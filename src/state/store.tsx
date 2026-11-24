// 全局状态：导入流水线、IndexedDB 持久化、离线规则失效与同步合并的 React Context。
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react';
import { idbGetAll, idbPut, idbClear, STORES, kvGet, kvSet } from '../db/indexdb';
import { callWorker } from '../workers/client';
import type { WorkerResponse } from '../workers/protocol';
import { runPipeline } from '../domain/pipeline';
import { markStaleReports, syncDrafts, type RuleFingerprints } from '../domain/sync';
import { fnv1a } from '../domain/hash';
import {
  anomalyPackage,
  baselinePackage,
  correctionPackage,
  splitPackage,
  TOPOLOGY_RULE_VERSION,
  type RawSourcePackage,
} from '../domain/sampleData';
import type {
  PackageMeta,
  RecomputeMode,
  ReleaseSnapshot,
  ReviewDraft,
  ReviewStatus,
  SemanticIssue,
  SyncState,
} from '../domain/types';
import type { DriftReport } from '../domain/driftTypes';
import type { PipelineResult as PipelineResultType } from '../domain/pipeline';

export type PipelineResult = PipelineResultType;

export interface PackageRecord {
  id: string;
  meta: PackageMeta;
  rawText: string;
  issues: SemanticIssue[];
  blocked: boolean;
  result: PipelineResult | null;
  mode: RecomputeMode | null;
}

/** IndexedDB 内漂移报告的落库包装（存储主键为 id） */
interface DriftReportRecord {
  id: string;
  report: DriftReport;
}

interface ServerState {
  releaseVersion: number;
  finalizedIds: string[];
}

interface AppState {
  ready: boolean;
  records: PackageRecord[];
  snapshots: ReleaseSnapshot[];
  drafts: ReviewDraft[];
  driftReports: DriftReport[];
  sync: SyncState | null;
  activeRule: string;
  lastFingerprints: RuleFingerprints | null;
  server: ServerState;
  busy: boolean;
  progress: { phase: string; at: number } | null;
  selectedId: string | null;
  reviewer: string;
  notice: string | null;
}

type Action =
  | { type: 'ready'; payload: Omit<AppState, 'ready' | 'busy' | 'progress' | 'selectedId' | 'reviewer' | 'notice'> & { activeRule: string; lastFingerprints: RuleFingerprints | null; server: ServerState } }
  | { type: 'busy'; payload: { phase: string; at: number } | null }
  | { type: 'upsertRecord'; payload: PackageRecord }
  | { type: 'upsertSnapshot'; payload: ReleaseSnapshot }
  | { type: 'upsertDraft'; payload: ReviewDraft }
  | { type: 'upsertDriftReport'; payload: DriftReport }
  | { type: 'select'; payload: string | null }
  | { type: 'reviewer'; payload: string }
  | { type: 'notice'; payload: string | null }
  | { type: 'ruleUpdated'; payload: { records: PackageRecord[]; activeRule: string } }
  | { type: 'synced'; payload: { sync: SyncState; drafts: ReviewDraft[] } }
  | { type: 'reset' };

