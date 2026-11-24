// 漂移验证编排：冻结母体 -> 样本账 -> 预测-观测配对器 -> 空间校准 -> 版本差异 -> 扩面门禁。
//
// 关键纪律：
//  1) 配对器只把「独立现场核验且观察窗已结束」的记录计为阴性/阳性；
//     未复核、人工修正、失访、窗口未结束一律排除并计入可观测性，绝不当作阴性。
//  2) 不加权随机路线权重恒为 1（直接代表性）；
//     分层加权路线按每段已知入样概率 π 取逆概率权重 1/π 还原同一母体。
//  3) 三终点分别求校准截距/斜率、Brier、召回率及 95% 区间；
//     三终点都有独立观测、关键分区校准斜率区间含 1、总体 Brier 较上一版本增幅 ≤0.02、
//     召回率下限 ≥0.70 才可扩面；任一未复核/人工修正/失访/区间跨门限都阻止扩面并保留可观测范围。
import type {
  DriftEndpoint,
  DriftReport,
  EndpointMetrics,
  EndpointObservation,
  EndpointReport,
  ExpansionGate,
  GateCondition,
  PairedRecord,
  ReviewLedger,
  RouteComparison,
  RouteResult,
  ZoneMetrics,
} from './driftTypes';
import { DRIFT_ENDPOINTS, DRIFT_ENDPOINT_LABEL } from './driftTypes';
import {
  DRIFT_ALERT_THRESHOLD,
  DRIFT_OBSERVATION_DAYS,
  KEY_ZONE_ID,
  KEY_ZONE_LABEL,
  buildFrozenCohort,
  buildLedger,
  buildObservations,
  buildRouteSelections,
  applyUnobservable,
  type FrozenCohort,
  type RouteSelection,
} from './driftSample';
import {
  brierSummary,
  calibrationCurve,
  fitCalibration,
  recallSummary,
  round3,
  round4,
  type WeightedPoint,
} from './stats';
import { stableHash } from './hash';

/** 门禁参数（与 README/题目一致，集中定义便于核对） */
export const GATE_CONFIG = {
  /** Brier 误差较上一发布版本增加上限 */
  brierDeltaLimit: 0.02,
  /** 召回率 95% 区间下限必须达到 */
  recallLowerLimit: 0.7,
  /** 关键分区校准斜率区间必须包含 1 */
  slopeMustInclude: 1,
} as const;

export interface DriftValidateOptions {
  alertThreshold?: number;
  observationDays?: number;
}

interface PreparedRoute {
  route: RouteResult['route'];
  label: string;
  ledger: ReviewLedger;
  /** 每个终点 -> 通过核验的加权配对 */
  pairsByEndpoint: Record<DriftEndpoint, PairedRecord[]>;
  /** 每个终点 -> 不可观测状态计数（未复核/人工修正/失访/窗口未结束） */
  excluded: Record<DriftEndpoint, Record<string, number>>;
}

/**
 * 预测-观测配对器：把冻结母体的三终点预测与独立观测按 (segmentId, endpoint) 对齐。
 * 只有 verified 观测进入配对；其余状态进入不可观测计数。
 */
