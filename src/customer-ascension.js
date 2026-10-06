// The old locked-Y/upward-velocity glitch is an authored, bounded spectacle.
// No extra lights, shadows, textures, particles, timers or per-frame geometry.
export const ASCENSION = Object.freeze({ maxActive: 3, maxCarts: 6, riseSeconds: 5,
  returnSeconds: 12, cartSeconds: 45, tipSeconds: 0.95, triggerSeconds: 0.3 });

export function detectCustomerFlight(customer, delta) {
  if (!customer?.body || customer.visible === false || customer.interacting ||
      customer.nukeMode || customer.behaviorState === 'respawning' ||
      customer.behaviorState === 'ascended' || customer.behaviorState === 'ascending') {
    if (customer) customer.flightTime = 0;
    return false;
  }
  const body = customer.body;
  const rising = body.position.y > (customer.groundBodyY ?? 0.95) + 0.55 && body.velocity.y > 0.5;
  customer.flightTime = rising ? (customer.flightTime || 0) + Math.min(Math.max(delta, 0), 0.1) : 0;
  return customer.flightTime >= ASCENSION.triggerSeconds;
}

export function createCustomerAscensions({ THREE, scene, world, cartScale, ceilingHeight,
  onStart, dropItem, disposeCart, returnCustomer }) {
  const slots = [], carts = [], returning = [], settlingItems = [];
  let wingGeometry = null, beamGeometry = null, glowGeometry = null, wingMaterial = null;
  const center = new THREE.Vector3();

  function makeSlot() {
    if (!wingGeometry) {
      // One low-poly extruded feather silhouette per wing, shared by every slot.
      const shape = new THREE.Shape();
      shape.moveTo(0, 0);
      for (const [x, y] of [[0.25,0.55],[0.8,1.05],[1.48,1.28],[1.36,0.84],
        [1.56,0.91],[1.3,0.45],[1.45,0.5],[1.11,0.12],[1.23,0.15],
        [0.78,-0.13],[0.88,-0.13],[0.39,-0.3],[0,-0.14]]) shape.lineTo(x, y);
      wingGeometry = new THREE.ExtrudeGeometry(shape, { depth: 0.045, bevelEnabled: false, steps: 1, curveSegments: 1 });
      wingMaterial = new THREE.MeshBasicMaterial({ color: 0xfff8df, side: THREE.DoubleSide });
      beamGeometry = new THREE.CylinderGeometry(0.18, 1.25, ceilingHeight, 8, 1, true);
      glowGeometry = new THREE.CircleGeometry(1.25, 16);
    }
    const wings = new THREE.Group();
    const left = new THREE.Mesh(wingGeometry, wingMaterial);
    left.scale.x = -1; left.position.set(-0.13, 1.25, -0.2);
    const right = new THREE.Mesh(wingGeometry, wingMaterial);
    right.position.set(0.13, 1.25, -0.2);
    wings.add(left, right);
    const beamMaterial = new THREE.MeshBasicMaterial({ color: 0xffedb3, transparent: true,
      opacity: 0.14, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    beamMaterial.forceSinglePass = true;
    const beam = new THREE.Mesh(beamGeometry, beamMaterial);
    const glowMaterial = new THREE.MeshBasicMaterial({ color: 0xffe8a1, transparent: true,
      opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending });
    const glow = new THREE.Mesh(glowGeometry, glowMaterial);
    glow.rotation.x = -Math.PI / 2;
    beam.visible = glow.visible = false;
    scene.add(beam, glow);
    const slot = { wings, left, right, beam, glow, customer: null, elapsed: 0 };
    slots.push(slot);
    return slot;
  }

  function removeCart(record) {
    // Never destroy groceries along with a cart, even during cap eviction.
    spillCart(record);
    if (record.cart.body?.world === world) world.removeBody(record.cart.body);
    record.cart.group.removeFromParent();
    disposeCart(record.cart);
  }

  function spillCart(record) {
    if (record.spilled) return;
    record.spilled = true;
    const { cart, side, yaw } = record;
    cart.group.updateWorldMatrix(true, true);
    for (let i = 0; i < cart.items.length; i++) {
      const item = cart.items[i];
      releaseItem(item, { x: Math.cos(yaw) * side * (1.6 + i * 0.12),
        y: 0.8, z: -Math.sin(yaw) * side * (1.6 + i * 0.12) }, 0.85);
    }
    cart.items.length = 0;
  }

  function releaseItem(item, velocity, carryScale) {
    dropItem(item, velocity, carryScale);
    if (item?.body) settlingItems.push({ item, body: item.body });
  }

  function detachCart(customer) {
    const cart = customer.cart;
    customer.hasCart = false;
    customer.cart = null; // Nothing in follow/audio/checkout can keep dragging it.
    if (!cart?.group) return;
    cart.detached = true;
    while (carts.length >= ASCENSION.maxCarts) removeCart(carts.shift());
    const yaw = Math.atan2(2 * (cart.group.quaternion.x * cart.group.quaternion.z + cart.group.quaternion.w * cart.group.quaternion.y),
      1 - 2 * (cart.group.quaternion.x ** 2 + cart.group.quaternion.y ** 2));
    cart.group.rotation.set(0, yaw, 0);
    carts.push({ cart, yaw, side: customer.customerId % 2 ? 1 : -1,
      x: cart.group.position.x, z: cart.group.position.z, elapsed: 0, spilled: false });
  }

  function begin(customer) {
    let slot = slots.find(s => !s.customer);
    if (!slot && slots.length < ASCENSION.maxActive) slot = makeSlot();
    if (!slot) return false;
    onStart(customer);
    detachCart(customer);
    for (const key of ['handItem', 'scuffleHeldItem']) {
      if (customer[key]) releaseItem(customer[key], { x: 0.5, y: 0.8, z: 0.4 }, key === 'handItem' ? 0.8 : 1);
      customer[key] = null;
    }
    if (customer.body.world === world) world.removeBody(customer.body);
    customer.body.velocity.set(0, 0, 0);
    customer.body.angularVelocity.set(0, 0, 0);
    customer.behaviorState = 'ascending';
    customer.ascensionPending = false;
    customer.flightTime = 0;
    customer.leftLeg?.rotation.set(0, 0, 0);
    customer.rightLeg?.rotation.set(0, 0, 0);
    slot.customer = customer; slot.elapsed = 0;
    slot.x = customer.body.position.x; slot.z = customer.body.position.z;
    slot.startY = customer.body.position.y - 0.9;
    customer.position.set(slot.x, slot.startY, slot.z);
    customer.add(slot.wings);
    slot.beam.position.set(slot.x, ceilingHeight / 2, slot.z);
    slot.glow.position.set(slot.x, 0.025, slot.z);
    slot.beam.visible = slot.glow.visible = true;
    return true;
  }

  function checkCustomer(customer, delta) {
    if (customer.behaviorState === 'ascending' || customer.behaviorState === 'ascended') return true;
    if (customer.ascensionPending || detectCustomerFlight(customer, delta)) {
      customer.ascensionPending = true;
      if (!begin(customer)) {
        // Hold queued shoppers in place rather than allocating unbounded effects.
        customer.body.velocity.set(0, 0, 0);
        customer.position.set(customer.body.position.x, customer.body.position.y - 0.9, customer.body.position.z);
      }
      return true;
    }
    return false;
  }

  function update(delta) {
    const dt = Math.min(Math.max(delta, 0), 0.1);
    // Main-world automatic sleeping is disabled for shoppers. Tick only our
    // newly released bodies until they settle; normal collisions still wake them.
    for (let i = settlingItems.length - 1; i >= 0; i--) {
      const { item, body } = settlingItems[i];
      if (item.body !== body || item.isStatic || item.inCart || body.world !== world || body.sleepState === body.constructor.SLEEPING) {
        settlingItems.splice(i, 1);
      } else body.sleepTick(world.time);
    }
    // Only the small active pools are visited; elapsed time stops with gameplay.
    for (let i = returning.length - 1; i >= 0; i--) {
      const record = returning[i]; record.remaining -= dt;
      if (record.remaining <= 0) {
        returnCustomer(record.customer);
        returning.splice(i, 1);
      }
    }
    for (const slot of slots) {
      const customer = slot.customer;
      if (!customer) continue;
      slot.elapsed += dt;
      const t = Math.min(1, slot.elapsed / ASCENSION.riseSeconds);
      const lift = ceilingHeight + 1.5;
      customer.position.y = slot.startY + lift * (t * t * (3 - 2 * t));
      customer.body.position.set(slot.x, customer.position.y + 0.9, slot.z);
      const flap = Math.sin(slot.elapsed * 4) * 0.18;
      slot.left.rotation.y = -0.25 + flap;
      slot.right.rotation.y = 0.25 - flap;
      const fade = Math.min(1, slot.elapsed * 4, (1 - t) * 5);
      slot.beam.material.opacity = fade * 0.14;
      slot.glow.material.opacity = fade * 0.2;
      if (t === 1) {
        customer.visible = false;
        customer.behaviorState = 'ascended';
        customer.body.position.set(0, -60, 0);
        slot.wings.removeFromParent(); slot.beam.visible = slot.glow.visible = false;
        returning.push({ customer, remaining: ASCENSION.returnSeconds });
        slot.customer = null;
      }
    }
    for (let i = carts.length - 1; i >= 0; i--) {
      const record = carts[i]; record.elapsed += dt;
      if (record.elapsed >= ASCENSION.cartSeconds) {
        removeCart(record); carts.splice(i, 1); continue;
      }
      if (record.elapsed > ASCENSION.tipSeconds + dt) continue;
      const t = Math.min(1, record.elapsed / ASCENSION.tipSeconds);
      const roll = record.side * Math.PI / 2 * t * t;
      const { cart, yaw } = record;
      cart.group.rotation.set(0, yaw, roll);
      cart.group.position.set(record.x + Math.sin(yaw) * 0.25 * t,
        0.4 * cartScale * Math.sin(Math.abs(roll)), record.z + Math.cos(yaw) * 0.25 * t);
      if (cart.body) {
        center.set(0, 0.45 * cartScale, 0).applyQuaternion(cart.group.quaternion).add(cart.group.position);
        cart.body.position.copy(center); cart.body.quaternion.copy(cart.group.quaternion);
        cart.body.aabbNeedsUpdate = true;
      }
      if (t >= 0.45) spillCart(record);
    }
  }

  function clear() {
    for (const slot of slots) {
      slot.wings.removeFromParent(); slot.beam.removeFromParent(); slot.glow.removeFromParent();
      slot.beam.material.dispose(); slot.glow.material.dispose();
      if (slot.customer) { slot.customer.ascensionPending = false; slot.customer.flightTime = 0; }
    }
    for (const record of carts) removeCart(record);
    slots.length = carts.length = returning.length = settlingItems.length = 0;
    wingGeometry?.dispose(); beamGeometry?.dispose(); glowGeometry?.dispose(); wingMaterial?.dispose();
    wingGeometry = beamGeometry = glowGeometry = wingMaterial = null;
  }
  return { checkCustomer, update, clear,
    get activeCount() { return slots.filter(s => s.customer).length; },
    get cartCount() { return carts.length; }, get slotCount() { return slots.length; } };
}
