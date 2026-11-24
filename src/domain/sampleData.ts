// 可重复运行的虚构数据：两个相邻瓦片 TILE_A / TILE_B，6 管段、3 阀门、2 控制点，
// 一个 3 米施工缓冲许可 PRM-2026-001，一个使用管网连通特征的风险模型 RM-CONN。
// 坐标为虚构地方网格（米）。瓦片分界 x = 100。
import type { CrsKind, LineageRelation, Point, Unit, ValveState } from './types';

export const TILE_BOUNDARY_X = 100;
export const TILES = [
  { tileId: 'TILE_A', bounds: { minX: 0, maxX: 100, minY: 0, maxY: 100 } },
  { tileId: 'TILE_B', bounds: { minX: 100, maxX: 200, minY: 0, maxY: 100 } },
];

export interface RawControlObservation {
  id: string;
  zoneId: string;
  original: Point;
  corrected: Point | null;
}

export interface RawSegment {
  id: string;
  tileId: string;
  points: Point[];
  material: string;
  diameterMm: number;
  zoneId: string;
}

export interface RawValve {
  id: string;
  tileId: string;
  position: Point;
  state: ValveState;
  connectedSegmentIds: string[];
}

export interface RawLineageHint {
  oldSegmentIds: string[];
  newSegmentIds: string[];
  kind: LineageRelation['kind'];
  evidence: string;
  evidenceDistanceM?: number;
  confidence: number;
}

/** 来源包的原始 JSON 结构（导入器解析并计算哈希） */
export interface RawSourcePackage {
  meta: {
    packageId: string;
    fileName: string;
    source: string;
    crs: CrsKind;
    epoch: string | null;
    declaredUnit: Unit | null;
  };
  segments: RawSegment[];
  valves: RawValve[];
  controlPoints: RawControlObservation[];
  permit: {
    permitNo: string;
    boundary: Point[];
    bufferM: number;
    projectPeriod: { start: string; end: string };
    basedOnSegmentVersion: string;
    approvedSegmentIds: string[]; // 申请时固化的获批对象，不随现行地图漂移
  } | null;
  model: {
    modelCode: string;
    threshold: number;
    inputWaterLevelM: number;
  } | null;
  lineageHints: RawLineageHint[];
}

const P = (x: number, y: number): Point => ({ x, y });

/** 基准月包 PKG-2026-01：6 管段、2 阀门、2 控制点（仅原始坐标） */
export function baselinePackage(): RawSourcePackage {
  return {
    meta: {
      packageId: 'PKG-2026-01',
      fileName: 'survey-2026-01.json',
      source: '市测绘院 / 管网中心月度测绘包',
      crs: 'CGCS2000_3_DEGREE',
      epoch: '2026.1',
      declaredUnit: 'meter',
    },
    segments: [
      { id: 'S1', tileId: 'TILE_A', zoneId: 'Z-A', material: '球墨铸铁', diameterMm: 300, points: [P(0, 20), P(40, 20)] },
      { id: 'S2', tileId: 'TILE_A', zoneId: 'Z-A', material: '球墨铸铁', diameterMm: 300, points: [P(40, 20), P(80, 30)] },
      // S3 靠近许可缓冲外沿（外沿 y=57）：基准期中点 y=57.9，距边界 2.1 米，外沿剩余净距 0.9 米
      { id: 'S3', tileId: 'TILE_A', zoneId: 'Z-A', material: 'PE', diameterMm: 200, points: [P(10, 54), P(50, 57.9), P(85, 56)] },
      // S4 跨瓦片管段（x=100 为瓦片分界）
      { id: 'S4', tileId: 'TILE_A', zoneId: 'Z-A', material: '钢管', diameterMm: 400, points: [P(80, 30), P(100, 40), P(130, 40)] },
      { id: 'S5', tileId: 'TILE_B', zoneId: 'Z-B', material: '钢管', diameterMm: 400, points: [P(130, 40), P(170, 45)] },
      { id: 'S6', tileId: 'TILE_B', zoneId: 'Z-B', material: 'PE', diameterMm: 250, points: [P(130, 40), P(160, 80)] },
    ],
    valves: [
      { id: 'V1', tileId: 'TILE_A', position: P(40, 20), state: 'open', connectedSegmentIds: ['S1', 'S2'] },
      { id: 'V2', tileId: 'TILE_B', position: P(130, 40), state: 'closed', connectedSegmentIds: ['S4', 'S5', 'S6'] },
    ],
    controlPoints: [
      { id: 'CP1', zoneId: 'Z-A', original: P(20, 20), corrected: null },
      { id: 'CP2', zoneId: 'Z-A', original: P(60, 57.55), corrected: null },
    ],
    permit: {
      permitNo: 'PRM-2026-001',
      // 顺时针环，最近边 y=60；缓冲 3 米 -> 缓冲外沿 y=57
      boundary: [P(20, 60), P(20, 90), P(80, 90), P(80, 60)],
      bufferM: 3,
      projectPeriod: { start: '2026-03-01', end: '2026-09-30' },
      basedOnSegmentVersion: 'network-v0',
      approvedSegmentIds: ['S3'],
    },
    model: { modelCode: 'RM-CONN', threshold: 0.7, inputWaterLevelM: 2.5 },
    lineageHints: [],
  };
}

