// Transactional checkout: real groceries into sealed three-item bags.
// Every bag shares one low-poly geometry/material; no extra physics world.
function bagAssets(THREE) {
    const positions=[], colors=[];
    const quad=(a,b,c,d,color)=>{for(const p of [a,b,c,a,c,d]){positions.push(...p);colors.push(...color);}};
    const paper=[0.82,0.69,0.46], print=[0.08,0.32,0.21];
    const ring=(y,x,z)=>[[-x,y,-z],[x,y,-z],[x,y,z],[-x,y,z]];
    const bottom=ring(-0.21,0.16,0.19), top=ring(0.19,0.145,0.17);
    for(let i=0;i<4;i++)quad(bottom[i],bottom[(i+1)%4],top[(i+1)%4],top[i],paper);
    quad(...[...bottom].reverse(),paper);quad(...top,paper);
    // Flat loop handles instead of high-segment toruses or transparency.
    for(const z of [-0.12,0.12]){
        const outer=[[-0.10,0.19,z],[-0.10,0.34,z],[0.10,0.34,z],[0.10,0.19,z]];
        const inner=[[-0.065,0.19,z],[-0.065,0.305,z],[0.065,0.305,z],[0.065,0.19,z]];
        for(let i=0;i<3;i++)quad(outer[i],outer[i+1],inner[i+1],inner[i],paper);
    }
    quad([-0.13,-0.02,0.183],[0.13,-0.02,0.183],[0.13,0.045,0.179],[-0.13,0.045,0.179],print);
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
    geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));geometry.computeVertexNormals();
    return {geometry,material:new THREE.MeshLambertMaterial({vertexColors:true,side:THREE.DoubleSide})};
}

