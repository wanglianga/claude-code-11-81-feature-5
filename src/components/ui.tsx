import type { ReactNode } from 'react';
import type { ReviewStatus } from '../domain/types';

export function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'block' | 'info' | 'gray'; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Banner({ tone, children }: { tone: 'ok' | 'warn' | 'block' | 'info'; children: ReactNode }) {
  return <div className={`banner ${tone}`}>{children}</div>;
}

export function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}

export function StatusBadge({ status }: { status: ReviewStatus | string }) {
  const map: Record<string, { tone: 'ok' | 'warn' | 'block' | 'info' | 'gray'; label: string }> = {
    draft: { tone: 'gray', label: '草案' },
    approved: { tone: 'ok', label: '已批准' },
    rejected: { tone: 'block', label: '已驳回' },
    conflict: { tone: 'warn', label: '冲突' },
    valid: { tone: 'ok', label: '有效' },
    review: { tone: 'warn', label: '复核中' },
    blocked: { tone: 'block', label: '阻断' },
  };
  const m = map[status] ?? { tone: 'gray' as const, label: status };
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

export function Kv({ pairs }: { pairs: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {pairs.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
