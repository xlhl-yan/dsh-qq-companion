/**
 * OneBot 11 协议层（面向 SnowLuma）。
 *
 * 设计边界
 * --------
 * 这里**只做 HTTP 侧**：发送消息 + 只读查询。收消息必须走 WebSocket，
 * 而那会影响生产环境中正在运行的 qq-bridge（它占着 :3001），
 * 所以 WS 留到下一步单独处理，不在本模块里出现。
 *
 * 为什么 HTTP 与 WS 的 token 是同一个
 * --------
 * qq-bridge 的 `snowluma-conn.js` 注释说"HTTP 与 WebSocket 的 token 不同"，
 * 但这台机器的实测配置（`<SnowLuma>/config/onebot_<QQ号>.json`）显示
 * httpServers[0].accessToken 与 wsServers[0].accessToken 是同一个值。
 * 也就是说两个 server 各自有 token 字段，但用户配成了相同值 —— 不能假定
 * 它们总是相同，所以本模块按"各自取、取不到再回退"处理。
 *
 * token 不能硬编码
 * --------
 * 换 QQ 号后 token 会变，写死就会 401。这里按优先级探测：
 *   ① 显式配置（插件 config / 环境变量）
 *   ② SnowLuma 的 per-account 配置文件（真实来源）
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';
const DEFAULT_TIMEOUT_MS = 10000;

/**
 * SnowLuma 安装目录的候选位置。
 *
 * 为什么要有候选而不是写死一个：qq-bridge 的 config.json 里 homeDir 是空的
 * （它直接用 accessToken），所以从那边借不到路径；而换机器/换安装位置时
 * 硬编码必然失效。
 */
export function snowLumaHomeCandidates({ homeDir = '', launcherPath = '' } = {}) {
  const out = [];
  const push = (p) => {
    if (p && !out.includes(p)) out.push(p);
  };
  push(homeDir);
  if (launcherPath) push(path.dirname(launcherPath));
  push(process.env.SNOWLUMA_HOME);
  // 想固定一个位置就设 SNOWLUMA_HOME，不要把本机路径写死在源码里。
  return out.filter(Boolean);
}

/**
 * 读 SnowLuma 每个账号的 OneBot 配置，取出 HTTP 与 WS 端点。
 *
 * 返回 [{ uin, file, http: {token,host,port}, ws: {token,host,port} }]
 * 单个文件坏掉不影响其它账号 —— 解析失败直接跳过，不抛。
 */
export function readOneBotAccounts(homeDir) {
  const dir = path.join(homeDir, 'config');
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const m = /^onebot_(\d+)\.json$/i.exec(name);
    if (!m) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, name), 'utf8').replace(/^\uFEFF/, '');
      const j = JSON.parse(raw);
      const nets = j?.networks ?? {};
      const pick = (list, fallbackPort) => {
        const s = Array.isArray(list) ? list[0] : null;
        if (!s) return null;
        return {
          token: String(s.accessToken ?? ''),
          host: s.host || '127.0.0.1',
          port: Number(s.port) || fallbackPort,
        };
      };
      out.push({
        uin: m[1],
        file: path.join(dir, name),
        http: pick(nets.httpServers, 3000),
        ws: pick(nets.wsServers, 3001),
      });
    } catch {
      // 单个配置文件损坏不影响其它账号
    }
  }
  return out;
}

/**
 * 探测出一个**可用**的 HTTP 端点。
 *
 * 不猜 token：拿候选逐个真去问一次 `get_login_info`，谁通就用谁。
 * 这样做的好处是换账号后无需改任何配置。
 *
 * @returns {Promise<{ok:boolean, baseUrl?:string, token?:string, self?:object,
 *                    source?:string, ws?:object, error?:string, tried?:Array}>}
 */
export async function discoverEndpoint({
  baseUrl = '',
  token = '',
  homeDir = '',
  launcherPath = '',
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const base = String(baseUrl || process.env.SNOWLUMA_HTTP_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');

  // 候选 token：显式优先（尊重用户选择），然后才是配置文件里的
  const candidates = [];
  const seen = new Set();
  const add = (tk, source, url, ws) => {
    const key = `${url}|${tk}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ token: tk, source, url, ws });
  };

  const explicit = token || process.env.SNOWLUMA_TOKEN || '';
  if (explicit) add(explicit, 'config/env', base, null);

  for (const home of snowLumaHomeCandidates({ homeDir, launcherPath })) {
    for (const acc of readOneBotAccounts(home)) {
      if (acc.http) {
        add(acc.http.token, `onebot_${acc.uin}.json`, `http://${acc.http.host}:${acc.http.port}`, acc.ws);
      }
    }
  }
  if (candidates.length === 0) add('', 'no-token-found', base, null);

  const tried = [];
  for (const c of candidates) {
    const result = await call({ baseUrl: c.url, token: c.token, action: 'get_login_info', timeoutMs });
    tried.push({
      source: c.source,
      url: c.url,
      token: c.token ? `${c.token.slice(0, 4)}…` : '(空)',
      ok: result.ok,
      status: result.httpStatus,
      detail: result.ok ? undefined : result.error,
    });
    if (result.ok) {
      return { ok: true, baseUrl: c.url, token: c.token, self: result.data, source: c.source, ws: c.ws, tried };
    }
  }

  const last = tried[tried.length - 1];
  return {
    ok: false,
    baseUrl: base,
    tried,
    error:
      last?.status === 401
        ? '所有候选 token 都被拒绝（401）。请确认 SnowLuma 已登录目标 QQ，且 OneBot HTTP 服务已开启。'
        : `连不上 OneBot HTTP API（${base}）：${last?.detail ?? last?.status ?? '未知错误'}`,
  };
}

