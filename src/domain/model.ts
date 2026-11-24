// 模型运行账：固定特征、拓扑、阈值和输入水位；风险模型使用管网连通特征。
import type { ModelRunRecord, NetworkVersion, PipeSegment } from './types';
import { fnv1a } from './hash';

/**
 * 连通特征：每个管段的网络度数（在阀门/节点处连接的管段数）。
 * 拓扑变化（阀门拆并、管段拆分）会改变该特征，从而使旧模型运行账失效。
 */
export function connectivityFeatures(network: NetworkVersion): Record<string, number> {
  const nodeDegree = new Map<string, number>();
  const segOfEdge = new Map(network.edges.map((e) => [e.id, e.segmentId]));
  for (const e of network.edges) {
    nodeDegree.set(e.fromNode, (nodeDegree.get(e.fromNode) ?? 0) + 1);
    nodeDegree.set(e.toNode, (nodeDegree.get(e.toNode) ?? 0) + 1);
  }
  const features: Record<string, number> = {};
  for (const e of network.edges) {
    const segId = segOfEdge.get(e.id)!;
    features[segId] = (nodeDegree.get(e.fromNode) ?? 0) + (nodeDegree.get(e.toNode) ?? 0);
  }
  return features;
}

export function featureFingerprint(network: NetworkVersion): string {
  const f = connectivityFeatures(network);
  return fnv1a(Object.keys(f).sort().map((k) => `${k}=${f[k]}`).join(';'));
}

/** 虚构风险评分：连通度越高、管径越大、水位越高，风险越高（确定性，无随机数） */
export function runRiskModel(
  modelCode: string,
  threshold: number,
  inputWaterLevelM: number,
  network: NetworkVersion,
  segments: PipeSegment[],
  runSeq: number,
): ModelRunRecord {
  const features = connectivityFeatures(network);
  const scores: Record<string, number> = {};
  for (const seg of segments) {
    const conn = features[seg.id] ?? 1;
    const diameterFactor = seg.diameterMm / 400;
    const raw = (conn / 4) * 0.5 + diameterFactor * 0.3 + (inputWaterLevelM / 5) * 0.2;
    scores[seg.id] = Math.round(raw * 1000) / 1000;
  }
  return {
    runId: `RUN-${modelCode}-${runSeq}`,
    modelCode,
    featureFingerprint: featureFingerprint(network),
    topologyVersion: network.version,
    threshold,
    inputWaterLevelM,
    segmentScores: scores,
    ranAt: new Date().toISOString(),
  };
}

/** 模型输入是否因实体拆并而改变（特征指纹比对） */
export function modelInputsChanged(prev: ModelRunRecord | null, next: ModelRunRecord): boolean {
  if (!prev) return true;
  return (
    prev.featureFingerprint !== next.featureFingerprint ||
    prev.topologyVersion !== next.topologyVersion ||
    prev.threshold !== next.threshold ||
    prev.inputWaterLevelM !== next.inputWaterLevelM
  );
}
