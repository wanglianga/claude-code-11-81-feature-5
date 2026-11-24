// 影响求值器：沿依赖边分别计算四类影响，并汇总阻断原因。
// 1) 几何误差是否穿越施工缓冲；2) 实体拆并是否改变风险模型输入；
// 3) 许可是否仍覆盖原获批对象；4) 公开图层哪些字段/几何需重建。
import type {
  ControlCorrection,
  CrossTileDependency,
  ImpactItem,
  ImpactReport,
  LineageRelation,
  ModelRunRecord,
  NetworkVersion,
  Permit,
  PermitVerdict,
  PipeSegment,
} from './types';
import { closedRing, evaluatePermit } from './permit';
import { downstreamClosure } from './topology';
import { geometryDistance, round3 } from './geometry';

export interface ImpactInput {
  packageId: string;
  oldSegments: PipeSegment[];
  newSegments: PipeSegment[];
  relations: LineageRelation[];
  network: NetworkVersion;
  crossTile: CrossTileDependency[];
  correction: ControlCorrection;
  permit: Permit | null;
  originallyCoveredIds: string[];
  modelRun: ModelRunRecord;
  prevModelRun: ModelRunRecord | null;
  ruleFingerprints: { correction: string; topology: string };
  activeFingerprints: { correction: string; topology: string };
}

export interface ImpactOutput {
  report: ImpactReport;
  permitVerdict: PermitVerdict | null;
}

