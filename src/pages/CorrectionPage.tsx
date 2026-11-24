import { RecordSelector, useSelectedRecord } from './common';
import { Badge, Empty, Kv } from '../components/ui';
import { MapView } from '../components/MapView';
import { useApp } from '../state/store';

export function CorrectionPage() {
  const rec = useSelectedRecord();
  const r = rec?.result;
  const { state } = useApp();
  const idx = state.records.findIndex((x) => x.id === rec?.id);
  const prevSegments = idx > 0 ? state.records[idx - 1].result?.segments ?? [] : [];

  return (
    <div>
      <div className="header">
        <h2>② 控制点校正与分区误差</h2>
        <span className="meta">保存控制点原始/校正坐标与残差，计算各分区转换误差范围与 95% 误差带</span>
      </div>
      <RecordSelector />

      {!r?.correction ? (
        <Empty text="当前来源包无校正结果（异常包在语义核验阶段已被阻断）" />
      ) : (
        <>
          <div className="panel">
            <Kv
              pairs={[
                ['校正编号', r.correction.correctionId],
                ['依据来源包', r.correction.basedOnPackage],
                ['转换规则版本', r.correction.transformVersion],
                ['规则指纹', <span className="mono">{r.correction.ruleFingerprint}</span>],
                ['生成时间', r.correction.createdAt],
              ]}
            />
          </div>

          <div className="grid2">
            <div className="panel">
              <h3>控制点台账（原始 → 校正，残差）</h3>
              <table>
                <thead><tr><th>点号</th><th>分区</th><th>原始坐标</th><th>校正坐标</th><th>残差(m)</th></tr></thead>
                <tbody>
                  {r.correction.controlPoints.map((c) => (
                    <tr key={c.id}>
                      <td><strong>{c.id}</strong></td>
                      <td>{c.zoneId}</td>
                      <td className="mono">({c.original.x}, {c.original.y})</td>
                      <td className="mono">({c.corrected.x}, {c.corrected.y})</td>
                      <td>{c.residual}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h4>分区平移参数（应用到几何）</h4>
              <table>
                <thead><tr><th>分区</th><th>dx(m)</th><th>dy(m)</th><th>来源</th></tr></thead>
                <tbody>
                  {r.zoneShifts.map((s) => (
                    <tr key={s.zoneId}>
                      <td>{s.zoneId}</td><td>{s.dx}</td><td>{s.dy}</td>
                      <td>{s.inherited ? <Badge tone="info">继承全局</Badge> : <Badge tone="ok">本分区控制点</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="panel">
              <h3>分区转换误差范围</h3>
              <table>
                <thead><tr><th>分区</th><th>样本数</th><th>中误差 RMS(m)</th><th>最大残差(m)</th><th>95% 误差带半宽(m)</th></tr></thead>
                <tbody>
                  {r.correction.zoneRanges.map((z) => (
                    <tr key={z.zoneId}>
                      <td>{z.zoneId}</td><td>{z.sampleCount}</td><td>{z.rms}</td><td>{z.maxResidual}</td>
                      <td><Badge tone={z.band95 > 0.4 ? 'warn' : 'ok'}>{z.band95}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="small">
                误差带 = 1.96 × RMS。校正后 Z-A 分区管段整体横移约 0.8 米；该误差带参与许可缓冲触及判定，
                是“几何未穿越但误差带触及缓冲边界”复核结论的量化依据。
              </p>
            </div>
          </div>

          <div className="panel">
            <MapView
              title="校正后几何（紫色箭头为控制点改正方向；灰色虚线为上一版本几何）"
              segments={r.segments}
              prevSegments={prevSegments}
              valves={r.valves}
              controlPoints={r.correction.controlPoints}
              permit={r.permit}
            />
          </div>
        </>
      )}
    </div>
  );
}
