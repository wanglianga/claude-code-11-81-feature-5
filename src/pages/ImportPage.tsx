import { useState } from 'react';
import { useApp, type PackageChoice } from '../state/store';
import { Badge, Banner, Empty, Kv } from '../components/ui';
import type { RecomputeMode } from '../domain/types';

const CHOICES: { key: PackageChoice; title: string; desc: string }[] = [
  { key: 'baseline', title: '基准月包 PKG-2026-01', desc: '6 管段 / 2 阀门 / 2 控制点 / 3 米缓冲许可 / 连通性风险模型' },
  { key: 'correction', title: '控制点改正包 PKG-2026-02', desc: 'S3 横移约 0.8 米，95% 误差带触及缓冲边界' },
  { key: 'split', title: '拆并阀门包 PKG-2026-03', desc: '跨瓦片管段 S4 拆为 S4A/S4B，新阀门 V3 接入邻瓦片' },
  { key: 'anomaly', title: '异常补测包 PKG-BAD-09', desc: '测量历元缺失 + 单位误标 + 历史管段无法唯一续接' },
];

export function ImportPage() {
  const { state, importAndRun, resetAll } = useApp();
  const [mode, setMode] = useState<RecomputeMode>('slice');

  return (
    <div>
      <div className="header">
        <h2>① 来源包导入与语义核验</h2>
        <span className="meta">导入器记录包哈希、来源、坐标系、测量历元与单位；哈希正确不替代语义核验</span>
      </div>

      <div className="panel">
        <h3>选择虚构来源包（可重复运行，内容固定）</h3>
        <div className="row" style={{ marginBottom: 10 }}>
          <span className="small">默认重算路线：</span>
          <label><input type="radio" checked={mode === 'slice'} onChange={() => setMode('slice')} /> 切片重算（闭包）</label>
          <label><input type="radio" checked={mode === 'full'} onChange={() => setMode('full')} /> 全链重建（整包）</label>
        </div>
        <div className="grid2">
          {CHOICES.map((c) => (
            <div key={c.key} className="panel" style={{ marginBottom: 0 }}>
              <h3 style={{ fontSize: 14 }}>{c.title}</h3>
              <p className="small" style={{ margin: '4px 0 12px' }}>{c.desc}</p>
              <button className="act" disabled={state.busy} onClick={() => importAndRun(c.key, mode)}>
                导入并在 WebWorker 中运行流水线
              </button>
            </div>
          ))}
        </div>
        {state.progress && (
          <div>
            <div className="progress"><i style={{ width: `${state.progress.at}%` }} /></div>
            <span className="small">{state.progress.phase}（{state.progress.at}%）</span>
          </div>
        )}
      </div>

      <div className="panel">
        <h3>导入台账（IndexedDB 持久化，离线可读）</h3>
        {state.records.length === 0 ? (
          <Empty text="暂无导入记录" />
        ) : (
          <div className="scroll-x">
            <table>
              <thead>
                <tr><th>来源包</th><th>来源 / 坐标系</th><th>测量历元</th><th>单位</th><th>SHA-256</th><th>语义核验</th></tr>
              </thead>
              <tbody>
                {state.records.map((r) => (
                  <tr key={r.id}>
                    <td><strong>{r.id}</strong><div className="small mono">{r.meta.fileName} · {r.meta.byteSize}B</div></td>
                    <td>{r.meta.source}<div className="small">{r.meta.crs}</div></td>
                    <td>{r.meta.epoch ?? <Badge tone="block">缺失</Badge>}</td>
                    <td>{r.meta.declaredUnit ?? <Badge tone="block">缺失</Badge>}</td>
                    <td className="mono" style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.meta.sha256}</td>
                    <td>
                      {r.blocked
                        ? <Badge tone="block">阻断 {r.issues.length} 项</Badge>
                        : <Badge tone="ok">通过</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ marginTop: 12 }}>
          <button className="ghost danger" onClick={resetAll}>清空本地离线台账</button>
        </div>
      </div>

      {state.records.filter((r) => r.blocked).map((r) => (
        <div className="panel" key={`issue-${r.id}`}>
          <Banner tone="block">
            <strong>{r.id}</strong> 语义核验阻断（文件哈希 {r.meta.sha256.slice(0, 12)}… 正确，但语义不通过，禁止发布）
          </Banner>
          <ul>
            {r.issues.map((i, idx) => (
              <li key={idx}><Badge tone="block">{i.code}</Badge> {i.message}</li>
            ))}
          </ul>
          <h4>导入器仍记录的元信息</h4>
          <Kv
            pairs={[
              ['来源', r.meta.source],
              ['坐标系', r.meta.crs],
              ['测量历元', r.meta.epoch ?? 'null（缺失）'],
              ['声明单位', r.meta.declaredUnit ?? 'null（缺失）'],
              ['导入时间', r.meta.importedAt],
            ]}
          />
        </div>
      ))}
    </div>
  );
}
