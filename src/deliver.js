/**
 * 唤醒投递：把"某会话有新消息"变成一条真正进入 DSH agent 的用户消息。
 *
 * 为什么单独成模块
 * --------------
 * 这段逻辑原本写在 index.js 的 onWake 回调里。问题在于：apply() 内部创建的 runtime
 * 外部拿不到，于是"绑定解析 → 取 agent → steer"这条最容易出错的链路完全无法单测，
 * 只能靠"重启 DSH 看日志"来验证 —— 而重启 DSH 会中断当前对话，成本极高。
 * 抽出来之后可以用假的 agents 服务把每种失败分支都覆盖一遍。
 */

import { resolveBinding } from './session-map.js';

/** 把"多久以前"算清楚 —— 模型看到裸 epoch 算不出相对时间，会抢进早已散场的话题。 */
export function humanAgo(timestampSeconds, nowMs = Date.now()) {
  if (!Number.isFinite(timestampSeconds)) return '';
  const seconds = Math.max(0, Math.round(nowMs / 1000 - timestampSeconds));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`;
  return `${Math.round(seconds / 86400)} 天前`;
}

/**
 * 拼唤醒提示。
 *
 * 只给"可见窗口"，不拼对话历史 —— 历史由 DSH 会话自己持久化，
 * 插件重复搬运只会浪费上下文（qq-bridge 的 unread/recent 也是这个定位）。
 */
/**
 * 三种唤醒场景的文案表。
 *
 * 这样写是为了把「proactive / busy / idle 的判断」收拢到**选表那一步**，
 * 主流程从此是线性的：抬头 → 提示 → 历史 → 尾部。
 * 之前这三个维度散在五处 if 里（抬头、历史提示、空历史、尾部、消息展开），
 * 每次加个场景要在五个地方对齐。
 */
const SCENES = {
  proactive: {
    title: () => '【主动苏醒】',
    lead: () => [],
    tail: () => '想聊就用 qq_send_message；不想聊就什么都不调，安静结束这轮很正常。',
  },
  busy: {
    title: (n, seq) => `【QQ 新消息】有 ${n} 条新消息`,
    lead: () => [
      '（内容没展开 —— 想看就调 qq_wait_for_messages 拉进来看）',
    ],
    tail: () => '先把手上这件事做完；消息用 qq_wait_for_messages 拉，急事再停手回。',
  },
  idle: {
    title: (n, seq) => `【QQ 新消息】有 ${n} 条新消息`,
    lead: () => ['（内容没展开 —— 用 qq_wait_for_messages 拉进来看）'],
    tail: () => '先调 qq_wait_for_messages 看消息内容；回话用 qq_send_message；不回就 qq_mark_read 标记已读。',
  },
};

/**
 * 绝对时间锚点。消息用的都是相对时间（"9 分钟前"），没有基准就对不上。
 * 只到分钟 —— 秒没意义；带 MM-DD 是为了跨天时还能分辨。
 */
function formatStamp(now) {
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

const lastSeq = (list) => (list.length > 0 ? list[list.length - 1].seq : 0);

/** 把一条消息渲染成提示里的若干行。图片只给本地路径，不内联（理由见 src/media.js）。 */
function renderMessage(m, nowMs) {
  const who = m.senderName || m.sender || '?';
  const nonText = (m.segments ?? []).filter((s) => s !== 'text');
  const extra = nonText.length > 0 ? `（含 ${nonText.join('/')}）` : '';
  const lines = [`[seq ${m.seq} · ${who} · ${humanAgo(m.time, nowMs)}] ${m.text || '(非文本消息)'}${extra}`];

  for (const img of m.images ?? []) {
    if (img.localPath) {
      lines.push(`    ↳ 图片已存到 ${img.localPath}，想看就调 read_image（不要凭猜测描述图片内容）`);
    } else if (img.pending) {
      lines.push('    ↳ 图片还在下载，过一会儿用 qq_get_unread_messages 再看');
    } else if (img.error) {
      lines.push(`    ↳ 图片下载失败：${img.error}`);
    }
  }
  return lines;
}

export function buildWakePrompt(runtime, key, reason, nowMs = Date.now(), busy = false) {
  const now = new Date(nowMs);
  const unread = runtime.unread(key);
  const proactive = reason === 'proactive';
  const scene = SCENES[proactive ? 'proactive' : busy ? 'busy' : 'idle'];

  // 主动苏醒没有新消息可拉（wait 等的是新消息），只能靠 recent 历史判断要不要开口。
  // 其他两种场景一律不展开内容 —— 让模型自己用 qq_wait_for_messages 拉。
  const history = proactive ? runtime.recent(key, 10).slice(-12) : [];

  const lines = ['【QQ消息】', `【当前时间 】：${formatStamp(now)} 【会话标识】：${key}`];

  lines.push(scene.title(unread.length, lastSeq(unread)));

  if (proactive) {
    lines.push(
      history.length > 0
        ? `（下面是最近 ${history.length} 条对话，供你判断要不要开口）`
        : '（这个会话还没有任何历史消息。）',
    );
  } else {
    lines.push(...scene.lead());
  }

  lines.push('');
  for (const m of history) lines.push(...renderMessage(m, nowMs));
  lines.push('');

  lines.push(scene.tail());
  // 会话历史里残留着旧桥接注入的指令（要求必须传 token、必须调 mcp__snowluma__*）。
  // 那套后端已停用，照做只会失败 —— 一句边界说明就够，不必再列工具清单。
  lines.push('（查更早的对话用 qq_chat_log_path）');

  return lines.join('\n');
}

/**
 * 构造投递给 DSH 的 UserMessage。
 *
 * 为什么 id 要带 `qq-` 前缀：`steer` 在 agent 正在跑时会并进当前 turn，
 * 之后如果要做"这条回复是不是针对这次唤醒"的精确配对，得靠 messageId 去
 * `user/message` 事件里定位起始 seq。现在先留好记号。
 */
export function buildUserMessage(text) {
  return {
    id: `qq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  };
}

