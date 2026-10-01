// ... existing code ...
function createTwoInOneItem(x, y, z) {
    // Create a glowing, spinning star
    const starGroup = new THREE.Group();
    
    // Create star geometry
    const starGeometry = new THREE.BufferGeometry();
    const vertices = [];
    
    // Create a 5-pointed star
    const innerRadius = 0.2;
    const outerRadius = 0.4;
    const numPoints = 5;
    
    for (let i = 0; i < numPoints * 2; i++) {
        const radius = i % 2 === 0 ? outerRadius : innerRadius;
        const angle = (i / numPoints) * Math.PI;
        vertices.push(Math.cos(angle) * radius, Math.sin(angle) * radius, 0);
    }
    
    starGeometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    
    // Create lines for the star
    const starLines = new THREE.Line(
        starGeometry,
        new THREE.LineBasicMaterial({ 
            color: 0xFFFF00, 
            linewidth: 2,
            emissive: 0xFFFF00,
            emissiveIntensity: 1
        })
    );
    
    // Create a bright yellow point at each vertex
    const pointsMaterial = new THREE.PointsMaterial({ 
        color: 0xFFFF00, 
        size: 0.1,
        emissive: 0xFFFF00,
        emissiveIntensity: 1
    });
    const starPoints = new THREE.Points(starGeometry, pointsMaterial);
    
    // Add a glow effect with a sphere
    const glowGeometry = new THREE.SphereGeometry(0.3, 16, 16);
    const glowMaterial = new THREE.MeshBasicMaterial({ 
        color: 0xFFFF00, 
        transparent: true, 
        opacity: 0.5 
    });
    const glow = new THREE.Mesh(glowGeometry, glowMaterial);
    
    starGroup.add(starLines, starPoints, glow);
    starGroup.position.set(x, y, z);
    scene.add(starGroup);
    
    // Create physics body for interaction
    const shape = new CANNON.Box(new CANNON.Vec3(0.4, 0.4, 0.1));
    const body = new CANNON.Body({
        mass: 1,
        shape: shape,
        position: new CANNON.Vec3(x, y, z)
    });
    
    // Initially static but can be made dynamic when grabbed
    body.type = CANNON.Body.STATIC;
    world.addBody(body);
    
    // Add animation for spinning
    const twoInOneItem = {
        name: "2 in 1 Item",
        mesh: starGroup,
        body: body,
        size: [0.8, 0.8, 0.2],
        isOnSale: false,
        inCart: false,
        isCollected: false,
        isTwoInOne: true,
        initialPosition: { x, y, z },
        // Track which list items this star will permanently count for,
        // and whether its bonus has been applied to the list yet.
        twoInOneTargets: null,
        twoInOneApplied: false,
        update: function(time) {
            // Make it spin and bob up and down
            if (this.mesh && !this.inCart) {
                this.mesh.rotation.z = time * 0.5;
                this.mesh.position.y = y + Math.sin(time * 2) * 0.1;
                if (this.body) {
                    this.body.position.set(this.mesh.position.x, this.mesh.position.y, this.mesh.position.z);
                }
            }
        }
    };
    
    allItems.push(twoInOneItem);
    return twoInOneItem;
}

// NEW: Apply the 2‑in‑1 item's effect to its locked targets when placed into the cart.
function processTwoInOneItem(twoInOne) {
    if (!twoInOne || !twoInOne.isTwoInOne) return;

    // If we haven't chosen targets yet, lock them in permanently.
    if (!twoInOne.twoInOneTargets || twoInOne.twoInOneTargets.length === 0) {
        // Prefer items that are not fully collected yet
        const uncollectedItems = shoppingList.filter(item => item.collected < item.quantity);
        const pool = uncollectedItems.length > 0 ? uncollectedItems.slice() : shoppingList.slice();
        if (pool.length === 0) return;

        shuffleArray(pool);
        const targets = [];
        for (let i = 0; i < pool.length && targets.length < 2; i++) {
            targets.push(pool[i].name);
        }
        twoInOne.twoInOneTargets = targets;
    }

    // If we've already applied this star's bonus since the last reset, do nothing.
    if (twoInOne.twoInOneApplied) return;

    const targets = twoInOne.twoInOneTargets || [];
    let appliedCount = 0;
    targets.forEach(name => {
        updateShoppingListForItem(name);
        appliedCount++;
    });

    twoInOne.twoInOneApplied = true;
    twoInOneItemCollected = true;

    if (appliedCount > 0) {
        showPickupText(`2-in-1 item counted for ${appliedCount} items!`);
        try { sfxKey.currentTime = 0; sfxKey.play(); } catch (e) {}
    }
}
// ... existing code ...

