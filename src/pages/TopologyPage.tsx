import { RecordSelector, useSelectedRecord } from './common';
import { Badge, Empty, Kv } from '../components/ui';
import { MapView } from '../components/MapView';

export function TopologyPage() {
  const rec = useSelectedRecord();
  const r = rec?.result;

  return (
    <div>
      <div className="header">
        <h2>④ 版本化拓扑重建</h2>
        <span className="meta">按阀门连接与端点容差（{r?.network?.toleranceM ?? 0.5} 米）生成节点/边网络，跨瓦片依赖显式登记</span>
      </div>
      <RecordSelector />

      {!r?.network ? (
        <Empty text="当前来源包无网络版本" />
      ) : (
        <>
          <div className="panel">
            <Kv
              pairs={[
                ['网络标识', r.network.networkId],
                ['版本', <Badge tone="info">v{r.network.version}</Badge>],
                ['依据来源包', r.network.basedOnPackage],
                ['校正编号', r.network.correctionId],
                ['节点数 / 边数', `${r.network.nodes.length} / ${r.network.edges.length}`],
              ]}
            />
          </div>

          <div className="grid2">
            <div className="panel">
              <h3>节点（阀门 / 接合点 / 端点）</h3>
              <table>
                <thead><tr><th>节点</th><th>类型</th><th>阀门</th><th>瓦片</th><th>坐标</th></tr></thead>
                <tbody>
                  {r.network.nodes.map((n) => (
                    <tr key={n.id}>
                      <td className="mono">{n.id}</td>
                      <td>
                        <Badge tone={n.kind === 'valve' ? 'block' : n.kind === 'junction' ? 'warn' : 'gray'}>
                          {n.kind === 'valve' ? '阀门' : n.kind === 'junction' ? '接合点' : '端点'}
                        </Badge>
                      </td>
                      <td>{n.valveId ?? '—'}</td>
                      <td>{n.tileId}</td>
                      <td className="mono">({n.position.x}, {n.position.y})</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="panel">
              <h3>边（管段 → 节点对）与跨瓦片依赖</h3>
              <table>
                <thead><tr><th>边</th><th>管段</th><th>起节点</th><th>止节点</th><th>瓦片</th></tr></thead>
                <tbody>
                  {r.network.edges.map((e) => (
                    <tr key={e.id}>
                      <td className="mono">{e.id}</td><td>{e.segmentId}</td>
                      <td className="mono">{e.fromNode}</td><td className="mono">{e.toNode}</td><td>{e.tileId}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h4>跨瓦片依赖（闭包计算不得遗漏）</h4>
              {r.crossTile.length === 0 ? (
                <p className="small">无跨瓦片连接</p>
              ) : (
                <table>
                  <thead><tr><th>从瓦片</th><th>到瓦片</th><th>经由管段</th><th>经由阀门</th></tr></thead>
                  <tbody>
                    {r.crossTile.map((c, i) => (
                      <tr key={i}>
                        <td>{c.fromTile}</td><td>{c.toTile}</td><td>{c.viaSegmentId}</td><td>{c.viaValveId ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <div className="panel">
            <MapView title="版本化网络地图（阀门拆并改变图连接：V3 接入后 S4A/S4B 分属两瓦片）" segments={r.segments} valves={r.valves} permit={r.permit} />
          </div>
        </>
      )}
    </div>
  );
}