export function createCheckoutConveyor({THREE,scene,cart,counter,items,removeBody,
    restoreBody,onScan,onProgress,basket={floorY:0.511,halfW:0.49,halfL:0.742}}){
    const queue=[...new Set(items)].filter(item=>item?.inCart&&item.mesh?.parent===cart);
    const snapshots=queue.map(item=>({item,position:item.mesh.position.clone(),
        quaternion:item.mesh.quaternion.clone(),scale:item.mesh.scale.clone(),visible:item.mesh.visible}));
    const assets=bagAssets(THREE),bags=[];
    const start=new THREE.Vector3(),belt=new THREE.Vector3(),scanner=new THREE.Vector3();
    const bagPoint=new THREE.Vector3(),bagEnd=new THREE.Vector3(),bagStart=new THREE.Vector3();
    const upright=new THREE.Quaternion(),worldQuat=new THREE.Quaternion(),bounds=new THREE.Box3();
    let index=0,current=null,phase='item',elapsed=0,scanned=0,elapsedTotal=0;
    let disposed=false,committed=false,released=false,activeBag=null,returned=0;
    // ~1 second/item normally. Compress big carts to a 22-second total budget,
    // including cashier arrival, without discarding elapsed time at low FPS.
    const work=queue.length*0.78+Math.ceil(queue.length/3)*0.42;
    function newBag(){
        const mesh=new THREE.Mesh(assets.geometry,assets.material);
        const contents=new THREE.Group();contents.visible=false;mesh.add(contents);
        const bag={items:[],mesh,contents,loaded:false};
        counter.localToWorld(mesh.position.set(-2.15,1.26,0.15));scene.add(mesh);bags.push(bag);return bag;
    }
    function beginItem(){
        if(!activeBag)activeBag=newBag();
        const saved=snapshots[index],item=saved.item;current={...saved,scanned:false};
        item.mesh.getWorldPosition(start);item.mesh.getWorldQuaternion(worldQuat);
        removeBody(item);scene.attach(item.mesh);item.checkoutTransit=true;
        item.mesh.visible=true;item.mesh.quaternion.identity();bounds.setFromObject(item.mesh);
        const offset=item.mesh.position.y-bounds.min.y;
        counter.localToWorld(belt.set(2.25,1.009+offset,0.15));
        counter.localToWorld(scanner.set(-0.95,1.037+offset,0.15));
        activeBag.mesh.getWorldPosition(bagPoint);bagPoint.y+=0.1;
    }
    function putInBag(){
        const item=current.item;activeBag.contents.add(item.mesh);item.mesh.visible=false;
        item.checkoutTransit=false;item.checkoutBag=activeBag;activeBag.items.push(item);current=null;index++;
        if(activeBag.items.length===3||index===queue.length){
            phase='bag';activeBag.mesh.getWorldPosition(bagStart);const slot=bags.length-1;
            cart.localToWorld(bagEnd.set((slot%2?1:-1)*Math.min(0.21,basket.halfW-0.17),
                basket.floorY+0.215+Math.floor(slot/6)*0.43,
                (Math.floor(slot/2)%3-1)*Math.min(0.43,basket.halfL-0.19)));
        }
    }
    function release(restore){
        if(released)return;released=true;
        for(const saved of snapshots){
            const {item,position,quaternion,scale,visible}=saved;
            cart.add(item.mesh);item.mesh.position.copy(position);item.mesh.quaternion.copy(quaternion);
            item.mesh.scale.copy(scale);item.mesh.visible=visible;item.checkoutTransit=false;delete item.checkoutBag;
            if(restore)restoreBody(item,position,quaternion);
        }
        for(const bag of bags)bag.mesh.removeFromParent();assets.geometry.dispose();assets.material.dispose();
    }
    return {
        get done(){return returned===queue.length&&!current&&phase==='item';},
        get total(){return queue.length;},get item(){return current?.item||null;},
        get bags(){return bags;},get elapsed(){return elapsedTotal;},
        get registerFallback(){return elapsedTotal>=10;},
        update(delta,ready,speed=1){
            if(disposed||this.done)return;
            const dt=Math.max(0,Number.isFinite(delta)?delta:0),previous=elapsedTotal;elapsedTotal+=dt;
            // Never softlock payment on a physically blocked worker. The register
            // auto-scans after 10 seconds; the attendant still walks his real route.
            if(!ready&&elapsedTotal<10)return;
            const activeDt=ready?dt:elapsedTotal-Math.max(previous,10);
            const rate=Math.max(1,work/Math.max(1,22-Math.min(previous,10)))*Math.max(1,Math.min(3,speed));
            let remaining=activeDt*rate;
            while(remaining>1e-8&&!this.done){
                if(phase==='item'&&!current)beginItem();
                const duration=phase==='bag'?0.42:0.78;
                const step=Math.min(remaining,duration-elapsed);elapsed+=step;remaining-=step;
                const t=elapsed/duration,ease=t*t*(3-2*t);
                if(phase==='bag'){
                    activeBag.mesh.position.lerpVectors(bagStart,bagEnd,ease);
                    activeBag.mesh.position.y+=Math.sin(t*Math.PI)*0.5;
                    if(elapsed>=duration-1e-8){
                        cart.attach(activeBag.mesh);activeBag.loaded=true;returned+=activeBag.items.length;
                        activeBag=null;phase='item';elapsed=0;onProgress(scanned,returned,queue.length);
                    }
                }else{
                    const mesh=current.item.mesh;
                    if(t<0.25){
                        const u=t/0.25;mesh.position.lerpVectors(start,belt,u);mesh.position.y+=Math.sin(u*Math.PI)*0.55;
                        mesh.quaternion.slerpQuaternions(worldQuat,upright,u);
                    }else if(t<0.7){mesh.position.lerpVectors(belt,scanner,(t-0.25)/0.45);mesh.quaternion.copy(upright);}
                    else{
                        if(!current.scanned){current.scanned=true;scanned++;onScan(current.item);onProgress(scanned,returned,queue.length);}
                        const u=(t-0.7)/0.3;mesh.position.lerpVectors(scanner,bagPoint,u);mesh.position.y+=Math.sin(u*Math.PI)*0.25;
                    }
                    if(elapsed>=duration-1e-8){putInBag();elapsed=0;}
                }
            }
        },
        commit(){
            if(disposed||!this.done)return null;committed=true;
            return {bags,dispose:()=>release(false),loadBag:bag=>{if(bags.includes(bag))bag.mesh.visible=false;}};
        },
        dispose(){if(disposed)return;disposed=true;if(!committed)release(true);}
    };
}
