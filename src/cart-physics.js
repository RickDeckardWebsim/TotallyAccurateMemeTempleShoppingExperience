// Player cart physics.
//
// Three pieces, all keyed to the player's cart (cart3D):
//  1. Basket contents ("cart jenga"): items in the cart live in a small
//     physics world of their own, in cart-local space. They settle, stack and
//     then fall asleep, so pushing the cart around never disturbs them. A new
//     item landing on them, an item being taken out, or a hard bump into a
//     shelf wakes them up again.
//  2. Hull: a hollow kinematic body in the main world that follows the cart.
//     Thrown items bounce off its walls or drop in through the open top, and
//     loose items on the floor get nudged aside. Anything that ends up inside
//     the basket is handed over to the basket world.
//  3. Shelf/wall collision for the attached cart: the cart's footprint is
//     tested against static scenery. Walking it into something stops the
//     player, and turning it into something stops the swing.
import * as THREE from 'three';
import * as CANNON from 'cannon-es';

/* @tweakable Size multiplier for the player's shopping cart */
export const CART_SCALE = 1.4;
const S = CART_SCALE;

// Basket interior in cart3D local space. The wire model is authored at scale
// 1 (walls at x = ±0.36, z = ±0.54, floor 0.36, rim 0.92) and scaled by S.
export const CART_BASKET = {
    floorY: 0.365 * S,
    rimY: 0.92 * S,
    halfW: 0.35 * S,
    halfL: 0.53 * S,
};

// Where the attached cart sits: the handle keeps the same reach as the
// unscaled cart, so the bigger basket extends further forward.
export const CART_FOLLOW_DIST = 1.5 + 0.72 * (S - 1);

// Raises the cart baby so it still sits on the (higher) basket floor.
export const CART_BABY_LIFT = 0.36 * (S - 1);

const HULL_GROUP = 16;
const BASKET_TOP_MARGIN = 0.6; // invisible walls above the rim keep heaps in
const SLEEP_SPEED = 0.25;
const FORCE_SLEEP_AFTER = 4; // seconds awake before a slow body is frozen

let ctx = null;
let cartWorld = null;
const cartItems = new Set();
let babyBody = null;
let babyRef = null;

let hull = null;
let hullWorld = null;
let hullActive = false;
const hullPrevPos = new THREE.Vector3();
let hullPrevYaw = 0;
let hullHasPrev = false;
const hullVel = new THREE.Vector3();
let maskedHeldBody = null;

let cartYaw = null;
let ghostUntilFree = false;
let lastBumpAt = 0;

const _m = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _quatInv = new THREE.Quaternion();
const _scl = new THREE.Vector3();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _euler = new THREE.Euler();

/**
 * ctx: {
 *   getWorld, getCart3D, getCartObject, getAllItems, getCollectedItems,
 *   getHeldItem, getCartBaby, isItemDropping(item), massOf(item),
 *   gravity, ignoredBodies() -> CANNON.Body[],
 *   onCatch(item, localPos, localQuat, localVel), onBump(strength)
 * }
 */
export function initCartPhysics(context) {
    ctx = context;
}

function ensureCartWorld() {
    if (cartWorld) return cartWorld;
    cartWorld = new CANNON.World({ gravity: new CANNON.Vec3(0, -(ctx?.gravity || 9.8), 0) });
    cartWorld.allowSleep = true;
    cartWorld.solver.iterations = 12;
    cartWorld.defaultContactMaterial.friction = 0.7;
    cartWorld.defaultContactMaterial.restitution = 0.04;

    const B = CART_BASKET, T = 0.12;
    const top = B.rimY + BASKET_TOP_MARGIN;
    const wallHalfH = (top - B.floorY) / 2 + T;
    const wallY = (top + B.floorY) / 2;
    const shell = new CANNON.Body({ mass: 0 });
    shell.addShape(new CANNON.Box(new CANNON.Vec3(B.halfW + T, T, B.halfL + T)), new CANNON.Vec3(0, B.floorY - T, 0));
    shell.addShape(new CANNON.Box(new CANNON.Vec3(T, wallHalfH, B.halfL + T)), new CANNON.Vec3(-(B.halfW + T), wallY, 0));
    shell.addShape(new CANNON.Box(new CANNON.Vec3(T, wallHalfH, B.halfL + T)), new CANNON.Vec3(B.halfW + T, wallY, 0));
    shell.addShape(new CANNON.Box(new CANNON.Vec3(B.halfW + T, wallHalfH, T)), new CANNON.Vec3(0, wallY, -(B.halfL + T)));
    shell.addShape(new CANNON.Box(new CANNON.Vec3(B.halfW + T, wallHalfH, T)), new CANNON.Vec3(0, wallY, B.halfL + T));
    cartWorld.addBody(shell);
    return cartWorld;
}

