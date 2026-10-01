// High-performance 2D Grid A* Pathfinding with Line-of-Sight Smoothing and Obstacle Clearance

export function buildNavGrid({ shelfUnits = [], constructionZones = [], sampleBooths = [], bounds = { minX: -28, maxX: 28, minZ: -28, maxZ: 28 }, cellSize = 0.5, margin = 0.55 }) {
  const minX = bounds.minX, maxX = bounds.maxX, minZ = bounds.minZ, maxZ = bounds.maxZ;
  const cols = Math.floor((maxX - minX) / cellSize) + 1;
  const rows = Math.floor((maxZ - minZ) / cellSize) + 1;
  const walkable = new Uint8Array(cols * rows);
  const clearance = new Uint8Array(cols * rows); // Distance clearance to obstacles
  
  // Initialize all interior cells as walkable
  walkable.fill(1);

  const markBlocked = (x, z, w, d) => {
    const halfW = w / 2 + margin;
    const halfD = d / 2 + margin;
    const minCx = Math.max(0, Math.floor((x - halfW - minX) / cellSize));
    const maxCx = Math.min(cols - 1, Math.floor((x + halfW - minX) / cellSize));
    const minR = Math.max(0, Math.floor((z - halfD - minZ) / cellSize));
    const maxR = Math.min(rows - 1, Math.floor((z + halfD - minZ) / cellSize));

    for (let r = minR; r <= maxR; r++) {
      const rowOffset = r * cols;
      for (let c = minCx; c <= maxCx; c++) {
        walkable[rowOffset + c] = 0;
      }
    }
  };

  // 1. Mark shelf units with exact rotated AABB + safety margin
  shelfUnits.forEach(unit => {
    if (!unit || !unit.position) return;
    const rot = unit.userData?.rotY || unit.rotation?.y || 0;
    const cosR = Math.abs(Math.cos(rot));
    const sinR = Math.abs(Math.sin(rot));
    // Base shelf dimension: 8.0m wide by 1.6m deep + margin
    const rawW = 8.6;
    const rawD = 2.2;
    const effW = cosR * rawW + sinR * rawD;
    const effD = sinR * rawW + cosR * rawD;
    markBlocked(unit.position.x, unit.position.z, effW, effD);
  });

  // 2. Mark fixed store landmarks (Checkout counter, Information desk, Basket stack)
  markBlocked(15, -15, 6.8, 3.2);      // Checkout counter area
  markBlocked(-22, -24, 5.4, 4.4);    // Information desk area
  markBlocked(0, -25, 2.2, 2.2);      // Basket stack

  // 3. Mark dynamic construction zones if any
  constructionZones.forEach(cz => {
    if (!cz || !cz.position) return;
    const rad = cz.radius || 2.5;
    markBlocked(cz.position.x, cz.position.z, rad * 2, rad * 2);
  });
  sampleBooths.forEach(booth => {
    if (booth?.position) markBlocked(booth.position.x, booth.position.z, 3.8, 3.8);
  });

  // 4. Perimeter wall buffer (prevent getting stuck into perimeter walls)
  const wallMargin = 1.0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const wx = minX + c * cellSize;
      const wz = minZ + r * cellSize;
      if (wx < minX + wallMargin || wx > maxX - wallMargin ||
          wz < minZ + wallMargin || wz > maxZ - wallMargin) {
        walkable[r * cols + c] = 0;
      }
    }
  }

  // 5. Compute simple clearance field (for path preference away from sharp shelf corners)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (!walkable[idx]) {
        clearance[idx] = 0;
        continue;
      }
      let minClear = 3;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const nr = r + dr, nc = c + dc;
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols || !walkable[nr * cols + nc]) {
            const dist = Math.max(Math.abs(dr), Math.abs(dc));
            if (dist < minClear) minClear = dist;
          }
        }
      }
      clearance[idx] = minClear;
    }
  }

  return { minX, maxX, minZ, maxZ, cellSize, cols, rows, walkable, clearance };
}

export function worldToCell(grid, x, z) {
  const c = Math.round((x - grid.minX) / grid.cellSize);
  const r = Math.round((z - grid.minZ) / grid.cellSize);
  return {
    c: Math.max(0, Math.min(grid.cols - 1, c)),
    r: Math.max(0, Math.min(grid.rows - 1, r))
  };
}

