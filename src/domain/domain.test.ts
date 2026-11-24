import { beforeAll, describe, expect, it } from 'vitest';
import {
  anomalyPackage,
  baselinePackage,
  correctionPackage,
  splitPackage,
  TOPOLOGY_RULE_VERSION,
  TOPOLOGY_TOLERANCE_M,
} from './sampleData';
import { importPackage } from './importer';
import { applyCorrection, buildCorrection } from './correction';
import { buildLineage, measureLineageMovements } from './lineage';
import { buildNetwork, downstreamClosure } from './topology';
import { buildPermit, evaluatePermit, originallyCoveredSegmentIds } from './permit';
import { runRiskModel, featureFingerprint } from './model';
import { evaluateImpact } from './impact';
import { allSegmentIdsOf, executeRecompute } from './recompute';
import { buildReleaseSnapshot, replaySnapshot } from './snapshot';
import { markStaleReports, syncDrafts } from './sync';
import type { ReviewDraft } from './types';
import { fnv1a } from './hash';

const textOf = (pkg: unknown) => JSON.stringify(pkg);

async function buildFor(pkg: ReturnType<typeof baselinePackage>, version: number) {
  const imported = await importPackage(pkg, textOf(pkg));
  const { correction, zoneShifts } = buildCorrection(pkg, 'transform-v1');
  const { segments, valves } = applyCorrection(pkg, zoneShifts);
  const lineage = buildLineage(pkg);
  const topo = buildNetwork(segments, valves, pkg.meta.packageId, correction.correctionId, version, TOPOLOGY_TOLERANCE_M);
  const permit = buildPermit(pkg);
  const model = runRiskModel(pkg.model!.modelCode, pkg.model!.threshold, pkg.model!.inputWaterLevelM, topo.network, segments, version);
  return { imported, correction, zoneShifts, segments, valves, lineage, topo, permit, model };
}

describe('导入器：哈希与语义核验', () => {
  it('正常包通过且记录哈希/来源/坐标系/历元/单位', async () => {
    const r = await importPackage(baselinePackage(), textOf(baselinePackage()));
    expect(r.blocked).toBe(false);
    expect(r.meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.meta.epoch).toBe('2026.1');
    expect(r.meta.declaredUnit).toBe('meter');
    expect(r.issues).toHaveLength(0);
  });

  it('异常包：历元缺失、单位误标、续接歧义分别独立拦截，哈希正确也不能放行', async () => {
    const pkg = anomalyPackage();
    const r = await importPackage(pkg, textOf(pkg));
    expect(r.meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.blocked).toBe(true);
    const codes = r.issues.map((i) => i.code).sort();
    expect(codes).toEqual(['EPOCH_MISSING', 'UNIT_MISLABELED', 'UNRESOLVED_LINEAGE']);
    expect(r.issues.every((i) => i.severity === 'block')).toBe(true);
  });
});

describe('控制点校正器', () => {
  it('保存残差并给出分区 95% 误差带；Z-B 无控制点时继承全局平移', () => {
    const { correction, zoneShifts } = buildCorrection(correctionPackage(), 'transform-v1');
    expect(correction.controlPoints).toHaveLength(2);
    const za = correction.zoneRanges.find((z) => z.zoneId === 'Z-A')!;
    expect(za.band95).toBeGreaterThan(0);
    const shift = zoneShifts.find((s) => s.zoneId === 'Z-A')!;
    expect(Math.hypot(shift.dx, shift.dy)).toBeCloseTo(0.791, 1); // ≈0.8 米横移
    const zb = zoneShifts.find((s) => s.zoneId === 'Z-B')!;
    expect(zb.inherited).toBe(true);
  });
});

describe('拓扑重建器', () => {
  it('拆分包含 S4A/S4B、阀门 V3 节点及跨瓦片依赖', async () => {
    const { segments, topo } = await buildFor(splitPackage(), 3);
    expect(segments.map((s) => s.id).sort()).toEqual(['S1', 'S2', 'S3', 'S4A', 'S4B', 'S5', 'S6']);
    const v3 = topo.network.nodes.find((n) => n.valveId === 'V3');
    expect(v3).toBeDefined();
    expect(v3!.tileId).toBe('TILE_B');
    expect(topo.crossTile.some((c) => c.viaSegmentId === 'S4A' && c.viaValveId === 'V3')).toBe(true);
    const edgeIds = topo.network.edges.map((e) => e.segmentId);
    expect(edgeIds).toContain('S4A');
    expect(edgeIds).toContain('S4B');
  });
});