function itemHalfExtents(item) {
    const B = CART_BASKET;
    const [w, h, d] = item.size || [0.3, 0.3, 0.3];
    // Slightly undersized so neighbours rest against each other without jitter,
    // and never wider than the basket itself.
    return new CANNON.Vec3(
        Math.min(w * 0.48, B.halfW - 0.01),
        Math.min(h * 0.48, (B.rimY + BASKET_TOP_MARGIN - B.floorY) / 2),
        Math.min(d * 0.48, B.halfL - 0.01)
    );
}

function clampIntoBasket(body) {
    const B = CART_BASKET;
    const he = body.shapes[0].halfExtents;
    const r = Math.min(Math.max(he.x, he.z), B.halfW);
    body.position.x = THREE.MathUtils.clamp(body.position.x, -B.halfW + r, B.halfW - r);
    body.position.z = THREE.MathUtils.clamp(body.position.z, -B.halfL + r, B.halfL - r);
    if (body.position.y < B.floorY + he.y * 0.5) body.position.y = B.floorY + he.y;
}

/** Give an in-cart item a basket body at a cart-local pose. Starts awake. */
export function addItemToCart(item, localPos, localQuat = null, localVel = null) {
    if (!item) return;
    ensureCartWorld();
    removeItemBody(item);
    const body = new CANNON.Body({
        mass: Math.max(0.2, ctx?.massOf ? ctx.massOf(item) : 1),
        shape: new CANNON.Box(itemHalfExtents(item)),
    });
    body.allowSleep = true;
    body.sleepSpeedLimit = SLEEP_SPEED;
    body.sleepTimeLimit = 0.4;
    body.linearDamping = 0.2;
    body.angularDamping = 0.5;
    body.position.set(localPos.x, localPos.y, localPos.z);
    if (localQuat) body.quaternion.set(localQuat.x, localQuat.y, localQuat.z, localQuat.w);
    if (localVel) {
        const sp = Math.hypot(localVel.x, localVel.y, localVel.z);
        const k = sp > 5 ? 5 / sp : 1;
        body.velocity.set(localVel.x * k, localVel.y * k, localVel.z * k);
    }
    clampIntoBasket(body);
    cartWorld.addBody(body);
    item.cartBody = body;
    item._cartAwakeFor = 0;
    cartItems.add(item);
}

function removeItemBody(item) {
    if (item?.cartBody) {
        try { cartWorld?.removeBody(item.cartBody); } catch (_) {}
        item.cartBody = null;
    }
    cartItems.delete(item);
}

/** Controlled checkout transfer; inventory/list ownership stays with the cart. */
export function removeItemFromCart(item) { removeItemBody(item); }

/** Wake every basket item; kick adds a small random shove (a bump). */
export function wakeCartItems(kick = 0) {
    for (const item of cartItems) {
        const b = item.cartBody;
        if (!b) continue;
        b.wakeUp();
        item._cartAwakeFor = 0;
        if (kick > 0) {
            b.velocity.x += (Math.random() - 0.5) * kick;
            b.velocity.z += (Math.random() - 0.5) * kick;
            b.velocity.y += Math.random() * kick * 0.4;
            b.angularVelocity.x += (Math.random() - 0.5) * kick * 2;
            b.angularVelocity.z += (Math.random() - 0.5) * kick * 2;
        }
    }
}

