/**
 * 会话消息缓冲 + 本地序号。
 *
 * 为什么不能用 OneBot 的 message_seq 当游标
 * -----------------------------------------
 * 实测（2026-10-29，SnowLuma 2.2.1，私聊双向收发）：
 *   机器人自己发的消息 message_seq = 38119 / 38123 / 38137（递增）
 *   对方发的消息     message_seq = 548
 * 两套序列各自递增、互不衔接。直接拿它当"已读到哪"会漏消息或重复读。
 *
 * 所以这里**自己发号**：每进来一条消息分配一个本地递增 seq，
 * 水位（readThroughSeq）指的是这个本地 seq，与 QQ 的 message_id / message_seq 无关。
 * qq-bridge 的做法一致——它的工具说明里明写「readThroughSeq 是桥接本地的 seq，
 * 不是 QQ messageId，两者不能混用」。
 *
 * 为什么要有 recent 窗口而不是存全量
 * --------------------------------
 * 对话历史由 DSH 会话自己持久化，插件只需要给模型一个"这轮该看什么"的可见窗口。
 * qq-bridge 用 unread(30) / recent(100)，并且有字符预算（wakeMaxChars=6000）。
 * 存全量既费内存，也会诱导把整段历史塞进 prompt —— 那是 DSH 会话该做的事。
 */

const DEFAULTS = {
  /** 未读最多保留这么多条，防消息洪峰打爆内存。 */
  unreadLimit: 30,
  /** 最近的窗口。 */
  recentLimit: 100,
  /** 去重窗口：记住最近这么多条 message_id。 */
  dedupeLimit: 500,
};

/**
 * 从 OneBot 消息事件里取"发送者 QQ 号"。
 *
 * 注意：群消息的 `user_id` 是**发送者**，`group_id` 是群；
 * 私聊的 `user_id` 在 history 里是发送者，在 WS 事件里也是发送者。
 * 但 history 里**没有 self_id**，所以要判断"是不是我发的"只能靠这个字段
 * 和机器人自己的号比较（用 String() 比较，见 isSelf 注释）。
 */
export function senderOf(event) {
  const id = event?.sender?.user_id ?? event?.user_id;
  return id === undefined || id === null ? '' : String(id);
}

/**
 * 判断一条消息是不是机器人自己发的。
 *
 * 为什么要 String() 而不是 ===：qq-bridge 踩过（bridge.js:11822）——
 * 网关会把 id 序列化成 number 或 string 混用，用 === 会漏掉自己发的消息，
 * 后果是自己回答自己 / 回复循环。
 */
export function isSelf(event, selfId) {
  if (selfId === undefined || selfId === null || String(selfId) === '') return false;
  return senderOf(event) === String(selfId);
}

export class ConversationBuffer {
  constructor(options = {}) {
    const config = { ...DEFAULTS, ...options };
    this.config = config;
    this.nextSeq = 1;
    /** @type {Map<string, {unread:Array, recent:Array, watermark:number, seen:Set<string>}>} */
    this.sessions = new Map();
  }

