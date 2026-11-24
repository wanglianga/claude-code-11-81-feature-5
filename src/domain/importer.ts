// 导入器：记录包哈希、来源、坐标系、测量历元、单位，并执行语义核验。
// 关键约束：文件哈希正确不能代替语义核验（历元缺失、单位误标、续接歧义均独立拦截）。
import type { PackageMeta, SemanticIssue } from './types';
import type { RawSourcePackage } from './sampleData';
import { sha256Hex } from './hash';
import { distance } from './geometry';

export interface ImportResult {
  meta: PackageMeta;
  raw: RawSourcePackage;
  issues: SemanticIssue[];
  blocked: boolean;
}

/** 单位合理性：声明厘米时，真实管段物理中长若不足 1 米则视为误标 */
function detectUnitIssues(pkg: RawSourcePackage): SemanticIssue[] {
  const issues: SemanticIssue[] = [];
  if (pkg.meta.declaredUnit === null) {
    issues.push({
      code: 'UNIT_MISSING',
      severity: 'block',
      message: `来源包 ${pkg.meta.packageId} 未声明测量单位，无法确定厘米/米换算`,
    });
    return issues;
  }
  if (pkg.meta.declaredUnit === 'centimeter' && pkg.segments.length > 0) {
    const lengths = pkg.segments.map((s) =>
      s.points.reduce((acc, p, i) => (i === 0 ? 0 : acc + distance(s.points[i - 1], p)), 0),
    );
    const median = lengths.sort((a, b) => a - b)[Math.floor(lengths.length / 2)];
    // 声明单位为厘米时，中长 < 100 厘米（1 米）不符合市政管段常识，判定坐标实为米
    if (median < 100) {
      issues.push({
        code: 'UNIT_MISLABELED',
        severity: 'block',
        message: `来源包 ${pkg.meta.packageId} 声明单位为厘米，但管段中长仅 ${median.toFixed(1)} 厘米，坐标量级符合米制，判定单位误标`,
      });
    }
  }
  return issues;
}

function detectEpochIssue(pkg: RawSourcePackage): SemanticIssue[] {
  if (pkg.meta.epoch === null || pkg.meta.epoch.trim() === '') {
    return [
      {
        code: 'EPOCH_MISSING',
        severity: 'block',
        message: `来源包 ${pkg.meta.packageId} 缺失测量历元，无法判断控制点改正的历元基准`,
      },
    ];
  }
  return [];
}

function detectLineageIssues(pkg: RawSourcePackage): SemanticIssue[] {
  return pkg.lineageHints
    .filter((h) => h.kind === 'unresolved' || h.confidence < 0.5)
    .map((h) => ({
      code: 'UNRESOLVED_LINEAGE' as const,
      severity: 'block' as const,
      entityId: h.oldSegmentIds.join('+'),
      message: `历史管段 ${h.oldSegmentIds.join('、')} 无法唯一续接（候选 ${h.newSegmentIds.join('、')}，置信度 ${h.confidence}）：${h.evidence}`,
    }));
}

export async function importPackage(raw: RawSourcePackage, rawText: string): Promise<ImportResult> {
  const sha256 = await sha256Hex(rawText);
  const meta: PackageMeta = {
    packageId: raw.meta.packageId,
    fileName: raw.meta.fileName,
    sha256,
    source: raw.meta.source,
    crs: raw.meta.crs,
    epoch: raw.meta.epoch,
    declaredUnit: raw.meta.declaredUnit,
    importedAt: new Date().toISOString(),
    byteSize: new TextEncoder().encode(rawText).length,
  };
  const issues: SemanticIssue[] = [
    ...detectEpochIssue(raw),
    ...detectUnitIssues(raw),
    ...detectLineageIssues(raw),
  ];
  return { meta, raw, issues, blocked: issues.some((i) => i.severity === 'block') };
}
