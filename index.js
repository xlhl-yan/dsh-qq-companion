/**
 * dsh-qq-companion · Host 半边
 *
 * 一个 DSH 原生插件：直连 QQ 协议端（OneBot 11 / SnowLuma），收消息 → 决定要不要
 * 叫醒 agent → agent 用原生工具自主回话。
 *
 * 它替代的是 `D:\AgentTools\qq-bridge` 的职责，但把"独立进程 + 自建 MCP server +
 * 手写 DSH Web API 客户端（978 行 + 离线铸造 Cookie）"这一坨整个拿掉了。
 *
 * 设计取舍（都有实测依据，见 RESEARCH.md 与 research/）
 * -----------------------------------------------
 * 1. **不自动创建 DSH 会话**。`agents.create()` 的 preset / 模型选择行为尚未验证，
 *    先让用户手工建好 QQ 专用会话再绑定，最稳。绑定走 config.bindings，fail-closed。
 * 2. **收消息必须 WS，发消息走 HTTP**。OneBot 是推送模型，没有"拉未读"的接口。
 * 3. **防自激第一层是自己的 user_id**。SnowLuma 的 reportSelfMessage=false 已经
 *    不回报自己发的消息，但插件仍需自检（换协议端/换配置时这一层就生效了）。
 * 4. **observeOnly 默认 true**。装上先只看不喊，确认消息进出正常再打开唤醒，
 *    避免和正在跑的 qq-bridge 互相打架。
 *
 * 本文件只做装配；业务逻辑在 src/ 下，可脱离 DSH 单测。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { QQCompanionRuntime } from './src/runtime.js';
import { createQQTools } from './src/tools.js';
import { deliverWake, createAgentResolver } from './src/deliver.js';

export const name = 'qq-companion';

/** 只声明真正需要的服务；拿不到的用 ctx.get() 降级。 */
export const inject = ['agents', 'tools'];

const VERSION = '0.1.0';

function say(message) {
  // eslint-disable-next-line no-console
  console.log(`[qq-companion] ${message}`);
}

