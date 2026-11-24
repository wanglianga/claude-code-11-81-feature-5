// 局部发布后的风险模型漂移验证 —— 领域类型。
//
// 三个独立终点（分别建模、分别配对、分别门禁）：
//  - ATTR   管段属性异常（现场核验确认的材质/管径/防腐层等属性与台账不符）
//  - PERMIT 许可边界命中（现场核验确认管段实际进入获批施工边界/缓冲）
//  - MAINT  维修确认（现场核验确认的抢修/维修工单命中该管段）
//
// 观察窗固定为发布后 90 日。每一 (管段, 终点) 组合为一条「预测-观测」配对；
// 只有「独立现场核验」且窗口已结束的配对才可进入阴性/阳性计数；
// 未复核、人工修正、失访、观察窗未结束一律为「不可观测」，不得当作阴性。

export type DriftEndpoint = 'ATTR' | 'PERMIT' | 'MAINT';

export const DRIFT_ENDPOINTS: DriftEndpoint[] = ['ATTR', 'PERMIT', 'MAINT'];

export const DRIFT_ENDPOINT_LABEL: Record<DriftEndpoint, string> = {
  ATTR: '管段属性异常',
  PERMIT: '许可边界命中',
  MAINT: '维修确认',
};

/**
 * 单条 (管段, 终点) 观测状态：
 *  - verified              独立现场核验，观察窗已结束，可判定阳性/阴性
 *  - unverified            尚未复核，不能判定
 *  - manual_correction     由人工修正/手工改写台账产生，非独立核验，不能判定
 *  - lost_to_followup      失访，窗口内无法确认，不能判定
 *  - window_open           90 日观察窗尚未结束，不能判定
 */
export type ObservationStatus =
  | 'verified'
  | 'unverified'
  | 'manual_correction'
  | 'lost_to_followup'
  | 'window_open';

/** 不可观测状态（绝不能当阴性） */
export const UNOBSERVABLE_STATUSES: ObservationStatus[] = [
  'unverified',
  'manual_correction',
  'lost_to_followup',
  'window_open',
];

/** 冻结母体中每个管段随发布快照固定的三终点预测/空间分区/模型版本 */
export interface FrozenSegment {
  segmentId: string;
  tileId: string;
  /** 空间分区（校准曲线与关键分区门禁的分组键） */
  zoneId: string;
  /** 是否为稀有高风险分区（抽样分层键） */
  highRisk: boolean;
  /** 发布时对三个终点各自预测的未来 90 日风险概率 */
  predicted: Record<DriftEndpoint, number>;
  /** 上一发布版本对同三个终点的预测（用于 Brier 增量比较），可为空表示无上版本 */
  previousPredicted: Record<DriftEndpoint, number> | null;
  /** 发布时的模型版本（模型代码 + 运行编号 + 特征指纹） */
  modelVersion: string;
  /** 该管段进入评估母体的发布快照编号 */
  releaseId: string;
}

/** 终点的观测记录（现场核验结果） */
export interface EndpointObservation {
  segmentId: string;
  endpoint: DriftEndpoint;
  status: ObservationStatus;
  /** 仅当 status==='verified' 时有效：是否阳性事件 */
  event: boolean | null;
  observedAt: string | null;
  /** 核验来源/证据（虚构） */
  source: string;
  note?: string;
}

/** 抽样路线 */
export type SamplingRoute = 'srs' | 'stratified';

/** 入选记录：记录每段已知的入样概率（逆概率权重的依据） */
export interface SelectionRecord {
  segmentId: string;
  zoneId: string;
  highRisk: boolean;
  stratum: string;
  /** 已知入样概率（0,1]；加权路线用 1/π 还原母体） */
  inclusionProbability: number;
  /** 用于结果回放的确定性伪随机排名（0~1） */
  rank: number;
}

/** 复核样本账（抽样清单 + 已知入样概率 + 观测） */
export interface ReviewLedger {
  route: SamplingRoute;
  /** 母体规模与关键分区规模 */
  cohortSize: number;
  keyZoneCount: number;
  budget: number;
  selection: SelectionRecord[];
  observations: EndpointObservation[];
  /** 失访权重检查：可观测段占比（按终点分别给出） */
  observability: Record<DriftEndpoint, { verified: number; selected: number }>;
  /** 抽样是否无偏（随机路线 true；加权路线按已知概率还原） */
  designNote: string;
}

/** 配对器输出的一条加权配对 */
export interface PairedRecord {
  segmentId: string;
  zoneId: string;
  highRisk: boolean;
  endpoint: DriftEndpoint;
  predicted: number;
  previousPredicted: number | null;
  event: boolean;
  /** 逆概率权重（不加权随机路线恒为 1） */
  weight: number;
  reliability: number;
  releaseId: string;
  modelVersion: string;
}