/** 第一次变更包 PKG-2026-02：控制点改正（S3 横移约 0.8 米，95% 误差带触及 3 米缓冲外沿） */
export function correctionPackage(): RawSourcePackage {
  const base = baselinePackage();
  return {
    ...base,
    meta: { ...base.meta, packageId: 'PKG-2026-02', fileName: 'survey-2026-02.json', epoch: '2026.2' },
    controlPoints: [
      // 平移分量均值约 (0.7, -0.4)，模 ≈ 0.806 米（≈0.8 米横移），方向朝许可缓冲外沿（y 减小）
      { id: 'CP1', zoneId: 'Z-A', original: P(20, 20), corrected: P(20.6, 19.65) },
      { id: 'CP2', zoneId: 'Z-A', original: P(60, 57.55), corrected: P(60.8, 57.1) },
    ],
    lineageHints: base.segments.map((s) => ({
      oldSegmentIds: [s.id],
      newSegmentIds: [s.id],
      kind: 'one_to_one' as const,
      evidence: '控制点改正后同号管段续接，端点测量距离在容差内',
      evidenceDistanceM: 0.806,
      confidence: 0.98,
    })),
  };
}

/** 第二次变更包 PKG-2026-03：跨瓦片管段 S4 拆为 S4A/S4B，新阀门 V3 接入邻瓦片 */
export function splitPackage(): RawSourcePackage {
  const base = baselinePackage();
  return {
    ...base,
    meta: { ...base.meta, packageId: 'PKG-2026-03', fileName: 'survey-2026-03.json', epoch: '2026.3' },
    segments: [
      { id: 'S1', tileId: 'TILE_A', zoneId: 'Z-A', material: '球墨铸铁', diameterMm: 300, points: [P(0.65, 19.55), P(40.65, 19.55)] },
      { id: 'S2', tileId: 'TILE_A', zoneId: 'Z-A', material: '球墨铸铁', diameterMm: 300, points: [P(40.65, 19.55), P(80.65, 29.55)] },
      { id: 'S3', tileId: 'TILE_A', zoneId: 'Z-A', material: 'PE', diameterMm: 200, points: [P(10.7, 53.6), P(50.7, 57.5), P(85.7, 55.6)] },
      // S4 拆分后的两段，接头位于瓦片分界 x≈100.65
      { id: 'S4A', tileId: 'TILE_A', zoneId: 'Z-A', material: '钢管', diameterMm: 400, points: [P(80.65, 29.55), P(100.65, 39.55)] },
      { id: 'S4B', tileId: 'TILE_B', zoneId: 'Z-A', material: '钢管', diameterMm: 400, points: [P(100.65, 39.55), P(130.65, 39.55)] },
      { id: 'S5', tileId: 'TILE_B', zoneId: 'Z-B', material: '钢管', diameterMm: 400, points: [P(130.65, 39.55), P(170.65, 44.55)] },
      { id: 'S6', tileId: 'TILE_B', zoneId: 'Z-B', material: 'PE', diameterMm: 250, points: [P(130.65, 39.55), P(160.65, 79.55)] },
    ],
    valves: [
      { id: 'V1', tileId: 'TILE_A', position: P(40.65, 19.55), state: 'open', connectedSegmentIds: ['S1', 'S2'] },
      { id: 'V2', tileId: 'TILE_B', position: P(130.65, 39.55), state: 'closed', connectedSegmentIds: ['S4B', 'S5', 'S6'] },
      // 新增 V3：落在瓦片分界上，接入邻瓦片 TILE_B
      { id: 'V3', tileId: 'TILE_B', position: P(100.65, 39.55), state: 'open', connectedSegmentIds: ['S4A', 'S4B'] },
    ],
    controlPoints: [
      { id: 'CP1', zoneId: 'Z-A', original: P(20, 20), corrected: P(20.5, 19.7) },
      { id: 'CP2', zoneId: 'Z-A', original: P(60, 57.55), corrected: P(60.8, 56.95) },
    ],
    lineageHints: [
      { oldSegmentIds: ['S1'], newSegmentIds: ['S1'], kind: 'one_to_one', evidence: '复测坐标一致', evidenceDistanceM: 0, confidence: 0.99 },
      { oldSegmentIds: ['S2'], newSegmentIds: ['S2'], kind: 'one_to_one', evidence: '复测坐标一致', evidenceDistanceM: 0, confidence: 0.99 },
      { oldSegmentIds: ['S3'], newSegmentIds: ['S3'], kind: 'one_to_one', evidence: '校正后续接，几何横移 0.81 米', evidenceDistanceM: 0.806, confidence: 0.97 },
      // 关键拆分关系：S4 -> S4A + S4B，测量证据为接头共点
      { oldSegmentIds: ['S4'], newSegmentIds: ['S4A', 'S4B'], kind: 'split', evidence: '接头 V3 处共点测量，两段长度之和等于原 S4 长度（容差 0.02 米）', evidenceDistanceM: 0.012, confidence: 0.96 },
      { oldSegmentIds: ['S5'], newSegmentIds: ['S5'], kind: 'one_to_one', evidence: '复测坐标一致', evidenceDistanceM: 0, confidence: 0.99 },
      { oldSegmentIds: ['S6'], newSegmentIds: ['S6'], kind: 'one_to_one', evidence: '复测坐标一致', evidenceDistanceM: 0, confidence: 0.99 },
    ],
  };
}

