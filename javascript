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