describe('许可影响', () => {
  it('基准校正后 S3 的 95% 误差带触及 3 米缓冲边界，许可进入复核并阻断', async () => {
    const baseline = await buildFor(baselinePackage(), 1);
    const corr = await buildFor(correctionPackage(), 2);
    const covered = originallyCoveredSegmentIds(corr.permit!, baseline.segments);
    expect(covered).toContain('S3');
    const verdict = evaluatePermit(
      corr.permit!,
      corr.segments,
      ['S3'],
      corr.correction.zoneRanges,
      covered,
    );
    expect(verdict.bandTouchesBuffer).toBe(true);
    expect(verdict.status).toBe('review');
    expect(verdict.minClearanceM).toBeGreaterThan(0); // 几何未穿越，但误差带触及
    expect(verdict.minClearanceM).toBeLessThan(
      corr.correction.zoneRanges.find((z) => z.zoneId === 'Z-A')!.band95,
    );
  });

  it('影响报告对校正包给出阻断原因与下游闭包', async () => {
    const baseline = await buildFor(baselinePackage(), 1);
    const corr = await buildFor(correctionPackage(), 2);
    const covered = originallyCoveredSegmentIds(corr.permit!, baseline.segments);
    const fps = { correction: corr.correction.ruleFingerprint, topology: fnv1a(`${TOPOLOGY_RULE_VERSION}:v2`) };
    const { report } = evaluateImpact({
      packageId: 'PKG-2026-02',
      oldSegments: baseline.segments,
      newSegments: corr.segments,
      relations: corr.lineage,
      network: corr.topo.network,
      crossTile: corr.topo.crossTile,
      correction: corr.correction,
      permit: corr.permit,
      originallyCoveredIds: covered,
      modelRun: corr.model,
      prevModelRun: baseline.model,
      ruleFingerprints: fps,
      activeFingerprints: fps,
    });
    expect(report.blockingReasons.join(' ')).toContain('PRM-2026-001');
    expect(report.changedSegmentIds).toContain('S3');
    expect(report.stale).toBe(false);
  });

  it('拆分包切片闭包必须跨瓦片扩展并触发模型输入变更', async () => {
    const corr = await buildFor(correctionPackage(), 2);
    const split = await buildFor(splitPackage(), 3);
    const { closure, tiles, crossTileHits } = downstreamClosure(
      ['S4A', 'S4B'],
      split.topo.network,
      split.topo.crossTile,
    );
    expect(tiles.sort()).toEqual(['TILE_A', 'TILE_B']);
    expect(closure).toContain('S5');
    expect(closure).toContain('S6');
    expect(crossTileHits.some((c) => c.viaValveId === 'V3')).toBe(true);
    expect(featureFingerprint(split.topo.network)).not.toBe(featureFingerprint(corr.topo.network));
    const movements = measureLineageMovements(split.lineage, corr.segments, split.segments);
    expect(movements.find((m) => m.kind === 'split')!.blocked).toBe(false);
  });
});

describe('重算比较：切片 vs 全链', () => {
  let split: Awaited<ReturnType<typeof buildFor>>;
  let refs: Map<string, string>;

  const makeCtx = (changedSegmentIds: string[], report: never) => ({
    packageId: 'PKG-2026-03',
    changedSegmentIds,
    allSegmentIds: allSegmentIdsOf(split.segments),
    network: split.topo.network,
    crossTile: split.topo.crossTile,
    report,
    previousReleaseRefs: refs,
    modelRun: split.model,
  });
  const dummyReport = {
    reportId: 'IMP-X', basedOnPackage: 'PKG-2026-03', networkVersion: 3, correctionId: 'C',
    items: [], permitVerdicts: [{ permitNo: 'PRM-2026-001', stillCovers: true, minClearanceM: 0.05, bandTouchesBuffer: true, status: 'review', reasons: ['r'] }],
    changedSegmentIds: [], closureSegmentIds: [], crossTileDependencies: [], blockingReasons: ['b'],
    computedAt: new Date().toISOString(), stale: false,
  } as never;

  beforeAll(async () => {
    split = await buildFor(splitPackage(), 3);
    refs = new Map(split.segments.map((s) => [s.id, 'REL-PKG-2026-02']));
  });

  it('窄种子 S3：切片仅重算局部闭包并保留未变区域原发布引用，与全链拓扑签名一致', () => {
    const slice = executeRecompute(makeCtx(['S3'], dummyReport), 'slice', Date.now());
    const full = executeRecompute(makeCtx(['S3'], dummyReport), 'full', Date.now());
    expect(slice.parity.sameNetworkSignature).toBe(true);
    expect(slice.job.scopeSegmentIds).toEqual(['S3']);
    expect(slice.job.scopeTiles).toEqual(['TILE_A']);
    expect(slice.job.preservedReferences).toHaveLength(6);
    expect(full.job.scopeSegmentIds).toHaveLength(7);
    expect(full.job.preservedReferences).toHaveLength(0);
  });

  it('跨瓦片种子 S4A/S4B：闭包经 V3 扩展到两瓦片 6 管段，不漏跨区依赖且保留 S3 原引用', () => {
    const slice = executeRecompute(makeCtx(['S4A', 'S4B'], dummyReport), 'slice', Date.now());
    expect(slice.job.escalatedToFull).toBe(false);
    expect(slice.job.scopeSegmentIds).toHaveLength(6);
    expect(slice.job.scopeTiles.sort()).toEqual(['TILE_A', 'TILE_B']);
    expect(slice.job.preservedReferences).toEqual(['S3@REL-PKG-2026-02']);
    expect(slice.parity.samePermitStatus).toBe(true);
  });

  it('组合种子（许可种子 S3 + 拆分种子 S4A/S4B，即拆分包真实情形）：闭包覆盖整包，切片扩大至整包', () => {
    const slice = executeRecompute(makeCtx(['S3', 'S4A', 'S4B'], dummyReport), 'slice', Date.now());
    expect(slice.job.escalatedToFull).toBe(true);
    expect(slice.job.scopeSegmentIds).toHaveLength(7);
    expect(slice.job.scopeTiles.sort()).toEqual(['TILE_A', 'TILE_B']);
    expect(slice.job.boundaryProof).toContain('扩大至整包');
    expect(slice.job.preservedReferences).toHaveLength(0);
  });
});

