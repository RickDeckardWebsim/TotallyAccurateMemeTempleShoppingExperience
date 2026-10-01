// Cosmetic spill carry-out: two fixed instanced pools, no physics or per-mark meshes.
import * as THREE from 'three';

const FOOT_CAPACITY = 96;
const WHEEL_CAPACITY = 192;
const FADE_MS = 4000;
let footprints = null, wheelMarks = null;
let footDistance = 0, footSide = 0, playerX = NaN, playerZ = NaN;
const shoes = Array.from({ length: 2 }, () => ({ wet: 0, color: 0xffffff }));
const wheels = Array.from({ length: 4 }, () => ({ x: NaN, z: NaN, wet: 0, color: 0xffffff }));
const point = new THREE.Vector3(), position = new THREE.Vector3(), scale = new THREE.Vector3();
const rotation = new THREE.Quaternion(), matrix = new THREE.Matrix4(), color = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

function makeTexture(foot) {
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    if (foot) {
        // Two lobes and broken tread read as a shoe without any 3D geometry.
        ctx.beginPath(); ctx.ellipse(32, 43, 24, 37, 0, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.ellipse(32, 103, 19, 20, 0, 0, Math.PI * 2); ctx.fill();
        ctx.globalCompositeOperation = 'destination-out';
        for (let y = 20; y < 75; y += 13) ctx.fillRect(8, y, 48, 3);
        ctx.fillRect(16, 99, 32, 3);
    } else {
        const gradient = ctx.createLinearGradient(0, 0, 64, 0);
        gradient.addColorStop(0, 'rgba(255,255,255,0)');
        gradient.addColorStop(0.3, 'rgba(255,255,255,0.7)');
        gradient.addColorStop(0.7, 'rgba(255,255,255,0.7)');
        gradient.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = gradient; ctx.fillRect(0, 0, 64, 128);
        ctx.globalCompositeOperation = 'destination-out';
        for (let y = 0; y < 128; y += 16) ctx.fillRect(0, y, 64, 2);
    }
    return new THREE.CanvasTexture(canvas);
}

function makePool(scene, capacity, foot) {
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);
    const opacity = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    opacity.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('trackOpacity', opacity);
    const material = new THREE.MeshLambertMaterial({
        map: makeTexture(foot), transparent: true, depthWrite: false, alphaTest: 0.02,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1
    });
    material.onBeforeCompile = shader => {
        shader.vertexShader = 'attribute float trackOpacity;\nvarying float vTrackOpacity;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvTrackOpacity = trackOpacity;');
        shader.fragmentShader = 'varying float vTrackOpacity;\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vTrackOpacity;');
    };
    material.customProgramCacheKey = () => 'spill-track-opacity-v1';
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    // Marks spread across the store: avoid recalculating a growing bounding sphere.
    mesh.frustumCulled = false;
    mesh.raycast = () => {};
    mesh.renderOrder = foot ? 2 : 1;
    scene.add(mesh);
    return { mesh, opacity, cursor: 0, capacity, expires: new Float64Array(capacity), strength: new Float32Array(capacity), lifetime: foot ? 18000 : 14000, dirty: false };
}

function contact(spills, x, z) {
    for (let i = spills.length - 1; i >= 0; i--) {
        const spill = spills[i], dx = x - spill.x, dz = z - spill.z;
        if (dx * dx + dz * dz < spill.radius * spill.radius) return spill;
    }
    return null;
}

function loadWetness(state, spill) {
    if (!spill) return;
    state.wet = 1;
    state.color = spill.trackColor ?? spill.mesh.material.color.getHex();
}

function stamp(pool, x, z, yaw, width, length, state, now) {
    const index = pool.cursor;
    pool.cursor = (index + 1) % pool.capacity;
    position.set(x, 0.019 + index * 0.00001, z);
    rotation.setFromAxisAngle(UP, yaw);
    scale.set(width, 1, length);
    matrix.compose(position, rotation, scale);
    pool.mesh.setMatrixAt(index, matrix);
    color.setHex(state.color);
    pool.mesh.setColorAt(index, color);
    pool.strength[index] = state.wet * (pool === footprints ? 0.48 : 0.32);
    pool.expires[index] = now + pool.lifetime;
    pool.opacity.setX(index, pool.strength[index]);
    pool.mesh.count = Math.min(pool.capacity, pool.mesh.count + 1);
    pool.dirty = true;
}

