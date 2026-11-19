/**
 * 运行时：把协议层（onebot/ws）、缓冲（buffer）、映射（session-map）、判定（wake）缝在一起。
 *
 * 这一层刻意不碰 DSH 的任何东西（不调 ctx、不 steer），只暴露普通方法。
 * 好处：它可以脱离 DSH 单独跑起来做集成测试 —— 事实上有一次就是这样验证 WS 协议结构的，
 * 比"装进插件再重启 DSH 看日志"快一个数量级。
 */

import fs from 'node:fs';
import path from 'node:path';

import { discoverEndpoint, sendText, call } from './onebot.js';
import { OneBotWsClient } from './ws.js';
import { ConversationBuffer, isSelf, senderOf } from './buffer.js';
import { conversationOf } from './session-map.js';
import { extractText, nonTextTypes, segmentsOf } from './message.js';
import { downloadImage, imageSegmentsOf } from './media.js';
import { computeIntervalMs, skipQuietWindow, evaluateDue } from './schedule.js';
import { createWorkdayCalendar, parseWorkSpans } from './workday.js';

const DEFAULT_WAKE = {
  /**
   * 缓冲期（秒）：收到消息后**不立即唤醒**，等这么久没有新消息才叫醒 agent。
   * 缓冲期内又来消息则合并并重新计时（debounce）。
   * 用户 2026-10-29 定的语义：设 10 就是"留 10 秒缓冲"。
   */
  bufferSeconds: 10,
  /**
   * 苏醒间隔（秒）：每隔这么久主动唤醒一次，让 AI 自己决定要不要找主人说话。
   * 不看有没有未读 —— 这是"主动陪伴"的入口。
   */
  wakeIntervalSec: 300,
  /** 主动苏醒开关。关掉后只会因为消息唤醒。 */
  proactive: true,
  /**
   * 主动苏醒的时段窗口（24 小时制，含起不含止）。
   * 默认 8–23：夜里不主动找人，免得凌晨三点给主人发消息。
   * 起 > 止 表示跨午夜（如 22 → 6）；两者相等视作全天。
   */
  activeStartHour: 8,
  activeEndHour: 23,
  /**
   * 两次唤醒之间至少隔这么久 —— **2026-11-19 已删除**。
   *
   * 删掉的两个理由：
   *   ① 排期本身已经保证最小间隔（`wakeIntervalSec × (1 - jitterRatio)`），
   *      冷却纯冗余 —— 45 分钟 × 0.8 = 36 分钟，再怎么拦也轮不到 30 分钟这道闸；
   *   ② 「冷却拒绝 + 重排」会**死循环** —— 间隔 20 分钟、冷却 30 分钟时，
   *      每次算出 16~24 分钟、每次被拒、重排出来还是 16~24 分钟 → 永远不醒，
   *      而且日志里只有"冷却未过"，最难查。
   *
   * 保留这个键只为读懂老配置（settings.json 里可能还写着 wake.minIntervalSec），
   * **没有任何代码读它**。
   */
  minIntervalMs: 0,
  /** 每小时最多唤醒几次。超限是**延后**不是丢弃（qq-bridge 的教训）。 */
  maxPerHour: 12,

  // ── 排期（2026-11-19 新增）─────────────────────────────
  /**
   * 随机抖动幅度。0.15 = ±15%。
   *
   * 为什么要有抖动：固定间隔会让苏醒时间像机器（而且重启后总是同一个偏移量）。
   * 用户 2026-11-19：「真实可能是15%也可能是10%，这就是他支持可配置的优势」。
   */
  jitterRatio: 0.15,
  /**
   * 工作时段的抖动倍数。
   *
   * ⚠️ **这是"抖动幅度"的倍数，不是"间隔"的倍数。**
   *   非工作：base × (1 + rand(-j, +j))        对称
   *   工作：  base × (1 + |rand(-j, +j)| × m)  取绝对值，只变长
   *
   * 和旧配置 `workMultiplier`（间隔 ×m）差一倍 —— base=45、j=15%、m=2 时
   * 本规则 58.5 分，旧规则 103.5 分。
   */
  workJitterMultiplier: 2,
  /**
   * 工作时段，形如 `09:00-11:30, 13:00-17:30`（设置页文本框直接填）。
   * 空 = 不做工作时段区分，全天按非工作时段算。
   */
  workHours: '',
  /** 基础工作日（1=周一 … 7=周日），逗号分隔。节假日/调休由 workday.js 覆盖。 */
  workDays: '1,2,3,4,5',
  /**
   * 排期过期超过「间隔 × 这个倍数」时，不补醒而是重排。
   * 场景：电脑休眠一夜，醒来时排期已经过期 8 小时 —— 不该早上一开机就被叫。
   */
  overdueResetRatio: 2,
  /**
   * `qq_wait_for_messages` **连续空等**几次就算"这一段聊完了"。
   *
   * 用户 2026-11-19 定的：**超时两次之后默认结束会话**。
   * 拿到消息会清零，所以只有"连续几次都等到超时、一点回应都没有"才触发。
   * 触发后等价于调了一次 `qq_end_conversation`：主动苏醒计时从此刻重排。
   */
  waitTimeoutsBeforeEnd: 2,
};

/**
 * 回合判忙租约。
 *
 * turn/end 一旦丢失（DSH 重启、事件漏收），会话会**永久**判忙，之后所有唤醒都卡在
 * 队列里，QQ 上表现就是「它不理我了」，只能重启 —— qq-bridge 为这个吃过 issue
 * #11/#23/#26/#19。15 分钟足够覆盖任何还活着的回合（正常 1~3 分钟，长工具调用约 12 分钟）。
 */
const BUSY_LEASE_MS = 15 * 60 * 1000;

export class QQCompanionRuntime {
  constructor({ config = {}, log = () => {} } = {}) {
    this.config = config;
    this.log = log;

    this.buffer = new ConversationBuffer(config.buffer ?? {});
    /**
     * 聊天记录的根目录。
     *
     * 优先用 `config.chatLogDir`；否则落在 `config.baseDir`（= 绑定会话的**真实工作区**，
     * 由 index.js 通过 DSH 的 workingDirectory 服务解析）下的 `.qq-companion/logs`。
     *
     * 这里只写**收发流水**（↓ 收到 / ↑ 发出），不写重连、唤醒之类的调试信息 ——
     * 那些留在控制台就好，混进聊天记录反而没法读。
     *
     * 每个会话再分一层子目录（绑定会话用 sessionId，未绑定的用会话 key），
     * 见 #appendChat —— 多个会话混进一个文件根本没法读。
     */
    this.chatLogRoot = config.chatLogDir || path.join(config.baseDir || process.cwd(), 'logs');
    /**
     * 待投递消息的落盘目录。
     *
     * 为什么要有它：消息收进来先躺在**内存** buffer 里，等缓冲期结束才投递给 agent。
     * 如果这中间 DSH 退出了，内存一没，消息就永久丢了 —— 日志里虽然有记录，
     * 但没人会去重投，等于失联（2026-11-02 用户发现）。
     *
     * 所以：收下就写文件，投递成功才删；启动时把没删的捡回来重新投递。
     */
    this.pendingDir = config.pendingDir || path.join(config.baseDir || process.cwd(), 'pending');
    /**
     * 水位/seq 的持久化文件。
     *
     * 没有它会有致命后果：重启后 watermark 和 deliveredSeq 清零，pending 的
     * 过滤条件失效，历史消息被重新写回、重新投递（2026-11-16 用户实测：
     * "经常重复投递已读的消息"）。
     */
    this.stateFile = path.join(config.baseDir || process.cwd(), 'state.json');
    this.stateSaveTimer = null;

    /** 重连进行中标记：防止连点保存叠出两条 WS 连接。 */
    this.restarting = false;
    /** 主动苏醒的定时器句柄（stop() 里清）。 */
    this.pollTimer = null;
    /** key -> 缓冲期计时器（debounce）。收到消息重置，到期才唤醒。 */
    this.bufferTimers = new Map();
    /** key -> 长轮询租约时间戳。同一会话只允许一个等待（照抄 qq-bridge 的 activeWaits）。 */
    this.activeWaits = new Map();
    /** sessionId -> 这一轮 turn 的开始时间戳。没有键 = 空闲（只用于日志措辞）。 */
    this.busySessions = new Map();
    /** key -> 该会话的唤醒配置（覆盖全局默认值）。 */
    this.wakeConfigs = new Map();
    /** key -> 最近一次唤醒时间戳。目前只写不读，留着供以后做展示/诊断。 */
    this.lastWakeAt = new Map();
    /**
     * key -> 主动苏醒的**排期**（`{ nextAt, intervalSec, reason }`）。
     *
     * 这里存的是**绝对时间戳**，落盘到 state.json。重启后读回来继续等，
     * 不需要"从零开始数 45 分钟"。
     *
     * 它取代了两样东西：
     *   · 旧的"上次苏醒时间 + 固定间隔"链式计时（重启就归零）；
     *   · 旧的冷却 `minIntervalSec`（2026-11-19 删除 —— 排期已保证间隔，
     *     而且"拒绝后重排"会死循环）。
     *
     * **会被"主人最近说话"刷新**（聊完才开始计时）。这和 2026-11-03 那个
     * "越聊天越不主动"的坑不是同一件事：那时被刷新的是**冷却**，
     * 而冷却在语义上就不该被消息影响。
     */
    this.wakeSchedule = new Map();

    /** 上一轮轮询还没跑完 —— 防止 steer 卡住时叠出第二轮。 */
    this.pollBusy = false;

    /**
     * 工作日日历（节假日 + 调休）。
     *
     * 放构造时创建、`start()` 里 warmup：日历对象本身是纯本地的，
     * 但拉数据要联网，不该在构造函数里 await（会让插件启动变慢）。
     *
     * 数据缺失时 `isWorkday` 会退化成"只看星期几"，不会抛错。
     */
    this.workdayCalendar = createWorkdayCalendar({
      cacheDir: path.join(config.baseDir || process.cwd(), 'holidays'),
      log: (line) => this.log(line),
      workDays: config.wake?.workDays,
    });
    /**
     * key -> 已经成功投递出去的最大 seq。
     *
     * pending 文件不能拿 buffer.unread() 当数据源：unread 的语义是
     * “模型还没标记已读”，而 qq_mark_read 是手动操作，所以已投递的消息会长期
     * 留在 unread 里。每来一条新消息 persist 就会把旧的已投递消息一起写回去，
     * 重启后全部重投（2026-11-04 用户实测：每次启动都收到上一条发过的消息）。
     */
    this.deliveredSeq = new Map();
    /**
     * key -> 最近一次收到消息的时间戳。
     *
     * 主动苏醒要避开"正在聊天"：#isBusy 只挡得住「正在跑 turn」，
     * 但对话是 turns 密集切换，turn/end 之后 busy 立刻就是 false。
     * 用它判断"刚聊过"，避免聊到一半它突然插一句。
     */
    this.lastMessageAt = new Map();
    /** key -> 一小时内的唤醒时间戳数组。 */
    this.wakeHistory = new Map();
    /** 等待新消息的长轮询挂起点。 */
    this.waiters = new Set();
    /**
     * key -> `qq_wait_for_messages` **连续空等**的次数。
     *
     * 用户 2026-11-19：**超时两次之后默认结束会话**。
     * 拿到消息就清零（对方还在说）；只有"超时且没拿到任何消息"才 +1。
     *
     * 不持久化：重启丢了只是要多等两次，没有正确性问题。
     */
    this.waitTimeouts = new Map();

    this.endpoint = null;
    this.client = null;
    this.selfId = '';
    this.startedAt = 0;
    this.lastError = '';

    /** 唤醒回调：index.js 决定要不要真的 steer agent。 */
    this.onWake = null;

    // 字段全部初始化完之后再回灌水位。
    //
    // 它决定两件事：nextSeq 从哪儿继续（否则新消息 seq 和旧 pending 撞号），
    // 以及待投递恢复时按哪个 watermark 过滤（否则历史全量重投）。
    // 必须放在这里而不是 start()：纯本地状态，不该依赖 WS 连上与否；
    // 也必须放最后，否则 deliveredSeq 之类的字段会把恢复值覆盖掉。
    this.#loadState();
  }