// ... existing code ...
function grabItem() {
    if (heldItem) return;

    // Reuse shared raycaster/vector
    camera.getWorldDirection(sharedVec3);
    sharedRaycaster.set(camera.position, sharedVec3);

    // Only consider items that are not in the cart and are attached to the scene
    const itemMeshes = allItems
        .filter(item => !item.inCart && !item.inCustomerCart && item.mesh && item.mesh.parent) 
        .map(item => item.mesh);
    
    // NEW: extendo arm unlimited reach flag (for grabbing only)
    const unlimitedReach = powerupActive && currentPowerup === 'extendo_arm';
    
    // Check for checkout button first
    if (checkoutButton && !checkoutButton.pressed) {
        const buttonIntersection = sharedRaycaster.intersectObject(checkoutButton.mesh, true);
        if (buttonIntersection.length > 0) {
            const distance = buttonIntersection[0].distance;
            if (distance <= (unlimitedReach ? Infinity : CONFIG.ARM_REACH)) {
                // Button pressed!
                checkoutButton.pressed = true;
                checkoutButton.mesh.children[1].material.color.set(0xFF0000); // Change to red
                checkoutButton.mesh.children[1].material.emissive.set(0xAA0000);
                
                // Play button sound (reused)
                try { sfxKey.currentTime = 0; sfxKey.play(); } catch(e) {}
                
                // Removed pickup-related messages per request
                return;
            }
        }
    }

    const intersections = sharedRaycaster.intersectObjects(itemMeshes, true);

    if (intersections.length > 0) {
        const intersectedMesh = intersections[0].object;
        // robustly resolve the root item by walking parents
        const intersectedItem = allItems.find(item => {
            let obj = intersectedMesh;
            while (obj) { if (obj === item.mesh) return true; obj = obj.parent; }
            return false;
        });

        // Ignore items that are in the cart (should not be grabbable)
        if (intersectedItem && allItems.includes(intersectedItem) && !intersectedItem.inCart) {
            const distance = camera.position.distanceTo(intersectedItem.mesh.position);

            if (unlimitedReach || distance <= CONFIG.ARM_REACH * 1.8) {
                heldItem = intersectedItem;
                heldItem.isStatic = false;
                heldItem.inCart = false;
                // Disable collisions while held
                if (heldItem.body) { try { world.removeBody(heldItem.body); } catch(_) {} heldItem.body = null; }
                // Prepare smooth transition to held position in front of camera
                heldItem.mesh.visible = true;
                try {
                    heldItem.mesh.traverse((obj) => {
                        if (obj.isMesh && obj.material) {
                            if (Array.isArray(obj.material)) {
                                obj.material.forEach(m => { m.depthTest = false; m.depthWrite = false; });
                            } else {
                                obj.material.depthTest = false;
                                obj.material.depthWrite = false;
                            }
                        }
                        obj.renderOrder = 999;
                    });
                } catch(_) {}
                heldTransitionStart = performance.now();
                heldTransitionActive = true;
                heldItemPulling = false;
                soundEffects.grab.currentTime = 0;
                soundEffects.grab.play();
                // Mislabeled Item swap (no interference with drop/trip)
                const misChance = (CONFIG.MISLABELED_ITEM_CHANCE ?? (1/100));
                if (Math.random() < misChance) {
                    const originalName = heldItem.name;
                    const candidates = ITEMS.filter(it => it.name !== originalName);
                    const newTpl = candidates[Math.floor(Math.random() * candidates.length)];
                    if (newTpl && typeof newTpl.model === 'function') {
                        const oldMesh = heldItem.mesh;
                        const newMesh = newTpl.model();
                        newMesh.position.copy(oldMesh.position);
                        newMesh.quaternion.copy(oldMesh.quaternion);
                        try { newMesh.traverse(o => { if (o.isMesh && o.material){ (Array.isArray(o.material)?o.material:[o.material]).forEach(m=>{ m.depthTest=false; m.depthWrite=false; }); } o.renderOrder=999; }); } catch(_) {}
                        if (oldMesh.parent) oldMesh.parent.remove(oldMesh);
                        scene.add(newMesh);
                        heldItem.mesh = newMesh;
                        heldItem.name = newTpl.name;
                        heldItem.size = newTpl.size?.slice() || heldItem.size;
                        heldItem.isTwoInOne = false;
                        displayMessage(`This item was mislabeled as ${originalName}!`, 2200);
                    }
                }
                // 1-in-30 accidental drop chance on grab
                if (Math.random() * 100 < (CONFIG.DROP_ITEM_CHANCE ?? 0)) {
                    soundEffects.drop.currentTime = 0;
                    soundEffects.drop.play();
                    displayMessage("You accidentally dropped the item!", 2000, true);
                    releaseItem();
                    return;
                }

                // NEW: For 2-in-1 items, grabbing and dropping should not affect the list,
                // so we only play a "correct item" sound for normal items on the list.
                if (!heldItem.isTwoInOne) {
                    const isOnList = shoppingList.some(listItem => listItem.name === heldItem.name);
                    if (isOnList) {
                        try { sfxKey.currentTime = 0; sfxKey.play(); } catch(e) {}
                    }
                }
            } else {
                // No pickup messages
            }
        }
    }
}
// ... existing code ...

