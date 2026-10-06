export const HEAVEN_CHANCE = 0.02;
export const HEAVEN_LINE = 'this is greed, this is your life. you have come home, son.';

// One roll per new non-sticky spill entry, never per frame or per second.
export function rollPlayerHeaven(random = Math.random) {
    return random() < HEAVEN_CHANCE;
}

// A separate, lazy scene: no store physics, NPCs, shadows, network generation,
// new renderer, or post-processing while heaven is on screen.
export function createPlayerHeaven({ THREE, ceilingHeight, cameraStartY, itemName, itemModel,
    parent, onReturn, onMenu, volume = 0.7, muted = false, random = Math.random }) {
    let elapsed = 0, phase = 'rising', scene = null, camera = null, idol = null;
    let disposed = false, spoken = false, utterance = null, heavenTime = 0, lastAspect = 0, idolWidth = 0;
    const geometries = new Set(), materials = new Set();
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
        scene.background = new THREE.Color(0xf6f8ff);
        scene.fog = new THREE.Fog(0xf6f8ff, 24, 70);
        camera = new THREE.PerspectiveCamera(52, 1, 0.1, 90);
        camera.position.set(0, 4.5, 19);
        scene.add(new THREE.HemisphereLight(0xffffff, 0xcbd9f2, 2.6));
        const sun = new THREE.DirectionalLight(0xffefc6, 2.5);
        sun.position.set(4, 12, 7);
        scene.add(sun);
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
        const sphere = ownGeometry(new THREE.SphereGeometry(1, 8, 5));
        const cloudMat = ownMaterial(new THREE.MeshBasicMaterial({ color: 0xffffff, fog: true }));
        const clouds = new THREE.InstancedMesh(sphere, cloudMat, 72);
        const dummy = new THREE.Object3D();
        for (let i = 0; i < clouds.count; i++) {
            dummy.position.set((random() - 0.5) * 80, -1.9 + random() * 1.4, (random() - 0.5) * 80);
            dummy.scale.set(3 + random() * 4, 1 + random() * 1.5, 2 + random() * 3);
            dummy.rotation.set(0, 0, 0);
            dummy.updateMatrix(); clouds.setMatrixAt(i, dummy.matrix);
        }
        scene.add(clouds);
        const deck = new THREE.Mesh(ownGeometry(new THREE.PlaneGeometry(180, 180)), cloudMat);
        deck.rotation.x = -Math.PI / 2; deck.position.y = -2.8; scene.add(deck);
        const gold = ownMaterial(new THREE.MeshBasicMaterial({ color: 0xffd775 }));
        const halo = new THREE.Mesh(ownGeometry(new THREE.TorusGeometry(3, 0.14, 6, 40)), gold);
        halo.position.set(0, 7.5 + size.y * scale / 2, 0);
        halo.rotation.x = Math.PI / 2 - 0.2;
        idol.add(halo);
        const featherShape = new THREE.Shape();
        featherShape.moveTo(0, -1);
        for (const [x,y] of [[-0.4,-0.4],[-0.5,0.2],[-0.3,0.8],[0,1],[0.3,0.8],[0.5,0.2],[0.4,-0.4]]) featherShape.lineTo(x,y);
        featherShape.closePath();
        const featherGeometry = ownGeometry(new THREE.ExtrudeGeometry(featherShape, { depth: 0.12, bevelEnabled: false, steps: 1 }));
        const feathers = new THREE.InstancedMesh(featherGeometry,
            ownMaterial(new THREE.MeshStandardMaterial({ color: 0xfff5dc, roughness: 1 })), 28);
        const whites = new THREE.InstancedMesh(sphere, cloudMat, 12);
        const pupils = new THREE.InstancedMesh(sphere,
            ownMaterial(new THREE.MeshBasicMaterial({ color: 0x344264 })), 12);
        const wingRoot = size.x * scale / 2 + 0.35;
        for (let side = 0; side < 2; side++) {
            const sign = side === 0 ? -1 : 1;
            for (let i = 0; i < 14; i++) {
                const t = i / 13;
                dummy.position.set(sign * (wingRoot + 0.4 + t * 3.7), 5 + Math.sin(t * Math.PI * 0.8) * 4, -0.5);
                dummy.scale.set(1.0, 1.8 - t * 0.6, 1);
                dummy.rotation.set(0, 0, sign * (-0.5 - t * 0.65));
                dummy.updateMatrix(); feathers.setMatrixAt(side * 14 + i, dummy.matrix);
            }
            for (let i = 0; i < 6; i++) {
                const t = (i + 1) / 7;
                dummy.position.set(sign * (wingRoot + 0.4 + t * 3.7), 5 + Math.sin(t * Math.PI * 0.8) * 4, -0.13);
                dummy.scale.set(0.4, 0.25, 0.16); dummy.rotation.set(0, 0, 0);
                dummy.updateMatrix(); whites.setMatrixAt(side * 6 + i, dummy.matrix);
                dummy.position.z += 0.15;
                dummy.scale.set(0.11, 0.16, 0.08);
                dummy.updateMatrix(); pupils.setMatrixAt(side * 6 + i, dummy.matrix);
            }
        }
        idol.add(feathers, whites, pupils);
        idolWidth = size.x * scale + 10;
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
                }
                camera.position.x = Math.sin(t * 0.15) * 0.7;
                camera.position.y = 4.5 + Math.sin(t * 0.45) * 0.15;
                camera.lookAt(0, 6.5, 0);
                idol.position.y = Math.sin(t * 0.7) * 0.22;
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
            scene = camera = idol = itemModel = null;
        }
    };
}