/**
 * How a shopper would put an item down in the cart: tall things laid on
 * their side with the long edge running front-to-back, flat things flat.
 */
export function cartRestingQuat(item, out = new THREE.Quaternion()) {
    const [w, h, d] = item.size || [0.3, 0.3, 0.3];
    _euler.set(0, 0, 0, 'YXZ');
    if (h > Math.max(w, d) * 1.15) _euler.x = Math.PI / 2;      // height -> along z
    else if (w > d * 1.15) _euler.y = Math.PI / 2;              // width -> along z
    _euler.y += (Math.random() - 0.5) * 0.25;
    _euler.z = (Math.random() - 0.5) * 0.08;
    return out.setFromEuler(_euler);
}

// Half extents of an item's box in cart axes for a given orientation.
function orientedHalfExtents(item, quat, out) {
    const he = itemHalfExtents(item);
    _m.makeRotationFromQuaternion(quat || _q.identity());
    const e = _m.elements;
    out.x = Math.abs(e[0]) * he.x + Math.abs(e[4]) * he.y + Math.abs(e[8]) * he.z;
    out.y = Math.abs(e[1]) * he.x + Math.abs(e[5]) * he.y + Math.abs(e[9]) * he.z;
    out.z = Math.abs(e[2]) * he.x + Math.abs(e[6]) * he.y + Math.abs(e[10]) * he.z;
    return out;
}

const _he = new THREE.Vector3();
/**
 * Cart-local point to let an item go so it drops into place: the lowest open
 * spot near (x, z), the way a shopper fills the gaps before stacking higher.
 */
export function cartDropPoint(item, x, z, out = new THREE.Vector3(), quat = null) {
    const B = CART_BASKET;
    const he = orientedHalfExtents(item, quat, _he);
    const rx = Math.min(he.x, B.halfW), rz = Math.min(he.z, B.halfL);
    const boxes = [];
    for (const other of cartItems) {
        if (other === item || !other.cartBody) continue;
        other.cartBody.updateAABB();
        boxes.push(other.cartBody.aabb);
    }
    if (babyBody) { babyBody.updateAABB(); boxes.push(babyBody.aabb); }
    const topAt = (cx, cz) => {
        let top = B.floorY;
        for (const a of boxes) {
            if (a.lowerBound.x >= cx + rx * 0.9 || a.upperBound.x <= cx - rx * 0.9) continue;
            if (a.lowerBound.z >= cz + rz * 0.9 || a.upperBound.z <= cz - rz * 0.9) continue;
            top = Math.max(top, a.upperBound.y);
        }
        return top;
    };
    const minX = -B.halfW + rx, maxX = B.halfW - rx, minZ = -B.halfL + rz, maxZ = B.halfL - rz;
    x = minX < maxX ? THREE.MathUtils.clamp(x, minX, maxX) : 0;
    z = minZ < maxZ ? THREE.MathUtils.clamp(z, minZ, maxZ) : 0;
    let bestX = x, bestZ = z, bestTop = topAt(x, z), bestScore = bestTop;
    const NX = 5, NZ = 7;
    for (let i = 0; i < NX; i++) {
        const cx = minX < maxX ? minX + (maxX - minX) * i / (NX - 1) : 0;
        for (let j = 0; j < NZ; j++) {
            const cz = minZ < maxZ ? minZ + (maxZ - minZ) * j / (NZ - 1) : 0;
            const top = topAt(cx, cz);
            // Lower is better; aim still matters a little.
            const score = top + 0.12 * Math.hypot(cx - x, cz - z);
            if (score < bestScore - 1e-4) { bestScore = score; bestTop = top; bestX = cx; bestZ = cz; }
        }
    }
    return out.set(bestX, bestTop + he.y + 0.04, bestZ);
}