/**
 * 调一次 OneBot HTTP API。
 *
 * 统一返回 {ok, data, retcode, httpStatus, error}，**不抛异常** ——
 * 调用方（工具/调度器）需要的是"发没发出去"这个事实，而不是异常。
 * 这一点抄自 qq-bridge 的教训：发送失败如果被吞成一行日志然后照常 resolve，
 * 调用方会以为"我说过话了"，实际群里什么都没收到（静默丢回复）。
 */
export async function call({ baseUrl, token, action, body = {}, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/${action}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) {
      return { ok: false, httpStatus: response.status, error: `HTTP ${response.status}` };
    }
    const retcode = json?.retcode ?? null;
    if (retcode !== 0) {
      return { ok: false, httpStatus: response.status, retcode, error: json?.wording || json?.message || `retcode=${retcode}` };
    }
    return { ok: true, httpStatus: response.status, retcode, data: json?.data ?? null };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * QQ 文本转义。
 *
 * 一个字符的深度防御：SnowLuma 用 `[CQ:...]` 表示消息段，如果模型生成
 * （或从别处复制的）文本里带了 `[CQ:`，会被上游解析成消息段而不是字面量。
 * 把冒号换成全角即可让它保持为普通文本。
 */
export function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/g, '[CQ：');
}

/**
 * 发送文本消息。
 *
 * @param {'group'|'private'} kind
 * @param {number|string} target 群号或 QQ 号
 * @param {string|string[]} text 字符串=一条；数组=分多条顺序发送
 */
export async function sendText({ baseUrl, token, kind, target, text, delayMs = 0, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const messages = Array.isArray(text) ? text : [text];
  const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg';
  const idField = kind === 'group' ? 'group_id' : 'user_id';

  const sent = [];
  for (let i = 0; i < messages.length; i += 1) {
    const one = escapeCqText(messages[i]).trim();
    if (!one) continue;
    if (i > 0 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    const result = await call({
      baseUrl,
      token,
      action,
      body: { [idField]: Number(target), message: one },
      timeoutMs,
    });
    // ⚠️ error 必须兜底成 null：发送成功时 result.error 是 undefined，
    // 带 undefined 字段的对象过不了 DSH 的 lossless JSON 校验
    // （JSON.stringify 会把该键丢掉，往返后与原值不等），工具会报
    // "returned invalid output: value is not lossless JSON" —— 即使消息已经发出去了。
    sent.push({
      text: one,
      ok: result.ok,
      messageId: result.data?.message_id ?? null,
      error: result.error ?? null,
    });
  }
  // ok 是「全部成功」。连发时可能有前几条成功、后几条失败 ——
  // 调用方必须同时看 sent 才能判断"部分成功"，别只信 ok。
  return { ok: sent.length > 0 && sent.every((s) => s.ok), sent };
}

/**
 * 图片大小上限 3 MiB。
 *
 * DSH 附件侧有硬阈值（约 3.2 MiB 原始字节 / 4.47 MB base64），超过它会触发
 * base64 正则回溯爆栈 —— qq-bridge 的 media-normalize.js 头注释记录过这个事故
 * （`RangeError`，然后图片降级成一句 `[image unavailable]`，一个字节都没进上下文）。
 * 所以主动拦在 3 MiB，给出明确错误，而不是让上游静默失败。
 */
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

/**
 * 语音大小上限 20 MiB。
 *
 * 和图片不同，语音走的是**文件路径**而不是 base64 内联，不经过 DSH 的附件通道，
 * 所以没有 3.2 MiB 那个爆栈阈值。QQ 自己的语音上限大概十几 MB，
 * 这里拦在 20 MiB 只为了在明显异常时早点报错（别传个整张专辑进来）。
 */
const MAX_VOICE_BYTES = 20 * 1024 * 1024;

/**
 * 发送一张本地图片。
 *
 * OneBot 的 image 段 `data.file` 接受本地路径 / `file://` / `http(s)://` / `base64://`。
 * 这里统一走 **base64 内联**：agent 给的路径可能在工作区之外，协议端未必能访问到，
 * 而 base64 不依赖那个路径是否可见（qq-bridge 的 sendImageV2 也是这么做的）。
 *
 * @param {'group'|'private'} kind
 * @param {number|string} target
 * @param {string} imagePath 本地图片绝对路径
 * @param {string} [caption] 同一气泡的配文
 */
export async function sendImage({
  baseUrl,
  token,
  kind,
  target,
  imagePath,
  caption = '',
  timeoutMs = 60000,
}) {
  let buffer;
  try {
    buffer = fs.readFileSync(imagePath);
  } catch (error) {
    return { ok: false, error: `读不到图片：${String(error?.message ?? error)}` };
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    const mb = (buffer.length / 1024 / 1024).toFixed(2);
    return { ok: false, error: `图片 ${mb} MiB 超过上限 3 MiB，请先压缩` };
  }

  const segments = [{ type: 'image', data: { file: 'base64://' + buffer.toString('base64') } }];
  const cap = String(caption ?? '').trim();
  if (cap) segments.push({ type: 'text', data: { text: escapeCqText(cap) } });

  const isGroup = kind === 'group';
  const result = await call({
    baseUrl,
    token,
    action: isGroup ? 'send_group_msg' : 'send_private_msg',
    body: { [isGroup ? 'group_id' : 'user_id']: Number(target), message: segments },
    timeoutMs,
  });

  return {
    ok: result.ok,
    messageId: result.data?.message_id ?? null,
    bytes: buffer.length,
    // 同上：成功时 result.error 是 undefined，必须兜底成 null 才是无损 JSON。
    error: result.error ?? null,
  };
}


/**
 * 发一个文件（不是图片消息，是"上传文件并发送"）。
 *
 * 走 OneBot 的 upload_private_file / upload_group_file —— 2026-11-05 实测 SnowLuma
 * 两个都实现了，传绝对路径即可（不需要 base64，也不需要 file:// 前缀）。
 *
 * 与 sendImage 的区别：
 *  · **不能带配文**（这个 action 只发文件）；要说话得另发一条。
 *  · 对方收到的是「文件」，视频点开才能播，不是那种点一下就播的视频消息。
 */
export async function uploadPrivateFile({
  baseUrl,
  token,
  kind,
  target,
  filePath,
  name = '',
  timeoutMs = 120000,
}) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    return { ok: false, error: `读不到文件：${String(error?.message ?? error)}` };
  }
  if (!stat.isFile()) {
    return { ok: false, error: `不是文件：${filePath}` };
  }

  const isGroup = kind === 'group';
  const result = await call({
    baseUrl,
    token,
    action: isGroup ? 'upload_group_file' : 'upload_private_file',
    body: {
      [isGroup ? 'group_id' : 'user_id']: Number(target),
      file: filePath,
      name: name || path.basename(filePath),
    },
    timeoutMs,
  });

  return {
    ok: result.ok,
    fileId: result.data?.file_id ?? null,
    bytes: stat.size,
    error: result.error ?? null,
  };
}