  // ── 生命周期 ─────────────────────────────────────────────

  async start() {
    // 先把上次没投递出去的消息捡回来。
    //
    // 刻意放在端点发现**之前**：pending 是本地文件，读取不需要网络。
    // 排在后面的话，SnowLuma 没起来就直接 return，pending 永远轮不到被读
    // —— 那"消息不会丢"这个承诺在最需要它的场景（崩溃后重启）就失效了。
    this.#restorePending();

    // 预热节假日日历（当年 + 下一年）。
    //
    // 不 await：拉不到就算了，isWorkday 会退化成"只看星期几"，
    // 而且这件事跟能不能收消息完全无关 —— 不该阻塞启动。
    this.workdayCalendar
      ?.warmup?.()
      .then((years) => {
        if (Array.isArray(years) && years.length > 0) {
          this.log(`📅 工作日日历已就绪（${years.join(', ')}）`);
        }
      })
      .catch((error) => this.log(`⚠️ 节假日预热失败：${String(error?.message ?? error)}`));

    const ephemeral = this.config.snowLuma ?? {};
    const found = await discoverEndpoint({
      baseUrl: ephemeral.httpUrl ?? '',
      token: ephemeral.accessToken ?? '',
      homeDir: ephemeral.homeDir ?? '',
      launcherPath: ephemeral.launcherPath ?? '',
    });
    if (!found.ok) {
      this.lastError = found.error ?? '端点发现失败';
      this.log(`✗ ${this.lastError}`);
      return { ok: false, error: this.lastError, tried: found.tried };
    }

    this.endpoint = { baseUrl: found.baseUrl, token: found.token };
    // 配置里填了就用它（设置页可改），否则用协议端报上来的账号。防自激靠这个 id。
    this.selfId = String(this.config.selfId || found.self?.user_id || '');
    this.startedAt = Date.now();
    this.log(`✓ 端点就绪：${found.baseUrl} · 账号 ${found.self?.nickname}(${this.selfId}) · 来源 ${found.source}`);
    // 把聊天记录的真实路径打出来 —— 省得回头满地找"日志到底写哪了"。
    this.log(`聊天记录：${this.chatLogRoot}${path.sep}<sessionId>${path.sep}chat-YYYY-MM-DD.log`);
    this.log(`待投递目录：${this.pendingDir}`);
    this.log(`水位文件：${this.stateFile}`);


    const ws = this.config.snowLuma?.wsUrl || (found.ws ? `ws://${found.ws.host}:${found.ws.port}/` : 'ws://127.0.0.1:3001/');
    if (this.config.enabled !== false) {
      this.client = new OneBotWsClient({
        url: ws,
        token: found.ws?.token || found.token,
        log: this.log,
        onEvent: (event) => this.handleEvent(event),
      }).start();
      this.log(`WS 目标：${ws}${this.config.observeOnly ? '（观察模式：只记缓冲，不唤醒）' : ''}`);
    }

    // 主动苏醒：每隔 wakeIntervalSec 唤醒一次，让 AI 自己决定要不要主动搭话。
    this.#startProactiveTimer();

    return { ok: true, baseUrl: found.baseUrl, selfId: this.selfId, ws };
  }

  stop() {
    // 退出前把水位写死：节流用的 2 秒定时器可能还没到，unref 的定时器
    // 在进程收尾时不保证跑完。
    this.#saveState(true);
    this.#stopPoller();
    // 缓冲期计时器也要清 —— 否则 stop 之后还可能再叫醒一次。
    for (const timer of this.bufferTimers.values()) clearTimeout(timer);
    this.bufferTimers.clear();
    this.activeWaits.clear();
    this.busySessions.clear();
    this.client?.stop();
    this.client = null;
    // this.waiters 存的是 waiter 对象（{key,minCount,resolve,...}），不是函数 ——
    // 早期版本存过裸 resolve，改结构时这里漏改了，一 stop 就炸。
    for (const waiter of this.waiters) {
      try { waiter.resolve({ ok: false, why: 'runtime stopped' }); } catch { /* 已结束的跳过 */ }
    }
    this.waiters.clear();
  }

  /**
   * 按当前配置重连：停掉旧 WS、重新发现端点、连上新的。
   *
   * 什么时候需要它：设置页改了 wsUrl / httpUrl / accessToken —— 这几样在 start()
   * 那一刻就固化成 `this.endpoint` 和 `this.client` 了，光换 config 不会让它们跟着动。
   *
   * 有并发保护：重连期间再保存一次不会叠出两条连接。
   */
  async restart() {
    if (this.restarting) return { ok: false, error: '正在重连中，请稍候' };
    this.restarting = true;
    try {
      this.log('正在按新配置重连…');
      this.stop();
      const result = await this.start();
      if (result.ok) this.log(`✓ 重连完成 · 账号 ${result.selfId}`);
      else this.log(`✗ 重连失败：${result.error}`);
      return result;
    } catch (error) {
      const message = String(error?.message ?? error);
      this.log(`✗ 重连异常：${message}`);
      return { ok: false, error: message };
    } finally {
      this.restarting = false;
    }
  }

  // ── 事件处理 ─────────────────────────────────────────────

  /**
   * 一条 OneBot 事件。
   *
   * 只处理 message 类；meta/notice 目前忽略（notice 里的戳一戳以后可能有用）。
   */
  handleEvent(event) {
    if (!event || event.post_type !== 'message') return;
    const conv = conversationOf(event);
    if (!conv.ok) {
      this.log(`跳过事件：${conv.why}`);
      return;
    }

    // 防自激第一层：自己发的消息绝不进缓冲（否则 agent 会回答自己）
    if (isSelf(event, this.selfId)) return;

    const pushed = this.buffer.push(conv.key, event);
    if (!pushed.accepted) return;

    // 落盘保命：这条消息在投递成功之前，必须能在进程重启后找回来。
    // 写失败不影响收消息（日志那边还有一份），但会少一层保险。
    this.lastMessageAt.set(conv.key, Date.now());
    this.#persistPending(conv.key);

    // 收到就记日志 —— **不管后面唤不唤醒**。
    // 用户 2026-10-29 要求：私聊消息全部留痕，出问题时能回查"到底收没收到"，
    // 而不是只能靠 QQ 那边猜。非文字段（图片/表情/语音）也标出来。
    const text = extractText(event);
    const nonText = nonTextTypes(event);
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    // 图片落盘路径在下载前就能算出来（目录与日志同源，文件名就是上游 file 字段），
    // 所以直接写进这一行 —— 回查时不必去别处找（2026-10-29 用户要求）。
    const hints = this.#imageTargetHints(event);
    const line =
      `↓ ${stamp} ${conv.key} [${senderOf(event)}] ${text || '(非文本)'}` +
      (nonText.length > 0 ? `（含 ${nonText.join('/')}）` : '') +
      (hints.length > 0 ? ` → ${hints.join(' , ')}` : '');
    this.log(line);
    this.#appendChat(conv.key, line); // 同时落盘，控制台关了也能回查

    // 图片异步落盘（不阻塞事件处理）。下载完把本地路径写回消息段，
    // 供唤醒提示和 toView 使用 —— 模型拿到的是一条本地路径，可以自己 read_image。
    this.#fetchImages(event, conv.key);

    // 有长轮询在等新消息，先满足它（返回值 = 满足了几条等待）
    const satisfiedWaiters = this.#notifyWaiters(conv.key);

    if (this.config.observeOnly) return;

    // 有人说话 → 主动苏醒的排期往后推。
    //
    // 放在 satisfiedWaiters 判断**之前**：不管这条消息最终是走 wait 直接交付、
    // 还是走缓冲期唤醒，"有人在聊"这个事实是一样的，排期都该重新起算。
    //
    // 这条是 2026-11-19 用户实测反馈的根治办法：「我刚跟会话完成一轮对话，
    // 刚静下来 10 分钟，然后被主动唤醒重新拉起了会话」—— 因为那时排期是
    // 按"上次苏醒 + 固定间隔"算的，跟你什么时候说完话完全无关。
    this.#postponeWakeSchedule(conv.key);

    // 有人说话 = 对方还在聊 → 清掉"连续空等"的计数。
    // 不然「上次聊到一半超时两次」的陈年计数会带到这次对话里。
    this.waitTimeouts.delete(conv.key);

    // ⚠️ 如果有长轮询在等，这条消息**已经直接交给它了** —— agent 会带着这批消息
    // 在同一次工具调用里继续跑。此时再安排缓冲期唤醒 = 把同一批消息叫醒两次，
    // 表现就是「发一条消息，它回两遍」（2026-10-29 用户实测）。
    if (satisfiedWaiters > 0) {
      this.log(`（已通过 qq_wait_for_messages 直接送达，跳过缓冲期唤醒）`);
      return;
    }

    // 缓冲期（debounce）：收到消息**不立即唤醒**，只重置这个会话的计时器。
    // 缓冲期内又来消息就继续重置 —— 对方连发五条，只在停下来之后叫醒一次。
    // 详见 src/runtime.js 的 #scheduleBufferedWake。
    this.#scheduleBufferedWake(conv.key);
  }