function syncBaby() {
    const baby = ctx?.getCartBaby ? ctx.getCartBaby() : null;
    if (baby === babyRef) return;
    babyRef = baby;
    if (babyBody) { try { cartWorld.removeBody(babyBody); } catch (_) {} babyBody = null; }
    if (!baby) return;
    // Seated baby: legs on the basket floor, head at about 1.18 above the
    // baby group's origin.
    const B = CART_BASKET;
    const topY = baby.position.y + 1.2;
    const halfH = (topY - B.floorY) / 2;
    babyBody = new CANNON.Body({ mass: 0, shape: new CANNON.Box(new CANNON.Vec3(0.2, halfH, 0.24)) });
    babyBody.position.set(baby.position.x, B.floorY + halfH, baby.position.z - 0.02);
    cartWorld.addBody(babyBody);
    wakeCartItems(0);
}

/** Per-frame basket update: adopt/release items, step, sync meshes. */
export function stepCartPhysics(delta, frozen = false) {
    if (!ctx) return;
    ensureCartWorld();
    const cart3D = ctx.getCart3D();

    let removed = false;
    for (const item of cartItems) {
        if (!item.inCart || !cart3D || !item.mesh || item.mesh.parent !== cart3D) {
            removeItemBody(item);
            removed = true;
        }
    }
    if (removed) wakeCartItems(0);

    // Items put into the cart by any other route (gifts, events, ...) get a
    // body where they currently sit and settle from there.
    const collected = ctx.getCollectedItems() || [];
    for (let i = 0; i < collected.length; i++) {
        const item = collected[i];
        if (item && item.inCart && !item.cartBody && cart3D && item.mesh?.parent === cart3D && !ctx.isItemDropping(item)) {
            addItemToCart(item, item.mesh.position, item.mesh.quaternion, null);
        }
    }
    syncBaby();

    // Checkout temporarily removes one body at a time. Keep every other item
    // at its settled pose so reloading cannot overlap a shifted neighbour.
    if (frozen) {
        for (const item of cartItems) {
            item.cartBody.velocity.set(0, 0, 0); item.cartBody.angularVelocity.set(0, 0, 0);
            item.cartBody.sleep();
        }
        return;
    }

    let anyAwake = false;
    for (const item of cartItems) {
        const b = item.cartBody;
        if (b.sleepState === CANNON.Body.SLEEPING) {
            item._cartAwakeFor = 0;
            // Something outside moved the mesh: follow it and let it resettle.
            const p = item.mesh.position;
            if ((p.x - b.position.x) ** 2 + (p.y - b.position.y) ** 2 + (p.z - b.position.z) ** 2 > 1e-4) {
                b.position.set(p.x, p.y, p.z);
                b.quaternion.set(item.mesh.quaternion.x, item.mesh.quaternion.y, item.mesh.quaternion.z, item.mesh.quaternion.w);
                b.velocity.set(0, 0, 0);
                b.angularVelocity.set(0, 0, 0);
                clampIntoBasket(b);
                b.wakeUp();
                item._cartAwakeFor = 0;
                anyAwake = true;
            }
        } else {
            anyAwake = true;
        }
    }
    if (!anyAwake) return;

    const dt = Math.min(delta || 1 / 60, 0.1);
    cartWorld.step(1 / 60, dt, 3);

    const B = CART_BASKET;
    for (const item of cartItems) {
        const b = item.cartBody;
        if (b.sleepState === CANNON.Body.SLEEPING) continue;
        item._cartAwakeFor = (item._cartAwakeFor || 0) + dt;
        if (item._cartAwakeFor > FORCE_SLEEP_AFTER && b.velocity.lengthSquared() < 0.25) b.sleep();
        if (b.position.y < B.floorY - 0.3 || Math.abs(b.position.x) > B.halfW + 0.3 || Math.abs(b.position.z) > B.halfL + 0.3) {
            cartDropPoint(item, 0, 0, _v);
            b.position.set(_v.x, _v.y, _v.z);
            b.velocity.set(0, 0, 0);
            b.angularVelocity.set(0, 0, 0);
        }
        item.mesh.position.set(b.position.x, b.position.y, b.position.z);
        item.mesh.quaternion.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
    }
}