/** 异常包 PKG-BAD-09：测量历元缺失 + 单位误标 + 无法唯一续接的历史管段 */
export function anomalyPackage(): RawSourcePackage {
  return {
    meta: {
      packageId: 'PKG-BAD-09',
      fileName: 'survey-bad-09.json',
      source: '外协单位补测包',
      crs: 'LOCAL_GRID',
      epoch: null, // 测量历元缺失
      declaredUnit: 'centimeter', // 单位误标：坐标实为米量级（0~200），却声明厘米
    },
    segments: [
      { id: 'S88A', tileId: 'TILE_A', zoneId: 'Z-A', material: 'PE', diameterMm: 200, points: [P(12, 50), P(48, 52)] },
      { id: 'S88B', tileId: 'TILE_A', zoneId: 'Z-A', material: 'PE', diameterMm: 200, points: [P(48, 52), P(86, 51)] },
    ],
    valves: [],
    controlPoints: [],
    permit: null,
    model: null,
    lineageHints: [
      // 历史管段 S77 有两个等距候选，无法唯一续接
      {
        oldSegmentIds: ['S77'],
        newSegmentIds: ['S88A', 'S88B'],
        kind: 'unresolved',
        evidence: '两个候选端点距离均为 0.62 米，测量证据不足以唯一续接',
        evidenceDistanceM: 0.62,
        confidence: 0.41,
      },
    ],
  };
}

/** 拓扑规则版本（离线更新会改变该指纹，使旧影响计算失效） */
export const TOPOLOGY_RULE_VERSION = 'topo-rule-v1';
export const TOPOLOGY_TOLERANCE_M = 0.5;