export function pairPredictionsWithObservations(
  cohort: FrozenCohort,
  ledger: ReviewLedger,
): {
  pairsByEndpoint: Record<DriftEndpoint, PairedRecord[]>;
  excludedByEndpoint: Record<DriftEndpoint, Record<string, number>>;
} {
  const segById = new Map(cohort.segments.map((s) => [s.segmentId, s]));
  const obsByKey = new Map(ledger.observations.map((o) => [`${o.segmentId}|${o.endpoint}`, o]));
  const weightOf = new Map(ledger.selection.map((r) => [r.segmentId, 1 / r.inclusionProbability]));

  const pairsByEndpoint = {} as Record<DriftEndpoint, PairedRecord[]>;
  const excludedByEndpoint = {} as Record<DriftEndpoint, Record<string, number>>;
  for (const ep of DRIFT_ENDPOINTS) {
    pairsByEndpoint[ep] = [];
    excludedByEndpoint[ep] = {};
  }

  for (const rec of ledger.selection) {
    const seg = segById.get(rec.segmentId);
    if (!seg) continue;
    const weight = weightOf.get(rec.segmentId) ?? 1;
    for (const ep of DRIFT_ENDPOINTS) {
      const obs = obsByKey.get(`${rec.segmentId}|${ep}`);
      if (!obs || obs.status !== 'verified' || obs.event === null) {
        const status = obs?.status ?? 'unverified';
        excludedByEndpoint[ep][status] = (excludedByEndpoint[ep][status] ?? 0) + 1;
        continue;
      }
      pairsByEndpoint[ep].push({
        segmentId: seg.segmentId,
        zoneId: seg.zoneId,
        highRisk: seg.highRisk,
        endpoint: ep,
        predicted: seg.predicted[ep],
        previousPredicted: seg.previousPredicted ? seg.previousPredicted[ep] : null,
        event: obs.event,
        weight,
        reliability: seg.highRisk ? 0.9 : 0.8,
        releaseId: seg.releaseId,
        modelVersion: seg.modelVersion,
      });
    }
  }

  for (const ep of DRIFT_ENDPOINTS) {
    pairsByEndpoint[ep].sort((a, b) => a.segmentId.localeCompare(b.segmentId));
  }
  return { pairsByEndpoint, excludedByEndpoint };
}

function toWeighted(pairs: PairedRecord[]): WeightedPoint[] {
  return pairs.map((p) => ({ predicted: p.predicted, event: p.event, weight: p.weight }));
}

function computeEndpointMetrics(
  endpoint: DriftEndpoint,
  pairs: PairedRecord[],
  alertThreshold: number,
): EndpointMetrics {
  const wp = toWeighted(pairs);
  const fit = fitCalibration(wp);
  const brier = brierSummary(pairs.map((p) => ({ predicted: p.predicted, previous: p.previousPredicted, event: p.event, weight: p.weight })));
  const rec = recallSummary(wp, alertThreshold);
  const positives = pairs.filter((p) => p.event).length;

  const versionDifference = buildVersionDifference(pairs, fit, brier.delta, brier.deltaCi);

  return {
    endpoint,
    n: pairs.length,
    positives,
    positivesWeighted: rec.positivesWeighted,
    calibration: fit
      ? {
          intercept: round4(fit.intercept) ?? 0,
          slope: round4(fit.slope) ?? 0,
          interceptCi: [round4(fit.interceptCi[0]) ?? 0, round4(fit.interceptCi[1]) ?? 0],
          slopeCi: [round4(fit.slopeCi[0]) ?? 0, round4(fit.slopeCi[1]) ?? 0],
        }
      : null,
    brier: round4(brier.brier) ?? 0,
    brierCi: brier.brierCi ? [round4(brier.brierCi[0]) ?? 0, round4(brier.brierCi[1]) ?? 0] : null,
    brierDelta: round4(brier.delta),
    brierDeltaCi: brier.deltaCi ? [round4(brier.deltaCi[0]) ?? 0, round4(brier.deltaCi[1]) ?? 0] : null,
    recall: round4(rec.recall),
    recallCi: rec.ci ? [round4(rec.ci[0]) ?? 0, round4(rec.ci[1]) ?? 0] : null,
    versionDifference,
  };
}