/** 端点 (终点) 指标：校准截距/斜率、Brier、召回率及其 95% 区间 */
export interface EndpointMetrics {
  endpoint: DriftEndpoint;
  n: number;
  positives: number;
  positivesWeighted: number;
  calibration: { intercept: number; slope: number; interceptCi: [number, number]; slopeCi: [number, number] } | null;
  brier: number;
  brierCi: [number, number] | null;
  /** 当前版本 Brier − 上一版本 Brier（>0 表示变差） */
  brierDelta: number | null;
  brierDeltaCi: [number, number] | null;
  recall: number | null;
  recallCi: [number, number] | null;
  versionDifference: VersionDifference | null;
}

/** 版本差异检验：当前 vs 上一发布版本的校准/ Brier 变化 */
export interface VersionDifference {
  interceptShift: number | null;
  slopeShift: number | null;
  /** 配对 Brier 差的均值与 95% 区间（正=当前变差） */
  brierDelta: number | null;
  brierDeltaCi: [number, number] | null;
  /** 是否检出显著漂移（Brier 配对差区间整体 >0，或斜率区间不含 1 且偏离方向在两个版本间反转） */
  driftDetected: boolean;
  note: string;
}

/** 空间校准曲线：按预测概率等宽分箱的标定表 */
export interface CalibrationBin {
  lo: number;
  hi: number;
  n: number;
  sumWeight: number;
  meanPredicted: number;
  observedRate: number;
  positives: number;
}

/** 单个分区的指标（用于关键分区门禁与校准曲线） */
export interface ZoneMetrics {
  zoneId: string;
  highRisk: boolean;
  n: number;
  positives: number;
  coverage: number; // 加权母体覆盖量
  calibration: { intercept: number; slope: number; interceptCi: [number, number]; slopeCi: [number, number] } | null;
  brier: number;
  recall: number | null;
  recallCi: [number, number] | null;
  curve: CalibrationBin[];
}

/** 单个终点的完整报告 */
export interface EndpointReport {
  endpoint: DriftEndpoint;
  label: string;
  metrics: EndpointMetrics;
  /** 空间校准曲线（母体加权）：预测分箱 -> 观测率 */
  curve: CalibrationBin[];
  zones: ZoneMetrics[];
  /** 独立观测是否存在（缺失独立终点不得称漂移） */
  hasIndependentObservation: boolean;
}

/** 单个门禁条件 */
export interface GateCondition {
  key: string;
  label: string;
  passed: boolean;
  detail: string;
}

/** 扩面门禁结论 */
export interface ExpansionGate {
  endpoint: DriftEndpoint;
  passed: boolean;
  conditions: GateCondition[];
}

/** 一条路线的完整验证结果 */
export interface RouteResult {
  route: SamplingRoute;
  label: string;
  ledger: ReviewLedger;
  endpoints: EndpointReport[];
  gates: ExpansionGate[];
  /** 三终点均通过门禁才可扩面；任一未复核/人工修正/失访/区间跨门限均阻止 */
  expansionEligible: boolean;
  blockers: string[];
  /** 可保留的可观测范围（未通过时仍可扩面的区域/口径） */
  observableScope: string;
}

/** 两路线对比 */
export interface RouteComparison {
  routeA: RouteResult;
  routeB: RouteResult;
  /** 面向关键分区：区间宽度、是否跨 0.70、是否含 1 */
  keyZone: {
    endpoint: DriftEndpoint;
    srsRecallCi: [number, number] | null;
    stratRecallCi: [number, number] | null;
    srsSlopeCi: [number, number] | null;
    stratSlopeCi: [number, number] | null;
    srsCrossThreshold: boolean;
    stratCrossThreshold: boolean;
    srsSlopeIncludesOne: boolean;
    stratSlopeIncludesOne: boolean;
  }[];
  /** 总体加权 Brier 误差对比 */
  overallBrier: {
    endpoint: DriftEndpoint;
    srsBrier: number;
    stratBrier: number;
    srsDelta: number | null;
    stratDelta: number | null;
  }[];
  notes: string[];
}

/** 完整漂移验证报告 */
export interface DriftReport {
  reportId: string;
  createdAt: string;
  observationDays: number;
  keyZoneId: string;
  recallThreshold: number;
  brierDeltaLimit: number;
  recallLowerLimit: number;
  comparison: RouteComparison;
  /** 确定性回放指纹（同一冻结母体 + 同一观测 -> 同一报告） */
  replayHash: string;
  /** 全部用到的终点的独立观测是否齐全 */
  allEndpointsObserved: boolean;
}