export function cellToWorld(grid, c, r) {
  return {
    x: grid.minX + c * grid.cellSize,
    z: grid.minZ + r * grid.cellSize
  };
}

export function isWalkable(grid, x, z) {
  if (!grid || !grid.walkable) return true;
  const { c, r } = worldToCell(grid, x, z);
  return !!grid.walkable[r * grid.cols + c];
}

export function clampToWalkable(grid, x, z) {
  if (!grid || !grid.walkable) return { x, z };
  const { c, r } = worldToCell(grid, x, z);
  if (grid.walkable[r * grid.cols + c]) return { x, z };

  // Spiral outward to find nearest walkable cell
  const maxD = Math.max(grid.cols, grid.rows);
  for (let d = 1; d < maxD; d++) {
    for (let dc = -d; dc <= d; dc++) {
      for (let dr = -d; dr <= d; dr++) {
        if (Math.abs(dc) !== d && Math.abs(dr) !== d) continue;
        const nc = c + dc, nr = r + dr;
        if (nc < 0 || nr < 0 || nc >= grid.cols || nr >= grid.rows) continue;
        if (grid.walkable[nr * grid.cols + nc]) {
          return cellToWorld(grid, nc, nr);
        }
      }
    }
  }
  return cellToWorld(grid, c, r);
}

// Check if a direct straight ray between two points is clear of obstacles with body radius
export function isLineWalkable(grid, x0, z0, x1, z1, radius = 0.35) {
  if (!grid || !grid.walkable) return true;
  const dist = Math.hypot(x1 - x0, z1 - z0);
  if (dist < 0.05) return true;

  const steps = Math.ceil(dist / (grid.cellSize * 0.5));
  const dx = (x1 - x0) / steps;
  const dz = (z1 - z0) / steps;

  const radSteps = radius > 0.1 ? 2 : 0;
  for (let i = 0; i <= steps; i++) {
    const cx = x0 + dx * i;
    const cz = z0 + dz * i;
    if (!isWalkable(grid, cx, cz)) return false;
    
    // Check radius perpendicular offsets
    if (radSteps > 0 && dist > 0.1) {
      const nx = -dz / (dist / steps) * radius;
      const nz = dx / (dist / steps) * radius;
      if (!isWalkable(grid, cx + nx, cz + nz) || !isWalkable(grid, cx - nx, cz - nz)) {
        return false;
      }
    }
  }
  return true;
}

// String-pulling path smoothing.
// Walks forward from the current anchor and keeps extending while the straight
// line stays walkable (linear number of line checks instead of quadratic).
export function smoothPath(grid, rawPath) {
  if (!rawPath || rawPath.length <= 2) return rawPath || [];

  const smoothed = [rawPath[0]];
  let currentIdx = 0;
  const last = rawPath.length - 1;

  while (currentIdx < last) {
    const from = rawPath[currentIdx];
    let furthestVisible = currentIdx + 1;
    for (let checkIdx = currentIdx + 2; checkIdx <= last; checkIdx++) {
      const to = rawPath[checkIdx];
      if (isLineWalkable(grid, from.x, from.z, to.x, to.z, 0.3)) {
        furthestVisible = checkIdx;
      } else {
        break;
      }
    }
    smoothed.push(rawPath[furthestVisible]);
    currentIdx = furthestVisible;
  }

  return smoothed;
}

// Reusable per-grid A* scratch buffers (avoids allocating ~150KB per search)
function getScratch(grid) {
  const n = grid.cols * grid.rows;
  if (!grid._astar || grid._astar.n !== n) {
    grid._astar = {
      n,
      gScore: new Float32Array(n),
      cameFrom: new Int32Array(n),
      closed: new Uint32Array(n),   // stamp == searchId -> closed
      seen: new Uint32Array(n),     // stamp == searchId -> gScore/cameFrom valid
      searchId: 0,
      heapKeys: new Int32Array(n * 8 + 16),
      heapF: new Float32Array(n * 8 + 16)
    };
  }
  return grid._astar;
}

const NEIGHBORS = [
  [1, 0, 1.0], [-1, 0, 1.0], [0, 1, 1.0], [0, -1, 1.0],
  [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]
];

