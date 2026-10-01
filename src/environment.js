import * as THREE from 'three';
import * as CANNON from 'cannon-es';

export function createNightSkyTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');

  // Vertical gradient: Deep night void from pitch black zenith to dark cosmic indigo horizon
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0.0, '#010206');
  grad.addColorStop(0.3, '#02040c');
  grad.addColorStop(0.5, '#050816');
  grad.addColorStop(0.7, '#070a1c');
  grad.addColorStop(0.85, '#0a0d22');
  grad.addColorStop(1.0, '#040612');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Subtle cosmic nebula glow bands
  for (let i = 0; i < 6; i++) {
    const nx = Math.random() * canvas.width;
    const ny = canvas.height * (0.2 + Math.random() * 0.4);
    const nr = 120 + Math.random() * 200;
    const nGrad = ctx.createRadialGradient(nx, ny, 0, nx, ny, nr);
    nGrad.addColorStop(0, 'rgba(30, 45, 80, 0.12)');
    nGrad.addColorStop(0.5, 'rgba(15, 20, 45, 0.06)');
    nGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = nGrad;
    ctx.beginPath();
    ctx.arc(nx, ny, nr, 0, Math.PI * 2);
    ctx.fill();
  }

  // Realistic starry sky: 1400 twinkling stars with subtle hue variations
  for (let i = 0; i < 1400; i++) {
    const x = Math.random() * canvas.width;
    const y = Math.random() * (canvas.height * 0.78);
    const radius = Math.random() < 0.85 ? (Math.random() * 0.9 + 0.3) : (Math.random() * 1.6 + 1.0);
    const alpha = Math.random() * 0.85 + 0.15;

    const starColors = [
      `rgba(255, 255, 255, ${alpha})`,
      `rgba(215, 230, 255, ${alpha})`,
      `rgba(255, 240, 220, ${alpha * 0.9})`,
      `rgba(180, 210, 255, ${alpha})`
    ];
    const color = starColors[Math.floor(Math.random() * starColors.length)];

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();

    if (radius > 1.4) {
      const glow = ctx.createRadialGradient(x, y, 0, x, y, radius * 3.5);
      glow.addColorStop(0, `rgba(200, 225, 255, ${alpha * 0.6})`);
      glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, radius * 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Eerie pale moon in the distance
  const moonX = canvas.width * 0.72;
  const moonY = canvas.height * 0.28;
  const moonRadius = 38;

  // Moon atmospheric outer glow
  const moonGlow = ctx.createRadialGradient(moonX, moonY, moonRadius * 0.8, moonX, moonY, moonRadius * 4.0);
  moonGlow.addColorStop(0, 'rgba(180, 210, 255, 0.22)');
  moonGlow.addColorStop(0.5, 'rgba(100, 140, 200, 0.08)');
  moonGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = moonGlow;
  ctx.beginPath();
  ctx.arc(moonX, moonY, moonRadius * 4.0, 0, Math.PI * 2);
  ctx.fill();

  // Moon disc
  const moonDisc = ctx.createRadialGradient(moonX - 8, moonY - 8, 2, moonX, moonY, moonRadius);
  moonDisc.addColorStop(0, '#f4f6ff');
  moonDisc.addColorStop(0.8, '#d0d8ee');
  moonDisc.addColorStop(1, '#94a3b8');
  ctx.fillStyle = moonDisc;
  ctx.beginPath();
  ctx.arc(moonX, moonY, moonRadius, 0, Math.PI * 2);
  ctx.fill();

  // Subtle craters
  const craters = [
    { dx: -10, dy: 8, r: 6 },
    { dx: 6, dy: -12, r: 8 },
    { dx: 14, dy: 6, r: 7 },
    { dx: -4, dy: -4, r: 5 },
    { dx: 8, dy: 16, r: 4 }
  ];
  craters.forEach(c => {
    ctx.fillStyle = 'rgba(120, 135, 165, 0.35)';
    ctx.beginPath();
    ctx.arc(moonX + c.dx, moonY + c.dy, c.r, 0, Math.PI * 2);
    ctx.fill();
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export function setupScene(CONFIG, skyImage) {
  const scene = new THREE.Scene();
  const textureLoader = new THREE.TextureLoader();
  
  // Daytime sky texture (skyImage: the picture, if game.js already has it loaded)
  const skyTexture = skyImage ? new THREE.Texture(skyImage) : textureLoader.load('sky_39_2k.webp');
  if (skyImage) skyTexture.needsUpdate = true;
  skyTexture.mapping = THREE.EquirectangularReflectionMapping;
  skyTexture.colorSpace = THREE.SRGBColorSpace;
  scene.background = skyTexture;
  scene.environment = skyTexture;

  // Generate eerie night skybox texture for lights out / lonely store event
  const nightSkyTexture = createNightSkyTexture();

  // Atmospheric fog: crisp store interior fading softly out to the staple mountain & distant valley
  scene.fog = new THREE.Fog(0x9cc6e8, 25, 650);

  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, 1.6, 5);
  camera.rotation.order = 'YXZ';
  camera.rotation.set(0, 0, 0);
  camera.up.set(0, 1, 0);
  scene.add(camera);

  const quality = (CONFIG.RENDER_QUALITY || 'medium');
  // MSAA (Settings > Anti-aliasing, on unless turned off; never on phones, where its framebuffer costs too much memory)
  const aa = CONFIG.ANTIALIAS !== 'off';
  const pPref = quality === 'low' ? 'low-power' : 'high-performance';
  const lowMem = typeof window.__lowMem === 'function' && window.__lowMem();
  const renderer = new THREE.WebGLRenderer({ 
    antialias: aa && !lowMem, 
    powerPreference: lowMem ? 'default' : 'high-performance'
  });
  renderer.setSize(window.innerWidth, window.innerHeight);

  const dpr = window.devicePixelRatio || 1;
  const targetPR = quality === 'low' ? Math.min(1, dpr * 0.75) 
                 : quality === 'medium' ? Math.min(1.25, dpr) 
                 : quality === 'high' ? dpr 
                 : Math.min(2.0, dpr * 1.5);
  // Phones: a 3x retina framebuffer alone can blow iOS's per-tab memory cap.
  renderer.setPixelRatio(lowMem ? Math.min(targetPR, 1.25) : targetPR);

  // Cinematic ACES Filmic Tone Mapping for rich PBR highlights and true color saturation
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const lightingQuality = CONFIG.LIGHTING_QUALITY || 'high';
  renderer.shadowMap.enabled = (lightingQuality === 'high' || lightingQuality === 'ultra');
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.getElementById('game-container').appendChild(renderer.domElement);

  // ---- Advanced Multi-Tier Lighting System ----
  // 1. Soft neutral ambient fill
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.35);
  scene.add(ambientLight);

  // 2. Realistic sky dome and earth ground bounce (HemisphereLight)
  const hemiLight = new THREE.HemisphereLight(0xdbeafe, 0x526071, 0.85);
  hemiLight.position.set(0, 60, 0);
  scene.add(hemiLight);

  // 3. Golden Directional Sun Light casting warm natural daylight onto sidewalks and plaza
  const sunLight = new THREE.DirectionalLight(0xfff6e5, 1.75);
  sunLight.position.set(65, 80, -55);
  if (lightingQuality === 'high' || lightingQuality === 'ultra') {
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.width = (lightingQuality === 'ultra' ? 2048 : 1024);
    sunLight.shadow.mapSize.height = (lightingQuality === 'ultra' ? 2048 : 1024);
    sunLight.shadow.camera.near = 35;
    sunLight.shadow.camera.far = 185;
    sunLight.shadow.camera.left = -42;
    sunLight.shadow.camera.right = 42;
    sunLight.shadow.camera.top = 42;
    sunLight.shadow.camera.bottom = -42;
    sunLight.shadow.bias = -0.0003;
    sunLight.shadow.normalBias = 0.02;
  }
  scene.add(sunLight);

  // 4. Secondary cool fill light from opposite angle to prevent harsh pitch-black shadow sides
  const fillLight = new THREE.DirectionalLight(0xa5c4e8, 0.4);
  fillLight.position.set(-60, 40, 70);
  scene.add(fillLight);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return { scene, camera, renderer, skyTexture, nightSkyTexture, lights: { ambientLight, hemiLight, sunLight, fillLight } };
}

export function setupPhysics(CONFIG) {
  const world = new CANNON.World({
    gravity: new CANNON.Vec3(0, -CONFIG.GRAVITY, 0)
  });

  // Enable high-performance broadphase
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.allowSleep = false;
  world.solver.iterations = 7;
  world.solver.tolerance = 0.001;

  const playerPhysMaterial = new CANNON.Material('playerMaterial');
  const floorPhysMaterial = new CANNON.Material('floorMaterial');
  const customerPhysMaterial = new CANNON.Material('customerMaterial');

  const playerFloorContactMaterial = new CANNON.ContactMaterial(
    playerPhysMaterial,
    floorPhysMaterial,
    { friction: 0.5, restitution: 0.3 }
  );

  const playerCustomerContactMaterial = new CANNON.ContactMaterial(
    playerPhysMaterial,
    customerPhysMaterial,
    { friction: 0.1, restitution: 0.1 }
  );

  const customerCustomerContactMaterial = new CANNON.ContactMaterial(
    customerPhysMaterial,
    customerPhysMaterial,
    { friction: 0.05, restitution: 0.0 }
  );

  world.addContactMaterial(playerFloorContactMaterial);
  world.addContactMaterial(playerCustomerContactMaterial);
  world.addContactMaterial(customerCustomerContactMaterial);

  return { world, materials: { playerPhysMaterial, floorPhysMaterial, customerPhysMaterial } };
}