// Shared with the visible information desk: include the complete quartz overhang.
export const RETURN_DESK = { x: -22, z: -24, topY: 1.2, hx: 1.925, hz: 1.025 };

export function boxSupportHeight(half, q) {
    return Math.abs(2 * (q.x * q.y + q.w * q.z)) * half.x +
        Math.abs(1 - 2 * (q.x * q.x + q.z * q.z)) * half.y +
        Math.abs(2 * (q.y * q.z - q.w * q.x)) * half.z;
}

// One swept surface test for the one active return, not extra physics substeps.
// Use the rotated box's bottom rather than its unrotated half-height. A centre
// landing on the actual countertop is supported, including the outer edges.
export function supportReturnOnCounter(f, desk = RETURN_DESK) {
    const body = f.body, p = body.position, previous = f.previousPosition;
    const height = boxSupportHeight(f.half, body.quaternion);
    const bottom = p.y - height, oldBottom = f.previousBottom ?? (previous?.y - height);
    if (previous && oldBottom >= desk.topY && bottom < desk.topY) {
        const t = (oldBottom - desk.topY) / (oldBottom - bottom);
        const x = previous.x + (p.x - previous.x) * t;
        const z = previous.z + (p.z - previous.z) * t;
        const edgeContact = Math.abs(previous.x - desk.x) <= desk.hx && Math.abs(previous.z - desk.z) <= desk.hz;
        const slop = edgeContact ? 0.08 : 0;
        if (Math.abs(x - desk.x) <= desk.hx + slop && Math.abs(z - desk.z) <= desk.hz + slop) {
            // A corner contact can push the centre a few centimetres sideways
            // before this frame's sweep. Settle onto the real surface, not an
            // invisible expanded platform outside it.
            p.set(Math.max(desk.x - desk.hx + 0.01, Math.min(desk.x + desk.hx - 0.01, x)),
                desk.topY + height + 0.006,
                Math.max(desk.z - desk.hz + 0.01, Math.min(desk.z + desk.hz - 0.01, z)));
            body.velocity.set(0, 0, 0);
            body.angularVelocity.set(0, 0, 0);
            body.aabbNeedsUpdate = true;
        }
    }
    // Cannon may resolve the contact before the swept test sees a crossing.
    // Stabilize that genuine top contact too, so an edge/corner landing cannot
    // tumble into the wooden base while the return acceptance timer runs.
    if (Math.abs(p.x - desk.x) <= desk.hx && Math.abs(p.z - desk.z) <= desk.hz &&
        p.y - height >= desk.topY - 0.045 && p.y - height <= desk.topY + 0.035 && body.velocity.y <= 0.35) {
        p.y = desk.topY + height + 0.006;
        body.velocity.set(0, 0, 0); body.angularVelocity.set(0, 0, 0); body.aabbNeedsUpdate = true;
    }
    f.previousBottom = p.y - height;
    previous?.set(p.x, p.y, p.z);
    return Math.abs(p.x - desk.x) <= desk.hx && Math.abs(p.z - desk.z) <= desk.hz &&
        p.y - height >= desk.topY - 0.045 && p.y - height <= desk.topY + 0.12;
}
