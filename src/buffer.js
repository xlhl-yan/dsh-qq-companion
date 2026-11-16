/**
 * 会话消息队列 —— 三队列状态机。
 *
 * 为什么是三个队列（2026-11-16 用户提出）
 * -------------------------------------
 * 之前只有一个 `unread` 数组，它同时承担三种语义：
 *   ① 刚收到、还在缓冲期里的（没定稿）
 *   ② 缓冲够了、可以给消费者读的
 *   ③ 已经投递出去、但模型还没确认的
 * 三个概念挤在一个数组里，导致一连串 bug：重复投递、pending 重投、
 * deliveredSeq 与 watermark 对不上。分开之后每个阶段都有明确的进出条件。
 *
 *       staging[]       收到就进，任何消费者都看不见
 *          ↓ 静默 bufferSeconds（期间来新消息就重置计时）
 *       ready[]         已定稿，唯一可读的地方
 *          ↓ 投递成功（steer 返回 ok）
 *       unconfirmed[]   送到了，模型还没确认
 *          ↓ mark_read(seq)
 *       已确认 · 出队
 *
 * 三条规则：
 *   ① 投递失败的消息**留在 ready**，不进 unconfirmed ——
 *      后者的语义是"送到了没确认"，没送到的不该混进去。
 *   ② 所有消费者（wait / 唤醒 / get_unread）只读 ready。
 *   ③ seq 只在 push 时分配一次，三个队列共享同一条 seq 轴，
 *      所以 markRead 就是一次简单过滤。
 *
 * 为什么不能用 OneBot 的 message_seq 当游标
 * -----------------------------------------
 * 实测（2026-10-29，SnowLuma 2.2.1，私聊双向收发）：
 *   机器人自己发的消息 message_seq = 38119 / 38123 / 38137（递增）
 *   对方发的消息     message_seq = 548
 * 两套序列各自递增、互不衔接。直接拿它当"已读到哪"会漏消息或重复读。
 * 所以这里自己发号，与 QQ 的 message_id / message_seq 无关。
 *
 * 为什么要有 recent 窗口而不是存全量
 * --------------------------------
 * 对话历史由 DSH 会话自己持久化，插件只需要给模型一个"这轮该看什么"的可见窗口。
 * 存全量既费内存，也会诱导把整段历史塞进 prompt —— 那是 DSH 会话该做的事。
 */

const DEFAULTS = {
  /** staging 最多攒这么多条，防消息洪峰打爆内存。 */
  stagingLimit: 60,
  /** ready 最多保留这么多条。 */
  readyLimit: 30,
  /** unconfirmed 最多保留这么多条（正常情况下 mark_read 会及时清掉）。 */
  unconfirmedLimit: 100,
  /** 最近的窗口。 */
  recentLimit: 100,
  /** 去重窗口：记住最近这么多条 message_id。 */
  dedupeLimit: 500,
};

/**
 * 从 OneBot 消息事件里取"发送者 QQ 号"。
 */
export function senderOf(event) {
  const id = event?.sender?.user_id ?? event?.user_id;
  return id === undefined || id === null ? '' : String(id);
}