// ---------------------------------------------------------------------------
// Hull in the main world

function buildHull() {
    const h = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC });
    const T = 0.03;
    const wallHalfH = (0.92 - 0.35) * S / 2;
    const wallY = (0.92 + 0.35) * S / 2;
    h.addShape(new CANNON.Box(new CANNON.Vec3(0.37 * S, 0.02, 0.55 * S)), new CANNON.Vec3(0, 0.35 * S, 0));
    h.addShape(new CANNON.Box(new CANNON.Vec3(T, wallHalfH, 0.55 * S)), new CANNON.Vec3(-0.36 * S, wallY, 0));
    h.addShape(new CANNON.Box(new CANNON.Vec3(T, wallHalfH, 0.55 * S)), new CANNON.Vec3(0.36 * S, wallY, 0));
    h.addShape(new CANNON.Box(new CANNON.Vec3(0.37 * S, wallHalfH, T)), new CANNON.Vec3(0, wallY, -0.54 * S));
    h.addShape(new CANNON.Box(new CANNON.Vec3(0.37 * S, wallHalfH, T)), new CANNON.Vec3(0, wallY, 0.54 * S));
    // Bottom tray between the wheels
    h.addShape(new CANNON.Box(new CANNON.Vec3(0.34 * S, 0.02, 0.45 * S)), new CANNON.Vec3(0, 0.16 * S, 0));
    h.collisionFilterGroup = HULL_GROUP;
    h.collisionFilterMask = 1; // player + loose items
    return h;
}

/** Keep the hull on the cart, then catch loose items that fell inside. */
export function updateCartHull(delta, active) {
    if (!ctx) return;
    const world = ctx.getWorld();
    const cart3D = ctx.getCart3D();
    if (!world || !cart3D) return;
    if (hullWorld !== world) {
        if (hull && hullWorld) { try { hullWorld.removeBody(hull); } catch (_) {} }
        hull = buildHull();
        hullWorld = world;
        world.addBody(hull);
        hullHasPrev = false;
        maskedHeldBody = null;
    }

    // The held item is steered by the hand; let it pass through the hull so
    // it never snags on the basket while being carried.
    const held = ctx.getHeldItem();
    const heldBody = held?.body || null;
    if (maskedHeldBody && maskedHeldBody !== heldBody) maskedHeldBody.collisionFilterMask |= HULL_GROUP;
    if (heldBody && maskedHeldBody !== heldBody) heldBody.collisionFilterMask &= ~HULL_GROUP;
    maskedHeldBody = heldBody;

    hullActive = !!active;
    hull.collisionResponse = hullActive;
    if (!hullActive) { hullHasPrev = false; return; }

    cart3D.updateWorldMatrix(true, false);
    cart3D.matrixWorld.decompose(_pos, _quat, _scl);
    const yaw = _euler.setFromQuaternion(_quat, 'YXZ').y;
    const dt = Math.max(delta || 1 / 60, 1 / 240);
    if (hullHasPrev && _pos.distanceToSquared(hullPrevPos) < 2.25) {
        hullVel.copy(_pos).sub(hullPrevPos).divideScalar(dt);
        let dy = yaw - hullPrevYaw;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        hull.angularVelocity.set(0, THREE.MathUtils.clamp(dy / dt, -12, 12), 0);
    } else {
        hullVel.set(0, 0, 0);
        hull.angularVelocity.set(0, 0, 0);
    }
    if (hullVel.lengthSq() > 144) hullVel.setLength(12);
    hullPrevPos.copy(_pos);
    hullPrevYaw = yaw;
    hullHasPrev = true;
    hull.position.set(_pos.x, _pos.y, _pos.z);
    hull.quaternion.set(_quat.x, _quat.y, _quat.z, _quat.w);
    hull.velocity.set(hullVel.x, hullVel.y, hullVel.z);
    hull.aabbNeedsUpdate = true;

    catchLooseItems();
}

