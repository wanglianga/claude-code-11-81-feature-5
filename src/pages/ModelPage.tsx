import { RecordSelector, useSelectedRecord } from './common';
import { Badge, Empty, Kv } from '../components/ui';
import { connectivityFeatures } from '../domain/model';

export function ModelPage() {
  const rec = useSelectedRecord();
  const r = rec?.result;

  if (!r?.modelRun) {
    return (
      <div>
        <div className="header"><h2>⑥ 模型运行账与特征依赖</h2></div>
        <RecordSelector />
        <Empty text="当前来源包无模型运行记录（异常包已在导入阶段阻断）" />
      </div>
    );
  }

  const features = r.network ? connectivityFeatures(r.network) : {};

  return (
    <div>
      <div className="header">
        <h2>⑥ 模型运行账与特征依赖</h2>
        <span className="meta">风险模型 RM-CONN 使用管网连通特征；运行账固定特征、拓扑、阈值与输入水位</span>
      </div>
      <RecordSelector />

      <div className="panel">
        <Kv
          pairs={[
            ['运行编号', <span className="mono">{r.modelRun.runId}</span>],
            ['模型代码', r.modelRun.modelCode],
            ['特征指纹', <span className="mono">{r.modelRun.featureFingerprint}</span>],
            ['拓扑版本', <Badge tone="info">v{r.modelRun.topologyVersion}</Badge>],
            ['风险阈值', r.modelRun.threshold],
            ['输入水位', `${r.modelRun.inputWaterLevelM} 米`],
            ['运行时间', r.modelRun.ranAt],
            ['上次模型指纹', <span className="mono">{r.prevModelRun?.featureFingerprint ?? '首次运行'}</span>],
            ['输入是否变化',
              !r.prevModelRun
                ? <Badge tone="gray">首次建账</Badge>
                : r.prevModelRun.featureFingerprint === r.modelRun.featureFingerprint
                  ? <Badge tone="ok">未变化</Badge>
                  : <Badge tone="warn">连通特征已变化，须重算</Badge>],
          ]}
        />
      </div>

      <div className="panel">
        <h3>管段连通特征与风险评分</h3>
        <table>
          <thead><tr><th>管段</th><th>瓦片</th><th>连通度特征</th><th>管径(mm)</th><th>风险评分</th><th>超阈值</th></tr></thead>
          <tbody>
            {r.segments.map((s) => {
              const score = r.modelRun!.segmentScores[s.id] ?? 0;
              return (
                <tr key={s.id}>
                  <td><strong>{s.id}</strong></td>
                  <td>{s.tileId}</td>
                  <td>{features[s.id] ?? 1}</td>
                  <td>{s.diameterMm}</td>
                  <td>{score}</td>
                  <td>{score >= r.modelRun!.threshold ? <Badge tone="warn">超阈值</Badge> : <Badge tone="ok">正常</Badge>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="small">
          阀门拆并（V3 接入）与 S4 拆分会改变节点连接度，特征指纹随之变化——这是“实体拆并改变风险模型输入”的可核验依据。
        </p>
      </div>
    </div>
  );
}