/**
 * 把一次唤醒投进对应的 DSH 会话。
 *
 * 所有失败分支都返回结果而不是抛异常 —— 调用方在事件回调里，
 * 抛出去会变成一个没人接的 unhandled rejection。
 *
 * @returns {{ok:boolean, why?:string, sessionId?:string, messageId?:string}}
 */
/**
 * 造一个"按 sessionId 拿 agent"的解析器，拿不到就 resume。
 *
 * 为什么需要它
 * ----------
 * `agents.get()` 只返回**活跃**（已加载）的 agent。DSH 重启后，会话虽然持久化还在，
 * 但只有被打开过的才会进活跃列表 —— 于是「关掉窗口就收不到唤醒」。
 * 对一个常驻陪伴插件来说这是硬伤，所以这里补一条兜底：
 * 拿不到就 `agents.resume({ resumeSessionId })` 把持久化会话复活。
 *
 * 为什么还要缓存
 * ------------
 * resume 会创建新的 Agent 实例（AgentHandle 带 dispose capability）。如果每次唤醒都
 * resume，会不断堆积实例。所以缓存起来，并在发现它已从 registry 消失时先 dispose 再重建。
 *
 * @param {object} agents  ctx.get('agents')
 * @param {(msg:string)=>void} log
 */
/**
 * 拼 resume 需要的 agentOptions。
 *
 * 从 agentDefaultModel.currentSelection() 读当前默认模型；拿不到就返回空对象
 * （保持原行为，不要因为缺这个服务就让 resume 整个失败）。
 */
function resumeAgentOptions(getDefaultModel) {
  try {
    const selection = getDefaultModel?.() ?? undefined;
    if (!selection || typeof selection !== 'object') return {};
    const { provider, model, reasoningEffort } = selection;
    if (typeof provider !== 'string' || typeof model !== 'string') return {};
    return {
      agentOptions: {
        provider,
        model,
        ...(typeof reasoningEffort === 'string' ? { reasoningEffort } : {}),
      },
    };
  } catch {
    return {};
  }
}

