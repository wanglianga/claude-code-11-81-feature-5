// SVG 地图：两个相邻瓦片、管段、阀门、控制点、许可边界与 3 米缓冲，
// 支持高亮变更管段与下游闭包，并可叠加校正前几何（虚线）作对比。
import { useMemo } from 'react';
import type { ControlPoint, Permit, PipeSegment, Point, Valve } from '../domain/types';
import { permitBufferRing } from '../domain/permit';
import { TILE_BOUNDARY_X } from '../domain/sampleData';

const W = 820;
const H = 400;
const PAD = 24;
const DATA_W = 200;
const DATA_H = 100;

function proj(p: Point): { x: number; y: number } {
  return {
    x: PAD + (p.x / DATA_W) * (W - 2 * PAD),
    y: H - PAD - (p.y / DATA_H) * (H - 2 * PAD),
  };
}

function linePath(seg: PipeSegment): string {
  return seg.geometry.points
    .map((p, i) => {
      const q = proj(p);
      return `${i === 0 ? 'M' : 'L'}${q.x.toFixed(1)},${q.y.toFixed(1)}`;
    })
    .join(' ');
}

function ringPath(points: Point[]): string {
  const closed = [...points, points[0]];
  return closed
    .map((p, i) => {
      const q = proj(p);
      return `${i === 0 ? 'M' : 'L'}${q.x.toFixed(1)},${q.y.toFixed(1)}`;
    })
    .join(' ');
}

interface MapViewProps {
  segments: PipeSegment[];
  prevSegments?: PipeSegment[];
  valves: Valve[];
  controlPoints?: ControlPoint[];
  permit?: Permit | null;
  changedIds?: Set<string>;
  closureIds?: Set<string>;
  title?: string;
}

export function MapView({
  segments,
  prevSegments = [],
  valves,
  controlPoints = [],
  permit,
  changedIds,
  closureIds,
  title,
}: MapViewProps) {
  const divider = proj({ x: TILE_BOUNDARY_X, y: 0 });
  const buffer = useMemo(() => (permit ? permitBufferRing(permit) : []), [permit]);

  return (
    <div className="map-wrap">
      {title && <div className="small" style={{ marginBottom: 4 }}>{title}</div>}
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="管网地图">
        <rect x={0} y={0} width={W} height={H} fill="#fbfdff" />
        {/* 瓦片底图 */}
        <rect x={PAD} y={PAD} width={divider.x - PAD} height={H - 2 * PAD} fill="#eef2ff" opacity={0.55} />
        <rect x={divider.x} y={PAD} width={W - PAD - divider.x} height={H - 2 * PAD} fill="#f0fdf4" opacity={0.55} />
        <line x1={divider.x} y1={PAD} x2={divider.x} y2={H - PAD} stroke="#94a3b8" strokeDasharray="6 5" />
        <text x={PAD + 8} y={PAD + 16} fontSize={12} fill="#64748b">TILE_A</text>
        <text x={divider.x + 8} y={PAD + 16} fontSize={12} fill="#64748b">TILE_B</text>

        {/* 许可边界与缓冲 */}
        {permit && (
          <>
            <path d={ringPath(buffer)} fill="rgba(220,38,38,0.08)" stroke="#dc2626" strokeWidth={1.2} strokeDasharray="5 4" />
            <path d={ringPath(permit.boundary.points)} fill="rgba(220,38,38,0.05)" stroke="#dc2626" strokeWidth={1.6} />
            <text {...proj({ x: 22, y: 88 })} fontSize={11} fill="#dc2626">{permit.permitNo}（缓冲 {permit.bufferM}m）</text>
          </>
        )}

        {/* 校正前几何（虚线对比） */}
        {prevSegments.map((s) => (
          <path key={`ghost-${s.id}`} d={linePath(s)} fill="none" stroke="#94a3b8" strokeWidth={1.4} strokeDasharray="3 4" opacity={0.8} />
        ))}

        {/* 管段 */}
        {segments.map((s) => {
          const isChanged = changedIds?.has(s.id);
          const inClosure = closureIds?.has(s.id);
          const color = isChanged ? '#ea580c' : inClosure ? '#ca8a04' : '#334155';
          const width = isChanged ? 4 : inClosure ? 3.2 : 2.4;
          return (
            <g key={s.id}>
              <path d={linePath(s)} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" />
              {s.geometry.points.map((p, i) => {
                const q = proj(p);
                return <text key={i} x={q.x + 3} y={q.y - 4} fontSize={10} fill={color}>{i === 0 ? s.id : ''}</text>;
              })}
            </g>
          );
        })}

        {/* 控制点 */}
        {controlPoints.map((c) => {
          const o = proj(c.original);
          const n = proj(c.corrected);
          return (
            <g key={c.id}>
              <circle cx={o.x} cy={o.y} r={4.5} fill="#7c3aed" opacity={0.35} />
              <circle cx={n.x} cy={n.y} r={4.5} fill="#7c3aed" />
              <line x1={o.x} y1={o.y} x2={n.x} y2={n.y} stroke="#7c3aed" strokeWidth={1} markerEnd="url(#arrow)" />
              <text x={n.x + 6} y={n.y + 3} fontSize={10} fill="#6d28d9">{c.id}</text>
            </g>
          );
        })}
        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill="#7c3aed" />
          </marker>
        </defs>

        {/* 阀门 */}
        {valves.map((v) => {
          const q = proj(v.position);
          const color = v.state === 'open' ? '#059669' : '#dc2626';
          return (
            <g key={v.id}>
              <rect x={q.x - 6} y={q.y - 6} width={12} height={12} fill="#fff" stroke={color} strokeWidth={2} transform={`rotate(45 ${q.x} ${q.y})`} />
              <text x={q.x + 9} y={q.y - 7} fontSize={10.5} fill={color}>{v.id}·{v.state === 'open' ? '开' : '关'}</text>
            </g>
          );
        })}
      </svg>
      <div className="legend">
        <span>现行管段</span>
        <span className="hot">变更管段</span>
        <span style={{ ['--c' as string]: '#ca8a04' }}>
          <i style={{ display: 'inline-block', width: 14, height: 4, background: '#ca8a04', marginRight: 5, borderRadius: 2 }} />下游闭包
        </span>
        <span className="permit">许可边界/缓冲</span>
        <span className="cp">控制点（淡=原始，实=校正）</span>
      </div>
    </div>
  );
}
