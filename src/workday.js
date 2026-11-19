/**
 * 工作日判断：中国节假日 + 调休补班。
 *
 * ## 数据从哪来
 *
 * 2026-11-19 实测了三个源：
 *
 * | 源 | 结果 |
 * |---|---|
 * | `timor.tech` | **403** —— Cloudflare 挑战页，直接不可用 |
 * | `api.apihubs.cn` | 200，但要 key / 参数格式讲究 |
 * | **`NateScarlet/holiday-cn`** 静态 JSON | ✅ 2026/2027 都能取 |
 *
 * 选 holiday-cn，因为它的结构正好对上需求：
 *
 * ```json
 * {
 *   "year": 2026,
 *   "papers": ["https://www.gov.cn/zhengce/..."],   // 国务院原文，可追溯
 *   "days": [
 *     { "name": "元旦", "date": "2026-01-01", "isOffDay": true },   // 放假
 *     { "name": "元旦", "date": "2026-01-04", "isOffDay": false }   // 调休补班
 *   ]
 * }
 * ```
 *
 * **`isOffDay: false` 是"调休上班"** —— 那种周六要上班，不能当休息日。
 *
 * ## 为什么要本地缓存
 *
 * - 节假日是**每天最多变一次**的数据，没必要每 5 分钟的轮询都联网
 * - 断网时也不能把"工作日"全判错
 *
 * ## 一个必须知道的边界
 *
 * 国务院每年 11–12 月才发布**下一年**安排。所以「往后拉一批」最多拉到
 * 正文已发布的年份 —— 拉不到不是 bug，是数据源客观没有。那种情况下
 * `isWorkday` 会退化成"只看星期几"，并由调用方决定要不要在日志里说明。
 */

/** 优先 jsDelivr（2026-11-19 实测 2.97s / 4.8KB）；raw.githubusercontent 作为兜底（当日实测首包超时过）。 */
const SOURCES = [
  (year) => `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`,
  (year) => `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`,
];

/** 网络超时。取 8 秒：三次来源加起来最长也就这么多，再久就没意义了。 */
const FETCH_TIMEOUT_MS = 8000;

/**
 * 把 `2026-01-04` 解析成本地时间的 Date。
 *
 * **不用 `new Date('2026-01-04')`** —— 那是按 UTC 解析，东八区会变成当天 08:00，
 * `getDay()` 虽然还对，但任何涉及"今天几号"的比较就会差一天。用本地构造最稳。
 */
export function parseLocalDate(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text ?? '').trim());
  if (m === null) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(year, month - 1, day);
  // 校验：2-30 这类不存在的日期会被 Date 挪到下个月，这里要挡掉
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d;
}

/** 本地日期的 `YYYY-MM-DD`。 */
export function formatLocalDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 节假日日历。
 *
 * @param {object} options
 * @param {string} options.cacheDir - `<baseDir>/holidays` 这样的目录
 * @param {(line: string) => void} [options.log]
 * @param {number[]} [options.workDays] - 基础工作日（1=周一 … 7=周日），默认 1-5
 */