export function createAgentResolver(agents, log = () => {}, getDefaultModel = () => undefined) {
  /** @type {Map<string, {agent:object, handle:object|undefined}>} */
  const cache = new Map();

  return async function resolveAgent(sessionId) {
    if (!agents || typeof agents.get !== 'function') return undefined;

    // 先问 registry：它是最权威的"活着"判据
    let live;
    try {
      live = agents.get(sessionId);
    } catch (error) {
      log(`✗ agents.get 抛错：${String(error?.message ?? error)}`);
      return undefined;
    }
    if (live) return live;

    // registry 里没有：可能缓存的是已 dispose 的旧实例，先清掉
    const cached = cache.get(sessionId);
    if (cached) {
      cache.delete(sessionId);
      try {
        cached.handle?.dispose?.();
      } catch {
        // dispose 失败无所谓，反正已经从 registry 掉了
      }
    }

    if (typeof agents.resume !== 'function') {
      log('✗ agents.resume 不可用，无法恢复会话');
      return undefined;
    }

    try {
      log(`… 会话 ${sessionId.slice(0, 18)}… 不在活跃列表，尝试 resume 恢复`);
      // resume 不传 agentOptions 的话，恢复出来的 agent 没有 provider/model
      // （实测日志：provider=(none) model=(none)）。而 system prompt 里的
      // {{model}} 取的是 context.agent.options.model —— 于是重启后第一轮就报
      // "has no value for this assembly"。补上默认模型选择即可。
      const handle = await agents.resume({
        resumeSessionId: sessionId,
        ...resumeAgentOptions(getDefaultModel),
      });
      const agent = handle?.agent ?? handle;
      if (!agent || typeof agent.steer !== 'function') {
        log('✗ resume 返回的句柄没有 steer 方法');
        return undefined;
      }
      cache.set(sessionId, { agent, handle });
      // 把恢复出来的 agent 实际拿到的 provider/model 记下来。
      // prompt 里的 {{model}} 取自 context.agent.options.model，为空就会
      // 报 "has no value for this assembly"，而恢复路径是唯一不走
      // 「新建会话」的入口，很可能就是它少了这两个值。
      const opts = agent.options ?? {};
      log(
        `✓ 会话已恢复（resume）：${sessionId.slice(0, 18)}… · ` +
          `provider=${opts.provider ?? '(none)'} model=${opts.model ?? '(none)'}`,
      );
      if (!opts.model) {
        log('⚠️ 恢复出来的 agent 没有 model，它的 prompt 里一旦有 {{model}} 就会报错');
      }
      return agent;
    } catch (error) {
      log(`✗ resume 失败：${String(error?.message ?? error)}`);
      return undefined;
    }
  };
}

/**
 * 把一次唤醒投进对应的 DSH 会话。
 *
 * 所有失败分支都返回结果而不是抛异常 —— 调用方在事件回调里，
 * 抛出去会变成一个没人接的 unhandled rejection。
 *
 * @returns {Promise<{ok:boolean, why?:string, sessionId?:string, messageId?:string, resumed?:boolean}>}
 */
export async function deliverWake({
  resolveAgent,
  config,
  runtime,
  key,
  reason,
  busy = false,
  log = () => {},
}) {
  const binding = resolveBinding(config, key);
  if (!binding.ok) {
    const why = `唤醒丢弃：${binding.why}`;
    log(`✗ ${why}`);
    return { ok: false, why };
  }

  if (typeof resolveAgent !== 'function') {
    const why = 'agents 服务不可用';
    log(`✗ ${why}`);
    return { ok: false, why };
  }

  const agent = await resolveAgent(binding.sessionId);
  if (!agent) {
    const why = `会话 ${binding.sessionId.slice(0, 18)}… 取不到（既不在活跃列表，resume 也失败）`;
    log(`✗ ${why}`);
    return { ok: false, why };
  }

  // 图片是异步落盘的，而唤醒几乎和消息同时触发。投递前等一下，
  // 让提示里能带真实路径而不是"还在下载"。
  if (typeof runtime?.settleImages === 'function') {
    const settled = await runtime.settleImages(key, 2000);
    if (!settled.ok) log(`… 图片下载未在期限内完成，先投递（提示里会标注）`);
  }

  const message = buildUserMessage(buildWakePrompt(runtime, key, reason, Date.now(), busy));

  // steer 是同步 void：插到最近的 step 边界，会唤醒 agent，但不返回回复。
  // 回复由 agent 自己用 qq_send_message 发出去 —— 插件不需要接文本，
  // 这正是"群聊伴侣"路线比"文本转发"路线少掉的一大块复杂度。
  try {
    agent.steer(message);
  } catch (error) {
    const why = `steer 失败：${String(error?.message ?? error)}`;
    log(`✗ ${why}`);
    return { ok: false, why };
  }

  log(`→ 已投递唤醒到 ${binding.sessionId.slice(0, 18)}…（${key} · ${reason}）`);
  return { ok: true, sessionId: binding.sessionId, messageId: message.id };
}
