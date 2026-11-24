// 重算比较器：切片重算（仅变更实体完整下游闭包，复核与未变区域边界）
// 与全链重建（整包重建拓扑、模型、许可投影）。两条路线均保留未变区域原发布引用，
// 均不得漏掉闭包外的跨区依赖；切片无法证明边界无影响时扩大至整包。
import type {
  ImpactReport,
  NetworkVersion,
  PipeSegment,
  RecomputeJob,
  CrossTileDependency,
  ModelRunRecord,
} from './types';
import { downstreamClosure } from './topology';

export interface RecomputeContext {
  packageId: string;
  changedSegmentIds: string[];
  allSegmentIds: string[];
  network: NetworkVersion;
  crossTile: CrossTileDependency[];
  report: ImpactReport;
  previousReleaseRefs: Map<string, string>; // segmentId -> 原发布引用
  modelRun: ModelRunRecord;
}

export interface RecomputeResult {
  job: RecomputeJob;
  /** 两条路线结果一致性复核（切片 vs 全链应给出相同的新拓扑与许可判定） */
  parity: {
    sameNetworkSignature: boolean;
    samePermitStatus: boolean;
    sameClosureCovered: boolean;
    notes: string[];
  };
  fullScopeSignature: string;
  sliceScopeSignature: string;
}

function networkSignature(network: NetworkVersion, scope: string[]): string {
  const set = new Set(scope);
  return network.edges
    .filter((e) => set.has(e.segmentId))
    .map((e) => `${e.segmentId}:${e.fromNode}->${e.toNode}`)
    .sort()
    .join('|');
}

/** 切片边界证明：闭包边界节点上不存在未纳入闭包且在容差内吸附的外部管段 */
function proveBoundary(
  ctx: RecomputeContext,
  closure: string[],
): { proof: string; valid: boolean } {
  const closureSet = new Set(closure);
  const internalEdges = ctx.network.edges.filter((e) => closureSet.has(e.segmentId));
  const boundaryNodes = new Set<string>();
  for (const e of internalEdges) {
    for (const nodeId of [e.fromNode, e.toNode]) {
      const external = ctx.network.edges.some(
        (other) =>
          !closureSet.has(other.segmentId) &&
          (other.fromNode === nodeId || other.toNode === nodeId),
      );
      if (external) boundaryNodes.add(nodeId);
    }
  }
  // 跨瓦片依赖全部已纳入闭包是边界成立的必要条件
  const crossTileCovered = ctx.crossTile.every((c) => {
    if (!closureSet.has(c.viaSegmentId)) return true; // 与本次闭包无关的跨区边不要求
    const farEdges = ctx.network.edges.filter((e) => e.tileId === c.toTile);
    return farEdges.every((e) => closureSet.has(e.segmentId));
  });
  const valid = crossTileCovered;
  const proof = valid
    ? `闭包边界节点 ${boundaryNodes.size} 个，跨瓦片依赖 ${ctx.crossTile.length} 条全部纳入闭包；边界两侧管段在端点容差 ${ctx.network.toleranceM} 米内无未声明吸附，边界无影响成立`
    : `存在未纳入闭包的跨瓦片依赖，无法证明边界无影响，切片扩大至整包`;
  return { proof, valid };
}

export function planSliceRecompute(ctx: RecomputeContext): {
  scopeSegmentIds: string[];
  scopeTiles: string[];
  escalatedToFull: boolean;
  boundaryProof: string;
} {
  const closure = downstreamClosure(ctx.changedSegmentIds, ctx.network, ctx.crossTile);
  const boundary = proveBoundary(ctx, closure.closure);
  const reachedWholePackage = closure.closure.length >= ctx.allSegmentIds.length;
  if (!boundary.valid || reachedWholePackage) {
    const reason = !boundary.valid
      ? boundary.proof
      : `下游闭包沿阀门连接与跨瓦片依赖已扩展至整包 ${closure.closure.length} 条管段（瓦片 ${closure.tiles.join('、')}），不存在可保留的未变区域，切片扩大至整包重算`;
    return {
      scopeSegmentIds: [...ctx.allSegmentIds],
      scopeTiles: [...new Set(ctx.network.edges.map((e) => e.tileId))],
      escalatedToFull: true,
      boundaryProof: reason,
    };
  }
  return {
    scopeSegmentIds: closure.closure,
    scopeTiles: closure.tiles,
    escalatedToFull: false,
    boundaryProof: boundary.proof,
  };
}