// ... existing code ...
function placeHeldItemInCart() {
    if (!heldItem) return;
    // Validate item correctness on cart placement (not on grab)
    let isOnList = shoppingList.some(listItem => listItem.name === heldItem.name);
    if (heldItem?.isTwoInOne) isOnList = true; // 2-in-1 always counts as correct

    // Hide and mark collected
    heldItem.inCart = true;
    if (!collectedItems.includes(heldItem)) collectedItems.push(heldItem);
    if (heldItem.mesh) {
        // Ensure it's fully removed from the scene graph so raycaster can't hit it
        if (heldItem.mesh.parent) heldItem.mesh.parent.remove(heldItem.mesh);
        heldItem.mesh.visible = false;
    }
    if (heldItem.body) { try { world.removeBody(heldItem.body); } catch(_) {} }

    // Only update shopping list for correct items
    if (isOnList) {
        updateShoppingListForItem(heldItem.name);
    } else {
        // Count a fail only when a wrong item is placed into the cart
        wrongItemsGrabbedCount++;
        // Optional feedback
        try { soundEffects.wrongItem.currentTime = 0; soundEffects.wrongItem.play(); } catch(e) {}
    }

    showPickupText(`Placed ${heldItem.name} in cart`);
    heldItemPulling = false;
    heldTransitionActive = false;
    heldItem = null;
    if (powerupActive && currentPowerup === 'eagle_eye') {
        clearEagleEyeOutlines();
        applyEagleEyeOutlines();
    }
}
// ... existing code ...

// ... existing code ...
function placeHeldItemInCart() {
    if (!heldItem) return;

    // Hide and mark collected
    heldItem.inCart = true;
    if (!collectedItems.includes(heldItem)) collectedItems.push(heldItem);
    if (heldItem.mesh) {
        // Ensure it's fully removed from the scene graph so raycaster can't hit it
        if (heldItem.mesh.parent) heldItem.mesh.parent.remove(heldItem.mesh);
        heldItem.mesh.visible = false;
    }
    if (heldItem.body) { try { world.removeBody(heldItem.body); } catch(_) {} }

    // Special handling for 2-in-1 items:
    // - They never count as "wrong".
    // - They only credit their locked targets the first time we put them into the cart
    //   since the last global list reset (trip/spill).
    if (heldItem.isTwoInOne) {
        processTwoInOneItem(heldItem);
    } else {
        // Normal items: only update shopping list for correct items
        const isOnList = shoppingList.some(listItem => listItem.name === heldItem.name);
        if (isOnList) {
            updateShoppingListForItem(heldItem.name);
        } else {
            // Count a fail only when a wrong item is placed into the cart
            wrongItemsGrabbedCount++;
            // Optional feedback
            try { soundEffects.wrongItem.currentTime = 0; soundEffects.wrongItem.play(); } catch(e) {}
        }
    }

    showPickupText(`Placed ${heldItem.name} in cart`);
    heldItemPulling = false;
    heldTransitionActive = false;
    heldItem = null;
    if (powerupActive && currentPowerup === 'eagle_eye') {
        clearEagleEyeOutlines();
        applyEagleEyeOutlines();
    }
}
// ... existing code ...

