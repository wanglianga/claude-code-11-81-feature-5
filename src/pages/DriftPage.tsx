import { useMemo, useState } from 'react';
import { useApp } from '../state/store';
import { Badge, Banner, Empty, Kv } from '../components/ui';
import type {
  CalibrationBin,
  DriftEndpoint,
  DriftReport,
  EndpointReport,
  ExpansionGate,
  RouteResult,
  ZoneMetrics,
} from '../domain/driftTypes';
import { DRIFT_ENDPOINT_LABEL } from '../domain/driftTypes';
import { selectionStats } from '../domain/driftSample';

const fmt = (x: number | null | undefined, digits = 3): string =>
  x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(digits);
const fmtCi = (ci: [number, number] | null | undefined, digits = 3): string =>
  ci ? `[${fmt(ci[0], digits)}, ${fmt(ci[1], digits)}]` : '—';
const pct = (x: number | null | undefined): string =>
  x === null || x === undefined || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(1)}%`;

/** 空间校准曲线：横轴=预测概率，纵轴=观测率，对角线=理想校准 */
function CalibrationChart({ curve, highlight }: { curve: CalibrationBin[]; highlight?: boolean }) {
  const W = 300;
  const H = 220;
  const PAD = 30;
  const sx = (p: number) => PAD + p * (W - 2 * PAD);
  const sy = (p: number) => H - PAD - p * (H - 2 * PAD);
  const pts = curve.filter((b) => b.sumWeight > 0);
  const path = pts.map((b, i) => `${i === 0 ? 'M' : 'L'}${sx(b.meanPredicted).toFixed(1)},${sy(b.observedRate).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="空间校准曲线">
      <rect x={PAD} y={PAD} width={W - 2 * PAD} height={H - 2 * PAD} fill="#fbfdff" stroke="#e2e8f0" />
      <line x1={sx(0)} y1={sy(0)} x2={sx(1)} y2={sy(1)} stroke="#94a3b8" strokeDasharray="4 4" />
      {[0, 0.25, 0.5, 0.75, 1].map((t) => (
        <g key={t}>
          <line x1={sx(t)} y1={PAD} x2={sx(t)} y2={H - PAD} stroke="#f1f5f9" />
          <text x={sx(t)} y={H - PAD + 14} fontSize={9} fill="#64748b" textAnchor="middle">{t}</text>
        </g>
      ))}
      <text x={W - PAD + 2} y={H - PAD + 4} fontSize={9} fill="#64748b">预测</text>
      <text x={4} y={PAD - 6} fontSize={9} fill="#64748b">观测</text>
      {path && <path d={path} fill="none" stroke={highlight ? '#1d4ed8' : '#dc2626'} strokeWidth={2} />}
      {pts.map((b, i) => (
        <circle key={i} cx={sx(b.meanPredicted)} cy={sy(b.observedRate)} r={3 + Math.min(6, Math.sqrt(b.n))} fill={highlight ? '#2563eb' : '#ef4444'} opacity={0.6} />
      ))}
    </svg>
  );
}

function MetricTable({ report }: { report: EndpointReport }) {
  const m = report.metrics;
  return (
    <table>
      <thead>
        <tr>
          <th>终点</th><th>可观测 n</th><th>阳性</th>
          <th>校准截距 (95%)</th><th>校准斜率 (95%)</th>
          <th>Brier (95%)</th><th>较上一版本 ΔBrier</th><th>召回 (95%)</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><strong>{DRIFT_ENDPOINT_LABEL[report.endpoint]}</strong></td>
          <td>{m.n}</td>
          <td>{m.positives}</td>
          <td>{m.calibration ? `${fmt(m.calibration.intercept)} ${fmtCi(m.calibration.interceptCi, 2)}` : '无法拟合'}</td>
          <td>{m.calibration ? `${fmt(m.calibration.slope)} ${fmtCi(m.calibration.slopeCi, 2)}` : '无法拟合'}</td>
          <td>{fmt(m.brier, 4)} {fmtCi(m.brierCi, 4)}</td>
          <td>{fmt(m.brierDelta, 4)} {fmtCi(m.brierDeltaCi, 4)}</td>
          <td>{pct(m.recall)} {fmtCi(m.recallCi)}</td>
        </tr>
      </tbody>
    </table>
  );
}

