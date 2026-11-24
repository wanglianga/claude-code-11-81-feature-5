import type { Geometry, Point } from './types';

/** 欧氏距离（平面坐标，单位由调用方保证为米） */
export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 点到线段最近点 */
export function closestPointOnSegment(p: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { ...a };
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/** 点到折线的最短距离 */
export function pointToGeometryDistance(p: Point, g: Geometry): number {
  let best = Infinity;
  for (let i = 0; i < g.points.length - 1; i++) {
    const q = closestPointOnSegment(p, g.points[i], g.points[i + 1]);
    best = Math.min(best, distance(p, q));
  }
  return best;
}

/** 两条折线之间的最短距离（采样点到另一折线距离的最小值） */
export function geometryDistance(a: Geometry, b: Geometry): number {
  let best = Infinity;
  for (const p of a.points) best = Math.min(best, pointToGeometryDistance(p, b));
  for (const p of b.points) best = Math.min(best, pointToGeometryDistance(p, a));
  return best;
}

/** 折线整体平移 */
export function translateGeometry(g: Geometry, dx: number, dy: number): Geometry {
  return { points: g.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
}

/** 折线在某参数处拆分（按顶点索引 k，1 <= k < n） */
export function splitGeometry(g: Geometry, atVertex: number): [Geometry, Geometry] {
  if (atVertex < 1 || atVertex >= g.points.length) {
    throw new Error(`非法拆分点 ${atVertex}`);
  }
  const joint = g.points[atVertex];
  return [
    { points: g.points.slice(0, atVertex + 1) },
    { points: [joint, ...g.points.slice(atVertex + 1)] },
  ];
}

/** 多边形缓冲近似：将边界折线外扩 bufferM（采样顶点法，足以支撑虚构样例判定） */
export function bufferedBoundary(boundary: Geometry, bufferM: number): Geometry {
  // 边界视为闭合环，逐顶点沿法线方向外扩
  const ring = [...boundary.points, boundary.points[0]];
  const out: Point[] = [];
  for (let i = 0; i < boundary.points.length; i++) {
    const prev = ring[i === 0 ? ring.length - 2 : i - 1];
    const cur = ring[i];
    const next = ring[i + 1];
    const n1 = normal(prev, cur);
    const n2 = normal(cur, next);
    let nx = n1.x + n2.x;
    let ny = n1.y + n2.y;
    const norm = Math.hypot(nx, ny) || 1;
    nx /= norm;
    ny /= norm;
    out.push({ x: cur.x + nx * bufferM, y: cur.y + ny * bufferM });
  }
  return { points: out };
}

function normal(a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const norm = Math.hypot(dx, dy) || 1;
  // 外法线（环按顺时针给定时取左侧，这里统一取左法向，样例边界按此构造）
  return { x: -dy / norm, y: dx / norm };
}

/** 点是否在闭合多边形内（射线法） */
export function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect =
      yi > p.y !== yj > p.y &&
      p.x < ((xj - xi) * (p.y - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** 折线是否有任一点落在多边形内 */
export function geometryIntersectsPolygon(g: Geometry, poly: Point[]): boolean {
  return g.points.some((p) => pointInPolygon(p, poly));
}

/** 折线端点集合 */
export function endpoints(g: Geometry): [Point, Point] {
  return [g.points[0], g.points[g.points.length - 1]];
}

/** 质心 */
export function centroid(g: Geometry): Point {
  const sx = g.points.reduce((s, p) => s + p.x, 0);
  const sy = g.points.reduce((s, p) => s + p.y, 0);
  return { x: sx / g.points.length, y: sy / g.points.length };
}

/** 厘米 -> 米 */
export function cmToM(v: number): number {
  return v / 100;
}

/** 限定小数位，避免展示浮点噪声 */
export function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