export function apply(ctx, config = {}) {
  const enabled = config.enabled !== false;
  const observeOnly = config.observeOnly !== false;
  say(`apply · v${VERSION} · enabled=${enabled} · observeOnly=${observeOnly}`);

  if (!enabled) {
    say('插件已禁用（config.enabled=false），不连接协议端');
    return;
  }

  // 落盘根目录：**会话工作区**，做法照抄 dsh-meow-memory。
  //
  // meow-memory 的取法（lib/index.js:2949）：
  //     const cwd = exec.agent?.session?.header?.cwd;
  //     if (typeof cwd === 'string' && cwd.length > 0) return cwd;
  // 然后落 `<cwd>/.dsh-meow/memory.db`。这里照样取 header.cwd，落 `<cwd>/.dsh-qq`。
  //
  // 与它的一处差别：它是**工具**，`exec.agent` 天然就有；我们是**插件**，启动时
  // QQ 会话往往还没加载，`agents.get()` 拿不到 agent。所以这里做成**懒解析**——
  // 每次写日志时才去问一次，等会话真的加载起来，路径自然就切到工作区了。
  // 在那之前（以及会话始终没加载时）落在插件目录，保证日志不会丢。
  //
  // 踩过的坑也记一笔：别用 process.cwd()（那是 DSH 进程的启动目录），
  // 也别用 workingDirectory.defaultDirectory（同上，会话没加载时它会退成 cwd）。
  const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url));
  const PLUGIN_FALLBACK_DIR = path.join(PLUGIN_ROOT, '.qq-companion');

  /** 照抄 meow-memory：工作区 = 会话 header 里的 cwd。拿不到返回 null。 */
  const resolveWorkspace = () => {
    try {
      const agents = ctx.get('agents');
      for (const row of Array.isArray(config.bindings) ? config.bindings : []) {
        const agent = agents?.get?.(String(row?.sessionId ?? ''));
        const cwd = agent?.session?.header?.cwd;
        if (typeof cwd === 'string' && cwd.length > 0) return path.join(cwd, '.dsh-qq');
      }
    } catch {
      /* 取不到就走兜底 */
    }
    return null;
  };

  const baseDir = config.baseDir || resolveWorkspace() || PLUGIN_FALLBACK_DIR;
  say(`落盘根目录：${baseDir}${config.baseDir ? '（配置指定）' : resolveWorkspace() ? '' : '（会话未加载，暂用插件目录兜底）'}`);

  // baseConfig 是"cordis config + 默认值"，设置页的覆盖值在它之上叠。
  // 单独留一份，是为了设置页保存后能重新算出生效配置并热替换给 runtime。
  const baseConfig = {
    ...config,
    baseDir,
    // imageDir 刻意不在这里定死：apply 时 QQ 会话往往还没加载，resolveWorkspace()
    // 会退到插件目录，图片就跟日志分家了（2026-10-29 实测）。
    // 交给 resolveImageDir 每次现算。
    imageDir: config.imageDir || '',
    // 懒解析：runtime 每次写日志都会调它，会话一加载路径就跟上。
    resolveBaseDir: () => config.baseDir || resolveWorkspace() || PLUGIN_FALLBACK_DIR,
    // 图片落盘目录：显式配置（cordis 或设置页）优先，否则跟着工作区走 —— 跟日志同源。
    resolveImageDir: () => {
      const fromSettings = readSettingsOverrides().imageDir;
      const explicit = [config.imageDir, fromSettings]
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .find((value) => value.length > 0);
      if (explicit) return explicit;
      const root = config.baseDir || resolveWorkspace() || PLUGIN_FALLBACK_DIR;
      return path.join(root, 'images');
    },
  };
  // 设置页写的覆盖值在**启动时**也要叠上。
  // 否则 DSH 一重启（插件重新 apply），runtime 拿到的只有 cordis 默认值，
  // 页面里填的「苏醒间隔」就白填了 —— 2026-10-29 实测：页面填 6000 秒，
  // 重启后仍按 300 秒叫醒，就是这个原因。
  const bootConfig = mergeConfig(baseConfig, readSettingsOverrides());
  const runtime = new QQCompanionRuntime({ config: bootConfig, log: say });
  let disposed = false;

  // 回复只有一条路：agent 主动调 qq_send_message。
  //
  // 曾经还有一条 "relay" 路（监听 turn/end，把 agent 输出的文本自动转发到 QQ），
  // 那是当年 qq_* 工具在旧会话里调不到时的兜底。现在工具能正常用了，两条路并存
  // 反而会重复发送（agent 既说话又调工具 = 同一句发两遍），所以 2026-10-29
  // 按用户要求整条删掉。

  // ── 工具注册 ───────────────────────────────────────────
  const tools = ctx.get('tools');
  if (tools && typeof tools.register === 'function') {
    for (const definition of createQQTools(runtime)) {
      try {
        const release = tools.register(definition);
        ctx.effect(() => release);
        say(`工具已注册：${definition.name}`);
      } catch (error) {
        say(`✗ 工具注册失败 ${definition.name}：${String(error?.message ?? error)}`);
      }
    }
  } else {
    say('⚠️ tools 服务不可用，跳过工具注册');
  }

  // ── 唤醒 → 投递给对应 DSH 会话（实现在 src/deliver.js，可单测） ──
  // createAgentResolver 在会话不在活跃列表时会用 agents.resume() 自动恢复，
  // 这样 QQ 会话不需要一直开着窗口 —— 否则"关掉窗口就收不到唤醒"。
  // 第三个参数是"当前默认模型"：resume 恢复出来的 agent 默认**没有** provider/model，
  // 而 system prompt 里的 {{model}} 取 context.agent.options.model —— 不补就在重启后
  // 第一轮报 "has no value for this assembly"。惰性读，服务不在也不影响加载。
  const resolveAgent = createAgentResolver(ctx.get('agents'), say, () =>
    ctx.get('agentDefaultModel')?.currentSelection?.(),
  );
  // 返回 Promise 是有意的：runtime 要知道投递到底成不成功，
  // 成功才能把「待投递文件」删掉（否则下次启动会重复投递）。
  runtime.onWake = ({ key, reason, busy }) => {
    if (disposed) return Promise.resolve({ ok: false, why: 'disposed' });
    return deliverWake({ resolveAgent, config, runtime, key, reason, busy, log: say }).catch((error) => {
      say(`✗ 投递异常：${String(error?.message ?? error)}`);
      return { ok: false, why: String(error?.message ?? error) };
    });
  };

  // ── 忙闲观察者：只用来决定投递时的措辞，**不再用来挂起消息** ──
  //
  // 演变（值得记一笔）：
  //   2026-10-29 —— 用户发现 AI 回复到一半被打断，于是忙时消息全部进队列、等 turn/end 补发。
  //   2026-10-30 —— 另一种情况暴露了：AI 跑长任务（好几分钟）时主人发消息，
  //                 队列要等任务结束才放行，等于**长任务期间彻底失联**。
  //
  // 现在的做法：忙时也照常投递。DSH 的 steer 插到最近的 step 边界，
  // 不会中断正在执行的工具调用，只是让模型在下一步看到"主人又说话了"。
  // 于是 turn/start / end 只剩下一个用途：让唤醒提示带上"你现在正忙"的措辞。
  //
  // ⚠️ turn/end 丢失会让会话一直显示"忙"（只是措辞问题，不影响投递），
  // runtime 侧有 15 分钟租约兜底。
  // 忙闲的权威判据：直接读 DSH 的 turnBoundary projection。
  //
  // openTurnStartSeq 在 turn/start 时写入、turn/end 时清空 —— 只要 turn 没结束
  // 它就非 null，跟"过了多久"无关。所以长任务（下载模型、等后台 job）跑一小时，
  // 这里照样返回"忙"，主动苏醒不会闯进来。
  runtime.busyProbe = (sessionId) => {
    try {
      const agent = ctx.get('agents')?.get?.(sessionId);
      const session = agent?.session;
      if (!session) return null;
      const projections = ctx.get('sessionProjections');
      if (typeof projections?.stateOf !== 'function') return null;
      const boundary = projections.stateOf(session, 'turnBoundary');
      if (boundary === undefined || boundary === null) return null;
      return boundary.openTurnStartSeq !== null && boundary.openTurnStartSeq !== undefined;
    } catch {
      // 问不到就走兜底，绝不因为查询失败就判"闲"（那正好会让主动苏醒闯进去）。
      return null;
    }
  };

  ctx.on('session/event', (session, event) => {
    if (disposed) return;
    try {
      const sessionId = String(session?.id ?? session?.sessionId ?? '');
      if (sessionId === '') return;
      const type = event?.type;
      if (type === 'turn/start') {
        runtime.setSessionBusy(sessionId, true);
      } else if (type === 'turn/end') {
        runtime.setSessionBusy(sessionId, false);
        runtime.flushPending(sessionId);
      }
    } catch (error) {
      say(`✗ 忙闲判定异常：${String(error?.message ?? error)}`);
    }
  });

  // ── 启动协议端（异步，不阻塞装配） ─────────────────────
  runtime
    .start()
    .then((result) => {
      if (disposed) return;
      if (!result.ok) {
        say(`✗ 协议端启动失败：${result.error}`);
        return;
      }
      say(`✓ 就绪 · 账号 ${result.selfId} · ${observeOnly ? '观察模式（不唤醒）' : '唤醒已开启'}`);
    })
    .catch((error) => say(`✗ 启动异常：${String(error?.message ?? error)}`));

  // ── 设置页后端（实现在文件末尾，与 client.js 共用 SETTINGS_NS / CONFIG_ROUTE）──
  // 传 baseConfig 而不是原始 config：它带着 imageDir 的默认值，页面才能显示真实路径。
  mountSettingsEndpoint(ctx, baseConfig, runtime, say);

  // ── 卸载清理 ───────────────────────────────────────────
  ctx.effect(() => () => {
    disposed = true;
    runtime.stop();
    say('已停止');
  });
}

