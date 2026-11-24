import { RecordSelector, useSelectedRecord } from './common';
import { Badge, Empty, Kv, StatusBadge } from '../components/ui';
import { MapView } from '../components/MapView';

export function PermitPage() {
  const rec = useSelectedRecord();
  const r = rec?.result;

  return (
    <div>
      <div className="header">
        <h2>⑤ 许可账与缓冲影响</h2>
        <span className="meta">许可编号、获批边界、缓冲距离、工程期与所依据管段版本在申请时固化，不随现行地图漂移</span>
      </div>
      <RecordSelector />

      {!r?.permit ? (
        <Empty text="当前来源包无施工许可（异常补测包不含许可）" />
      ) : (
        <>
          <div className="panel">
            <Kv
              pairs={[
                ['许可编号', <strong>{r.permit.permitNo}</strong>],
                ['缓冲距离', `${r.permit.bufferM} 米`],
                ['工程期', `${r.permit.projectPeriod.start} 至 ${r.permit.projectPeriod.end}`],
                ['依据管段版本', <span className="mono">{r.permit.basedOnSegmentVersion}</span>],
                ['边界锁定时间', r.permit.lockedAt],
                ['基准期覆盖管段', r.originallyCoveredIds.join('、') || '（无）'],
              ]}
            />
          </div>

          <div className="panel">
            <h3>许可判定（几何净距 / 95% 误差带 / 覆盖连续性）</h3>
            {r.impact?.permitVerdicts.map((v) => (
              <div key={v.permitNo}>
                <p>
                  判定：<StatusBadge status={v.status} />
                  <span style={{ marginLeft: 10 }} className="small">
                    缓冲外沿剩余净距 {v.minClearanceM} 米（负=穿越）· 误差带触及缓冲：
                    {v.bandTouchesBuffer ? <Badge tone="warn">是</Badge> : <Badge tone="ok">否</Badge>}
                    · 仍覆盖原获批对象：{v.stillCovers ? <Badge tone="ok">是</Badge> : <Badge tone="block">否</Badge>}
                  </span>
                </p>
                <ul>
                  {v.reasons.map((reason, i) => (
                    <li key={i} className={v.status === 'valid' ? 'small' : ''}>{reason}</li>
                  ))}
                </ul>
              </div>
            ))}
            <p className="small">
              规则：外沿剩余净距 = 缓冲距离 − 管段到获批边界最短距离；为负表示几何越过缓冲外沿（blocked）；
              该净距不大于 95% 误差带半宽时误差带触及缓冲外沿（review），复核期间阻止该局部发布。
            </p>
          </div>

          <div className="panel">
            <MapView
              title="许可边界（实线）与施工缓冲外沿（红色虚线）；误差带触及缓冲时许可进入复核"
              segments={r.segments}
              valves={r.valves}
              permit={r.permit}
              changedIds={new Set(r.impact?.changedSegmentIds ?? [])}
              closureIds={new Set(r.impact?.closureSegmentIds ?? [])}
            />
          </div>
        </>
      )}
    </div>
  );
}