function catchLooseItems() {
    const items = ctx.getAllItems() || [];
    const held = ctx.getHeldItem();
    const B = CART_BASKET;
    _inv.copy(ctx.getCart3D().matrixWorld).invert();
    _quatInv.copy(_quat).invert();
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const body = item?.body;
        if (!body || item === held || item.inCart || item.isStatic || item.isCustomerHeld || item.inCustomerCart) continue;
        if (body.type !== CANNON.Body.DYNAMIC) continue;
        const dx = body.position.x - _pos.x, dz = body.position.z - _pos.z;
        if (dx * dx + dz * dz > 6.25) { item._cartPrevLocal = null; continue; }
        const local = _v.set(body.position.x, body.position.y, body.position.z).applyMatrix4(_inv);
        let caught = Math.abs(local.x) < B.halfW && Math.abs(local.z) < B.halfL &&
            local.y > B.floorY - 0.05 && local.y < B.rimY;
        // Fast throws can cross the rim between two frames; test the path too.
        const prev = item._cartPrevLocal;
        if (!caught && prev && prev.y >= B.rimY && local.y < B.rimY) {
            const t = (prev.y - B.rimY) / Math.max(1e-6, prev.y - local.y);
            const cx = prev.x + (local.x - prev.x) * t;
            const cz = prev.z + (local.z - prev.z) * t;
            if (Math.abs(cx) < B.halfW && Math.abs(cz) < B.halfL) {
                local.set(cx, B.rimY - 0.05, cz);
                caught = true;
            }
        }
        if (!caught) {
            if (!item._cartPrevLocal) item._cartPrevLocal = new THREE.Vector3();
            item._cartPrevLocal.copy(local);
            continue;
        }
        item._cartPrevLocal = null;
        const localVel = _v2.set(body.velocity.x - hullVel.x, body.velocity.y - hullVel.y, body.velocity.z - hullVel.z)
            .applyQuaternion(_quatInv);
        const localQuat = _q.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w)
            .premultiply(_quatInv);
        ctx.onCatch(item, local.clone(), localQuat.clone(), localVel.clone());
    }
}

// ---------------------------------------------------------------------------
// Attached cart vs shelves and walls (2D footprint test)

const obstacleCache = new WeakMap();
const _obstacles = [];

function bodyBoxes(body) {
    const p = body.position, q = body.quaternion;
    let c = obstacleCache.get(body);
    if (c && c.px === p.x && c.py === p.y && c.pz === p.z && c.qy === q.y && c.qw === q.w && c.n === body.shapes.length) return c.boxes;
    const boxes = [];
    const ax = new CANNON.Vec3(), ay = new CANNON.Vec3(), az = new CANNON.Vec3();
    const wq = new CANNON.Quaternion();
    const center = new CANNON.Vec3();
    for (let i = 0; i < body.shapes.length; i++) {
        const shape = body.shapes[i];
        if (shape.type !== CANNON.Shape.types.BOX) continue;
        const he = shape.halfExtents;
        if (Math.max(he.x, he.y, he.z) < 0.08) continue;
        q.mult(body.shapeOrientations[i], wq);
        q.vmult(body.shapeOffsets[i], center);
        center.vadd(p, center);
        wq.vmult(new CANNON.Vec3(1, 0, 0), ax);
        wq.vmult(new CANNON.Vec3(0, 1, 0), ay);
        wq.vmult(new CANNON.Vec3(0, 0, 1), az);
        const yh = Math.abs(ax.y) * he.x + Math.abs(ay.y) * he.y + Math.abs(az.y) * he.z;
        let box;
        if (Math.abs(ay.y) > 0.9) {
            const lx = Math.hypot(ax.x, ax.z) || 1, lz = Math.hypot(az.x, az.z) || 1;
            box = { cx: center.x, cz: center.z, ux: ax.x / lx, uz: ax.z / lx, vx: az.x / lz, vz: az.z / lz, hu: he.x, hv: he.z };
        } else {
            box = {
                cx: center.x, cz: center.z, ux: 1, uz: 0, vx: 0, vz: 1,
                hu: Math.abs(ax.x) * he.x + Math.abs(ay.x) * he.y + Math.abs(az.x) * he.z,
                hv: Math.abs(ax.z) * he.x + Math.abs(ay.z) * he.y + Math.abs(az.z) * he.z,
            };
        }
        box.y0 = center.y - yh;
        box.y1 = center.y + yh;
        box.r = Math.hypot(box.hu, box.hv);
        boxes.push(box);
    }
    c = { px: p.x, py: p.y, pz: p.z, qy: q.y, qw: q.w, n: body.shapes.length, boxes };
    obstacleCache.set(body, c);
    return boxes;
}