function GateList({ gate }: { gate: ExpansionGate }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="row" style={{ marginBottom: 4 }}>
        <strong>{DRIFT_ENDPOINT_LABEL[gate.endpoint]}</strong>
        {gate.passed ? <Badge tone="ok">该终点通过</Badge> : <Badge tone="block">该终点未通过</Badge>}
      </div>
      <table>
        <thead><tr><th style={{ width: 28 }}>#</th><th>条件</th><th style={{ width: 70 }}>结论</th><th>依据</th></tr></thead>
        <tbody>
          {gate.conditions.map((c, i) => (
            <tr key={c.key}>
              <td>{i + 1}</td>
              <td>{c.label}</td>
              <td>{c.passed ? <Badge tone="ok">通过</Badge> : <Badge tone="block">阻止</Badge>}</td>
              <td className="small">{c.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ZoneTable({ zones }: { zones: ZoneMetrics[] }) {
  return (
    <table>
      <thead>
        <tr><th>空间分区</th><th>可观测 n</th><th>阳性</th><th>加权覆盖</th><th>校准截距 (95%)</th><th>校准斜率 (95%)</th><th>Brier</th><th>召回 (95%)</th></tr>
      </thead>
      <tbody>
        {zones.filter((z) => z.n > 0).map((z) => (
          <tr key={z.zoneId}>
            <td>{z.zoneId}{z.highRisk ? ' ★' : ''}</td>
            <td>{z.n}</td><td>{z.positives}</td><td>{fmt(z.coverage, 0)}</td>
            <td>{z.calibration ? `${fmt(z.calibration.intercept)} ${fmtCi(z.calibration.interceptCi, 2)}` : '—'}</td>
            <td>{z.calibration ? `${fmt(z.calibration.slope)} ${fmtCi(z.calibration.slopeCi, 2)}` : <span className="small">无法拟合（样本/分离不足）</span>}</td>
            <td>{fmt(z.brier, 4)}</td>
            <td>{pct(z.recall)} {fmtCi(z.recallCi)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RoutePanel({ route, report, highlight }: { route: RouteResult; report: DriftReport; highlight: boolean }) {
  const stats = selectionStats(route.ledger);
  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>{route.label}</h3>
        {route.expansionEligible ? <Badge tone="ok">可扩面</Badge> : <Badge tone="block">阻止扩面</Badge>}
      </div>

      <Kv
        pairs={[
          ['抽样路线', route.ledger.route === 'srs' ? '简单随机（不加权）' : '关键分区全纳 + 逆概率加权'],
          ['母体 / 关键分区', `${route.ledger.cohortSize} 段 / ${route.ledger.keyZoneCount} 段`],
          ['复核预算', `${route.ledger.budget} 段`],
          ['实际抽中', `${stats.total} 段（关键分区 ${stats.keyCount} 段，其余 ${stats.restCount} 段）`],
          ['关键分区期望（随机）', `${stats.keyExpected} 段`],
          ['入样概率 / 权重', route.ledger.route === 'srs' ? '每段 π=0.10，权重=1（不加权）' : `关键分区 π=1；其余 π=60/960≈0.0625，权重≈${stats.restWeights.join('/')}`],
          ['设计说明', route.ledger.designNote],
        ]}
      />

      <h4>三终点指标（校准截距/斜率、Brier、召回率及 95% 区间）</h4>
      {route.endpoints.map((e) => <MetricTable key={e.endpoint} report={e} />)}

      <div className="grid2" style={{ marginTop: 10 }}>
        {route.endpoints.map((e) => (
          <div key={e.endpoint} className="map-wrap">
            <div className="small" style={{ marginBottom: 2 }}>{DRIFT_ENDPOINT_LABEL[e.endpoint]} · 空间校准曲线（点大小≈样本量）</div>
            <CalibrationChart curve={e.curve} highlight={highlight} />
          </div>
        ))}
      </div>

      <h4>关键分区 {report.keyZoneId} 与各分区指标</h4>
      {route.endpoints.map((e) => (
        <details key={e.endpoint} style={{ marginBottom: 8 }}>
          <summary style={{ cursor: 'pointer' }}>{DRIFT_ENDPOINT_LABEL[e.endpoint]}</summary>
          <ZoneTable zones={e.zones} />
        </details>
      ))}

      <h4>扩面门禁（逐终点）</h4>
      {route.gates.map((g) => <GateList key={g.endpoint} gate={g} />)}

      {route.blockers.length > 0 ? (
        <Banner tone="block">
          <strong>阻止扩面的原因（{route.blockers.length} 项）：</strong>
          <ul style={{ margin: '6px 0 0' }}>{route.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
        </Banner>
      ) : (
        <Banner tone="ok">三终点均有独立观测、关键分区校准斜率区间含 1、Brier 增量 ≤ 0.02、召回率下限 ≥ 0.70 —— 允许扩面。</Banner>
      )}
      <Banner tone="info">{route.observableScope}</Banner>
    </div>
  );
}

export function DriftPage() {
  const { state, runDriftValidation } = useApp();
  const [alertThreshold, setAlertThreshold] = useState(0.3);
  const latest = state.driftReports.at(-1) ?? null;

  const comparisonRows = useMemo(() => latest?.comparison.keyZone ?? [], [latest]);

  const run = () => runDriftValidation({ alertThreshold });

  return (
    <div>
      <div className="header">
        <h2>⑪ 局部发布后的风险模型漂移验证</h2>
        <span className="meta">冻结母体 + 90 日独立核验观测 → 校准/ Brier/召回 + 版本差异 + 扩面门禁</span>
      </div>

      <div className="panel">
        <div className="row">
          <label className="small">告警阈值 θ（召回率口径）：</label>
          <input
            type="number" step="0.05" min="0.05" max="0.95"
            value={alertThreshold}
            onChange={(e) => setAlertThreshold(Number(e.target.value))}
            style={{ width: 90 }}
          />
          <button className="act" disabled={state.busy} onClick={run}>
            {state.busy ? '运行中…' : '运行漂移验证（离线样例）'}
          </button>
          {latest && <span className="small">已保存报告：<span className="mono">{latest.reportId}</span> · 回放指纹 <span className="mono">{latest.replayHash.slice(0, 16)}…</span></span>}
        </div>
        {state.busy && state.progress && (
          <div className="progress"><i style={{ width: `${state.progress.at}%` }} /></div>
        )}
        <p className="small" style={{ marginBottom: 0 }}>
          虚构样例：1000 段已发布管段（其中 40 段属于稀有高风险分区 {latest?.keyZoneId ?? 'Z-H'}），100 段复核预算。
          观测只认「90 日内独立现场核验且窗口结束」的记录；未复核 / 人工修正 / 失访 / 窗口未结束一律排除，绝不当阴性。
          两条路线使用同一三终点、同一 90 日窗、同一门限，仅抽样与加权方式不同。
        </p>
      </div>

      {!latest ? (
        <Empty text="尚无漂移验证报告，点击上方按钮运行离线样例" />
      ) : (
        <>
          <div className="panel">
            <h3>五条准则（门限）</h3>
            <Kv
              pairs={[
                ['观察窗', `${latest.observationDays} 日（发布后）`],
                ['终点', DRIFT_ENDPOINT_LABEL.ATTR + ' / ' + DRIFT_ENDPOINT_LABEL.PERMIT + ' / ' + DRIFT_ENDPOINT_LABEL.MAINT],
                ['关键分区', latest.keyZoneId],
                ['关键分区校准斜率区间须包含', '1'],
                ['总体 Brier 较上一版本增幅上限', `≤ ${latest.brierDeltaLimit}`],
                ['召回率 95% 区间下限', `≥ ${latest.recallLowerLimit}`],
                ['无独立终点', '不得称漂移，直接阻止扩面'],
                ['报告回放指纹', <span className="mono">{latest.replayHash}</span>],
              ]}
            />
          </div>

          <div className="panel">
            <h3>两路线关键分区对比（同一门限）</h3>
            <table>
              <thead>
                <tr>
                  <th>终点</th>
                  <th>路线 A 关键分区召回 (95%)</th>
                  <th>路线 B 关键分区召回 (95%)</th>
                  <th>路线 A 斜率区间</th>
                  <th>路线 B 斜率区间</th>
                </tr>
              </thead>
              <tbody>
                {comparisonRows.map((k: DriftReport['comparison']['keyZone'][number]) => (
                  <tr key={k.endpoint}>
                    <td><strong>{DRIFT_ENDPOINT_LABEL[k.endpoint]}</strong></td>
                    <td>
                      {fmtCi(k.srsRecallCi)} {k.srsCrossThreshold ? <Badge tone="block">跨 0.70</Badge> : <Badge tone="ok">≥0.70</Badge>}
                    </td>
                    <td>
                      {fmtCi(k.stratRecallCi)} {k.stratCrossThreshold ? <Badge tone="block">跨 0.70</Badge> : <Badge tone="ok">≥0.70</Badge>}
                    </td>
                    <td>{fmtCi(k.srsSlopeCi, 2)} {k.srsSlopeIncludesOne ? <Badge tone="ok">含 1</Badge> : <Badge tone="block">不含 1</Badge>}</td>
                    <td>{fmtCi(k.stratSlopeCi, 2)} {k.stratSlopeIncludesOne ? <Badge tone="ok">含 1</Badge> : <Badge tone="block">不含 1</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h4>总体加权 Brier 误差对比</h4>
            <table>
              <thead><tr><th>终点</th><th>路线 A Brier</th><th>路线 A ΔBrier</th><th>路线 B Brier</th><th>路线 B ΔBrier</th></tr></thead>
              <tbody>
                {latest.comparison.overallBrier.map((b) => (
                  <tr key={b.endpoint}>
                    <td>{DRIFT_ENDPOINT_LABEL[b.endpoint]}</td>
                    <td>{fmt(b.srsBrier, 4)}</td><td>{fmt(b.srsDelta, 4)}</td>
                    <td>{fmt(b.stratBrier, 4)}</td><td>{fmt(b.stratDelta, 4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="small" style={{ marginTop: 8 }}>
              {latest.comparison.notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          </div>

          <div className="panel">
            <h3>版本差异检验</h3>
            <table>
              <thead><tr><th>终点</th><th>截距漂移</th><th>斜率漂移</th><th>配对 ΔBrier (95%)</th><th>是否检出显著漂移</th></tr></thead>
              <tbody>
                {latest.comparison.routeB.endpoints.map((e) => {
                  const vd = e.metrics.versionDifference;
                  return (
                    <tr key={e.endpoint}>
                      <td>{DRIFT_ENDPOINT_LABEL[e.endpoint]}</td>
                      <td>{fmt(vd?.interceptShift)}</td>
                      <td>{fmt(vd?.slopeShift)}</td>
                      <td>{fmt(vd?.brierDelta, 4)} {fmtCi(vd?.brierDeltaCi, 4)}</td>
                      <td>{vd?.driftDetected ? <Badge tone="block">检出漂移</Badge> : <Badge tone="ok">未检出</Badge>} <span className="small">{vd?.note}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <RoutePanel route={latest.comparison.routeA} report={latest} highlight={false} />
          <RoutePanel route={latest.comparison.routeB} report={latest} highlight={true} />

          <div className="panel">
            <h3>路线 A 不可观测记录（绝不当阴性）</h3>
            {(() => {
              const flagged = latest.comparison.routeA.ledger.observations.filter((o) => o.status !== 'verified');
              if (flagged.length === 0) return <Empty text="无不可观测记录" />;
              const label: Record<string, string> = {
                unverified: '未复核',
                manual_correction: '人工修正',
                lost_to_followup: '失访',
                window_open: '观察窗未结束',
              };
              return (
                <table>
                  <thead><tr><th>管段</th><th>终点</th><th>状态</th><th>说明</th></tr></thead>
                  <tbody>
                    {flagged.map((o, i) => (
                      <tr key={i}>
                        <td className="mono">{o.segmentId}</td>
                        <td>{DRIFT_ENDPOINT_LABEL[o.endpoint as DriftEndpoint]}</td>
                        <td><Badge tone="block">{label[o.status] ?? o.status}</Badge></td>
                        <td className="small">{o.note ?? o.source}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              );
            })()}
            <p className="small" style={{ marginBottom: 0 }}>
              这些记录已从阴性/阳性计数中排除并计入可观测性；正是它们（叠加关键分区仅 4 段的随机抽样）使路线 A 触发“阻止扩面”。
            </p>
          </div>
        </>
      )}
    </div>
  );
}
