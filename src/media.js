/**
 * 媒体处理：把 QQ 消息里的图片落到本地。
 *
 * 为什么是"落盘 + 给路径"而不是"内联成 image block"
 * -----------------------------------------------
 * DSH 的附件侧有硬阈值（约 3.2 MiB 原始字节 / 4.47 MB base64），超了会触发
 * base64 正则回溯爆栈 —— 那个事故 qq-bridge 的 media-normalize.js 头注释里记得很清楚
 * （`RangeError` → 图片降级成一句 `[image unavailable]`，一个字节都没进上下文）。
 *
 * 落盘 + 在提示里给路径的代价是模型要多调一次 `read_image`，但换来的是：
 *   · 不会因为一张大图把整个唤醒提示撑爆；
 *   · 图片在本地，模型之后还能反复看（比如"刚才那张图里写了什么"）；
 *   · 失败时能明确说"下载失败"，而不是静默丢一张图。
 *
 * 实测（2026-10-29）：SnowLuma 给的 `https://multimedia.nt.qq.com.cn/download?...`
 * 可以直接 fetch，HTTP 200 / image/png / 214ms，不需要 Referer 或 UA。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 单张图片上限 3 MiB（与发送侧一致，理由见 src/onebot.js 的 MAX_IMAGE_BYTES）。 */
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

/** 文件名只保留安全字符，避免 url 里的 query 变成奇怪的路径。 */
function safeName(raw) {
  const base = String(raw ?? '')
    .split('?')[0]
    .split('/')
    .pop()
    ?? '';
  const cleaned = base.replace(/[^0-9A-Za-z._-]/g, '').slice(0, 80);
  return cleaned || '';
}

/** 从 content-type 猜扩展名。 */
function extOf(contentType) {
  const ct = String(contentType ?? '').toLowerCase();
  if (ct.includes('png')) return '.png';
  if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg';
  if (ct.includes('gif')) return '.gif';
  if (ct.includes('webp')) return '.webp';
  if (ct.includes('bmp')) return '.bmp';
  return '';
}

/**
 * 下载一张图片到 destDir。
 *
 * @returns {Promise<{ok:boolean, path?:string, bytes?:number, error?:string}>}
 */
export async function downloadImage({ url, destDir, filename = '', timeoutMs = 20000 }) {
  if (!url) return { ok: false, error: '没有 url' };
  if (!destDir) return { ok: false, error: '没有目标目录' };

  let response;
  try {
    response = await fetch(String(url), { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { ok: false, error: `请求失败：${String(error?.message ?? error)}` };
  }
  if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };

  let buffer;
  try {
    buffer = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    return { ok: false, error: `读响应失败：${String(error?.message ?? error)}` };
  }
  if (buffer.length === 0) return { ok: false, error: '响应为空' };
  if (buffer.length > MAX_IMAGE_BYTES) {
    const mb = (buffer.length / 1024 / 1024).toFixed(2);
    return { ok: false, error: `图片 ${mb} MiB 超过上限 3 MiB` };
  }

  // 文件名优先用上游给的 file 字段；它没扩展名时就按 content-type 补
  let name = safeName(filename);
  if (name === '') name = `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  if (path.extname(name) === '') {
    const ext = extOf(response.headers.get('content-type'));
    if (ext) name += ext;
  }

  const target = path.join(destDir, name);
  try {
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(target, buffer);
  } catch (error) {
    return { ok: false, error: `写文件失败：${String(error?.message ?? error)}` };
  }

  return { ok: true, path: target, bytes: buffer.length };
}

/**
 * 从一个 OneBot 消息段数组里挑出可下载的图片段。
 *
 * 只收有 url 的；`file` 是 base64 的那种（某些实现会内联）暂不处理。
 */
export function imageSegmentsOf(segments) {
  return (Array.isArray(segments) ? segments : []).filter(
    (seg) => seg?.type === 'image' && typeof seg?.data?.url === 'string' && seg.data.url !== '',
  );
}
