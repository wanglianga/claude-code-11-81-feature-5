import { useApp, type PackageRecord } from '../state/store';

export function useSelectedRecord(): PackageRecord | null {
  const { state } = useApp();
  return state.records.find((r) => r.id === state.selectedId) ?? state.records.at(-1) ?? null;
}

export function RecordSelector() {
  const { state, select } = useApp();
  return (
    <div className="row" style={{ marginBottom: 12 }}>
      <span className="small">当前来源包：</span>
      <select value={state.selectedId ?? ''} onChange={(e) => select(e.target.value || null)}>
        {state.records.length === 0 && <option value="">（尚未导入）</option>}
        {state.records.map((r) => (
          <option key={r.id} value={r.id}>
            {r.id} · {r.meta.fileName}{r.blocked ? '（已阻断）' : ''}
          </option>
        ))}
      </select>
    </div>
  );
}
