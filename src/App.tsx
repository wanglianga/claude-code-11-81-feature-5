import { useEffect, useState } from 'react';
import { useApp } from './state/store';
import { ImportPage } from './pages/ImportPage';
import { CorrectionPage } from './pages/CorrectionPage';
import { LineagePage } from './pages/LineagePage';
import { TopologyPage } from './pages/TopologyPage';
import { PermitPage } from './pages/PermitPage';
import { ModelPage } from './pages/ModelPage';
import { ImpactPage } from './pages/ImpactPage';
import { RecomputePage } from './pages/RecomputePage';
import { ReleasePage } from './pages/ReleasePage';
import { SyncPage } from './pages/SyncPage';
import { DriftPage } from './pages/DriftPage';

const NAV = [
  { key: 'import', label: '① 导入与语义核验' },
  { key: 'correction', label: '② 控制点校正' },
  { key: 'lineage', label: '③ 实体谱系' },
  { key: 'topology', label: '④ 版本化拓扑' },
  { key: 'permit', label: '⑤ 许可影响' },
  { key: 'model', label: '⑥ 模型依赖' },
  { key: 'impact', label: '⑦ 影响求值' },
  { key: 'recompute', label: '⑧ 重算比较' },
  { key: 'release', label: '⑨ 发布审阅' },
  { key: 'sync', label: '⑩ 离线失效与同步' },
  { key: 'drift', label: '⑪ 发布后漂移验证' },
] as const;

type NavKey = (typeof NAV)[number]['key'];

export default function App() {
  const { state } = useApp();
  const [tab, setTab] = useState<NavKey>('import');
  const [online, setOnline] = useState(navigator.onLine);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  useEffect(() => {
    if (!state.notice) return;
    setToast(state.notice);
    const t = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(t);
  }, [state.notice]);

  if (!state.ready) {
    return <div style={{ padding: 40 }}>正在打开 IndexedDB 离线台账…</div>;
  }

  return (
    <>
      <nav className="sidebar">
        <h1>地下管网血缘变更工作台</h1>
        <p className="sub">React + TS + IndexedDB + WebWorker · 离线运行</p>
        {NAV.map((n) => (
          <button key={n.key} className={`nav-btn ${tab === n.key ? 'active' : ''}`} onClick={() => setTab(n.key)}>
            {n.label}
          </button>
        ))}
        <div className="foot">
          <div>网络：{online ? '在线（仍以本地台账为准）' : '离线模式'}</div>
          <div style={{ marginTop: 6 }}>来源包：{state.records.length} · 快照：{state.snapshots.length} · 漂移报告：{state.driftReports.length}</div>
        </div>
      </nav>
      <main className="main">
        {tab === 'import' && <ImportPage />}
        {tab === 'correction' && <CorrectionPage />}
        {tab === 'lineage' && <LineagePage />}
        {tab === 'topology' && <TopologyPage />}
        {tab === 'permit' && <PermitPage />}
        {tab === 'model' && <ModelPage />}
        {tab === 'impact' && <ImpactPage />}
        {tab === 'recompute' && <RecomputePage />}
        {tab === 'release' && <ReleasePage />}
        {tab === 'sync' && <SyncPage />}
        {tab === 'drift' && <DriftPage />}
      </main>
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
