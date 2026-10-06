export const HEAVEN_CHANCE = 0.02;
export const HEAVEN_LINE = 'this is greed, this is your life. you have come home, son.';

// One roll per new non-sticky spill entry, never per frame or per second.
export function rollPlayerHeaven(random = Math.random, chancePercent = HEAVEN_CHANCE * 100) {
    const chance = Number.isFinite(chancePercent)
        ? Math.max(0, Math.min(100, chancePercent)) / 100 : HEAVEN_CHANCE;
    return chance > 0 && random() < chance;
}

// A separate, lazy scene: no store physics, NPCs, shadows, network generation,
// new renderer, or post-processing while heaven is on screen.
export function createPlayerHeaven({ THREE, ceilingHeight, cameraStartY, itemName, itemModel,
    parent, onReturn, onMenu, volume = 0.7, muted = false, random = Math.random }) {
    let elapsed = 0, phase = 'rising', scene = null, camera = null, idol = null;
    let disposed = false, spoken = false, utterance = null, heavenTime = 0, lastAspect = 0, idolWidth = 0;
    const geometries = new Set(), materials = new Set(), textures = new Set();
    let clouds = null, cloudSeeds = null, cloudTick = -1, haloGlow = null, sunGlow = null;
    const dummy = new THREE.Object3D();
    const ownGeometry = geometry => (geometries.add(geometry), geometry);
    const ownMaterial = material => (materials.add(material), material);
    const overlay = document.createElement('div');
    overlay.id = 'heaven-screen';
    overlay.innerHTML = '<div class="heaven-whiteout"></div><div class="heaven-dialog" hidden><div class="heaven-name"></div><p></p><div class="heaven-actions"><button type="button">Return to store</button><button type="button">Main menu</button></div></div>';
    parent.appendChild(overlay);
    const fade = overlay.querySelector('.heaven-whiteout');
    const dialog = overlay.querySelector('.heaven-dialog');
    dialog.querySelector('.heaven-name').textContent = 'THE ' + itemName.toUpperCase();
    dialog.querySelector('p').textContent = HEAVEN_LINE;
    const buttons = dialog.querySelectorAll('button');
    buttons[0].onclick = onReturn;
    buttons[1].onclick = onMenu;

    function buildHeaven() {
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0xd8e5f5);
        scene.fog = new THREE.Fog(0xeaf0fa, 55, 115);
        camera = new THREE.PerspectiveCamera(52, 1, 0.1, 260);
        camera.position.set(0, 4.5, 19);
        scene.add(new THREE.HemisphereLight(0xffffff, 0x92acd0, 2.1));
        const key = new THREE.DirectionalLight(0xffefcf, 2.8);
        key.position.set(-4, 12, 8);
        const rim = new THREE.DirectionalLight(0xffffff, 3.2);
        rim.position.set(0, 10, -8);
        scene.add(key, rim);
        idol = new THREE.Group();
        scene.add(idol);
        // This is a fresh display model, never an actual grocery from a cart.
        const bounds = new THREE.Box3().setFromObject(itemModel);
        const size = bounds.getSize(new THREE.Vector3());
        const center = bounds.getCenter(new THREE.Vector3());
        const scale = 8 / Math.max(size.x, size.y, size.z, 0.01);
        const item = new THREE.Group();
        itemModel.position.sub(center);
        item.add(itemModel);
        item.scale.setScalar(scale);
        item.position.y = 6;
        idol.add(item);
        // Actual shaded 3D puffs, not expensive raymarched volumes. Fixed-size
        // clusters drift in layers, with instance matrices refreshed at 20 Hz.
        const sphere = ownGeometry(new THREE.SphereGeometry(1, 10, 6));
        const cloudMat = ownMaterial(new THREE.MeshLambertMaterial({ color: 0xffffff }));
        clouds = new THREE.InstancedMesh(sphere, cloudMat, 96);
        clouds.name = 'heaven-clouds'; clouds.frustumCulled = false;
        clouds.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        cloudSeeds = new Float32Array(clouds.count * 8);
        for (let cluster = 0; cluster < 16; cluster++) {
            const high = cluster >= 12;
            const x = (cluster % 4 - 1.5) * 21 + (random() - 0.5) * 8;
            const z = high ? -35 - random() * 20 : 12 - Math.floor(cluster / 4) * 19;
            const y = high ? 10 + random() * 10 : -3.8 - random() * 1.2;
            const speed = (0.16 + random() * 0.2) * (cluster % 2 ? -1 : 1);
            for (let puff = 0; puff < 6; puff++) {
                const offset = (cluster * 6 + puff) * 8;
                cloudSeeds.set([x + (random() - 0.5) * 11, y + random() * 1.6,
                    z + (random() - 0.5) * 6, 3.2 + random() * 2.5,
                    1.4 + random() * 1.5, 2.5 + random() * 2, speed, random() * Math.PI * 2], offset);
            }
        }
        updateClouds(0);
        scene.add(clouds);
        const deck = new THREE.Mesh(ownGeometry(new THREE.PlaneGeometry(180, 180)), cloudMat);
        deck.rotation.x = -Math.PI / 2; deck.position.y = -5.5; scene.add(deck);

        // Two tiny procedural textures supply all glow. No bloom render target,
        // full-screen blur, transparent cloud stacks, shadows or downloaded assets.
        function glowTexture(ring = false) {
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
            const ctx = canvas.getContext('2d');
            const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
            for (const [stop, alpha] of ring ? [[0,0],[0.48,0],[0.64,0.7],[0.78,0.2],[1,0]]
                : [[0,1],[0.18,0.85],[0.45,0.3],[0.75,0.06],[1,0]]) {
                gradient.addColorStop(stop, `rgba(255,255,255,${alpha})`);
            }
            ctx.fillStyle = gradient; ctx.fillRect(0, 0, 128, 128);
            const texture = new THREE.CanvasTexture(canvas);
            texture.colorSpace = THREE.SRGBColorSpace;
            textures.add(texture); return texture;
        }
        const glow = glowTexture(), ringGlow = glowTexture(true);
        function lightSprite(map, color, opacity, x, y, z, width, height, additive = false) {
            const sprite = new THREE.Sprite(ownMaterial(new THREE.SpriteMaterial({ map, color, opacity,
                transparent: true, depthWrite: false, fog: false, toneMapped: false,
                blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending })));
            sprite.position.set(x, y, z); sprite.scale.set(width, height, 1); return sprite;
        }
        sunGlow = lightSprite(glow, 0xffe6ae, 0.72, 0, 10, -19, 38, 38);
        scene.add(sunGlow, lightSprite(glow, 0xfffdf0, 1, 0, 10, -18.8, 12, 12));
        idol.add(lightSprite(glow, 0xffe9be, 0.32, 0, 6, -1.5, 18, 18, true));
        const gold = ownMaterial(new THREE.MeshBasicMaterial({ color: 0xffd775, toneMapped: false }));
        const halo = new THREE.Mesh(ownGeometry(new THREE.TorusGeometry(3, 0.14, 6, 40)), gold);
        halo.position.set(0, 7.5 + size.y * scale / 2, 0);
        halo.rotation.x = Math.PI / 2 - 0.2;
        haloGlow = lightSprite(ringGlow, 0xffde91, 0.55, 0, halo.position.y, -0.2, 9, 2.4, true);
        idol.add(halo, haloGlow);

        // Swept flight feathers plus a shorter overlapping covert layer. All
        // feathers share one instanced draw; color variation exposes the layers.
        const featherShape = new THREE.Shape();
        featherShape.moveTo(0, 0);
        featherShape.quadraticCurveTo(-0.34, 0.32, -0.2, 0.68);
        featherShape.quadraticCurveTo(-0.1, 0.9, 0.08, 1);
        featherShape.quadraticCurveTo(0.28, 0.62, 0.26, 0.35);
        featherShape.quadraticCurveTo(0.22, 0.1, 0, 0);
        featherShape.closePath();
        const featherGeometry = ownGeometry(new THREE.ExtrudeGeometry(featherShape, { depth: 0.1, curveSegments: 3, bevelEnabled: false, steps: 1 }));
        const feathers = new THREE.InstancedMesh(featherGeometry,
            ownMaterial(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75,
                emissive: 0xffeed1, emissiveIntensity: 0.12 })), 64);
        feathers.name = 'heaven-feathers';
        const shafts = new THREE.InstancedMesh(ownGeometry(new THREE.BoxGeometry(0.022, 1, 0.018)),
            ownMaterial(new THREE.MeshBasicMaterial({ color: 0xe9d8b1 })), 64);
        const whites = new THREE.InstancedMesh(sphere,
            ownMaterial(new THREE.MeshStandardMaterial({ color: 0xfffcf0, roughness: 0.22 })), 12);
        whites.name = 'heaven-eyes';
        const irises = new THREE.InstancedMesh(sphere,
            ownMaterial(new THREE.MeshBasicMaterial({ color: 0x478b92 })), 12);
        const pupils = new THREE.InstancedMesh(sphere,
            ownMaterial(new THREE.MeshBasicMaterial({ color: 0x112134 })), 12);
        const lids = new THREE.InstancedMesh(ownGeometry(new THREE.TorusGeometry(1, 0.09, 4, 16)), gold, 12);
        const highlights = new THREE.InstancedMesh(sphere,
            ownMaterial(new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })), 12);
        const wingRoot = size.x * scale / 2 + 0.35;
        const featherColor = new THREE.Color();
        function instance(mesh, index, x, y, z, sx, sy, sz, rotation = 0) {
            dummy.position.set(x, y, z); dummy.scale.set(sx, sy, sz);
            dummy.rotation.set(0, 0, rotation); dummy.updateMatrix(); mesh.setMatrixAt(index, dummy.matrix);
        }
        for (let side = 0; side < 2; side++) {
            const sign = side === 0 ? -1 : 1;
            for (let layer = 0; layer < 2; layer++) {
                for (let i = 0; i < 16; i++) {
                    const t = i / 15, index = side * 32 + layer * 16 + i;
                    const x = sign * (wingRoot + t * 3.3);
                    const y = 4.6 + Math.sin(t * Math.PI * 0.64) * 2.7 + layer * 0.23;
                    const z = -0.6 + layer * 0.22 + t * 0.1;
                    const length = (2.2 + t * 1.5) * (layer ? 0.58 : 1);
                    const rotation = sign * (-0.25 - t * 0.85);
                    instance(feathers, index, x, y, z, 1.6 - layer * 0.35, length, 1, rotation);
                    feathers.setColorAt(index, featherColor.setHex(layer ? (i % 2 ? 0xfff5de : 0xffffff) : (i % 2 ? 0xe3e9f3 : 0xf7eee0)));
                    instance(shafts, index, x - Math.sin(rotation) * length * 0.4,
                        y + Math.cos(rotation) * length * 0.4, z + 0.12, 1, length * 0.78, 1, rotation);
                }
            }
            for (let i = 0; i < 6; i++) {
                const t = (i + 0.4) / 6, index = side * 6 + i;
                const x = sign * (wingRoot + 0.15 + t * 3.4);
                const y = 5.15 + Math.sin(t * Math.PI * 0.64) * 2.7;
                const z = 0.05 + t * 0.1;
                const rotation = sign * -0.18;
                instance(lids, index, x, y, z, 0.46, 0.29, 0.15, rotation);
                instance(whites, index, x, y, z + 0.04, 0.43, 0.26, 0.16, rotation);
                instance(irises, index, x, y, z + 0.185, 0.18, 0.21, 0.045, rotation);
                instance(pupils, index, x, y, z + 0.225, 0.065, 0.155, 0.02, rotation);
                instance(highlights, index, x - 0.055, y + 0.07, z + 0.247, 0.04, 0.047, 0.012);
            }
        }
        idol.add(feathers, shafts, lids, whites, irises, pupils, highlights);
        idolWidth = (wingRoot + 7) * 2;
    }

    function updateClouds(t) {
        const tick = Math.floor(t * 20);
        if (tick === cloudTick) return;
        cloudTick = tick;
        for (let i = 0; i < clouds.count; i++) {
            const offset = i * 8;
            const x = ((cloudSeeds[offset] + t * cloudSeeds[offset + 6] + 60) % 120 + 120) % 120 - 60;
            dummy.position.set(x, cloudSeeds[offset + 1] + Math.sin(t * 0.2 + cloudSeeds[offset + 7]) * 0.18, cloudSeeds[offset + 2]);
            dummy.scale.set(cloudSeeds[offset + 3], cloudSeeds[offset + 4], cloudSeeds[offset + 5]);
            dummy.rotation.set(0, 0, 0); dummy.updateMatrix(); clouds.setMatrixAt(i, dummy.matrix);
        }
        clouds.instanceMatrix.needsUpdate = true;
    }

    function speak() {
        if (spoken) return;
        spoken = true;
        // Local speech is optional; the exact line is always subtitled. Respect
        // sound-off, SFX volume, and cleanup without canceling unrelated speech.
        if (muted || volume <= 0 || !globalThis.speechSynthesis || !globalThis.SpeechSynthesisUtterance || speechSynthesis.speaking || speechSynthesis.pending) return;
        try {
            utterance = new SpeechSynthesisUtterance(HEAVEN_LINE);
            utterance.lang = 'en-US'; utterance.rate = 0.78; utterance.pitch = 0.65;
            utterance.volume = Math.max(0, Math.min(1, volume));
            utterance.onend = utterance.onerror = () => { utterance = null; };
            speechSynthesis.speak(utterance);
        } catch (_) { utterance = null; }
    }

    return {
        get phase() { return phase; },
        get scene() { return scene; },
        get camera() { return camera; },
        update(delta, aspect) {
            if (disposed) return null;
            elapsed += Math.max(0, Math.min(delta, 0.1));
            const y = cameraStartY + elapsed * 0.35 + elapsed * elapsed * 0.12;
            if (phase === 'rising') {
                // Whiteout starts only as the player's viewpoint crosses the ceiling.
                fade.style.opacity = String(Math.max(0, Math.min(1, (y - ceilingHeight) / 0.75)));
                if (y >= ceilingHeight + 0.75) {
                    buildHeaven(); phase = 'heaven'; heavenTime = elapsed;
                }
            }
            if (phase === 'heaven') {
                const t = elapsed - heavenTime;
                fade.style.opacity = String(Math.max(0, 1 - t / 1.4));
                if (aspect !== lastAspect) {
                    lastAspect = aspect;
                    camera.aspect = Math.max(0.2, aspect); camera.updateProjectionMatrix();
                    // Keep both wings in view on phones, not just landscape screens.
                    camera.position.z = Math.max(19, idolWidth / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect) * 1.08);
                    // Fog must not erase the idol when portrait framing backs up.
                    scene.fog.near = camera.position.z + 32;
                    scene.fog.far = camera.position.z + 95;
                }
                camera.position.x = Math.sin(t * 0.15) * 0.7;
                camera.position.y = 4.5 + Math.sin(t * 0.45) * 0.15;
                camera.lookAt(0, 6.5, 0);
                idol.position.y = Math.sin(t * 0.7) * 0.22;
                idol.rotation.z = Math.sin(t * 0.3) * 0.012;
                updateClouds(t);
                haloGlow.material.opacity = 0.5 + Math.sin(t * 0.8) * 0.07;
                sunGlow.material.opacity = 0.72 + Math.sin(t * 0.24) * 0.04;
                if (t > 1.4) { dialog.hidden = false; speak(); }
            }
            return { phase, y };
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            overlay.remove();
            if (utterance && speechSynthesis.speaking) speechSynthesis.cancel();
            // Instanced buffers are per scene; the grocery's shared textures,
            // geometry and materials still belong to the store cache.
            scene?.traverse(node => { if (node.isInstancedMesh) node.dispose(); });
            geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose());
            textures.forEach(texture => texture.dispose());
            scene = camera = idol = itemModel = clouds = cloudSeeds = haloGlow = sunGlow = null;
        }
    };
}
