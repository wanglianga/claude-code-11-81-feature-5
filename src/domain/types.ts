// 地下管网血缘变更工作台 —— 领域类型定义
// 所有坐标为平面投影坐标（虚构地方基准 CGCS2000 / 地方独立坐标），单位由来源包声明。

export type Unit = 'meter' | 'centimeter';
export type CrsKind = 'CGCS2000_3_DEGREE' | 'LOCAL_GRID' | 'BD09'; // 虚构基准集合
export type LineageKind = 'one_to_one' | 'split' | 'merge' | 'unresolved';
export type ValveState = 'open' | 'closed';
export type ChangeType = 'unchanged' | 'geometry' | 'split' | 'merge' | 'unresolved' | 'valve';
export type RecomputeMode = 'slice' | 'full';
export type ReviewStatus = 'draft' | 'approved' | 'rejected' | 'conflict';

/** 二维点 */
export interface Point {
  x: number;
  y: number;
}

/** 管段折线（至少两个点） */
export interface Geometry {
  points: Point[];
}

/** 来源数据包元信息（导入器记录） */
export interface PackageMeta {
  packageId: string;
  fileName: string;
  sha256: string;
  source: string; // 来源单位/系统
  crs: CrsKind;
  epoch: string | null; // 测量历元，如 2026.2；缺失为 null（语义校验项）
  declaredUnit: Unit | null; // 声明单位；误标/缺失为语义校验项
  importedAt: string;
  byteSize: number;
}

/** 语义校验问题：文件哈希正确不能替代语义核验 */
export interface SemanticIssue {
  code: 'EPOCH_MISSING' | 'UNIT_MISLABELED' | 'UNIT_MISSING' | 'UNRESOLVED_LINEAGE' | 'CRS_UNKNOWN';
  severity: 'block' | 'warn';
  entityId?: string;
  message: string;
}

/** 控制点（校正器保存原始/校正坐标与残差） */
export interface ControlPoint {
  id: string;
  zoneId: string; // 分区
  original: Point;
  corrected: Point;
  residual: number; // 残差（米），校正后计算
  note?: string;
}

/** 分区转换误差范围 */
export interface ZoneErrorRange {
  zoneId: string;
  sampleCount: number;
  rms: number; // 中误差（米）
  maxResidual: number;
  band95: number; // 95% 误差带半宽（米），约 1.96 * rms
}

/** 控制点校正集（版本化，规则更新会使旧影响计算失效） */
export interface ControlCorrection {
  correctionId: string;
  basedOnPackage: string;
  controlPoints: ControlPoint[];
  zoneRanges: ZoneErrorRange[];
  transformVersion: string; // 校正规则版本
  ruleFingerprint: string; // 规则指纹，离线更新后比对
  createdAt: string;
}

/** 管段实体 */
export interface PipeSegment {
  id: string;
  tileId: string;
  packageId: string;
  geometry: Geometry;
  material: string;
  diameterMm: number;
  zoneId: string;
}

/** 阀门 */
export interface Valve {
  id: string;
  tileId: string;
  position: Point;
  state: ValveState;
  connectedSegmentIds: string[];
}

/** 实体谱系关系（旧管段 -> 新管段） */
export interface LineageRelation {
  id: string;
  oldSegmentIds: string[];
  newSegmentIds: string[];
  kind: LineageKind;
  evidence: string; // 测量证据描述
  evidenceDistanceM?: number; // 续接端点距离（米）
  confidence: number; // 0~1
}

/** 版本化网络（拓扑重建器输出） */
export interface NetworkVersion {
  networkId: string;
  version: number;
  basedOnPackage: string;
  correctionId: string;
  toleranceM: number; // 端点容差（米）
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  createdAt: string;
}

export interface NetworkNode {
  id: string;
  position: Point;
  kind: 'endpoint' | 'valve' | 'junction';
  valveId?: string;
  tileId: string;
}

