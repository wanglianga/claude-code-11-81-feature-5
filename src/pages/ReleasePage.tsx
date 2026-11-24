import { useState } from 'react';
import { useApp } from '../state/store';
import { Banner, Empty, Kv, StatusBadge } from '../components/ui';
import type { ReleaseSnapshot, ReviewStatus } from '../domain/types';

export function ReleasePage() {
  const { state, replay, saveDraft } = useApp();
  const [replayOf, setReplayOf] = useState<Record<string, { ok: boolean; mismatch: string[]; hash: string }>>({});
  const [commentOf, setCommentOf] = useState<Record<string, string>>({});

  const runReplay = async (s: ReleaseSnapshot) => {
    const out = await replay(s);
    setReplayOf((prev) => ({ ...prev, [s.releaseId]: { ok: out.ok, mismatch: out.mismatch, hash: out.replayHash } }));
  };

  return (
    <div>
      <div className="header">
        <h2>⑨ 发布快照、回放与审阅</h2>
        <span className="meta">快照固定输入包、转换、实体关系、许可与模型版本；未知续接/许可越界给出阻断原因</span>
      </div>

      {state.snapshots.length === 0 ? (
        <Empty text="尚无发布快照（异常包不会产生快照）" />
      ) : (
        state.snapshots.map((s) => (
          <div className="panel" key={s.releaseId}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0 }}>{s.releaseId} <StatusBadge status={s.status} /></h3>
              <div className="row">
                <button className="ghost" disabled={state.busy} onClick={() => runReplay(s)}>回放快照</button>
              </div>
            </div>

            <Kv
              pairs={[
                ['来源包 / 哈希', `${s.packageMeta.packageId} · ${s.packageMeta.sha256.slice(0, 16)}…`],
                ['校正指纹', <span className="mono">{s.correction.ruleFingerprint}</span>],
                ['网络版本', `v${s.network.version}（节点 ${s.network.nodes.length} / 边 ${s.network.edges.length}）`],
                ['谱系关系', `${s.lineage.length} 条（拆分 ${s.lineage.filter((x) => x.kind === 'split').length} / 合并 ${s.lineage.filter((x) => x.kind === 'merge').length} / 未续接 ${s.lineage.filter((x) => x.kind === 'unresolved').length}）`],
                ['许可', s.permits.map((p) => `${p.permitNo}（缓冲 ${p.bufferM}m，依据 ${p.basedOnSegmentVersion}）`).join('；') || '无'],
                ['模型运行', `${s.modelRun.modelCode} / 特征指纹 ${s.modelRun.featureFingerprint} / 拓扑 v${s.modelRun.topologyVersion} / 阈值 ${s.modelRun.threshold} / 水位 ${s.modelRun.inputWaterLevelM}m`],
                ['重算路线', `${s.recompute.mode === 'slice' ? '切片' : '全链'}（范围 ${s.recompute.scopeSegmentIds.length} 管段，保留引用 ${s.recompute.preservedReferences.length} 条）`],
                ['回放指纹', <span className="mono">{s.replayHash}</span>],
                ['发布时间', s.publishedAt],
              ]}
            />

            {s.blockers.length > 0 ? (
              <Banner tone="block">
                <strong>阻断原因（禁止发布，须先处理）：</strong>
                <ul style={{ margin: '6px 0 0' }}>{s.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
              </Banner>
            ) : (
              <Banner tone="ok">无阻断项，可进入发布审阅。</Banner>
            )}

            {replayOf[s.releaseId] && (
              <Banner tone={replayOf[s.releaseId].ok && replayOf[s.releaseId].mismatch.length === 0 ? 'ok' : 'warn'}>
                <div>回放指纹：<span className="mono">{replayOf[s.releaseId].hash}</span>
                  {replayOf[s.releaseId].hash === s.replayHash ? '（与快照一致）' : '（与快照不一致）'}</div>
                {replayOf[s.releaseId].mismatch.length > 0 && (
                  <ul style={{ margin: '6px 0 0' }}>{replayOf[s.releaseId].mismatch.map((m, i) => <li key={i}>{m}</li>)}</ul>
                )}
              </Banner>
            )}

            <h4>审阅草案（离线保存，同步时只合并非冲突草案）</h4>
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <textarea
                placeholder="审阅意见…"
                value={commentOf[s.releaseId] ?? ''}
                onChange={(e) => setCommentOf((p) => ({ ...p, [s.releaseId]: e.target.value }))}
              />
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              {(['approved', 'rejected', 'draft'] as ReviewStatus[]).map((st) => {
                const labels: Record<string, string> = { approved: '批准草案', rejected: '驳回草案', draft: '待审草案' };
                return (
                  <button
                    key={st}
                    className="ghost"
                    disabled={state.busy}
                    onClick={() => saveDraft(s, st, commentOf[s.releaseId] ?? '')}
                  >
                    保存为{labels[st]}
                  </button>
                );
              })}
            </div>
            {state.drafts.filter((d) => d.releaseId === s.releaseId).length > 0 && (
              <table style={{ marginTop: 10 }}>
                <thead><tr><th>草案</th><th>审阅人</th><th>状态</th><th>基于版本</th><th>意见</th><th>时间</th></tr></thead>
                <tbody>
                  {state.drafts.filter((d) => d.releaseId === s.releaseId).map((d) => (
                    <tr key={d.draftId}>
                      <td className="mono">{d.draftId}</td><td>{d.reviewer}</td>
                      <td><StatusBadge status={d.status} /></td><td>v{d.baseReleaseVersion}</td>
                      <td>{d.comment || <span className="small">无</span>}</td><td className="small">{d.updatedAt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))
      )}
    </div>
  );
}
