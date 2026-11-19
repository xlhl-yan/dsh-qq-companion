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
export function skipQuietWindow(ts, startHour, endHour) {
  const start = clampHour(startHour, 23);
  const end = clampHour(endHour, 9);
  if (start === end) return ts; // 起止相同 = 全天可醒

  const d = new Date(ts);
  const hour = d.getHours();
  const inQuiet =
    start < end ? hour >= start && hour < end : hour >= start || hour < end;
  if (!inQuiet) return ts;

  const out = new Date(ts);
  if (start < end) {
    // 同日窗口（如 2 点→6 点）：推到当天 end 点
    out.setHours(end, 0, 0, 0);
    return out.getTime();
  }

  // 跨午夜（23 → 9）：
  //   · 23 点这一侧 → 明天 9 点
  //   · 凌晨这一侧（< end）→ 当天 9 点
  if (hour >= start) out.setDate(out.getDate() + 1);
  out.setHours(end, 0, 0, 0);
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