function flush(pool, now) {
    if (!pool || pool.mesh.count === 0) return;
    let active = 0;
    for (let i = 0; i < pool.mesh.count; i++) {
        const remaining = pool.expires[i] - now;
        const alpha = pool.strength[i] * Math.max(0, Math.min(1, remaining / FADE_MS));
        pool.opacity.setX(i, alpha);
        if (alpha > 0.02) active++;
    }
    pool.opacity.needsUpdate = true;
    pool.mesh.visible = active > 0;
    if (pool.dirty) {
        pool.mesh.instanceMatrix.needsUpdate = true;
        pool.mesh.instanceColor.needsUpdate = true;
        pool.dirty = false;
    }
    if (active === 0) { pool.mesh.count = 0; pool.cursor = 0; }
}

export function updateSpillTracks(scene, spills, player, cart, active, attached, now) {
    if (!scene) return;
    // Most frames have no spills: skip contact sampling and matrix work entirely.
    if (!spills.length && !footprints && !wheelMarks) return;
    if (!active) {
        playerX = playerZ = NaN;
        for (const wheel of wheels) wheel.x = wheel.z = NaN;
        flush(footprints, now); flush(wheelMarks, now);
        return;
    }
    if (player) {
        const x = player.position.x, z = player.position.z;
        const dx = x - playerX, dz = z - playerZ, distance = Math.hypot(dx, dz);
        if (Number.isFinite(distance) && distance < 2 && player.position.y < 1.25 && Math.abs(player.velocity.y) < 0.8) {
            const yaw = Math.atan2(dx, dz);
            const rightX = distance > 0 ? dz / distance : 1;
            const rightZ = distance > 0 ? -dx / distance : 0;
            for (let i = 0; i < 2; i++) {
                const side = i === 0 ? -0.11 : 0.11;
                loadWetness(shoes[i], contact(spills, x + side * rightX, z + side * rightZ));
                shoes[i].wet = Math.max(0, shoes[i].wet - distance * 0.23);
            }
            footDistance += distance;
            if (distance > 0 && footDistance >= 0.34) {
                footDistance %= 0.34;
                const shoe = shoes[footSide], side = footSide === 0 ? -0.11 : 0.11;
                footSide ^= 1;
                if (shoe.wet > 0.05) {
                    if (!footprints) footprints = makePool(scene, FOOT_CAPACITY, true);
                    stamp(footprints, x + side * rightX, z + side * rightZ, yaw + Math.PI, 0.16, 0.29, shoe, now);
                }
            }
        } else {
            footDistance = 0;
            for (const shoe of shoes) shoe.wet = 0;
        }
        playerX = x; playerZ = z;
    }
    if (attached && cart) {
        cart.updateWorldMatrix(true, false);
        const cartScale = cart.userData.visual?.scale.x || 1;
        for (let i = 0; i < 4; i++) {
            point.set((i & 1 ? 0.34 : -0.34) * cartScale, 0, (i & 2 ? -0.42 : 0.42) * cartScale).applyMatrix4(cart.matrixWorld);
            const wheel = wheels[i];
            loadWetness(wheel, contact(spills, point.x, point.z));
            const dx = point.x - wheel.x, dz = point.z - wheel.z, distance = Math.hypot(dx, dz);
            if (!Number.isFinite(distance) || distance > 1.5) {
                wheel.x = point.x; wheel.z = point.z; wheel.wet = 0;
            } else if (distance >= 0.12) {
                if (wheel.wet > 0.05) {
                    if (!wheelMarks) wheelMarks = makePool(scene, WHEEL_CAPACITY, false);
                    stamp(wheelMarks, (point.x + wheel.x) * 0.5, (point.z + wheel.z) * 0.5,
                        Math.atan2(dx, dz), 0.065, distance + 0.025, wheel, now);
                }
                wheel.wet = Math.max(0, wheel.wet - distance * 0.17);
                wheel.x = point.x; wheel.z = point.z;
            }
        }
    } else {
        for (const wheel of wheels) { wheel.x = wheel.z = NaN; wheel.wet = 0; }
    }
    flush(footprints, now); flush(wheelMarks, now);
}

export function clearSpillTracks() {
    for (const pool of [footprints, wheelMarks]) {
        if (!pool) continue;
        pool.mesh.removeFromParent();
        pool.mesh.dispose();
        pool.mesh.geometry.dispose();
        pool.mesh.material.map.dispose();
        pool.mesh.material.dispose();
    }
    footprints = wheelMarks = null;
    playerX = playerZ = NaN; footDistance = footSide = 0;
    for (const shoe of shoes) shoe.wet = 0;
    for (const wheel of wheels) { wheel.x = wheel.z = NaN; wheel.wet = 0; }
}