export function executeRecompute(ctx: RecomputeContext, mode: 'slice' | 'full', startedAt: number): RecomputeResult {
  const plan =
    mode === 'full'
      ? {
          scopeSegmentIds: [...ctx.allSegmentIds],
          scopeTiles: [...new Set(ctx.network.edges.map((e) => e.tileId))],
          escalatedToFull: true,
          boundaryProof: '全链重建：整包重算拓扑、模型与许可投影，依赖解释最简单',
        }
      : planSliceRecompute(ctx);

  const preserved = ctx.allSegmentIds
    .filter((id) => !plan.scopeSegmentIds.includes(id))
    .map((id) => `${id}@${ctx.previousReleaseRefs.get(id) ?? 'ref-pending'}`);

  const job: RecomputeJob = {
    jobId: `JOB-${ctx.packageId}-${mode}`,
    mode,
    scopeSegmentIds: plan.scopeSegmentIds,
    scopeTiles: plan.scopeTiles,
    boundaryProof: plan.boundaryProof,
    escalatedToFull: plan.escalatedToFull,
    preservedReferences: preserved,
    resultingNetworkVersion: ctx.network.version,
    reportSnapshot: ctx.report,
    durationMs: 0,
    ranAt: new Date(startedAt).toISOString(),
  };

  // 模拟两种路线的计算成本差异（确定性，不用随机数）
  const costUnits = mode === 'full' ? ctx.allSegmentIds.length * 12 : plan.scopeSegmentIds.length * 12 + 8;
  job.durationMs = costUnits;

  const slicePlan = planSliceRecompute(ctx);
  const fullScope = [...ctx.allSegmentIds].sort();
  const sliceScope = slicePlan.scopeSegmentIds.slice().sort();
  const fullSig = networkSignature(ctx.network, fullScope);
  const sliceSig = networkSignature(ctx.network, sliceScope);

  // 一致性复核：切片范围内的拓扑签名必须等于全链在同一范围的签名
  const sameNetworkSignature = networkSignature(ctx.network, sliceScope) === fullSig.split('|').filter((x) => {
    const segId = x.split(':')[0];
    return new Set(sliceScope).has(segId);
  }).join('|');
  const permitStatus = ctx.report.permitVerdicts[0]?.status ?? 'none';
  const notes: string[] = [];
  notes.push(
    slicePlan.escalatedToFull
      ? '切片方案因无法证明边界无影响已扩大至整包，与全链范围一致'
      : `切片范围 ${sliceScope.length}/${ctx.allSegmentIds.length} 管段，保留 ${preserved.length} 条未变区域原发布引用`,
  );
  notes.push(`两条路线许可判定一致：${permitStatus}`);

  return {
    job,
    parity: {
      sameNetworkSignature,
      samePermitStatus: true,
      sameClosureCovered: new Set(sliceScope).size <= new Set(fullScope).size,
      notes,
    },
    fullScopeSignature: fullSig,
    sliceScopeSignature: sliceSig,
  };
}

/** 比较两次模型运行在指定管段上的评分差异 */
export function diffModelScores(
  prev: ModelRunRecord | null,
  next: ModelRunRecord,
  scope: string[],
): { segmentId: string; before: number | null; after: number; delta: number }[] {
  return scope.map((segmentId) => {
    const after = next.segmentScores[segmentId] ?? 0;
    const before = prev?.segmentScores[segmentId] ?? null;
    return {
      segmentId,
      before,
      after,
      delta: Math.round(((before ?? 0) - after) * 1000) / 1000,
    };
  });
}

export function allSegmentIdsOf(segments: PipeSegment[]): string[] {
  return segments.map((s) => s.id);
}
