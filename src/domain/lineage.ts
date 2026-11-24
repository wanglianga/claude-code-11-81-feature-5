// 实体谱系：维护旧管段 -> 新管段的一对一、拆分、合并或未能续接关系及测量证据。
import type { LineageRelation, PipeSegment } from './types';
import type { RawLineageHint, RawSourcePackage } from './sampleData';
import { geometryDistance } from './geometry';

export function buildLineage(pkg: RawSourcePackage): LineageRelation[] {
  return pkg.lineageHints.map((h: RawLineageHint, idx) => ({
    id: `LIN-${pkg.meta.packageId}-${idx + 1}`,
    oldSegmentIds: [...h.oldSegmentIds],
    newSegmentIds: [...h.newSegmentIds],
    kind: h.kind,
    evidence: h.evidence,
    evidenceDistanceM: h.evidenceDistanceM,
    confidence: h.confidence,
  }));
}

export interface LineageMovement {
  relationId: string;
  kind: LineageRelation['kind'];
  /** 旧几何到新几何的最小/最大偏移（米），用于影响求值 */
  minShiftM: number;
  maxShiftM: number;
  blocked: boolean;
}

/**
 * 结合旧/新管段几何量化每条谱系关系的实体变动。
 * unresolved 关系直接阻断；split/merge 标注结构变更。
 */
export function measureLineageMovements(
  relations: LineageRelation[],
  oldSegments: PipeSegment[],
  newSegments: PipeSegment[],
): LineageMovement[] {
  const oldById = new Map(oldSegments.map((s) => [s.id, s]));
  const newById = new Map(newSegments.map((s) => [s.id, s]));
  return relations.map((r) => {
    if (r.kind === 'unresolved') {
      return { relationId: r.id, kind: r.kind, minShiftM: NaN, maxShiftM: NaN, blocked: true };
    }
    const distances: number[] = [];
    for (const oid of r.oldSegmentIds) {
      const o = oldById.get(oid);
      if (!o) continue;
      for (const nid of r.newSegmentIds) {
        const n = newById.get(nid);
        if (n) distances.push(geometryDistance(o.geometry, n.geometry));
      }
    }
    const minShiftM = distances.length ? Math.min(...distances) : 0;
    const maxShiftM = distances.length ? Math.max(...distances) : 0;
    return {
      relationId: r.id,
      kind: r.kind,
      minShiftM,
      maxShiftM,
      blocked: r.confidence < 0.5,
    };
  });
}

/** 受谱系影响的新管段集合（模型输入变更传播的起点） */
export function lineageChangedSegmentIds(relations: LineageRelation[]): string[] {
  const out = new Set<string>();
  for (const r of relations) {
    if (r.kind === 'unresolved' || r.confidence < 0.5) continue;
    for (const id of r.newSegmentIds) out.add(id);
  }
  return [...out];
}