function triggerTrip() {
    if (tripped || !cartAttached) return;
    tripped = true;
    tripCount++; // Increment trip count
    soundEffects.trip.play();
    displayMessage("Oops! You tripped!", 3000);

    // Capture pre-trip attachment state, then detach cart so you must reattach it manually
    const wasAttached = cartAttached;
    cartAttached = false;

    // Make all collected items fall out of the cart ONLY if it was attached at the moment of trip
    if (wasAttached && collectedItems.length > 0) {
        itemsFallenCount += collectedItems.length; // Increment items fallen count
        const cartPos = new THREE.Vector3();
        cartObject.getWorldPosition(cartPos);
        
        collectedItems.forEach(item => {
            // Make the item visible again
            item.mesh.visible = true;
            
            // Remove from current parent if it has one
            if (item.mesh && item.mesh.parent) {
                item.mesh.parent.remove(item.mesh);
            }
            
            // Remove the old physics body if it exists
            if (item.body) {
                world.removeBody(item.body);
            }
            
            // Create a new physics body for the item
            const shape = new CANNON.Box(new CANNON.Vec3(
                item.size[0]/2,
                item.size[1]/2,
                item.size[2]/2
            ));
            
            item.body = new CANNON.Body({
                mass: 1,
                shape: shape
            });
            
            // Position randomly around the cart
            const randomX = cartPos.x + (Math.random() - 0.5) * 2;
            const randomZ = cartPos.z + (Math.random() - 0.5) * 2;
            
            item.mesh.position.set(randomX, cartPos.y + 0.5, randomZ);
            item.body.position.set(randomX, cartPos.y + 0.5, randomZ);
            
            // Add random velocity for more realistic scattering
            item.body.velocity.set(
                (Math.random() - 0.5) * 2,
                2 + Math.random() * 2,
                (Math.random() - 0.5) * 2
            );
            
            world.addBody(item.body);
            scene.add(item.mesh);
            
            // Update item state
            item.inCart = false;
        });
        
        // Clear the collected items array
        collectedItems = [];
        // Reset all shopping list collected counts since items fell out of attached cart
        shoppingList.forEach(item => {
            item.collected = 0;
        });
        updateShoppingListDisplay();
    }
    
    // Briefly disable movement controls and show a caution message
    setTimeout(() => {
        tripped = false;
        displayMessage("Careful now!", 2000);
        // After trip ends, reset camera tilt to normal view after ~1s
        setTimeout(() => {
            cameraFlickActive = false;
            cameraFlickStrength = 0;
            camera.rotation.x = 0;
            camera.rotation.z = 0;
            camera.updateProjectionMatrix();
        }, 1000);
    }, 3000);
    
    // Stop horizontal movement and apply a strong vertical fling to the player
    playerBody.velocity.x = 0;
    playerBody.velocity.z = 0;
    playerBody.velocity.y = 6; // fling camera/player much higher

    // Visual trip animation: strong camera flick + stronger cart fling
    cameraFlickActive = true; 
    cameraFlickElapsed = 0; 
    cameraBasePitch = camera.rotation.x;
    cameraFlickStrength = 1.1; // much stronger than before
    if (cartObject) { cartFlingActive = true; cartFlingStartY = cartObject.position.y;
        cartFlingVel.set((Math.random()-0.5)*4, 14, (Math.random()-0.5)*4); // higher and farther
    }
}
// ... existing code ...