export interface NetworkEdge {
  id: string;
  segmentId: string;
  fromNode: string;
  toNode: string;
  tileId: string;
}

/** 施工许可（许可账） */
export interface Permit {
  permitNo: string;
  boundary: Geometry; // 获批空间边界（申请时固化）
  bufferM: number; // 缓冲距离（米），样例为 3 米
  projectPeriod: { start: string; end: string };
  basedOnSegmentVersion: string; // 所依据的管段版本（网络版本号）
  approvedSegmentIds: string[]; // 申请时固化的获批对象，不随现行地图漂移
  lockedAt: string;
}

/** 许可判定结果 */
export interface PermitVerdict {
  permitNo: string;
  stillCovers: boolean; // 是否仍覆盖原获批对象
  minClearanceM: number; // 几何到缓冲边界的最小净距（负=穿越）
  bandTouchesBuffer: boolean; // 95% 误差带是否触及缓冲边界
  status: 'valid' | 'review' | 'blocked';
  reasons: string[];
}

/** 风险模型运行账（固定特征、拓扑、阈值、输入水位） */
export interface ModelRunRecord {
  runId: string;
  modelCode: string;
  featureFingerprint: string; // 输入特征指纹（管网连通特征）
  topologyVersion: number;
  threshold: number; // 风险阈值
  inputWaterLevelM: number; // 输入水位
  segmentScores: Record<string, number>;
  ranAt: string;
}

/** 影响求值单项结果 */
export interface ImpactItem {
  dimension: 'geometry_buffer' | 'entity_lineage' | 'permit_coverage' | 'layer_rebuild';
  targetId: string;
  changed: boolean;
  detail: string;
  blocking: boolean;
}

/** 影响评估报告 */
export interface ImpactReport {
  reportId: string;
  basedOnPackage: string;
  networkVersion: number;
  correctionId: string;
  items: ImpactItem[];
  permitVerdicts: PermitVerdict[];
  changedSegmentIds: string[];
  closureSegmentIds: string[]; // 完整下游闭包（含跨瓦片依赖）
  crossTileDependencies: CrossTileDependency[];
  blockingReasons: string[];
  computedAt: string;
  stale: boolean; // 控制点/拓扑规则更新后置为失效
  staleReason?: string;
}

export interface CrossTileDependency {
  fromTile: string;
  toTile: string;
  viaSegmentId: string;
  viaValveId?: string;
}

/** 重算作业（切片 / 全链） */
export interface RecomputeJob {
  jobId: string;
  mode: RecomputeMode;
  scopeSegmentIds: string[];
  scopeTiles: string[];
  boundaryProof: string; // 切片方案的边界无影响证明；无法证明则扩大整包
  escalatedToFull: boolean;
  preservedReferences: string[]; // 未变区域保留的原发布引用
  resultingNetworkVersion: number;
  reportSnapshot: ImpactReport;
  durationMs: number;
  ranAt: string;
}

/** 发布快照（可回放：输入包、转换、实体关系、许可与模型版本） */
export interface ReleaseSnapshot {
  releaseId: string;
  packageMeta: PackageMeta;
  correction: ControlCorrection;
  lineage: LineageRelation[];
  network: NetworkVersion;
  permits: Permit[];
  modelRun: ModelRunRecord;
  impact: ImpactReport;
  recompute: RecomputeJob;
  status: ReviewStatus;
  blockers: string[];
  publishedAt: string;
  replayHash: string; // 全链路回放指纹
}

/** 离线审阅草案（同步时只合并非冲突草案） */
export interface ReviewDraft {
  draftId: string;
  releaseId: string;
  reviewer: string;
  comment: string;
  status: ReviewStatus;
  updatedAt: string;
  baseReleaseVersion: number; // 草案所基于的发布版本
}

/** 同步状态（模拟服务器） */
export interface SyncState {
  lastSyncAt: string | null;
  serverReleaseVersion: number;
  mergedDrafts: string[];
  conflicts: string[];
}