function gatherObstacles(world, px, pz, reach) {
    _obstacles.length = 0;
    const ignored = ctx.ignoredBodies ? ctx.ignoredBodies() : [];
    const cartTop = 1.2 * S;
    for (let i = 0; i < world.bodies.length; i++) {
        const body = world.bodies[i];
        if (body.type !== CANNON.Body.STATIC || body === hull || body.collisionResponse === false || body.isTrigger) continue;
        if (!(body.collisionFilterMask & 1) || !(body.collisionFilterGroup & ~4)) continue;
        if (ignored.includes(body)) continue;
        const dx = body.position.x - px, dz = body.position.z - pz;
        const br = body.boundingRadius || 0;
        if (dx * dx + dz * dz > (reach + br) * (reach + br)) continue;
        const boxes = bodyBoxes(body);
        for (let j = 0; j < boxes.length; j++) {
            const b = boxes[j];
            if (b.y1 < 0.1 || b.y0 > cartTop) continue;
            const ddx = b.cx - px, ddz = b.cz - pz;
            if (ddx * ddx + ddz * ddz > (reach + b.r) * (reach + b.r)) continue;
            _obstacles.push(b);
        }
    }
    return _obstacles;
}

// Cart footprint (from just behind the handle to the front wall), a touch
// smaller than the model so tight aisles stay comfortable.
const FOOT_HALF_W = 0.34 * S;
const FOOT_BACK = -0.7 * S;
const FOOT_FRONT = 0.55 * S;

function cartBox(px, pz, yaw, out) {
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const mid = CART_FOLLOW_DIST + (FOOT_BACK + FOOT_FRONT) / 2;
    out.cx = px + fx * mid;
    out.cz = pz + fz * mid;
    out.ux = fz; out.uz = -fx;          // right
    out.vx = fx; out.vz = fz;           // forward
    out.hu = FOOT_HALF_W;
    out.hv = (FOOT_FRONT - FOOT_BACK) / 2;
    return out;
}

// Separating-axis test of two 2D oriented boxes. Returns the push (for a)
// along the axis of least overlap, or null when they do not touch.
function overlap(a, b, res) {
    const axes = [a.ux, a.uz, a.vx, a.vz, b.ux, b.uz, b.vx, b.vz];
    let best = Infinity, nx = 0, nz = 0;
    const dx = b.cx - a.cx, dz = b.cz - a.cz;
    for (let i = 0; i < 8; i += 2) {
        const x = axes[i], z = axes[i + 1];
        const ra = a.hu * Math.abs(a.ux * x + a.uz * z) + a.hv * Math.abs(a.vx * x + a.vz * z);
        const rb = b.hu * Math.abs(b.ux * x + b.uz * z) + b.hv * Math.abs(b.vx * x + b.vz * z);
        const d = dx * x + dz * z;
        const o = ra + rb - Math.abs(d);
        if (o <= 0) return null;
        if (o < best) { best = o; const s = d > 0 ? -1 : 1; nx = x * s; nz = z * s; }
    }
    res.depth = best; res.nx = nx; res.nz = nz;
    return res;
}