function triggerTrip() {
    if (tripped || !cartAttached) return;
    tripped = true;
    tripCount++; // Increment trip count
    soundEffects.trip.play();
    displayMessage("Oops! You tripped!", 3000);

    // Capture pre-trip attachment state, then detach cart so you must reattach it manually
    const wasAttached = cartAttached;
    cartAttached = false;

    // Make all collected items fall out of the cart ONLY if it was attached at the moment of trip
    if (wasAttached && collectedItems.length > 0) {
        itemsFallenCount += collectedItems.length; // Increment items fallen count
        const cartPos = new THREE.Vector3();
        cartObject.getWorldPosition(cartPos);
        
        collectedItems.forEach(item => {
            // Make the item visible again
            item.mesh.visible = true;
            
            // Remove from current parent if it has one
            if (item.mesh && item.mesh.parent) {
                item.mesh.parent.remove(item.mesh);
            }
            
            // Remove the old physics body if it exists
            if (item.body) {
                world.removeBody(item.body);
            }
            
            // Create a new physics body for the item
            const shape = new CANNON.Box(new CANNON.Vec3(
                item.size[0]/2,
                item.size[1]/2,
                item.size[2]/2
            ));
            
            item.body = new CANNON.Body({
                mass: 1,
                shape: shape
            });
            
            // Position randomly around the cart
            const randomX = cartPos.x + (Math.random() - 0.5) * 2;
            const randomZ = cartPos.z + (Math.random() - 0.5) * 2;
            
            item.mesh.position.set(randomX, cartPos.y + 0.5, randomZ);
            item.body.position.set(randomX, cartPos.y + 0.5, randomZ);
            
            // Add random velocity for more realistic scattering
            item.body.velocity.set(
                (Math.random() - 0.5) * 2,
                2 + Math.random() * 2,
                (Math.random() - 0.5) * 2
            );
            
            world.addBody(item.body);
            scene.add(item.mesh);
            
            // Update item state
            item.inCart = false;
        });
        
        // Clear the collected items array
        collectedItems = [];
        // Reset all shopping list collected counts since items fell out of attached cart
        shoppingList.forEach(item => {
            item.collected = 0;
        });
        updateShoppingListDisplay();

        // NEW: allow existing 2-in-1 items to re-apply their locked bonus
        // the next time they are placed back into the cart.
        allItems.forEach(it => {
            if (it.isTwoInOne) {
                it.twoInOneApplied = false;
            }
        });
    }
    
    // Briefly disable movement controls and show a caution message
    setTimeout(() => {
        tripped = false;
        displayMessage("Careful now!", 2000);
        // After trip ends, reset camera tilt to normal view after ~1s
        setTimeout(() => {
            cameraFlickActive = false;
            cameraFlickStrength = 0;
            camera.rotation.x = 0;
            camera.rotation.z = 0;
            camera.updateProjectionMatrix();
        }, 1000);
    }, 3000);
    
    // Stop horizontal movement and apply a strong vertical fling to the player
    playerBody.velocity.x = 0;
    playerBody.velocity.z = 0;
    playerBody.velocity.y = 6; // fling camera/player much higher

    // Visual trip animation: strong camera flick + stronger cart fling
    cameraFlickActive = true; 
    cameraFlickElapsed = 0; 
    cameraBasePitch = camera.rotation.x;
    cameraFlickStrength = 1.1; // much stronger than before
    if (cartObject) { cartFlingActive = true; cartFlingStartY = cartObject.position.y;
        cartFlingVel.set((Math.random()-0.5)*4, 14, (Math.random()-0.5)*4); // higher and farther
    }
}
// ... existing code ...

