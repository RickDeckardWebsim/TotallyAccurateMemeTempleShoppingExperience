// Animate the actual groceries one at a time. Inventory ownership never changes;
// only the display parent and basket physics are suspended during a transfer.
export function createCheckoutConveyor({ THREE, scene, cart, counter, items, removeBody,
    restoreBody, onScan, onProgress }) {
    const queue = [...new Set(items)].filter(item => item?.inCart && item.mesh?.parent === cart);
    let index = 0, current = null, elapsed = 0, scanned = 0, disposed = false;
    const start = new THREE.Vector3(), belt = new THREE.Vector3(), scanner = new THREE.Vector3(), end = new THREE.Vector3();
    const upright = new THREE.Quaternion(), worldQuat = new THREE.Quaternion(), bounds = new THREE.Box3();
    function restore() {
        if (!current) return;
        const { item, position, quaternion, scale, visible } = current;
        cart.add(item.mesh); item.mesh.position.copy(position); item.mesh.quaternion.copy(quaternion);
        item.mesh.scale.copy(scale); item.mesh.visible = visible;
        item.checkoutTransit = false;
        restoreBody(item, position, quaternion);
        current = null;
    }
    function takeNext() {
        if (index >= queue.length) return;
        const item = queue[index];
        current = { item, position: item.mesh.position.clone(), quaternion: item.mesh.quaternion.clone(),
            scale: item.mesh.scale.clone(), visible: item.mesh.visible, scanned: false };
        item.mesh.getWorldPosition(start); item.mesh.getWorldQuaternion(worldQuat);
        removeBody(item); scene.attach(item.mesh); item.checkoutTransit = true;
        item.mesh.visible = true; item.mesh.quaternion.identity();
        bounds.setFromObject(item.mesh);
        const baseOffset = item.mesh.position.y - bounds.min.y;
        // Sit just above the actual belt (1.005) and scanner glass (1.032).
        counter.localToWorld(belt.set(2.25, 1.009 + baseOffset, 0.15));
        counter.localToWorld(scanner.set(-0.95, 1.037 + baseOffset, 0.15));
        cart.localToWorld(end.copy(current.position));
        elapsed = 0;
    }
    return {
        get done() { return index >= queue.length && !current; },
        get total() { return queue.length; },
        get item() { return current?.item || null; },
        update(delta, ready, speed = 1) {
            if (disposed || !ready || this.done) return;
            if (!current) takeNext();
            if (!current) return;
            elapsed += Math.max(0, Math.min(0.1, delta)) * Math.max(1, Math.min(3, speed));
            const mesh = current.item.mesh;
            if (elapsed < 0.23) {
                const t = elapsed / 0.23, ease = t * t * (3 - 2 * t);
                mesh.position.lerpVectors(start, belt, ease); mesh.position.y += Math.sin(t * Math.PI) * 0.65;
                mesh.quaternion.slerpQuaternions(worldQuat, upright, ease);
            } else if (elapsed < 0.70) {
                mesh.position.lerpVectors(belt, scanner, (elapsed - 0.23) / 0.47); mesh.quaternion.copy(upright);
            } else {
                if (!current.scanned) {
                    current.scanned = true; scanned++; onScan(current.item);
                    onProgress(scanned, index, queue.length);
                }
                const t = Math.max(0, Math.min(1, (elapsed - 0.78) / 0.29)), ease = t * t * (3 - 2 * t);
                mesh.position.lerpVectors(scanner, end, ease); mesh.position.y += Math.sin(t * Math.PI) * 0.85;
                mesh.quaternion.slerpQuaternions(upright, worldQuat, ease);
                if (elapsed >= 1.07) {
                    restore(); index++; onProgress(scanned, index, queue.length);
                }
            }
        },
        dispose() {
            if (disposed) return;
            disposed = true; restore(); queue.length = 0;
        }
    };
}