export function createWorkdayCalendar({
  cacheDir,
  log = () => {},
  workDays = [1, 2, 3, 4, 5],
  fetchImpl = globalThis.fetch,
} = {}) {
  /** year -> Map（key 是 YYYY-MM-DD，value 是 isOffDay 布尔） */
  const years = new Map();
  /** 已经尝试过加载、但失败的年份 —— 避免每 5 分钟轮询都重试一次 */
  const failedYears = new Set();
  /** 基础工作日归一化：Date.getDay() 是 0=周日…6=周六，配置用 1=周一…7=周日 */
  let baseWorkDays = normalizeWorkDays(workDays);
  function setWorkDays(list) {
    baseWorkDays = normalizeWorkDays(list);
  }

  function cachePathFor(year) {
    if (!cacheDir) return null;
    return `${cacheDir}/${year}.json`;
  }

  /** 从磁盘读。返回 null 表示"没有"（不是错误）。 */
  async function readCache(year) {
    const file = cachePathFor(year);
    if (file === null) return null;
    try {
      const fs = await import('node:fs/promises');
      const text = await fs.readFile(file, 'utf8');
      return parseHolidayJson(JSON.parse(text));
    } catch {
      return null;
    }
  }

  /** 写磁盘。失败只记日志 —— 缓存写不进去不该影响功能。 */
  async function writeCache(year, days) {
    const file = cachePathFor(year);
    if (file === null) return;
    try {
      const fs = await import('node:fs/promises');
      await fs.mkdir(cacheDir, { recursive: true });
      // 只存"我们要的那部分"，不整份转发官方 JSON（省空间，也避免以后 schema 变了读不懂）
      const payload = {
        year,
        fetchedAt: new Date().toISOString(),
        days: [...days.entries()].map(([date, isOffDay]) => ({ date, isOffDay })),
      };
      await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
    } catch (error) {
      log(`⚠️ 节假日缓存写入失败（${year}）：${String(error?.message ?? error)}`);
    }
  }

  /** 从网络拉。依次试 SOURCES，全失败返回 null。 */
  async function fetchYear(year) {
    if (typeof fetchImpl !== 'function') return null;
    for (const sourceOf of SOURCES) {
      const url = sourceOf(year);
      try {
        const res = await fetchImpl(url, {
          signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined,
        });
        if (!res.ok) {
          log(`… 节假日源 ${new URL(url).host} 返回 ${res.status}，换下一个`);
          continue;
        }
        const days = parseHolidayJson(await res.json());
        if (days === null || days.size === 0) {
          log(`… 节假日源 ${new URL(url).host} 数据为空，换下一个`);
          continue;
        }
        return days;
      } catch (error) {
        log(`… 节假日源 ${new URL(url).host} 失败：${String(error?.message ?? error)}`);
      }
    }
    return null;
  }

  /**
   * 确保某一年的数据已在内存里。
   *
   * 顺序：内存 → 磁盘 → 网络。任何一步成功就返回 true。
   */
  async function ensureYear(year) {
    if (years.has(year)) return true;
    if (failedYears.has(year)) return false;

    const cached = await readCache(year);
    if (cached !== null && cached.size > 0) {
      years.set(year, cached);
      log(`📅 节假日 ${year}：从本地缓存读入 ${cached.size} 天`);
      return true;
    }

    const fetched = await fetchYear(year);
    if (fetched !== null) {
      years.set(year, fetched);
      await writeCache(year, fetched);
      log(`📅 节假日 ${year}：联网取到 ${fetched.size} 天（已缓存）`);
      return true;
    }

    failedYears.add(year);
    log(`⚠️ 节假日 ${year}：本地没有、联网也取不到 —— 该年将按"周一到周五"退化判断`);
    return false;
  }

  /**
   * 启动预热：把当前年、下一年装进来。
   *
   * 为什么是两年：跨年那几天最容易被问到"明天上不上班"，而这两年数据量加起来
   * 不到 10KB，一次拉完一整天不用再联网。
   */
  async function warmup(now = new Date()) {
    const year = now.getFullYear();
    await Promise.all([ensureYear(year), ensureYear(year + 1)]);
    return [...years.keys()].sort();
  }

  /**
   * 判断某天是不是工作日（同步，只查内存）。
   *
   * @param {Date|string} date - Date 对象或 `YYYY-MM-DD`
   * @returns {{ workday: boolean, reason: string, authoritative: boolean }}
   *   `authoritative=false` 表示"节假日数据缺失，这是按星期几猜的"
   */
  function isWorkday(date) {
    const d = typeof date === 'string' ? parseLocalDate(date) : date;
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
      return { workday: false, reason: '日期无效', authoritative: false };
    }
    const key = formatLocalDate(d);
    const days = years.get(d.getFullYear());

    if (days !== undefined && days.has(key)) {
      const isOffDay = days.get(key);
      // isOffDay=true 是放假；isOffDay=false 是**调休上班**
      return {
        workday: !isOffDay,
        reason: isOffDay ? `节假日（${key}）` : `调休上班（${key}）`,
        authoritative: true,
      };
    }

    // Date.getDay(): 0=周日 … 6=周六。配置用 1=周一 … 7=周日。
    const dow = d.getDay() === 0 ? 7 : d.getDay();
    return {
      workday: baseWorkDays.has(dow),
      reason: `按星期几（${dow}）判断`,
      authoritative: days !== undefined,
    };
  }

  /**
   * 某个时刻是不是落在工作时段里。
   *
   * @param {Date} now
   * @param {Array<{start: string, end: string}>} spans - `[{start:'09:00', end:'11:30'}]`
   * @returns {{ inWork: boolean, why: string }}
   */
  function isWorkTime(now, spans) {
    const wd = isWorkday(now);
    if (!wd.workday) return { inWork: false, why: `非工作日：${wd.reason}` };

    const list = Array.isArray(spans) ? spans : [];
    if (list.length === 0) return { inWork: false, why: '没配工作时段' };

    const minutes = now.getHours() * 60 + now.getMinutes();
    for (const span of list) {
      const from = parseClock(span?.start);
      const to = parseClock(span?.end);
      if (from === null || to === null) continue;
      // 跨午夜（22:00-02:00）也支持：起 > 止 时按"或"判断
      const hit = from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
      if (hit) return { inWork: true, why: `工作时段 ${span.start}-${span.end}` };
    }
    return { inWork: false, why: '不在任何工作时段内' };
  }

  return { warmup, ensureYear, isWorkday, isWorkTime, setWorkDays, parseLocalDate, formatLocalDate };
}

