// 拓扑重建器：按阀门连接与端点容差生成版本化网络，跨瓦片边显式记录跨区依赖。
import type {
  CrossTileDependency,
  NetworkEdge,
  NetworkNode,
  NetworkVersion,
  PipeSegment,
  Valve,
} from './types';
import { distance, endpoints } from './geometry';

export interface TopologyBuild {
  network: NetworkVersion;
  crossTile: CrossTileDependency[];
}

export function buildNetwork(
  segments: PipeSegment[],
  valves: Valve[],
  packageId: string,
  correctionId: string,
  version: number,
  toleranceM: number,
): TopologyBuild {
  const nodes: NetworkNode[] = [];
  const edges: NetworkEdge[] = [];
  const nodeKey = new Map<string, string>();

  const findOrCreateNode = (p: { x: number; y: number }, tileId: string): string => {
    for (const [key, id] of nodeKey) {
      const [kx, ky] = key.split('|').map(Number);
      if (distance({ x: kx, y: ky }, p) <= toleranceM) return id;
    }
    const id = `N${nodes.length + 1}`;
    nodeKey.set(`${p.x}|${p.y}`, id);
    nodes.push({ id, position: p, kind: 'endpoint', tileId });
    return id;
  };

  // 阀门节点优先登记，保证管段端点在容差内吸附到阀门
  const valveNodeIds = new Map<string, string>();
  for (const v of valves) {
    const id = `NV-${v.id}`;
    nodes.push({ id, position: v.position, kind: 'valve', valveId: v.id, tileId: v.tileId });
    nodeKey.set(`${v.position.x}|${v.position.y}`, id);
    valveNodeIds.set(v.id, id);
  }

  const crossTile: CrossTileDependency[] = [];
  for (const seg of segments) {
    const [a, b] = endpoints(seg.geometry);
    const from = findOrCreateNode(a, seg.tileId);
    const to = findOrCreateNode(b, seg.tileId);
    edges.push({ id: `E-${seg.id}`, segmentId: seg.id, fromNode: from, toNode: to, tileId: seg.tileId });

    // 跨瓦片依赖：管段自身跨瓦片，或其端点吸附到邻瓦片阀门
    const crossesBoundary = seg.geometry.points.some(
      (p, i) => i > 0 && Math.sign(p.x - 100) !== Math.sign(seg.geometry.points[i - 1].x - 100) && p.x !== 100,
    ) || new Set(seg.geometry.points.map((p) => (p.x <= 100 ? 'TILE_A' : 'TILE_B'))).size > 1;
    if (crossesBoundary) {
      const otherTile = seg.tileId === 'TILE_A' ? 'TILE_B' : 'TILE_A';
      const valveAtJoint = valves.find(
        (v) => distance(v.position, a) <= toleranceM || distance(v.position, b) <= toleranceM,
      );
      crossTile.push({
        fromTile: seg.tileId,
        toTile: otherTile,
        viaSegmentId: seg.id,
        viaValveId: valveAtJoint?.id,
      });
    }
  }

  // 连接度 > 2 的端点升级为 junction
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.fromNode, (degree.get(e.fromNode) ?? 0) + 1);
    degree.set(e.toNode, (degree.get(e.toNode) ?? 0) + 1);
  }
  for (const n of nodes) {
    if (n.kind === 'endpoint' && (degree.get(n.id) ?? 0) > 1) n.kind = 'junction';
  }

  const network: NetworkVersion = {
    networkId: `NET-${packageId}`,
    version,
    basedOnPackage: packageId,
    correctionId,
    toleranceM,
    nodes,
    edges,
    createdAt: new Date().toISOString(),
  };
  return { network, crossTile: dedupeCrossTile(crossTile) };
}

function dedupeCrossTile(items: CrossTileDependency[]): CrossTileDependency[] {
  const seen = new Set<string>();
  const out: CrossTileDependency[] = [];
  for (const c of items) {
    const key = `${c.fromTile}->${c.toTile}:${c.viaSegmentId}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

/** 下游闭包：从变更管段出发，沿网络边与阀门连接扩展，并强制纳入跨瓦片依赖 */
export function downstreamClosure(
  seedSegmentIds: string[],
  network: NetworkVersion,
  crossTile: CrossTileDependency[],
): { closure: string[]; tiles: string[]; crossTileHits: CrossTileDependency[] } {
  const edgeBySegment = new Map(network.edges.map((e) => [e.segmentId, e]));
  const adjacency = new Map<string, Set<string>>();
  for (const e of network.edges) {
    for (const [a, b] of [[e.fromNode, e.toNode], [e.toNode, e.fromNode]] as const) {
      if (!adjacency.has(a)) adjacency.set(a, new Set());
      adjacency.get(a)!.add(b);
    }
  }
  const closure = new Set(seedSegmentIds);
  const queue = [...seedSegmentIds];
  while (queue.length) {
    const segId = queue.shift()!;
    const edge = edgeBySegment.get(segId);
    if (!edge) continue;
    for (const nodeId of [edge.fromNode, edge.toNode]) {
      for (const neighborNode of adjacency.get(nodeId) ?? []) {
        for (const e of network.edges) {
          if ((e.fromNode === neighborNode || e.toNode === neighborNode) && !closure.has(e.segmentId)) {
            closure.add(e.segmentId);
            queue.push(e.segmentId);
          }
        }
      }
    }
  }

  // 跨瓦片依赖：闭包内管段触及的跨区边，对侧管段必须入闭包
  const hits = crossTile.filter((c) => closure.has(c.viaSegmentId));
  for (const hit of hits) {
    const farSide = network.edges.filter((e) => e.tileId === hit.toTile);
    for (const e of farSide) {
      if (!closure.has(e.segmentId)) {
        closure.add(e.segmentId);
        queue.push(e.segmentId);
      }
    }
  }

  const tiles = [...new Set(network.edges.filter((e) => closure.has(e.segmentId)).map((e) => e.tileId))];
  return { closure: [...closure].sort(), tiles, crossTileHits: hits };
}
