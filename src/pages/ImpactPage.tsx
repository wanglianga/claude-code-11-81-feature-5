import { RecordSelector, useSelectedRecord } from './common';
import { Badge, Banner, Empty, StatusBadge } from '../components/ui';
import { MapView } from '../components/MapView';

const DIM_LABEL: Record<string, string> = {
  geometry_buffer: '几何误差 vs 施工缓冲',
  entity_lineage: '实体拆并 vs 模型输入',
  permit_coverage: '许可覆盖连续性',
  layer_rebuild: '公开图层重建',
};

export function ImpactPage() {
  const rec = useSelectedRecord();
  const r = rec?.result;

  return (
    <div>
      <div className="header">
        <h2>⑦ 影响求值（四类依赖边）</h2>
        <span className="meta">几何缓冲穿越、实体拆并、许可覆盖与公开图层重建；阻断原因显式给出</span>
      </div>
      <RecordSelector />

      {!r?.impact ? (
        <Empty text="当前来源包无影响报告（异常包仅产生语义阻断，不进入影响求值）" />
      ) : (
        <>
          {r.impact.stale && (
            <Banner tone="block">
              <strong>报告已失效：</strong>{r.impact.staleReason}
            </Banner>
          )}
          <div className="panel">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0 }}>报告 {r.impact.reportId}（网络 v{r.impact.networkVersion}）</h3>
              <div>
                {r.impact.blockingReasons.length > 0
                  ? <Badge tone="block">{r.impact.blockingReasons.length} 项阻断</Badge>
                  : <Badge tone="ok">无阻断</Badge>}
                {r.impact.stale && <Badge tone="warn">已失效</Badge>}
              </div>
            </div>
            <h4>变更实体种子</h4>
            <div className="pill-list">
              {r.impact.changedSegmentIds.map((id) => <Badge key={id} tone="warn">{id}</Badge>)}
              {r.impact.changedSegmentIds.length === 0 && <span className="small">无</span>}
            </div>
            <h4>完整下游闭包（含跨瓦片依赖）</h4>
            <div className="pill-list">
              {r.impact.closureSegmentIds.map((id) => <Badge key={id} tone="info">{id}</Badge>)}
              {r.impact.closureSegmentIds.length === 0 && <span className="small">无</span>}
            </div>
            <h4>闭包触及的跨瓦片依赖</h4>
            {r.impact.crossTileDependencies.length === 0 ? (
              <p className="small">无</p>
            ) : (
              <table>
                <thead><tr><th>从</th><th>到</th><th>经由管段</th><th>经由阀门</th></tr></thead>
                <tbody>
                  {r.impact.crossTileDependencies.map((c, i) => (
                    <tr key={i}><td>{c.fromTile}</td><td>{c.toTile}</td><td>{c.viaSegmentId}</td><td>{c.viaValveId ?? '—'}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="panel">
            <h3>分维度影响项</h3>
            <table>
              <thead><tr><th>维度</th><th>对象</th><th>结论</th><th>说明</th><th>阻断</th></tr></thead>
              <tbody>
                {r.impact.items.map((it, i) => (
                  <tr key={i}>
                    <td><Badge tone="info">{DIM_LABEL[it.dimension]}</Badge></td>
                    <td className="mono">{it.targetId}</td>
                    <td>{it.changed ? <Badge tone="warn">受影响</Badge> : <Badge tone="ok">无变化</Badge>}</td>
                    <td style={{ maxWidth: 460 }}>{it.detail}</td>
                    <td>{it.blocking ? <Badge tone="block">阻断</Badge> : <span className="small">否</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {r.impact.permitVerdicts.length > 0 && (
            <div className="panel">
              <h3>许可判定汇总</h3>
              {r.impact.permitVerdicts.map((v) => (
                <div key={v.permitNo}>
                  <p>{v.permitNo}：<StatusBadge status={v.status} />
                    <span className="small" style={{ marginLeft: 8 }}>外沿剩余净距 {v.minClearanceM}m，误差带触及={String(v.bandTouchesBuffer)}</span>
                  </p>
                  <ul>{v.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>
                </div>
              ))}
            </div>
          )}

          {r.impact.blockingReasons.length > 0 && (
            <Banner tone="block">
              <strong>阻断原因（局部发布被阻止）：</strong>
              <ul style={{ margin: '6px 0 0' }}>{r.impact.blockingReasons.map((b, i) => <li key={i}>{b}</li>)}</ul>
            </Banner>
          )}

          <div className="panel">
            <MapView
              title="影响地图：橙色=变更种子，黄色=下游闭包，红色=许可缓冲"
              segments={r.segments}
              valves={r.valves}
              permit={r.permit}
              changedIds={new Set(r.impact.changedSegmentIds)}
              closureIds={new Set(r.impact.closureSegmentIds)}
            />
          </div>
        </>
      )}
    </div>
  );
}
