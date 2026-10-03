// One manager: cached navigation, bounded A* refreshes and allocation-free slab tests.
// Geometry is supplied by the game; this module has no renderer/audio/physics dependencies.
import { findPath, isLineWalkable, cellToWorld, worldToCell } from './pathfinding.js';

export const MANAGER = Object.freeze({ radius: 0.48, eyeY: 2.3, height: 2.56,
  range: 19, halfFov: Math.PI * 50 / 180, patrolSpeed: 2.1, searchSpeed: 4.3,
  chargeSpeed: 10, catchDistance: 1.15 });

// Return first intersection fraction, or Infinity. Rotated X/Z boxes, not an
// all-scene raycast through hundreds of products, labels and decorative meshes.
export function boxEntry(x0, z0, x1, z1, box, padding = 0, y0 = null, y1 = y0) {
  const c = Math.cos(box.rot || 0), s = Math.sin(box.rot || 0);
  const ox = x0 - box.x, oz = z0 - box.z;
  const x = ox * c - oz * s, z = ox * s + oz * c;
  const dx = (x1 - x0) * c - (z1 - z0) * s;
  const dz = (x1 - x0) * s + (z1 - z0) * c;
  let enter = 0, leave = 1;
  const hx = box.hx + padding, hz = box.hz + padding;
  if (Math.abs(dx) < 1e-9) { if (Math.abs(x) > hx) return Infinity; }
  else {
    const a = (-hx - x) / dx, b = (hx - x) / dx;
    enter = Math.max(enter, Math.min(a, b)); leave = Math.min(leave, Math.max(a, b));
  }
  if (Math.abs(dz) < 1e-9) { if (Math.abs(z) > hz) return Infinity; }
  else {
    const a = (-hz - z) / dz, b = (hz - z) / dz;
    enter = Math.max(enter, Math.min(a, b)); leave = Math.min(leave, Math.max(a, b));
  }
  if (y0 !== null) {
    const dy = y1 - y0;
    if (Math.abs(dy) < 1e-9) { if (y0 < box.minY || y0 > box.maxY) return Infinity; }
    else {
      const a = (box.minY - y0) / dy, b = (box.maxY - y0) / dy;
      enter = Math.max(enter, Math.min(a, b)); leave = Math.min(leave, Math.max(a, b));
    }
  }
  return enter <= leave ? enter : Infinity;
}

export function sightFraction(from, to, boxes, eyeY = MANAGER.eyeY, targetY = eyeY) {
  let nearest = 1;
  for (const box of boxes) nearest = Math.min(nearest,
    boxEntry(from.x, from.z, to.x, to.z, box, 0, eyeY, targetY));
  return nearest;
}

export function canManagerSee(position, yaw, player, boxes) {
  const dx = player.x - position.x, dz = player.z - position.z;
  const dist = Math.hypot(dx, dz);
  if (dist > MANAGER.range) return false;
  if (dist > 0.01 && (dx * Math.sin(yaw) + dz * Math.cos(yaw)) / dist < Math.cos(MANAGER.halfFov)) return false;
  return sightFraction(position, player, boxes, MANAGER.eyeY, player.eyeY ?? 2.6) >= 0.999;
}

export function createManagerGrid(boxes) {
  const minX = -29, maxX = 29, minZ = -29, maxZ = 29, cellSize = 0.4;
  const cols = 146, rows = 146;
  const grid = { minX, maxX, minZ, maxZ, cellSize, cols, rows,
    walkable: new Uint8Array(cols * rows), clearance: new Uint8Array(cols * rows) };
  grid.walkable.fill(1); grid.clearance.fill(2);
  // Extra half-cell diagonal prevents A* edges shaving inflated corners.
  const pad = MANAGER.radius + cellSize * Math.SQRT1_2;
  for (const box of boxes) {
    if (box.maxY <= 0.06 || box.minY >= MANAGER.height) continue;
    const c = Math.abs(Math.cos(box.rot || 0)), s = Math.abs(Math.sin(box.rot || 0));
    const ex = c * (box.hx + pad) + s * (box.hz + pad);
    const ez = s * (box.hx + pad) + c * (box.hz + pad);
    const c0 = Math.max(0, Math.floor((box.x - ex - minX) / cellSize));
    const c1 = Math.min(cols - 1, Math.ceil((box.x + ex - minX) / cellSize));
    const r0 = Math.max(0, Math.floor((box.z - ez - minZ) / cellSize));
    const r1 = Math.min(rows - 1, Math.ceil((box.z + ez - minZ) / cellSize));
    for (let r = r0; r <= r1; r++) for (let col = c0; col <= c1; col++) {
      const x = minX + col * cellSize, z = minZ + r * cellSize;
      if (boxEntry(x, z, x, z, box, pad) === 0) grid.walkable[r * cols + col] = 0;
    }
  }
  return grid;
}