// ─────────────────────────────────────────────────────────────────────────
// 设置页后端
// ─────────────────────────────────────────────────────────────────────────

/** 设置页与 Host 半的配对键（client.js 里必须用同一串）。 */
export const SETTINGS_NS = 'qq-companion';

/** 设置页读写走插件自己的 HTTP 前缀。 */
export const CONFIG_ROUTE = '/qq-companion-config';

/**
 * 设置文件目录。
 *
 * 为什么要自己存一份：DSH 的 configForms 在 client 侧拿到的是**空壳**
 * （host 侧没有 installSection/register，`set()` 静默无效）—— 这是
 * dsh-mc-chat-watch 实测踩出来的，所以它和 dsh-meme 都改成了
 * 「插件自建 loopback HTTP + 自带 settings.json」。
 * 优先级：settings.json（页面改的） > cordis config > 代码默认值。
 */
function settingsDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'storages', 'dsh-qq-companion');
}

function settingsFile() {
  return path.join(settingsDir(), 'settings.json');
}

/** 读页面写入的覆盖值（文件不存在/损坏都当成空对象）。 */
export function readSettingsOverrides() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeSettingsOverrides(patch) {
  const dir = settingsDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* 目录已存在 */
  }
  const next = { ...readSettingsOverrides(), ...patch };
  fs.writeFileSync(settingsFile(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

function denyNonLoopback(req, res) {
  try {
    const addr = req.socket?.remoteAddress || '';
    const ok = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === '';
    if (!ok) {
      res.statusCode = 403;
      res.end('loopback only');
      return true;
    }
  } catch {
    /* 判断不了就放行 */
  }
  return false;
}

function sendJson(res, status, payload) {
  try {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(payload));
  } catch {
    try {
      res.end('{}');
    } catch {
      /* 忽略 */
    }
  }
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 设置页暴露的字段（顺序即页面顺序）。
 *
 * `type` 决定控件：bool 走下拉胶囊，number/text 走输入框（失焦保存），
 * list 走逗号分隔的文本框，readonly 只展示不可改。
 */
const SETTINGS_FIELDS = [
  { key: 'enabled', label: '总开关', type: 'bool', help: '关掉后完全不连接协议端' },
  { key: 'observeOnly', label: '观察模式', type: 'bool', help: '只收消息、不唤醒任何会话' },
  { key: 'selfId', label: '自己的 QQ 号', type: 'text', help: '留空则用协议端报上来的账号；防自激靠它' },
  { key: 'ownerId', label: '主人的 QQ 号', type: 'text', help: '这个人说话一定唤醒' },
  {
    key: 'bindingSessionId',
    label: '绑定的 DSH 会话',
    type: 'text',
    help: 'QQ 消息投递到哪个会话（填 session-xxx）。改这里等于改 cordis 里的 bindings[0].sessionId',
  },
  { key: 'snowLuma.wsUrl', label: 'WebSocket 地址', type: 'text', help: '收消息用，如 ws://127.0.0.1:3001/' },
  { key: 'snowLuma.httpUrl', label: 'HTTP 地址', type: 'text', help: '发消息用，留空则自动发现' },
  { key: 'snowLuma.accessToken', label: '访问令牌', type: 'text', help: '留空则从 SnowLuma 配置里读' },
  {
    key: 'wake.bufferSeconds',
    label: '缓冲期（秒）',
    type: 'number',
    help: '收到消息先等这么久；期间又来消息就合并并重新计时，停下来才叫醒一次',
  },
  {
    key: 'wake.wakeIntervalSec',
    label: '苏醒间隔（秒）',
    type: 'number',
    help: '每隔这么久主动叫醒一次，让 AI 自己决定要不要找你说话（不看有没有新消息）',
  },
  { key: 'wake.proactive', label: '主动苏醒', type: 'bool', help: '关掉后只在收到消息时唤醒' },
  {
    key: 'wake.activeStartHour',
    label: '主动苏醒起始（点）',
    type: 'number',
    help: '24 小时制。默认 8 点开始主动找你；只约束主动苏醒，来消息照常唤醒',
  },
  {
    key: 'wake.activeEndHour',
    label: '主动苏醒截止（点）',
    type: 'number',
    help: '24 小时制。默认 23 点之后不再主动；起始大于截止表示跨午夜（22→6）',
  },
  // 冷却（wake.minIntervalSec）2026-11-19 删除：
  //   排期本身保证最小间隔，冷却纯冗余；而且"拒绝后重排"会死循环
  //   （间隔 20 分钟 + 冷却 30 分钟 = 永远不醒，且日志只有"冷却未过"）。
  {
    key: 'wake.maxPerHour',
    label: '主动苏醒每小时上限',
    type: 'number',
    help: '只约束主动苏醒，超过就先歇着。你发的消息不计入、不受限',
  },
  {
    key: 'wake.jitterRatio',
    label: '苏醒抖动幅度',
    type: 'number',
    help: '0.15 = 间隔上下浮动 15%。不填按 0.15。填 0 就是死板固定间隔',
  },
  {
    key: 'wake.workJitterMultiplier',
    label: '工作时段抖动倍数',
    type: 'number',
    help:
      '注意：这是抖动幅度的倍数，不是间隔的倍数。' +
      '基准 45 分、抖动 15%、倍数 2 时，工作时段间隔 = 45×(1+15%×2) = 58.5 分（取绝对值，只会更长）',
  },
  {
    key: 'wake.workHours',
    label: '工作时段',
    type: 'text',
    help: '形如 09:00-11:30, 13:00-17:30（逗号分隔多个）。留空 = 不区分工作时段',
  },
  {
    key: 'wake.workDays',
    label: '工作日',
    type: 'text',
    help: '1=周一 … 7=周日，逗号分隔。节假日和调休会自动查（联网，失败则只看这里）',
  },
  { key: 'imageDir', label: '图片落盘目录', type: 'text', help: '留空 = 工作区下的 .qq-companion/images' },
];

function pick(source, dotted) {
  return dotted.split('.').reduce((node, part) => (node == null ? undefined : node[part]), source);
}

/**
 * 把 settings.json 的覆盖值叠到 cordis config 上。
 *
 * 支持一层点号路径（如 `wake.probability`），够用且不会误伤 —— 不做递归，
 * 免得 `bindings` 这种数组被合并坏。值为 `null` 表示"取消覆盖"。
 */
export function mergeConfig(base, overrides) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value === undefined) continue;
    if (value === null) {
      delete merged[key];
      continue;
    }
    if (!key.includes('.')) {
      merged[key] = value;
      continue;
    }
    const parts = key.split('.');
    let node = merged;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      node[part] = node[part] && typeof node[part] === 'object' ? { ...node[part] } : {};
      node = node[part];
    }
    node[parts[parts.length - 1]] = value;
  }
  return merged;
}

