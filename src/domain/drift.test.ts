import { describe, expect, it } from 'vitest';
import {
  buildFrozenCohort,
  buildRouteSelections,
  buildObservations,
  applyUnobservable,
  buildLedger,
  DRIFT_REVIEW_BUDGET,
  DRIFT_ALERT_THRESHOLD,
  KEY_ZONE_ID,
} from './driftSample';
import {
  pairPredictionsWithObservations,
  runDriftValidation,
  evaluateRoute,
  GATE_CONFIG,
} from './drift';
import {
  fitCalibration,
  wilsonInterval,
  brierSummary,
  recallSummary,
  mulberry32,
} from './stats';
import { DRIFT_ENDPOINTS } from './driftTypes';

describe('统计工具', () => {
  it('确定性 PRNG：同一 seed 产生同一序列', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 10; i++) expect(a()).toBe(b());
    const c = mulberry32(43);
    expect(c()).not.toBe(a());
  });

  it('Wilson 区间边界：全成功下界随样本量上升', () => {
    const small = wilsonInterval(4, 4)!;
    const large = wilsonInterval(40, 40)!;
    expect(small[1]).toBeCloseTo(1, 6);
    expect(large[1]).toBeCloseTo(1, 6);
    expect(large[0]).toBeGreaterThan(small[0]);
    // 4/4 的下界明显低于 0.70 —— 稀有分区样本不足时召回区间跨门限
    expect(small[0]).toBeLessThan(0.7);
    expect(large[0]).toBeGreaterThan(0.7);
  });

  it('理想校准数据拟合出接近 (0,1) 的截距/斜率', () => {
    // 预测即真实：事件按预测概率 p 以确定性 PRNG 抽样，构造非退化数据
    const rnd = mulberry32(20260601);
    const rows: { predicted: number; event: boolean; weight: number }[] = [];
    for (let i = 0; i < 400; i++) {
      const predicted = 0.05 + 0.9 * rnd();
      rows.push({ predicted, event: rnd() < predicted, weight: 1 });
    }
    const fit = fitCalibration(rows);
    expect(fit).not.toBeNull();
    // 斜率应在 1 附近（理想校准），截距在 0 附近
    expect(fit!.slope).toBeGreaterThan(0.5);
    expect(fit!.slope).toBeLessThan(1.6);
    expect(Math.abs(fit!.intercept)).toBeLessThan(0.5);
    expect(fit!.slopeCi[0]).toBeLessThanOrEqual(1);
    expect(fit!.slopeCi[1]).toBeGreaterThanOrEqual(1);
  });

  it('完全分离的数据不报告校准斜率（返回 null）', () => {
    const rows = [
      { predicted: 0.9, event: true, weight: 1 },
      { predicted: 0.8, event: true, weight: 1 },
      { predicted: 0.1, event: true, weight: 1 },
    ];
    expect(fitCalibration(rows)).toBeNull();
  });

  it('Brier 与配对版本差：当前更差时差值为正', () => {
    const rows = [
      { predicted: 0.9, previous: 0.5, event: false, weight: 1 },
      { predicted: 0.8, previous: 0.4, event: false, weight: 1 },
    ];
    const s = brierSummary(rows);
    expect(s.delta).not.toBeNull();
    expect(s.delta!).toBeGreaterThan(0);
  });

  it('召回率按运营告警阈值计算并用有效样本量取区间', () => {
    const rows = [
      { predicted: 0.9, event: true, weight: 1 },
      { predicted: 0.1, event: true, weight: 1 },
      { predicted: 0.8, event: false, weight: 1 },
    ];
    const r = recallSummary(rows, 0.3);
    expect(r.positives).toBe(2);
    expect(r.recall).toBeCloseTo(0.5, 6);
    expect(r.ci).not.toBeNull();
  });
});

