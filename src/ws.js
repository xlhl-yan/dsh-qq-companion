/**
 * OneBot 11 WebSocket 客户端（收消息用）。
 *
 * 为什么必须用 WS
 * --------------
 * OneBot 是**推送模型**：消息由协议端主动推给已连接的客户端，没有"拉取未读"的 HTTP 接口。
 * 发消息可以走 HTTP（见 onebot.js），收消息只能走这里。
 *
 * 断线重连为什么不做成"固定 3 秒重试"
 * ----------------------------------
 * qq-bridge 踩过（issue #34）：固定 3 秒重连 = 每分钟 20 行日志，真正的错误被淹没。
 * 这里用指数退避，并且**只在状态变化时打日志**（连上/断开各一行），重试本身不刷屏。
 *
 * 为什么要有心跳超时
 * ----------------
 * WebSocket 层可能"看起来连着"但上游已经静默（qq-bridge README:304 的
 * 「连上了 ≠ 收得到」）。OneBot 心跳默认 30 秒一次，超过 90 秒什么都没收到
 * 就认为连接死了，主动断开走重连。
 */

const DEFAULTS = {
  reconnectMinMs: 1000,
  reconnectMaxMs: 30000,
  /** 超过这么久没收到任何事件就认为连接已死。 */
  heartbeatTimeoutMs: 90000,
};

/**
 * 把 token 拼进 URL。
 *
 * 为什么用 query 而不是 Authorization header
 * ------------------------------------------
 * Node 内置的 WebSocket 实现（WHATWG 标准）不支持自定义请求头。
 * OneBot 生态普遍支持 `?access_token=` 这种形式，实测 SnowLuma 也认。
 */
function withToken(url, token) {
  if (!token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}access_token=${encodeURIComponent(token)}`;
}

export class OneBotWsClient {
  /**
   * @param {object} options
   * @param {string} options.url       形如 ws://127.0.0.1:3001/
   * @param {string} [options.token]
   * @param {(event:object)=>void} [options.onEvent] 任意事件（含 meta）
   * @param {(text:string)=>void} [options.log]
   */
  constructor({ url, token = '', onEvent, log = () => {}, ...rest }) {
    this.config = { ...DEFAULTS, ...rest };
    this.url = withToken(String(url), token);
    this.onEvent = onEvent;
    this.log = log;

    this.socket = null;
    this.state = 'idle'; // idle | connecting | open | closed
    this.attempt = 0;
    this.reconnectTimer = null;
    this.watchdogTimer = null;
    this.lastEventAt = 0;
    this.stopped = false;
    /** 累计收到的事件数与最近一次断开原因，供诊断工具读取。 */
    this.stats = { received: 0, connects: 0, drops: 0, lastError: '' };
  }

  start() {
    this.stopped = false;
    this.#connect();
    return this;
  }

  stop() {
    this.stopped = true;
    this.#clearTimers();
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // 已经关闭/从未连上都会抛，忽略
      }
      this.socket = null;
    }
    this.state = 'closed';
  }

  #clearTimers() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  #connect() {
    if (this.stopped) return;
    if (this.state === 'connecting' || this.state === 'open') return;
    this.state = 'connecting';

    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (error) {
      this.stats.lastError = String(error?.message ?? error);
      this.#scheduleReconnect('构造 WebSocket 失败');
      return;
    }
    this.socket = ws;

    ws.onopen = () => {
      this.state = 'open';
      this.attempt = 0;
      this.stats.connects += 1;
      this.lastEventAt = Date.now();
      this.log(`WS 已连接：${this.#safeUrl()}`);
      this.#armWatchdog();
    };

    ws.onmessage = (messageEvent) => {
      this.lastEventAt = Date.now();
      this.stats.received += 1;
      this.#armWatchdog();
      if (!this.onEvent) return;
      try {
        const parsed = JSON.parse(String(messageEvent.data));
        this.onEvent(parsed);
      } catch (error) {
        // 上游偶尔会推非 JSON（调试文本），忽略即可，但记下原因
        this.stats.lastError = `解析事件失败：${String(error?.message ?? error)}`;
      }
    };

    ws.onerror = () => {
      // 具体错误细节不可用；close 事件会随后到达，交给统一收尾
      this.stats.lastError = 'WebSocket 错误';
    };

    ws.onclose = (closeEvent) => {
      const wasOpen = this.state === 'open';
      this.state = 'closed';
      this.socket = null;
      this.#clearTimers();
      if (wasOpen) {
        this.stats.drops += 1;
        this.log(`WS 断开：code=${closeEvent?.code ?? '?'} ${closeEvent?.reason || ''}`.trim());
      }
      if (!this.stopped) this.#scheduleReconnect(`code=${closeEvent?.code ?? '?'}`);
    };
  }

  #scheduleReconnect(why) {
    if (this.stopped || this.reconnectTimer) return;
    this.attempt += 1;
    const delay = Math.min(
      this.config.reconnectMinMs * 2 ** (this.attempt - 1),
      this.config.reconnectMaxMs,
    );
    if (this.attempt === 1) this.log(`WS 将在 ${delay}ms 后重连（${why}）`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.#connect();
    }, delay);
  }

  #armWatchdog() {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      const idleMs = Date.now() - this.lastEventAt;
      if (idleMs < this.config.heartbeatTimeoutMs) return;
      this.log(`WS 心跳超时（${Math.round(idleMs / 1000)}s 无事件），主动重连`);
      this.stats.lastError = 'heartbeat timeout';
      try {
        this.socket?.close();
      } catch {
        // ignore
      }
    }, this.config.heartbeatTimeoutMs);
  }

  /** 打日志时不要带上 token。 */
  #safeUrl() {
    return this.url.replace(/(access_token=)[^&]+/, '$1***');
  }
}
