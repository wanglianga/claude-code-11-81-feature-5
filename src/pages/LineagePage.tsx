import { RecordSelector, useSelectedRecord } from './common';
import { Badge, Empty } from '../components/ui';

const KIND_LABEL: Record<string, string> = {
  one_to_one: '一对一续接',
  split: '拆分',
  merge: '合并',
  unresolved: '未能续接',
};

export function LineagePage() {
  const rec = useSelectedRecord();
  const r = rec?.result;

  return (
    <div>
      <div className="header">
        <h2>③ 实体谱系与测量证据</h2>
        <span className="meta">旧管段 → 新管段的一对一、拆分、合并或未能续接关系，均带测量证据与置信度</span>
      </div>
      <RecordSelector />

      {!r ? (
        <Empty text="暂无来源包" />
      ) : (
        <div className="panel">
          <h3>{rec!.id} 的谱系关系</h3>
          {r.lineage.length === 0 ? (
            <Empty text="基准月包无历史管段，尚无谱系关系（首次建账）" />
          ) : (
            <table>
              <thead>
                <tr><th>关系</th><th>类型</th><th>旧管段</th><th>新管段</th><th>测量证据</th><th>端点距离(m)</th><th>置信度</th><th>结论</th></tr>
              </thead>
              <tbody>
                {r.lineage.map((l) => (
                  <tr key={l.id}>
                    <td className="mono">{l.id}</td>
                    <td><Badge tone={l.kind === 'unresolved' ? 'block' : l.kind === 'split' || l.kind === 'merge' ? 'warn' : 'info'}>{KIND_LABEL[l.kind]}</Badge></td>
                    <td>{l.oldSegmentIds.join('、')}</td>
                    <td>{l.newSegmentIds.join('、')}</td>
                    <td style={{ maxWidth: 320 }}>{l.evidence}</td>
                    <td>{l.evidenceDistanceM ?? '—'}</td>
                    <td>{l.confidence}</td>
                    <td>
                      {l.kind === 'unresolved' || l.confidence < 0.5
                        ? <Badge tone="block">阻断发布</Badge>
                        : <Badge tone="ok">可续接</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {rec!.blocked && (
            <p className="small" style={{ marginTop: 10 }}>
              异常包中历史管段 S77 存在两个等距候选，无法唯一续接；即使文件 SHA-256 校验通过，该语义问题仍阻断发布。
            </p>
          )}
        </div>
      )}
    </div>
  );
}