export function evaluateImpact(input: ImpactInput): ImpactOutput {
  const items: ImpactItem[] = [];
  const blockingReasons: string[] = [];
  const oldById = new Map(input.oldSegments.map((s) => [s.id, s]));
  const newById = new Map(input.newSegments.map((s) => [s.id, s]));
  const changedSegmentIds = new Set<string>();

  // ---- 维度 1：几何误差 vs 施工缓冲 ----
  const permit = input.permit;
  if (permit) {
    // 仅评估获批对象与许可邻近管段（缓冲外沿 + 误差带 + 1 米邻域），避免无关管段误报
    const maxBand = Math.max(0, ...input.correction.zoneRanges.map((z) => z.band95));
    const ring = closedRing(permit.boundary);
    const proximityLimit = permit.bufferM + maxBand + 1;
    const candidateIds = input.newSegments
      .filter(
        (s) =>
          input.originallyCoveredIds.includes(s.id) ||
          geometryDistance(s.geometry, ring) <= proximityLimit,
      )
      .map((s) => s.id);
    const verdict = evaluatePermit(
      permit,
      input.newSegments,
      candidateIds,
      input.correction.zoneRanges,
      input.originallyCoveredIds,
    );
    for (const id of candidateIds) {
      const seg = newById.get(id)!;
      const zone = input.correction.zoneRanges.find((z) => z.zoneId === seg.zoneId);
      const band = zone?.band95 ?? 0;
      const d = geometryDistance(seg.geometry, ring);
      const edgeMargin = round3(permit.bufferM - d); // 到缓冲外沿剩余净距（负=穿越）
      const crosses = edgeMargin < 0;
      const bandTouches = edgeMargin <= band;
      if (crosses || bandTouches) {
        changedSegmentIds.add(id);
        items.push({
          dimension: 'geometry_buffer',
          targetId: id,
          changed: true,
          detail: `缓冲外沿剩余净距 ${edgeMargin} 米，95% 误差带 ${band} 米；${crosses ? '几何穿越施工缓冲' : '误差带触及缓冲外沿'}`,
          blocking: bandTouches, // 误差带触及即阻断该局部发布，强制许可复核
        });
        if (bandTouches) {
          blockingReasons.push(`管段 ${id} 的 95% 误差带触及许可 ${permit.permitNo} 的施工缓冲外沿，许可须复核`);
        }
      }
    }

    // ---- 维度 3：许可覆盖 ----
    items.push({
      dimension: 'permit_coverage',
      targetId: permit.permitNo,
      changed: verdict.status !== 'valid',
      detail:
        verdict.status === 'valid'
          ? '许可仍覆盖原获批对象'
          : `许可判定 ${verdict.status}：${verdict.reasons.join('；')}`,
      blocking: verdict.status !== 'valid',
    });
    if (verdict.status !== 'valid') {
      blockingReasons.push(...verdict.reasons);
    }

    // ---- 维度 2：实体拆并 -> 模型输入 ----
    for (const r of input.relations) {
      if (r.kind === 'split' || r.kind === 'merge') {
        for (const id of r.newSegmentIds) changedSegmentIds.add(id);
        items.push({
          dimension: 'entity_lineage',
          targetId: r.id,
          changed: true,
          detail: `${r.kind === 'split' ? '拆分' : '合并'}关系 ${r.oldSegmentIds.join('、')} -> ${r.newSegmentIds.join('、')}，管网连通特征改变，风险模型输入须重算`,
          blocking: false,
        });
      } else if (r.kind === 'unresolved' || r.confidence < 0.5) {
        items.push({
          dimension: 'entity_lineage',
          targetId: r.id,
          changed: true,
          detail: `未能唯一续接：${r.evidence}`,
          blocking: true,
        });
        blockingReasons.push(`谱系关系 ${r.id} 无法唯一续接，禁止发布`);
      } else {
        // 一对一但发生几何移动的管段
        const oldSeg = oldById.get(r.oldSegmentIds[0]);
        const newSeg = newById.get(r.newSegmentIds[0]);
        if (oldSeg && newSeg) {
          const shift = geometryDistance(oldSeg.geometry, newSeg.geometry);
          if (shift > 0.01) changedSegmentIds.add(newSeg.id);
        }
      }
    }

    // ---- 维度 4：公开图层重建项 ----
    const closure0 = downstreamClosure([...changedSegmentIds], input.network, input.crossTile);
    for (const id of closure0.closure) {
      items.push({
        dimension: 'layer_rebuild',
        targetId: id,
        changed: true,
        detail: `下游闭包管段：几何瓦片与连通属性字段需重建（瓦片 ${input.network.edges.find((e) => e.segmentId === id)?.tileId ?? '?'}）`,
        blocking: false,
      });
    }

    // ---- 闭包与跨瓦片依赖 ----
    const closure = downstreamClosure([...changedSegmentIds], input.network, input.crossTile);

    // ---- 离线失效判断：控制点或拓扑规则更新后旧影响计算失效 ----
    const stale =
      input.ruleFingerprints.correction !== input.activeFingerprints.correction ||
      input.ruleFingerprints.topology !== input.activeFingerprints.topology;
    const staleReason = stale
      ? `规则指纹变化（控制点 ${input.ruleFingerprints.correction}->${input.activeFingerprints.correction}，拓扑 ${input.ruleFingerprints.topology}->${input.activeFingerprints.topology}），离线期间规则已更新，旧影响计算失效须重算`
      : undefined;
    if (stale) blockingReasons.push(staleReason!);

    const report: ImpactReport = {
      reportId: `IMP-${input.packageId}`,
      basedOnPackage: input.packageId,
      networkVersion: input.network.version,
      correctionId: input.correction.correctionId,
      items,
      permitVerdicts: [verdict],
      changedSegmentIds: [...changedSegmentIds].sort(),
      closureSegmentIds: closure.closure,
      crossTileDependencies: closure.crossTileHits,
      blockingReasons: [...new Set(blockingReasons)],
      computedAt: new Date().toISOString(),
      stale,
      staleReason,
    };
    return { report, permitVerdict: verdict };
  }

  // 无许可的异常包：仅做谱系阻断与失效判断
  for (const r of input.relations) {
    if (r.kind === 'unresolved' || r.confidence < 0.5) {
      items.push({
        dimension: 'entity_lineage',
        targetId: r.id,
        changed: true,
        detail: `未能唯一续接：${r.evidence}`,
        blocking: true,
      });
      blockingReasons.push(`谱系关系 ${r.id} 无法唯一续接，禁止发布`);
    }
  }
  const stale =
    input.ruleFingerprints.correction !== input.activeFingerprints.correction ||
    input.ruleFingerprints.topology !== input.activeFingerprints.topology;
  const report: ImpactReport = {
    reportId: `IMP-${input.packageId}`,
    basedOnPackage: input.packageId,
    networkVersion: input.network.version,
    correctionId: input.correction.correctionId,
    items,
    permitVerdicts: [],
    changedSegmentIds: [...changedSegmentIds].sort(),
    closureSegmentIds: [],
    crossTileDependencies: [],
    blockingReasons: [...new Set(blockingReasons)],
    computedAt: new Date().toISOString(),
    stale,
    staleReason: stale ? '控制点或拓扑规则已更新，旧影响计算失效' : undefined,
  };
  return { report, permitVerdict: null };
}
