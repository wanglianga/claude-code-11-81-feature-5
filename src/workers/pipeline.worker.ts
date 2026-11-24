// 重计算流水线 Worker：在后台线程执行导入、校正、拓扑、影响、重算与快照构建，
// 避免阻塞主线程 UI。领域代码不依赖 DOM，可直接在 Worker 内运行。
import { runPipeline } from '../domain/pipeline';
import { replaySnapshot } from '../domain/snapshot';
import { runDriftValidation } from '../domain/drift';
import type { WorkerRequest, WorkerResponse } from './protocol';

function post(msg: WorkerResponse): void {
  (self as unknown as { postMessage: (m: WorkerResponse) => void }).postMessage(msg);
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    if (req.type === 'runPipeline') {
      const p = req.payload;
      post({ type: 'progress', payload: { phase: '导入与语义核验', at: 10 } });
      const result = await runPipeline({
        raw: p.raw,
        rawText: p.rawText,
        networkVersion: p.networkVersion,
        prevSegments: p.prevResult?.segments ?? [],
        prevNetwork: p.prevResult?.network ?? null,
        prevModelRun: p.prevResult?.modelRun ?? null,
        prevReleaseRefs: new Map(p.prevReleaseRefs),
        recomputeMode: p.recomputeMode,
        activeTopologyRule: p.activeTopologyRule,
        storedRuleFingerprints: p.storedRuleFingerprints,
        reviewStatus: p.reviewStatus,
      });
      post({ type: 'progress', payload: { phase: '影响求值与重算完成', at: 100 } });
      post({ type: 'pipelineDone', payload: result });
    } else if (req.type === 'replay') {
      const replay = await replaySnapshot(req.payload.snapshot);
      post({ type: 'replayDone', payload: replay });
    } else if (req.type === 'compareModes') {
      const p = req.payload;
      post({ type: 'progress', payload: { phase: 'Worker 内并行执行切片 / 全链重算', at: 40 } });
      const common = {
        raw: p.raw,
        rawText: p.rawText,
        networkVersion: p.networkVersion,
        prevSegments: p.prevResult?.segments ?? [],
        prevNetwork: p.prevResult?.network ?? null,
        prevModelRun: p.prevResult?.modelRun ?? null,
        prevReleaseRefs: new Map(p.prevReleaseRefs),
        activeTopologyRule: p.activeTopologyRule,
        storedRuleFingerprints: p.storedRuleFingerprints,
        reviewStatus: p.reviewStatus,
      };
      const [slice, full] = await Promise.all([
        runPipeline({ ...common, recomputeMode: 'slice' }),
        runPipeline({ ...common, recomputeMode: 'full' }),
      ]);
      post({ type: 'compareDone', payload: { slice, full } });
    } else if (req.type === 'runDriftValidation') {
      post({ type: 'progress', payload: { phase: '冻结母体抽样、预测-观测配对与校准', at: 40 } });
      const report = await runDriftValidation(req.payload);
      post({ type: 'progress', payload: { phase: '扩面门禁与两路线比较完成', at: 100 } });
      post({ type: 'driftDone', payload: report });
    }
  } catch (err) {
    post({ type: 'error', payload: err instanceof Error ? err.message : String(err) });
  }
};