const initialState: AppState = {
  ready: false,
  records: [],
  snapshots: [],
  drafts: [],
  driftReports: [],
  sync: null,
  activeRule: TOPOLOGY_RULE_VERSION,
  lastFingerprints: null,
  server: { releaseVersion: 0, finalizedIds: [] },
  busy: false,
  progress: null,
  selectedId: null,
  reviewer: '审阅人-张工',
  notice: null,
};

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'ready':
      return { ...state, ready: true, ...action.payload };
    case 'busy':
      return { ...state, busy: action.payload !== null, progress: action.payload };
    case 'upsertRecord': {
      const others = state.records.filter((r) => r.id !== action.payload.id);
      return { ...state, records: [...others, action.payload], selectedId: action.payload.id };
    }
    case 'upsertSnapshot': {
      const others = state.snapshots.filter((s) => s.releaseId !== action.payload.releaseId);
      return { ...state, snapshots: [...others, action.payload] };
    }
    case 'upsertDraft': {
      const others = state.drafts.filter((d) => d.draftId !== action.payload.draftId);
      return { ...state, drafts: [...others, action.payload] };
    }
    case 'upsertDriftReport': {
      const others = state.driftReports.filter((r) => r.reportId !== action.payload.reportId);
      return { ...state, driftReports: [...others, action.payload] };
    }
    case 'select':
      return { ...state, selectedId: action.payload };
    case 'reviewer':
      return { ...state, reviewer: action.payload };
    case 'notice':
      return { ...state, notice: action.payload };
    case 'ruleUpdated':
      return { ...state, records: action.payload.records, activeRule: action.payload.activeRule };
    case 'synced':
      return { ...state, sync: action.payload.sync, drafts: action.payload.drafts };
    case 'reset':
      return { ...initialState, ready: true, activeRule: state.activeRule };
    default:
      return state;
  }
}

export type PackageChoice = 'baseline' | 'correction' | 'split' | 'anomaly';

const PACKAGE_FACTORIES: Record<PackageChoice, () => RawSourcePackage> = {
  baseline: baselinePackage,
  correction: correctionPackage,
  split: splitPackage,
  anomaly: anomalyPackage,
};

interface AppApi {
  state: AppState;
  importAndRun: (choice: PackageChoice, mode: RecomputeMode) => Promise<void>;
  compareModes: (recordId: string) => Promise<{ slice: PipelineResult; full: PipelineResult } | null>;
  replay: (snapshot: ReleaseSnapshot) => Promise<{ ok: boolean; mismatch: string[]; replayHash: string }>;
  saveDraft: (snapshot: ReleaseSnapshot, status: ReviewStatus, comment: string) => Promise<void>;
  simulateRuleUpdate: () => Promise<void>;
  simulateServerAdvance: () => Promise<void>;
  runSync: () => Promise<void>;
  runDriftValidation: (opts?: { alertThreshold?: number; observationDays?: number }) => Promise<DriftReport | null>;
  select: (id: string | null) => void;
  setReviewer: (name: string) => void;
  resetAll: () => Promise<void>;
}

const AppContext = createContext<AppApi | null>(null);