/**
 * 挂上设置页的读写接口。
 *
 * ⚠️ `webServer` 是**异步挂载**的：apply 早期 `ctx.get('webServer')` 拿到 null
 * （dsh-mc-chat-watch 2026-10-22 实测）。所以必须用 `ctx.inject` 等它就绪。
 */
function mountSettingsEndpoint(ctx, config, runtime, say) {
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx?.webServer ?? (typeof webCtx?.get === 'function' ? webCtx.get('webServer') : null);
    if (!webServer || typeof webServer.register !== 'function') {
      say('⚠️ 没有 webServer 服务，设置页后端不可用');
      return;
    }

    /** 运行状态：设置页顶部的状态行用它（连不上协议端时要能看出来）。 */
    const readStatus = async () => {
      try {
        // ⚠️ health() 是 async 的（要真去问一次协议端），不能当同步用 ——
        // 直接塞进 JSON 会变成 {}，状态行就永远空白。
        return await runtime.health();
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    };

    const buildPayload = async () => {
      const overrides = readSettingsOverrides();
      const effective = mergeConfig(config, overrides);
      return {
        ok: true,
        namespace: SETTINGS_NS,
        route: CONFIG_ROUTE,
        settingsPath: settingsFile(),
        status: await readStatus(),
        fields: SETTINGS_FIELDS.map((field) => ({
          ...field,
          // bindingSessionId 是虚拟字段：它映射到 bindings[0].sessionId（数组没法用点号路径）。
          value:
            field.key === 'bindingSessionId'
              ? (effective.bindings?.[0]?.sessionId ?? '')
              : pick(effective, field.key),
          overridden:
            field.key === 'bindingSessionId'
              ? Boolean(overrides.bindings)
              : pick(overrides, field.key) !== undefined,
        })),
        overrides,
      };
    };

    ctx.effect(() =>
      webServer.register({
        kind: 'prefix',
        path: CONFIG_ROUTE,
        async handler(req, res) {
          if (denyNonLoopback(req, res)) return;
          const method = String(req.method || 'GET').toUpperCase();
          try {
            if (method === 'GET') {
              sendJson(res, 200, await buildPayload());
              return;
            }
            if (method !== 'POST') {
              sendJson(res, 405, { ok: false, error: '仅支持 GET / POST' });
              return;
            }
            const body = await readBody(req);
            // bindingSessionId 是虚拟字段：落到 bindings[0].sessionId。
            // 数组没法用点号路径写进 overrides，所以这里整份 bindings 覆盖。
            if (Object.prototype.hasOwnProperty.call(body, 'bindingSessionId')) {
              const current = mergeConfig(config, readSettingsOverrides());
              const bindings = Array.isArray(current.bindings)
                ? current.bindings.map((row) => ({ ...row }))
                : [];
              if (bindings.length === 0) bindings.push({ key: 'private:0', sessionId: '' });
              bindings[0].sessionId = String(body.bindingSessionId ?? '').trim();
              delete body.bindingSessionId;
              body.bindings = bindings;
            }
            const keys = Object.keys(body || {});
            if (keys.length === 0) {
              sendJson(res, 400, { ok: false, error: '没有要保存的字段' });
              return;
            }
            const nextOverrides = writeSettingsOverrides(body);
            // 热应用：runtime 里所有配置读取都是实时的（this.config.xxx），
            // 换掉引用就等于立刻生效 —— 不用重启、不用重连。
            // 只有连接地址和总开关例外：WS 已经连上、runtime 已经 start 过了。
            const effective = mergeConfig(config, nextOverrides);
            if (!effective.imageDir) {
              effective.imageDir = path.join(process.cwd(), '.qq-companion', 'images');
            }
            const applied = runtime.applyConfig(effective);

            // 现在所有配置项都能热生效（连接地址变化会触发自动重连），
            // 只有总开关例外 —— runtime 的启动/销毁属于插件 apply 的生命周期，改不了。
            const needsRestart = keys.filter((key) => key === 'enabled');
            const hot = keys.filter((key) => !needsRestart.includes(key));
            say(
              `设置已保存：${keys.join(', ')}` +
                (hot.length > 0 ? `（已生效：${hot.join(', ')}）` : '') +
                (applied.reconnecting ? '（连接配置变化，正在重连）' : '') +
                (needsRestart.length > 0 ? `（需重启：${needsRestart.join(', ')}）` : ''),
            );
            sendJson(res, 200, {
              ...(await buildPayload()),
              saved: keys,
              applied: hot,
              reconnecting: applied.reconnecting === true,
              needsRestart,
            });
          } catch (error) {
            sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
          }
        },
      }),
    );
    say(`设置页后端已挂载：${CONFIG_ROUTE}（配置 ${settingsFile()}）`);
  });
}