/**
 * 判断一条消息是不是机器人自己发的。
 *
 * 为什么要 String() 而不是 ===：网关会把 id 序列化成 number 或 string 混用，
 * 用 === 会漏掉自己发的消息，后果是自己回答自己 / 回复循环。
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
    /**
     * @type {Map<string, {
     *   staging: Array, ready: Array, unconfirmed: Array,
     *   recent: Array, watermark: number, seen: Set<string>,
     * }>}
     */
    this.sessions = new Map();
  }

  #state(key) {
    let state = this.sessions.get(key);
    if (!state) {
      state = {
        staging: [],
        ready: [],
        unconfirmed: [],
        recent: [],
        watermark: 0,
        seen: new Set(),
      };
      this.sessions.set(key, state);
    }
    return state;
  }

  #makeRecord(seq, event, messageId) {
    return {
      seq,
      messageId,
      time: Number(event?.time) || Math.floor(Date.now() / 1000),
      sender: senderOf(event),
      senderName: event?.sender?.card || event?.sender?.nickname || '',
      message: event?.message,
      raw: event?.raw_message ?? null,
      event,
    };
  }

  /**
   * 记一条消息 —— **进 staging，不进 ready**。
   *
   * 这是整个设计的关键：消费者永远看不到 staging 里的东西，
   * 所以"对方还没说完"这件事由队列结构保证，不需要消费侧再判断一次。
   *
   * @returns {{accepted:boolean, seq?:number, why?:string}}
   */
  push(key, event) {
    const state = this.#state(key);
    const messageId = event?.message_id === undefined ? '' : String(event.message_id);
    if (messageId !== '') {
      if (state.seen.has(messageId)) return { accepted: false, why: 'duplicate' };
      state.seen.add(messageId);
      if (state.seen.size > this.config.dedupeLimit) {
        const oldest = state.seen.values().next().value;
        state.seen.delete(oldest);
      }
    }

    const seq = this.nextSeq;
    this.nextSeq += 1;
    const record = this.#makeRecord(seq, event, messageId);

    state.staging.push(record);
    if (state.staging.length > this.config.stagingLimit) state.staging.shift();

    state.recent.push(record);
    if (state.recent.length > this.config.recentLimit) state.recent.shift();

    return { accepted: true, seq };
  }

  /** staging 里有几条（给"要不要安排搬运定时器"判断用）。 */
  stagingCount(key) {
    return this.#state(key).staging.length;
  }

  /**
   * 把 staging 整批搬进 ready —— **由 runtime 的搬运定时器调用**。
   *
   * 搬的时机由生产侧决定（静默够久了），消费者不参与。
   *
   * @returns {number} 搬了多少条
   */
  flushStaging(key) {
    const state = this.#state(key);
    if (state.staging.length === 0) return 0;
    const moved = state.staging.splice(0, state.staging.length);
    state.ready.push(...moved);
    if (state.ready.length > this.config.readyLimit) {
      const drop = state.ready.length - this.config.readyLimit;
      state.ready.splice(0, drop);
    }
    return moved.length;
  }

  /**
   * 从磁盘恢复「还没投递出去」的消息（进程重启后调用）—— **直接进 ready**。
   *
   * 为什么不进 staging：这些消息在崩溃前已经过了缓冲期（否则不会被写进 pending），
   * 重新静默一遍只会让用户干等多一个 bufferSeconds。重启本身是异常状态，
   * 优先保证"尽快送到"。
   *
   * 刻意不走 push()：push 会重新分配 seq、重跑去重，seq 跟持久化时对不上。
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
    state.ready.push(...valid);
    state.recent.push(...valid);
    return valid.length;
  }

  /**
   * 可读的消息 —— **只返回 ready**。
   *
   * 名字沿用 `unread` 是为了少改动调用点，但它现在的精确语义是
   * 「已经定稿、还没投递出去」。staging 和 unconfirmed 都不在这里。
   */
  unread(key) {
    return this.#state(key).ready.slice();
  }

  /**
   * **还没投递出去的全部消息** = staging + ready。
   *
   * 和 unread() 的区别很重要：
   *   · unread()      消费者能读的（只有 ready）
   *   · undelivered() 该落盘的（staging 也还没送出去，不能丢）
   *
   * staging 里的消息虽然"还没定稿"，但崩溃后它的内容必须还在 ——
   * 所以 pending 文件要收它，恢复时统一进 ready（重新静默一遍没意义，
   * 那批消息在崩溃前对方早就不说话了）。
   */
  undelivered(key) {
    const state = this.#state(key);
    return [...state.staging, ...state.ready].sort((a, b) => a.seq - b.seq);
  }

  /** unconfirmed 里的消息（已投递、等确认）。 */
  pendingConfirm(key) {
    return this.#state(key).unconfirmed.slice();
  }

  recent(key, limit = 10) {
    const list = this.#state(key).recent;
    return list.slice(Math.max(0, list.length - limit));
  }

  /**
   * 投递成功：把这些 seq 从 ready 移到 unconfirmed。
   *
   * @param {string} key
   * @param {number[]} seqs 投递成功的那批 seq；省略则搬空 ready
   * @returns {number} 搬了多少条
   */
  markDelivered(key, seqs) {
    const state = this.#state(key);
    const wanted = Array.isArray(seqs) && seqs.length > 0 ? new Set(seqs.map(Number)) : null;
    const moved = [];
    const keep = [];
    for (const r of state.ready) {
      if (wanted === null || wanted.has(r.seq)) moved.push(r);
      else keep.push(r);
    }
    if (moved.length === 0) return 0;
    state.ready = keep;
    state.unconfirmed.push(...moved);
    if (state.unconfirmed.length > this.config.unconfirmedLimit) {
      const drop = state.unconfirmed.length - this.config.unconfirmedLimit;
      state.unconfirmed.splice(0, drop);
    }
    return moved.length;
  }

  /**
   * 导出可持久化的状态（只有数字 + 队列号段，不带消息本体）。
   *
   * 为什么必须存：这些值重启就清零，而 pending 的过滤和去重全靠它们，
   * 清零后历史消息会被当成"没投递过"重新写回、重新投递。
   */
  snapshot() {
    const sessions = {};
    for (const [key, state] of this.sessions) {
      sessions[key] = {
        watermark: state.watermark,
        // 三个队列各自的 seq 范围：恢复 pending 时按 max(watermark, 各队列尾) 判断
        // 哪些已经处理过，避免把 ready/unconfirmed 里的又当成新的。
        readySeqs: state.ready.map((r) => r.seq),
        unconfirmedSeqs: state.unconfirmed.map((r) => r.seq),
        lastSeq: state.recent.at(-1)?.seq ?? 0,
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
   * 推进已读水位 —— **从 unconfirmed 里清掉已被确认的**。
   *
   * 只允许**向前**推进，且不能超过已收到的最大 seq ——
   * 防止模型凭空猜一个水位把没看过的消息标成已读。
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
    state.unconfirmed = state.unconfirmed.filter((item) => item.seq > capped);
    return { ok: true, watermark: capped, capped: capped !== wanted };
  }

  /** 某会话的队列概况，给诊断工具和日志用。 */
  stats(key) {
    const state = this.#state(key);
    return {
      staging: state.staging.length,
      ready: state.ready.length,
      unconfirmed: state.unconfirmed.length,
      recent: state.recent.length,
      watermark: state.watermark,
      maxSeq: state.recent.length > 0 ? state.recent[state.recent.length - 1].seq : 0,
    };
  }

  keys() {
    return [...this.sessions.keys()];
  }
}
