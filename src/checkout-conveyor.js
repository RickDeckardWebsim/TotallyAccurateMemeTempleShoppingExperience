// Transactional checkout: unload the real groceries together, scan individually,
// then return sealed three-item bags. Bags share one low-poly geometry/material.
function bagAssets(THREE) {
    const positions=[], colors=[];
    const quad=(a,b,c,d,color)=>{for(const p of [a,b,c,a,c,d]){positions.push(...p);colors.push(...color);}};
    const paper=[0.82,0.69,0.46], print=[0.08,0.32,0.21];
    const ring=(y,x,z)=>[[-x,y,-z],[x,y,-z],[x,y,z],[-x,y,z]];
    const bottom=ring(-0.21,0.16,0.19), top=ring(0.19,0.145,0.17);
    for(let i=0;i<4;i++)quad(bottom[i],bottom[(i+1)%4],top[(i+1)%4],top[i],paper);
    quad(...[...bottom].reverse(),paper);quad(...top,paper);
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

const UNLOAD_SECONDS=0.9, STAFF_GRACE_SECONDS=1.5, BAGGED_DEADLINE_SECONDS=9;
// The remaining second covers payment, UI handoff and ordinary frame rounding.
export function createCheckoutConveyor({THREE,scene,cart,counter,items,removeBody,
    restoreBody,onScan,onProgress,basket={floorY:0.511,halfW:0.49,halfL:0.742}}){
    const queue=[...new Set(items)].filter(item=>item?.inCart&&item.mesh?.parent===cart);
    const snapshots=queue.map(item=>({item,position:item.mesh.position.clone(),
        quaternion:item.mesh.quaternion.clone(),scale:item.mesh.scale.clone(),visible:item.mesh.visible}));
    const assets=bagAssets(THREE),bags=[];
    const scanner=new THREE.Vector3(),scanStart=new THREE.Vector3(),bagPoint=new THREE.Vector3();
    const bagEnd=new THREE.Vector3(),bagStart=new THREE.Vector3(),bounds=new THREE.Box3(),size=new THREE.Vector3();
    const upright=counter.getWorldQuaternion(new THREE.Quaternion());
    let index=0,current=null,phase='item',elapsed=0,scanned=0,elapsedTotal=0,processingAt=null,rate=1;
    let disposed=false,committed=false,released=false,activeBag=null,returned=0;
    const work=queue.length*0.42+Math.ceil(queue.length/3)*0.20;

    // Measure once, suspend basket bodies, and reuse the original meshes.
    let maxW=0.01,maxD=0.01,maxH=0.01;
    for(const saved of snapshots){
        const mesh=saved.item.mesh;
        saved.from=mesh.getWorldPosition(new THREE.Vector3());
        saved.fromQuat=mesh.getWorldQuaternion(new THREE.Quaternion());
        removeBody(saved.item);scene.attach(mesh);saved.worldScale=mesh.scale.clone();
        mesh.position.set(0,0,0);mesh.quaternion.identity();bounds.setFromObject(mesh);
        bounds.getSize(size);maxW=Math.max(maxW,size.x);maxD=Math.max(maxD,size.z);maxH=Math.max(maxH,size.y);
        saved.offset=new THREE.Vector3(-(bounds.min.x+bounds.max.x)/2,-bounds.min.y,-(bounds.min.z+bounds.max.z)/2);
        saved.target=new THREE.Vector3();
        mesh.position.copy(saved.from);mesh.quaternion.copy(saved.fromQuat);mesh.visible=true;
        saved.item.checkoutTransit=true;
    }
    // Keep normal-sized carts at their real scale. Extremely overfilled carts
    // compact only the temporary belt display so piles don't cross the ceiling.
    let compact=1,columns=1,rows=1;
    for(let attempt=0;attempt<48;attempt++){
        columns=Math.max(1,Math.floor(2.9/(maxW*compact+0.035)));
        rows=Math.max(1,Math.floor(1.0/(maxD*compact+0.035)));
        const layers=Math.ceil(queue.length/(columns*rows));
        if(maxW*compact<=2.9&&maxD*compact<=1.0&&layers*(maxH*compact+0.015)<=1.7)break;
        compact*=0.9;
    }
    const cellW=maxW*compact+0.035,cellD=maxD*compact+0.035,cellH=maxH*compact+0.015;
    function arrangeWaiting(){
        for(let i=index;i<snapshots.length;i++){
            const saved=snapshots[i],slot=i-index,column=Math.floor(slot/rows)%columns,row=slot%rows,layer=Math.floor(slot/(columns*rows));
            counter.localToWorld(saved.target.set(-0.55+cellW*(column+0.5)+saved.offset.x*compact,
                1.01+layer*cellH+saved.offset.y*compact,
                0.15+(row-(rows-1)/2)*cellD+saved.offset.z*compact));
        }
    }
    arrangeWaiting();
    function newBag(){
        const mesh=new THREE.Mesh(assets.geometry,assets.material);
        const contents=new THREE.Group();contents.visible=false;mesh.add(contents);
        const bag={items:[],mesh,contents,loaded:false};
        counter.localToWorld(mesh.position.set(-2.15,1.26,0.15));scene.add(mesh);bags.push(bag);return bag;
    }
    function beginItem(){
        if(!activeBag)activeBag=newBag();
        current={...snapshots[index],scanned:false};current.item.mesh.getWorldPosition(scanStart);
        counter.localToWorld(scanner.set(-0.95+current.offset.x*compact,1.037+current.offset.y*compact,0.15+current.offset.z*compact));
        activeBag.mesh.getWorldPosition(bagPoint);bagPoint.y+=0.1;
    }
    function putInBag(){
        const item=current.item;activeBag.contents.add(item.mesh);item.mesh.visible=false;
        item.mesh.scale.copy(current.scale);item.checkoutTransit=false;item.checkoutBag=activeBag;
        activeBag.items.push(item);current=null;index++;arrangeWaiting();
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
        get unloading(){return elapsedTotal<UNLOAD_SECONDS;},
        get registerFallback(){return elapsedTotal>=STAFF_GRACE_SECONDS;},
        update(delta,ready,speed=1){
            if(disposed||this.done)return;
            const dt=Math.max(0,Number.isFinite(delta)?delta:0),previous=elapsedTotal;elapsedTotal+=dt;
            // All groceries go onto the belt immediately, independently of staff.
            const blend=1-Math.exp(-dt*14);
            for(let i=index;i<snapshots.length;i++){
                const saved=snapshots[i],mesh=saved.item.mesh;if(current?.item===saved.item)continue;
                mesh.scale.copy(saved.worldScale).multiplyScalar(compact);
                if(previous<UNLOAD_SECONDS){
                    const delay=(i/Math.max(1,queue.length))*0.18;
                    const t=Math.max(0,Math.min(1,(elapsedTotal-delay)/(UNLOAD_SECONDS-0.18))),ease=t*t*(3-2*t);
                    mesh.position.lerpVectors(saved.from,saved.target,ease);mesh.position.y+=Math.sin(t*Math.PI)*0.55;
                    mesh.quaternion.slerpQuaternions(saved.fromQuat,upright,ease);
                }else{mesh.position.lerp(saved.target,blend);mesh.quaternion.copy(upright);}
            }
            let activeDt=dt;
            if(processingAt===null){
                const gate=ready?UNLOAD_SECONDS:STAFF_GRACE_SECONDS;
                if(elapsedTotal<gate)return;
                processingAt=ready?Math.max(UNLOAD_SECONDS,Math.min(previous,STAFF_GRACE_SECONDS)):STAFF_GRACE_SECONDS;
                rate=Math.max(1,work/(BAGGED_DEADLINE_SECONDS-processingAt));
                activeDt=elapsedTotal-processingAt;
            }
            // If the attendant is still travelling, auto-scan at 1.5 s rather
            // than extending the ten-second checkout. His route stays physical.
            let remaining=activeDt*rate*Math.max(1,Math.min(3,speed));
            while(remaining>1e-8&&!this.done){
                if(phase==='item'&&!current)beginItem();
                const duration=phase==='bag'?0.20:0.42;
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
                    if(t<0.6){
                        const u=t/0.6;mesh.position.lerpVectors(scanStart,scanner,u);mesh.position.y+=Math.sin(u*Math.PI)*0.08;
                        mesh.quaternion.copy(upright);
                    }else{
                        if(!current.scanned){current.scanned=true;scanned++;onScan(current.item);onProgress(scanned,returned,queue.length);}
                        const u=Math.max(0,(t-0.68)/0.32);
                        mesh.position.lerpVectors(scanner,bagPoint,u);mesh.position.y+=Math.sin(u*Math.PI)*0.25;
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
