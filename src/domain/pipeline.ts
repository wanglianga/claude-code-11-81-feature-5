// 端到端流水线：导入 -> 校正 -> 谱系 -> 拓扑 -> 模型 -> 影响 -> 重算 -> 快照。
// 纯函数式编排，可在 WebWorker 中完整运行，不触碰 DOM。
import type {
  ControlCorrection,
  ImpactReport,
  LineageRelation,
  ModelRunRecord,
  NetworkVersion,
  PackageMeta,
  Permit,
  PipeSegment,
  RecomputeJob,
  ReleaseSnapshot,
  ReviewStatus,
  SemanticIssue,
  Valve,
  CrossTileDependency,
} from './types';
import type { RawSourcePackage } from './sampleData';
import { TOPOLOGY_TOLERANCE_M } from './sampleData';
import { importPackage } from './importer';
import { applyCorrection, buildCorrection, type ZoneShift } from './correction';
import { buildLineage } from './lineage';
import { buildNetwork } from './topology';
import { buildPermit, originallyCoveredSegmentIds } from './permit';
import { runRiskModel } from './model';
import { evaluateImpact } from './impact';
import { allSegmentIdsOf, executeRecompute } from './recompute';
import { buildReleaseSnapshot } from './snapshot';
import { fnv1a } from './hash';

export interface PipelineResult {
  meta: PackageMeta;
  issues: SemanticIssue[];
  blocked: boolean;
  correction: ControlCorrection | null;
  zoneShifts: ZoneShift[];
  segments: PipeSegment[];
  valves: Valve[];
  lineage: LineageRelation[];
  network: NetworkVersion | null;
  crossTile: CrossTileDependency[];
  permit: Permit | null;
  originallyCoveredIds: string[];
  modelRun: ModelRunRecord | null;
  impact: ImpactReport | null;
  recompute: RecomputeJob | null;
  snapshot: ReleaseSnapshot | null;
  prevModelRun: ModelRunRecord | null;
}

export interface PipelineOptions {
  raw: RawSourcePackage;
  rawText: string;
  networkVersion: number;
  prevSegments: PipeSegment[];
  prevNetwork: NetworkVersion | null;
  prevModelRun: ModelRunRecord | null;
  prevReleaseRefs: Map<string, string>;
  recomputeMode: 'slice' | 'full';
  activeTopologyRule: string;
  /** 上次影响计算所依据的规则指纹；为 null 表示首次计算（不判失效） */
  storedRuleFingerprints: { correction: string; topology: string } | null;
  reviewStatus: ReviewStatus;
}

export async function runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const started = Date.now();
  const imported = await importPackage(opts.raw, opts.rawText);
  const result: PipelineResult = {
    meta: imported.meta,
    issues: imported.issues,
    blocked: imported.blocked,
    correction: null,
    zoneShifts: [],
    segments: [],
    valves: [],
    lineage: [],
    network: null,
    crossTile: [],
    permit: null,
    originallyCoveredIds: [],
    modelRun: null,
    impact: null,
    recompute: null,
    snapshot: null,
    prevModelRun: opts.prevModelRun,
  };

  // 语义阻断（历元缺失/单位误标/续接歧义）：仍记录导入账，但不产出可发布产物
  if (imported.blocked) {
    return result;
  }

  const { correction, zoneShifts } = buildCorrection(opts.raw, 'transform-v1');
  result.correction = correction;
  result.zoneShifts = zoneShifts;

  const { segments, valves } = applyCorrection(opts.raw, zoneShifts);
  result.segments = segments;
  result.valves = valves;

  const lineage = buildLineage(opts.raw);
  result.lineage = lineage;

  const topo = buildNetwork(
    segments,
    valves,
    opts.raw.meta.packageId,
    correction.correctionId,
    opts.networkVersion,
    TOPOLOGY_TOLERANCE_M,
  );
  result.network = topo.network;
  result.crossTile = topo.crossTile;

  const permit = buildPermit(opts.raw);
  result.permit = permit;
  result.originallyCoveredIds = permit
    ? originallyCoveredSegmentIds(permit, opts.prevSegments.length ? opts.prevSegments : segments)
    : [];

  const modelSpec = opts.raw.model;
  const modelRun = modelSpec
    ? runRiskModel(
        modelSpec.modelCode,
        modelSpec.threshold,
        modelSpec.inputWaterLevelM,
        topo.network,
        segments,
        opts.networkVersion,
      )
    : null;
  result.modelRun = modelRun;

  if (modelRun && permit) {
    const activeFingerprints = {
      correction: correction.ruleFingerprint,
      topology: fnv1a(`${opts.activeTopologyRule}:v${opts.networkVersion}`),
    };
    const storedFingerprints =
      opts.storedRuleFingerprints ?? {
        correction: correction.ruleFingerprint,
        topology: activeFingerprints.topology,
      };
    const { report } = evaluateImpact({
      packageId: opts.raw.meta.packageId,
      oldSegments: opts.prevSegments.length ? opts.prevSegments : segments,
      newSegments: segments,
      relations: lineage,
      network: topo.network,
      crossTile: topo.crossTile,
      correction,
      permit,
      originallyCoveredIds: result.originallyCoveredIds,
      modelRun,
      prevModelRun: opts.prevModelRun,
      ruleFingerprints: storedFingerprints,
      activeFingerprints,
    });
    result.impact = report;

    const recomputeResult = executeRecompute(
      {
        packageId: opts.raw.meta.packageId,
        changedSegmentIds: report.changedSegmentIds,
        allSegmentIds: allSegmentIdsOf(segments),
        network: topo.network,
        crossTile: topo.crossTile,
        report,
        previousReleaseRefs: opts.prevReleaseRefs,
        modelRun,
      },
      opts.recomputeMode,
      started,
    );
    result.recompute = recomputeResult.job;

    result.snapshot = await buildReleaseSnapshot(
      {
        packageMeta: imported.meta,
        correction,
        lineage,
        network: topo.network,
        permits: [permit],
        modelRun,
        recompute: recomputeResult.job,
      },
      report.blockingReasons,
      opts.reviewStatus,
    );
  }

  return result;
}
