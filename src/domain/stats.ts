// 漂移验证用的统计工具：确定性 PRNG、加权 Logistic 校准（截距/斜率 + 三明治方差）、
// Wilson 区间、Brier 与配对 Brier 差的区间估计、空间校准分箱。
// 全部为纯函数，主线程与 WebWorker 可用；不使用 Math.random / Date，便于离线回放。

/** Mulberry32 确定性伪随机数（离线回放稳定） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sigmoid(x: number): number {
  if (x >= 0) {
    const e = Math.exp(-x);
    return 1 / (1 + e);
  }
  const e = Math.exp(x);
  return e / (1 + e);
}

export const clampProb = (p: number, lo = 1e-6, hi = 1 - 1e-6): number =>
  Math.min(hi, Math.max(lo, p));

export function logit(p: number): number {
  const q = clampProb(p);
  return Math.log(q / (1 - q));
}

/** 标准正态 97.5% 分位（固定值，避免依赖 z 表） */
export const Z95 = 1.959963984540054;

/** Wilson 得分区间（用于召回率的二项区间；未加权时是标准 Wilson） */
export function wilsonInterval(successes: number, total: number, z = Z95): [number, number] | null {
  if (total <= 0) return null;
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

export interface WeightedPoint {
  predicted: number;
  event: boolean;
  weight: number;
}

export interface LogisticFit {
  intercept: number;
  slope: number;
  interceptCi: [number, number];
  slopeCi: [number, number];
  converged: boolean;
}

/**
 * 加权 Logistic 回归：logit(P(event)) = intercept + slope * logit(predicted)。
 * 理想校准 = (0, 1)。用 Newton-Raphson（带步长折半）+ 三明治方差估计区间。
 * 数据完全分离（同一侧全为 0/1）或奇异时返回 null —— 此时不可报告校准斜率。
 */
export function fitCalibration(points: WeightedPoint[]): LogisticFit | null {
  if (points.length < 2) return null;
  const xs = points.map((p) => logit(p.predicted));
  const ys = points.map((p) => (p.event ? 1 : 0));
  const ws = points.map((p) => Math.max(p.weight, 0));

  // 初值：加权均值近似 -> (0,1) 起步（收敛稳定）
  let a = 0;
  let b = 1;

  const negLogLik = (aa: number, bb: number): number => {
    let ll = 0;
    for (let i = 0; i < xs.length; i++) {
      const mu = sigmoid(aa + bb * xs[i]);
      ll += ws[i] * (ys[i] * Math.log(clampProb(mu)) + (1 - ys[i]) * Math.log(clampProb(1 - mu)));
    }
    return -ll;
  };

  let cur = negLogLik(a, b);
  let converged = false;
  for (let it = 0; it < 200; it++) {
    let g0 = 0;
    let g1 = 0;
    let s00 = 0;
    let s01 = 0;
    let s11 = 0;
    for (let i = 0; i < xs.length; i++) {
      const mu = sigmoid(a + b * xs[i]);
      const h = ws[i] * mu * (1 - mu);
      g0 += ws[i] * (ys[i] - mu);
      g1 += ws[i] * (ys[i] - mu) * xs[i];
      s00 += h;
      s01 += h * xs[i];
      s11 += h * xs[i] * xs[i];
    }
    const det = s00 * s11 - s01 * s01;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
    const da = (s11 * g0 - s01 * g1) / det;
    const db = (s00 * g1 - s01 * g0) / det;
    if (!Number.isFinite(da) || !Number.isFinite(db)) return null;

    // 步长折半保证对数似然不下降
    let step = 1;
    let improved = false;
    for (let halve = 0; halve < 20; halve++) {
      const na = a + step * da;
      const nb = b + step * db;
      if (!Number.isFinite(na) || !Number.isFinite(nb) || Math.abs(nb) > 25) {
        step /= 2;
        continue;
      }
      const next = negLogLik(na, nb);
      if (next <= cur + 1e-12) {
        a = na;
        b = nb;
        improved = true;
        // 收敛判据
        if (Math.abs(step * da) + Math.abs(step * db) < 1e-10) converged = true;
        cur = next;
        break;
      }
      step /= 2;
    }
    if (!improved) break;
    if (converged) break;
  }

  // 分离检测：拟合概率全在同一侧 -> 斜率无意义
  const fitted = xs.map((x) => sigmoid(a + b * x));
  const above = fitted.filter((m) => m >= 0.5).length;
  if (above === 0 || above === fitted.length) return null;

  // 三明治方差：V = A^-1 B A^-1
  let a00 = 0;
  let a01 = 0;
  let a11 = 0;
  let b00 = 0;
  let b01 = 0;
  let b11 = 0;
  for (let i = 0; i < xs.length; i++) {
    const mu = sigmoid(a + b * xs[i]);
    const h = ws[i] * mu * (1 - mu);
    a00 += h;
    a01 += h * xs[i];
    a11 += h * xs[i] * xs[i];
    const u0 = ws[i] * (ys[i] - mu);
    const u1 = u0 * xs[i];
    b00 += u0 * u0;
    b01 += u0 * u1;
    b11 += u1 * u1;
  }
  const det = a00 * a11 - a01 * a01;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const i00 = a11 / det;
  const i01 = -a01 / det;
  const i11 = a00 / det;
  // tmp = A^-1 B
  const t00 = i00 * b00 + i01 * b01;
  const t01 = i00 * b01 + i01 * b11;
  const t10 = i01 * b00 + i11 * b01;
  const t11 = i01 * b01 + i11 * b11;
  // V = tmp * A^-1
  const v00 = t00 * i00 + t01 * i01;
  const v11 = t10 * i01 + t11 * i11;
  const seA = Math.sqrt(Math.max(0, v00));
  const seB = Math.sqrt(Math.max(0, v11));
  if (!Number.isFinite(seA) || !Number.isFinite(seB)) return null;

  return {
    intercept: a,
    slope: b,
    interceptCi: [a - Z95 * seA, a + Z95 * seA],
    slopeCi: [b - Z95 * seB, b + Z95 * seB],
    converged,
  };
}

export interface BrierSummary {
  brier: number;
  brierCi: [number, number] | null;
  nWeight: number;
  /** 当前 vs 上一版本配对差（当前-上一；正=当前更差） */
  delta: number | null;
  deltaCi: [number, number] | null;
}

/** Brier 误差与（可选）配对版本差，含 95% 区间 */
export function brierSummary(rows: { predicted: number; previous: number | null; event: boolean; weight: number }[]): BrierSummary {
  const sw = rows.reduce((s, r) => s + r.weight, 0);
  if (sw <= 0) return { brier: NaN, brierCi: null, nWeight: 0, delta: null, deltaCi: null };
  const brier = rows.reduce((s, r) => s + r.weight * (r.predicted - (r.event ? 1 : 0)) ** 2, 0) / sw;

  let varSum = 0;
  for (const r of rows) {
    const e = (r.predicted - (r.event ? 1 : 0)) ** 2 - brier;
    varSum += (r.weight * e) ** 2;
  }
  const seB = Math.sqrt(varSum) / sw;

  const withPrev = rows.filter((r) => r.previous !== null);
  let delta: number | null = null;
  let deltaCi: [number, number] | null = null;
  if (withPrev.length > 0) {
    const swp = withPrev.reduce((s, r) => s + r.weight, 0);
    if (swp > 0) {
      delta =
        withPrev.reduce(
          (s, r) => s + r.weight * ((r.predicted - (r.event ? 1 : 0)) ** 2 - (r.previous! - (r.event ? 1 : 0)) ** 2),
          0,
        ) / swp;
      let vd = 0;
      for (const r of withPrev) {
        const d =
          (r.predicted - (r.event ? 1 : 0)) ** 2 - (r.previous! - (r.event ? 1 : 0)) ** 2 - delta;
        vd += (r.weight * d) ** 2;
      }
      const sd = Math.sqrt(vd) / swp;
      deltaCi = [delta - Z95 * sd, delta + Z95 * sd];
    }
  }

  return { brier, brierCi: [brier - Z95 * seB, brier + Z95 * seB], nWeight: sw, delta, deltaCi };
}

export interface RecallSummary {
  recall: number | null;
  ci: [number, number] | null;
  positives: number;
  positivesWeighted: number;
  truePositivesWeighted: number;
}

/**
 * 召回率（加权）：Recall = Σ w·1[e=1,p≥θ] / Σ w·1[e=1]。
 * 区间用 Kish 有效样本量把加权召回率折算为二项计数后取 Wilson 区间，
 * 既适用于不加权随机样本，也适用于逆概率加权的分层样本。
 */
export function recallSummary(
  rows: { predicted: number; event: boolean; weight: number }[],
  alertThreshold: number,
): RecallSummary {
  const pos = rows.filter((r) => r.event);
  const wPos = pos.reduce((s, r) => s + r.weight, 0);
  const wTp = pos.reduce((s, r) => s + (r.predicted >= alertThreshold ? r.weight : 0), 0);
  if (wPos <= 0) {
    return { recall: null, ci: null, positives: 0, positivesWeighted: 0, truePositivesWeighted: 0 };
  }
  const sumW2 = pos.reduce((s, r) => s + r.weight * r.weight, 0);
  const nEff = sumW2 > 0 ? (wPos * wPos) / sumW2 : 0;
  const recall = wTp / wPos;
  const ci = nEff > 0 ? wilsonInterval(recall * nEff, nEff) : null;
  return { recall, ci, positives: pos.length, positivesWeighted: wPos, truePositivesWeighted: wTp };
}

/** 空间校准分箱：按预测概率等宽分箱，给出每箱 n、加权量、平均预测与观测率 */
export function calibrationCurve(
  rows: { predicted: number; event: boolean; weight: number }[],
  bins = 5,
): { lo: number; hi: number; n: number; sumWeight: number; meanPredicted: number; observedRate: number; positives: number }[] {
  const edges = Array.from({ length: bins + 1 }, (_, i) => i / bins);
  return edges.slice(0, bins).map((lo, i) => {
    const hi = edges[i + 1];
    const inBin = rows.filter((r) => {
      const p = r.predicted;
      const last = i === bins - 1;
      return p >= lo && (last ? p <= hi : p < hi);
    });
    const sw = inBin.reduce((s, r) => s + r.weight, 0);
    const predW = inBin.reduce((s, r) => s + r.weight * r.predicted, 0);
    const posW = inBin.reduce((s, r) => s + (r.event ? r.weight : 0), 0);
    const positives = inBin.filter((r) => r.event).length;
    return {
      lo,
      hi,
      n: inBin.length,
      sumWeight: sw,
      meanPredicted: sw > 0 ? predW / sw : 0,
      observedRate: sw > 0 ? posW / sw : 0,
      positives,
    };
  });
}

export function round4(x: number | null): number | null {
  if (x === null || !Number.isFinite(x)) return null;
  return Math.round(x * 10000) / 10000;
}

export function round3(x: number | null): number | null {
  if (x === null || !Number.isFinite(x)) return null;
  return Math.round(x * 1000) / 1000;
}
