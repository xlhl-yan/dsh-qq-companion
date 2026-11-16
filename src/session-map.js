/**
 * 会话映射：QQ 会话（群/私聊） ↔ DSH sessionId。
 *
 * 为什么需要显式映射而不是"猜最近活跃的会话"
 * ------------------------------------------------
 * dsh-mc-chat-watch 踩过这个坑（2026-10-13）：它早先会退化成"找最近有写入的那个会话"，
 * 猜错就把游戏消息送进了别的窗口（串台）。插件自己的注释写着：
 *   "宁可这条消息丢掉并记日志，也不要投错地方。"
 * 所以这里的策略是 **fail-closed**：映射不到就拒绝投递并返回原因，绝不猜。
 *
 * key 的规范化
 * ------------
 * OneBot 的群号/QQ 号在某些实现里会退化成前导零字符串（`group:0123`），
 * 不归一化就会让同一个群分裂成两套状态（qq-bridge 的 canonicalV2Key 就是为这个存在的）。
 * 这里统一成 `group:<十进制无前导零>` / `private:<十进制无前导零>`。
 */

const KEY_PATTERN = /^(group|private):(\d+)$/;

/**
 * 把 "group:0123" / "group:123" / {type:'group', id:123} 统一成 "group:123"。
 *
 * @returns {{ok:true, key:string, kind:'group'|'private', id:number} | {ok:false, why:string}}
 */
export function normalizeConversationKey(raw) {
  if (raw && typeof raw === 'object') {
    const kind = String(raw.kind ?? raw.type ?? '').toLowerCase();
    const id = String(raw.id ?? raw.groupId ?? raw.userId ?? '').trim();
    return normalizeConversationKey(`${kind}:${id}`);
  }

  const text = String(raw ?? '').trim();
  const match = KEY_PATTERN.exec(text);
  if (!match) return { ok: false, why: `会话 key 形状不合法（期望 group:<号> 或 private:<号>）：${text || '(空)'}` };

  const kind = match[1];
  // Number() 顺带去掉前导零；超过 Number.MAX_SAFE_INTEGER 的号现实里不存在。
  const id = Number(match[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, why: `会话号不合法：${match[2]}` };
  return { ok: true, key: `${kind}:${id}`, kind, id };
}

/**
 * 由一条 OneBot 消息事件推出它属于哪个会话。
 *
 * 注意 group 消息里**同时**带 user_id（发送者）和 group_id，
 * 拿错字段就会把群消息当成私聊。
 */
export function conversationOf(event) {
  if (!event || typeof event !== 'object') return { ok: false, why: '事件为空' };
  const type = String(event.message_type ?? '').toLowerCase();
  if (type === 'group') {
    return normalizeConversationKey(`group:${event.group_id}`);
  }
  if (type === 'private') {
    return normalizeConversationKey(`private:${event.user_id}`);
  }
  return { ok: false, why: `不认识的消息类型：${type || '(空)'}` };
}

/**
 * 从插件配置里解析出某个会话应该投给哪个 DSH 会话。
 *
 * V1 只认显式绑定（config.bindings），**不做自动建会话**——
 * `agents.create()` 的 preset / 模型选择行为尚未验证（见 research/host-api.md 风险 4），
 * 先让用户手工在 GUI 里建好"QQ 聊天"会话，把 sessionId 填进配置，最稳。
 *
 * @param {object} config 插件配置
 * @param {string} key 规范化后的会话 key
 * @returns {{ok:true, sessionId:string, label?:string} | {ok:false, why:string}}
 */
export function resolveBinding(config, key) {
  const bindings = Array.isArray(config?.bindings) ? config.bindings : [];
  const wanted = normalizeConversationKey(key);
  if (!wanted.ok) return wanted;

  for (const row of bindings) {
    const probe = normalizeConversationKey(row?.key);
    if (!probe.ok || probe.key !== wanted.key) continue;
    const sessionId = String(row?.sessionId ?? '').trim();
    if (sessionId === '') {
      return { ok: false, why: `绑定 ${wanted.key} 的 sessionId 为空` };
    }
    return { ok: true, sessionId, label: row?.label ? String(row.label) : undefined };
  }

  return {
    ok: false,
    why: `没有为 ${wanted.key} 配置绑定。请在插件配置的 bindings 里加一条 { key: '${wanted.key}', sessionId: 'session-…' }`,
  };
}