describe('发布快照回放与离线同步', () => {
  it('回放指纹稳定，并保留未知续接/许可越界阻断原因', async () => {
    const split = await buildFor(splitPackage(), 3);
    const refs = new Map(split.segments.map((s) => [s.id, 'REL-PKG-2026-02']));
    const recompute = executeRecompute(
      {
        packageId: 'PKG-2026-03',
        changedSegmentIds: ['S4A', 'S4B'],
        allSegmentIds: allSegmentIdsOf(split.segments),
        network: split.topo.network,
        crossTile: split.topo.crossTile,
        report: {
          reportId: 'IMP-X', basedOnPackage: 'PKG-2026-03', networkVersion: 3, correctionId: 'C',
          items: [], permitVerdicts: [], changedSegmentIds: ['S4A'], closureSegmentIds: [],
          crossTileDependencies: [], blockingReasons: ['许可越界'], computedAt: new Date().toISOString(), stale: false,
        } as never,
        previousReleaseRefs: refs,
        modelRun: split.model,
      },
      'slice',
      Date.now(),
    );
    const snap = await buildReleaseSnapshot(
      {
        packageMeta: (await importPackage(splitPackage(), textOf(splitPackage()))).meta,
        correction: split.correction,
        lineage: split.lineage,
        network: split.topo.network,
        permits: [split.permit!],
        modelRun: split.model,
        recompute: recompute.job,
      },
      ['许可越界'],
      'draft',
    );
    const replay = await replaySnapshot(snap);
    expect(replay.ok).toBe(true);
    expect(replay.replayHash).toBe(snap.replayHash);
    expect(snap.blockers).toContain('许可越界');
  });

  it('离线规则更新使旧影响报告失效', () => {
    const report = {
      reportId: 'IMP-1', basedOnPackage: 'P', networkVersion: 1, correctionId: 'C', items: [],
      permitVerdicts: [], changedSegmentIds: [], closureSegmentIds: [], crossTileDependencies: [],
      blockingReasons: [], computedAt: new Date().toISOString(), stale: false,
    } as never;
    const stale = markStaleReports([report], { correction: 'a', topology: 'b' }, { correction: 'a2', topology: 'b' });
    expect(stale[0].stale).toBe(true);
    expect(stale[0].blockingReasons.join(' ')).toContain('失效');
  });

  it('同步只合并非冲突草案，拒绝覆盖服务器较新发布', () => {
    const drafts: ReviewDraft[] = [
      { draftId: 'D1', releaseId: 'REL-1', reviewer: 'r', comment: 'c', status: 'approved', updatedAt: '', baseReleaseVersion: 3 },
      { draftId: 'D2', releaseId: 'REL-2', reviewer: 'r', comment: 'c', status: 'draft', updatedAt: '', baseReleaseVersion: 1 },
    ];
    const out = syncDrafts(drafts, 3, 3, ['REL-2'], null);
    expect(out.state.mergedDrafts).toEqual(['D1']);
    expect(out.state.conflicts).toEqual(['D2']);
    expect(out.rejectedOverwrites.join(' ')).toContain('REL-2');
  });
});
