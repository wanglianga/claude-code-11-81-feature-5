import { describe, expect, it } from 'vitest';
import {
  anomalyPackage,
  baselinePackage,
  correctionPackage,
  splitPackage,
  TOPOLOGY_RULE_VERSION,
  type RawSourcePackage,
} from './sampleData';
import { runPipeline, type PipelineResult } from './pipeline';
import { replaySnapshot } from './snapshot';
import type { PipeSegment } from './types';
import { fnv1a } from './hash';

async function run(pkg: RawSourcePackage, version: number, prev: PipelineResult | null, mode: 'slice' | 'full' = 'slice') {
  const refs = prev ? new Map(prev.segments.map((s: PipeSegment) => [s.id, 'REL-prev'])) : new Map<string, string>();
  return runPipeline({
    raw: pkg,
    rawText: JSON.stringify(pkg),
    networkVersion: version,
    prevSegments: prev?.segments ?? [],
    prevNetwork: prev?.network ?? null,
    prevModelRun: prev?.modelRun ?? null,
    prevReleaseRefs: refs,
    recomputeMode: mode,
    activeTopologyRule: TOPOLOGY_RULE_VERSION,
    storedRuleFingerprints: null,
    reviewStatus: 'draft',
  });
}

describe('端到端流水线（Worker 内同一套领域代码）', () => {
  it('基准包：建账成功、无阻断、产出可回放快照', async () => {
    const r = await run(baselinePackage(), 1, null);
    expect(r.blocked).toBe(false);
    expect(r.snapshot).not.toBeNull();
    expect(r.snapshot!.blockers).toEqual([]);
    expect(r.network?.edges).toHaveLength(6);
    const replay = await replaySnapshot(r.snapshot!);
    expect(replay.ok).toBe(true);
    expect(replay.replayHash).toBe(r.snapshot!.replayHash);
  });

  it('校正包：S3 误差带触及缓冲，许可复核并阻断局部发布', async () => {
    const base = await run(baselinePackage(), 1, null);
    const corr = await run(correctionPackage(), 2, base);
    expect(corr.impact?.changedSegmentIds).toContain('S3');
    expect(corr.impact?.permitVerdicts[0].status).toBe('review');
    expect(corr.impact?.blockingReasons.join(' ')).toContain('PRM-2026-001');
    expect(corr.snapshot?.blockers.length).toBeGreaterThan(0);
  });

  it('拆分包：切片闭包跨两瓦片并经 V3；全链给出相同许可判定与拓扑', async () => {
    const base = await run(baselinePackage(), 1, null);
    const corr = await run(correctionPackage(), 2, base);
    const slice = await run(splitPackage(), 3, corr, 'slice');
    const full = await run(splitPackage(), 3, corr, 'full');
    expect(slice.impact?.crossTileDependencies.some((c) => c.viaValveId === 'V3')).toBe(true);
    expect(slice.impact?.closureSegmentIds).toContain('S5');
    expect(slice.impact?.closureSegmentIds).toContain('S6');
    expect(slice.recompute?.scopeTiles.sort()).toEqual(['TILE_A', 'TILE_B']);
    // S4 分支经 V1/V2/V3 连通整个网络，加上 S3 许可种子，闭包合法扩展为整包（对应“无法证明边界无影响则扩大整包”）
    expect(slice.recompute?.scopeSegmentIds).toHaveLength(7);
    expect(full.recompute?.scopeSegmentIds).toHaveLength(7);
    expect(full.recompute?.preservedReferences).toHaveLength(0);
    expect(slice.impact?.permitVerdicts[0].status).toBe(full.impact?.permitVerdicts[0].status);
    const sig = (r: PipelineResult) => r.network!.edges.map((e) => `${e.segmentId}:${e.fromNode}->${e.toNode}`).sort().join('|');
    expect(sig(slice)).toBe(sig(full));
    // 连通特征改变 -> 模型输入变化
    expect(slice.modelRun?.featureFingerprint).not.toBe(corr.modelRun?.featureFingerprint);
  });

  it('异常包：三类语义问题阻断，不产出校正/拓扑/快照（哈希正确不放行）', async () => {
    const bad = await run(anomalyPackage(), 9, null);
    expect(bad.blocked).toBe(true);
    expect(bad.issues.map((i) => i.code).sort()).toEqual(['EPOCH_MISSING', 'UNIT_MISLABELED', 'UNRESOLVED_LINEAGE']);
    expect(bad.meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(bad.network).toBeNull();
    expect(bad.snapshot).toBeNull();
  });

  it('离线规则更新后重新计算：旧指纹与活动指纹不一致时报告失效', async () => {
    const base = await run(baselinePackage(), 1, null);
    const staleFp = { correction: 'old-cp', topology: fnv1a('old-rule:v1') };
    const r = await runPipeline({
      raw: correctionPackage(),
      rawText: JSON.stringify(correctionPackage()),
      networkVersion: 2,
      prevSegments: base.segments,
      prevNetwork: base.network,
      prevModelRun: base.modelRun,
      prevReleaseRefs: new Map(),
      recomputeMode: 'slice',
      activeTopologyRule: TOPOLOGY_RULE_VERSION,
      storedRuleFingerprints: staleFp,
      reviewStatus: 'draft',
    });
    expect(r.impact?.stale).toBe(true);
    expect(r.impact?.blockingReasons.join(' ')).toContain('失效');
  });
});
