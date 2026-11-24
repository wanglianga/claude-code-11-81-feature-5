import { useState } from 'react';
import { RecordSelector, useSelectedRecord } from './common';
import { Badge, Empty } from '../components/ui';
import { useApp, type PipelineResult } from '../state/store';
import { diffModelScores } from '../domain/recompute';

type Compare = { slice: PipelineResult; full: PipelineResult } | null;

export function RecomputePage() {
  const rec = useSelectedRecord();
  const r = rec?.result;
  const { compareModes, state } = useApp();
  const [compare, setCompare] = useState<Compare>(null);

  if (!r?.recompute) {
    return (
      <div>
        <div className="header"><h2>⑧ 切片 / 全链重算比较</h2></div>
        <RecordSelector />
        <Empty text="当前来源包无重算作业" />
      </div>
    );
  }

  const job = r.recompute;
  const diffs = r.modelRun && r.prevModelRun
    ? diffModelScores(r.prevModelRun, r.modelRun, job.scopeSegmentIds)
    : [];

  return (
    <div>
      <div className="header">
        <h2>⑧ 切片 / 全链重算比较</h2>
        <span className="meta">两条路线均保留未变区域原发布引用；切片无法证明边界无影响时扩大至整包</span>
      </div>
      <RecordSelector />

      <div className="panel">
        <h3>本次导入采用的路线：{job.mode === 'slice' ? '切片重算' : '全链重建'}
          {job.escalatedToFull && <Badge tone="warn">切片已扩大至整包</Badge>}
        </h3>
        <div className="grid2">
          <div>
            <h4>重算范围</h4>
            <p className="small">瓦片：{job.scopeTiles.join('、')}</p>
            <div className="pill-list">{job.scopeSegmentIds.map((id) => <Badge key={id} tone="info">{id}</Badge>)}</div>
          </div>
          <div>
            <h4>保留的未变区域原发布引用</h4>
            {job.preservedReferences.length === 0
              ? <p className="small">无（整包重建或全部管段均在闭包内）</p>
              : <table><tbody>{job.preservedReferences.map((ref) => <tr key={ref}><td className="mono">{ref}</td></tr>)}</tbody></table>}
          </div>
        </div>
        <h4>边界无影响证明 / 重建范围说明</h4>
        <p className="small">{job.boundaryProof}</p>
        <p className="small">确定性耗时记账：{job.durationMs} 单位（切片范围越小越快；全链成本随整包管段数线性增长）</p>
      </div>

      {diffs.length > 0 && (
        <div className="panel">
          <h3>重算范围内模型评分变化（相对上一模型运行账）</h3>
          <table>
            <thead><tr><th>管段</th><th>旧评分</th><th>新评分</th><th>差值</th></tr></thead>
            <tbody>
              {diffs.map((d) => (
                <tr key={d.segmentId}>
                  <td>{d.segmentId}</td><td>{d.before ?? '—'}</td><td>{d.after}</td>
                  <td>{d.delta === 0 ? <Badge tone="ok">无变化</Badge> : <Badge tone="warn">{d.delta}</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="panel">
        <h3>同数据双路线复核</h3>
        <p className="small">对同一来源包分别执行切片与全链重算，比对新拓扑签名与许可判定是否一致。</p>
        <button className="act" disabled={state.busy} onClick={async () => setCompare(await compareModes(rec!.id))}>
          运行切片 vs 全链对照
        </button>
        {compare && (
          <div style={{ marginTop: 12 }}>
            <table>
              <thead><tr><th>对照项</th><th>切片重算</th><th>全链重建</th></tr></thead>
              <tbody>
                <tr>
                  <td>范围管段数</td>
                  <td>{compare.slice.recompute!.scopeSegmentIds.length}</td>
                  <td>{compare.full.recompute!.scopeSegmentIds.length}</td>
                </tr>
                <tr>
                  <td>覆盖瓦片</td>
                  <td>{compare.slice.recompute!.scopeTiles.join('、')}</td>
                  <td>{compare.full.recompute!.scopeTiles.join('、')}</td>
                </tr>
                <tr>
                  <td>保留原发布引用数</td>
                  <td>{compare.slice.recompute!.preservedReferences.length}</td>
                  <td>{compare.full.recompute!.preservedReferences.length}</td>
                </tr>
                <tr>
                  <td>许可判定</td>
                  <td><Badge tone={compare.slice.impact!.permitVerdicts[0]?.status === 'valid' ? 'ok' : 'warn'}>{compare.slice.impact!.permitVerdicts[0]?.status ?? '无'}</Badge></td>
                  <td><Badge tone={compare.full.impact!.permitVerdicts[0]?.status === 'valid' ? 'ok' : 'warn'}>{compare.full.impact!.permitVerdicts[0]?.status ?? '无'}</Badge></td>
                </tr>
                <tr>
                  <td>网络版本</td>
                  <td>v{compare.slice.network!.version}</td>
                  <td>v{compare.full.network!.version}</td>
                </tr>
              </tbody>
            </table>
            <BannerLike compare={compare} />
          </div>
        )}
      </div>
    </div>
  );
}

function BannerLike({ compare }: { compare: NonNullable<Compare> }) {
  const samePermit =
    JSON.stringify(compare.slice.impact?.permitVerdicts.map((v) => v.status)) ===
    JSON.stringify(compare.full.impact?.permitVerdicts.map((v) => v.status));
  const sliceEdges = compare.slice.network!.edges.map((e) => `${e.segmentId}:${e.fromNode}->${e.toNode}`).sort();
  const fullEdges = compare.full.network!.edges.map((e) => `${e.segmentId}:${e.fromNode}->${e.toNode}`).sort();
  const sameTopology = JSON.stringify(sliceEdges) === JSON.stringify(fullEdges);
  return (
    <div className={`banner ${samePermit && sameTopology ? 'ok' : 'block'}`} style={{ marginTop: 12 }}>
      {samePermit && sameTopology
        ? '两条路线给出相同的新拓扑与许可判定；全链记录的重建范围为整包，切片仅重算闭包并保留未变区域引用。'
        : '对照发现不一致，禁止以切片结论发布，须扩大至整包重建。'}
      <div className="small" style={{ marginTop: 6 }}>
        切片闭包 {compare.slice.impact?.closureSegmentIds.join('、')}；跨瓦片依赖 {compare.slice.impact?.crossTileDependencies.length} 条。
      </div>
    </div>
  );
}