// Fast A* Pathfinding (binary-heap open set)
export function findPath(grid, start, goal) {
  if (!grid || !grid.walkable) {
    return [{ x: goal.x, z: goal.z }];
  }

  const startPt = clampToWalkable(grid, start.x, start.z);
  const goalPt = clampToWalkable(grid, goal.x, goal.z);

  const startCell = worldToCell(grid, startPt.x, startPt.z);
  const goalCell = worldToCell(grid, goalPt.x, goalPt.z);

  const cols = grid.cols;
  const rows = grid.rows;
  const walkable = grid.walkable;
  const clearance = grid.clearance;

  const startKey = startCell.r * cols + startCell.c;
  const goalKey = goalCell.r * cols + goalCell.c;

  if (startKey === goalKey) {
    return [{ x: goalPt.x, z: goalPt.z }];
  }

  const S = getScratch(grid);
  S.searchId = (S.searchId + 1) >>> 0;
  if (S.searchId === 0) { S.closed.fill(0); S.seen.fill(0); S.searchId = 1; }
  const id = S.searchId;
  const { gScore, cameFrom, closed, seen, heapKeys, heapF } = S;
  const gc = goalCell.c, gr = goalCell.r;
  const h = (c, r) => Math.hypot(c - gc, r - gr);

  // Binary min-heap with lazy deletion
  let heapSize = 0;
  const push = (k, f) => {
    if (heapSize >= heapKeys.length) return;
    let i = heapSize++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapF[p] <= f) break;
      heapKeys[i] = heapKeys[p]; heapF[i] = heapF[p];
      i = p;
    }
    heapKeys[i] = k; heapF[i] = f;
  };
  const pop = () => {
    const top = heapKeys[0];
    const lastK = heapKeys[--heapSize];
    const lastF = heapF[heapSize];
    let i = 0;
    while (true) {
      let l = 2 * i + 1;
      if (l >= heapSize) break;
      const r = l + 1;
      if (r < heapSize && heapF[r] < heapF[l]) l = r;
      if (heapF[l] >= lastF) break;
      heapKeys[i] = heapKeys[l]; heapF[i] = heapF[l];
      i = l;
    }
    heapKeys[i] = lastK; heapF[i] = lastF;
    return top;
  };

  seen[startKey] = id;
  gScore[startKey] = 0;
  cameFrom[startKey] = -1;
  push(startKey, h(startCell.c, startCell.r));

  let found = false;
  let iterations = 0;
  const maxIterations = cols * rows;

  while (heapSize > 0 && iterations < maxIterations) {
    const currentKey = pop();
    if (closed[currentKey] === id) continue;
    closed[currentKey] = id;
    iterations++;

    if (currentKey === goalKey) { found = true; break; }

    const curR = (currentKey / cols) | 0;
    const curC = currentKey - curR * cols;
    const curG = gScore[currentKey];

    for (let i = 0; i < 8; i++) {
      const nb = NEIGHBORS[i];
      const dc = nb[0], dr = nb[1];
      const nc = curC + dc;
      const nr = curR + dr;

      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;

      const nIdx = nr * cols + nc;
      if (!walkable[nIdx] || closed[nIdx] === id) continue;

      // Prevent cutting directly across tight diagonal corners
      if (dc !== 0 && dr !== 0) {
        if (!walkable[curR * cols + nc] || !walkable[nr * cols + curC]) continue;
      }

      // Small clearance penalty to prefer walking in the middle of aisles
      const clearVal = clearance ? clearance[nIdx] : 2;
      const tentativeG = curG + nb[2] + (clearVal === 1 ? 0.35 : 0);

      if (seen[nIdx] !== id || tentativeG < gScore[nIdx]) {
        seen[nIdx] = id;
        gScore[nIdx] = tentativeG;
        cameFrom[nIdx] = currentKey;
        push(nIdx, tentativeG + h(nc, nr));
      }
    }
  }

  if (!found) {
    // If no complete path to exact goal, return direct clamped goal
    return [{ x: goalPt.x, z: goalPt.z }];
  }

  const path = [];
  let curr = goalKey;
  let guard = 0;
  while (curr !== -1 && guard++ < maxIterations) {
    const r = (curr / cols) | 0;
    const c = curr - r * cols;
    path.push(cellToWorld(grid, c, r));
    if (curr === startKey) break;
    curr = cameFrom[curr];
  }

  path.reverse();

  // Apply smooth string-pulling so agents walk smoothly without grid artifacts
  return smoothPath(grid, path);
}