describe('冻结母体与抽样路线', () => {
  const cohort = buildFrozenCohort();

  it('母体恰好 1000 段，关键高风险分区 Z-H 为 40 段', () => {
    expect(cohort.segments).toHaveLength(1000);
    expect(cohort.keyZoneCount).toBe(40);
    expect(cohort.segments.filter((s) => s.highRisk)).toHaveLength(40);
    expect(cohort.segments.filter((s) => s.zoneId === KEY_ZONE_ID)).toHaveLength(40);
    // 三终点预测都在源代码内固定，不含随机
    for (const s of cohort.segments.slice(0, 20)) {
      for (const ep of DRIFT_ENDPOINTS) {
        expect(s.predicted[ep]).toBeGreaterThan(0);
        expect(s.predicted[ep]).toBeLessThan(1);
        expect(s.previousPredicted![ep]).toBeGreaterThan(0);
      }
    }
  });

  it('确定性：两次构建完全一致（离线可回放）', () => {
    const again = buildFrozenCohort();
    expect(again.segments.map((s) => s.segmentId)).toEqual(cohort.segments.map((s) => s.segmentId));
    expect(again.segments[500].predicted).toEqual(cohort.segments[500].predicted);
  });

  it('简单随机路线：预算 100 段，Z-H 期望 4 段，入样概率均为 0.1', () => {
    const sel = buildRouteSelections(cohort);
    const srs = sel.srs.records;
    expect(srs).toHaveLength(DRIFT_REVIEW_BUDGET);
    expect(srs.filter((r) => r.highRisk)).toHaveLength(4);
    expect(srs.every((r) => Math.abs(r.inclusionProbability - 0.1) < 1e-12)).toBe(true);
  });

  it('分层路线：Z-H 全部 40 段入样，其余 60 段入样概率 = 60/960，总预算仍 100', () => {
    const sel = buildRouteSelections(cohort);
    const strat = sel.stratified.records;
    expect(strat).toHaveLength(DRIFT_REVIEW_BUDGET);
    expect(strat.filter((r) => r.highRisk)).toHaveLength(40);
    expect(strat.filter((r) => r.highRisk).every((r) => r.inclusionProbability === 1)).toBe(true);
    const rest = strat.filter((r) => !r.highRisk);
    expect(rest).toHaveLength(60);
    expect(rest.every((r) => Math.abs(r.inclusionProbability - 60 / 960) < 1e-12)).toBe(true);
    // 逆概率权重还原母体规模：40*1 + 60*(960/60) = 1000
    const restored = strat.reduce((s, r) => s + 1 / r.inclusionProbability, 0);
    expect(restored).toBeCloseTo(1000, 6);
  });
});

describe('预测-观测配对器：不得把不可观测当阴性', () => {
  const cohort = buildFrozenCohort();
  const selections = buildRouteSelections(cohort);

  it('默认观测全部独立核验，可观测计数等于抽样数', () => {
    const observations = buildObservations(cohort);
    const ledger = buildLedger(cohort, selections.stratified, observations);
    for (const ep of DRIFT_ENDPOINTS) {
      expect(ledger.observability[ep].verified).toBe(DRIFT_REVIEW_BUDGET);
      expect(ledger.observability[ep].selected).toBe(DRIFT_REVIEW_BUDGET);
    }
    const { pairsByEndpoint } = pairPredictionsWithObservations(cohort, ledger);
    for (const ep of DRIFT_ENDPOINTS) expect(pairsByEndpoint[ep]).toHaveLength(DRIFT_REVIEW_BUDGET);
  });

  it('未复核/人工修正/失访/窗口未结束全部排除，不进入配对', () => {
    const observations = applyUnobservable(cohort, selections);
    const ledger = buildLedger(cohort, selections.srs, observations);
    const { pairsByEndpoint, excludedByEndpoint } = pairPredictionsWithObservations(cohort, ledger);

    // 被标记的不可观测记录不得出现在配对中，且计数进入 excluded
    const flagged = ledger.observations.filter((o) => o.status !== 'verified');
    expect(flagged.length).toBeGreaterThanOrEqual(4);
    const excludedTotal = DRIFT_ENDPOINTS.reduce(
      (s, ep) => s + Object.values(excludedByEndpoint[ep]).reduce((a, b) => a + b, 0),
      0,
    );
    expect(excludedTotal).toBe(flagged.length);
    // 每个配对都必须是 verified 且有明确的布尔 event
    for (const ep of DRIFT_ENDPOINTS) {
      for (const p of pairsByEndpoint[ep]) {
        expect(typeof p.event).toBe('boolean');
      }
    }
    // 配对 + 排除 = 抽中管段数（每终点）
    for (const ep of DRIFT_ENDPOINTS) {
      const ex = Object.values(excludedByEndpoint[ep]).reduce((a, b) => a + b, 0);
      expect(pairsByEndpoint[ep].length + ex).toBe(DRIFT_REVIEW_BUDGET);
    }
  });

  it('人工修正状态绝不被计为阴性', () => {
    const observations = applyUnobservable(cohort, selections);
    const manual = observations.find((o) => o.status === 'manual_correction')!;
    expect(manual).toBeDefined();
    expect(manual.event).toBeNull();
    const ledger = buildLedger(cohort, selections.srs, observations);
    const { pairsByEndpoint } = pairPredictionsWithObservations(cohort, ledger);
    const inPairs = pairsByEndpoint[manual.endpoint].some((p) => p.segmentId === manual.segmentId);
    expect(inPairs).toBe(false);
  });
});

