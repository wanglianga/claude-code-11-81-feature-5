// 发布快照与回放：固定输入包、转换、实体关系、许可与模型版本；对未知续接或许可越界给出阻断原因。
import type {
  ControlCorrection,
  LineageRelation,
  ModelRunRecord,
  NetworkVersion,
  PackageMeta,
  Permit,
  RecomputeJob,
  ReleaseSnapshot,
  ReviewStatus,
} from './types';
import { stableHash } from './hash';

export interface SnapshotParts {
  packageMeta: PackageMeta;
  correction: ControlCorrection;
  lineage: LineageRelation[];
  network: NetworkVersion;
  permits: Permit[];
  modelRun: ModelRunRecord;
  recompute: RecomputeJob;
}

export async function buildReleaseSnapshot(
  parts: SnapshotParts,
  blockingReasons: string[],
  status: ReviewStatus,
): Promise<ReleaseSnapshot> {
  const impact = parts.recompute.reportSnapshot;
  const replayHash = await stableHash({
    packageSha: parts.packageMeta.sha256,
    correctionFingerprint: parts.correction.ruleFingerprint,
    lineage: parts.lineage.map((r) => ({
      old: r.oldSegmentIds,
      next: r.newSegmentIds,
      kind: r.kind,
      confidence: r.confidence,
    })),
    network: {
      version: parts.network.version,
      edges: parts.network.edges.map((e) => `${e.segmentId}:${e.fromNode}->${e.toNode}`),
    },
    permits: parts.permits.map((p) => ({
      no: p.permitNo,
      boundary: p.boundary,
      buffer: p.bufferM,
      period: p.projectPeriod,
      based: p.basedOnSegmentVersion,
    })),
    model: {
      code: parts.modelRun.modelCode,
      fp: parts.modelRun.featureFingerprint,
      topo: parts.modelRun.topologyVersion,
      threshold: parts.modelRun.threshold,
      level: parts.modelRun.inputWaterLevelM,
    },
  });
  return {
    releaseId: `REL-${parts.packageMeta.packageId}`,
    ...parts,
    impact,
    status,
    blockers: blockingReasons,
    publishedAt: new Date().toISOString(),
    replayHash,
  };
}

export interface ReplayResult {
  ok: boolean;
  replayHash: string;
  mismatch: string[];
}

/** 回放：用快照内固定的输入重新计算回放指纹并逐项比对 */
export async function replaySnapshot(snapshot: ReleaseSnapshot): Promise<ReplayResult> {
  const rebuilt = await buildReleaseSnapshot(
    {
      packageMeta: snapshot.packageMeta,
      correction: snapshot.correction,
      lineage: snapshot.lineage,
      network: snapshot.network,
      permits: snapshot.permits,
      modelRun: snapshot.modelRun,
      recompute: snapshot.recompute,
    },
    snapshot.blockers,
    snapshot.status,
  );
  const mismatch: string[] = [];
  if (rebuilt.replayHash !== snapshot.replayHash) {
    mismatch.push('全链路回放指纹不一致，输入包/转换/谱系/许可/模型版本存在漂移');
  }
  const replayBlockers: string[] = [];
  for (const r of snapshot.lineage) {
    if (r.kind === 'unresolved' || r.confidence < 0.5) {
      replayBlockers.push(`阻断：谱系 ${r.id} 无法唯一续接（${r.evidence}）`);
    }
  }
  for (const v of snapshot.impact.permitVerdicts) {
    if (v.status !== 'valid') {
      replayBlockers.push(`阻断：许可 ${v.permitNo} 状态 ${v.status} —— ${v.reasons.join('；')}`);
    }
  }
  if (snapshot.impact.stale) {
    replayBlockers.push(`阻断：${snapshot.impact.staleReason}`);
  }
  return {
    ok: mismatch.length === 0,
    replayHash: rebuilt.replayHash,
    mismatch: [...mismatch, ...replayBlockers],
  };
}