function buildVersionDifference(
  pairs: PairedRecord[],
  currentFit: ReturnType<typeof fitCalibration>,
  brierDelta: number | null,
  brierDeltaCi: [number, number] | null,
): EndpointMetrics['versionDifference'] {
  const withPrev = pairs.filter((p) => p.previousPredicted !== null);
  const prevFit = fitCalibration(withPrev.map((p) => ({ predicted: p.previousPredicted!, event: p.event, weight: p.weight })));
  const interceptShift = currentFit && prevFit ? round4(currentFit.intercept - prevFit.intercept) : null;
  const slopeShift = currentFit && prevFit ? round4(currentFit.slope - prevFit.slope) : null;

  // 显著漂移：配对 Brier 差的 95% 区间整体 > 0（当前显著更差），
  // 或当前校准斜率区间不含 1 且与上一版本方向相反（校准结构反转）。
  const brierWorse = brierDeltaCi ? brierDeltaCi[0] > 0 : false;
  const slopeIncludesOne = currentFit ? currentFit.slopeCi[0] <= 1 && 1 <= currentFit.slopeCi[1] : false;
  const reversed =
    currentFit !== null &&
    prevFit !== null &&
    !slopeIncludesOne &&
    Math.sign(currentFit.slope - 1) !== Math.sign(prevFit.slope - 1);
  const driftDetected = brierWorse || reversed;

  let note: string;
  if (pairs.length === 0) note = '无独立配对，无法做版本差异检验';
  else if (driftDetected) note = brierWorse ? '配对 Brier 差区间整体为正，当前版本显著劣于上一版本' : '校准斜率结构相对上一版本反转，检出漂移';
  else note = '配对 Brier 差区间跨 0 且校准斜率未见结构反转，未检出显著漂移';

  return {
    interceptShift,
    slopeShift,
    brierDelta: round4(brierDelta),
    brierDeltaCi: brierDeltaCi ? [round4(brierDeltaCi[0]) ?? 0, round4(brierDeltaCi[1]) ?? 0] : null,
    driftDetected,
    note,
  };
}

function computeZoneMetrics(
  pairs: PairedRecord[],
  alertThreshold: number,
  zoneId: string,
): ZoneMetrics {
  const zonePairs = pairs.filter((p) => p.zoneId === zoneId);
  const wp = toWeighted(zonePairs);
  const fit = fitCalibration(wp);
  const brier = brierSummary(zonePairs.map((p) => ({ predicted: p.predicted, previous: p.previousPredicted, event: p.event, weight: p.weight })));
  const rec = recallSummary(wp, alertThreshold);
  const coverage = wp.reduce((s, r) => s + r.weight, 0);
  return {
    zoneId,
    highRisk: zoneId === KEY_ZONE_ID,
    n: zonePairs.length,
    positives: zonePairs.filter((p) => p.event).length,
    coverage: round4(coverage) ?? 0,
    calibration: fit
      ? {
          intercept: round4(fit.intercept) ?? 0,
          slope: round4(fit.slope) ?? 0,
          interceptCi: [round4(fit.interceptCi[0]) ?? 0, round4(fit.interceptCi[1]) ?? 0],
          slopeCi: [round4(fit.slopeCi[0]) ?? 0, round4(fit.slopeCi[1]) ?? 0],
        }
      : null,
    brier: round4(brier.brier) ?? 0,
    recall: round4(rec.recall),
    recallCi: rec.ci ? [round4(rec.ci[0]) ?? 0, round4(rec.ci[1]) ?? 0] : null,
    curve: calibrationCurve(wp, 5),
  };
}

function buildEndpointReport(
  endpoint: DriftEndpoint,
  pairs: PairedRecord[],
  cohort: FrozenCohort,
  alertThreshold: number,
  _excluded: Record<string, number>,
): EndpointReport {
  const metrics = computeEndpointMetrics(endpoint, pairs, alertThreshold);
  const zoneIds = [...new Set([...Object.keys(cohort.zoneSizes), ...pairs.map((p) => p.zoneId)])].sort(
    (a, b) => (a === KEY_ZONE_ID ? -1 : b === KEY_ZONE_ID ? 1 : a.localeCompare(b)),
  );
  const zones = zoneIds.map((z) => computeZoneMetrics(pairs, alertThreshold, z));
  return {
    endpoint,
    label: DRIFT_ENDPOINT_LABEL[endpoint],
    metrics,
    curve: calibrationCurve(toWeighted(pairs), 5),
    zones,
    hasIndependentObservation: pairs.length > 0,
  };
}

