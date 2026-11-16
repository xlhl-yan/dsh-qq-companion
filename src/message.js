/**
 * OneBot 消息解析：把事件里的 message 字段统一成消息段数组，并取出「用户真正说的话」。
 *
 * 这两个函数原来住在 wake.js（群聊唤醒判定模块）。2026-10-29 用户砍掉群聊判定后，
 * 判定逻辑整个不要了，但解析工具还有用（runtime 记日志、buffer 取文本、设置页展示），
 * 所以单独搬到这里，别让它们殉葬。
 */

/** OneBot 的 message 可能是字符串（CQ 码）也可能是消息段数组。统一成数组。 */
export function segmentsOf(event) {
  const message = event?.message;
  if (Array.isArray(message)) return message;
  if (typeof message === 'string') return parseCqString(message);
  return [];
}

/** 极简 CQ 码解析：只提取 text 与 at 两类，够用。 */
function parseCqString(raw) {
  const out = [];
  const pattern = /\[CQ:([a-zA-Z_]+)((?:,[^\]]*)?)\]/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    if (match.index > last) out.push({ type: 'text', data: { text: raw.slice(last, match.index) } });
    const data = {};
    for (const pair of match[2].split(',')) {
      const idx = pair.indexOf('=');
      if (idx > 0) data[pair.slice(0, idx)] = pair.slice(idx + 1);
    }
    out.push({ type: match[1], data });
    last = pattern.lastIndex;
  }
  if (last < raw.length) out.push({ type: 'text', data: { text: raw.slice(last) } });
  return out;
}

/**
 * 取"用户真正说的话"。
 *
 * 只取 text 段，**丢掉 at / reply / image 等段**。
 * 这一点很重要：qq-bridge 踩过"引用原文污染指向性判断"——
 * 引用一条恰好提到机器人昵称的旧消息，被算成"有人叫了我的名字"，白花一个回合。
 * 段引用（type:'reply'）本身不含文本，天然被排除。
 */
export function extractText(event) {
  return segmentsOf(event)
    .filter((seg) => seg?.type === 'text')
    .map((seg) => String(seg?.data?.text ?? ''))
    .join('')
    .trim();
}

/** 这条消息里有哪些非文字段（image / face / record …），给日志用。 */
export function nonTextTypes(event) {
  return segmentsOf(event)
    .map((seg) => String(seg?.type ?? ''))
    .filter((type) => type !== '' && type !== 'text');
}