const inside = (grid, p) => p.x >= grid.minX && p.x <= grid.maxX && p.z >= grid.minZ && p.z <= grid.maxZ;
const CONNECT_NEIGHBORS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function createManagerAI({ boxes, spawn = { x: -25, z: -16 }, random = Math.random }) {
  let grid = createManagerGrid(boxes);
  // Only use the connected component of the manager's spawn. Unreachable goals
  // select the closest REACHABLE cell; there is never a direct-wall fallback.
  let reachable = [];
  const position = { x: spawn.x, z: spawn.z };
  const state = { position, yaw: 0, mode: 'patrol', remaining: 0, visible: false,
    moving: false, distanceMoved: 0, cooldown: 0 };
  let path = [], pathIndex = 0, target = null, lastSeen = null;
  let repath = 0, perception = 0, wait = 0, huntElapsed = 0, huntDuration = 0;
  let lostFor = 0, scanTime = 0, scanYaw = 0;
  const sensePeriod = 0.08;

  function connect() {
    const { c, r } = worldToCell(grid, position.x, position.z);
    let start = r * grid.cols + c, best = Infinity;
    if (!grid.walkable[start]) {
      for (let i = 0; i < grid.walkable.length; i++) if (grid.walkable[i]) {
        const p = cellToWorld(grid, i % grid.cols, (i / grid.cols) | 0);
        const d = Math.hypot(p.x - position.x, p.z - position.z);
        if (d < best) { best = d; start = i; }
      }
    }
    const seen = new Uint8Array(grid.walkable.length), queue = [start]; seen[start] = 1;
    for (let i = 0; i < queue.length; i++) {
      const k = queue[i], col = k % grid.cols, row = (k / grid.cols) | 0;
      for (const [dc, dr] of CONNECT_NEIGHBORS) {
        const nc = col + dc, nr = row + dr, n = nr * grid.cols + nc;
        if (nc < 0 || nr < 0 || nc >= grid.cols || nr >= grid.rows || seen[n] || !grid.walkable[n]) continue;
        seen[n] = 1; queue.push(n);
      }
    }
    reachable = queue;
  }
  function nearest(point) {
    let key = reachable[0], best = Infinity;
    for (const k of reachable) {
      const x = grid.minX + (k % grid.cols) * grid.cellSize;
      const z = grid.minZ + ((k / grid.cols) | 0) * grid.cellSize;
      const d = (x - point.x) ** 2 + (z - point.z) ** 2;
      if (d < best) { best = d; key = k; }
    }
    return cellToWorld(grid, key % grid.cols, (key / grid.cols) | 0);
  }
  function clearMove(from, to) {
    if (!inside(grid, from) || !inside(grid, to)) return false;
    for (const box of boxes) if (box.maxY > 0.06 && box.minY < MANAGER.height &&
      boxEntry(from.x, from.z, to.x, to.z, box, MANAGER.radius) !== Infinity) return false;
    return true;
  }
  function pickPatrol() {
    for (let i = 0; i < 12; i++) {
      const k = reachable[Math.min(reachable.length - 1, Math.floor(random() * reachable.length))];
      const p = cellToWorld(grid, k % grid.cols, (k / grid.cols) | 0);
      if (Math.hypot(p.x - position.x, p.z - position.z) >= 8) { target = p; break; }
    }
    target ||= nearest({ x: -position.x, z: -position.z });
    path = []; pathIndex = 0; repath = 0;
  }
  function route() {
    repath = state.mode === 'charge' ? 0.25 : 0.8;
    if (!target) return;
    const goal = nearest(target);
    path = clearMove(position, goal) && isLineWalkable(grid, position.x, position.z, goal.x, goal.z, 0)
      ? [goal] : findPath(grid, position, goal, { strict: true, smoothingRadius: 0 });
    pathIndex = 0;
    if (path.length > 1 && clearMove(position, path[1])) pathIndex = 1;
    // First point is the nearby cell centre. Don't skip it blindly at a corner.
    while (pathIndex < path.length && Math.hypot(path[pathIndex].x - position.x, path[pathIndex].z - position.z) < 0.04) pathIndex++;
  }
  function turn(yaw, dt, speed = 5) {
    const d = Math.atan2(Math.sin(yaw - state.yaw), Math.cos(yaw - state.yaw));
    state.yaw += Math.max(-speed * dt, Math.min(speed * dt, d));
  }
  connect(); Object.assign(position, nearest(spawn)); pickPatrol();

  return {
    state,
    beginHunt(duration = 25 + random() * 5) {
      if (state.mode !== 'patrol' || state.cooldown > 0) return false;
      huntDuration = Math.max(25, Math.min(30, duration)); huntElapsed = 0;
      state.remaining = huntDuration; state.mode = 'search'; state.visible = false;
      lastSeen = null; lostFor = 0; perception = 0; repath = 0; wait = 0;
      return true;
    },
    finish() {
      state.mode = 'patrol'; state.remaining = 0; state.visible = false; state.cooldown = 7;
      lastSeen = null; lostFor = 0; wait = 0; pickPatrol();
    },
    replaceBoxes(nextBoxes) {
      boxes = nextBoxes; grid = createManagerGrid(boxes); connect();
      path = []; pathIndex = 0; repath = 0;
      // Never teleport out of an obstruction introduced by another event.
    },
    update(dt, player) {
      state.moving = false; state.distanceMoved = 0;
      if (state.mode === 'caught') return null;
      const hunting = state.mode !== 'patrol';
      if (hunting) {
        huntElapsed += Math.max(0, dt); state.remaining = Math.max(0, huntDuration - huntElapsed);
        // Absolute event limit wins even over a charge/catch on this frame.
        if (state.remaining <= 1e-6) { this.finish(); return 'escaped'; }
      }
      state.cooldown = Math.max(0, state.cooldown - dt);
      perception -= dt; repath -= dt;
      if (hunting && perception <= 0) {
        perception = sensePeriod;
        state.visible = canManagerSee(position, state.yaw, player, boxes);
        if (state.visible) {
          if (state.mode !== 'charge') repath = 0;
          wait = 0;
          lastSeen = { x: player.x, z: player.z }; state.mode = 'charge'; lostFor = 0;
          // Short intercept only while actually seeing the player, and only
          // if the lead point is reachable without cutting a fixture corner.
          const lead = { x: player.x + (player.vx || 0) * 0.12, z: player.z + (player.vz || 0) * 0.12 };
          target = clearMove(player, lead) ? lead : lastSeen;
        } else if (lastSeen) target = lastSeen;
      }
      if (hunting && !state.visible) {
        lostFor += dt;
        if (lostFor > 0.45) state.mode = 'search';
      }
      // Catch also needs CURRENT, unobstructed sight: no through-shelf catches,
      // and no stale 80ms perception result when the player ducks behind cover.
      if (hunting && Math.hypot(player.x - position.x, player.z - position.z) <= MANAGER.catchDistance &&
          canManagerSee(position, state.yaw, player, boxes)) {
        state.mode = 'caught'; state.visible = true; return 'caught';
      }
      const stepDt = Math.min(Math.max(dt, 0), 0.1); // No tunnelling after a slow/tab frame.
      wait -= stepDt;
      if (wait > 0) {
        scanTime += stepDt; turn(scanYaw + Math.sin(scanTime * 2.3) * 1.1, stepDt);
        return null;
      }
      if (!target) pickPatrol();
      if (repath <= 0) route();
      let budget = (state.mode === 'charge' ? MANAGER.chargeSpeed : hunting ? MANAGER.searchSpeed : MANAGER.patrolSpeed) * stepDt;
      while (budget > 0.001 && pathIndex < path.length) {
        // A* is already radius-inflated; exact swept checks guard every step,
        // including dynamic obstacles and the start-cell connector.
        const next = path[pathIndex], dx = next.x - position.x, dz = next.z - position.z, d = Math.hypot(dx, dz);
        if (d < 0.015) { pathIndex++; continue; }
        const travel = Math.min(d, budget), end = { x: position.x + dx / d * travel, z: position.z + dz / d * travel };
        if (!clearMove(position, end)) { path = []; pathIndex = 0; repath = 0; break; }
        turn(Math.atan2(dx, dz), stepDt, state.mode === 'charge' ? 12 : 6);
        position.x = end.x; position.z = end.z; budget -= travel;
        state.distanceMoved += travel; state.moving = true;
        if (travel >= d - 0.001) pathIndex++;
      }
      if (pathIndex >= path.length && repath > 0) {
        if (hunting && state.visible) { repath = 0; return null; }
        if (hunting && lastSeen) { lastSeen = null; target = null; }
        else target = null;
        scanYaw = state.yaw; scanTime = 0; wait = hunting ? 0.5 : 0.65;
      }
      return null;
    },
    get boxes() { return boxes; },
    get grid() { return grid; },
    clearMove
  };
}