function dropAllItems() {
    if (!cartAttached) return; // Only drop items if cart is attached
    displayMessage("Oh no! You slipped and dropped all the items!", 3000);

    // Do NOT auto-drop the currently held item
    // (Previously: releaseItem(); removed so held items remain hovering)

    // Make all collected items fall out of the cart
    if (collectedItems.length > 0) {
        itemsFallenCount += collectedItems.length; // Increment items fallen count
        const cartPos = new THREE.Vector3();
        cartObject.getWorldPosition(cartPos);

        collectedItems.forEach(item => {
            // Make the item visible again
            item.mesh.visible = true;
            // Restore proper depth so occlusion works
            try {
                item.mesh.traverse(o => {
                    if (o.isMesh && o.material) {
                        if (Array.isArray(o.material)) o.material.forEach(m => { m.depthTest = true; m.depthWrite = true; });
                        else { o.material.depthTest = true; o.material.depthWrite = true; }
                    }
                    o.renderOrder = 0;
                });
            } catch(_) {}
        });

        collectedItems.forEach(item => {
            // Make the item visible again
            item.mesh.visible = true;

            // Remove from current parent if it has one
            if (item.mesh && item.mesh.parent) {
                item.mesh.parent.remove(item.mesh);
            }

            // Remove the old physics body if it exists
            if (item.body) {
                world.removeBody(item.body);
            }

            // Create a new physics body for the item
            const shape = new CANNON.Box(new CANNON.Vec3(
                item.size[0]/2,
                item.size[1]/2,
                item.size[2]/2
            ));

            item.body = new CANNON.Body({
                mass: 1,
                shape: shape
            });

            // Position randomly around the cart
            const randomX = cartPos.x + (Math.random() - 0.5) * 2;
            const randomZ = cartPos.z + (Math.random() - 0.5) * 2;

            item.mesh.position.set(randomX, cartPos.y + 0.5, randomZ);
            item.body.position.set(randomX, cartPos.y + 0.5, randomZ);

            // Add random velocity for more realistic scattering
            item.body.velocity.set(
                (Math.random() - 0.5) * 2,
                2 + Math.random() * 2,
                (Math.random() - 0.5) * 2
            );

            world.addBody(item.body);
            scene.add(item.mesh);

            // Update item state
            item.inCart = false;
        });

        // Clear the collected items array
        collectedItems = [];
    }

    // Reset all shopping list collected counts
    shoppingList.forEach(item => {
        item.collected = 0;
    });
    updateShoppingListDisplay();
}
// ... existing code ...

function dropAllItems() {
    if (!cartAttached) return; // Only drop items if cart is attached
    displayMessage("Oh no! You slipped and dropped all the items!", 3000);

    // Do NOT auto-drop the currently held item
    // (Previously: releaseItem(); removed so held items remain hovering)

    // Make all collected items fall out of the cart
    if (collectedItems.length > 0) {
        itemsFallenCount += collectedItems.length; // Increment items fallen count
        const cartPos = new THREE.Vector3();
        cartObject.getWorldPosition(cartPos);

        collectedItems.forEach(item => {
            // Make the item visible again
            item.mesh.visible = true;
            // Restore proper depth so occlusion works
            try {
                item.mesh.traverse(o => {
                    if (o.isMesh && o.material) {
                        if (Array.isArray(o.material)) o.material.forEach(m => { m.depthTest = true; m.depthWrite = true; });
                        else { o.material.depthTest = true; o.material.depthWrite = true; }
                    }
                    o.renderOrder = 0;
                });
            } catch(_) {}
        });

        collectedItems.forEach(item => {
            // Make the item visible again
            item.mesh.visible = true;

            // Remove from current parent if it has one
            if (item.mesh && item.mesh.parent) {
                item.mesh.parent.remove(item.mesh);
            }

            // Remove the old physics body if it exists
            if (item.body) {
                world.removeBody(item.body);
            }

            // Create a new physics body for the item
            const shape = new CANNON.Box(new CANNON.Vec3(
                item.size[0]/2,
                item.size[1]/2,
                item.size[2]/2
            ));

            item.body = new CANNON.Body({
                mass: 1,
                shape: shape
            });

            // Position randomly around the cart
            const randomX = cartPos.x + (Math.random() - 0.5) * 2;
            const randomZ = cartPos.z + (Math.random() - 0.5) * 2;

            item.mesh.position.set(randomX, cartPos.y + 0.5, randomZ);
            item.body.position.set(randomX, cartPos.y + 0.5, randomZ);

            // Add random velocity for more realistic scattering
            item.body.velocity.set(
                (Math.random() - 0.5) * 2,
                2 + Math.random() * 2,
                (Math.random() - 0.5) * 2
            );

            world.addBody(item.body);
            scene.add(item.mesh);

            // Update item state
            item.inCart = false;
        });

        // Clear the collected items array
        collectedItems = [];
    }

    // Reset all shopping list collected counts
    shoppingList.forEach(item => {
        item.collected = 0;
    });
    updateShoppingListDisplay();

    // NEW: allow existing 2-in-1 items to re-apply their locked bonus
    // the next time they are placed back into the cart.
    allItems.forEach(it => {
        if (it.isTwoInOne) {
            it.twoInOneApplied = false;
        }
    });
}
// ... existing code ...

