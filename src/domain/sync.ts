// 离线失效与重新同步：
// - 离线期间控制点或拓扑规则更新 -> 旧影响计算失效（指纹比对）；
// - 重新同步只合并未冲突审阅草案，不能覆盖服务器较新的发布版本。
import type { ImpactReport, ReviewDraft, SyncState } from './types';

export interface RuleFingerprints {
  correction: string;
  topology: string;
}

/** 依据当前规则指纹判断已有影响报告是否失效 */
export function markStaleReports(
  reports: ImpactReport[],
  storedFingerprints: RuleFingerprints,
  activeFingerprints: RuleFingerprints,
): ImpactReport[] {
  const changed =
    storedFingerprints.correction !== activeFingerprints.correction ||
    storedFingerprints.topology !== activeFingerprints.topology;
  if (!changed) return reports;
  return reports.map((r) =>
    r.stale
      ? r
      : {
          ...r,
          stale: true,
          staleReason: `离线期间规则更新（控制点/拓扑规则指纹变化），旧影响计算于 ${r.computedAt} 失效，须重新求值`,
          blockingReasons: [...new Set([...r.blockingReasons, '离线期间控制点或拓扑规则更新，旧影响计算失效'])],
        },
  );
}

export interface SyncOutcome {
  state: SyncState;
  mergedDrafts: ReviewDraft[];
  conflicts: { draft: ReviewDraft; reason: string }[];
  rejectedOverwrites: string[];
}

/**
 * 同步合并：
 * 1) 服务器发布版本较新时，本地草案若基于旧版本且已被处理 -> 冲突，不覆盖服务器版本；
 * 2) 仅合并非冲突草案（baseReleaseVersion === serverReleaseVersion 且服务器无同 releaseId 终态）。
 */
export function syncDrafts(
  drafts: ReviewDraft[],
  localReleaseVersion: number,
  serverReleaseVersion: number,
  serverFinalizedReleaseIds: string[],
  _lastSyncAt: string | null,
): SyncOutcome {
  const merged: ReviewDraft[] = [];
  const conflicts: { draft: ReviewDraft; reason: string }[] = [];
  const rejectedOverwrites: string[] = [];

  for (const draft of drafts) {
    if (serverFinalizedReleaseIds.includes(draft.releaseId) && draft.status !== 'approved') {
      conflicts.push({
        draft,
        reason: `服务器已存在 ${draft.releaseId} 的终态发布，本地草案 ${draft.draftId} 不得覆盖`,
      });
      rejectedOverwrites.push(`拒绝覆盖服务器发布 ${draft.releaseId}`);
      continue;
    }
    if (draft.baseReleaseVersion < serverReleaseVersion) {
      conflicts.push({
        draft,
        reason: `草案基于发布版本 v${draft.baseReleaseVersion}，服务器已到 v${serverReleaseVersion}，存在版本冲突，需人工合并`,
      });
      continue;
    }
    merged.push({ ...draft, status: draft.status === 'conflict' ? 'draft' : draft.status });
  }

  const state: SyncState = {
    lastSyncAt: new Date().toISOString(),
    serverReleaseVersion: Math.max(serverReleaseVersion, localReleaseVersion),
    mergedDrafts: merged.map((d) => d.draftId),
    conflicts: conflicts.map((c) => c.draft.draftId),
  };
  return { state, mergedDrafts: merged, conflicts, rejectedOverwrites };
}
