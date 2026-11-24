// WebWorker 客户端：单例 Worker，Promise 化请求，进度回调。
import type { WorkerRequest, WorkerResponse } from './protocol';

let worker: Worker | null = null;
let pending: {
  resolve: (m: WorkerResponse) => void;
  reject: (e: Error) => void;
  onProgress?: (phase: string, at: number) => void;
} | null = null;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./pipeline.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      if (!pending) return;
      if (msg.type === 'progress') {
        pending.onProgress?.(msg.payload.phase, msg.payload.at);
        return;
      }
      if (msg.type === 'error') {
        pending.reject(new Error(msg.payload));
        pending = null;
        return;
      }
      pending.resolve(msg);
      pending = null;
    };
    worker.onerror = (ev) => {
      pending?.reject(new Error(ev.message));
      pending = null;
    };
  }
  return worker;
}

export function callWorker<T extends WorkerRequest>(
  req: T,
  onProgress?: (phase: string, at: number) => void,
): Promise<WorkerResponse> {
  return new Promise((resolve, reject) => {
    if (pending) {
      reject(new Error('Worker 正忙，请等待当前任务完成'));
      return;
    }
    pending = { resolve, reject, onProgress };
    getWorker().postMessage(req);
  });
}

export function workerBusy(): boolean {
  return pending !== null;
}
