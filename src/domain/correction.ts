// 控制点校正器：保存原始/校正坐标与残差，按分区计算转换误差范围（中误差、95% 误差带）。
import type { ControlCorrection, ControlPoint, PipeSegment, Point, Valve, ZoneErrorRange } from './types';
import type { RawControlObservation, RawSourcePackage } from './sampleData';
import { distance, round3 } from './geometry';
import { fnv1a } from './hash';

export interface ZoneShift {
  zoneId: string;
  dx: number;
  dy: number;
  inherited: boolean; // 无本分区控制点时沿用全局平均平移
}

export interface CorrectionBuild {
  correction: ControlCorrection;
  zoneShifts: ZoneShift[];
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function buildCorrection(pkg: RawSourcePackage, transformVersion: string): CorrectionBuild {
  const controlPoints: ControlPoint[] = pkg.controlPoints
    .filter((cp: RawControlObservation) => cp.corrected !== null)
    .map((cp) => {
      const corrected = cp.corrected as Point;
      return {
        id: cp.id,
        zoneId: cp.zoneId,
        original: cp.original,
        corrected,
        residual: round3(distance(cp.original, corrected)),
      };
    });

  const zoneIds = [...new Set(pkg.segments.map((s) => s.zoneId))];
  // 尚无校正观测（如基准月包）时使用恒等变换，避免 NaN 平移
  const globalDx = controlPoints.length ? mean(controlPoints.map((c) => c.corrected.x - c.original.x)) : 0;
  const globalDy = controlPoints.length ? mean(controlPoints.map((c) => c.corrected.y - c.original.y)) : 0;

  const zoneRanges: ZoneErrorRange[] = [];
  const zoneShifts: ZoneShift[] = [];
  for (const zoneId of zoneIds) {
    const cps = controlPoints.filter((c) => c.zoneId === zoneId);
    if (cps.length > 0) {
      const rms = Math.sqrt(mean(cps.map((c) => c.residual ** 2)));
      zoneRanges.push({
        zoneId,
        sampleCount: cps.length,
        rms: round3(rms),
        maxResidual: round3(Math.max(...cps.map((c) => c.residual))),
        band95: round3(1.96 * rms),
      });
      zoneShifts.push({
        zoneId,
        dx: round3(mean(cps.map((c) => c.corrected.x - c.original.x))),
        dy: round3(mean(cps.map((c) => c.corrected.y - c.original.y))),
        inherited: false,
      });
    } else {
      // 无本地控制点的分区继承全局平移，误差带沿用全局统计并标注继承
      const allRms = controlPoints.length
        ? Math.sqrt(mean(controlPoints.map((c) => c.residual ** 2)))
        : 0;      zoneRanges.push({
        zoneId,
        sampleCount: 0,
        rms: round3(allRms),
        maxResidual: 0,
        band95: round3(1.96 * allRms),
      });
      zoneShifts.push({ zoneId, dx: round3(globalDx), dy: round3(globalDy), inherited: true });
    }
  }

  const ruleFingerprint = fnv1a(
    `${transformVersion}|${controlPoints.map((c) => `${c.id}:${c.residual}`).join('|')}`,
  );
  const correction: ControlCorrection = {
    correctionId: `CORR-${pkg.meta.packageId}`,
    basedOnPackage: pkg.meta.packageId,
    controlPoints,
    zoneRanges,
    transformVersion,
    ruleFingerprint,
    createdAt: new Date().toISOString(),
  };
  return { correction, zoneShifts };
}

/** 对整包几何施加分区平移，输出校正后的管段与阀门 */
export function applyCorrection(
  pkg: RawSourcePackage,
  shifts: ZoneShift[],
): { segments: PipeSegment[]; valves: Valve[] } {
  const shiftOf = (zoneId: string): ZoneShift =>
    shifts.find((s) => s.zoneId === zoneId) ?? { zoneId, dx: 0, dy: 0, inherited: true };
  const segments: PipeSegment[] = pkg.segments.map((s) => {
    const sh = shiftOf(s.zoneId);
    return {
      id: s.id,
      tileId: s.tileId,
      packageId: pkg.meta.packageId,
      material: s.material,
      diameterMm: s.diameterMm,
      zoneId: s.zoneId,
      geometry: {
        points: s.points.map((p) => ({ x: round3(p.x + sh.dx), y: round3(p.y + sh.dy) })),
      },
    };
  });
  const valves: Valve[] = pkg.valves.map((v) => {
    // 阀门按其位置就近管段的分区平移（样例中全部落在 Z-A 平移基准下）
    const near = nearestZone(v.position, pkg);
    const sh = shiftOf(near);
    return {
      ...v,
      position: { x: round3(v.position.x + sh.dx), y: round3(v.position.y + sh.dy) },
    };
  });
  return { segments, valves };
}

function nearestZone(p: Point, pkg: RawSourcePackage): string {
  let best = pkg.segments[0]?.zoneId ?? 'Z-A';
  let bestD = Infinity;
  for (const s of pkg.segments) {
    for (const q of s.points) {
      const d = distance(p, q);
      if (d < bestD) {
        bestD = d;
        best = s.zoneId;
      }
    }
  }
  return best;
}