const _cb = {};
const _res = {};
function deepest(px, pz, yaw, obstacles, out) {
    cartBox(px, pz, yaw, _cb);
    let found = null;
    for (let i = 0; i < obstacles.length; i++) {
        if (overlap(_cb, obstacles[i], _res) && (!found || _res.depth > found.depth)) {
            found = out;
            out.depth = _res.depth; out.nx = _res.nx; out.nz = _res.nz;
        }
    }
    return found;
}
function isFree(px, pz, yaw, obstacles) {
    cartBox(px, pz, yaw, _cb);
    for (let i = 0; i < obstacles.length; i++) if (overlap(_cb, obstacles[i], _res)) return false;
    return true;
}

/** Forget the attached cart's heading (after detaching, teleports, resets). */
export function resetCartHeading() {
    cartYaw = null;
    ghostUntilFree = false;
}

/**
 * Resolve the attached cart against scenery. Pushes the player back when the
 * cart is walked into something, and stops the swing when it is turned into
 * something. Returns { yaw, pushX, pushZ } — the heading to draw the cart at
 * and how far the player was moved.
 */
const _hit = {};
const _solve = { yaw: 0, pushX: 0, pushZ: 0 };
export function solveAttachedCart(playerBody, desiredYaw, now) {
    _solve.pushX = 0; _solve.pushZ = 0;
    const world = ctx?.getWorld();
    if (!world || !playerBody) { _solve.yaw = desiredYaw; return _solve; }
    if (cartYaw === null) cartYaw = desiredYaw;
    const obstacles = gatherObstacles(world, playerBody.position.x, playerBody.position.z, CART_FOLLOW_DIST + 1.2);

    if (ghostUntilFree) {
        // Arrived overlapping (reattach, teleport): let the cart pass until clear.
        cartYaw = desiredYaw;
        if (isFree(playerBody.position.x, playerBody.position.z, cartYaw, obstacles)) ghostUntilFree = false;
        _solve.yaw = cartYaw;
        return _solve;
    }

    // 1. Walking into something: move the player back out.
    let impact = 0;
    for (let iter = 0; iter < 3; iter++) {
        const hit = deepest(playerBody.position.x, playerBody.position.z, cartYaw, obstacles, _hit);
        if (!hit) break;
        if (hit.depth > 0.45) { ghostUntilFree = true; break; }
        const push = Math.min(hit.depth + 0.002, 0.3);
        playerBody.position.x += hit.nx * push;
        playerBody.position.z += hit.nz * push;
        _solve.pushX += hit.nx * push;
        _solve.pushZ += hit.nz * push;
        const vn = playerBody.velocity.x * hit.nx + playerBody.velocity.z * hit.nz;
        if (vn < 0) {
            impact = Math.max(impact, -vn);
            playerBody.velocity.x -= vn * hit.nx;
            playerBody.velocity.z -= vn * hit.nz;
        }
    }
    if (_solve.pushX || _solve.pushZ) playerBody.aabbNeedsUpdate = true;

    // 2. Turning into something: swing only as far as there is room.
    let d = desiredYaw - cartYaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    if (Math.abs(d) > 1e-5) {
        const px = playerBody.position.x, pz = playerBody.position.z;
        if (ghostUntilFree || isFree(px, pz, cartYaw + d, obstacles)) {
            cartYaw += d;
        } else {
            let lo = 0, hi = 1;
            for (let i = 0; i < 6; i++) {
                const mid = (lo + hi) / 2;
                if (isFree(px, pz, cartYaw + d * mid, obstacles)) lo = mid; else hi = mid;
            }
            const before = cartYaw;
            cartYaw += d * lo;
            // Swinging hard into a shelf counts as a bump too.
            impact = Math.max(impact, Math.min(4, Math.abs(d * (1 - lo)) * 6));
            if (cartYaw === before && !isFree(px, pz, cartYaw, obstacles)) ghostUntilFree = true;
        }
    }
    cartYaw = Math.atan2(Math.sin(cartYaw), Math.cos(cartYaw));

    if (impact > 1.2 && now - lastBumpAt > 350) {
        lastBumpAt = now;
        const strength = Math.min(1, (impact - 1.2) / 3);
        wakeCartItems(0.25 + strength * 0.9);
        ctx.onBump?.(strength);
    }
    _solve.yaw = cartYaw;
    return _solve;
}