const KV_KEYS = {
  rule: 'activeTopologyRule',
  fingerprints: 'lastFingerprints',
  server: 'serverState',
  sync: 'syncState',
};

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    (async () => {
      const [records, snapshots, drafts, driftReports, activeRule, lastFingerprints, server, sync] = await Promise.all([
        idbGetAll<PackageRecord>(STORES.packages),
        idbGetAll<ReleaseSnapshot>(STORES.snapshots),
        idbGetAll<ReviewDraft>(STORES.drafts),
        idbGetAll<DriftReportRecord>(STORES.driftReports),
        kvGet<string>(KV_KEYS.rule),
        kvGet<RuleFingerprints>(KV_KEYS.fingerprints),
        kvGet<ServerState>(KV_KEYS.server),
        kvGet<SyncState>(KV_KEYS.sync),
      ]);
      dispatch({
        type: 'ready',
        payload: {
          records: records.sort((a, b) => a.meta.importedAt.localeCompare(b.meta.importedAt)),
          snapshots,
          drafts,
          driftReports: driftReports.map((r) => r.report),
          sync: sync ?? null,
          activeRule: activeRule ?? TOPOLOGY_RULE_VERSION,
          lastFingerprints: lastFingerprints ?? null,
          server: server ?? { releaseVersion: 0, finalizedIds: [] },
        },
      });
    })();
  }, []);

  const importAndRun = useCallback(async (choice: PackageChoice, mode: RecomputeMode) => {
    const factory = PACKAGE_FACTORIES[choice];
    const raw = factory();
    const rawText = JSON.stringify(raw, null, 2);
    dispatch({ type: 'busy', payload: { phase: 'Worker 已启动，排队执行', at: 1 } });
    try {
      const prevRecords = (await idbGetAll<PackageRecord>(STORES.packages)).filter((r) => !r.blocked && r.result);
      const prevResult = prevRecords.sort((a, b) => b.meta.importedAt.localeCompare(a.meta.importedAt))[0]?.result ?? null;
      const prevSnapshot = (await idbGetAll<ReleaseSnapshot>(STORES.snapshots)).slice(-1)[0];
      const prevReleaseRefs = prevResult
        ? new Map(prevResult.segments.map((s) => [s.id, prevSnapshot?.releaseId ?? 'network-v0']))
        : new Map<string, string>();
      const networkVersion = (prevResult?.network?.version ?? 0) + 1;
      const activeRule = (await kvGet<string>(KV_KEYS.rule)) ?? TOPOLOGY_RULE_VERSION;

      const msg: WorkerResponse = await callWorker(
        {
          type: 'runPipeline',
          payload: {
            raw,
            rawText,
            networkVersion,
            prevResult,
            prevReleaseRefs: [...prevReleaseRefs.entries()],
            recomputeMode: mode,
            activeTopologyRule: activeRule,
            storedRuleFingerprints: null,
            reviewStatus: 'draft',
          },
        },
        (phase, at) => dispatch({ type: 'busy', payload: { phase, at } }),
      );
      if (msg.type !== 'pipelineDone') throw new Error('Worker 返回类型异常');
      const result = msg.payload;

      const record: PackageRecord = {
        id: raw.meta.packageId,
        meta: result.meta,
        rawText,
        issues: result.issues,
        blocked: result.blocked,
        result,
        mode: result.blocked ? null : mode,
      };
      await idbPut(STORES.packages, record);
      dispatch({ type: 'upsertRecord', payload: record });

      if (result.snapshot) {
        await idbPut(STORES.snapshots, result.snapshot);
        dispatch({ type: 'upsertSnapshot', payload: result.snapshot });
      }
      if (result.impact && result.correction && result.network) {
        const fingerprints: RuleFingerprints = {
          correction: result.correction.ruleFingerprint,
          topology: fnv1a(`${activeRule}:v${result.network.version}`),
        };
        await kvSet(KV_KEYS.fingerprints, fingerprints);
      }
      dispatch({
        type: 'notice',
        payload: result.blocked
          ? `来源包 ${raw.meta.packageId} 语义核验未通过，已阻断发布（哈希仍已记录）`
          : `来源包 ${raw.meta.packageId} 处理完成，网络版本 v${networkVersion}`,
      });
    } catch (err) {
      dispatch({ type: 'notice', payload: `处理失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      dispatch({ type: 'busy', payload: null });
    }
  }, []);

  const compareModes = useCallback(async (recordId: string) => {
    const record = (await idbGetAll<PackageRecord>(STORES.packages)).find((x) => x.id === recordId);
    if (!record || record.blocked || !record.result?.network) return null;
    const raw: RawSourcePackage = JSON.parse(record.rawText);
    const records = await idbGetAll<PackageRecord>(STORES.packages);
    const idx = records.findIndex((x) => x.id === recordId);
    const prevResult = idx > 0 ? records[idx - 1].result : null;
    const prevSnapshot = (await idbGetAll<ReleaseSnapshot>(STORES.snapshots)).find((s) => s.releaseId === `REL-${prevResult?.meta.packageId ?? ''}`) ?? null;
    const refs = prevResult ? new Map(prevResult.segments.map((s) => [s.id, prevSnapshot?.releaseId ?? 'network-v0'])) : new Map<string, string>();
    const activeRule = (await kvGet<string>(KV_KEYS.rule)) ?? TOPOLOGY_RULE_VERSION;
    const networkVersion = record.result.network.version;

    dispatch({ type: 'busy', payload: { phase: '同数据分别执行切片 / 全链重算', at: 20 } });
    try {
      const msg = await callWorker(
        {
          type: 'compareModes',
          payload: {
            raw, rawText: record.rawText, networkVersion, prevResult,
            prevReleaseRefs: [...refs.entries()],
            activeTopologyRule: activeRule,
            storedRuleFingerprints: null,
            reviewStatus: 'draft',
          },
        },
        (phase, at) => dispatch({ type: 'busy', payload: { phase, at } }),
      );
      if (msg.type !== 'compareDone') throw new Error('Worker 返回类型异常');
      return msg.payload;
    } finally {
      dispatch({ type: 'busy', payload: null });
    }
  }, []);

  const replay = useCallback(async (snapshot: ReleaseSnapshot) => {
    dispatch({ type: 'busy', payload: { phase: '回放发布快照', at: 30 } });
    try {
      const msg = await callWorker({ type: 'replay', payload: { snapshot } });
      if (msg.type !== 'replayDone') throw new Error('Worker 返回类型异常');
      dispatch({ type: 'notice', payload: msg.payload.ok ? '回放指纹一致，快照可完整复现' : '回放发现漂移或阻断项' });
      return msg.payload;
    } finally {
      dispatch({ type: 'busy', payload: null });
    }
  }, []);

  const saveDraft = useCallback(async (snapshot: ReleaseSnapshot, status: ReviewStatus, comment: string) => {
    const draft: ReviewDraft = {
      draftId: `DRAFT-${snapshot.releaseId}-${Date.now()}`,
      releaseId: snapshot.releaseId,
      reviewer: state.reviewer,
      comment,
      status,
      updatedAt: new Date().toISOString(),
      baseReleaseVersion: snapshot.network.version,
    };
    await idbPut(STORES.drafts, draft);
    dispatch({ type: 'upsertDraft', payload: draft });
    const updated: ReleaseSnapshot = { ...snapshot, status };
    await idbPut(STORES.snapshots, updated);
    dispatch({ type: 'upsertSnapshot', payload: updated });
    dispatch({ type: 'notice', payload: `审阅草案 ${draft.draftId} 已离线保存` });
  }, [state.reviewer]);

  const simulateRuleUpdate = useCallback(async () => {
    const nextRule = state.activeRule === TOPOLOGY_RULE_VERSION ? 'topo-rule-v2' : TOPOLOGY_RULE_VERSION;
    const records = await idbGetAll<PackageRecord>(STORES.packages);
    const stored = (await kvGet<RuleFingerprints>(KV_KEYS.fingerprints));
    const active: RuleFingerprints = {
      correction: stored?.correction ?? 'none',
      topology: fnv1a(`${nextRule}:v${records.at(-1)?.result?.network?.version ?? 0}`),
    };
    const staleRecords = records.map((r) => {
      if (!r.result?.impact) return r;
      const [impact] = markStaleReports([r.result.impact], stored ?? active, active);
      return { ...r, result: { ...r.result, impact } };
    });
    for (const r of staleRecords) await idbPut(STORES.packages, r);
    await kvSet(KV_KEYS.rule, nextRule);
    dispatch({ type: 'ruleUpdated', payload: { records: staleRecords, activeRule: nextRule } });
    dispatch({ type: 'notice', payload: `离线期间拓扑规则更新为 ${nextRule}，历史影响计算已标记失效` });
  }, [state.activeRule]);

  const simulateServerAdvance = useCallback(async () => {
    const snapshots = await idbGetAll<ReleaseSnapshot>(STORES.snapshots);
    const latest = snapshots.at(-1);
    const prev = (await kvGet<ServerState>(KV_KEYS.server)) ?? { releaseVersion: 0, finalizedIds: [] };
    const server: ServerState = {
      releaseVersion: prev.releaseVersion + 1,
      finalizedIds: latest ? [...new Set([...prev.finalizedIds, latest.releaseId])] : prev.finalizedIds,
    };
    await kvSet(KV_KEYS.server, server);
    dispatch({ type: 'notice', payload: `模拟服务器发布版本前进至 v${server.releaseVersion}（终态发布：${server.finalizedIds.join('、') || '无'}）` });
    // 直接刷新内存中的 server 字段
    dispatch({ type: 'ready', payload: {
      records: state.records, snapshots: state.snapshots, drafts: state.drafts,
      driftReports: state.driftReports, sync: state.sync,
      activeRule: state.activeRule, lastFingerprints: state.lastFingerprints, server,
    } });
  }, [state]);

  const runSync = useCallback(async () => {
    const drafts = await idbGetAll<ReviewDraft>(STORES.drafts);
    const server = (await kvGet<ServerState>(KV_KEYS.server)) ?? { releaseVersion: 0, finalizedIds: [] };
    const localVersion = state.records.filter((r) => r.result?.network).at(-1)?.result?.network?.version ?? 0;
    const outcome = syncDrafts(drafts, localVersion, server.releaseVersion, server.finalizedIds, state.sync?.lastSyncAt ?? null);
    for (const d of outcome.mergedDrafts) await idbPut(STORES.drafts, d);
    await kvSet(KV_KEYS.sync, outcome.state);
    dispatch({ type: 'synced', payload: { sync: outcome.state, drafts: outcome.mergedDrafts } });
    dispatch({
      type: 'notice',
      payload: `同步完成：合并草案 ${outcome.state.mergedDrafts.length} 条，冲突 ${outcome.state.conflicts.length} 条，拒绝越权覆盖 ${outcome.rejectedOverwrites.length} 次`,
    });
  }, [state]);

  const select = useCallback((id: string | null) => dispatch({ type: 'select', payload: id }), []);

  const runDriftValidation = useCallback(
    async (opts?: { alertThreshold?: number; observationDays?: number }): Promise<DriftReport | null> => {
      dispatch({ type: 'busy', payload: { phase: '漂移验证：冻结母体抽样与配对', at: 20 } });
      try {
        const msg = await callWorker(
          { type: 'runDriftValidation', payload: opts ?? {} },
          (phase, at) => dispatch({ type: 'busy', payload: { phase, at } }),
        );
        if (msg.type !== 'driftDone') throw new Error('Worker 返回类型异常');
        const report = msg.payload;
        await idbPut<DriftReportRecord>(STORES.driftReports, { id: report.reportId, report });
        dispatch({ type: 'upsertDriftReport', payload: report });
        dispatch({
          type: 'notice',
          payload: report.comparison.routeB.expansionEligible
            ? '漂移验证完成：分层加权路线通过三终点门禁，可扩面'
            : '漂移验证完成：存在未通过门禁的路线，阻止扩面',
        });
        return report;
      } catch (err) {
        dispatch({ type: 'notice', payload: `漂移验证失败：${err instanceof Error ? err.message : String(err)}` });
        return null;
      } finally {
        dispatch({ type: 'busy', payload: null });
      }
    },
    [],
  );

  const setReviewer = useCallback((name: string) => dispatch({ type: 'reviewer', payload: name }), []);

  const resetAll = useCallback(async () => {
    for (const store of Object.values(STORES)) await idbClear(store);
    await kvSet(KV_KEYS.rule, TOPOLOGY_RULE_VERSION);
    dispatch({ type: 'reset' });
    dispatch({ type: 'notice', payload: '本地离线台账已清空' });
  }, []);

  const api = useMemo<AppApi>(
    () => ({ state, importAndRun, compareModes, replay, saveDraft, simulateRuleUpdate, simulateServerAdvance, runSync, runDriftValidation, select, setReviewer, resetAll }),
    [state, importAndRun, compareModes, replay, saveDraft, simulateRuleUpdate, simulateServerAdvance, runSync, runDriftValidation, select, setReviewer, resetAll],
  );

  return <AppContext.Provider value={api}>{children}</AppContext.Provider>;
}

export function useApp(): AppApi {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp 必须在 AppProvider 内使用');
  return ctx;
}

// 供非 React 环境（测试/调试）复用流水线
export { runPipeline };