/**
 * 把「1,2,3,4,5」或数组归一化成 Set，非法项丢掉。
 *
 * 全非法时**退回默认的周一到周五** —— 配置写错不该变成"永远不是工作日"
 * （那会让工作时段永远不生效，比"多醒几次"更糟且更难发现）。
 */
export function normalizeWorkDays(input) {
  const list = Array.isArray(input)
    ? input
    : String(input ?? '')
        .split(/[,，\s]+/)
        .map((x) => x.trim())
        .filter(Boolean);
  const set = new Set();
  for (const item of list) {
    const n = Number(item);
    if (Number.isInteger(n) && n >= 1 && n <= 7) set.add(n);
  }
  return set.size > 0 ? set : new Set([1, 2, 3, 4, 5]);
}

/** `09:30` → 570（分钟）。非法返回 null。 */
export function parseClock(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (m === null) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || h < 0 || h > 23) return null;
  if (!Number.isInteger(min) || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/**
 * 把 holiday-cn 的 JSON 转成 `Map<date, isOffDay>`。
 *
 * 也接受我们自己的缓存格式（`{ year, days: [{date,isOffDay}] }`）——
 * 两者结构一致，所以同一个解析器就够。
 */
export function parseHolidayJson(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const list = Array.isArray(raw.days) ? raw.days : null;
  if (list === null) return null;
  const map = new Map();
  for (const row of list) {
    const date = typeof row?.date === 'string' ? row.date.trim() : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    // 只认显式布尔：缺字段的条目跳过，别用默认值猜出"放假"
    if (typeof row.isOffDay !== 'boolean') continue;
    map.set(date, row.isOffDay);
  }
  return map;
}

/**
 * 把设置页里的文本解析成工作时段数组。
 *
 * 输入形如 `09:00-11:30, 13:00-17:30`（分隔符支持中英文逗号、分号、空白）。
 * 解析失败的段落**跳过并回报**，不让一个笔误把整条配置变成空数组。
 */
export function parseWorkSpans(text) {
  const spans = [];
  const bad = [];
  const raw = String(text ?? '').trim();
  if (raw === '') return { spans, bad };

  for (const part of raw.split(/[,;，；]+/)) {
    const piece = part.trim();
    if (piece === '') continue;
    const m = /^(\d{1,2}:\d{2})\s*[-~—]\s*(\d{1,2}:\d{2})$/.exec(piece);
    if (m === null) {
      bad.push(piece);
      continue;
    }
    if (parseClock(m[1]) === null || parseClock(m[2]) === null) {
      bad.push(piece);
      continue;
    }
    spans.push({ start: m[1], end: m[2] });
  }
  return { spans, bad };
}