  /**
   * 安排一次"缓冲期结束后唤醒"。
   *
   * 用户 2026-10-29 定的语义：缓冲期设 10 秒，收到消息不要立刻醒，留 10 秒缓冲；
   * 缓冲期内又来新消息就把它们合并、并**重新计时**。所以这里是 debounce 而不是 throttle。
   *
   * 每个会话一个独立计时器：私聊和群聊互不影响。
   */
  #scheduleBufferedWake(key) {
    const raw = Number(this.config.wake?.bufferSeconds ?? 10);
    const seconds = Number.isFinite(raw) && raw >= 0 ? raw : 10;
    const previous = this.bufferTimers.get(key);
    if (previous !== undefined) clearTimeout(previous);

    const timer = setTimeout(() => {
      this.bufferTimers.delete(key);
      // 缓冲期到了 —— 这是「搬运」发生的地方：
      // 把 staging 整批搬进 ready，消费者从这一刻起才看得见这批消息。
      // 顺序不能反：先搬再通知，否则 notifyWaiters 读 ready 还是空的。
      const moved = this.buffer.flushStaging(key);
      if (moved > 0) this.log(`📦 ${key} 搬运 ${moved} 条 staging → ready`);

      // 搬运完先看有没有长轮询在等：有就直接交付给它，别再叫醒 agent。
      // 两边都消化同一批消息 = 用户说的「发一条消息，它回两遍」。
      const satisfied = this.#notifyWaiters(key);
      if (satisfied > 0) {
        this.log(`（已通过 qq_wait_for_messages 直接送达，跳过缓冲期唤醒）`);
        return;
      }

      this.#deliverBuffered(key).catch((error) =>
        this.log(`✗ 缓冲唤起异常：${String(error?.message ?? error)}`),
      );
    }, Math.max(0, seconds * 1000));
    timer.unref?.();
    this.bufferTimers.set(key, timer);
  }

  // ── 忙闲观察 ─────────────────────────────────────────────

  /**
   * 标记某个 DSH 会话是不是正在跑 turn（index.js 监听 session/event 时调用）。
   *
   * 为什么要判忙：不判的话，缓冲期一到就 steer 进正在跑的回合，AI 回到一半被打断
   * （用户 2026-10-29 实测，不是偶发）。
   */
  /**
   * 由 index.js 注入：给定 sessionId，返回这一轮是否还在跑。
   * 返回 null/undefined = 问不到（退回事件+租约兜底）。
   */
  busyProbe = null;

  setSessionBusy(sessionId, busy) {
    const id = String(sessionId ?? '');
    if (id === '') return;
    if (busy) {
      if (!this.busySessions.has(id)) this.busySessions.set(id, Date.now());
    } else {
      this.busySessions.delete(id);
    }
  }

  /** key -> 绑定的 DSH sessionId（没绑定就是空串）。 */
  #sessionIdFor(key) {
    for (const row of Array.isArray(this.config.bindings) ? this.config.bindings : []) {
      if (String(row?.key ?? '') === key) return String(row?.sessionId ?? '').trim();
    }
    return '';
  }

  /**
   * 这个 QQ 会话对应的 DSH 会话正在跑 turn 吗。
   *
   * 带租约：qq-bridge 踩过的坑是「turn/end 一旦丢了，会话会永久判忙，之后所有唤醒
   * 只进队列，QQ 上表现就是『它不理我了』，只能重启」（issue #11/#23/#26/#19）。
   * 这里超过 15 分钟就当那一轮已经死了 —— 不判忙只是允许新唤醒排队，会话本身不受影响。
   */
  #isBusy(key) {
    const sessionId = this.#sessionIdFor(key);
    if (sessionId === '') return false;

    // 首选：直接问 DSH 的权威状态（turnBoundary projection 的 openTurnStartSeq）。
    //
    // 为什么不用事件+租约就够：session/event **只有** turn/start 和 turn/end，
    // turn 执行中间一个事件都没有 —— 跑一个 30 分钟的后台任务时，插件完全收不到
    // 任何信号，只能拿"已经过去 15 分钟"去猜"这轮死了没"。猜错就会在任务进行中
    // 主动插话（用户 2026-11-08 实测）。projection 是 loop 自己维护的，
    // turn 没结束它就永远是开着的，与时间无关。
    //
    // busyProbe 返回 null/undefined 表示"问不到"，此时退回下面的事件+租约兜底。
    const probed = this.busyProbe?.(sessionId);
    if (probed === true || probed === false) return probed;
    const since = this.busySessions.get(sessionId);
    if (since === undefined) return false;
    if (Date.now() - since > BUSY_LEASE_MS) {
      this.busySessions.delete(sessionId);
      this.log(`（${key} 的回合超过 ${Math.round(BUSY_LEASE_MS / 60000)} 分钟没结束，视为已失效）`);
      return false;
    }
    return true;
  }

  /**
   * 会话空闲了（turn/end 时由 index.js 调）。
   *
   * 2026-10-30 起这里**不再补发任何东西**：忙的时候消息已经通过 steer 插进去了，
   * 队列机制整个删掉了（长任务期间失联的根因）。保留这个方法只是因为 index.js
   * 还在 turn/end 里调它 —— 现在它只负责清一下可能残留的会话忙碌标记。
   */
  flushPending(sessionId) {
    const id = String(sessionId ?? '');
    if (id === '') return;
    this.busySessions.delete(id);
  }

  // ── 未投递消息的落盘 ───────────────────────────────────

  #pendingFile(key) {
    return path.join(this.pendingDir, `${String(key).replace(/[:/\\]/g, '-')}.json`);
  }

  /** 把某个会话目前"还没投递出去"的消息写到磁盘。 */
  /**
   * 把水位落盘（节流）。
   *
   * 不立刻写：投递和标记已读可能连着发生，每次写盘没必要。2 秒内的多次变化
   * 合并成一次；stop() 时强制写。
   */
  #saveState(immediate = false) {
    const write = () => {
      this.stateSaveTimer = null;
      try {
        const payload = {
          savedAt: Date.now(),
          buffer: this.buffer.snapshot(),
          deliveredSeq: Object.fromEntries(this.deliveredSeq),
          // 主动苏醒排期：绝对时间戳，重启后接着等（不重置成"从现在起 N 分钟"）
          wakeSchedule: Object.fromEntries(this.wakeSchedule),
        };
        fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
        fs.writeFileSync(this.stateFile, JSON.stringify(payload), 'utf8');
      } catch (error) {
        this.log(`✗ 水位落盘失败：${String(error?.message ?? error)}`);
      }
    };
    if (immediate) {
      if (this.stateSaveTimer !== null) clearTimeout(this.stateSaveTimer);
      write();
      return;
    }
    if (this.stateSaveTimer !== null) return;
    this.stateSaveTimer = setTimeout(write, 2000);
    this.stateSaveTimer.unref?.();
  }

  /**
   * 启动时读回水位。
   *
   * 必须在 #restorePending **之前** 调用 —— 恢复时要按 watermark 过滤，
   * 水位没读回来就等于不过滤（这正是历史重投的成因）。
   */
  #loadState() {
    try {
      const raw = fs.readFileSync(this.stateFile, 'utf8');
      const data = JSON.parse(raw);
      this.buffer.hydrate(data?.buffer);
      for (const [key, seq] of Object.entries(data?.deliveredSeq ?? {})) {
        const n = Number(seq);
        if (Number.isFinite(n) && n > 0) this.deliveredSeq.set(key, n);
      }
      const keys = Object.keys(data?.deliveredSeq ?? {}).length;
      if (keys > 0) {
        this.log(`↺ 已恢复水位（${keys} 个会话，nextSeq ${this.buffer.nextSeq}）`);
      }

      // 主动苏醒排期：绝对时间戳，读回来继续等。
      // 只接受"数字 + 有限值"的 nextAt，坏数据直接跳过 —— 一个烂条目不该
      // 让整个会话的排期失效（那样它会退化成"立刻醒一次"）。
      let restored = 0;
      for (const [key, row] of Object.entries(data?.wakeSchedule ?? {})) {
        const nextAt = Number(row?.nextAt);
        if (!Number.isFinite(nextAt) || nextAt <= 0) continue;
        this.wakeSchedule.set(key, {
          nextAt,
          intervalSec: Number(row?.intervalSec) || 0,
          reason: typeof row?.reason === 'string' ? row.reason : '',
        });
        restored += 1;
      }
      if (restored > 0) {
        const soonest = Math.min(...[...this.wakeSchedule.values()].map((r) => r.nextAt));
        const mins = Math.max(0, Math.round((soonest - Date.now()) / 60000));
        this.log(`↺ 已恢复主动苏醒排期（${restored} 个会话，最近一次在 ${mins} 分钟后）`);
      }
    } catch (error) {
      // 文件不存在 = 首次启动，正常路径，不用吵。
      //
      // 但**其他**错误必须说出来：2026-11-19 调试排期持久化时，就是这里
      // 一个空的 catch 把真实错误吞了，表现成"排期存了但读不回来"，
      // 查了好几轮才想到是解析失败。静默失效比明着失败难查得多。
      if (error?.code !== 'ENOENT') {
        this.log(
          `✗ 状态文件读取失败（${this.stateFile}）：${String(error?.message ?? error)}` +
            ` —— 水位和排期都会从零开始`,
        );
      }
    }
  }

  #persistPending(key) {
    const file = this.#pendingFile(key);
    try {
      // staging + ready 都要落盘：两者都还没送出去，崩溃后都得捡回来。
      // （不算 unconfirmed —— 那些已经送达了，靠 mark_read 清理。）
      const records = this.buffer.undelivered(key)
        .map((r) => ({
        seq: r.seq,
        messageId: r.messageId,
        time: r.time,
        sender: r.sender,
        senderName: r.senderName,
        event: r.event,
      }));
      if (records.length === 0) {
        const had = fs.existsSync(file);
        fs.rmSync(file, { force: true });
        if (had) this.log(`🗑 pending 清空 ${file}（没有待投递的）`);
        return;
      }
      fs.mkdirSync(this.pendingDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ key, savedAt: Date.now(), records }), 'utf8');
      const seqs = records.map((r) => r.seq);
      this.log(
        `💾 pending 写入 ${file}（${records.length} 条，seq ${Math.min(...seqs)}-${Math.max(...seqs)}）`,
      );
    } catch (error) {
      // 落盘失败不能影响收消息，但必须喊出来 —— 不然"消息没丢"这个保证是假的。
      this.log(`✗ pending 写入失败 ${file}：${String(error?.message ?? error)}`);
    }
  }

  /** 投递成功后清掉。删失败无所谓 —— 恢复时会按水位过滤，不会重复投递。 */
  #clearPending(key, reason = '') {
    const file = this.#pendingFile(key);
    try {
      const existed = fs.existsSync(file);
      fs.rmSync(file, { force: true });
      if (existed) {
        this.log(`🗑 pending 删除 ${file}${reason ? `（${reason}）` : ''}`);
      }
    } catch (error) {
      this.log(`✗ pending 删除失败 ${file}：${String(error?.message ?? error)}`);
    }
  }

  /** 启动时把上次没投递出去的捡回来，重新走一遍缓冲期。 */
  #restorePending() {
    let files = [];
    try {
      files = fs.readdirSync(this.pendingDir).filter((f) => f.endsWith('.json'));
    } catch {
      this.log(`📂 pending 目录 ${this.pendingDir}（不存在，无待恢复）`);
      return;
    }
    this.log(`📂 pending 目录 ${this.pendingDir}（${files.length} 个文件待检查）`);
    for (const name of files) {
      const file = path.join(this.pendingDir, name);
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        const key = String(data?.key ?? '');
        if (key === '') {
          fs.rmSync(file, { force: true });
          continue;
        }
        // 不需要再用 deliveredSeq 过滤：三队列里 ready 本身就只含未投递的，
        // 而 buffer.restore() 内部会按 watermark 挡掉已读过的。
        const floor = this.buffer.watermark(key);
        const records = (Array.isArray(data?.records) ? data.records : []).filter(
          (r) => Number(r?.seq) > floor,
        );
        const before = Array.isArray(data?.records) ? data.records.length : 0;
        this.log(
          `📂 读取 ${file}：文件里 ${before} 条，水位 ${floor} 过滤后剩 ${records.length} 条`,
        );
        const restored = this.buffer.restore(key, records);
        if (restored === 0) {
          // 全都被水位挡下了 = 其实已经处理过，文件是残留
          fs.rmSync(file, { force: true });
          this.log(`🗑 pending 删除 ${file}（全部已被水位过滤，属于残留）`);
          continue;
        }
        this.log(`↺ 恢复 ${key} 未投递的 ${restored} 条消息（上次退出前没送达）`);
        this.#scheduleBufferedWake(key); // 重新走缓冲期，不一股脑立刻叫醒
      } catch {
        try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
      }
    }
  }

  /** 缓冲期满：把这段时间攒下的消息一次性交给 agent。 */
  async #deliverBuffered(key) {
    const unread = this.buffer.unread(key);
    if (unread.length === 0) return;

    // 没配置绑定 = 永久投不出去。这类消息不进 pending、不反复重试 ——
    // 否则每次启动都会重投一遍、每次都失败，pending 目录和日志只会越积越多。
    // 消息本身在聊天日志里已经留痕了，"收到过什么"仍然查得到。
    if (this.#sessionIdFor(key) === '') {
      const top = Math.max(...unread.map((r) => r.seq));
      this.buffer.markRead(key, top);
      this.#clearPending(key, '没有配置绑定，直接丢弃');
      this.log(
        `🗑 丢弃 ${key}（${unread.length} 条）：没有配置绑定，不保留待投递` +
          `（在设置页 bindings 里加一条才能接住这个号）`,
      );
      return;
    }

    // 会话正在跑 turn 时，**不再挂起**。
    //
    // 旧做法是塞进 pendingByKey 等 turn/end 补发，结果长任务期间彻底失联 ——
    // 任务跑十分钟，这十分钟里主人说的话全在排队，一句都进不来
    // （2026-10-30 用户实测反馈）。
    //
    // 现在照常投递：DSH 的 steer 是**插到最近的 step 边界**，不会中断正在执行的
    // 工具调用，只是让模型在下一步看到"主人又说话了"。是停下手里的活先回，
    // 还是应一声接着做，交给它自己判断（persona 里写了这个规矩）。
    const busy = this.#isBusy(key);

    const wake = this.effectiveWake(key);
    const gate = this.#admitWake(key, wake, { messageWake: true }); // 人来的消息，不设限
    if (!gate.ok) {
      // 消息不会丢：留在缓冲里，等下次唤醒（或主动苏醒）一起带上。
      this.log(`⏸ 缓冲期满但被限（${key}）：${gate.why}`);
      return;
    }
    const latest = unread[unread.length - 1];
    if (busy) {
      this.log(`⚡ 唤醒 ${key}（${unread.length} 条新消息；这一轮还没结束，插到下一步）`);
    } else {
      this.log(`🔔 唤醒 ${key}（${unread.length} 条消息定稿，本小时第 ${gate.count} 次）`);
    }
    const delivered = await this.onWake?.({
      key,
      reason: 'buffer',
      event: latest?.event,
      seq: latest?.seq,
      busy,
    });
    // 只有真的投出去了才删文件。投递失败（会话取不到、steer 抛错）就留着，
    // 下次启动还能捡回来 —— 这正是这个文件存在的意义。
    if (!delivered?.ok) {
      // "跳过"不算失败：消息没丢，只是被 wait 直接交付了（正文真的到了模型手上）。
      // 记成失败会误导排查 —— 日志里会写"投递失败"，而实际上那批消息已经读过了。
      if (delivered?.skipped) {
        this.log(`⏭ ${key} 唤醒跳过：${delivered.why ?? '已被 wait 接管'}`);
        return;
      }
      // 结果也要记：不然「消息丢了」时，日志里只有"收到了"，看不出送到没送到 AI 那里。
      this.log(
        `✗ 投递失败 ${key}（${unread.length} 条留在 pending，下次启动重试）：` +
          `${delivered?.why ?? '未返回原因'}`,
      );
    }
    if (delivered?.ok) {
      // **故意不 markDelivered**。
      //
      // 唤醒提示现在只报「有 N 条」，正文没有随提示交给模型 —— 所以这批消息
      // 必须留在 ready 里，等模型自己用 qq_wait_for_messages / qq_get_unread_messages
      // 来取。之前在这里无条件 markDelivered，导致提示说"有 1 条"、
      // 两个读接口却都是空的（2026-11-16 实测，只能去翻聊天日志）。
      //
      // 「送达」的定义收窄为：**正文真的出现在模型可见的输出里**。
      // 唤醒不算，wait 拿到才算（见 waitForMessages 的 resolve 包装）。
      this.log(
        `✓ 已唤醒 ${key}（提示只报条数，${unread.length} 条正文仍留在 ready 等模型来取）`,
      );
      // pending 也不删：这批还没被模型看过。
    }
  }

  /**
   * 把这条消息里的图片落盘。
   *
   * 刻意**不 await**：图片下载可能几百毫秒，而消息缓冲和唤醒判定不该等它。
   * 下载完成后把路径写到 `seg.data.localPath` 上（就地改，record 持有同一个 event 引用）。
   * 注意唤醒提示是在 onWake 时拼的，如果图片还没下完，提示里会显示"下载中"——
   * 这是可接受的降级：模型可以稍后用 read_image 再试，或者模型根本不需要这张图。
   */
  /**
   * 图片会落到哪儿 —— 下载前就算出来，供聊天日志直接写全路径。
   *
   * 目录跟随工作区（与日志同源）；文件名就是上游的 file 字段。
   * 上游没给文件名时落盘名带随机串，预知不了，只能标注"下载后确定"。
   */
  #imageTargetHints(event) {
    const segs = imageSegmentsOf(segmentsOf(event));
    if (segs.length === 0) return [];
    const dir =
      typeof this.config.resolveImageDir === 'function'
        ? this.config.resolveImageDir()
        : this.config.imageDir;
    return segs.map((seg) => {
      const name = String(seg.data?.file ?? '').trim();
      if (!dir || !name) return '[图片] 路径下载后确定';
      return path.join(dir, name);
    });
  }

  #fetchImages(event, chatKey = '') {
    // 优先懒解析：apply 时 QQ 会话往往还没加载，resolveWorkspace() 会退到插件目录，
    // 于是图片和日志分家。这里每次下载前再问一次，才能跟日志落在同一个工作区目录下。
    const dir =
      typeof this.config.resolveImageDir === 'function'
        ? this.config.resolveImageDir()
        : this.config.imageDir;
    if (!dir) return;
    for (const seg of imageSegmentsOf(segmentsOf(event))) {
      if (seg.data.localPath || seg.data.imagePending) continue;
      seg.data.imagePending = true;
      downloadImage({ url: seg.data.url, destDir: dir, filename: seg.data.file ?? '' })
        .then((result) => {
          seg.data.imagePending = false;
          if (result.ok) {
            seg.data.localPath = result.path;
            this.log(`🖼 图片已保存：${result.path}（${result.bytes} 字节）`);
          } else {
            seg.data.localError = result.error;
            this.log(`✗ 图片下载失败：${result.error}`);
            if (chatKey) this.#appendChat(chatKey, `   ↳ 图片下载失败：${result.error}`);
          }
        })
        .catch((error) => {
          seg.data.imagePending = false;
          seg.data.localError = String(error?.message ?? error);
          if (chatKey) this.#appendChat(chatKey, `   ↳ 图片下载异常：${seg.data.localError}`);
        });
    }
  }

  /**
   * 等该会话里正在下载的图片落盘（最多 timeoutMs）。
   *
   * 为什么需要：`#fetchImages` 刻意不 await（不能因为一张图卡住事件处理），
   * 但唤醒几乎是在消息到达的同一瞬间触发的 —— 于是提示里会写"图片还在下载"，
   * 模型要么白跑一趟、要么放弃看图。
   * 这里在**投递前**等一小会儿（默认 2 秒），足够覆盖绝大多数图片（实测 214ms / 58KB）。
   * 超时也不阻塞，照常发提示（里面会写明还在下载）。
   */
  async settleImages(key, timeoutMs = 2000) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const hasPending = () =>
      this.buffer
        .recent(key, 50)
        .some((record) =>
          imageSegmentsOf(segmentsOf(record.event)).some((seg) => seg.data?.imagePending === true),
        );
    while (Date.now() < deadline) {
      if (!hasPending()) return { ok: true };
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    return { ok: false, why: '图片下载超时' };
  }

  /**
   * 限频闸门。返回 ok=false 时调用方跳过本次唤醒。
   *
   * 两类唤醒的经济学完全不同，所以拆开算：
   *
   * - **消息唤醒**（`messageWake: true`）：**任何限流都不生效**。
   *   人来找你，就该立刻回；连发刷屏早被缓冲期（debounce）合并成一次了，
   *   再拿上限去挡，只会让用户觉得"它坏了"
   *   （2026-10-29 用户实测「我的消息也被唤醒间隔限制了？这不对吧」）。
   *
   * - **主动苏醒**（不传）：只剩**每小时上限**。
   *   冷却已于 2026-11-19 删除（排期本身保证间隔，而且"拒绝后重排"会死循环）。
   */
  #admitWake(key, wake, options = {}) {
    const now = Date.now();
    const history = (this.wakeHistory.get(key) ?? []).filter((t) => now - t < 3600_000);

    // 消息唤醒：只记账（供统计/展示），不做任何拦截。
    if (options.messageWake) {
      history.push(now);
      this.wakeHistory.set(key, history);
      this.lastWakeAt.set(key, now);
      return { ok: true, count: history.length };
    }

    // 主动苏醒：只剩**每小时上限**这一道闸。
    //
    // 冷却（minIntervalSec）2026-11-19 用户拍板删掉：
    //   · 排期本身已经保证最小间隔（间隔 × (1 - jitter)），冷却纯冗余
    //     —— 45 分钟 × 0.8 = 36 分钟，冷却是 30 分钟，永远撞不上；
    //   · 更糟的是「拒绝后重排」会**死循环**：间隔 20 分钟、冷却 30 分钟时，
    //     每次算出 16~24 分钟、每次被拒、重排出来还是 16~24 分钟 → 永远不醒。
    //     而这种失败是静默的（日志只有"冷却未过"），最难查。
    //
    // 保留的这道上限是**温和的保险丝**：一小时窗口自然滚动，不会永久卡死。
    if (history.length >= wake.maxPerHour) {
      return { ok: false, why: `本小时主动苏醒已达上限 ${wake.maxPerHour} 次` };
    }
    history.push(now);
    this.wakeHistory.set(key, history);
    this.lastWakeAt.set(key, now);
    return { ok: true, count: history.length };
  }

  // ── 主动苏醒 ─────────────────────────────────────────────

  /**
   * 启动"苏醒间隔"定时器。
   *
   * 语义（用户 2026-10-29 拍板）：**每隔一段时间唤醒会话，让 AI 自己决定要不要
   * 主动找主人说话**。不再是"按概率响应消息"，而是定期给 agent 一个开口的机会。
   *
   * 所以这里**不看有没有未读** —— 没有新消息也会醒，醒来后由提示告诉它
   * "现在没有新消息，你可以决定要不要主动说点什么"。想说就用 qq_send_message，
   * 不想说就什么都不做（那一轮不产生任何 QQ 输出）。
   */
  #startProactiveTimer() {
    this.#stopPoller();

    // 2026-11-19 改造：**固定 5 分钟轮询**，不再是"间隔到了再 setTimeout"。
    //
    // 为什么换掉链式 setTimeout：
    //   ① 它和"现在几点""你上次什么时候说话"都无关，进程一重启就从零开始数
    //      （用户 2026-11-18：「重启了他的计时器也重启了，所以很尴尬」）；
    //   ② 一次排 45 分钟的 setTimeout 在休眠/时钟跳变下不可靠；
    //   ③ 轮询天然免疫上面两条 —— 每次醒来只看"排期到点了吗"，与进程活了多久无关。
    //
    // 代价：苏醒时间精度变成 ±5 分钟。对"不定时主动聊天"完全够。
    const POLL_MS = 5 * 60 * 1000;
    const tick = () => {
      this.#wakePollTick().catch((error) =>
        this.log(`✗ 主动苏醒轮询异常：${String(error?.message ?? error)}`),
      );
    };
    // 立刻跑一次：启动/改配置时可能已经有排期到点了，不该再等 5 分钟。
    tick();
    this.pollTimer = setInterval(tick, POLL_MS);
    this.pollTimer.unref?.();
  }

  #stopPoller() {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * 当前是否落在主动苏醒的时段窗口内。
   *
   * 参数按 24 小时制：默认 8–23（含 8 点，不含 23 点）。
   * 起 > 止 表示跨午夜（22 → 6）；两者相等当全天处理。
   * 只约束**主动苏醒**；有消息进来该唤醒照样唤醒（人来找你，不分几点）。
   */
  #inActiveWindow() {
    const hour = new Date().getHours();
    const rawStart = Number(this.config.wake?.activeStartHour ?? 8);
    const rawEnd = Number(this.config.wake?.activeEndHour ?? 23);
    const start = Number.isFinite(rawStart) ? Math.min(23, Math.max(0, Math.trunc(rawStart))) : 8;
    const end = Number.isFinite(rawEnd) ? Math.min(24, Math.max(0, Math.trunc(rawEnd))) : 23;
    if (start === end) return true;
    if (start < end) return hour >= start && hour < end;
    return hour >= start || hour < end;
  }

  /**
   * 「这一轮聊完了」—— 让主动苏醒的排期从**现在**重新起算。
   *
   * 用户 2026-11-18 提的设计：「在我找你的时候，主动苏醒计时器停止工作，
   * 等你调用那个结束会话标识的时候，去重新拉起这个计时器」。
   *
   * 和"消息到达自动重排"的区别：
   *   · 自动重排锚在**消息到达**的那一刻；
   *   · 这个工具锚在**你调用**的那一刻。
   * 中间隔着你处理并回复的几分钟 —— 所以聊得久的时候，用这个更准。
   *
   * 兜底：**不调这个工具也不会永远不醒**。消息到达本来就会重排，
   * 而且排期到点后还有 `proactiveQuietSec` 之类的闸门把关。
   *
   * @param {string} key - `private:<QQ 号>`
   * @param {string} [note] - 只进日志，方便回查"这句聊完是什么时候标的"
   * @returns 无损 JSON（不能有 undefined —— DSH 的工具输出校验要求）
   */
  endConversation(key, note = '') {
    const k = String(key ?? '');
    if (!/^private:\d+$/.test(k)) {
      return { ok: false, why: '只支持私聊会话（形如 private:12345678）', nextAt: 0, nextInMinutes: 0 };
    }
    if (!this.#proactiveKeys().includes(k)) {
      return {
        ok: false,
        why: '这个会话没有配绑定，主动苏醒本来就不会作用于它',
        nextAt: 0,
        nextInMinutes: 0,
      };
    }
    const wake = this.effectiveWake(k);
    if (wake.proactive === false) {
      return { ok: false, why: '主动苏醒已关闭（wake.proactive = false）', nextAt: 0, nextInMinutes: 0 };
    }

    // 显式结束 → 连续空等的计数没有意义了（这一段已经正式收尾）
    this.waitTimeouts.delete(k);

    this.#reschedule(k, Date.now(), { reason: 'conversation-ended' });
    const row = this.wakeSchedule.get(k);
    const nextAt = Number(row?.nextAt) || 0;
    const nextInMinutes = nextAt > 0 ? Math.max(0, Math.round((nextAt - Date.now()) / 60000)) : 0;
    this.log(
      `💤 ${k} 会话结束${note === '' ? '' : `（${note}）`} → 下次主动苏醒在 ${nextInMinutes} 分钟后`,
    );
    return { ok: true, why: '', nextAt, nextInMinutes };
  }

  /**
   * 一次主动苏醒 tick。
   *
   * 保留为公开方法（不是 `#private`）：便于单测和手动触发 —— 它现在等价于
   * "对这轮该醒的会话各试一次"，不再自己管时间节奏（节奏交给 #wakePollTick）。
   */
  async proactiveTick() {
    for (const key of this.#proactiveKeys()) {
      await this.#proactiveAttempt(key, Date.now());
    }
  }

  /** 主动苏醒只看**绑定的私聊**（群聊 `qq_*` 都不做，这里更不该往群里跑）。 */
  #proactiveKeys() {
    const bindings = Array.isArray(this.config.bindings) ? this.config.bindings : [];
    const out = [];
    for (const row of bindings) {
      const key = String(row?.key ?? '');
      if (/^private:\d+$/.test(key)) out.push(key);
    }
    return out;
  }

  /**
   * 5 分钟轮询的主体：只看"排期到点的会话"，没到点的一律不碰。
   *
   * 这样"每 5 分钟跑一次"不会变成"每 5 分钟叫一次模型"——绝大多数轮次什么都不做。
   */
  async #wakePollTick() {
    if (this.config.observeOnly) return;
    // 上一轮还没跑完就跳过：乘号里的 steer 可能卡住，不该叠出第二轮
    if (this.pollBusy) return;
    this.pollBusy = true;
    try {
      const now = Date.now();
      for (const key of this.#proactiveKeys()) {
        const sched = this.wakeSchedule.get(key);

        // 没有排期：首次启动、刚加绑定、或状态被清 —— 现在排一个，不立刻醒。
        if (sched === undefined) {
          this.#reschedule(key, now, { reason: 'init' });
          continue;
        }

        const wake = this.effectiveWake(key);
        if (wake.proactive === false) {
          // 主动苏醒关着：不排期也不触发，等用户打开再重排
          this.wakeSchedule.delete(key);
          continue;
        }

        const plannedMs = Math.max(1000, Number(sched.intervalSec || 0) * 1000);
        const ratio = this.#overdueRatio(wake);
        const { due, stale } = evaluateDue(sched.nextAt, now, plannedMs, ratio);
        if (!due) continue;

        if (stale) {
          // 过期太久（典型：电脑休眠一夜）→ 不该补醒，直接重排
          const mins = Math.round((now - sched.nextAt) / 60000);
          this.log(`⏭ ${key} 排期已过期 ${mins} 分钟（超过 ${ratio}×间隔），不补醒，改为重排`);
          this.#reschedule(key, now, { reason: 'stale' });
          continue;
        }

        await this.#proactiveAttempt(key, now);
      }
    } finally {
      this.pollBusy = false;
    }
  }

  /** 对单个会话尝试一次主动苏醒。**无论成败都会重排**，否则会卡死在同一个点。 */
  async #proactiveAttempt(key, now) {
    // 时段窗口：夜里不主动打扰。有消息唤醒不受这个限制。
    if (!this.#inActiveWindow()) {
      const start = this.config.wake?.activeStartHour ?? 8;
      const end = this.config.wake?.activeEndHour ?? 23;
      this.log(`🌙 主动苏醒跳过 ${key}：当前 ${new Date().getHours()} 点，不在 ${start}–${end} 点窗口内`);
      this.#reschedule(key, now, { reason: 'quiet-window' });
      return;
    }

    const wake = this.effectiveWake(key);
    if (wake.proactive === false) {
      this.wakeSchedule.delete(key);
      return;
    }

    // 会话正在跑 turn：主动苏醒**不该**插进去。
    //
    // 和消息唤醒是有意区别对待的：消息唤醒是主人说话，忙也要送达（那条路径会
    // 带 busy=true 继续投递）；主动苏醒是它自己找话说，没有紧迫性，打断只会
    // 干扰主人正在等的事。所以这里直接跳过，等下一轮 —— 不消耗冷却配额。
    if (this.#isBusy(key)) {
      this.log(`🌙 主动苏醒跳过 ${key}：会话正在执行任务，不打断`);
      this.#reschedule(key, now, { reason: 'busy' });
      return;
    }

    // 正在 qq_wait_for_messages 里等 → 那就是"还在聊"，不该插话。
    // （2026-11-18 加的 hasActiveWaiter；即使对话已结束，这条也能挡住长轮询期间的空隙。）
    if (this.activeWaits.has(key)) {
      this.log(`🌙 主动苏醒跳过 ${key}：正在 qq_wait_for_messages 里等，不插话`);
      this.#reschedule(key, now, { reason: 'waiting' });
      return;
    }

    // 刚聊过也别插话：#isBusy 挡不住"两个 turn 之间"的空隙（turn/end 一到
    // busy 就变 false，而对话是密集切换的）。要求"安静够久"才允许主动开口。
    const quietMs = Math.max(0, Number(wake.proactiveQuietSec ?? 120)) * 1000;
    const lastAt = this.lastMessageAt.get(key) ?? 0;
    if (quietMs > 0 && lastAt > 0 && Date.now() - lastAt < quietMs) {
      const ago = Math.round((Date.now() - lastAt) / 1000);
      this.log(`🌙 主动苏醒跳过 ${key}：${ago}s 前刚聊过（需静默 ${quietMs / 1000}s）`);
      this.#reschedule(key, now, { reason: 'recent-chat' });
      return;
    }

    const gate = this.#admitWake(key, wake);
    if (!gate.ok) {
      // 用户 2026-11-19 明确：被冷却拦住就**丢弃这一次、正常重算下一次**，
      // 不要为了绕开冷却去篡改间隔。
      this.log(`🌙 主动苏醒跳过 ${key}：${gate.why} —— 本次丢弃，重排下一次`);
      this.#reschedule(key, now, { reason: 'cooldown' });
      return;
    }

    const unread = this.buffer.unread(key);
    this.log(`🌙 主动苏醒 ${key}（未读 ${unread.length} 条，本小时第 ${gate.count} 次）`);
    this.onWake?.({ key, reason: 'proactive', event: null, seq: null });
    this.#reschedule(key, now, { reason: 'delivered' });
  }

  /**
   * 记录一次 `qq_wait_for_messages` 的结果，连续空等够次数就当作"这一段聊完了"。
   *
   * 用户 2026-11-19 定的规则：**wait 超时两次之后默认结束会话**。
   *
   * 为什么需要它：`qq_end_conversation` 靠 Agent 主动调，而它有时候会忘（或者在
   * 长任务里顾不上）。没有兜底的话，排期就停在"最后一条消息 + 间隔"上 ——
   * 这个其实不会卡死（消息到达本来就会重排），但**聊得久的时候计时会偏早**。
   * 连续两次空等是很强的信号："对方确实不说了"。
   *
   * 什么算"空等"：`timeout === true` **且没有拿到任何消息**。
   * 超时但拿到了消息（比如"再等一轮"期间来了消息）说明对方还在说，不算。
   *
   * @param {string} key
   * @param {{ timeout?: boolean, messages?: unknown[] }} value - wait 的返回值
   */
  #trackWaitOutcome(key, value) {
    const gotMessages = Array.isArray(value?.messages) && value.messages.length > 0;

    // 拿到消息 = 对方还在说话 → 计数清零
    if (gotMessages) {
      if (this.waitTimeouts.delete(key)) {
        this.log(`⏱ ${key} wait 拿到消息，连续空等计数清零`);
      }
      return;
    }

    // 不是超时（比如 runtime 停止导致的 resolve）→ 不计数
    if (value?.timeout !== true) return;

    const next = (this.waitTimeouts.get(key) ?? 0) + 1;
    this.waitTimeouts.set(key, next);

    const limit = this.#waitTimeoutLimit(key);
    if (next < limit) {
      this.log(`⏱ ${key} wait 空等第 ${next}/${limit} 次`);
      return;
    }

    this.waitTimeouts.delete(key);
    this.log(`⏱ ${key} wait 连续空等 ${next} 次 → 默认这一段聊完了，重排主动苏醒`);
    this.#postponeWakeSchedule(key);
  }

  /**
   * 连续空等多少次算聊完。配置坏了兜底到 2（用户 2026-11-19 定的值）。
   *
   * 传 key 而不是空串：`effectiveWake` 会合并**会话级**配置，
   * 传空串就拿不到 per-key 的覆盖值了。
   */
  #waitTimeoutLimit(key) {
    const n = Number(this.effectiveWake(key).waitTimeoutsBeforeEnd ?? 2);
    return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : 2;
  }

  /**
   * 重算并落盘某个会话的下次主动苏醒时间。
   *
   * @param {string} key
   * @param {number} now - 基准时刻（**用"现在"判断是否工作时段**，用户 2026-11-19 拍板）
   * @param {{ reason?: string }} [options] - 只影响日志和记录，不改变计算
   */
  #reschedule(key, now, { reason = 'normal' } = {}) {
    try {
      const wake = this.effectiveWake(key);
      const baseMs = Math.max(10_000, Number(wake.wakeIntervalSec ?? 300) * 1000);
      const inWork = this.#inWorkNow(wake);

      const { intervalMs, mode, jitterPct } = computeIntervalMs({
        baseMs,
        jitterRatio: wake.jitterRatio,
        workMultiplier: wake.workJitterMultiplier,
        inWork,
      });

      // 落在夜间静默窗口里就顺延到活跃窗口开始的那个整点。
      //
      // 传的是**活跃窗口**（activeStartHour / activeEndHour），静默窗口由
      // skipQuietWindow 自己反推。2026-11-19 这里曾把两个概念搞混过：
      // 函数当时要静默窗口，调用传了活跃窗口，于是白天被当成静默时段 ——
      // 15:30 算出的 16:15 被推到 23:00，日志显示「468 分钟后苏醒」。
      // 现在函数接受活跃窗口，语义和这里一致，不会再传反。
      const nextAt = skipQuietWindow(
        now + intervalMs,
        wake.activeStartHour,
        wake.activeEndHour,
      );

      this.wakeSchedule.set(key, {
        nextAt,
        intervalSec: Math.round(intervalMs / 1000),
        reason: `${reason}/${mode}`,
      });
      // **立即写盘**，不走 #saveState 的 2 秒节流。
      //
      // 理由：排期丢了不是"少写一条日志"，而是重启后会按 reason='init' 重排 ——
      // 等于"从现在起再等 45 分钟"，正是这次改造要消除的行为。
      // 而且排期变动不频繁（每 40~50 分钟一次），立刻写没有性能顾虑。
      this.#saveState(true);

      const mins = Math.round((nextAt - now) / 60000);
      const pct = `${jitterPct >= 0 ? '+' : ''}${Math.round(jitterPct * 100)}%`;
      this.log(
        `🗓 ${key} 下次主动苏醒 ${mins} 分钟后` +
          `（${mode === 'work' ? '工作时段' : '非工作'}，基准 ${Math.round(baseMs / 60000)} 分 ${pct}）`,
      );
    } catch (error) {
      this.log(`✗ 排期计算失败 ${key}：${String(error?.message ?? error)}`);
    }
  }

  /** 现在是不是工作时段（用"现在"判断，不看算出来的目标时刻）。 */
  #inWorkNow(wake) {
    const spans = parseWorkSpans(wake.workHours).spans;
    if (spans.length === 0) return false;
    const calendar = this.workdayCalendar;
    if (calendar === undefined || calendar === null) return false;
    try {
      return calendar.isWorkTime(new Date(), spans).inWork;
    } catch {
      return false;
    }
  }

  /** 过期判定的倍数（配置坏了要有兜底，不能被一个 NaN 搞成"永不过期"）。 */
  #overdueRatio(wake) {
    const n = Number(wake.overdueResetRatio);
    return Number.isFinite(n) && n >= 1 ? n : 2;
  }

  /**
   * 重排**所有**正在参与主动苏醒的会话。
   *
   * 用在"排期相关配置改了"的时候：排期是提前算好存起来的绝对时间戳，
   * 配置改了不重排就等于没改（用户会以为"设置没生效"）。
   *
   * @param {string} reason - 只进日志
   */
  #rescheduleAll(reason = 'manual') {
    const now = Date.now();
    for (const key of this.#proactiveKeys()) {
      const wake = this.effectiveWake(key);
      if (wake.proactive === false) {
        this.wakeSchedule.delete(key);
        continue;
      }
      this.#reschedule(key, now, { reason });
    }
    this.log(`↻ 已重排 ${this.wakeSchedule.size} 个会话的主动苏醒（原因：${reason}）`);
  }

  /**
   * 主人刚说过话 → 把排期往后推。
   *
   * 这是"聊完 10 分钟就被叫醒"的根治办法（2026-11-19 用户实测反馈）。
   *
   * 为什么这条不会重踩 2026-11-03 那个坑：
   *   · 那时错在让**冷却**去看 lastWakeAt（那个会被消息刷新），结果"越常聊天越不主动"；
   *   · 这里刷新的是**排期**，语义就是"聊完才开始计时"——你一直在说话，
   *     它就不该主动找你，这本来就是想要的。
   * 语义上的区别：**冷却**问的是"两次苏醒隔够久了吗"，**排期**问的是"下次该什么时候醒"。
   * 前者的答案不该受你说话影响，后者正该受影响。
   */
  #postponeWakeSchedule(key) {
    const wake = this.effectiveWake(key);
    if (wake.proactive === false) return;
    // 只对真正参与主动苏醒的会话生效（绑定的私聊），别给群聊之类的也建条目
    if (!this.#proactiveKeys().includes(key)) return;
    this.#reschedule(key, Date.now(), { reason: 'after-message' });
  }

  // ── 会话级配置 ───────────────────────────────────────────

  effectiveWake(key) {
    const scoped = { ...(this.config.wake ?? {}), ...(this.wakeConfigs.get(key) ?? {}) };
    const merged = { ...DEFAULT_WAKE, ...scoped };
    // 顶层 ownerId 注入进来：wake.js 只认 wake.ownerId。
    if (merged.ownerId === undefined) merged.ownerId = this.config.ownerId ?? '';
    return merged;
  }

  /**
   * 热替换配置（设置页保存后调用）。
   *
   * 为什么大部分项能这么简单：本类所有配置读取都是 `this.config.xxx` 的**实时读取**，
   * 没有在构造时缓存成局部变量的（buffer 除外，它跟唤醒无关）。换掉引用就立刻生效。
   *
   * 例外是**连接类字段**（wsUrl / httpUrl / accessToken / homeDir）：它们经 start()
   * 固化成了 `this.endpoint` 和 `this.client`，换 config 不会让连接自己搬家 ——
   * 所以这里检出变化后主动 restart()，用户不用再重启 DSH。
   *
   * @returns {{config: object, reconnecting: boolean}} reconnecting = 已异步触发重连
   */
  applyConfig(nextConfig) {
    if (!nextConfig || typeof nextConfig !== 'object') {
      return { config: this.config, reconnecting: false };
    }
    const previous = this.config;
    this.config = { ...nextConfig };

    const connectionKey = (cfg) =>
      [cfg?.snowLuma?.wsUrl, cfg?.snowLuma?.httpUrl, cfg?.snowLuma?.accessToken, cfg?.snowLuma?.homeDir]
        .map((part) => String(part ?? ''))
        .join('\u0000');
    const reconnecting = connectionKey(previous) !== connectionKey(this.config);
    if (reconnecting) {
      this.restart().catch(() => {}); // restart 内部自己记日志
      return { config: this.config, reconnecting };
    }

    // 苏醒间隔改了要**立刻重建定时器**。
    // 链式 setTimeout 虽然每次会重读配置，但当前这一轮已经按旧间隔排好了 ——
    // 把 30 分钟改成 5 分钟，得等那 30 分钟走完才生效，用户会觉得"设置没起作用"。
    const wakeIntervalChanged =
      Number(previous?.wake?.wakeIntervalSec) !== Number(this.config?.wake?.wakeIntervalSec);
    const windowChanged =
      Number(previous?.wake?.activeStartHour) !== Number(this.config?.wake?.activeStartHour) ||
      Number(previous?.wake?.activeEndHour) !== Number(this.config?.wake?.activeEndHour);

    // 排期相关配置（2026-11-19 新增）。任何一个变了都要重排 ——
    // 排期是"提前算好一个绝对时间戳"存起来的，配置改了不重排就等于没改。
    const scheduleChanged =
      String(previous?.wake?.workHours ?? '') !== String(this.config?.wake?.workHours ?? '') ||
      String(previous?.wake?.workDays ?? '') !== String(this.config?.wake?.workDays ?? '') ||
      Number(previous?.wake?.jitterRatio) !== Number(this.config?.wake?.jitterRatio) ||
      Number(previous?.wake?.workJitterMultiplier) !==
        Number(this.config?.wake?.workJitterMultiplier) ||
      Number(previous?.wake?.overdueResetRatio) !==
        Number(this.config?.wake?.overdueResetRatio);

    if (scheduleChanged) {
      // workDays 是日历对象内部持有的，改了要同步过去（否则节假日判断还用旧规则）
      this.workdayCalendar?.setWorkDays?.(this.config?.wake?.workDays);
      this.#rescheduleAll('config');
    }

    if (wakeIntervalChanged || windowChanged || scheduleChanged) {
      // 轮询间隔本身是固定的 5 分钟，重建只是为了让"立刻跑一次"发生
      this.#startProactiveTimer();
      this.log(
        `↻ 主动苏醒已按新配置重排（间隔 ${Number(this.config?.wake?.wakeIntervalSec ?? 300)}s` +
          `${scheduleChanged ? '，排期配置变更' : ''}）`,
      );
    }

    return { config: this.config, reconnecting };
  }

  setWakeConfig(key, patch) {
    const next = { ...(this.wakeConfigs.get(key) ?? {}), ...(patch ?? {}) };
    this.wakeConfigs.set(key, next);
    return this.effectiveWake(key);
  }

  // ── 供工具调用的接口 ─────────────────────────────────────

  summary(key) {
    const wake = this.effectiveWake(key);
    return {
      key,
      selfId: this.selfId,
      endpoint: this.endpoint?.baseUrl ?? null,
      observedOnly: this.config.observeOnly !== false,
      connected: this.client?.state === 'open',
      wake,
      buffer: this.buffer.stats(key),
    };
  }

  unread(key) {
    return this.buffer.unread(key).map(toView);
  }

  /**
   * 这个会话现在有没有长轮询在等？
   *
   * 用途：唤醒投递前的最后一道闸。`#deliverBuffered` 在**开头**拍了 unread 快照，
   * 但真正的 steer 发生在 `await resolveAgent()` / `await settleImages()` 之后 ——
   * 那几百毫秒到 2 秒里模型完全可能正好调了 `qq_wait_for_messages`。
   * 这时消息已经直接交给 wait 了，再插一条「有 N 条」就是同一批说两遍
   * （2026-11-18 用户从 UI 上看到的「wait 和插话同时生效」）。
   *
   * 注意：这只能拦住"还没 steer 出去"的。**已经 steer 的撤不回来**
   * —— DSH 没有 unsend，`agent.steer()` 一旦调用就进了对方的 inbox。
   */
  hasActiveWaiter(key) {
    return this.activeWaits.has(key);
  }

  /**
   * **模型视角的「未读」** = 还没 mark_read 的全部消息（ready + unconfirmed）。
   *
   * 和 unread() 的区别：
   *   · ready        正文还没交给模型（唤醒只报了条数）
   *   · unconfirmed  正文交过了（wait 拉的），但模型没标已读
   *
   * 对"还有什么没处理的"这个诉求来说两者都算未读，所以 get_unread 用这个。
   * 只返回 ready 会造成：唤醒说"有 1 条"，get_unread 却是空数组（2026-11-16 反馈）。
   */
  pendingMessages(key) {
    const all = [...this.buffer.unread(key), ...this.buffer.pendingConfirm(key)];
    return all.sort((a, b) => a.seq - b.seq).map(toView);
  }

  recent(key, limit = 10) {
    return this.buffer.recent(key, limit).map(toView);
  }

  markRead(key, throughSeq) {
    const result = this.buffer.markRead(key, throughSeq);
    // 水位变了就要落盘 —— 这是重启后过滤"已读消息"的唯一依据。
    if (result?.ok) {
      this.#saveState();
      // 已读意味着模型确认处理过这批消息，pending 没有继续留着的理由。
      // （投递成功只代表"送进 agent 了"，标记已读才代表"真的读到了"。）
      this.#clearPending(key, `已读至 seq ${throughSeq}`);
    }
    return result;
  }

  /** 发消息（按会话 key 自动判断群/私聊）。 */
  async send(key, messages, options = {}) {
    if (!this.endpoint) return { ok: false, error: '协议端点未就绪' };
    const head = key.split(':')[0];
    const target = key.split(':')[1];
    const kind = head === 'group' ? 'group' : 'private';
    const result = await sendText({
      baseUrl: this.endpoint.baseUrl,
      token: this.endpoint.token,
      kind,
      target,
      text: messages,
      delayMs: options.delayMs ?? 400,
    });
    // 发出去什么就记什么 —— 聊天日志要有来有回，只记"收到"没法复盘。
    // 记在发送这一层（而不是监听 agent 输出）是因为：这才是**实际抵达 QQ 的内容**，
    // 不会把"AI 想说但没发"混进来。
    this.#logOutgoing(key, result);
    return result;
  }

  /**
   * 把一个 QQ 会话映射成日志子目录名。
   *
   * 绑定了 DSH 会话就用 sessionId（一眼能对上是哪个窗口）；没绑定就用会话 key，
   * 把冒号之类换掉（`private:555` → `private-555`）—— Windows 目录名不能带冒号。
   */
  #logSubdir(key) {
    for (const row of Array.isArray(this.config.bindings) ? this.config.bindings : []) {
      if (String(row?.key ?? '') === key) {
        const sessionId = String(row?.sessionId ?? '').trim();
        if (sessionId !== '') return sessionId;
      }
    }
    return String(key).replace(/[:/\\]/g, '-');
  }

  /**
   * 把一行聊天流水追加到当天的日志文件。
   *
   * 路径：`<chatLogRoot>/<sessionId 或会话key>/chat-YYYY-MM-DD.log`
   * 文件按天切（本地日期，不是 UTC）。
   * 写失败一律吞掉 —— 磁盘满或权限不对的时候，消息该发还是要发出去；
   * 控制台那边还有一份，不至于全丢。
   */
  #appendChat(key, line) {
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate(),
    ).padStart(2, '0')}`;
    // 懒解析工作区：会话可能在插件启动之后才加载（详见 index.js 的 resolveWorkspace）。
    // 每次写日志都问一次，拿到工作区就跟上；拿不到就用构造时算好的兜底根。
    const base =
      typeof this.config.resolveBaseDir === 'function'
        ? this.config.resolveBaseDir() || this.config.baseDir || null
        : null;
    const root = base ? path.join(base, 'logs') : this.chatLogRoot;
    const dir = path.join(root, this.#logSubdir(key));
    const file = path.join(dir, `chat-${day}.log`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file, `${line}\n`, 'utf8');
    } catch {
      /* 日志写不进去不能影响收发 */
    }
  }

  /** 把一次发送的结果写进日志（成功/失败都记）。 */
  #logOutgoing(key, result) {
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    for (const one of result?.sent ?? []) {
      const mark = one.ok ? '✓' : '✗';
      const id = one.messageId === null || one.messageId === undefined ? '' : ` (id ${one.messageId})`;
      const line = `↑ ${stamp} ${key} ${mark}${id} ${one.text}`;
      this.log(line);
      this.#appendChat(key, line);
    }
  }

  /**
   * 聊天记录落在哪（给 qq_chat_log_path 工具用）。
   *
   * 路径是**懒解析**的（会话加载前后可能不同，见 index.js 的 resolveWorkspace），
   * 所以这里每次都重新算一遍，不能缓存。
   */
  chatLogPath(key) {
    const base =
      typeof this.config.resolveBaseDir === 'function'
        ? this.config.resolveBaseDir() || this.config.baseDir || null
        : null;
    const root = base ? path.join(base, 'logs') : this.chatLogRoot;
    const dir = path.join(root, this.#logSubdir(key));
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate(),
    ).padStart(2, '0')}`;
    const file = path.join(dir, `chat-${day}.log`);
    return { root, dir, file, day, exists: fs.existsSync(file) };
  }

  /**
   * 记一次图片发送。
   *
   * 图片不走 send()（那条路是文字，结构不一样），所以单独一个入口。
   * 公开方法：tools.js 的 qq_send_image 直接调它。
   */
  logOutgoingFile(key, result) {
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const mark = result?.ok ? '✓' : '✗';
    const size = Number.isFinite(result?.bytes) ? ` ${result.bytes} 字节` : '';
    const id = result?.fileId ? ` (file ${String(result.fileId).slice(0, 12)}…)` : '';
    const why = result?.error ? ` ${result.error}` : '';
    const line = `↑ ${stamp} ${key} ${mark}${id} [文件${size}]${why}`;
    this.log(line);
    this.#appendChat(key, line);
  }

  /**
   * 记一条「发出去的东西」到日志。
   *
   * label 是给对方看的东西类型：图片 / 语音 / 文件。
   * 原来叫 logOutgoingImage 且写死 `[图片]`，加语音后改名并把类型提出来。
   */
  logOutgoing(key, result, label = '图片') {
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const mark = result?.ok ? '✓' : '✗';
    const size = Number.isFinite(result?.bytes) ? ` ${result.bytes} 字节` : '';
    const id = result?.messageId === null || result?.messageId === undefined ? '' : ` (id ${result.messageId})`;
    const why = result?.error ? ` ${result.error}` : '';
    const line = `↑ ${stamp} ${key} ${mark}${id} [${label}${size}]${why}`;
    this.log(line);
    this.#appendChat(key, line);
  }

  /**
   * 等这个会话的新消息。
   *
   * 为什么需要它：模型读完消息后常常需要"等对方把话说完"。
   * 没有这个工具，模型只能用 sleep 之类的笨办法，或者干脆提前回复。
   *
   * 下面两处照抄 qq-bridge（`bridge.js:6215` 一带的 activeWaits / pendingWakeTimer 清理），
   * 都是为了**同一件事不被唤醒两次**：
   *   1) 开工前先**清掉本会话待发的缓冲期唤醒**。否则会撞上这个顺序：消息到了 →
   *      排好 10 秒缓冲 → AI 主动调本工具等待 → 缓冲期到点又把 AI 叫醒一次。
   *   2) **同一会话只允许一个等待**（租约）。两个长轮询并存会互相踩水位、各回一遍。
   */
  waitForMessages(key, { timeoutMs = 60000, minCount = 1 } = {}) {
    // 注意：这里**不取消搬运定时器**。
    //
    // 单队列时代取消它是对的（消息已可读，取消只是"别叫醒 agent"）；
    // 三队列下取消它等于取消 staging → ready 的搬运，消息永远卡在 staging，
    // wait 就永远等不到（2026-11-16 实测：8 秒超时、staging 仍剩 1 条）。
    //
    // 现在的分工是：搬运定时器照常跑，但一旦 wait 被满足，定时器回调里
    // 会跳过 deliverBuffered —— 不会重复唤醒。

    // ② 同会话租约：已经有一个在等就直接拒绝，别让两个等待互相踩。
    if (this.activeWaits.has(key)) {
      return Promise.resolve({
        ok: false,
        error: '这个会话已经有一个等待中的 qq_wait_for_messages，等它结束再来',
      });
    }

    // 只看 ready —— 这里**不做任何时间判断**。
    //
    // "该不该读"属于生产侧的判断（搬运定时器负责），消费者只该看到
    // "有 / 没有"两种结果。曾经在这里算过静默期（2026-11-16 用户纠正：
    // 「wait 就不应该有主动的行为，他只是在监听消息通道，仅此而已」），
    // 那是把生产者的职责塞给了消费者，同一个静默概念还被复制到三处。
    const existing = this.buffer.unread(key);
    if (existing.length >= minCount) {
      // 交付 = 送达（正文真的交到模型手上了）。标记之后这批进 unconfirmed，
      // 下次唤醒报的是 ready 长度，不会再把它们算成"新消息"。
      this.buffer.markDelivered(key, existing.map((r) => r.seq));
      this.#saveState();
      // 立即返回这条路径**不经过 waiter.resolve**，所以清零要在这里做。
      // 漏掉的话"连续空等"的计数就不会因为拿到消息而重置 ——
      // 一旦攒够两次，会在明明还在聊的时候误判成"聊完了"。
      this.waitTimeouts.delete(key);
      return Promise.resolve({ ok: true, immediate: true, messages: existing.map(toView) });
    }

    return new Promise((resolve) => {
      let timer = null;
      let extended = false;

      const waiter = {
        key,
        minCount,
        resolve: (value) => {
          if (timer !== null) clearTimeout(timer);
          this.waiters.delete(waiter);
          if (this.activeWaits.get(key) === leaseStamp) this.activeWaits.delete(key);
          // 交付即送达：把这批从 ready 移到 unconfirmed。
          // 不标记的话它们还留在 ready，下次唤醒会重复投递（"回两遍"）。
          const seqs = (value?.messages ?? []).map((m) => Number(m.seq)).filter(Number.isFinite);
          if (seqs.length > 0) {
            this.buffer.markDelivered(key, seqs);
            this.#saveState();
          }
          this.#trackWaitOutcome(key, value);
          resolve(value);
        },
      };

      /**
       * 布一次定时；到点先看管道里有没有东西。
       * isExtension=true 表示这已经是"再等一轮"，到点就真返回，不再续命。
       */
      const arm = (ms, isExtension) => {
        timer = setTimeout(() => {
          if (!isExtension) {
            const stagingLeft = this.buffer.stagingCount(key);
            if (stagingLeft > 0) {
              // 缓冲期还没走完 —— 消息就在 staging 里排着，搬过来只是时间问题。
              // 这时候返回空数组等于白等一轮。
              //
              // "再等一轮" = **再等一个 timeoutMs**（用户 2026-11-17 明确：
              // 「wait 5 分钟，发现缓冲区有新消息，那就再等 5 分钟，最多等一轮」）。
              // 不是 bufferSeconds —— 缓冲期只决定消息什么时候搬过来，
              // 而 wait 的节奏由它自己的 timeout 定。
              const extra = timeout;
              extended = true;
              this.log(
                `⏳ ${key} wait 到时，但 staging 还有 ${stagingLeft} 条（缓冲期没走完），` +
                  `再等一轮 ${Math.round(extra / 1000)}s`,
              );
              arm(extra, true);
              return;
            }
          }
          waiter.resolve({
            ok: true,
            timeout: true,
            extended,
            messages: this.buffer.unread(key).map(toView),
          });
        }, ms);
      };

      const timeout = Math.max(1000, Math.min(timeoutMs, 600000));
      arm(timeout, false);

      const leaseStamp = Date.now();
      this.activeWaits.set(key, leaseStamp);
      this.waiters.add(waiter);
      // 已经有消息在缓冲区里：立刻排上静默计时，等它够了就交付。
      // 不排的话要等到"下一条新消息"才会触发 #notifyWaiters，等于白等。
      if (this.buffer.unread(key).length > 0) this.#notifyWaiters(key);
    });
  }

  /**
   * 满足正在等待这个会话的长轮询。
   *
   * @returns {number} 这次满足了几个等待者 —— 调用方用它决定要不要再安排缓冲期唤醒
   *   （满足了说明消息已经直接交给 agent，再唤醒一次就会重复回复）。
   */
  #notifyWaiters(key) {
    let satisfied = 0;
    // 被调用时调用方已经把 staging 搬进 ready 了，所以这里直接交付。
    // 不再有静默计时器 —— 那个职责属于搬运定时器，不属于这里。
    for (const waiter of [...this.waiters]) {
      if (waiter.key !== key) continue;
      const messages = this.buffer.unread(key);
      if (messages.length < waiter.minCount) continue;
      waiter.resolve({ ok: true, messages: messages.map(toView) });
      satisfied += 1;
    }
    return satisfied;
  }

  /** 只读探测：确认上游还活着。 */
  async health() {
    if (!this.endpoint) return { ok: false, error: '协议端点未就绪' };
    const status = await call({ ...this.endpoint, action: 'get_status' });
    return {
      ok: status.ok,
      online: status.data?.online ?? null,
      good: status.data?.good ?? null,
      ws: this.client?.state ?? 'stopped',
      stats: this.client?.stats ?? null,
      // 成功时 status.error 是 undefined，兜底成 null 才是无损 JSON（工具 output 校验要求）。
      error: status.error ?? null,
    };
  }
}

/** 把缓冲记录转成"给模型看"的形状：只留它需要判断的字段，不塞原始 event。 */
function toView(record) {
  return {
    seq: record.seq,
    messageId: record.messageId,
    time: record.time,
    sender: record.sender,
    senderName: record.senderName,
    text: extractText(record.event),
    segments: segmentsOf(record.event).map((s) => s.type),
    images: segmentsOf(record.event)
      .filter((s) => s.type === 'image')
      .map((s) => ({
        url: s.data?.url ?? null,
        localPath: s.data?.localPath ?? null,
        pending: s.data?.imagePending === true,
        error: s.data?.localError ?? null,
      })),
  };
}