/** 门禁：逐终点评估全部条件 */
function buildEndpointGate(
  report: EndpointReport,
  _cohort: FrozenCohort,
  excludedCounts: Record<string, number>,
): ExpansionGate {
  const { endpoint, metrics, zones } = report;
  const conditions: GateCondition[] = [];

  // 独立观测是否齐全（全数端点必须存在已经过核验的配对）
  const hasObs = report.hasIndependentObservation && metrics.n > 0;
  conditions.push({
    key: 'independent_observation',
    label: '该终点存在独立现场核验观测',
    passed: hasObs,
    detail: hasObs ? `${metrics.n} 条可观测配对（阳性 ${metrics.positives}）` : '无独立观测，不得据此宣称漂移',
  });

  // 关键分区校准斜率区间包含 1
  const keyZone = zones.find((z) => z.zoneId === KEY_ZONE_ID);
  const slope = keyZone?.calibration?.slopeCi ?? null;
  const slopeOk = slope !== null && slope[0] <= GATE_CONFIG.slopeMustInclude && GATE_CONFIG.slopeMustInclude <= slope[1];
  conditions.push({
    key: 'key_zone_slope',
    label: `关键分区 ${KEY_ZONE_LABEL} 校准斜率 95% 区间包含 1`,
    passed: slopeOk,
    detail:
      keyZone?.calibration
        ? `斜率 ${round3(keyZone.calibration.slope)}，区间 [${round3(slope![0])}, ${round3(slope![1])}]（该分区可观测 ${keyZone.n} 段）`
        : `关键分区无可拟合校准（可观测 ${keyZone?.n ?? 0} 段），区间无法证明包含 1`,
  });

  // 总体 Brier 较上一版本增幅 ≤ 0.02（用配对差，正=变差；无上版本视为无法比较 -> 不放行）
  const delta = metrics.versionDifference?.brierDelta ?? null;
  const brierOk = delta !== null && delta <= GATE_CONFIG.brierDeltaLimit;
  conditions.push({
    key: 'brier_delta',
    label: `总体 Brier 较上一发布版本增幅 ≤ ${GATE_CONFIG.brierDeltaLimit}`,
    passed: brierOk,
    detail:
      delta === null
        ? '缺少上一发布版本预测，无法比较 Brier 增量'
        : `当前 Brier ${round3(metrics.brier)}，配对差 ${round3(delta)}（区间 [${round3(metrics.versionDifference?.brierDeltaCi?.[0] ?? null)}, ${round3(metrics.versionDifference?.brierDeltaCi?.[1] ?? null)}]）`,
  });

  // 召回率 95% 区间下限 ≥ 0.70
  const recallCi = metrics.recallCi;
  const recallOk = recallCi !== null && recallCi[0] >= GATE_CONFIG.recallLowerLimit;
  conditions.push({
    key: 'recall_lower',
    label: `召回率 95% 区间下限 ≥ ${GATE_CONFIG.recallLowerLimit}`,
    passed: recallOk,
    detail:
      recallCi === null
        ? '无可计算召回率的阳性观测'
        : `召回 ${round3(metrics.recall)}，区间 [${round3(recallCi[0])}, ${round3(recallCi[1])}]`,
  });

  // 可观测性：任何未复核/人工修正/失访/窗口未结束都不得当作阴性
  const excludedTotal = Object.values(excludedCounts).reduce((s, v) => s + v, 0);
  const observabilityOk = excludedTotal === 0;
  const parts = Object.entries(excludedCounts)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${statusLabel(k)}×${v}`);
  conditions.push({
    key: 'observability',
    label: '样本内不存在未复核/人工修正/失访/窗口未结束记录',
    passed: observabilityOk,
    detail: observabilityOk ? '全部抽中管段均为独立核验且窗口结束' : `存在不可观测记录：${parts.join('、')}；已从阴性计数排除，阻止扩面`,
  });

  return {
    endpoint,
    passed: conditions.every((c) => c.passed),
    conditions,
  };
}

function statusLabel(status: string): string {
  switch (status) {
    case 'unverified':
      return '未复核';
    case 'manual_correction':
      return '人工修正';
    case 'lost_to_followup':
      return '失访';
    case 'window_open':
      return '观察窗未结束';
    default:
      return status;
  }
}

function buildRouteResult(prepared: PreparedRoute, cohort: FrozenCohort, excludedByEndpoint: Record<DriftEndpoint, Record<string, number>>, alertThreshold: number): RouteResult {
  const endpoints = DRIFT_ENDPOINTS.map((ep) =>
    buildEndpointReport(ep, prepared.pairsByEndpoint[ep], cohort, alertThreshold, excludedByEndpoint[ep]),
  );
  const gates = endpoints.map((r) => buildEndpointGate(r, cohort, excludedByEndpoint[r.endpoint]));

  const blockers: string[] = [];
  for (const gate of gates) {
    for (const c of gate.conditions) {
      if (!c.passed) {
        blockers.push(`${DRIFT_ENDPOINT_LABEL[gate.endpoint]}：${c.label} —— ${c.detail}`);
      }
    }
  }
  if (endpoints.some((e) => !e.hasIndependentObservation)) {
    blockers.push('至少一个终点缺少独立观测，无独立终点不得称漂移');
  }

  const expansionEligible = gates.every((g) => g.passed) && endpoints.every((e) => e.hasIndependentObservation);

  // 可观测范围：未通过时保留「已验证且可观测」的分区/口径，明确不能扩面的区域
  const observableZones = endpoints
    .map((e) => {
      const okZones = e.zones.filter((z) => z.n > 0).map((z) => z.zoneId);
      return `${DRIFT_ENDPOINT_LABEL[e.endpoint]}（可观测分区：${okZones.join('、') || '无'}）`;
    })
    .join('；');
  const observableScope = expansionEligible
    ? `三终点均在全部可观测分区通过门禁，可扩面（${observableZones}）`
    : `阻止扩面；仅保留可观测范围：${observableZones}。未复核/人工修正/失访/窗口未结束的分区或口径不得纳入阴性。`;

  return {
    route: prepared.route,
    label: prepared.label,
    ledger: prepared.ledger,
    endpoints,
    gates,
    expansionEligible,
    blockers,
    observableScope,
  };
}

function buildComparison(routeA: RouteResult, routeB: RouteResult): RouteComparison {
  const keyZone = DRIFT_ENDPOINTS.map((ep) => {
    const a = routeA.endpoints.find((e) => e.endpoint === ep)!;
    const b = routeB.endpoints.find((e) => e.endpoint === ep)!;
    const aKey = a.zones.find((z) => z.zoneId === KEY_ZONE_ID);
    const bKey = b.zones.find((z) => z.zoneId === KEY_ZONE_ID);
    const aRecall = aKey?.recallCi ?? null;
    const bRecall = bKey?.recallCi ?? null;
    const aSlope = aKey?.calibration?.slopeCi ?? null;
    const bSlope = bKey?.calibration?.slopeCi ?? null;
    return {
      endpoint: ep,
      srsRecallCi: aRecall,
      stratRecallCi: bRecall,
      srsSlopeCi: aSlope,
      stratSlopeCi: bSlope,
      srsCrossThreshold: aRecall ? aRecall[0] < GATE_CONFIG.recallLowerLimit : true,
      stratCrossThreshold: bRecall ? bRecall[0] < GATE_CONFIG.recallLowerLimit : true,
      srsSlopeIncludesOne: aSlope ? aSlope[0] <= 1 && 1 <= aSlope[1] : false,
      stratSlopeIncludesOne: bSlope ? bSlope[0] <= 1 && 1 <= bSlope[1] : false,
    };
  });

  const overallBrier = DRIFT_ENDPOINTS.map((ep) => {
    const a = routeA.endpoints.find((e) => e.endpoint === ep)!.metrics;
    const b = routeB.endpoints.find((e) => e.endpoint === ep)!.metrics;
    return {
      endpoint: ep,
      srsBrier: a.brier,
      stratBrier: b.brier,
      srsDelta: a.brierDelta,
      stratDelta: b.brierDelta,
    };
  });

  const notes: string[] = [
    `两条路线使用同一冻结母体（${routeA.ledger.cohortSize} 段，关键分区 ${routeA.ledger.keyZoneCount} 段）、同一 ${DRIFT_OBSERVATION_DAYS} 日观察窗、同一三终点与同一门限。`,
    `路线 A 随机抽检关键分区仅 ${routeA.ledger.selection.filter((r) => r.highRisk).length} 段；路线 B 按已知入样概率将 ${routeB.ledger.selection.filter((r) => r.highRisk).length} 段关键分区全部纳入，其余分区抽样后以 1/π 加权还原母体。`,
    `门禁结论：路线 A ${routeA.expansionEligible ? '可扩面' : '阻止扩面'}，路线 B ${routeB.expansionEligible ? '可扩面' : '阻止扩面'}。`,
  ];

  return { routeA, routeB, keyZone, overallBrier, notes };
}

/**
 * 全量漂移验证：构造冻结母体、两条抽样路线、配对、校准、版本差异、门禁，并给出可回放指纹。
 */
export async function runDriftValidation(opts: DriftValidateOptions = {}): Promise<DriftReport> {
  const alertThreshold = opts.alertThreshold ?? DRIFT_ALERT_THRESHOLD;
  const observationDays = opts.observationDays ?? DRIFT_OBSERVATION_DAYS;

  const cohort = buildFrozenCohort();
  const selections = buildRouteSelections(cohort);
  const observations = applyUnobservable(cohort, selections);

  const prepared: Record<'srs' | 'stratified', PreparedRoute> = {
    srs: prepare('srs', selections.srs, cohort, observations),
    stratified: prepare('stratified', selections.stratified, cohort, observations),
  };

  const srsResult = buildRouteResult(prepared.srs, cohort, prepared.srs.excluded, alertThreshold);
  const stratResult = buildRouteResult(prepared.stratified, cohort, prepared.stratified.excluded, alertThreshold);
  const comparison = buildComparison(srsResult, stratResult);

  const allEndpointsObserved = [...srsResult.endpoints, ...stratResult.endpoints].every((e) => e.hasIndependentObservation);

  // 回放指纹：只依赖冻结母体 + 观测 + 口径参数（不含时间），保证离线可复现
  const replayHash = await stableHash({
    releaseId: cohort.releaseId,
    modelVersion: cohort.modelVersion,
    cohortSize: cohort.segments.length,
    zoneSizes: cohort.zoneSizes,
    alertThreshold,
    observationDays,
    observations: observations
      .slice()
      .sort((a, b) => `${a.segmentId}|${a.endpoint}`.localeCompare(`${b.segmentId}|${b.endpoint}`))
      .map((o) => `${o.segmentId}|${o.endpoint}|${o.status}|${o.event === null ? 'NA' : o.event ? 1 : 0}`),
    routes: [srsResult, stratResult].map((r) => ({
      route: r.route,
      expansionEligible: r.expansionEligible,
      gates: r.gates.map((g) => g.conditions.map((c) => `${c.key}:${c.passed}`)),
    })),
  });

  return {
    reportId: 'DRIFT-2026-01',
    createdAt: '2026-04-20T09:00:00.000Z',
    observationDays,
    keyZoneId: KEY_ZONE_ID,
    recallThreshold: alertThreshold,
    brierDeltaLimit: GATE_CONFIG.brierDeltaLimit,
    recallLowerLimit: GATE_CONFIG.recallLowerLimit,
    comparison,
    replayHash,
    allEndpointsObserved,
  };
}

function prepare(
  route: 'srs' | 'stratified',
  selection: RouteSelection,
  cohort: FrozenCohort,
  observations: EndpointObservation[],
): PreparedRoute {
  const ledger = buildLedger(cohort, selection, observations);
  const { pairsByEndpoint, excludedByEndpoint } = pairPredictionsWithObservations(cohort, ledger);
  return {
    route,
    label: selection.label,
    ledger,
    pairsByEndpoint,
    excluded: excludedByEndpoint,
  };
}

export { buildFrozenCohort, buildRouteSelections, buildObservations, applyUnobservable, buildLedger };

/**
 * 对给定观测运行单条抽样路线的验证（供测试/自定义观测复用）。
 * 观测可以是任意（含把某终点全部置为不可观测的合成场景）。
 */
export function evaluateRoute(
  route: 'srs' | 'stratified',
  cohort: FrozenCohort,
  selection: RouteSelection,
  observations: EndpointObservation[],
  opts: DriftValidateOptions = {},
): RouteResult {
  const alertThreshold = opts.alertThreshold ?? DRIFT_ALERT_THRESHOLD;
  const prepared = prepare(route, selection, cohort, observations);
  return buildRouteResult(prepared, cohort, prepared.excluded, alertThreshold);
}
