/**
 * 主动苏醒的排期计算。
 *
 * 全部是纯函数 —— 不碰 runtime 状态、不读文件、不发网络请求。
 * 这样能脱离 DSH 单独跑测试，而且"算得对不对"和"状态管得对不对"两件事分开查。
 *
 * ## 一条规则的来历
 *
 * 2026-11-19 用户拍板：工作时段不是"间隔翻倍"，而是**抖动幅度翻倍**
 *
 * ```
 * 非工作：base × (1 + rand(-j, +j))          对称，可能变短
 * 工作：  base × (1 + |rand(-j, +j)| × m)    取绝对值，只往长了走
 * ```
 *
 * 理由：工作时段要"醒得稀"，所以**不该出现比 base 更短的间隔**。
 * 取绝对值正好把"变短"那一半砍掉。
 *
 * 注意 `m` 是**抖动倍数**不是**间隔倍数** —— 老配置里有同名的 `workMultiplier`
 * 语义是后者，两者差一倍（base=45, j=15%, m=2 时：本规则 58.5 分 vs 旧规则 103.5 分）。
 */

/**
 * 算一次间隔（毫秒）。
 *
 * @param {object} p
 * @param {number} p.baseMs - 基准间隔
 * @param {number} p.jitterRatio - 抖动幅度，0.15 表示 ±15%
 * @param {number} p.workMultiplier - 工作时段的抖动倍数
 * @param {boolean} p.inWork - 是否工作时段（调用方按"现在"判断）
 * @param {() => number} [p.random] - 注入随机源，便于测试
 * @returns {{ intervalMs: number, mode: 'work' | 'off', jitterPct: number }}
 */
export function computeIntervalMs({
  baseMs,
  jitterRatio,
  workMultiplier,
  inWork,
  random = Math.random,
}) {
  const base = Number(baseMs);
  const j = Number.isFinite(Number(jitterRatio)) ? Math.max(0, Number(jitterRatio)) : 0;
  const m = Number.isFinite(Number(workMultiplier)) ? Math.max(0, Number(workMultiplier)) : 1;

  // random() ∈ [0,1) → u ∈ [-1, 1)
  const u = random() * 2 - 1;

  if (inWork) {
    // 取绝对值：负的那一半被折到正向，所以结果**永不低于 base**
    const magnitude = Math.abs(u) * j;
    return {
      intervalMs: base * (1 + magnitude * m),
      mode: 'work',
      jitterPct: magnitude * m,
    };
  }

  return {
    intervalMs: base * (1 + u * j),
    mode: 'off',
    jitterPct: u * j,
  };
}

/**
 * 把一个时间戳从"静默窗口"里推出来。
 *
 * 静默窗口的语义和 `#inActiveWindow` 保持一致：**含起不含止**，
 * `start > end` 表示跨午夜（23 → 9）。
 *
 * @param {number} ts - 候选时间戳
 * @param {number} startHour - 静默起点（如 23）
 * @param {number} endHour - 静默终点（如 9）
 * @returns {number} 若不在窗口内原样返回；否则顺延到窗口结束后第一个整点
 */
/**
 * 把一个时间戳从静默窗口里推出来。
 *
 * ## 参数是「活跃窗口」，不是「静默窗口」
 *
 * 2026-11-19 这里出过一次真实的线上问题：函数原来要求传**静默窗口**
 * （如 23 → 9），而调用方手里有的只是配置里的**活跃窗口**
 * （`activeStartHour=9` / `activeEndHour=23`）。调用处把两者直接传了进去，
 * 于是函数把「9 点到 23 点」当成了静默时段 ——
 * 15:30 算出来的 16:15 被一路推到当天 23:00，日志里显示「468 分钟后苏醒」。
 *
 * 修法不是"在调用处交换两个参数"（那还是同一个陷阱，只是这次记住了），
 * 而是**让函数接受调用方真正拥有的那个概念**：活跃窗口。
 * 静默窗口由它自己反推：活跃 9–23 → 静默 23–9。
 *
 * @param {number} ts - 候选时间戳
 * @param {number} activeStartHour - 活跃窗口起点（如 9）
 * @param {number} activeEndHour - 活跃窗口终点（如 23）
 * @returns {number} 若落在活跃窗口内原样返回；否则顺延到活跃窗口开始的那个整点
 */
export function skipQuietWindow(ts, activeStartHour, activeEndHour) {
  const activeStart = clampHour(activeStartHour, 8);
  const activeEnd = clampHour(activeEndHour, 23);
  // 活跃窗口起止相同 = 全天都能醒 = 没有静默窗口
  if (activeStart === activeEnd) return ts;

  // 静默窗口 = 活跃窗口的补集
  const quietStart = activeEnd;
  const quietEnd = activeStart;

  const d = new Date(ts);
  const hour = d.getHours();
  const inQuiet =
    quietStart < quietEnd
      ? hour >= quietStart && hour < quietEnd
      : hour >= quietStart || hour < quietEnd;
  if (!inQuiet) return ts;

  const out = new Date(ts);
  if (quietStart < quietEnd) {
    // 同日静默窗口（活跃窗口跨午夜时会出现，如活跃 22–6 → 静默 6–22）
    out.setHours(quietEnd, 0, 0, 0);
    return out.getTime();
  }

  // 跨午夜静默（最常见的形态：活跃 9–23 → 静默 23–9）
  //   · 23 点这一侧 → 明天 activeStart 点
  //   · 凌晨这一侧（< activeStart）→ 当天 activeStart 点
  if (hour >= quietStart) out.setDate(out.getDate() + 1);
  out.setHours(quietEnd, 0, 0, 0);
  return out.getTime();
}

function clampHour(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(24, Math.max(0, Math.trunc(n)));
}

/**
 * 判断某个排期是否"过期太久、不该补醒"。
 *
 * 场景：电脑休眠一夜，醒来时 `nextAt` 已经过期 8 小时。此时若直接触发，
 * 等于早上开机突然被叫一声 —— 而主人根本没在等。
 *
 * @param {number} nextAt - 排定的时间戳
 * @param {number} now - 当前
 * @param {number} intervalMs - 当时的间隔
 * @param {number} [ratio=2] - 过期超过 interval × ratio 就重排而不是补醒
 * @returns {{ due: boolean, stale: boolean }}
 */
export function evaluateDue(nextAt, now, intervalMs, ratio = 2) {
  if (now < nextAt) return { due: false, stale: false };
  const overdue = now - nextAt;
  const cap = Math.max(60_000, intervalMs * Math.max(1, ratio));
  return { due: true, stale: overdue > cap };
}
