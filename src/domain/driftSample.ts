// 漂移验证的虚构样例（100% 确定性，可离线回放）。
//
// 母体：某次局部发布 REL-2026-01 随发布快照进入评估母体的 1000 个已发布管段。
// 空间分区：Z-A 420、Z-B 380、Z-C 160、Z-H 40 —— Z-H 为「稀有高风险分区」，
// 仅占母体 4%，但风险事件率明显更高，是扩面门禁必须校准的关键分区。
//
// 三个独立终点 ATTR/PERMIT/MAINT 各有自己的 90 日预测概率与现场核验观测：
//  - 当前发布版本预测概率 p（冻结到快照）；
//  - 上一发布版本预测概率 prev（系统性偏高约 +0.65 logit，用于 Brier 增量比较）；
//  - 观测 event 以 p 为真实发生率独立抽样（模拟 90 日内的独立现场核验结果）。
// 注意：观测只反映「真实结局」，绝不来自人工修正或被快照预测诱导。
import type {
  DriftEndpoint,
  EndpointObservation,
  FrozenSegment,
  ReviewLedger,
  SamplingRoute,
  SelectionRecord,
} from './driftTypes';
import { DRIFT_ENDPOINTS } from './driftTypes';
import { clampProb, logit, mulberry32, sigmoid } from './stats';

export const DRIFT_RELEASE_ID = 'REL-2026-01';
export const DRIFT_MODEL_VERSION = 'RM-CONN-v3 / RUN-CONN-2026-01';
export const KEY_ZONE_ID = 'Z-H';
export const KEY_ZONE_LABEL = 'Z-H（稀有高风险分区）';
export const DRIFT_OBSERVATION_DAYS = 90;
/** 运营告警阈值：现场按此阈值决定是否出动复核；召回率以此计算 */
export const DRIFT_ALERT_THRESHOLD = 0.3;
/** 随机复核预算：两条路线都是 100 段 */
export const DRIFT_REVIEW_BUDGET = 100;

const COHORT_SEED = 4;
const SRS_SEED = 6;
const STRAT_SEED = 39;
/** 上一发布版本整体偏高的 logit 偏移（系统性过预测 -> 版本差异来源） */
const PREV_LOGIT_SHIFT = 0.65;

/** 分区规模 */
const ZONE_SIZES: [string, number][] = [
  ['Z-A', 420],
  ['Z-B', 380],
  ['Z-C', 160],
  ['Z-H', 40],
];

/** 各分区、各终点的真实发生率区间（虚构；Z-H 明显更高） */
const RATE_RANGES: Record<string, Record<DriftEndpoint, [number, number]>> = {
  'Z-H': { ATTR: [0.36, 0.92], PERMIT: [0.34, 0.9], MAINT: [0.38, 0.93] },
  'Z-A': { ATTR: [0.16, 0.68], PERMIT: [0.14, 0.64], MAINT: [0.16, 0.66] },
  'Z-B': { ATTR: [0.14, 0.64], PERMIT: [0.15, 0.66], MAINT: [0.14, 0.63] },
  'Z-C': { ATTR: [0.08, 0.55], PERMIT: [0.06, 0.52], MAINT: [0.08, 0.54] },
};