  #state(key) {
    let state = this.sessions.get(key);
    if (!state) {
      state = { unread: [], recent: [], watermark: 0, seen: new Set() };
      this.sessions.set(key, state);
    }
    return state;
  }

  /**
   * 记一条消息。
   *
   * @returns {{accepted:boolean, seq?:number, why?:string}}
   *   accepted=false 表示被去重丢弃。
   */
  push(key, event) {
    const state = this.#state(key);
    const messageId = event?.message_id === undefined ? '' : String(event.message_id);
    if (messageId !== '') {
      // 重连后上游可能补发，去重能省掉一次无意义的模型回合
      if (state.seen.has(messageId)) return { accepted: false, why: 'duplicate' };
      state.seen.add(messageId);
      if (state.seen.size > this.config.dedupeLimit) {
        // Set 的插入序就是迭代序，删最早的那条
        const oldest = state.seen.values().next().value;
        state.seen.delete(oldest);
      }
    }

    const seq = this.nextSeq;
    this.nextSeq += 1;

    const record = {
      seq,
      messageId,
      time: Number(event?.time) || Math.floor(Date.now() / 1000),
      sender: senderOf(event),
      senderName: event?.sender?.card || event?.sender?.nickname || '',
      message: event?.message,
      raw: event?.raw_message ?? null,
      event,
    };

    state.unread.push(record);
    if (state.unread.length > this.config.unreadLimit) state.unread.shift();

    state.recent.push(record);
    if (state.recent.length > this.config.recentLimit) state.recent.shift();

    return { accepted: true, seq };
  }

  /**
   * 从磁盘恢复「还没投递出去」的消息（进程重启后调用）。
   *
   * 刻意不走 push()：push 会重新分配 seq、重新跑一遍去重，那样 seq 跟持久化时
   * 对不上，已读水位也会跟着错乱。这里直接塞回 unread，并保证 nextSeq 越过最大值。
   *
   * @returns {number} 实际恢复了多少条
   */
  restore(key, records) {
    const state = this.#state(key);
    const valid = [];
    for (const r of Array.isArray(records) ? records : []) {
      if (!r || typeof r !== 'object') continue;
      const seq = Number(r.seq);
      if (!Number.isFinite(seq) || seq <= 0) continue;
      // 水位已经越过它的，说明这条已经被模型看过了，不重复投递
      if (seq <= state.watermark) continue;
      const messageId = String(r.messageId ?? '');
      valid.push({
        seq,
        messageId,
        time: Number(r.time) || 0,
        sender: String(r.sender ?? ''),
        senderName: String(r.senderName ?? ''),
        message: r.event?.message,
        raw: r.event?.raw_message ?? null,
        event: r.event ?? null,
      });
      if (messageId !== '') state.seen.add(messageId);
      if (seq >= this.nextSeq) this.nextSeq = seq + 1;
    }
    if (valid.length === 0) return 0;
    valid.sort((a, b) => a.seq - b.seq);
    state.unread.push(...valid);
    state.recent.push(...valid);
    return valid.length;
  }

  unread(key) {
    return this.#state(key).unread.slice();
  }

  recent(key, limit = 10) {
    const list = this.#state(key).recent;
    return list.slice(Math.max(0, list.length - limit));
  }

  /** 当前水位：模型已经看到哪一条本地 seq。 */
  /**
   * 导出可持久化的状态（只有数字，不带消息本体 —— 消息本体在 pending 里）。
   *
   * 为什么必须存：这几个值重启就清零，而 pending 的过滤和去重全靠它们，
   * 清零后历史消息会被当成"没投递过"重新写回、重新投递。
   */
  snapshot() {
    const sessions = {};
    for (const [key, state] of this.sessions) {
      sessions[key] = {
        watermark: state.watermark,
        // seen 只用于同一次进程内的上游补发去重，重启后按 messageId 重新收集即可；
        // 但 lastSeq 必须存，否则 nextSeq 回到 1、新消息的 seq 会和旧 pending 撞号。
        lastSeq: state.unread.length > 0
          ? Math.max(...state.unread.map((r) => r.seq), state.recent.at(-1)?.seq ?? 0)
          : (state.recent.at(-1)?.seq ?? 0),
      };
    }
    return { nextSeq: this.nextSeq, sessions };
  }

  /** 从 snapshot() 的产物恢复。水位只会被读回，不会绕过 markRead 直接改。 */
  hydrate(data) {
    if (!data || typeof data !== 'object') return;
    for (const [key, saved] of Object.entries(data.sessions ?? {})) {
      if (!saved || typeof saved !== 'object') continue;
      const state = this.#state(key);
      const wm = Number(saved.watermark);
      if (Number.isFinite(wm) && wm > state.watermark) state.watermark = wm;
    }
    const next = Number(data.nextSeq);
    if (Number.isFinite(next) && next > this.nextSeq) this.nextSeq = next;
  }

  watermark(key) {
    return this.#state(key).watermark;
  }

  /**
   * 推进已读水位。
   *
   * 只允许**向前**推进，且不能超过已收到的最大 seq ——
   * 防止模型凭空猜一个水位把没看过的消息标成已读（qq-bridge 踩过：
   * "水位钉在 185，模型已看过 205"这类静默错数据最难查）。
   */
  markRead(key, throughSeq) {
    const state = this.#state(key);
    const wanted = Number(throughSeq);
    if (!Number.isFinite(wanted) || wanted <= state.watermark) {
      return { ok: false, why: `水位只能前进（当前 ${state.watermark}，请求 ${throughSeq}）` };
    }
    const maxSeq = state.recent.length > 0 ? state.recent[state.recent.length - 1].seq : 0;
    const capped = Math.min(wanted, maxSeq);
    state.watermark = capped;
    state.unread = state.unread.filter((item) => item.seq > capped);
    return { ok: true, watermark: capped, capped: capped !== wanted };
  }

  /** 某会话的缓冲概况，给诊断工具和唤醒提示用。 */
  stats(key) {
    const state = this.#state(key);
    return {
      unread: state.unread.length,
      recent: state.recent.length,
      watermark: state.watermark,
      maxSeq: state.recent.length > 0 ? state.recent[state.recent.length - 1].seq : 0,
    };
  }

  keys() {
    return [...this.sessions.keys()];
  }
}
