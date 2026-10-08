// Small, per-run traffic controller. Reuses the existing shoppers, physics
// bodies, indoor A* grid and instanced cars; no per-frame path searches/timers.
const EXIT = { x: 2.5, z: -26.5 }, ENTRY = { x: -2.5, z: -26.5 };
const wrapAngle = a => Math.atan2(Math.sin(a), Math.cos(a));
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

export function createShopperTraffic({ cars, grid, findPath, clampToWalkable, isWalkable, random = Math.random }) {
    const queue = [];
    let nextQueueCheck = 0;
    function route(cust, points, target, mode) {
        cust.nav = { path: points, waypointIdx: 0, target, nextRepath: Infinity };
        cust.nextTargetMode = mode;
        cust.lastProgressTime = 0;
        cust.stuckCount = 0;
    }
    function indoorPath(cust, target) {
        return findPath(grid, cust.body.position, target, { strict: true });
    }
    function claimCar(cust) {
        if (cust.usesShoppingCart === undefined) cust.usesShoppingCart = !!cust.hasCart;
        if (cust.assignedCar?.shopper === cust) return cust.assignedCar;
        const car = cars.find(c => c.shopperCar && !c.shopper && !c.isDriving);
        if (!car) return null; // Never steal another shopper's moving car.
        car.shopper = cust; car.assigned = true; cust.assignedCar = car;
        car.origX = car.x; car.origZ = car.z; car.origHeading = car.heading;
        car.driveState = 'parked';
        return car;
    }
    function carDoor(car) {
        // Front-quarter door approach stays out of the narrow inter-car gaps.
        return { x: car.origX - Math.cos(car.origHeading) * 1.25,
            z: car.origZ + Math.cos(car.origHeading) * 2.6 };
    }
    function releaseQueue(cust) {
        const index = queue.indexOf(cust);
        if (index >= 0) queue.splice(index, 1);
        cust.checkoutQueued = false; cust.checkoutSlot = -1; cust.checkoutUntil = 0;
        nextQueueCheck = 0;
    }
    function slotPoint(index) {
        // The player keeps the north side of the belt. The NPC service point
        // is at its east end, with a 3m-spaced line across the front plaza.
        const wanted = index === 0 ? { x: 21, z: -15 } : { x: 21 - (index - 1) * 3, z: -21 };
        return clampToWalkable(grid, wanted.x, wanted.z);
    }
    function syncQueue(now, force = false) {
        if (!force && now < nextQueueCheck) return;
        nextQueueCheck = now + 250;
        for (let i = queue.length - 1; i >= 0; i--) {
            const c = queue[i];
            if (!c.body || c.visible === false || !['navigating','checkout_wait','checkout'].includes(c.behaviorState)) releaseQueue(c);
        }
        queue.forEach((c, i) => {
            if (c.checkoutSlot === i && c.nav?.path?.length) return;
            c.checkoutSlot = i; c.checkoutUntil = 0;
            const target = slotPoint(i), path = indoorPath(c, target);
            route(c, path, target, 'checkout_wait'); c.behaviorState = 'navigating';
        });
    }
    function joinQueue(cust, now) {
        cust.journey = null;
        if (!queue.includes(cust)) { queue.push(cust); cust.checkoutSlot = -1; }
        cust.checkoutQueued = true; cust.behaviorState = 'navigating';
        syncQueue(now, true);
    }
    function walkToCar(cust) {
        releaseQueue(cust); claimCar(cust); cust.journey = 'out';
        const car = cust.assignedCar;
        const p = cust.body.position;
        const outdoor = p.z >= -27 ? [{ x: 1.65, z: -28.5 }, { x: 1.65, z: -33 }, { x: 0.9, z: -39 }]
            : p.z > -33 ? [{ x: 1.65, z: -33 }, { x: 0.9, z: -39 }]
            : p.z > -45 ? [{ x: 0.9, z: -39 }] : [];
        if (car) {
            const door = carDoor(car);
            const load = cust.hasCart ? { x: car.origX, z: car.origZ + Math.cos(car.origHeading) * 4.5 } : door;
            outdoor.push({ x: p.z < -45 ? p.x : 0.9, z: car.aisleZ }, { x: load.x, z: car.aisleZ }, load);
        } else outdoor.push({ x: 0.9, z: -60 });
        const points = p.z >= -27 ? [...indoorPath(cust, EXIT), EXIT, ...outdoor] : outdoor;
        route(cust, points, outdoor.at(-1), 'car'); cust.behaviorState = 'walking_to_car';
    }
    function walkIntoStore(cust) {
        const car = cust.assignedCar, p = cust.body.position;
        const points = car ? [{ x: p.x, z: car.aisleZ }, { x: -0.9, z: car.aisleZ }] : [];
        points.push({ x: -0.9, z: -39 }, { x: -1.65, z: -33 }, { x: -1.65, z: -28.5 }, ENTRY);
        cust.journey = 'in'; cust.behaviorState = 'walking_into_store';
        route(cust, points, ENTRY, 'enter_store');
    }
    function setVisible(cust, visible) {
        cust.visible = visible;
        cust.body.velocity.set(0, 0, 0);
        cust.body.collisionFilterMask = visible ? 1 | 2 | 4 : 0;
        cust.body.collisionResponse = visible;
        if (cust.cart) {
            const cartVisible = visible && (cust.hasCart || cust.cartParked);
            cust.cart.group.visible = cartVisible;
            cust.cart.body.collisionFilterMask = cartVisible ? 1 | 2 | 8 : 0;
            cust.cart.body.collisionResponse = cartVisible;
        }
    }
    function clearGoods(cust) {
        cust.handItem?.mesh?.removeFromParent(); cust.handItem = null;
        for (const item of cust.cart?.items || []) item.mesh?.removeFromParent();
        if (cust.cart) cust.cart.items.length = 0;
        cust.itemsGathered = 0; cust.hasStolenItem = false;
    }
    function vehicleRoute(car, arriving) {
        const side = car.origX < 0 ? -1 : 1;
        const laneZ = car.aisleZ + side * (arriving ? 1.3 : -1.3);
        const points = [{ x: car.origX, z: laneZ }, { x: side * 104, z: laneZ },
            { x: side * 112, z: -105 }, { x: side * 170, z: -105 }];
        return arriving ? [...points.reverse(), { x: car.origX, z: car.origZ }] : points;
    }
    function scheduleArrival(cust, delay = 8 + random() * 12) {
        releaseQueue(cust); const car = claimCar(cust);
        cust.hasCart = false; cust.cartParked = false;
        setVisible(cust, false); cust.behaviorState = 'respawning'; cust.journey = null;
        if (car) {
            const end = vehicleRoute(car, false).at(-1);
            car.x = end.x; car.z = end.z; car.driveState = 'away'; car.isDriving = true; car.wait = delay;
        } else cust.arrivalWait = delay;
    }
    function boardCar(cust) {
        clearGoods(cust); cust.hasCart = false; cust.cartParked = false;
        setVisible(cust, false); cust.behaviorState = 'respawning'; cust.journey = null;
        const car = cust.assignedCar;
        if (car) {
            car.driveState = 'departing'; car.isDriving = true;
            car.route = vehicleRoute(car, false); car.waypoint = 0; car.driveSpeed = 0;
        } else cust.arrivalWait = 10 + random() * 8;
    }
    function arrived(cust, now) {
        if (cust.journey === 'boarding') { boardCar(cust); return true; }
        if (cust.journey === 'out') {
            cust.behaviorState = 'loading_car'; cust.trafficUntil = now + 1100;
            cust.body.velocity.set(0, 0, 0); return true;
        }
        if (cust.journey === 'in') {
            cust.journey = null; cust.nextTargetMode = null; cust.itemsGathered = 0;
            cust.hasCart = cust.usesShoppingCart; cust.cartParked = false;
            setVisible(cust, true); // Collect their empty cart at the store entrance.
            cust.shoppingListQuota = 2 + Math.floor(random() * 4);
            cust.behaviorState = 'navigating'; return true;
        }
        return false;
    }
    function updateCustomer(cust, now, dt) {
        if (cust.behaviorState === 'loading_car') {
            cust.body.velocity.set(0, 0, 0);
            if (now >= cust.trafficUntil) {
                if (cust.hasCart && cust.assignedCar) {
                    clearGoods(cust); cust.hasCart = false; cust.cartParked = true;
                    const door = carDoor(cust.assignedCar);
                    route(cust, [door], door, 'board');
                    cust.journey = 'boarding'; cust.behaviorState = 'walking_to_car';
                } else boardCar(cust);
            }
            return true;
        }
        if (cust.behaviorState === 'getting_out') {
            cust.body.velocity.set(0, 0, 0);
            if (now >= cust.trafficUntil) walkIntoStore(cust);
            return true;
        }
        if (cust.behaviorState === 'respawning' && !cust.assignedCar) {
            cust.arrivalWait -= dt;
            if (cust.arrivalWait <= 0) {
                cust.body.position.set(-0.9, cust.groundBodyY || 0.9, -60);
                setVisible(cust, true); walkIntoStore(cust);
            }
        }
        return cust.behaviorState === 'respawning';
    }
    function canWalk(x, z) {
        if (z < -30.6) return true; // Explicit parking-aisle / crosswalk routes.
        if (z < -27) return Math.abs(x) <= 2.45; // Real doorway, not the grid's wall buffer.
        return isWalkable(grid, x, z);
    }
    function updateCars(dt, now, onTransform) {
        let changed = false;
        cars.forEach((car, i) => {
            if (!car.isDriving || !car.shopper) return;
            changed = true;
            if (car.driveState === 'away') {
                car.wait -= dt;
                if (car.wait <= 0) {
                    car.driveState = 'arriving'; car.route = vehicleRoute(car, true);
                    car.waypoint = 1; car.driveSpeed = 0;
                    const next = car.route[car.waypoint];
                    car.heading = Math.atan2(next.x - car.x, next.z - car.z);
                }
            } else {
                let remaining = Math.min(dt, 0.5);
                // Stable turn arcs at low FPS; at most 15 cheap steps/car/frame.
                while (remaining > 1e-6 && car.route) {
                    const step = Math.min(remaining, 1 / 30); remaining -= step;
                    const goal = car.route[car.waypoint], d = distance(car, goal);
                    if (d < 0.45) {
                        if (++car.waypoint >= car.route.length) {
                            car.route = null;
                            if (car.driveState === 'departing') {
                                car.driveState = 'away'; car.wait = 8 + random() * 12;
                            } else {
                                car.x = car.origX; car.z = car.origZ; car.heading = car.origHeading;
                                car.driveState = 'parked'; car.isDriving = false;
                                const c = car.shopper, door = carDoor(car);
                                c.body.position.set(door.x, c.groundBodyY || 0.9, door.z);
                                c.body.aabbNeedsUpdate = true; c.position.set(door.x, 0, door.z);
                                setVisible(c, true); c.behaviorState = 'getting_out'; c.trafficUntil = now + 800;
                            }
                            break;
                        }
                        continue;
                    }
                    const turn = wrapAngle(Math.atan2(goal.x - car.x, goal.z - car.z) - car.heading);
                    car.heading += Math.max(-step * 2.4, Math.min(step * 2.4, turn));
                    const parking = Math.abs(car.x - car.origX) < 3 && Math.abs(car.z - car.origZ) < 8;
                    let limit = Math.abs(turn) > 0.5 ? 1.2 : parking ? 2.5 : 9;
                    const fx = Math.sin(car.heading), fz = Math.cos(car.heading);
                    // Cars yield at crosswalks and to traffic ahead. Only the
                    // existing small shopper/car pools are checked, no rays.
                    for (let otherIndex = 0; otherIndex < cars.length; otherIndex++) {
                        const other = cars[otherIndex];
                        if (other === car) continue;
                        const p = other.shopper?.body?.position;
                        if (other.shopper?.visible !== false && p) {
                            const dx = p.x - car.x, dz = p.z - car.z, ahead = dx * fx + dz * fz;
                            if (ahead > 0 && ahead < 4.8 && Math.abs(dx * fz - dz * fx) < 1.5) limit = 0;
                        }
                        if (!other.isDriving || !['departing','arriving'].includes(other.driveState)) continue;
                        const dx = other.x - car.x, dz = other.z - car.z, ahead = dx * fx + dz * fz;
                        const aligned = fx * Math.sin(other.heading) + fz * Math.cos(other.heading) > 0.7;
                        if (ahead > 0 && ahead < 6 && Math.abs(dx * fz - dz * fx) < 1.95 &&
                            (aligned || i > otherIndex)) limit = 0;
                    }
                    car.driveSpeed += Math.max(-step * 10, Math.min(step * 3.5, limit - car.driveSpeed));
                    const travel = Math.min(d, car.driveSpeed * step);
                    car.x += Math.sin(car.heading) * travel; car.z += Math.cos(car.heading) * travel;
                }
            }
            onTransform(i, car);
        });
        return changed;
    }
    return { claimCar, joinQueue, releaseQueue, syncQueue, walkToCar, arrived, updateCustomer,
        canWalk, scheduleArrival, updateCars, isFront: cust => queue[0] === cust,
        queue, carDoor, slotPoint };
}