function shuffle<T>(arr: T[], rnd: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export interface FrozenCohort {
  releaseId: string;
  modelVersion: string;
  segments: FrozenSegment[];
  /** 分区规模（母体口径） */
  zoneSizes: Record<string, number>;
  keyZoneId: string;
  keyZoneCount: number;
  /**
   * 母体真实结局（独立于任何抽样与人工修正）：用于构造 90 日现场核验观测。
   * 与冻结预测在同一确定性随机流上逐段「先抽三终点真实率、再抽三终点结局」生成，
   * 保证预测与结局同源可回放。
   */
  truth: Record<string, Record<DriftEndpoint, boolean>>;
}

/**
 * 构建冻结母体：1000 段、三终点预测、空间分区、模型版本，以及（确定性）真实结局。
 * 每段的 ATTR/PERMIT/MAINT 预测来自同一冻结快照的三个子模型；
 * 结局以预测概率为真实发生率独立抽样（模拟 90 日现场核验的虚构图景）。
 */
export function buildFrozenCohort(): FrozenCohort {
  const rnd = mulberry32(COHORT_SEED);
  const zoneOrder: string[] = [];
  for (const [zone, n] of ZONE_SIZES) for (let i = 0; i < n; i++) zoneOrder.push(zone);
  const shuffledZones = shuffle(zoneOrder, rnd);

  const segments: FrozenSegment[] = [];
  const truth: Record<string, Record<DriftEndpoint, boolean>> = {};
  for (let i = 0; i < 1000; i++) {
    const zoneId = shuffledZones[i];
    const predicted = {} as Record<DriftEndpoint, number>;
    const previousPredicted = {} as Record<DriftEndpoint, number>;
    for (const ep of DRIFT_ENDPOINTS) {
      const [lo, hi] = RATE_RANGES[zoneId][ep];
      const rate = lo + (hi - lo) * rnd();
      predicted[ep] = clampProb(rate);
      previousPredicted[ep] = clampProb(sigmoid(logit(rate) + PREV_LOGIT_SHIFT));
    }
    const segmentId = `P${String(i + 1).padStart(4, '0')}`;
    // 与预测同段同序抽取真实结局
    const segTruth = {} as Record<DriftEndpoint, boolean>;
    for (const ep of DRIFT_ENDPOINTS) {
      segTruth[ep] = rnd() < predicted[ep];
    }
    truth[segmentId] = segTruth;
    segments.push({
      segmentId,
      tileId: zoneId === 'Z-H' ? 'TILE_H' : zoneId === 'Z-C' ? 'TILE_C' : zoneId === 'Z-B' ? 'TILE_B' : 'TILE_A',
      zoneId,
      highRisk: zoneId === KEY_ZONE_ID,
      predicted,
      previousPredicted,
      modelVersion: DRIFT_MODEL_VERSION,
      releaseId: DRIFT_RELEASE_ID,
    });
  }

  return {
    releaseId: DRIFT_RELEASE_ID,
    modelVersion: DRIFT_MODEL_VERSION,
    segments,
    zoneSizes: Object.fromEntries(ZONE_SIZES),
    keyZoneId: KEY_ZONE_ID,
    keyZoneCount: ZONE_SIZES.find(([z]) => z === KEY_ZONE_ID)![1],
    truth,
  };
}

/**
 * 独立现场核验观测：以母体真实结局为结果、默认全部为 verified
 * （窗口已结束、独立核验、无人工修正）。
 */
export function buildObservations(cohort: FrozenCohort): EndpointObservation[] {
  const observations: EndpointObservation[] = [];
  for (const seg of cohort.segments) {
    for (const ep of DRIFT_ENDPOINTS) {
      observations.push({
        segmentId: seg.segmentId,
        endpoint: ep,
        status: 'verified',
        event: cohort.truth[seg.segmentId][ep],
        observedAt: '2026-04-15',
        source: ep === 'MAINT' ? '维修工单闭环 + 现场核验' : '第三方现场核验',
      });
    }
  }
  return observations;
}

/** 入选记录：入样概率由抽样路线与已知设计决定 */
export interface RouteSelection {
  route: SamplingRoute;
  label: string;
  records: SelectionRecord[];
  designNote: string;
}

/**
 * 两条抽样路线（复核预算均为 100 段）：
 *  - srs：从 1000 段母体简单随机抽取 100 段，每段入样概率 100/1000 = 0.1；
 *         Z-H 期望只抽到 4 段，稀有分区证据积累慢。
 *  - stratified：Z-H 全纳 40 段（入样概率 1） + 其余 960 段随机 60 段（入样概率 60/960 = 0.0625），
 *         每段入样概率显式记录，逆概率权重 = 1/π 还原同一母体。
 */
export function buildRouteSelections(cohort: FrozenCohort): Record<SamplingRoute, RouteSelection> {
  const all = cohort.segments;

  // 简单随机：对母体确定性洗牌后取前 100
  const rndSrs = mulberry32(SRS_SEED);
  const srsRank = rankMap(shuffle(all, rndSrs).map((s) => s.segmentId));
  const srsIds = new Set(all.filter((s) => srsRank[s.segmentId] < DRIFT_REVIEW_BUDGET).map((s) => s.segmentId));
  const srsRecords: SelectionRecord[] = all
    .filter((s) => srsIds.has(s.segmentId))
    .map((s) => ({
      segmentId: s.segmentId,
      zoneId: s.zoneId,
      highRisk: s.highRisk,
      stratum: s.zoneId,
      inclusionProbability: DRIFT_REVIEW_BUDGET / all.length,
      rank: srsRank[s.segmentId],
    }));

  // 分层：关键分区全纳 + 其余分区随机 60
  const keySegments = all.filter((s) => s.highRisk);
  const restSegments = all.filter((s) => !s.highRisk);
  const restQuota = DRIFT_REVIEW_BUDGET - keySegments.length; // 60
  const rndStrat = mulberry32(STRAT_SEED);
  const shuffledRest = shuffle(restSegments, rndStrat);
  const restRank = rankMap(shuffledRest.map((s) => s.segmentId));
  const stratRecords: SelectionRecord[] = [
    ...keySegments.map((s) => ({
      segmentId: s.segmentId,
      zoneId: s.zoneId,
      highRisk: true,
      stratum: s.zoneId,
      inclusionProbability: 1,
      rank: 0,
    })),
    ...shuffledRest.slice(0, restQuota).map((s) => ({
      segmentId: s.segmentId,
      zoneId: s.zoneId,
      highRisk: false,
      stratum: s.zoneId,
      inclusionProbability: restQuota / restSegments.length,
      rank: restRank[s.segmentId],
    })),
  ];

  return {
    srs: {
      route: 'srs',
      label: '路线 A · 简单随机抽检（不加权）',
      records: srsRecords,
      designNote: `从 1000 段母体简单随机抽取 ${DRIFT_REVIEW_BUDGET} 段，每段入样概率 ${DRIFT_REVIEW_BUDGET}/1000 = 0.10；代表性直接，稀有高风险分区收敛慢。`,
    },
    stratified: {
      route: 'stratified',
      label: '路线 B · 关键分区全纳 + 逆概率加权',
      records: stratRecords,
      designNote: `相同 ${DRIFT_REVIEW_BUDGET} 段预算下，Z-H 全部 40 段入样（π=1），其余 960 段随机 60 段（π=${restQuota}/960=${round4(restQuota / restSegments.length)}）；每段记录已知入样概率，按 1/π 加权还原同一母体。`,
    },
  };
}

function rankMap(ids: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  ids.forEach((id, i) => {
    out[id] = i;
  });
  return out;
}

/**
 * 「不可观测」记录：从抽样清单中挑出若干 (管段, 终点) 记录标记为
 * 未复核 / 人工修正 / 失访 / 观察窗未结束。它们绝不能当作阴性。
 * 只作用于路线 A 的样本（这些管段不在路线 B 的分层样本中），
 * 以对比两条路线的门禁结论。
 */
export const UNOBSERVABLE_ASSIGNMENTS: {
  segmentId: string;
  endpoint: DriftEndpoint;
  status: 'unverified' | 'manual_correction' | 'lost_to_followup' | 'window_open';
  note: string;
}[] = [];

export function applyUnobservable(
  cohort: FrozenCohort,
  selections: Record<SamplingRoute, RouteSelection>,
): EndpointObservation[] {
  const observations = buildObservations(cohort);
  const srs = selections.srs.records;
  const stratIds = new Set(selections.stratified.records.map((r) => r.segmentId));
  // 路线 A 中不属于关键分区、且不在路线 B 样本内的前 4 段
  const candidates = srs.filter((r) => !r.highRisk && !stratIds.has(r.segmentId)).map((r) => r.segmentId);
  const chosen = candidates.slice(0, 4);

  UNOBSERVABLE_ASSIGNMENTS.length = 0;
  const plan: { segmentId: string; endpoint: DriftEndpoint; status: (typeof UNOBSERVABLE_ASSIGNMENTS)[number]['status']; note: string }[] = [
    { segmentId: chosen[0], endpoint: 'ATTR', status: 'unverified', note: '该管段属性尚未安排现场复核' },
    { segmentId: chosen[1], endpoint: 'PERMIT', status: 'manual_correction', note: '许可命中由人工修正台账写入，非独立现场核验' },
    { segmentId: chosen[2], endpoint: 'MAINT', status: 'lost_to_followup', note: '维修确认在随访期内失访，无法判定' },
    { segmentId: chosen[3], endpoint: 'ATTR', status: 'window_open', note: '该管段属性异常的 90 日观察窗尚未结束' },
  ];

  const byKey = new Map(observations.map((o) => [`${o.segmentId}|${o.endpoint}`, o]));
  for (const p of plan) {
    if (!p.segmentId) continue;
    UNOBSERVABLE_ASSIGNMENTS.push(p);
    const o = byKey.get(`${p.segmentId}|${p.endpoint}`);
    if (o) {
      o.status = p.status;
      o.event = null;
      o.observedAt = null;
      o.source = '（不可观测，非独立核验）';
      o.note = p.note;
    }
  }
  return observations;
}

/** 组装复核样本账 */
export function buildLedger(
  cohort: FrozenCohort,
  selection: RouteSelection,
  observations: EndpointObservation[],
): ReviewLedger {
  const selectedIds = new Set(selection.records.map((r) => r.segmentId));
  const obsByKey = new Map(observations.map((o) => [`${o.segmentId}|${o.endpoint}`, o]));
  const observability = {} as Record<DriftEndpoint, { verified: number; selected: number }>;
  for (const ep of DRIFT_ENDPOINTS) {
    let verified = 0;
    let selected = 0;
    for (const id of selectedIds) {
      selected++;
      const o = obsByKey.get(`${id}|${ep}`);
      if (o?.status === 'verified') verified++;
    }
    observability[ep] = { verified, selected };
  }
  return {
    route: selection.route,
    cohortSize: cohort.segments.length,
    keyZoneCount: cohort.keyZoneCount,
    budget: DRIFT_REVIEW_BUDGET,
    selection: selection.records,
    observations,
    observability,
    designNote: selection.designNote,
  };
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

/** 供 UI 展示：某路线的关键分区抽样统计 */
export function selectionStats(ledger: ReviewLedger): {
  total: number;
  keyCount: number;
  keyExpected: number;
  restCount: number;
  restWeights: number[];
} {
  const keyCount = ledger.selection.filter((r) => r.highRisk).length;
  const rest = ledger.selection.filter((r) => !r.highRisk);
  const restWeights = [...new Set(rest.map((r) => Math.round(1 / r.inclusionProbability)))];
  return {
    total: ledger.selection.length,
    keyCount,
    keyExpected: Math.round((ledger.keyZoneCount / ledger.cohortSize) * ledger.budget),
    restCount: rest.length,
    restWeights,
  };
}
