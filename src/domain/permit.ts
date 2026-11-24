// 许可账与许可影响：许可边界按申请时空间边界与有效期固化，不随现行地图静默漂移。
import type { Geometry, Permit, PermitVerdict, PipeSegment, Point, ZoneErrorRange } from './types';
import type { RawSourcePackage } from './sampleData';
import { bufferedBoundary, geometryDistance, round3 } from './geometry';

/** 许可边界为闭合环，距离计算需补回首尾闭合边 */
export function closedRing(boundary: Geometry): Geometry {
  return { points: [...boundary.points, boundary.points[0]] };
}

export function buildPermit(pkg: RawSourcePackage): Permit | null {
  if (!pkg.permit) return null;
  return {
    permitNo: pkg.permit.permitNo,
    boundary: { points: pkg.permit.boundary },
    bufferM: pkg.permit.bufferM,
    projectPeriod: { ...pkg.permit.projectPeriod },
    basedOnSegmentVersion: pkg.permit.basedOnSegmentVersion,
    approvedSegmentIds: [...pkg.permit.approvedSegmentIds],
    lockedAt: new Date().toISOString(),
  };
}

/**
 * 许可判定（许可边界锁定，不随地图漂移）。
 * 设 d = 管段到获批边界的最短距离，缓冲 envelope 外沿距边界 bufferM：
 * - 外沿净距 edgeMargin = bufferM - d：
 *   · edgeMargin >= 0：管段仍在缓冲 envelope 内（值为到外沿的剩余距离）；
 *   · edgeMargin < 0 ：几何已越过缓冲外沿（穿越施工缓冲）-> blocked；
 * - 95% 误差带半宽 band95：edgeMargin <= band95 时误差带触及/越过外沿 -> review，复核期间阻止局部发布；
 * - 申请时获批对象若越过外沿 -> stillCovers=false，许可不得静默漂移，须复核。
 */
export function evaluatePermit(
  permit: Permit,
  segments: PipeSegment[],
  candidateSegmentIds: string[],
  zoneRanges: ZoneErrorRange[],
  originallyCoveredIds: string[],
): PermitVerdict {
  const boundaryRing = closedRing(permit.boundary);
  const bandOf = (seg: PipeSegment): number =>
    zoneRanges.find((z) => z.zoneId === seg.zoneId)?.band95 ?? 0;

  let minEdgeMargin = Infinity;
  let bandTouches = false;
  let crosses = false;
  const coveredNow = new Set<string>();
  const reasons: string[] = [];

  for (const id of candidateSegmentIds) {
    const seg = segments.find((s) => s.id === id);
    if (!seg) continue;
    const d = geometryDistance(seg.geometry, boundaryRing);
    const edgeMargin = round3(permit.bufferM - d); // 到缓冲外沿的剩余净距（负=已穿越外沿）
    minEdgeMargin = Math.min(minEdgeMargin, edgeMargin);
    if (edgeMargin >= 0) coveredNow.add(seg.id);
    if (edgeMargin < 0) {
      crosses = true;
      reasons.push(`管段 ${seg.id} 几何越过施工缓冲外沿（外沿净距 ${edgeMargin} 米），构成穿越`);
    }
    const band = bandOf(seg);
    if (edgeMargin <= band) {
      bandTouches = true;
      reasons.push(
        `管段 ${seg.id} 距获批边界 ${round3(d)} 米，缓冲外沿剩余净距 ${edgeMargin} 米，95% 误差带半宽 ${band} 米，误差带触及缓冲外沿`,
      );
    }
  }

  const lostCoverage = originallyCoveredIds.filter((id) => !coveredNow.has(id));
  if (lostCoverage.length) {
    reasons.push(`原获批对象 ${lostCoverage.join('、')} 已偏离许可缓冲覆盖范围，许可边界不得随地图漂移，须复核确认`);
  }

  let status: PermitVerdict['status'] = 'valid';
  if (crosses) status = 'blocked';
  else if (bandTouches || lostCoverage.length > 0) status = 'review';

  return {
    permitNo: permit.permitNo,
    stillCovers: lostCoverage.length === 0,
    minClearanceM: minEdgeMargin === Infinity ? 999 : minEdgeMargin,
    bandTouchesBuffer: bandTouches,
    status,
    reasons,
  };
}

/** 许可缓冲外沿多边形（供地图绘制） */
export function permitBufferRing(permit: Permit): Point[] {
  return bufferedBoundary(permit.boundary, permit.bufferM).points;
}

/** 基准期获批对象（申请时固化清单；缺省时回退为距离判定） */
export function originallyCoveredSegmentIds(permit: Permit, segments: PipeSegment[]): string[] {
  if (permit.approvedSegmentIds.length > 0) return [...permit.approvedSegmentIds];
  const ring = closedRing(permit.boundary);
  return segments
    .filter((s) => geometryDistance(s.geometry, ring) <= permit.bufferM)
    .map((s) => s.id);
}
