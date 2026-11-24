import { useApp } from '../state/store';
import { Badge, Banner, Empty, Kv } from '../components/ui';

export function SyncPage() {
  const { state, simulateRuleUpdate, simulateServerAdvance, runSync } = useApp();

  return (
    <div>
      <div className="header">
        <h2>⑩ 离线失效与重新同步</h2>
        <span className="meta">离线期间规则更新使旧影响计算失效；同步只合并未冲突草案，不覆盖服务器较新发布</span>
      </div>

      <div className="panel">
        <h3>规则版本与失效状态</h3>
        <Kv
          pairs={[
            ['当前拓扑规则', <Badge tone="info">{state.activeRule}</Badge>],
            ['上次计算指纹', <span className="mono">{state.lastFingerprints ? `${state.lastFingerprints.correction} / ${state.lastFingerprints.topology}` : '无'}</span>],
            ['服务器发布版本', `v${state.server.releaseVersion}`],
            ['服务器终态发布', state.server.finalizedIds.join('、') || '无'],
            ['上次同步', state.sync?.lastSyncAt ?? '从未同步'],
          ]}
        />
        <div className="row" style={{ marginTop: 12 }}>
          <button className="ghost" disabled={state.busy} onClick={simulateRuleUpdate}>
            模拟离线期间控制点/拓扑规则更新
          </button>
          <button className="ghost" disabled={state.busy} onClick={simulateServerAdvance}>
            模拟服务器发布版本前进
          </button>
          <button className="act" disabled={state.busy || state.drafts.length === 0} onClick={runSync}>
            重新同步（合并未冲突草案）
          </button>
        </div>
        <p className="small" style={{ marginTop: 8 }}>
          规则更新后回到“⑦ 影响求值”可看到历史报告被标记为失效并附带阻断原因；
          服务器前进后再同步，基于旧版本或指向服务器终态发布的草案会被列为冲突且不被覆盖。
        </p>
      </div>

      <div className="panel">
        <h3>本地影响报告失效情况</h3>
        {state.records.length === 0 ? (
          <Empty text="暂无报告" />
        ) : (
          <table>
            <thead><tr><th>来源包</th><th>影响报告</th><th>失效状态</th><th>失效原因</th></tr></thead>
            <tbody>
              {state.records.map((r) => (
                <tr key={r.id}>
                  <td>{r.id}</td>
                  <td className="mono">{r.result?.impact?.reportId ?? '—'}</td>
                  <td>{r.result?.impact?.stale ? <Badge tone="block">已失效</Badge> : <Badge tone="ok">有效</Badge>}</td>
                  <td className="small">{r.result?.impact?.staleReason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {state.sync && (
        <div className="panel">
          <h3>最近一次同步结果</h3>
          <Banner tone={state.sync.conflicts.length ? 'warn' : 'ok'}>
            合并草案 {state.sync.mergedDrafts.length} 条：{state.sync.mergedDrafts.join('、') || '无'}；
            冲突 {state.sync.conflicts.length} 条：{state.sync.conflicts.join('、') || '无'}
          </Banner>
        </div>
      )}

      <div className="panel">
        <h3>离线审阅草案</h3>
        {state.drafts.length === 0 ? (
          <Empty text="暂无草案，可在“⑨ 发布审阅”中保存" />
        ) : (
          <table>
            <thead><tr><th>草案</th><th>发布</th><th>审阅人</th><th>状态</th><th>基于版本</th></tr></thead>
            <tbody>
              {state.drafts.map((d) => (
                <tr key={d.draftId}>
                  <td className="mono">{d.draftId}</td><td>{d.releaseId}</td><td>{d.reviewer}</td>
                  <td><Badge tone={d.status === 'approved' ? 'ok' : d.status === 'rejected' ? 'block' : 'gray'}>{d.status}</Badge></td>
                  <td>v{d.baseReleaseVersion}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