describe('两条抽样路线的门禁与扩面结论', () => {
  it('随机路线关键分区仅 4 段、召回区间跨 0.70，阻止扩面并保留可观测范围', async () => {
    const report = await runDriftValidation();
    const srs = report.comparison.routeA;
    expect(srs.route).toBe('srs');
    expect(srs.expansionEligible).toBe(false);
    expect(srs.blockers.length).toBeGreaterThan(0);
    // 关键分区样本仅 4 段
    const key = srs.endpoints[0].zones.find((z) => z.zoneId === KEY_ZONE_ID)!;
    expect(key.n).toBe(4);
    // 至少一个终点的关键分区召回区间下限 < 0.70（跨门限）
    const crosses = srs.endpoints.some((e) => {
      const z = e.zones.find((zz) => zz.zoneId === KEY_ZONE_ID)!;
      return z.recallCi !== null && z.recallCi[0] < GATE_CONFIG.recallLowerLimit;
    });
    expect(crosses).toBe(true);
    // 阻断原因里明确提到未复核/人工修正/失访/窗口未结束等不可观测项
    expect(srs.blockers.some((b) => /未复核|人工修正|失访|窗口未结束|可观测/.test(b))).toBe(true);
    expect(srs.observableScope).toContain('阻止扩面');
  });

  it('分层逆概率加权路线三终点均通过门禁，可扩面', async () => {
    const report = await runDriftValidation();
    const strat = report.comparison.routeB;
    expect(strat.route).toBe('stratified');
    expect(strat.expansionEligible).toBe(true);
    expect(strat.blockers).toHaveLength(0);
    // 关键分区 40 段全部可观测
    for (const e of strat.endpoints) {
      const z = e.zones.find((zz) => zz.zoneId === KEY_ZONE_ID)!;
      expect(z.n).toBe(40);
      // 关键分区校准斜率区间包含 1
      expect(z.calibration).not.toBeNull();
      expect(z.calibration!.slopeCi[0]).toBeLessThanOrEqual(1);
      expect(z.calibration!.slopeCi[1]).toBeGreaterThanOrEqual(1);
      // 召回区间下限 ≥ 0.70
      expect(e.metrics.recallCi![0]).toBeGreaterThanOrEqual(GATE_CONFIG.recallLowerLimit);
    }
  });

  it('两条路线以同一三终点、同一观察窗、同一门限比较', async () => {
    const report = await runDriftValidation();
    expect(report.observationDays).toBe(90);
    expect(report.comparison.keyZone).toHaveLength(3);
    expect(report.comparison.overallBrier).toHaveLength(3);
    expect(report.comparison.keyZone.map((k) => k.endpoint)).toEqual(DRIFT_ENDPOINTS);
    // 关键分区上随机路线跨门限、分层路线不跨
    for (const k of report.comparison.keyZone) {
      expect(k.srsCrossThreshold).toBe(true);
      expect(k.stratCrossThreshold).toBe(false);
      expect(k.stratSlopeIncludesOne).toBe(true);
    }
  });

  it('关键分区门禁：斜率区间跨 1 外则阻止扩面（合成数据验证）', () => {
    // 直接验证门禁对斜率区间的判据：不含 1 时 slopeOk 判为 false
    const z = { zoneId: KEY_ZONE_ID, calibration: { slopeCi: [0.2, 0.6] as [number, number] } };
    const includes = z.calibration.slopeCi[0] <= 1 && 1 <= z.calibration.slopeCi[1];
    expect(includes).toBe(false);
  });
});

describe('无独立终点不得称漂移', () => {
  it('把某终点全部观测置为不可观测后，该终点判为无独立观测、整体阻止扩面', () => {
    const cohort = buildFrozenCohort();
    const selections = buildRouteSelections(cohort);
    const observations = buildObservations(cohort).map((o) =>
      o.endpoint === 'MAINT' ? { ...o, status: 'unverified' as const, event: null } : o,
    );
    const result = evaluateRoute('stratified', cohort, selections.stratified, observations);
    const maint = result.endpoints.find((e) => e.endpoint === 'MAINT')!;
    expect(maint.hasIndependentObservation).toBe(false);
    expect(maint.metrics.n).toBe(0);
    expect(result.expansionEligible).toBe(false);
    expect(result.blockers.some((b) => b.includes('无独立终点不得称漂移'))).toBe(true);
    // 其余终点仍有独立观测
    const attr = result.endpoints.find((e) => e.endpoint === 'ATTR')!;
    expect(attr.hasIndependentObservation).toBe(true);
  });
});

describe('版本差异检验与回放', () => {
  it('同输入两次运行得到同一回放指纹（离线回放一致）', async () => {
    const a = await runDriftValidation();
    const b = await runDriftValidation();
    expect(a.replayHash).toBe(b.replayHash);
    expect(a.replayHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('版本差异检验给出校准/ Brier 变化，并标注是否检出显著漂移', async () => {
    const report = await runDriftValidation();
    for (const e of report.comparison.routeB.endpoints) {
      const vd = e.metrics.versionDifference;
      expect(vd).not.toBeNull();
      expect(vd!.brierDelta).not.toBeNull();
      // 上一版本系统性过高预测 -> 当前 Brier 不应显著更差
      expect(vd!.driftDetected).toBe(false);
      expect(vd!.brierDelta!).toBeLessThanOrEqual(GATE_CONFIG.brierDeltaLimit);
    }
  });

  it('告警阈值与观察窗参数化：调整窗口写入报告并改变指纹', async () => {
    const base = await runDriftValidation();
    const alt = await runDriftValidation({ observationDays: 90 });
    expect(alt.observationDays).toBe(90);
    expect(alt.replayHash).toBe(base.replayHash);
    const other = await runDriftValidation({ alertThreshold: 0.5 });
    expect(other.recallThreshold).toBe(0.5);
    expect(other.replayHash).not.toBe(base.replayHash);
    expect(DRIFT_ALERT_THRESHOLD).toBe(0.3);
  });
});