/**
 * 发一条语音。
 *
 * 2026-11-17 实测（SnowLuma 2.x，私聊）：
 *  · OneBot action 列表里**没有** send_voice / send_record —— 语音走 `send_private_msg`
 *    的 `record` 消息段。
 *  · `can_send_record` 返回 `{yes: true}`，能力是有的。
 *  · 源码里 `record.toSegment` 写的是 `file: element.fileId ?? ""`（看起来只吃 fileId），
 *    但**实测直接给绝对路径也能用** —— 正斜杠 / 反斜杠 / `file:///` 三种都返回 retcode 0。
 *    这里用绝对路径（最简单，且已实测通过）。
 *  · 格式：SnowLuma 内部有 silk 转换，wav / mp3 / ogg / amr / m4a / aac / flac 都能发，
 *    不需要自己转码。
 *  · 文件必须在 **SnowLuma 所在的同一台机器**上（它按路径去 stat）。
 */
export async function sendVoice({
  baseUrl,
  token,
  kind,
  target,
  voicePath,
  timeoutMs = 60000,
}) {
  let stat;
  try {
    stat = fs.statSync(voicePath);
  } catch (error) {
    return { ok: false, error: `读不到音频：${String(error?.message ?? error)}` };
  }
  if (!stat.isFile()) {
    return { ok: false, error: `不是文件：${voicePath}` };
  }
  if (stat.size > MAX_VOICE_BYTES) {
    const mb = (stat.size / 1024 / 1024).toFixed(2);
    return { ok: false, error: `音频 ${mb} MiB 超过上限 ${MAX_VOICE_BYTES / 1024 / 1024} MiB` };
  }

  const isGroup = kind === 'group';
  const result = await call({
    baseUrl,
    token,
    action: isGroup ? 'send_group_msg' : 'send_private_msg',
    body: {
      [isGroup ? 'group_id' : 'user_id']: Number(target),
      message: [{ type: 'record', data: { file: voicePath } }],
    },
    timeoutMs,
  });

  return {
    ok: result.ok,
    messageId: result.data?.message_id ?? null,
    bytes: stat.size,
    // 成功时 result.error 是 undefined，必须兜底成 null 才是无损 JSON。
    error: result.error ?? null,
  };
}
