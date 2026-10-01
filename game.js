import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import * as CANNON from 'cannon-es';
import { CONFIG } from './config.js';
import { DEFAULT_GAME_SETTINGS } from './config/game-settings.js';
import { CONFIG as PROB_DEFAULTS } from './config/probabilities.js';
import { createCompatibleAudio as createCompatibleAudioExt, safePlay as safePlayExt, stopAllAudio as stopAllAudioExt, loadSounds as loadSoundsExt, stopMenuMusic as stopMenuMusicExt } from './src/audio.js';
import { setupScene as setupSceneExt, setupPhysics as setupPhysicsExt } from './src/environment.js';
import { addMagMartLogo3D } from './src/magmart-logo-3d.js';
import { buildNavGrid, findPath, clampToWalkable, isWalkable, isLineWalkable } from './src/pathfinding.js';
import * as SQ from './src/side-quests.js';
import * as Thermo from './src/thermostat.js';
import * as Nuke from './src/nuke.js';
import { bankSavings, pickCustomerSkin, equippedCartSkin } from './src/shop.js';
import { applyCartFinish, applyCartSkin } from './src/cart-skins.js';
import { buildCartQuarterSlot } from './src/cart-quarter-slot.js';
import * as CartPhys from './src/cart-physics.js';
import { updateSpillTracks, clearSpillTracks } from './src/spill-tracks.js';
import { planStoreShelves, getShelfTierPools, SHELF_WIDTH, blocksStoreRoute } from './src/store-layout.js';
import { addStoreWayfinding } from './src/store-signs.js';
import { dressCustomer } from './src/customer-skins.js';
import { unlockAchievement, addAchievementProgress, setAchievementEligibility } from './src/achievements.js';
import { showIosHelp } from './src/ios-help.js';
import { createRunSeed, RULESET_KEYS, vanillaRulesetValue } from './src/run-seed.js';
import { seedBadgeHtml, setSeedCheckMenuVisible, renderDevReview } from './src/seed-dev.js';
import { startRunTrack, finishRunTrack, stopRunTrack } from './src/run-track.js';

// Touch devices (phones/tablets) get on-screen controls and emulated pointer lock.
export const TOUCH_MODE = (() => {
    try {
        const hasTouch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
        const mq = (q) => window.matchMedia(q).matches;
        const mobileUA = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(navigator.userAgent || '');
        return hasTouch && (mq('(pointer: coarse)') || mq('(hover: none)') || mobileUA);
    } catch (_) { return false; }
})();
if (TOUCH_MODE) document.documentElement.classList.add('touch-mode');

// iOS (incl. iPadOS, which reports itself as a Mac). Every iOS browser is WebKit
// with a hard per-tab memory cap: exceeding it silently kills and reloads the
// page, which looks exactly like "Play does nothing".
export const IS_IOS = (() => {
    try {
        const ua = navigator.userAgent || '';
        return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    } catch (_) { return false; }
})();
if (IS_IOS) document.documentElement.classList.add('ios');

// If the last boot never reached gameplay, the tab most likely crashed from
// memory pressure; drop to an even lighter profile this time.
const BOOT_KEY = 'ss_boot_pending';
let lastBootCrashed = false;
try {
    const t = Number(localStorage.getItem(BOOT_KEY) || 0);
    lastBootCrashed = (TOUCH_MODE || IS_IOS) && t > 0 && Date.now() - t < 10 * 60 * 1000;
    localStorage.removeItem(BOOT_KEY);
    if (lastBootCrashed) localStorage.setItem('ss_lite_level', '2');
} catch (_) {}
function liteLevel() {
    if (!TOUCH_MODE && !IS_IOS) return 0; // desktop always keeps full detail
    let stored = 0;
    try { stored = Number(localStorage.getItem('ss_lite_level') || 0); } catch (_) {}
    return Math.max(stored, IS_IOS ? 1 : 0);
}
function markBootPending(on) {
    try { on ? localStorage.setItem(BOOT_KEY, String(Date.now())) : localStorage.removeItem(BOOT_KEY); } catch (_) {}
}
// Max texture edge: desktop keeps full 2K art, phones get far smaller copies.
export function maxTextureSize() {
    const lvl = liteLevel();
    if (lvl >= 2) return 256;
    if (lvl >= 1) return 512;
    return TOUCH_MODE ? 1024 : 0;
}
window.__lowMem = () => liteLevel() > 0 || TOUCH_MODE;

// Downscale a loaded texture's image in place (and let the full-size decode go).
function shrinkTexture(tex) {
    const max = maxTextureSize();
    const img = tex && tex.image;
    if (!max || !img || !img.width || (img.width <= max && img.height <= max)) return tex;
    try {
        const k = max / Math.max(img.width, img.height);
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * k));
        c.height = Math.max(1, Math.round(img.height * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        tex.image = c;
        tex.needsUpdate = true;
        try { if (img.src) img.src = ''; } catch (_) {}
    } catch (_) {}
    return tex;
}
// Textures that have smaller WebP copies in uploads/webp/ (<name>_<size>.webp, made from the PNG with cwebp; the
// PNGs stay as the originals): the sizes there, largest first. Desktop loads the largest, phones the largest
// that fits maxTextureSize(), so nobody downloads a 2K PNG only to shrink it.
const WEBP_TEXTURES = {};
for (const [name, sizes] of [['SupermarketTile', [2048, 1024, 512, 256]], ['VerticalPlankWall', [1024, 512, 256]],
    ['DropCeiling', [1024, 512, 256]], ['SupermarketBrick', [1024, 512, 256]]]) {
    for (const map of ['BaseColor', 'Normal_OpenGL', 'ORM']) WEBP_TEXTURES[`uploads/${name}_${map}.png`] = sizes;
}
WEBP_TEXTURES['watercolor-abstract-background-free-png.png'] = [512, 256];
function texturePath(path) {
    const sizes = WEBP_TEXTURES[path];
    if (!sizes) return path;
    const max = maxTextureSize() || Infinity;
    const size = sizes.find((s) => s <= max) ?? sizes[sizes.length - 1];
    return `uploads/webp/${path.split('/').pop().replace(/\.png$/, '')}_${size}.webp`;
}
function loadShrunk(path) {
    return sharedTextureLoader.load(texturePath(path), (t) => shrinkTexture(t));
}

// Game state
let scene, camera, renderer, controls;
let nukeShelterBodies = new Set();
let nukeShelterMats = new Set();
let storeFloorBody = null;
let nukeContext = null;
let sceneLights = null; // Scene illumination state (sun, hemi, ambient, fill)
// Reuse loaders and raycaster to avoid allocations
const sharedTextureLoader = new THREE.TextureLoader();
const sharedRaycaster = new THREE.Raycaster();
const sharedVec3 = new THREE.Vector3();

// Draw centred label text, shrinking the font size (never squashing letters)
// until it fits maxW.
function fitText(ctx, text, x, y, maxW) {
    let size = Number((ctx.font.match(/(\d+)px/) || [0, 24])[1]);
    while (size > 10 && ctx.measureText(text).width > maxW) {
        size -= 1;
        ctx.font = ctx.font.replace(/\d+px/, size + 'px');
    }
    ctx.fillText(text, x, y);
}

// Centralized Texture Cache & Preloader Manager for consistent PBR rendering
const textureCache = new Map();

function getLoadedTexture(path, isSRGB = false, repeatX = 1, repeatY = 1) {
    const key = `${path}_${isSRGB}_${repeatX}_${repeatY}`;
    if (textureCache.has(key)) {
        return textureCache.get(key);
    }
    const tex = loadShrunk(path);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeatX, repeatY);
    if (isSRGB) tex.colorSpace = THREE.SRGBColorSpace;
    try {
        if (renderer) tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    } catch(_) {}
    textureCache.set(key, tex);
    return tex;
}

// Configurable PBR Material Builder: respects PBR quality setting ('high' | 'medium' | 'low' | 'off')
function createPBRMaterial(params) {
    const {
        baseColorPath,
        normalPath,
        ormPath, // one texture holding AO (red), roughness (green) and metalness (blue): stands in for the three below
        roughnessPath = ormPath,
        metallicPath = ormPath,
        aoPath = ormPath,
        heightPath,
        repeatX = 1,
        repeatY = 1,
        defaultRoughness = 0.8,
        defaultMetalness = 0.05,
        bumpScale = 0.015,
        side = THREE.FrontSide
    } = params;

    const pbrMode = CONFIG.PBR_QUALITY || 'high';
    const baseColorMap = baseColorPath ? getLoadedTexture(baseColorPath, true, repeatX, repeatY) : null;

    if (pbrMode === 'off') {
        return new THREE.MeshLambertMaterial({
            map: baseColorMap,
            side: side
        });
    }

    const mat = new THREE.MeshStandardMaterial({
        map: baseColorMap,
        roughness: defaultRoughness,
        metalness: defaultMetalness,
        side: side
    });

    if (pbrMode === 'high' || pbrMode === 'medium') {
        if (normalPath) {
            mat.normalMap = getLoadedTexture(normalPath, false, repeatX, repeatY);
            mat.normalScale = new THREE.Vector2(0.9, 0.9);
        }
        if (roughnessPath) {
            mat.roughnessMap = getLoadedTexture(roughnessPath, false, repeatX, repeatY);
        }
        if (metallicPath) {
            mat.metalnessMap = getLoadedTexture(metallicPath, false, repeatX, repeatY);
        }
    }

    if (pbrMode === 'high') {
        if (aoPath) {
            mat.aoMap = getLoadedTexture(aoPath, false, repeatX, repeatY);
            mat.aoMapIntensity = 1.0;
        }
        // Height is only used as a bump map when there is no normal map (normal already carries the detail)
        if (heightPath && !mat.normalMap) {
            mat.bumpMap = getLoadedTexture(heightPath, false, repeatX, repeatY);
            mat.bumpScale = bumpScale;
        }
    }

    return mat;
}

// Smoothly rotate an Object3D toward a Y-axis heading without per-frame allocations.
const _slerpYawQuat = new THREE.Quaternion();
const _slerpYawEuler = new THREE.Euler();
function slerpToYaw(obj, yaw, t) {
    _slerpYawQuat.setFromEuler(_slerpYawEuler.set(0, yaw, 0));
    obj.quaternion.slerp(_slerpYawQuat, t);
}

// Natural eyelid blinking shared by customers and the store worker:
// a 160ms blink every few seconds, lids resting open otherwise.
const EYELID_OPEN_ANGLE = -Math.PI * 0.55;
function updateEyelidBlink(npc, now) {
    const lids = npc.eyelids;
    if (!lids || lids.length === 0) return;
    if (!npc.blinkNext) npc.blinkNext = now + 1500 + Math.random() * 3500;
    const blinkElapsed = now - npc.blinkNext;
    const blinkDuration = 160;
    let lidAngle = EYELID_OPEN_ANGLE;
    if (blinkElapsed >= 0 && blinkElapsed < blinkDuration) {
        lidAngle = THREE.MathUtils.lerp(EYELID_OPEN_ANGLE, 0.08, Math.sin((blinkElapsed / blinkDuration) * Math.PI));
    } else if (blinkElapsed >= blinkDuration) {
        npc.blinkNext = now + 2500 + Math.random() * 4000;
    }
    for (let i = 0; i < lids.length; i++) lids[i].rotation.x = lidAngle;
}

// ---- High-Performance Hierarchical Frustum Culling System ----
const _cullingFrustum = new THREE.Frustum();
const _cullingMatrix = new THREE.Matrix4();
const registeredCullableObjects = [];

function registerCullableObject(object3D, radius = 6.0, centerOffset = null) {
    if (!object3D) return;
    const center = centerOffset 
        ? object3D.position.clone().add(centerOffset) 
        : object3D.position.clone();
    const sphere = new THREE.Sphere(center, radius);
    registeredCullableObjects.push({
        object: object3D,
        sphere: sphere,
        dynamicPosition: !centerOffset && object3D.matrixAutoUpdate !== false
    });
}

function clearCullableObjects() {
    registeredCullableObjects.length = 0;
}

function updateFrustumCulling() {
    if (!camera || !scene) return;

    // Build camera frustum once per frame
    _cullingMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _cullingFrustum.setFromProjectionMatrix(_cullingMatrix);

    const len = registeredCullableObjects.length;
    for (let i = 0; i < len; i++) {
        const item = registeredCullableObjects[i];
        const obj = item.object;
        if (!obj || !obj.parent) continue;

        if (item.dynamicPosition) {
            item.sphere.center.copy(obj.position);
        }

        obj.visible = _cullingFrustum.intersectsSphere(item.sphere);
    }
}

function loadTextureAsync(path, isSRGB = false, repeatX = 1, repeatY = 1) {
    const key = `${path}_${isSRGB}_${repeatX}_${repeatY}`;
    if (textureCache.has(key)) {
        return Promise.resolve(textureCache.get(key));
    }
    return new Promise((resolve) => {
        sharedTextureLoader.load(
            texturePath(path),
            (tex) => {
                shrinkTexture(tex);
                tex.wrapS = THREE.RepeatWrapping;
                tex.wrapT = THREE.RepeatWrapping;
                tex.repeat.set(repeatX, repeatY);
                if (isSRGB) tex.colorSpace = THREE.SRGBColorSpace;
                try {
                    if (renderer) tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
                } catch(_) {}
                tex.needsUpdate = true;
                textureCache.set(key, tex);
                resolve(tex);
            },
            undefined,
            (err) => {
                console.warn(`Texture load warning for ${path}:`, err);
                const canvas = document.createElement('canvas');
                canvas.width = 4;
                canvas.height = 4;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = isSRGB ? '#dddddd' : '#808080';
                ctx.fillRect(0, 0, 4, 4);
                const fallbackTex = new THREE.CanvasTexture(canvas);
                fallbackTex.wrapS = THREE.RepeatWrapping;
                fallbackTex.wrapT = THREE.RepeatWrapping;
                fallbackTex.repeat.set(repeatX, repeatY);
                if (isSRGB) fallbackTex.colorSpace = THREE.SRGBColorSpace;
                textureCache.set(key, fallbackTex);
                resolve(fallbackTex);
            }
        );
    });
}

const LOADING_HINTS = [
    "Stocking fresh produce, dairy, and snack aisles...",
    "Streaming high-resolution PBR textures to ceiling, walls, and floor...",
    "Polishing supermarket floor tiles to a clean semi-gloss finish...",
    "Remember: Press [F] to grab and attach your shopping cart!",
    "Watch your step: Spills and slippery aisles can send you sliding!",
    "Tip: Check your shopping list on the left to gather all items quickly.",
    "Did you know? Power outages can strike at any moment — stay alert!",
    "Press [E] to reach for items on shelves.",
    "Press [Esc] anytime to pause the game and adjust settings.",
    "Look out for special sales and 2-in-1 promotions in the aisles!"
];

function setRandomLoadingHint(statusText) {
    const hintEl = document.getElementById('loading-hint');
    if (!hintEl) return;
    const hint = LOADING_HINTS[Math.floor(Math.random() * LOADING_HINTS.length)];
    hintEl.textContent = statusText ? `${statusText} — ${hint}` : hint;
}

function showLoadingScreen(title = 'Stocking the Shelves...') {
    const loadingEl = document.getElementById('loading');
    if (!loadingEl) return;
    loadingEl.classList.remove('hidden');
    loadingEl.style.display = 'flex';
    loadingEl.style.opacity = '1';
    const titleEl = loadingEl.querySelector('h2');
    if (titleEl) titleEl.textContent = title;
    setRandomLoadingHint();
}

function hideLoadingScreen() {
    const loadingEl = document.getElementById('loading');
    if (!loadingEl) return;
    loadingEl.classList.add('hidden');
    loadingEl.style.opacity = '0';
    setTimeout(() => {
        if (loadingEl.classList.contains('hidden')) {
            loadingEl.style.display = 'none';
        }
    }, 320);
}

async function preloadAllGameAssets(onProgress) {
    // What the store's materials will use at this PBR quality (see createPBRMaterial): the base colour, and from
    // medium up the normal map and the ORM map (AO/roughness/metalness in one). The sky loads in setupScene.
    const pbr = CONFIG.PBR_QUALITY || 'high';
    const maps = pbr === 'high' || pbr === 'medium' ? ['BaseColor', 'Normal_OpenGL', 'ORM'] : ['BaseColor'];
    const assetsToLoad = [
        ...[['SupermarketTile', 14], ['VerticalPlankWall', 1], ['DropCeiling', 15], ['SupermarketBrick', 1]].flatMap(([name, r]) =>
            maps.map((map) => ({ path: `uploads/${name}_${map}.png`, isSRGB: map === 'BaseColor', rx: r, ry: r }))),
        // spill stains
        { path: 'watercolor-abstract-background-free-png.png', isSRGB: true, rx: 1, ry: 1 },
    ];

    let count = 0;
    const total = assetsToLoad.length;
    // Phones decode a few at a time so 2K PNGs never pile up in memory at once.
    const lanes = maxTextureSize() ? 2 : total;
    let next = 0;
    const worker = async () => {
        while (next < total) {
            const item = assetsToLoad[next++];
            await loadTextureAsync(item.path, item.isSRGB, item.rx, item.ry);
            count++;
            if (onProgress) onProgress(count / total);
        }
    };
    await Promise.all(Array.from({ length: Math.min(lanes, total) }, worker));
}
let world, timeStep = 1/60;
let physicsMaterials = null;
let nextCustomerEntityId = 1;
let playerBody;
let playerObject, arm, hand;
let shoppingList = [];
let itemsRemovedFromShoppingList = new Set();
let outOfStockListItems = [];
let storeStockCounts = {};
let collectedItems = [];
let heldItem = null;
let heldItemPulling = false;
let isCheckout = false;
let gameStarted = false;
let gameOver = false;
let gameTime = 0; // track elapsed for pause/resume
let timer;
let timerStart;
let stoppedRunElapsed = null;
let allItems = [];
let shelves = [];
// Add tracking for entire shelf units and per-unit items
let shelfUnits = [];
// Freezer Units & Amnesia Physical Door Physics System
let freezerUnits = [];
let allFreezerDoors = [];
let freezerDoorMeshesCache = [];
let activeGrabbedDoor = null;
let hoveredFreezerDoor = null;
let crosshairElement = null;
let doorDragActive = false;
let doorDragMoved = false;
let navGrid = null;
// Per-game walking speed and purchase guard
let currentMoveSpeed = CONFIG.MOVE_SPEED;
let purchaseComplete = false;
let paidListSnapshot = null;     // grocery list frozen at the moment of purchase
let purchaseWrongItemsCount = 0; // wrong items evaluated at purchase time
let activeListPage = 'grocery';  // 'grocery' | 'other' (keys 1 / 2)
let playerCarSpots = [];         // nearby empty stalls for the player's car
let bathroomToilet = null;
// Track Falling Shelf event state
let fallingShelfTriggered = false;
let fallingShelfAnim = null; // { unit, start, duration, tiltAxis: 'z'|'x', finished: false }
let checkout;
let powerOutage = false;
let slipperyFloor = false;
let storeClosing = false;
let storeClosingTimer = 0;
let cartObject;
let cart3D;
let cartDroppingItems = [];
let lastPosition = { x: 0, z: 0 };
let playerWalkBobPhase = 0;
let playerWalkBobAmount = 0;
let soundEffects = {};
const BOOSTED_SFX_MULTIPLIERS = {
    tweakerGrunt: 1.35,
    moneyPickup: 1.5,
    cartRoll: 1.4
};

function setBoostedSfxVolume(name, baseVolume = CONFIG.SFX_VOLUME ?? 0.7) {
    const audio = soundEffects?.[name];
    const multiplier = BOOSTED_SFX_MULTIPLIERS[name];
    if (audio && multiplier) {
        audio.volume = Math.min(1, Math.max(0, baseVolume * multiplier));
    }
}

// Preload frequently-used one-shot SFX to avoid repeated allocations
let sfxKey, sfxTada, sfxPowerDown, sfxAttentionCustomers, sfxSqueak;
let music;
let menuMusic; // main menu music
let storeEnv = {};
// Add fail-state music
let mrResettiMusic = null;
let bestTimes = (() => { try { return JSON.parse(localStorage.getItem('bestTimes') || '[]') || []; } catch (_) { return []; } })();
let tripped = false;
let cartAttached = true;
let gamePaused = false;
let mainMenuVisible = true;
let footstepCount = 0;
let tripCount = 0;
let powerOutageCount = 0;
let itemsFallenCount = 0;
let slipperyFloorCount = 0;
let storeClosingCount = 0;
let slapCount = 0;
let mislabeledItemsCount = 0;
let customerQuestionsCount = 0;
let managerJumpscareOccurred = false;
let gumCravingTriggered = false;
let checkoutBusyOccurred = false;
let powerupCollectedCount = 0;
let shelfReplacedCount = 0;
let productSpillCount = 0;
let customerInteractionMessageVisible = false;
let wrongItemsGrabbedCount = 0;
let noMoneyForGroceries = false;
let walletFailed = false;
let tweakerMoneyFailure = false;
let tweakerMoneyRisk = false;
let savingsCents = 0;
let looseMoney = [];
let nextMoneySpawnAt = 0;
let activeTweaker = null;
let tweakerEventScheduleVersion = 0;
let tweakerRequestOpen = false;
let rngNotificationsElement;
let centerAlertElement = null;
let singleItemList = false;
let emptyShelfEvent = false;
let itemAddedEventCount = 0;
let itemRemovedEventCount = 0;
let twoInOneItemCollected = false;
let thief = null;
let activeCustomerScuffle = null;
let customerScufflePending = false;
let customerScuffleProjectiles = [];
let customerScuffleCount = 0;
let customerScuffleMusic = null;
let customerScuffleMusicMix = 0;
let isCustomGame = false;
// Only runs started from Play with the exact vanilla ruleset count for the
// leaderboard; custom games never do. The run seed records which one it was.
let currentRunSeed = null;
const countsForLeaderboard = () => !isCustomGame && !!currentRunSeed &&
    currentRunSeed.mode === 'vanilla' && currentRunSeed.rulesetIsVanilla;
setAchievementEligibility(() => !isCustomGame);
let glassesBlurRemaining = 0;
let glassesBlurDuration = 0;
let lastGlassesBlurValue = '';
function clearGlassesBlur() {
    glassesBlurRemaining = 0;
    glassesBlurDuration = 0;
    const container = document.getElementById('game-container');
    container?.classList.remove('glasses-blur');
    container?.style.removeProperty('--glasses-blur');
    lastGlassesBlurValue = '';
}
function triggerForgotGlasses() {
    if (glassesBlurRemaining > 0) return false;
    glassesBlurDuration = 15 + Math.random() * 5;
    glassesBlurRemaining = glassesBlurDuration;
    document.getElementById('game-container')?.classList.add('glasses-blur');
    displayMessage('👓 You forgot your glasses! Your eyes are adjusting…', 3500);
}
function updateGlassesBlur(delta) {
    if (glassesBlurRemaining <= 0 || gamePaused || isCheckout || introCutsceneActive) return;
    glassesBlurRemaining = Math.max(0, glassesBlurRemaining - Math.min(delta, 0.1));
    if (glassesBlurRemaining === 0) {
        clearGlassesBlur();
        displayMessage('👀 Your eyes have adjusted.', 2200);
        return;
    }
    const progress = 1 - glassesBlurRemaining / glassesBlurDuration;
    const blurValue = `${(5 * (1 - progress * progress)).toFixed(2)}px`;
    if (blurValue === lastGlassesBlurValue) return;
    lastGlassesBlurValue = blurValue;
    document.getElementById('game-container')?.style.setProperty('--glasses-blur', blurValue);
}
let policeCarModel = null;
let isBeingArrested = false;
let storeSize = 30; // Half width/length of the store (store boundaries)
let policeCopAnimation = false; // Track if police animation is in progress
let policeCarStartPosition = null; // Starting position for animation
let productSpills = []; // Track persistent product spills on the floor
let productSpill = null; // Track if there's a product spill on the floor
let glassShardsZones = []; // Track persistent glass shards on the floor
let playerOnGlassShards = false; // Track if player is currently on glass shards
let isLonelyStoreMode = false; // Lonely Store whole-run modifier
let forceNextGameVanilla = false; // Force vanilla normal game on next restart after lonely store crash
let lonelyStoreStalker = null; // Stalker entity in lonely store mode
let lonelyStoreOminousTimer = null; // Occasional ominous notification timer
let playerFlashlight = null; // Player camera-mounted flashlight
let playerOnSpill = false; // Track if player is currently on the spill
let playerOnSticky = false; // On a sticky (peanut butter) spill: very slow, no slipping
let dropAllItemsOnSpillChance = 0.1; // 1/10 chance of dropping items on spill
let checkoutButton = null; // Track the checkout button
let checkoutButtonRequired = false; // Track if the button is required
let babyCrying = false; // Track if a baby is currently crying
let babyHeadacheOverlay = null; // Reference to the headache overlay element
let babyTantrumCount = 0; // Count the number of baby tantrums
let babyFOVDefault = 75; // Default FOV for the camera
let shoppingListHidden = false; // Track if shopping list is hidden due to baby crying
let cartBaby = null;
let cartBabyIsGood = false; // Hidden run state: good babies only select needed items
let cartBabyHead = null;
let cartBabyPacifier = null;
let cartBabyAction = null;
let cartBabyActionCount = 0;
let cartBabyActionLimit = 0;
let cartBabyActionTimerId = null;
let lastDoorBeepTime = 0;

function updateEntranceDoorBeepVolume() {
    if (!soundEffects?.entranceBeep) return;
    const distance = playerBody ? Math.hypot(playerBody.position.x, playerBody.position.z + 30) : 0;
    const proximity = Math.max(0, 1 - distance / 50);
    soundEffects.entranceBeep.volume = Math.min(1, CONFIG.SFX_VOLUME * (0.12 + 1.03 * proximity ** 2.5));
}

function playEntranceDoorBeep() {
    const now = performance.now();
    if (now - lastDoorBeepTime < 3000) return;
    lastDoorBeepTime = now;
    if (soundEffects && soundEffects.entranceBeep) {
        try {
            updateEntranceDoorBeepVolume();
            soundEffects.entranceBeep.currentTime = 0;
            soundEffects.entranceBeep.play().catch(() => {});
        } catch (_) {}
    }
}

let cartRollingRequested = false;
function updateCartRollingSound(rolling) {
    const audio = soundEffects?.cartRoll;
    if (!audio) return;
    if (rolling === cartRollingRequested) return;
    cartRollingRequested = rolling;
    if (rolling) {
        setBoostedSfxVolume('cartRoll');
        audio.play().catch(() => {});
    } else {
        audio.pause();
        audio.currentTime = 0;
    }
}
// Busy checkout event state
let checkoutBusyActive = false;
let checkoutBusyEvaluatedThisGame = false;
let checkoutBusyCountdown = 0;
let checkoutBusyInterval = null;
let checkoutBusyTimerId = null;
let checkoutBusyCustomer = null;
let checkoutBusyItem = null;
let checkoutBusyItemMesh = null;
// Track animation frame to cancel when going back to menu
let animationFrameId = null;
let lockOnStart = false;
// Add global music mute state
let musicMuted = false;
try {
    const savedMuted = localStorage.getItem('musicMuted');
    if (savedMuted !== null) {
        musicMuted = (savedMuted === 'true');
    }
} catch (_) {}
// Add a reference to the loaded sky texture so we can restore it after outages
let skyTexture = null;
let nightSkyTexture = null;
// Add a reference to the loaded sky texture so we can restore it after outages
let autoDoors = null; // Automatic sliding doors state
let parkingLotCars = []; // Exterior parked and driving vehicles
let carInstancedMeshes = {}; // InstancedMesh references for vehicles
// Track transient UI timeouts to avoid overlapping/flicker
let messageTimeoutId = null;
let rngTimeoutId = null;
// Ensure single alert for checkout button requirement
let checkoutButtonAlertShown = false;
let initialFindItemsMessageShown = false;
// NEW: Track if settings were opened from the pause menu
let settingsOpenedFromPause = false;

// Global cleanup trackers
let storeClosingInterval = null;           // track store closing countdown interval for cleanup
let spillBeginHandler = null;              // track spill beginContact handler
let spillEndHandler = null;                // track spill endContact handler
let globalBeginContactHandler = null;      // NEW: main physics beginContact handler
let globalEndContactHandler = null;       // NEW: main physics endContact handler
// NEW: Timed trip check trackers for spill zones
let spillTripIntervalPlayer = null;
const customerSpillTripIntervals = new Map();
// Track player–customer physical contacts for theft checks
const touchingCustomers = new Set();
let customerTheftIntervalId = null;
// NEW: extra event tracking for detailed failure stats
let productSpillOccurred = false;
let thiefEventOccurred = false;
let customerTheftEventsCount = 0;
let fallingShelfOccurred = false;
let underConstructionOccurred = false; // NEW: Track if under construction zone was created

// Event Director & Dynamic Text Placement Manager
let scheduledEventTimeouts = [];
let lastMajorEventEndTime = 0;
const activeTextEvents = new Set();

const secondaryTextSpots = [
    { top: '22%', left: '26%', rot: -3 },
    { top: '22%', left: '74%', rot: 3 },
    { top: '75%', left: '26%', rot: 3 },
    { top: '75%', left: '74%', rot: -3 },
    { top: '18%', left: '50%', rot: 2 },
    { top: '78%', left: '50%', rot: -2 },
    { top: '34%', left: '18%', rot: -4 },
    { top: '34%', left: '82%', rot: 4 },
];

function isMajorEventActive() {
    return powerOutage || storeClosing;
}

function placeEventTextElement(element, preferredIsCenter = true) {
    if (!element) return;
    element.style.position = 'relative';
    element.style.top = 'auto';
    element.style.left = 'auto';
    element.style.transform = 'none';
    element.style.margin = '0 auto';
}

function removeEventTextElement(element) {
    if (!element) return;
    if (element.parentNode) {
        element.remove();
    }
}

function cancelScheduledEvents(clearAlerts = false) {
    scheduledEventTimeouts.forEach(id => {
        try { clearTimeout(id); } catch(_) {}
    });
    scheduledEventTimeouts = [];
    if (clearAlerts) {
        clearAllAlertsAndNotifications();
    }
}

function showLonelyStoreOminousEventNotif() {
    if (mainMenuVisible || !isLonelyStoreMode || isCheckout || gameOver) return;

    if (soundEffects && soundEffects.textChime) {
        try {
            soundEffects.textChime.currentTime = 0;
            soundEffects.textChime.play().catch(() => {});
        } catch (_) {}
    }

    const existing = document.getElementById('lonely-ominous-banner');
    if (existing) existing.remove();

    const banner = document.createElement('div');
    banner.id = 'lonely-ominous-banner';
    banner.className = 'lonely-event-notification';
    banner.innerHTML = `
        <div class="lonely-event-box">
            <div class="lonely-event-badge">👁️ NOTICE</div>
            <div class="lonely-event-text">You know what you did to his brother. And now you're forcing him to admit to it?</div>
        </div>
    `;

    const container = document.getElementById('game-container') || document.body;
    container.appendChild(banner);

    // Auto remove after 5.5s
    setTimeout(() => {
        if (banner) {
            banner.classList.add('leaving');
            setTimeout(() => {
                if (banner && banner.parentNode) banner.remove();
            }, 360);
        }
    }, 5500);
}

function startLonelyStoreOminousNotifs() {
    stopLonelyStoreOminousNotifs();
    if (!isLonelyStoreMode) return;
    
    const scheduleNext = (delay) => {
        lonelyStoreOminousTimer = setTimeout(() => {
            if (isLonelyStoreMode && !isCheckout && !gameOver) {
                showLonelyStoreOminousEventNotif();
            }
            if (isLonelyStoreMode && !isCheckout && !gameOver) {
                scheduleNext(7000 + Math.random() * 4000);
            }
        }, delay);
    };

    scheduleNext(1500);
}

function stopLonelyStoreOminousNotifs() {
    if (lonelyStoreOminousTimer) {
        clearTimeout(lonelyStoreOminousTimer);
        lonelyStoreOminousTimer = null;
    }
}

let eventRerollIntervalId = null;

function getNextRerollInterval() {
    // 45 seconds to 1 minute (45,000ms - 60,000ms)
    return 45000 + Math.random() * 15000;
}

function startEventRerollCycle() {
    stopEventRerollCycle();
    if (isLonelyStoreMode) return;
    let remaining = getNextRerollInterval();
    // Count playable time only: an intro, pause or checkout should not
    // consume a reroll window or discard the roll at its boundary.
    eventRerollIntervalId = setInterval(() => {
        if (!gameStarted || gameOver || isLonelyStoreMode) return;
        if (gamePaused || introCutsceneActive || isCheckout) return;
        remaining -= 1000;
        if (remaining <= 0) {
            performEventReroll();
            remaining = getNextRerollInterval();
        }
    }, 1000);
}

function stopEventRerollCycle() {
    if (eventRerollIntervalId !== null) {
        clearInterval(eventRerollIntervalId);
        eventRerollIntervalId = null;
    }
}

function performEventReroll() {
    if (!gameStarted || isCheckout || gameOver || gamePaused || introCutsceneActive || isLonelyStoreMode) return;
    if (Nuke.isNukeLockdown()) return;

    // Re-roll timed gameplay events only. Layout, construction, freezers and
    // the pre-game powerup are decided when the run is created.
    scheduleRandomEvents(true);
}

// NEW: Manager jumpscare event state
let managerActive = false;
let managerGroup = null;
let managerApproachActive = false;
let managerQuestionVisible = false;
let managerSlowTimeoutId = null;
let managerStompInterval = null;        // NEW: custom loop for overlapping stomp audio
let managerQuestionsAsked = 0;          // NEW: how many times the manager asked a question
let managerAnsweredYes = 0;             // NEW: count of "yes" answers
let managerAnsweredNo = 0;              // NEW: count of "no" answers
let suppressLockMessage = false;        // NEW: suppress next lock message after manager dialog
let managerJumpscareActive = false;     // FNAF style jumpscare active state
let jumpscareCameraRig = null;          // 3D camera-attached jumpscare manager rig
let jumpscareAnimId = null;             // RequestAnimationFrame ID for jumpscare
let jumpscareRenderer = null;
let jumpscareScene = null;
let jumpscareCamera = null;

// NEW: Wife Call and Earthquake state
let wifeCallActive = false;
let wifeCallRinging = false;
let phoneEventActive = false;
let wifeCallTimeoutId = null;
let wifeCallRetryTimeoutId = null;
let wifeCallCount = 0;
let wifeCallsAnsweredCount = 0;
let currentPhoneKeyHandler = null;
let earthquakeOccurred = false;
let earthquakeCount = 0;
let earthquakeTremorsUntil = 0;

function removePhoneKeyListener() {
    if (currentPhoneKeyHandler) {
        try {
            window.removeEventListener('keydown', currentPhoneKeyHandler, true);
        } catch (_) {}
        currentPhoneKeyHandler = null;
    }
}

function stopAllAudio() {
    cartRollingRequested = false;
    customerScuffleMusicMix = 0;
    if (customerScuffleMusic) {
        customerScuffleMusic.pause();
        customerScuffleMusic.currentTime = 0;
    }
    // Delegate to module
    stopAllAudioExt(music, menuMusic, soundEffects, [sfxKey, sfxTada, sfxPowerDown, sfxAttentionCustomers, sfxSqueak]);
    // Also stop fail music
    try {
        if (mrResettiMusic) {
            mrResettiMusic.pause();
            mrResettiMusic.currentTime = 0;
        }
    } catch (_) {}
    // Ensure manager stomp loop is fully stopped
    try {
        if (managerStompInterval) {
            clearInterval(managerStompInterval);
            managerStompInterval = null;
        }
        if (soundEffects && soundEffects.managerStomp) {
            soundEffects.managerStomp.pause();
            soundEffects.managerStomp.currentTime = 0;
        }
        if (soundEffects && soundEffects.managerStomp2) {
            soundEffects.managerStomp2.pause();
            soundEffects.managerStomp2.currentTime = 0;
        }
        if (soundEffects && soundEffects.phoneRing) {
            soundEffects.phoneRing.pause();
            soundEffects.phoneRing.currentTime = 0;
        }
        if (soundEffects && soundEffects.earthquake) {
            soundEffects.earthquake.pause();
            soundEffects.earthquake.currentTime = 0;
        }
    } catch (_) {}
}

// NEW: helper to play / stop fail music
function playFailMusic() {
    try {
        if (!mrResettiMusic) return;
        // Stop any current background / menu music so fail track fully replaces it
        if (music) music.pause();
        if (menuMusic) menuMusic.pause();
        mrResettiMusic.muted = musicMuted;
        mrResettiMusic.volume = CONFIG.MUSIC_VOLUME;
        mrResettiMusic.currentTime = 0;
        safePlayExt(mrResettiMusic);
    } catch (_) {}
}
function stopFailMusic() {
    try {
        if (mrResettiMusic) {
            mrResettiMusic.pause();
            mrResettiMusic.currentTime = 0;
        }
    } catch (_) {}
}

// Brutal but effective: clear all pending timeouts/intervals in this window
function clearAllTimers() {
    try {
        // Clear timeouts
        const highestTimeoutId = setTimeout(() => {}, 0);
        for (let i = 0; i <= highestTimeoutId; i++) clearTimeout(i);
        // Clear intervals
        const highestIntervalId = setInterval(() => {}, 0);
        for (let i = 0; i <= highestIntervalId; i++) clearInterval(i);
    } catch (_) {}
}

// Powerups state
let currentPowerup = null; // 'super_speed' | 'eagle_eye' | 'crazy_scanner' | 'extendo_arm' | null
let powerupUsed = false;
let powerupActive = false;
let powerupIndicatorEl = null;
let superSpeedTimeoutId = null;
let extendoArmTimeoutId = null;
let activeSpeedMultiplier = 1;
let eagleEyeTimeoutId = null;
let crazyScannerActive = false;
let crazyScannerTimeoutId = null;
let powerupCountdownInterval = null;
// Add smooth pickup transition state
let heldTransitionActive = false;
// moved a bit farther from camera
const heldOffset = new THREE.Vector3(0, -0.15, -0.8); // relative to camera
// Every item has the same normal weight; only the independent pickup
// weight roll makes an item unusually heavy or light.
const NORMAL_ITEM_MASS = 1;
function itemPhysicsMass(item) {
    return item.massOverride ?? NORMAL_ITEM_MASS;
}

function makeLooseItemBody(item, position) {
    const [w, h, d] = item.size || [0.3, 0.3, 0.3];
    const body = new CANNON.Body({
        mass: itemPhysicsMass(item),
        shape: new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2))
    });
    body.position.set(position.x, position.y, position.z);
    body.quaternion.copy(item.mesh.quaternion);
    body.linearDamping = 0.12;
    body.angularDamping = 0.4;
    world.addBody(body);
    return body;
}
// Trip animation state
let cartFlingActive = false;
let cartFlingVel = new THREE.Vector3();
let cartFlingStartY = 0;
let cameraFlickActive = false;
let cameraFlickElapsed = 0;
let cameraBasePitch = 0;
let cameraFlickStrength = 0; // controls how strong the camera flick is

// Slap mechanic state
let lastSlapAt = 0;
const SLAP_COOLDOWN_MS = 1500;
let slapActive = false;
let slapStart = 0;
let slapDuration = 300; // ms
let slapHand = null;
let slapDidImpact = false;
let customerSlapTexture = null;

// NEW: Reach multiplier for powerups (e.g., Extendo Arm)
let reachMultiplier = 1;

// Track menu autoplay handlers so we can remove them when leaving the menu
let menuAutoplayHandlers = [];
function stopMenuMusic() {
    stopMenuMusicExt(menuMusic);
}

// Every music track ever created, so mute always reaches all of them and a
// replaced/leftover track can never keep playing underneath the current one.
const musicTracks = new Set();
function registerMusic(el) {
    if (el) { musicTracks.add(el); el.muted = musicMuted; }
    return el;
}
function applyMusicMute() {
    for (const el of musicTracks) { try { el.muted = musicMuted; } catch (_) {} }
    try { updateMuteButtonIcon(); } catch (_) {}
}
function setMusicMuted(muted) {
    musicMuted = !!muted;
    try { localStorage.setItem('musicMuted', String(musicMuted)); } catch (_) {}
    applyMusicMute();
}
// Pause every music track except `keep` (only one song at a time).
function pauseOtherMusic(keep) {
    for (const el of musicTracks) {
        if (el !== keep && !el.paused) { try { el.pause(); } catch (_) {} }
    }
}
function retireMusic(el) {
    if (!el) return;
    try { el.pause(); el.removeAttribute('src'); el.load(); } catch (_) {}
    musicTracks.delete(el);
}

// NEW: Initialize menu music once
function initMenuMusicSingleton() {
    if (!menuMusic) {
        menuMusic = new Audio('Shopping Spree Serenade.mp3');
        menuMusic.loop = true;
        menuMusic.volume = CONFIG.MUSIC_VOLUME;
        registerMusic(menuMusic);
    } else {
        // keep existing instance; only update volume/mute to current config
        menuMusic.volume = CONFIG.MUSIC_VOLUME;
        menuMusic.muted = musicMuted;
    }
}

// FPS overlay
const fpsOverlay = document.createElement('div');
fpsOverlay.className = 'fps-overlay';
fpsOverlay.id = 'fps-overlay';
fpsOverlay.textContent = 'FPS: 0';
document.getElementById('game-container').appendChild(fpsOverlay);
let fpsLastTime = performance.now();
let fpsFrames = 0;
function updateFps() {
    fpsFrames++;
    const now = performance.now();
    if (now - fpsLastTime >= 1000) {
        const fps = Math.round((fpsFrames * 1000) / (now - fpsLastTime));
        fpsOverlay.textContent = `FPS: ${fps}`;
        fpsFrames = 0;
        fpsLastTime = now;
    }
}

// Utility: create an Audio element from the first source the browser can play
function createCompatibleAudio(sources) {
    const audio = new Audio();
    const test = new Audio();
    const pickSrc = (src) => {
        const ext = src.split('.').pop().toLowerCase();
        let mime = '';
        if (ext === 'mp3') mime = 'audio/mpeg';
        else if (ext === 'wav') mime = 'audio/wav';
        else if (ext === 'ogg') mime = 'audio/ogg';
        else if (ext === 'opus') mime = 'audio/ogg; codecs=opus'; // best cross-browser chance
        const canPlay = test.canPlayType(mime);
        return canPlay && canPlay !== '';
    };
    for (const src of sources) {
        if (pickSrc(src)) {
            audio.src = src;
            return audio;
        }
    }
    // No supported sources; return an empty audio to avoid crashing on play()
    return audio;
}

// Utility: safely play audio without unhandled promise rejections
async function safePlay(audio) {
    if (!audio || !audio.src) return;
    try {
        const p = audio.play();
        if (p && typeof p.catch === 'function') {
            await p.catch(() => {});
        }
    } catch (_) {}
}

// Perf: reuse raycaster/vectors and throttle per-frame work
let raycaster = null, lookDir = null, frameCount = 0;

// Interval trackers to allow proper clearing on restart/pause
let movementIntervalId = null;
let addItemIntervalId = null;
let removeItemIntervalId = null;
let eventsInitialized = false;
let animationStarted = false;
// Add a clock for frame-rate independent physics
let clock = new THREE.Clock();

// NEW: Track gameplay event handlers for proper cleanup between restarts
let keydownHandler = null;
let keyupHandler = null;
let windowBlurHandler = null;
let windowFocusHandler = null;
let rendererClickHandler = null;

// NEW: Unified mechanics reset to ensure identical behavior on all (re)starts
function resetAllMechanicsState() {
    // Clear held item and transitions
    try {
        if (heldItem) {
            // Restore material depth behavior if it was altered
            heldItem.mesh?.traverse((obj) => {
                if (obj.isMesh && obj.material) {
                    if (Array.isArray(obj.material)) {
                        obj.material.forEach(m => { m.depthTest = true; m.depthWrite = true; });
                    } else {
                        obj.material.depthTest = true;
                        obj.material.depthWrite = true;
                    }
                }
                obj.renderOrder = 0;
            });
        }
    } catch (_) {}
    heldItem = null;
    heldItemPulling = false;
    heldTransitionActive = false;
    cartDroppingItems = [];

    // Reset all run statistics and event tracking for current run
    initialFindItemsMessageShown = false;
    footstepCount = 0;
    tripCount = 0;
    itemsFallenCount = 0;
    wrongItemsGrabbedCount = 0;
    slapCount = 0;
    mislabeledItemsCount = 0;
    customerQuestionsCount = 0;
    managerJumpscareOccurred = false;
    gumCravingTriggered = false;
    checkoutBusyOccurred = false;
    powerupCollectedCount = 0;
    shelfReplacedCount = 0;
    productSpillCount = 0;
    powerOutageCount = 0;
    slipperyFloorCount = 0;
    storeClosingCount = 0;
    productSpillOccurred = false;
    underConstructionOccurred = false;
    fallingShelfOccurred = false;
    thiefEventOccurred = false;
    customerTheftEventsCount = 0;
    babyTantrumCount = 0;
    if (cartBabyActionTimerId) {
        try { clearTimeout(cartBabyActionTimerId); } catch (_) {}
        cartBabyActionTimerId = null;
    }
    cartBaby = null;
    cartBabyIsGood = false;
    cartBabyHead = null;
    cartBabyPacifier = null;
    cartBabyAction = null;
    cartBabyActionCount = 0;
    cartBabyActionLimit = 0;
    wifeCallCount = 0;
    wifeCallsAnsweredCount = 0;
    earthquakeCount = 0;
    earthquakeOccurred = false;
    Nuke.resetNuke();
    nukeContext = null;
    document.getElementById('game-container')?.classList.remove('nuke-aftermath');
    Thermo.resetThermostat();
    Thermo.clearThermostatStats();
    endCustomerScuffle(true);
    clearTweakerAndMoney();
    tweakerMoneyFailure = false;
    tweakerMoneyRisk = false;
    savingsCents = 0;
    updateSavingsTab();
    customerScuffleCount = 0;
    singleItemList = false;
    emptyShelfEvent = false;
    itemAddedEventCount = 0;
    itemRemovedEventCount = 0;
    twoInOneItemCollected = false;
    managerQuestionsAsked = 0;
    managerAnsweredYes = 0;
    managerAnsweredNo = 0;

    // Reset wallet / no-money state so it never leaks across games
    noMoneyForGroceries = false;
    walletFailed = false;

    // Reset collected items and shopping cart state
    collectedItems = [];
    purchaseComplete = false;
    paidListSnapshot = null;
    purchaseWrongItemsCount = 0;
    activeListPage = 'grocery';
    SQ.resetSideQuests();
    isCheckout = false;
    gameOver = false;
    cartAttached = true;
    twoInOneItemCollected = false;

    // Reset gum craving and busy checkout
    gumCravingActive = false;
    gumCravingSatisfied = false;
    gumCravingEvaluatedThisGame = false;
    checkoutBusyEvaluatedThisGame = false;
    itemsRemovedFromShoppingList.clear();
    checkoutExitCooldownUntil = 0;
    if (gumCravingTimeoutId) {
        try { clearTimeout(gumCravingTimeoutId); } catch(_) {}
        gumCravingTimeoutId = null;
    }

    // Reset out of stock items and store stock counts
    outOfStockListItems = [];
    storeStockCounts = {};

    // Clear raycaster caches and frame counters that affect hover/pickup
    raycaster = null;
    lookDir = null;
    frameCount = 0;

    // Reset powerups state and timers
    clearEagleEyeOutlines();
    if (superSpeedTimeoutId) { try { clearTimeout(superSpeedTimeoutId); } catch(_) {} superSpeedTimeoutId = null; }
    if (eagleEyeTimeoutId) { try { clearTimeout(eagleEyeTimeoutId); } catch(_) {} eagleEyeTimeoutId = null; }
    if (crazyScannerTimeoutId) { try { clearTimeout(crazyScannerTimeoutId); } catch(_) {} crazyScannerTimeoutId = null; }
    if (extendoArmTimeoutId) { try { clearTimeout(extendoArmTimeoutId); } catch(_) {} extendoArmTimeoutId = null; }
    crazyScannerActive = false;
    activeSpeedMultiplier = 1;
    if (powerupCountdownInterval) { clearInterval(powerupCountdownInterval); powerupCountdownInterval = null; }
    currentPowerup = null;
    powerupUsed = false;
    powerupActive = false;
    if (powerupIndicatorEl) {
        powerupIndicatorEl.classList.remove('visible');
        powerupIndicatorEl.textContent = '';
    }
    hidePowerupIndicator();

    // Clear busy checkout overlays/items
    try { endBusyCheckoutIfActive(); } catch (_) {}

    // Clear RNG notification UI
    if (rngNotificationsElement) {
        rngNotificationsElement.classList.remove('notification-visible');
        rngNotificationsElement.textContent = '';
    }

    // Remove pickup text UI if present
    const pt = document.getElementById('pickup-text');
    if (pt) pt.remove();

    // End baby crying overlays/sound if active
    if (babyCrying) { try { endBabyCrying(); } catch(_) {} }

    // Reset phone call and earthquake states
    wifeCallActive = false;
    wifeCallRinging = false;
    phoneEventActive = false;
    wifeCallCount = 0;
    wifeCallsAnsweredCount = 0;
    earthquakeOccurred = false;
    removePhoneKeyListener();
    if (wifeCallTimeoutId) { try { clearTimeout(wifeCallTimeoutId); } catch (_) {} wifeCallTimeoutId = null; }
    if (wifeCallRetryTimeoutId) { try { clearTimeout(wifeCallRetryTimeoutId); } catch (_) {} wifeCallRetryTimeoutId = null; }
    const phoneEl = document.getElementById('phone-call-container');
    if (phoneEl) { try { phoneEl.remove(); } catch (_) {} }
    const gc = document.getElementById('game-container');
    if (gc) gc.classList.remove('earthquake-shake');
    Thermo.resetThermostat();
    if (soundEffects && soundEffects.phoneRing) {
        try { soundEffects.phoneRing.pause(); soundEffects.phoneRing.currentTime = 0; } catch (_) {}
    }

    // Clean up glass shards on reset
    if (glassShardsZones && glassShardsZones.length > 0) {
        glassShardsZones.forEach(gz => {
            if (gz.mesh?.parent) gz.mesh.parent.remove(gz.mesh);
        });
        glassShardsZones = [];
    }
    playerOnGlassShards = false;

    // Reset event re-roll cycle
    stopEventRerollCycle();

    // Clear all alerts and notifications so none linger
    clearAllAlertsAndNotifications();

    // Clean up store worker
    cleanupStoreWorker();

    // Ensure menu autoplay listeners are cleared (handled in hideMainMenu) but double safety
    menuAutoplayHandlers.forEach(h => { try { document.removeEventListener(h.type, h.fn); } catch(_) {} });
    menuAutoplayHandlers = [];
}

// NEW: Tag to mark items placed in NPC carts (predeclare default)
let npcCartItemFlag = Symbol('inCustomerCart');

function createRuntimeTowelModel() {
    const group = new THREE.Group();
    const towelColors = [0x1A365D, 0x42A5F5, 0xF5EBE0, 0xFFFFFF];
    const layerHeight = 0.12;
    const towelW = 0.52;
    const towelD = 0.46;

    towelColors.forEach((col, i) => {
        const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.85 });
        const layer = new THREE.Mesh(new THREE.BoxGeometry(towelW, layerHeight - 0.01, towelD), mat);
        layer.position.y = 0.06 + i * layerHeight;
        group.add(layer);

        const hemMat = new THREE.MeshStandardMaterial({ color: i === 3 ? 0xD4AF37 : 0xffffff, roughness: 0.6 });
        const hem = new THREE.Mesh(new THREE.BoxGeometry(towelW - 0.02, 0.012, 0.02), hemMat);
        hem.position.set(0, 0.06 + i * layerHeight, towelD / 2 + 0.005);
        group.add(hem);
    });

    const bandMat = new THREE.MeshStandardMaterial({ color: 0x0F172A, roughness: 0.4 });
    const band = new THREE.Mesh(new THREE.BoxGeometry(towelW + 0.015, 0.20, towelD + 0.015), bandMat);
    band.position.set(0, 0.24, 0);
    group.add(band);

    const ribbonMat = new THREE.MeshStandardMaterial({ color: 0xD4AF37, roughness: 0.4, metalness: 0.3 });
    const ribbon = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.025, 0.12), ribbonMat);
    ribbon.position.set(0, 0.50, 0);
    group.add(ribbon);

    const wrapMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.15, transparent: true, opacity: 0.16 });
    const wrap = new THREE.Mesh(new THREE.BoxGeometry(towelW + 0.03, 0.50, towelD + 0.03), wrapMat);
    wrap.position.y = 0.24;
    group.add(wrap);

    return group;
}

function createRuntimeSteakModel() {
    const group = new THREE.Group();
    const trayMat = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.6 });
    const tray = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.04, 0.44), trayMat);
    tray.position.y = 0.02;
    group.add(tray);

    const meatMat = new THREE.MeshStandardMaterial({ color: 0x9c2330, roughness: 0.65 });
    const steakMesh = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.06, 0.34), meatMat);
    steakMesh.position.set(0, 0.06, 0);
    group.add(steakMesh);

    const fatMat = new THREE.MeshStandardMaterial({ color: 0xfff8ef, roughness: 0.45 });
    const fatStrip = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.062, 0.04), fatMat);
    fatStrip.position.set(0, 0.061, 0.14);
    group.add(fatStrip);

    const wrapMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.15, transparent: true, opacity: 0.16 });
    const wrap = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.14, 0.46), wrapMat);
    wrap.position.y = 0.06;
    group.add(wrap);

    return group;
}

function createGumModel(flavorColor = 0x16a34a, flavorName = 'SPEARMINT') {
    const group = new THREE.Group();

    // 1. Silver inner foil core
    const foilMat = new THREE.MeshStandardMaterial({
        color: 0xe2e8f0,
        metalness: 0.88,
        roughness: 0.22
    });
    const foilCore = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.076, 0.116), foilMat);
    foilCore.position.y = 0.038;
    group.add(foilCore);

    // 2. Outer paper sleeve wrapper (slightly shorter in X to reveal silver foil tips)
    const sleeveWidth = 0.24;
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    
    // Background flavor color
    const hexCol = typeof flavorColor === 'number' ? '#' + flavorColor.toString(16).padStart(6, '0') : '#16a34a';
    ctx.fillStyle = hexCol;
    ctx.fillRect(0, 0, 256, 128);

    // Dynamic contrast styling
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(8, 18, 240, 52);

    ctx.fillStyle = hexCol;
    ctx.font = '900 32px "Arial Black", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('GUM', 128, 56);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText(`★ ${flavorName} ★`, 128, 98);

    // Border
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.strokeRect(4, 4, 248, 120);

    const labelTex = new THREE.CanvasTexture(canvas);
    const sleeveMat = new THREE.MeshStandardMaterial({
        color: flavorColor,
        roughness: 0.45,
        metalness: 0.05
    });
    const labelMat = new THREE.MeshStandardMaterial({
        map: labelTex,
        roughness: 0.4
    });

    const sleeveMesh = new THREE.Mesh(
        new THREE.BoxGeometry(sleeveWidth, 0.082, 0.122),
        [sleeveMat, sleeveMat, labelMat, sleeveMat, labelMat, sleeveMat]
    );
    sleeveMesh.position.y = 0.041;
    group.add(sleeveMesh);

    // 3. Stick rib lines on top
    const ribMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.8, transparent: true, opacity: 0.18 });
    for (let s = -2; s <= 2; s++) {
        const rib = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.004, 0.11), ribMat);
        rib.position.set(s * 0.042, 0.084, 0);
        group.add(rib);
    }

    return group;
}


// Uniform size reduction applied to every product model.
const ITEM_SCALE = 0.85;

// Lofts a closed tube through stacked superellipse rings (n=2 circle, higher =
// squarer). Rings: { y, hx, hz, n, cx, cz }. Bottom/top get flat caps.
function loftRingsGeometry(rings, segs = 32) {
    const pos = [], idx = [];
    const ringPt = (r, a) => {
        const c = Math.cos(a), s = Math.sin(a), e = 2 / r.n;
        return [r.cx + Math.sign(c) * Math.pow(Math.abs(c), e) * r.hx, r.y,
                r.cz + Math.sign(s) * Math.pow(Math.abs(s), e) * r.hz];
    };
    rings.forEach(r => { for (let i = 0; i < segs; i++) pos.push(...ringPt(r, (i / segs) * Math.PI * 2)); });
    for (let j = 0; j < rings.length - 1; j++) {
        for (let i = 0; i < segs; i++) {
            const a = j * segs + i, b = j * segs + (i + 1) % segs;
            const c = a + segs, d = b + segs;
            idx.push(a, c, b, b, c, d);
        }
    }
    const capCenter = (r, ringIndex, up) => {
        const ci = pos.length / 3;
        pos.push(r.cx, r.y, r.cz);
        for (let i = 0; i < segs; i++) {
            const a = ringIndex * segs + i, b = ringIndex * segs + (i + 1) % segs;
            if (up) idx.push(ci, b, a); else idx.push(ci, a, b);
        }
    };
    capCenter(rings[0], 0, false);
    capCenter(rings[rings.length - 1], rings.length - 1, true);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
}

const _itemAssetCache = {};
function cachedItemAsset(key, make) {
    return _itemAssetCache[key] || (_itemAssetCache[key] = make());
}

function buildMilkJugModel() {
    const group = new THREE.Group();
    const jugMat = new THREE.MeshStandardMaterial({ color: 0xF4F6F8, roughness: 0.38, metalness: 0.02 });
    // Gallon jug: squared body, sloped shoulder that rises to an off-centre neck.
    const neckX = -0.08, neckZ = 0.04;
    const body = new THREE.Mesh(cachedItemAsset('milkBodyGeo', () => loftRingsGeometry([
        { y: 0.00, hx: 0.17, hz: 0.17, n: 4,   cx: 0,            cz: 0 },
        { y: 0.025, hx: 0.20, hz: 0.20, n: 5,  cx: 0,            cz: 0 },
        { y: 0.27, hx: 0.198, hz: 0.198, n: 5, cx: 0,            cz: 0 }, // grip waist
        { y: 0.50, hx: 0.20, hz: 0.20, n: 5,   cx: 0,            cz: 0 },
        { y: 0.58, hx: 0.185, hz: 0.185, n: 4.5, cx: neckX * 0.15, cz: neckZ * 0.15 },
        { y: 0.66, hx: 0.14, hz: 0.14, n: 3.2, cx: neckX * 0.5,  cz: neckZ * 0.5 },
        { y: 0.72, hx: 0.085, hz: 0.085, n: 2.3, cx: neckX * 0.9, cz: neckZ * 0.9 },
        { y: 0.75, hx: 0.062, hz: 0.062, n: 2, cx: neckX,        cz: neckZ },
        { y: 0.80, hx: 0.062, hz: 0.062, n: 2, cx: neckX,        cz: neckZ }
    ], 32)), jugMat);

    const cap = new THREE.Mesh(
        cachedItemAsset('milkCapGeo', () => new THREE.CylinderGeometry(0.068, 0.068, 0.05, 18)),
        new THREE.MeshStandardMaterial({ color: 0x1976D2, roughness: 0.35 })
    );
    cap.position.set(neckX, 0.825, neckZ);

    // Hollow carry handle on the back corner of the shoulder.
    const handle = new THREE.Mesh(cachedItemAsset('milkHandleGeo', () => new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3([
            new THREE.Vector3(0.02, 0.70, -0.02),
            new THREE.Vector3(0.14, 0.70, -0.10),
            new THREE.Vector3(0.21, 0.62, -0.15),
            new THREE.Vector3(0.22, 0.50, -0.16),
            new THREE.Vector3(0.17, 0.42, -0.13)
        ]), 14, 0.032, 8, false)), jugMat);

    // Flat printed label on the front face.
    const labelTex = cachedItemAsset('milkLabelTex', () => {
        const canvas = document.createElement('canvas');
        canvas.width = 512; canvas.height = 448;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, 512, 448);
        ctx.fillStyle = '#1565C0'; ctx.fillRect(0, 0, 512, 130);
        ctx.fillStyle = '#FFFFFF'; ctx.textAlign = 'center';
        ctx.font = 'bold 30px sans-serif'; ctx.fillText('★ GRADE B+ ★', 256, 42);
        ctx.font = 'bold 56px "Arial Black", sans-serif';
        fitText(ctx, 'LIZARD MILK', 256, 108, 480);
        ctx.fillStyle = '#4CAF50'; ctx.beginPath(); ctx.ellipse(256, 300, 220, 80, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#1565C0'; ctx.font = 'bold 38px "Arial Black", sans-serif';
        fitText(ctx, '1 GALLON', 256, 200, 480);
        ctx.fillStyle = '#FFFFFF'; ctx.font = 'bold 26px sans-serif';
        fitText(ctx, 'COLD-BLOODED • 3.78 L', 256, 310, 400);
        ctx.fillStyle = '#555555'; ctx.font = 'bold 22px sans-serif';
        fitText(ctx, 'SUN-BASKED • SCALE-FREE (MOSTLY)', 256, 420, 480);
        return new THREE.CanvasTexture(canvas);
    });
    const label = new THREE.Mesh(
        cachedItemAsset('milkLabelGeo', () => new THREE.PlaneGeometry(0.30, 0.26)),
        new THREE.MeshBasicMaterial({ map: labelTex })
    );
    label.position.set(0, 0.28, 0.2005);

    group.add(body, cap, handle, label);
    return group;
}

function buildPotatoBagModel() {
    const group = new THREE.Group();
    // Lumpy sack silhouette (lathe) that gathers into a tied top.
    const lumpyLathe = (scale) => {
        const prof = [[0.0, 0.0], [0.17, 0.01], [0.25, 0.06], [0.28, 0.16], [0.27, 0.28],
                      [0.22, 0.38], [0.12, 0.45], [0.04, 0.49], [0.03, 0.52]]
            .map(([r, y]) => new THREE.Vector2(r * scale, y));
        const g = new THREE.LatheGeometry(prof, 16);
        const p = g.attributes.position;
        for (let i = 0; i < p.count; i++) {
            const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
            const a = Math.atan2(z, x);
            const bump = 1 + 0.07 * Math.sin(a * 5 + y * 9) * Math.sin(y * 17 + a * 2) * Math.min(1, y * 6);
            p.setX(i, x * bump); p.setZ(i, z * bump);
        }
        g.computeVertexNormals();
        return g;
    };
    const potatoes = new THREE.Mesh(
        cachedItemAsset('potatoInnerGeo', () => lumpyLathe(0.95)),
        new THREE.MeshStandardMaterial({ color: 0x9A6B3A, roughness: 0.92 })
    );
    const netTex = cachedItemAsset('potatoNetTex', () => {
        const c = document.createElement('canvas');
        c.width = c.height = 64;
        const ctx = c.getContext('2d');
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 7;
        ctx.beginPath();
        ctx.moveTo(0, 0); ctx.lineTo(64, 64);
        ctx.moveTo(64, 0); ctx.lineTo(0, 64);
        ctx.stroke();
        const t = new THREE.CanvasTexture(c);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(10, 6);
        return t;
    });
    const net = new THREE.Mesh(
        cachedItemAsset('potatoNetGeo', () => lumpyLathe(1.02)),
        new THREE.MeshStandardMaterial({ color: 0xD84315, map: netTex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.8 })
    );
    // Tie twist + cardboard header tag.
    const tie = new THREE.Mesh(
        cachedItemAsset('potatoTieGeo', () => new THREE.CylinderGeometry(0.035, 0.05, 0.06, 10)),
        new THREE.MeshStandardMaterial({ color: 0xC62828, roughness: 0.7 })
    );
    tie.position.y = 0.53;
    const tagTex = cachedItemAsset('potatoTagTex', () => {
        const canvas = document.createElement('canvas');
        canvas.width = 512; canvas.height = 256;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#D7CCC8'; ctx.fillRect(0, 0, 512, 256);
        ctx.strokeStyle = '#5D4037'; ctx.lineWidth = 8; ctx.strokeRect(12, 12, 488, 232);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#2E7D32'; ctx.font = 'bold 28px serif';
        fitText(ctx, '★ NOT RUSSET ★', 256, 50, 470);
        ctx.fillStyle = '#4E342E'; ctx.font = 'bold 44px "Arial Black", sans-serif';
        fitText(ctx, 'RUSSEL POTATOS', 256, 115, 470);
        ctx.fillStyle = '#8D6E63'; ctx.font = 'bold 24px sans-serif';
        fitText(ctx, 'GROWN BY RUSSEL • NET WT 5 LBS', 256, 175, 470);
        ctx.fillStyle = '#2E7D32'; ctx.font = 'bold 20px sans-serif';
        fitText(ctx, 'RUSSEL SAYS HI', 256, 225, 470);
        return new THREE.CanvasTexture(canvas);
    });
    const tag = new THREE.Mesh(
        cachedItemAsset('potatoTagGeo', () => new THREE.PlaneGeometry(0.30, 0.15)),
        new THREE.MeshBasicMaterial({ map: tagTex, side: THREE.DoubleSide })
    );
    tag.position.set(0, 0.24, 0.29);
    tag.rotation.x = -0.18;
    group.add(potatoes, net, tie, tag);
    return group;
}

function buildSlicedBreadModel() {
    const group = new THREE.Group();
    const sliceGeometry = cachedItemAsset('breadSliceGeo', () => {
        // Nine-point loaf profile: flat base, rounded shoulders, no bevels.
        const shape = new THREE.Shape();
        shape.moveTo(-0.175, 0.012);
        shape.lineTo(0.175, 0.012);
        shape.lineTo(0.175, 0.18);
        shape.lineTo(0.15, 0.24);
        shape.lineTo(0.09, 0.285);
        shape.lineTo(0, 0.30);
        shape.lineTo(-0.09, 0.285);
        shape.lineTo(-0.15, 0.24);
        shape.lineTo(-0.175, 0.18);
        shape.closePath();
        const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.056, steps: 1, bevelEnabled: false });
        geometry.rotateY(Math.PI / 2);
        geometry.translate(-0.028, 0, 0);
        return geometry;
    });
    const sliceMaterials = cachedItemAsset('breadSliceMaterials', () => [
        new THREE.MeshStandardMaterial({ color: 0xFFF1D4, roughness: 0.88 }),
        new THREE.MeshStandardMaterial({ color: 0xC68A3A, roughness: 0.75 })
    ]);
    // Two instanced draws (crumb faces + crust), not a separate mesh per slice.
    const slices = new THREE.InstancedMesh(sliceGeometry, sliceMaterials, 10);
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < 10; i++) {
        matrix.makeTranslation(-0.279 + i * 0.062, 0, 0);
        slices.setMatrixAt(i, matrix);
    }
    slices.instanceMatrix.needsUpdate = true;
    slices.computeBoundingBox();
    slices.computeBoundingSphere();
    group.add(slices);

    const bagGeometry = cachedItemAsset('breadBagGeo', () => {
        const rings = [
            [-0.335, 0.185, 0.21], [-0.32, 0.185, 0.21],
            [0.325, 0.185, 0.21], [0.39, 0.025, 0.03], [0.445, 0.065, 0.085]
        ].map(([y, hx, hz]) => ({ y, hx, hz, n: 6, cx: 0, cz: 0 }));
        const geometry = loftRingsGeometry(rings, 12);
        geometry.rotateZ(-Math.PI / 2);
        geometry.translate(0, 0.17, 0);
        return geometry;
    });
    const bagMaterial = cachedItemAsset('breadBagMaterial', () => new THREE.MeshStandardMaterial({
        color: 0xFFFFFF, roughness: 0.16, transparent: true, opacity: 0.16, depthWrite: false
    }));
    group.add(new THREE.Mesh(bagGeometry, bagMaterial));

    const labelTexture = cachedItemAsset('breadLabelTex', () => {
        const canvas = document.createElement('canvas');
        canvas.width = 512; canvas.height = 256;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#0D47A1'; ctx.fillRect(0, 0, 512, 256);
        ctx.fillStyle = '#FFF9C4'; ctx.fillRect(16, 16, 480, 224);
        ctx.fillStyle = '#B71C1C'; ctx.font = 'bold 24px sans-serif';
        ctx.textAlign = 'center'; fitText(ctx, '★ BEIGE-ADJACENT BAKERY ★', 256, 46, 460);
        ctx.fillStyle = '#0D47A1'; ctx.font = 'bold 34px "Arial Black", sans-serif';
        fitText(ctx, 'SOMEWHAT', 256, 88, 460);
        fitText(ctx, 'WHITE BREAD', 256, 128, 460);
        ctx.fillStyle = '#2E7D32'; ctx.font = 'bold 22px sans-serif';
        fitText(ctx, 'SLICED LOAF', 256, 168, 460);
        ctx.fillStyle = '#555555'; ctx.font = 'bold 18px sans-serif';
        fitText(ctx, 'SOFT-ISH & FRESH-ISH • NET WT 20 OZ-ISH', 256, 215, 460);
        return new THREE.CanvasTexture(canvas);
    });
    const label = new THREE.Mesh(
        cachedItemAsset('breadLabelGeo', () => new THREE.PlaneGeometry(0.30, 0.20)),
        cachedItemAsset('breadLabelMaterial', () => new THREE.MeshStandardMaterial({ map: labelTexture, roughness: 0.4 }))
    );
    label.rotation.x = -Math.PI / 2;
    label.position.set(-0.06, 0.357, 0);
    group.add(label);

    const clip = new THREE.Mesh(
        cachedItemAsset('breadClipGeo', () => new THREE.BoxGeometry(0.018, 0.06, 0.07)),
        cachedItemAsset('breadClipMaterial', () => new THREE.MeshStandardMaterial({ color: 0x1E88E5, roughness: 0.5 }))
    );
    clip.position.set(0.39, 0.17, 0);
    group.add(clip);
    return group;
}

// Available items with more realistic representations
const BASE_ITEMS = [
    { 
        name: "Milk", 
        color: 0xF0F0F0, 
        size: [0.6, 0.9, 0.6],
        quantity: [1, 2],
        model: buildMilkJugModel
    },
    { 
        name: "Bread", 
        color: 0xD2B48C, 
        size: [0.8, 0.35, 0.5],
        quantity: [1, 3],
        model: buildSlicedBreadModel
    },
    { 
        name: "Eggs", 
        color: 0xF5F5DC, 
        size: [0.75, 0.35, 0.55],
        quantity: [1, 1],
        model: function() {
            const group = new THREE.Group();
            const cartonMat = new THREE.MeshStandardMaterial({ color: 0xD7CCC8, roughness: 0.85 });
            const eggMat = new THREE.MeshStandardMaterial({ color: 0xFFFDF0, roughness: 0.4 });
            const brownEggMat = new THREE.MeshStandardMaterial({ color: 0xA0522D, roughness: 0.45 });

            // Molded Pulp Carton Base
            const base = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.14, 0.48), cartonMat);
            base.position.y = 0.07;

            // Open/Angled Carton Lid
            const lid = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.04, 0.48), cartonMat);
            lid.position.set(0, 0.24, -0.22);
            lid.rotation.x = Math.PI / 4;

            // Printed Egg Carton Label
            const canvas = document.createElement('canvas');
            canvas.width = 512; canvas.height = 256;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#2E7D32'; ctx.fillRect(0, 0, 512, 256);
            ctx.fillStyle = '#FFFDE7'; ctx.fillRect(12, 12, 488, 232);
            ctx.fillStyle = '#1B5E20'; ctx.font = 'bold 30px sans-serif';
            ctx.textAlign = 'center'; ctx.fillText('★ GRADE A ★', 256, 55);
            ctx.fillStyle = '#B71C1C'; ctx.font = 'bold 44px "Arial Black", sans-serif';
            fitText(ctx, 'DINOSAUR EGGS', 256, 115, 470);
            ctx.fillStyle = '#333333'; ctx.font = 'bold 24px sans-serif';
            fitText(ctx, 'ONE DOZEN (MAY HATCH)', 256, 170, 470);
            ctx.fillStyle = '#1B5E20'; ctx.font = 'bold 18px sans-serif';
            fitText(ctx, 'JURASSIC FRESH • DO NOT INCUBATE', 256, 215, 470);

            const lidTex = new THREE.CanvasTexture(canvas);
            const labelMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.66, 0.42), new THREE.MeshBasicMaterial({ map: lidTex }));
            labelMesh.position.set(0, 0.022, 0);
            labelMesh.rotation.x = -Math.PI / 2;
            lid.add(labelMesh);

            group.add(base, lid);

            // 12 eggs (2 rows of 6): 11 White Eggs + EXACTLY 1 DISTINCT BROWN EGG (at index 4)
            for (let r = 0; r < 2; r++) {
                for (let c = 0; c < 6; c++) {
                    const idx = r * 6 + c;
                    const isBrownEgg = (idx === 4); // Keep the one brown egg
                    const egg = new THREE.Mesh(
                        new THREE.SphereGeometry(0.048, 14, 14),
                        isBrownEgg ? brownEggMat : eggMat
                    );
                    egg.scale.set(1.0, 1.35, 1.0);
                    egg.position.set(
                        -0.28 + c * 0.112,
                        0.14,
                        -0.10 + r * 0.20
                    );
                    group.add(egg);
                }
            }

            return group;
        }
    },
    { 
        name: "Cereal", 
        color: 0xFF8C00, 
        size: [0.55, 0.85, 0.32],
        quantity: [1, 2],
        model: function() {
            const group = new THREE.Group();
            const boxMat = new THREE.MeshStandardMaterial({ color: 0xF57C00, roughness: 0.5 });
            const box = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.82, 0.28), boxMat);
            box.position.y = 0.41;

            // Full color cereal box front artwork
            const canvas = document.createElement('canvas');
            canvas.width = 512; canvas.height = 768;
            const ctx = canvas.getContext('2d');
            // Vibrant orange & yellow sunburst
            ctx.fillStyle = '#FF9800'; ctx.fillRect(0, 0, 512, 768);
            ctx.fillStyle = '#FFF8E1'; ctx.beginPath(); ctx.arc(256, 300, 220, 0, Math.PI * 2); ctx.fill();
            // Mascot header banner
            ctx.fillStyle = '#D32F2F'; ctx.fillRect(0, 40, 512, 130);
            ctx.fillStyle = '#FFEB3B'; ctx.font = 'bold 32px sans-serif';
            ctx.textAlign = 'center'; ctx.fillText('★ RED 40 ★', 256, 80);
            ctx.fillStyle = '#FFFFFF'; ctx.font = 'bold 34px "Arial Black", sans-serif';
            fitText(ctx, 'CRUNCHY', 256, 120, 480);
            fitText(ctx, 'MACRO PLASTICS', 256, 158, 480);

            // Cereal Bowl graphic
            ctx.fillStyle = '#1E88E5'; ctx.beginPath(); ctx.ellipse(256, 520, 180, 90, 0, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#FFFDE7'; ctx.beginPath(); ctx.ellipse(256, 505, 160, 70, 0, 0, Math.PI * 2); ctx.fill();
            // Golden Flakes
            ctx.fillStyle = '#FBC02D';
            for (let i = 0; i < 30; i++) {
                const fx = 140 + (i % 6) * 45 + (i % 3) * 10;
                const fy = 470 + Math.floor(i / 6) * 15;
                ctx.beginPath(); ctx.ellipse(fx, fy, 14, 8, Math.random(), 0, Math.PI * 2); ctx.fill();
            }

            // Nutritional badges
            ctx.fillStyle = '#2E7D32'; ctx.font = 'bold 26px sans-serif';
            fitText(ctx, 'WHOLE PLASTIC • 0 VITAMINS', 256, 680, 470);
            ctx.fillStyle = '#333333'; ctx.font = 'bold 22px sans-serif';
            fitText(ctx, 'NOT MICROWAVE SAFE • NET WT 18 OZ', 256, 730, 470);

            const frontTex = new THREE.CanvasTexture(canvas);
            const frontLabel = new THREE.Mesh(
                new THREE.PlaneGeometry(0.515, 0.815),
                new THREE.MeshBasicMaterial({ map: frontTex })
            );
            frontLabel.position.set(0, 0.41, 0.141);

            group.add(box, frontLabel);
            return group;
        } 
    },
    { 
        name: "Apples", 
        color: 0xFF0000, 
        size: [0.3, 0.35, 0.3],
        quantity: [1, 4],
        model: function() {
            const group = new THREE.Group();
            // Apple body - slightly squashed sphere
            const bodyGeom = new THREE.SphereGeometry(0.18, 20, 20);
            const bodyMat = new THREE.MeshStandardMaterial({ color: 0xCC0000, roughness: 0.6, metalness: 0.05 });
            const body = new THREE.Mesh(bodyGeom, bodyMat);
            body.scale.set(1, 0.9, 1);
            // Stem - dark brown cylinder
            const stemGeom = new THREE.CylinderGeometry(0.02, 0.02, 0.12, 8);
            const stemMat = new THREE.MeshStandardMaterial({ color: 0x4b2e17, roughness: 0.9 });
            const stem = new THREE.Mesh(stemGeom, stemMat);
            stem.position.set(0.03, 0.22, 0);
            stem.rotation.z = -Math.PI / 12;

            // Optional subtle leaf for visibility (kept simple)
            const leafGeom = new THREE.PlaneGeometry(0.12, 0.06);
            const leafMat = new THREE.MeshStandardMaterial({ color: 0x2e8b57, side: THREE.DoubleSide });
            const leaf = new THREE.Mesh(leafGeom, leafMat);
            leaf.position.set(0.06, 0.2, 0.02);
            leaf.rotation.set(0, Math.PI / 6, Math.PI / 8);

            group.add(body, stem, leaf);
            return group;
        }
    },
    { 
        name: "Bananas", 
        color: 0xFFFF00, 
        size: [0.8, 0.35, 0.4],
        quantity: [1, 2],
        model: function() {
            const group = new THREE.Group();
            const bananaMat = new THREE.MeshStandardMaterial({ color: 0xFDD835, roughness: 0.45, metalness: 0.05 });
            const tipMat = new THREE.MeshStandardMaterial({ color: 0x4E342E, roughness: 0.8 });
            const stalkMat = new THREE.MeshStandardMaterial({ color: 0x558B2F, roughness: 0.7 });
            const stickerMat = new THREE.MeshBasicMaterial({ color: 0x1565C0 });

            // Crown / Stalk where bananas attach
            const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 0.14, 12), stalkMat);
            stalk.position.set(-0.28, 0.16, 0);
            stalk.rotation.z = Math.PI / 4;
            group.add(stalk);

            // Cluster of 5 organic curved bananas
            const count = 5;
            for (let i = 0; i < count; i++) {
                const angle = (i - (count - 1) / 2) * 0.14;
                const zOff = (i - (count - 1) / 2) * 0.08;
                const lift = Math.sin((i / (count - 1)) * Math.PI) * 0.04;

                const curve = new THREE.CubicBezierCurve3(
                    new THREE.Vector3(-0.25, 0.14, zOff * 0.5),
                    new THREE.Vector3(-0.08, 0.22 + lift, zOff),
                    new THREE.Vector3(0.18, 0.16 + lift, zOff),
                    new THREE.Vector3(0.32, 0.03, zOff * 0.9)
                );
                const geo = new THREE.TubeGeometry(curve, 16, 0.042, 8, false);
                const bMesh = new THREE.Mesh(geo, bananaMat);
                group.add(bMesh);

                // Brown tip on flower end
                const tip = new THREE.Mesh(new THREE.SphereGeometry(0.038, 8, 8), tipMat);
                tip.position.set(0.32, 0.03, zOff * 0.9);
                group.add(tip);

                // Produce brand sticker on middle banana
                if (i === 2) {
                    const sticker = new THREE.Mesh(new THREE.CircleGeometry(0.022, 12), stickerMat);
                    sticker.position.set(0.04, 0.21, zOff + 0.045);
                    sticker.rotation.x = -Math.PI / 6;
                    group.add(sticker);
                }
            }

            return group;
        } 
    },
    { 
        name: "Cleaning Supplies", 
        color: 0x1E90FF, 
        size: [0.55, 0.9, 0.45],
        quantity: [1, 3],
        model: function() {
            const group = new THREE.Group();
            
            // Translucent cyan bottle body with ergonomic grip
            const bottleMat = new THREE.MeshPhysicalMaterial({ 
                color: 0x00E5FF, 
                roughness: 0.15, 
                metalness: 0.05, 
                transparent: true, 
                opacity: 0.85 
            });
            const body = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.52, 20), bottleMat);
            body.position.y = 0.26;

            const shoulder = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.16, 0.18, 20), bottleMat);
            shoulder.position.y = 0.58;

            // Trigger Sprayer Head (White & Blue plastic)
            const sprayMat = new THREE.MeshStandardMaterial({ color: 0xFAFAFA, roughness: 0.3 });
            const blueAccentMat = new THREE.MeshStandardMaterial({ color: 0x0288D1, roughness: 0.3 });

            const sprayHead = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.28), sprayMat);
            sprayHead.position.set(0, 0.72, 0.04);

            // Nozzle tip
            const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.06, 12), blueAccentMat);
            nozzle.rotation.x = Math.PI / 2;
            nozzle.position.set(0, 0.72, 0.19);

            // Trigger lever
            const trigger = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.12, 0.04), blueAccentMat);
            trigger.position.set(0, 0.64, 0.10);
            trigger.rotation.x = -0.3;

            // Front Brand Label
            const canvas = document.createElement('canvas');
            canvas.width = 512; canvas.height = 384;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#0288D1'; ctx.fillRect(0, 0, 512, 384);
            ctx.fillStyle = '#E1F5FE'; ctx.fillRect(12, 12, 488, 360);
            ctx.fillStyle = '#01579B'; ctx.font = 'bold 32px sans-serif';
            ctx.textAlign = 'center'; ctx.fillText('★ SHINE-ISH ★', 256, 55);
            ctx.fillStyle = '#D81B60'; ctx.font = 'bold 42px "Arial Black", sans-serif';
            fitText(ctx, 'NO PURPOSE', 256, 110, 470);
            ctx.fillStyle = '#01579B'; ctx.font = 'bold 44px "Arial Black", sans-serif';
            ctx.fillText('CLEANER', 256, 160);
            ctx.fillStyle = '#2E7D32'; ctx.font = 'bold 24px sans-serif';
            fitText(ctx, 'CLEANS 11.25% OF GERMS', 256, 222, 460);
            ctx.font = 'bold 18px sans-serif'; ctx.fillText('(GIVE OR TAKE)', 256, 252);
            ctx.fillStyle = '#555555'; ctx.font = 'bold 20px sans-serif';
            fitText(ctx, 'SMELLS LIKE A SMELL • 32 FL OZ', 256, 330, 460);

            const labelTex = new THREE.CanvasTexture(canvas);
            const labelMesh = new THREE.Mesh(
                new THREE.CylinderGeometry(0.162, 0.182, 0.34, 20, 1, true, -Math.PI * 0.4, Math.PI * 0.8),
                new THREE.MeshBasicMaterial({ map: labelTex, side: THREE.DoubleSide })
            );
            labelMesh.position.y = 0.28;

            // Yellow Textured Scrub Sponge beside bottle
            const spongeMat = new THREE.MeshStandardMaterial({ color: 0xFFEB3B, roughness: 0.9 });
            const scourMat = new THREE.MeshStandardMaterial({ color: 0x2E7D32, roughness: 0.85 });
            const sponge = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.08, 0.14), spongeMat);
            sponge.position.set(0.22, 0.04, 0);
            const scourPad = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.02, 0.14), scourMat);
            scourPad.position.set(0.22, 0.09, 0);

            group.add(body, shoulder, sprayHead, nozzle, trigger, labelMesh, sponge, scourPad);
            return group;
        } 
    },
    {
        name: "Soda",
        color: 0xDC143C,
        size: [0.4, 0.9, 0.4],
        quantity: [1, 3],
        model: function() {
            const group = new THREE.Group();
            // 2-Liter contoured bottle with dark cola liquid
            const bottleMat = new THREE.MeshStandardMaterial({ 
                color: 0x2B1108, 
                roughness: 0.2, 
                metalness: 0.1 
            });
            const body = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.52, 24), bottleMat);
            body.position.y = 0.30;

            const shoulder = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.18, 0.22, 24), bottleMat);
            shoulder.position.y = 0.65;

            // Red Screw Cap
            const cap = new THREE.Mesh(
                new THREE.CylinderGeometry(0.075, 0.075, 0.07, 16),
                new THREE.MeshStandardMaterial({ color: 0xD32F2F, roughness: 0.25 })
            );
            cap.position.y = 0.78;

            // Wrap-around FIZZ COLA Brand Label
            const canvas = document.createElement('canvas');
            canvas.width = 512; canvas.height = 256;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#C62828'; ctx.fillRect(0, 0, 512, 256);
            // White dynamic wave ribbon
            ctx.fillStyle = '#FFFFFF';
            ctx.beginPath();
            ctx.moveTo(0, 160);
            ctx.bezierCurveTo(150, 100, 350, 220, 512, 140);
            ctx.lineTo(512, 180);
            ctx.bezierCurveTo(350, 260, 150, 140, 0, 200);
            ctx.closePath();
            ctx.fill();

            // Brand title
            ctx.fillStyle = '#FFFFFF'; ctx.font = 'bold 58px "Arial Black", Impact, sans-serif';
            ctx.textAlign = 'center'; fitText(ctx, 'SLUDGE SODA', 256, 105, 470);
            ctx.fillStyle = '#FFEB3B'; ctx.font = 'bold 22px sans-serif';
            fitText(ctx, 'ORIGINAL QUESTIONABLE TASTE', 256, 150, 470);
            ctx.fillStyle = '#FFFFFF'; ctx.font = 'bold 20px sans-serif';
            fitText(ctx, '2 LITERS OF PURE SLUDGE', 256, 225, 470);

            const labelTex = new THREE.CanvasTexture(canvas);
            const label = new THREE.Mesh(
                new THREE.CylinderGeometry(0.182, 0.182, 0.32, 24, 1, true),
                new THREE.MeshStandardMaterial({ map: labelTex, roughness: 0.3 })
            );
            label.position.y = 0.30;
            label.rotation.y = -Math.PI / 2;

            group.add(body, shoulder, cap, label);
            return group;
        }
    },
    {
        name: "Pasta",
        color: 0xF0E68C,
        size: [0.55, 0.75, 0.32],
        quantity: [1, 2],
        model: function() {
            const group = new THREE.Group();
            const boxMat = new THREE.MeshStandardMaterial({ color: 0x0D47A1, roughness: 0.5 });
            const box = new THREE.Mesh(new THREE.BoxGeometry(0.50, 0.72, 0.28), boxMat);
            box.position.y = 0.36;

            // Italian pasta box printed front with clear cellophane window
            const canvas = document.createElement('canvas');
            canvas.width = 512; canvas.height = 768;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#0D47A1'; ctx.fillRect(0, 0, 512, 768);
            // Italian flag header ribbon
            ctx.fillStyle = '#2E7D32'; ctx.fillRect(0, 0, 170, 24);
            ctx.fillStyle = '#FFFFFF'; ctx.fillRect(170, 0, 172, 24);
            ctx.fillStyle = '#C62828'; ctx.fillRect(342, 0, 170, 24);

            // Gold brand banner
            ctx.fillStyle = '#FFD54F'; ctx.font = 'bold 30px serif';
            ctx.textAlign = 'center'; fitText(ctx, '★ SINCE LAST TUESDAY ★', 256, 80, 470);
            ctx.fillStyle = '#FFFFFF'; ctx.font = 'bold 50px "Arial Black", serif';
            fitText(ctx, 'PASTA OHIOANA', 256, 140, 470);
            ctx.fillStyle = '#FFD54F'; ctx.font = 'bold 28px sans-serif';
            fitText(ctx, 'SPAGHETTI N° 330', 256, 190, 470);

            // Clear window frame
            ctx.fillStyle = '#0A387E'; ctx.fillRect(76, 240, 360, 320);
            ctx.strokeStyle = '#FFD54F'; ctx.lineWidth = 6; ctx.strokeRect(76, 240, 360, 320);

            ctx.fillStyle = '#FFFFFF'; ctx.font = 'bold 24px sans-serif';
            fitText(ctx, '100% MIDWEST WHEAT, PROBABLY', 256, 620, 470);
            ctx.fillStyle = '#FFE082'; ctx.font = 'bold 20px sans-serif';
            fitText(ctx, 'NET WT 16 OZ • COOKS IN 9 TO 45 MIN', 256, 680, 470);

            const boxTex = new THREE.CanvasTexture(canvas);
            const frontFace = new THREE.Mesh(
                new THREE.PlaneGeometry(0.495, 0.715),
                new THREE.MeshBasicMaterial({ map: boxTex })
            );
            frontFace.position.set(0, 0.36, 0.141);

            // Dried golden spaghetti strands visible inside the window
            const noodleMat = new THREE.MeshStandardMaterial({ color: 0xFDD835, roughness: 0.7 });
            const noodleGroup = new THREE.Group();
            for (let i = 0; i < 9; i++) {
                const noodle = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.28, 6), noodleMat);
                noodle.position.set(-0.12 + i * 0.03, 0.35, 0.138);
                noodleGroup.add(noodle);
            }

            group.add(box, frontFace, noodleGroup);
            return group;
        } 
    },
    {
        name: "Pasta Sauce",
        color: 0xB71C1C,
        size: [0.45, 0.70, 0.45],
        quantity: [1, 2],
        model: function() {
            const group = new THREE.Group();
            
            const glassMat = new THREE.MeshStandardMaterial({
                color: 0xE0F7FA,
                roughness: 0.1,
                metalness: 0.15,
                transparent: true,
                opacity: 0.55,
                depthWrite: false
            });
            const sauceMat = new THREE.MeshStandardMaterial({
                color: 0x8B1E0F,
                roughness: 0.85,
                metalness: 0.05
            });
            const lidMat = new THREE.MeshStandardMaterial({
                color: 0xD4AF37,
                roughness: 0.25,
                metalness: 0.85
            });
            const goldMat = new THREE.MeshStandardMaterial({
                color: 0xF59E0B,
                roughness: 0.3,
                metalness: 0.8
            });

            // 1. Rich marinara sauce core inside the jar
            const sauceCore = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.48, 24), sauceMat);
            sauceCore.position.y = 0.26;
            
            // 2. Clear glass outer jar (thick bottom base, cylindrical body, tapered shoulder, threaded neck)
            const jarBase = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.195, 0.04, 24), glassMat);
            jarBase.position.y = 0.02;

            const jarBody = new THREE.Mesh(new THREE.CylinderGeometry(0.195, 0.195, 0.48, 24), glassMat);
            jarBody.position.y = 0.28;

            const jarShoulder = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.195, 0.10, 24), glassMat);
            jarShoulder.position.y = 0.57;

            const jarNeck = new THREE.Mesh(new THREE.CylinderGeometry(0.135, 0.135, 0.08, 24), glassMat);
            jarNeck.position.y = 0.66;

            // 3. Premium metallic twist-off lid with safety pop-button and rim ridges
            const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.145, 0.145, 0.05, 24), lidMat);
            lid.position.y = 0.725;

            const lidButton = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.015, 16), lidMat);
            lidButton.position.y = 0.755;

            const lidRing = new THREE.Mesh(new THREE.TorusGeometry(0.145, 0.008, 8, 24), goldMat);
            lidRing.rotation.x = Math.PI / 2;
            lidRing.position.y = 0.71;

            // 4. Authentic Italian Marinara Label Wrap
            const canvas = document.createElement('canvas');
            canvas.width = 512; canvas.height = 384;
            const ctx = canvas.getContext('2d');
            
            ctx.fillStyle = '#FDF6E2';
            ctx.fillRect(0, 0, 512, 384);
            
            // Italian Tricolor header ribbon
            ctx.fillStyle = '#1B5E20'; ctx.fillRect(0, 0, 170, 16);
            ctx.fillStyle = '#FFFFFF'; ctx.fillRect(170, 0, 172, 16);
            ctx.fillStyle = '#B71C1C'; ctx.fillRect(342, 0, 170, 16);

            // Green ornamental header badge
            ctx.fillStyle = '#2E7D32';
            ctx.fillRect(20, 26, 472, 40);
            ctx.fillStyle = '#FFD54F';
            ctx.font = 'bold 20px Georgia, serif';
            ctx.textAlign = 'center';
            fitText(ctx, '★ FAMILY-ISH RECIPE ★', 256, 52, 460);

            // Bold Marinara Brand Title
            ctx.fillStyle = '#B71C1C';
            ctx.font = '900 42px "Arial Black", Georgia, serif';
            fitText(ctx, "SOME DUDE'S", 256, 115, 460);

            ctx.fillStyle = '#424242';
            ctx.font = 'bold 22px "Trebuchet MS", sans-serif';
            fitText(ctx, 'PASTA SAUCE • AKRON, OHIO', 256, 146, 460);

            // Tomato & Basil illustration
            ctx.fillStyle = '#D32F2F';
            ctx.beginPath(); ctx.arc(225, 215, 36, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.arc(285, 215, 36, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.arc(255, 240, 32, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#388E3C';
            ctx.beginPath(); ctx.ellipse(255, 175, 26, 12, -0.4, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.ellipse(285, 180, 20, 10, 0.5, 0, Math.PI * 2); ctx.fill();

            // Quality callout badges
            ctx.fillStyle = '#B71C1C';
            ctx.font = 'bold 18px sans-serif';
            fitText(ctx, 'SIMMERED IN A GARAGE • BASIL (PROBABLY)', 256, 295, 460);

            ctx.fillStyle = '#2E7D32';
            ctx.font = 'bold 16px sans-serif';
            fitText(ctx, '100% OHIO TOMATOES • WHATEVER OIL HE HAD', 256, 325, 460);

            ctx.fillStyle = '#616161';
            ctx.font = 'bold 14px monospace';
            fitText(ctx, 'NET WT 24 OZ-ISH • HE SAYS HI', 256, 360, 460);

            const labelTex = new THREE.CanvasTexture(canvas);
            const labelMesh = new THREE.Mesh(
                new THREE.CylinderGeometry(0.198, 0.198, 0.36, 24, 1, true, -Math.PI * 0.45, Math.PI * 0.9),
                new THREE.MeshBasicMaterial({ map: labelTex, side: THREE.DoubleSide })
            );
            labelMesh.position.y = 0.28;

            group.add(sauceCore, jarBase, jarBody, jarShoulder, jarNeck, lid, lidButton, lidRing, labelMesh);
            return group;
        } 
    },
    {
        name: "Water bottles",
        color: 0xADD8E6,
        size: [0.4, 0.8, 0.4],
        quantity: [1, 4],
        model: function() {
            const group = new THREE.Group();
            const plasticMat = new THREE.MeshStandardMaterial({ color: 0xbfe4f5, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.55 });
            const capMat = new THREE.MeshStandardMaterial({ color: 0x2266bb, roughness: 0.4 });
            const labelMat = new THREE.MeshStandardMaterial({ color: 0x3888dd, roughness: 0.5 });
            const ridgeMat = new THREE.MeshStandardMaterial({ color: 0xbfe4f5, roughness: 0.3, transparent: true, opacity: 0.5 });

            // Body
            const body = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.16, 0.5, 20), plasticMat);
            body.position.y = -0.08;
            group.add(body);

            // Neck tapering up
            const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.15, 0.11, 20), plasticMat);
            neck.position.y = 0.22;
            group.add(neck);

            // Screw cap
            const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.058, 0.1, 20), capMat);
            cap.position.y = 0.33;
            group.add(cap);

            // Ridges ring on the body
            const ridge = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.012, 8, 22), ridgeMat);
            ridge.position.y = -0.12;
            ridge.rotation.x = Math.PI / 2;
            group.add(ridge);

            // Label band
            const label = new THREE.Mesh(new THREE.CylinderGeometry(0.155, 0.155, 0.24, 20), labelMat);
            label.position.y = 0.0;
            group.add(label);
            return group;
        }
    },
    {
        name: "Sugar",
        color: 0xFFFFFF,
        size: [0.45, 0.7, 0.45],
        quantity: [1, 2],
        model: function() {
            const group = new THREE.Group();
            // Paper sack bag of pure cane sugar
            const bagMat = new THREE.MeshStandardMaterial({ color: 0xFAFAFA, roughness: 0.75 });
            const bag = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.58, 0.38), bagMat);
            bag.position.y = 0.29;

            // Folded top paper flap
            const topFlap = new THREE.Mesh(
                new THREE.BoxGeometry(0.44, 0.08, 0.08),
                new THREE.MeshStandardMaterial({ color: 0x1565C0, roughness: 0.6 })
            );
            topFlap.position.set(0, 0.61, 0);

            // Front Brand Label with Sugar Cane graphic
            const canvas = document.createElement('canvas');
            canvas.width = 512; canvas.height = 512;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, 512, 512);
            ctx.fillStyle = '#1565C0'; ctx.fillRect(16, 16, 480, 100);
            ctx.fillStyle = '#FFFFFF'; ctx.font = 'bold 32px sans-serif';
            ctx.textAlign = 'center'; ctx.fillText('★ 100% NATURAL ★', 256, 50);
            ctx.font = 'bold 44px "Arial Black", sans-serif';
            ctx.fillText('PURE CANE SUGAR', 256, 95);

            // Sugar bowl & crystal icon
            ctx.fillStyle = '#0D47A1'; ctx.beginPath(); ctx.arc(256, 260, 90, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#FFFFFF'; ctx.font = 'bold 36px sans-serif';
            ctx.fillText('GRANULATED', 256, 250);
            ctx.font = 'bold 24px sans-serif';
            ctx.fillText('EXTRA FINE', 256, 290);

            ctx.fillStyle = '#2E7D32'; ctx.font = 'bold 26px sans-serif';
            ctx.fillText('NON-GMO PROJECT VERIFIED', 256, 400);
            ctx.fillStyle = '#333333'; ctx.font = 'bold 22px sans-serif';
            ctx.fillText('NET WT 4 LBS (1.81 kg)', 256, 460);

            const labelTex = new THREE.CanvasTexture(canvas);
            const labelMesh = new THREE.Mesh(
                new THREE.PlaneGeometry(0.41, 0.56),
                new THREE.MeshBasicMaterial({ map: labelTex })
            );
            labelMesh.position.set(0, 0.29, 0.191);

            group.add(bag, topFlap, labelMesh);
            return group;
        }
    },
    {
        name: "Towels",
        color: 0x87CEFA,
        size: [0.60, 0.58, 0.55],
        quantity: [1, 1],
        model: function() {
            return createRuntimeTowelModel();
        }
    },
    {
        name: "Peanut Butter",
        color: 0xA0522D,
        size: [0.45, 0.7, 0.45],
        quantity: [1, 1],
        model: function() {
            const group = new THREE.Group();
            // Golden Roasted Peanut Butter Jar
            const pbMat = new THREE.MeshStandardMaterial({ color: 0xC68A4C, roughness: 0.4, metalness: 0.05 });
            const jar = new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.20, 0.46, 24), pbMat);
            jar.position.y = 0.23;

            // Red Ribbed Screw Lid
            const lidMat = new THREE.MeshStandardMaterial({ color: 0xC62828, roughness: 0.35 });
            const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.21, 0.08, 24), lidMat);
            lid.position.y = 0.50;

            // Brand Label
            const canvas = document.createElement('canvas');
            canvas.width = 512; canvas.height = 256;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#0D47A1'; ctx.fillRect(0, 0, 512, 256);
            ctx.fillStyle = '#FFF8E1'; ctx.beginPath(); ctx.ellipse(256, 128, 190, 105, 0, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = '#D4AF37'; ctx.lineWidth = 6; ctx.stroke();
            // Header & text
            ctx.fillStyle = '#E65100'; ctx.font = 'bold 20px sans-serif';
            ctx.textAlign = 'center'; ctx.fillText('★ 100% UNWASHED ★', 256, 55);
            ctx.fillStyle = '#C62828'; ctx.font = 'bold 38px "Arial Black", sans-serif';
            ctx.fillText('WATERY', 256, 100);
            ctx.fillStyle = '#0D47A1'; ctx.font = 'bold 44px "Arial Black", sans-serif';
            fitText(ctx, 'PEANUT BUTTER', 256, 145, 470);
            ctx.fillStyle = '#5D4037'; ctx.font = 'bold 18px sans-serif';
            fitText(ctx, 'NOW 40% WATER • NET WT 16 FL OZ', 256, 215, 470);

            const labelTex = new THREE.CanvasTexture(canvas);
            const label = new THREE.Mesh(
                new THREE.CylinderGeometry(0.202, 0.202, 0.34, 24, 1, true),
                new THREE.MeshStandardMaterial({ map: labelTex, roughness: 0.35 })
            );
            label.position.y = 0.23;
            label.rotation.y = -Math.PI / 2;

            group.add(jar, lid, label);
            return group;
        }
    },
    {
        name: "Steak",
        color: 0x8B0000, 
        size: [0.6, 0.2, 0.5],
        quantity: [1, 2],
        model: function() {
            return createRuntimeSteakModel();
        }
    },
    {
        name: "Chicken",
        color: 0xCD853F, 
        size: [0.65, 0.35, 0.5],
        quantity: [1, 3],
        model: function() {
            const group = new THREE.Group();
            // Black butcher styrofoam meat tray
            const trayMat = new THREE.MeshStandardMaterial({ color: 0x1E2228, roughness: 0.6 });
            const tray = new THREE.Mesh(cachedItemAsset('chickenTrayGeo', () => new THREE.BoxGeometry(0.62, 0.04, 0.46)), trayMat);
            tray.position.y = 0.02;

            // Golden Seasoned Whole Roast Chicken Body
            const roastMat = new THREE.MeshStandardMaterial({ color: 0xD78B38, roughness: 0.65, metalness: 0.05 });
            const chickenBody = new THREE.Mesh(cachedItemAsset('chickenBodyGeo', () => new THREE.SphereGeometry(0.18, 16, 12)), roastMat);
            chickenBody.scale.set(1.3, 0.72, 1.0);
            chickenBody.position.set(-0.025, 0.172, 0);

            // Drumstick legs with white bone tips
            const boneMat = new THREE.MeshStandardMaterial({ color: 0xFFFDF0, roughness: 0.4 });
            // Both legs point toward +X, the tray's short edge; thin ends meet the bones.
            [-0.11, 0.11].forEach((lz) => {
                const leg = new THREE.Mesh(cachedItemAsset('chickenLegGeo', () => new THREE.CylinderGeometry(0.045, 0.028, 0.18, 10)), roastMat);
                leg.position.set(0.18, 0.10, lz);
                leg.rotation.z = Math.PI / 2;

                const bone = new THREE.Mesh(cachedItemAsset('chickenBoneGeo', () => new THREE.SphereGeometry(0.022, 8, 6)), boneMat);
                bone.position.set(0.275, 0.10, lz);
                group.add(leg, bone);
            });

            // Wings
            [-0.16, 0.16].forEach((wz) => {
                const wing = new THREE.Mesh(cachedItemAsset('chickenWingGeo', () => new THREE.BoxGeometry(0.16, 0.08, 0.06)), roastMat);
                wing.position.set(-0.06, 0.12, wz);
                wing.rotation.y = wz > 0 ? -0.3 : 0.3;
                group.add(wing);
            });

            // Yellow USDA butcher price & inspection label
            const canvas = document.createElement('canvas');
            canvas.width = 256; canvas.height = 160;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#FFF9C4'; ctx.fillRect(0, 0, 256, 160);
            ctx.strokeStyle = '#FBC02D'; ctx.lineWidth = 6; ctx.strokeRect(4, 4, 248, 152);
            ctx.fillStyle = '#C62828'; ctx.font = 'bold 20px sans-serif';
            ctx.textAlign = 'center'; ctx.fillText('FRESH POULTRY', 128, 35);
            ctx.fillStyle = '#212121'; ctx.font = 'bold 24px "Arial Black", sans-serif';
            ctx.fillText('WHOLE CHICKEN', 128, 75);
            ctx.fillStyle = '#2E7D32'; ctx.font = 'bold 16px sans-serif';
            ctx.fillText('ALL NATURAL • USDA INSPECTED', 128, 115);
            ctx.fillStyle = '#333333'; ctx.font = 'bold 18px monospace';
            ctx.fillText('$8.99 / EA', 128, 145);

            const labelTex = new THREE.CanvasTexture(canvas);
            const butcherLabel = new THREE.Mesh(cachedItemAsset('chickenLabelGeo', () => new THREE.PlaneGeometry(0.24, 0.15)), new THREE.MeshBasicMaterial({ map: labelTex }));
            butcherLabel.rotation.x = -Math.PI / 2;
            butcherLabel.position.set(-0.14, 0.332, -0.10);

            // Clear shrink wrap shell
            const wrapMat = new THREE.MeshStandardMaterial({ color: 0xFFFFFF, transparent: true, opacity: 0.18, roughness: 0.1, depthWrite: false });
            const wrap = new THREE.Mesh(cachedItemAsset('chickenWrapGeo', () => {
                const geometry = new THREE.BoxGeometry(0.64, 0.29, 0.48);
                // BoxGeometry face order: +X, -X, +Y, -Y, +Z, -Z. Omit the hidden bottom.
                const indices = Array.from(geometry.index.array);
                indices.splice(18, 6);
                geometry.setIndex(indices);
                geometry.clearGroups();
                return geometry;
            }), wrapMat);
            // Shell starts above the tray and leaves headroom above the roast.
            wrap.position.y = 0.185;

            group.add(tray, chickenBody, butcherLabel, wrap);
            return group;
        }
    },
    {
        name: "Potatoes",
        color: 0xD2B48C, 
        size: [0.75, 0.55, 0.75],
        quantity: [1, 4],
        model: buildPotatoBagModel
    },
    {
        name: "Canned Goods",
        color: 0xC0C0C0, 
        size: [0.3, 0.5, 0.3],
        quantity: [2, 4],
        model: function() {
            const group = new THREE.Group();
            const metalMat = new THREE.MeshStandardMaterial({ color: 0xcfd2d6, roughness: 0.3, metalness: 0.7 });
            const labelMat = new THREE.MeshStandardMaterial({ color: 0xbf2222, roughness: 0.5, metalness: 0.05 });
            const lidMat = new THREE.MeshStandardMaterial({ color: 0xb9bec6, roughness: 0.3, metalness: 0.8 });

            // Can body
            group.add(new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.5, 20), metalMat));

            // Printed label band (larger radius than the body so it never z-fights)
            const label = new THREE.Mesh(new THREE.CylinderGeometry(0.154, 0.154, 0.36, 20), labelMat);
            group.add(label);

            // Ribbed rings near the top and bottom
            const ribGeo = new THREE.TorusGeometry(0.15, 0.012, 8, 24);
            const ribTop = new THREE.Mesh(ribGeo, lidMat);
            ribTop.position.y = 0.21;
            ribTop.rotation.x = Math.PI / 2;
            group.add(ribTop);
            const ribBottom = new THREE.Mesh(ribGeo, lidMat);
            ribBottom.position.y = -0.21;
            ribBottom.rotation.x = Math.PI / 2;
            group.add(ribBottom);

            // Top and bottom lids
            const lidGeo = new THREE.CylinderGeometry(0.145, 0.145, 0.02, 20);
            const lidTop = new THREE.Mesh(lidGeo, lidMat);
            lidTop.position.y = 0.25;
            group.add(lidTop);
            const lidBottom = new THREE.Mesh(lidGeo, lidMat);
            lidBottom.position.y = -0.25;
            group.add(lidBottom);

            // Pull-tab ring on the top lid
            const tab = new THREE.Mesh(new THREE.TorusGeometry(0.04, 0.008, 8, 16), lidMat);
            tab.position.set(0.04, 0.27, 0);
            tab.rotation.x = Math.PI / 2;
            group.add(tab);

            return group;
        }
    }
];

// Alternate batch of items (used exclusively when selected for a game)
const ALT_ITEMS = [
    {
        name: "Toilet paper",
        color: 0xF5F5F5,
        size: [0.6, 0.6, 0.6],
        quantity: [1, 4],
        model: function() {
            const g = new THREE.Group();
            // Roll
            const roll = new THREE.Mesh(
                new THREE.CylinderGeometry(0.3, 0.3, 0.5, 24),
                new THREE.MeshStandardMaterial({ color: 0xF5F5F5, roughness: 0.8 })
            );
            roll.rotation.z = Math.PI / 2;
            // Inner cardboard tube
            const tube = new THREE.Mesh(
                new THREE.CylinderGeometry(0.08, 0.08, 0.52, 16),
                new THREE.MeshStandardMaterial({ color: 0xC4A484, roughness: 0.7 })
            );
            tube.rotation.z = Math.PI / 2;
            g.add(roll, tube);
            return g;
        }
    },
    {
        name: "Ice Cream",
        color: 0xF7D9C4,
        size: [0.4, 0.85, 0.4],
        quantity: [1, 2],
        model: function() {
            const g = new THREE.Group();
            // Acrylic counter stand so cone stands upright on freezer shelf
            const stand = new THREE.Mesh(
                new THREE.CylinderGeometry(0.14, 0.16, 0.03, 16),
                new THREE.MeshStandardMaterial({ color: 0xDDDDDD, roughness: 0.3, metalness: 0.3 })
            );
            stand.position.y = 0.015;

            // Waffle Cone (pointy end down, wide open mouth facing UP)
            const coneMat = new THREE.MeshStandardMaterial({ color: 0xD2A679, roughness: 0.75 });
            const cone = new THREE.Mesh(
                new THREE.ConeGeometry(0.18, 0.48, 16),
                coneMat
            );
            cone.rotation.x = Math.PI; // Pointy tip at bottom, open scoop base at top
            cone.position.y = 0.27;

            // Cone upper waffle rim
            const rim = new THREE.Mesh(
                new THREE.CylinderGeometry(0.185, 0.175, 0.04, 16),
                new THREE.MeshStandardMaterial({ color: 0xC49260, roughness: 0.7 })
            );
            rim.position.y = 0.50;

            // Ice Cream Scoop sitting inside the open cone
            const scoop = new THREE.Mesh(
                new THREE.SphereGeometry(0.20, 18, 18),
                new THREE.MeshStandardMaterial({ color: 0xF7D9C4, roughness: 0.6 })
            );
            scoop.position.y = 0.62;

            // Cherry on top
            const cherry = new THREE.Mesh(
                new THREE.SphereGeometry(0.04, 12, 12),
                new THREE.MeshStandardMaterial({ color: 0xC62828, roughness: 0.25 })
            );
            cherry.position.y = 0.81;

            g.add(stand, cone, rim, scoop, cherry);
            return g;
        }
    },
    {
        name: "Shampoo",
        color: 0x4A90E2,
        size: [0.4, 0.9, 0.4],
        quantity: [1, 2],
        model: function() {
            const g = new THREE.Group();
            const bottle = new THREE.Mesh(
                new THREE.CylinderGeometry(0.18, 0.2, 0.8, 18),
                new THREE.MeshStandardMaterial({ color: 0x4A90E2 })
            );
            const cap = new THREE.Mesh(
                new THREE.BoxGeometry(0.2, 0.1, 0.2),
                new THREE.MeshStandardMaterial({ color: 0x222222 })
            );
            bottle.position.y = 0.4;
            cap.position.y = 0.85;
            g.add(bottle, cap);
            return g;
        }
    },
    {
        name: "Orange Juice",
        color: 0xFFA726,
        size: [0.4, 0.9, 0.4],
        quantity: [1, 2],
        model: function() {
            const g = new THREE.Group();
            // Gable carton body
            const cartonMat = new THREE.MeshStandardMaterial({ color: 0xF57C00, roughness: 0.35 });
            const carton = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.72, 0.38), cartonMat);
            carton.position.y = 0.36;

            // Gable sloped roof
            const roofMat = new THREE.MeshStandardMaterial({ color: 0xFF9800, roughness: 0.35 });
            const roofLeft = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.02, 0.38), roofMat);
            roofLeft.position.set(-0.09, 0.79, 0);
            roofLeft.rotation.z = Math.PI / 4;

            const roofRight = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.02, 0.38), roofMat);
            roofRight.position.set(0.09, 0.79, 0);
            roofRight.rotation.z = -Math.PI / 4;

            const roofPeak = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.06, 0.38), roofMat);
            roofPeak.position.set(0, 0.88, 0);

            // Plastic screw cap on sloped roof
            const cap = new THREE.Mesh(
                new THREE.CylinderGeometry(0.045, 0.045, 0.03, 16),
                new THREE.MeshStandardMaterial({ color: 0xFFFFFF, roughness: 0.2 })
            );
            cap.position.set(0.08, 0.81, 0.06);
            cap.rotation.z = -Math.PI / 4;

            // Brand Label on front face
            const canvas = document.createElement('canvas');
            canvas.width = 512; canvas.height = 512;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#FF9800'; ctx.fillRect(0, 0, 512, 512);
            ctx.fillStyle = '#FFF3E0'; ctx.fillRect(16, 16, 480, 480);
            ctx.fillStyle = '#E65100'; ctx.fillRect(24, 24, 464, 110);
            // Title
            ctx.fillStyle = '#FFFFFF'; ctx.font = 'bold 36px "Arial", sans-serif';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            fitText(ctx, '100% PURE-ISH', 256, 55, 450);
            ctx.font = 'bold 44px "Arial Black", sans-serif';
            fitText(ctx, 'ONARGE JUICE', 256, 100, 450);
            // Big juicy orange graphic
            ctx.fillStyle = '#FB8C00'; ctx.beginPath(); ctx.arc(256, 280, 110, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 8; ctx.stroke();
            // Orange segments
            ctx.fillStyle = '#FFE082';
            for (let a = 0; a < 8; a++) {
                ctx.beginPath();
                ctx.moveTo(256, 280);
                ctx.arc(256, 280, 95, a * Math.PI / 4 + 0.08, (a + 1) * Math.PI / 4 - 0.08);
                ctx.closePath();
                ctx.fill();
            }
            // Green leaf
            ctx.fillStyle = '#2E7D32';
            ctx.beginPath();
            ctx.ellipse(220, 160, 40, 20, -Math.PI / 4, 0, Math.PI * 2);
            ctx.fill();
            // Subtext
            ctx.fillStyle = '#E65100'; ctx.font = 'bold 26px sans-serif';
            fitText(ctx, 'NO SPELLCHECK ADDED • VITAMIN SEE', 256, 430, 450);
            ctx.fillStyle = '#5D4037'; ctx.font = 'bold 20px sans-serif';
            fitText(ctx, 'FROM CONSENTRATE • 59 FL OZ', 256, 470, 450);

            const labelTex = new THREE.CanvasTexture(canvas);
            const labelMesh = new THREE.Mesh(
                new THREE.PlaneGeometry(0.375, 0.68),
                new THREE.MeshBasicMaterial({ map: labelTex })
            );
            labelMesh.position.set(0, 0.36, 0.191);

            g.add(carton, roofLeft, roofRight, roofPeak, cap, labelMesh);
            return g;
        }
    },
    {
        name: "Lettuce",
        color: 0x7CB342,
        size: [0.55, 0.45, 0.55],
        quantity: [1, 2],
        model: function() {
            const g = new THREE.Group();
            // Compact core base
            const coreMat = new THREE.MeshStandardMaterial({ color: 0xDCEDC8, roughness: 0.8 });
            const core = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.06, 0.12, 12), coreMat);
            core.position.y = 0.06;
            g.add(core);

            // Dense inner head
            const innerMat = new THREE.MeshStandardMaterial({ color: 0x9CCC65, roughness: 0.85 });
            const innerHead = new THREE.Mesh(new THREE.SphereGeometry(0.18, 14, 14), innerMat);
            innerHead.position.y = 0.18;
            g.add(innerHead);

            // Multiple overlapping ruffled outer leaf layers
            const leafColors = [0x7CB342, 0x689F38, 0x558B2F, 0x8BC34A];
            for (let layer = 0; layer < 3; layer++) {
                const count = 5 + layer * 2;
                const radius = 0.16 + layer * 0.05;
                const leafMat = new THREE.MeshStandardMaterial({
                    color: leafColors[layer % leafColors.length],
                    roughness: 0.85,
                    side: THREE.DoubleSide
                });
                for (let i = 0; i < count; i++) {
                    const angle = (i / count) * Math.PI * 2 + layer * 0.4;
                    const leaf = new THREE.Mesh(
                        new THREE.SphereGeometry(0.13 + layer * 0.02, 10, 8, 0, Math.PI, 0, Math.PI * 0.75),
                        leafMat
                    );
                    leaf.scale.set(1.1, 0.8, 1.3);
                    leaf.rotation.x = Math.PI / 4 + layer * 0.15;
                    leaf.rotation.y = angle;
                    leaf.position.set(
                        Math.cos(angle) * radius,
                        0.14 + layer * 0.04,
                        Math.sin(angle) * radius
                    );
                    g.add(leaf);
                }
            }
            return g;
        }
    },
    {
        name: "Grapes",
        color: 0x7E57C2,
        size: [0.5, 0.5, 0.5],
        quantity: [1, 2],
        model: function() {
            const g = new THREE.Group();
            // Woody vine stem on top
            const stemMat = new THREE.MeshStandardMaterial({ color: 0x5D4037, roughness: 0.9 });
            const mainStem = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.008, 0.32, 8), stemMat);
            mainStem.position.set(0, 0.32, 0);
            mainStem.rotation.z = -0.2;

            const hookStem = new THREE.Mesh(new THREE.TorusGeometry(0.04, 0.008, 6, 12, Math.PI), stemMat);
            hookStem.position.set(-0.04, 0.46, 0);
            hookStem.rotation.z = Math.PI / 4;

            // 2 Green grape leaves
            const leafMat = new THREE.MeshStandardMaterial({ color: 0x388E3C, roughness: 0.6, side: THREE.DoubleSide });
            const leaf1 = new THREE.Mesh(new THREE.CircleGeometry(0.09, 6), leafMat);
            leaf1.position.set(-0.06, 0.36, 0.04);
            leaf1.rotation.set(-0.5, -0.3, 0.4);

            const leaf2 = new THREE.Mesh(new THREE.CircleGeometry(0.08, 6), leafMat);
            leaf2.position.set(0.06, 0.35, -0.04);
            leaf2.rotation.set(0.4, 0.5, -0.3);

            g.add(mainStem, hookStem, leaf1, leaf2);

            // Clustered glossy grapes in realistic tapered conical layers
            const grapeMat = new THREE.MeshStandardMaterial({
                color: 0x5E1A5E,
                roughness: 0.25,
                metalness: 0.08
            });

            // Layered grape positions [x, y, z, r]
            const grapeDefs = [
                // Top wide layer (y: 0.26 - 0.30)
                [-0.10, 0.28, 0.00, 0.052], [0.10, 0.28, 0.00, 0.052], [0.00, 0.28, -0.10, 0.052], [0.00, 0.28, 0.10, 0.052],
                [-0.07, 0.27, 0.07, 0.050], [0.07, 0.27, 0.07, 0.050], [-0.07, 0.27, -0.07, 0.050], [0.07, 0.27, -0.07, 0.050],
                // Upper-mid layer (y: 0.20 - 0.24)
                [-0.08, 0.21, 0.04, 0.050], [0.08, 0.21, 0.04, 0.050], [-0.04, 0.21, -0.08, 0.050], [0.04, 0.21, -0.08, 0.050],
                [0.00, 0.20, 0.08, 0.048], [-0.07, 0.20, -0.04, 0.048], [0.07, 0.20, -0.04, 0.048],
                // Mid layer (y: 0.14 - 0.17)
                [-0.06, 0.15, 0.02, 0.048], [0.06, 0.15, 0.02, 0.048], [0.00, 0.15, -0.06, 0.048],
                [-0.03, 0.14, 0.05, 0.046], [0.03, 0.14, 0.05, 0.046], [0.00, 0.14, 0.00, 0.048],
                // Lower layer (y: 0.08 - 0.11)
                [-0.03, 0.09, 0.02, 0.045], [0.03, 0.09, 0.02, 0.045], [0.00, 0.09, -0.03, 0.045],
                // Bottom tip (y: 0.03 - 0.06)
                [-0.015, 0.04, 0.01, 0.042], [0.015, 0.04, 0.01, 0.042], [0.00, 0.02, -0.01, 0.038]
            ];

            grapeDefs.forEach(([gx, gy, gz, gr]) => {
                const grape = new THREE.Mesh(new THREE.SphereGeometry(gr, 12, 12), grapeMat);
                grape.position.set(gx, gy, gz);
                g.add(grape);
            });

            return g;
        }
    },
    {
        name: "Cooking oil",
        color: 0xFFD54F,
        size: [0.4, 0.9, 0.4],
        quantity: [1, 2],
        model: function() {
            const g = new THREE.Group();
            const bottle = new THREE.Mesh(
                new THREE.CylinderGeometry(0.16, 0.18, 0.8, 16),
                new THREE.MeshStandardMaterial({ color: 0xFFD54F, transparent: true, opacity: 0.85 })
            );
            const cap = new THREE.Mesh(
                new THREE.CylinderGeometry(0.09, 0.09, 0.1, 12),
                new THREE.MeshStandardMaterial({ color: 0x555555 })
            );
            bottle.position.y = 0.4;
            cap.position.y = 0.85;
            g.add(bottle, cap);
            return g;
        }
    },
    {
        name: "Pizza",
        color: 0xFBC02D,
        size: [0.75, 0.22, 0.75],
        quantity: [1, 2],
        model: function() {
            const g = new THREE.Group();
            // Corrugated kraft delivery pizza box base
            const boxMat = new THREE.MeshStandardMaterial({ color: 0xD7CCC8, roughness: 0.85 });
            const boxBottom = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.06, 0.72), boxMat);
            boxBottom.position.y = 0.03;

            // Box lid angled open to show hot fresh pizza inside
            const lidGroup = new THREE.Group();
            const boxLid = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.02, 0.72), boxMat);
            boxLid.position.set(0, 0, 0.36);

            // Printed Pizzeria graphic on box lid
            const canvas = document.createElement('canvas');
            canvas.width = 512; canvas.height = 512;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#EFEBE9'; ctx.fillRect(0, 0, 512, 512);
            // Red & White checkered border
            ctx.fillStyle = '#C62828';
            for (let i = 0; i < 512; i += 32) {
                ctx.fillRect(i, 0, 16, 24); ctx.fillRect(i, 488, 16, 24);
                ctx.fillRect(0, i, 24, 16); ctx.fillRect(488, i, 24, 16);
            }
            ctx.fillStyle = '#C62828'; ctx.font = 'bold 36px "Arial", sans-serif';
            ctx.textAlign = 'center'; ctx.fillText('★ PIZZERIA BELLA ★', 256, 90);
            ctx.fillStyle = '#2E7D32'; ctx.font = 'bold 48px "Arial Black", sans-serif';
            ctx.fillText('HOT & FRESH PIZZA', 256, 160);
            ctx.fillStyle = '#D84315'; ctx.font = 'bold 24px sans-serif';
            ctx.fillText('STONE OVEN BAKED • 100% MOZZARELLA', 256, 440);

            const lidTex = new THREE.CanvasTexture(canvas);
            const lidLabel = new THREE.Mesh(new THREE.PlaneGeometry(0.68, 0.68), new THREE.MeshBasicMaterial({ map: lidTex }));
            lidLabel.rotation.x = -Math.PI / 2;
            lidLabel.position.set(0, 0.012, 0.36);
            lidGroup.add(boxLid, lidLabel);
            lidGroup.position.set(0, 0.06, -0.36);
            lidGroup.rotation.x = -0.32; // Prop lid open

            // Fresh Baked Pizza with crust & toppings inside
            const crustMat = new THREE.MeshStandardMaterial({ color: 0xD7A15C, roughness: 0.75 });
            const crustRim = new THREE.Mesh(new THREE.TorusGeometry(0.29, 0.035, 12, 32), crustMat);
            crustRim.rotation.x = Math.PI / 2;
            crustRim.position.y = 0.065;

            // Tomato Sauce & Melted Mozzarella
            const cheeseMat = new THREE.MeshStandardMaterial({ color: 0xFFF176, roughness: 0.6 });
            const cheeseDisc = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.015, 32), cheeseMat);
            cheeseDisc.position.y = 0.055;

            // Procedural Pizza Toppings: Pepperoni, Bell Peppers, Mushrooms, Olives
            const pepperoniMat = new THREE.MeshStandardMaterial({ color: 0xB71C1C, roughness: 0.5 });
            const pepperMat = new THREE.MeshStandardMaterial({ color: 0x388E3C, roughness: 0.4 });
            const oliveMat = new THREE.MeshStandardMaterial({ color: 0x212121, roughness: 0.3 });
            const mushroomMat = new THREE.MeshStandardMaterial({ color: 0xD7CCC8, roughness: 0.7 });

            const toppingsGroup = new THREE.Group();
            // 7 Pepperonis
            const pepPositions = [[0,0], [0.14, 0.1], [-0.15, 0.08], [0.08, -0.16], [-0.1, -0.14], [0.18, -0.05], [-0.04, 0.18]];
            pepPositions.forEach(([px, pz]) => {
                const pep = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.048, 0.008, 16), pepperoniMat);
                pep.position.set(px, 0.066, pz);
                toppingsGroup.add(pep);
            });
            // Green bell pepper slivers
            for (let i = 0; i < 8; i++) {
                const angle = (i / 8) * Math.PI * 2 + 0.2;
                const r = 0.09 + (i % 3) * 0.06;
                const pepper = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.008, 0.015), pepperMat);
                pepper.position.set(Math.cos(angle) * r, 0.068, Math.sin(angle) * r);
                pepper.rotation.y = angle + 0.5;
                toppingsGroup.add(pepper);
            }
            // Sliced mushrooms & olives
            for (let i = 0; i < 6; i++) {
                const angle = (i / 6) * Math.PI * 2 + 0.4;
                const r = 0.13 + (i % 2) * 0.08;
                const olive = new THREE.Mesh(new THREE.TorusGeometry(0.02, 0.007, 8, 12), oliveMat);
                olive.rotation.x = Math.PI / 2;
                olive.position.set(Math.cos(angle) * r, 0.068, Math.sin(angle) * r);

                const shroom = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 8, 0, Math.PI * 2, 0, Math.PI / 2), mushroomMat);
                shroom.position.set(Math.cos(angle + 0.3) * (r - 0.04), 0.067, Math.sin(angle + 0.3) * (r - 0.04));
                toppingsGroup.add(olive, shroom);
            }

            g.add(boxBottom, lidGroup, crustRim, cheeseDisc, toppingsGroup);
            return g;
        }
    },
    {
        name: "Ketchup",
        color: 0xC62828,
        size: [0.4, 0.85, 0.4],
        quantity: [1, 2],
        model: function() {
            const g = new THREE.Group();
            const bottleMat = new THREE.MeshStandardMaterial({ color: 0xB71C1C, roughness: 0.3, metalness: 0.08 });
            // Contoured squeeze bottle
            const body = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.52, 24), bottleMat);
            body.position.y = 0.30;
            const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.18, 0.18, 24), bottleMat);
            neck.position.y = 0.64;
            // White flip-top cap
            const cap = new THREE.Mesh(
                new THREE.CylinderGeometry(0.09, 0.09, 0.10, 16),
                new THREE.MeshStandardMaterial({ color: 0xF5F5F5, roughness: 0.2 })
            );
            cap.position.y = 0.78;

            // Seamless cylindrical Brand Label
            const canvas = document.createElement('canvas');
            canvas.width = 512; canvas.height = 256;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#B71C1C'; ctx.fillRect(0, 0, 512, 256);
            ctx.fillStyle = '#FFF8E1'; ctx.beginPath(); ctx.ellipse(256, 128, 190, 105, 0, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = '#D4AF37'; ctx.lineWidth = 6; ctx.stroke();
            // Label header & title
            ctx.fillStyle = '#1B5E20'; ctx.font = 'bold 18px sans-serif';
            ctx.textAlign = 'center'; fitText(ctx, '★ ONE VARIETY ★', 256, 50, 470);
            ctx.fillStyle = '#B71C1C'; ctx.font = 'bold 38px "Arial Black", sans-serif';
            ctx.fillText('RED', 256, 92);
            fitText(ctx, 'MUSTARD', 256, 130, 470);
            // Tomato icon
            ctx.fillStyle = '#D32F2F'; ctx.beginPath(); ctx.arc(256, 178, 28, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#2E7D32'; ctx.beginPath(); ctx.ellipse(256, 152, 10, 6, 0, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#333333'; ctx.font = 'bold 16px sans-serif';
            fitText(ctx, 'DEFINITELY NOT KETCHUP • NET WT 20 OZ', 256, 218, 470);

            const labelTex = new THREE.CanvasTexture(canvas);
            const labelMesh = new THREE.Mesh(
                new THREE.CylinderGeometry(0.182, 0.182, 0.32, 24, 1, true),
                new THREE.MeshStandardMaterial({ map: labelTex, roughness: 0.35 })
            );
            labelMesh.position.y = 0.30;
            labelMesh.rotation.y = -Math.PI / 2;

            g.add(body, neck, cap, labelMesh);
            return g;
        }
    },
    {
        name: "Mustard",
        color: 0xFBC02D,
        size: [0.4, 0.85, 0.4],
        quantity: [1, 2],
        model: function() {
            const g = new THREE.Group();
            const bottleMat = new THREE.MeshStandardMaterial({ color: 0xFBC02D, roughness: 0.35, metalness: 0.08 });
            // Contoured squeeze bottle
            const body = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.52, 24), bottleMat);
            body.position.y = 0.30;
            const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.18, 0.18, 24), bottleMat);
            neck.position.y = 0.64;
            // Pointed yellow squeeze nozzle cap
            const capBase = new THREE.Mesh(
                new THREE.CylinderGeometry(0.09, 0.09, 0.06, 16),
                new THREE.MeshStandardMaterial({ color: 0xFDD835, roughness: 0.25 })
            );
            capBase.position.y = 0.76;
            const capTip = new THREE.Mesh(
                new THREE.ConeGeometry(0.05, 0.12, 16),
                new THREE.MeshStandardMaterial({ color: 0xFDD835, roughness: 0.25 })
            );
            capTip.position.y = 0.85;

            // Seamless cylindrical Brand Label
            const canvas = document.createElement('canvas');
            canvas.width = 512; canvas.height = 256;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#FBC02D'; ctx.fillRect(0, 0, 512, 256);
            ctx.fillStyle = '#0D47A1'; ctx.beginPath(); ctx.ellipse(256, 128, 190, 105, 0, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 6; ctx.stroke();
            ctx.fillStyle = '#FFFDE7'; ctx.fillRect(80, 55, 352, 140);
            ctx.fillStyle = '#B71C1C'; ctx.font = 'bold 18px sans-serif';
            ctx.textAlign = 'center'; fitText(ctx, '★ 100% YELLOW TOMATOES ★', 256, 75, 470);
            ctx.fillStyle = '#0D47A1'; ctx.font = 'bold 32px "Arial Black", sans-serif';
            fitText(ctx, 'YELLOW', 256, 115, 470);
            ctx.fillStyle = '#F57F17'; ctx.font = 'bold 42px "Arial Black", sans-serif';
            fitText(ctx, 'KETCHUP', 256, 155, 470);
            ctx.fillStyle = '#333333'; ctx.font = 'bold 16px sans-serif';
            fitText(ctx, 'DEFINITELY NOT MUSTARD • NET WT 14 OZ', 256, 185, 470);

            const labelTex = new THREE.CanvasTexture(canvas);
            const labelMesh = new THREE.Mesh(
                new THREE.CylinderGeometry(0.182, 0.182, 0.32, 24, 1, true),
                new THREE.MeshStandardMaterial({ map: labelTex, roughness: 0.35 })
            );
            labelMesh.position.y = 0.30;
            labelMesh.rotation.y = -Math.PI / 2;

            g.add(body, neck, capBase, capTip, labelMesh);
            return g;
        }
    },
    {
        name: "Batteries",
        color: 0x616161,
        size: [0.5, 0.4, 0.5],
        quantity: [2, 4],
        model: function() {
            const g = new THREE.Group();
            // Blister Card Backing with retail branding
            const cardGeo = new THREE.BoxGeometry(0.48, 0.44, 0.015);
            const canvas = document.createElement('canvas');
            canvas.width = 512; canvas.height = 512;
            const ctx = canvas.getContext('2d');
            // Navy / Gold gradient
            const grad = ctx.createLinearGradient(0, 0, 0, 512);
            grad.addColorStop(0, '#0D1B2A'); grad.addColorStop(0.4, '#1B263B'); grad.addColorStop(1, '#0D1B2A');
            ctx.fillStyle = grad; ctx.fillRect(0, 0, 512, 512);
            // Header
            ctx.fillStyle = '#FFD700'; ctx.font = 'bold 42px "Arial Black", sans-serif';
            ctx.textAlign = 'center'; ctx.fillText('⚡ POWERMAX', 256, 65);
            ctx.fillStyle = '#E0E1DD'; ctx.font = 'bold 26px sans-serif';
            ctx.fillText('ALKALINE AA • 4-PACK', 256, 115);
            ctx.fillStyle = '#415A77'; ctx.fillRect(20, 440, 472, 50);
            ctx.fillStyle = '#FFD700'; ctx.font = 'bold 24px sans-serif';
            ctx.fillText('10 YEAR SHELF LIFE • 1.5V', 256, 475);

            const cardTex = new THREE.CanvasTexture(canvas);
            const card = new THREE.Mesh(cardGeo, new THREE.MeshStandardMaterial({ map: cardTex, roughness: 0.6 }));
            card.position.set(0, 0.22, 0);

            // 4 Detailed AA Battery Cells
            const copperMat = new THREE.MeshStandardMaterial({ color: 0xD4AF37, metalness: 0.85, roughness: 0.25 });
            const darkBodyMat = new THREE.MeshStandardMaterial({ color: 0x1E272C, metalness: 0.4, roughness: 0.3 });
            const silverMat = new THREE.MeshStandardMaterial({ color: 0xCCCCCC, metalness: 0.9, roughness: 0.2 });

            const cellOffsets = [-0.15, -0.05, 0.05, 0.15];
            cellOffsets.forEach(cx => {
                const cellGroup = new THREE.Group();
                // Main dark body
                const body = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.16, 16), darkBodyMat);
                body.position.y = 0.13;
                // Copper/Gold top band
                const topBand = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.06, 16), copperMat);
                topBand.position.y = 0.24;
                // Positive terminal pip (+)
                const pip = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.02, 12), silverMat);
                pip.position.y = 0.28;
                // Negative terminal base (-)
                const base = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.01, 16), silverMat);
                base.position.y = 0.045;

                cellGroup.add(body, topBand, pip, base);
                cellGroup.position.set(cx, 0.02, 0.05);
                g.add(cellGroup);
            });

            // Transparent blister bubble
            const blisterMat = new THREE.MeshPhysicalMaterial({ color: 0xFFFFFF, transparent: true, opacity: 0.35, roughness: 0.1 });
            const blister = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.28, 0.08), blisterMat);
            blister.position.set(0, 0.18, 0.05);

            g.add(card, blister);
            return g;
        }
    },
    {
        name: "Dog food",
        color: 0x8D6E63,
        size: [0.55, 0.95, 0.35],
        quantity: [1, 2],
        model: function() {
            const g = new THREE.Group();
            // Main bag body with pinched top
            const bagMat = new THREE.MeshStandardMaterial({ color: 0xB71C1C, roughness: 0.6 });
            const bag = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.78, 0.32), bagMat);
            bag.position.y = 0.39;

            // Pinched top seal seam
            const topSeam = new THREE.Mesh(
                new THREE.BoxGeometry(0.52, 0.08, 0.04),
                new THREE.MeshStandardMaterial({ color: 0x8E0000, roughness: 0.7 })
            );
            topSeam.position.set(0, 0.82, 0);

            // Detailed printed label on front
            const canvas = document.createElement('canvas');
            canvas.width = 512; canvas.height = 512;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#C62828'; ctx.fillRect(0, 0, 512, 512);
            ctx.fillStyle = '#FFF8E1'; ctx.fillRect(16, 16, 480, 480);
            // Header banner
            ctx.fillStyle = '#0D47A1'; ctx.fillRect(24, 24, 464, 110);
            ctx.fillStyle = '#FFD700'; ctx.font = 'bold 30px sans-serif';
            ctx.textAlign = 'center'; fitText(ctx, '★ ROCK HARD NUTRITION ★', 256, 55, 470);
            ctx.fillStyle = '#FFFFFF'; ctx.font = 'bold 44px "Arial Black", sans-serif';
            ctx.fillText('DOG FOOD', 256, 105);

            // Paw Print & Dog Bone graphic
            ctx.fillStyle = '#C62828';
            // Main paw pad
            ctx.beginPath(); ctx.ellipse(256, 250, 45, 35, 0, 0, Math.PI * 2); ctx.fill();
            // 4 toe pads
            ctx.beginPath(); ctx.ellipse(200, 205, 18, 22, -0.3, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.ellipse(238, 185, 18, 24, -0.1, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.ellipse(274, 185, 18, 24, 0.1, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.ellipse(312, 205, 18, 22, 0.3, 0, Math.PI * 2); ctx.fill();

            // Recipe subtext & seal
            ctx.fillStyle = '#1A237E'; ctx.font = 'bold 28px sans-serif';
            fitText(ctx, 'REAL GRANITE &', 256, 325, 460);
            ctx.font = 'bold 28px sans-serif';
            fitText(ctx, 'ASH DUST RECIPE', 256, 358, 460);
            ctx.fillStyle = '#2E7D32'; ctx.font = 'bold 22px sans-serif';
            fitText(ctx, '100% COMPLETE MINERALS', 256, 398, 460);
            ctx.fillStyle = '#5D4037'; ctx.font = 'bold 20px sans-serif';
            fitText(ctx, "NET WT 50 LBS (IT'S ROCKS)", 256, 455, 460);

            const labelTex = new THREE.CanvasTexture(canvas);
            const labelMesh = new THREE.Mesh(
                new THREE.PlaneGeometry(0.48, 0.74),
                new THREE.MeshBasicMaterial({ map: labelTex })
            );
            labelMesh.position.set(0, 0.39, 0.161);

            g.add(bag, topSeam, labelMesh);
            return g;
        }
    },
    {
        name: "Cheese",
        color: 0xFFA000,
        size: [0.55, 0.32, 0.35],
        quantity: [1, 3],
        model: function() {
            const g = new THREE.Group();
            // Solid rectangular block of sharp cheddar cheese
            const cheeseMat = new THREE.MeshStandardMaterial({ color: 0xFFA000, roughness: 0.65 });
            const block = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.24, 0.26), cheeseMat);
            block.position.y = 0.12;

            // Wax wrapper band around the middle of the cheese block
            const wrapMat = new THREE.MeshStandardMaterial({ color: 0xD32F2F, roughness: 0.4 });
            const wrapper = new THREE.Mesh(new THREE.BoxGeometry(0.484, 0.244, 0.20), wrapMat);
            wrapper.position.y = 0.12;

            // Brand label on wrapper
            const canvas = document.createElement('canvas');
            canvas.width = 512; canvas.height = 256;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#C62828'; ctx.fillRect(0, 0, 512, 256);
            ctx.fillStyle = '#FFF8E1'; ctx.fillRect(12, 12, 488, 232);
            ctx.fillStyle = '#E65100'; ctx.fillRect(20, 20, 472, 60);
            ctx.fillStyle = '#FFFFFF'; ctx.font = 'bold 28px sans-serif';
            ctx.textAlign = 'center'; ctx.fillText('★ FARM FRESH DAIRY ★', 256, 52);
            ctx.fillStyle = '#B71C1C'; ctx.font = 'bold 44px "Arial Black", sans-serif';
            ctx.fillText('SHARP CHEDDAR', 256, 125);
            ctx.fillStyle = '#333333'; ctx.font = 'bold 22px sans-serif';
            ctx.fillText('NATURAL CHEESE BLOCK', 256, 175);
            ctx.fillStyle = '#D84315'; ctx.font = 'bold 18px sans-serif';
            ctx.fillText('AGED OVER 12 MONTHS • NET WT 16 OZ (1 LB)', 256, 218);

            const labelTex = new THREE.CanvasTexture(canvas);
            const labelTop = new THREE.Mesh(
                new THREE.PlaneGeometry(0.48, 0.19),
                new THREE.MeshBasicMaterial({ map: labelTex })
            );
            labelTop.rotation.x = -Math.PI / 2;
            labelTop.position.set(0, 0.243, 0);

            const labelFront = new THREE.Mesh(
                new THREE.PlaneGeometry(0.48, 0.24),
                new THREE.MeshBasicMaterial({ map: labelTex })
            );
            labelFront.position.set(0, 0.12, 0.101);

            g.add(block, wrapper, labelTop, labelFront);
            return g;
        }
    },
    {
        name: "Pants",
        color: 0x455A64,
        size: [0.7, 1.0, 0.3],
        quantity: [1, 1],
        model: function() {
            const g = new THREE.Group();
            const legGeo = new THREE.BoxGeometry(0.25, 0.9, 0.2);
            const mat = new THREE.MeshStandardMaterial({ color: 0x455A64 });
            const left = new THREE.Mesh(legGeo, mat);
            const right = new THREE.Mesh(legGeo, mat);
            left.position.set(-0.15, 0.45, 0);
            right.position.set(0.15, 0.45, 0);
            const waist = new THREE.Mesh(
                new THREE.BoxGeometry(0.55, 0.2, 0.22),
                mat
            );
            waist.position.set(0, 0.95, 0);
            g.add(left, right, waist);
            return g;
        }
    },
    {
        name: "Toys",
        color: 0xFF7043,
        size: [0.6, 0.55, 0.6],
        quantity: [1, 3],
        model: function() {
            const g = new THREE.Group();
            // 5 distinct procedural toy varieties
            const variety = Math.floor(Math.random() * 5);

            if (variety === 0) {
                // Variety 0: Plush Teddy Bear
                const furMat = new THREE.MeshStandardMaterial({ color: 0x8D6E63, roughness: 0.9 });
                const muzzleMat = new THREE.MeshStandardMaterial({ color: 0xD7CCC8, roughness: 0.8 });
                const darkMat = new THREE.MeshStandardMaterial({ color: 0x212121, roughness: 0.4 });
                const bowMat = new THREE.MeshStandardMaterial({ color: 0xE53935, roughness: 0.5 });

                // Body & Head
                const body = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 16), furMat);
                body.position.y = 0.20;
                body.scale.set(1.0, 1.15, 0.9);

                const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 16), furMat);
                head.position.set(0, 0.38, 0.02);

                // Ears
                const earL = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 12), furMat);
                earL.position.set(-0.11, 0.48, 0);
                const earR = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 12), furMat);
                earR.position.set(0.11, 0.48, 0);

                // Muzzle & Nose
                const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 12), muzzleMat);
                muzzle.position.set(0, 0.35, 0.13);
                muzzle.scale.set(1.1, 0.8, 1.0);
                const nose = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 8), darkMat);
                nose.position.set(0, 0.37, 0.18);

                // Eyes
                const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.016, 8, 8), darkMat);
                eyeL.position.set(-0.05, 0.40, 0.14);
                const eyeR = new THREE.Mesh(new THREE.SphereGeometry(0.016, 8, 8), darkMat);
                eyeR.position.set(0.05, 0.40, 0.14);

                // Paws & Bow
                const pawL = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 10), furMat);
                pawL.position.set(-0.15, 0.08, 0.1);
                const pawR = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 10), furMat);
                pawR.position.set(0.15, 0.08, 0.1);

                const bow = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.04, 0.04), bowMat);
                bow.position.set(0, 0.28, 0.12);

                g.add(body, head, earL, earR, muzzle, nose, eyeL, eyeR, pawL, pawR, bow);
            } else if (variety === 1) {
                // Variety 1: Sports Race Car
                const carMat = new THREE.MeshStandardMaterial({ color: 0xD32F2F, roughness: 0.3, metalness: 0.2 });
                const glassMat = new THREE.MeshStandardMaterial({ color: 0x81D4FA, roughness: 0.1, metalness: 0.5 });
                const wheelMat = new THREE.MeshStandardMaterial({ color: 0x212121, roughness: 0.8 });
                const hubMat = new THREE.MeshStandardMaterial({ color: 0xEEEEEE, metalness: 0.8, roughness: 0.2 });

                const chassis = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.08, 0.48), carMat);
                chassis.position.y = 0.09;

                const cabin = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.09, 0.24), glassMat);
                cabin.position.set(0, 0.17, -0.02);

                const spoiler = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.02, 0.06), carMat);
                spoiler.position.set(0, 0.19, -0.21);

                // 4 Wheels
                [[-0.13, 0.14], [0.13, 0.14], [-0.13, -0.14], [0.13, -0.14]].forEach(([wx, wz]) => {
                    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.04, 16), wheelMat);
                    wheel.rotation.z = Math.PI / 2;
                    wheel.position.set(wx, 0.055, wz);
                    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.042, 12), hubMat);
                    hub.rotation.z = Math.PI / 2;
                    hub.position.set(wx, 0.055, wz);
                    g.add(wheel, hub);
                });

                g.add(chassis, cabin, spoiler);
            } else if (variety === 2) {
                // Variety 2: Retro Toy Robot
                const metalMat = new THREE.MeshStandardMaterial({ color: 0x00ACC1, metalness: 0.6, roughness: 0.3 });
                const darkMat = new THREE.MeshStandardMaterial({ color: 0x37474F, metalness: 0.5 });
                const eyeMat = new THREE.MeshBasicMaterial({ color: 0xFFEB3B });
                const redMat = new THREE.MeshStandardMaterial({ color: 0xE53935 });

                const torso = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.24, 0.16), metalMat);
                torso.position.y = 0.20;

                const head = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.16, 0.16), metalMat);
                head.position.y = 0.40;

                // Visor eye
                const visor = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.04, 0.02), eyeMat);
                visor.position.set(0, 0.41, 0.082);

                // Antenna with red tip
                const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.08, 8), darkMat);
                stem.position.set(0, 0.52, 0);
                const tip = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 8), redMat);
                tip.position.set(0, 0.57, 0);

                // Arms & Legs
                const armL = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.18, 8), darkMat);
                armL.position.set(-0.14, 0.20, 0);
                const armR = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.18, 8), darkMat);
                armR.position.set(0.14, 0.20, 0);

                const legL = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.10), darkMat);
                legL.position.set(-0.06, 0.04, 0);
                const legR = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.10), darkMat);
                legR.position.set(0.06, 0.04, 0);

                g.add(torso, head, visor, stem, tip, armL, armR, legL, legR);
            } else if (variety === 3) {
                // Variety 3: Space Rocket
                const whiteMat = new THREE.MeshStandardMaterial({ color: 0xFAFAFA, roughness: 0.3 });
                const redMat = new THREE.MeshStandardMaterial({ color: 0xD32F2F, roughness: 0.3 });
                const blueMat = new THREE.MeshStandardMaterial({ color: 0x1976D2, roughness: 0.3 });

                const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.36, 16), whiteMat);
                fuselage.position.y = 0.26;

                const noseCone = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.16, 16), redMat);
                noseCone.position.y = 0.52;

                const windowRing = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.008, 8, 16), redMat);
                windowRing.position.set(0, 0.32, 0.10);
                const windowGlass = new THREE.Mesh(new THREE.CircleGeometry(0.034, 16), blueMat);
                windowGlass.position.set(0, 0.32, 0.101);

                // 3 Stabilizer Fins
                for (let i = 0; i < 3; i++) {
                    const angle = (i / 3) * Math.PI * 2;
                    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.14, 0.12), redMat);
                    fin.position.set(Math.cos(angle) * 0.12, 0.13, Math.sin(angle) * 0.12);
                    fin.rotation.y = -angle;
                    g.add(fin);
                }
                g.add(fuselage, noseCone, windowRing, windowGlass);
            } else {
                // Variety 4: Rainbow Stacking Rings Toy
                const baseMat = new THREE.MeshStandardMaterial({ color: 0x8D6E63, roughness: 0.7 });
                const base = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.20, 0.04, 20), baseMat);
                base.position.y = 0.02;

                const post = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.42, 12), baseMat);
                post.position.y = 0.23;

                const ringColors = [0x7B1FA2, 0x1976D2, 0x388E3C, 0xFBC02D, 0xE64A19];
                ringColors.forEach((col, idx) => {
                    const radius = 0.15 - idx * 0.022;
                    const ring = new THREE.Mesh(
                        new THREE.TorusGeometry(radius, 0.024, 12, 24),
                        new THREE.MeshStandardMaterial({ color: col, roughness: 0.4 })
                    );
                    ring.rotation.x = Math.PI / 2;
                    ring.position.y = 0.06 + idx * 0.055;
                    g.add(ring);
                });

                const topBall = new THREE.Mesh(
                    new THREE.SphereGeometry(0.045, 16, 16),
                    new THREE.MeshStandardMaterial({ color: 0xD32F2F, roughness: 0.3 })
                );
                topBall.position.y = 0.36;

                g.add(base, post, topBall);
            }

            return g;
        }
    },
    {
        name: "Chocolate bars",
        color: 0x5D4037,
        size: [0.55, 0.35, 0.40],
        quantity: [2, 4],
        model: function() {
            const g = new THREE.Group();

            // Materials
            const chocoMat = new THREE.MeshStandardMaterial({ color: 0x2A1508, roughness: 0.35, metalness: 0.05 });
            const foilMat = new THREE.MeshStandardMaterial({ color: 0xD4AF37, roughness: 0.22, metalness: 0.88 });
            const silverFoilMat = new THREE.MeshStandardMaterial({ color: 0xCCCCCC, roughness: 0.25, metalness: 0.85 });

            // 1. Bottom Dark Chocolate Bar (Deep Ruby/Burgundy wrapper)
            const bar1 = new THREE.Group();
            const b1Mat = new THREE.MeshStandardMaterial({ color: 0x4A0E17, roughness: 0.4 });
            const b1Body = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.065, 0.22), b1Mat);
            const b1Foil = new THREE.Mesh(new THREE.BoxGeometry(0.47, 0.066, 0.03), foilMat);
            b1Foil.position.set(0, 0, 0.10);
            
            // Label for Bar 1
            const c1 = document.createElement('canvas');
            c1.width = 512; c1.height = 256;
            const ctx1 = c1.getContext('2d');
            ctx1.fillStyle = '#4A0E17'; ctx1.fillRect(0, 0, 512, 256);
            ctx1.strokeStyle = '#D4AF37'; ctx1.lineWidth = 6; ctx1.strokeRect(12, 12, 488, 232);
            ctx1.fillStyle = '#D4AF37'; ctx1.font = 'bold 22px serif';
            ctx1.textAlign = 'center'; ctx1.fillText('★ ARTISAN CHOCOLATIER ★', 256, 50);
            ctx1.fillStyle = '#FFFFFF'; ctx1.font = 'bold 42px "Arial Black", sans-serif';
            ctx1.fillText('GRAND NOIR', 256, 110);
            ctx1.fillStyle = '#D4AF37'; ctx1.font = 'bold 28px sans-serif';
            ctx1.fillText('85% COCOA DARK CHOCOLATE', 256, 160);
            ctx1.fillStyle = '#E0E0E0'; ctx1.font = '18px sans-serif';
            ctx1.fillText('SINGLE ORIGIN • NET WT 3.5 OZ (100g)', 256, 210);

            const b1Label = new THREE.Mesh(
                new THREE.PlaneGeometry(0.44, 0.20),
                new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(c1), roughness: 0.4 })
            );
            b1Label.rotation.x = -Math.PI / 2;
            b1Label.position.set(0, 0.034, 0);
            bar1.add(b1Body, b1Foil, b1Label);
            bar1.position.set(-0.04, 0.035, -0.06);
            bar1.rotation.y = -0.08;
            g.add(bar1);

            // 2. Middle Milk Chocolate Bar with unwrapped chocolate pips exposed!
            const bar2 = new THREE.Group();
            // Wrapped half
            const b2Mat = new THREE.MeshStandardMaterial({ color: 0x0D47A1, roughness: 0.4 });
            const b2Body = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.065, 0.22), b2Mat);
            b2Body.position.set(-0.10, 0, 0);

            const c2 = document.createElement('canvas');
            c2.width = 256; c2.height = 256;
            const ctx2 = c2.getContext('2d');
            ctx2.fillStyle = '#0D47A1'; ctx2.fillRect(0, 0, 256, 256);
            ctx2.strokeStyle = '#D4AF37'; ctx2.lineWidth = 5; ctx2.strokeRect(8, 8, 240, 240);
            ctx2.fillStyle = '#FFFFFF'; ctx2.font = 'bold 26px "Arial Black", sans-serif';
            ctx2.textAlign = 'center'; ctx2.fillText('SWISS', 128, 60);
            ctx2.fillText('MILK', 128, 100);
            ctx2.fillStyle = '#FFD54F'; ctx2.font = 'bold 18px sans-serif';
            ctx2.fillText('HAZELNUT', 128, 145);
            ctx2.fillStyle = '#E0E0E0'; ctx2.font = '14px sans-serif';
            ctx2.fillText('CREAMY & RICH', 128, 195);

            const b2Label = new THREE.Mesh(
                new THREE.PlaneGeometry(0.24, 0.20),
                new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(c2), roughness: 0.4 })
            );
            b2Label.rotation.x = -Math.PI / 2;
            b2Label.position.set(-0.10, 0.034, 0);

            // Crinkled metallic foil transition
            const b2Foil = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.068, 0.224), silverFoilMat);
            b2Foil.position.set(0.035, 0, 0);

            // Exposed chocolate slab with 6 beveled snap pips (2x3 grid)
            const chocoBase = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.05, 0.21), chocoMat);
            chocoBase.position.set(0.13, -0.005, 0);
            bar2.add(b2Body, b2Label, b2Foil, chocoBase);

            for (let row = 0; row < 2; row++) {
                for (let col = 0; col < 3; col++) {
                    const pip = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.02, 0.088), chocoMat);
                    pip.position.set(0.065 + col * 0.055, 0.028, -0.048 + row * 0.096);
                    bar2.add(pip);
                }
            }

            bar2.position.set(0.02, 0.10, 0.02);
            bar2.rotation.y = 0.06;
            g.add(bar2);

            // 3. Top Salted Caramel Bar (Golden Ochre Wrapper)
            const bar3 = new THREE.Group();
            const b3Mat = new THREE.MeshStandardMaterial({ color: 0xD84315, roughness: 0.4 });
            const b3Body = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.065, 0.22), b3Mat);
            const b3Foil = new THREE.Mesh(new THREE.BoxGeometry(0.47, 0.066, 0.03), foilMat);
            b3Foil.position.set(0, 0, -0.10);

            const c3 = document.createElement('canvas');
            c3.width = 512; c3.height = 256;
            const ctx3 = c3.getContext('2d');
            ctx3.fillStyle = '#D84315'; ctx3.fillRect(0, 0, 512, 256);
            ctx3.strokeStyle = '#FFE082'; ctx3.lineWidth = 6; ctx3.strokeRect(12, 12, 488, 232);
            ctx3.fillStyle = '#FFE082'; ctx3.font = 'bold 22px serif';
            ctx3.textAlign = 'center'; ctx3.fillText('★ PREMIUM CONFECTION ★', 256, 50);
            ctx3.fillStyle = '#FFFFFF'; ctx3.font = 'bold 38px "Arial Black", sans-serif';
            ctx3.fillText('SALTED CARAMEL', 256, 110);
            ctx3.fillStyle = '#FFD54F'; ctx3.font = 'bold 24px sans-serif';
            ctx3.fillText('CRUNCH & SEA SALT', 256, 160);
            ctx3.fillStyle = '#FFF8E1'; ctx3.font = '18px sans-serif';
            ctx3.fillText('SMOOTH MILK CHOCOLATE • 100g', 256, 210);

            const b3Label = new THREE.Mesh(
                new THREE.PlaneGeometry(0.44, 0.20),
                new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(c3), roughness: 0.4 })
            );
            b3Label.rotation.x = -Math.PI / 2;
            b3Label.position.set(0, 0.034, 0);

            bar3.add(b3Body, b3Foil, b3Label);
            bar3.position.set(-0.02, 0.165, 0.06);
            bar3.rotation.y = 0.12;
            g.add(bar3);

            return g;
        }
    },
    {
        name: "Watermelon",
        color: 0x2E7D32,
        size: [0.75, 0.55, 0.55],
        quantity: [1, 1],
        model: function() {
            const g = new THREE.Group();
            // Procedural striped watermelon skin texture
            const canvas = document.createElement('canvas');
            canvas.width = 1024; canvas.height = 512;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#1B5E20'; ctx.fillRect(0, 0, 1024, 512);
            // Light green jagged stripes
            ctx.fillStyle = '#4CAF50';
            for (let i = 0; i < 1024; i += 64) {
                ctx.beginPath();
                ctx.moveTo(i, 0);
                for (let y = 0; y <= 512; y += 16) {
                    const offset = Math.sin(y * 0.08) * 16 + Math.sin(y * 0.03 + i) * 10;
                    ctx.lineTo(i + 24 + offset, y);
                }
                ctx.lineTo(i + 36, 512);
                for (let y = 512; y >= 0; y -= 16) {
                    const offset = Math.sin(y * 0.08) * 16 + Math.sin(y * 0.03 + i) * 10;
                    ctx.lineTo(i + 8 + offset, y);
                }
                ctx.closePath();
                ctx.fill();
            }

            const rindTex = new THREE.CanvasTexture(canvas);
            const melonMat = new THREE.MeshStandardMaterial({ map: rindTex, roughness: 0.4 });
            const wholeMelon = new THREE.Mesh(new THREE.SphereGeometry(0.32, 32, 32), melonMat);
            wholeMelon.scale.set(1.24, 0.95, 0.95);
            wholeMelon.position.set(0, 0.30, 0);

            // Natural curly woody stem nub
            const stemMat = new THREE.MeshStandardMaterial({ color: 0x4E342E, roughness: 0.9 });
            const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.02, 0.08, 8), stemMat);
            stem.rotation.z = Math.PI / 2;
            stem.position.set(0.40, 0.30, 0);

            const stemTip = new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.008, 6, 12, Math.PI * 0.75), stemMat);
            stemTip.position.set(0.44, 0.32, 0);
            stemTip.rotation.z = Math.PI / 4;

            g.add(wholeMelon, stem, stemTip);
            return g;
        }
    },
    {
        name: "Flowers",
        color: 0xEC407A,
        size: [0.5, 0.9, 0.5],
        quantity: [1, 2],
        model: function() {
            const g = new THREE.Group();
            const green = new THREE.MeshStandardMaterial({ color: 0x397b39, roughness: 0.9, side: THREE.DoubleSide });
            const petals = new THREE.InstancedMesh(
                new THREE.SphereGeometry(0.075, 8, 6),
                new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 }), 18
            );
            const stems = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.012, 0.018, 0.55, 5), green, 3);
            const leaves = new THREE.InstancedMesh(new THREE.SphereGeometry(0.08, 6, 4), green, 6);
            const centers = new THREE.InstancedMesh(
                new THREE.SphereGeometry(0.047, 8, 6),
                new THREE.MeshStandardMaterial({ color: 0xffc851, roughness: 0.7 }), 3
            );
            const dummy = new THREE.Object3D();
            const bouquets = [
                {x: -0.14, z: 0.01, y: 0.68, color: 0xf267a1},
                {x: 0.02, z: 0.08, y: 0.77, color: 0xffd967},
                {x: 0.16, z: -0.035, y: 0.65, color: 0xc78aff}
            ];
            bouquets.forEach((bloom, i) => {
                dummy.position.set(bloom.x * 0.55, bloom.y / 2, bloom.z * 0.55);
                dummy.rotation.set(0, 0, -bloom.x * 0.55);
                dummy.scale.set(1, (bloom.y - 0.08) / 0.55, 1);
                dummy.updateMatrix(); stems.setMatrixAt(i, dummy.matrix);
                for (let p = 0; p < 6; p++) {
                    const a = p * Math.PI / 3;
                    dummy.position.set(bloom.x + Math.cos(a) * 0.084, bloom.y, bloom.z + Math.sin(a) * 0.084);
                    dummy.rotation.set(0, -a, 0);
                    dummy.scale.set(0.85, 0.28, 1.35);
                    dummy.updateMatrix(); petals.setMatrixAt(i * 6 + p, dummy.matrix);
                    petals.setColorAt(i * 6 + p, new THREE.Color(bloom.color).multiplyScalar(p % 2 ? 0.91 : 1));
                }
                dummy.position.set(bloom.x, bloom.y + 0.025, bloom.z);
                dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 0.6, 1);
                dummy.updateMatrix(); centers.setMatrixAt(i, dummy.matrix);
                for (let l = 0; l < 2; l++) {
                    dummy.position.set(bloom.x * 0.7 + (l ? 0.055 : -0.055), 0.38 + l * 0.12, bloom.z * 0.7);
                    dummy.rotation.set(0, 0, l ? -0.5 : 0.5);
                    dummy.scale.set(1.1, 0.28, 0.52);
                    dummy.updateMatrix(); leaves.setMatrixAt(i * 2 + l, dummy.matrix);
                }
            });
            const wrap = new THREE.Mesh(
                new THREE.CylinderGeometry(0.135, 0.07, 0.24, 9),
                new THREE.MeshStandardMaterial({ color: 0xcfa781, roughness: 0.95, side: THREE.DoubleSide })
            );
            wrap.position.y = 0.13;
            g.add(wrap, stems, leaves, petals, centers);
            return g;
        }
    },
    {
        name: "Coffee",
        color: 0x795548,
        size: [0.4, 0.7, 0.4],
        quantity: [1, 2],
        model: function() {
            const g = new THREE.Group();
            // Dark roasted coffee canister body
            const tinMat = new THREE.MeshStandardMaterial({ color: 0x321E17, roughness: 0.35, metalness: 0.3 });
            const tin = new THREE.Mesh(
                // Open shell meets the base at y=0.02 and lid at y=0.60 without duplicate caps.
                cachedItemAsset('coffeeTinGeo', () => new THREE.CylinderGeometry(0.2, 0.2, 0.58, 24, 1, true)),
                tinMat
            );
            tin.position.y = 0.31;

            // Brand label with custom canvas artwork
            const canvas = document.createElement('canvas');
            canvas.width = 512;
            canvas.height = 256;
            const ctx = canvas.getContext('2d');

            // Rich coffee bean background
            ctx.fillStyle = '#2B170C';
            ctx.fillRect(0, 0, 512, 256);

            // Gold framing
            ctx.strokeStyle = '#D4AF37';
            ctx.lineWidth = 6;
            ctx.strokeRect(10, 10, 492, 236);
            ctx.lineWidth = 2;
            ctx.strokeRect(16, 16, 480, 224);

            // Cream brand badge
            ctx.fillStyle = '#FFF8E7';
            ctx.beginPath();
            ctx.ellipse(256, 118, 175, 58, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#D4AF37';
            ctx.lineWidth = 4;
            ctx.stroke();

            // Header
            ctx.fillStyle = '#D4AF37';
            ctx.font = 'bold 20px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            fitText(ctx, '★ FLOOR-ROASTED ★', 256, 40, 460);

            // Title
            ctx.fillStyle = '#3E1C0A';
            ctx.font = 'bold 54px "Arial Black", Impact, sans-serif';
            ctx.fillText('COFFEE', 256, 112);

            // Subtitle
            ctx.fillStyle = '#8D4018';
            ctx.font = 'bold 15px sans-serif';
            fitText(ctx, '100% BEANS FOUND', 256, 144, 260);
            ctx.font = 'bold 15px sans-serif';
            fitText(ctx, 'ON THE GROUND', 256, 162, 220);

            // Footer
            ctx.fillStyle = '#D4AF37';
            ctx.font = 'bold 18px sans-serif';
            fitText(ctx, 'GROUND COFFEE (LITERALLY) • 12 OZ', 256, 212, 460);

            const labelTex = new THREE.CanvasTexture(canvas);
            const labelMat = new THREE.MeshStandardMaterial({
                map: labelTex,
                roughness: 0.35,
                metalness: 0.1
            });
            const label = new THREE.Mesh(
                cachedItemAsset('coffeeLabelGeo', () => new THREE.CylinderGeometry(0.202, 0.202, 0.42, 24, 1, true)),
                labelMat
            );
            label.position.y = 0.3;
            label.rotation.y = -Math.PI / 2;

            // Gold metallic lid and bottom rim
            const goldMat = new THREE.MeshStandardMaterial({ color: 0xD4AF37, roughness: 0.25, metalness: 0.8 });
            const lid = new THREE.Mesh(
                cachedItemAsset('coffeeLidGeo', () => new THREE.CylinderGeometry(0.21, 0.21, 0.04, 24)),
                goldMat
            );
            lid.position.y = 0.62;

            const baseRim = new THREE.Mesh(
                cachedItemAsset('coffeeBaseGeo', () => new THREE.CylinderGeometry(0.205, 0.205, 0.02, 24)),
                goldMat
            );
            baseRim.position.y = 0.01;

            g.add(tin, label, lid, baseRim);
            return g;
        }
    }
];

// Product labels were unlit MeshBasicMaterials, so when the store lights go
// out they kept glowing at full brightness and looked like items floating in
// the dark. Swap them for lit materials so products respond to store lighting.
function makeItemMaterialsLit(root) {
    if (!root) return root;
    const cache = new Map();
    root.traverse(o => {
        if (!o.isMesh) return;
        const swap = m => {
            if (!m || !m.isMeshBasicMaterial) return m;
            if (cache.has(m)) return cache.get(m);
            const lit = new THREE.MeshLambertMaterial({
                color: m.color, map: m.map, side: m.side,
                transparent: m.transparent, opacity: m.opacity,
                alphaTest: m.alphaTest, depthWrite: m.depthWrite
            });
            cache.set(m, lit);
            return lit;
        };
        o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
    });
    return root;
}
[BASE_ITEMS, ALT_ITEMS].forEach(list => list.forEach(tpl => {
    if (typeof tpl.model !== 'function') return;
    const raw = tpl.model;
    tpl.model = function(...args) { return makeItemMaterialsLit(raw.apply(this, args)); };
}));

// Active batch for current game (either BASE_ITEMS or ALT_ITEMS)
let ACTIVE_ITEMS = BASE_ITEMS;
let usingAltItems = false;
// Legacy alias so older code paths that still reference ITEMS continue to work
let ITEMS = ACTIVE_ITEMS;

function chooseItemBatch() {
    usingAltItems = Math.random() < 0.5;
    ACTIVE_ITEMS = usingAltItems ? ALT_ITEMS : BASE_ITEMS;
    // Keep legacy ITEMS alias in sync with the currently active batch
    ITEMS = ACTIVE_ITEMS;
}

// DOM elements
const loadingElement = document.getElementById('loading');
const loadingHintElement = document.getElementById('loading-hint');
const messageElement = document.getElementById('message'); // legacy element (kept as backup)
const shoppingListElement = document.getElementById('shopping-list');
const timerElement = document.getElementById('timer');
const checkoutUIElement = document.getElementById('checkout-ui');
const checkoutItemsElement = document.getElementById('checkout-items');
const finishCheckoutButton = document.getElementById('finish-checkout');
const checkoutBusyBanner = document.getElementById('checkout-busy-banner');
const checkoutBusyCountdownEl = document.getElementById('checkout-busy-countdown');
const gameOverElement = document.getElementById('game-over');
const finalTimeElement = document.getElementById('final-time');
const playAgainButton = document.getElementById('play-again');

const scoreboardElement = document.createElement('div');
scoreboardElement.id = 'scoreboard';
scoreboardElement.innerHTML = '<h3>Best Times</h3><ol id="best-times-list"></ol>';
scoreboardElement.style.display = CONFIG.HIDE_BEST_TIMES ? 'none' : '';
document.getElementById('game-container').appendChild(scoreboardElement);

export const DEFAULT_KEYBINDS = {
    forward: 'KeyW',
    backward: 'KeyS',
    left: 'KeyA',
    right: 'KeyD',
    interact: 'KeyE',
    jump: 'Space',
    cart: 'KeyF',
    slap: 'KeyR',
    mute: 'KeyM',
    pause: 'Escape',
    powerup: 'KeyY',
    useMouse: 'Tab'
};

function formatKeyName(code) {
    if (!code) return '';
    if (code.startsWith('Key')) return code.substring(3);
    if (code.startsWith('Digit')) return code.substring(5);
    if (code === 'Space') return 'Space';
    if (code === 'Escape') return 'Esc';
    if (code.startsWith('Arrow')) return code.substring(5);
    if (code === 'ShiftLeft' || code === 'ShiftRight') return 'Shift';
    if (code === 'ControlLeft' || code === 'ControlRight') return 'Ctrl';
    if (code === 'AltLeft' || code === 'AltRight') return 'Alt';
    if (code === 'Backquote') return '`';
    if (code === 'Tab') return 'Tab';
    if (code === 'Enter') return 'Enter';
    return code;
}

const controlsGuideElement = document.createElement('div');
controlsGuideElement.id = 'controls-guide';
document.getElementById('game-container').appendChild(controlsGuideElement);

function updateControlsGuideDisplay() {
    if (!controlsGuideElement) return;
    if (CONFIG.HIDE_CONTROLS_GUIDE) {
        controlsGuideElement.style.display = 'none';
        return;
    }
    controlsGuideElement.style.display = '';
    const kb = { ...DEFAULT_KEYBINDS, ...(CONFIG.KEYBINDS || {}) };
    controlsGuideElement.innerHTML = `
        <h3>Controls</h3>
        <p>${formatKeyName(kb.forward)}/${formatKeyName(kb.left)}/${formatKeyName(kb.backward)}/${formatKeyName(kb.right)} - Move</p>
        <p>Mouse - Look</p>
        <p>${formatKeyName(kb.interact)} - Grab/Release items</p>
        <p>${formatKeyName(kb.jump)} - Jump</p>
        <p>${formatKeyName(kb.cart)} - Attach/Detach Cart</p>
        <p>${formatKeyName(kb.mute)} - Mute/Unmute Music</p>
        <p>${formatKeyName(kb.pause)} - Pause</p>
        <p>${formatKeyName(kb.slap)} - Slap</p>
        <p>${formatKeyName(kb.useMouse || 'Tab')} - Use Mouse</p>
        <p>1/2 - Grocery / Other list</p>
    `;
}
updateControlsGuideDisplay();

const mainMenuElement = document.createElement('div');
mainMenuElement.id = 'main-menu';
mainMenuElement.innerHTML = `
    <button id="start-game" class="main-menu-btn">Play</button>
    <button id="customize-game" class="main-menu-btn">Customize Game</button>
    <button id="open-leaderboard" class="main-menu-btn">Leaderboard</button>
    <button id="open-settings" class="main-menu-btn">Settings</button>
`;
document.getElementById('game-container').appendChild(mainMenuElement);

// Add mute toggle button on main menu (audio symbol)
const muteBtn = document.createElement('button');
muteBtn.id = 'mute-toggle';
muteBtn.setAttribute('aria-label', 'Toggle music mute');
muteBtn.textContent = '🔊';
document.getElementById('game-container').appendChild(muteBtn);

function playUIButtonSound(name) {
    const source = soundEffects?.[name];
    const sfxVolume = Math.max(0, Math.min(1, CONFIG.SFX_VOLUME ?? 0.7));
    if (!source || sfxVolume === 0) return;
    try {
        const player = source.cloneNode();
        player.volume = sfxVolume * (name === 'uiHover' ? 0.55 : 0.8);
        player.play().catch(() => {});
    } catch (_) {}
}

let lastButtonHoverSoundAt = 0;
document.addEventListener('pointerover', (event) => {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (!button || button.disabled || (event.relatedTarget && button.contains(event.relatedTarget))) return;
    const now = performance.now();
    if (now - lastButtonHoverSoundAt < 80) return;
    lastButtonHoverSoundAt = now;
    playUIButtonSound('uiHover');
}, true);

document.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (button && !button.disabled) playUIButtonSound('uiClick');
}, true);

// Add still image background for main menu
const menuBg = document.createElement('div');
menuBg.id = 'menu-bg';
document.getElementById('game-container').appendChild(menuBg);

const itemHoverTextElement = document.getElementById('item-hover-text');

// Side quests ("Other Tasks" paper) get a narrow window into the game state.
SQ.initSideQuests({
    get config() { return CONFIG; },
    get scene() { return scene; },
    get world() { return world; },
    get camera() { return camera; },
    get controls() { return controls; },
    get arm() { return arm; },
    get playerBody() { return playerBody; },
    get cartObject() { return cartObject; },
    get cartAttached() { return cartAttached; },
    get heldItem() { return heldItem; },
    get customers() { return customers; },
    get sampleBooths() { return sampleBooths; },
    get toilet() { return bathroomToilet; },
    get items() { return ITEMS; },
    get shoppingList() { return shoppingList; },
    get purchaseComplete() { return purchaseComplete; },
    get gameStarted() { return gameStarted; },
    get gamePaused() { return gamePaused; },
    get isCheckout() { return isCheckout; },
    get gameOver() { return gameOver; },
    get sfxVolume() { return CONFIG.SFX_VOLUME ?? 0.7; },
    displayMessage: (msg, ms) => displayMessage(msg, ms),
    findCustomerUnderCrosshair: () => findCustomerUnderCrosshair(),
    keyName: (action) => {
        const kb = CONFIG.KEYBINDS;
        return formatKeyName(kb && Object.prototype.hasOwnProperty.call(kb, action) ? kb[action] : DEFAULT_KEYBINDS[action]);
    },
    addSavings: (cents) => { savingsCents += cents; updateSavingsTab(); },
    detachCart: () => { cartAttached = false; },
    refreshList: () => updateShoppingListDisplay(),
    getLook: () => ({ yaw: cameraTargetYaw, pitch: cameraTargetPitch }),
    setLook: (yaw, pitch) => syncCameraAngles(yaw, Math.max(-Math.PI * 0.48, Math.min(Math.PI * 0.48, pitch))),
    stopRunTimer: () => stopRunTimer(),
    finishRun: () => endGame()
});

function setListPage(page) {
    if (page === 'other' && !SQ.sideQuestsEnabled()) return;
    if (activeListPage === page) return;
    activeListPage = page;
    updateShoppingListDisplay();
    shoppingListElement.classList.remove('page-flip');
    void shoppingListElement.offsetWidth;
    shoppingListElement.classList.add('page-flip');
}

function countWrongItemsInCart() {
    return collectedItems.filter(item =>
        !item.isTwoInOne &&
        !(item.name === 'Gum' || item.isCheckoutGum) &&
        !shoppingList.some(li => li?.name === item?.name) &&
        !itemsRemovedFromShoppingList.has(item.name)
    ).length;
}

// Checkout confirmed. With side quests on, the run continues until you drive away.
function completeGroceryPurchase() {
    teardownCheckoutPanel();
    endBusyCheckoutIfActive();
    if (!SQ.sideQuestsEnabled()) { endGame(); return; }
    purchaseWrongItemsCount = countWrongItemsInCart();
    paidListSnapshot = shoppingList.map(item => ({ ...item }));
    gumCravingActive = false;
    isCheckout = false;
    gamePaused = false;
    if (addItemIntervalId) { clearInterval(addItemIntervalId); addItemIntervalId = null; }
    if (removeItemIntervalId) { clearInterval(removeItemIntervalId); removeItemIntervalId = null; }
    if (cartBabyActionTimerId) { clearTimeout(cartBabyActionTimerId); cartBabyActionTimerId = null; }
    cartBabyAction = null;
    try { controls.lock(); } catch (_) {}
    activeListPage = 'grocery';
    setListPage('other');
    displayMessage("🧾 Groceries paid! Finish your other tasks, then drive home.", 3500);
}

function getRunMetrics(elapsed) {
    const list = paidListSnapshot || shoppingList;
    const totalRequired = list.reduce((sum, item) => sum + (item.quantity || 1), 0);
    const totalCollected = list.reduce((sum, item) => sum + Math.min(item.collected || 0, item.quantity || 1), 0);
    const missingItems = Math.max(0, totalRequired - totalCollected);
    const completionPercent = totalRequired > 0 ? Math.round((totalCollected / totalRequired) * 100) : 100;

    return {
        totalRequired,
        totalCollected,
        missingItems,
        completionPercent
    };
}

function endGame() {
    // Stop the game timer and event reroll cycle
    clearInterval(timer);
    timer = null;
    stopEventRerollCycle();
    clearGlassesBlur();
    gameOver = true;
    endCustomerScuffle(true);
    endTweakerEvent();

    // Decide success vs failure music: only fail if a wrong item is currently in the cart (Gum from craving is valid, and removed list items are valid)
    const currentWrongItemsInCart = paidListSnapshot ? purchaseWrongItemsCount : countWrongItemsInCart();
    trackSideQuestTimeline(true);
    const sideQuestStats = SQ.getSideQuestStats();
    SQ.resetSideQuests();
    const isFailure = walletFailed || tweakerMoneyFailure || currentWrongItemsInCart > 0;
    if (isFailure) {
        playFailMusic();
    } else {
        stopFailMusic();
        // Play duck squeak on successful completion
        try { if (sfxSqueak) { sfxSqueak.currentTime = 0; sfxSqueak.play(); } } catch(_) {}
    }

    // Calculate final elapsed time
    const elapsed = stoppedRunElapsed ?? Math.max(0, Date.now() - timerStart);
    stoppedRunElapsed = elapsed;
    updateTimer();
    logRunEvent(isFailure ? '❌ Shopping failed' : '🏁 Finished shopping');
    const hours = Math.floor(elapsed / 3600000);
    const minutes = Math.floor((elapsed % 3600000) / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);
    const milliseconds = Math.floor((elapsed % 1000) / 10);
    const finalTime = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(2, '0')}`;

    // Display final time on the game over screen
    finalTimeElement.textContent = finalTime;

    // Calculate run metrics
    const runMetrics = getRunMetrics(elapsed);

    // If this was a failure, show unified failure overlay and skip best‑time handling
    if (isFailure || !countsForLeaderboard() || elapsed > 300000) {
        try { window.__replayRunEnded?.(false); } catch (_) {}
    } else {
        try { window.__replayRunEnded?.(true, finalTime); } catch (_) {}
    }
    if (isFailure) {
        const subtitle = tweakerMoneyFailure
            ? "You didn't have a enough money to get your items!"
            : walletFailed
            ? 'You forgot your wallet and could not pay at checkout.'
            : 'You left a wrong item in your cart.';
        showShoppingFailureOverlay('Shopping Failed!', subtitle);
        controls.unlock();
        return;
    }

    if (!isCustomGame) {
        unlockAchievement('firstCheckout');
        if (elapsed < 120000) unlockAchievement('expressLane');
    }

    // Bank the cash left over from a completed vanilla run exactly once.
    const bankedSavings = !isCustomGame ? bankSavings(savingsCents) : 0;
    if (bankedSavings) savingsCents = 0;

    let bestTimeMessage = "";
    if (currentWrongItemsInCart === 0 && !isCustomGame && !walletFailed) {  
        // Update and store best times only if no wrong items grabbed, not custom, and no wallet failure
        let stored = [];
        try { stored = JSON.parse(localStorage.getItem('bestTimes') || '[]') || []; } catch (_) {}
        
        // Convert time strings to milliseconds for comparison
        const currentTimeMs = elapsed;
        const bestTimeMs = stored.length > 0 ? timeStringToMs(stored[0]) : Infinity;

        stored.push(finalTime);
        stored.sort((a, b) => timeStringToMs(a) - timeStringToMs(b));
        stored = stored.slice(0, 5); // Keep only top 5
        try { localStorage.setItem('bestTimes', JSON.stringify(stored)); } catch (_) {}
        
        // ensure global scoreboard uses the updated list
        bestTimes = stored;

        // Check if this was a new best time
        if (currentTimeMs < bestTimeMs) {
            bestTimeMessage = "<br><strong style='color:#34d399;'>⚡ NEW PERSONAL RECORD! Fastest Speedrun Time!</strong>";
            try { sfxTada.currentTime = 0; sfxTada.play(); } catch(e) {}
        }
    }

    // Submit speedrun time to database leaderboard for valid non-custom runs
    if (!isFailure && countsForLeaderboard() && runMetrics) {
        submitLeaderboardScore({
            final_time: finalTime,
            elapsed_ms: elapsed,
            completion_percent: runMetrics.completionPercent,
            items_collected: runMetrics.totalCollected
        });
    }

    // Prepare statistics text
    let statsText = buildStatsHtml(runMetrics, sideQuestStats);
    if (bankedSavings) statsText += `<br>Added $${(bankedSavings / 100).toFixed(2)} to shop savings`;

    if (!countsForLeaderboard()) {
        statsText += `<br><em>This was a customized game (speedruns not counted on official leaderboard)</em>`;
    }

    // Use unified "shopping complete" overlay
    showShoppingCompleteOverlay(statsText, bestTimeMessage, runMetrics);

    updateScoreboard();

    controls.unlock();
}

function timeStringToMs(timeStr) {
    const [time, ms] = timeStr.split('.');
    const [hours, minutes, seconds] = time.split(':');
    return (parseInt(hours) * 3600000) + 
           (parseInt(minutes) * 60000) + 
           (parseInt(seconds) * 1000) + 
           (parseInt(ms) * 10);
}

function loadSounds() {
    const { music: newMusic, soundEffects: newSfx, singles } = loadSoundsExt({ musicMuted });
    if (music && music !== newMusic) retireMusic(music);
    music = registerMusic(newMusic);
    soundEffects = newSfx;
    soundEffects.tweakerGrunt = new Audio('./sfx/tweaker_grunt.wav');
    soundEffects.moneyPickup = new Audio('./sfx/money_pickup.wav');
    Object.keys(BOOSTED_SFX_MULTIPLIERS).forEach(name => setBoostedSfxVolume(name));
    cartRollingRequested = false;
    sfxKey = singles.sfxKey;
    sfxTada = singles.sfxTada;
    sfxPowerDown = singles.sfxPowerDown;
    sfxAttentionCustomers = singles.sfxAttentionCustomers;
    sfxSqueak = singles.sfxSqueak;

    // Initialize Mr. Resetti fail music (counted as music)
    try {
        mrResettiMusic = new Audio('Mr. Resetti - Animal Crossing Wild World Soundtrack [TubeRipper.com].mp3');
        registerMusic(mrResettiMusic);
        mrResettiMusic.loop = true;
        mrResettiMusic.volume = CONFIG.MUSIC_VOLUME;
        mrResettiMusic.muted = musicMuted;
    } catch (_) {}
}

// Indoor darkness: while the camera is inside the store, the global sky/fill
// lights (which otherwise light the interior uniformly) and the sun (which
// streams through the glass) are scaled down for the frame being rendered,
// then restored so every other system keeps owning the base values.
const INDOOR_DIM = { ambientLight: 0.4, hemiLight: 0.4, fillLight: 0.35, sunLight: 0.55, exposure: 0.88 };
const OUTAGE_SUN_DEEP = 0.12;      // sun multiplier deep inside during an outage
const OUTAGE_EXPOSURE_DEEP = 0.8;  // exposure multiplier deep inside during an outage
function installIndoorDimming(r) {
    if (!r || r.__indoorDim) return;
    r.__indoorDim = true;
    const baseRender = r.render.bind(r);
    let k = 0, outageSun = 1, last = performance.now();
    r.render = (sc, cam) => {
        const now = performance.now();
        const dt = Math.min((now - last) / 1000, 0.1);
        last = now;
        const p = cam?.position;
        const inside = sc === scene && p && Math.abs(p.x) < 30 && Math.abs(p.z) < 30 && p.y < 12;
        k += ((inside ? 1 : 0) - k) * Math.min(1, dt * 4);
        // During a power outage the sun through the glass is dimmed further the
        // deeper inside you are, easing back slowly as you near the entrance.
        if (inside) {
            const dx = p.x, dz = p.z + 30;
            const t = Math.min(1, Math.max(0, (Math.sqrt(dx * dx + dz * dz) - 4) / 16));
            const near = 1 - t * t * (3 - 2 * t);
            const target = OUTAGE_SUN_DEEP + (1 - OUTAGE_SUN_DEEP) * near;
            outageSun += (target - outageSun) * Math.min(1, dt * 0.6);
        } else {
            outageSun += (1 - outageSun) * Math.min(1, dt * 0.6);
        }
        if (k < 0.001 || !sceneLights) return baseRender(sc, cam);
        let outK = 0;
        try { outK = Math.max(0, Math.min(1, 1 - storePowerLevel)); } catch (_) {}
        const outageMul = 1 - outK * (1 - outageSun);
        const saved = {};
        for (const key of ['ambientLight', 'hemiLight', 'fillLight', 'sunLight']) {
            const l = sceneLights[key];
            if (!l) continue;
            saved[key] = l.intensity;
            l.intensity *= 1 + (INDOOR_DIM[key] - 1) * k;
            if (key === 'sunLight') l.intensity *= 1 + (outageMul - 1) * k;
        }
        const savedExp = r.toneMappingExposure;
        r.toneMappingExposure *= 1 + (INDOOR_DIM.exposure - 1) * k;
        r.toneMappingExposure *= 1 + (OUTAGE_EXPOSURE_DEEP - 1) * (1 - outageMul) / (1 - OUTAGE_SUN_DEEP) * k;
        try { baseRender(sc, cam); }
        finally {
            for (const key in saved) sceneLights[key].intensity = saved[key];
            r.toneMappingExposure = savedExp;
        }
    };
}

function setupScene() {
    const { scene: newScene, camera: newCamera, renderer: newRenderer, skyTexture: skyTex, nightSkyTexture: nightSkyTex, lights } = setupSceneExt(CONFIG);
    scene = newScene;
    camera = newCamera;
    renderer = newRenderer;
    scene.add(camera);
    window.debugRenderer = newRenderer;
    skyTexture = skyTex;
    nightSkyTexture = nightSkyTex;
    sceneLights = lights;
    installIndoorDimming(renderer);

    controls = new PointerLockControls(camera, renderer.domElement);
    // Handled by our lag-resistant frame-independent smooth camera engine
    controls.pointerSpeed = 0;
    // Touch devices have no pointer lock: emulate a "locked" state so every
    // gameplay check (look, grab, slap, camera follow, cart) keeps working.
    if (TOUCH_MODE || typeof renderer.domElement.requestPointerLock !== 'function') {
        const c = controls;
        c.lock = () => { if (c.isLocked) return; c.isLocked = true; c.dispatchEvent({ type: 'lock' }); };
        c.unlock = () => { if (!c.isLocked) return; c.isLocked = false; c.dispatchEvent({ type: 'unlock' }); };
    }
    controls.addEventListener('lock', () => {
        syncCameraAngles(camera.rotation.y, camera.rotation.x);
    });

    if (lockOnStart) { try { controls.lock(); } catch(_) {} lockOnStart = false; }
    let crosshair = document.querySelector('.crosshair');
    if (!crosshair) {
        crosshair = document.createElement('div');
        crosshair.className = 'crosshair';
        document.getElementById('game-container').appendChild(crosshair);
    }
    crosshairElement = crosshair;

    // Pre-warm police car model in scene to prevent any frame freeze during shoplifting easter egg
    try {
        if (!policeCarModel) {
            policeCarModel = createPoliceCar();
        }
        policeCarModel.position.set(0, -500, 0);
        policeCarModel.visible = true;
        scene.add(policeCarModel);
    } catch (_) {}
}

function setupPhysics() {
    const { world: newWorld, materials } = setupPhysicsExt(CONFIG);
    world = newWorld;
    physicsMaterials = materials;

    // Rebind contact events previously attached
    if (globalBeginContactHandler) { try { world.removeEventListener('beginContact', globalBeginContactHandler); } catch(_) {} }
    if (globalEndContactHandler) { try { world.removeEventListener('endContact', globalEndContactHandler); } catch(_) {} }
    globalBeginContactHandler = (event) => {
        let bodyA = event.bodyA;
        let bodyB = event.bodyB;
        if (!bodyA || !bodyB) return;

        if ((bodyA === playerBody && bodyB.userData && bodyB.userData.entity && bodyB.userData.entity.walkSpeed !== undefined) || (bodyB === playerBody && bodyA.userData && bodyA.userData.entity && bodyA.userData.entity.walkSpeed !== undefined)) {
            // Track contact for theft mechanic
            const custBody = bodyA === playerBody ? bodyB : bodyA;
            if (custBody.userData && custBody.userData.entity) {
                const cust = custBody.userData.entity;
                touchingCustomers.add(cust);
                const now = performance.now();
                if (now > (cust.bumpCooldownUntil || 0)) {
                    cust.bumpYieldUntil = now + 450 + Math.random() * 300;
                    cust.bumpReactionUntil = now + 750;
                    cust.bumpCooldownUntil = now + 1400;
                }
            }
            if (Math.random() * 100 < plus5PercentPercent(CONFIG.CUSTOMER_QUESTION_CHANCE)) { 
                soundEffects.customerQuestion.currentTime = 0;
                soundEffects.customerQuestion.play();
                showCustomerInteractionMessage();
            }
        }

        // Mutual bump contact between customers
        if (bodyA.userData && bodyA.userData.entity && bodyB.userData && bodyB.userData.entity) {
            const custA = bodyA.userData.entity;
            const custB = bodyB.userData.entity;
            if (custA.walkSpeed !== undefined && custB.walkSpeed !== undefined) {
                const now = performance.now();
                if (now > (custA.bumpCooldownUntil || 0)) {
                    custA.bumpYieldUntil = now + 450 + Math.random() * 300;
                    custA.bumpReactionUntil = now + 750;
                    custA.bumpCooldownUntil = now + 1400;
                    custA.bumpTarget = custB;
                }
                if (now > (custB.bumpCooldownUntil || 0)) {
                    custB.bumpYieldUntil = now + 450 + Math.random() * 300;
                    custB.bumpReactionUntil = now + 750;
                    custB.bumpCooldownUntil = now + 1400;
                    custB.bumpTarget = custA;
                }
            }
        }
    };
    world.addEventListener('beginContact', globalBeginContactHandler);

    // Track when player stops touching customers
    globalEndContactHandler = (event) => {
        let bodyA = event.bodyA;
        let bodyB = event.bodyB;
        // Guard against malformed events where one of the bodies is missing
        if (!bodyA || !bodyB) return;

        if ((bodyA === playerBody && bodyB.userData && bodyB.userData.entity) ||
            (bodyB === playerBody && bodyA.userData && bodyA.userData.entity)) {
            const custBody = bodyA === playerBody ? bodyB : bodyA;
            const cust = custBody.userData && custBody.userData.entity;
            if (cust && touchingCustomers.has(cust)) {
                touchingCustomers.delete(cust);
            }
        }
    };
    world.addEventListener('endContact', globalEndContactHandler);

    // Start / restart theft check interval
    if (customerTheftIntervalId) {
        try { clearInterval(customerTheftIntervalId); } catch (_) {}
        customerTheftIntervalId = null;
    }
    customerTheftIntervalId = setInterval(() => {
        if (!gameStarted || gamePaused || isCheckout || gameOver) return;
        if (!touchingCustomers.size) return;
        touchingCustomers.forEach(cust => {
            tryAttemptCustomerTheft(cust);
        });
    }, 1000);
}

function createEnvironment() {
    // Default layout
    createStoreLayout();
}

function createLayout2() {
    // Use structured aisle layout
    createStoreLayout();
}

function createLayout3() {
    // Use structured aisle layout
    createStoreLayout();
}

function createLayout4() {
    // Use structured aisle layout
    createStoreLayout();
}

function createLayout5() {
    // Use structured aisle layout
    createStoreLayout();
}

// Define ceiling height (slightly taller than before)
const CEILING_HEIGHT = 5.5;

function createStoreLayout() {
    if (isLonelyStoreMode) {
        if (sceneLights) {
            if (sceneLights.ambientLight) {
                sceneLights.ambientLight.intensity = 0.005;
                sceneLights.ambientLight.color.set(0x050714);
            }
            if (sceneLights.hemiLight) {
                sceneLights.hemiLight.intensity = 0.01;
                sceneLights.hemiLight.color.set(0x0a1025);
                sceneLights.hemiLight.groundColor.set(0x020306);
            }
            if (sceneLights.sunLight) sceneLights.sunLight.intensity = 0.0;
            if (sceneLights.fillLight) sceneLights.fillLight.intensity = 0.0;
        }
        if (scene) {
            scene.fog = new THREE.Fog(0x010206, 2, 28);
            if (nightSkyTexture) {
                scene.background = nightSkyTexture;
                scene.environment = nightSkyTexture;
            } else {
                scene.background = new THREE.Color(0x010206);
                scene.environment = null;
            }
        }
        if (renderer) {
            renderer.toneMappingExposure = 0.8;
        }
    } else {
        if (sceneLights) {
            if (sceneLights.ambientLight) {
                sceneLights.ambientLight.intensity = 0.35;
                sceneLights.ambientLight.color.set(0xffffff);
            }
            if (sceneLights.hemiLight) {
                sceneLights.hemiLight.intensity = 0.85;
                sceneLights.hemiLight.color.set(0xdbeafe);
                sceneLights.hemiLight.groundColor.set(0x526071);
            }
            if (sceneLights.sunLight) sceneLights.sunLight.intensity = 1.75;
            if (sceneLights.fillLight) sceneLights.fillLight.intensity = 0.4;
        }
        if (scene) {
            scene.fog = new THREE.Fog(0x9cc6e8, 25, 650);
            if (skyTexture) {
                scene.background = skyTexture;
                scene.environment = skyTexture;
            }
        }
        if (renderer) {
            renderer.toneMappingExposure = 1.15;
        }
    }

    // Clear existing environment
    if (storeEnv.walls) {
        // Clear the existing bodies from the world, but keep the player body
        world.bodies.slice().forEach(body => {
            if (body !== playerBody) {
                world.removeBody(body);
            }
        });

        // Remove existing objects from the scene
        scene.children.forEach(child => {
            if (child.isMesh) {
                scene.remove(child);
            }
        });
    }

    // Reset per-layout collections
    shelves = [];
    shelfUnits = [];
    constructionZones = [];
    sampleBooths = [];
    clearCullableObjects();

    // Create store floor with configurable PBR textures
    const floorGeometry = new THREE.PlaneGeometry(60, 60);
    floorGeometry.setAttribute('uv2', floorGeometry.attributes.uv);

    const floorMaterial = createPBRMaterial({
        baseColorPath: 'uploads/SupermarketTile_BaseColor.png',
        normalPath: 'uploads/SupermarketTile_Normal_OpenGL.png',
        ormPath: 'uploads/SupermarketTile_ORM.png',
        repeatX: 14,
        repeatY: 14,
        defaultRoughness: 0.38,
        defaultMetalness: 0.05,
        bumpScale: 0.015
    });

    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // Add floor physics
    const floorShape = new CANNON.Plane();
    const floorBody = new CANNON.Body({
        mass: 0,
        shape: floorShape,
        material: new CANNON.Material('floorMaterial')
    });
    floorBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    world.addBody(floorBody);
    storeFloorBody = floorBody;

    // Create drop ceiling with configurable PBR textures
    const ceilingGeometry = new THREE.PlaneGeometry(60, 60);
    ceilingGeometry.setAttribute('uv2', ceilingGeometry.attributes.uv);

    const ceilingMaterial = createPBRMaterial({
        baseColorPath: 'uploads/DropCeiling_BaseColor.png',
        normalPath: 'uploads/DropCeiling_Normal_OpenGL.png',
        ormPath: 'uploads/DropCeiling_ORM.png',
        repeatX: 15,
        repeatY: 15,
        defaultRoughness: 0.65,
        defaultMetalness: 0.15,
        bumpScale: 0.015,
        side: THREE.DoubleSide
    });

    const ceiling = new THREE.Mesh(ceilingGeometry, ceilingMaterial);
    ceiling.position.y = CEILING_HEIGHT;
    ceiling.rotation.x = Math.PI / 2;
    ceiling.receiveShadow = true;
    ceiling.castShadow = false; // switched on during power outages (see updateStorePower)
    storeCeilingMesh = ceiling;
    scene.add(ceiling);

    // Create walls with windows
    createWalls();

    // Add exterior scenery (parking lot, trees, and cars) in front of the store entrance
    createExteriorScenery();

    // Create shelves using structured aisle positions
    shelves = [];
    shelfUnits = [];
    freezerUnits = [];
    allFreezerDoors = [];
    freezerDoorMeshesCache = [];
    activeGrabbedDoor = null;
    hoveredFreezerDoor = null;
    let shelvesCreated = 0;
    let replacedShelvesThisGame = 0;

    // The custom Random Vanilla choice uses the same per-run roll as normal games.
    const targetShelfCount = isCustomGame && !CONFIG.CUSTOM_RANDOM_SHELVES
        ? CONFIG.SHELF_COUNT
        : Math.floor(Math.random() * 10) + 5;

    const positions = planStoreShelves(targetShelfCount, ACTIVE_ITEMS, plus5PercentPercent(CONFIG.SHELF_REPLACE_CHANCE ?? 4), Math.random, usingAltItems);

    // 7% chance per game that 1 shelf is completely empty
    let emptyShelfIndex = -1;
    if (positions.length > 0 && Math.random() * 100 < plus5PercentPercent(CONFIG.EMPTY_SHELF_CHANCE ?? 7)) {
        emptyShelfEvent = true;
        emptyShelfIndex = Math.floor(Math.random() * Math.min(positions.length, targetShelfCount));
    } else {
        emptyShelfEvent = false;
    }

    const shelfWidth = SHELF_WIDTH;
    const shelfHeight = 4.8;
    const shelfDepth = 1.6;
    const shelfY = shelfHeight / 2; // = 2.4 -> sits flat on floor (Y = 0)

    positions.forEach((pos, idx) => {
        if (shelvesCreated >= targetShelfCount) return;
        const skipItemsOnThisShelf = (idx === emptyShelfIndex);
        // The per-shelf replacement rolls are retained; group their fixtures in
        // cold storage before creating bodies, doors and world-space stock.
        const isReplaced = pos.isFreezer;
        let unit;
        if (isReplaced) {
            replacedShelvesThisGame++;
            unit = createFreezerUnit(pos.x, shelfY, pos.z, shelfWidth, shelfHeight, shelfDepth, pos.dir, pos.rot, skipItemsOnThisShelf, pos.department, pos);
        } else {
            unit = createShelf(pos.x, shelfY, pos.z, shelfWidth, shelfHeight, shelfDepth, pos.dir, pos.rot, skipItemsOnThisShelf, pos.department, pos);
        }
        Object.assign(unit.userData, { aisle: pos.aisle, laneX: pos.laneX });
        shelvesCreated++;
    });

    // NEW: Possibly add an under-construction zone per game
    maybeCreateUnderConstructionZone();
    createFreeSampleBooth();

    // Update obstacle list for pathfinding
    obstacles = [...shelfUnits, ...constructionZones, ...sampleBooths];
    navGrid = buildNavGrid({ shelfUnits, constructionZones, sampleBooths, bounds: { minX: -28, maxX: 28, minZ: -28, maxZ: 28 }, cellSize: 0.5 });

    // Create checkout
    createCheckout();

    // Add store decorations
    createStoreDecorations();
    
    // Check for 2-in-1 item at the end of layout creation (if not in lonely store mode)
    if (!isLonelyStoreMode && (CONFIG.ENSURE_TWO_IN_ONE_ITEM || Math.random() * 100 < CONFIG.TWO_IN_ONE_ITEM_CHANCE)) {
        ensureTwoInOneItemExists();
    }
}

// NEW: Define store roaming zones to spread customers naturally
const ZONES = [
    { x: -20, z: -20, r: 10 }, { x: 0, z: -20, r: 10 }, { x: 20, z: -20, r: 10 },
    { x: -20, z: 0, r: 10 },   { x: 0, z: 0, r: 10 },   { x: 20, z: 0, r: 10 },
    { x: -20, z: 20, r: 10 },  { x: 0, z: 20, r: 10 },  { x: 20, z: 20, r: 10 },
];
function pickZone() { return ZONES[Math.floor(Math.random() * ZONES.length)]; }
function clampToStore(x, z) {
    return { x: THREE.MathUtils.clamp(x, -28, 28), z: THREE.MathUtils.clamp(z, -28, 28) };
}
function jitterAroundZone(zone, j = 6) {
    const px = zone.x + (Math.random() - 0.5) * j;
    const pz = zone.z + (Math.random() - 0.5) * j;
    const clamped = clampToStore(px, pz);
    return new THREE.Vector3(clamped.x, 0, clamped.z);
}
// Helper: find nearest shelf unit to a position
function nearestShelfUnitTo(x, z) {
    if (!shelfUnits.length) return null;
    let best = null, bd = Infinity;
    for (const u of shelfUnits) {
        const dx = u.position.x - x, dz = u.position.z - z;
        const d = dx*dx + dz*dz;
        if (d < bd) { bd = d; best = u; }
    }
    return best;
}
// Customer takes a random item from a shelf unit (visual/logical)
function customerTakeItemFromUnit(cust, unit) {
    if (!unit || !unit.userData || !unit.userData.items || !unit.userData.items.length) return false;
    // Only allow taking every 5–10s
    const now = performance.now();
    if (cust.analyzeCooldownUntil && now < cust.analyzeCooldownUntil) return false;

    // Pick an available item
    const candidates = unit.userData.items.filter(i => i && i.mesh && i.mesh.visible && i.isStatic &&
        !i.inCart && !i.stolen && !i.inCustomerCart && !i.isCustomerHeld);
    if (!candidates.length) return false;
    const item = candidates[Math.floor(Math.random() * candidates.length)];

    // If this customer has a cart, snap item into their cart instead of hand
    if (cust.hasCart && cust.cart && cust.cart.slots && cust.cart.group) {
        try {
            // Remove physics and scene parent
            if (item.body) { try { world.removeBody(item.body); } catch(_) {} item.body = null; }
            if (item.mesh.parent) item.mesh.parent.remove(item.mesh);

            // Pick a free slot or append into a random slot index
            let slotIdx = cust.cart.items.length % cust.cart.slots.length;
            const slot = cust.cart.slots[slotIdx] || { x: 0, y: 0.6, z: 0 };
            // Place item inside the cart (local space)
            item.mesh.position.set(slot.x + (Math.random()*0.08-0.04), slot.y, slot.z + (Math.random()*0.08-0.04));
            item.mesh.rotation.set(0, Math.random()*Math.PI*2, 0);
            // Slight downscale to fit
            try { item.mesh.scale.multiplyScalar(0.85); } catch(_) {}

            // Attach to cart group and mark flags to exclude from gameplay interaction
            cust.cart.group.add(item.mesh);
            item.inCustomerCart = true;
            item.isStatic = true;

            // Track in customer's cart inventory
            cust.cart.items.push(item);

            // Cooldown 5–10 seconds
            cust.analyzeCooldownUntil = now + (5000 + Math.random() * 5000);
        } catch (_) {}
        return true;
    }

    // Default behavior: carry in hand (non-cart customers)
    try {
        if (cust.handItem) {
            if (cust.handItem.mesh && cust.handItem.mesh.parent) cust.handItem.mesh.parent.remove(cust.handItem.mesh);
            if (cust.handItem.body && world) { try { world.removeBody(cust.handItem.body); } catch(_) {} }
            cust.handItem = null;
        }
        if (item.body) { try { world.removeBody(item.body); } catch(_) {} item.body = null; }
        if (item.mesh.parent) item.mesh.parent.remove(item.mesh);
        // Slight downscale for hand-carry look
        item.mesh.scale.multiplyScalar(0.8);
        // Hand position (front of torso)
        item.mesh.position.set(0, 1.0, 0.35);
        item.mesh.rotation.set(0, Math.PI / 12, 0);
        cust.add(item.mesh);
        item.isCustomerHeld = true;
        item.isStatic = true;
        cust.handItem = item;
        cust.analyzeCooldownUntil = now + (5000 + Math.random() * 5000);
    } catch (_) {}
    return true;
}
// Customer carried item handling
function customerForceDropCarriedItem(cust) {
    if (!cust || !cust.handItem) return;
    const item = cust.handItem;
    if (item.mesh && item.mesh.parent) {
        item.mesh.parent.remove(item.mesh);
    }
    if (item.body && world) {
        try { world.removeBody(item.body); } catch(_) {}
    }
    cust.handItem = null;
    cust.hasStolenItem = false;
}

function customerMaybeDropCarriedItem(cust) {
    // Disabled: customers no longer drop items randomly while navigating
}

function findSocialScufflePair() {
    for (const customer of customers) {
        const partner = customer.socialPartner;
        if (customer.behaviorState === 'socializing' && partner?.behaviorState === 'socializing' &&
            partner.socialPartner === customer && customer.visible !== false && partner.visible !== false &&
            customer.body && partner.body) return [customer, partner];
    }
    return null;
}

function triggerCustomerScuffle() {
    if (!gameStarted || isCheckout || gameOver || isLonelyStoreMode) return false;
    const pair = !activeCustomerScuffle && findSocialScufflePair();
    if (pair) return startCustomerScuffle(...pair);
    // A conversation may not be happening at the exact moment the roll arrives.
    // Hold the successful roll until the next real customer conversation.
    customerScufflePending = true;
    return true;
}

function addScuffleAnger(customer) {
    const browMaterial = new THREE.MeshBasicMaterial({ color: 0x290909 });
    const browGeometry = new THREE.BoxGeometry(0.13, 0.027, 0.018);
    customer.scuffleBrows = [-1, 1].map(side => {
        const brow = new THREE.Mesh(browGeometry, browMaterial);
        brow.position.set(side * 0.105, 0.115, 0.185);
        brow.rotation.z = side * 0.42;
        customer.head.add(brow);
        return brow;
    });
    const points = [];
    for (let i = 0; i <= 34; i++) {
        points.push(new THREE.Vector3(
            Math.sin(i * 1.48) * 0.25,
            Math.cos(i * 1.13) * 0.12,
            Math.sin(i * 0.81) * 0.16
        ));
    }
    const scribble = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color: 0xff283c, depthTest: false, depthWrite: false })
    );
    scribble.position.y = 2.35;
    scribble.renderOrder = 5;
    customer.add(scribble);
    customer.scuffleScribble = scribble;
}

function clearScuffleAnger(customer) {
    if (customer.scuffleBrows) {
        customer.scuffleBrows.forEach(brow => brow.removeFromParent());
        customer.scuffleBrows[0]?.geometry.dispose();
        customer.scuffleBrows[0]?.material.dispose();
        customer.scuffleBrows = null;
    }
    if (customer.scuffleScribble) {
        customer.scuffleScribble.removeFromParent();
        customer.scuffleScribble.geometry.dispose();
        customer.scuffleScribble.material.dispose();
        customer.scuffleScribble = null;
    }
}

function startCustomerScuffle(first, second) {
    if (activeCustomerScuffle || !first?.body || !second?.body || !gameStarted || isCheckout || gameOver) return false;
    customerScufflePending = false;
    const now = performance.now();
    activeCustomerScuffle = { participants: [first, second], remaining: 30000 };
    customerScuffleCount++;
    for (const [customer, partner] of [[first, second], [second, first]]) {
        customer.behaviorState = 'scuffling';
        customer.scufflePartner = partner;
        customer.scufflePlan = null;
        customer.scuffleHeldItem = null;
        customer.socialPartner = null;
        customer.nextScuffleThrowAt = now + 250 + Math.random() * 700;
        customer.fleeUntil = 0;
        customer.body.velocity.x = 0;
        customer.body.velocity.z = 0;
        addScuffleAnger(customer);
    }
    displayMessage("💢 Two customers are fighting and throwing groceries!", 4200, true);
    if (!customerScuffleMusic) {
        customerScuffleMusic = new Audio('20260418_Mii Fight - Tomodachi Life： Living the Dream [OST].wav');
        registerMusic(customerScuffleMusic);
        customerScuffleMusic.loop = true;
    }
    customerScuffleMusic.volume = 0;
    customerScuffleMusic.muted = musicMuted;
    customerScuffleMusic.currentTime = 0;
    customerScuffleMusic.play().catch(() => {});
    return true;
}

function updateCustomerScuffleMusic(delta) {
    let targetMix = 0;
    if (activeCustomerScuffle && playerBody) {
        const distance = Math.min(...activeCustomerScuffle.participants.map(customer =>
            Math.hypot(playerBody.position.x - customer.body.position.x,
                playerBody.position.z - customer.body.position.z)));
        // Within six metres only the fight is heard; it fades out across
        // the rest of the store while the normal music fades back in.
        const t = Math.max(0, Math.min(1, (distance - 6) / 28));
        targetMix = 1 - t * t * (3 - 2 * t);
    }
    if (targetMix === 1) {
        customerScuffleMusicMix = 1;
    } else {
        const fade = 1 - Math.exp(-Math.min(delta, 0.1) * 3.5);
        customerScuffleMusicMix += (targetMix - customerScuffleMusicMix) * fade;
        if (!activeCustomerScuffle && customerScuffleMusicMix < 0.005) {
            customerScuffleMusicMix = 0;
            if (customerScuffleMusic && !customerScuffleMusic.paused) {
                customerScuffleMusic.pause();
                customerScuffleMusic.currentTime = 0;
            }
        }
    }
    if (music) music.volume = CONFIG.MUSIC_VOLUME * (1 - customerScuffleMusicMix);
    if (customerScuffleMusic) customerScuffleMusic.volume = CONFIG.MUSIC_VOLUME * customerScuffleMusicMix;
}

function endCustomerScuffle(reset = false) {
    if (activeCustomerScuffle) {
        const now = performance.now();
        for (const customer of activeCustomerScuffle.participants) {
            clearScuffleAnger(customer);
            if (customer.scuffleHeldItem && scene && world) {
                dropMeshItemToFloor(customer.scuffleHeldItem, customer.body.position.x, customer.body.position.z);
            }
            customer.scuffleHeldItem = null;
            customer.scufflePlan = null;
            customer.scufflePartner = null;
            if (customer.behaviorState === 'scuffling') {
                customer.behaviorState = 'navigating';
                customer.socialCooldownUntil = now + 20000;
                if (customer.head) customer.head.rotation.set(0, 0, 0);
                if (!reset && gameStarted && !gameOver) setCustomerTarget(customer);
            }
        }
        activeCustomerScuffle = null;
    }
    if (reset) {
        customerScuffleMusicMix = 0;
        if (music) music.volume = CONFIG.MUSIC_VOLUME;
        if (customerScuffleMusic) {
            customerScuffleMusic.pause();
            customerScuffleMusic.currentTime = 0;
            customerScuffleMusic.volume = 0;
        }
        customerScufflePending = false;
        customerScuffleProjectiles = [];
    } else if (gameStarted && !gameOver && !isLonelyStoreMode && !powerOutage && !gamePaused && !isCheckout) {
        music?.play().catch(() => {});
    }
}

function chooseScuffleItem(customer) {
    const otherPlan = customer.scufflePartner?.scufflePlan;
    const nearby = (item, radius = 20, playerCart = false) => {
        if (!item?.mesh || !item.mesh.parent || item.mesh.visible === false ||
            item.stolen || item.outOfStock || item.isTwoInOne || item === heldItem ||
            (!playerCart && item.inCart) || otherPlan?.item === item ||
            customerScuffleProjectiles.some(projectile => projectile.item === item)) return false;
        const pos = new THREE.Vector3();
        item.mesh.getWorldPosition(pos);
        return Math.hypot(pos.x - customer.body.position.x, pos.z - customer.body.position.z) < radius;
    };
    const ground = allItems.filter(item => nearby(item) && !item.inCustomerCart && !item.isCustomerHeld &&
        !item.isStatic && item.body?.type === CANNON.Body.DYNAMIC).map(item => ({ item, kind: 'ground' }));
    const carts = customers.flatMap(owner =>
        owner.visible !== false && owner.cart?.group?.visible !== false
            ? owner.cart?.items?.filter(item => nearby(item) && item.inCustomerCart)
                .map(item => ({ item, kind: 'customer_cart', owner })) || []
            : []);
    if (cartObject?.visible && !purchaseComplete) {
        carts.push(...collectedItems.filter(item => nearby(item, 25, true) && item.inCart)
            .map(item => ({ item, kind: 'player_cart' })));
    }
    const shelves = allItems.filter(item => nearby(item, 30) && item.isStatic &&
        !item.inCustomerCart && !item.isCustomerHeld).map(item => ({ item, kind: 'shelf' }));
    const roll = Math.random();
    const pools = roll < 0.62 ? [ground, carts, shelves] :
        roll < 0.92 ? [carts, ground, shelves] : [shelves, ground, carts];
    for (const pool of pools) {
        if (pool.length) {
            // Prefer sources close enough to reach and still have time to throw.
            const ranked = pool.map(selection => {
                const pos = getScuffleSourcePosition(selection);
                return { selection, distance: Math.hypot(pos.x - customer.body.position.x,
                    pos.z - customer.body.position.z) };
            }).sort((a, b) => a.distance - b.distance);
            return ranked[Math.floor(Math.random() * Math.min(7, ranked.length))].selection;
        }
    }
    return null;
}

function getScuffleSourcePosition(selection) {
    const position = new THREE.Vector3();
    if (selection.kind === 'player_cart') {
        cartObject.getWorldPosition(position);
    } else if (selection.kind === 'customer_cart') {
        selection.owner.cart.group.getWorldPosition(position);
    } else {
        selection.item.mesh.getWorldPosition(position);
    }
    return position;
}

function scuffleSourceAvailable(selection) {
    const item = selection.item;
    if (!item?.mesh?.parent || !item.mesh.visible || item.stolen || item.outOfStock ||
        item === heldItem || Boolean(item.inCart) !== (selection.kind === 'player_cart')) return false;
    if (selection.kind === 'player_cart') return collectedItems.includes(item) && cartObject?.visible;
    if (selection.kind === 'customer_cart') return selection.owner.visible !== false &&
        selection.owner.cart?.group?.visible !== false &&
        selection.owner.cart?.items.includes(item) && item.inCustomerCart;
    if (selection.kind === 'shelf') return item.isStatic && !item.inCustomerCart && !item.isCustomerHeld;
    return !item.isStatic && item.body?.type === CANNON.Body.DYNAMIC && !item.inCustomerCart;
}

function acquireScuffleItem(customer, selection) {
    if (!scuffleSourceAvailable(selection)) return false;
    const item = selection.item;
    if (selection.kind === 'player_cart') {
        const index = collectedItems.indexOf(item);
        collectedItems.splice(index, 1);
        item.inCart = false;
        const entry = shoppingList.find(row => row.name === item.name && row.collected > 0);
        if (entry) entry.collected--;
        else wrongItemsGrabbedCount = Math.max(0, wrongItemsGrabbedCount - 1);
        updateShoppingListDisplay();
        refreshGumCravingState();
        displayMessage(`💢 A scuffling customer grabbed ${item.name} from your cart!`, 2600, true);
    } else if (selection.kind === 'customer_cart') {
        const items = selection.owner.cart.items;
        items.splice(items.indexOf(item), 1);
    }
    if (item.body) { try { world.removeBody(item.body); } catch (_) {} }
    item.body = null;
    item.mesh.removeFromParent();
    customer.add(item.mesh);
    item.mesh.position.set(0, 1.1, 0.4);
    item.mesh.rotation.set(0, 0, 0);
    item.isStatic = true;
    item.inCustomerCart = false;
    item.isCustomerHeld = true;
    customer.scuffleHeldItem = item;
    return true;
}

function navigateScufflingCustomer(customer, target, reach, now) {
    const plan = customer.scufflePlan;
    const body = customer.body;
    const distance = Math.hypot(target.x - body.position.x, target.z - body.position.z);
    if (distance <= reach) {
        body.velocity.x = 0;
        body.velocity.z = 0;
        return true;
    }
    if (!plan.path || now >= plan.repathAt ||
        Math.hypot(target.x - plan.pathGoal.x, target.z - plan.pathGoal.z) > 1.1) {
        const goal = navGrid ? clampToWalkable(navGrid, target.x, target.z) : { x: target.x, z: target.z };
        const path = navGrid ? findPath(navGrid,
            { x: body.position.x, z: body.position.z }, goal) : null;
        plan.path = path?.length ? path : [goal];
        plan.waypointIdx = 0;
        plan.pathGoal = { x: target.x, z: target.z };
        plan.repathAt = now + 650;
    }
    while (plan.waypointIdx < plan.path.length - 1 &&
        Math.hypot(plan.path[plan.waypointIdx].x - body.position.x,
            plan.path[plan.waypointIdx].z - body.position.z) < 0.7) plan.waypointIdx++;
    const waypoint = plan.path[plan.waypointIdx];
    const dx = waypoint.x - body.position.x;
    const dz = waypoint.z - body.position.z;
    const length = Math.hypot(dx, dz);
    if (length > 0.18) {
        const speed = Math.max(2.3, customer.walkSpeed * 1.65);
        body.velocity.x = dx / length * speed;
        body.velocity.z = dz / length * speed;
    } else {
        body.velocity.x = 0;
        body.velocity.z = 0;
    }
    return false;
}

function throwScuffleItem(customer, target) {
    const item = customer.scuffleHeldItem;
    if (!item) return;
    customer.scuffleHeldItem = null;
    if (item.body) { try { world.removeBody(item.body); } catch (_) {} }
    item.mesh.removeFromParent();
    scene.add(item.mesh);
    const dx = target.body.position.x - customer.body.position.x + (Math.random() - 0.5) * 1.1;
    const dz = target.body.position.z - customer.body.position.z + (Math.random() - 0.5) * 1.1;
    const distance = Math.max(0.1, Math.hypot(dx, dz));
    const shape = new CANNON.Box(new CANNON.Vec3(
        Math.max(0.06, item.size[0] / 2), Math.max(0.06, item.size[1] / 2), Math.max(0.06, item.size[2] / 2)
    ));
    const body = new CANNON.Body({ mass: 0.5, shape });
    body.position.set(
        customer.body.position.x + dx / distance * 0.65,
        1.55,
        customer.body.position.z + dz / distance * 0.65
    );
    body.velocity.set(dx / 0.72, 2.1, dz / 0.72);
    body.collisionFilterGroup = 2;
    body.collisionFilterMask = 1 | 2 | 4;
    world.addBody(body);
    item.body = body;
    item.mesh.position.copy(body.position);
    item.inCustomerCart = false;
    item.isCustomerHeld = false;
    item.isStatic = false;
    item.inCart = false;
    item.isDropping = false;
    item.hasLanded = true;
    customerScuffleProjectiles.push({ item, startedAt: performance.now() });
}

const _scuffleLocal = new THREE.Vector3();
function updateCustomerScuffle(now, delta) {
    if (activeCustomerScuffle && !gamePaused && !isCheckout) {
        activeCustomerScuffle.remaining -= delta * 1000;
        if (activeCustomerScuffle.remaining <= 0) {
            endCustomerScuffle();
        } else {
            for (const customer of activeCustomerScuffle.participants) {
                if (customer.scuffleScribble) {
                    customer.scuffleScribble.rotation.y += delta * 5;
                    customer.scuffleScribble.scale.setScalar(1 + Math.sin(now * 0.018) * 0.13);
                }
                if (!customer.scufflePlan && now >= customer.nextScuffleThrowAt) {
                    const selection = chooseScuffleItem(customer);
                    if (selection) {
                        const source = getScuffleSourcePosition(selection);
                        const distance = Math.hypot(source.x - customer.body.position.x,
                            source.z - customer.body.position.z);
                        customer.scufflePlan = {
                            selection, item: selection.item, phase: 'seeking',
                            elapsed: 0, maxSeekMs: Math.min(18000, 5000 + distance * 600),
                            path: null
                        };
                    } else {
                        customer.nextScuffleThrowAt = now + 1100;
                    }
                }
                const plan = customer.scufflePlan;
                if (!plan) {
                    customer.body.velocity.x = 0;
                    customer.body.velocity.z = 0;
                    continue;
                }
                plan.elapsed += delta * 1000;
                if (plan.phase === 'seeking') {
                    if (!scuffleSourceAvailable(plan.selection) || plan.elapsed > plan.maxSeekMs) {
                        customer.scufflePlan = null;
                        customer.nextScuffleThrowAt = now + 300;
                        continue;
                    }
                    const source = getScuffleSourcePosition(plan.selection);
                    const reach = plan.selection.kind === 'shelf' ? 2.6 :
                        plan.selection.kind === 'ground' ? 1.35 : 2.1;
                    if (navigateScufflingCustomer(customer, source, reach, now)) {
                        if (acquireScuffleItem(customer, plan.selection)) {
                            plan.phase = 'chasing';
                            plan.elapsed = 0;
                            plan.path = null;
                            customer.nextScuffleThrowAt = now + 240;
                        } else {
                            customer.scufflePlan = null;
                            customer.nextScuffleThrowAt = now + 300;
                        }
                    }
                } else if (customer.scufflePartner?.body) {
                    const partner = customer.scufflePartner;
                    if (navigateScufflingCustomer(customer, partner.body.position, 3.4, now) &&
                        now >= customer.nextScuffleThrowAt) {
                        throwScuffleItem(customer, partner);
                        customer.scufflePlan = null;
                        customer.nextScuffleThrowAt = now + 550 + Math.random() * 350;
                    } else if (plan.elapsed > 8000) {
                        // Don't keep an item hostage if the other customer gets stuck.
                        dropMeshItemToFloor(customer.scuffleHeldItem, customer.body.position.x, customer.body.position.z);
                        customer.scuffleHeldItem = null;
                        customer.scufflePlan = null;
                        customer.nextScuffleThrowAt = now + 450;
                    }
                }
            }
        }
    }
    updateCustomerScuffleMusic(delta);
    const cartCatchActive = !!(cart3D && cartObject?.visible && gameStarted && !isCheckout);
    if (cartCatchActive && customerScuffleProjectiles.length) cart3D.updateWorldMatrix(true, false);
    for (let i = customerScuffleProjectiles.length - 1; i >= 0; i--) {
        const { item, startedAt } = customerScuffleProjectiles[i];
        if (!item.body || item.inCart) {
            customerScuffleProjectiles.splice(i, 1);
            continue;
        }
        // The same cart placement path as a manually dropped item updates
        // inventory, shopping list progress, and gum craving.
        if (cartCatchActive) {
            const local = cart3D.worldToLocal(_scuffleLocal.set(item.body.position.x, item.body.position.y, item.body.position.z));
            if (Math.abs(local.x) < CartPhys.CART_BASKET.halfW && Math.abs(local.z) < CartPhys.CART_BASKET.halfL &&
                local.y > CartPhys.CART_BASKET.floorY - 0.05 && local.y < CartPhys.CART_BASKET.rimY + 0.3) {
                catchItemInCart(item, local);
                displayMessage(`💥 A flying ${item.name} landed in your cart!`, 2400, true);
                customerScuffleProjectiles.splice(i, 1);
                continue;
            }
        }
        if (now - startedAt > 4000 || (now - startedAt > 450 && item.body.position.y < 0.32 && item.body.velocity.y <= 0)) {
            customerScuffleProjectiles.splice(i, 1);
        }
    }
}

// Cached master cart geometry merging 60+ components into a single multi-material BufferGeometry
let cachedMasterCartGeometry = null;

function getMasterCartGeometry() {
    if (cachedMasterCartGeometry) return cachedMasterCartGeometry;

    const makeTransformedBox = (w, h, d, px, py, pz, rx = 0, ry = 0, rz = 0) => {
        const g = new THREE.BoxGeometry(w, h, d);
        if (rx !== 0) g.rotateX(rx);
        if (ry !== 0) g.rotateY(ry);
        if (rz !== 0) g.rotateZ(rz);
        g.translate(px, py, pz);
        return g;
    };
    const makeTransformedCylinder = (rt, rb, h, segs, px, py, pz, rx = 0, ry = 0, rz = 0) => {
        const g = new THREE.CylinderGeometry(rt, rb, h, segs);
        if (rx !== 0) g.rotateX(rx);
        if (ry !== 0) g.rotateY(ry);
        if (rz !== 0) g.rotateZ(rz);
        g.translate(px, py, pz);
        return g;
    };
    const makeTransformedSphere = (r, ws, hs, px, py, pz) => {
        const g = new THREE.SphereGeometry(r, ws, hs);
        g.translate(px, py, pz);
        return g;
    };

    const chromeWireGeoms = [];
    const accentGeoms = [];
    const darkMetalGeoms = [];
    const wheelGeoms = [];

    // --- 1. Basket Bottom Wire Grid / Tray ---
    chromeWireGeoms.push(makeTransformedBox(0.74, 0.015, 1.10, 0, 0.35, 0));

    // Longitudinal floor wires
    for (let x = -0.32; x <= 0.32; x += 0.08) {
        chromeWireGeoms.push(makeTransformedCylinder(0.004, 0.004, 1.08, 6, x, 0.358, 0, Math.PI / 2, 0, 0));
    }
    // Transversal floor wires
    for (let z = -0.50; z <= 0.50; z += 0.10) {
        chromeWireGeoms.push(makeTransformedCylinder(0.004, 0.004, 0.72, 6, 0, 0.362, z, 0, 0, Math.PI / 2));
    }

    // --- 2. Top Rim Frame ---
    const topRimY = 0.92;
    const botRimY = 0.35;
    const halfW = 0.36;
    const halfL = 0.54;
    const postY = (topRimY + botRimY) / 2;

    chromeWireGeoms.push(makeTransformedCylinder(0.012, 0.012, 1.08, 8, -halfW, topRimY, 0, Math.PI / 2, 0, 0));
    chromeWireGeoms.push(makeTransformedCylinder(0.012, 0.012, 1.08, 8, halfW, topRimY, 0, Math.PI / 2, 0, 0));
    chromeWireGeoms.push(makeTransformedCylinder(0.012, 0.012, 0.72, 8, 0, topRimY, halfL, 0, 0, Math.PI / 2));
    chromeWireGeoms.push(makeTransformedCylinder(0.012, 0.012, 0.72, 8, 0, topRimY, -halfL, 0, 0, Math.PI / 2));

    // 4 Corner Posts & Caps
    const corners = [
        [-halfW, -halfL],
        [halfW, -halfL],
        [-halfW, halfL],
        [halfW, halfL]
    ];
    corners.forEach(([cx, cz]) => {
        chromeWireGeoms.push(makeTransformedCylinder(0.012, 0.012, topRimY - botRimY, 8, cx, postY, cz));
        accentGeoms.push(makeTransformedSphere(0.02, 8, 8, cx, topRimY, cz));
    });

    // --- 3. Wire Perimeter Walls ---
    const hoopYLevels = [0.46, 0.58, 0.70, 0.82];
    hoopYLevels.forEach(hy => {
        chromeWireGeoms.push(makeTransformedCylinder(0.005, 0.005, 1.08, 6, -halfW, hy, 0, Math.PI / 2, 0, 0));
        chromeWireGeoms.push(makeTransformedCylinder(0.005, 0.005, 1.08, 6, halfW, hy, 0, Math.PI / 2, 0, 0));
        chromeWireGeoms.push(makeTransformedCylinder(0.005, 0.005, 0.72, 6, 0, hy, halfL, 0, 0, Math.PI / 2));
        chromeWireGeoms.push(makeTransformedCylinder(0.005, 0.005, 0.72, 6, 0, hy, -halfL, 0, 0, Math.PI / 2));
    });

    // Vertical wire ribs
    for (let vz = -0.45; vz <= 0.45; vz += 0.09) {
        chromeWireGeoms.push(makeTransformedCylinder(0.004, 0.004, topRimY - botRimY, 6, -halfW, postY, vz));
        chromeWireGeoms.push(makeTransformedCylinder(0.004, 0.004, topRimY - botRimY, 6, halfW, postY, vz));
    }
    for (let vx = -0.27; vx <= 0.27; vx += 0.09) {
        chromeWireGeoms.push(makeTransformedCylinder(0.004, 0.004, topRimY - botRimY, 6, vx, postY, halfL));
        chromeWireGeoms.push(makeTransformedCylinder(0.004, 0.004, topRimY - botRimY, 6, vx, postY, -halfL));
    }

    // --- 4. Cart Handle & Struts ---
    accentGeoms.push(makeTransformedCylinder(0.026, 0.026, 0.76, 12, 0, 0.96, -0.72, 0, 0, Math.PI / 2));
    darkMetalGeoms.push(makeTransformedCylinder(0.028, 0.028, 0.06, 10, -0.36, 0.96, -0.72, 0, 0, Math.PI / 2));
    darkMetalGeoms.push(makeTransformedCylinder(0.028, 0.028, 0.06, 10, 0.36, 0.96, -0.72, 0, 0, Math.PI / 2));

    chromeWireGeoms.push(makeTransformedCylinder(0.014, 0.014, 0.38, 8, -0.36, 0.82, -0.63, -0.55, 0, 0));
    chromeWireGeoms.push(makeTransformedCylinder(0.014, 0.014, 0.38, 8, 0.36, 0.82, -0.63, -0.55, 0, 0));

    // --- 5. Lower Undercarriage Chassis & Wheels ---
    darkMetalGeoms.push(makeTransformedBox(0.68, 0.02, 0.90, 0, 0.16, 0));

    chromeWireGeoms.push(makeTransformedCylinder(0.014, 0.014, 0.20, 8, -0.32, 0.25, 0.40));
    chromeWireGeoms.push(makeTransformedCylinder(0.014, 0.014, 0.20, 8, 0.32, 0.25, 0.40));
    chromeWireGeoms.push(makeTransformedCylinder(0.014, 0.014, 0.20, 8, -0.32, 0.25, -0.40));
    chromeWireGeoms.push(makeTransformedCylinder(0.014, 0.014, 0.20, 8, 0.32, 0.25, -0.40));

    const wheelPositions = [
        [-0.34, 0.085, 0.42],
        [0.34, 0.085, 0.42],
        [-0.34, 0.085, -0.42],
        [0.34, 0.085, -0.42]
    ];
    wheelPositions.forEach(([wx, wy, wz]) => {
        darkMetalGeoms.push(makeTransformedBox(0.06, 0.08, 0.06, wx, wy + 0.04, wz));
        wheelGeoms.push(makeTransformedCylinder(0.085, 0.085, 0.05, 12, wx, 0.085, wz, 0, 0, Math.PI / 2));
    });

    const mChromeWire = BufferGeometryUtils.mergeGeometries(chromeWireGeoms, false);
    const mAccent = BufferGeometryUtils.mergeGeometries(accentGeoms, false);
    const mDarkMetal = BufferGeometryUtils.mergeGeometries(darkMetalGeoms, false);
    const mWheels = BufferGeometryUtils.mergeGeometries(wheelGeoms, false);

    cachedMasterCartGeometry = BufferGeometryUtils.mergeGeometries([mChromeWire, mAccent, mDarkMetal, mWheels], true);

    chromeWireGeoms.forEach(g => g.dispose());
    accentGeoms.forEach(g => g.dispose());
    darkMetalGeoms.forEach(g => g.dispose());
    wheelGeoms.forEach(g => g.dispose());
    mChromeWire.dispose();
    mAccent.dispose();
    mDarkMetal.dispose();
    mWheels.dispose();

    return cachedMasterCartGeometry;
}

// Helper to build an authentic hollow wire supermarket cart model merged into a single BufferGeometry
function buildWireCartGroup(cartColor = CONFIG.CART_COLOR || 0xD32F2F, skin = null, scale = 1) {
    const cart3D = new THREE.Group();
    // Model parts live in a scaled subgroup; items placed in cart3D keep their own size.
    const visual = new THREE.Group();
    visual.scale.setScalar(scale);
    cart3D.add(visual);
    cart3D.userData.visual = visual;
    const masterGeo = getMasterCartGeometry();

    const chromeMaterial = new THREE.MeshStandardMaterial({ 
        color: 0xd8d8d8, 
        roughness: 0.2, 
        metalness: 0.85 
    });
    const cartMaterial = new THREE.MeshStandardMaterial({ 
        color: cartColor, 
        roughness: 0.35, 
        metalness: 0.2 
    });
    const darkMetalMaterial = new THREE.MeshStandardMaterial({ 
        color: 0x444444, 
        roughness: 0.5, 
        metalness: 0.7 
    });
    applyCartFinish([chromeMaterial, cartMaterial, darkMetalMaterial], cartColor, null);
    const wheelMaterial = new THREE.MeshStandardMaterial({ 
        color: 0x1a1a1a, 
        roughness: 0.85 
    });

    const mesh = new THREE.Mesh(masterGeo, [chromeMaterial, cartMaterial, darkMetalMaterial, wheelMaterial]);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    visual.add(mesh);

    // Invisible solid occlusion hull (5 basket walls + chassis) so rays cannot pass through cart walls/bottom
    const occMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
    
    // Basket bottom
    const bBot = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.12, 1.05), occMat);
    bBot.position.set(0, 0.34, 0.05);
    // Basket front
    const bFront = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.60, 0.10), occMat);
    bFront.position.set(0, 0.65, 0.52);
    // Basket back
    const bBack = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.60, 0.10), occMat);
    bBack.position.set(0, 0.65, -0.44);
    // Basket left
    const bLeft = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.60, 1.05), occMat);
    bLeft.position.set(-0.35, 0.65, 0.05);
    // Basket right
    const bRight = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.60, 1.05), occMat);
    bRight.position.set(0.35, 0.65, 0.05);
    // Lower tray & wheels chassis
    const bChassis = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.32, 1.10), occMat);
    bChassis.position.set(0, 0.16, 0.05);

    const occGroup = new THREE.Group();
    occGroup.add(bBot, bFront, bBack, bLeft, bRight, bChassis);
    visual.add(occGroup);
    cart3D.userData.occlusionHull = occGroup;
    if (skin) applyCartSkin(visual, cartColor, skin);
    if (isCustomGame) visual.add(buildCartQuarterSlot());

    return cart3D;
}

document.addEventListener('shop:cart-skin-change', () => {
    applyCartSkin(cart3D?.userData.visual || cart3D, CONFIG.CART_COLOR || 0xD32F2F, equippedCartSkin());
});

// Create an identical detailed wire cart model and physics for a customer
const NPC_CART_FOLLOW_OFFSET = 0.33 + 0.72 * CartPhys.CART_SCALE;

function npcCartHeading(cust) {
    // The customer's quaternion is authoritative; XYZ Euler Y folds beyond ±90°.
    const q = cust.quaternion;
    return Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y));
}

function createNpcCartForCustomer(cust) {
    const scale = CartPhys.CART_SCALE;
    const group = buildWireCartGroup(CONFIG.CART_COLOR || 0xD32F2F, null, scale);
    const facing = npcCartHeading(cust);
    group.position.set(cust.body.position.x + Math.sin(facing) * NPC_CART_FOLLOW_OFFSET, 0, cust.body.position.z + Math.cos(facing) * NPC_CART_FOLLOW_OFFSET);
    group.rotation.y = facing;
    scene.add(group);

    // Kinematic physics body for collisions (ignore own customer)
    const shape = new CANNON.Box(new CANNON.Vec3(0.4 * scale, 0.45 * scale, 0.6 * scale));
    const body = new CANNON.Body({ mass: 0, shape });
    body.collisionFilterGroup = 8;
    body.collisionFilterMask = 1 | 2 | 8;
    body.position.set(group.position.x, 0.45 * scale, group.position.z);
    body.quaternion.setFromEuler(0, facing, 0);
    world.addBody(body);

    // Precompute slots inside cart (local coordinates inside hollow basket)
    const slots = [];
    const rows = 3, cols = 2;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const lx = -0.18 + c * 0.36;
            const lz = -0.32 + r * 0.32;
            const ly = 0.45 + (Math.random()*0.05 - 0.025);
            slots.push({ x: lx * scale, y: ly * scale, z: lz * scale });
        }
    }

    return { group, body, slots, items: [], wobblePhase: Math.random()*Math.PI*2 };
}

// The shopper already smooths its heading; keep the handle rigidly in front of them.
function updateNpcCartFollow(cust, delta) {
    if (!cust.hasCart || !cust.cart || !cust.body) return;
    const velx = cust.body.velocity.x, velz = cust.body.velocity.z;
    const speed = Math.hypot(velx, velz);
    
    const facing = npcCartHeading(cust);
    const offset = NPC_CART_FOLLOW_OFFSET; // keep the scaled handle 0.33m in front
    const targetX = cust.body.position.x + Math.sin(facing) * offset;
    const targetZ = cust.body.position.z + Math.cos(facing) * offset;
    const targetY = 0; // ground

    // Independent position/yaw lerps let the shopper turn away and drag the cart sideways.
    const g = cust.cart.group;
    g.position.set(targetX, targetY, targetZ);
    g.rotation.y = facing;

    // Subtle tilt when moving
    g.rotation.x = -Math.min(0.08, speed * 0.03);
    // Idle wobble
    if (speed < 0.05) {
        cust.cart.wobblePhase = (cust.cart.wobblePhase || 0) + (delta || 0.016) * 2;
        g.rotation.z = Math.sin(cust.cart.wobblePhase) * 0.015;
    } else {
        g.rotation.z = 0;
    }

    // Sync physics body directly
    if (cust.cart.body) {
        cust.cart.body.position.set(g.position.x, 0.45 * CartPhys.CART_SCALE, g.position.z);
        cust.cart.body.quaternion.setFromEuler(0, facing, 0);
        cust.cart.body.aabbNeedsUpdate = true;
    }
}

// Exterior scenery: realistic commercial plaza, grand shopping mall complex in the distance,
// urban city skyline, clean tree-free blacktop, terraced long-drop valley, and one majestic staple mountain.
function createExteriorScenery() {
    const buildingHalf = 30; // store interior spans -30..30 in X/Z
    const sidewalkWidth = 6.5;
    const curbHeight = 0.18;
    const curbWidth = 0.35;

    // ---- Shared PBR & procedural materials ----
    // 1. High-fidelity seamless asphalt
    const asphaltTex = (() => {
        const c = document.createElement('canvas');
        c.width = 512; c.height = 512;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#2d3136';
        ctx.fillRect(0, 0, 512, 512);
        // Deterministic asphalt speckling (no Math.random)
        let seed = 1234567;
        const lcg = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
        for (let i = 0; i < 9000; i++) {
            const v = 35 + lcg() * 55;
            ctx.fillStyle = `rgba(${v},${v},${v + 5},${0.15 + lcg() * 0.25})`;
            const s = 1 + lcg() * 2.5;
            ctx.fillRect(lcg() * 512, lcg() * 512, s, s);
        }
        const t = new THREE.CanvasTexture(c);
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(24, 24);
        t.colorSpace = THREE.SRGBColorSpace;
        return t;
    })();
    const asphaltMat = new THREE.MeshStandardMaterial({ map: asphaltTex, roughness: 0.95, metalness: 0.05 });

    // 2. Concrete sidewalk full configurable PBR materials (from uploaded high-res maps)
    const sidewalkMat = createPBRMaterial({
        baseColorPath: 'uploads/Sidewalk_BaseColor_1k.jpg',
        normalPath: 'uploads/Sidewalk_Normal_OpenGL_1k.webp',
        roughnessPath: 'uploads/Sidewalk_Roughness_1k.jpg',
        metallicPath: 'uploads/Sidewalk_Metallic_1k.png',
        aoPath: 'uploads/Sidewalk_AO_1k.png',
        heightPath: 'uploads/Sidewalk_Height_1k.jpg',
        repeatX: 1,
        repeatY: 1,
        defaultRoughness: 0.82,
        defaultMetalness: 0.05,
        bumpScale: 0.015
    });

    const curbMat = createPBRMaterial({
        baseColorPath: 'uploads/Sidewalk_BaseColor_1k.jpg',
        normalPath: 'uploads/Sidewalk_Normal_OpenGL_1k.webp',
        roughnessPath: 'uploads/Sidewalk_Roughness_1k.jpg',
        repeatX: 1,
        repeatY: 1,
        defaultRoughness: 0.85,
        defaultMetalness: 0.05
    });

    // Yellow tactile warning paver for ADA curb cuts
    const tactileTex = (() => {
        const c = document.createElement('canvas');
        c.width = 128; c.height = 128;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#f59e0b';
        ctx.fillRect(0, 0, 128, 128);
        ctx.fillStyle = '#d97706';
        for (let x = 8; x < 128; x += 16) {
            for (let y = 8; y < 128; y += 16) {
                ctx.beginPath();
                ctx.arc(x, y, 4, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        const t = new THREE.CanvasTexture(c);
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(6, 1);
        t.colorSpace = THREE.SRGBColorSpace;
        return t;
    })();
    const yellowTactileMat = new THREE.MeshStandardMaterial({ map: tactileTex, roughness: 0.65, metalness: 0.1 });

    // 3. Grass ground texture
    const grassTex = (() => {
        const c = document.createElement('canvas');
        c.width = 256; c.height = 256;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#4d7c38';
        ctx.fillRect(0, 0, 256, 256);
        let gSeed = 9876543;
        const gLcg = () => { gSeed = (gSeed * 1664525 + 1013904223) % 4294967296; return gSeed / 4294967296; };
        for (let i = 0; i < 3500; i++) {
            const g = 90 + gLcg() * 65;
            const r = 50 + gLcg() * 40;
            ctx.fillStyle = `rgba(${r},${g},45,${0.2 + gLcg() * 0.3})`;
            ctx.fillRect(gLcg() * 256, gLcg() * 256, 2, 3);
        }
        const t = new THREE.CanvasTexture(c);
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(40, 40);
        t.colorSpace = THREE.SRGBColorSpace;
        return t;
    })();
    const grassMat = new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1.0, metalness: 0 });

    const lineWhite = new THREE.MeshBasicMaterial({ color: 0xf8fafc });
    const lineYellow = new THREE.MeshBasicMaterial({ color: 0xfbbf24 });
    const lightPoleMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.7, metalness: 0.4 });
    const lightHeadMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, emissive: 0xfef08a, emissiveIntensity: 0.65 });

    // 1. MASSIVE CONTINUOUS BASE WORLD TERRAIN (Zero cracks/voids anywhere)
    const worldBaseGround = new THREE.Mesh(new THREE.PlaneGeometry(950, 950), grassMat);
    worldBaseGround.rotation.x = -Math.PI / 2;
    worldBaseGround.position.set(0, -0.02, 0);
    worldBaseGround.receiveShadow = false;
    scene.add(worldBaseGround);

    // 2. CONTINUOUS FULL-PLAZA ASPHALT LOT (Seamless 210m x 210m square lot)
    const plazaAsphalt = new THREE.Mesh(new THREE.PlaneGeometry(210, 210), asphaltMat);
    plazaAsphalt.rotation.x = -Math.PI / 2;
    plazaAsphalt.position.set(0, -0.005, 0);
    scene.add(plazaAsphalt);

    // 3. STORE PERIMETER SIDEWALKS AND CURBS (Solid 3D Raised Slabs with Seamless World UVs)
    const addSidewalkSlab = (w, d, x, z, h = curbHeight) => {
        const geo = new THREE.BoxGeometry(w, h, d);
        applyWorldUVsToBox(geo, x, h / 2, z, w, h, d, 0.5, 0.5);
        const slab = new THREE.Mesh(geo, sidewalkMat);
        slab.position.set(x, h / 2, z);
        slab.receiveShadow = true;
        scene.add(slab);
        return slab;
    };

    // Store Perimeter Walkway Slabs:
    // Front Entrance Promenade: wide, spacious walkway in front of storefront (Z = -30 to -38)
    addSidewalkSlab(72, 8, 0, -34);
    // West Side Walkway (X = -36 to -30, Z = -30 to +36)
    addSidewalkSlab(6, 66, -33, 3);
    // East Side Walkway (X = +30 to +36, Z = -21.25 to +36; the restroom annex occupies the front end)
    addSidewalkSlab(6, 57.25, 33, 7.375);
    // Rear Service Walkway (Z = +30 to +36, X = -30 to +30)
    addSidewalkSlab(60, 6, 0, 33);

    // Front ADA curb ramp at main entrance (X = -4.5 to +4.5, Z = -37.5 to -38.5)
    {
        const rampW = 6.0;
        const rampD = 1.2;
        const rampGeo = new THREE.BoxGeometry(rampW, curbHeight, rampD);
        applyWorldUVsToBox(rampGeo, 0, curbHeight / 2, -38, rampW, curbHeight, rampD, 0.5, 0.5);
        const rampMesh = new THREE.Mesh(rampGeo, sidewalkMat);
        rampMesh.position.set(0, curbHeight * 0.35, -38);
        rampMesh.rotation.x = 0.12; // gentle ADA slope down to street grade
        scene.add(rampMesh);

        // Tactile yellow blister warning pad at crosswalk boundary
        const tactileMesh = new THREE.Mesh(new THREE.PlaneGeometry(rampW, 0.65), yellowTactileMat);
        tactileMesh.rotation.x = -Math.PI / 2 + 0.12;
        tactileMesh.position.set(0, 0.04, -38.35);
        scene.add(tactileMesh);
    }

    // Central Parking Lot Pedestrian Spine Island (Walkway leading safely from crosswalk through parking aisles)
    addSidewalkSlab(3.4, 28, 0, -59, curbHeight * 0.85);

    // Defined corral stall exclusion coordinates so cars never spawn on corrals
    const corralLocations = [
        { x: -18.2, z: -52.2 },
        { x: 18.2, z: -52.2 },
        { x: -41.6, z: -52.2 },
        { x: 41.6, z: -52.2 }
    ];

    // 4. PARKING LOT ROAD LINES, STALLS & VEHICLES (Batched geometries for zero draw-call overhead)
    const carList = [];
    const carColors = [0xd32f2f, 0x1976d2, 0xfbc02d, 0x388e3c, 0x7b1fa2, 0xe65100, 0x0097a7, 0x424242, 0xffffff, 0x4e342e, 0x0284c7, 0x16a34a];
    const whiteLineGeometries = [];
    const yellowLineGeometries = [];
    const candidateStalls = [];

    const addParkingSection = (centerX, centerZ, width, depth, rotationY = 0) => {
        const stallWidth = 2.6;
        const stallDepth = 5.5;
        const driveAisle = 6.4;
        const startZ = -depth / 2;
        const rowZ1 = startZ + stallDepth / 2;
        const rowZ2 = startZ + stallDepth + driveAisle + stallDepth / 2;

        const cos = Math.cos(rotationY), sin = Math.sin(rotationY);
        const localToWorld = (lx, lz) => ({
            x: centerX + lx * cos + lz * sin,
            z: centerZ - lx * sin + lz * cos
        });

        const addBatchedLine = (w, d, lx, lz, isYellow = false) => {
            const wp = localToWorld(lx, lz);
            const geo = new THREE.PlaneGeometry(w, d);
            geo.rotateX(-Math.PI / 2);
            if (rotationY !== 0) geo.rotateY(rotationY);
            geo.translate(wp.x, 0.003, wp.z);
            if (isYellow) {
                yellowLineGeometries.push(geo);
            } else {
                whiteLineGeometries.push(geo);
            }
        };

        addBatchedLine(width, 0.14, 0, startZ + stallDepth, false);
        addBatchedLine(width, 0.14, 0, startZ + stallDepth + driveAisle, false);

        const cols = Math.floor(width / stallWidth) - 2;
        for (let c = 0; c < cols; c++) {
            const xPos = -width / 2 + (c + 1) * stallWidth;
            addBatchedLine(0.1, stallDepth, xPos, rowZ1, false);
            addBatchedLine(0.1, stallDepth, xPos, rowZ2, false);

            // Stalls in Row 1
            const p1 = localToWorld(xPos, rowZ1);
            const nearCorral1 = corralLocations.some(cl => Math.hypot(p1.x - cl.x, p1.z - cl.z) < 2.2);
            if (!nearCorral1) {
                candidateStalls.push({ x: p1.x, z: p1.z, heading: rotationY });
            }

            // Stalls in Row 2
            const p2 = localToWorld(xPos, rowZ2);
            const nearCorral2 = corralLocations.some(cl => Math.hypot(p2.x - cl.x, p2.z - cl.z) < 2.2);
            if (!nearCorral2) {
                candidateStalls.push({ x: p2.x, z: p2.z, heading: rotationY + Math.PI });
            }
        }

        // Accessible stalls
        for (let i = 0; i < 2; i++) {
            const xPos = -width / 2 + (i + 1) * stallWidth;
            addBatchedLine(0.12, stallDepth, xPos, rowZ1, true);
            addBatchedLine(stallWidth - 0.1, 0.12, xPos, rowZ1 + stallDepth / 2, true);
        }
    };

    const lotNear = buildingHalf + sidewalkWidth + curbWidth + 2;
    const lotCenter = lotNear + 14;
    addParkingSection(0, -lotCenter, 100, 28, 0);
    addParkingSection(0, lotCenter, 100, 28, 0);
    addParkingSection(-lotCenter, 0, 100, 28, Math.PI / 2);
    addParkingSection(lotCenter, 0, 100, 28, Math.PI / 2);

    addParkingSection(-lotCenter, -lotCenter, 42, 28, 0);
    addParkingSection(lotCenter, -lotCenter, 42, 28, 0);
    addParkingSection(-lotCenter, lotCenter, 42, 28, 0);
    addParkingSection(lotCenter, lotCenter, 42, 28, 0);

    // Number of cars equals the number of people in the store (12 customers)
    const targetStoreCars = 12;
    // Shuffle candidate stalls randomly
    const shuffledStalls = [...candidateStalls].sort(() => Math.random() - 0.5);
    const chosenStalls = shuffledStalls.slice(0, targetStoreCars);
    // Empty stalls close to the entrance for the player's own car.
    playerCarSpots = shuffledStalls.slice(targetStoreCars).filter(st =>
        st.z < -45 && Math.abs(st.x) > 2.5 && Math.hypot(st.x, st.z + 38) < 20 &&
        chosenStalls.every(o => Math.hypot(o.x - st.x, o.z - st.z) > 2.4));
    chosenStalls.forEach(st => {
        carList.push({
            x: st.x + (Math.random() * 0.1 - 0.05),
            z: st.z,
            heading: st.heading,
            color: carColors[Math.floor(Math.random() * carColors.length)]
        });
    });

    // Plus ~7 cars for detail in the background mall lot
    const mallCarPositions = [
        { x: -35, z: -125, heading: 0 },
        { x: -22, z: -128, heading: 0 },
        { x: -8,  z: -126, heading: Math.PI },
        { x: 10,  z: -127, heading: 0 },
        { x: 25,  z: -125, heading: Math.PI },
        { x: 38,  z: -129, heading: 0 },
        { x: 50,  z: -126, heading: Math.PI }
    ];
    mallCarPositions.forEach(st => {
        carList.push({
            x: st.x,
            z: st.z,
            heading: st.heading,
            color: carColors[Math.floor(Math.random() * carColors.length)]
        });
    });

    // 5. PEDESTRIAN CROSSWALKS (Batched into whiteLineGeometries)
    const addCrosswalk = (x, z, width, length, rot = 0) => {
        const stripeWidth = 0.6;
        const stripeGap = 0.55;
        const stripeCount = Math.floor(length / (stripeWidth + stripeGap));
        const cos = Math.cos(rot), sin = Math.sin(rot);
        for (let i = 0; i < stripeCount; i++) {
            const lz = -length / 2 + (i + 0.5) * (stripeWidth + stripeGap);
            const wx = x + lz * sin;
            const wz = z + lz * cos;
            const geo = new THREE.PlaneGeometry(width, stripeWidth);
            geo.rotateX(-Math.PI / 2);
            if (rot !== 0) geo.rotateY(rot);
            geo.translate(wx, 0.004, wz);
            whiteLineGeometries.push(geo);
        }
    };

    // Main entrance pedestrian zebra crosswalk connecting store ramp to central parking median
    addCrosswalk(0, -41.5, 5.5, 7.0, 0);
    // Side crosswalks connecting east and west walkway ramps to side lot aisles
    addCrosswalk(-39.5, -34, 4.0, 7.0, Math.PI / 2);
    addCrosswalk(39.5, -34, 4.0, 7.0, Math.PI / 2);

    // 6. REALISTIC SHOPPING CART CORRALS & STOREFRONT STAGING BAYS (WITH THREE.InstancedMesh)
    const cartReturnSignTex = (() => {
        const c = document.createElement('canvas');
        c.width = 512; c.height = 256;
        const ctx = c.getContext('2d');
        const grad = ctx.createLinearGradient(0, 0, 0, 256);
        grad.addColorStop(0, '#1e3a8a');
        grad.addColorStop(1, '#0f172a');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 512, 256);
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 8;
        ctx.strokeRect(8, 8, 496, 240);
        ctx.fillStyle = '#dc2626';
        ctx.fillRect(16, 16, 480, 50);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 26px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('MAGMART', 256, 41);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 44px sans-serif';
        ctx.fillText('🛒 CART RETURN', 256, 115);
        ctx.fillStyle = '#93c5fd';
        ctx.font = 'bold 20px sans-serif';
        ctx.fillText('PLEASE RETURN CARTS HERE', 256, 170);
        ctx.fillStyle = '#cbd5e1';
        ctx.font = '16px sans-serif';
        ctx.fillText('THANK YOU FOR SHOPPING WITH US', 256, 205);
        const t = new THREE.CanvasTexture(c);
        t.colorSpace = THREE.SRGBColorSpace;
        return t;
    })();
    const cartReturnSignMat = new THREE.MeshStandardMaterial({ map: cartReturnSignTex, roughness: 0.35, metalness: 0.2 });

    const cartStagingSignTex = (() => {
        const c = document.createElement('canvas');
        c.width = 512; c.height = 128;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#1e3a8a';
        ctx.fillRect(0, 0, 512, 128);
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 6;
        ctx.strokeRect(6, 6, 500, 116);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 34px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('🛒 CART STAGING AREA', 256, 46);
        ctx.fillStyle = '#fde047';
        ctx.font = 'bold 20px sans-serif';
        ctx.fillText('SANITIZED CARTS • PLEASE TAKE ONE', 256, 90);
        const t = new THREE.CanvasTexture(c);
        t.colorSpace = THREE.SRGBColorSpace;
        return t;
    })();
    const cartStagingSignMat = new THREE.MeshStandardMaterial({ map: cartStagingSignTex, roughness: 0.35, metalness: 0.2 });

    const galvanizedMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.28, metalness: 0.85 });
    const safetyYellowMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.4, metalness: 0.1 });
    const blackBumperMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.9 });

    const entranceBayCartTransforms = [];
    const corralCartTransforms = [];

    const addCartCorral = (x, z, rotY = 0, isEntranceBay = false) => {
        const corral = new THREE.Group();
        const baseElevation = isEntranceBay ? curbHeight : 0;
        const length = isEntranceBay ? 4.2 : 5.0;
        const width = isEntranceBay ? 2.8 : 2.5;

        // Ground painted stall border & safety hatching for parking lot corrals
        if (!isEntranceBay) {
            const padMesh = new THREE.Mesh(new THREE.PlaneGeometry(width + 0.2, length + 0.2), new THREE.MeshBasicMaterial({ color: 0x1e293b }));
            padMesh.rotation.x = -Math.PI / 2;
            padMesh.position.set(0, 0.002, 0);
            padMesh.receiveShadow = false;
            corral.add(padMesh);

            // Diagonal safety stripes (batched into yellowLineGeometries)
            const stripeCount = 6;
            for (let s = 0; s < stripeCount; s++) {
                const stripeGeo = new THREE.PlaneGeometry(width - 0.2, 0.12);
                stripeGeo.rotateX(-Math.PI / 2);
                stripeGeo.rotateZ(0.55);
                if (rotY !== 0) stripeGeo.rotateY(rotY);
                stripeGeo.translate(x, 0.004, z + (-length / 2 + 0.6 + s * (length / stripeCount)));
                yellowLineGeometries.push(stripeGeo);
            }
        }

        // Heavy-duty tubular guard rails
        const railRadius = 0.045;
        const railHeight = 0.95;
        const halfW = width / 2;
        const halfL = length / 2;

        // 3 Longitudinal guide rails (Left, Center divider, Right)
        [-halfW + 0.15, 0, halfW - 0.15].forEach((railX) => {
            // Upper horizontal rail
            const topRail = new THREE.Mesh(new THREE.CylinderGeometry(railRadius, railRadius, length - 0.4, 10), galvanizedMat);
            topRail.rotation.x = Math.PI / 2;
            topRail.position.set(railX, baseElevation + railHeight, 0);
            topRail.castShadow = false; topRail.receiveShadow = false;
            corral.add(topRail);

            // Lower rub rail / wheel bumper
            const botRail = new THREE.Mesh(new THREE.CylinderGeometry(railRadius * 0.85, railRadius * 0.85, length - 0.4, 10), galvanizedMat);
            botRail.rotation.x = Math.PI / 2;
            botRail.position.set(railX, baseElevation + 0.28, 0);
            botRail.castShadow = false; botRail.receiveShadow = false;
            corral.add(botRail);

            // Vertical support posts
            [-halfL + 0.3, 0, halfL - 0.3].forEach(postZ => {
                const post = new THREE.Mesh(new THREE.CylinderGeometry(railRadius * 1.1, railRadius * 1.1, railHeight, 10), galvanizedMat);
                post.position.set(railX, baseElevation + railHeight / 2, postZ);
                post.castShadow = false; post.receiveShadow = false;
                corral.add(post);

                // Top post cap
                const cap = new THREE.Mesh(new THREE.SphereGeometry(railRadius * 1.25, 8, 8), safetyYellowMat);
                cap.position.set(railX, baseElevation + railHeight, postZ);
                cap.castShadow = false; cap.receiveShadow = false;
                corral.add(cap);
            });
        });

        // Rear stop bar
        const rearBar = new THREE.Mesh(new THREE.CylinderGeometry(railRadius, railRadius, width - 0.3, 10), galvanizedMat);
        rearBar.rotation.z = Math.PI / 2;
        rearBar.position.set(0, baseElevation + railHeight, halfL - 0.2);
        rearBar.castShadow = false; rearBar.receiveShadow = false;
        corral.add(rearBar);

        // Signage & Overhead structure
        if (isEntranceBay) {
            const signBoard = new THREE.Mesh(new THREE.BoxGeometry(width - 0.2, 0.55, 0.08), cartStagingSignMat);
            signBoard.position.set(0, baseElevation + 1.6, halfL - 0.2);
            const signPostL = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.8, 8), galvanizedMat);
            signPostL.position.set(-halfW + 0.2, baseElevation + 1.3, halfL - 0.2);
            const signPostR = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.8, 8), galvanizedMat);
            signPostR.position.set(halfW - 0.2, baseElevation + 1.3, halfL - 0.2);
            signBoard.castShadow = false; signPostL.castShadow = false; signPostR.castShadow = false;
            corral.add(signBoard, signPostL, signPostR);
        } else {
            const archH = 2.7;
            const archLegL = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, archH - railHeight, 8), galvanizedMat);
            archLegL.position.set(-halfW + 0.15, railHeight + (archH - railHeight) / 2, -halfL + 0.3);
            const archLegR = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, archH - railHeight, 8), galvanizedMat);
            archLegR.position.set(halfW - 0.15, railHeight + (archH - railHeight) / 2, -halfL + 0.3);

            const archTopBar = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, width - 0.3, 8), galvanizedMat);
            archTopBar.rotation.z = Math.PI / 2;
            archTopBar.position.set(0, archH, -halfL + 0.3);

            const signBox = new THREE.Mesh(new THREE.BoxGeometry(width * 0.92, 0.82, 0.12), cartReturnSignMat);
            signBox.position.set(0, archH + 0.45, -halfL + 0.3);

            archLegL.castShadow = false; archLegR.castShadow = false; archTopBar.castShadow = false; signBox.castShadow = false;
            corral.add(archLegL, archLegR, archTopBar, signBox);

            // Front Safety Bollards
            [-halfW - 0.18, halfW + 0.18].forEach(bx => {
                const bMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.1, 12), safetyYellowMat);
                bMesh.position.set(bx, 0.55, -halfL + 0.3);
                const ring1 = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.12, 12), blackBumperMat);
                ring1.position.set(bx, 0.85, -halfL + 0.3);
                const ring2 = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.12, 12), blackBumperMat);
                ring2.position.set(bx, 0.55, -halfL + 0.3);
                bMesh.castShadow = false; ring1.castShadow = false; ring2.castShadow = false;
                corral.add(bMesh, ring1, ring2);
            });
        }

        // Collect instance matrix for nested carts rendered via THREE.InstancedMesh
        const laneOffsets = [-halfW * 0.48, halfW * 0.48];
        const cartsPerLane = isEntranceBay ? 4 : 3;
        const cartSpacing = 0.62;

        const corralMat = new THREE.Matrix4().compose(
            new THREE.Vector3(x, 0, z),
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY),
            new THREE.Vector3(1, 1, 1)
        );

        laneOffsets.forEach(laneX => {
            for (let cIdx = 0; cIdx < cartsPerLane; cIdx++) {
                const zPos = halfL - 0.9 - cIdx * cartSpacing;
                const localMat = new THREE.Matrix4().compose(
                    new THREE.Vector3(laneX, baseElevation, zPos),
                    new THREE.Quaternion(),
                    new THREE.Vector3(0.85, 0.85, 0.85)
                );
                const worldCartMat = corralMat.clone().multiply(localMat);
                if (isEntranceBay) {
                    entranceBayCartTransforms.push(worldCartMat);
                } else {
                    corralCartTransforms.push(worldCartMat);
                }
            }
        });

        corral.position.set(x, 0, z);
        corral.rotation.y = rotY;
        scene.add(corral);
        registerCullableObject(corral, 5.5);
        return corral;
    };

    // A. STOREFRONT ENTRANCE CART STAGING BAYS (Directly on front promenade flanking entrance doors)
    addCartCorral(-9.2, -34.0, 0, true);
    addCartCorral(9.2, -34.0, 0, true);

    // B. PARKING LOT CART RETURN CORRALS (Neatly placed inside parking stall bays facing drive aisles)
    corralLocations.forEach(loc => {
        addCartCorral(loc.x, loc.z, 0, false);
    });

    // Merge and submit batched parking & crosswalk line geometries in 2 draw calls
    if (whiteLineGeometries.length > 0) {
        const mergedWhite = BufferGeometryUtils.mergeGeometries(whiteLineGeometries, false);
        const whiteMesh = new THREE.Mesh(mergedWhite, lineWhite);
        whiteMesh.receiveShadow = false;
        whiteMesh.castShadow = false;
        whiteMesh.matrixAutoUpdate = false;
        scene.add(whiteMesh);
        whiteLineGeometries.forEach(g => g.dispose());
    }

    if (yellowLineGeometries.length > 0) {
        const mergedYellow = BufferGeometryUtils.mergeGeometries(yellowLineGeometries, false);
        const yellowMesh = new THREE.Mesh(mergedYellow, lineYellow);
        yellowMesh.receiveShadow = false;
        yellowMesh.castShadow = false;
        yellowMesh.matrixAutoUpdate = false;
        scene.add(yellowMesh);
        yellowLineGeometries.forEach(g => g.dispose());
    }

    // Instanced shopping carts rendering all 40+ carts in single draw calls
    const masterCartGeo = getMasterCartGeometry();
    const chromeMat = new THREE.MeshStandardMaterial({ color: 0xd8d8d8, roughness: 0.2, metalness: 0.85 });
    const blueCartMat = new THREE.MeshStandardMaterial({ color: 0x2563eb, roughness: 0.35, metalness: 0.2 });
    const redCartMat = new THREE.MeshStandardMaterial({ color: 0xd32f2f, roughness: 0.35, metalness: 0.2 });
    const darkMetalMat = new THREE.MeshStandardMaterial({ color: 0x444444, roughness: 0.5, metalness: 0.7 });
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.85 });

    if (entranceBayCartTransforms.length > 0) {
        const entranceCartMesh = new THREE.InstancedMesh(
            masterCartGeo,
            [chromeMat, blueCartMat, darkMetalMat, wheelMat],
            entranceBayCartTransforms.length
        );
        entranceBayCartTransforms.forEach((mat, idx) => {
            entranceCartMesh.setMatrixAt(idx, mat);
        });
        entranceCartMesh.instanceMatrix.needsUpdate = true;
        entranceCartMesh.castShadow = false;
        entranceCartMesh.receiveShadow = false;
        scene.add(entranceCartMesh);
    }

    if (corralCartTransforms.length > 0) {
        const corralCartMesh = new THREE.InstancedMesh(
            masterCartGeo,
            [chromeMat, redCartMat, darkMetalMat, wheelMat],
            corralCartTransforms.length
        );
        corralCartTransforms.forEach((mat, idx) => {
            corralCartMesh.setMatrixAt(idx, mat);
        });
        corralCartMesh.instanceMatrix.needsUpdate = true;
        corralCartMesh.castShadow = false;
        corralCartMesh.receiveShadow = false;
        scene.add(corralCartMesh);
    }

    // 7. FRONT PROMENADE AMENITIES (Security Bollards, Benches, Trash/Recycling, Concrete Planters)
    {
        // Stainless steel security bollards along curb edge
        const bollardGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.9, 12);
        const bollardMat = new THREE.MeshStandardMaterial({ color: 0xd1d5db, roughness: 0.2, metalness: 0.85 });
        const bollardCapMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.4, metalness: 0.1 });

        const bollardXPositions = [-34, -30, -26, -22, -18, -14, -6.5, 6.5, 14, 18, 22, 26, 30, 34];
        bollardXPositions.forEach(bx => {
            const b = new THREE.Mesh(bollardGeo, bollardMat);
            b.position.set(bx, curbHeight + 0.45, -37.6);
            b.castShadow = false; b.receiveShadow = false;
            const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.08, 12), bollardCapMat);
            cap.position.set(bx, curbHeight + 0.82, -37.6);
            cap.castShadow = false; cap.receiveShadow = false;
            scene.add(b, cap);
        });

        // Storefront architectural outdoor benches
        const createBench = (bx, bz, brotY = 0) => {
            const bench = new THREE.Group();
            const woodMat = new THREE.MeshStandardMaterial({ color: 0x78350f, roughness: 0.7, metalness: 0.1 });
            const legMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.4, metalness: 0.7 });

            for (let s = 0; s < 4; s++) {
                const slat = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.04, 0.1), woodMat);
                slat.position.set(0, curbHeight + 0.48, -0.2 + s * 0.12);
                slat.castShadow = false; slat.receiveShadow = false;
                bench.add(slat);
            }
            for (let bs = 0; bs < 3; bs++) {
                const backSlat = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.09, 0.04), woodMat);
                backSlat.position.set(0, curbHeight + 0.68 + bs * 0.11, -0.25);
                backSlat.castShadow = false; backSlat.receiveShadow = false;
                bench.add(backSlat);
            }
            [-0.95, 0.95].forEach(lx => {
                const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.48, 0.55), legMat);
                leg.position.set(lx, curbHeight + 0.24, -0.02);
                leg.castShadow = false; leg.receiveShadow = false;
                bench.add(leg);
            });
            bench.position.set(bx, 0, bz);
            bench.rotation.y = brotY;
            scene.add(bench);
        };
        createBench(-18.5, -31.2, Math.PI);
        createBench(18.5, -31.2, Math.PI);

        // Commercial outdoor trash & recycling receptacles
        const createReceptacle = (rx, rz) => {
            const rGroup = new THREE.Group();
            const bodyMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.35, metalness: 0.6 });
            const topMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.4, metalness: 0.7 });

            const body = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.25, 0.95, 16), bodyMat);
            body.position.set(0, curbHeight + 0.475, 0);
            const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.31, 0.1, 16), topMat);
            lid.position.set(0, curbHeight + 0.97, 0);
            const opening = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.12, 0.28), new THREE.MeshBasicMaterial({ color: 0x020617 }));
            opening.position.set(0, curbHeight + 0.82, 0.16);

            body.castShadow = false; body.receiveShadow = false;
            lid.castShadow = false; lid.receiveShadow = false;
            rGroup.add(body, lid, opening);
            rGroup.position.set(rx, 0, rz);
            scene.add(rGroup);
        };
        createReceptacle(-6.2, -31.4);
        createReceptacle(6.2, -31.4);

        // Landscaping Planters with lush boxwood shrubs
        const createPlanter = (px, pz) => {
            const planter = new THREE.Group();
            const potMat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.85, metalness: 0.1 });
            const plantMat = new THREE.MeshStandardMaterial({ color: 0x2e7d32, roughness: 0.9 });

            const pot = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.65, 1.2), potMat);
            pot.position.set(0, curbHeight + 0.325, 0);
            const plant = new THREE.Mesh(new THREE.SphereGeometry(0.68, 10, 8), plantMat);
            plant.scale.set(1.1, 0.75, 0.9);
            plant.position.set(0, curbHeight + 0.95, 0);

            pot.castShadow = false; pot.receiveShadow = false;
            plant.castShadow = false; plant.receiveShadow = false;
            planter.add(pot, plant);
            planter.position.set(px, 0, pz);
            scene.add(planter);
        };
        createPlanter(-33.5, -36.2);
        createPlanter(33.5, -36.2);
        createPlanter(-5.5, -36.2);
        createPlanter(5.5, -36.2);
    }

    // 8. INSTANCED VEHICLES (Crisp Sedans & SUVs)
    parkingLotCars = carList;
    if (carList.length > 0) {
        const n = carList.length;
        const bodyGeo = new THREE.BoxGeometry(1.9, 0.58, 4.2);
        const cabinGeo = new THREE.BoxGeometry(1.58, 0.52, 2.3);
        const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.26, 14);
        const lightGeo = new THREE.BoxGeometry(0.55, 0.14, 0.1);

        const bodyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.25, metalness: 0.45 });
        const cabinMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.1, metalness: 0.8 });
        const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.95 });
        const headMat = new THREE.MeshStandardMaterial({ color: 0xfef08a, emissive: 0xfef08a, emissiveIntensity: 0.85 });
        const tailMat = new THREE.MeshStandardMaterial({ color: 0xef4444, emissive: 0xdc2626, emissiveIntensity: 0.7 });

        const bodyMesh = new THREE.InstancedMesh(bodyGeo, bodyMat, n);
        const cabinMesh = new THREE.InstancedMesh(cabinGeo, cabinMat, n);
        const wheelMesh = new THREE.InstancedMesh(wheelGeo, wheelMat, n * 4);
        const headMesh = new THREE.InstancedMesh(lightGeo, headMat, n * 2);
        const tailMesh = new THREE.InstancedMesh(lightGeo, tailMat, n * 2);

        carInstancedMeshes = { bodyMesh, cabinMesh, wheelMesh, headMesh, tailMesh };

        const color = new THREE.Color();
        carList.forEach((car, i) => {
            car.origX = car.x;
            car.origZ = car.z;
            car.origHeading = car.heading;
            color.setHex(car.color);
            bodyMesh.setColorAt(i, color);
            updateCarInstanceTransform(i, car);
        });

        bodyMesh.instanceMatrix.needsUpdate = true;
        if (bodyMesh.instanceColor) bodyMesh.instanceColor.needsUpdate = true;
        cabinMesh.instanceMatrix.needsUpdate = true;
        wheelMesh.instanceMatrix.needsUpdate = true;
        headMesh.instanceMatrix.needsUpdate = true;
        tailMesh.instanceMatrix.needsUpdate = true;

        scene.add(bodyMesh, cabinMesh, wheelMesh, headMesh, tailMesh);
    }

    // 7. STREET LIGHTS
    const addLightPole = (x, z) => {
        const pole = new THREE.Group();
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 7.5, 8), lightPoleMat);
        mast.position.y = 3.75;
        mast.castShadow = false; mast.receiveShadow = false;
        const arm = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.09, 0.09), lightPoleMat);
        arm.position.set(1.0, 7.4, 0);
        arm.castShadow = false; arm.receiveShadow = false;
        const head = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.14, 0.35), lightHeadMat);
        head.position.set(2.0, 7.32, 0);
        head.castShadow = false; head.receiveShadow = false;
        pole.add(mast, arm, head);
        pole.position.set(x, 0, z);
        scene.add(pole);
    };
    for (let x = -70; x <= 70; x += 22) {
        addLightPole(x, -52);
        addLightPole(x, 52);
    }
    for (let z = -70; z <= 70; z += 22) {
        addLightPole(-52, z);
        addLightPole(52, z);
    }

    // 8. THE GRAND SHOPPING MALL COMPLEX IN THE DISTANCE (WITH THREE.LOD)
    {
        const mallLOD = new THREE.LOD();

        const mallFacadeTex = (() => {
            const c = document.createElement('canvas');
            c.width = 512; c.height = 256;
            const ctx = c.getContext('2d');
            ctx.fillStyle = '#e2e8f0';
            ctx.fillRect(0, 0, 512, 256);
            ctx.fillStyle = '#cbd5e1';
            for (let y = 0; y < 256; y += 16) {
                ctx.fillRect(0, y, 512, 3);
            }
            ctx.fillStyle = '#0f172a';
            ctx.fillRect(20, 24, 472, 60);
            ctx.strokeStyle = '#38bdf8';
            ctx.lineWidth = 4;
            ctx.strokeRect(20, 24, 472, 60);
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 24px "Trebuchet MS", sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('VALLEY VISTA GRAND MALL', 256, 54);

            ctx.fillStyle = '#0f172a';
            ctx.fillRect(30, 100, 452, 140);
            ctx.strokeStyle = '#38bdf8';
            ctx.lineWidth = 3;
            for (let x = 30; x < 482; x += 38) {
                ctx.strokeRect(x, 100, 38, 140);
            }
            const tex = new THREE.CanvasTexture(c);
            tex.colorSpace = THREE.SRGBColorSpace;
            return tex;
        })();

        const deptStoreTex = (() => {
            const c = document.createElement('canvas');
            c.width = 512; c.height = 256;
            const ctx = c.getContext('2d');
            ctx.fillStyle = '#334155';
            ctx.fillRect(0, 0, 512, 256);
            ctx.fillStyle = '#b91c1c';
            ctx.fillRect(30, 30, 452, 50);
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 22px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('PREMIER DEPARTMENT STORE', 256, 55);
            ctx.fillStyle = '#0f172a';
            ctx.fillRect(40, 110, 432, 130);
            const tex = new THREE.CanvasTexture(c);
            tex.colorSpace = THREE.SRGBColorSpace;
            return tex;
        })();

        const cinemaTex = (() => {
            const c = document.createElement('canvas');
            c.width = 512; c.height = 256;
            const ctx = c.getContext('2d');
            ctx.fillStyle = '#1e1b4b';
            ctx.fillRect(0, 0, 512, 256);
            ctx.fillStyle = '#f59e0b';
            ctx.fillRect(30, 30, 452, 50);
            ctx.fillStyle = '#000000';
            ctx.font = 'bold 22px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('CINEMA 14 & FOOD GALLERIA', 256, 55);
            ctx.fillStyle = '#0f172a';
            ctx.fillRect(40, 110, 432, 130);
            const tex = new THREE.CanvasTexture(c);
            tex.colorSpace = THREE.SRGBColorSpace;
            return tex;
        })();

        const mallMat = new THREE.MeshStandardMaterial({ map: mallFacadeTex, roughness: 0.65, metalness: 0.1 });
        const deptMat = new THREE.MeshStandardMaterial({ map: deptStoreTex, roughness: 0.7 });
        const cinemaMat = new THREE.MeshStandardMaterial({ map: cinemaTex, roughness: 0.7 });
        const mallGlassMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.1, metalness: 0.9, transparent: false }); // Opaque reflective glass to eliminate overdraw

        const centerW = 75, centerH = 24, centerD = 42;
        const westW = 85, westH = 19, westD = 38;
        const eastW = 85, eastH = 18, eastD = 38;

        // --- LOD 0: Detailed Mall Group (Distance < 130) ---
        const mallHighGroup = new THREE.Group();
        const centerMesh = new THREE.Mesh(new THREE.BoxGeometry(centerW, centerH, centerD), mallMat);
        centerMesh.position.set(0, centerH / 2, 0);
        centerMesh.castShadow = false; centerMesh.receiveShadow = false;

        const atriumDome = new THREE.Mesh(new THREE.CylinderGeometry(14, 18, 6, 16), mallGlassMat);
        atriumDome.position.set(0, centerH + 3, 0);
        atriumDome.castShadow = false; atriumDome.receiveShadow = false;

        const canopy = new THREE.Mesh(new THREE.BoxGeometry(32, 1.2, 12), new THREE.MeshStandardMaterial({ color: 0x0284c7, metalness: 0.6, roughness: 0.3 }));
        canopy.position.set(0, 7, centerD / 2 + 5);
        canopy.castShadow = false; canopy.receiveShadow = false;

        const westMesh = new THREE.Mesh(new THREE.BoxGeometry(westW, westH, westD), cinemaMat);
        westMesh.position.set(-centerW / 2 - westW / 2, westH / 2, -2);
        westMesh.castShadow = false; westMesh.receiveShadow = false;

        const eastMesh = new THREE.Mesh(new THREE.BoxGeometry(eastW, eastH, eastD), deptMat);
        eastMesh.position.set(centerW / 2 + eastW / 2, eastH / 2, -2);
        eastMesh.castShadow = false; eastMesh.receiveShadow = false;

        const hvacMat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.5, metalness: 0.6 });
        const hvacOffsetsZ = [-3.5, 2.0, -2.5, 3.0];
        [-60, -20, 20, 60].forEach((hx, idx) => {
            const hBox = new THREE.Mesh(new THREE.BoxGeometry(4, 2, 3), hvacMat);
            hBox.position.set(hx, centerH + 1, hvacOffsetsZ[idx % hvacOffsetsZ.length]);
            hBox.castShadow = false; hBox.receiveShadow = false;
            mallHighGroup.add(hBox);
        });
        mallHighGroup.add(centerMesh, atriumDome, canopy, westMesh, eastMesh);

        // --- LOD 1: Medium Detail Massing (Distance 130 - 240) ---
        const mallMedGroup = new THREE.Group();
        const medCenter = new THREE.Mesh(new THREE.BoxGeometry(centerW, centerH, centerD), mallMat);
        medCenter.position.set(0, centerH / 2, 0);
        medCenter.castShadow = false; medCenter.receiveShadow = false;
        const medWest = new THREE.Mesh(new THREE.BoxGeometry(westW, westH, westD), cinemaMat);
        medWest.position.set(-centerW / 2 - westW / 2, westH / 2, -2);
        medWest.castShadow = false; medWest.receiveShadow = false;
        const medEast = new THREE.Mesh(new THREE.BoxGeometry(eastW, eastH, eastD), deptMat);
        medEast.position.set(centerW / 2 + eastW / 2, eastH / 2, -2);
        medEast.castShadow = false; medEast.receiveShadow = false;
        mallMedGroup.add(medCenter, medWest, medEast);

        // --- LOD 2: Low-Poly Distant Billboard (Distance > 240) ---
        const mallLowGroup = new THREE.Group();
        const lowBox = new THREE.Mesh(new THREE.BoxGeometry(centerW + westW + eastW, 20, centerD), mallMat);
        lowBox.position.set(0, 10, 0);
        lowBox.castShadow = false; lowBox.receiveShadow = false;
        mallLowGroup.add(lowBox);

        mallLOD.addLevel(mallHighGroup, 0);
        mallLOD.addLevel(mallMedGroup, 130);
        mallLOD.addLevel(mallLowGroup, 240);

        mallLOD.position.set(0, 0, -145);
        mallLOD.castShadow = false;
        mallLOD.receiveShadow = false;
        mallLOD.matrixAutoUpdate = false;
        mallLOD.updateMatrix();
        scene.add(mallLOD);
        registerCullableObject(mallLOD, 130);
    }

    // 9. URBAN CITY SKYLINE IN THE DISTANCE (WITH THREE.LOD - 100% STATIC & OUTSIDE THE MOUNTAIN)
    {
        const cityLOD = new THREE.LOD();

        const makeCityFacadeTex = (baseCol, winCol, isGlassTower) => {
            const c = document.createElement('canvas');
            c.width = 256; c.height = 512;
            const ctx = c.getContext('2d');
            ctx.fillStyle = baseCol;
            ctx.fillRect(0, 0, 256, 512);

            const rows = 28, cols = 8;
            const ww = 256 / cols, wh = 512 / rows;
            ctx.fillStyle = winCol;
            for (let r = 0; r < rows; r++) {
                for (let col = 0; col < cols; col++) {
                    if (isGlassTower || ((r + col * 3) % 7 !== 0)) {
                        ctx.fillRect(col * ww + 3, r * wh + 3, ww - 6, wh - 6);
                    }
                }
            }
            const tex = new THREE.CanvasTexture(c);
            tex.colorSpace = THREE.SRGBColorSpace;
            return tex;
        };

        const cityThemes = [
            { base: '#1e293b', win: '#38bdf8', glass: true },
            { base: '#334155', win: '#fef08a', glass: false },
            { base: '#0f172a', win: '#60a5fa', glass: true },
            { base: '#475569', win: '#fed7aa', glass: false },
            { base: '#18181b', win: '#a5f3fc', glass: true },
            { base: '#27272a', win: '#fef9c3', glass: false }
        ];

        const spireMat = new THREE.MeshStandardMaterial({ color: 0xd4d4d8, metalness: 0.8, roughness: 0.2 });
        const beaconMat = new THREE.MeshBasicMaterial({ color: 0xef4444 });

        const cityHighGroup = new THREE.Group();
        const cityMedGroup = new THREE.Group();
        const cityLowGroup = new THREE.Group();

        // 100% Deterministic, static buildings positioned strictly OUTSIDE the mountain (center 35, -270, radius 195)
        const staticBuildings = [
            // East Skyline Flank (X > 140, completely clear of mountain)
            { x: 175, z: -45, w: 28, h: 65, d: 26, rot: -0.25, themeIdx: 0, spire: true },
            { x: 195, z: 0, w: 32, h: 85, d: 24, rot: 0.0, themeIdx: 1, spire: true },
            { x: 180, z: 45, w: 24, h: 52, d: 28, rot: 0.2, themeIdx: 2, spire: false },
            { x: 210, z: 80, w: 34, h: 90, d: 24, rot: 0.35, themeIdx: 3, spire: true },
            { x: 170, z: 120, w: 30, h: 72, d: 25, rot: 0.5, themeIdx: 4, spire: true },
            { x: 190, z: 160, w: 26, h: 48, d: 28, rot: 0.7, themeIdx: 5, spire: false },
            { x: 230, z: 35, w: 36, h: 82, d: 28, rot: 0.1, themeIdx: 0, spire: true },
            { x: 225, z: 110, w: 28, h: 60, d: 26, rot: 0.4, themeIdx: 1, spire: false },

            // West Skyline Flank (X < -140, completely clear of mountain)
            { x: -175, z: -45, w: 30, h: 75, d: 25, rot: 0.25, themeIdx: 3, spire: true },
            { x: -195, z: 0, w: 35, h: 88, d: 23, rot: 0.0, themeIdx: 4, spire: true },
            { x: -180, z: 45, w: 25, h: 55, d: 27, rot: -0.2, themeIdx: 5, spire: false },
            { x: -210, z: 80, w: 32, h: 86, d: 24, rot: -0.35, themeIdx: 0, spire: true },
            { x: -170, z: 120, w: 28, h: 64, d: 26, rot: -0.5, themeIdx: 1, spire: false },
            { x: -190, z: 160, w: 24, h: 44, d: 30, rot: -0.7, themeIdx: 2, spire: false },
            { x: -230, z: 35, w: 36, h: 80, d: 26, rot: -0.1, themeIdx: 3, spire: true },
            { x: -225, z: 110, w: 30, h: 68, d: 25, rot: -0.4, themeIdx: 4, spire: false },

            // South Skyline Perimeter (Behind store, Z > 170)
            { x: -130, z: 195, w: 32, h: 76, d: 24, rot: -0.85, themeIdx: 0, spire: true },
            { x: -85, z: 210, w: 28, h: 58, d: 26, rot: -1.2, themeIdx: 1, spire: false },
            { x: -35, z: 220, w: 35, h: 92, d: 24, rot: -1.5, themeIdx: 2, spire: true },
            { x: 15, z: 225, w: 30, h: 70, d: 28, rot: 1.6, themeIdx: 3, spire: false },
            { x: 65, z: 215, w: 34, h: 84, d: 26, rot: 1.3, themeIdx: 4, spire: true },
            { x: 115, z: 200, w: 26, h: 50, d: 30, rot: 0.9, themeIdx: 5, spire: false },
            { x: -10, z: 245, w: 32, h: 78, d: 26, rot: 1.55, themeIdx: 0, spire: true },

            // Distant Northwest & Northeast Vista Outside Mountain Bounds
            { x: -220, z: -95, w: 34, h: 72, d: 26, rot: 0.6, themeIdx: 2, spire: false },
            { x: -245, z: -140, w: 36, h: 88, d: 28, rot: 0.7, themeIdx: 3, spire: true },
            { x: 220, z: -95, w: 34, h: 74, d: 26, rot: -0.6, themeIdx: 4, spire: false },
            { x: 245, z: -140, w: 36, h: 86, d: 28, rot: -0.7, themeIdx: 5, spire: true }
        ];

        staticBuildings.forEach((b, i) => {
            const theme = cityThemes[b.themeIdx % cityThemes.length];
            const bMat = new THREE.MeshStandardMaterial({ map: makeCityFacadeTex(theme.base, theme.win, theme.glass), roughness: 0.4, metalness: 0.3 });

            // High LOD
            const towerHigh = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d), bMat);
            towerHigh.position.set(b.x, b.h / 2, b.z);
            towerHigh.rotation.y = b.rot;
            towerHigh.castShadow = false; towerHigh.receiveShadow = false;
            cityHighGroup.add(towerHigh);

            if (b.spire || b.h > 70) {
                const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.6, 12, 6), spireMat);
                spire.position.set(b.x, b.h + 6, b.z);
                spire.castShadow = false; spire.receiveShadow = false;
                const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 8), beaconMat);
                beacon.position.set(b.x, b.h + 12, b.z);
                beacon.castShadow = false; beacon.receiveShadow = false;
                cityHighGroup.add(spire, beacon);
            }

            // Med LOD (Simplified boxes, no spires/beacons)
            const towerMed = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d), bMat);
            towerMed.position.set(b.x, b.h / 2, b.z);
            towerMed.rotation.y = b.rot;
            towerMed.castShadow = false; towerMed.receiveShadow = false;
            cityMedGroup.add(towerMed);

            // Low LOD
            if (i % 2 === 0) {
                const towerLow = new THREE.Mesh(new THREE.BoxGeometry(b.w * 1.2, b.h, b.d * 1.2), bMat);
                towerLow.position.set(b.x, b.h / 2, b.z);
                towerLow.rotation.y = b.rot;
                towerLow.castShadow = false; towerLow.receiveShadow = false;
                cityLowGroup.add(towerLow);
            }
        });

        cityLOD.addLevel(cityHighGroup, 0);
        cityLOD.addLevel(cityMedGroup, 180);
        cityLOD.addLevel(cityLowGroup, 300);

        cityLOD.castShadow = false;
        cityLOD.receiveShadow = false;
        cityLOD.matrixAutoUpdate = false;
        cityLOD.updateMatrix();
        scene.add(cityLOD);
    }

    // 10. LANDSCAPED GREEN ISLANDS & SUBURBAN TREES (Strictly outside blacktop & mountain)
    {
        const trunkGeo = new THREE.CylinderGeometry(0.2, 0.32, 2.2, 8);
        const foliageGeo = new THREE.ConeGeometry(1.6, 3.4, 8);
        const trunkMat = new THREE.MeshStandardMaterial({ color: 0x543d2b, roughness: 1 });
        const foliageMat = new THREE.MeshStandardMaterial({ color: 0x2e7d32, roughness: 0.95 });

        // Deterministic trees outside blacktop and outside mountain base
        const treePositions = [];
        let treeIdx = 0;
        for (let a = 0; a < Math.PI * 2; a += 0.14) {
            const r = 120 + ((treeIdx % 5) * 5.5);
            const x = Math.cos(a) * r;
            const z = Math.sin(a) * r;
            // Verify outside mountain
            if (Math.hypot(x - 35, z - (-270)) > 215) {
                const s = 0.9 + ((treeIdx % 4) * 0.2);
                treePositions.push({ x, z, s });
            }
            treeIdx++;
        }
        for (let a = 0; a < Math.PI * 2; a += 0.2) {
            const r = 160 + ((treeIdx % 6) * 5.0);
            const x = Math.cos(a) * r;
            const z = Math.sin(a) * r;
            if (Math.hypot(x - 35, z - (-270)) > 215) {
                const s = 1.1 + ((treeIdx % 4) * 0.25);
                treePositions.push({ x, z, s });
            }
            treeIdx++;
        }

        const trunkMesh = new THREE.InstancedMesh(trunkGeo, trunkMat, treePositions.length);
        const foliageMesh = new THREE.InstancedMesh(foliageGeo, foliageMat, treePositions.length);
        trunkMesh.castShadow = false; trunkMesh.receiveShadow = false;
        foliageMesh.castShadow = false; foliageMesh.receiveShadow = false;

        const _m2 = new THREE.Matrix4();
        const _p2 = new THREE.Vector3();
        const _s2 = new THREE.Vector3();
        const _q2 = new THREE.Quaternion();

        treePositions.forEach((p, i) => {
            const s = p.s;
            _p2.set(p.x, 1.1 * s, p.z);
            _s2.set(s, s, s);
            _m2.compose(_p2, _q2, _s2);
            trunkMesh.setMatrixAt(i, _m2);
            _p2.set(p.x, 1.7 * s + 1.1 * s, p.z);
            _m2.compose(_p2, _q2, _s2);
            foliageMesh.setMatrixAt(i, _m2);
        });

        trunkMesh.instanceMatrix.needsUpdate = true;
        foliageMesh.instanceMatrix.needsUpdate = true;
        scene.add(trunkMesh, foliageMesh);
    }

    // 11. LOW-POLY "LONG DROP" TERRACED CANYON & VALLEY BASIN
    {
        const cliffMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.95, flatShading: true });
        const valleyGrassMat = new THREE.MeshStandardMaterial({ color: 0x3b6426, roughness: 1.0, flatShading: true });
        const roadMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.9 });

        const valleyFloor = new THREE.Mesh(new THREE.PlaneGeometry(950, 950), valleyGrassMat);
        valleyFloor.rotation.x = -Math.PI / 2;
        valleyFloor.position.set(0, -22, 0);
        valleyFloor.castShadow = false; valleyFloor.receiveShadow = false;
        scene.add(valleyFloor);

        const dropRadius = 118;
        const cliffSegmentCount = 28;
        const cliffHeights = [26, 28, 25, 30, 27, 29, 26, 31, 28, 25, 29, 27, 30, 28, 26, 30, 27, 29, 26, 31, 28, 25, 29, 27, 30, 28, 26, 29];
        const cliffDepths = [20, 24, 18, 26, 22, 20, 25, 19, 23, 27, 21, 24, 18, 25, 22, 20, 24, 18, 26, 22, 20, 25, 19, 23, 27, 21, 24, 20];
        const cliffOffsets = [0, 2, -2, 3, -1, 1, -3, 2, -2, 1, 3, -2, 0, 2, -1, 3, -2, 1, -3, 2, -2, 1, 3, -2, 0, 2, -1, 1];

        for (let i = 0; i < cliffSegmentCount; i++) {
            const angle = (i / cliffSegmentCount) * Math.PI * 2;
            const r = dropRadius + cliffOffsets[i];
            const x = Math.cos(angle) * r;
            const z = Math.sin(angle) * r;

            const cliffWidth = (Math.PI * 2 * dropRadius / cliffSegmentCount) * 1.35;
            const cliffHeight = cliffHeights[i];
            const cliffDepth = cliffDepths[i];

            const cliffGeo = new THREE.BoxGeometry(cliffWidth, cliffHeight, cliffDepth);
            const cliffMesh = new THREE.Mesh(cliffGeo, cliffMat);
            cliffMesh.position.set(x, -cliffHeight / 2 + 1, z);
            cliffMesh.lookAt(0, -cliffHeight / 2 + 1, 0);
            cliffMesh.rotation.y += Math.PI + (cliffOffsets[i] * 0.03);
            cliffMesh.castShadow = false; cliffMesh.receiveShadow = false;
            cliffMesh.matrixAutoUpdate = false;
            cliffMesh.updateMatrix();
            scene.add(cliffMesh);
        }

        const terraceCount = 9;
        const terraceWidths = [70, 85, 65, 90, 75, 80, 70, 95, 60];
        const terraceHeights = [16, 20, 15, 22, 18, 17, 21, 19, 15];
        const terraceDepths = [50, 60, 45, 65, 55, 48, 58, 52, 45];
        const terraceRadii = [180, 192, 175, 188, 182, 195, 178, 190, 185];

        for (let i = 0; i < terraceCount; i++) {
            const angle = -Math.PI * 0.85 + (i / terraceCount) * Math.PI * 0.7;
            const tr = terraceRadii[i];
            const tx = Math.cos(angle) * tr;
            const tz = Math.sin(angle) * tr;

            const tWidth = terraceWidths[i];
            const tHeight = terraceHeights[i];
            const tDepth = terraceDepths[i];

            const tMesh = new THREE.Mesh(new THREE.BoxGeometry(tWidth, tHeight, tDepth), valleyGrassMat);
            tMesh.position.set(tx, -22 + tHeight / 2, tz);
            tMesh.rotation.y = angle + Math.PI / 2;
            tMesh.castShadow = false; tMesh.receiveShadow = false;
            tMesh.matrixAutoUpdate = false;
            tMesh.updateMatrix();
            scene.add(tMesh);
        }

        const highway = new THREE.Group();
        const roadSegments = [
            { x: -80, z: -150, len: 120, rot: 0.35 },
            { x: -20, z: -220, len: 140, rot: -0.2 },
            { x: 30, z: -290, len: 130, rot: 0.15 }
        ];
        roadSegments.forEach(seg => {
            const rMesh = new THREE.Mesh(new THREE.PlaneGeometry(8, seg.len), roadMat);
            rMesh.rotation.x = -Math.PI / 2;
            rMesh.rotation.z = seg.rot;
            rMesh.position.set(seg.x, -21.95, seg.z);
            rMesh.castShadow = false; rMesh.receiveShadow = false;
            highway.add(rMesh);
        });
        scene.add(highway);
    }

    // 12. ONE BIG STAPLE FEATURE MOUNTAIN (Grand Iconic Landmark WITH THREE.LOD)
    {
        const grandMountainMat = new THREE.MeshStandardMaterial({ color: 0x3b4a5a, roughness: 0.95, flatShading: true });
        const ridgeMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 1.0, flatShading: true });
        const snowPeakMat = new THREE.MeshStandardMaterial({
            color: 0xf1f5f9,
            roughness: 0.85,
            flatShading: true,
            polygonOffset: true,
            polygonOffsetFactor: -1.0,
            polygonOffsetUnits: -4.0
        });

        const mountainLOD = new THREE.LOD();

        // --- LOD 0: Detailed Peak & Ridges (Distance < 220) ---
        const mHighGroup = new THREE.Group();
        const mainW = 195, mainH = 155;
        const mainBaseGeo = new THREE.ConeGeometry(mainW, mainH, 7);
        const mainBaseMesh = new THREE.Mesh(mainBaseGeo, grandMountainMat);
        mainBaseMesh.position.y = -22 + mainH / 2;
        mainBaseMesh.rotation.y = 0.45;
        mainBaseMesh.castShadow = false; mainBaseMesh.receiveShadow = false;
        mHighGroup.add(mainBaseMesh);

        const snowH = (mainH * 0.34) * 1.02;
        const snowW = (mainW * 0.34) * 1.025;
        const snowGeo = new THREE.ConeGeometry(snowW, snowH, 7);
        const snowMesh = new THREE.Mesh(snowGeo, snowPeakMat);
        snowMesh.position.y = -22 + mainH - snowH / 2 + 0.15;
        snowMesh.rotation.y = mainBaseMesh.rotation.y;
        snowMesh.castShadow = false; snowMesh.receiveShadow = false;
        mHighGroup.add(snowMesh);

        const ridge1W = 125, ridge1H = 95;
        const ridge1Geo = new THREE.ConeGeometry(ridge1W, ridge1H, 6);
        const ridge1Mesh = new THREE.Mesh(ridge1Geo, ridgeMat);
        ridge1Mesh.position.set(-85, -22 + ridge1H / 2, 20);
        ridge1Mesh.rotation.y = 1.1;
        ridge1Mesh.castShadow = false; ridge1Mesh.receiveShadow = false;
        mHighGroup.add(ridge1Mesh);

        const snow1H = (ridge1H * 0.26) * 1.02, snow1W = (ridge1W * 0.26) * 1.025;
        const snow1Mesh = new THREE.Mesh(new THREE.ConeGeometry(snow1W, snow1H, 6), snowPeakMat);
        snow1Mesh.position.set(-85, -22 + ridge1H - snow1H / 2 + 0.15, 20);
        snow1Mesh.rotation.y = 1.1;
        snow1Mesh.castShadow = false; snow1Mesh.receiveShadow = false;
        mHighGroup.add(snow1Mesh);

        const ridge2W = 110, ridge2H = 80;
        const ridge2Geo = new THREE.ConeGeometry(ridge2W, ridge2H, 6);
        const ridge2Mesh = new THREE.Mesh(ridge2Geo, ridgeMat);
        ridge2Mesh.position.set(80, -22 + ridge2H / 2, -15);
        ridge2Mesh.rotation.y = 0.8;
        ridge2Mesh.castShadow = false; ridge2Mesh.receiveShadow = false;
        mHighGroup.add(ridge2Mesh);

        const snow2H = (ridge2H * 0.24) * 1.02, snow2W = (ridge2W * 0.24) * 1.025;
        const snow2Mesh = new THREE.Mesh(new THREE.ConeGeometry(snow2W, snow2H, 6), snowPeakMat);
        snow2Mesh.position.set(80, -22 + ridge2H - snow2H / 2 + 0.15, -15);
        snow2Mesh.rotation.y = 0.8;
        snow2Mesh.castShadow = false; snow2Mesh.receiveShadow = false;
        mHighGroup.add(snow2Mesh);

        // --- LOD 1: Medium Detail Mountain (Distance 220 - 360) ---
        const mMedGroup = new THREE.Group();
        const medMain = new THREE.Mesh(new THREE.ConeGeometry(mainW, mainH, 5), grandMountainMat);
        medMain.position.y = -22 + mainH / 2;
        medMain.rotation.y = 0.45;
        medMain.castShadow = false; medMain.receiveShadow = false;
        const medSnow = new THREE.Mesh(new THREE.ConeGeometry(snowW, snowH, 5), snowPeakMat);
        medSnow.position.y = -22 + mainH - snowH / 2 + 0.15;
        medSnow.rotation.y = 0.45;
        medSnow.castShadow = false; medSnow.receiveShadow = false;
        const medRidge1 = new THREE.Mesh(new THREE.ConeGeometry(ridge1W, ridge1H, 4), ridgeMat);
        medRidge1.position.set(-85, -22 + ridge1H / 2, 20);
        medRidge1.castShadow = false; medRidge1.receiveShadow = false;
        const medRidge2 = new THREE.Mesh(new THREE.ConeGeometry(ridge2W, ridge2H, 4), ridgeMat);
        medRidge2.position.set(80, -22 + ridge2H / 2, -15);
        medRidge2.castShadow = false; medRidge2.receiveShadow = false;
        mMedGroup.add(medMain, medSnow, medRidge1, medRidge2);

        // --- LOD 2: Low-Poly Distant Silhouette (Distance > 360) ---
        const mLowGroup = new THREE.Group();
        const lowMain = new THREE.Mesh(new THREE.ConeGeometry(mainW, mainH, 4), grandMountainMat);
        lowMain.position.y = -22 + mainH / 2;
        lowMain.castShadow = false; lowMain.receiveShadow = false;
        mLowGroup.add(lowMain);

        mountainLOD.addLevel(mHighGroup, 0);
        mountainLOD.addLevel(mMedGroup, 220);
        mountainLOD.addLevel(mLowGroup, 360);

        mountainLOD.position.set(35, 0, -270);
        mountainLOD.userData.nukeKeep = true; // the only landmark left after the nuke
        mountainLOD.castShadow = false;
        mountainLOD.receiveShadow = false;
        mountainLOD.matrixAutoUpdate = false;
        mountainLOD.updateMatrix();
        scene.add(mountainLOD);
        registerCullableObject(mountainLOD, 240);
    }
}

function applyWorldUVsToBox(geo, x, y, z, w, h, d, scaleX = 0.5, scaleY = 0.5) {
    const uvAttr = geo.attributes.uv;
    if (!uvAttr) return;
    const uvs = uvAttr.array;

    // Face 0: +X face (Right face, normal = +1, 0, 0)
    uvs[0] = -(z + d/2) * scaleX; uvs[1] = (y + h/2) * scaleY;
    uvs[2] = -(z - d/2) * scaleX; uvs[3] = (y + h/2) * scaleY;
    uvs[4] = -(z + d/2) * scaleX; uvs[5] = (y - h/2) * scaleY;
    uvs[6] = -(z - d/2) * scaleX; uvs[7] = (y - h/2) * scaleY;

    // Face 1: -X face (Left face, normal = -1, 0, 0)
    uvs[8]  = (z - d/2) * scaleX; uvs[9]  = (y + h/2) * scaleY;
    uvs[10] = (z + d/2) * scaleX; uvs[11] = (y + h/2) * scaleY;
    uvs[12] = (z - d/2) * scaleX; uvs[13] = (y - h/2) * scaleY;
    uvs[14] = (z + d/2) * scaleX; uvs[15] = (y - h/2) * scaleY;

    // Face 2: +Y face (Top face, normal = 0, +1, 0) - aligned in standard UV direction for crisp normals
    uvs[16] = (x - w/2) * scaleX; uvs[17] = (z - d/2) * scaleY;
    uvs[18] = (x + w/2) * scaleX; uvs[19] = (z - d/2) * scaleY;
    uvs[20] = (x - w/2) * scaleX; uvs[21] = (z + d/2) * scaleY;
    uvs[22] = (x + w/2) * scaleX; uvs[23] = (z + d/2) * scaleY;

    // Face 3: -Y face (Bottom face, normal = 0, -1, 0)
    uvs[24] = (x - w/2) * scaleX; uvs[25] = (z + d/2) * scaleY;
    uvs[26] = (x + w/2) * scaleX; uvs[27] = (z + d/2) * scaleY;
    uvs[28] = (x - w/2) * scaleX; uvs[29] = (z - d/2) * scaleY;
    uvs[30] = (x + w/2) * scaleX; uvs[31] = (z - d/2) * scaleY;

    // Face 4: +Z face (Front face / Towards +Z, normal = 0, 0, +1)
    uvs[32] = (x - w/2) * scaleX; uvs[33] = (y + h/2) * scaleY;
    uvs[34] = (x + w/2) * scaleX; uvs[35] = (y + h/2) * scaleY;
    uvs[36] = (x - w/2) * scaleX; uvs[37] = (y - h/2) * scaleY;
    uvs[38] = (x + w/2) * scaleX; uvs[39] = (y - h/2) * scaleY;

    // Face 5: -Z face (Back face / Towards -Z, normal = 0, 0, -1)
    uvs[40] = -(x + w/2) * scaleX; uvs[41] = (y + h/2) * scaleY;
    uvs[42] = -(x - w/2) * scaleX; uvs[43] = (y + h/2) * scaleY;
    uvs[44] = -(x + w/2) * scaleX; uvs[45] = (y - h/2) * scaleY;
    uvs[46] = -(x - w/2) * scaleX; uvs[47] = (y - h/2) * scaleY;

    uvAttr.needsUpdate = true;
    geo.setAttribute('uv2', uvAttr.clone());
    geo.computeVertexNormals();
    try {
        geo.computeTangents();
    } catch (_) {}
}

function createWalls() {
    // Inside wall configurable PBR textures
    const wallRepeatX = 1;
    const wallRepeatY = 1;

    const insideWallMat = createPBRMaterial({
        baseColorPath: 'uploads/VerticalPlankWall_BaseColor.png',
        normalPath: 'uploads/VerticalPlankWall_Normal_OpenGL.png',
        ormPath: 'uploads/VerticalPlankWall_ORM.png',
        repeatX: wallRepeatX,
        repeatY: wallRepeatY,
        defaultRoughness: 0.38,
        defaultMetalness: 0.05,
        bumpScale: 0.015,
        side: THREE.DoubleSide
    });

    // Outside wall configurable PBR textures (SupermarketBrick)
    const outsideWallRepeatX = 1;
    const outsideWallRepeatY = 1;

    const outsideWallMat = createPBRMaterial({
        baseColorPath: 'uploads/SupermarketBrick_BaseColor.png',
        normalPath: 'uploads/SupermarketBrick_Normal_OpenGL.png',
        ormPath: 'uploads/SupermarketBrick_ORM.png',
        repeatX: outsideWallRepeatX,
        repeatY: outsideWallRepeatY,
        defaultRoughness: 0.65,
        defaultMetalness: 0.05,
        bumpScale: 0.015,
        side: THREE.DoubleSide
    });

    // Multi-material setups for BoxGeometry ([+X, -X, +Y, -Y, +Z, -Z]):
    const backWallMats = [outsideWallMat, outsideWallMat, outsideWallMat, outsideWallMat, outsideWallMat, insideWallMat];
    const frontWallMats = [outsideWallMat, outsideWallMat, outsideWallMat, outsideWallMat, insideWallMat, outsideWallMat];
    const leftWallMats = [insideWallMat, outsideWallMat, outsideWallMat, outsideWallMat, outsideWallMat, outsideWallMat];
    const rightWallMats = [outsideWallMat, insideWallMat, outsideWallMat, outsideWallMat, outsideWallMat, outsideWallMat];

    const frameMat = new THREE.MeshStandardMaterial({
        color: 0x272B33, // sleek dark aluminum window framing
        roughness: 0.35,
        metalness: 0.6
    });

    // High-performance architectural glass with crisp sky environment reflections (zero transmission overhead)
    // Tinted: dark smoked-blue, mostly opaque so far less daylight reads through
    const glassMat = new THREE.MeshStandardMaterial({
        color: 0x1e2a3a,
        roughness: 0.05,
        metalness: 0.85,
        transparent: true,
        opacity: 0.72,
        depthWrite: false, // Prevents depth buffer fighting and depth sorting thrash
        side: THREE.FrontSide // Single-sided to eliminate alpha overdraw
    });

    // Helper to add physics box for a wall section
    const addWallSection = (x, y, z, w, h, d, material, isGlass = false) => {
        const geo = new THREE.BoxGeometry(w, h, d);
        applyWorldUVsToBox(geo, x, y, z, w, h, d, 0.5, 0.5);
        const mesh = new THREE.Mesh(geo, material);
        mesh.position.set(x, y, z);
        if (!isGlass) {
            mesh.castShadow = true;
            mesh.receiveShadow = true;
        } else {
            mesh.castShadow = false;
            mesh.receiveShadow = false;
        }
        scene.add(mesh);

        if (!isGlass) {
            const shape = new CANNON.Box(new CANNON.Vec3(w/2, h/2, d/2));
            const body = new CANNON.Body({ mass: 0, shape });
            body.position.set(x, y, z);
            world.addBody(body);
        }
        return mesh;
    };

    // Helper to create cohesive framed window unit with zero gaps/negative space
    const addFramedWindowX = (wallX, startZ, endZ, sillY, headY, wallD) => {
        const spanZ = endZ - startZ;
        const centerZ = (startZ + endZ) / 2;
        const winH = headY - sillY;
        const centerY = (sillY + headY) / 2;
        const frameThick = 0.08;
        const frameDepth = wallD + 0.04;

        // Outer Top & Bottom window sashes
        addWallSection(wallX, headY - frameThick/2, centerZ, frameDepth, frameThick, spanZ, frameMat);
        addWallSection(wallX, sillY + frameThick/2, centerZ, frameDepth, frameThick, spanZ, frameMat);

        // Outer Left & Right window sashes
        addWallSection(wallX, centerY, startZ + frameThick/2, frameDepth, winH - frameThick*2, frameThick, frameMat);
        addWallSection(wallX, centerY, endZ - frameThick/2, frameDepth, winH - frameThick*2, frameThick, frameMat);

        // Center vertical mullion for realism
        addWallSection(wallX, centerY, centerZ, frameDepth, winH - frameThick*2, frameThick, frameMat);

        // Seamless glass pane
        addWallSection(wallX, centerY, centerZ, 0.04, winH - 0.02, spanZ - 0.02, glassMat, true);
    };

    const addFramedWindowZ = (wallZ, startX, endX, sillY, headY, wallD, numMullions = 3) => {
        const spanX = endX - startX;
        const centerX = (startX + endX) / 2;
        const winH = headY - sillY;
        const centerY = (sillY + headY) / 2;
        const frameThick = 0.08;
        const frameDepth = wallD + 0.04;

        // Outer Top & Bottom window sashes
        addWallSection(centerX, headY - frameThick/2, wallZ, spanX, frameThick, frameDepth, frameMat);
        addWallSection(centerX, sillY + frameThick/2, wallZ, spanX, frameThick, frameDepth, frameMat);

        // Outer Left & Right window sashes
        addWallSection(startX + frameThick/2, centerY, wallZ, frameThick, winH - frameThick*2, frameDepth, frameMat);
        addWallSection(endX - frameThick/2, centerY, wallZ, frameThick, winH - frameThick*2, frameDepth, frameMat);

        // Vertical dividing mullions
        for (let m = 1; m <= numMullions; m++) {
            const mx = startX + (spanX / (numMullions + 1)) * m;
            addWallSection(mx, centerY, wallZ, frameThick, winH - frameThick*2, frameDepth, frameMat);
        }

        // Seamless glass pane
        addWallSection(centerX, centerY, wallZ, spanX - 0.02, winH - 0.02, 0.04, glassMat, true);
    };

    // Store Dimensions
    const W = 60; // 60x60 store footprint
    const H = CEILING_HEIGHT; // 5.5
    const D = 0.5; // wall thickness

    // 1. BACK WALL (Z = +30): Continuous solid wall
    addWallSection(0, H/2, 30, W, H, D, backWallMats);

    // Side window vertical bounds (sill at 1.2m, header at 4.0m)
    const sideSillY = 1.2;
    const sideHeadY = 4.0;
    const sideSillH = sideSillY; // 1.2
    const sideHeadH = H - sideHeadY; // 1.5

    // 2. LEFT WALL (X = -30): 100% gapless with two 8m framed windows at Z=-15 and Z=+15
    // Section 1: Z = -30 to -19 (length 11, center -24.5)
    addWallSection(-30, H/2, -24.5, D, H, 11, leftWallMats);
    // Window 1 Opening: Z = -19 to -11 (length 8, center -15)
    addWallSection(-30, sideSillH/2, -15, D, sideSillH, 8, leftWallMats); // Sill below
    addWallSection(-30, H - sideHeadH/2, -15, D, sideHeadH, 8, leftWallMats); // Header above
    addFramedWindowX(-30, -19, -11, sideSillY, sideHeadY, D); // Framed window + glass

    // Section 2: Z = -11 to +11 (length 22, center 0)
    addWallSection(-30, H/2, 0, D, H, 22, leftWallMats);

    // Window 2 Opening: Z = +11 to +19 (length 8, center +15)
    addWallSection(-30, sideSillH/2, 15, D, sideSillH, 8, leftWallMats); // Sill below
    addWallSection(-30, H - sideHeadH/2, 15, D, sideHeadH, 8, leftWallMats); // Header above
    addFramedWindowX(-30, 11, 19, sideSillY, sideHeadY, D); // Framed window + glass

    // Section 3: Z = +19 to +30 (length 11, center +24.5)
    addWallSection(-30, H/2, 24.5, D, H, 11, leftWallMats);

    // 3. RIGHT WALL (X = +30): 100% gapless mirrored with two framed windows
    // Section 1: Z = -30 to -19 (split around the restroom doorway; the +X face
    // between Z = -30 and -21.5 is the restroom's interior tiled wall)
    const bathMats = createBathroomMaterials();
    const bathChildStart = scene.children.length;
    const bathBodyStart = world.bodies.length;
    const rightBathMats = [bathMats.tile, insideWallMat, outsideWallMat, outsideWallMat, outsideWallMat, outsideWallMat];
    const bathDoorZ0 = BATHROOM.doorZ - BATHROOM.doorW / 2; // -28.8
    const bathDoorZ1 = BATHROOM.doorZ + BATHROOM.doorW / 2; // -27.0
    addWallSection(30, H/2, (-30 + bathDoorZ0) / 2, D, H, bathDoorZ0 + 30, rightBathMats);
    addWallSection(30, (BATHROOM.doorH + H) / 2, BATHROOM.doorZ, D, H - BATHROOM.doorH, BATHROOM.doorW, rightBathMats);
    addWallSection(30, H/2, (bathDoorZ1 + BATHROOM.z1) / 2, D, H, BATHROOM.z1 - bathDoorZ1, rightBathMats);
    addWallSection(30, H/2, (BATHROOM.z1 - 19) / 2, D, H, -19 - BATHROOM.z1, rightWallMats);
    createBathroom(addWallSection, bathMats, outsideWallMat, frameMat);
    // Remember the restroom annex: it is the only building to survive the nuke.
    scene.children.slice(bathChildStart).forEach(obj => { obj.userData.nukeKeep = true; obj.userData.nukeBathroom = true; });
    nukeShelterBodies = new Set(world.bodies.slice(bathBodyStart));
    nukeShelterMats = new Set(Object.values(bathMats));
    // Window 1 Opening: Z = -19 to -11
    addWallSection(30, sideSillH/2, -15, D, sideSillH, 8, rightWallMats);
    addWallSection(30, H - sideHeadH/2, -15, D, sideHeadH, 8, rightWallMats);
    addFramedWindowX(30, -19, -11, sideSillY, sideHeadY, D);

    // Section 2: Z = -11 to +11
    addWallSection(30, H/2, 0, D, H, 22, rightWallMats);

    // Window 2 Opening: Z = +11 to +19
    addWallSection(30, sideSillH/2, 15, D, sideSillH, 8, rightWallMats);
    addWallSection(30, H - sideHeadH/2, 15, D, sideHeadH, 8, rightWallMats);
    addFramedWindowX(30, 11, 19, sideSillY, sideHeadY, D);

    // Section 3: Z = +19 to +30
    addWallSection(30, H/2, 24.5, D, H, 11, rightWallMats);

    // 4. FRONT WALL (Z = -30): Large showcase storefront windows + entrance
    const frontSillY = 1.0;
    const frontHeadY = 4.0;
    const frontSillH = frontSillY; // 1.0
    const frontHeadH = H - frontHeadY; // 1.5

    // Left outer corner: X = -30 to -26 (width 4, center -28)
    addWallSection(-28, H/2, -30, 4, H, D, frontWallMats);

    // Left storefront window: X = -26 to -6 (width 20, center -16)
    addWallSection(-16, frontSillH/2, -30, 20, frontSillH, D, frontWallMats); // Sill below
    addWallSection(-16, H - frontHeadH/2, -30, 20, frontHeadH, D, frontWallMats); // Header above
    addFramedWindowZ(-30, -26, -6, frontSillY, frontHeadY, D, 3); // Window frame + 3 mullions + glass

    // Left entrance pillar: X = -6 to -4 (width 2, center -5)
    addWallSection(-5, H/2, -30, 2, H, D, frontWallMats);

    // Entrance opening header: X = -4 to +4 (width 8, center 0)
    addWallSection(0, H - frontHeadH/2, -30, 8, frontHeadH, D, frontWallMats);

    // Right entrance pillar: X = +4 to +6 (width 2, center +5)
    addWallSection(5, H/2, -30, 2, H, D, frontWallMats);

    // Right storefront window: X = +6 to +26 (width 20, center +16)
    addWallSection(16, frontSillH/2, -30, 20, frontSillH, D, frontWallMats); // Sill below
    addWallSection(16, H - frontHeadH/2, -30, 20, frontHeadH, D, frontWallMats); // Header above
    addFramedWindowZ(-30, 6, 26, frontSillY, frontHeadY, D, 3); // Window frame + 3 mullions + glass

    // Right outer corner: X = +26 to +30 (width 4, center +28)
    addWallSection(28, H/2, -30, 4, H, D, frontWallMats);

    // 5. PARAPET / UPPER EXTERIOR FACADE (Above ceiling height Y = 5.5 to 8.5)
    const parapetH = 3.0;
    const parapetY = H + parapetH / 2;
    addWallSection(0, parapetY, 30, W, parapetH, D, outsideWallMat);
    addWallSection(0, parapetY, -30, W, parapetH, D, outsideWallMat);
    addWallSection(-30, parapetY, 0, D, parapetH, W, outsideWallMat);
    addWallSection(30, parapetY, 0, D, parapetH, W, outsideWallMat);

    // Automatic sliding glass doors at front entrance (opening width 8, height 4.0)
    createFrontDoors(glassMat, frameMat, 8, frontHeadY);

    // Exterior sign "magmart" centered above entrance
    createMagMartSign();

    // Store references
    storeEnv.walls = {
        back: { x: 0, y: H/2, z: 30 },
        front: { x: 0, y: H/2, z: -30 },
        left: { x: -30, y: H/2, z: 0 },
        right: { x: 30, y: H/2, z: 0 }
    };
}

// ---------------------------------------------------------------------------
// RESTROOM EXPANSION (cosmetic): single-stall bathroom annex bolted onto the
// outside of the east wall (X = +30) next to the front-right corner, near
// the checkout. Entered through a swinging door in the east wall.
// ---------------------------------------------------------------------------
const BATHROOM = {
    x0: 30, x1: 36,        // store wall center -> annex east wall center
    z0: -30, z1: -21.5,    // annex front wall center -> annex north wall center
    doorZ: -27.9,          // doorway center along the store's east wall
    doorW: 1.8,
    doorH: 3.5,
    ceilH: 4.2
};
let bathroomDoor = null;
let bathroomStallDoor = null;

function createBathroomMaterials() {
    const makeTex = (size, draw, repX = 1, repY = 1) => {
        const c = document.createElement('canvas');
        c.width = c.height = size;
        draw(c.getContext('2d'), size);
        const t = new THREE.CanvasTexture(c);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(repX, repY);
        t.colorSpace = THREE.SRGBColorSpace;
        return t;
    };

    // Glossy white subway-ish wall tile with a mint accent band
    const wallTex = makeTex(256, (ctx, s) => {
        ctx.fillStyle = '#b9c2c7';
        ctx.fillRect(0, 0, s, s);
        const n = 4, g = 3, ts = s / n;
        for (let y = 0; y < n; y++) {
            for (let x = 0; x < n; x++) {
                const v = 238 + ((x * 7 + y * 13) % 5) * 3;
                ctx.fillStyle = `rgb(${v},${v},${Math.min(255, v + 4)})`;
                ctx.fillRect(x * ts + g / 2, y * ts + g / 2, ts - g, ts - g);
            }
        }
    });
    const tile = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.18, metalness: 0.05 });

    // Blue/grey checker floor tile
    const floorTex = makeTex(128, (ctx, s) => {
        const h = s / 2;
        ctx.fillStyle = '#6f8aa0'; ctx.fillRect(0, 0, s, s);
        ctx.fillStyle = '#dfe6ec'; ctx.fillRect(0, 0, h, h); ctx.fillRect(h, h, h, h);
        ctx.strokeStyle = 'rgba(40,50,60,0.35)'; ctx.lineWidth = 2;
        ctx.strokeRect(0, 0, h, h); ctx.strokeRect(h, h, h, h);
        ctx.strokeRect(h, 0, h, h); ctx.strokeRect(0, h, h, h);
    }, 6, 8);
    const floor = new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.3, metalness: 0.05 });

    return {
        tile,
        floor,
        ceiling: new THREE.MeshStandardMaterial({ color: 0xf1f3f5, roughness: 0.9 }),
        roof: new THREE.MeshStandardMaterial({ color: 0x3a3f47, roughness: 0.95 }),
        partition: new THREE.MeshStandardMaterial({ color: 0x5f8fa6, roughness: 0.45, metalness: 0.15 }),
        porcelain: new THREE.MeshStandardMaterial({ color: 0xfbfcfd, roughness: 0.12, metalness: 0.02 }),
        chrome: new THREE.MeshStandardMaterial({ color: 0xe5e7eb, roughness: 0.12, metalness: 0.95 }),
        mirror: new THREE.MeshStandardMaterial({ color: 0xdfe8ee, roughness: 0.02, metalness: 1.0 }),
        stone: new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.3, metalness: 0.1 }),
        cabinet: new THREE.MeshStandardMaterial({ color: 0x8a6a4a, roughness: 0.6 }),
        door: new THREE.MeshStandardMaterial({ color: 0x7a5236, roughness: 0.55, metalness: 0.05 }),
        dark: new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.6 }),
        paper: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 })
    };
}

function createBathroom(addWallSection, m, outsideWallMat, frameMat) {
    const { x0, x1, z0, z1, ceilH, doorZ, doorW, doorH } = BATHROOM;
    const D = 0.5;
    const out = outsideWallMat;
    const ix0 = x0 + D / 2, ix1 = x1 - D / 2; // interior X: 30.25 .. 35.75
    const iz0 = z0 + D / 2, iz1 = z1 - D / 2; // interior Z: -29.75 .. -21.75
    const icx = (ix0 + ix1) / 2, icz = (iz0 + iz1) / 2;

    const box = (w, h, d, mat, x, y, z, parent = scene) => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
        mesh.position.set(x, y, z);
        parent.add(mesh);
        return mesh;
    };
    const cyl = (rt, rb, h, mat, x, y, z, parent = scene, seg = 20) => {
        const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
        mesh.position.set(x, y, z);
        parent.add(mesh);
        return mesh;
    };
    const solid = (hx, hy, hz, x, y, z) => {
        const body = new CANNON.Body({ mass: 0, shape: new CANNON.Box(new CANNON.Vec3(hx, hy, hz)) });
        body.position.set(x, y, z);
        world.addBody(body);
    };

    // --- Shell: three exterior walls (brick outside, tile inside) + roof slab ---
    const fw = ix1 - x0; // 30 -> 35.75 (closes the corner notch at the store wall)
    addWallSection(x0 + fw / 2, ceilH / 2, z0, fw, ceilH, D, [out, out, out, out, m.tile, out]);
    addWallSection(x0 + fw / 2, ceilH / 2, z1, fw, ceilH, D, [out, out, out, out, out, m.tile]);
    addWallSection(x1, ceilH / 2, (z0 + z1) / 2, D, ceilH, (z1 - z0) + D, [out, m.tile, out, out, out, out]);
    const roofOver = 0.15;
    const roofW = (x1 + D / 2 + roofOver) - ix0;
    const roofD = (z1 - z0) + D + roofOver * 2;
    addWallSection(ix0 + roofW / 2, ceilH + 0.15, (z0 + z1) / 2, roofW, 0.3, roofD,
        [m.dark, m.dark, m.roof, m.ceiling, m.dark, m.dark]);

    // Floor (extends under the doorway threshold to meet the store floor)
    const floorW = ix1 - (x0 - D / 2);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(floorW, iz1 - iz0), m.floor);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set((x0 - D / 2) + floorW / 2, 0.006, icz);
    floor.material.map.repeat.set(floorW / 1.0, (iz1 - iz0) / 1.0);
    floor.receiveShadow = true;
    scene.add(floor);

    // Ceiling light panel
    const lightMat = new THREE.MeshBasicMaterial({ color: 0xfffdf2 });
    box(1.4, 0.05, 1.4, frameMat, icx, ceilH - 0.03, icz - 1.2);
    box(1.3, 0.02, 1.3, lightMat, icx, ceilH - 0.06, icz - 1.2);

    // --- Door frame (store side + bathroom side trim) ---
    const dz0 = doorZ - doorW / 2, dz1 = doorZ + doorW / 2;
    // Trim sits slightly proud of the wall's opening faces on every side so no
    // face is coplanar with the wall (that caused z-fighting on the jambs/head).
    const trimD = D + 0.08;
    const lip = 0.02;
    box(trimD, 0.12 + lip, doorW + 0.24, frameMat, x0, doorH + 0.06 - lip / 2, doorZ);
    box(trimD - 0.004, doorH - lip, 0.12 + lip, frameMat, x0, (doorH - lip) / 2, dz0 - 0.06 + lip / 2);
    box(trimD - 0.004, doorH - lip, 0.12 + lip, frameMat, x0, (doorH - lip) / 2, dz1 + 0.06 - lip / 2);

    // Swinging door (hinged on the corner side, opens into the restroom)
    const pivot = new THREE.Group();
    pivot.position.set(x0 + 0.1, 0, dz0);
    scene.add(pivot);
    const leafW = doorW - 0.08, leafH = doorH - 0.08;
    const leaf = box(0.06, leafH, leafW, m.door, 0, leafH / 2 + 0.02, leafW / 2 + 0.04, pivot);
    leaf.castShadow = true;
    // Push plates + round sign on both faces
    [-1, 1].forEach(side => {
        box(0.01, 0.4, 0.14, m.chrome, side * 0.036, 1.5, leafW - 0.25, pivot);
    });
    bathroomDoor = { pivot, angle: 0, target: 0 };

    // "RESTROOM" sign above the doorway (store side)
    {
        const c = document.createElement('canvas');
        c.width = 512; c.height = 160;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#1e3a5f';
        ctx.fillRect(0, 0, 512, 160);
        ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 8;
        ctx.strokeRect(8, 8, 496, 144);
        // Stick-figure icons
        const fig = (cx, dress) => {
            ctx.fillStyle = '#ffffff';
            ctx.beginPath(); ctx.arc(cx, 44, 14, 0, Math.PI * 2); ctx.fill();
            if (dress) {
                ctx.beginPath(); ctx.moveTo(cx, 62); ctx.lineTo(cx + 24, 116); ctx.lineTo(cx - 24, 116); ctx.closePath(); ctx.fill();
            } else {
                ctx.fillRect(cx - 14, 62, 28, 54);
            }
            ctx.fillRect(cx - 10, 112, 8, 28); ctx.fillRect(cx + 2, 112, 8, 28);
        };
        fig(60, false); fig(116, true);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 64px "Arial Black", Impact, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('RESTROOM', 330, 84);
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.75), new THREE.MeshBasicMaterial({ map: tex }));
        sign.position.set(x0 - D / 2 - 0.02, doorH + 0.75, doorZ);
        sign.rotation.y = -Math.PI / 2;
        scene.add(sign);
    }

    // --- Single stall in the far (north) end ---
    const sx0 = 32.3;                 // stall side partition X
    const sz0 = -24.9;                // stall front partition Z
    const pBot = 0.3, pTop = 3.1, pH = pTop - pBot, pY = (pBot + pTop) / 2, pT = 0.06;
    const sdx0 = 33.15, sdx1 = 34.9;  // stall door opening X
    // Side partition
    box(pT, pH, iz1 - sz0, m.partition, sx0, pY, (sz0 + iz1) / 2);
    solid(pT / 2 + 0.02, pH / 2, (iz1 - sz0) / 2, sx0, pY, (sz0 + iz1) / 2);
    // Front partition pieces either side of the stall door
    box(sdx0 - sx0, pH, pT, m.partition, (sx0 + sdx0) / 2, pY, sz0);
    solid((sdx0 - sx0) / 2, pH / 2, pT / 2 + 0.02, (sx0 + sdx0) / 2, pY, sz0);
    box(ix1 - sdx1, pH, pT, m.partition, (sdx1 + ix1) / 2, pY, sz0);
    solid((ix1 - sdx1) / 2, pH / 2, pT / 2 + 0.02, (sdx1 + ix1) / 2, pY, sz0);
    // Corner pilaster + chrome shoe, and headrail over the door
    box(0.1, pTop + 0.05, 0.1, m.partition, sx0, (pTop + 0.05) / 2, sz0);
    box(0.13, 0.12, 0.13, m.chrome, sx0, 0.06, sz0);
    box(ix1 - sx0, 0.06, 0.08, m.chrome, (sx0 + ix1) / 2, pTop + 0.03, sz0);
    // Stall door swings inward when someone approaches from either side.
    const sPivot = new THREE.Group();
    sPivot.position.set(sdx0 + 0.02, 0, sz0);
    scene.add(sPivot);
    const sdW = sdx1 - sdx0 - 0.06;
    box(sdW, pH, 0.05, m.partition, sdW / 2, pY, 0, sPivot);
    box(0.08, 0.05, 0.05, m.chrome, sdW - 0.12, 1.45, -0.05, sPivot);
    box(0.08, 0.05, 0.05, m.chrome, sdW - 0.12, 1.45, 0.05, sPivot);
    box(0.06, 0.04, 0.02, new THREE.MeshBasicMaterial({ color: 0x22c55e }), sdW - 0.12, 1.6, -0.04, sPivot);
    const stallBody = new CANNON.Body({
        mass: 0, type: CANNON.Body.KINEMATIC,
        shape: new CANNON.Box(new CANNON.Vec3(sdW / 2, pH / 2, 0.025))
    });
    stallBody.position.set(sPivot.position.x + sdW / 2, pY, sz0);
    world.addBody(stallBody);
    bathroomStallDoor = { pivot: sPivot, body: stallBody, width: sdW, height: pY, angle: 0, target: 0 };

    // Toilet against the north wall, facing the stall door
    {
        const t = new THREE.Group();
        t.position.set((sx0 + ix1) / 2, 0, iz1);
        scene.add(t);
        bathroomToilet = t;
        cyl(0.17, 0.22, 0.5, m.porcelain, 0, 0.25, -0.5, t);
        const bowl = cyl(0.3, 0.2, 0.24, m.porcelain, 0, 0.6, -0.52, t);
        bowl.scale.z = 1.3;
        const water = cyl(0.23, 0.23, 0.01, new THREE.MeshStandardMaterial({ color: 0x9ed6ea, roughness: 0.05, metalness: 0.3 }), 0, 0.68, -0.54, t);
        water.scale.z = 1.25;
        const seat = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.045, 10, 28), m.porcelain);
        seat.rotation.x = -Math.PI / 2;
        seat.scale.y = 1.3; // elongates along world Z after rotation
        seat.position.set(0, 0.74, -0.54);
        t.add(seat);
        const lid = box(0.56, 0.66, 0.04, m.porcelain, 0, 1.06, -0.32, t);
        lid.rotation.x = 0.12;
        box(0.64, 0.66, 0.26, m.porcelain, 0, 1.05, -0.14, t);  // tank
        box(0.68, 0.05, 0.3, m.porcelain, 0, 1.405, -0.14, t);  // tank lid
        box(0.12, 0.03, 0.04, m.chrome, -0.24, 1.26, -0.29, t); // flush handle
        solid(0.33, 0.45, 0.45, t.position.x, 0.45, iz1 - 0.45);

        // Toilet paper holder on the side partition
        box(0.06, 0.08, 0.3, m.chrome, sx0 + 0.06, 1.0, iz1 - 0.95);
        const roll = cyl(0.09, 0.09, 0.22, m.paper, sx0 + 0.16, 0.95, iz1 - 0.95, scene, 16);
        roll.rotation.x = Math.PI / 2;
    }

    // Urinal immediately to the right of the stall wall as seen from the entrance.
    {
        const uz = -25.48, ux = ix1 - 0.22;
        box(0.16, 0.8, 0.58, m.porcelain, ix1 - 0.08, 0.97, uz);
        const bowl = new THREE.Mesh(new THREE.SphereGeometry(0.32, 20, 14, 0, Math.PI * 2, 0, Math.PI / 2), m.porcelain);
        bowl.rotation.z = Math.PI / 2; // curves out from the east wall into the room
        bowl.scale.set(0.75, 0.9, 1);
        bowl.position.set(ux - 0.06, 0.8, uz);
        scene.add(bowl);
        const inner = new THREE.Mesh(new THREE.SphereGeometry(0.22, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2),
            new THREE.MeshStandardMaterial({ color: 0xc7dbe1, roughness: 0.28, side: THREE.DoubleSide }));
        inner.rotation.z = Math.PI / 2;
        inner.position.set(ux - 0.235, 0.81, uz);
        scene.add(inner);
        box(0.1, 0.1, 0.1, m.chrome, ix1 - 0.14, 1.58, uz);
        box(0.06, 0.38, 0.06, m.chrome, ix1 - 0.14, 1.34, uz);
        box(0.34, 0.2, 0.42, m.porcelain, ux - 0.08, 0.48, uz);
        solid(0.35, 0.55, 0.38, ix1 - 0.25, 0.55, uz);
    }

    // --- Sink vanity + mirror on the east wall, by the entrance ---
    {
        const vz = -28.2, vw = 1.6, vd = 0.7;
        const vx = ix1 - vd / 2;
        box(vd - 0.05, 0.84, vw, m.cabinet, vx + 0.025, 0.42, vz);
        box(vd + 0.02, 0.06, vw + 0.06, m.stone, vx - 0.01, 0.87, vz);
        const basin = cyl(0.26, 0.2, 0.05, m.porcelain, vx - 0.05, 0.9, vz);
        basin.scale.x = 0.8;
        const drain = cyl(0.03, 0.03, 0.01, m.chrome, vx - 0.05, 0.93, vz);
        drain.scale.x = 0.8;
        cyl(0.03, 0.035, 0.3, m.chrome, ix1 - 0.12, 1.05, vz);            // faucet riser
        box(0.22, 0.04, 0.05, m.chrome, ix1 - 0.22, 1.2, vz);              // spout
        box(0.04, 0.03, 0.14, m.chrome, ix1 - 0.12, 1.22, vz);             // handle
        solid(vd / 2, 0.45, vw / 2, vx, 0.45, vz);
        // Mirror
        box(0.03, 1.5, 1.4, frameMat, ix1 - 0.015, 2.1, vz);
        box(0.02, 1.4, 1.3, m.mirror, ix1 - 0.035, 2.1, vz);
        // Soap dispenser
        box(0.1, 0.22, 0.14, m.dark, ix1 - 0.05, 1.3, vz + 0.62);
    }

    // Trash can beside the vanity
    cyl(0.22, 0.19, 0.7, m.dark, ix1 - 0.3, 0.35, -26.9);
    solid(0.22, 0.35, 0.22, ix1 - 0.3, 0.35, -26.9);

    // Hand dryer on the south wall
    box(0.35, 0.3, 0.2, m.chrome, 34.3, 1.6, iz0 + 0.1);
}

const CANNON_Y_AXIS = new CANNON.Vec3(0, 1, 0);
function updateBathroomDoor(delta) {
    if (!playerBody) return;
    const p = playerBody.position;
    const k = 1 - Math.exp(-(delta || 0.016) * 6);
    if (bathroomDoor) {
        const dx = p.x - BATHROOM.x0, dz = p.z - BATHROOM.doorZ;
        bathroomDoor.target = (dx * dx + dz * dz < 3.2 * 3.2) ? 1.5 : 0;
        bathroomDoor.angle += (bathroomDoor.target - bathroomDoor.angle) * k;
        bathroomDoor.pivot.rotation.y = bathroomDoor.angle;
    }
    if (bathroomStallDoor) {
        const door = bathroomStallDoor;
        const dx = p.x - (door.pivot.position.x + door.width / 2);
        const dz = p.z - door.pivot.position.z;
        door.target = Math.hypot(dx, dz) < 2.15 ? -1.4 : 0;
        door.angle += (door.target - door.angle) * k;
        door.pivot.rotation.y = door.angle;
        door.body.position.set(
            door.pivot.position.x + Math.cos(door.angle) * door.width / 2,
            door.height,
            door.pivot.position.z - Math.sin(door.angle) * door.width / 2
        );
        door.body.quaternion.setFromAxisAngle(CANNON_Y_AXIS, door.angle);
        door.body.aabbNeedsUpdate = true;
    }
}

// Constant per-part local transforms for instanced parking-lot cars, built once.
const CAR_PART = (() => {
    const one = new THREE.Vector3(1, 1, 1);
    const wheelRot = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 2));
    const wheel = (x, z) => new THREE.Matrix4().compose(new THREE.Vector3(x, 0.34, z), wheelRot, one);
    return {
        body: new THREE.Matrix4().makeTranslation(0, 0.62, 0),
        cabin: new THREE.Matrix4().makeTranslation(0, 1.08, 0.15),
        wheels: [wheel(-0.74, 1.35), wheel(0.74, 1.35), wheel(-0.74, -1.35), wheel(0.74, -1.35)],
        headL: new THREE.Matrix4().makeTranslation(-0.62, 0.62, 2.11),
        headR: new THREE.Matrix4().makeTranslation(0.62, 0.62, 2.11),
        tailL: new THREE.Matrix4().makeTranslation(-0.62, 0.62, -2.11),
        tailR: new THREE.Matrix4().makeTranslation(0.62, 0.62, -2.11)
    };
})();
const _carM = new THREE.Matrix4();
const _carTmp = new THREE.Matrix4();
const _carQ = new THREE.Quaternion();
const _carP = new THREE.Vector3();
const _carS = new THREE.Vector3(1, 1, 1);
const _carYAxis = new THREE.Vector3(0, 1, 0);

function updateCarInstanceTransform(i, car) {
    const meshes = carInstancedMeshes;
    if (!meshes.bodyMesh) return;
    _carQ.setFromAxisAngle(_carYAxis, car.heading);
    _carM.compose(_carP.set(car.x, 0, car.z), _carQ, _carS);
    const place = (mesh, index, part) => mesh.setMatrixAt(index, _carTmp.copy(_carM).multiply(part));
    place(meshes.bodyMesh, i, CAR_PART.body);
    place(meshes.cabinMesh, i, CAR_PART.cabin);
    for (let w = 0; w < 4; w++) place(meshes.wheelMesh, i * 4 + w, CAR_PART.wheels[w]);
    place(meshes.headMesh, i * 2, CAR_PART.headL);
    place(meshes.headMesh, i * 2 + 1, CAR_PART.headR);
    place(meshes.tailMesh, i * 2, CAR_PART.tailL);
    place(meshes.tailMesh, i * 2 + 1, CAR_PART.tailR);
}

function updateDrivingCars(delta) {
    if (!parkingLotCars || !parkingLotCars.length || !carInstancedMeshes.bodyMesh) return;
    let needsUpdate = false;

    parkingLotCars.forEach((car, i) => {
        if (!car.isDriving) return;
        needsUpdate = true;

        if (!car.driveState) car.driveState = 'backing_out';
        if (!car.driveSpeed) car.driveSpeed = 2.0;

        if (car.driveState === 'backing_out') {
            const revSpeed = 2.4;
            car.x += Math.sin(car.heading) * revSpeed * delta;
            car.z += Math.cos(car.heading) * revSpeed * delta;
            car.backupDist = (car.backupDist || 0) + revSpeed * delta;
            if (car.backupDist >= 4.0) {
                car.driveState = 'turning';
                car.targetHeading = car.x > 0 ? -Math.PI / 2 : Math.PI / 2;
            }
        } else if (car.driveState === 'turning') {
            const turnSpeed = 2.0;
            const diff = (car.targetHeading || -Math.PI / 2) - car.heading;
            if (Math.abs(diff) > 0.08) {
                car.heading += Math.sign(diff) * turnSpeed * delta;
            } else {
                car.heading = car.targetHeading;
                car.driveState = 'driving_away';
            }
            car.x -= Math.sin(car.heading) * 3.0 * delta;
            car.z -= Math.cos(car.heading) * 3.0 * delta;
        } else if (car.driveState === 'driving_away') {
            car.driveSpeed = Math.min(11.0, car.driveSpeed + delta * 4.5);
            car.x -= Math.sin(car.heading) * car.driveSpeed * delta;
            car.z -= Math.cos(car.heading) * car.driveSpeed * delta;

            if (car.z < -160 || Math.abs(car.x) > 160) {
                car.isDriving = false;
                car.assigned = false;
                car.driveState = null;
                car.backupDist = 0;
                if (car.origX !== undefined) {
                    car.x = car.origX;
                    car.z = car.origZ;
                    car.heading = car.origHeading;
                }
            }
        }

        updateCarInstanceTransform(i, car);
    });

    if (needsUpdate) {
        if (carInstancedMeshes.bodyMesh) carInstancedMeshes.bodyMesh.instanceMatrix.needsUpdate = true;
        if (carInstancedMeshes.cabinMesh) carInstancedMeshes.cabinMesh.instanceMatrix.needsUpdate = true;
        if (carInstancedMeshes.wheelMesh) carInstancedMeshes.wheelMesh.instanceMatrix.needsUpdate = true;
        if (carInstancedMeshes.headMesh) carInstancedMeshes.headMesh.instanceMatrix.needsUpdate = true;
        if (carInstancedMeshes.tailMesh) carInstancedMeshes.tailMesh.instanceMatrix.needsUpdate = true;
    }
}

function createFrontDoors(glassMat, frameMat, entranceWidth, doorOpeningH = 4.0) {
    const doorGroup = new THREE.Group();
    doorGroup.position.set(0, 0, -30);
    scene.add(doorGroup);

    // Each door is 4.15m wide to generously overlap center and seal into wall jambs (zero side gaps)
    const doorW = 4.15;
    const doorH = doorOpeningH + 0.04; // 4.04m tall (extends into the upper track channel)
    const doorThick = 0.06;
    const closedLeftX = -doorW / 2; // -2.075m
    const closedRightX = doorW / 2; // +2.075m
    const maxSlide = 3.3; // Opens up to 6.6m width

    // Overhead guide track header - mounted on the face of the header (offset in Z to eliminate coplanar Z-fighting)
    const trackMesh = new THREE.Mesh(
        new THREE.BoxGeometry(entranceWidth + 4.0, 0.16, 0.16),
        frameMat
    );
    trackMesh.position.set(0, doorOpeningH + 0.08, 0.12);
    doorGroup.add(trackMesh);

    // Floor guide threshold
    const thresholdMesh = new THREE.Mesh(
        new THREE.BoxGeometry(entranceWidth + 4.0, 0.02, 0.14),
        frameMat
    );
    thresholdMesh.position.set(0, 0.01, 0.06);
    doorGroup.add(thresholdMesh);

    // Helper for framed glass sliding door panel
    const createSlidingDoorPane = () => {
        const paneGroup = new THREE.Group();
        const fThick = 0.08;

        // Glass
        const glass = new THREE.Mesh(new THREE.BoxGeometry(doorW - fThick*2, doorH - fThick*2, 0.03), glassMat);
        glass.position.set(0, doorH / 2, 0);
        glass.castShadow = false;
        glass.receiveShadow = false;
        paneGroup.add(glass);

        // Metal frame perimeter
        const topF = new THREE.Mesh(new THREE.BoxGeometry(doorW, fThick, doorThick), frameMat);
        topF.position.set(0, doorH - fThick/2, 0);
        const botF = new THREE.Mesh(new THREE.BoxGeometry(doorW, fThick, doorThick), frameMat);
        botF.position.set(0, fThick/2, 0);
        const leftF = new THREE.Mesh(new THREE.BoxGeometry(fThick, doorH - fThick*2, doorThick), frameMat);
        leftF.position.set(-doorW/2 + fThick/2, doorH/2, 0);
        const rightF = new THREE.Mesh(new THREE.BoxGeometry(fThick, doorH - fThick*2, doorThick), frameMat);
        rightF.position.set(doorW/2 - fThick/2, doorH/2, 0);

        // Center push/pull handle
        const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.8, 12), frameMat);
        handle.position.set(0, doorH * 0.45, 0.04);
        paneGroup.add(topF, botF, leftF, rightF, handle);
        return paneGroup;
    };

    // Left door (default closed position: center at closedLeftX, mounted in sliding plane Z = 0.04)
    const leftPane = createSlidingDoorPane();
    leftPane.position.set(closedLeftX, 0, 0.03);
    doorGroup.add(leftPane);

    // Right door (default closed position: center at closedRightX, mounted in sliding plane Z = 0.09)
    const rightPane = createSlidingDoorPane();
    rightPane.position.set(closedRightX, 0, 0.09);
    doorGroup.add(rightPane);

    // Physics bodies for closed state
    const leftBody = new CANNON.Body({
        mass: 0,
        shape: new CANNON.Box(new CANNON.Vec3(doorW/2, doorH/2, 0.05))
    });
    leftBody.position.set(closedLeftX, doorH/2, -30);
    world.addBody(leftBody);

    const rightBody = new CANNON.Body({
        mass: 0,
        shape: new CANNON.Box(new CANNON.Vec3(doorW/2, doorH/2, 0.05))
    });
    rightBody.position.set(closedRightX, doorH/2, -30);
    world.addBody(rightBody);

    autoDoors = {
        group: doorGroup,
        leftPane,
        rightPane,
        leftBody,
        rightBody,
        open: false,
        closedLeftX,
        closedRightX,
        maxSlide
    };
}

function createMagMartSign() {
    const signGroup = new THREE.Group();
    signGroup.position.set(0, 0, -30);
    scene.add(signGroup);

    // 1. Grand Marquee Sign Lightbox centered on exterior facade above entrance
    const signW = 22;
    const signH = 3.6;
    const signD = 0.5;
    const signY = CEILING_HEIGHT + 1.25; // y = 6.75m

    const signBox = new THREE.Mesh(
        new THREE.BoxGeometry(signW, signH, signD),
        new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.3, metalness: 0.5 })
    );
    signBox.position.set(0, signY, -0.42);
    signGroup.add(signBox);

    // Glowing ruby & gold neon perimeter trim
    const neonMat = new THREE.MeshStandardMaterial({ 
        color: 0xff1e46, 
        emissive: 0xe11d48, 
        emissiveIntensity: 0.9, 
        roughness: 0.2 
    });
    const topTrim = new THREE.Mesh(new THREE.BoxGeometry(signW + 0.3, 0.12, signD + 0.08), neonMat);
    topTrim.position.set(0, signY + signH / 2, -0.42);
    const botTrim = new THREE.Mesh(new THREE.BoxGeometry(signW + 0.3, 0.12, signD + 0.08), neonMat);
    botTrim.position.set(0, signY - signH / 2, -0.42);
    signGroup.add(topTrim, botTrim);

    // Architectural Sign Spotlight Fixtures
    const spotFixtureMat = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.8, roughness: 0.2 });
    [-8, -3, 3, 8].forEach(sx => {
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.8, 8), spotFixtureMat);
        arm.position.set(sx, signY + signH / 2 + 0.3, -0.75);
        arm.rotation.x = Math.PI / 4;
        const hood = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.32, 12), spotFixtureMat);
        hood.position.set(sx, signY + signH / 2 + 0.55, -0.95);
        hood.rotation.x = Math.PI * 0.75;
        signGroup.add(arm, hood);
    });

    // Extruded 3D MagMart logo on both faces of the exterior marquee.
    addMagMartLogo3D(signBox, true);

    // 2. Modern Cantilevered Entrance Portico / Canopy (Z = -30.0 to -34.8)
    const canopyW = 15.0;
    const canopyD = 4.8;
    const canopyH = 0.25;
    const canopyY = 4.3;

    const canopyDeck = new THREE.Mesh(
        new THREE.BoxGeometry(canopyW, canopyH, canopyD),
        new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.35, metalness: 0.6 })
    );
    canopyDeck.position.set(0, canopyY, -canopyD / 2);
    signGroup.add(canopyDeck);

    // Canopy Fascia Trim (Accent color)
    const fasciaMat = new THREE.MeshStandardMaterial({ color: 0xe11d48, roughness: 0.3, metalness: 0.2 });
    const frontFascia = new THREE.Mesh(new THREE.BoxGeometry(canopyW + 0.2, 0.38, 0.1), fasciaMat);
    frontFascia.position.set(0, canopyY, -canopyD);
    const leftFascia = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.38, canopyD), fasciaMat);
    leftFascia.position.set(-canopyW / 2, canopyY, -canopyD / 2);
    const rightFascia = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.38, canopyD), fasciaMat);
    rightFascia.position.set(canopyW / 2, canopyY, -canopyD / 2);
    signGroup.add(frontFascia, leftFascia, rightFascia);

    // Entrance Transom Lightbox on the canopy front
    const transomBox = new THREE.Mesh(
        new THREE.BoxGeometry(7.0, 0.6, 0.12),
        new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.4 })
    );
    transomBox.position.set(0, canopyY, -canopyD - 0.05);
    signGroup.add(transomBox);
    addTextToSign("WELCOME TO MAGMART • OPEN 24/7", transomBox, 0.6, 0.05, 0xFBBF24, false);

    // Structural Brushed Steel Pillars with Concrete Safety Bases
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.85, roughness: 0.25 });
    const bollardMat = new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.5 });
    [-6.2, 6.2].forEach(px => {
        // Base bollard
        const base = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 0.8, 16), bollardMat);
        base.position.set(px, 0.4, -canopyD + 0.35);
        // Column mast
        const col = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, canopyY - 0.8, 16), pillarMat);
        col.position.set(px, 0.8 + (canopyY - 0.8) / 2, -canopyD + 0.35);
        signGroup.add(base, col);
    });

    // Warm Recessed Downlight Glows under the canopy
    [-4.0, 0, 4.0].forEach(lx => {
        const fixture = new THREE.Mesh(
            new THREE.CylinderGeometry(0.22, 0.22, 0.04, 16),
            new THREE.MeshBasicMaterial({ color: 0xfffae0 })
        );
        fixture.position.set(lx, canopyY - 0.13, -canopyD / 2);
        signGroup.add(fixture);
    });

    // 3. Parapet Roofline Decorative Cornice Cap along entire front (X = -30 to +30)
    const corniceMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.4, metalness: 0.3 });
    const roofCornice = new THREE.Mesh(new THREE.BoxGeometry(60.4, 0.35, 0.8), corniceMat);
    roofCornice.position.set(0, 8.6, -0.3);
    signGroup.add(roofCornice);

    // 4. Exterior Storefront Showcase Window Promotional Decals
    const createPromoDecal = (xPos, title, subtitle, color) => {
        const c = document.createElement('canvas');
        c.width = 512; c.height = 256;
        const ctx = c.getContext('2d');
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 512, 256);
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 8;
        ctx.strokeRect(10, 10, 492, 236);
        ctx.fillStyle = '#FFFFFF';
        ctx.font = '900 48px "Arial Black", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(title, 256, 105);
        ctx.font = 'bold 26px sans-serif';
        ctx.fillStyle = '#FEF08A';
        ctx.fillText(subtitle, 256, 175);
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        const decalMesh = new THREE.Mesh(
            new THREE.PlaneGeometry(5.5, 2.4),
            new THREE.MeshStandardMaterial({ map: tex, roughness: 0.3 })
        );
        decalMesh.position.set(xPos, 2.6, -0.05);
        decalMesh.rotation.y = Math.PI; // Face outwards toward parking lot
        signGroup.add(decalMesh);
    };

    createPromoDecal(-15.5, 'FRESH PRODUCE', '★ FARM TO TABLE SAVINGS ★', '#15803d');
    createPromoDecal(15.5, 'BAKERY & MEATS', '★ FRESHLY PREPARED DAILY ★', '#b91c1c');
}

function addImageToSign(path, parent, bothSides = true) {
    const parentWidth = parent.geometry?.parameters?.width || 3;
    const parentHeight = parent.geometry?.parameters?.height || 1;
    const parentDepth = parent.geometry?.parameters?.depth || 0.1;
    const halfDepth = parentDepth / 2;
    const imageAspect = 1062 / 292; // Aspect ratio of the supplied MagMart artwork.
    const imageHeight = Math.min(parentHeight * 0.94, parentWidth * 0.92 / imageAspect);
    const imageWidth = imageHeight * imageAspect;
    const texture = loadShrunk(path);
    texture.colorSpace = THREE.SRGBColorSpace;
    try {
        if (renderer) texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    } catch (_) {}

    const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false
    });
    const geometry = new THREE.PlaneGeometry(imageWidth, imageHeight);
    const frontPlane = new THREE.Mesh(geometry, material);
    frontPlane.position.z = halfDepth + 0.008;
    parent.add(frontPlane);

    if (bothSides) {
        const backPlane = new THREE.Mesh(geometry, material);
        backPlane.position.z = -halfDepth - 0.008;
        backPlane.rotation.y = Math.PI;
        parent.add(backPlane);
    }
}

function addTextToSign(text, parent, size, height, color, bothSides = true) {
    const parentWidth = parent.geometry?.parameters?.width || 3;
    const parentHeight = parent.geometry?.parameters?.height || 1;
    const parentDepth = parent.geometry?.parameters?.depth || 0.1;
    const halfDepth = parentDepth / 2;

    // Create high-resolution double-sided canvas texture for crisp display (no duplicate 3D font text)
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 384;
    const ctx = canvas.getContext('2d');

    // Transparent canvas with bold text and clean drop outline
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (text.toLowerCase() === 'magmart') {
        // High-end vibrant illuminated "magmart" store branding
        ctx.fillStyle = '#FFFFFF';
        ctx.strokeStyle = '#991B1B';
        ctx.lineWidth = 18;
        ctx.lineJoin = 'round';
        ctx.font = '900 112px "Arial Black", Impact, system-ui, sans-serif';
        ctx.strokeText('magmart', canvas.width / 2, canvas.height / 2 - 24);
        ctx.fillText('magmart', canvas.width / 2, canvas.height / 2 - 24);

        // Core fill gradient effect
        ctx.fillStyle = '#FB7185';
        ctx.font = '900 112px "Arial Black", Impact, system-ui, sans-serif';
        ctx.fillText('magmart', canvas.width / 2, canvas.height / 2 - 24);

        // Subtitle banner
        ctx.fillStyle = '#F59E0B';
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 6;
        ctx.font = 'bold 28px sans-serif';
        ctx.strokeText('★ SUPERMARKET • FRESH & SAVINGS ★', canvas.width / 2, canvas.height / 2 + 65);
        ctx.fillText('★ SUPERMARKET • FRESH & SAVINGS ★', canvas.width / 2, canvas.height / 2 + 65);
    } else {
        ctx.fillStyle = typeof color === 'string' ? color : ('#' + (new THREE.Color(color)).getHexString());
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 14;
        ctx.lineJoin = 'round';
        ctx.font = 'bold 84px "Arial Black", Impact, sans-serif';
        ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
        ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    }

    const textTexture = new THREE.CanvasTexture(canvas);
    textTexture.minFilter = THREE.LinearFilter;
    textTexture.magFilter = THREE.LinearFilter;

    const textMat = new THREE.MeshBasicMaterial({
        map: textTexture,
        transparent: true,
        depthWrite: false,
        side: THREE.FrontSide
    });

    const textPlaneGeo = new THREE.PlaneGeometry(parentWidth * 0.92, parentHeight * 0.78);

    // Front text plane
    const frontPlane = new THREE.Mesh(textPlaneGeo, textMat);
    frontPlane.position.set(0, 0, halfDepth + 0.005);
    parent.add(frontPlane);

    // Back text plane (facing opposite side)
    if (bothSides) {
        const backPlane = new THREE.Mesh(textPlaneGeo, textMat);
        backPlane.position.set(0, 0, -halfDepth - 0.005);
        backPlane.rotation.y = Math.PI;
        parent.add(backPlane);
    }
}

// Store interior lighting, tracked so a power outage can switch it off for real.
let storeCeilingLights = [];
let storeLightTubes = [];
const TUBE_ON_COLOR = new THREE.Color(0xFFFFEE);
const TUBE_OFF_COLOR = new THREE.Color(0x3a3a36);
let storePowerLevel = 1; // 1 = lights on, 0 = blacked out
let storeCeilingMesh = null; // casts the roof's shadow over the interior while the power is out

// Unlit (MeshBasic/Sprite) and emissive materials inside the store ignore the
// lights, so signs, labels and glowing props would stay full-bright in a power
// outage. They are collected when the power first drops and scaled with it.
let powerDimEntries = null; // [{ mat, color, emissive, setColor, setEmissive }]
const POWER_DIM_FLOOR = 0.1; // how bright self-lit surfaces stay in the dark
const _powerDimPos = new THREE.Vector3();

function isInsideStore(x, z) {
    return x > -29.95 && x < BATHROOM.x1 + 0.2 && z > -29.85 && z < 29.95;
}

function collectPowerDimMaterials() {
    const tubeMats = new Set(storeLightTubes.map(t => t.material));
    const seen = new Set();
    const entries = [];
    scene.traverse(obj => {
        if (!(obj.isMesh || obj.isSprite || obj.isPoints) || !obj.material) return;
        obj.getWorldPosition(_powerDimPos);
        if (_powerDimPos.y > 12 || !isInsideStore(_powerDimPos.x, _powerDimPos.z)) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const mat of mats) {
            if (!mat || seen.has(mat) || tubeMats.has(mat)) continue;
            seen.add(mat);
            if (mat.fog === false || mat.userData?.noPowerDim) continue; // overlays/effects
            const unlit = mat.isMeshBasicMaterial || mat.isSpriteMaterial || mat.isPointsMaterial;
            const glows = mat.emissive && mat.emissiveIntensity > 0 &&
                (mat.emissive.r + mat.emissive.g + mat.emissive.b) > 0.001;
            if (!unlit && !glows) continue;
            entries.push({
                mat,
                color: unlit && mat.color ? mat.color.clone() : null,
                emissive: glows ? mat.emissiveIntensity : null,
                setColor: null,
                setEmissive: null
            });
        }
    });
    return entries;
}

function applyPowerDimToSelfLitMaterials(k) {
    if (isLonelyStoreMode || !scene) return;
    if (k >= 1) {
        if (!powerDimEntries) return;
        // Restore originals (unless something else changed them meanwhile).
        for (const e of powerDimEntries) {
            if (e.color && e.setColor && e.mat.color.equals(e.setColor)) e.mat.color.copy(e.color);
            if (e.emissive !== null && e.mat.emissiveIntensity === e.setEmissive) e.mat.emissiveIntensity = e.emissive;
        }
        powerDimEntries = null; // re-collect next outage so new props are included
        return;
    }
    if (!powerDimEntries) powerDimEntries = collectPowerDimMaterials();
    const f = POWER_DIM_FLOOR + (1 - POWER_DIM_FLOOR) * k;
    for (const e of powerDimEntries) {
        // If another system changed a value meanwhile, it owns it now: stop managing it.
        if (e.color) {
            if (e.setColor && !e.mat.color.equals(e.setColor)) e.color = null;
            else {
                e.mat.color.copy(e.color).multiplyScalar(f);
                (e.setColor ||= new THREE.Color()).copy(e.mat.color);
            }
        }
        if (e.emissive !== null) {
            if (e.setEmissive !== null && e.mat.emissiveIntensity !== e.setEmissive) e.emissive = null;
            else {
                e.mat.emissiveIntensity = e.emissive * f;
                e.setEmissive = e.mat.emissiveIntensity;
            }
        }
    }
}

// Apply the current storePowerLevel to ceiling lights, tubes and the global
// ambient/hemi fill (which otherwise lights the interior uniformly). The sun
// and sky stay untouched so the outside remains daylight.
function applyStorePowerLevel() {
    const k = storePowerLevel;
    storeCeilingLights = storeCeilingLights.filter(l => l.parent);
    storeLightTubes = storeLightTubes.filter(t => t.parent);
    for (const l of storeCeilingLights) l.intensity = (l.userData.baseIntensity ?? 1) * k;
    for (const t of storeLightTubes) t.material.color.copy(TUBE_OFF_COLOR).lerp(TUBE_ON_COLOR, k);
    applyPowerDimToSelfLitMaterials(k);
    if (sceneLights && !isLonelyStoreMode) {
        if (sceneLights.ambientLight) sceneLights.ambientLight.intensity = 0.03 + (0.35 - 0.03) * k;
        if (sceneLights.hemiLight) sceneLights.hemiLight.intensity = 0.1 + (0.85 - 0.1) * k;
        if (sceneLights.fillLight) sceneLights.fillLight.intensity = 0.1 + (0.4 - 0.1) * k;
    }
}

function updateStorePower(delta) {
    if (isLonelyStoreMode) return;
    let target = powerOutage ? 0 : 1;
    // Brief fluorescent flicker right as the power drops
    if (powerOutage && powerOutageStartTime && performance.now() - powerOutageStartTime < 700) {
        target = Math.random() < 0.35 ? 0.8 : 0;
    }
    const prev = storePowerLevel;
    const rate = powerOutage ? 12 : 2.5; // snap off, ease back on
    storePowerLevel += (target - storePowerLevel) * Math.min(1, delta * rate);
    if (Math.abs(target - storePowerLevel) < 0.002) storePowerLevel = target;
    if (storePowerLevel !== prev || storePowerLevel !== 1) applyStorePowerLevel();
    if (storeCeilingMesh) storeCeilingMesh.castShadow = storePowerLevel < 0.5;
}
let powerOutageStartTime = 0;

function createCeilingLight(x, y, z, addLight = true) {
    const lightFixture = new THREE.Group();

    // Light housing
    const housingColor = isLonelyStoreMode ? 0x1e293b : 0xDDDDDD;
    const housingGeometry = new THREE.BoxGeometry(4, 0.2, 1);
    const housingMaterial = new THREE.MeshStandardMaterial({ color: housingColor, roughness: 0.8 });
    const housing = new THREE.Mesh(housingGeometry, housingMaterial);

    // Light tube (emissive when on, dark dead bulb when lonely store)
    const tubeGeometry = new THREE.CylinderGeometry(0.15, 0.15, 3.8, 8);
    const tubeMaterial = isLonelyStoreMode 
        ? new THREE.MeshStandardMaterial({ color: 0x18181b, roughness: 0.95 })
        : new THREE.MeshBasicMaterial({ color: 0xFFFFEE });
    const tube = new THREE.Mesh(tubeGeometry, tubeMaterial);
    tube.rotation.z = Math.PI / 2;

    lightFixture.add(housing, tube);
    lightFixture.position.set(x, y, z);
    if (!isLonelyStoreMode) storeLightTubes.push(tube);
    scene.add(lightFixture);

    // Add point light if lights are on
    const lightIntensity = isLonelyStoreMode ? 0 : 1.4;
    if (addLight && lightIntensity > 0) {
        const light = new THREE.PointLight(0xFFFFEE, lightIntensity, 16, 1.4);
        light.position.set(x, y - 0.1, z);
        light.castShadow = false;
        light.userData.baseIntensity = light.intensity;
        storeCeilingLights.push(light);
        scene.add(light);
    }
}

function createStoreDecorations() {
    storeCeilingLights = [];
    storeLightTubes = [];
    storePowerLevel = 1;
    powerDimEntries = null;
    // Add ceiling lights (fluorescent tubes)
    // PERF: every PointLight is evaluated per-pixel in every lit material, so 36 of
    // them made the GPU the bottleneck (low FPS -> laggy, dragging mouse look).
    // Only 'ultra' keeps one real light per fixture; other tiers use a sparser
    // grid of wider lights tuned to give the same average brightness.
    const lq = CONFIG.LIGHTING_QUALITY || 'high';
    const perFixtureLights = lq === 'ultra';
    for (let x = -25; x <= 25; x += 10) {
        for (let z = -25; z <= 25; z += 10) {
            createCeilingLight(x, CEILING_HEIGHT - 0.1, z, perFixtureLights);
        }
    }
    if (!perFixtureLights && !isLonelyStoreMode) {
        const grid = lq === 'high' ? [-20, -7, 7, 20] : [-18, 0, 18];
        const intensity = lq === 'high' ? 0.5 : 0.87;
        for (const lx of grid) {
            for (const lz of grid) {
                const light = new THREE.PointLight(0xFFFFEE, intensity, 30, 0.8);
                light.position.set(lx, CEILING_HEIGHT - 0.2, lz);
                light.castShadow = false;
                light.userData.baseIntensity = light.intensity;
                storeCeilingLights.push(light);
                scene.add(light);
            }
        }
    }

    // Add double-sided aisle department signs
    createAisleSigns();

    // Add promotional signs in the aisles
    createPromotionalSigns();

    // Add shopping baskets stack near entrance
    createBasketStack(0, 0, -25);

    // Add information booth near entrance lobby (isolated from shelf aisles)
    createInfoBooth(-22, 0, -24);

    // Add Live Database Leaderboard Stand near the info desk in the lobby
    createLeaderboardStand(-17.5, 0, -23.5, 0.4);
}

function createAisleSigns() {
    addStoreWayfinding(scene, shelfUnits, CEILING_HEIGHT, registerCullableObject);
}

function drawWrappedPosterText(ctx, text, x, centerY, maxWidth, fontFace, textColor, strokeColor) {
    const words = text.split(' ');
    let lines = [];
    let currentLine = words[0];

    // Determine initial font size based on text length
    let fontSize = 46;
    if (text.length > 28) fontSize = 36;
    if (text.length > 42) fontSize = 30;

    ctx.font = `bold ${fontSize}px ${fontFace}`;

    for (let i = 1; i < words.length; i++) {
        const testLine = currentLine + ' ' + words[i];
        if (ctx.measureText(testLine).width > maxWidth) {
            lines.push(currentLine);
            currentLine = words[i];
        } else {
            currentLine = testLine;
        }
    }
    lines.push(currentLine);

    // Dynamically scale down if any line still exceeds maxWidth
    while (lines.some(l => ctx.measureText(l).width > maxWidth) && fontSize > 16) {
        fontSize -= 2;
        ctx.font = `bold ${fontSize}px ${fontFace}`;
    }

    const lineHeight = fontSize * 1.25;
    const totalHeight = lines.length * lineHeight;
    const startY = centerY - (totalHeight / 2) + (lineHeight / 2);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    lines.forEach((line, idx) => {
        const py = startY + idx * lineHeight;
        if (strokeColor) {
            ctx.strokeStyle = strokeColor;
            ctx.lineWidth = Math.max(6, Math.floor(fontSize * 0.22));
            ctx.lineJoin = 'round';
            ctx.strokeText(line, x, py);
        }
        ctx.fillStyle = textColor;
        ctx.fillText(line, x, py);
    });
}

function createPromotionalSigns() {
    // Generate static wall posters on store perimeter walls using active products + safety notices
    const pool = (ACTIVE_ITEMS && ACTIVE_ITEMS.length > 0) ? ACTIVE_ITEMS : BASE_ITEMS;
    const shuffledItems = pool.slice().sort(() => Math.random() - 0.5);

    const item1 = shuffledItems[0]?.name || "Milk";
    const item2 = shuffledItems[1]?.name || "Bread";
    const item3 = shuffledItems[2]?.name || "Coffee";
    const item4 = shuffledItems[3]?.name || "Pizza";

    // Inner wall surface bounds (walls centered at +/-30 with 0.5m thickness -> inner face at +/-29.75)
    const posterPositions = [
        // Back wall posters (Inner face at Z = 29.75 -> offset to Z = 29.66, facing into store with rotY = Math.PI)
        { 
            text: `BUY 1 GET 1 FREE: ${item1.toUpperCase()}!`, 
            subtext: "Limited Time Storewide Special", 
            tag: "WEEKLY SPECIAL",
            color: "#D32F2F", 
            x: -18, y: 3.3, z: 29.66, rotY: Math.PI 
        },
        { 
            text: "WATCH OUT FOR FALLING SHELVES!", 
            subtext: "⚠️ Safety First • Please Keep A Safe Distance", 
            tag: "SAFETY NOTICE",
            color: "#C62828", 
            x: -6, y: 3.3, z: 29.66, rotY: Math.PI 
        },
        { 
            text: "COVER YOUR EARS, SCREAMING BABIES AFOOT!", 
            subtext: "📢 Free Earplugs Available In Aisles", 
            tag: "STORE ALERT",
            color: "#6A1B9A", 
            x: 6, y: 3.3, z: 29.66, rotY: Math.PI 
        },
        { 
            text: `FRESH ${item2.toUpperCase()} ON SALE!`, 
            subtext: "Stock Up Your Cart Today", 
            tag: "DAILY SAVINGS",
            color: "#1565C0", 
            x: 18, y: 3.3, z: 29.66, rotY: Math.PI 
        },

        // Left wall posters (Inner face at X = -29.75 -> offset to X = -29.66, facing into store with rotY = Math.PI / 2)
        { 
            text: "DON'T SLIP & BREAK YOUR NECK, SPILLS HAPPEN!", 
            subtext: "💧 Caution • Wet Floor Spills In Every Aisle", 
            tag: "HAZARD WARNING",
            color: "#00838F", 
            x: -29.66, y: 3.3, z: -4, rotY: Math.PI / 2 
        },
        { 
            text: `TODAY'S SPECIAL: ${item3.toUpperCase()}!`, 
            subtext: "Top Quality & Best Supermarket Value", 
            tag: "CHEF'S PICK",
            color: "#2E7D32", 
            x: -29.66, y: 3.3, z: 6, rotY: Math.PI / 2 
        },

        // Right wall posters (Inner face at X = +29.75 -> offset to X = +29.66, facing into store with rotY = -Math.PI / 2)
        { 
            text: "ATTENTION SHOPLIFTERS: HEAVY FOOTSTEPS AHEAD!", 
            subtext: "🚨 Store Manager Is On Continuous Patrol", 
            tag: "STORE POLICY",
            color: "#37474F", 
            x: 29.66, y: 3.3, z: -4, rotY: -Math.PI / 2 
        },
        { 
            text: `HOT DEAL: 50% OFF ${item4.toUpperCase()}!`, 
            subtext: "Limited Quantities Available While Supplies Last", 
            tag: "MANAGER'S SPECIAL",
            color: "#E65100", 
            x: 29.66, y: 3.3, z: 6, rotY: -Math.PI / 2 
        }
    ];

    posterPositions.forEach(pos => {
        const posterGroup = new THREE.Group();

        const posterW = 3.6;
        const posterH = 2.0;
        const frameD = 0.05;

        // Dark aluminum wall frame
        const frameMat = new THREE.MeshStandardMaterial({ 
            color: 0x1E2228, 
            roughness: 0.35, 
            metalness: 0.5 
        });
        const frameMesh = new THREE.Mesh(new THREE.BoxGeometry(posterW, posterH, frameD), frameMat);
        posterGroup.add(frameMesh);

        // Top spotlight fixture bar
        const lightBar = new THREE.Mesh(
            new THREE.BoxGeometry(posterW * 0.7, 0.06, 0.16),
            new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.8, roughness: 0.2 })
        );
        lightBar.position.set(0, posterH / 2 + 0.03, 0.06);
        posterGroup.add(lightBar);

        // Render high-resolution static wall poster artwork
        const canvas = document.createElement('canvas');
        canvas.width = 1024; 
        canvas.height = 576;
        const ctx = canvas.getContext('2d');

        // Background color gradient
        const bgGrad = ctx.createLinearGradient(0, 0, 1024, 576);
        bgGrad.addColorStop(0, pos.color);
        bgGrad.addColorStop(1, '#0B0F19');
        ctx.fillStyle = bgGrad; 
        ctx.fillRect(0, 0, 1024, 576);

        // Framing borders
        ctx.strokeStyle = '#FFFFFF'; 
        ctx.lineWidth = 14; 
        ctx.strokeRect(12, 12, 1000, 552);
        ctx.strokeStyle = '#FFD700'; 
        ctx.lineWidth = 4; 
        ctx.strokeRect(24, 24, 976, 528);

        // Header Tag badge
        ctx.fillStyle = '#000000';
        ctx.fillRect(362, 36, 300, 48);
        ctx.strokeStyle = '#FFD700';
        ctx.lineWidth = 2;
        ctx.strokeRect(362, 36, 300, 48);
        ctx.fillStyle = '#FFD700';
        ctx.font = 'bold 26px "Arial", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`★ ${pos.tag} ★`, 512, 60);

        // Main poster headline (wrapped and scaled to fit frame perfectly)
        drawWrappedPosterText(ctx, pos.text, 512, 260, 880, '"Arial Black", Impact, sans-serif', '#FFFFFF', '#000000');

        // Subtext / description (wrapped and scaled)
        drawWrappedPosterText(ctx, pos.subtext, 512, 420, 880, '"Arial", sans-serif', '#FFF9C4', 'rgba(0,0,0,0.6)');

        // Footer banner
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.fillRect(28, 490, 968, 55);
        ctx.fillStyle = '#FFD700';
        ctx.font = 'bold 22px sans-serif';
        ctx.fillText('MAGMART SUPERMARKET • QUALITY & SAVINGS', 512, 518);

        const posterTex = new THREE.CanvasTexture(canvas);
        const posterMat = new THREE.MeshBasicMaterial({ map: posterTex });

        const posterPlane = new THREE.Mesh(new THREE.PlaneGeometry(posterW - 0.08, posterH - 0.08), posterMat);
        posterPlane.position.set(0, 0, frameD / 2 + 0.005);
        posterGroup.add(posterPlane);

        posterGroup.position.set(pos.x, pos.y, pos.z);
        posterGroup.rotation.y = pos.rotY;
        scene.add(posterGroup);
    });
}

function createBasketStack(x, y, z) {
    const basketStack = new THREE.Group();

    // Chrome wire stand on floor (cleanly grounds the basket stack)
    const chromeMat = new THREE.MeshStandardMaterial({ color: 0xAAAAAA, metalness: 0.85, roughness: 0.2 });
    const standLegGeo = new THREE.CylinderGeometry(0.015, 0.015, 0.4, 8);
    [[-0.30, -0.20], [0.30, -0.20], [-0.30, 0.20], [0.30, 0.20]].forEach(([lx, lz]) => {
        const leg = new THREE.Mesh(standLegGeo, chromeMat);
        leg.position.set(lx, 0.2, lz);
        basketStack.add(leg);
    });
    const standBase = new THREE.Mesh(new THREE.BoxGeometry(0.70, 0.03, 0.50), chromeMat);
    standBase.position.y = 0.4;
    basketStack.add(standBase);

    // Stack several shopping baskets nested tightly with tapered walls (ZERO Z-fighting)
    const basketColors = [0xDD1111, 0x118822, 0x1144CC, 0xEEAA00];

    for (let i = 0; i < basketColors.length; i++) {
        const isTop = (i === basketColors.length - 1);
        const basket = createShoppingBasket(basketColors[i], isTop);
        // Each nested basket sits slightly higher with a subtle nesting scale offset to prevent coplanar faces
        const scale = 1.0 + i * 0.012;
        basket.scale.set(scale, 1.0, scale);
        basket.position.set(0, 0.42 + i * 0.08, 0);
        basketStack.add(basket);
    }

    basketStack.position.set(x, y, z + 10);
    scene.add(basketStack);

    // Add physical boundaries
    const basketStackShape = new CANNON.Box(new CANNON.Vec3(0.4, 0.5, 0.3));
    const basketStackBody = new CANNON.Body({
        mass: 0,
        shape: basketStackShape
    });
    basketStackBody.position.set(x, y + 0.5, z + 10);
    world.addBody(basketStackBody);
}

function createShoppingBasket(color, isTop = false) {
    const basket = new THREE.Group();
    const basketMat = new THREE.MeshStandardMaterial({ color: color, roughness: 0.5 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.7 });
    const handleMat = new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.6, roughness: 0.4 });

    const baseW = 0.58, baseD = 0.40, basketH = 0.26;
    const rimW = 0.64, rimD = 0.46;

    // Solid base bottom
    const baseMesh = new THREE.Mesh(new THREE.BoxGeometry(baseW, 0.02, baseD), basketMat);
    baseMesh.position.y = 0.01;
    basket.add(baseMesh);

    // Four tapered side walls (sloped so they nest cleanly without coplanar overlap)
    // Front wall
    const frontWall = new THREE.Mesh(new THREE.BoxGeometry(rimW, basketH, 0.02), basketMat);
    frontWall.position.set(0, basketH / 2, baseD / 2 + 0.015);
    frontWall.rotation.x = -0.07;
    basket.add(frontWall);

    // Back wall
    const backWall = new THREE.Mesh(new THREE.BoxGeometry(rimW, basketH, 0.02), basketMat);
    backWall.position.set(0, basketH / 2, -baseD / 2 - 0.015);
    backWall.rotation.x = 0.07;
    basket.add(backWall);

    // Left wall
    const leftWall = new THREE.Mesh(new THREE.BoxGeometry(0.02, basketH, rimD - 0.02), basketMat);
    leftWall.position.set(-baseW / 2 - 0.015, basketH / 2, 0);
    leftWall.rotation.z = 0.07;
    basket.add(leftWall);

    // Right wall
    const rightWall = new THREE.Mesh(new THREE.BoxGeometry(0.02, basketH, rimD - 0.02), basketMat);
    rightWall.position.set(baseW / 2 + 0.015, basketH / 2, 0);
    rightWall.rotation.z = -0.07;
    basket.add(rightWall);

    // Top rim lip
    const topRim = new THREE.Mesh(new THREE.BoxGeometry(rimW + 0.02, 0.02, rimD + 0.02), rimMat);
    topRim.position.y = basketH + 0.01;
    basket.add(topRim);

    // Handle: folded flat along the rim to avoid clipping into upper baskets (or upright on top)
    const handle = new THREE.Mesh(
        new THREE.TorusGeometry(0.18, 0.014, 8, 16, Math.PI),
        handleMat
    );
    if (isTop) {
        handle.rotation.x = 0;
        handle.position.set(0, basketH + 0.16, 0);
    } else {
        handle.rotation.x = Math.PI / 2;
        handle.position.set(0, basketH + 0.02, 0.03);
    }
    basket.add(handle);

    return basket;
}

function createInfoBooth(x, y, z) {
    const booth = new THREE.Group();

    // 1. Desk Base with dark kickplate and warm walnut wood paneling
    const baseWoodMat = new THREE.MeshStandardMaterial({ color: 0x3E2723, roughness: 0.65 });
    const kickplateMat = new THREE.MeshStandardMaterial({ color: 0x1E2228, roughness: 0.8 });
    const marbleMat = new THREE.MeshStandardMaterial({ color: 0xF8F9FA, roughness: 0.2, metalness: 0.05 });
    const chromeMat = new THREE.MeshStandardMaterial({ color: 0xD8D8D8, metalness: 0.85, roughness: 0.2 });

    const kickplate = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.12, 1.8), kickplateMat);
    kickplate.position.y = 0.06;
    booth.add(kickplate);

    const mainCounter = new THREE.Mesh(new THREE.BoxGeometry(3.6, 1.0, 1.8), baseWoodMat);
    mainCounter.position.y = 0.62;
    booth.add(mainCounter);

    // Front decorative panel groove
    const frontPanel = new THREE.Mesh(
        new THREE.BoxGeometry(3.2, 0.75, 0.04),
        new THREE.MeshStandardMaterial({ color: 0x4E342E, roughness: 0.6 })
    );
    frontPanel.position.set(0, 0.62, 0.91);
    booth.add(frontPanel);

    // 2. Polished White Quartz / Marble Countertop
    const countertop = new THREE.Mesh(new THREE.BoxGeometry(3.85, 0.08, 2.05), marbleMat);
    countertop.position.y = 1.16;
    booth.add(countertop);

    // 3. Desktop Accessories
    // Widescreen POS Computer Monitor & Stand
    const screenGroup = new THREE.Group();
    const monitorStand = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.04, 0.18, 12), chromeMat);
    monitorStand.position.y = 0.09;
    const monitorScreen = new THREE.Mesh(
        new THREE.BoxGeometry(0.50, 0.32, 0.03),
        new THREE.MeshStandardMaterial({ color: 0x1E2228, roughness: 0.3 })
    );
    monitorScreen.position.set(0, 0.25, 0);

    const screenCanvas = document.createElement('canvas');
    screenCanvas.width = 256; screenCanvas.height = 160;
    const sctx = screenCanvas.getContext('2d');
    sctx.fillStyle = '#0D47A1'; sctx.fillRect(0, 0, 256, 160);
    sctx.fillStyle = '#FFFFFF'; sctx.font = 'bold 20px sans-serif';
    sctx.fillText('STORE SYSTEM v2', 20, 40);
    sctx.fillStyle = '#64B5F6'; sctx.font = '16px sans-serif';
    sctx.fillText('• Customer Service', 20, 75);
    sctx.fillText('• Inventory Lookup', 20, 105);
    sctx.fillText('• Aisle Directory', 20, 135);
    const screenTex = new THREE.CanvasTexture(screenCanvas);
    const displayFace = new THREE.Mesh(new THREE.PlaneGeometry(0.46, 0.28), new THREE.MeshBasicMaterial({ map: screenTex }));
    displayFace.position.set(0, 0.25, 0.016);
    screenGroup.add(monitorStand, monitorScreen, displayFace);
    screenGroup.position.set(0.6, 1.20, 0.2);
    screenGroup.rotation.y = 0.25;
    booth.add(screenGroup);

    // Keyboard & Mousepad
    const keyboard = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.015, 0.14), new THREE.MeshStandardMaterial({ color: 0x2A2E35 }));
    keyboard.position.set(0.6, 1.205, -0.15);
    booth.add(keyboard);

    // Chrome Desk Service Bell
    const bell = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 12, 0, Math.PI * 2, 0, Math.PI / 2), chromeMat);
    bell.position.set(-0.5, 1.22, 0.4);
    const bellBase = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.015, 16), chromeMat);
    bellBase.position.set(-0.5, 1.205, 0.4);
    const bellPlunger = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.03, 8), chromeMat);
    bellPlunger.position.set(-0.5, 1.245, 0.4);
    booth.add(bell, bellBase, bellPlunger);

    // Acrylic Brochure Flyer Stand with Store Weekly Circulars
    const flyerStand = new THREE.Mesh(
        new THREE.BoxGeometry(0.28, 0.22, 0.14),
        new THREE.MeshPhysicalMaterial({ color: 0xFFFFFF, transparent: true, opacity: 0.4, roughness: 0.1 })
    );
    flyerStand.position.set(-1.1, 1.30, 0.2);
    booth.add(flyerStand);

    // 4. Overhead Illuminated Canopy Sign
    const pillarL = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.8, 16), chromeMat);
    pillarL.position.set(-1.6, 2.05, 0);
    const pillarR = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.8, 16), chromeMat);
    pillarR.position.set(1.6, 2.05, 0);
    booth.add(pillarL, pillarR);

    const signBoard = new THREE.Mesh(
        new THREE.BoxGeometry(3.6, 0.75, 0.12),
        new THREE.MeshStandardMaterial({ color: 0x0D47A1, roughness: 0.4 })
    );
    signBoard.position.set(0, 2.85, 0);
    booth.add(signBoard);

    addTextToSign("INFORMATION", signBoard, 0.32, 0.05, 0xFFFFFF, true);

    // 5. Office Chair behind desk
    const chairGroup = new THREE.Group();
    const chairBase = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.04, 16), chromeMat);
    chairBase.position.y = 0.08;
    const chairStem = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.35, 12), chromeMat);
    chairStem.position.y = 0.26;
    const chairSeat = new THREE.Mesh(
        new THREE.BoxGeometry(0.42, 0.08, 0.40),
        new THREE.MeshStandardMaterial({ color: 0x212121, roughness: 0.8 })
    );
    chairSeat.position.y = 0.46;
    const chairBack = new THREE.Mesh(
        new THREE.BoxGeometry(0.40, 0.42, 0.06),
        new THREE.MeshStandardMaterial({ color: 0x212121, roughness: 0.8 })
    );
    chairBack.position.set(0, 0.70, -0.18);
    chairGroup.add(chairBase, chairStem, chairSeat, chairBack);
    chairGroup.position.set(0, 0, -0.65);
    booth.add(chairGroup);

    // Stationary staff member on the service side of the information desk.
    if (!isLonelyStoreMode) {
        const infoWorker = createWorkerModel();
        infoWorker.position.set(-0.7, 0, -1.55);
        infoWorker.rotation.y = 0;
        booth.add(infoWorker);
    }

    booth.position.set(x, y, z);
    scene.add(booth);
    registerCullableObject(booth, 5.5);

    // Add physics collider for counter
    const boothShape = new CANNON.Box(new CANNON.Vec3(1.9, 0.6, 1.0));
    const boothBody = new CANNON.Body({
        mass: 0,
        shape: boothShape
    });
    boothBody.position.set(x, y + 0.6, z);
    world.addBody(boothBody);
}

// ---------------- 3D SPEEDRUN LEADERBOARD STAND & DATABASE SYNC ----------------
let leaderboardStandGroup = null;
let leaderboardScreenCanvas = null;
let leaderboardScreenTex = null;
let leaderboardPollInterval = null;
let latestLeaderboardData = { top_times: [], top_scores: [] };
let currentRunSession = null;

async function pollLeaderboard() {
    try {
        const res = await fetch('/api/leaderboard');
        if (res.ok) {
            const data = await res.json();
            const rawList = Array.isArray(data.top_times) ? data.top_times : (Array.isArray(data.top_scores) ? data.top_scores : []);
            // Ensure 1 entry per unique user/username (keeping their best time)
            const seen = new Set();
            const uniqueList = [];
            for (const entry of rawList) {
                const key = (entry.user_id || entry.username || '').trim().toLowerCase();
                if (key && !seen.has(key)) {
                    seen.add(key);
                    uniqueList.push(entry);
                }
            }
            latestLeaderboardData = {
                top_times: uniqueList,
                top_scores: uniqueList,
                review_queue: data.review_queue,
                banned: data.banned
            };
            renderLeaderboardStandCanvas();
            updateLeaderboardModalContent();
            renderDevReview(latestLeaderboardData, pollLeaderboard);
        }
    } catch (_) {}
}

function startLeaderboardPolling() {
    if (leaderboardPollInterval) clearInterval(leaderboardPollInterval);
    pollLeaderboard();
    leaderboardPollInterval = setInterval(pollLeaderboard, 5000);
}

function createLeaderboardStand(x, y, z, rotY = 0) {
    if (leaderboardStandGroup && leaderboardStandGroup.parent) {
        leaderboardStandGroup.parent.remove(leaderboardStandGroup);
    }

    const stand = new THREE.Group();
    stand.position.set(x, y, z);
    stand.rotation.y = rotY;

    // Materials
    const darkMetalMat = new THREE.MeshStandardMaterial({ color: 0x1E2228, roughness: 0.35, metalness: 0.8 });
    const glowingRimMat = new THREE.MeshStandardMaterial({ color: 0x3B82F6, emissive: 0x1D4ED8, roughness: 0.2 });
    const chromeMat = new THREE.MeshStandardMaterial({ color: 0xD8D8D8, metalness: 0.9, roughness: 0.15 });

    // 1. Heavy base pedestal
    const base = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.14, 1.2), darkMetalMat);
    base.position.y = 0.07;
    const baseRim = new THREE.Mesh(new THREE.BoxGeometry(2.24, 0.04, 1.24), glowingRimMat);
    baseRim.position.y = 0.04;
    stand.add(base, baseRim);

    // 2. Dual support pylons
    const pylonL = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.2, 16), chromeMat);
    pylonL.position.set(-0.7, 0.65, 0);
    const pylonR = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.2, 16), chromeMat);
    pylonR.position.set(0.7, 0.65, 0);
    stand.add(pylonL, pylonR);

    // 3. Kiosk Frame Body (slanted 8 degrees back for ergonomic viewing)
    const frameW = 2.4;
    const frameH = 2.0;
    const frameD = 0.16;
    const frameGroup = new THREE.Group();
    frameGroup.position.set(0, 1.85, 0);
    frameGroup.rotation.x = -0.12;

    const frameMesh = new THREE.Mesh(new THREE.BoxGeometry(frameW, frameH, frameD), darkMetalMat);
    const frameBevel = new THREE.Mesh(new THREE.BoxGeometry(frameW + 0.06, frameH + 0.06, frameD - 0.04), glowingRimMat);
    frameGroup.add(frameMesh, frameBevel);

    // 4. Digital Screen with CanvasTexture
    if (!leaderboardScreenCanvas) {
        leaderboardScreenCanvas = document.createElement('canvas');
        leaderboardScreenCanvas.width = 1024;
        leaderboardScreenCanvas.height = 1024;
    }
    leaderboardScreenTex = new THREE.CanvasTexture(leaderboardScreenCanvas);
    leaderboardScreenTex.minFilter = THREE.LinearFilter;
    leaderboardScreenTex.magFilter = THREE.LinearFilter;

    const screenMat = new THREE.MeshBasicMaterial({ map: leaderboardScreenTex });
    const screenMesh = new THREE.Mesh(new THREE.PlaneGeometry(frameW - 0.16, frameH - 0.16), screenMat);
    screenMesh.position.set(0, 0, frameD / 2 + 0.005);
    screenMesh.userData.isLeaderboardStand = true;
    frameGroup.add(screenMesh);

    stand.add(frameGroup);
    scene.add(stand);
    registerCullableObject(stand, 5.0);

    // Physics collider for stand
    const standShape = new CANNON.Box(new CANNON.Vec3(1.2, 1.4, 0.6));
    const standBody = new CANNON.Body({ mass: 0, shape: standShape });
    standBody.position.set(x, 1.4, z);
    standBody.quaternion.setFromEuler(0, rotY, 0);
    standBody.collisionFilterGroup = 2;
    standBody.collisionFilterMask = 1 | 4;
    world.addBody(standBody);

    leaderboardStandGroup = stand;
    stand.userData.body = standBody;

    renderLeaderboardStandCanvas();
    return stand;
}

function renderLeaderboardStandCanvas() {
    if (!leaderboardScreenCanvas) return;
    const ctx = leaderboardScreenCanvas.getContext('2d');
    const W = 1024;
    const H = 1024;

    // Background gradient
    const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
    bgGrad.addColorStop(0, '#0F172A');
    bgGrad.addColorStop(0.5, '#020617');
    bgGrad.addColorStop(1, '#0F172A');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);

    // Outer neon tech border
    ctx.strokeStyle = '#3B82F6';
    ctx.lineWidth = 10;
    ctx.strokeRect(12, 12, W - 24, H - 24);
    ctx.strokeStyle = '#F59E0B';
    ctx.lineWidth = 3;
    ctx.strokeRect(24, 24, W - 48, H - 48);

    // Header Title
    ctx.fillStyle = '#F59E0B';
    ctx.font = '900 42px "Arial Black", Impact, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('⚡ MAGMART SPEEDRUN LEADERBOARD', W / 2, 80);

    // Subtitle Banner
    ctx.fillStyle = '#38BDF8';
    ctx.font = 'bold 20px system-ui, sans-serif';
    ctx.fillText('OFFICIAL DATABASE SPEEDRUN RECORDS • ALL-TIME FASTEST TIMES', W / 2, 120);

    // Table Header Bar
    ctx.fillStyle = 'rgba(245, 158, 11, 0.2)';
    ctx.fillRect(36, 145, W - 72, 42);
    ctx.strokeStyle = '#F59E0B';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(36, 145, W - 72, 42);
    ctx.fillStyle = '#FBBF24';
    ctx.font = 'bold 20px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('RANK   SPEEDRUNNER', 52, 173);
    ctx.textAlign = 'center';
    ctx.fillText('BEST TIME', 540, 173);
    ctx.fillText('LIST %', 730, 173);
    ctx.textAlign = 'right';
    ctx.fillText('ITEMS', W - 52, 173);

    const topRows = (latestLeaderboardData.top_times || latestLeaderboardData.top_scores || []).slice(0, 8);
    const startScoreY = 200;
    const scoreRowH = 80;

    if (topRows.length === 0) {
        ctx.fillStyle = '#64748B';
        ctx.font = 'italic 24px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No completed speedruns recorded yet.', W / 2, 460);
        ctx.fillStyle = '#94A3B8';
        ctx.font = 'bold 20px system-ui, sans-serif';
        ctx.fillText('Complete your shopping list to claim rank #1!', W / 2, 505);
    } else {
        topRows.forEach((entry, idx) => {
            const ry = startScoreY + idx * scoreRowH;
            ctx.fillStyle = idx % 2 === 0 ? 'rgba(255, 255, 255, 0.05)' : 'rgba(255, 255, 255, 0.015)';
            ctx.fillRect(36, ry, W - 72, scoreRowH - 6);

            // Medal badge / rank
            ctx.textAlign = 'center';
            if (idx === 0) {
                ctx.fillStyle = '#FBBF24';
                ctx.font = 'bold 28px system-ui, sans-serif';
                ctx.fillText('🥇', 72, ry + 46);
            } else if (idx === 1) {
                ctx.fillStyle = '#E2E8F0';
                ctx.font = 'bold 26px system-ui, sans-serif';
                ctx.fillText('🥈', 72, ry + 46);
            } else if (idx === 2) {
                ctx.fillStyle = '#D97706';
                ctx.font = 'bold 26px system-ui, sans-serif';
                ctx.fillText('🥉', 72, ry + 46);
            } else {
                ctx.fillStyle = '#94A3B8';
                ctx.font = 'bold 22px system-ui, sans-serif';
                ctx.fillText(`#${idx + 1}`, 72, ry + 46);
            }

            // Name
            ctx.textAlign = 'left';
            ctx.fillStyle = idx < 3 ? '#FFFFFF' : '#E2E8F0';
            ctx.font = 'bold 24px system-ui, sans-serif';
            ctx.fillText((entry.username || 'Shopper').substring(0, 16), 115, ry + 46);

            // Speedrun Time (Prominent neon green monospace)
            ctx.textAlign = 'center';
            ctx.fillStyle = '#4ADE80';
            ctx.font = '900 28px monospace';
            ctx.fillText(entry.final_time || '00:00.00', 540, ry + 46);

            // List %
            ctx.fillStyle = (entry.completion_percent || 100) >= 100 ? '#60A5FA' : '#FBBF24';
            ctx.font = 'bold 22px system-ui, sans-serif';
            ctx.fillText(`${entry.completion_percent || 100}%`, 730, ry + 46);

            // Items collected
            ctx.textAlign = 'right';
            ctx.fillStyle = '#F1F5F9';
            ctx.font = 'bold 20px monospace';
            ctx.fillText(`${entry.items_collected || 0} items`, W - 52, ry + 46);
        });
    }

    // Bottom interactive footer bar
    ctx.fillStyle = 'rgba(59, 130, 246, 0.25)';
    ctx.fillRect(36, 924, W - 72, 60);
    ctx.strokeStyle = '#3B82F6';
    ctx.lineWidth = 2;
    ctx.strokeRect(36, 924, W - 72, 60);
    ctx.fillStyle = '#F59E0B';
    ctx.font = 'bold 24px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('🔍 [ CLICK STAND TO OPEN FULL INTERACTIVE LEADERBOARD ]', W / 2, 962);

    if (leaderboardScreenTex) {
        leaderboardScreenTex.needsUpdate = true;
    }
}

function updateLeaderboardModalContent() {
    const scoresTbody = document.getElementById('leaderboard-scores-tbody');
    const statusLabel = document.getElementById('leaderboard-status-label');

    const topTimesList = latestLeaderboardData.top_times || latestLeaderboardData.top_scores || [];

    if (statusLabel) {
        statusLabel.textContent = `● Speedrun Database (${topTimesList.length} records) • Auto-syncing`;
    }

    if (scoresTbody) {
        if (topTimesList.length === 0) {
            scoresTbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: #94a3b8; padding: 24px;">No database speedruns recorded yet. Complete a shopping run to claim rank #1!</td></tr>`;
        } else {
            let html = '';
            topTimesList.forEach((entry, idx) => {
                const rankClass = idx === 0 ? 'rank-1' : idx === 1 ? 'rank-2' : idx === 2 ? 'rank-3' : 'rank-other';
                const rankLabel = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}`;
                const avatarUrl = `https://images.websim.com/avatar/${entry.username}`;
                
                html += `
                    <tr>
                        <td><span class="rank-badge ${rankClass}">${rankLabel}</span></td>
                        <td>
                            <div class="player-cell">
                                <img class="player-avatar-small" src="${avatarUrl}" alt="${entry.username}" onerror="this.src='uploads/webp/watercolor-abstract-background-free-png_256.webp';">
                                <span style="font-weight: 700; color: #fff;">${entry.username || 'Shopper'}</span>
                            </div>
                        </td>
                        <td><span class="leaderboard-time-val">${entry.final_time || '00:00.00'}</span></td>
                        <td><span style="color: ${(entry.completion_percent || 100) >= 100 ? '#60a5fa' : '#f59e0b'}; font-weight: 600;">${entry.completion_percent || 100}%</span></td>
                        <td><span style="font-family: monospace; font-size: 0.95em; color: #e2e8f0;">${entry.items_collected || 0} items</span></td>
                        <td>${entry.replay_video_url ? `<button type="button" class="lb-watch-btn" data-replay-idx="${idx}">▶ Watch</button>` : ''}${entry.seed ? `<button type="button" class="seed-copy" title="Copy run seed (dev)" data-seed-copy="${String(entry.seed).replace(/[^A-Za-z0-9._-]/g, '')}">🔑 Seed</button>` : ''}</td>
                    </tr>
                `;
            });
            scoresTbody.innerHTML = html;
            const lbMenu = document.getElementById('leaderboard-menu');
            if (lbMenu && lbMenu.style.display === 'block') refreshLeaderboardSpeedrunBox();
            scoresTbody.onclick = (e) => {
                const btn = e.target.closest('.lb-watch-btn');
                if (!btn) return;
                const entry = topTimesList[Number(btn.dataset.replayIdx)];
                if (entry && entry.replay_video_url) window.__replayWatch?.({ ...entry, rank: Number(btn.dataset.replayIdx) + 1 });
            };
        }
    }
}

// Main-menu only: speedrun.com link + export of the player's own run video.
let lbCachedUser;
async function refreshLeaderboardSpeedrunBox() {
    const box = document.getElementById('lb-speedrun');
    const btn = document.getElementById('lb-export-run');
    if (!box || !btn) return;
    box.classList.toggle('hidden', !mainMenuVisible);
    if (!mainMenuVisible) return;
    const local = window.__replayLocalRun?.();
    let remoteUrl = null;
    if (!local) {
        if (lbCachedUser === undefined) {
            try { lbCachedUser = await window.websim?.getUser?.() || null; } catch (_) { lbCachedUser = null; }
        }
        const list = latestLeaderboardData.top_times || [];
        const mine = lbCachedUser && list.find(e => e.username === lbCachedUser.username && e.replay_video_url);
        remoteUrl = mine ? mine.replay_video_url : null;
    }
    btn.classList.toggle('hidden', !local && !remoteUrl);
    btn.onclick = async () => {
        btn.disabled = true;
        try {
            if (local) window.__replayDownloadLocal?.();
            else if (remoteUrl) await downloadRemoteRunVideo(remoteUrl);
        } finally { btn.disabled = false; }
    };
}
async function downloadRemoteRunVideo(url) {
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error('fetch failed');
        const blob = await res.blob();
        const ext = (blob.type || '').includes('mp4') ? 'mp4' : 'webm';
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `MagMart-run.${ext}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } catch (_) {
        window.open(url, '_blank', 'noopener');
    }
}

function showLeaderboardMenu() {
    const menu = document.getElementById('leaderboard-menu');
    if (!menu) return;

    menu.style.display = 'block';
    refreshLeaderboardSpeedrunBox();
    updateLeaderboardModalContent();
    pollLeaderboard();
}

function hideLeaderboardMenu() {
    const menu = document.getElementById('leaderboard-menu');
    if (menu) menu.style.display = 'none';
}

async function submitLeaderboardScore(speedrunPayload) {
    try {
        // Deliver the live tracker's final report before the score itself.
        await finishRunTrack(speedrunPayload.elapsed_ms);
        let username = "Shopper";
        if (typeof window !== 'undefined' && window.websim && typeof window.websim.getUser === 'function') {
            const user = await window.websim.getUser();
            if (user && user.username) {
                username = user.username;
            }
        }
        
        const res = await fetch('/api/score', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: username,
                final_time: speedrunPayload.final_time,
                elapsed_ms: speedrunPayload.elapsed_ms,
                completion_percent: speedrunPayload.completion_percent,
                items_collected: speedrunPayload.items_collected,
                run_id: currentRunSession ? currentRunSession.runId : '',
                seed: currentRunSeed ? currentRunSeed.full : ''
            })
        });
        const result = await res.json().catch(() => null);
        const note = result && (result.pending_review
            ? '🕵️ Top 10 run! It will appear on the leaderboard once its replay is reviewed.'
            : result.rejected ? `Not counted for the leaderboard: ${result.reason}` : '');
        const statsBox = note && document.querySelector('#store-closed-overlay .store-closed-stats');
        if (statsBox) {
            const line = document.createElement('div');
            line.className = 'lb-submit-note';
            line.textContent = note;
            statsBox.appendChild(line);
        }
        // Only a run that became the player's best inside the top 10 gets a replay claim.
        try { window.__replayClaim?.(result && result.replay_token ? result : null); } catch (_) {}

        pollLeaderboard();
    } catch (err) {
        console.warn('Could not submit leaderboard speedrun:', err);
    }
}

function createShelf(x, y, z, width, height, depth, direction = 1, rotationY = 0, skipItems = false, department = 'pantry', stockPlan = null) {
    // Create a tall, majestic shelf unit with grounded plinth, canopy, and generous tier heights
    const shelfUnit = new THREE.Group();
    shelfUnit.userData = { items: [], rotY: rotationY, direction, width, height, depth, department,
        tierPools: stockPlan?.tierPools || getShelfTierPools(ACTIVE_ITEMS, usingAltItems), tierStock: stockPlan?.tiers || null };

    const shelfMaterial = new THREE.MeshStandardMaterial({
        color: 0x8a6345,
        roughness: 0.65,
        metalness: 0.05
    });
    const darkAccentMaterial = new THREE.MeshStandardMaterial({
        color: 0x5e412a,
        roughness: 0.75,
        metalness: 0.05
    });
    const metalAccentMaterial = new THREE.MeshStandardMaterial({ color: 0x444850, roughness: 0.4, metalness: 0.5 });

    // 1. Ground base plinth / kickplate (starts above floor to prevent floor Z-fighting)
    const plinthHeight = 0.22;
    const plinthGeo = new THREE.BoxGeometry(width - 0.04, plinthHeight - 0.01, depth - 0.04);
    const plinth = new THREE.Mesh(plinthGeo, darkAccentMaterial);
    plinth.position.set(0, -height / 2 + plinthHeight / 2 + 0.005, 0);
    shelfUnit.add(plinth);

    // 2. Top canopy / cap (cleanly overhanging outer top edges to eliminate coplanar Z-fighting)
    const capHeight = 0.12;
    const capGeo = new THREE.BoxGeometry(width + 0.04, capHeight, depth + 0.04);
    const cap = new THREE.Mesh(capGeo, darkAccentMaterial);
    cap.position.set(0, height / 2 - capHeight / 2, 0);
    shelfUnit.add(cap);

    // 3. Side panels (left & right)
    const sideThickness = 0.08;
    const sideH = height - capHeight;
    const sidePanelGeometry = new THREE.BoxGeometry(sideThickness, sideH, depth);

    const leftPanel = new THREE.Mesh(sidePanelGeometry, shelfMaterial);
    leftPanel.position.set(-width / 2 + sideThickness / 2, -capHeight / 2, 0);
    shelfUnit.add(leftPanel);

    const rightPanel = new THREE.Mesh(sidePanelGeometry, shelfMaterial);
    rightPanel.position.set(width / 2 - sideThickness / 2, -capHeight / 2, 0);
    shelfUnit.add(rightPanel);

    // 4. Back panel (nested cleanly between side panels)
    const backThickness = 0.06;
    const backW = width - sideThickness * 2 - 0.02;
    const backH = height - plinthHeight - capHeight - 0.02;
    const backGeometry = new THREE.BoxGeometry(backW, backH, backThickness);
    const back = new THREE.Mesh(backGeometry, shelfMaterial);
    const backLocalZ = direction * (-depth / 2 + backThickness / 2 + 0.02);
    const backCenterY = (-height / 2 + plinthHeight + height / 2 - capHeight) / 2;
    back.position.set(0, backCenterY, backLocalZ);
    shelfUnit.add(back);

    // 5. Four spacious shelf tiers (each segment has ~1.0m+ of clear vertical space)
    const boardThickness = 0.06;
    const usableBoardWidth = width - sideThickness * 2 - 0.04;
    const usableBoardDepth = depth - backThickness - 0.06;

    // Evenly spaced tier heights across 4.8m unit
    const tierPositionsY = [
        -height / 2 + plinthHeight + 0.28, // Tier 0: -1.90m (world Y = 0.50m)
        -height / 2 + plinthHeight + 1.38, // Tier 1: -0.80m (world Y = 1.60m)
        -height / 2 + plinthHeight + 2.48, // Tier 2: +0.30m (world Y = 2.70m)
        -height / 2 + plinthHeight + 3.58  // Tier 3: +1.40m (world Y = 3.80m)
    ];

    const canopyBottomY = height / 2 - capHeight; // +2.28m
    shelfUnit.userData.tierTops = tierPositionsY.map(t => t + boardThickness / 2);
    shelfUnit.userData.tierClearance = tierPositionsY.map((t, i) =>
        (i < 3 ? tierPositionsY[i + 1] - boardThickness / 2 : canopyBottomY) - t - boardThickness / 2);

    const cosR = Math.cos(rotationY);
    const sinR = Math.sin(rotationY);

    for (let i = 0; i < tierPositionsY.length; i++) {
        const localTierY = tierPositionsY[i];

        // Available clearance height for items on this tier
        const nextCeilingY = (i < tierPositionsY.length - 1) ? (tierPositionsY[i + 1] - boardThickness / 2) : canopyBottomY;
        const shelfLocalTopY = localTierY + boardThickness / 2;
        const availHeight = nextCeilingY - shelfLocalTopY; // ~1.04m on Tiers 0..2, ~0.85m on Tier 3

        // Shelf board mesh (inset to eliminate all Z-fighting)
        const shelfGeometry = new THREE.BoxGeometry(usableBoardWidth, boardThickness, usableBoardDepth);
        const shelfMesh = new THREE.Mesh(shelfGeometry, shelfMaterial);
        shelfMesh.position.set(0, localTierY, direction * (backThickness / 2));
        shelfMesh.userData.isEmptyShelf = skipItems;
        shelfUnit.add(shelfMesh);
        shelves.push(shelfMesh);

        // Front retaining / price tag lip
        const lipGeo = new THREE.BoxGeometry(usableBoardWidth, 0.04, 0.02);
        const lip = new THREE.Mesh(lipGeo, metalAccentMaterial);
        lip.position.set(0, localTierY + boardThickness / 2 + 0.02, direction * (usableBoardDepth / 2 - 0.01 + backThickness / 2));
        shelfUnit.add(lip);

        // Place and auto-scale items to fit onto this shelf tier if not an empty shelf
        if (!skipItems) {
            placeItemsOnShelf(shelfUnit, x, y, z, width, depth, direction, rotationY, shelfLocalTopY, i, availHeight);
        }
    }

    // High Performance: Single Compound Cannon Body for the entire shelf unit
    const compoundShelfBody = new CANNON.Body({ mass: 0 });
    compoundShelfBody.position.set(x, y, z);
    compoundShelfBody.quaternion.setFromEuler(0, rotationY, 0);
    compoundShelfBody.collisionFilterGroup = 2; // Shelves group 2
    compoundShelfBody.collisionFilterMask = 1 | 4;  // Collide with player AND customers

    // 1. Plinth shape
    compoundShelfBody.addShape(
        new CANNON.Box(new CANNON.Vec3((width - 0.04) / 2, (plinthHeight - 0.01) / 2, (depth - 0.04) / 2)),
        new CANNON.Vec3(0, -height / 2 + plinthHeight / 2 + 0.005, 0)
    );
    // 2. Cap shape
    compoundShelfBody.addShape(
        new CANNON.Box(new CANNON.Vec3((width + 0.04) / 2, capHeight / 2, (depth + 0.04) / 2)),
        new CANNON.Vec3(0, height / 2 - capHeight / 2, 0)
    );
    // 3. Back panel shape
    compoundShelfBody.addShape(
        new CANNON.Box(new CANNON.Vec3(backW / 2, backH / 2, backThickness / 2)),
        new CANNON.Vec3(0, backCenterY, backLocalZ)
    );
    // 4. Side panel shapes
    const sideShape = new CANNON.Box(new CANNON.Vec3(sideThickness / 2, sideH / 2, depth / 2));
    compoundShelfBody.addShape(sideShape, new CANNON.Vec3(-width / 2 + sideThickness / 2, -capHeight / 2, 0));
    compoundShelfBody.addShape(sideShape, new CANNON.Vec3(width / 2 - sideThickness / 2, -capHeight / 2, 0));
    // 5. Shelf tier shapes
    const shelfTierShape = new CANNON.Box(new CANNON.Vec3(usableBoardWidth / 2, boardThickness / 2, usableBoardDepth / 2));
    const tierLocalZ = direction * (backThickness / 2);
    for (let i = 0; i < tierPositionsY.length; i++) {
        compoundShelfBody.addShape(shelfTierShape, new CANNON.Vec3(0, tierPositionsY[i], tierLocalZ));
    }
    world.addBody(compoundShelfBody);

    // Position and rotate the entire visual shelf unit
    shelfUnit.position.set(x, y, z);
    shelfUnit.rotation.y = rotationY;
    scene.add(shelfUnit);

    // Register shelf unit for hierarchical frustum culling
    registerCullableObject(shelfUnit, Math.max(width, depth, height) * 0.85);

    // Track unit for Falling Shelf event
    shelfUnits.push(shelfUnit);

    return shelfUnit;
}

// Shared Assets for High Performance Freezer Rendering
let sharedFreezerAssets = null;

function getSharedFreezerAssets() {
    if (sharedFreezerAssets) return sharedFreezerAssets;

    // 1. Static Signboard Texture (generated ONCE, shared across all freezers)
    const signCanvas = document.createElement('canvas');
    signCanvas.width = 512; signCanvas.height = 128;
    const sctx = signCanvas.getContext('2d');
    sctx.fillStyle = '#0b192c'; sctx.fillRect(0, 0, 512, 128);
    sctx.strokeStyle = '#0284c7'; sctx.lineWidth = 4; sctx.strokeRect(6, 6, 500, 116);
    sctx.fillStyle = '#f0f9ff'; sctx.font = 'bold 36px "Arial Black", sans-serif';
    sctx.textAlign = 'center'; sctx.fillText('❄️ FROZEN STORAGE ❄️', 256, 58);
    sctx.fillStyle = '#38bdf8'; sctx.font = 'bold 16px sans-serif';
    sctx.fillText('• SUB-ZERO FRESHNESS •', 256, 94);
    const signTex = new THREE.CanvasTexture(signCanvas);

    // 2. High-performance lightweight materials (0 PBR overhead, buttery smooth FPS)
    const bodyMat = new THREE.MeshLambertMaterial({ color: 0x2b313a });
    const darkAccentMat = new THREE.MeshLambertMaterial({ color: 0x1a1d24 });
    const steelBackMat = new THREE.MeshLambertMaterial({ color: 0xb0bec5 });
    const chromeMat = new THREE.MeshLambertMaterial({ color: 0xe2e8f0 });
    const ventMat = new THREE.MeshLambertMaterial({ color: 0x111827 });
    const frameMat = new THREE.MeshLambertMaterial({ color: 0x334155 });
    const glassMat = new THREE.MeshBasicMaterial({ color: 0xdbeafe, transparent: true, opacity: 0.35, depthWrite: false });
    const ledMat = new THREE.MeshBasicMaterial({ color: 0xe0f2fe });
    const signMat = new THREE.MeshBasicMaterial({ map: signTex });

    sharedFreezerAssets = {
        signTex,
        bodyMat,
        darkAccentMat,
        steelBackMat,
        chromeMat,
        ventMat,
        frameMat,
        glassMat,
        ledMat,
        signMat
    };
    return sharedFreezerAssets;
}

function createFreezerUnit(x, y, z, width, height, depth, direction = 1, rotationY = 0, skipItems = false, department = 'cold', stockPlan = null) {
    const shelfUnit = new THREE.Group();
    shelfUnit.userData = { items: [], rotY: rotationY, direction, width, height, depth, department,
        tierPools: stockPlan?.tierPools || getShelfTierPools(ACTIVE_ITEMS, usingAltItems), tierStock: stockPlan?.tiers || null, isFreezer: true };

    const assets = getSharedFreezerAssets();
    const bodyMaterial = assets.bodyMat;
    const darkAccentMaterial = assets.darkAccentMat;
    const steelBackMaterial = assets.steelBackMat;
    const chromeMaterial = assets.chromeMat;
    const glassMaterial = assets.glassMat;
    const signMaterial = assets.signMat;
    const ledMaterial = assets.ledMat;
    const frameMaterial = assets.frameMat;
    const ventMaterial = assets.ventMat;

    // 1. Ground base plinth / compressor intake grill
    const plinthHeight = 0.28;
    const plinthGeo = new THREE.BoxGeometry(width - 0.04, plinthHeight - 0.01, depth - 0.04);
    const plinth = new THREE.Mesh(plinthGeo, darkAccentMaterial);
    plinth.position.set(0, -height / 2 + plinthHeight / 2 + 0.005, 0);
    shelfUnit.add(plinth);

    // Front compressor vent slats
    const ventGeo = new THREE.BoxGeometry(width - 0.3, 0.14, 0.02);
    const ventMesh = new THREE.Mesh(ventGeo, ventMaterial);
    ventMesh.position.set(0, -height / 2 + plinthHeight / 2, direction * (depth / 2 - 0.01));
    shelfUnit.add(ventMesh);

    // 2. Top lightbox header canopy (Illuminated "FROZEN STORAGE")
    const capHeight = 0.32;
    const capGeo = new THREE.BoxGeometry(width + 0.04, capHeight, depth + 0.04);
    const cap = new THREE.Mesh(capGeo, darkAccentMaterial);
    cap.position.set(0, height / 2 - capHeight / 2, 0);
    shelfUnit.add(cap);

    // Lightbox sign front panel
    const signGeo = new THREE.PlaneGeometry(width - 0.1, capHeight - 0.04);
    const signMesh = new THREE.Mesh(signGeo, signMaterial);
    signMesh.position.set(0, height / 2 - capHeight / 2, direction * (depth / 2 + 0.025));
    if (direction === -1) signMesh.rotation.y = Math.PI;
    shelfUnit.add(signMesh);

    // 3. Side panels
    const sideThickness = 0.10;
    const sideH = height - capHeight;
    const sidePanelGeometry = new THREE.BoxGeometry(sideThickness, sideH, depth);

    const leftPanel = new THREE.Mesh(sidePanelGeometry, bodyMaterial);
    leftPanel.position.set(-width / 2 + sideThickness / 2, -capHeight / 2, 0);
    shelfUnit.add(leftPanel);

    const rightPanel = new THREE.Mesh(sidePanelGeometry, bodyMaterial);
    rightPanel.position.set(width / 2 - sideThickness / 2, -capHeight / 2, 0);
    shelfUnit.add(rightPanel);

    // 4. Back panel
    const backThickness = 0.08;
    const backW = width - sideThickness * 2 - 0.02;
    const backH = height - plinthHeight - capHeight - 0.02;
    const backGeometry = new THREE.BoxGeometry(backW, backH, backThickness);
    const back = new THREE.Mesh(backGeometry, steelBackMaterial);
    const backLocalZ = direction * (-depth / 2 + backThickness / 2 + 0.02);
    const backCenterY = (-height / 2 + plinthHeight + height / 2 - capHeight) / 2;
    back.position.set(0, backCenterY, backLocalZ);
    shelfUnit.add(back);

    // 5. Interior LED strip lights
    const ledHeight = backH;
    const ledGeo = new THREE.BoxGeometry(0.03, ledHeight, 0.03);
    const leftLed = new THREE.Mesh(ledGeo, ledMaterial);
    leftLed.position.set(-width / 2 + sideThickness + 0.02, backCenterY, direction * (depth / 2 - 0.10));
    shelfUnit.add(leftLed);

    const rightLed = new THREE.Mesh(ledGeo, ledMaterial);
    rightLed.position.set(width / 2 - sideThickness - 0.02, backCenterY, direction * (depth / 2 - 0.10));
    shelfUnit.add(rightLed);

    // 6. Four wire-grid shelves / tiers
    const boardThickness = 0.04;
    const usableBoardWidth = width - sideThickness * 2 - 0.04;
    const usableBoardDepth = depth - backThickness - 0.12;

    const tierPositionsY = [
        -height / 2 + plinthHeight + 0.28,
        -height / 2 + plinthHeight + 1.38,
        -height / 2 + plinthHeight + 2.48,
        -height / 2 + plinthHeight + 3.58
    ];
    const canopyBottomY = height / 2 - capHeight;
    shelfUnit.userData.tierTops = tierPositionsY.map(t => t + boardThickness / 2);
    shelfUnit.userData.tierClearance = tierPositionsY.map((t, i) =>
        (i < 3 ? tierPositionsY[i + 1] - boardThickness / 2 : canopyBottomY) - t - boardThickness / 2);

    for (let i = 0; i < tierPositionsY.length; i++) {
        const localTierY = tierPositionsY[i];

        // Shelf mesh
        const shelfGeometry = new THREE.BoxGeometry(usableBoardWidth, boardThickness, usableBoardDepth);
        const shelfMesh = new THREE.Mesh(shelfGeometry, chromeMaterial);
        shelfMesh.position.set(0, localTierY, direction * (backThickness / 2 - 0.02));
        shelfUnit.add(shelfMesh);
        shelves.push(shelfMesh);

        // Front price tag rail
        const lipGeo = new THREE.BoxGeometry(usableBoardWidth, 0.04, 0.02);
        const lipMat = new THREE.MeshLambertMaterial({ color: 0x0284c7 });
        const lip = new THREE.Mesh(lipGeo, lipMat);
        lip.position.set(0, localTierY + boardThickness / 2 + 0.02, direction * (usableBoardDepth / 2 - 0.01 + backThickness / 2 - 0.02));
        shelfUnit.add(lip);
    }

    // High Performance: Single Compound Cannon Body for the freezer unit
    const compoundFreezerBody = new CANNON.Body({ mass: 0 });
    compoundFreezerBody.position.set(x, y, z);
    compoundFreezerBody.quaternion.setFromEuler(0, rotationY, 0);
    compoundFreezerBody.collisionFilterGroup = 2;
    compoundFreezerBody.collisionFilterMask = 1 | 4;

    compoundFreezerBody.addShape(
        new CANNON.Box(new CANNON.Vec3((width - 0.04) / 2, (plinthHeight - 0.01) / 2, (depth - 0.04) / 2)),
        new CANNON.Vec3(0, -height / 2 + plinthHeight / 2 + 0.005, 0)
    );
    compoundFreezerBody.addShape(
        new CANNON.Box(new CANNON.Vec3((width + 0.04) / 2, capHeight / 2, (depth + 0.04) / 2)),
        new CANNON.Vec3(0, height / 2 - capHeight / 2, 0)
    );
    compoundFreezerBody.addShape(
        new CANNON.Box(new CANNON.Vec3(backW / 2, backH / 2, backThickness / 2)),
        new CANNON.Vec3(0, backCenterY, backLocalZ)
    );
    const freezerSideShape = new CANNON.Box(new CANNON.Vec3(sideThickness / 2, sideH / 2, depth / 2));
    compoundFreezerBody.addShape(freezerSideShape, new CANNON.Vec3(-width / 2 + sideThickness / 2, -capHeight / 2, 0));
    compoundFreezerBody.addShape(freezerSideShape, new CANNON.Vec3(width / 2 - sideThickness / 2, -capHeight / 2, 0));

    const freezerShelfShape = new CANNON.Box(new CANNON.Vec3(usableBoardWidth / 2, boardThickness / 2, usableBoardDepth / 2));
    const tierZ = direction * (backThickness / 2 - 0.02);
    for (let i = 0; i < tierPositionsY.length; i++) {
        compoundFreezerBody.addShape(freezerShelfShape, new CANNON.Vec3(0, tierPositionsY[i], tierZ));
    }
    world.addBody(compoundFreezerBody);

    // 8. Reach-In Commercial Glass Doors with Amnesia Physical Drag Hinge System
    const doorCount = 2;
    const doorW = (usableBoardWidth / 2) - 0.04;
    const doorH = backH - 0.02;
    const doorThick = 0.05;
    const doorFrontLocalZ = direction * (depth / 2 - doorThick / 2);

    const createdDoors = [];

    for (let d = 0; d < doorCount; d++) {
        const isLeft = (d === 0);
        // Swing each door outward from the cabinet front. The previous sign
        // sent both panels toward the solid back/interior of the freezer.
        const hingeSign = (isLeft ? -1 : 1) * (direction || 1);
        const hingeLocalX = isLeft 
            ? (-width / 2 + sideThickness + 0.02)
            : (width / 2 - sideThickness - 0.02);

        const hingePivot = new THREE.Group();
        hingePivot.position.set(hingeLocalX, backCenterY, doorFrontLocalZ);
        shelfUnit.add(hingePivot);

        const doorPanel = new THREE.Group();
        const doorCenterOffset = isLeft ? (doorW / 2) : (-doorW / 2);
        doorPanel.position.set(doorCenterOffset, 0, 0);
        hingePivot.add(doorPanel);

        const frameThickness = 0.08;

        // Frame top/bottom/sides
        const frameTop = new THREE.Mesh(new THREE.BoxGeometry(doorW, frameThickness, doorThick), frameMaterial);
        frameTop.position.set(0, doorH / 2 - frameThickness / 2, 0);
        doorPanel.add(frameTop);

        const frameBot = new THREE.Mesh(new THREE.BoxGeometry(doorW, frameThickness, doorThick), frameMaterial);
        frameBot.position.set(0, -doorH / 2 + frameThickness / 2, 0);
        doorPanel.add(frameBot);

        const frameLeft = new THREE.Mesh(new THREE.BoxGeometry(frameThickness, doorH - frameThickness * 2, doorThick), frameMaterial);
        frameLeft.position.set(-doorW / 2 + frameThickness / 2, 0, 0);
        doorPanel.add(frameLeft);

        const frameRight = new THREE.Mesh(new THREE.BoxGeometry(frameThickness, doorH - frameThickness * 2, doorThick), frameMaterial);
        frameRight.position.set(doorW / 2 - frameThickness / 2, 0, 0);
        doorPanel.add(frameRight);

        // Insulated double-pane frosty glass
        const glassGeo = new THREE.BoxGeometry(doorW - frameThickness * 2, doorH - frameThickness * 2, 0.015);
        const glassMesh = new THREE.Mesh(glassGeo, glassMaterial);
        doorPanel.add(glassMesh);

        // Vertical ergonomic tubular stainless steel grab handle
        const handleX = isLeft ? (doorW / 2 - frameThickness / 2 - 0.04) : (-doorW / 2 + frameThickness / 2 + 0.04);
        const handleGroup = new THREE.Group();
        handleGroup.position.set(handleX, 0, direction * (doorThick / 2 + 0.06));

        const handleBar = new THREE.Mesh(
            new THREE.CylinderGeometry(0.024, 0.024, 1.4, 12),
            chromeMaterial
        );
        handleGroup.add(handleBar);

        const standOffTop = new THREE.Mesh(
            new THREE.CylinderGeometry(0.016, 0.016, 0.08, 8),
            chromeMaterial
        );
        standOffTop.rotation.x = Math.PI / 2;
        standOffTop.position.set(0, 0.55, -0.04 * direction);
        handleGroup.add(standOffTop);

        const standOffBot = new THREE.Mesh(
            new THREE.CylinderGeometry(0.016, 0.016, 0.08, 8),
            chromeMaterial
        );
        standOffBot.rotation.x = Math.PI / 2;
        standOffBot.position.set(0, -0.55, -0.04 * direction);
        handleGroup.add(standOffBot);

        doorPanel.add(handleGroup);

        // Randomized heaviness / difficulty (-30% light to +75% heavy)
        let difficulty = (Math.random() * 1.05 - 0.30);
        difficulty = Math.max(-0.30, Math.min(0.75, difficulty));

        const doorData = {
            unit: shelfUnit,
            hingeGroup: hingePivot,
            panelGroup: doorPanel,
            handleMesh: handleBar,
            glassMesh: glassMesh,
            frameMesh: frameTop,
            hitMeshes: [handleBar, glassMesh, frameTop, frameBot, frameLeft, frameRight],
            hingeSign: hingeSign,
            shelfDirection: direction,
            currentAngle: 0,
            angularVelocity: 0,
            maxAngle: 1.85, // ~106 degrees
            heavinessDifficulty: difficulty,
            friction: 0.91 + Math.max(0, difficulty) * 0.05,
            isSealed: true,
            sealTension: 0,
            isGrabbed: false,
            itemsInside: [],
            lastCreakSoundTime: 0,
            isLeft: isLeft
        };

        // Attach user reference for fast raycaster lookup
        handleBar.userData = { freezerDoor: doorData };
        glassMesh.userData = { freezerDoor: doorData };
        frameTop.userData = { freezerDoor: doorData };
        frameBot.userData = { freezerDoor: doorData };
        frameLeft.userData = { freezerDoor: doorData };
        frameRight.userData = { freezerDoor: doorData };

        // ONLY push handle and glass to the interaction cache (fast flat raycasting)
        freezerDoorMeshesCache.push(handleBar, glassMesh);

        allFreezerDoors.push(doorData);
        createdDoors.push(doorData);
    }

    // Position and add shelfUnit to scene
    shelfUnit.position.set(x, y, z);
    shelfUnit.rotation.y = rotationY;
    shelfUnit.updateMatrixWorld(true);
    scene.add(shelfUnit);

    shelfUnit.userData.doors = createdDoors;
    // Freezers retain the same mixed, layer-specific RNG stock as other shelves.
    if (!skipItems) {
        for (let i = 0; i < tierPositionsY.length; i++) {
            const localTierY = tierPositionsY[i];
            const nextCeilingY = (i < tierPositionsY.length - 1) ? (tierPositionsY[i + 1] - boardThickness / 2) : canopyBottomY;
            const shelfLocalTopY = localTierY + boardThickness / 2;
            const availHeight = nextCeilingY - shelfLocalTopY;

            // Use normal shelf item placement logic
            placeItemsOnShelf(shelfUnit, x, y, z, width, depth, direction, rotationY, shelfLocalTopY, i, availHeight);
        }
    }

    // Link placed items on this shelf unit to their respective freezer door (left vs right)
    if (shelfUnit.userData.items && createdDoors.length >= 2) {
        shelfUnit.updateMatrixWorld(true);
        shelfUnit.userData.items.forEach(itemObj => {
            if (!itemObj || !itemObj.mesh) return;
            const itemWorldPos = new THREE.Vector3();
            itemObj.mesh.getWorldPosition(itemWorldPos);
            const itemLocal = shelfUnit.worldToLocal(itemWorldPos);
            const assignedDoor = (itemLocal.x < 0) ? createdDoors[0] : createdDoors[1];
            itemObj.freezerDoor = assignedDoor;
            assignedDoor.itemsInside.push(itemObj);
        });
    }

    registerCullableObject(shelfUnit, Math.max(width, depth, height) * 0.85);
    shelfUnits.push(shelfUnit);
    freezerUnits.push(shelfUnit);

    return shelfUnit;
}

function findFreezerDoorFromMesh(mesh) {
    if (!mesh) return null;
    let curr = mesh;
    while (curr) {
        if (curr.userData && curr.userData.freezerDoor) {
            return curr.userData.freezerDoor;
        }
        for (const door of allFreezerDoors) {
            if (door.hitMeshes && door.hitMeshes.includes(curr)) return door;
            if (door.hingeGroup === curr || door.panelGroup === curr || door.handleMesh === curr || door.glassMesh === curr) return door;
        }
        curr = curr.parent;
    }
    return null;
}

function updateFreezerDoors(delta) {
    if (!allFreezerDoors || allFreezerDoors.length === 0) return;
    
    const now = performance.now();
    let nearestFreezerDist = Infinity;

    // Throttle proximity distance check to every 20 frames
    const shouldCheckDistance = (frameCount % 20 === 0);

    for (let i = 0; i < allFreezerDoors.length; i++) {
        const door = allFreezerDoors[i];
        
        if (shouldCheckDistance && camera && door.unit) {
            const unitWorldPos = door.unit.position;
            const dist = camera.position.distanceTo(unitWorldPos);
            if (dist < nearestFreezerDist) nearestFreezerDist = dist;
        }

        // If not grabbed, apply damping / friction
        if (!door.isGrabbed) {
            door.angularVelocity *= Math.pow(door.friction, delta * 60);
        }

        // Integrate angular position
        if (Math.abs(door.angularVelocity) > 0.001) {
            door.currentAngle += door.angularVelocity * delta;

            // Creak sound effect during movement
            if (Math.abs(door.angularVelocity) > 0.18 && (now - door.lastCreakSoundTime > 1400)) {
                door.lastCreakSoundTime = now;
                try {
                    if (soundEffects.freezerDoorCreak) {
                        const sfx = soundEffects.freezerDoorCreak.cloneNode();
                        const speedVol = Math.min(1.0, Math.abs(door.angularVelocity) / 2.0);
                        sfx.volume = (CONFIG.SFX_VOLUME || 0.8) * (0.4 + speedVol * 0.6);
                        // Heavy doors have deeper pitch (0.75 - 0.9), light doors have higher pitch (1.05 - 1.25)
                        const pitch = 1.0 - (door.heavinessDifficulty || 0) * 0.35;
                        sfx.playbackRate = Math.max(0.65, Math.min(1.4, pitch));
                        sfx.play().catch(() => {});
                    }
                } catch(_) {}
            }
        } else {
            door.angularVelocity = 0;
        }

        // Door frame collision (shut)
        if (door.currentAngle <= 0) {
            if (door.angularVelocity < -0.35) {
                // Slam shut sound!
                try {
                    if (soundEffects.freezerDoorSlam) {
                        const slamSfx = soundEffects.freezerDoorSlam.cloneNode();
                        slamSfx.volume = Math.min(1.0, (CONFIG.SFX_VOLUME || 0.8) * (0.6 + Math.abs(door.angularVelocity) * 0.3));
                        slamSfx.play().catch(() => {});
                    }
                } catch(_) {}
            }
            door.currentAngle = 0;
            door.angularVelocity = 0;
            door.isSealed = true;
            door.sealTension = 0;
        }

        // Stopper limit (fully open)
        if (door.currentAngle >= door.maxAngle) {
            door.currentAngle = door.maxAngle;
            door.angularVelocity = -door.angularVelocity * 0.25; // Rebound off bumper
        }

        // Update 3D door hinge rotation
        if (door.hingeGroup) {
            door.hingeGroup.rotation.y = door.hingeSign * door.currentAngle;
        }
    }

    // Proximity compressor hum
    if (shouldCheckDistance) {
        try {
            if (soundEffects.freezerHum && gameStarted && !gamePaused) {
                if (nearestFreezerDist < 14) {
                    const humVol = Math.max(0, (1 - nearestFreezerDist / 14)) * (CONFIG.SFX_VOLUME || 0.8) * 0.35;
                    soundEffects.freezerHum.volume = humVol;
                    if (soundEffects.freezerHum.paused) {
                        soundEffects.freezerHum.play().catch(() => {});
                    }
                } else {
                    soundEffects.freezerHum.volume = 0;
                }
            }
        } catch(_) {}
    }
}

function placeItemsOnShelf(shelfUnit, x, y, z, width, depth, direction, rotationY, shelfLocalTopY, shelfLevel, availHeight = 0.95) {
    // In Lonely Store mode / Lights Out creepy event, all shelves are barren and completely empty
    if (isLonelyStoreMode) {
        return;
    }

    // Department signs are hints. The original layer pools are authoritative,
    // with independent uniform RNG, including on freezer replacement shelves.
    const candidateItems = shelfUnit.userData.tierPools[shelfLevel % 4];
    const rolledItems = shelfUnit.userData.tierStock?.[shelfLevel % 4];
    if (!candidateItems?.length) return;

    // Determine how many items to place (3 to 5 per tier)
    const itemCount = Math.min(rolledItems?.length ?? (Math.floor(Math.random() * 3) + 3), Math.floor((width - 1.2) / 1.1));
    const usableWidth = width - 1.4;
    const spacing = usableWidth / (itemCount + 1);

    const cosR = Math.cos(rotationY);
    const sinR = Math.sin(rotationY);

    for (let i = 0; i < itemCount; i++) {
        // Use the already-rolled stock unchanged after grouping the fixture.
        const itemTemplate = rolledItems ? rolledItems[i] : candidateItems[Math.floor(Math.random() * candidateItems.length)];
        if (!itemTemplate) continue;

        // Create visible color
        const hue = Math.random() * 0.1 - 0.05;
        const color = new THREE.Color(itemTemplate.color);
        color.offsetHSL(hue, 0, (Math.random() * 0.2 - 0.1) * (CONFIG.ITEM_COLOR_BRIGHTNESS || 0.8));

        // Position along the shelf in local space
        const localX = -width / 2 + 0.7 + (i + 1) * spacing;
        // Keep items centered safely in the front-half of the tier (clear from back wall)
        const localZ = direction * (depth * 0.16);

        // Rotate local coordinates to world coordinates (Y will be precisely computed upon seating)
        const worldItemX = x + localX * cosR + localZ * sinR;
        const worldItemZ = z - localX * sinR + localZ * cosR;

        // Align item facing with the shelf's open face
        const baseFacing = rotationY + (direction === -1 ? Math.PI : 0);
        const itemRotY = baseFacing + (Math.random() - 0.5) * 0.25;

        // Pass shelfLocalTopY and availHeight for auto-scaling and exact seating
        const itemObj = createStaticItem(
            itemTemplate.name,
            color,
            itemTemplate.size,
            worldItemX,
            y, // shelf world Y
            worldItemZ,
            itemTemplate.model,
            itemRotY,
            shelfLocalTopY,
            availHeight
        );

        if (shelfUnit && itemObj) {
            shelfUnit.userData.items.push(itemObj);
            storeStockCounts[itemTemplate.name] = (storeStockCounts[itemTemplate.name] || 0) + 1;
        }
    }
}

function createStaticItem(name, color, nominalSize, x, shelfWorldY, z, modelFunction, rotY, shelfLocalTopY = null, availHeight = 0.95) {
    let itemGroup;
    let actualWidth = nominalSize[0];
    let actualHeight = nominalSize[1];
    let actualDepth = nominalSize[2];

    if (modelFunction) {
        // Create raw model and wrap it
        const rawModel = modelFunction();
        const wrapper = new THREE.Group();
        wrapper.add(rawModel);

        const bbox = new THREE.Box3().setFromObject(rawModel);
        if (!bbox.isEmpty()) {
            const bCenter = new THREE.Vector3();
            const bSize = new THREE.Vector3();
            bbox.getCenter(bCenter);
            bbox.getSize(bSize);

            // Center raw geometry inside wrapper around (0, 0, 0)
            rawModel.position.sub(bCenter);

            const rawH = bSize.y > 0 ? bSize.y : nominalSize[1];
            const rawW = bSize.x > 0 ? bSize.x : nominalSize[0];
            const rawD = bSize.z > 0 ? bSize.z : nominalSize[2];

            // AUTO-SCALE: ensure the item fits cleanly with generous headroom (taking ~65% of available tier height)
            const maxAllowedH = availHeight * 0.65; // e.g. ~0.60m - 0.68m
            const maxAllowedD = 0.48; // ample room to front and back
            const maxAllowedW = 0.70;

            const scaleH = maxAllowedH / rawH;
            const scaleD = maxAllowedD / rawD;
            const scaleW = maxAllowedW / rawW;
            const fitScale = Math.min(1.0, scaleH, scaleD, scaleW) * ITEM_SCALE;

            wrapper.scale.set(fitScale, fitScale, fitScale);

            actualWidth = rawW * fitScale;
            actualHeight = rawH * fitScale;
            actualDepth = rawD * fitScale;
        }
        itemGroup = wrapper;
    } else {
        // Create box fallback and auto-scale to fit
        const maxAllowedH = availHeight * 0.65;
        const maxAllowedD = 0.48;
        const maxAllowedW = 0.70;

        const scaleH = maxAllowedH / nominalSize[1];
        const scaleD = maxAllowedD / nominalSize[2];
        const scaleW = maxAllowedW / nominalSize[0];
        const fitScale = Math.min(1.0, scaleH, scaleD, scaleW) * ITEM_SCALE;

        actualWidth = nominalSize[0] * fitScale;
        actualHeight = nominalSize[1] * fitScale;
        actualDepth = nominalSize[2] * fitScale;

        const geometry = new THREE.BoxGeometry(actualWidth, actualHeight, actualDepth);
        const material = new THREE.MeshStandardMaterial({ color: color });
        itemGroup = new THREE.Mesh(geometry, material);
    }

    // EXACT SEATING ON SHELF:
    // When placed on a shelf, seat the bottom of the item (which is at -actualHeight / 2)
    // exactly 2mm above the shelf board's top surface!
    const worldY = (shelfLocalTopY !== null)
        ? (shelfWorldY + shelfLocalTopY + actualHeight / 2 + 0.002)
        : shelfWorldY;

    // Position and orient the item
    itemGroup.position.set(x, worldY, z);
    itemGroup.rotation.y = (rotY !== undefined) ? rotY : (Math.random() * Math.PI);
    itemGroup.castShadow = false;
    itemGroup.receiveShadow = true;
    itemGroup.traverse(child => {
        child.castShadow = false;
        child.receiveShadow = true;
    });

    // Create physics body for interaction
    const shape = new CANNON.Box(new CANNON.Vec3(
        actualWidth / 2,
        actualHeight / 2,
        actualDepth / 2
    ));

    const body = new CANNON.Body({
        mass: 1,
        shape: shape,
        position: new CANNON.Vec3(x, worldY, z)
    });
    body.quaternion.setFromEuler(0, itemGroup.rotation.y, 0);

    // Initially static but can be made dynamic when grabbed.
    // PERF: shelf items are NOT added to the physics world while they sit on a
    // shelf (the shelf's compound body already handles collisions). Hundreds of
    // static bodies made cannon's O(n²) collision matrix reset every substep and
    // caused massive per-frame stalls. Every code path that frees an item
    // removes this body and creates a fresh dynamic one, so nothing depends on it
    // being in the world.
    body.type = CANNON.Body.STATIC;

    scene.add(itemGroup);

    // Add to all items array with proper properties
    const itemObj = {
        name: name,
        mesh: itemGroup,
        body: body,
        size: [actualWidth, actualHeight, actualDepth],
        isOnSale: false,
        inCart: false,
        isCollected: false,
        isStatic: true,
        initialPosition: { x, y: worldY, z },
        stolen: false
    };

    allItems.push(itemObj);
    return itemObj;
}

function createCheckout() {
    // Clear any previous checkout button
    if (checkoutButton) {
        if (checkoutButton.mesh?.parent) checkoutButton.mesh.parent.remove(checkoutButton.mesh);
        if (checkoutButton.body) { try { world.removeBody(checkoutButton.body); } catch(e) {} }
        checkoutButton = null;
    }
    
    // Create modern architectural checkout counter and lane
    const counterGroup = new THREE.Group();

    // --- High-Performance Materials ---
    const cabinetryMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.5, metalness: 0.15 });
    const cabinetAccentMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.6 });
    const steelMat = new THREE.MeshStandardMaterial({ color: 0xd1d5db, roughness: 0.22, metalness: 0.85 });
    const chromeMat = new THREE.MeshStandardMaterial({ color: 0xe5e7eb, roughness: 0.15, metalness: 0.9 });
    const beltMat = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.85 });
    const plasticMat = new THREE.MeshStandardMaterial({ color: 0x18181b, roughness: 0.35, metalness: 0.2 });
    const scannerGlassMat = new THREE.MeshStandardMaterial({ color: 0x0284c7, roughness: 0.08, metalness: 0.8 });
    const laserMat = new THREE.MeshBasicMaterial({ color: 0xef4444 });
    const laneOpenMat = new THREE.MeshStandardMaterial({ color: 0x22c55e, emissive: 0x16a34a, emissiveIntensity: 0.85, roughness: 0.2 });

    // 1. MAIN COUNTER BASE & WORK SURFACES (6.2m length x 1.8m width)
    // Recessed bottom kickboard / plinth
    const kickboard = new THREE.Mesh(new THREE.BoxGeometry(6.1, 0.08, 1.76), cabinetAccentMat);
    kickboard.position.y = 0.04;
    kickboard.castShadow = false; kickboard.receiveShadow = false;
    counterGroup.add(kickboard);

    // Main heavy-duty cabinetry unit
    const counterBase = new THREE.Mesh(new THREE.BoxGeometry(6.0, 0.88, 1.7), cabinetryMat);
    counterBase.position.y = 0.48;
    counterBase.castShadow = false; counterBase.receiveShadow = false;
    counterGroup.add(counterBase);

    // Aluminum bumper accent rub-strips along perimeter
    const rubStripFront = new THREE.Mesh(new THREE.BoxGeometry(6.04, 0.06, 0.04), chromeMat);
    rubStripFront.position.set(0, 0.48, 0.86);
    const rubStripBack = new THREE.Mesh(new THREE.BoxGeometry(6.04, 0.06, 0.04), chromeMat);
    rubStripBack.position.set(0, 0.48, -0.86);
    counterGroup.add(rubStripFront, rubStripBack);

    // Stainless steel main countertop deck
    const counterTop = new THREE.Mesh(new THREE.BoxGeometry(6.12, 0.06, 1.82), steelMat);
    counterTop.position.y = 0.95;
    counterTop.castShadow = false; counterTop.receiveShadow = false;
    counterGroup.add(counterTop);

    // 2. MOTORIZED CONVEYOR BELT UNIT
    const beltLength = 3.0, beltWidth = 1.05;
    const beltMesh = new THREE.Mesh(new THREE.BoxGeometry(beltLength, 0.03, beltWidth), beltMat);
    beltMesh.position.set(0.9, 0.99, 0.15);
    counterGroup.add(beltMesh);

    // Stainless steel conveyor side guide rails
    const guideLeft = new THREE.Mesh(new THREE.BoxGeometry(beltLength + 0.1, 0.08, 0.04), steelMat);
    guideLeft.position.set(0.9, 1.02, 0.15 + beltWidth / 2 + 0.02);
    const guideRight = new THREE.Mesh(new THREE.BoxGeometry(beltLength + 0.1, 0.08, 0.04), steelMat);
    guideRight.position.set(0.9, 1.02, 0.15 - beltWidth / 2 - 0.02);
    counterGroup.add(guideLeft, guideRight);

    // Optical divider sensor arch post at conveyor end
    const sensorPostL = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.22, 10), plasticMat);
    sensorPostL.position.set(-0.55, 1.08, 0.15 + beltWidth / 2 + 0.02);
    const sensorPostR = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.22, 10), plasticMat);
    sensorPostR.position.set(-0.55, 1.08, 0.15 - beltWidth / 2 - 0.02);
    const sensorLens = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 8), laserMat);
    sensorLens.position.set(-0.55, 1.15, 0.15 + beltWidth / 2);
    counterGroup.add(sensorPostL, sensorPostR, sensorLens);

    // Grocery lane divider bars ("NEXT CUSTOMER PLEASE") in holder tray
    const dividerTray = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.04, 0.14), plasticMat);
    dividerTray.position.set(2.1, 0.99, 0.72);
    counterGroup.add(dividerTray);
    const dividerColors = [0x2563eb, 0xdc2626, 0xf59e0b];
    dividerColors.forEach((col, dIdx) => {
        const bar = new THREE.Mesh(
            new THREE.BoxGeometry(0.48, 0.025, 0.025),
            new THREE.MeshStandardMaterial({ color: col, roughness: 0.3 })
        );
        bar.position.set(2.1, 1.03 + dIdx * 0.022, 0.70 + (dIdx - 1) * 0.03);
        counterGroup.add(bar);
    });

    // 3. BI-OPTIC BARCODE SCANNER & INTEGRATED SCALE PLATFORM
    const scannerBase = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.08, 0.85), steelMat);
    scannerBase.position.set(-0.95, 0.99, 0.15);
    // Vertical scanner glass window facing customer flow
    const scannerTower = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.32, 0.45), plasticMat);
    scannerTower.position.set(-0.95, 1.14, -0.2);
    const scanGlassV = new THREE.Mesh(new THREE.PlaneGeometry(0.38, 0.22), scannerGlassMat);
    scanGlassV.position.set(-0.95, 1.14, -0.138);
    // Horizontal scan platter glass
    const scanGlassH = new THREE.Mesh(new THREE.PlaneGeometry(0.45, 0.45), scannerGlassMat);
    scanGlassH.rotation.x = -Math.PI / 2;
    scanGlassH.position.set(-0.95, 1.032, 0.18);
    // Laser emitter line
    const scanLaser = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.015, 0.015), laserMat);
    scanLaser.position.set(-0.95, 1.14, -0.13);
    // Digital weight scale readout
    const scaleCanvas = document.createElement('canvas');
    scaleCanvas.width = 128; scaleCanvas.height = 64;
    const sctx = scaleCanvas.getContext('2d');
    sctx.fillStyle = '#020617'; sctx.fillRect(0, 0, 128, 64);
    sctx.fillStyle = '#22c55e'; sctx.font = 'bold 26px monospace';
    sctx.textAlign = 'center'; sctx.fillText('0.00 LB', 64, 42);
    const scaleTex = new THREE.CanvasTexture(scaleCanvas);
    const scaleDisplay = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 0.07), new THREE.MeshBasicMaterial({ map: scaleTex }));
    scaleDisplay.position.set(-0.95, 1.05, 0.52);
    scaleDisplay.rotation.x = -Math.PI / 4;
    counterGroup.add(scannerBase, scannerTower, scanGlassV, scanGlassH, scanLaser, scaleDisplay);

    // 4. CASHIER POS TOUCHSCREEN TERMINAL
    const posStand = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.35, 12), steelMat);
    posStand.position.set(-1.8, 1.15, -0.35);
    const posHead = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.45, 0.05), plasticMat);
    posHead.position.set(-1.8, 1.40, -0.35);
    posHead.rotation.x = -Math.PI / 8;
    posHead.rotation.y = 0.15;

    // Cashier UI screen texture
    const posCanvas = document.createElement('canvas');
    posCanvas.width = 512; posCanvas.height = 320;
    const pctx = posCanvas.getContext('2d');
    pctx.fillStyle = '#0f172a'; pctx.fillRect(0, 0, 512, 320);
    pctx.fillStyle = '#1e3a8a'; pctx.fillRect(0, 0, 512, 45);
    pctx.fillStyle = '#ffffff'; pctx.font = 'bold 20px sans-serif';
    pctx.fillText('MAGMART POS v4.2 • REGISTER 01', 20, 30);
    pctx.fillStyle = '#22c55e'; pctx.beginPath(); pctx.arc(485, 22, 10, 0, Math.PI * 2); pctx.fill();
    // Itemized receipt list window
    pctx.fillStyle = '#1e293b'; pctx.fillRect(16, 56, 480, 180);
    pctx.fillStyle = '#94a3b8'; pctx.font = '16px monospace';
    pctx.fillText('READY FOR ITEMS... SCAN ITEM TO BEGIN', 30, 90);
    pctx.fillText('TAX RATE: 7.00% • STORE #0142', 30, 120);
    // Total banner
    pctx.fillStyle = '#0284c7'; pctx.fillRect(16, 246, 480, 60);
    pctx.fillStyle = '#ffffff'; pctx.font = 'bold 28px monospace';
    pctx.fillText('TOTAL DUE: $0.00', 30, 288);
    const posTex = new THREE.CanvasTexture(posCanvas);
    const posScreen = new THREE.Mesh(new THREE.PlaneGeometry(0.68, 0.41), new THREE.MeshBasicMaterial({ map: posTex }));
    posScreen.position.set(-1.8, 1.40, -0.32);
    posScreen.rotation.x = -Math.PI / 8;
    posScreen.rotation.y = 0.15;

    // Cash Drawer beneath counter
    const cashDrawer = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.14, 0.55), steelMat);
    cashDrawer.position.set(-1.8, 0.88, -0.35);

    // Receipt printer
    const printer = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.18, 0.22), plasticMat);
    printer.position.set(-1.35, 1.06, -0.42);
    const receiptPaper = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.16), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
    receiptPaper.position.set(-1.35, 1.18, -0.35);
    receiptPaper.rotation.x = Math.PI / 6;

    counterGroup.add(posStand, posHead, posScreen, cashDrawer, printer, receiptPaper);

    // 5. CUSTOMER PIN PAD & CONTACTLESS TERMINAL
    const pinPedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.25, 12), steelMat);
    pinPedestal.position.set(-1.0, 1.10, 0.72);
    const pinTerminal = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.28, 0.06), plasticMat);
    pinTerminal.position.set(-1.0, 1.25, 0.72);
    pinTerminal.rotation.x = -Math.PI / 4;
    pinTerminal.rotation.y = Math.PI;

    const pinCanvas = document.createElement('canvas');
    pinCanvas.width = 256; pinCanvas.height = 384;
    const pinCtx = pinCanvas.getContext('2d');
    pinCtx.fillStyle = '#0f172a'; pinCtx.fillRect(0, 0, 256, 384);
    pinCtx.fillStyle = '#0284c7'; pinCtx.fillRect(0, 0, 256, 60);
    pinCtx.fillStyle = '#ffffff'; pinCtx.font = 'bold 22px sans-serif';
    pinCtx.textAlign = 'center'; pinCtx.fillText('INSERT / TAP', 128, 38);
    // Contactless icon wave
    pinCtx.strokeStyle = '#38bdf8'; pinCtx.lineWidth = 4;
    for (let r = 1; r <= 3; r++) {
        pinCtx.beginPath(); pinCtx.arc(128, 120, r * 16, Math.PI * 0.2, Math.PI * 0.8); pinCtx.stroke();
    }
    // Keypad numbers representation
    pinCtx.fillStyle = '#334155';
    for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 3; col++) {
            pinCtx.fillRect(36 + col * 64, 180 + row * 45, 52, 36);
        }
    }
    const pinTex = new THREE.CanvasTexture(pinCanvas);
    const pinScreen = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.25), new THREE.MeshBasicMaterial({ map: pinTex }));
    pinScreen.position.set(-1.0, 1.25, 0.755);
    pinScreen.rotation.x = -Math.PI / 4;
    pinScreen.rotation.y = Math.PI;
    counterGroup.add(pinPedestal, pinTerminal, pinScreen);

    // 6. DUAL BAGGING WELL & CAROUSEL RACK
    const bagWell = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.04, 1.3), steelMat);
    bagWell.position.set(-2.2, 0.92, 0.1);
    counterGroup.add(bagWell);

    // Dual chrome bag arms
    [-0.3, 0.3].forEach(bx => {
        const bagPost = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.35, 10), chromeMat);
        bagPost.position.set(-2.2 + bx, 1.10, 0.1);
        const bagArm = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.45, 10), chromeMat);
        bagArm.rotation.x = Math.PI / 2;
        bagArm.position.set(-2.2 + bx, 1.25, 0.1);
        // Hanging MagMart plastic/paper bags
        const bagMesh = new THREE.Mesh(
            new THREE.BoxGeometry(0.32, 0.36, 0.18),
            new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.6, transparent: true, opacity: 0.85 })
        );
        bagMesh.position.set(-2.2 + bx, 1.05, 0.1);
        counterGroup.add(bagPost, bagArm, bagMesh);
    });

    // 7. FRONT IMPULSE CANDY & GUM MERCHANDISER
    const impulseRack = new THREE.Group();
    const impulseBack = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.65, 0.03), plasticMat);
    impulseBack.position.set(0.6, 0.52, 0.87);
    impulseRack.add(impulseBack);

    // 3 Tiers of grab-able chewing gum packs exclusively at checkout!
    const gumFlavors = [
        { color: 0x16a34a, label: 'SPEARMINT' },
        { color: 0xec4899, label: 'BUBBLEGUM' },
        { color: 0x0284c7, label: 'PEPPERMINT' },
        { color: 0xdc2626, label: 'CINNAMON' },
        { color: 0x84cc16, label: 'SOUR APPLE' },
        { color: 0xeab308, label: 'JUICY FRUIT' }
    ];

    for (let t = 0; t < 3; t++) {
        const shelfLip = new THREE.Mesh(new THREE.BoxGeometry(2.35, 0.025, 0.14), chromeMat);
        shelfLip.position.set(0.6, 0.30 + t * 0.20, 0.94);
        impulseRack.add(shelfLip);

        gumFlavors.forEach((gf, cIdx) => {
            // Checkout counter origin in world is (15, 0, -15)
            const localX = 0.6 - 0.95 + cIdx * 0.38;
            const localY = 0.30 + t * 0.20 + 0.045;
            const localZ = 0.94;

            const worldX = 15 + localX;
            const worldY = localY;
            const worldZ = -15 + localZ;

            const gumItem = createStaticItem(
                "Gum",
                new THREE.Color(gf.color),
                [0.30, 0.08, 0.12],
                worldX,
                worldY,
                worldZ,
                () => createGumModel(gf.color, gf.label),
                0, // rotY
                null, // shelfLocalTopY (already in absolute world Y)
                0.25
            );
            if (gumItem) {
                gumItem.isCheckoutGum = true;
            }
        });
    }
    counterGroup.add(impulseRack);

    // 8. ARCHITECTURAL OVERHEAD SIGN STRUCTURE & MOUNTING (NO FLOATING SIGNS!)
    const gantryGroup = new THREE.Group();
    const stanchionRadius = 0.06;
    const stanchionH = 3.65;

    // Left vertical support stanchion column firmly anchored to counter
    const stanchionL = new THREE.Mesh(new THREE.CylinderGeometry(stanchionRadius, stanchionRadius, stanchionH, 16), chromeMat);
    stanchionL.position.set(-2.7, stanchionH / 2, 0);
    const basePlateL = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.04, 16), steelMat);
    basePlateL.position.set(-2.7, 0.97, 0);

    // Right vertical support stanchion column firmly anchored to counter
    const stanchionR = new THREE.Mesh(new THREE.CylinderGeometry(stanchionRadius, stanchionRadius, stanchionH, 16), chromeMat);
    stanchionR.position.set(2.7, stanchionH / 2, 0);
    const basePlateR = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.04, 16), steelMat);
    basePlateR.position.set(2.7, 0.97, 0);

    // Dual horizontal bridge structural truss crossbeams spanning between columns
    const trussTop = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 5.4, 16), chromeMat);
    trussTop.rotation.z = Math.PI / 2;
    trussTop.position.set(0, 3.65, 0);

    const trussBot = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 5.4, 16), chromeMat);
    trussBot.rotation.z = Math.PI / 2;
    trussBot.position.set(0, 2.75, 0);

    // Heavy vertical sign mounting hanger drop brackets
    const bracketL = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.95, 0.08), steelMat);
    bracketL.position.set(-1.4, 3.2, 0);
    const bracketR = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.95, 0.08), steelMat);
    bracketR.position.set(1.4, 3.2, 0);

    // 10. DUAL-SIDED ILLUMINATED LANE 1 LIGHTBOX SIGN
    const signW = 3.6, signH = 0.85, signD = 0.18;
    const signBody = new THREE.Mesh(new THREE.BoxGeometry(signW, signH, signD), cabinetAccentMat);
    signBody.position.set(0, 3.2, 0);

    // Sign Face Graphics Texture
    const signTex = (() => {
        const c = document.createElement('canvas');
        c.width = 1024; c.height = 256;
        const ctx = c.getContext('2d');
        // Dark blue-to-navy background
        const grad = ctx.createLinearGradient(0, 0, 0, 256);
        grad.addColorStop(0, '#1e3a8a');
        grad.addColorStop(1, '#0f172a');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 1024, 256);

        // Gold border frame
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 8;
        ctx.strokeRect(8, 8, 1008, 240);

        // Top MagMart ribbon
        ctx.fillStyle = '#dc2626';
        ctx.fillRect(16, 16, 992, 44);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 26px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('★ MAGMART EXPRESS ★', 512, 46);

        // Bold Lane 1 Header with Green Open Indicator
        ctx.fillStyle = '#22c55e';
        ctx.beginPath(); ctx.arc(220, 120, 22, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = '900 64px "Arial Black", sans-serif';
        ctx.fillText('LANE 1', 370, 142);

        // Main Checkout Text
        ctx.fillStyle = '#fde047';
        ctx.font = '900 60px "Arial Black", sans-serif';
        ctx.fillText('CHECKOUT', 710, 142);

        // Payment Sub-banner
        ctx.fillStyle = '#38bdf8';
        ctx.font = 'bold 22px sans-serif';
        ctx.fillText('CHIP & PIN  •  CONTACTLESS / NFC  •  APPLE PAY  •  CASH', 512, 215);

        const t = new THREE.CanvasTexture(c);
        t.colorSpace = THREE.SRGBColorSpace;
        return t;
    })();

    const signFaceMat = new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.25, metalness: 0.1 });
    const signFaceFront = new THREE.Mesh(new THREE.PlaneGeometry(signW - 0.04, signH - 0.04), signFaceMat);
    signFaceFront.position.set(0, 3.2, signD / 2 + 0.002);
    const signFaceBack = new THREE.Mesh(new THREE.PlaneGeometry(signW - 0.04, signH - 0.04), signFaceMat);
    signFaceBack.rotation.y = Math.PI;
    signFaceBack.position.set(0, 3.2, -signD / 2 - 0.002);

    // Glowing Green "LANE OPEN" Beacon Lantern on top of sign
    const beaconBase = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.10, 16), steelMat);
    beaconBase.position.set(0, 3.65 + signH / 2 + 0.05, 0);
    const beaconLantern = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.24, 16), laneOpenMat);
    beaconLantern.position.set(0, 3.65 + signH / 2 + 0.20, 0);
    const beaconDome = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), laneOpenMat);
    beaconDome.position.set(0, 3.65 + signH / 2 + 0.32, 0);

    // Under-sign downlight spot fixtures
    [-1.0, 1.0].forEach(sx => {
        const spotHousing = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.06, 0.06, 12), steelMat);
        spotHousing.position.set(sx, 3.2 - signH / 2 - 0.03, 0);
        const spotLens = new THREE.Mesh(new THREE.CircleGeometry(0.05, 12), new THREE.MeshBasicMaterial({ color: 0xfffbeb }));
        spotLens.rotation.x = Math.PI / 2;
        spotLens.position.set(sx, 3.2 - signH / 2 - 0.061, 0);
        gantryGroup.add(spotHousing, spotLens);
    });

    gantryGroup.add(
        stanchionL, basePlateL, stanchionR, basePlateR,
        trussTop, trussBot, bracketL, bracketR,
        signBody, signFaceFront, signFaceBack,
        beaconBase, beaconLantern, beaconDome
    );
    counterGroup.add(gantryGroup);

    // Position the complete checkout lane in the front store plaza
    counterGroup.position.set(15, 0, -15);
    scene.add(counterGroup);
    checkout = counterGroup;
    registerCullableObject(counterGroup, 7.5);

    // Add compound physics body for checkout counter
    const checkoutShape = new CANNON.Box(new CANNON.Vec3(3.1, 0.55, 0.95));
    const checkoutBody = new CANNON.Body({
        mass: 0,
        shape: checkoutShape
    });
    checkoutBody.position.set(15, 0.55, -15);
    checkoutBody.collisionFilterGroup = 2;
    checkoutBody.collisionFilterMask = 1 | 4 | 8;
    world.addBody(checkoutBody);

    // Add checkout button with probability
    const chance = CONFIG.CHECKOUT_BUTTON_REQUIRED_CHANCE;
    const normalizedChance = chance > 1 ? chance / 100 : chance;
    const boosted = plus0_05Fraction(normalizedChance);
    if (Math.random() < boosted) {
        checkoutButtonRequired = true;
        checkoutButtonAlertShown = false;
        createCheckoutButton(counterGroup);
    } else {
        checkoutButtonRequired = false;
        checkoutButtonAlertShown = false;
    }
}

function createCheckoutButton(counterGroup) {
    // Architectural Call Button Console on front corner of counter
    const buttonGroup = new THREE.Group();
    
    // Angled metallic mounting plate
    const baseGeometry = new THREE.BoxGeometry(0.48, 0.08, 0.48);
    const baseMaterial = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.35, metalness: 0.8 });
    const base = new THREE.Mesh(baseGeometry, baseMaterial);
    buttonGroup.add(base);

    // Chrome beveled bezel ring
    const bezel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.18, 0.20, 0.04, 24),
        new THREE.MeshStandardMaterial({ color: 0xd1d5db, roughness: 0.15, metalness: 0.9 })
    );
    bezel.position.y = 0.05;
    buttonGroup.add(bezel);
    
    // Large glowing emerald activation button
    const buttonGeometry = new THREE.CylinderGeometry(0.14, 0.14, 0.06, 24);
    const buttonMaterial = new THREE.MeshStandardMaterial({ 
        color: 0x22c55e,
        emissive: 0x16a34a,
        emissiveIntensity: 0.6,
        roughness: 0.2
    });
    const button = new THREE.Mesh(buttonGeometry, buttonMaterial);
    button.position.y = 0.09;
    buttonGroup.add(button);

    // Engraved label plate on console
    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = 256; labelCanvas.height = 64;
    const lctx = labelCanvas.getContext('2d');
    lctx.fillStyle = '#0f172a'; lctx.fillRect(0, 0, 256, 64);
    lctx.fillStyle = '#22c55e'; lctx.font = 'bold 22px sans-serif';
    lctx.textAlign = 'center'; lctx.fillText('PRESS TO ACTIVATE', 128, 40);
    const labelTex = new THREE.CanvasTexture(labelCanvas);
    const labelMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.40, 0.10), new THREE.MeshBasicMaterial({ map: labelTex }));
    labelMesh.rotation.x = -Math.PI / 2;
    labelMesh.position.set(0, 0.045, 0.16);
    buttonGroup.add(labelMesh);
    
    // Position the button on the front counter deck
    buttonGroup.position.set(2.4, 0.98, 0.65);
    counterGroup.add(buttonGroup);
    
    // Add physics for button interaction
    const buttonShape = new CANNON.Cylinder(0.2, 0.2, 0.15, 16);
    const buttonBody = new CANNON.Body({
        mass: 0,
        position: new CANNON.Vec3(
            counterGroup.position.x + 2.4,
            counterGroup.position.y + 1.05,
            counterGroup.position.z + 0.65
        ),
        shape: buttonShape
    });
    buttonBody.collisionFilterGroup = 4;
    buttonBody.collisionFilterMask = 1;
    world.addBody(buttonBody);
    
    // Store button data
    checkoutButton = {
        mesh: buttonGroup,
        body: buttonBody,
        pressed: false
    };
}

// Helper to create a display mesh for an item
function createStaticItemMesh(name) {
    const template = (ACTIVE_ITEMS && ACTIVE_ITEMS.find(it => it.name === name)) || (BASE_ITEMS && BASE_ITEMS[0]);
    if (template && typeof template.createModel === 'function') {
        const rawModel = template.createModel();
        const wrapper = new THREE.Group();
        wrapper.add(rawModel);
        const bbox = new THREE.Box3().setFromObject(rawModel);
        if (!bbox.isEmpty()) {
            const bCenter = new THREE.Vector3();
            bbox.getCenter(bCenter);
            rawModel.position.sub(bCenter);
        }
        wrapper.scale.set(0.65, 0.65, 0.65);
        return wrapper;
    }
    const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.3, 0.3, 0.3),
        new THREE.MeshStandardMaterial({ color: template?.color || 0xef4444, roughness: 0.5 })
    );
    return mesh;
}

// World-based busy checkout event: NPC customer scans items physically at the register, then leaves holding the item
function startWorldBusyCheckout() {
    endBusyCheckoutIfActive();

    checkoutBusyActive = true;
    checkoutBusyOccurred = true;
    checkoutExitCooldownUntil = Date.now() + 6500;
    displayMessage("🧾 Register is busy! A customer is scanning an item.", 4000, true);

    // Create a store customer using the exact same customer model and system
    const cust = createCustomer();
    if (!cust) {
        checkoutBusyActive = false;
        return;
    }

    // Position customer facing the register conveyor
    const registerX = 14.8;
    const registerZ = -13.8;
    cust.position.set(registerX, 0, registerZ);
    if (cust.body) {
        cust.body.position.set(registerX, 0.95, registerZ);
        cust.body.velocity.set(0, 0, 0);
    }
    cust.rotation.y = Math.PI;
    cust.behaviorState = 'busy_checkout_scanning';
    cust.itemsGathered = 1;
    cust.role = 'regular_shopper';
    checkoutBusyCustomer = cust;

    // Place an item on the scanner conveyor belt
    const candidates = ['Cereal', 'Milk', 'Bread', 'Soda', 'Apples', 'Pasta Sauce'];
    const itemName = candidates[Math.floor(Math.random() * candidates.length)];
    const itemMesh = createStaticItemMesh(itemName);
    itemMesh.position.set(14.5, 1.05, -14.7);
    scene.add(itemMesh);
    checkoutBusyItemMesh = itemMesh;

    // Scanning sound beeps during the wait
    setTimeout(() => {
        if (!checkoutBusyActive) return;
        try { soundEffects.checkoutScan.currentTime = 0; soundEffects.checkoutScan.play().catch(() => {}); } catch(_) {}
    }, 1200);

    setTimeout(() => {
        if (!checkoutBusyActive) return;
        try { soundEffects.checkoutScan.currentTime = 0; soundEffects.checkoutScan.play().catch(() => {}); } catch(_) {}
    }, 2500);

    // Customer completes scanning after 4.5 seconds
    if (checkoutBusyTimerId) clearTimeout(checkoutBusyTimerId);
    checkoutBusyTimerId = setTimeout(() => {
        checkoutBusyActive = false;

        // Cash register chime
        try { soundEffects.cashRegister.currentTime = 0; soundEffects.cashRegister.play().catch(() => {}); } catch(_) {}

        // Customer picks up and holds item in hand
        if (checkoutBusyItemMesh) {
            if (checkoutBusyItemMesh.parent) checkoutBusyItemMesh.parent.remove(checkoutBusyItemMesh);
            if (cust && cust.parent) {
                cust.handItem = { mesh: checkoutBusyItemMesh, name: itemName };
                cust.add(checkoutBusyItemMesh);
                checkoutBusyItemMesh.position.set(0, 1.0, 0.35);
                checkoutBusyItemMesh.rotation.set(0, Math.PI / 12, 0);
            }
            checkoutBusyItemMesh = null;
        }

        // Customer walks out of the store to their car holding the item
        if (cust) {
            cust.behaviorState = 'navigating';
            setCustomerTarget(cust, 'leaving_store');
        }

        displayMessage("The customer finished and left. The register is now free!", 3000, true);
    }, 4500);
}

function startBusyCheckoutCountdown() {
    startWorldBusyCheckout();
}

function spawnBusyCustomerAndItem() {
    // Deprecated by startWorldBusyCheckout
}

function endBusyCheckoutIfActive() {
    if (checkoutBusyInterval) {
        clearInterval(checkoutBusyInterval);
        checkoutBusyInterval = null;
    }
    if (checkoutBusyTimerId) {
        clearTimeout(checkoutBusyTimerId);
        checkoutBusyTimerId = null;
    }
    checkoutBusyActive = false;
    checkoutBusyCountdown = 0;

    if (checkoutBusyBanner) {
        checkoutBusyBanner.classList.add('hidden');
        checkoutBusyBanner.classList.remove('visible');
    }

    if (checkoutBusyItemMesh) {
        if (checkoutBusyItemMesh.parent) checkoutBusyItemMesh.parent.remove(checkoutBusyItemMesh);
        checkoutBusyItemMesh = null;
    }

    if (checkoutBusyCustomer) {
        if (checkoutBusyCustomer.behaviorState === 'busy_checkout_scanning') {
            setCustomerTarget(checkoutBusyCustomer, 'leaving_store');
        }
        checkoutBusyCustomer = null;
    }
}

// ---------------- INTRO CUTSCENE & SPAWN SYSTEM ----------------
const INTRO_STORAGE_KEY = 'magmart_intro_played_v1';
let introCutsceneActive = false;
let introCutsceneStartTime = 0;
const INTRO_CUTSCENE_DURATION = 4200; // 4.2 seconds
let introCutsceneOverlayEl = null;

function shouldPlayIntroCutscene() {
    try {
        return localStorage.getItem(INTRO_STORAGE_KEY) !== 'true';
    } catch (_) {
        return false;
    }
}

function showIntroCutsceneUI() {
    hideIntroCutsceneUI();
    const overlay = document.createElement('div');
    overlay.id = 'intro-cutscene-overlay';
    overlay.innerHTML = `
        <div class="cutscene-letterbox-top"></div>
        <div class="cutscene-footer">
            <div class="cutscene-skip-prompt" id="cutscene-skip-btn">
                [Space / Click to Skip Intro]
            </div>
        </div>
        <div class="cutscene-letterbox-bottom"></div>
    `;
    document.getElementById('game-container').appendChild(overlay);
    introCutsceneOverlayEl = overlay;

    const skipBtn = document.getElementById('cutscene-skip-btn');
    if (skipBtn) {
        skipBtn.onclick = (e) => {
            e.stopPropagation();
            finishIntroCutscene(true);
        };
    }
}

function hideIntroCutsceneUI() {
    if (introCutsceneOverlayEl) {
        introCutsceneOverlayEl.remove();
        introCutsceneOverlayEl = null;
    }
    const existing = document.getElementById('intro-cutscene-overlay');
    if (existing) existing.remove();
}

function startIntroCutscene() {
    introCutsceneActive = true;
    introCutsceneStartTime = performance.now();

    // Hide shopping list during intro walk
    const listEl = document.getElementById('shopping-list');
    if (listEl) {
        listEl.classList.add('intro-hidden');
        listEl.classList.remove('pop-down-entry');
    }

    // Position player outside the front entrance doors on the promenade approach
    if (playerBody) {
        playerBody.position.set(0, 1.0, -42.0);
        playerBody.velocity.set(0, 0, 0);
    }
    if (camera) {
        camera.position.set(0, 2.6, -42.0);
        camera.rotation.set(0, Math.PI, 0); // facing +Z towards magmart entrance doors
    }

    // Hide cart initially during approach
    if (cartObject) {
        cartObject.visible = false;
    }
    cartAttached = false;

    showIntroCutsceneUI();
}

function finishIntroCutscene(skipped = false) {
    if (!introCutsceneActive) return;
    introCutsceneActive = false;

    try {
        localStorage.setItem(INTRO_STORAGE_KEY, 'true');
    } catch (_) {}

    hideIntroCutsceneUI();

    // Reveal shopping list with pop-down animation
    const listEl = document.getElementById('shopping-list');
    if (listEl) {
        listEl.classList.remove('intro-hidden');
        listEl.classList.add('pop-down-entry');
    }

    // Ensure player is at the door facing the back of the store
    if (playerBody) {
        playerBody.position.set(0, 1.0, -26.0);
        playerBody.velocity.set(0, 0, 0);
    }
    if (camera) {
        camera.position.set(0, 2.6, -26.0);
        camera.rotation.set(0, Math.PI, 0);
        syncCameraAngles(Math.PI, 0);
    }

    // Give the cart to the player
    if (cartObject) {
        cartObject.visible = true;
        cartObject.position.set(0, 0, -24.5);
        cartObject.rotation.set(0, 0, 0);
    }
    cartAttached = true;

    // Welcome chime sound
    try {
        if (sfxAttentionCustomers) {
            sfxAttentionCustomers.currentTime = 0;
            sfxAttentionCustomers.play();
        } else if (soundEffects && soundEffects.attentionCustomers) {
            soundEffects.attentionCustomers.currentTime = 0;
            soundEffects.attentionCustomers.play();
        }
    } catch (_) {}

    displayMessage("Welcome to MagMart! Your cart is ready.", 3200);

    // Lock controls for normal play
    if (controls && !controls.isLocked) {
        try { controls.lock(); } catch (_) {}
    }
}

function createPlayer() {
    const isIntro = shouldPlayIntroCutscene();
    const spawnZ = isIntro ? -42.0 : -26.0;

    // Create player physics body
    const playerShape = new CANNON.Sphere(0.5);
    playerBody = new CANNON.Body({
        mass: 75,
        position: new CANNON.Vec3(0, 1, spawnZ),
        shape: playerShape,
        material: new CANNON.Material('playerMaterial'),
        allowSleep: false
    });
    playerBody.allowSleep = false;
    world.addBody(playerBody);

    // Create player visual representation (invisible in first person)
    playerObject = new THREE.Group();
    scene.add(playerObject);

    // Create player arm
    arm = new THREE.Group();
    camera.add(arm);

    const upperArmGeometry = new THREE.CylinderGeometry(0.1, 0.1, 0.5);
    const armMaterial = new THREE.MeshStandardMaterial({ color: 0xFFCC99 });
    const upperArm = new THREE.Mesh(upperArmGeometry, armMaterial);
    upperArm.position.set(0.3, -0.3, -0.2);
    upperArm.rotation.set(0, 0, -Math.PI / 4);
    arm.add(upperArm);

    const lowerArmGeometry = new THREE.CylinderGeometry(0.08, 0.1, 0.5);
    const lowerArm = new THREE.Mesh(lowerArmGeometry, armMaterial);
    lowerArm.position.set(0.6, -0.6, -0.2);
    lowerArm.rotation.set(0, 0, -Math.PI / 4);
    arm.add(lowerArm);

    // Create hand
    hand = new THREE.Group();
    hand.position.set(0.9, -0.9, -0.2);
    arm.add(hand);

    const handGeometry = new THREE.SphereGeometry(0.12, 16, 16);
    const handMesh = new THREE.Mesh(handGeometry, armMaterial);
    hand.add(handMesh);

    // Initial camera setup facing +Z (back of store)
    camera.position.set(0, 2.6, spawnZ);
    camera.rotation.set(0, Math.PI, 0);

    // Create shopping cart - positioned in front of player
    createShoppingCart();

    if (!isIntro) {
        cartObject.position.set(0, 0, -24.5);
        cartObject.rotation.set(0, 0, 0);
        cartObject.visible = true;
        cartAttached = true;
    } else {
        cartObject.visible = false;
        cartAttached = false;
    }

    // Camera Flashlight for Lonely Store mode
    if (camera) {
        if (playerFlashlight && playerFlashlight.parent) {
            playerFlashlight.parent.remove(playerFlashlight);
        }
        playerFlashlight = null;

        if (isLonelyStoreMode) {
            playerFlashlight = new THREE.SpotLight(0xfff3d6, 6.0, 32, Math.PI / 5.5, 0.45, 1.2);
            playerFlashlight.position.set(0.12, -0.15, 0.1);
            const tObj = new THREE.Object3D();
            tObj.position.set(0, 0, -10);
            camera.add(playerFlashlight);
            camera.add(tObj);
            playerFlashlight.target = tObj;
        }
    }

    // Spawn Creepy Stalker entity if in Lonely Store mode
    if (lonelyStoreStalker && lonelyStoreStalker.parent) {
        lonelyStoreStalker.parent.remove(lonelyStoreStalker);
    }
    lonelyStoreStalker = null;

    if (isLonelyStoreMode) {
        lonelyStoreStalker = createStalker();
        lonelyStoreStalker.position.set(16, 0, 16);
        scene.add(lonelyStoreStalker);
    }
}

CartPhys.initCartPhysics({
    getWorld: () => world,
    getCart3D: () => cart3D,
    getCartObject: () => cartObject,
    getAllItems: () => allItems,
    getCollectedItems: () => collectedItems,
    getHeldItem: () => heldItem,
    getCartBaby: () => cartBaby,
    isItemDropping: (item) => cartDroppingItems.some(anim => anim.item === item),
    massOf: (item) => itemPhysicsMass(item),
    gravity: CONFIG.GRAVITY || 9.8,
    ignoredBodies: () => autoDoors ? [autoDoors.leftBody, autoDoors.rightBody] : [],
    onCatch: (item, localPos, localQuat, localVel) => {
        const fromScuffle = customerScuffleProjectiles.some(p => p.item === item);
        catchItemInCart(item, localPos, localQuat, localVel);
        if (fromScuffle) displayMessage(`💥 A flying ${item.name} landed in your cart!`, 2400, true);
    },
    onBump: (strength) => {
        try {
            if (!soundEffects.cartAdd) return;
            const bump = soundEffects.cartAdd.cloneNode();
            bump.volume = Math.min(1, soundEffects.cartAdd.volume * (0.35 + 0.65 * strength));
            bump.play().catch(() => {});
        } catch (_) {}
    },
});

function createShoppingCart() {
    // Create a cart that stays in front of the player
    cartObject = new THREE.Group();
    scene.add(cartObject);

    cart3D = buildWireCartGroup(CONFIG.CART_COLOR || 0xD32F2F, equippedCartSkin(), CartPhys.CART_SCALE);
    cartObject.add(cart3D);
    cartObject.position.set(0, 0, -24.5);
    createPlayerCartHands();

    const babyChance = Number(CONFIG.BABY_IN_CART_CHANCE ?? 7);
    if (!isLonelyStoreMode && Math.random() * 100 < babyChance) {
        createCartBaby();
    }
}

function createPlayerCartHands() {
    const visual = cart3D.userData.visual;
    const geometry = cachedItemAsset('cartHandGeo', () => new THREE.SphereGeometry(1, 10, 6));
    const material = cachedItemAsset('cartHandMaterial', () => new THREE.MeshStandardMaterial({ color: 0xffd1a4, roughness: 0.8 }));
    const left = new THREE.Mesh(geometry, material);
    const right = new THREE.Mesh(geometry, material);
    // Cart faces +Z: from behind its handle, +X is the player's left.
    left.position.set(0.25, 0.985, -0.73);
    right.position.set(-0.25, 0.985, -0.73);
    left.scale.set(0.075, 0.048, 0.085);
    right.scale.copy(left.scale);
    left.raycast = right.raycast = () => {};
    visual.add(left, right);
    cart3D.userData.playerHands = { left, right };
    updatePlayerCartHands();
}

function updatePlayerCartHands() {
    const hands = cart3D?.userData.playerHands;
    if (!hands) return;
    const gripping = gameStarted && !gameOver && !isCheckout && cartAttached && !cartFlingActive;
    const slapping = slapActive && !!slapHand;
    hands.left.visible = gripping && !(slapping && slapHand.userData.fromLeft);
    hands.right.visible = gripping && !(slapping && !slapHand.userData.fromLeft);
}

function createCartBaby() {
    if (!cart3D || cartBaby) return;
    cartBabyIsGood = Math.random() < 0.5;
    cartBabyActionLimit = 1 + Math.floor(Math.random() * 2);
    cartBabyActionCount = 0;

    const baby = new THREE.Group();
    baby.position.set(0, CartPhys.CART_BABY_LIFT, 0.05);
    cart3D.add(baby);
    cartBaby = baby;

    const skinMat = new THREE.MeshStandardMaterial({ color: 0xf4c9a8, roughness: 0.82 });
    const shirtMat = new THREE.MeshStandardMaterial({ color: 0x7fc9d6, roughness: 0.72 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0xf7c96c, roughness: 0.68 });
    const pantsMat = new THREE.MeshStandardMaterial({ color: 0x596b9b, roughness: 0.78 });
    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 });
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x28242a, roughness: 0.38 });
    const pacifierMat = new THREE.MeshStandardMaterial({ color: 0xf08d9c, roughness: 0.4 });

    const addSphere = (parent, material, radius, position, scale = [1, 1, 1], segments = 14) => {
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, segments, segments), material);
        mesh.position.set(position[0], position[1], position[2]);
        mesh.scale.set(scale[0], scale[1], scale[2]);
        mesh.castShadow = true;
        parent.add(mesh);
        return mesh;
    };

    // A little seated customer with simple rounded tube legs.
    const body = addSphere(baby, shirtMat, 0.19, [0, 0.66, 0.03], [0.86, 0.82, 0.76], 18);
    body.rotation.x = -0.12;
    addSphere(baby, trimMat, 0.11, [0, 0.73, -0.09], [0.92, 0.5, 0.28], 14);

    for (const side of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.21, 4, 8), pantsMat);
        leg.position.set(side * 0.095, 0.48, -0.14);
        leg.rotation.x = 0.95;
        baby.add(leg);
    }

    cartBabyHead = new THREE.Group();
    cartBabyHead.position.set(0, 0.98, 0.015);
    baby.add(cartBabyHead);
    addSphere(cartBabyHead, skinMat, 0.205, [0, 0, 0], [0.96, 1.02, 0.88], 20);

    for (const side of [-1, 1]) {
        addSphere(cartBabyHead, skinMat, 0.055, [side * 0.184, -0.005, 0.012], [0.68, 0.9, 0.72], 12);
        addSphere(cartBabyHead, whiteMat, 0.032, [side * 0.071, 0.022, -0.158], [1, 1, 0.65], 12);
        addSphere(cartBabyHead, eyeMat, 0.017, [side * 0.071, 0.019, -0.181], [1, 1, 0.65], 10);
    }
    addSphere(cartBabyHead, skinMat, 0.027, [0, -0.035, -0.177], [0.86, 0.76, 0.76], 10);

    // Pacifier shield, stem and button move gently to create a sucking motion.
    cartBabyPacifier = new THREE.Group();
    cartBabyPacifier.position.set(0, -0.082, -0.181);
    cartBabyHead.add(cartBabyPacifier);
    addSphere(cartBabyPacifier, pacifierMat, 0.052, [0, 0, -0.024], [1.05, 0.76, 0.34], 14);
    addSphere(cartBabyPacifier, pacifierMat, 0.027, [0, -0.002, -0.048], [0.55, 0.58, 0.72], 12);
    addSphere(cartBabyPacifier, whiteMat, 0.009, [0, 0, -0.066], [1, 1, 0.7], 8);

}

function getCartBabyItemCandidates() {
    const stock = allItems.filter(item =>
        item &&
        item !== heldItem &&
        item.isStatic &&
        !item.inCart &&
        !item.inCustomerCart &&
        !item.isCustomerHeld &&
        !item.stolen &&
        !item.outOfStock &&
        !item.isTwoInOne &&
        item.name !== 'Gum' &&
        !item.isCheckoutGum &&
        item.mesh?.parent &&
        item.mesh.visible !== false
    );

    if (cartBabyIsGood) {
        return stock.filter(item =>
            !outOfStockListItems.includes(item.name) &&
            shoppingList.some(entry => entry.name === item.name && entry.collected < entry.quantity)
        );
    }
    return stock.filter(item => !shoppingList.some(entry => entry.name === item.name));
}

function startCartBabyActionSchedule(delay = 18000 + Math.random() * 12000) {
    if (purchaseComplete || !cartBaby || cartBabyActionTimerId || cartBabyActionCount >= cartBabyActionLimit) return;
    cartBabyActionTimerId = setTimeout(() => {
        cartBabyActionTimerId = null;
        if (!gameStarted || gameOver || !cartBaby) return;
        if (gamePaused || introCutsceneActive || isCheckout) {
            startCartBabyActionSchedule(5000 + Math.random() * 5000);
            return;
        }
        const candidates = getCartBabyItemCandidates();
        if (!candidates.length) {
            startCartBabyActionSchedule(15000 + Math.random() * 10000);
            return;
        }
        cartBabyAction = {
            item: candidates[Math.floor(Math.random() * candidates.length)],
            elapsed: 0,
            launched: false,
            duration: 0.8
        };
    }, delay);
}

function launchCartBabyItem(item) {
    if (!cartBaby || !cart3D || !item?.mesh?.parent || !getCartBabyItemCandidates().includes(item)) return false;

    const worldPos = item.mesh.getWorldPosition(new THREE.Vector3());
    const worldQuat = item.mesh.getWorldQuaternion(new THREE.Quaternion());
    item.mesh.removeFromParent();
    cart3D.add(item.mesh);
    item.mesh.position.copy(cart3D.worldToLocal(worldPos));
    const cartWorldQuat = cart3D.getWorldQuaternion(new THREE.Quaternion());
    item.mesh.quaternion.copy(cartWorldQuat.invert().multiply(worldQuat));

    if (item.body) {
        try { world.removeBody(item.body); } catch (_) {}
        item.body = null;
    }
    item.isStatic = false;

    const B = CartPhys.CART_BASKET;
    const restQuat = CartPhys.cartRestingQuat(item);
    const targetPos = CartPhys.cartDropPoint(item, (Math.random() - 0.5) * B.halfW * 1.2, (Math.random() - 0.5) * B.halfL * 1.2, undefined, restQuat);

    cartDroppingItems.push({
        item,
        startPos: item.mesh.position.clone(),
        targetPos,
        startRot: item.mesh.rotation.clone(),
        targetRot: new THREE.Euler().setFromQuaternion(restQuat),
        duration: 0.5,
        elapsed: 0,
        arcHeight: 0.18,
        babyGrabbed: true
    });

    cartBabyActionCount++;
    if (cartBabyActionCount < cartBabyActionLimit) {
        startCartBabyActionSchedule(25000 + Math.random() * 15000);
    }
    return true;
}

function updateCartBabyAnimation(now, delta) {
    if (!cartBaby) return;
    const suck = Math.sin(now * 0.012);
    if (cartBabyPacifier) {
        cartBabyPacifier.position.y = -0.082 + suck * 0.009;
        cartBabyPacifier.position.z = -0.181 + Math.abs(suck) * 0.006;
    }
    if (cartBabyHead) {
        cartBabyHead.rotation.x = Math.sin(now * 0.0035) * 0.018;
        cartBabyHead.rotation.z = Math.sin(now * 0.0028) * 0.012;
    }

    if (!cartBabyAction || gamePaused || introCutsceneActive || isCheckout || gameOver) {
        cartBaby.rotation.x = 0;
        cartBaby.position.y = 0;
        return;
    }

    cartBabyAction.elapsed += delta;
    const progress = Math.min(1, cartBabyAction.elapsed / cartBabyAction.duration);
    const reach = Math.sin(progress * Math.PI);
    cartBaby.rotation.x = -reach * 0.14;
    cartBaby.position.y = reach * 0.035;

    if (!cartBabyAction.launched && progress >= 0.3) {
        cartBabyAction.launched = true;
        const available = getCartBabyItemCandidates();
        const item = available.includes(cartBabyAction.item)
            ? cartBabyAction.item
            : available[Math.floor(Math.random() * available.length)];
        if (!launchCartBabyItem(item)) {
            cartBabyAction.item = null;
        }
    }
    if (progress >= 1) {
        const shouldRetry = !cartBabyAction.item;
        cartBabyAction = null;
        cartBaby.rotation.set(0, 0, 0);
        cartBaby.position.y = 0;
        if (shouldRetry) startCartBabyActionSchedule(15000 + Math.random() * 10000);
    }
}

function generateShoppingList() {
    // Clear previous shopping list
    shoppingList = [];
    outOfStockListItems = [];
    singleItemList = false; // Reset single item list flag

    if (isLonelyStoreMode) {
        shoppingList = [
            { name: "Shredder", quantity: 1, collected: 0 },
            { name: "Cleaning supplies", quantity: 1, collected: 0 },
            { name: "spinning top", quantity: 1, collected: 0 }
        ];
        updateShoppingListDisplay();
        return;
    }

    const availablePool = ITEMS.filter(item => item && item.name !== 'Gum');

    if (Math.random() * 100 < CONFIG.SINGLE_ITEM_LIST_CHANCE && availablePool.length > 0) {
        singleItemList = true;
        // Single item list with quantity 12
        const itemIndex = Math.floor(Math.random() * availablePool.length);
        const item = availablePool[itemIndex];
        shoppingList.push({
            name: item.name,
            quantity: 12,
            collected: 0
        });
    } else {
        // Custom games can opt into vanilla's 8–10 item roll.
        const maxAvailable = availablePool.length;
        const itemCount = ((isCustomGame && !CONFIG.CUSTOM_RANDOM_ITEMS) || CONFIG.MIN_SHOPPING_LIST_ITEMS === CONFIG.MAX_SHOPPING_LIST_ITEMS)
            ? Math.min(maxAvailable, CONFIG.MAX_SHOPPING_LIST_ITEMS) 
            : Math.min(maxAvailable, Math.floor(
                Math.random() * 
                (CONFIG.MAX_SHOPPING_LIST_ITEMS - CONFIG.MIN_SHOPPING_LIST_ITEMS + 1) + 
                CONFIG.MIN_SHOPPING_LIST_ITEMS
            ));

        // Shuffle items and select
        const shuffledItems = [...availablePool];
        shuffleArray(shuffledItems);

        // Create shopping list with quantities
        for (let i = 0; i < itemCount; i++) {
            const item = shuffledItems[i];
            if (item) {
                // Determine random quantity based on item's allowed range
                const minQty = item.quantity ? item.quantity[0] : 1;
                const maxQty = item.quantity ? item.quantity[1] : 1;
                const quantity = Math.floor(Math.random() * (maxQty - minQty + 1)) + minQty;

                shoppingList.push({
                    name: item.name,
                    quantity: quantity,
                    collected: 0
                });
            }
        }
    }

    // Display shopping list
    updateShoppingListDisplay();
}

function updateShoppingListDisplay() {
    const sqOn = SQ.sideQuestsEnabled();
    if (!sqOn) activeListPage = 'grocery';
    shoppingListElement.classList.toggle('other-page', activeListPage === 'other');
    const tabs = sqOn
        ? `<div class="list-tabs"><span class="${activeListPage === 'grocery' ? 'on' : ''}">1 Grocery</span><span class="${activeListPage === 'other' ? 'on' : ''}">2 Other</span></div>`
        : '';
    if (activeListPage === 'other') {
        shoppingListElement.innerHTML = SQ.renderOtherTasksHtml() + tabs;
        return;
    }
    shoppingListElement.innerHTML = '<h3>🛒 Grocery List</h3>' + (paidListSnapshot ? '<div class="paid-stamp">PAID</div>' : '');
    (paidListSnapshot || shoppingList).forEach(item => {
        const soldOut = outOfStockListItems.includes(item.name) && item.collected < item.quantity;
        const collected = item.collected >= item.quantity || soldOut || !!paidListSnapshot;
        const itemElement = document.createElement('div');
        itemElement.className = `list-item ${collected ? 'collected' : ''}`;
        itemElement.innerHTML = `
            <span><span class="list-check">${collected ? '✓' : ''}</span>${item.name} x${item.quantity}</span>
            <span>${soldOut ? 'SOLD OUT' : `(${item.collected}/${item.quantity})`}</span>
        `;
        shoppingListElement.appendChild(itemElement);
    });
    if (tabs) shoppingListElement.insertAdjacentHTML('beforeend', tabs);
}

// Lag-Resistant Smooth Camera Engine
let smoothMouseMoveHandler = null;
let cameraTargetYaw = Math.PI;
let cameraTargetPitch = 0;
let cameraCurrentYaw = Math.PI;
let cameraCurrentPitch = 0;

function syncCameraAngles(yaw = (camera ? camera.rotation.y : Math.PI), pitch = (camera ? camera.rotation.x : 0)) {
    cameraTargetYaw = yaw;
    cameraTargetPitch = pitch;
    cameraCurrentYaw = yaw;
    cameraCurrentPitch = pitch;
}

// Browsers often report one huge bogus movement right after pointer lock is
// (re)acquired, which snapped the view when closing a popup. Ignore it.
let pointerLockAcquiredAt = 0;
document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement) pointerLockAcquiredAt = performance.now();
});

function handleSmoothMouseMove(event) {
    if (!controls || !controls.isLocked || isCheckout || gamePaused || isUiPopupOpen()) return;
    
    const sens = typeof CONFIG.LOOK_SENSITIVITY === 'number' ? CONFIG.LOOK_SENSITIVITY : 1.0;
    const rawX = event.movementX || event.mozMovementX || event.webkitMovementX || 0;
    const rawY = event.movementY || event.mozMovementY || event.webkitMovementY || 0;
    if (performance.now() - pointerLockAcquiredAt < 120 || Math.abs(rawX) > 400 || Math.abs(rawY) > 400) return;
    
    // Amnesia: The Dark Descent Physical Door Dragging
    if (activeGrabbedDoor) {
        doorDragMoved = true;
        const hingeSign = activeGrabbedDoor.hingeSign || 1;
        const dirMultiplier = activeGrabbedDoor.shelfDirection || 1;
        
        // Keep the mouse gesture stable while the visual hinge swings outward.
        // The visual hinge sign is intentionally inverted here because the
        // previous hinge fix changes the rotation direction, not the expected
        // screen-space drag direction.
        const pullAmount = (rawY * 0.75 + rawX * hingeSign * dirMultiplier * 0.65);
        
        // Randomized Heaviness Difficulty (-30% light to +75% heavy)
        const difficulty = activeGrabbedDoor.heavinessDifficulty || 0;
        // Higher difficulty -> greater resistance -> slower, heavier actuation
        const difficultyFactor = 1.0 / (1.0 + Math.max(-0.28, difficulty) * 2.2);
        
        // Magnetic vacuum seal suction check
        if (activeGrabbedDoor.isSealed && activeGrabbedDoor.currentAngle < 0.05) {
            if (pullAmount > 0) {
                activeGrabbedDoor.sealTension = (activeGrabbedDoor.sealTension || 0) + pullAmount * difficultyFactor;
                const requiredSealBreak = 14.0 * (1.0 + Math.max(0, difficulty) * 1.5);
                if (activeGrabbedDoor.sealTension >= requiredSealBreak) {
                    activeGrabbedDoor.isSealed = false;
                    activeGrabbedDoor.sealTension = 0;
                    try {
                        if (soundEffects.freezerSealPop) {
                            soundEffects.freezerSealPop.currentTime = 0;
                            soundEffects.freezerSealPop.play().catch(() => {});
                        }
                    } catch(_) {}
                    activeGrabbedDoor.angularVelocity += 0.55 * difficultyFactor;
                }
            }
        } else {
            // Apply angular acceleration torque
            const torque = pullAmount * 0.0038 * difficultyFactor;
            activeGrabbedDoor.angularVelocity += torque;
            // Physical max speed clamp based on door weight
            const maxSpeed = 3.8 * difficultyFactor;
            activeGrabbedDoor.angularVelocity = Math.max(-maxSpeed, Math.min(maxSpeed, activeGrabbedDoor.angularVelocity));
        }

        // Subtly stabilize camera rotation while dragging heavy door
        cameraTargetYaw -= rawX * 0.0003 * sens;
        cameraTargetPitch -= rawY * 0.0003 * sens;
        cameraTargetPitch = Math.max(-Math.PI * 0.48, Math.min(Math.PI * 0.48, cameraTargetPitch));
        cameraCurrentYaw = cameraTargetYaw;
        cameraCurrentPitch = cameraTargetPitch;
        return;
    }

    cameraTargetYaw -= rawX * 0.0022 * sens;
    cameraTargetPitch -= rawY * 0.0022 * sens;
    
    // Clamp vertical pitch to prevent gimbal lock
    cameraTargetPitch = Math.max(-Math.PI * 0.48, Math.min(Math.PI * 0.48, cameraTargetPitch));
    cameraCurrentYaw = cameraTargetYaw;
    cameraCurrentPitch = cameraTargetPitch;
}

let pointerdownHandler = null;
let pointerupHandler = null;

// ---- Touch controls bridge (used by src/touch-controls.js) ----
const touchMove = { x: 0, y: 0 }; // x: strafe (-1 left..1 right), y: forward (-1 back..1 fwd)
window.__touch = {
    enabled: TOUCH_MODE,
    keybinds() { return { ...DEFAULT_KEYBINDS, ...(CONFIG.KEYBINDS || {}) }; },
    move(x, y) { touchMove.x = x; touchMove.y = y; },
    look(dx, dy) {
        const k = 1.9;
        handleSmoothMouseMove({ movementX: dx * k, movementY: dy * k });
    },
    tap() { try { rendererClickHandler?.(); } catch (_) {} },
    relock() {
        if (gameStarted && !isCheckout && !gamePaused && !tweakerRequestOpen && !mainMenuVisible && controls && !controls.isLocked) {
            try { controls.lock(); } catch (_) {}
        }
    },
    state() {
        return {
            started: gameStarted, paused: gamePaused, menu: mainMenuVisible, checkout: isCheckout,
            over: gameOver, locked: !!controls?.isLocked, holding: !!heldItem, cart: cartAttached,
            intro: introCutsceneActive,
            power: !!currentPowerup && !powerupActive && !powerupUsed,
        };
    },
};

function setupEvents() {
    if (eventsInitialized) return;

    // Clean up any previous handlers to avoid duplicate bindings between restarts
    if (keydownHandler) { try { document.removeEventListener('keydown', keydownHandler); } catch(_) {} }
    if (keyupHandler) { try { document.removeEventListener('keyup', keyupHandler); } catch(_) {} }
    if (windowBlurHandler) { try { window.removeEventListener('blur', windowBlurHandler); } catch(_) {} }
    if (windowFocusHandler) { try { window.removeEventListener('focus', windowFocusHandler); } catch(_) {} }
    if (rendererClickHandler && renderer?.domElement) { try { renderer.domElement.removeEventListener('click', rendererClickHandler); } catch(_) {} }
    if (pointerdownHandler && renderer?.domElement) { try { renderer.domElement.removeEventListener('pointerdown', pointerdownHandler); } catch(_) {} }
    if (pointerupHandler) { try { window.removeEventListener('pointerup', pointerupHandler); } catch(_) {} }
    if (smoothMouseMoveHandler) { try { document.removeEventListener('mousemove', smoothMouseMoveHandler); } catch(_) {} }

    smoothMouseMoveHandler = handleSmoothMouseMove;
    document.addEventListener('mousemove', smoothMouseMoveHandler, { passive: true });

    // Amnesia Door Pointer Grab Handlers
    pointerdownHandler = (e) => {
        if (e.button !== 0) return; // Left mouse button only
        if (controls && controls.isLocked && !isCheckout && !gamePaused) {
            if (hoveredFreezerDoor) {
                activeGrabbedDoor = hoveredFreezerDoor;
                activeGrabbedDoor.isGrabbed = true;
                doorDragActive = true;
                doorDragMoved = false;
                if (crosshairElement) {
                    crosshairElement.classList.remove('amnesia-hover');
                    crosshairElement.classList.add('amnesia-grabbing');
                }
            }
        }
    };
    pointerupHandler = () => {
        if (activeGrabbedDoor) {
            activeGrabbedDoor.isGrabbed = false;
            activeGrabbedDoor = null;
            if (crosshairElement) {
                crosshairElement.classList.remove('amnesia-grabbing');
                if (hoveredFreezerDoor) {
                    crosshairElement.classList.add('amnesia-hover');
                }
            }
            setTimeout(() => {
                doorDragActive = false;
                doorDragMoved = false;
            }, 60);
        }
    };
    renderer?.domElement.addEventListener('pointerdown', pointerdownHandler);
    window.addEventListener('pointerup', pointerupHandler);

    // Click to start game OR relock pointer if game already started
    rendererClickHandler = (event) => {
        if (event?.button !== undefined && event.button !== 0) return;
        if (introCutsceneActive) {
            finishIntroCutscene(true);
            return;
        }
        if (doorDragActive || doorDragMoved) {
            doorDragActive = false;
            doorDragMoved = false;
            return;
        }
        if (!gameStarted && !gameOver && !mainMenuVisible) {
            startGame();
        } else if (gameStarted && !isCheckout && !gamePaused && !tweakerRequestOpen && controls && !controls.isLocked) {
            try { controls.lock(); } catch (_) {}
        } else if (gameStarted && !isCheckout && !gamePaused && controls && controls.isLocked) {
            if (Nuke.isWorldFrozen()) return;
            if (SQ.capturesClick() || SQ.isMovementLocked()) return;
            if (!heldItem) {
                grabItem();
            } else {
                tossHeldItem();
            }
        }
    };
    renderer?.domElement.addEventListener('click', rendererClickHandler);

    // Handle keyboard input
    const keyState = {};
    clearHeldKeys = () => Object.keys(keyState).forEach(k => (keyState[k] = false));
    let lastEActionTime = 0;

    keydownHandler = (event) => {
        if (introCutsceneActive) {
            if (event.code === 'Space' || event.code === 'Escape' || event.code === 'KeyE' || event.code === 'Enter') {
                finishIntroCutscene(true);
                return;
            }
        }
        if (tweakerRequestOpen) return;
        keyState[event.code] = true;
        const now = Date.now();

        // Handle jumping with configured key
        const kb = { ...DEFAULT_KEYBINDS, ...(CONFIG.KEYBINDS || {}) };
        if (event.code === kb.jump && SQ.onJump()) {
            // consumed by a side quest (e.g. stepping away from the returns desk)
        } else if (event.code === kb.jump && playerBody && playerBody.position.y < 1.1 && !SQ.isMovementLocked()) {
            playerBody.velocity.y = 3.5;
            const originalGravityY = world.gravity.y;
            world.gravity.y = -CONFIG.GRAVITY * 1.8;
            setTimeout(() => {
                world.gravity.y = originalGravityY;
            }, 220);

            if (Math.random() * 100 < CONFIG.TRIPPING_CHANCE && !tripped && cartAttached) {
                triggerTrip();
            }
        }

        // After the nuke nothing is left to interact with: walk, look, pause.
        if (Nuke.isWorldFrozen()) {
            if (event.code === kb.pause) togglePause();
            return;
        }

        // Flip between the grocery list and the other-tasks paper
        if (gameStarted && !gameOver && (event.code === 'Digit1' || event.code === 'Numpad1')) setListPage('grocery');
        if (gameStarted && !gameOver && (event.code === 'Digit2' || event.code === 'Numpad2')) setListPage('other');

        // Side-quest interactions (toilet, info desk, samples, customers, car) come first
        if (event.code === kb.interact && gameStarted && !isCheckout && !gamePaused && SQ.onInteractDown(event)) return;

        // Interact behavior: grab item, take item from cart, or drop/place into cart
        if (event.code === kb.interact && gameStarted && !isCheckout) {
            if (now - lastEActionTime < 250) return;
            lastEActionTime = now;
            if (tryCollectLooseMoney()) {
                // Money on the crosshair takes priority.
            } else if (!heldItem) {
                grabItem();
            } else {
                handleItemDropOrPlacement();
            }
        }

        if (event.code === kb.pause) {
            togglePause();
        }
        if (event.code === kb.cart && !SQ.isMovementLocked()) {
            if (cartAttached) {
                cartAttached = false;
                try { if (soundEffects.cartDrop) { soundEffects.cartDrop.currentTime = 0; soundEffects.cartDrop.play(); } } catch(_) {}
                displayMessage(`Detached from cart. You can now grab items off shelves! (Press ${formatKeyName(kb.cart)} to push cart)`, 2200);
            } else {
                if (canInteractWithCart()) {
                    cartAttached = true;
                    try { if (soundEffects.grab) { soundEffects.grab.currentTime = 0; soundEffects.grab.play(); } } catch(_) {}
                    displayMessage("Attached to shopping cart!", 1500);
                } else {
                    displayMessage(`Get closer to your shopping cart to attach! (Press ${formatKeyName(kb.cart)})`, 1800);
                }
            }
        }
        if (event.code === kb.mute) {
            setMusicMuted(!musicMuted);
            displayMessage(musicMuted ? "Music muted" : "Music unmuted", 2000);
        }
        if (event.code === kb.powerup && gameStarted && !powerupUsed && currentPowerup && !powerupActive) {
            activateCurrentPowerup();
        }
        // Use Mouse keybind toggle
        if (event.code === kb.useMouse) {
            event.preventDefault();
            if (gameStarted && !isCheckout && !gameOver && !gamePaused) {
                if (controls && controls.isLocked) {
                    try { controls.unlock(); } catch(_) {}
                } else if (controls && !controls.isLocked) {
                    try { controls.lock(); } catch(_) {}
                }
            }
        }
        // Slap mechanic
        if (event.code === kb.slap && gameStarted && !isCheckout && !gamePaused && controls?.isLocked) {
            if (now - lastSlapAt >= SLAP_COOLDOWN_MS) {
                lastSlapAt = now;
                performSlap();
            }
        }
    };
    document.addEventListener('keydown', keydownHandler);

    keyupHandler = (event) => {
        keyState[event.code] = false;
        const kbUp = { ...DEFAULT_KEYBINDS, ...(CONFIG.KEYBINDS || {}) };
        if (event.code === kbUp.interact) SQ.onInteractUp();
    };
    document.addEventListener('keyup', keyupHandler);

    windowBlurHandler = () => {
        Object.keys(keyState).forEach(k => (keyState[k] = false));
        try { controls?.unlock(); } catch (_) {}
    };
    window.addEventListener('blur', windowBlurHandler);

    windowFocusHandler = () => {
        if (gameStarted && !isCheckout && !gamePaused && !tweakerRequestOpen && controls && !controls.isLocked && !mainMenuVisible) {
            try { controls.lock(); } catch (_) {}
        }
    };
    window.addEventListener('focus', windowFocusHandler);

    // Process movement based on key state
    if (movementIntervalId) clearInterval(movementIntervalId);
    let lastMovementUpdate = performance.now();
    movementIntervalId = setInterval(() => {
        const movementNow = performance.now();
        const movementDelta = Math.min((movementNow - lastMovementUpdate) / 1000, 0.05);
        lastMovementUpdate = movementNow;
        if (!gameStarted || !playerBody) return;
        if (isCheckout || gamePaused) {
            if (!gameOver) { playerBody.velocity.x = 0; playerBody.velocity.z = 0; }
            return;
        }
        if (tweakerRequestOpen || SQ.isMovementLocked() || Nuke.isMovementLocked()) {
            playerBody.velocity.x = 0;
            playerBody.velocity.z = 0;
            return;
        }
        // Freeze movement while tripped
        if (tripped) {
            playerBody.velocity.x = 0;
            playerBody.velocity.z = 0;
            return;
        }

        const moveSpeed = currentMoveSpeed * activeSpeedMultiplier * Thermo.getThermostatSpeedMultiplier() * (powerOutage ? 0.5 : 1) * (slipperyFloor ? 2 : 1) * (playerOnSpill ? 0.5 : 1) * (playerOnSticky ? 0.25 : 1) * (playerOnGlassShards ? 0.5 : 1) * ((cartStuckActive && cartAttached) ? 0.8 : 1);
        const direction = new THREE.Vector3();
        camera.getWorldDirection(direction);
        direction.y = 0;
        direction.normalize();

        const sideVector = new THREE.Vector3(
            direction.z,
            0,
            -direction.x
        );

        let moveX = 0;
        let moveZ = 0;

        const kb = { ...DEFAULT_KEYBINDS, ...(CONFIG.KEYBINDS || {}) };
        if (keyState[kb.forward]) {
            moveX += direction.x * moveSpeed;
            moveZ += direction.z * moveSpeed;
        }
        if (keyState[kb.backward]) {
            moveX -= direction.x * moveSpeed;
            moveZ -= direction.z * moveSpeed;
        }
        if (keyState[kb.left]) {
            moveX += sideVector.x * moveSpeed; 
            moveZ += sideVector.z * moveSpeed; 
        }
        if (keyState[kb.right]) {
            moveX -= sideVector.x * moveSpeed; 
            moveZ -= sideVector.z * moveSpeed; 
        }
        if (touchMove.x || touchMove.y) {
            moveX += (direction.x * touchMove.y - sideVector.x * touchMove.x) * moveSpeed;
            moveZ += (direction.z * touchMove.y - sideVector.z * touchMove.x) * moveSpeed;
        }

        if ((Math.abs(moveX) > 0 || Math.abs(moveZ) > 0) &&
            Math.random() * 100 < CONFIG.TRIPPING_CHANCE &&
            !tripped &&
            cartAttached) {
            triggerTrip();
        }

        if (slipperyFloor) {
            // Ice keeps momentum when keys are released and takes time to turn.
            const steering = moveX !== 0 || moveZ !== 0;
            const response = steering ? 5 : 3.5;
            const blend = 1 - Math.exp(-response * movementDelta);
            playerBody.velocity.x += (moveX - playerBody.velocity.x) * blend;
            playerBody.velocity.z += (moveZ - playerBody.velocity.z) * blend;
            if (!steering && Math.hypot(playerBody.velocity.x, playerBody.velocity.z) < 0.08) {
                playerBody.velocity.x = 0;
                playerBody.velocity.z = 0;
            }
        } else {
            playerBody.velocity.x = moveX;
            playerBody.velocity.z = moveZ;
        }
        if (Math.hypot(playerBody.velocity.x, playerBody.velocity.z) > 0.08) {
            try { playerBody.wakeUp(); } catch (_) {}
        }

        if ((Math.abs(moveX) > 0.5 || Math.abs(moveZ) > 0.5) &&
            !soundEffects.footstep.playing &&
            playerBody.position.y < 1.1) {

            soundEffects.footstep.currentTime = 0;
            soundEffects.footstep.play();
            soundEffects.footstep.playing = true;

            footstepCount++;

            setTimeout(() => {
                soundEffects.footstep.playing = false;
            }, 300);
        }

        const currentPos = { x: playerBody.position.x, z: playerBody.position.z };
        const distanceTraveled = Math.sqrt(
            Math.pow(currentPos.x - lastPosition.x, 2) + 
            Math.pow(currentPos.z - lastPosition.z, 2)
        );

        lastPosition = currentPos;
    }, 10);

    if (finishCheckoutButton) {
        finishCheckoutButton.addEventListener('click', () => {
            if (purchaseComplete) return;
            if (checkoutBusyActive) {
                displayMessage("A customer is currently checking out. Please wait.", 2000);
                return;
            }
            const allItemsScanned = document.querySelectorAll('.checkout-item.scanned').length === collectedItems.length;

            if (allItemsScanned) {
                purchaseComplete = true;
                logRunEvent('💳 Paid for your groceries');
                finishCheckoutButton.disabled = true;
                completeGroceryPurchase();
            } else {
                displayMessage("You need to scan all items first!", 3000);
            }
        });
    }

    if (playAgainButton) {
        playAgainButton.addEventListener('click', () => {
            // "Shop Again" should behave like a full restart of the game
            restartGameCold();
        });
    }

    eventsInitialized = true;
}

// Helper: clamp values safely without artificial offsets
function plus5PercentPercent(value) { // value in [0..100]
    const v = Number.isFinite(value) ? value : 0;
    return Math.max(0, Math.min(100, v));
}
function plus0_05Fraction(value) { // value in [0..1]
    const v = Number.isFinite(value) ? value : 0;
    return Math.max(0, Math.min(1, v));
}

function scheduleRandomEvents(isReroll = false) {
    if (!isReroll) {
        cancelScheduledEvents(false);
    }
    if (isLonelyStoreMode) return;

    const events = [
        { name: 'power_outage', chance: CONFIG.POWER_OUTAGE_CHANCE ?? 6, trigger: triggerPowerOutage, available: () => !powerOutage },
        { name: 'forgot_glasses', chance: CONFIG.FORGOT_GLASSES_CHANCE ?? 10, trigger: triggerForgotGlasses,
            available: () => glassesBlurRemaining <= 0, guard: () => glassesBlurRemaining <= 0,
            delay: () => isReroll ? 5000 + Math.random() * 20000 : 5000 + Math.random() * 55000 },
        { name: 'manager_jumpscare', chance: CONFIG.MANAGER_JUMPSCARE_CHANCE ?? 8, trigger: triggerManagerJumpscare, available: () => !managerActive && !!scene && !!playerBody },
        { name: 'store_closing', chance: CONFIG.STORE_CLOSING_CHANCE ?? 10, trigger: triggerStoreClosing, available: () => !storeClosing },
        { name: 'baby_crying', chance: cartBaby ? 35 : (CONFIG.BABY_CRYING_CHANCE ?? 5), trigger: triggerBabyCrying, available: () => !isLonelyStoreMode && !babyCrying },
        { name: 'falling_shelf', chance: CONFIG.FALLING_SHELF_CHANCE ?? 5, trigger: triggerFallingShelfEvent, available: () => !fallingShelfTriggered && shelfUnits.length > 0 },
        { name: 'slippery_floor', chance: CONFIG.SLIPPERY_FLOOR_CHANCE ?? 13, trigger: triggerSlipperyFloor, available: () => !slipperyFloor },
        { name: 'product_spill', chance: CONFIG.PRODUCT_SPILL_CHANCE ?? 15, trigger: triggerProductSpill, available: () => true },
        { name: 'out_of_stock', chance: CONFIG.OUT_OF_STOCK_CHANCE ?? 8, trigger: triggerOutOfStock, available: () =>
            shoppingList.filter(li => li && li.collected < li.quantity &&
                !outOfStockListItems.includes(li.name) && countObtainableInStore(li.name) > 0).length >= 2 },
        { name: 'gnome_thief', chance: CONFIG.THIEF_BREAK_IN_CHANCE ?? 6, trigger: () => triggerThiefEvent(true),
            available: () => !thief, guard: () => !thief,
            delay: () => isReroll ? 6000 + Math.random() * 32000 : 12000 + Math.random() * 30000 },
        { name: 'wife_call', chance: CONFIG.WIFE_CALL_CHANCE ?? 13, trigger: triggerWifeCallEvent,
            available: () => !wifeCallActive && !wifeCallRinging, guard: () => !wifeCallActive && !wifeCallRinging,
            delay: () => isReroll ? 8000 + Math.random() * 32000 : 14000 + Math.random() * 30000 },
        { name: 'earthquake', chance: CONFIG.EARTHQUAKE_CHANCE ?? 8, trigger: triggerEarthquakeEvent, available: () => true,
            delay: () => isReroll ? 10000 + Math.random() * 32000 : 16000 + Math.random() * 30000 },
        { name: 'thermostat', chance: CONFIG.THERMOSTAT_CHANCE ?? 7, trigger: triggerThermostatMalfunction,
            available: () => !Thermo.isThermostatActive(), guard: () => !Thermo.isThermostatActive(),
            delay: () => isReroll ? 5000 + Math.random() * 25000 : 40000 + Math.random() * 20000 },
        { name: 'customer_scuffle', chance: CONFIG.CUSTOMER_SCUFFLE_CHANCE ?? 13, trigger: triggerCustomerScuffle,
            available: () => customers.filter(c => c.body && c.visible !== false && c.behaviorState !== 'respawning').length >= 2 },
        { name: 'tweaker', chance: CONFIG.TWEAKER_CHANCE ?? 8, trigger: triggerTweakerEvent,
            available: () => !activeTweaker && !!playerBody, guard: () => !activeTweaker && !!playerBody },
        { name: 'cart_stuck', chance: CONFIG.CART_STUCK_CHANCE ?? 8, trigger: triggerCartStuck,
            available: () => cartAttached && !cartStuckActive, guard: () => cartAttached && !cartStuckActive,
            delay: () => isReroll ? 7000 + Math.random() * 30000 : 15000 + Math.random() * 35000 }
    ];

    // Every configured chance still gets its own roll. Only timed rerolls
    // choose one extra eligible event when none passed those rolls.
    const allowed = ev => !(purchaseComplete && LIST_AFFECTING_EVENTS.has(ev.name));
    const rolled = events.filter(ev => ev.chance > 0 && allowed(ev) && Math.random() * 100 < ev.chance && ev.available());
    if (isReroll && rolled.length === 0) {
        const eligible = events.filter(ev => ev.name !== 'forgot_glasses' && ev.chance > 0 && allowed(ev) && ev.available());
        if (eligible.length) rolled.push(eligible[Math.floor(Math.random() * eligible.length)]);
    }
    rolled.forEach(ev => {
        const delay = ev.delay ? ev.delay() : (isReroll ? 5000 + Math.random() * 20000 : 8000 + Math.random() * 24000);
        scheduleEventAttempt(ev.name, ev.trigger, delay, ev.guard);
    });

    // Rarest event: the nuclear fallout. Rolled once per run, never rerolled.
    if (!isReroll && Math.random() * 100 < (CONFIG.NUCLEAR_FALLOUT_CHANCE ?? 1)) {
        scheduleEventAttempt('nuclear_fallout', triggerNuclearFallout, 25000 + Math.random() * 50000,
            () => !Nuke.isNukeActive());
    }
}

const LIST_AFFECTING_EVENTS = new Set(['out_of_stock', 'gnome_thief', 'wife_call']);

// Schedule a rolled event. If it comes due while the game can't show it
// (paused, intro cutscene, customer question, checkout) or its guard fails,
// keep it pending until it can run or the game ends.
function scheduleEventAttempt(name, trigger, delay, guard = null) {
    const tweakerScheduleVersion = name === 'tweaker' ? tweakerEventScheduleVersion : null;
    const timerId = setTimeout(() => {
        const idx = scheduledEventTimeouts.indexOf(timerId);
        if (idx !== -1) scheduledEventTimeouts.splice(idx, 1);
        if (!gameStarted || gameOver || isLonelyStoreMode) return;
        // The nuclear fallout disables every other event.
        if (Nuke.isNukeLockdown()) return;
        // Invalidate tweaker attempts queued before an encounter began so
        // they cannot restart it after he leaves.
        if (name === 'tweaker' &&
            (activeTweaker || tweakerScheduleVersion !== tweakerEventScheduleVersion)) return;
        if (name === 'tweaker' && guard && !guard()) return;
        // Once groceries are paid, list/checkout events are gone for good.
        if (purchaseComplete && LIST_AFFECTING_EVENTS.has(name)) return;
        const blocked = gamePaused || introCutsceneActive || isCheckout || SQ.isCinematic() || (guard && !guard());
        if (blocked) {
            scheduleEventAttempt(name, trigger, 3000 + Math.random() * 4000, guard);
            return;
        }
        let result;
        try { result = trigger(); } catch (err) { console.warn('Error executing event', name, err); return; }
        if (result !== false) logRunEvent(RUN_EVENT_LABELS[name] || name.replace(/_/g, ' '));
        if (result === false) {
            scheduleEventAttempt(name, trigger, 4000 + Math.random() * 4000, guard);
        }
    }, delay);
    scheduledEventTimeouts.push(timerId);
    return timerId;
}

const moneyValues = [25, 50, 100, 100, 100, 500, 500];
const tweakerQuestions = [
    'Is the ceiling following me?', 'Do these aisles move at night?',
    'Can I borrow a cloud?', 'Have you seen my invisible coupon?',
    'Do the shopping carts know my name?'
];

function updateSavingsTab() {
    const tab = document.getElementById('savings-tab');
    if (!tab) return;
    tab.classList.toggle('hidden', !gameStarted && savingsCents === 0);
    document.getElementById('savings-amount').textContent = `$${(savingsCents / 100).toFixed(2)}`;
}

function disposeEventGroup(group) {
    if (!group) return;
    group.removeFromParent();
    group.traverse(obj => {
        if (!obj.isMesh) return;
        obj.geometry.dispose();
        if (Array.isArray(obj.material)) obj.material.forEach(mat => { mat.map?.dispose(); mat.dispose(); });
        else { obj.material?.map?.dispose(); obj.material?.dispose(); }
    });
}

function closeTweakerRequest(restoreControls = true) {
    if (!tweakerRequestOpen) return;
    tweakerRequestOpen = false;
    document.getElementById('tweaker-interaction-message')?.remove();
    if (activeTweaker) {
        activeTweaker.frozenAt = null;
        activeTweaker.nextAsk = performance.now() + 8000 + Math.random() * 5000;
    }
    if (restoreControls && gameStarted && !gameOver && !gamePaused && !isCheckout) {
        try { controls?.lock(); } catch (_) {}
    }
}

function declineTweakerRequest() {
    if (!activeTweaker || !tweakerRequestOpen) return;
    const reachedAskLimit = activeTweaker.askCount >= activeTweaker.askLimit;
    closeTweakerRequest();
    if (reachedAskLimit) beginTweakerExit();
}

function endTweakerEvent() {
    if (!activeTweaker) return;
    closeTweakerRequest();
    world?.removeBody(activeTweaker.body);
    disposeEventGroup(activeTweaker.group);
    activeTweaker = null;
}

function beginTweakerExit() {
    if (!activeTweaker || activeTweaker.phase === 'leaving' || activeTweaker.phase === 'outside') return;
    closeTweakerRequest();
    activeTweaker.phase = 'leaving';
    activeTweaker.exitStartedAt = performance.now();
    activeTweaker.path = [];
    activeTweaker.repathAt = 0;
    activeTweaker.body.velocity.x = 0;
    activeTweaker.body.velocity.z = 0;
}

function clearTweakerAndMoney() {
    endTweakerEvent();
    looseMoney.forEach(money => disposeEventGroup(money.group));
    looseMoney = [];
    nextMoneySpawnAt = 0;
    document.getElementById('savings-tab')?.classList.add('hidden');
}

function spawnLooseMoney(nearPlayer = false) {
    if (!scene || looseMoney.length >= 20) return;
    const sources = ['floor', 'floor', 'shelf', 'counter', 'cart', 'outside'];
    let x, y = 0.07, z, cartParent = null;
    const source = nearPlayer
        ? (playerBody.position.z < -20 ? 'outside' : 'floor')
        : sources[Math.floor(Math.random() * sources.length)];
    if (source === 'shelf' && shelfUnits.length) {
        const shelf = shelfUnits[Math.floor(Math.random() * shelfUnits.length)];
        const boards = shelves.filter(board => board.parent === shelf && !board.userData.isEmptyShelf);
        const board = boards[Math.floor(Math.random() * boards.length)];
        if (board) {
            shelf.updateMatrixWorld(true);
            const { width, height, depth } = board.geometry.parameters;
            const point = board.localToWorld(new THREE.Vector3(
                (Math.random() - 0.5) * Math.max(0.1, width - 0.7),
                height / 2 + 0.025,
                (Math.random() - 0.5) * Math.max(0.1, depth - 0.55)
            ));
            x = point.x; y = point.y; z = point.z;
        }
    } else if (source === 'cart' && customers.some(c => c.cart?.group)) {
        const carts = customers.filter(c => c.cart?.group);
        const cart = carts[Math.floor(Math.random() * carts.length)].cart.group;
        x = 0; y = 0.9; z = 0; cartParent = cart;
    } else if (source === 'counter') {
        x = 15 + (Math.random() - 0.5) * 4; z = -15 + (Math.random() - 0.5) * 0.8; y = 0.98;
    } else if (source === 'outside') {
        x = (Math.random() - 0.5) * 22; z = -39 - Math.random() * 12;
    } else {
        const angle = Math.random() * Math.PI * 2;
        const radius = 3 + Math.random() * 10;
        const fx = nearPlayer ? playerBody.position.x + Math.cos(angle) * radius : (Math.random() - 0.5) * 48;
        const fz = nearPlayer ? playerBody.position.z + Math.sin(angle) * radius : -18 + Math.random() * 40;
        const pos = navGrid ? clampToWalkable(navGrid, fx, fz) : {x: fx, z: fz};
        x = pos.x; z = Math.max(-20, pos.z);
    }
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    const cents = moneyValues[Math.floor(Math.random() * moneyValues.length)];
    const group = new THREE.Group();
    const bill = cents >= 100;
    const canvas = document.createElement('canvas');
    canvas.width = bill ? 256 : 128;
    canvas.height = bill ? 128 : 128;
    const ctx = canvas.getContext('2d');
    if (bill) {
        ctx.fillStyle = '#a7c99b'; ctx.fillRect(0, 0, 256, 128);
        ctx.strokeStyle = '#325b3b'; ctx.lineWidth = 5; ctx.strokeRect(8, 8, 240, 112);
        ctx.lineWidth = 2; ctx.strokeRect(15, 15, 226, 98);
        ctx.fillStyle = '#325b3b'; ctx.font = 'bold 28px Georgia';
        ctx.fillText(String(cents / 100), 22, 40);
        ctx.fillText(String(cents / 100), 212, 110);
        ctx.beginPath(); ctx.ellipse(128, 64, 45, 49, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.font = 'bold 50px Georgia'; ctx.fillText('$', 113, 81);
    } else {
        ctx.fillStyle = '#b98e37';
        ctx.beginPath(); ctx.arc(64, 64, 60, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#f5d57b'; ctx.lineWidth = 7;
        ctx.beginPath(); ctx.arc(64, 64, 49, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(64, 64, 39, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = '#ffe19b'; ctx.textAlign = 'center'; ctx.font = 'bold 48px Georgia';
        ctx.fillText(cents === 25 ? '25' : '50', 64, 79);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const base = new THREE.Mesh(
        bill ? new THREE.BoxGeometry(0.54, 0.012, 0.27) : new THREE.CylinderGeometry(0.145, 0.145, 0.018, 32),
        new THREE.MeshStandardMaterial({color: bill ? 0x789f70 : 0xe5b754, metalness: bill ? 0 : 0.75, roughness: 0.35})
    );
    group.add(base);
    const face = new THREE.Mesh(
        new THREE.PlaneGeometry(bill ? 0.52 : 0.26, bill ? 0.25 : 0.26),
        new THREE.MeshBasicMaterial({map: texture, transparent: !bill, side: THREE.DoubleSide})
    );
    face.rotation.x = -Math.PI / 2;
    face.position.y = bill ? 0.008 : 0.011;
    group.add(face);
    group.position.set(x, y, z);
    group.rotation.y = Math.random() * Math.PI;
    (cartParent || scene).add(group);
    looseMoney.push({group, cents});
}

function aimedLooseMoney(ray, reach = 3.2) {
    if (!looseMoney.length) return false;
    const hits = ray.intersectObjects(looseMoney.map(m => m.group), true);
    const hit = hits.find(h => h.distance <= reach);
    if (!hit) return false;
    return looseMoney.find(m => m.group === hit.object.parent) || false;
}

function tryCollectLooseMoney() {
    camera.getWorldDirection(sharedVec3);
    sharedRaycaster.set(camera.position, sharedVec3);
    const money = aimedLooseMoney(sharedRaycaster);
    if (!money) return false;
    savingsCents += money.cents;
    looseMoney.splice(looseMoney.indexOf(money), 1);
    disposeEventGroup(money.group);
    updateSavingsTab();
    try {
        setBoostedSfxVolume('moneyPickup');
        soundEffects.moneyPickup.currentTime = 0;
        soundEffects.moneyPickup.play().catch(() => {});
    } catch (_) {}
    displayMessage(`Picked up $${(money.cents / 100).toFixed(2)}. Savings: $${(savingsCents / 100).toFixed(2)}`, 2200);
    return true;
}

function triggerTweakerEvent() {
    if (activeTweaker || !scene || !world || !playerBody) return false;
    tweakerEventScheduleVersion += 1;
    // Build him from the same character, eye, leg, and physics setup as a shopper.
    const group = createCustomer({tweaker: true});
    const body = group.body;
    group.bodyMesh.material.color.set(0x655b4e);
    group.leftLeg.material.color.set(0x48423a);
    const beard = new THREE.MeshStandardMaterial({color: 0x393024, roughness: 1});
    const tear = new THREE.MeshStandardMaterial({color: 0x29271f, roughness: 1, side: THREE.DoubleSide});
    const addPatch = (parent, x, y, z, width) => {
        const patch = new THREE.Mesh(new THREE.PlaneGeometry(width, width * 0.72), tear);
        patch.position.set(x, y, z); patch.rotation.z = (Math.random() - 0.5) * 0.55;
        parent.add(patch);
    };
    for (const side of [-1, 0, 1]) {
        const tuft = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.22 + Math.random() * 0.10, 7), beard);
        tuft.position.set(side * 0.095, -0.19, 0.16);
        tuft.rotation.z = Math.PI + side * 0.2;
        group.head.add(tuft);
    }
    addPatch(group.bodyMesh, -0.12, 0.13, 0.317, 0.13);
    addPatch(group.bodyMesh, 0.14, -0.11, 0.318, 0.16);
    addPatch(group.leftLeg, -0.015, -0.08, 0.089, 0.085);
    addPatch(group.rightLeg, 0.018, 0.08, 0.089, 0.095);
    group.position.set(0, 0, -38);
    body.position.set(0, 0.95, -38);
    group.walkSpeed = 11;
    activeTweaker = {group, body, askCount: 0, askLimit: 2 + Math.floor(Math.random() * 3),
        nextAsk: 0, request: 1 + Math.floor(Math.random() * 10),
        phase: 'entering', path: [], waypoint: 0, repathAt: 0,
        expiresAt: performance.now() + 45000, exitStartedAt: 0};
    displayMessage('Someone is coming into the store...', 3500, true);
    return true;
}

function showTweakerRequest(now) {
    if (!activeTweaker || tweakerRequestOpen || customerQuestionInProgress) return;
    const t = activeTweaker;
    t.request = 1 + Math.floor(Math.random() * 10);
    const question = tweakerQuestions[Math.floor(Math.random() * tweakerQuestions.length)];
    const panel = document.createElement('div');
    panel.id = 'tweaker-interaction-message';
    const title = document.createElement('h3');
    title.textContent = 'SOMEONE ASKED';
    const text = document.createElement('p');
    text.textContent = `${question} Can you give me $${t.request}?`;
    const yes = document.createElement('button');
    yes.textContent = `Yes, give $${t.request}`;
    yes.addEventListener('click', () => { if (activeTweaker) tryPayTweaker(); });
    const no = document.createElement('button');
    no.textContent = 'No, sorry.';
    no.addEventListener('click', () => declineTweakerRequest());
    panel.append(title, text, yes, no);
    document.getElementById('game-container').appendChild(panel);
    tweakerRequestOpen = true;
    t.askCount += 1;
    t.nextAsk = now + 8000 + Math.random() * 5000;
    t.frozenAt = {x: playerBody.position.x, z: playerBody.position.z};
    t.body.velocity.x = 0; t.body.velocity.z = 0;
    playerBody.velocity.x = 0; playerBody.velocity.z = 0;
    try {
        setBoostedSfxVolume('tweakerGrunt');
        soundEffects.tweakerGrunt.currentTime = 0;
        soundEffects.tweakerGrunt.play().catch(() => {});
    } catch (_) {}
    try { controls?.unlock(); } catch (_) {}
}

function updateTweaker(now) {
    if (!activeTweaker || gamePaused || isCheckout || introCutsceneActive) return;
    const t = activeTweaker;
    if (t.phase === 'following' && now >= t.expiresAt) beginTweakerExit();
    if (t.phase === 'leaving' && now - t.exitStartedAt > 10000 && !t.unstuck) {
        // If collision/pathfinding traps him, finish the trip out the door
        // under his own movement instead of despawning inside the store.
        t.unstuck = true;
        t.body.collisionResponse = false;
    }
    if (t.unstuck) {
        t.body.position.y = 0.95;
        t.body.velocity.y = 0;
    }
    const pos = t.body.position, player = playerBody.position;
    const distance = Math.hypot(player.x - pos.x, player.z - pos.z);
    if (t.phase === 'entering') {
        if (pos.z >= -26.3) {
            t.phase = 'following';
            t.repathAt = 0;
            t.body.velocity.z = 0;
        } else {
            t.body.velocity.x = -pos.x * 2;
            t.body.velocity.z = 6.8;
        }
    } else if (t.phase === 'outside') {
        if (pos.z <= -41) { endTweakerEvent(); return; }
        const dx = 2.7 - pos.x, dz = -42 - pos.z;
        const length = Math.hypot(dx, dz);
        if (length < 0.9) { endTweakerEvent(); return; }
        t.body.velocity.x = dx / length * 7;
        t.body.velocity.z = dz / length * 7;
    } else if (tweakerRequestOpen) {
        t.body.velocity.x = 0; t.body.velocity.z = 0;
    } else if (t.phase === 'leaving' || distance > 1.45) {
        // The basket stack blocks the center of the entrance. Approach
        // through the open aisle beside it, then cross into the parking lot.
        const goalX = t.phase === 'leaving' ? 2.7 : player.x;
        const goalZ = t.phase === 'leaving' ? -27.3 : player.z;
        if (t.phase === 'leaving' && Math.hypot(goalX - pos.x, goalZ - pos.z) < 1.2) {
            t.phase = 'outside';
            t.body.velocity.x = 0;
            t.body.velocity.z = -7;
        } else {
            if (t.unstuck) {
                t.path = [{x: goalX, z: goalZ}];
                t.waypoint = 0;
            } else if (now >= t.repathAt) {
                const goal = navGrid ? clampToWalkable(navGrid, goalX, goalZ) : {x: goalX, z: goalZ};
                t.path = navGrid ? findPath(navGrid, {x: pos.x, z: pos.z}, goal) || [goal] : [goal];
                t.waypoint = 0; t.repathAt = now + 650;
            }
            while (t.waypoint < t.path.length - 1 &&
                Math.hypot(t.path[t.waypoint].x - pos.x, t.path[t.waypoint].z - pos.z) < 0.65) t.waypoint++;
            const target = t.path[t.waypoint] || {x: goalX, z: goalZ};
            const dx = target.x - pos.x, dz = target.z - pos.z;
            const length = Math.hypot(dx, dz);
            const speed = t.phase === 'leaving' ? 7 : Math.max(11, currentMoveSpeed * activeSpeedMultiplier + 6, distance * 1.5);
            t.body.velocity.x = length > 0.15 ? dx / length * speed : 0;
            t.body.velocity.z = length > 0.15 ? dz / length * speed : 0;
        }
    } else {
        t.body.velocity.x = 0; t.body.velocity.z = 0;
    }
    t.group.position.set(pos.x, 0, pos.z);
    slerpToYaw(t.group,
        t.phase === 'following'
            ? Math.atan2(player.x - pos.x, player.z - pos.z)
            : Math.atan2(t.body.velocity.x, t.body.velocity.z), 0.22);
    const moving = Math.hypot(t.body.velocity.x, t.body.velocity.z) > 0.2;
    const phase = now * 0.003 + t.group.animPhase;
    const swing = moving ? Math.min(0.5, Math.hypot(t.body.velocity.x, t.body.velocity.z) / t.group.walkSpeed) * 0.35 : 0;
    t.group.leftLeg.rotation.x = Math.sin(phase * 5.2) * swing;
    t.group.rightLeg.rotation.x = Math.sin(phase * 5.2 + Math.PI) * swing;
    t.group.bodyMesh.rotation.x = moving ? Math.sin(phase * 10.4) * 0.035 : 0;
    t.group.head.rotation.y = Math.sin(now * 0.002) * 0.1;
    if (now >= t.group.blinkNext) {
        const progress = now - t.group.blinkNext;
        const angle = progress < 160 ? THREE.MathUtils.lerp(-Math.PI * 0.55, 0.08,
            Math.sin(progress / 160 * Math.PI)) : -Math.PI * 0.55;
        t.group.eyelids.forEach(lid => { lid.rotation.x = angle; });
        if (progress >= 160) t.group.blinkNext = now + 2500 + Math.random() * 4000;
    }
    if (t.phase === 'following' && !tweakerRequestOpen && distance < 2.1 && now >= t.nextAsk &&
        !customerQuestionInProgress && !customerInteractionMessageVisible) showTweakerRequest(now);
}

function tryPayTweaker() {
    if (!activeTweaker || !tweakerRequestOpen || activeTweaker.phase !== 'following' || !playerBody) return false;
    const cost = activeTweaker.request * 100;
    const fromSavings = Math.min(savingsCents, cost);
    savingsCents -= fromSavings;
    if (fromSavings === cost) {
        displayMessage(`Gave $${activeTweaker.request} from savings. They left.`, 2500);
    } else {
        if (Math.random() < 0.20) tweakerMoneyRisk = true;
        displayMessage(`Gave $${((cost - fromSavings) / 100).toFixed(2)} of your own money. They left.`, 2500);
    }
    updateSavingsTab();
    beginTweakerExit();
    return true;
}

function triggerTrip() {
    if (tripped || !cartAttached) return;
    tripped = true;
    tripCount++; // Increment trip count
    logRunEvent('🤕 Tripped');
    addAchievementProgress('klutz');
    soundEffects.trip.play();
    displayMessage("Oops! You tripped!", 3000);

    // Capture pre-trip attachment state, then detach cart so you must reattach it manually
    const wasAttached = cartAttached;
    cartAttached = false;

    // Make all collected items fall out of the cart ONLY if it was attached at the moment of trip
    if (wasAttached && collectedItems.length > 0) {
        itemsFallenCount += collectedItems.length; // Increment items fallen count
        addAchievementProgress('butterfingers', collectedItems.length);
        const cartPos = new THREE.Vector3();
        cartObject.getWorldPosition(cartPos);
        
        collectedItems.forEach(item => {
            // Make the item visible again
            item.mesh.visible = true;

            const itemWorldPos = new THREE.Vector3();
            if (item.mesh) {
                item.mesh.getWorldPosition(itemWorldPos);
                if (item.mesh.parent) item.mesh.parent.remove(item.mesh);
            } else {
                itemWorldPos.set(cartPos.x, cartPos.y + 0.5, cartPos.z);
            }

            // Remove the old physics body if it exists
            if (item.body) {
                try { world.removeBody(item.body); } catch(_) {}
                item.body = null;
            }

            // Restore mesh material depth and ensure mesh is fully visible and in scene
            try {
                item.mesh.traverse((obj) => {
                    if (obj.isMesh && obj.material) {
                        if (Array.isArray(obj.material)) {
                            obj.material.forEach(m => { m.depthTest = true; m.depthWrite = true; });
                        } else {
                            obj.material.depthTest = true;
                            obj.material.depthWrite = true;
                        }
                    }
                    obj.renderOrder = 0;
                });
            } catch(_) {}

            const sx = (item.size && item.size[0]) ? item.size[0] / 2 : 0.15;
            const sy = (item.size && item.size[1]) ? item.size[1] / 2 : 0.15;
            const sz = (item.size && item.size[2]) ? item.size[2] / 2 : 0.15;

            // Create a new physics body for the item
            const shape = new CANNON.Box(new CANNON.Vec3(sx, sy, sz));

            item.body = new CANNON.Body({
                mass: 1,
                shape: shape,
                linearDamping: 0.35,
                angularDamping: 0.35
            });

            item.mesh.position.copy(itemWorldPos);
            item.body.position.set(itemWorldPos.x, Math.max(0.35, itemWorldPos.y), itemWorldPos.z);

            // Add random velocity for more realistic scattering
            item.body.velocity.set(
                (Math.random() - 0.5) * 3.5,
                2.2 + Math.random() * 2.0,
                (Math.random() - 0.5) * 3.5
            );

            world.addBody(item.body);
            scene.add(item.mesh);

            // Update item state
            item.inCart = false;
            item.isStatic = false;
            item.isDropping = false;
            item.hasLanded = false;
        });
        
        // Clear the collected items array
        collectedItems = [];
        refreshGumCravingState();
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

// One live report for the leaderboard tracker: run clock, position, items.
function sampleRunTrack(final) {
    if (!playerBody || (!final && (gameOver || !gameStarted))) return null;
    const t = stoppedRunElapsed ?? Math.max(0, Date.now() - timerStart);
    const p = playerBody.position;
    return { t: Math.round(t), x: +p.x.toFixed(2), z: +p.z.toFixed(2), c: getRunMetrics(t).totalCollected };
}

async function startAuthenticatedRun() {
    currentRunSession = null;
    stopRunTrack();
    try {
        // Sent straight away: the server's clock for this run starts on arrival.
        // (The server reads the signed-in username from its own headers.)
        const username = "Shopper";
        const res = await fetch('/api/run/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: username,
                total_items: shoppingList.length
            })
        });

        if (res.ok) {
            const data = await res.json();
            currentRunSession = {
                runId: data.run_id,
                startedAt: data.started_at
            };
            if (!gameOver && stoppedRunElapsed === null) {
                startRunTrack(data.run_id, sampleRunTrack, data.beat_ms || 2000);
            }
        }
    } catch (err) {
        console.warn('Could not start authenticated run session:', err);
    }
}

function startGame() {
    markBootPending(false);
    gameStarted = true;
    stoppedRunElapsed = null;
    if (!gameTime) resetRunTimeline();
    updateSavingsTab();
    if (looseMoney.length === 0) {
        for (let i = 0; i < 17; i++) spawnLooseMoney(i < 5);
        nextMoneySpawnAt = performance.now() + 8000;
    }

    // Start anti-cheat verified speedrun session
    if (countsForLeaderboard()) {
        startAuthenticatedRun();
        try { window.__replayRunStarted?.(); } catch (_) {}
    }

    // Make sure menu music is fully stopped when gameplay begins
    stopMenuMusic();
    // Ensure fail music is not playing when starting a game
    stopFailMusic();

    // Correct timer start: resume from existing elapsed if any
    if (!timer) {
        timerStart = Date.now() - gameTime;
        timer = setInterval(updateTimer, 33);
    }

    // Start background music or lonely store low drone
    try {
        if (isLonelyStoreMode) {
            if (music) music.pause();
            if (soundEffects && soundEffects.lowDrone) {
                soundEffects.lowDrone.volume = 1.0;
                soundEffects.lowDrone.currentTime = 0;
                soundEffects.lowDrone.play().catch(() => {});
            }
            startLonelyStoreOminousNotifs();
        } else {
            if (soundEffects && soundEffects.lowDrone) {
                try { soundEffects.lowDrone.pause(); soundEffects.lowDrone.currentTime = 0; } catch(_) {}
            }
            stopLonelyStoreOminousNotifs();
            if (music) {
                music.muted = musicMuted;
                pauseOtherMusic(music);
                safePlayExt(music);
            }
        }
    } catch (e) {
        console.warn("Could not play audio:", e);
        document.addEventListener('click', () => {
            if (isLonelyStoreMode) {
                if (soundEffects && soundEffects.lowDrone) soundEffects.lowDrone.play().catch(() => {});
            } else if (music) {
                music.play().catch(() => {});
            }
        }, { once: true });
    }

    if (shouldPlayIntroCutscene()) {
        startIntroCutscene();
    } else {
        // Direct consistent spawn at door facing the back of the store
        if (playerBody) {
            playerBody.position.set(0, 1.0, -26.0);
            playerBody.velocity.set(0, 0, 0);
        }
        if (camera) {
            camera.position.set(0, 2.6, -26.0);
            camera.rotation.set(0, Math.PI, 0);
            syncCameraAngles(Math.PI, 0);
        }
        if (cartObject) {
            cartObject.visible = true;
            cartObject.position.set(0, 0, -24.5);
            cartObject.rotation.set(0, 0, 0);
        }
        cartAttached = true;

        // Lock controls safely
        if (controls && !controls.isLocked) { try { controls.lock(); } catch (_) {} }
    }

    scheduleRandomEvents();
    scheduleShoppingListUpdates();
    startEventRerollCycle();
    startCartBabyActionSchedule();

    // Ensure indicator shows at gameplay start if a powerup was rolled, otherwise hide
    if (currentPowerup) {
        showPowerupIndicator();
    } else {
        hidePowerupIndicator();
    }

    controls?.addEventListener('lock', () => {
        if (suppressLockMessage) {
            // Skip the usual "start shopping" helper once after certain dialogs (e.g., manager)
            suppressLockMessage = false;
            return;
        }
        if (!initialFindItemsMessageShown && gameStarted && !isCheckout && !gameOver && !introCutsceneActive) {
            initialFindItemsMessageShown = true;
            displayMessage("Find all the items on your list and head to checkout!", 3000);
        }
    });

    controls?.addEventListener('unlock', () => {
        if (gameStarted && !isCheckout && !gameOver) {
            // Removed: no on-screen message on pause/unlock per spec
        }
    });
}

function scheduleShoppingListUpdates() {
    if (isLonelyStoreMode) return;
    if (addItemIntervalId) clearInterval(addItemIntervalId);
    addItemIntervalId = setInterval(() => {
        if (!gameStarted || isCheckout || gameOver || isLonelyStoreMode || purchaseComplete) return;
        if (Math.random() * 100 < CONFIG.ADD_ITEM_CHANCE) {
            addItemToShoppingList();
        }
    }, 1000);

    if (removeItemIntervalId) clearInterval(removeItemIntervalId);
    removeItemIntervalId = setInterval(() => {
        if (!gameStarted || isCheckout || gameOver || isLonelyStoreMode || purchaseComplete || shoppingList.length <= 1) return;
        if (Math.random() * 100 < CONFIG.REMOVE_ITEM_CHANCE) {
            removeItemFromShoppingList();
        }
    }, 1000);
}

function addItemToShoppingList() {
    if (isLonelyStoreMode || purchaseComplete) return;
    if (ITEMS.length <= shoppingList.length) return; // Don't add if all items are already listed

    const availableItemsForList = ITEMS.filter(item => item && item.name !== 'Gum' && !shoppingList.some(listItem => listItem?.name === item?.name));
    if (availableItemsForList.length === 0) return;

    const newItem = availableItemsForList[Math.floor(Math.random() * availableItemsForList.length)];
    shoppingList.push({
        name: newItem.name,
        quantity: 1,
        collected: 0
    });
    updateShoppingListDisplay();
    displayMessage(`You just remembered that you needed ${newItem.name}!`, CONFIG.NOTIFICATION_DURATION, true);
    itemAddedEventCount++;
    logRunEvent(`📝 ${newItem.name} added to your list`);
    
    // Play item added sound
    soundEffects.itemAddedToList.currentTime = 0;
    soundEffects.itemAddedToList.play();
}

function removeItemFromShoppingList() {
    if (isLonelyStoreMode || purchaseComplete) return;
    if (shoppingList.length <= 1) return; // Keep at least one item on the list

    const itemToRemoveIndex = Math.floor(Math.random() * shoppingList.length);
    const removedItemName = shoppingList[itemToRemoveIndex].name;
    itemsRemovedFromShoppingList.add(removedItemName);
    shoppingList.splice(itemToRemoveIndex, 1);
    updateShoppingListDisplay();
    displayMessage(`You changed your mind on needing ${removedItemName}. It has been removed.`, CONFIG.NOTIFICATION_DURATION, true);
    itemRemovedEventCount++;
    logRunEvent(`✂️ ${removedItemName} removed from your list`);

    // Play item removed sound
    soundEffects.itemRemoved.currentTime = 0;
    soundEffects.itemRemoved.play();
}

function currency(n) {
    try { return '$' + (Math.round(n * 100) / 100).toFixed(2); } catch (_) { return '$0.00'; }
}
function getItemIcon(name) {
    // Simple high-res emoji/icon mapping as vector-like placeholder
    const map = {
        'Milk':'🥛','Bread':'🍞','Eggs':'🥚','Cereal':'🥣','Apples':'🍎','Bananas':'🍌',
        'Cleaning Supplies':'🧴','Soda':'🥤','Pasta':'🍝','Pasta Sauce':'🥫','Water bottles':'💧',
        'Sugar':'🧂','Towels':'🧻','Peanut Butter':'🥜','Steak':'🥩','Chicken':'🍗',
        'Potatoes':'🥔','Canned Goods':'🥫','Gum':'🍬','2 in 1 Item':'✳️',
        'Toilet paper':'🧻','Ice Cream':'🍨','Shampoo':'🧴','Orange Juice':'🍊',
        'Lettuce':'🥬','Grapes':'🍇','Cooking oil':'🫒','Pizza':'🍕',
        'Ketchup':'🍅','Mustard':'🌭','Batteries':'🔋','Dog food':'🐶',
        'Cheese':'🧀','Pants':'👖','Toys':'🧸','Chocolate bars':'🍫',
        'Watermelon':'🍉','Flowers':'💐','Coffee':'☕',
        'Shredder':'🗑️','Cleaning supplies':'🧴','spinning top':'🪀'
    };
    return map[name] || '🛒';
}
// Price cache per game session
let priceBook = new Map();
function derivePriceForItem(name) {
    if (priceBook.has(name)) return priceBook.get(name);
    // Base by category
    const base = {
        'Milk':2.99,'Bread':2.49,'Eggs':3.49,'Cereal':4.99,'Apples':1.29,'Bananas':0.79,
        'Cleaning Supplies':5.49,'Soda':1.49,'Pasta':1.99,'Pasta Sauce':3.29,'Water bottles':3.99,
        'Sugar':2.19,'Towels':2.99,'Peanut Butter':3.99,'Steak':12.99,'Chicken':8.99,
        'Potatoes':3.49,'Canned Goods':1.49,'Gum':1.29,'2 in 1 Item':0.00
    }[name] ?? 2.5;
    const price = Math.max(0.5, base * (0.9 + Math.random()*0.2)); // ±10%
    priceBook.set(name, price);
    return price;
}
function computeTotals(list, onlyScanned = false) {
    let subtotal = 0;
    list.forEach(row => {
        if (onlyScanned && !row.scanned) return;
        subtotal += row.price * row.qty;
    });
    const tax = subtotal * 0.07;
    const total = subtotal + tax;
    return { subtotal, tax, total };
}

let gumCravingActive = false;
let gumCravingSatisfied = false;
let gumCravingTimeoutId = null;
let gumCravingEvaluatedThisGame = false;
let checkoutExitCooldownUntil = 0;

function hasGumInCart() {
    return collectedItems.some(i => i && i.inCart && (i.name === 'Gum' || i.isCheckoutGum));
}

function refreshGumCravingState() {
    if (!gumCravingActive) return;
    gumCravingSatisfied = hasGumInCart();
    if (gumCravingSatisfied) {
        showGumCravingBanner("✨ Craving Satisfied! Chewing Gum is in your cart!", true);
    } else {
        showGumCravingBanner("🍬 Put Chewing Gum in your cart before checking out.");
    }
}

function showGumCravingBanner(msg, isSatisfied = false) {
    const banner = document.getElementById('gum-craving-banner');
    if (!banner) return;
    banner.textContent = msg;
    banner.className = 'gum-craving-banner visible' + (isSatisfied ? ' satisfied' : '');
}

function triggerGumCraving() {
    if (gameOver || purchaseComplete) return;
    gumCravingTriggered = true;
    gumCravingActive = true;
    gumCravingEvaluatedThisGame = true;
    
    refreshGumCravingState();
    if (!gumCravingSatisfied) {
        try {
            if (soundEffects.itemAddedToList) {
                soundEffects.itemAddedToList.currentTime = 0;
                soundEffects.itemAddedToList.play().catch(() => {});
            }
        } catch(_) {}
        displayMessage("🍬 You're craving Gum! Put a pack from the checkout rack in your cart.", 4500, true);
        if (isCheckout) {
            teardownCheckoutPanel();
            isCheckout = false;
            checkoutExitCooldownUntil = Date.now() + 2500;
        }
    }
    
    // Refresh checkout confirm button state
    const confirmBtn = document.getElementById('btn-confirm');
    const listEl = document.getElementById('checkout-list');
    if (confirmBtn && listEl) {
        const rows = Array.from(listEl.querySelectorAll('.checkout-row'));
        const allScanned = rows.length > 0 && rows.every(r => r.classList.contains('scanned'));
        const cravingOk = (!gumCravingActive || hasGumInCart());
        confirmBtn.disabled = !allScanned || !cravingOk;
    }
}

function buildCheckoutPanel() {
    // Build modern panel markup inside #checkout-ui
    checkoutUIElement.innerHTML = `
      <div class="checkout-panel">
        <div class="checkout-glow"></div>
        <div class="checkout-header">
          <div class="terminal-icon">🧾</div>
          <div class="checkout-title">Checkout</div>
          <div class="checkout-sub" id="checkout-progress">0 / 0 scanned</div>
        </div>
        <div id="checkout-busy-banner" class="hidden"></div>
        <div id="gum-craving-banner" class="gum-craving-banner"></div>
        <div class="checkout-list" id="checkout-list"></div>
        <div class="checkout-totals">
          <div class="total-line"><span class="label">Subtotal</span><span id="co-subtotal">$0.00</span></div>
          <div class="total-line"><span class="label">Tax (7%)</span><span id="co-tax">$0.00</span></div>
          <div class="total-line total"><span class="label">TOTAL</span><span id="co-total">$0.00</span></div>
        </div>
        <div class="checkout-actions">
          <button class="btn btn-secondary" id="btn-cancel">Cancel</button>
          <button class="btn btn-primary" id="btn-confirm" disabled>Confirm Purchase</button>
        </div>
        <div class="checkout-footer-note">Thank you for shopping at MagMart!</div>
      </div>
    `;
    checkoutUIElement.classList.remove('hidden');
    checkoutUIElement.classList.add('visible');
}

function teardownCheckoutPanel() {
    if (gumCravingTimeoutId) {
        clearTimeout(gumCravingTimeoutId);
        gumCravingTimeoutId = null;
    }
    checkoutUIElement.classList.remove('visible');
    checkoutUIElement.classList.add('hidden');
    // Don't clear innerHTML immediately (allow CSS fade); clear in a tick
    setTimeout(() => { checkoutUIElement.innerHTML = ''; }, 200);
}

function updateCheckoutTotalsFromRows(rows) {
    const { subtotal, tax, total } = computeTotals(rows, false);
    const subEl = document.getElementById('co-subtotal');
    const taxEl = document.getElementById('co-tax');
    const totEl = document.getElementById('co-total');
    if (subEl) subEl.textContent = currency(subtotal);
    if (taxEl) taxEl.textContent = currency(tax);
    if (totEl) totEl.textContent = currency(total);
}

// Scan beeps come from a small pool of clones so rapid scanning (Crazy Scanner
// sweeps) never has to seek/restart one shared audio element per row.
const scanBeepPool = [];
let scanBeepIndex = 0;
let lastScanBeepAt = 0;
function playScanBeep() {
    const base = soundEffects?.checkoutScan;
    if (!base) return;
    const now = performance.now();
    if (now - lastScanBeepAt < 45) return; // beeps closer than this blur together anyway
    lastScanBeepAt = now;
    try {
        if (scanBeepPool.length === 0 || scanBeepPool[0].src !== base.src) {
            scanBeepPool.length = 0;
            for (let i = 0; i < 4; i++) scanBeepPool.push(base.cloneNode());
        }
        const beep = scanBeepPool[scanBeepIndex];
        scanBeepIndex = (scanBeepIndex + 1) % scanBeepPool.length;
        beep.volume = base.volume;
        beep.muted = base.muted;
        if (!beep.paused) beep.pause();
        beep.currentTime = 0;
        beep.play().catch(() => {});
    } catch (_) {}
}

function wireCheckoutRowScanning(rows) {
    const progressEl = document.getElementById('checkout-progress');
    const confirmBtn = document.getElementById('btn-confirm');
    let progressFrame = 0;
    const updateProgress = () => {
        progressFrame = 0;
        let scanned = 0;
        for (const r of rows) if (r.scanned) scanned++;
        if (progressEl) progressEl.textContent = `${scanned} / ${rows.length} scanned`;
        const allScanned = (scanned === rows.length);
        const cravingOk = (!gumCravingActive || hasGumInCart());
        if (confirmBtn) confirmBtn.disabled = !allScanned || !cravingOk;
    };
    // Coalesce many scans in one frame into a single DOM update.
    const queueProgress = () => { if (!progressFrame) progressFrame = requestAnimationFrame(updateProgress); };
    const scanRow = (r, scanned) => {
        r.scanned = scanned;
        r.el.classList.toggle('scanned', scanned);
        playScanBeep();
    };
    rows.forEach(r => {
        r.el.addEventListener('click', () => {
            if (checkoutBusyActive) {
                displayMessage("Please wait until the register is free.", 1500);
                return;
            }
            if (crazyScannerActive && r.scanned) return;
            scanRow(r, !r.scanned);
            if (progressFrame) { cancelAnimationFrame(progressFrame); }
            updateProgress();
        });
        // Crazy Scanner: sweeping the pointer over a row scans it.
        r.el.addEventListener('pointerenter', () => {
            if (checkoutBusyActive || !crazyScannerActive || r.scanned) return;
            scanRow(r, true);
            queueProgress();
        }, { passive: true });
    });
    updateProgress();
}

function populateCheckoutList() {
    const listEl = document.getElementById('checkout-list');
    if (!listEl) return [];
    // Build rows from collectedItems (flatten by name with quantities)
    const map = new Map();
    collectedItems.forEach(ci => {
        const key = `${ci.name}:${ci.isManagerGift ? 'gift' : 'regular'}`;
        const entry = map.get(key) || { name: ci.name, gift: !!ci.isManagerGift, qty: 0 };
        entry.qty += 1;
        map.set(key, entry);
    });
    const rows = [];
    listEl.innerHTML = '';
    Array.from(map.values()).forEach(entry => {
        const price = entry.gift ? 0 : derivePriceForItem(entry.name);
        const row = document.createElement('div');
        row.className = 'checkout-row';
        row.innerHTML = `
            <div class="checkout-icon"><span>${getItemIcon(entry.name)}</span></div>
            <div class="checkout-name">${entry.name}${entry.gift ? ' (Gift)' : ''}</div>
            <div class="checkout-qty">x${entry.qty}</div>
            <div class="checkout-price">${currency(price * entry.qty)}</div>
        `;
        listEl.appendChild(row);
        rows.push({ name: entry.name, qty: entry.qty, price, el: row, scanned: false });
    });
    updateCheckoutTotalsFromRows(rows);
    wireCheckoutRowScanning(rows);
    return rows;
}

function startCheckoutProcess() {
    if (isCheckout || gameOver || purchaseComplete) return;
    if (checkoutButtonRequired && checkoutButton && !checkoutButton.pressed) {
        if (!checkoutButtonAlertShown) {
            displayMessage("The checkout machine is off. Please press the green button!", 3000, true);
            checkoutButtonAlertShown = true;
        }
        return;
    }

    if (collectedItems.length === 0) {
        displayMessage("Your cart is empty! Collect items from the aisles first.", 2500);
        return;
    }

    if (gumCravingActive && !hasGumInCart()) {
        gumCravingSatisfied = false;
        displayMessage("🍬 Put Chewing Gum in your cart before checking out.", 2500, true);
        checkoutExitCooldownUntil = Date.now() + 3000;
        return;
    }

    // Check if checkout register is occupied by busy customer
    if (checkoutBusyActive) {
        displayMessage("A customer is currently checking out at the register. Please wait your turn!", 2500, true);
        checkoutExitCooldownUntil = Date.now() + 2000;
        return;
    }

    // Evaluate Busy Checkout event chance if not yet evaluated
    if (!checkoutBusyEvaluatedThisGame) {
        checkoutBusyEvaluatedThisGame = true;
        const triggerBusy = Math.random() * 100 < plus5PercentPercent(CONFIG.CHECKOUT_BUSY_CHANCE ?? 25);
        if (triggerBusy) {
            startWorldBusyCheckout();
            return;
        }
    }

    // Check if gum craving is active and satisfied
    refreshGumCravingState();

    if (noMoneyForGroceries) { walletFailed = true; endGame(); return; }
    if (tweakerMoneyRisk) { tweakerMoneyFailure = true; endGame(); return; }

    isCheckout = true;
    controls.unlock();

    // Start sound effect for terminal (already plays cash register)
    soundEffects.cashRegister.currentTime = 0;
    soundEffects.cashRegister.play();

    // Build modern panel and populate
    buildCheckoutPanel();

    if (gumCravingActive) {
        refreshGumCravingState();
    } else if (!gumCravingEvaluatedThisGame) {
        // Start 5-second timer at checkout: if player takes 5 seconds, craving chance is evaluated
        if (gumCravingTimeoutId) {
            try { clearTimeout(gumCravingTimeoutId); } catch(_) {}
            gumCravingTimeoutId = null;
        }
        gumCravingTimeoutId = setTimeout(() => {
            gumCravingTimeoutId = null;
            if (!isCheckout || gameOver || purchaseComplete) return;
            gumCravingEvaluatedThisGame = true;
            const cravingChance = Number.isFinite(CONFIG.GUM_CRAVING_CHANCE) ? CONFIG.GUM_CRAVING_CHANCE : 35;
            if (Math.random() * 100 < plus5PercentPercent(cravingChance)) {
                triggerGumCraving();
            }
        }, 5000);
    }

    const checkoutRows = populateCheckoutList();

    // Wire buttons
    const btnCancel = document.getElementById('btn-cancel');
    const btnConfirm = document.getElementById('btn-confirm');

    if (btnCancel) {
        btnCancel.onclick = () => {
            // Cancel checkout: close panel, resume controls, and prevent instant re-open
            teardownCheckoutPanel();
            isCheckout = false;
            gamePaused = false;
            checkoutExitCooldownUntil = Date.now() + 2500;
            try { controls.lock(); } catch(_) {}
            if (gumCravingActive && !hasGumInCart()) {
                displayMessage("🍬 Exited checkout. Grab your Gum from the counter rack, then step back up to the register!", 3000, true);
            } else {
                displayMessage("Exited checkout. Step up to the register when ready!", 2000);
            }
        };
    }

    if (btnConfirm) {
        btnConfirm.onclick = () => {
            if (purchaseComplete) return;
            // Check gum craving requirement
            if (gumCravingActive && !hasGumInCart()) {
                displayMessage("🍬 Put Chewing Gum in your cart to satisfy your craving!", 2500, true);
                return;
            }
            // ensure all scanned
            const allScanned = checkoutRows.every(r => r.scanned);
            if (!allScanned) {
                displayMessage("Scan all items to confirm purchase.", 2000);
                return;
            }
            purchaseComplete = true;
            logRunEvent('💳 Paid for your groceries');
            btnConfirm.disabled = true;
            // subtle receipt calc sound already used; add small delay for effect
            setTimeout(() => {
                completeGroceryPurchase();
            }, 350);
        };
    }

    // Show overlay
    checkoutUIElement.classList.add('visible');
}

// Popups that stop the player (customer question, manager, tweaker, checkout,
// pause, leaderboard). While any is open the player is pinned in place.
function isUiPopupOpen() {
    if (!gameStarted || gameOver) return false;
    if (isCheckout || gamePaused || customerInteractionMessageVisible || managerQuestionVisible || tweakerRequestOpen) return true;
    const lb = document.getElementById('leaderboard-menu');
    return !!(lb && lb.style.display === 'block');
}
let uiFreezePos = null;
let clearHeldKeys = () => {};
function pinPlayerDuringPopup() {
    if (!playerBody) return;
    if (!isUiPopupOpen()) { uiFreezePos = null; return; }
    if (!uiFreezePos) {
        uiFreezePos = { x: playerBody.position.x, z: playerBody.position.z };
        // Drop held keys so the player doesn't walk off when the popup closes.
        clearHeldKeys();
    }
    playerBody.position.x = uiFreezePos.x;
    playerBody.position.z = uiFreezePos.z;
    playerBody.velocity.x = 0;
    playerBody.velocity.z = 0;
    playerBody.aabbNeedsUpdate = true;
}

// NEW: Global guard for rare customer question event
let customerQuestionInProgress = false;
let customerQuestionActor = null;

function showCustomerInteractionMessage() {
    customerQuestionsCount++;
    logRunEvent('🙋 A customer asked if you work here');
    customerInteractionMessageVisible = true;
    gamePaused = true;
    controls.unlock();

    // Create message container
    const messageContainer = document.createElement('div');
    messageContainer.id = 'customer-interaction-message';

    // Message title
    const messageTitle = document.createElement('h3');
    messageTitle.style.fontWeight = 'bold';
    messageTitle.textContent = 'A CUSTOMER ASKED';
    messageContainer.appendChild(messageTitle);

    // Message text
    const messageText = document.createElement('p');
    messageText.textContent = 'Hi, do you work here?';
    messageContainer.appendChild(messageText);

    // Button to close
    const closeButton = document.createElement('button');
    closeButton.textContent = 'No sorry.';
    closeButton.addEventListener('click', () => {
        hideCustomerInteractionMessage();
    });
    messageContainer.appendChild(closeButton);

    // Append to game container
    document.getElementById('game-container').appendChild(messageContainer);
}

function hideCustomerInteractionMessage() {
    customerInteractionMessageVisible = false;
    gamePaused = false;
    const messageContainer = document.getElementById('customer-interaction-message');
    if (messageContainer) {
        messageContainer.remove();
    }
    // After interaction, resume actor pathfinding and walk away
    if (customerQuestionActor) {
        customerQuestionActor.interacting = false;
        customerQuestionActor.behaviorState = 'navigating';
        // set a new target away from player
        const awayAngle = Math.atan2(customerQuestionActor.body.position.z - (playerBody?.position.z || 0), customerQuestionActor.body.position.x - (playerBody?.position.x || 0));
        const dist = 6 + Math.random() * 6;
        const ax = customerQuestionActor.body.position.x + Math.cos(awayAngle) * dist;
        const az = customerQuestionActor.body.position.z + Math.sin(awayAngle) * dist;
        const pt = navGrid ? clampToWalkable(navGrid, ax, az) : { x: ax, z: az };
        customerQuestionActor.nav = customerQuestionActor.nav || {};
        customerQuestionActor.nav.target = new THREE.Vector3(pt.x, 0, pt.z);
        customerQuestionActor.nav.path = findPath(navGrid, { x: customerQuestionActor.body.position.x, z: customerQuestionActor.body.position.z }, { x: pt.x, z: pt.z });
        customerQuestionActor.nav.waypointIdx = 0;
        customerQuestionActor.nextQuestionAt = performance.now() + (120000 + Math.random() * 60000); // schedule next far in future
        customerQuestionActor = null;
        customerQuestionInProgress = false;
    }
    try { controls.lock(); } catch (_) {} // Just lock controls without restarting game
}

function resumeGame() {
    gamePaused = false;
    if (document.getElementById('trunk-loading')) return;
    if (controls && !controls.isLocked) {
        try { controls.lock(); } catch(_) {}
    }
}

function togglePause() {
    gamePaused = !gamePaused;

    if (gamePaused) {
        controls?.unlock();
        PauseMenu.show();
    } else {
        PauseMenu.hide();
        resumeGame();
    }
}

function showPauseMenu() {
    PauseMenu.show();
}
function hidePauseMenu() {
    PauseMenu.hide();
}

// ---------------- UNIFIED CIRCULAR RING NOTIFICATION HUB ----------------
let nextToastRingIdx = 0;
// Positions distributed in a circular/oval ring around the center of the screen
const TOAST_RING_POSITIONS = [
    { x: '50%', y: '22%', tilt: '-2.0deg' },  // Top
    { x: '68%', y: '26%', tilt: '+2.4deg' },  // Top-Right
    { x: '78%', y: '48%', tilt: '-1.8deg' },  // Right
    { x: '68%', y: '70%', tilt: '+2.2deg' },  // Bottom-Right
    { x: '50%', y: '76%', tilt: '-2.5deg' },  // Bottom
    { x: '32%', y: '70%', tilt: '+1.9deg' },  // Bottom-Left
    { x: '22%', y: '48%', tilt: '-2.2deg' },  // Left
    { x: '32%', y: '26%', tilt: '+2.6deg' },  // Top-Left
];
const activeToastsList = [];

function clearAllAlertsAndNotifications() {
    activeToastsList.forEach((entry) => {
        if (entry.timerId) clearTimeout(entry.timerId);
        if (entry.el && entry.el.parentNode) entry.el.remove();
    });
    activeToastsList.length = 0;
    
    // Clear any banners in alerts overlay
    const overlay = document.getElementById('alerts-overlay');
    if (overlay) {
        overlay.innerHTML = '';
    }
    
    const msgEl = document.getElementById('message');
    if (msgEl) msgEl.textContent = '';
    if (rngNotificationsElement) {
        rngNotificationsElement.classList.remove('notification-visible');
        rngNotificationsElement.textContent = '';
    }
    const pt = document.getElementById('pickup-text');
    if (pt) pt.remove();
}

function displayRngNotification(message, duration = 3500) {
    if (!message) return;
    if (isLonelyStoreMode) return;
    displayMessage(message, duration, true);
}

function displayMessage(message, duration = 2400, isRngEvent = false, isAllowedInLonelyStore = false, isOminous = false) {
    if (mainMenuVisible || !message) return;
    if (isLonelyStoreMode && !isAllowedInLonelyStore) return;
    if (Nuke.isWorldFrozen()) return;
    const overlay = document.getElementById('alerts-overlay');
    if (!overlay) return;

    // Limit active visible toasts in the ring area to 4 at once
    while (activeToastsList.length >= 4) {
        const oldest = activeToastsList.shift();
        if (oldest) {
            if (oldest.timerId) clearTimeout(oldest.timerId);
            if (oldest.el && oldest.el.parentNode) oldest.el.remove();
        }
    }

    const pos = TOAST_RING_POSITIONS[nextToastRingIdx % TOAST_RING_POSITIONS.length];
    nextToastRingIdx++;

    const el = document.createElement('div');
    let toastClass = 'game-toast-alert';
    if (isOminous) {
        toastClass += ' ominous-toast';
    } else if (isRngEvent) {
        toastClass += ' rng-toast';
    }
    el.className = toastClass;
    el.style.left = pos.x;
    el.style.top = pos.y;
    el.style.setProperty('--tilt', pos.tilt);
    el.textContent = message;
    overlay.appendChild(el);

    const showDuration = Math.max(1800, duration || 2400);

    const entry = { el, timerId: null };
    entry.timerId = setTimeout(() => {
        el.classList.add('leaving');
        setTimeout(() => {
            if (el && el.parentNode) el.remove();
            const idx = activeToastsList.indexOf(entry);
            if (idx > -1) activeToastsList.splice(idx, 1);
        }, 240);
    }, showDuration);

    activeToastsList.push(entry);
}

function resetGame(message) {
    if (message) {
        alert(message);
    }
    restartGameCold();
}

// NEW: Full cold restart that completely reloads a fresh game instance
function restartGameCold() {
    clearAllAlertsAndNotifications();

    // Show loading overlay with reloading message
    showLoadingScreen('Reloading Store...');

    // Ensure any in-progress UI is closed
    PauseMenu.hide();

    // Fully stop current session (audio, timers, physics, renderer, handlers, overlays)
    hardStopGame();
    stopMenuMusic();
    // Also explicitly stop fail music
    stopFailMusic();

    // Start fresh after a short tick to allow the DOM overlay to render
    setTimeout(() => {
        // Do not force default config here; preserve current settings/custom mode.
        // Hide main menu (we want immediate gameplay after restart)
        try { hideMainMenu(); } catch (_) {}

        // Lock pointer on fresh start for seamless resume feel
        lockOnStart = true;

        // Build a brand-new game instance with fresh RNG and environment
        startNewGame();
    }, 50);
}

function showPickupText(itemName) {
    displayMessage(`Picked up ${itemName}`, 1500);
}

// ---------------- LINE-OF-SIGHT & OCCLUSION CHECKING ----------------
const _occlItemPos = new THREE.Vector3();
const _occlFrontDir = new THREE.Vector3();
const _occlToCam = new THREE.Vector3();
const _occlUpAxis = new THREE.Vector3(0, 1, 0);
function isItemOccludedByCart(targetItem, ray) {
    if (!cart3D || !cartObject) return false;
    // If the item is already inside the cart, it's not occluded by the cart when looking into the cart
    if (targetItem.inCart) return false;

    // Check intersection with cart3D
    const cartHits = ray.intersectObject(cart3D, true);
    if (cartHits.length === 0) return false;

    const itemWorldPos = targetItem.mesh.getWorldPosition(_occlItemPos);
    const itemDistance = camera.position.distanceTo(itemWorldPos);

    // Items on the floor or near the player shouldn't be blocked by see-through cart wireframe / handle
    if (itemWorldPos.y < 0.45 && itemDistance < 2.5) {
        return false;
    }

    // If the cart is closer than the item, the cart is physically blocking the ray
    if (cartHits[0].distance < itemDistance - 0.12) {
        return true;
    }

    return false;
}

function isItemOccludedByShelfBack(targetItem, ray) {
    if (targetItem.inCart) return false;
    // If item is no longer on a shelf (e.g. fallen on floor, dynamic physics body, or parented to scene), shelf backs don't occlude it
    if (targetItem.body || !targetItem.isStatic || (targetItem.mesh && targetItem.mesh.parent === scene)) {
        return false;
    }

    // Find the shelf unit that contains this item
    let parentShelfUnit = null;
    for (const unit of shelfUnits) {
        if (unit.userData && unit.userData.items && unit.userData.items.includes(targetItem)) {
            parentShelfUnit = unit;
            break;
        }
    }

    if (parentShelfUnit && parentShelfUnit.userData) {
        // Compute front direction vector of the shelf unit in world space
        const dirSign = parentShelfUnit.userData.direction || 1;
        const frontDir = _occlFrontDir.set(0, 0, dirSign)
            .applyAxisAngle(_occlUpAxis, parentShelfUnit.rotation.y)
            .normalize();

        const toCam = _occlToCam.subVectors(camera.position, parentShelfUnit.position);
        toCam.y = 0;

        // If the player camera is standing behind the shelf's solid back panel
        const dot = toCam.dot(frontDir);
        if (dot < -0.15) {
            return true; // Blocked: cannot grab from behind solid shelf back
        }
    }

    // Also check if any shelf back panel is directly between the camera and the item
    const itemDistance = camera.position.distanceTo(targetItem.mesh.getWorldPosition(_occlItemPos));

    for (const unit of shelfUnits) {
        if (unit === parentShelfUnit) continue;
        const hits = ray.intersectObject(unit, true);
        if (hits.length > 0 && hits[0].distance < itemDistance - 0.25) {
            return true;
        }
    }

    return false;
}

function isItemAccessible(targetItem, ray) {
    if (!targetItem || !targetItem.mesh || !targetItem.mesh.parent) return false;
    if (targetItem.inCustomerCart || targetItem.isCustomerHeld) return false;

    // 1. Check if blocked behind a closed freezer door (< 0.30 rad ~ 17 deg)
    if (targetItem.freezerDoor && targetItem.freezerDoor.currentAngle < 0.30) {
        return false;
    }

    // 2. Check if blocked through the shopping cart
    if (isItemOccludedByCart(targetItem, ray)) {
        return false;
    }

    // 3. Check if blocked through solid back of shelves
    if (isItemOccludedByShelfBack(targetItem, ray)) {
        return false;
    }

    return true;
}

const _reachTmpVec = new THREE.Vector3();
const _reachToItem = new THREE.Vector3();
const _reachZeroDir = new THREE.Vector3();
// Scratch buffers reused across calls (this runs every few frames).
const _reachCandidates = [];   // { item, x, y, z, dist }
const _reachMeshToItem = new Map();
const _reachMeshes = [];
function findAccessibleItemUnderCrosshair(ray, maxReach) {
    // PERF: only raycast against items actually within reach (recursive raycasts
    // against every product in the store were a major per-frame cost).
    // Each candidate's world position is computed once and shared by both passes.
    const reachSq = (maxReach + 1.0) * (maxReach + 1.0);
    const camPos = camera.position;
    _reachCandidates.length = 0;
    _reachMeshes.length = 0;
    _reachMeshToItem.clear();
    for (let i = 0; i < allItems.length; i++) {
        const item = allItems[i];
        if (item.inCustomerCart || item.isCustomerHeld || !item.mesh || !item.mesh.parent || item === heldItem) continue;
        item.mesh.getWorldPosition(_reachTmpVec);
        const distSq = _reachTmpVec.distanceToSquared(camPos);
        if (distSq > reachSq) continue;
        _reachMeshes.push(item.mesh);
        if (!_reachMeshToItem.has(item.mesh)) _reachMeshToItem.set(item.mesh, item);
        _reachCandidates.push({ item, x: _reachTmpVec.x, y: _reachTmpVec.y, z: _reachTmpVec.z, dist: Math.sqrt(distSq) });
    }

    // 1. Direct raycast intersection check against item 3D meshes
    const intersections = ray.intersectObjects(_reachMeshes, true);
    for (let i = 0; i < intersections.length; i++) {
        let obj = intersections[i].object;
        let intersectedItem = null;
        while (obj && !intersectedItem) { intersectedItem = _reachMeshToItem.get(obj) || null; obj = obj.parent; }
        if (intersectedItem && isItemAccessible(intersectedItem, ray)) {
            intersectedItem.mesh.getWorldPosition(_reachTmpVec);
            if (camPos.distanceTo(_reachTmpVec) <= maxReach) return intersectedItem;
        }
    }

    // 2. Proximity cone check: ensures small items on the floor / shelves (especially after tripping/dropping) can be grabbed effortlessly
    let bestItem = null;
    let closestPerpDist = 0.48; // Max 48cm perpendicular radius from center ray
    const rayDir = ray.ray ? ray.ray.direction : _reachZeroDir;

    for (let i = 0; i < _reachCandidates.length; i++) {
        const c = _reachCandidates[i];
        const it = c.item;
        if (!it.mesh.visible) continue;
        const distToCam = c.dist;
        if (distToCam > maxReach || distToCam < 0.2) continue;

        _reachToItem.set(c.x - camPos.x, c.y - camPos.y, c.z - camPos.z);
        const dot = _reachToItem.dot(rayDir);
        if (dot <= 0.1) continue;

        // Perpendicular distance from the center ray
        const perpDist = _reachToItem.addScaledVector(rayDir, -dot).length();

        const isFloorOrDropped = (c.y < 0.65 || it.body != null || it.isDropping);
        const threshold = isFloorOrDropped ? 0.55 : 0.38;

        if (perpDist < threshold && perpDist < closestPerpDist) {
            if (isItemAccessible(it, ray)) {
                closestPerpDist = perpDist;
                bestItem = it;
            }
        }
    }

    return bestItem;
}

function grabItem() {
    if (heldItem) return;
    if (wifeCallRinging) {
        displayMessage("📱 Cannot grab items while the phone is ringing! Answer or decline first.", 2000, true);
        return;
    }

    // Reuse shared raycaster/vector
    camera.getWorldDirection(sharedVec3);
    sharedRaycaster.set(camera.position, sharedVec3);

    // NEW: extendo arm unlimited reach flag (for grabbing only)
    const unlimitedReach = powerupActive && currentPowerup === 'extendo_arm';
    const maxReach = unlimitedReach ? Infinity : (CONFIG.ARM_REACH * 1.8);

    // Check for 3D Leaderboard Stand interaction
    if (leaderboardStandGroup) {
        const standIntersection = sharedRaycaster.intersectObject(leaderboardStandGroup, true);
        if (standIntersection.length > 0) {
            const distance = standIntersection[0].distance;
            if (distance <= (unlimitedReach ? Infinity : CONFIG.ARM_REACH * 2.0)) {
                showLeaderboardMenu();
                controls?.unlock();
                return;
            }
        }
    }

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
                return;
            }
        }
    }

    const intersectedItem = findAccessibleItemUnderCrosshair(sharedRaycaster, maxReach);

    if (intersectedItem && allItems.includes(intersectedItem)) {
        const wasInCart = intersectedItem.inCart;

        // Cannot grab/remove items from INSIDE the cart while attached to the cart
        if (wasInCart && cartAttached) {
            try {
                if (soundEffects.wrongItem) {
                    soundEffects.wrongItem.currentTime = 0;
                    soundEffects.wrongItem.play();
                }
            } catch(_) {}
            displayMessage("Detach from your cart to take items out! (Press F)", 2200, true);
            return;
        }

        if (wasInCart) {
            // Remove from cart collection
            const cIdx = collectedItems.indexOf(intersectedItem);
            if (cIdx !== -1) collectedItems.splice(cIdx, 1);
            intersectedItem.inCart = false;
            refreshGumCravingState();
            // If it was on list, decrement list count
            if (!intersectedItem.isTwoInOne) {
                const listEntry = shoppingList.find(listItem => listItem.name === intersectedItem.name);
                if (listEntry && listEntry.collected > 0) {
                    listEntry.collected = Math.max(0, listEntry.collected - 1);
                    updateShoppingListDisplay();
                } else {
                    // It was a wrong item taken out of the cart
                    wrongItemsGrabbedCount = Math.max(0, wrongItemsGrabbedCount - 1);
                }
            }
            if (powerupActive && currentPowerup === 'eagle_eye') {
                clearEagleEyeOutlines();
                applyEagleEyeOutlines();
            }
        }

        const itemWorldPos = new THREE.Vector3();
        intersectedItem.mesh.getWorldPosition(itemWorldPos);

        heldItem = intersectedItem;
        heldItem.isStatic = false;
        heldItem.inCart = false;
        heldItem.isDropping = false;
        heldItem.hasLanded = false;

        // Move mesh from cart3D/parent to scene for free holding
        if (heldItem.mesh.parent) heldItem.mesh.parent.remove(heldItem.mesh);
        scene.add(heldItem.mesh);
        heldItem.mesh.position.copy(itemWorldPos);

        // Replace the shelf/cart body with a dynamic one. The hand pulls this
        // body through the world, so shelves and the floor still stop it.
        if (heldItem.body) { try { world.removeBody(heldItem.body); } catch(_) {} heldItem.body = null; }
        
        // Prepare smooth transition to held position in front of camera
        heldItem.mesh.visible = true;
        try {
            heldItem.mesh.traverse((obj) => {
                if (obj.isMesh && obj.material) {
                    if (Array.isArray(obj.material)) {
                        obj.material.forEach(m => { m.depthTest = true; m.depthWrite = true; });
                    } else {
                        obj.material.depthTest = true;
                        obj.material.depthWrite = true;
                    }
                }
                obj.renderOrder = 0;
            });
        } catch(_) {}
        heldTransitionActive = false;
        heldItemPulling = false;
        soundEffects.grab.currentTime = 0;
        soundEffects.grab.play();

        // Mislabeling and unusual weight are separate rolls with their own
        // configured probabilities. Either can happen without the other.
        const misChance = (CONFIG.MISLABELED_ITEM_CHANCE ?? 0.015);
        const weightChance = (CONFIG.WEIGHT_CHANGE_CHANCE ?? 0.015);
        if (!wasInCart) {
            heldItem.massOverride = null;
            heldItem.weightFactor = 1;
            const baseMass = itemPhysicsMass(heldItem);
            let pickupMessage = '';
            if (Math.random() < misChance) {
                const originalName = heldItem.name;
                const candidates = ITEMS.filter(it => it.name !== originalName);
                const newTpl = candidates[Math.floor(Math.random() * candidates.length)];
                if (newTpl && typeof newTpl.model === 'function') {
                    const oldMesh = heldItem.mesh;
                    const newMesh = newTpl.model();
                    newMesh.scale.multiplyScalar(ITEM_SCALE);
                    newMesh.position.copy(oldMesh.position);
                    newMesh.quaternion.copy(oldMesh.quaternion);
                    try { newMesh.traverse(o => { if (o.isMesh && o.material){ (Array.isArray(o.material)?o.material:[o.material]).forEach(m=>{ m.depthTest=true; m.depthWrite=true; }); } o.renderOrder=0; }); } catch(_) {}
                    if (oldMesh.parent) oldMesh.parent.remove(oldMesh);
                    scene.add(newMesh);
                    heldItem.mesh = newMesh;
                    heldItem.name = newTpl.name;
                    heldItem.size = newTpl.size?.map(v => v * ITEM_SCALE) || heldItem.size;
                    heldItem.isTwoInOne = false;
                    // The appearance swap alone does not change physical mass.
                    heldItem.massOverride = baseMass;
                    mislabeledItemsCount++;
                    pickupMessage = `Mislabeled as ${originalName}!`;
                }
            }
            if (Math.random() < weightChance) {
                heldItem.weightFactor = Math.random() < 0.5 ? 2 : 0.5;
                heldItem.massOverride = baseMass * heldItem.weightFactor;
                pickupMessage += `${pickupMessage ? ' ' : ''}It feels ${heldItem.weightFactor > 1 ? 'heavier' : 'lighter'}.`;
            }
            if (pickupMessage) displayMessage(pickupMessage, 2200);
        }
        heldItem.body = makeLooseItemBody(heldItem, heldItem.mesh.position);
        if (wasInCart) {
            showPickupText(`Took ${heldItem.name} out of cart`);
            return;
        }
        // Accidental drop chance on grab: drops beside cart and triggers event upon hitting the ground
        if (Math.random() * 100 < (CONFIG.DROP_ITEM_CHANCE ?? 0)) {
            releaseItem(true);
            return;
        }

        // For 2-in-1 items, grabbing and dropping should not affect the list,
        // so we only play a "correct item" sound for normal items on the list.
        if (!heldItem.isTwoInOne) {
            const isOnList = shoppingList.some(listItem => listItem?.name === heldItem?.name);
            if (isOnList) {
                try { sfxKey.currentTime = 0; sfxKey.play(); } catch(e) {}
            }
        }

        return;
    }
}

function placeHeldItemOnSurface(hitPoint, hitNormal) {
    if (!heldItem) return;
    const item = heldItem;
    heldItemPulling = false;
    heldTransitionActive = false;
    heldItem = null;

    try {
        const halfH = item.size ? (item.size[1] * 0.5) : 0.15;
        const normal = (hitNormal && typeof hitNormal.clone === 'function') ? hitNormal.clone().normalize() : new THREE.Vector3(0, 1, 0);
        if (normal.y < 0.2) normal.set(0, 1, 0);
        const placePos = hitPoint.clone().add(normal.multiplyScalar(halfH + 0.005));

        if (item.mesh.parent) item.mesh.parent.remove(item.mesh);
        scene.add(item.mesh);

        try {
            item.mesh.traverse((obj) => {
                if (obj.isMesh && obj.material) {
                    if (Array.isArray(obj.material)) {
                        obj.material.forEach(m => { m.depthTest = true; m.depthWrite = true; });
                    } else {
                        obj.material.depthTest = true;
                        obj.material.depthWrite = true;
                    }
                }
                obj.renderOrder = 0;
            });
        } catch(_) {}

        if (item.body) {
            try { world.removeBody(item.body); } catch(_) {}
        }
        item.body = makeLooseItemBody(item, placePos);
        item.body.velocity.set(0, 0, 0);
        item.body.angularVelocity.set(0, 0, 0);
        item.isStatic = false;
        item.inCart = false;
        item.mesh.position.copy(item.body.position);

        showPickupText(`Placed ${item.name} on shelf`);
        try {
            if (soundEffects.grab) {
                soundEffects.grab.currentTime = 0;
                soundEffects.grab.play();
            }
        } catch(_) {}
    } catch(_) {}
}

function handleItemDropOrPlacement() {
    if (!heldItem) return;

    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    sharedRaycaster.set(camera.position, dir);

    // 1. Check if looking at or hovering over player cart
    if (cart3D) {
        const cartHit = sharedRaycaster.intersectObject(cart3D, true);
        const heldWorldPos = new THREE.Vector3();
        if (heldItem.mesh) heldItem.mesh.getWorldPosition(heldWorldPos);
        else heldWorldPos.copy(camera.position).add(dir.clone().multiplyScalar(1.0));

        const localHeldPos = cart3D.worldToLocal(heldWorldPos.clone());
        const isOverCart = Math.abs(localHeldPos.x) < 0.50 * CartPhys.CART_SCALE && Math.abs(localHeldPos.z) < 0.70 * CartPhys.CART_SCALE && localHeldPos.y > 0.15 && localHeldPos.y < 2.5;
        const isLookingAtCart = cartHit.length > 0 && cartHit[0].distance <= (CONFIG.ARM_REACH + 1.2);

        if (isLookingAtCart || isOverCart) {
            let hitLocal = null;
            if (cartHit.length > 0) {
                hitLocal = cart3D.worldToLocal(cartHit[0].point.clone());
            } else {
                hitLocal = localHeldPos;
            }
            dropHeldItemIntoCart(hitLocal);
            return;
        }
    }

    // 2. Check if aiming at shelf boards or shelf units within arm's reach
    const maxReach = (powerupActive && currentPowerup === 'extendo_arm') ? 25 : (CONFIG.ARM_REACH * 1.8);

    if (shelves && shelves.length > 0) {
        const shelfHits = sharedRaycaster.intersectObjects(shelves, true);
        if (shelfHits.length > 0 && shelfHits[0].distance <= maxReach) {
            const hit = shelfHits[0];
            placeHeldItemOnSurface(hit.point, hit.face ? hit.face.normal : new THREE.Vector3(0, 1, 0));
            return;
        }
    }

    if (shelfUnits && shelfUnits.length > 0) {
        const unitHits = sharedRaycaster.intersectObjects(shelfUnits, true);
        if (unitHits.length > 0 && unitHits[0].distance <= maxReach) {
            const hit = unitHits[0];
            placeHeldItemOnSurface(hit.point, hit.face ? hit.face.normal : new THREE.Vector3(0, 1, 0));
            return;
        }
    }

    // 3. Otherwise, release item dynamically into world space
    releaseItem();
}

function tossHeldItem() {
    if (!heldItem || !heldItem.body) return;
    const item = heldItem;
    const direction = new THREE.Vector3();
    camera.getWorldDirection(direction);
    const speed = Math.max(3.8, Math.min(9, 8 / Math.sqrt(item.body.mass)));
    const playerVelocity = playerBody?.velocity;
    item.body.velocity.set(
        direction.x * speed + (playerVelocity?.x || 0) * 0.65,
        direction.y * speed + 1.8 + Math.max(0, playerVelocity?.y || 0) * 0.4,
        direction.z * speed + (playerVelocity?.z || 0) * 0.65
    );
    item.body.angularVelocity.set(direction.z * 3, 1.8, -direction.x * 3);
    item.body.wakeUp();
    item.isDropping = true;
    item.isAccidentalDrop = false;
    item.hasLanded = false;
    item.inCart = false;
    item.isStatic = false;
    heldItem = null;
    heldItemPulling = false;
    heldTransitionActive = false;
}

function dropHeldItemIntoCart(hitLocal) {
    if (!heldItem) return;

    const item = heldItem;
    heldItem = null;
    heldItemPulling = false;
    heldTransitionActive = false;

    // Restore materials
    if (item.mesh) {
        item.mesh.visible = true;
        try {
            item.mesh.traverse(obj => {
                if (obj.isMesh && obj.material) {
                    if (Array.isArray(obj.material)) {
                        obj.material.forEach(m => { m.depthTest = true; m.depthWrite = true; });
                    } else {
                        obj.material.depthTest = true;
                        obj.material.depthWrite = true;
                    }
                }
                obj.renderOrder = 0;
            });
        } catch(_) {}
    }

    // Capture starting world position of the held item
    const startWorldPos = new THREE.Vector3();
    if (item.mesh) item.mesh.getWorldPosition(startWorldPos);
    else startWorldPos.copy(camera.position).add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(1.0));

    // Glide to just above whatever is piled under the aim point; the basket
    // physics takes over from there and drops it into place.
    const B = CartPhys.CART_BASKET;
    const aimX = hitLocal ? hitLocal.x + (Math.random() - 0.5) * 0.06 : (Math.random() - 0.5) * B.halfW;
    const aimZ = hitLocal ? hitLocal.z + (Math.random() - 0.5) * 0.06 : (Math.random() - 0.5) * B.halfL;
    const restQuat = CartPhys.cartRestingQuat(item);
    const targetPos = CartPhys.cartDropPoint(item, aimX, aimZ, undefined, restQuat);
    const targetY = targetPos.y;

    // Attach mesh directly to cart3D
    if (item.mesh.parent) item.mesh.parent.remove(item.mesh);
    cart3D.add(item.mesh);

    // Set initial local position to match world position at release
    const startLocal = cart3D.worldToLocal(startWorldPos.clone());
    item.mesh.position.copy(startLocal);

    // Set down the way a shopper packs a cart (tall items on their side)
    const targetEuler = new THREE.Euler().setFromQuaternion(restQuat);

    // Remove Cannon body while contained in cart
    if (item.body) {
        try { world.removeBody(item.body); } catch(_) {}
        item.body = null;
    }

    cartDroppingItems.push({
        item: item,
        startPos: startLocal.clone(),
        targetPos: targetPos.clone(),
        startRot: item.mesh.rotation.clone(),
        targetRot: targetEuler,
        duration: 0.22,
        elapsed: 0,
        arcHeight: Math.max(0.04, Math.min(0.18, 0.12 + (startLocal.y - targetY) * 0.1))
    });
}

const _cartLetGoVel = { x: 0, y: -0.6, z: 0 };
function updateCartDroppingItems(delta) {
    for (let i = cartDroppingItems.length - 1; i >= 0; i--) {
        const anim = cartDroppingItems[i];
        anim.elapsed += delta;
        const t = Math.min(1, anim.elapsed / anim.duration);
        // Gravity drop curve
        const ease = 1 - Math.pow(1 - t, 2);

        anim.item.mesh.position.x = THREE.MathUtils.lerp(anim.startPos.x, anim.targetPos.x, ease);
        anim.item.mesh.position.z = THREE.MathUtils.lerp(anim.startPos.z, anim.targetPos.z, ease);
        anim.item.mesh.position.y = THREE.MathUtils.lerp(anim.startPos.y, anim.targetPos.y, ease) + Math.sin(t * Math.PI) * anim.arcHeight;

        anim.item.mesh.rotation.x = THREE.MathUtils.lerp(anim.startRot.x, anim.targetRot.x, ease);
        anim.item.mesh.rotation.y = THREE.MathUtils.lerp(anim.startRot.y, anim.targetRot.y, ease);
        anim.item.mesh.rotation.z = THREE.MathUtils.lerp(anim.startRot.z, anim.targetRot.z, ease);

        if (t >= 1) {
            anim.item.mesh.position.copy(anim.targetPos);
            anim.item.mesh.rotation.copy(anim.targetRot);
            CartPhys.addItemToCart(anim.item, anim.item.mesh.position, anim.item.mesh.quaternion, _cartLetGoVel);
            finalizeItemInCart(anim.item);
            if (anim.babyGrabbed) {
                displayRngNotification(`🍼 Your baby grabbed ${anim.item.name}!`, 4200);
            }
            cartDroppingItems.splice(i, 1);
        }
    }
}

function finalizeItemInCart(item) {
    item.inCart = true;
    item.isStatic = true;
    if (!collectedItems.includes(item)) {
        collectedItems.push(item);
    }
    if (gumCravingActive && !gumCravingSatisfied && (item.name === 'Gum' || item.isCheckoutGum)) {
        refreshGumCravingState();
        displayMessage("✨ Craving satisfied! Chewing Gum is in your cart!", 2500, true);
        checkoutExitCooldownUntil = 0;
    }

    // Special handling for 2-in-1 items:
    if (item.isTwoInOne) {
        processTwoInOneItem(item);
    } else {
        const isOnList = shoppingList.some(listItem => listItem?.name === item?.name);
        if (isOnList) {
            updateShoppingListForItem(item.name);
            try {
                if (soundEffects.itemAddedToList) {
                    soundEffects.itemAddedToList.currentTime = 0;
                    soundEffects.itemAddedToList.play();
                }
            } catch(_) {}
        } else {
            wrongItemsGrabbedCount++;
            try { soundEffects.wrongItem.currentTime = 0; soundEffects.wrongItem.play(); } catch(e) {}
            displayMessage("That's not on your shopping list!", 1500, true);
        }
    }

    showPickupText(`Placed ${item.name} in cart`);

    if (powerupActive && currentPowerup === 'eagle_eye') {
        clearEagleEyeOutlines();
        applyEagleEyeOutlines();
    }
}

function giveManagerGift(itemName) {
    if (!cart3D) return false;
    let item = allItems.find(candidate =>
        candidate.name === itemName && candidate.mesh?.parent &&
        !candidate.inCart && !candidate.inCustomerCart && !candidate.isCustomerHeld &&
        !candidate.stolen && !candidate.outOfStock && candidate !== heldItem
    );
    if (!item) {
        const template = ACTIVE_ITEMS.find(entry => entry.name === itemName);
        if (!template) return false;
        item = createStaticItem(template.name, template.color, template.size,
            playerBody.position.x, 1, playerBody.position.z, template.model, 0);
    }
    item.mesh.removeFromParent();
    cart3D.add(item.mesh);
    item.mesh.visible = true;
    const B = CartPhys.CART_BASKET;
    CartPhys.cartRestingQuat(item, item.mesh.quaternion);
    CartPhys.cartDropPoint(item, (Math.random() - 0.5) * B.halfW, (Math.random() - 0.5) * B.halfL, item.mesh.position, item.mesh.quaternion);
    if (item.body) {
        world?.removeBody(item.body);
        item.body = null;
    }
    CartPhys.addItemToCart(item, item.mesh.position, item.mesh.quaternion, null);
    item.isManagerGift = true;
    finalizeItemInCart(item);
    return true;
}

// Hand a loose item that has landed inside the basket over to the basket
// physics, keeping its motion so it tumbles in naturally.
function catchItemInCart(item, localPos, localQuat = null, localVel = null) {
    if (item.body) {
        try { world.removeBody(item.body); } catch(_) {}
        item.body = null;
    }
    if (item.mesh.parent) item.mesh.parent.remove(item.mesh);
    cart3D.add(item.mesh);
    item.mesh.position.copy(localPos);
    if (localQuat) item.mesh.quaternion.copy(localQuat);
    item.isDropping = false;
    item.isAccidentalDrop = false;
    item.hasLanded = true;
    CartPhys.addItemToCart(item, localPos, localQuat || item.mesh.quaternion, localVel);
    finalizeItemInCart(item);
    try { if (soundEffects.cartAdd) { soundEffects.cartAdd.currentTime = 0; soundEffects.cartAdd.play().catch(() => {}); } } catch (_) {}
}

function releaseItem(isAccidental = false) {
    if (!heldItem) return;
    addAchievementProgress('butterfingers');
    if (!isAccidental && heldItem.body) {
        const item = heldItem;
        const velocity = playerBody?.velocity;
        item.body.velocity.set(
            (velocity?.x || 0) * 0.65,
            (velocity?.y || 0) * 0.4,
            (velocity?.z || 0) * 0.65
        );
        item.body.angularVelocity.scale(0.35, item.body.angularVelocity);
        item.isDropping = true;
        item.isAccidentalDrop = false;
        item.hasLanded = false;
        item.isStatic = false;
        item.body.wakeUp();
        heldItemPulling = false;
        heldTransitionActive = false;
        heldItem = null;
        return;
    }
    // Detach from hand and reintroduce physics so it drops beside the cart to the ground
    try {
        const forward = new THREE.Vector3();
        camera.getWorldDirection(forward);
        forward.y = 0;
        forward.normalize();
        const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

        // Place it beside/forward of cart so it drops past it to the floor
        const sideSign = Math.random() < 0.5 ? 1 : -1;
        const dropPos = new THREE.Vector3().copy(camera.position)
            .add(forward.clone().multiplyScalar(1.2))
            .add(right.clone().multiplyScalar(sideSign * 0.70));

        // Ensure item is in scene and not parented
        if (heldItem.mesh.parent) heldItem.mesh.parent.remove(heldItem.mesh);
        scene.add(heldItem.mesh);
        // Restore material depth behavior
        try {
            heldItem.mesh.traverse((obj) => {
                if (obj.isMesh && obj.material) {
                    if (Array.isArray(obj.material)) {
                        obj.material.forEach(m => { m.depthTest = true; m.depthWrite = true; });
                    } else {
                        obj.material.depthTest = true;
                        obj.material.depthWrite = true;
                    }
                }
                obj.renderOrder = 0;
            });
        } catch(_) {}

        // Recreate or re-add a dynamic body
        if (heldItem.body) { try { world.removeBody(heldItem.body); } catch (_) {} }
        heldItem.body = makeLooseItemBody(heldItem, dropPos);
        heldItem.body.velocity.set(sideSign * 0.35, -0.6, (Math.random() - 0.5) * 0.35);
        // Sync mesh to body
        heldItem.mesh.position.copy(heldItem.body.position);

        heldItem.isDropping = true;
        heldItem.isAccidentalDrop = isAccidental;
        heldItem.hasLanded = false;
        heldItem.inCart = false;
        heldItem.isStatic = false;

        const droppedRef = heldItem;
        const groundCollideHandler = () => {
            if (droppedRef && droppedRef.isDropping && !droppedRef.hasLanded) {
                triggerItemGroundImpact(droppedRef);
            }
        };
        heldItem.body.addEventListener('collide', groundCollideHandler);
    } catch(_) {}
    heldItemPulling = false;
    heldTransitionActive = false;
    heldItem = null;
}

function triggerItemGroundImpact(item) {
    if (!item || !item.isDropping || item.hasLanded) return;
    item.isDropping = false;
    item.hasLanded = true;
    const impactX = item.body ? item.body.position.x : item.mesh.position.x;
    const impactZ = item.body ? item.body.position.z : item.mesh.position.z;

    if (item.isAccidentalDrop) {
        item.isAccidentalDrop = false;
        try {
            soundEffects.drop.currentTime = 0;
            soundEffects.drop.play();
        } catch (_) {}
        displayMessage("You accidentally dropped the item!", 2000, true);

        if (isGlassItem(item.name)) {
            // Glass item shatters on floor impact and is destroyed
            createGlassShardsAt(impactX, impactZ, item.name);
            if (item.mesh && item.mesh.parent) item.mesh.parent.remove(item.mesh);
            if (item.body && world) {
                try { world.removeBody(item.body); } catch (_) {}
                item.body = null;
            }
            const idx = allItems.indexOf(item);
            if (idx > -1) allItems.splice(idx, 1);
        } else if (isLiquidItem(item.name)) {
            // Liquid item creates a spill on floor impact
            createProductSpillAt(impactX, impactZ, item.name);
        }
    }
}

function updateShoppingListForItem(itemName) {
    // Find the item in the shopping list and update its collected count
    for (let i = 0; i < shoppingList.length; i++) {
        if (shoppingList[i].name === itemName && shoppingList[i].collected < shoppingList[i].quantity) {
            shoppingList[i].collected++;
            if (shoppingList[i].collected >= shoppingList[i].quantity) {
                const q = shoppingList[i].quantity;
                logRunEvent(`✅ Got ${itemName}${q > 1 ? ` x${q}` : ''}`);
            }
            break;
        }
    }
    updateShoppingListDisplay();
    if (powerupActive && currentPowerup === 'eagle_eye') {
        clearEagleEyeOutlines();
        applyEagleEyeOutlines();
    }
}

function placeHeldItemInCart() {
    handleItemDropOrPlacement();
}

function countObtainableInStore(name) {
    let n = 0;
    for (let i = 0; i < allItems.length; i++) {
        const it = allItems[i];
        if (it.name !== name || it.inCart || it.stolen || it.inCustomerCart || it.isCustomerHeld || it.outOfStock) continue;
        if (!it.mesh || !it.mesh.parent) continue;
        n++;
    }
    return n;
}

function checkCheckoutReady() {
    if (!playerBody || !gameStarted || isCheckout || gameOver || gamePaused || purchaseComplete) return;

    if (isLonelyStoreMode) {
        // In Lonely Store mode, getting to checkout counter or front entrance triggers escape
        const dx = playerBody.position.x - 15;
        const dz = playerBody.position.z + 15;
        const distSq = dx * dx + dz * dz;
        const entranceDistSq = playerBody.position.x * playerBody.position.x + (playerBody.position.z - (-26)) * (playerBody.position.z - (-26));
        if (distSq < 25 || entranceDistSq < 25) {
            if (Date.now() >= checkoutExitCooldownUntil) {
                startCheckoutProcess();
            }
        }
        return;
    }

    // Check if the player is near the checkout
    const dx = playerBody.position.x - 15;
    const dz = playerBody.position.z + 15;
    const distSq = dx*dx + dz*dz;

    if (distSq > 36) {
        checkoutExitCooldownUntil = 0; // Clears cooldown when stepping away
    }

    if (Date.now() < checkoutExitCooldownUntil) return;
    if (distSq >= 25 || collectedItems.length === 0) return;

    // Check if all items that are still obtainable in the store have been collected.
    // Uses LIVE stock (not the initial stock count) so items stolen by the gnome
    // thief, taken by customers, or pulled by an out-of-stock event can never
    // make the run impossible to finish.
    let allAvailableCollected = true;
    for (const item of shoppingList) {
        const maxCollectable = Math.min(item.quantity, item.collected + countObtainableInStore(item.name));
        if (item.collected < maxCollectable) {
            allAvailableCollected = false;
            break;
        }
    }

    if (allAvailableCollected) {
        // Player is near the checkout and has gathered all obtainable list items
        startCheckoutProcess();
    }
}

function triggerPowerOutage() {
    if (powerOutage || !gameStarted || isCheckout || gameOver) return false;
    powerOutage = true;
    music.pause();

    // Play power outage sound (reused)
    try { sfxPowerDown.currentTime = 0; sfxPowerDown.play(); } catch(e) {}

    powerOutageCount++; // Increment power outage count

    // Lights go out in the store itself (see updateStorePower) — no screen overlay
    powerOutageStartTime = performance.now();

    // Text banner positioned dynamically
    const existingText = document.getElementById('power-outage-banner');
    if (existingText) removeEventTextElement(existingText);
    const textBanner = document.createElement('div');
    textBanner.id = 'power-outage-banner';
    textBanner.className = 'event-text-banner power-outage-banner';
    textBanner.textContent = 'POWER OUTAGE!';
    textBanner.style.zIndex = '2004';
    textBanner.style.color = '#ff3333';
    textBanner.style.fontSize = '2.4em';
    textBanner.style.fontWeight = 'bold';
    textBanner.style.textShadow = '0 0 14px rgba(255, 0, 0, 0.9), 3px 3px 0px #000';
    textBanner.style.padding = '14px 28px';
    textBanner.style.backgroundColor = 'rgba(10, 0, 0, 0.88)';
    textBanner.style.borderRadius = '16px';
    textBanner.style.border = '2px solid rgba(255, 60, 60, 0.7)';
    textBanner.style.textAlign = 'center';

    placeEventTextElement(textBanner, true);
    document.getElementById('alerts-overlay').appendChild(textBanner);

    // End power outage after 15 seconds
    const endTimerId = setTimeout(() => {
        powerOutage = false;
        removeEventTextElement(textBanner);
        if (gameStarted && !gameOver && !isCheckout) {
            music.play();
        }
        lastMajorEventEndTime = performance.now();
    }, 15000);
    scheduledEventTimeouts.push(endTimerId);
    return true;
}

// Cart wheel gets stuck: pushing the attached cart is very slow for a while.
let cartStuckActive = false;
let cartStuckCount = 0;
let cartStuckPull = 0;
function triggerCartStuck() {
    if (cartStuckActive || !cartAttached || !gameStarted || isCheckout || gameOver) return false;
    cartStuckActive = true;
    cartStuckPull = Math.random() < 0.5 ? -1 : 1;
    cartStuckCount++;
    displayMessage("🛒 Stuck wheel! Steer against the pull to keep the cart straight.", 4000, true);
    try { if (soundEffects.cartAdd) { soundEffects.cartAdd.currentTime = 0; soundEffects.cartAdd.play().catch(() => {}); } } catch (_) {}
    const endTimerId = setTimeout(() => {
        cartStuckActive = false;
        cartStuckPull = 0;
        if (gameStarted && !gameOver) displayMessage("The wheel popped loose. Cart rolling normally again.", 2200);
        lastMajorEventEndTime = performance.now();
    }, 9000);
    scheduledEventTimeouts.push(endTimerId);
    return true;
}

// Out of stock: one item still needed on the list sells out. Remaining shelf
// stock disappears; the list marks it and checkout no longer requires it.
function triggerOutOfStock() {
    if (!gameStarted || isCheckout || gameOver || isLonelyStoreMode || purchaseComplete) return false;
    const candidates = shoppingList.filter(li => li && li.collected < li.quantity &&
        !outOfStockListItems.includes(li.name) && countObtainableInStore(li.name) > 0);
    // Keep at least one other obtainable item so the run always has something to do
    if (candidates.length < 2) return false;
    const target = candidates[Math.floor(Math.random() * candidates.length)];

    allItems.forEach(it => {
        if (it.name !== target.name || it === heldItem || it.inCart || it.inCustomerCart || it.isCustomerHeld || it.stolen) return;
        if (!it.mesh || !it.mesh.parent) return;
        it.outOfStock = true;
        if (it.body) { try { world.removeBody(it.body); } catch (_) {} }
        it.mesh.parent.remove(it.mesh);
    });

    outOfStockListItems.push(target.name);
    updateShoppingListDisplay();
    displayMessage(`📢 Attention shoppers: we're completely out of ${target.name}! It's no longer required.`, 5000, true);
    try { if (soundEffects.itemRemoved) { soundEffects.itemRemoved.currentTime = 0; soundEffects.itemRemoved.play().catch(() => {}); } } catch (_) {}
    return true;
}

function triggerSlipperyFloor() {
    if (slipperyFloor || !gameStarted || isCheckout || gameOver) return false;
    slipperyFloor = true;
    slipperyFloorCount++; // Increment slippery floor count
    displayMessage("Caution: Wet floor! Your movement is slippery!", 5000, true);

    // End slippery floor after a few seconds
    const endTimerId = setTimeout(() => {
        slipperyFloor = false;
        displayMessage("The floor is dry again.", 2000);
        lastMajorEventEndTime = performance.now();
    }, 10000);
    scheduledEventTimeouts.push(endTimerId);
    return true;
}

function triggerStoreClosing() {
    if (storeClosing || !gameStarted || isCheckout || gameOver) return false;
    storeClosing = true;
    storeClosingCount++; // Increment store closing count (though it can only happen once per game)
    storeClosingTimer = 60; // 60 seconds = 1 minute

    // Play store closing audio cue again
    try {
        if (sfxAttentionCustomers) {
            sfxAttentionCustomers.currentTime = 0;
            sfxAttentionCustomers.play();
        } else if (soundEffects.storeClosing) {
            soundEffects.storeClosing.currentTime = 0;
            soundEffects.storeClosing.play();
        }
    } catch (_) {}

    // Create closing warning display
    const existing = document.getElementById('closing-warning');
    if (existing) removeEventTextElement(existing);
    const closingWarning = document.createElement('div');
    closingWarning.id = 'closing-warning';
    closingWarning.className = 'event-text-banner store-closing-banner';
    closingWarning.innerHTML = `ATTENTION SHOPPERS:<br>The store will close in 1 minute!`;
    closingWarning.style.zIndex = '2003';
    closingWarning.style.fontSize = '2.0em';
    closingWarning.style.fontWeight = 'bold';
    closingWarning.style.color = '#ffffff';
    closingWarning.style.textShadow = '0 2px 8px rgba(0,0,0,0.9), 2px 2px 0px #000';
    closingWarning.style.padding = '14px 26px';
    closingWarning.style.backgroundColor = 'rgba(200, 20, 20, 0.75)';
    closingWarning.style.borderRadius = '16px';
    closingWarning.style.border = '2px solid rgba(255, 120, 120, 0.6)';
    closingWarning.style.textAlign = 'center';

    placeEventTextElement(closingWarning, true);
    document.getElementById('alerts-overlay').appendChild(closingWarning);

    // Start countdown
    if (storeClosingInterval) { try { clearInterval(storeClosingInterval); } catch(_) {} }
    storeClosingInterval = setInterval(() => {
        storeClosingTimer--;

        if (storeClosingTimer <= 0) {
            clearInterval(storeClosingInterval);
            storeClosingInterval = null;
            removeEventTextElement(closingWarning);

            if (gameStarted && !isCheckout && !gameOver) {
                // Show fancy full-screen failure UI instead of an alert/reset
                showStoreClosedOverlay();
            }
        } else if (storeClosingTimer <= 10) {
            // Last 10 seconds warning
            closingWarning.innerHTML = `URGENT: STORE CLOSING IN<br>${storeClosingTimer} SECONDS!`;
            closingWarning.style.backgroundColor = 'rgba(255, 0, 0, 0.88)';
        }
    }, 1000);
    return true;
}

function stopRunTimer() {
    if (stoppedRunElapsed !== null) return;
    stoppedRunElapsed = Math.max(0, Date.now() - timerStart);
    finishRunTrack(stoppedRunElapsed);
    if (timer) { clearInterval(timer); timer = null; }
    updateTimer();
}

// ---- Run timeline: everything that happened, stamped with the run clock ----
let runTimeline = [];
let runTimelineSQ = null;
let runTimelineLastSQCheck = 0;
const RUN_EVENT_LABELS = {
    power_outage: '⚡ Power outage',
    forgot_glasses: '👓 Forgot your glasses',
    manager_jumpscare: '👔 The manager showed up',
    store_closing: '🔒 Store closing announced',
    baby_crying: '👶 Baby started crying',
    falling_shelf: '🗄️ A shelf fell over',
    slippery_floor: '🧊 Slippery floor',
    product_spill: '💧 Product spill',
    out_of_stock: '📦 An item sold out',
    gnome_thief: '🧙 Thief broke in',
    wife_call: '📞 Your wife called',
    earthquake: '🌎 Earthquake',
    thermostat: '🌡️ Thermostat malfunction',
    customer_scuffle: '🥊 Customer scuffle',
    tweaker: '😵 A tweaker approached you',
    cart_stuck: '🛒 Cart wheel got stuck',
    nuclear_fallout: '☢️ Nuclear fallout',
};
function currentRunElapsed() {
    if (!timerStart) return 0;
    return stoppedRunElapsed ?? Math.max(0, Date.now() - timerStart);
}
function resetRunTimeline() {
    runTimeline = [];
    runTimelineSQ = null;
    runTimelineLastSQCheck = 0;
}
function logRunEvent(label) {
    if (!gameStarted || !label) return;
    runTimeline.push({ t: currentRunElapsed(), label: String(label) });
}
// Side quests live in their own module; log their completions as they flip.
function trackSideQuestTimeline(force = false) {
    const now = performance.now();
    if (!force && now - runTimelineLastSQCheck < 400) return;
    runTimelineLastSQCheck = now;
    const st = SQ.getSideQuestStats();
    if (!st) return;
    const prev = runTimelineSQ;
    runTimelineSQ = { ...st };
    if (!prev) return;
    if (st.restroomDone && !prev.restroomDone) logRunEvent('🚻 Used the restroom');
    if (st.returnsDone > prev.returnsDone) {
        logRunEvent(`↩️ Returned an item (${st.returnsDone}/${st.returnsTotal})`);
    }
    if (st.changeCents !== null && prev.changeCents !== null && st.changeCents >= 100 && prev.changeCents < 100) {
        logRunEvent('🪙 Found $1.00 in spare change');
    }
    if (st.sampleEaten > prev.sampleEaten) logRunEvent('🧀 Ate a free sample');
    if (st.droveHome && !prev.droveHome) logRunEvent('🚗 Drove home');
}
function updateTimer() {
    if (gameStarted && !gameOver) trackSideQuestTimeline();
    const elapsed = stoppedRunElapsed ?? Math.max(0, Date.now() - timerStart);
    const hours = Math.floor(elapsed / 3600000);
    const minutes = Math.floor((elapsed % 3600000) / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);
    const milliseconds = Math.floor((elapsed % 1000) / 10);

    timerElement.textContent = [
        hours.toString().padStart(2, '0'),
        minutes.toString().padStart(2, '0'),
        seconds.toString().padStart(2, '0')
    ].join(':') + '.' + milliseconds.toString().padStart(2, '0');
}

function updateScoreboard() {
    const bestTimesList = document.getElementById('best-times-list');
    bestTimesList.innerHTML = '';

    // Read latest stored best times to avoid stale globals
    let stored = [];
    try { stored = JSON.parse(localStorage.getItem('bestTimes') || '[]') || []; } catch (_) {}

    // Display top 5 best times
    stored.slice(0, 5).forEach((time) => {
        const listItem = document.createElement('li');
        listItem.textContent = time;
        bestTimesList.appendChild(listItem);
    });

    if (stored.length === 0) {
        const emptyItem = document.createElement('li');
        emptyItem.textContent = 'No times recorded yet';
        bestTimesList.appendChild(emptyItem);
    }
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// NEW: Track customers array to avoid scanning scene.children every frame
let customers = [];
// NEW: Reuse Box3 for falling shelf crush detection and throttle checks
let fallBoxTmp = new THREE.Box3();
let fallCheckFrameSkip = 0;

// ---------------- STORE WORKER RESTOCKER SYSTEM ----------------
let storeWorker = null;

function cleanupStoreWorker() {
    if (storeWorker) {
        if (storeWorker.parent) storeWorker.parent.remove(storeWorker);
        if (storeWorker.body) { try { world.removeBody(storeWorker.body); } catch(_) {} }
        storeWorker = null;
    }
}

function createStoreWorker() {
    cleanupStoreWorker();

    const workerGroup = createWorkerModel();
    const totalHeight = 1.8;
    // Register station position - on the clear, open cashier side of the counter
    const registerStation = new THREE.Vector3(15.0, 0, -17.2);
    workerGroup.position.copy(registerStation);
    workerGroup.rotation.y = 0;

    // Physics body for collision
    const workerShape = new CANNON.Box(new CANNON.Vec3(0.35, totalHeight / 2, 0.35));
    const workerBody = new CANNON.Body({
        mass: 70,
        position: new CANNON.Vec3(registerStation.x, totalHeight / 2 + 0.05, registerStation.z),
        shape: workerShape
    });
    workerBody.linearFactor = new CANNON.Vec3(1, 0, 1);
    workerBody.fixedRotation = true;
    workerBody.collisionFilterGroup = 4;
    workerBody.collisionFilterMask = 1;
    world.addBody(workerBody);
    workerGroup.body = workerBody;
    workerBody.userData = { entity: workerGroup };

    workerGroup.workerState = 'idle_register';
    workerGroup.registerStation = registerStation;
    workerGroup.outsideDock = new THREE.Vector3(0, 0, -38);
    workerGroup.nextRestockTime = performance.now() + (22000 + Math.random() * 12000);
    workerGroup.stateTimer = 0;
    workerGroup.walkSpeed = 1.7;
    workerGroup.nav = { path: [], waypointIdx: 0, target: null };
    workerGroup.targetShelf = null;
    workerGroup.hasStocked = false;
    workerGroup.animPhase = 0;

    scene.add(workerGroup);
    storeWorker = workerGroup;
    return workerGroup;
}

// Every staff model ever built, so the nuke can make them all panic.
const staffModels = [];

function createWorkerModel() {
    const workerGroup = new THREE.Group();
    staffModels.push(workerGroup);
    const totalHeight = 1.8;
    const legHeight = 0.8;
    const torsoHeight = 0.8;
    const headRadius = 0.2;
    const hipY = legHeight;
    const chestY = hipY + torsoHeight / 2;
    const headY = hipY + torsoHeight + headRadius;

    // Head with MagMart Staff Cap
    const headGeometry = new THREE.SphereGeometry(headRadius, 16, 16);
    const headMaterial = new THREE.MeshStandardMaterial({ color: 0xFACDAD });
    const head = new THREE.Mesh(headGeometry, headMaterial);
    head.position.y = headY;
    workerGroup.add(head);
    workerGroup.head = head;

    // MagMart Staff Visor / Cap
    const capCrown = new THREE.Mesh(
        new THREE.CylinderGeometry(0.21, 0.21, 0.12, 16),
        new THREE.MeshStandardMaterial({ color: 0x1E3A8A, roughness: 0.5 })
    );
    capCrown.position.set(0, headY + 0.12, 0);
    const capBrim = new THREE.Mesh(
        new THREE.BoxGeometry(0.24, 0.03, 0.18),
        new THREE.MeshStandardMaterial({ color: 0xDC2626, roughness: 0.4 })
    );
    capBrim.position.set(0, headY + 0.09, 0.22);
    workerGroup.add(capCrown, capBrim);

    // Genuine 3D Eyes with Eyelids (Parented to head)
    const eyeWhiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.25 });
    const pupilMat = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.2 });

    const createWorkerEyeWithLids = (posX, posY, posZ) => {
        const eyeGroup = new THREE.Group();
        eyeGroup.position.set(posX, posY, posZ);

        const eyeball = new THREE.Mesh(new THREE.SphereGeometry(0.058, 14, 14), eyeWhiteMat);
        eyeGroup.add(eyeball);

        const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.028, 12, 12), pupilMat);
        pupil.position.set(0, 0, 0.046);
        eyeGroup.add(pupil);

        const eyelidPivot = new THREE.Group();
        const eyelidGeo = new THREE.SphereGeometry(0.063, 16, 14, 0, Math.PI * 2, 0, Math.PI * 0.52);
        const eyelidMesh = new THREE.Mesh(eyelidGeo, headMaterial);
        eyelidPivot.add(eyelidMesh);
        eyelidPivot.rotation.x = -Math.PI * 0.55;
        eyeGroup.add(eyelidPivot);

        return { eyeGroup, eyelidPivot };
    };

    const eyeRData = createWorkerEyeWithLids(0.105, 0.02, 0.165);
    const eyeLData = createWorkerEyeWithLids(-0.105, 0.02, 0.165);
    head.add(eyeRData.eyeGroup);
    head.add(eyeLData.eyeGroup);

    workerGroup.eyelids = [eyeRData.eyelidPivot, eyeLData.eyelidPivot];
    workerGroup.blinkNext = performance.now() + 1000 + Math.random() * 3000;

    // Torso: MagMart Staff Red Vest/Apron over collared shirt
    const bodyGeometry = new THREE.CylinderGeometry(0.35, 0.3, torsoHeight, 16);
    const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xDC2626, roughness: 0.5 });
    const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
    body.position.y = chestY;
    workerGroup.add(body);
    workerGroup.bodyMesh = body;

    // Staff Name Badge on chest
    const badge = new THREE.Mesh(
        new THREE.BoxGeometry(0.12, 0.06, 0.02),
        new THREE.MeshStandardMaterial({ color: 0xFBBF24, roughness: 0.3, metalness: 0.3 })
    );
    badge.position.set(0.14, chestY + 0.15, 0.31);
    workerGroup.add(badge);

    // Legs in dark navy trousers
    const legGeom = new THREE.CylinderGeometry(0.09, 0.09, legHeight, 12);
    const legMat = new THREE.MeshStandardMaterial({ color: 0x0F172A, roughness: 0.7 });
    const leftLeg = new THREE.Mesh(legGeom, legMat);
    leftLeg.position.set(-0.18, legHeight / 2, 0);
    const rightLeg = new THREE.Mesh(legGeom, legMat);
    rightLeg.position.set(0.18, legHeight / 2, 0);
    workerGroup.add(leftLeg, rightLeg);
    workerGroup.leftLeg = leftLeg;
    workerGroup.rightLeg = rightLeg;

    // Cardboard Restocking Box (carried in front of torso when stocking)
    const boxGroup = new THREE.Group();
    const boxMat = new THREE.MeshStandardMaterial({ color: 0xA07855, roughness: 0.85 });
    const boxMesh = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.38, 0.44), boxMat);
    
    // Top packing tape strip
    const tapeMesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.12, 0.01, 0.46),
        new THREE.MeshStandardMaterial({ color: 0xD7CCC8, roughness: 0.4 })
    );
    tapeMesh.position.set(0, 0.191, 0);

    // Box label
    const bCanvas = document.createElement('canvas');
    bCanvas.width = 256; bCanvas.height = 128;
    const bCtx = bCanvas.getContext('2d');
    bCtx.fillStyle = '#A07855'; bCtx.fillRect(0, 0, 256, 128);
    bCtx.strokeStyle = '#DC2626'; bCtx.lineWidth = 4; bCtx.strokeRect(6, 6, 244, 116);
    bCtx.fillStyle = '#DC2626'; bCtx.font = 'bold 22px sans-serif';
    bCtx.textAlign = 'center'; bCtx.fillText('★ MAGMART ★', 128, 40);
    bCtx.fillStyle = '#1E293B'; bCtx.font = 'bold 18px sans-serif';
    bCtx.fillText('RESTOCK DEPT', 128, 75);
    bCtx.fillStyle = '#475569'; bCtx.font = '12px sans-serif';
    bCtx.fillText('HANDLE WITH CARE', 128, 105);

    const bLabel = new THREE.Mesh(
        new THREE.PlaneGeometry(0.38, 0.24),
        new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(bCanvas), roughness: 0.6 })
    );
    bLabel.position.set(0, 0, 0.222);

    boxGroup.add(boxMesh, tapeMesh, bLabel);
    boxGroup.position.set(0, chestY - 0.02, 0.38);
    boxGroup.visible = false; // hidden when idle at register
    workerGroup.add(boxGroup);
    workerGroup.boxMesh = boxGroup;

    return workerGroup;
}

function updateStoreWorker(delta) {
    if (!storeWorker || !gameStarted || isCheckout || gameOver) return;

    const now = performance.now();
    const w = storeWorker;
    w.animPhase += delta * 8;

    // Nuke siren: drop everything and run around screaming.
    if (Nuke.isNukeActive()) {
        updateWorkerNukePanic(w, delta, now);
        return;
    }

    // Natural genuine eyelid blinking for worker
    updateEyelidBlink(w, now);

    // 1. STATE: Idle at Register
    if (w.workerState === 'idle_register') {
        w.body.velocity.x = 0;
        w.body.velocity.z = 0;
        w.boxMesh.visible = false;
        
        // Reset legs to idle
        if (w.leftLeg) w.leftLeg.rotation.x = THREE.MathUtils.lerp(w.leftLeg.rotation.x, 0, delta * 8);
        if (w.rightLeg) w.rightLeg.rotation.x = THREE.MathUtils.lerp(w.rightLeg.rotation.x, 0, delta * 8);

        // Face forward toward store
        w.rotation.y = THREE.MathUtils.lerp(w.rotation.y, 0, delta * 4);

        if (now > w.nextRestockTime) {
            // Begin restock mission: step out from behind counter and walk outside
            w.workerState = 'going_outside';
            const startPt = { x: w.body.position.x, z: w.body.position.z };
            const exitCounterPt = { x: 10.5, z: -17.2 };
            const doorPt = { x: 0, z: -28 };
            const outsidePt = { x: 0, z: -38 };
            const pathToDoor = navGrid ? findPath(navGrid, exitCounterPt, doorPt) : [doorPt];
            w.nav.path = [exitCounterPt, ...pathToDoor, outsidePt];
            w.nav.waypointIdx = 0;
        }
    }

    // 2. STATE: Going Outside to Loading Dock
    else if (w.workerState === 'going_outside') {
        w.boxMesh.visible = false;
        stepWorkerAlongPath(w, delta);

        const distToDock = Math.hypot(w.body.position.x - w.outsideDock.x, w.body.position.z - w.outsideDock.z);
        if (distToDock < 1.2 || w.nav.waypointIdx >= w.nav.path.length) {
            w.workerState = 'getting_box';
            w.stateTimer = now + 1400; // 1.4s outside picking up box
            w.body.velocity.x = 0;
            w.body.velocity.z = 0;
        }
    }

    // 3. STATE: Getting Box Outside
    else if (w.workerState === 'getting_box') {
        w.body.velocity.x = 0;
        w.body.velocity.z = 0;
        // Turn around facing store
        w.rotation.y = THREE.MathUtils.lerp(w.rotation.y, Math.PI, delta * 6);
        
        // Box appears in front of chest
        w.boxMesh.visible = true;

        if (now > w.stateTimer) {
            // Choose shelf to restock (preferring shelves matching uncollected list items)
            let chosenShelf = null;
            if (shelfUnits && shelfUnits.length > 0) {
                const uncollected = shoppingList.filter(i => i.collected < i.quantity).map(i => i.name);
                if (uncollected.length > 0) {
                    chosenShelf = shelfUnits.find(u => u?.userData?.items?.some(it => uncollected.includes(it.name))) ||
                        shelfUnits.find(u => u?.userData?.tierPools?.some(pool => pool.some(it => uncollected.includes(it.name))));
                }
                if (!chosenShelf) {
                    chosenShelf = shelfUnits[Math.floor(Math.random() * shelfUnits.length)];
                }
            }

            if (chosenShelf) {
                w.targetShelf = chosenShelf;
                const dirSign = chosenShelf.userData.direction || 1;
                const rot = chosenShelf.userData.rotY || 0;
                const along = (Math.random() - 0.5) * 2.0;
                const targetX = chosenShelf.position.x + along * Math.cos(rot) + dirSign * 2.2 * Math.sin(rot);
                const targetZ = chosenShelf.position.z - along * Math.sin(rot) + dirSign * 2.2 * Math.cos(rot);
                const validTgt = navGrid ? clampToWalkable(navGrid, targetX, targetZ) : { x: targetX, z: targetZ };
                w.targetShelfPos = validTgt;

                w.workerState = 'carrying_to_shelf';
                const doorPt = { x: 0, z: -28 };
                const pathInStore = navGrid ? findPath(navGrid, doorPt, validTgt) : [validTgt];
                w.nav.path = [doorPt, ...pathInStore];
                w.nav.waypointIdx = 0;
            } else {
                w.workerState = 'returning_to_register';
                const exitCounterPt = { x: 10.5, z: -17.2 };
                w.nav.path = navGrid ? findPath(navGrid, { x: 0, z: -28 }, exitCounterPt) : [exitCounterPt];
                w.nav.path.push({ x: w.registerStation.x, z: w.registerStation.z });
                w.nav.waypointIdx = 0;
            }
        }
    }

    // 4. STATE: Carrying Box to Shelf
    else if (w.workerState === 'carrying_to_shelf') {
        w.boxMesh.visible = true;
        // Gentle carrying bob
        w.boxMesh.position.y = 1.15 + Math.sin(w.animPhase * 2) * 0.03;

        stepWorkerAlongPath(w, delta);

        if (w.targetShelfPos) {
            const distToShelf = Math.hypot(w.body.position.x - w.targetShelfPos.x, w.body.position.z - w.targetShelfPos.z);
            if (distToShelf < 1.1 || w.nav.waypointIdx >= w.nav.path.length) {
                w.workerState = 'stocking_shelf';
                w.stateTimer = now + 3200; // 3.2s stocking animation
                w.hasStocked = false;
                w.body.velocity.x = 0;
                w.body.velocity.z = 0;
            }
        }
    }

    // 5. STATE: Stocking Shelf
    else if (w.workerState === 'stocking_shelf') {
        w.body.velocity.x = 0;
        w.body.velocity.z = 0;
        w.boxMesh.visible = true;

        // Face the shelf
        if (w.targetShelf) {
            const shelfAngle = Math.atan2(w.targetShelf.position.x - w.position.x, w.targetShelf.position.z - w.position.z);
            w.rotation.y = THREE.MathUtils.lerp(w.rotation.y, shelfAngle, delta * 6);
        }

        // Stocking motion: box bobs slightly as items are placed
        w.boxMesh.position.y = 1.15 + Math.sin(now * 0.008) * 0.04;

        // Perform actual restocking at halfway mark
        if (!w.hasStocked && now > (w.stateTimer - 1600)) {
            w.hasStocked = true;
            restockItemOnShelf(w.targetShelf);
        }

        if (now > w.stateTimer) {
            // Box is empty, put away box and return to register
            w.boxMesh.visible = false;
            w.workerState = 'returning_to_register';
            const startPt = { x: w.body.position.x, z: w.body.position.z };
            const exitCounterPt = { x: 10.5, z: -17.2 };
            const pathToCounter = navGrid ? findPath(navGrid, startPt, exitCounterPt) : [exitCounterPt];
            w.nav.path = [...pathToCounter, { x: w.registerStation.x, z: w.registerStation.z }];
            w.nav.waypointIdx = 0;
        }
    }

    // 6. STATE: Returning to Register Station
    else if (w.workerState === 'returning_to_register') {
        w.boxMesh.visible = false;
        stepWorkerAlongPath(w, delta);

        const distToReg = Math.hypot(w.body.position.x - w.registerStation.x, w.body.position.z - w.registerStation.z);
        if (distToReg < 0.8 || w.nav.waypointIdx >= w.nav.path.length) {
            w.workerState = 'idle_register';
            w.body.position.set(w.registerStation.x, 0.95, w.registerStation.z);
            w.body.velocity.x = 0;
            w.body.velocity.z = 0;
            w.nextRestockTime = now + (28000 + Math.random() * 20000); // next restock in 28-48s
        }
    }

    // Sync visual group position to physics body
    w.position.copy(w.body.position);
    w.position.y = 0; // feet on floor
}

// Restocker panics: box dropped, job abandoned, sprinting in random directions.
function updateWorkerNukePanic(w, delta, now) {
    if (w.workerState !== 'nuke_panic') {
        w.workerState = 'nuke_panic';
        w.boxMesh.visible = false;
        w.targetShelf = null;
        w.nav.path = [];
        w.panicNextTurn = 0;
    }
    if (Nuke.isWorldFrozen()) {
        w.body.velocity.x = 0; w.body.velocity.z = 0;
        return;
    }
    const pos = w.body.position;
    // Keep him inside the store area, bouncing off in a new direction
    const outOfBounds = Math.abs(pos.x) > 26 || Math.abs(pos.z) > 26;
    if (now >= w.panicNextTurn || outOfBounds) {
        const a = outOfBounds ? Math.atan2(-pos.z, -pos.x) + (Math.random() - 0.5) : Math.random() * Math.PI * 2;
        w.panicDir = { x: Math.cos(a), z: Math.sin(a) };
        w.panicNextTurn = now + 300 + Math.random() * 800;
    }
    const speed = 5.2;
    w.body.velocity.x = w.panicDir.x * speed;
    w.body.velocity.z = w.panicDir.z * speed;
    const targetAngle = Math.atan2(w.panicDir.x, w.panicDir.z);
    w.rotation.y = THREE.MathUtils.lerp(w.rotation.y, targetAngle, delta * 12);
    w.animPhase += delta * 10;
    const stride = Math.sin(w.animPhase);
    if (w.leftLeg) w.leftLeg.rotation.x = stride * 0.9;
    if (w.rightLeg) w.rightLeg.rotation.x = -stride * 0.9;
    if (w.head) w.head.rotation.y = Math.sin(now * 0.03) * 0.6;
    w.position.copy(pos);
    w.position.y = Math.abs(Math.sin(w.animPhase)) * 0.12;
}

// Staff stuck behind booths lose it in place: frantic hopping, spinning, head shaking.
function updateStaffNukePanic(now) {
    for (let i = staffModels.length - 1; i >= 0; i--) {
        const m = staffModels[i];
        if (!m.parent) { staffModels.splice(i, 1); continue; }
        if (m === storeWorker) continue;
        if (m.userData.panicBase === undefined) {
            m.userData.panicBase = { x: m.position.x, y: m.position.y, z: m.position.z, ry: m.rotation.y };
            m.userData.panicSeed = Math.random() * 100;
        }
        const b = m.userData.panicBase, k = m.userData.panicSeed, t = now * 0.001 + k;
        m.position.set(
            b.x + Math.sin(t * 7.3) * 0.12,
            b.y + Math.abs(Math.sin(t * 9)) * 0.28,
            b.z + Math.cos(t * 5.1) * 0.08
        );
        m.rotation.y = b.ry + Math.sin(t * 2.2) * 1.4 + Math.sin(t * 13) * 0.2;
        m.rotation.z = Math.sin(t * 11) * 0.12;
        if (m.head) m.head.rotation.y = Math.sin(t * 24) * 0.7;
        if (m.leftLeg) m.leftLeg.rotation.x = Math.sin(t * 18) * 0.6;
        if (m.rightLeg) m.rightLeg.rotation.x = -Math.sin(t * 18) * 0.6;
    }
}

// Move worker along waypoints
function stepWorkerAlongPath(w, delta) {
    if (!w.nav.path || w.nav.waypointIdx >= w.nav.path.length) return;

    const tgt = w.nav.path[w.nav.waypointIdx];
    const dx = tgt.x - w.body.position.x;
    const dz = tgt.z - w.body.position.z;
    const dist = Math.hypot(dx, dz);

    if (dist < 0.6) {
        w.nav.waypointIdx++;
        if (w.nav.waypointIdx >= w.nav.path.length) {
            w.body.velocity.x = 0;
            w.body.velocity.z = 0;
            return;
        }
    }

    const invLen = 1 / (dist || 1);
    const dirX = dx * invLen, dirZ = dz * invLen;
    w.body.velocity.x = dirX * w.walkSpeed;
    w.body.velocity.z = dirZ * w.walkSpeed;

    // Face movement direction
    const targetAngle = Math.atan2(dirX, dirZ);
    w.rotation.y = THREE.MathUtils.lerp(w.rotation.y, targetAngle, delta * 8);

    // Leg walking animation
    const stride = Math.sin(w.animPhase);
    if (w.leftLeg) w.leftLeg.rotation.x = stride * 0.45;
    if (w.rightLeg) w.rightLeg.rotation.x = -stride * 0.45;
}

// Spawn newly restocked item onto shelf
function restockItemOnShelf(shelfUnit) {
    if (!shelfUnit) return;

    // Mixed restocks still respect the original shelf-layer restrictions.
    const tierPools = shelfUnit.userData.tierPools || getShelfTierPools(ACTIVE_ITEMS, usingAltItems);
    const pool = [...new Set(tierPools.flat())];
    const uncollected = shoppingList.filter(i => i.collected < i.quantity && !outOfStockListItems.includes(i.name) && pool.some(it => it.name === i.name));
    let itemTemplate = null;
    if (uncollected.length > 0) {
        const pickName = uncollected[Math.floor(Math.random() * uncollected.length)].name;
        itemTemplate = ACTIVE_ITEMS.find(it => it.name === pickName);
    }
    if (!itemTemplate) {
        itemTemplate = pool[Math.floor(Math.random() * pool.length)];
    }
    if (!itemTemplate) return;

    // Shelf tier parameters
    const shelfWidth = shelfUnit.userData.width || 8;
    const shelfDepth = shelfUnit.userData.depth || 1.6;
    const dir = shelfUnit.userData.direction || 1;
    const rotY = shelfUnit.rotation.y;
    const cosR = Math.cos(rotY);
    const sinR = Math.sin(rotY);

    // Random allowed tier, including top-only household/misc items.
    const allowedTiers = tierPools.map((tier, i) => tier.some(item => item.name === itemTemplate.name) ? i : -1).filter(i => i >= 0);
    const tierIdx = allowedTiers[Math.floor(Math.random() * allowedTiers.length)];
    const tierY = shelfUnit.userData.tierTops?.[tierIdx] ?? (-2.4 + 0.22 + 0.28 + tierIdx * 1.10);
    const availHeight = shelfUnit.userData.tierClearance?.[tierIdx] ?? 0.95;
    const localX = (Math.random() - 0.5) * (shelfWidth - 2.0);
    const localZ = dir * (shelfDepth * 0.16);

    const worldItemX = shelfUnit.position.x + localX * cosR + localZ * sinR;
    const worldItemZ = shelfUnit.position.z - localX * sinR + localZ * cosR;
    const itemRotY = rotY + (dir === -1 ? Math.PI : 0) + (Math.random() - 0.5) * 0.25;

    const color = new THREE.Color(itemTemplate.color);
    const itemObj = createStaticItem(
        itemTemplate.name,
        color,
        itemTemplate.size,
        worldItemX,
        shelfUnit.position.y,
        worldItemZ,
        itemTemplate.model,
        itemRotY,
        tierY,
        availHeight
    );

    if (itemObj) {
        if (shelfUnit.userData && shelfUnit.userData.items) {
            shelfUnit.userData.items.push(itemObj);
        }
        const doors = shelfUnit.userData.doors;
        if (doors?.length >= 2) {
            const door = localX < 0 ? doors[0] : doors[1];
            itemObj.freezerDoor = door;
            door.itemsInside.push(itemObj);
        }
        storeStockCounts[itemTemplate.name] = (storeStockCounts[itemTemplate.name] || 0) + 1;
        
        // Notification
        displayMessage(`Store worker restocked ${itemTemplate.name}!`, 2200);
    }
}

function createCustomer({ tweaker = false } = {}) {
    const customerGroup = new THREE.Group();

    // Unified proportions (Preserve exact aesthetic)
    const totalHeight = 1.8;      // overall character height
    const legHeight = 0.8;
    const torsoHeight = 0.8;
    const headRadius = 0.2;
    const hipY = legHeight;                 // top of legs
    const chestY = hipY + torsoHeight / 2;  // torso center
    const headY = hipY + torsoHeight + headRadius; // head center

    // Colors
    const torsoColors = [0x333333, 0x444444, 0x555555, 0x666666];
    const randomTorsoColor = torsoColors[Math.floor(Math.random() * torsoColors.length)];
    const skinTones = [0xFFE0C4, 0xFACDAD, 0xD2B48C, 0xA0522D];
    const randomSkinToneHead = skinTones[Math.floor(Math.random() * skinTones.length)];

    // Head
    const headGeometry = new THREE.SphereGeometry(headRadius, 16, 16);
    const headMaterial = new THREE.MeshStandardMaterial({ color: randomSkinToneHead, roughness: 0.8 });
    const head = new THREE.Mesh(headGeometry, headMaterial);
    head.position.y = headY;
    customerGroup.add(head);
    customerGroup.head = head;

    // Genuine 3D Eyes with Eyelids (Parented to head for realistic head motion)
    const eyeWhiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.25 });
    const pupilMat = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.2 });

    const createEyeWithLids = (posX, posY, posZ) => {
        const eyeGroup = new THREE.Group();
        eyeGroup.position.set(posX, posY, posZ);

        // Eyeball
        const eyeball = new THREE.Mesh(new THREE.SphereGeometry(0.058, 14, 14), eyeWhiteMat);
        eyeGroup.add(eyeball);

        // Pupil (never squished, remains spherical)
        const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.028, 12, 12), pupilMat);
        pupil.position.set(0, 0, 0.046);
        eyeGroup.add(pupil);

        // Genuine Upper Eyelid Shell (matching skin tone)
        const eyelidPivot = new THREE.Group();
        const eyelidGeo = new THREE.SphereGeometry(0.063, 16, 14, 0, Math.PI * 2, 0, Math.PI * 0.52);
        const eyelidMesh = new THREE.Mesh(eyelidGeo, headMaterial);
        eyelidPivot.add(eyelidMesh);
        // Default open state (retracted up)
        eyelidPivot.rotation.x = -Math.PI * 0.55;
        eyeGroup.add(eyelidPivot);

        return { eyeGroup, eyelidPivot };
    };

    const eyeRData = createEyeWithLids(0.105, 0.02, 0.165);
    const eyeLData = createEyeWithLids(-0.105, 0.02, 0.165);
    head.add(eyeRData.eyeGroup);
    head.add(eyeLData.eyeGroup);

    customerGroup.eyelids = [eyeRData.eyelidPivot, eyeLData.eyelidPivot];
    customerGroup.blinkNext = performance.now() + 1000 + Math.random() * 3000;

    // Torso
    const bodyGeometry = new THREE.CylinderGeometry(0.35, 0.3, torsoHeight, 16);
    const rainbowShirts = [0xf06292, 0xffa94d, 0xf5d65a, 0x67c77c, 0x57c4dc, 0x8c91ee, 0xc184d9];
    const customerSkin = tweaker ? null : pickCustomerSkin();
    const shirtColor = customerSkin === 'rainbow'
        ? rainbowShirts[nextCustomerEntityId % rainbowShirts.length]
        : randomTorsoColor;
    const bodyMaterial = new THREE.MeshStandardMaterial({ color: shirtColor });
    const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
    body.position.y = chestY;
    customerGroup.add(body);
    customerGroup.bodyMesh = body;

    // Legs (feet sit on y=0)
    const legGeom = new THREE.CylinderGeometry(0.09, 0.09, legHeight, 12);
    const legMat = new THREE.MeshStandardMaterial({ color: randomTorsoColor });
    const leftLeg = new THREE.Mesh(legGeom, legMat);
    leftLeg.position.set(-0.18, legHeight / 2, 0);
    const rightLeg = new THREE.Mesh(legGeom, legMat);
    rightLeg.position.set(0.18, legHeight / 2, 0);
    customerGroup.add(leftLeg, rightLeg);
    customerGroup.leftLeg = leftLeg;
    customerGroup.rightLeg = rightLeg;
    if (customerSkin) dressCustomer(customerGroup, customerSkin);

    // Initial scene position: spawn near assigned zone
    customerGroup.zone = pickZone();
    const spawnPos = jitterAroundZone(customerGroup.zone, 8);
    const validSpawn = navGrid ? clampToWalkable(navGrid, spawnPos.x, spawnPos.z) : spawnPos;
    customerGroup.position.set(validSpawn.x, 0, validSpawn.z);

    // Dynamic Behavioral Roles: Shopper, Speed Shopper, Browser, or Shoplifter
    const roleRoll = Math.random();
    if (roleRoll < 0.08) {
        customerGroup.role = 'shoplifter';
        customerGroup.walkSpeed = 1.45 + Math.random() * 0.35;
    } else if (roleRoll < 0.30) {
        customerGroup.role = 'speed_shopper';
        customerGroup.walkSpeed = 1.65 + Math.random() * 0.45;
    } else if (roleRoll < 0.70) {
        customerGroup.role = 'regular_shopper';
        customerGroup.walkSpeed = 1.30 + Math.random() * 0.35;
    } else {
        customerGroup.role = 'casual_browser';
        customerGroup.walkSpeed = 1.15 + Math.random() * 0.30;
    }

    customerGroup.customerId = nextCustomerEntityId++;
    customerGroup.behaviorState = 'navigating';
    customerGroup.shoppingListQuota = 2 + Math.floor(Math.random() * 4);
    customerGroup.itemsGathered = 0;
    customerGroup.hasStolenItem = false;
    customerGroup.socialPartner = null;
    customerGroup.socialUntil = 0;
    customerGroup.socialCooldownUntil = performance.now() + 8000 + Math.random() * 10000;
    customerGroup.inspectUntil = 0;
    customerGroup.checkoutUntil = 0;
    customerGroup.bumpYieldUntil = 0;
    customerGroup.bumpReactionUntil = 0;
    customerGroup.bumpCooldownUntil = 0;
    customerGroup.bumpTarget = null;
    customerGroup.lastProgressPos = new THREE.Vector3(validSpawn.x, 0, validSpawn.z);
    customerGroup.lastProgressTime = performance.now();
    customerGroup.stuckCount = 0;

    customerGroup.nav = { path: [], waypointIdx: 0, target: null };
    customerGroup.animPhase = Math.random() * Math.PI * 2;
    customerGroup.nextQuestionAt = performance.now() + (120000 + Math.random() * 60000);
    customerGroup.interacting = false;
    customerGroup.zoneSwitchAt = performance.now() + (40000 + Math.random() * 40000);
    customerGroup.handItem = null;
    customerGroup.lastAnalyzeCheck = 0;
    customerGroup.analyzeCooldownUntil = 0;

    scene.add(customerGroup);
    if (!tweaker) customers.push(customerGroup);

    // Physics body
    const customerShape = new CANNON.Box(new CANNON.Vec3(0.35, totalHeight / 2, 0.35));
    const customerBody = new CANNON.Body({
        mass: 60,
        position: new CANNON.Vec3(validSpawn.x, totalHeight / 2 + 0.05, validSpawn.z),
        shape: customerShape
    });
    customerBody.linearFactor = new CANNON.Vec3(1, 0, 1);
    customerBody.fixedRotation = true;
    customerBody.updateMassProperties();
    world.addBody(customerBody);
    customerGroup.body = customerBody;
    customerBody.userData = { entity: customerGroup };
    if (physicsMaterials && physicsMaterials.customerPhysMaterial) {
        customerBody.material = physicsMaterials.customerPhysMaterial;
    }
    customerBody.collisionResponse = true;
    customerBody.isTrigger = false;
    customerBody.collisionFilterGroup = 4;
    customerBody.collisionFilterMask = 1 | 2 | 4; // Collide with Player (1), Shelves (2), and other Customers (4)

    // 25% of customers get a cart
    customerGroup.hasCart = !tweaker && (customerGroup.role !== 'shoplifter') && (Math.floor(Math.random() * 4) === 0);
    if (customerGroup.hasCart) {
        customerGroup.walkSpeed *= 0.92;
        customerGroup.cart = createNpcCartForCustomer(customerGroup);
        customerGroup.cart.group.position.set(customerBody.position.x, 0, customerBody.position.z + 0.75);
    }

    // Set initial target
    if (!tweaker) setCustomerTarget(customerGroup);
    return customerGroup;
}

// Simple obstacle list for customer avoidance
let obstacles = [];
let constructionZones = [];
let sampleBooths = [];

// Whisker obstacle detection against store collision layout
function checkWhiskerObstacle(x, z, angle, length = 1.1) {
    if (!navGrid) return false;
    const checkX = x + Math.sin(angle) * length;
    const checkZ = z + Math.cos(angle) * length;
    return !isWalkable(navGrid, checkX, checkZ);
}

// Set a customer's navigational target based on state and role
function setCustomerTarget(cust, targetMode = null) {
    if (!navGrid) return;
    const now = performance.now();
    
    let mode = targetMode;
    if (!mode) {
        if (cust.role === 'shoplifter' && cust.hasStolenItem) {
            mode = 'exit';
        } else if (cust.behaviorState === 'checkout' || (cust.itemsGathered >= cust.shoppingListQuota && cust.shoppingListQuota > 0)) {
            mode = 'checkout';
        } else {
            mode = 'shelf';
        }
    }

    let target = null;

    if (mode === 'leaving_store') {
        let car = parkingLotCars.find(c => !c.assigned && !c.isDriving && c.z > -85);
        if (!car && parkingLotCars.length > 0) car = parkingLotCars[Math.floor(Math.random() * parkingLotCars.length)];
        if (car) {
            car.assigned = true;
            if (car.origX === undefined) {
                car.origX = car.x;
                car.origZ = car.z;
                car.origHeading = car.heading;
            }
        }
        cust.assignedCar = car;

        const doorInside = { x: 0, z: -27.5 };
        const doorOutside = { x: 0, z: -33.5 };
        const carX = car ? (car.x - 1.2 * Math.cos(car.heading)) : 0;
        const carZ = car ? (car.z - 1.2 * Math.sin(car.heading)) : -45;
        const carDoorPos = { x: carX, z: carZ };

        const startPos = { x: cust.body.position.x, z: cust.body.position.z };
        const pathToDoor = (navGrid ? findPath(navGrid, startPos, doorInside) : null) || [doorInside];
        cust.nav = cust.nav || {};
        cust.nav.path = [...pathToDoor, doorOutside, carDoorPos];
        cust.nav.waypointIdx = 0;
        cust.behaviorState = 'walking_to_car';
        return;
    } else if (mode === 'exit') {
        // Exit doors near entrance (0, 0, -26)
        const ex = (Math.random() - 0.5) * 4;
        const ez = -26.5;
        const pt = clampToWalkable(navGrid, ex, ez);
        target = new THREE.Vector3(pt.x, 0, pt.z);
        cust.behaviorState = 'sneaking';
    } else if (mode === 'checkout') {
        // Line near checkout register (12.5, 0, -13.5)
        const cx = 12.5 + (Math.random() - 0.5) * 2.0;
        const cz = -13.5 + (Math.random() - 0.5) * 1.5;
        const pt = clampToWalkable(navGrid, cx, cz);
        target = new THREE.Vector3(pt.x, 0, pt.z);
        cust.behaviorState = 'navigating';
        cust.nextTargetMode = 'checkout_wait';
    } else {
        // Pick shelf to visit
        if (shelfUnits.length > 0) {
            const zone = cust.zone || pickZone();
            const nearUnit = (Math.random() < 0.6) 
                ? (nearestShelfUnitTo(zone.x, zone.z) || shelfUnits[Math.floor(Math.random() * shelfUnits.length)])
                : shelfUnits[Math.floor(Math.random() * shelfUnits.length)];
            
            cust.targetUnit = nearUnit;
            const rot = nearUnit.userData?.rotY || nearUnit.rotation?.y || 0;
            const dir = nearUnit.userData?.direction || 1;
            const nx = Math.sin(rot) * dir;
            const nz = Math.cos(rot) * dir;
            // The full-size cart remains ahead of the shopper while browsing.
            const standDist = cust.hasCart ? 3.3 : 2.2;
            const tx = nearUnit.position.x + nx * standDist;
            const tz = nearUnit.position.z + nz * standDist;
            const pt = clampToWalkable(navGrid, tx, tz);
            target = new THREE.Vector3(pt.x, 0, pt.z);
        } else {
            const z = cust.zone || pickZone();
            const pt = clampToWalkable(navGrid, z.x + (Math.random() - 0.5) * 6, z.z + (Math.random() - 0.5) * 6);
            target = new THREE.Vector3(pt.x, 0, pt.z);
        }
        cust.behaviorState = 'navigating';
        cust.nextTargetMode = 'inspecting';
    }

    if (cust.handItem && cust.handItem.mesh) {
        if (cust.handItem.mesh.parent !== cust) {
            if (cust.handItem.mesh.parent) cust.handItem.mesh.parent.remove(cust.handItem.mesh);
            cust.add(cust.handItem.mesh);
        }
        cust.handItem.mesh.position.set(0, 1.0, 0.35);
        cust.handItem.mesh.rotation.set(0, Math.PI / 12, 0);
    }

    cust.nav = cust.nav || {};
    cust.nav.target = target;
    const startPos = { x: cust.body.position.x, z: cust.body.position.z };
    cust.nav.path = findPath(navGrid, startPos, { x: target.x, z: target.z });
    cust.nav.waypointIdx = 0;
    cust.nav.nextRepath = now + (10000 + Math.random() * 5000);
}

// ---------------- LONELY STORE CREEPY STALKER ENTITY ----------------
function createStalker() {
    const stalker = new THREE.Group();
    stalker.name = 'stalker_entity';

    // Materials
    const darkShadowMat = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.98 });
    const paleFaceMat = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.35 });
    const eyeSocketMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
    const eyeGlowMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const smileMat = new THREE.MeshBasicMaterial({ color: 0x110505 });

    // 1. Slender, towering shadowy body (~2.3m height)
    const torsoGeo = new THREE.CylinderGeometry(0.22, 0.28, 1.25, 14);
    const torso = new THREE.Mesh(torsoGeo, darkShadowMat);
    torso.position.y = 1.15;
    stalker.add(torso);

    // Dark drooping shoulders
    const shoulders = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.16, 0.32), darkShadowMat);
    shoulders.position.set(0, 1.72, 0);
    stalker.add(shoulders);

    // Spindly elongated arms hanging down past knees
    [-0.38, 0.38].forEach(ax => {
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.035, 1.35, 10), darkShadowMat);
        arm.position.set(ax, 1.05, 0.04);
        arm.rotation.z = ax < 0 ? -0.08 : 0.08;
        stalker.add(arm);
    });

    // 2. Uncanny Pale Head & Terrifying Smile
    const headGroup = new THREE.Group();
    headGroup.position.set(0, 1.95, 0.05);
    stalker.add(headGroup);
    stalker.headGroup = headGroup;

    // Pale oval face
    const faceGeo = new THREE.SphereGeometry(0.20, 16, 16);
    faceGeo.scale(1.0, 1.35, 0.85);
    const faceMesh = new THREE.Mesh(faceGeo, paleFaceMat);
    headGroup.add(faceMesh);

    // Dark shadow hood framing the face
    const hood = new THREE.Mesh(new THREE.SphereGeometry(0.23, 16, 16), darkShadowMat);
    hood.scale.set(1.08, 1.40, 0.82);
    hood.position.set(0, 0, -0.06);
    headGroup.add(hood);

    // Giant sunken black eye sockets
    [-0.075, 0.075].forEach(ex => {
        const socket = new THREE.Mesh(new THREE.SphereGeometry(0.048, 12, 12), eyeSocketMat);
        socket.position.set(ex, 0.06, 0.145);
        
        // Intense tiny piercing glowing white pupils
        const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.016, 8, 8), eyeGlowMat);
        pupil.position.set(ex, 0.06, 0.182);
        headGroup.add(socket, pupil);
    });

    // Wide unsettling rictus grin
    const smile = new THREE.Mesh(new THREE.TorusGeometry(0.095, 0.022, 8, 16, Math.PI * 0.9), smileMat);
    smile.rotation.x = Math.PI * 0.12;
    smile.rotation.z = Math.PI;
    smile.position.set(0, -0.12, 0.155);
    headGroup.add(smile);

    // State & AI variables
    stalker.stareDuration = 0;
    stalker.isVanished = false;
    stalker.reappearAt = 0;

    return stalker;
}

const _stalkerCamDir = new THREE.Vector3();
const _stalkerToVec = new THREE.Vector3();
function updateStalker(delta) {
    if (!lonelyStoreStalker || !isLonelyStoreMode || !gameStarted || isCheckout || gameOver || gamePaused || introCutsceneActive) {
        soundEffects?.stalkerWhispers?.pause();
        return;
    }
    const now = performance.now();
    const stalker = lonelyStoreStalker;

    if (stalker.isVanished) {
        soundEffects?.stalkerWhispers?.pause();
        if (now >= stalker.reappearAt) {
            relocateStalkerToDistantAisle();
        }
        return;
    }

    // Look directly towards player camera
    if (camera) {
        stalker.lookAt(camera.position.x, stalker.position.y, camera.position.z);

        // Check if player is looking at the stalker
        const camDir = camera.getWorldDirection(_stalkerCamDir);
        const toStalker = _stalkerToVec.subVectors(stalker.position, camera.position).normalize();
        const dot = camDir.dot(toStalker);
        const dist = camera.position.distanceTo(stalker.position);
        const whispers = soundEffects?.stalkerWhispers;
        if (whispers) {
            const closeness = Math.max(0, 1 - dist / 19);
            if (closeness > 0) {
                whispers.volume = Math.min(1, CONFIG.SFX_VOLUME * 2.4 * closeness * closeness);
                if (whispers.paused) whispers.play().catch(() => {});
            } else if (!whispers.paused) {
                whispers.pause();
            }
        }

        // Subtle head tilt / twitch when stared at
        if (dot > 0.65) {
            stalker.stareDuration = (stalker.stareDuration || 0) + delta;
            if (stalker.headGroup) {
                stalker.headGroup.rotation.z = Math.sin(now * 0.003) * 0.32;
                stalker.headGroup.rotation.x = 0.12 + Math.sin(now * 0.006) * 0.08;
            }

            // Vanish if player stares for 5 seconds or gets right up to it (< 3.5m)
            if (stalker.stareDuration >= 5.0 || dist < 3.5) {
                vanishStalker();
            }
        } else {
            stalker.stareDuration = 0;
            if (stalker.headGroup) {
                stalker.headGroup.rotation.z = THREE.MathUtils.lerp(stalker.headGroup.rotation.z, 0, delta * 4);
                stalker.headGroup.rotation.x = THREE.MathUtils.lerp(stalker.headGroup.rotation.x, 0, delta * 4);
            }
        }
    }
}

function vanishStalker() {
    if (!lonelyStoreStalker) return;
    soundEffects?.stalkerWhispers?.pause();
    lonelyStoreStalker.visible = false;
    lonelyStoreStalker.isVanished = true;
    lonelyStoreStalker.stareDuration = 0;
    // Reappear after 8 to 15 seconds
    lonelyStoreStalker.reappearAt = performance.now() + (8000 + Math.random() * 7000);
}

function relocateStalkerToDistantAisle() {
    if (!lonelyStoreStalker || !playerBody) return;
    const px = playerBody.position.x;
    const pz = playerBody.position.z;

    const candidateZones = [
        { x: -18, z: -18 }, { x: -18, z: 0 }, { x: -18, z: 18 },
        { x: 18, z: -18 }, { x: 18, z: 0 }, { x: 18, z: 18 },
        { x: 0, z: -20 }, { x: 0, z: 20 }, { x: -8, z: -14 }, { x: 8, z: 14 }
    ];

    const sorted = candidateZones
        .map(z => ({ ...z, dist: Math.hypot(z.x - px, z.z - pz) }))
        .filter(z => z.dist >= 12 && z.dist <= 26)
        .sort(() => Math.random() - 0.5);

    const chosen = sorted[0] || { x: -px * 0.8, z: -pz * 0.8 };
    lonelyStoreStalker.position.set(chosen.x, 0, chosen.z);
    lonelyStoreStalker.visible = true;
    lonelyStoreStalker.isVanished = false;
    lonelyStoreStalker.stareDuration = 0;
}

function createThief() {
    const gnome = new THREE.Group();
    gnome.name = 'gnome_thief';

    // Materials
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xffdfba, roughness: 0.75 });
    const noseMat = new THREE.MeshStandardMaterial({ color: 0xfca5a5, roughness: 0.65 });
    const greenTunicMat = new THREE.MeshStandardMaterial({ color: 0x15803d, roughness: 0.85 }); // classic emerald tunic
    const beltMat = new THREE.MeshStandardMaterial({ color: 0x3f1d0b, roughness: 0.7 });
    const buckleMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.3, metalness: 0.8 });
    const pantsMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.9 });
    const bootMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.8 });
    const towelMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.95 }); // fluffy towel
    const hatMat = new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.6 }); // vibrant pointy red hat
    const beardMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.98 });
    const mittenMat = new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.8 });
    const sackMat = new THREE.MeshStandardMaterial({ color: 0x78350f, roughness: 0.95 });

    // 1. CROUCHING ROOT & TORSO PIVOT (Low to ground, tilted forward)
    const torsoPivot = new THREE.Group();
    torsoPivot.position.set(0, 0.38, 0);
    torsoPivot.rotation.x = 0.35; // 20-degree forward crouch
    gnome.add(torsoPivot);
    gnome.torsoPivot = torsoPivot;

    // Tunic / Torso Body
    const bodyGeo = new THREE.CylinderGeometry(0.20, 0.24, 0.36, 14);
    const bodyMesh = new THREE.Mesh(bodyGeo, greenTunicMat);
    bodyMesh.position.set(0, 0, 0);
    torsoPivot.add(bodyMesh);

    // Leather Belt & Buckle
    const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.245, 0.245, 0.06, 14), beltMat);
    belt.position.set(0, -0.06, 0);
    const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.08, 0.04), buckleMat);
    buckle.position.set(0, -0.06, 0.23);
    torsoPivot.add(belt, buckle);

    // Stolen Goods Burlap Sack on his back
    const sack = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 12), sackMat);
    sack.scale.set(1.0, 1.25, 0.9);
    sack.position.set(0, 0.05, -0.24);
    torsoPivot.add(sack);
    gnome.lootSack = sack;

    // 2. HEAD & ICONIC GNOME FEATURES
    const headGroup = new THREE.Group();
    headGroup.position.set(0, 0.22, 0.06);
    torsoPivot.add(headGroup);
    gnome.headGroup = headGroup;

    // Head sphere
    const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.14, 14, 14), skinMat);
    headGroup.add(headMesh);

    // Big bulbous rosy gnome nose
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.052, 12, 12), noseMat);
    nose.position.set(0, -0.01, 0.14);
    headGroup.add(nose);

    // Mischievous eyes
    const eyeWhiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const pupilMat = new THREE.MeshStandardMaterial({ color: 0x000000 });
    [-0.055, 0.055].forEach(ex => {
        const eyeW = new THREE.Mesh(new THREE.SphereGeometry(0.024, 10, 10), eyeWhiteMat);
        eyeW.position.set(ex, 0.04, 0.125);
        const eyeP = new THREE.Mesh(new THREE.SphereGeometry(0.013, 8, 8), pupilMat);
        eyeP.position.set(ex, 0.04, 0.145);
        headGroup.add(eyeW, eyeP);

        // Bushy white eyebrow
        const brow = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.018, 0.02), beardMat);
        brow.position.set(ex, 0.07, 0.13);
        headGroup.add(brow);
    });

    // Magnificent Fluffy White Beard flowing down chest
    const beardGroup = new THREE.Group();
    const mainBeard = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.38, 12), beardMat);
    mainBeard.rotation.x = 2.7;
    mainBeard.position.set(0, -0.15, 0.10);
    beardGroup.add(mainBeard);
    [-0.09, 0.09].forEach(bx => {
        const sideFluff = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 10), beardMat);
        sideFluff.position.set(bx, -0.06, 0.08);
        beardGroup.add(sideFluff);
    });
    headGroup.add(beardGroup);

    // Tall Pointy Red Hat (Curved / bent tip)
    const hatGroup = new THREE.Group();
    hatGroup.position.set(0, 0.10, -0.02);
    const hatBase = new THREE.Mesh(new THREE.ConeGeometry(0.20, 0.38, 16), hatMat);
    hatBase.position.set(0, 0.16, 0);
    hatBase.rotation.x = -0.15;
    hatGroup.add(hatBase);
    const hatTip = new THREE.Mesh(new THREE.ConeGeometry(0.10, 0.28, 12), hatMat);
    hatTip.position.set(0, 0.36, -0.06);
    hatTip.rotation.x = -0.45;
    hatGroup.add(hatTip);
    headGroup.add(hatGroup);
    gnome.hatGroup = hatGroup;

    // 3. TOWEL WRAPPED AROUND NECK
    const towelGroup = new THREE.Group();
    towelGroup.position.set(0, 0.15, 0.02);

    // Collar wrap
    const towelCollar = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.048, 10, 18), towelMat);
    towelCollar.rotation.x = Math.PI / 2;
    towelGroup.add(towelCollar);

    // Towel drape tails falling down front over chest
    const leftTail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.26, 0.04), towelMat);
    leftTail.position.set(-0.09, -0.13, 0.15);
    leftTail.rotation.z = -0.12;

    const rightTail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.26, 0.04), towelMat);
    rightTail.position.set(0.09, -0.13, 0.15);
    rightTail.rotation.z = 0.12;

    towelGroup.add(leftTail, rightTail);
    torsoPivot.add(towelGroup);

    // 4. ARMS HOLDING THE TOWEL
    // Left Arm (holding left towel drape)
    const armL = new THREE.Group();
    armL.position.set(-0.20, 0.08, 0.02);
    const upArmL = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.042, 0.18), greenTunicMat);
    upArmL.rotation.z = 0.55;
    upArmL.rotation.x = 0.45;
    upArmL.position.set(0.02, -0.06, 0.04);
    const handL = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 10), mittenMat);
    handL.position.set(0.11, -0.12, 0.13);
    armL.add(upArmL, handL);
    torsoPivot.add(armL);

    // Right Arm (holding right towel drape)
    const armR = new THREE.Group();
    armR.position.set(0.20, 0.08, 0.02);
    const upArmR = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.042, 0.18), greenTunicMat);
    upArmR.rotation.z = -0.55;
    upArmR.rotation.x = 0.45;
    upArmR.position.set(-0.02, -0.06, 0.04);
    const handR = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 10), mittenMat);
    handR.position.set(-0.11, -0.12, 0.13);
    armR.add(upArmR, handR);
    torsoPivot.add(armR);

    // 5. TWO-SEGMENTED LEGS (Left & Right Hips -> Thighs -> Knees -> Shins -> Elf Boots)
    // Left Leg
    const hipL = new THREE.Group();
    hipL.position.set(-0.12, 0.32, 0);
    gnome.add(hipL);
    gnome.hipL = hipL;

    const thighL = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.048, 0.18, 10), pantsMat);
    thighL.position.set(0, -0.09, 0);
    hipL.add(thighL);

    const kneeL = new THREE.Group();
    kneeL.position.set(0, -0.18, 0);
    hipL.add(kneeL);
    gnome.kneeL = kneeL;

    const shinL = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.042, 0.18, 10), pantsMat);
    shinL.position.set(0, -0.09, 0);
    kneeL.add(shinL);

    const bootL = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.06, 0.15), bootMat);
    bootL.position.set(0, -0.16, 0.04);
    kneeL.add(bootL);

    // Right Leg
    const hipR = new THREE.Group();
    hipR.position.set(0.12, 0.32, 0);
    gnome.add(hipR);
    gnome.hipR = hipR;

    const thighR = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.048, 0.18, 10), pantsMat);
    thighR.position.set(0, -0.09, 0);
    hipR.add(thighR);

    const kneeR = new THREE.Group();
    kneeR.position.set(0, -0.18, 0);
    hipR.add(kneeR);
    gnome.kneeR = kneeR;

    const shinR = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.042, 0.18, 10), pantsMat);
    shinR.position.set(0, -0.09, 0);
    kneeR.add(shinR);

    const bootR = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.06, 0.15), bootMat);
    bootR.position.set(0, -0.16, 0.04);
    kneeR.add(bootR);

    gnome.animTime = 0;
    gnome.stolenCount = 0;
    gnome.walkSpeed = 7.5; // very fast sprint
    gnome.state = 'stealing';

    return gnome;
}

function startThiefEscape() {
    if (!thief || thief.state === 'escaping') return;
    thief.state = 'escaping';
    thief.stealTargets = [];
    thief.walkSpeed = 9.2; // sprint to escape

    const currentPt = { x: thief.position.x, z: thief.position.z };
    const toLobby = (navGrid ? findPath(navGrid, currentPt, { x: 0, z: -27.0 }) : null) || [{ x: 0, z: -27.0 }];
    
    // Straight run out front sliding doors into the parking lot road
    const fullEscapePath = [
        ...toLobby,
        { x: 0, z: -30.5 },
        { x: 0, z: -36.0 },
        { x: 0, z: -46.0 },
        { x: 0, z: -62.0 }
    ];

    thief.navPath = fullEscapePath;
    thief.currentWpIdx = 0;
}

const _thiefItemPos = new THREE.Vector3();
function updateGnomeThief(delta) {
    if (!thief || !gameStarted || isCheckout || gameOver) return;

    thief.animTime = (thief.animTime || 0) + delta * 24;
    const t = thief.animTime;

    // 2-segmented crouching waddle leg animation
    if (thief.hipL && thief.kneeL && thief.hipR && thief.kneeR) {
        thief.hipL.rotation.x = Math.sin(t) * 0.70 - 0.25;
        thief.kneeL.rotation.x = Math.max(0.1, Math.sin(t - 0.7) * 1.05) + 0.35;

        thief.hipR.rotation.x = Math.sin(t + Math.PI) * 0.70 - 0.25;
        thief.kneeR.rotation.x = Math.max(0.1, Math.sin(t + Math.PI - 0.7) * 1.05) + 0.35;
    }

    // Waddling side-to-side torso sway and vertical scurrying bob
    if (thief.torsoPivot) {
        thief.torsoPivot.rotation.z = Math.sin(t * 0.5) * 0.18;
        thief.torsoPivot.position.y = 0.36 + Math.abs(Math.sin(t)) * 0.04;
    }
    if (thief.hatGroup) {
        thief.hatGroup.rotation.z = Math.sin(t * 0.5) * 0.14;
    }

    // Steal nearby items as gnome runs past shelves (only while in stealing mode)
    if (thief.state !== 'escaping' && thief.stealTargets && thief.stealTargets.length > 0) {
        for (let i = thief.stealTargets.length - 1; i >= 0; i--) {
            const item = thief.stealTargets[i];
            if (!item || item.stolen || !item.mesh) {
                thief.stealTargets.splice(i, 1);
                continue;
            }
            const itemWorldPos = item.mesh.getWorldPosition(_thiefItemPos);
            const dist = Math.hypot(itemWorldPos.x - thief.position.x, itemWorldPos.z - thief.position.z);
            if (dist < 3.2) {
                // Snatched!
                if (item.mesh.parent) item.mesh.parent.remove(item.mesh);
                if (item.body) { try { world.removeBody(item.body); } catch(_) {} }
                item.stolen = true;
                thief.stolenCount = (thief.stolenCount || 0) + 1;
                thief.stealTargets.splice(i, 1);

                if (thief.lootSack) {
                    const sackScale = 1.0 + Math.min(0.7, thief.stolenCount * 0.04);
                    thief.lootSack.scale.set(sackScale, sackScale * 1.25, sackScale * 0.9);
                }
            }
        }
        if (thief.stealTargets.length === 0) {
            startThiefEscape();
        }
    }

    // Pathfinding / Navigation between target waypoints
    const wpList = thief.navPath || [];
    const wp = wpList[thief.currentWpIdx || 0];
    if (wp) {
        const dx = wp.x - thief.position.x;
        const dz = wp.z - thief.position.z;
        const dist = Math.hypot(dx, dz);

        if (dist < 0.95) {
            thief.currentWpIdx = (thief.currentWpIdx || 0) + 1;
            if (thief.currentWpIdx >= wpList.length) {
                if (thief.state !== 'escaping') {
                    startThiefEscape();
                } else {
                    // Escaped out through front entrance doors into the parking lot
                    if (thief.parent) thief.parent.remove(thief);
                    thief = null;
                    lastMajorEventEndTime = performance.now();
                    displayMessage("The gnome escaped outside through the front doors!", 3500, true);
                    return;
                }
            }
        } else {
            const moveSpeed = thief.walkSpeed || 7.5;
            const moveStep = Math.min(dist, moveSpeed * delta);
            thief.position.x += (dx / dist) * moveStep;
            thief.position.z += (dz / dist) * moveStep;

            const targetYaw = Math.atan2(dx, dz);
            slerpToYaw(thief, targetYaw, 0.25);
        }
    } else {
        if (thief.state !== 'escaping') {
            startThiefEscape();
        } else {
            // Fallback exit through doors into parking lot
            thief.position.z -= (thief.walkSpeed || 7.5) * delta;
            if (thief.position.z < -52) {
                if (thief.parent) thief.parent.remove(thief);
                thief = null;
                lastMajorEventEndTime = performance.now();
                displayMessage("The gnome escaped outside through the front doors!", 3500, true);
                return;
            }
        }
    }

    // Check if gnome reached outside parking lot while escaping
    if (thief && thief.state === 'escaping' && thief.position.z <= -52) {
        if (thief.parent) thief.parent.remove(thief);
        thief = null;
        lastMajorEventEndTime = performance.now();
        displayMessage("The gnome escaped outside through the front doors!", 3500, true);
    }
}

function triggerThiefEvent(isManual = false) {
    if (thief || !gameStarted || isCheckout || gameOver || purchaseComplete) return false;

    // Create the Gnome Thief
    thief = createThief();
    thief.position.set(0, 0, -32); // Spawns outside at the entrance doors
    scene.add(thief);
    thiefEventOccurred = true;

    // Steal 30% of eligible store items on the shelves
    const storeItems = allItems.filter(item => !item.inCart && item.mesh && item.mesh.visible && !item.stolen && !item.inCustomerCart);
    const stealCount = Math.max(1, Math.floor(storeItems.length * 0.30));
    const shuffledItems = storeItems.slice().sort(() => Math.random() - 0.5);
    const targetItemsToSteal = shuffledItems.slice(0, stealCount);
    thief.stealTargets = targetItemsToSteal;

    // Build a sprint path visiting the shelves where items are located, then running out the front doors
    const visitPoints = [];
    targetItemsToSteal.forEach(item => {
        if (item.mesh) {
            const pos = new THREE.Vector3();
            item.mesh.getWorldPosition(pos);
            const standPos = { x: pos.x + (Math.random() - 0.5) * 1.5, z: pos.z + (Math.random() - 0.5) * 1.5 };
            visitPoints.push(standPos);
        }
    });

    const sampledStops = [];
    const step = Math.max(1, Math.floor(visitPoints.length / 8));
    for (let i = 0; i < visitPoints.length; i += step) {
        sampledStops.push(visitPoints[i]);
    }

    // Generate path through shelves
    let fullPath = [];
    let currentPt = { x: 0, z: -27 };
    sampledStops.forEach(st => {
        const seg = (navGrid ? findPath(navGrid, currentPt, st) : null) || [st];
        fullPath = fullPath.concat(seg);
        currentPt = st;
    });

    thief.navPath = fullPath;
    thief.currentWpIdx = 0;

    displayMessage("🧙‍♂️ A mischievous gnome broke in and is snatching items from the shelves!", 5000, true);

    // Escape trigger timeout (after 20 seconds, force escape run out the door)
    const escapeTimerId = setTimeout(() => {
        if (thief && thief.state !== 'escaping') {
            startThiefEscape();
        }
    }, 20000);
    // Hard failsafe cleanup timeout (35 seconds max)
    const endTimerId = setTimeout(() => {
        if (thief) {
            if (thief.parent) thief.parent.remove(thief);
            thief = null;
        }
        lastMajorEventEndTime = performance.now();
    }, 35000);
    scheduledEventTimeouts.push(escapeTimerId, endTimerId);
    return true;
}

function triggerBabyCrying() {
    if (isLonelyStoreMode || babyCrying || !gameStarted || isCheckout || gameOver) return false;
    
    babyCrying = true;
    babyTantrumCount++;
    
    // Play baby crying sound safely
    try {
        soundEffects.babyCry.currentTime = 0;
        safePlayExt(soundEffects.babyCry);
    } catch(_) {}
    
    // Create headache overlay for limited vision
    const existingOverlay = document.querySelector('.baby-headache-overlay');
    if (existingOverlay) existingOverlay.remove();
    document.querySelectorAll('.baby-black-bar').forEach(bar => bar.remove());

    babyHeadacheOverlay = document.createElement('div');
    babyHeadacheOverlay.className = 'baby-headache-overlay';
    document.getElementById('game-container').appendChild(babyHeadacheOverlay);
    
    // Add black bars to limit vision
    const topBar = document.createElement('div');
    topBar.className = 'baby-black-bar top-bar';
    document.getElementById('game-container').appendChild(topBar);
    
    const bottomBar = document.createElement('div');
    bottomBar.className = 'baby-black-bar bottom-bar';
    document.getElementById('game-container').appendChild(bottomBar);
    
    // Change FOV to zoom in
    camera.fov = babyFOVDefault * 0.7; // Zoom in by reducing FOV
    camera.updateProjectionMatrix();
    
    // Display message
    displayMessage("A baby is crying nearby! You're getting a headache...", 5000, true);
    
    // End crying after time between 12-16 seconds
    const cryDuration = Math.random() * 4000 + 12000;
    const endTimerId = setTimeout(() => {
        endBabyCrying();
    }, cryDuration);
    scheduledEventTimeouts.push(endTimerId);
    return true;
}

function endBabyCrying() {
    babyCrying = false;
    
    // Stop sound safely
    try { if (soundEffects.babyCry) { soundEffects.babyCry.pause(); } } catch (_) {}
    
    // Remove overlay
    if (babyHeadacheOverlay) {
        babyHeadacheOverlay.remove();
        babyHeadacheOverlay = null;
    }
    
    // Remove black bars
    document.querySelectorAll('.baby-black-bar').forEach(bar => bar.remove());
    
    // Reset FOV to default
    camera.fov = babyFOVDefault;
    camera.updateProjectionMatrix();

    displayMessage("The baby stopped crying. Your headache is subsiding.", 3000);
    lastMajorEventEndTime = performance.now();
}

// The wasteland after surviving the nuke: just walking, looking and wind.
function runNukeAftermathFrame(delta) {
    if (world) world.step(timeStep, delta, 2);
    if (playerBody) {
        const p = playerBody.position;
        const r = Math.hypot(p.x, p.z);
        if (r > 170) { p.x *= 170 / r; p.z *= 170 / r; }
        if (p.y < -5) { p.set(33, 1.0, -26.5); playerBody.velocity.set(0, 0, 0); }
        const speed = Math.hypot(playerBody.velocity.x, playerBody.velocity.z);
        if (speed > 0.15 && controls?.isLocked && !gamePaused) {
            playerWalkBobPhase += speed * delta * 3.8;
            playerWalkBobAmount = THREE.MathUtils.lerp(playerWalkBobAmount, Math.min(1, speed / (CONFIG.MOVE_SPEED || 5)), delta * 6);
        } else {
            playerWalkBobAmount = THREE.MathUtils.lerp(playerWalkBobAmount, 0, delta * 6);
        }
        if (controls?.isLocked && !gamePaused) {
            cameraCurrentYaw = cameraTargetYaw;
            cameraCurrentPitch = cameraTargetPitch;
            camera.position.set(p.x, p.y + 1.6 + Math.sin(playerWalkBobPhase * 2) * 0.008 * playerWalkBobAmount, p.z);
            camera.rotation.set(cameraCurrentPitch, cameraCurrentYaw, 0, 'YXZ');
        }
    }
    updateFrustumCulling();
    renderer.render(scene, camera);
}

// Scratch objects reused by the per-frame animate() loop.
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const _landedItemsScratch = [];
const _heldCamDir = new THREE.Vector3();
const _heldCamRight = new THREE.Vector3();
const _heldTarget = new THREE.Vector3();
const _heldBodyPos = new THREE.Vector3();
const _heldRelVel = new THREE.Vector3();
const _heldOrientation = new THREE.Quaternion();
const _heldError = new THREE.Quaternion();
const _heldForce = new CANNON.Vec3();
const _heldForcePoint = new CANNON.Vec3();
const _managerTarget = new THREE.Vector3();
const _managerDir = new THREE.Vector3();
const _cartDir = new THREE.Vector3();
const _cartRight = new THREE.Vector3();
const LONELY_BG_COLOR = new THREE.Color(0x010206);
const DAY_BG_COLOR = new THREE.Color(0x87CEEB);

function animate() {
    animationFrameId = requestAnimationFrame(animate);
    frameCount++;
    if (CONFIG.SHOW_FPS) updateFps();

    const now = performance.now();

    // Compute frame delta for consistent physics stepping
    const delta = clock.getDelta();
    updatePlayerCartHands();
    updateGlassesBlur(delta);
    if (Thermo.isThermostatActive()) {
        if (gameOver || !gameStarted) Thermo.resetThermostat();
        else Thermo.updateThermostat(delta, thermostatCtx());
    }
    updateCartBabyAnimation(now, delta);
    updateBathroomDoor(delta);
    if (Nuke.isNukeActive()) {
        Nuke.updateNuke(delta, now, nukeCtx());
        updateNukePanic(now);
        if (Nuke.isAftermath()) {
            runNukeAftermathFrame(delta);
            return;
        }
    }
    if (gameStarted && !gameOver && !introCutsceneActive) {
        updateTweaker(now);
        if (!gamePaused && !isCheckout && now >= nextMoneySpawnAt) {
            if (looseMoney.length < 20) spawnLooseMoney();
            nextMoneySpawnAt = now + 7000 + Math.random() * 4000;
        }
    }

    // Skip physics update only if game is over
    if (gameOver) {
        updateFrustumCulling();
        renderer.render(scene, camera);
        return;
    }

    // Intro Cutscene walking animation
    if (introCutsceneActive) {
        const now = performance.now();
        const progress = Math.min(1.0, (now - introCutsceneStartTime) / INTRO_CUTSCENE_DURATION);

        // Smooth cubic ease-in-out curve
        const t = progress < 0.5 ? 4 * progress * progress * progress : 1 - Math.pow(-2 * progress + 2, 3) / 2;
        const currentZ = -42.0 + t * 16.0; // from -42.0 (outside) to -26.0 (inside)

        // Head bobbing simulation while walking
        const walkBob = Math.sin(progress * Math.PI * 12) * 0.05;

        if (playerBody) {
            playerBody.position.set(0, 1.0, currentZ);
            playerBody.velocity.set(0, 0, 0);
        }
        if (camera) {
            camera.position.set(0, 2.6 + walkBob, currentZ);
            camera.rotation.set(0, Math.PI, 0);
        }

        // Trigger automatic doors to slide open as player approaches
        if (currentZ >= -34.0 && autoDoors && !autoDoors.open) {
            autoDoors.open = true;
            playEntranceDoorBeep();
        }

        // Update auto doors sliding
        if (autoDoors) {
            const slideOffset = autoDoors.open ? autoDoors.maxSlide : 0;
            const targetLeftX = autoDoors.closedLeftX - slideOffset;
            const targetRightX = autoDoors.closedRightX + slideOffset;
            autoDoors.leftPane.position.x = THREE.MathUtils.lerp(autoDoors.leftPane.position.x, targetLeftX, 0.12);
            autoDoors.rightPane.position.x = THREE.MathUtils.lerp(autoDoors.rightPane.position.x, targetRightX, 0.12);
            autoDoors.leftBody.position.x = autoDoors.leftPane.position.x;
            autoDoors.rightBody.position.x = autoDoors.rightPane.position.x;
        }

        // Near the end of the walk, animate the cart rolling forward to meet player
        if (progress > 0.80 && cartObject) {
            cartObject.visible = true;
            const cartT = (progress - 0.80) / 0.20;
            cartObject.position.set(0, 0, -24.5 - (1.0 - cartT) * 1.5);
            cartObject.rotation.set(0, 0, 0);
        }

        if (progress >= 1.0) {
            finishIntroCutscene(false);
        }

        updateFrustumCulling();
        renderer.render(scene, camera);
        return;
    }

    // Item hover text logic
    let hoveredItemName = null;
    if (controls.isLocked && !isCheckout) {
        // Throttle hover/raycast work and reuse objects
        if (!raycaster) { raycaster = new THREE.Raycaster(); lookDir = new THREE.Vector3(); }
        if (frameCount % 3 === 0) {
            hoveredItemName = null;
            camera.getWorldDirection(lookDir);
            raycaster.set(camera.position, lookDir);
            // First check for Amnesia reach-in freezer doors
            hoveredFreezerDoor = null;
            if (freezerDoorMeshesCache.length > 0) {
                const doorIntersections = raycaster.intersectObjects(freezerDoorMeshesCache, false);
                if (doorIntersections.length > 0 && doorIntersections[0].distance <= CONFIG.ARM_REACH * 1.6) {
                    const hitMesh = doorIntersections[0].object;
                    const door = findFreezerDoorFromMesh(hitMesh);
                    if (door) {
                        hoveredFreezerDoor = door;
                        hoveredItemName = `🚪 Freezer Door (Hold Left-Click & Drag to Open)`;
                        if (crosshairElement && !activeGrabbedDoor) {
                            crosshairElement.classList.add('amnesia-hover');
                        }
                    }
                }
            }

            if (!hoveredFreezerDoor && crosshairElement && !activeGrabbedDoor) {
                crosshairElement.classList.remove('amnesia-hover');
            }

            if (!hoveredFreezerDoor) {
                const it = findAccessibleItemUnderCrosshair(raycaster, CONFIG.ARM_REACH * 1.8);
                if (it && it !== heldItem) {
                    const isClosedFreezer = (it.freezerDoor && it.freezerDoor.currentAngle < 0.30);
                    if (isClosedFreezer) {
                        hoveredItemName = `❄️ ${it.name} (Pull freezer door open to reach!)`;
                    } else if (it.inCart) {
                        hoveredItemName = cartAttached ? `${it.name} (In Cart — Detach [F] to take out)` : `${it.name} (In Cart) [E / Click]`;
                    } else {
                        hoveredItemName = `${it.name} [E / Click]`;
                    }
                }
            }
            if (!hoveredItemName && !cartAttached && cart3D) {
                const cartHits = raycaster.intersectObject(cart3D, true);
                if (cartHits.length > 0 && cartHits[0].distance <= 3.8) {
                    const cKey = formatKeyName((CONFIG.KEYBINDS && CONFIG.KEYBINDS.cart) || 'KeyF');
                    hoveredItemName = `🛒 Shopping Cart [Press ${cKey} to Push]`;
                }
            }
            if (!hoveredItemName && leaderboardStandGroup) {
                const standHits = raycaster.intersectObject(leaderboardStandGroup, true);
                if (standHits.length > 0 && standHits[0].distance <= CONFIG.ARM_REACH * 2.0) {
                    hoveredItemName = `🏆 MagMart Live Leaderboard [Click to View]`;
                }
            }
            if (!hoveredItemName) hoveredItemName = SQ.getHoverText();
            const aimedMoney = aimedLooseMoney(raycaster);
            if (aimedMoney) hoveredItemName = `$${(aimedMoney.cents / 100).toFixed(2)} [E to save]`;
            if (heldItem) hoveredItemName = `${heldItem.name} [Click to toss • E to place]`;
            if (hoveredItemName) { itemHoverTextElement.textContent = hoveredItemName; itemHoverTextElement.classList.add('item-hover-visible'); }
            else { itemHoverTextElement.classList.remove('item-hover-visible'); }
        }
    } else {
        itemHoverTextElement.classList.remove('item-hover-visible');
    }

    // Update active cart dropping animations
    updateCartDroppingItems(delta);

    // Update Amnesia freezer doors physical simulation & audio
    updateFreezerDoors(delta);

    // Update physics
    // Step physics with fixed timestep using the current frame delta; maxSubSteps keeps simulation stable on slow frames
    world.step(timeStep, delta, 2);
    pinPlayerDuringPopup();
    if (tweakerRequestOpen && activeTweaker?.frozenAt) {
        playerBody.position.x = activeTweaker.frozenAt.x;
        playerBody.position.z = activeTweaker.frozenAt.z;
        playerBody.velocity.x = 0;
        playerBody.velocity.z = 0;
        playerBody.aabbNeedsUpdate = true;
    }

    // Active earthquake ground tremors
    if (earthquakeTremorsUntil && now < earthquakeTremorsUntil) {
        allItems.forEach(item => {
            if (!item.isStatic && item.body && item.body.type === CANNON.Body.DYNAMIC) {
                item.body.velocity.x += (Math.random() - 0.5) * 0.12;
                item.body.velocity.z += (Math.random() - 0.5) * 0.12;
                item.body.wakeUp();
            }
        });
    }

    // Update object positions and check for ground impacts on dropped items
    // Impacts are collected first and fired afterwards, since they may modify allItems.
    const landedItems = _landedItemsScratch;
    landedItems.length = 0;
    for (let i = 0; i < allItems.length; i++) {
        const item = allItems[i];
        if (item === heldItem || item.inCart || item.isStatic || !item.body) continue;
        item.mesh.position.copy(item.body.position);
        item.mesh.quaternion.copy(item.body.quaternion);

        // Ground impact handling for dropped items
        if (item.isDropping && !item.hasLanded) {
            const halfH = (item.size && item.size[1]) ? (item.size[1] * 0.5) : 0.15;
            if (item.body.position.y <= Math.max(halfH + 0.12, 0.30)) landedItems.push(item);
        }
    }
    for (let i = 0; i < landedItems.length; i++) triggerItemGroundImpact(landedItems[i]);
    landedItems.length = 0;

    // Compute walking head bob and sway (very nuanced, subtle and gentle)
    const playerHVelocity = playerBody ? Math.hypot(playerBody.velocity.x, playerBody.velocity.z) : 0;
    const isWalking = controls.isLocked && !isCheckout && !gamePaused && gameStarted && (playerHVelocity > 0.15);
    updateCartRollingSound(isWalking && !gameOver && cartAttached && !cartFlingActive);
    if (soundEffects?.entranceBeep && !soundEffects.entranceBeep.paused) {
        updateEntranceDoorBeepVolume();
    }

    if (isWalking) {
        playerWalkBobPhase += playerHVelocity * delta * 3.8;
        playerWalkBobAmount = THREE.MathUtils.lerp(playerWalkBobAmount, Math.min(1.0, playerHVelocity / (CONFIG.MOVE_SPEED || 5)), delta * 6.0);
    } else {
        playerWalkBobAmount = THREE.MathUtils.lerp(playerWalkBobAmount, 0, delta * 6.0);
    }

    // Nuanced subtle vertical step bob (strictly vertical to guarantee zero camera roll/flip)
    const headBobY = Math.sin(playerWalkBobPhase * 2) * 0.008 * playerWalkBobAmount;

    // Update player and camera position with direct 1:1 responsive rotation (zero lag)
    if (controls.isLocked && !isCheckout && !SQ.isCinematic()) {
        // The wheel pulls the heading while the cart rolls; opposite mouse
        // movement compensates immediately through cameraTargetYaw.
        if (cartStuckActive && cartAttached && isWalking && !gamePaused) {
            cameraTargetYaw += cartStuckPull * 0.34 * Math.min(delta, 0.05);
        }
        cameraCurrentYaw = cameraTargetYaw;
        cameraCurrentPitch = cameraTargetPitch;

        // Subtle ground tremor shake during earthquake event (not too crazy)
        let quakeShakeX = 0;
        let quakeShakeY = 0;
        let quakeShakeZ = 0;
        let quakePitch = 0;
        let quakeYaw = 0;
        if (earthquakeTremorsUntil && now < earthquakeTremorsUntil) {
            const timeLeft = earthquakeTremorsUntil - now;
            const progress = 1.0 - Math.max(0, Math.min(1, timeLeft / 6000));
            const env = Math.sin(progress * Math.PI); // smooth bell curve envelope
            const intensity = 0.032 * env;
            quakeShakeX = (Math.sin(now * 0.035) + Math.cos(now * 0.053) * 0.5) * intensity;
            quakeShakeY = (Math.sin(now * 0.048) + Math.sin(now * 0.082) * 0.4) * (intensity * 0.6);
            quakeShakeZ = (Math.cos(now * 0.039) + Math.sin(now * 0.061) * 0.5) * intensity;
            quakePitch = Math.sin(now * 0.042) * (0.007 * env);
            quakeYaw = Math.cos(now * 0.038) * (0.007 * env);
        }

        const nukeShake = Nuke.getNukeShake(now);
        if (nukeShake) {
            quakeShakeX += nukeShake.x; quakeShakeY += nukeShake.y; quakeShakeZ += nukeShake.z;
            quakePitch += nukeShake.pitch; quakeYaw += nukeShake.yaw;
        }
        camera.position.set(
            playerBody.position.x + quakeShakeX,
            playerBody.position.y + 1.6 + headBobY + quakeShakeY,
            playerBody.position.z + quakeShakeZ
        );
        camera.rotation.set(cameraCurrentPitch + quakePitch, cameraCurrentYaw + quakeYaw, 0, 'YXZ');
        camera.rotation.z = 0;
        camera.up.set(0, 1, 0);
    }
    playerObject.position.copy(playerBody.position);
    playerObject.quaternion.copy(playerBody.quaternion);

    // Pull the dynamic body toward the hand with a bounded spring. Its mass
    // determines how much it lags behind turns and how readily it accelerates.
    if (heldItem && heldItem.mesh && heldItem.body) {
        // Compute the hand target in front of the camera in world space
        const camDir = camera.getWorldDirection(_heldCamDir);
        const camRight = _heldCamRight.crossVectors(camDir, WORLD_UP).normalize();
        const worldPos = _heldTarget
            .copy(camera.position)
            .addScaledVector(camDir, Math.abs(heldOffset.z))
            .addScaledVector(WORLD_UP, heldOffset.y)
            .addScaledVector(camRight, heldOffset.x);

        const body = heldItem.body;
        const playerV = playerBody?.velocity;
        const pvx = playerV?.x || 0, pvy = playerV?.y || 0, pvz = playerV?.z || 0;
        const hasWeightRoll = (heldItem.weightFactor ?? 1) !== 1;
        if (!hasWeightRoll) {
            // Normal-weight items stay locked to the hand with no lag.
            body.position.set(worldPos.x, worldPos.y, worldPos.z);
            body.velocity.set(pvx, pvy, pvz);
            body.quaternion.set(camera.quaternion.x, camera.quaternion.y, camera.quaternion.z, camera.quaternion.w);
            body.angularVelocity.set(0, 0, 0);
            body.wakeUp();
            heldItem.mesh.position.copy(worldPos);
            heldItem.mesh.quaternion.copy(camera.quaternion);
        } else {
            // Weight-rolled items are pulled by a bounded spring, so their
            // mass determines how much they lag behind turns.
            const pull = worldPos
                .sub(_heldBodyPos.set(body.position.x, body.position.y, body.position.z))
                .multiplyScalar(95)
                .addScaledVector(_heldRelVel.set(body.velocity.x - pvx, body.velocity.y - pvy, body.velocity.z - pvz), -18);
            pull.y += body.mass * CONFIG.GRAVITY;
            pull.clampLength(0, 95);
            _heldForce.set(pull.x, pull.y, pull.z);
            _heldForcePoint.set(0, 0, 0);
            body.applyForce(_heldForce, _heldForcePoint);

            _heldOrientation.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w).invert();
            const error = _heldError.copy(camera.quaternion).multiply(_heldOrientation).normalize();
            if (error.w < 0) error.set(-error.x, -error.y, -error.z, -error.w);
            const angle = 2 * Math.acos(THREE.MathUtils.clamp(error.w, -1, 1));
            const sinHalf = Math.sqrt(Math.max(0, 1 - error.w * error.w));
            if (sinHalf > 0.001) {
                const turn = Math.min(9, angle * 9) / sinHalf;
                body.angularVelocity.set(error.x * turn, error.y * turn, error.z * turn);
            } else {
                body.angularVelocity.scale(0.7, body.angularVelocity);
            }
            body.wakeUp();
            heldItem.mesh.position.copy(body.position);
            heldItem.mesh.quaternion.copy(body.quaternion);
        }
    }

    // Side quests: minigames, returns physics, samples, car departure
    if (gameStarted && !gameOver) SQ.updateSideQuests(delta, now);
    if (gameOver) { updateFrustumCulling(); renderer.render(scene, camera); return; }

    // Camera flick on trip: quick kick then damp back
    if (cameraFlickActive) {
        cameraFlickElapsed += delta;
        const d = cameraFlickElapsed;
        const kick = cameraFlickStrength * Math.exp(-d * 5) * Math.sin(d * 10);
        camera.rotation.x = cameraBasePitch - kick;
        if (d > 0.9) {
            camera.rotation.x = cameraBasePitch;
            camera.rotation.z = 0;            // ensure no tilt remains
            camera.fov = babyFOVDefault;      // restore FOV
            camera.updateProjectionMatrix();
            cameraFlickActive = false;
            cameraFlickStrength = 0;
        }
    }

    // NEW: Slap hand animation and impact
    if (slapActive && slapHand) {
        const t = (performance.now() - slapStart) / slapDuration;
        const tt = Math.max(0, Math.min(1, t));
        // Ease-in-out motion across screen
        const ease = tt < 0.5 ? 2*tt*tt : -1 + (4 - 2*tt) * tt;
        const startX = slapHand.userData.startX ?? (slapHand.userData.dir === -1 ? -0.85 : 0.85);
        const endX = slapHand.userData.endX ?? (slapHand.userData.dir === -1 ? 0.85 : -0.85);
        slapHand.position.x = THREE.MathUtils.lerp(startX, endX, ease);
        slapHand.position.y = -0.08 + Math.sin(tt * Math.PI) * 0.08;

        // Impact at mid point once
        if (!slapDidImpact && tt >= 0.48) {
            slapDidImpact = true;
            try { soundEffects.slap.currentTime = 0; soundEffects.slap.play(); } catch(_) {}
            // Apply a short DOM-based tilt to the renderer canvas (visual only, does not affect controls)
            try {
                if (renderer && renderer.domElement) {
                    const maxTilt = 6; // degrees tilt at impact
                    const side = slapHand.userData.dir === -1 ? 1 : -1; // direction sign
                    const tiltDeg = maxTilt * side * (Math.random() * 0.6 + 0.4); // small variation
                    renderer.domElement.style.transform = `perspective(800px) rotateX(${tiltDeg * 0.12}deg) rotateZ(${tiltDeg}deg) translateY(${Math.abs(tiltDeg) * 0.4}px)`;
                    // Remove the transform slightly after the slap finishes to ensure perfect reset
                    setTimeout(() => {
                        try {
                            if (renderer && renderer.domElement) {
                                renderer.domElement.style.transform = '';
                            }
                        } catch(_) {}
                    }, Math.min(350, slapDuration + 150));
                }
            } catch(_) {}

            // The crosshair's exact intersection decides both the customer and print location.
            const slapHit = findCustomerUnderCrosshair();
            if (slapHit) {
                const target = slapHit.customer;
                showCustomerSlapMark(slapHit);
                addAchievementProgress('slapper');
                // If holding item in hand
                if (target.handItem) {
                    dropMeshItemToFloor(target.handItem, target.body.position.x, target.body.position.z);
                    target.handItem = null;
                } else if (target.scuffleHeldItem) {
                    dropMeshItemToFloor(target.scuffleHeldItem, target.body.position.x, target.body.position.z);
                    target.scuffleHeldItem = null;
                } else if (target.hasCart && target.cart && target.cart.items && target.cart.items.length > 0) {
                    const idx = Math.floor(Math.random() * target.cart.items.length);
                    const item = target.cart.items.splice(idx, 1)[0];
                    if (item) {
                        dropMeshItemToFloor(item, target.body.position.x, target.body.position.z);
                    }
                }
                makeCustomerFlee(target, 2500);
            }
        }
        // End animation
        if (tt >= 1) {
            slapActive = false;
            if (slapHand && slapHand.parent) { try { slapHand.parent.remove(slapHand); } catch(_) {} }
            slapHand = null;
            updatePlayerCartHands();
            // Ensure renderer canvas transform cleared at end
            try {
                if (renderer && renderer.domElement) {
                    renderer.domElement.style.transition = '';
                    renderer.domElement.style.transform = '';
                    renderer.domElement.style.willChange = '';
                }
            } catch(_) {}
        }
    }

    // Update cart fling physics while tripping
    if (cartFlingActive && cartObject) {
        cartObject.position.x += cartFlingVel.x * delta;
        cartObject.position.z += cartFlingVel.z * delta;
        cartObject.position.y += cartFlingVel.y * delta;
        cartFlingVel.y += -9.8 * 3 * delta;
        if (cartObject.position.y <= cartFlingStartY) {
            cartObject.position.y = cartFlingStartY; cartFlingActive = false;
            CartPhys.wakeCartItems(1.2);
        }
    }

    // NEW: Handle Falling Shelf tilt animation and crush detection
    if (fallingShelfAnim && !fallingShelfAnim.finished) {
        const { unit, start, duration, tiltAxis, initialY, targetY } = fallingShelfAnim;
        const t = Math.min(1, (performance.now() - start) / duration);
        // Ease-in for tip, then quick settle near the end
        const ease = t * t; // quadratic ease-in
        const targetAngle = Math.PI / 2; // fall flat
        if (tiltAxis === 'z') {
            unit.rotation.z = targetAngle * ease;
            unit.rotation.x = 0;
        } else {
            unit.rotation.x = targetAngle * ease;
            unit.rotation.z = 0;
        }
        // Slight vertical drop to 'land' on the floor as it tips
        unit.position.y = initialY + (targetY - initialY) * ease;

        // Scatter items earlier in the fall to simulate items sliding off
        if (!fallingShelfAnim.scattered && t > 0.3) {
            fallingShelfAnim.scattered = true;
            scatterItemsFromUnit(unit);
        }
        // Play crash sound once right as the shelf lands
        if (t >= 1 && !fallingShelfAnim.playedCrash) {
            try { soundEffects.shelfCrash.currentTime = 0; soundEffects.shelfCrash.play(); } catch (e) {}
            fallingShelfAnim.playedCrash = true;
        }

        // Crush detection: if player is close to unit footprint while tilting
        // Throttle crush check and reuse Box3/vector allocations
        if ((++fallCheckFrameSkip % 4) === 0) {
            fallBoxTmp.setFromObject(unit);
            sharedVec3.set(playerBody.position.x, playerBody.position.y + 1.0, playerBody.position.z);
            if (fallBoxTmp.containsPoint(sharedVec3)) {
                fallingShelfAnim.finished = true;
                failCrushedByShelf();
            }
        }

        if (t >= 1) {
            // Clamp final transform to ensure clean landing and keep it down
            if (tiltAxis === 'z') {
                unit.rotation.z = targetAngle;
                unit.rotation.x = 0;
            } else {
                unit.rotation.x = targetAngle;
                unit.rotation.z = 0;
            }
            unit.position.y = targetY;
            fallingShelfAnim.finished = true;
        }
    }

    // Check if player is outside store for arrest easter egg
    if (gameStarted && !isCheckout && !gameOver && !isBeingArrested) {
        checkPlayerOutsideStore();
    }

    // Update police car lights if it exists
    if (policeCarModel && policeCarModel.animate) {
        policeCarModel.animate(performance.now() * 0.001);
    }

    // Update police car animation if needed
    if (policeCopAnimation && policeCarModel && policeCarStartPosition) {
        const now = performance.now();
        const elapsed = now - policeCarModel.animationStartTime;
        const progress = Math.min(elapsed / policeCarModel.animationDuration, 1);
        
        // Easing function for fast approach and realistic deceleration to a halt
        const easeOut = 1 - Math.pow(1 - progress, 2.5);
        
        const curX = policeCarStartPosition.x + (policeCarStartPosition.finalX - policeCarStartPosition.x) * easeOut;
        const curZ = policeCarStartPosition.z + (policeCarStartPosition.finalZ - policeCarStartPosition.z) * easeOut;
        
        policeCarModel.position.set(curX, 0, curZ);
        if (playerBody) {
            policeCarModel.lookAt(playerBody.position.x, 0, playerBody.position.z);
            playerBody.velocity.set(0, 0, 0);
        }
        
        // Animation completed
        if (progress >= 1) {
            policeCopAnimation = false;
            setTimeout(showArrestMessage, 600);
        }
    }

    // NEW: Manager approach movement
    if (managerActive && managerApproachActive && managerGroup && playerBody) {
        const target = _managerTarget.set(playerBody.position.x, 0, playerBody.position.z);
        const pos = managerGroup.position;
        const dir = _managerDir.subVectors(target, pos);
        const dist = dir.length();
        if (dist > 0.05) {
            dir.normalize();
            // Increased rush speed so the manager comes at you faster
            const speed = 14; // was 8
            pos.addScaledVector(dir, speed * delta);
            // Face the player
            managerGroup.lookAt(target.x, managerGroup.position.y, target.z);
        }

        // Drive stomp volume based on distance (louder as manager gets closer)
        if (soundEffects && soundEffects.managerStomp) {
            const maxDist = 25;
            const t = Math.max(0, Math.min(1, dist / maxDist)); // 1 at far, 0 at close
            const vol = (1 - t) * (CONFIG.SFX_VOLUME || 0.7);   // 0 far, full at close
            soundEffects.managerStomp.volume = vol;
            if (soundEffects.managerStomp2) {
                soundEffects.managerStomp2.volume = vol;
            }
        }

        if (dist <= 1.5 && !managerQuestionVisible && !managerJumpscareActive) {
            managerApproachActive = false;
            startManagerFNAFJumpscare();
        }
    }

    // NEW: Manager flee animation
    if (managerGroup && managerGroup.fleeing) {
        const fleeSpeed = 14;
        const fleeDir = {
            x: Math.cos(managerGroup.fleeAngle),
            z: Math.sin(managerGroup.fleeAngle)
        };
        managerGroup.position.x += fleeDir.x * fleeSpeed * delta;
        managerGroup.position.z += fleeDir.z * fleeSpeed * delta;
        managerGroup.lookAt(
            managerGroup.position.x + fleeDir.x,
            managerGroup.position.y,
            managerGroup.position.z + fleeDir.z
        );

        if (Math.hypot(managerGroup.position.x, managerGroup.position.z) > 40) {
            if (managerGroup.parent) managerGroup.parent.remove(managerGroup);
            managerGroup = null;
            managerActive = false;
            stopManagerStompLoop();
            lastMajorEventEndTime = performance.now();
        }
    }

    // Update customers' positions, navigation, and generalized behaviors
    customers.forEach(child => {
        if (!child || !child.body) return;

        // 1. Periodic zone switching / aisle migration
        if (now > (child.zoneSwitchAt || 0) && child.behaviorState !== 'socializing' &&
            child.behaviorState !== 'scuffling' && child.behaviorState !== 'fleeing' && !child.interacting) {
            child.zone = pickZone();
            child.zoneSwitchAt = now + (40000 + Math.random() * 40000);
            if (child.behaviorState === 'navigating') {
                setCustomerTarget(child);
            }
        }

        // 2. Flee state (explosions, falling shelves, or startled shoplifter)
        if (!child.scufflePartner && child.fleeUntil && now < child.fleeUntil && child.fleeDir) {
            child.behaviorState = 'fleeing';
            const fleeSpeed = child.fleeSpeed || 3.0;
            let vx = child.fleeDir.x * fleeSpeed;
            let vz = child.fleeDir.z * fleeSpeed;

            // Store boundary bounce (customers fleeing the nuke run out the doors)
            if (child.nukeMode !== 'leave') {
                if (child.body.position.x < -27 && vx < 0) vx = -vx;
                if (child.body.position.x > 27 && vx > 0) vx = -vx;
                if (child.body.position.z < -27 && vz < 0) vz = -vz;
                if (child.body.position.z > 27 && vz > 0) vz = -vz;
            }

            child.body.velocity.x = vx;
            child.body.velocity.z = vz;
        } else {
            if (child.fleeUntil && now >= child.fleeUntil) {
                if (child.walkSpeedBackup) { child.walkSpeed = child.walkSpeedBackup; child.walkSpeedBackup = null; }
                child.fleeUntil = 0;
                child.fleeDir = null;
                child.behaviorState = 'navigating';
                setCustomerTarget(child);
            }

            // 3. Socializing state (friendly interaction between two customers)
            if (child.behaviorState === 'scuffling') {
                const walking = Math.hypot(child.body.velocity.x, child.body.velocity.z) > 0.12;
                if (walking || child.scufflePartner?.body) {
                    const dx = walking ? child.body.velocity.x :
                        child.scufflePartner.body.position.x - child.body.position.x;
                    const dz = walking ? child.body.velocity.z :
                        child.scufflePartner.body.position.z - child.body.position.z;
                    slerpToYaw(child, Math.atan2(dx, dz), 0.18);
                }
                if (child.head) {
                    child.head.rotation.z = Math.sin(now * 0.019 + child.animPhase) * 0.17;
                    child.head.rotation.x = -0.12;
                }
            } else if (child.behaviorState === 'socializing') {
                child.body.velocity.x = 0;
                child.body.velocity.z = 0;

                // Face social partner smoothly
                if (child.socialPartner && child.socialPartner.body) {
                    const pdx = child.socialPartner.body.position.x - child.body.position.x;
                    const pdz = child.socialPartner.body.position.z - child.body.position.z;
                    const targetYaw = Math.atan2(pdx, pdz);
                    slerpToYaw(child, targetYaw, 0.12);

                    // Expressive subtle head nod/tilt
                    if (child.head) {
                        const nodTime = now * 0.004 + child.animPhase;
                        child.head.rotation.x = Math.sin(nodTime * 3.5) * 0.12;
                        child.head.rotation.y = Math.sin(nodTime * 1.8) * 0.14;
                    }
                }

                // Check social duration expiry
                if (now >= (child.socialUntil || 0)) {
                    child.behaviorState = 'navigating';
                    child.socialPartner = null;
                    child.socialCooldownUntil = now + 15000 + Math.random() * 15000;
                    if (child.head) child.head.rotation.set(0, 0, 0);
                    setCustomerTarget(child);
                }
            }
            // 4. Shelf inspecting / item acquisition state
            else if (child.behaviorState === 'inspecting') {
                child.body.velocity.x = 0;
                child.body.velocity.z = 0;

                // Face the target shelf unit
                if (child.targetUnit) {
                    const rot = child.targetUnit.userData?.rotY || child.targetUnit.rotation?.y || 0;
                    const faceDir = (child.targetUnit.userData?.direction || 1) >= 0 ? rot + Math.PI : rot;
                    slerpToYaw(child, faceDir, 0.1);
                }

                // Animated head looking at goods
                if (child.head) {
                    const glanceTime = now * 0.003 + child.animPhase;
                    if (child.role === 'shoplifter') {
                        // Shoplifter glances nervously left and right
                        child.head.rotation.y = Math.sin(glanceTime * 6.0) * 0.55;
                        child.head.rotation.x = 0.06;
                    } else {
                        child.head.rotation.x = Math.sin(glanceTime * 2.2) * 0.18 + 0.1;
                        child.head.rotation.y = Math.sin(glanceTime * 1.2) * 0.22;
                    }
                }

                // Item browsing & selection check
                if (!child.lastAnalyzeCheck || now - child.lastAnalyzeCheck > 1000) {
                    child.lastAnalyzeCheck = now;
                    const unit = child.targetUnit || nearestShelfUnitTo(child.body.position.x, child.body.position.z);
                    if (unit && Math.random() < 0.45) {
                        const took = customerTakeItemFromUnit(child, unit);
                        if (took) {
                            child.itemsGathered = (child.itemsGathered || 0) + 1;
                            if (child.role === 'shoplifter') {
                                child.hasStolenItem = true;
                            }
                        }
                    }
                }

                // Finished inspecting shelf
                if (now >= (child.inspectUntil || 0)) {
                    if (child.head) child.head.rotation.set(0, 0, 0);
                    if (child.role === 'shoplifter' && child.hasStolenItem) {
                        setCustomerTarget(child, 'exit');
                    } else if (child.itemsGathered >= child.shoppingListQuota) {
                        setCustomerTarget(child, 'checkout');
                    } else {
                        setCustomerTarget(child, 'shelf');
                    }
                }
            }
            // 5. Checkout stand state
            else if (child.behaviorState === 'busy_checkout_scanning') {
                child.body.velocity.x = 0;
                child.body.velocity.z = 0;
                const checkoutYaw = -Math.PI / 2;
                slerpToYaw(child, checkoutYaw, 0.1);

                if (child.head) {
                    child.head.rotation.x = 0.22 + Math.sin(now * 0.005) * 0.06;
                    child.head.rotation.y = Math.sin(now * 0.003) * 0.12;
                }
            }
            else if (child.behaviorState === 'checkout_wait' || child.behaviorState === 'checkout') {
                child.body.velocity.x = 0;
                child.body.velocity.z = 0;

                // Face the checkout counter belt
                const checkoutYaw = -Math.PI / 2;
                slerpToYaw(child, checkoutYaw, 0.1);

                if (child.head) {
                    child.head.rotation.x = 0.15;
                    child.head.rotation.y = Math.sin(now * 0.003) * 0.1;
                }

                // Completed checkout: pack items and leave the store to drive away!
                if (now >= (child.checkoutUntil || 0)) {
                    if (child.head) child.head.rotation.set(0, 0, 0);
                    if (child.handItem) {
                        if (child.handItem.mesh && child.handItem.mesh.parent) child.handItem.mesh.parent.remove(child.handItem.mesh);
                        child.handItem = null;
                    }
                    if (child.cart && child.cart.items && child.cart.items.length > 0) {
                        child.cart.items.forEach(it => {
                            if (it.mesh && it.mesh.parent) it.mesh.parent.remove(it.mesh);
                        });
                        child.cart.items = [];
                    }
                    child.itemsGathered = 0;
                    setCustomerTarget(child, 'leaving_store');
                }
            }
            // 6. Active Waypoint Navigation & Obstacle Avoidance
            else {
                if (!child.nav || !child.nav.path || child.nav.path.length === 0) {
                    setCustomerTarget(child);
                }

                const wp = child.nav?.path ? child.nav.path[child.nav.waypointIdx] : null;
                if (wp) {
                    const dx = wp.x - child.body.position.x;
                    const dz = wp.z - child.body.position.z;
                    const d = Math.hypot(dx, dz);

                    if (d < 0.55) {
                        child.nav.waypointIdx++;
                        if (child.nav.waypointIdx >= child.nav.path.length) {
                            if (child.behaviorState === 'walking_to_car') {
                                const car = child.assignedCar;
                                if (car) {
                                    car.isDriving = true;
                                    car.driveState = 'backing_out';
                                    car.backupDist = 0;
                                    car.driveSpeed = 2.0;
                                }
                                child.visible = false;
                                if (child.cart && child.cart.group) child.cart.group.visible = false;
                                child.body.position.set(0, -60, 0);
                                child.body.velocity.set(0, 0, 0);
                                child.behaviorState = 'respawning';

                                // Customer respawn loop from parking lot entrance
                                setTimeout(() => {
                                    if (!gameStarted || isCheckout || gameOver) return;
                                    child.visible = true;
                                    if (child.cart && child.cart.group) child.cart.group.visible = true;
                                    child.itemsGathered = 0;
                                    child.shoppingListQuota = 2 + Math.floor(Math.random() * 4);
                                    child.assignedCar = null;
                                    const enterX = (Math.random() - 0.5) * 4;
                                    child.body.position.set(enterX, 0.9, -34);
                                    child.position.set(enterX, 0, -34);
                                    child.behaviorState = 'navigating';
                                    setCustomerTarget(child, 'shelf');
                                }, 14000);
                            } else if (child.nextTargetMode === 'checkout_wait') {
                                child.behaviorState = 'checkout_wait';
                                child.checkoutUntil = now + (3500 + Math.random() * 3000);
                            } else if (child.behaviorState === 'sneaking') {
                                // Successfully reached exit: safely clear any held item
                                if (child.handItem) {
                                    if (child.handItem.mesh && child.handItem.mesh.parent) {
                                        child.handItem.mesh.parent.remove(child.handItem.mesh);
                                    }
                                    if (child.handItem.body && world) {
                                        try { world.removeBody(child.handItem.body); } catch(_) {}
                                    }
                                    child.handItem = null;
                                }
                                child.hasStolenItem = false;
                                child.behaviorState = 'navigating';
                                setCustomerTarget(child, 'shelf');
                            } else {
                                child.behaviorState = 'inspecting';
                                child.inspectUntil = now + (2000 + Math.random() * 2500);
                            }
                        }
                    } else {
                        const isSneaking = child.behaviorState === 'sneaking';
                        const baseSpeed = isSneaking ? (child.walkSpeed * 1.35) : child.walkSpeed;
                        const desiredDirX = dx / d;
                        const desiredDirZ = dz / d;

                        // Check if customer is currently in a polite bump recoil / yield state
                        const isBumpYielding = now < (child.bumpYieldUntil || 0);
                        let speedThrottle = isBumpYielding ? 0.0 : 1.0;
                        let steerX = desiredDirX;
                        let steerZ = desiredDirZ;
                        let separationX = 0;
                        let separationZ = 0;
                        const currentAngle = Math.atan2(desiredDirX, desiredDirZ);

                        // A. Whisker checks against store geometry
                        const leftBlocked = checkWhiskerObstacle(child.body.position.x, child.body.position.z, currentAngle - 0.6, 1.0);
                        const rightBlocked = checkWhiskerObstacle(child.body.position.x, child.body.position.z, currentAngle + 0.6, 1.0);
                        const centerBlocked = checkWhiskerObstacle(child.body.position.x, child.body.position.z, currentAngle, 1.2);

                        if (centerBlocked) {
                            if (!leftBlocked) {
                                steerX += Math.cos(currentAngle) * 0.9;
                                steerZ -= Math.sin(currentAngle) * 0.9;
                            } else if (!rightBlocked) {
                                steerX -= Math.cos(currentAngle) * 0.9;
                                steerZ += Math.sin(currentAngle) * 0.9;
                            } else {
                                speedThrottle *= 0.25;
                            }
                        }

                        // B. Reciprocal NPC Mutual Awareness, Yielding & Avoidance
                        customers.forEach(other => {
                            if (other === child || !other.body) return;
                            if (child.socialPartner === other) return;

                            const ox = other.body.position.x - child.body.position.x;
                            const oz = other.body.position.z - child.body.position.z;
                            const dist = Math.hypot(ox, oz);
                            if (dist > 3.0 || dist < 0.001) return;

                            // Social Encounter Initiation
                            if (dist > 1.2 && dist < 2.0 &&
                                child.behaviorState === 'navigating' && other.behaviorState === 'navigating' &&
                                child.role !== 'shoplifter' && other.role !== 'shoplifter' &&
                                now > (child.socialCooldownUntil || 0) && now > (other.socialCooldownUntil || 0)) {
                                if (Math.random() < 0.05) {
                                    child.behaviorState = 'socializing';
                                    other.behaviorState = 'socializing';
                                    child.socialPartner = other;
                                    other.socialPartner = child;
                                    const duration = 3500 + Math.random() * 3000;
                                    child.socialUntil = now + duration;
                                    other.socialUntil = now + duration;
                                    child.socialCooldownUntil = now + duration + 20000;
                                    other.socialCooldownUntil = now + duration + 20000;
                                    if (customerScufflePending && !activeCustomerScuffle) {
                                        startCustomerScuffle(child, other);
                                    }
                                    return;
                                }
                            }

                            const fwdDist = ox * desiredDirX + oz * desiredDirZ;
                            const latDist = Math.abs(-oz * desiredDirX + ox * desiredDirZ);
                            const minDist = (child.hasCart || other.hasCart) ? 1.35 : 0.95;

                            // 1. Close contact / bump awareness
                            if (dist < minDist) {
                                const push = Math.min(1.5, (minDist - dist) / minDist);
                                separationX -= (ox / dist) * push * 0.85;
                                separationZ -= (oz / dist) * push * 0.85;

                                if (now > (child.bumpCooldownUntil || 0)) {
                                    child.bumpYieldUntil = now + 450 + Math.random() * 300;
                                    child.bumpReactionUntil = now + 750;
                                    child.bumpCooldownUntil = now + 1400;
                                    child.bumpTarget = other;
                                }
                            }

                            // 2. Ahead corridor lookahead & courteous braking/yielding
                            if (fwdDist > 0.1 && fwdDist < 2.4 && latDist < 0.90) {
                                const otherIsMoving = (other.body.velocity && (Math.hypot(other.body.velocity.x, other.body.velocity.z) > 0.15));
                                const relVx = (child.body.velocity.x - (other.body.velocity ? other.body.velocity.x : 0));
                                const relVz = (child.body.velocity.z - (other.body.velocity ? other.body.velocity.z : 0));
                                const isApproachingHeadOn = (ox * relVx + oz * relVz) < -0.1;

                                if (isApproachingHeadOn) {
                                    // Rule of the road: both veer smoothly to their right
                                    const sideX = -oz / dist;
                                    const sideZ = ox / dist;
                                    steerX += sideX * 0.9;
                                    steerZ += sideZ * 0.9;

                                    // Tie-breaker priority: one yields/slows down so they don't jam head-on
                                    if (((child.customerId || child.id || 0) % 2) === 0) {
                                        speedThrottle = Math.min(speedThrottle, Math.max(0.1, (fwdDist - 0.75) / 1.2));
                                    }
                                } else if (!otherIsMoving) {
                                    // The person ahead is standing still (inspecting or waiting in line)
                                    // Steer around them smoothly towards open walkable side
                                    const canSteerRight = !checkWhiskerObstacle(child.body.position.x, child.body.position.z, currentAngle + 0.8, 1.0);
                                    const sign = canSteerRight ? 1 : -1;
                                    const sideX = -oz / dist;
                                    const sideZ = ox / dist;
                                    steerX += sideX * 0.9 * sign;
                                    steerZ += sideZ * 0.9 * sign;

                                    // Slow down if directly behind them
                                    speedThrottle = Math.min(speedThrottle, Math.max(0.0, (fwdDist - 0.8) / 1.1));
                                } else {
                                    // Following someone in front: match speed / maintain safety distance
                                    speedThrottle = Math.min(speedThrottle, Math.max(0.2, (fwdDist - 0.9) / 1.1));
                                }
                            }
                        });

                        // C. Player avoidance and yielding
                        if (playerBody && !child.interacting) {
                            const px = playerBody.position.x - child.body.position.x;
                            const pz = playerBody.position.z - child.body.position.z;
                            const pdist = Math.hypot(px, pz);
                            if (pdist < 2.5 && pdist > 0.01) {
                                const pfwd = px * desiredDirX + pz * desiredDirZ;
                                const plat = Math.abs(-pz * desiredDirX + px * desiredDirZ);
                                if (pfwd > 0 && pfwd < 2.0 && plat < 1.0) {
                                    speedThrottle = Math.min(speedThrottle, Math.max(0.0, (pfwd - 0.85) / 1.0));
                                    const sideX = -pz / pdist;
                                    const sideZ = px / pdist;
                                    steerX += sideX * 0.8;
                                    steerZ += sideZ * 0.8;
                                }
                                if (pdist < 1.1) {
                                    const ppush = (1.1 - pdist) / 1.1;
                                    separationX -= (px / pdist) * ppush * 0.85;
                                    separationZ -= (pz / pdist) * ppush * 0.85;
                                    if (now > (child.bumpCooldownUntil || 0)) {
                                        child.bumpYieldUntil = now + 450 + Math.random() * 300;
                                        child.bumpReactionUntil = now + 750;
                                        child.bumpCooldownUntil = now + 1400;
                                    }
                                }
                            }
                        }

                        // D. Apply calculated movement velocity
                        if (isBumpYielding || speedThrottle < 0.05) {
                            child.body.velocity.x = separationX;
                            child.body.velocity.z = separationZ;
                        } else {
                            const steerLen = Math.hypot(steerX, steerZ);
                            const finalSpeed = baseSpeed * Math.min(1.0, Math.max(0.1, speedThrottle));
                            if (steerLen > 0.01) {
                                child.body.velocity.x = (steerX / steerLen) * finalSpeed + separationX;
                                child.body.velocity.z = (steerZ / steerLen) * finalSpeed + separationZ;
                            } else {
                                child.body.velocity.x = separationX;
                                child.body.velocity.z = separationZ;
                            }
                        }
                    }
                }

                // D. Anti-Stuck Watchdog
                if (!child.lastProgressTime || now - child.lastProgressTime > 700) {
                    child.lastProgressTime = now;
                    if (child.lastProgressPos) {
                        const moved = Math.hypot(child.body.position.x - child.lastProgressPos.x, child.body.position.z - child.lastProgressPos.z);
                        if (moved < 0.10 && child.behaviorState === 'navigating') {
                            child.stuckCount = (child.stuckCount || 0) + 1;
                            if (child.stuckCount >= 2) {
                                setCustomerTarget(child);
                                child.stuckCount = 0;
                            }
                        } else {
                            child.stuckCount = 0;
                        }
                    }
                    if (child.lastProgressPos) child.lastProgressPos.set(child.body.position.x, 0, child.body.position.z);
                    else child.lastProgressPos = new THREE.Vector3(child.body.position.x, 0, child.body.position.z);
                }
            }
        }

        // Sync 3D group visual position to Cannon physics body
        child.position.x = child.body.position.x;
        child.position.y = child.body.position.y - 0.9;
        child.position.z = child.body.position.z;
        // Customers who lose it during the nuke siren bounce around frantically
        if (child.nukeMode === 'crazy') child.position.y += Math.abs(Math.sin(now * 0.014 + (child.animPhase || 0))) * 0.4;

        // Smooth body rotation to movement direction or polite bump reaction
        const vdx = child.body.velocity.x;
        const vdz = child.body.velocity.z;
        const speed = Math.hypot(vdx, vdz);

        if (now < (child.bumpReactionUntil || 0)) {
            // Polite bump recoil & glance
            const bumpProgress = (child.bumpReactionUntil - now) / 750;
            if (child.head && child.behaviorState !== 'asking_player') {
                child.head.rotation.x = -0.15 * Math.sin(bumpProgress * Math.PI);
                child.head.rotation.y = 0.18 * Math.sin(bumpProgress * Math.PI * 2);
            }
            if (child.bodyMesh) {
                child.bodyMesh.rotation.x = -0.10 * Math.sin(bumpProgress * Math.PI);
            }
        } else if (speed > 0.02 && child.behaviorState !== 'socializing' && child.behaviorState !== 'inspecting' && child.behaviorState !== 'checkout_wait') {
            if (child.head && child.behaviorState !== 'asking_player') {
                child.head.rotation.set(0, 0, 0);
            }
            if (child.bodyMesh) {
                child.bodyMesh.rotation.set(0, 0, 0);
            }
            const yaw = Math.atan2(vdx, vdz);
            slerpToYaw(child, yaw, 0.15);
        } else {
            if (child.bodyMesh) {
                child.bodyMesh.rotation.x *= 0.85;
            }
        }

        // Natural genuine eyelid blinking (without squishing pupils)
        updateEyelidBlink(child, now);

        // Animated leg swing walking cycle
        const t = now * 0.003 + child.animPhase;
        const swingMultiplier = (now < (child.bumpYieldUntil || 0)) ? 0.05 : 1.0;
        const swing = Math.min(0.5, speed / child.walkSpeed) * 0.35 * swingMultiplier;
        child.leftLeg.rotation.x = Math.sin(t * 5.2) * swing;
        child.rightLeg.rotation.x = Math.sin(t * 5.2 + Math.PI) * swing;

        // Rare customer question encounter with player
        if (!customerQuestionInProgress && !tweakerRequestOpen && !child.interacting && !child.scufflePartner &&
            now > (child.nextQuestionAt || 0) && playerBody &&
            gameStarted && !isCheckout && !gamePaused && !gameOver && !introCutsceneActive && child.visible !== false &&
            (CONFIG.CUSTOMER_QUESTION_CHANCE ?? 2.5) > 0) {
            const pdx = playerBody.position.x - child.body.position.x;
            const pdz = playerBody.position.z - child.body.position.z;
            const pd = Math.hypot(pdx, pdz);
            if (pd < 4.5 && Math.random() < 0.5) {
                customerQuestionInProgress = true;
                child.interacting = true;
                child.behaviorState = 'asking_player';
                customerQuestionActor = child;
                const tgt = navGrid ? clampToWalkable(navGrid, playerBody.position.x, playerBody.position.z) : { x: playerBody.position.x, z: playerBody.position.z };
                child.nav = child.nav || {};
                child.nav.target = new THREE.Vector3(tgt.x, 0, tgt.z);
                child.nav.path = findPath(navGrid, { x: child.body.position.x, z: child.body.position.z }, { x: tgt.x, z: tgt.z });
                child.nav.waypointIdx = 0;
            }
        }

        // If interacting, once close enough, trigger the popup
        if (child.interacting && playerBody && !tweakerRequestOpen) {
            const pdx = playerBody.position.x - child.body.position.x;
            const pdz = playerBody.position.z - child.body.position.z;
            const pd = Math.hypot(pdx, pdz);
            if (pd < 1.6) {
                child.body.velocity.x = 0;
                child.body.velocity.z = 0;
                if (!customerInteractionMessageVisible) {
                    showCustomerInteractionMessage();
                }
            }
        }
    });

    // Check if player is near checkout and has all items
    checkCheckoutReady();

    // Animate arm swinging slightly while walking
    if (gameStarted && !isCheckout && !powerOutage) {
        const speed = Math.sqrt(
            playerBody.velocity.x * playerBody.velocity.x +
            playerBody.velocity.z * playerBody.velocity.z
        );

        if (speed > 0.5) {
            const time = performance.now() * 0.003;
            const swingAmount = Math.sin(time * 5) * 0.1 * (speed / 5);

            arm.position.y = -0.2 + swingAmount;
            if (!heldItem) {
                arm.rotation.x = swingAmount * 0.5;
            }
        } else {
            arm.position.y = -0.2;
            if (!heldItem) {
                arm.rotation.x = 0;
            }
        }
    }

    // Apply atmosphere / skybox / darkness depending on mode
    updateStorePower(delta);
    if (isLonelyStoreMode) {
        if (nightSkyTexture) {
            scene.background = nightSkyTexture;
            scene.environment = nightSkyTexture;
        } else {
            scene.background = LONELY_BG_COLOR;
            scene.environment = null;
        }
        scene.fog.color.set(0x010206);
        scene.fog.near = 2;
        scene.fog.far = 28;
    } else {
        // Daytime skybox & blue atmospheric distance fog
        if (skyTexture) {
            scene.background = skyTexture;
            // The sky's image-based lighting would light the dark store evenly
            scene.environment = storePowerLevel > 0.5 ? skyTexture : null;
        } else {
            scene.background = DAY_BG_COLOR;
        }
        scene.fog.color.set(0x9cc6e8);
        scene.fog.near = 25;
        scene.fog.far = 650;
    }

    // Update any vehicles driving out of the parking lot
    updateDrivingCars(delta);

    // Automatic sliding doors: open when player, employee (storeWorker), or customers approach, close when far
    if (autoDoors) {
        const checkNearDoor = (x, z, radius = 6.0) => Math.hypot(x - 0, z - (-30)) < radius;

        let shouldOpen = false;
        if (playerBody && checkNearDoor(playerBody.position.x, playerBody.position.z, 6.0)) {
            shouldOpen = true;
        }
        if (!shouldOpen && storeWorker?.body && checkNearDoor(storeWorker.body.position.x, storeWorker.body.position.z, 6.0)) {
            shouldOpen = true;
        }
        if (!shouldOpen && customers.some(c => c?.body && c.visible !== false && checkNearDoor(c.body.position.x, c.body.position.z, 5.5))) {
            shouldOpen = true;
        }
        if (!shouldOpen && thief && checkNearDoor(thief.position.x, thief.position.z, 6.0)) {
            shouldOpen = true;
        }
        if (!shouldOpen && activeTweaker?.body &&
            checkNearDoor(activeTweaker.body.position.x, activeTweaker.body.position.z, 9.0)) {
            shouldOpen = true;
        }

        if (shouldOpen && !autoDoors.open) {
            autoDoors.open = true;
            playEntranceDoorBeep();
        } else if (!shouldOpen && autoDoors.open) {
            autoDoors.open = false;
        }

        const slideOffset = autoDoors.open ? autoDoors.maxSlide : 0;
        const targetLeftX = autoDoors.closedLeftX - slideOffset;
        const targetRightX = autoDoors.closedRightX + slideOffset;

        // Smooth slide
        const lerpFactor = 0.12;
        autoDoors.leftPane.position.x = THREE.MathUtils.lerp(autoDoors.leftPane.position.x, targetLeftX, lerpFactor);
        autoDoors.rightPane.position.x = THREE.MathUtils.lerp(autoDoors.rightPane.position.x, targetRightX, lerpFactor);

        // Sync physics bodies to panes
        autoDoors.leftBody.position.x = autoDoors.leftPane.position.x;
        autoDoors.rightBody.position.x = autoDoors.rightPane.position.x;

        // When open sufficiently, temporarily disable collisions
        const openedEnough = slideOffset > 0.5 * autoDoors.maxSlide;
        autoDoors.leftBody.collisionResponse = !openedEnough;
        autoDoors.rightBody.collisionResponse = !openedEnough;
    }

    // Update persistent product spill interactions (spills stay on floor without despawning)
    if (productSpills && productSpills.length > 0) {
        if (playerBody) {
            const px = playerBody.position.x;
            const pz = playerBody.position.z;
            let onSpill = false, onSticky = false;
            for (let i = 0; i < productSpills.length && !(onSpill && onSticky); i++) {
                const sp = productSpills[i];
                if (Math.hypot(px - sp.x, pz - sp.z) >= sp.radius) continue;
                if (sp.sticky) onSticky = true; else onSpill = true;
            }
            if (onSticky && !playerOnSticky) {
                playerOnSticky = true;
                displayMessage("Ugh, peanut butter! Your shoes are stuck...", 2500);
            } else if (!onSticky && playerOnSticky) {
                playerOnSticky = false;
            }

            if (onSpill && !playerOnSpill) {
                playerOnSpill = true;
                unlockAchievement('slip');
                displayMessage("Oops, slippery spill! Moving slower here.", 2500);
                if (Math.random() < dropAllItemsOnSpillChance) {
                    triggerTrip();
                }
                startSpillTripCheckForPlayer();
            } else if (!onSpill && playerOnSpill) {
                playerOnSpill = false;
                stopSpillTripCheckForPlayer();
            }
        }

        // Customer interaction with persistent spills
        customers.forEach(c => {
            if (c?.body && c.visible !== false) {
                const cx = c.body.position.x;
                const cz = c.body.position.z;
                const onSpill = productSpills.some(sp => !sp.sticky && Math.hypot(cx - sp.x, cz - sp.z) < sp.radius);
                if (onSpill) {
                    startSpillTripCheckForCustomer(c);
                } else {
                    stopSpillTripCheckForCustomer(c);
                }
            }
        });
    }

    // Update persistent glass shards hazard zone interaction
    if (glassShardsZones && glassShardsZones.length > 0) {
        const px = playerBody ? playerBody.position.x : camera.position.x;
        const pz = playerBody ? playerBody.position.z : camera.position.z;
        const onShards = glassShardsZones.some(gz => Math.hypot(px - gz.x, pz - gz.z) < gz.radius);
        if (onShards && !playerOnGlassShards) {
            playerOnGlassShards = true;
            displayMessage("⚠️ Crunch! Walking on glass shards slows you down.", 2200);
        } else if (!onShards && playerOnGlassShards) {
            playerOnGlassShards = false;
        }
    } else {
        playerOnGlassShards = false;
    }

    // Update 2-in-1 items animation
    const time = performance.now() * 0.001;
    allItems.forEach(item => {
        if (item.isTwoInOne && item.update) {
            item.update(time);
        }
    });

    // Update gnome thief movement and waddle animation if active
    if (thief) {
        updateGnomeThief(delta);
    }

    // Update Lonely Store Stalker entity if active
    if (isLonelyStoreMode && lonelyStoreStalker) {
        updateStalker(delta);
    }

    // Update cart position to be in front of player with very subtle side-to-side sway
    if (gameStarted && !isCheckout && cartAttached && controls.isLocked && !cartFlingActive) {
        const direction = camera.getWorldDirection(_cartDir);
        direction.y = 0;
        direction.normalize();

        // The cart can't go through shelves or walls: walking it into one stops
        // you, turning it into one stops the swing.
        const cartSolve = CartPhys.solveAttachedCart(playerBody, Math.atan2(direction.x, direction.z), performance.now());
        camera.position.x += cartSolve.pushX;
        camera.position.z += cartSolve.pushZ;
        direction.set(Math.sin(cartSolve.yaw), 0, Math.cos(cartSolve.yaw));

        const rightDir = _cartRight.crossVectors(direction, WORLD_UP).normalize();

        // Subtle nuanced sway
        const cartSwayLateral = Math.sin(playerWalkBobPhase) * 0.016 * playerWalkBobAmount;
        const cartSwayVertical = Math.abs(Math.sin(playerWalkBobPhase * 2)) * 0.004 * playerWalkBobAmount;
        const cartSwayRoll = Math.sin(playerWalkBobPhase) * 0.010 * playerWalkBobAmount;
        const cartSwayYaw = Math.cos(playerWalkBobPhase) * 0.007 * playerWalkBobAmount;

        // Position cart in front of player with gentle sway
        cartObject.position.copy(playerBody.position)
            .add(direction.multiplyScalar(CartPhys.CART_FOLLOW_DIST))
            .addScaledVector(rightDir, cartSwayLateral);
        cartObject.position.y = cartSwayVertical;

        // Make cart face same direction as player with subtle sway
        const angle = Math.atan2(direction.x, direction.z);
        cartObject.rotation.y = angle + cartSwayYaw + (cartStuckActive ? cartStuckPull * 0.055 : 0);
        cartObject.rotation.z = cartSwayRoll + (cartStuckActive ? cartStuckPull * 0.075 : 0);
        cartObject.rotation.x = Math.abs(Math.sin(playerWalkBobPhase * 2)) * 0.004 * playerWalkBobAmount;
    } else if (cartObject && !cartFlingActive) {
        cartObject.rotation.z = THREE.MathUtils.lerp(cartObject.rotation.z, 0, delta * 6);
        cartObject.rotation.x = THREE.MathUtils.lerp(cartObject.rotation.x, 0, delta * 6);
        cartObject.position.y = THREE.MathUtils.lerp(cartObject.position.y || 0, 0, delta * 6);
    }
    if (!cartAttached || cartFlingActive || isCheckout) CartPhys.resetCartHeading();

    // Cart hull in the world (thrown items land in it) and the basket contents
    CartPhys.updateCartHull(delta, !!(cartObject?.visible && gameStarted && !isCheckout));
    CartPhys.stepCartPhysics(delta);
    updateSpillTracks(scene, productSpills, playerBody, cart3D,
        gameStarted && !gamePaused && !gameOver && !isCheckout && !tripped,
        cartAttached && !cartFlingActive && !!cartObject?.visible, now);

    // Update Store Worker Restocker
    updateStoreWorker(delta);

    // Update NPC carts following their owners
    const dt = delta;
    customers.forEach(c => {
        updateNpcCartFollow(c, dt);
        updateCustomerSlapMark(c, now);
    });
    updateCustomerScuffle(now, delta);

    // Hierarchical Frustum Culling pass
    updateFrustumCulling();

    renderer.render(scene, camera);
}

function findCustomerUnderCrosshair() {
    if (!playerBody || !customers?.length) return null;
    camera.getWorldPosition(sharedRaycaster.ray.origin);
    camera.getWorldDirection(sharedRaycaster.ray.direction);
    let closest = null;
    for (const customer of customers) {
        if (!customer.body || customer.visible === false) continue;
        if (Math.hypot(customer.position.x - playerBody.position.x,
            customer.position.z - playerBody.position.z) > 2.7) continue;
        for (const mesh of [customer.head, customer.bodyMesh, customer.leftLeg, customer.rightLeg]) {
            if (!mesh?.visible) continue;
            mesh.updateWorldMatrix(true, false);
            const hit = sharedRaycaster.intersectObject(mesh, false)[0];
            if (hit && hit.distance <= 3.3 && (!closest || hit.distance < closest.distance)) {
                closest = { customer, mesh, point: hit.point.clone(), face: hit.face, distance: hit.distance };
            }
        }
    }
    return closest;
}

// Drop a mesh item to floor with physics near position
function dropMeshItemToFloor(item, px, pz) {
    if (!item) return;
    item.isCustomerHeld = false;
    try {
        // Ensure visible in scene
        if (item.mesh?.parent) item.mesh.parent.remove(item.mesh);
        scene.add(item.mesh);
        // Restore material depth for proper rendering
        try {
            item.mesh.traverse(o => {
                if (o.isMesh && o.material) {
                    (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m.depthTest = true; m.depthWrite = true; });
                }
                o.renderOrder = 0;
            });
        } catch (_) {}

        // Remove any old body and create a new dynamic one
        if (item.body) { try { world.removeBody(item.body); } catch(_) {} }
        const shape = new CANNON.Box(new CANNON.Vec3(item.size[0]/2, item.size[1]/2, item.size[2]/2));
        const body = new CANNON.Body({ mass: 1, shape });
        const x = px + (Math.random() - 0.5) * 0.6;
        const z = pz + (Math.random() - 0.5) * 0.6;
        body.position.set(x, 1.2, z);
        // give a slight outward impulse
        body.velocity.set((Math.random()-0.5)*1.5, 1.5, (Math.random()-0.5)*1.5);
        world.addBody(body);
        item.body = body;
        item.isStatic = false;
        item.inCart = false;
        item.inCustomerCart = false;
        item.mesh.position.copy(body.position);
        item.mesh.quaternion.copy(body.quaternion);
    } catch (_) {}
}

// Make customer flee away from player for a short duration
function makeCustomerFlee(cust, ms = 2500) {
    if (!cust?.body || !playerBody) return;
    const ang = Math.atan2(cust.body.position.z - playerBody.position.z, cust.body.position.x - playerBody.position.x);
    const fleeSpeed = 3.0; // brisk
    cust.fleeUntil = performance.now() + ms;
    cust.fleeDir = { x: Math.cos(ang), z: Math.sin(ang) };
    cust.walkSpeedBackup = cust.walkSpeed;
    cust.walkSpeed = 2.5;
}

function getCustomerSlapTexture() {
    if (!customerSlapTexture) {
        customerSlapTexture = sharedTextureLoader.load('uploads/webp/leslap_256.webp');
        customerSlapTexture.colorSpace = THREE.SRGBColorSpace;
    }
    return customerSlapTexture;
}

function clearCustomerSlapMark(cust) {
    const mark = cust?.slapMark;
    if (!mark) return;
    if (mark.parent) mark.parent.remove(mark);
    mark.geometry.dispose();
    mark.material.dispose();
    cust.slapMark = null;
    cust.slapMarkUntil = 0;
}

function showCustomerSlapMark({ customer: cust, mesh, point, face }) {
    if (!cust?.body || !mesh || !face) return;
    clearCustomerSlapMark(cust);

    mesh.updateWorldMatrix(true, false);
    const normal = face.normal.clone().applyMatrix3(
        new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld)
    ).normalize();
    const rotation = new THREE.Euler().setFromQuaternion(
        new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal)
    );
    const size = mesh === cust.head ? new THREE.Vector3(0.26, 0.26, 0.22) :
        mesh === cust.bodyMesh ? new THREE.Vector3(0.40, 0.43, 0.32) :
        new THREE.Vector3(0.17, 0.23, 0.16);
    const geometry = new DecalGeometry(mesh, point, rotation, size);
    geometry.applyMatrix4(mesh.matrixWorld.clone().invert());
    const mark = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        map: getCustomerSlapTexture(),
        transparent: true,
        opacity: 0.95,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        depthTest: true,
        depthWrite: false,
        toneMapped: false,
        side: THREE.DoubleSide
    }));
    mesh.add(mark);
    cust.slapMark = mark;
    cust.slapMarkUntil = performance.now() + 2400;
    updateCustomerSlapMark(cust, performance.now());
}

function updateCustomerSlapMark(cust, now) {
    const mark = cust?.slapMark;
    if (!mark) return;
    if (!cust.body || !mark.parent || now >= cust.slapMarkUntil) {
        clearCustomerSlapMark(cust);
        return;
    }

    mark.visible = cust.visible !== false;

    const remaining = cust.slapMarkUntil - now;
    mark.material.opacity = 0.95 * Math.min(1, remaining / 550);
}

// Create low-poly light blue tube arm with a skin-colored ball hand for the slap animation overlay
function createSlapArmMesh(fromLeft = true) {
    const group = new THREE.Group();
    // Lighter, soft, less intense blue for the arm sleeve
    const armMat = new THREE.MeshBasicMaterial({
        color: 0x60a5fa,
        depthTest: false,
        depthWrite: false
    });
    // Natural skin tone for the ball hand
    const skinMat = new THREE.MeshBasicMaterial({
        color: 0xffd1a4,
        depthTest: false,
        depthWrite: false
    });

    // 1. Low-poly tube arm (cylinder with 8 radial segments)
    const armLength = 0.95;
    const armRadius = 0.055;
    const armGeo = new THREE.CylinderGeometry(armRadius, armRadius, armLength, 8);
    const armMesh = new THREE.Mesh(armGeo, armMat);
    // Orient cylinder arm so it extends from edge towards the hand
    armMesh.position.set(fromLeft ? -0.38 : 0.38, -0.16, 0);
    armMesh.rotation.z = fromLeft ? -Math.PI / 3.2 : Math.PI / 3.2;
    group.add(armMesh);

    // 2. Low-poly skin-colored ball hand (sphere with 8 segments)
    const ballGeo = new THREE.SphereGeometry(0.14, 8, 7);
    const ballMesh = new THREE.Mesh(ballGeo, skinMat);
    ballMesh.position.set(0, 0, 0);
    group.add(ballMesh);

    group.traverse(o => {
        if (o.isMesh) {
            o.renderOrder = 999999;
            o.material.depthTest = false;
            o.material.depthWrite = false;
        }
    });

    return group;
}

// Create and run slap hand animation over camera
function spawnSlapHand() {
    if (slapHand && slapHand.parent) { try { slapHand.parent.remove(slapHand); } catch(_) {} }
    const fromLeft = Math.random() < 0.5;
    slapHand = createSlapArmMesh(fromLeft);
    camera.add(slapHand);
    const startX = fromLeft ? -0.85 : 0.85;
    const endX = fromLeft ? 0.85 : -0.85;
    slapHand.position.set(startX, -0.08, -0.50);
    slapHand.userData = {
        fromLeft,
        startX,
        endX,
        dir: fromLeft ? -1 : 1
    };
    return fromLeft ? -1 : 1;
}

function performSlap() {
    slapCount++;
    // Initialize animation
    const dir = spawnSlapHand(); // -1 for left->right, 1 for right->left
    slapActive = true;
    updatePlayerCartHands();
    slapStart = performance.now();
    slapDidImpact = false;

    // Minor screen bounce at start
    // keep this a purely visual DOM transform; do not change camera.rotation or control state
    if (renderer && renderer.domElement) {
        renderer.domElement.style.transition = 'transform 360ms cubic-bezier(.2,.8,.2,1)';
        renderer.domElement.style.willChange = 'transform';
        renderer.domElement.style.transform = 'none';
    }

    // Hard safety: ensure camera fully resets within 1s
    setTimeout(() => {
        // remove any DOM transform leftover
        try {
            if (renderer && renderer.domElement) {
                renderer.domElement.style.transition = '';
                renderer.domElement.style.transform = '';
                renderer.domElement.style.willChange = '';
            }
        } catch(_) {}
    }, 1000);

    // During animate(): we'll move the hand and at midpoint perform impact
    // Store direction on node for animate
    slapHand.userData.dir = dir;
}

function restoreVanillaGameDefaults() {
    CONFIG.SHELF_COUNT = DEFAULT_GAME_SETTINGS.SHELF_COUNT;
    CONFIG.MIN_SHOPPING_LIST_ITEMS = DEFAULT_GAME_SETTINGS.MIN_SHOPPING_LIST_ITEMS;
    CONFIG.MAX_SHOPPING_LIST_ITEMS = DEFAULT_GAME_SETTINGS.MAX_SHOPPING_LIST_ITEMS;

    CONFIG.POWER_OUTAGE_CHANCE = PROB_DEFAULTS.POWER_OUTAGE_CHANCE;
    CONFIG.FORGOT_GLASSES_CHANCE = PROB_DEFAULTS.FORGOT_GLASSES_CHANCE;
    CONFIG.SLIPPERY_FLOOR_CHANCE = PROB_DEFAULTS.SLIPPERY_FLOOR_CHANCE;
    CONFIG.STORE_CLOSING_CHANCE = PROB_DEFAULTS.STORE_CLOSING_CHANCE;
    CONFIG.THIEF_BREAK_IN_CHANCE = PROB_DEFAULTS.THIEF_BREAK_IN_CHANCE;
    CONFIG.TWO_IN_ONE_ITEM_CHANCE = PROB_DEFAULTS.TWO_IN_ONE_ITEM_CHANCE;
    CONFIG.EMPTY_SHELF_CHANCE = PROB_DEFAULTS.EMPTY_SHELF_CHANCE;
    CONFIG.TRIPPING_CHANCE = PROB_DEFAULTS.TRIPPING_CHANCE;
    CONFIG.DROP_ITEM_CHANCE = PROB_DEFAULTS.DROP_ITEM_CHANCE;
    CONFIG.CUSTOMER_THEFT_CHANCE = PROB_DEFAULTS.CUSTOMER_THEFT_CHANCE;
    CONFIG.NO_MONEY_CHANCE = PROB_DEFAULTS.NO_MONEY_CHANCE;
    CONFIG.OUT_OF_STOCK_CHANCE = PROB_DEFAULTS.OUT_OF_STOCK_CHANCE;
    CONFIG.PRODUCT_SPILL_CHANCE = PROB_DEFAULTS.PRODUCT_SPILL_CHANCE;
    CONFIG.CHECKOUT_BUTTON_REQUIRED_CHANCE = PROB_DEFAULTS.CHECKOUT_BUTTON_REQUIRED_CHANCE;
    CONFIG.ADD_ITEM_CHANCE = PROB_DEFAULTS.ADD_ITEM_CHANCE;
    CONFIG.REMOVE_ITEM_CHANCE = PROB_DEFAULTS.REMOVE_ITEM_CHANCE;
    CONFIG.BABY_CRYING_CHANCE = PROB_DEFAULTS.BABY_CRYING_CHANCE;
    CONFIG.BABY_IN_CART_CHANCE = PROB_DEFAULTS.BABY_IN_CART_CHANCE ?? 7;
    CONFIG.CHECKOUT_BUSY_CHANCE = PROB_DEFAULTS.CHECKOUT_BUSY_CHANCE;
    CONFIG.GUM_CRAVING_CHANCE = PROB_DEFAULTS.GUM_CRAVING_CHANCE ?? 35;
    CONFIG.POWERUP_CHANCE = PROB_DEFAULTS.POWERUP_CHANCE;
    CONFIG.MISLABELED_ITEM_CHANCE = PROB_DEFAULTS.MISLABELED_ITEM_CHANCE;
    CONFIG.WEIGHT_CHANGE_CHANCE = PROB_DEFAULTS.WEIGHT_CHANGE_CHANCE;
    CONFIG.CUSTOMER_QUESTION_CHANCE = PROB_DEFAULTS.CUSTOMER_QUESTION_CHANCE;
    CONFIG.UNDER_CONSTRUCTION_CHANCE = PROB_DEFAULTS.UNDER_CONSTRUCTION_CHANCE;
    CONFIG.MANAGER_JUMPSCARE_CHANCE = PROB_DEFAULTS.MANAGER_JUMPSCARE_CHANCE;
    CONFIG.WIFE_CALL_CHANCE = PROB_DEFAULTS.WIFE_CALL_CHANCE;
    CONFIG.EARTHQUAKE_CHANCE = PROB_DEFAULTS.EARTHQUAKE_CHANCE;
    CONFIG.NUCLEAR_FALLOUT_CHANCE = PROB_DEFAULTS.NUCLEAR_FALLOUT_CHANCE;
    CONFIG.THERMOSTAT_CHANCE = PROB_DEFAULTS.THERMOSTAT_CHANCE;
    CONFIG.CUSTOMER_SCUFFLE_CHANCE = PROB_DEFAULTS.CUSTOMER_SCUFFLE_CHANCE;
    CONFIG.TWEAKER_CHANCE = PROB_DEFAULTS.TWEAKER_CHANCE;
    CONFIG.LONELY_STORE_CHANCE = PROB_DEFAULTS.LONELY_STORE_CHANCE;
    CONFIG.SHELF_REPLACE_CHANCE = PROB_DEFAULTS.SHELF_REPLACE_CHANCE ?? 4;
    CONFIG.FALLING_SHELF_ENABLED = PROB_DEFAULTS.FALLING_SHELF_ENABLED;
    CONFIG.FALLING_SHELF_CHANCE = PROB_DEFAULTS.FALLING_SHELF_CHANCE;
    resetSideQuestConfig();

    isCustomGame = false;
    isLonelyStoreMode = false;
    forceNextGameVanilla = true;

    try {
        const menu = document.getElementById('customization-menu');
        if (menu) menu.style.display = 'none';
        applyConfigToCustomizationSliders();
        persistUserSettings();
    } catch (_) {}
}

function triggerLonelyStoreGlitchCrash() {
    if (playerBody) playerBody.velocity.set(0, 0, 0);

    // Stop ambient low drone when cop sound takes over
    if (soundEffects && soundEffects.lowDrone) {
        try { soundEffects.lowDrone.pause(); } catch(_) {}
    }

    // Play cop car siren sound effect
    if (soundEffects && soundEffects.policeSiren) {
        soundEffects.policeSiren.loop = false;
        try {
            soundEffects.policeSiren.currentTime = 0;
            soundEffects.policeSiren.play().catch(() => {});
        } catch(_) {}
    }

    // After cop car sound plays, execute the fake screen glitch / crash
    setTimeout(() => {
        if (soundEffects && soundEffects.policeSiren) {
            try { soundEffects.policeSiren.pause(); soundEffects.policeSiren.currentTime = 0; } catch(_) {}
        }
        if (soundEffects && soundEffects.shelfCrash) {
            try { soundEffects.shelfCrash.currentTime = 0; soundEffects.shelfCrash.play().catch(() => {}); } catch(_) {}
        }

        const glitchOverlay = document.createElement('div');
        glitchOverlay.id = 'fake-crash-overlay';
        glitchOverlay.innerHTML = `
            <div class="glitch-noise-layer"></div>
            <div class="glitch-bar-tear"></div>
            <div class="glitch-content">
                <div class="glitch-header">FATAL EXCEPTION: THREAD_STUCK_IN_DEVICE_DRIVER</div>
                <div class="glitch-log">*** STOP: 0x000000EA (0xFFFFFA8004B22010, 0xFFFFFA8004B234C0, 0x00000000)
*** magmart_lonely_anomaly.sys - Base Address 0xFFFFF88004812000
HARDWARE MEMORY VIOLATION DETECTED IN ISOLATED RUN
CALLSTACK:
  > 0x7FFF921A30B1 [KERNEL_PANIC_STALKER]
  > 0x7FFF921A44E2 [SHOPLIFT_ANOMALY_FAIL]
  > 0x7FFF9218F100 [STORE_RESET_FORCED]
Dumping crash minidump to NVRAM... [OK]
REBOOTING SUBSYSTEM IN 2 SECONDS...</div>
            </div>
        `;
        document.body.appendChild(glitchOverlay);

        // Force restart into a completely vanilla game round
        setTimeout(() => {
            try { glitchOverlay.remove(); } catch(_) {}
            isBeingArrested = false;
            restoreVanillaGameDefaults();
            restartGameCold();
        }, 2200);
    }, 3200);
}

function checkPlayerOutsideStore() {
    // If player is already being arrested, don't check
    if (isBeingArrested || policeCopAnimation) return;
    
    // Check if player is outside store boundaries
    const playerX = playerBody.position.x;
    const playerZ = playerBody.position.z;
    
    const distanceFromCenter = Math.sqrt(playerX * playerX + playerZ * playerZ);
    
    // Check if player is far enough outside the store boundaries (increased distance)
    // After paying, the parking lot is fair game on the way to your car.
    if (distanceFromCenter > storeSize + (purchaseComplete ? 70 : 25)) {
        isBeingArrested = true;
        unlockAchievement('shoplift');

        if (isLonelyStoreMode) {
            // Lonely Store Easter Egg: no cop car model gets you, just cop car sound
            // followed by a fake screen glitch/crash and a forced new game round.
            triggerLonelyStoreGlitchCrash();
            return;
        }

        if (!policeCarModel) {
            policeCarModel = createPoliceCar();
            scene.add(policeCarModel);
        }
        
        if (soundEffects.policeSiren) {
            soundEffects.policeSiren.loop = true;
            try { soundEffects.policeSiren.currentTime = 0; soundEffects.policeSiren.play(); } catch(e) {}
        }
        
        // Calculate player angle and starting position for police car
        const angle = Math.atan2(playerZ, playerX);
        const arrivalDistance = 6.5; // Final distance in front of player
        const startDistance = 50; // Start animation from far away
        
        // Set police car starting position far away heading toward player
        policeCarStartPosition = {
            x: playerX - Math.cos(angle) * startDistance,
            z: playerZ - Math.sin(angle) * startDistance,
            finalX: playerX - Math.cos(angle) * arrivalDistance,
            finalZ: playerZ - Math.sin(angle) * arrivalDistance,
            angle: angle
        };
        
        policeCarModel.position.set(
            policeCarStartPosition.x,
            0,
            policeCarStartPosition.z
        );
        policeCarModel.lookAt(playerX, 0, playerZ);
        policeCarModel.visible = true;
        
        policeCopAnimation = true;
        policeCarModel.animationStartTime = performance.now();
        policeCarModel.animationDuration = 3200; // 3.2 seconds smooth approach
    }
}

function createPoliceDoorTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');

    // Clean white door background
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, 512, 256);

    // Subtle metallic door seam / trim
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, 512, 12);
    ctx.fillRect(0, 246, 512, 10);

    // Decorative blue & gold interceptor accent stripes
    ctx.fillStyle = '#1e3a8a';
    ctx.fillRect(10, 218, 492, 10);
    ctx.fillStyle = '#d97706';
    ctx.fillRect(10, 230, 492, 4);

    // Draw 7-point Gold Police Star Badge
    const badgeX = 95;
    const badgeY = 115;
    const outerR = 52;
    const innerR = 30;

    // Star outer glow
    ctx.save();
    ctx.shadowColor = 'rgba(217, 119, 6, 0.6)';
    ctx.shadowBlur = 10;
    ctx.fillStyle = '#fbbf24';
    ctx.beginPath();
    const points = 7;
    for (let i = 0; i < points * 2; i++) {
        const r = (i % 2 === 0) ? outerR : innerR;
        const angle = (i * Math.PI) / points - Math.PI / 2;
        const x = badgeX + Math.cos(angle) * r;
        const y = badgeY + Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Badge inner shield
    ctx.fillStyle = '#1e293b';
    ctx.beginPath();
    ctx.arc(badgeX, badgeY, 24, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Badge center text
    ctx.fillStyle = '#fef3c7';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('STATE', badgeX, badgeY - 5);
    ctx.font = 'bold 9px sans-serif';
    ctx.fillText('POLICE', badgeX, badgeY + 8);

    // Bold "POLICE" lettering
    ctx.fillStyle = '#090d16';
    ctx.font = '900 68px "Arial Black", Impact, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('POLICE', 170, 132);

    // Motto & unit details
    ctx.fillStyle = '#334155';
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText('TO PROTECT AND TO SERVE', 175, 160);

    ctx.fillStyle = '#dc2626';
    ctx.font = 'bold 22px "Arial Black", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('EMERGENCY 911', 495, 52);

    ctx.fillStyle = '#1e293b';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText('UNIT #402', 495, 76);

    const texture = new THREE.CanvasTexture(canvas);
    texture.anisotropy = 4;
    return texture;
}

let cachedPoliceDoorTexture = null;

function createPoliceCar() {
    const policeCarGroup = new THREE.Group();
    
    // Realistic materials (reused & optimized)
    const blackPaintMat = new THREE.MeshStandardMaterial({
        color: 0x0a0c10,
        metalness: 0.65,
        roughness: 0.22
    });
    const whitePaintMat = new THREE.MeshStandardMaterial({
        color: 0xf8fafc,
        metalness: 0.35,
        roughness: 0.3
    });
    const darkChassisMat = new THREE.MeshStandardMaterial({
        color: 0x111317,
        metalness: 0.2,
        roughness: 0.8
    });
    const chromeMat = new THREE.MeshStandardMaterial({
        color: 0xf1f5f9,
        metalness: 0.95,
        roughness: 0.1
    });
    const blackTrimMat = new THREE.MeshStandardMaterial({
        color: 0x18181b,
        roughness: 0.7,
        metalness: 0.2
    });
    const rubberMat = new THREE.MeshStandardMaterial({
        color: 0x18181b,
        roughness: 0.9,
        metalness: 0.05
    });
    const tintedGlassMat = new THREE.MeshStandardMaterial({
        color: 0x0f172a,
        roughness: 0.08,
        metalness: 0.9,
        transparent: true,
        opacity: 0.88
    });

    // 1. Lower chassis / undercarriage
    const undercarriage = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.25, 4.8), darkChassisMat);
    undercarriage.position.y = 0.28;
    policeCarGroup.add(undercarriage);

    // 2. Main lower body (black fenders, front nose, rear quarter)
    const lowerBody = new THREE.Mesh(new THREE.BoxGeometry(2.18, 0.55, 4.9), blackPaintMat);
    lowerBody.position.y = 0.55;
    policeCarGroup.add(lowerBody);

    // 3. Tapered hood (sloped down toward front grille at +Z)
    const hoodGeo = new THREE.BoxGeometry(1.95, 0.16, 1.6);
    const hood = new THREE.Mesh(hoodGeo, blackPaintMat);
    hood.position.set(0, 0.84, 1.45);
    hood.rotation.x = 0.05;
    policeCarGroup.add(hood);

    // Hood scoop / power bulge center ridge
    const hoodBulge = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.06, 1.3), blackPaintMat);
    hoodBulge.position.set(0, 0.92, 1.45);
    hoodBulge.rotation.x = 0.05;
    policeCarGroup.add(hoodBulge);

    // 4. Rear trunk deck (at -Z)
    const trunk = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.16, 1.2), blackPaintMat);
    trunk.position.set(0, 0.82, -1.65);
    trunk.rotation.x = -0.03;
    policeCarGroup.add(trunk);

    // 5. White side doors with realistic police livery
    if (!cachedPoliceDoorTexture) {
        cachedPoliceDoorTexture = createPoliceDoorTexture();
    }
    const doorDecalMat = new THREE.MeshStandardMaterial({
        map: cachedPoliceDoorTexture,
        roughness: 0.35,
        metalness: 0.2
    });

    const leftDoorPanel = new THREE.Mesh(new THREE.PlaneGeometry(2.1, 0.58), doorDecalMat);
    leftDoorPanel.position.set(-1.101, 0.62, -0.05);
    leftDoorPanel.rotation.y = -Math.PI / 2;
    const rightDoorPanel = new THREE.Mesh(new THREE.PlaneGeometry(2.1, 0.58), doorDecalMat);
    rightDoorPanel.position.set(1.101, 0.62, -0.05);
    rightDoorPanel.rotation.y = Math.PI / 2;
    rightDoorPanel.scale.x = -1; // keep lettering facing forwards
    policeCarGroup.add(leftDoorPanel, rightDoorPanel);

    // 6. Passenger Cabin & White Roof
    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.68, 0.08, 1.9), whitePaintMat);
    roof.position.set(0, 1.42, -0.15);
    policeCarGroup.add(roof);

    // Pillars
    const aPillarL = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.62, 0.08), blackPaintMat);
    aPillarL.position.set(-0.76, 1.15, 0.72);
    aPillarL.rotation.x = -0.42;
    const aPillarR = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.62, 0.08), blackPaintMat);
    aPillarR.position.set(0.76, 1.15, 0.72);
    aPillarR.rotation.x = -0.42;

    const bPillarL = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.54, 0.12), blackPaintMat);
    bPillarL.position.set(-0.82, 1.14, -0.15);
    const bPillarR = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.54, 0.12), blackPaintMat);
    bPillarR.position.set(0.82, 1.14, -0.15);

    const cPillarL = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.62, 0.12), blackPaintMat);
    cPillarL.position.set(-0.76, 1.15, -1.02);
    cPillarL.rotation.x = 0.42;
    const cPillarR = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.62, 0.12), blackPaintMat);
    cPillarR.position.set(0.76, 1.15, -1.02);
    cPillarR.rotation.x = 0.42;
    policeCarGroup.add(aPillarL, aPillarR, bPillarL, bPillarR, cPillarL, cPillarR);

    // 7. Glass Windows
    const frontWindshield = new THREE.Mesh(new THREE.PlaneGeometry(1.52, 0.65), tintedGlassMat);
    frontWindshield.position.set(0, 1.16, 0.75);
    frontWindshield.rotation.x = -0.42;
    const rearWindshield = new THREE.Mesh(new THREE.PlaneGeometry(1.52, 0.65), tintedGlassMat);
    rearWindshield.position.set(0, 1.16, -1.05);
    rearWindshield.rotation.x = Math.PI + 0.42;
    const sideGlassL = new THREE.Mesh(new THREE.PlaneGeometry(1.85, 0.46), tintedGlassMat);
    sideGlassL.position.set(-0.83, 1.15, -0.15);
    sideGlassL.rotation.y = -Math.PI / 2;
    const sideGlassR = new THREE.Mesh(new THREE.PlaneGeometry(1.85, 0.46), tintedGlassMat);
    sideGlassR.position.set(0.83, 1.15, -0.15);
    sideGlassR.rotation.y = Math.PI / 2;
    policeCarGroup.add(frontWindshield, rearWindshield, sideGlassL, sideGlassR);

    // 8. Interior Hints (Dashboard & Steering Wheel & MDT Police Computer Screen)
    const dash = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.25, 0.45), blackTrimMat);
    dash.position.set(0, 0.95, 0.55);
    const mdtScreenMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
    const mdtScreen = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.14, 0.04), mdtScreenMat);
    mdtScreen.position.set(0.12, 1.08, 0.48);
    mdtScreen.rotation.y = -0.3;
    const steeringWheel = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.02, 8, 16), blackTrimMat);
    steeringWheel.position.set(-0.42, 1.05, 0.42);
    steeringWheel.rotation.x = 0.5;
    policeCarGroup.add(dash, mdtScreen, steeringWheel);

    // 9. Front Police Push Bumper (Bullbar) at +Z
    const bullbarGroup = new THREE.Group();
    const barMat = new THREE.MeshStandardMaterial({ color: 0x09090b, roughness: 0.5, metalness: 0.8 });
    const rubberPadMat = new THREE.MeshStandardMaterial({ color: 0x1c1917, roughness: 0.9 });
    
    const uprightL = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.65, 0.08), barMat);
    uprightL.position.set(-0.45, 0.55, 2.58);
    const uprightR = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.65, 0.08), barMat);
    uprightR.position.set(0.45, 0.55, 2.58);
    const padL = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.62, 0.04), rubberPadMat);
    padL.position.set(-0.45, 0.55, 2.63);
    const padR = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.62, 0.04), rubberPadMat);
    padR.position.set(0.45, 0.55, 2.63);
    const crossTop = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.4, 8), barMat);
    crossTop.rotation.z = Math.PI / 2;
    crossTop.position.set(0, 0.72, 2.58);
    const crossBottom = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.4, 8), barMat);
    crossBottom.rotation.z = Math.PI / 2;
    crossBottom.position.set(0, 0.42, 2.58);
    const strutL = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.25), barMat);
    strutL.position.set(-0.45, 0.45, 2.44);
    const strutR = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.25), barMat);
    strutR.position.set(0.45, 0.45, 2.44);

    bullbarGroup.add(uprightL, uprightR, padL, padR, crossTop, crossBottom, strutL, strutR);
    policeCarGroup.add(bullbarGroup);

    // 10. Front Grille & Headlights at +Z
    const grilleMat = new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.8, roughness: 0.4 });
    const grille = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.32, 0.04), grilleMat);
    grille.position.set(0, 0.56, 2.46);
    policeCarGroup.add(grille);

    const headlightLensMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: 0xffffee,
        emissiveIntensity: 0.8,
        roughness: 0.1
    });
    const headlightL = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.22, 0.06), headlightLensMat);
    headlightL.position.set(-0.85, 0.58, 2.46);
    const headlightR = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.22, 0.06), headlightLensMat);
    headlightR.position.set(0.85, 0.58, 2.46);
    policeCarGroup.add(headlightL, headlightR);

    const amberMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0xd97706, emissiveIntensity: 0.4 });
    const cornerSignalL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.20, 0.08), amberMat);
    cornerSignalL.position.set(-1.06, 0.58, 2.43);
    const cornerSignalR = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.20, 0.08), amberMat);
    cornerSignalR.position.set(1.06, 0.58, 2.43);
    policeCarGroup.add(cornerSignalL, cornerSignalR);

    // 11. Rear Taillight Assemblies & Dual Chrome Exhausts at -Z
    const taillightMat = new THREE.MeshStandardMaterial({
        color: 0xdc2626,
        emissive: 0xb91c1c,
        emissiveIntensity: 0.5,
        roughness: 0.2
    });
    const taillightL = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.20, 0.06), taillightMat);
    taillightL.position.set(-0.82, 0.60, -2.46);
    const taillightR = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.20, 0.06), taillightMat.clone());
    taillightR.position.set(0.82, 0.60, -2.46);
    policeCarGroup.add(taillightL, taillightR);

    const exhaustL = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.25, 12), chromeMat);
    exhaustL.rotation.x = Math.PI / 2;
    exhaustL.position.set(-0.65, 0.22, -2.48);
    const exhaustR = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.25, 12), chromeMat);
    exhaustR.rotation.x = Math.PI / 2;
    exhaustR.position.set(0.65, 0.22, -2.48);
    policeCarGroup.add(exhaustL, exhaustR);

    // 12. Realistic Police Steelie Wheels with Chrome Center Dog Dish Hubcaps
    const wheelRimMat = new THREE.MeshStandardMaterial({ color: 0x18181b, metalness: 0.8, roughness: 0.4 });
    const createRealisticWheel = (x, z) => {
        const wheelGroup = new THREE.Group();
        const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.22, 16), rubberMat);
        tire.rotation.z = Math.PI / 2;
        tire.castShadow = true;
        wheelGroup.add(tire);

        const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.225, 14), wheelRimMat);
        rim.rotation.z = Math.PI / 2;
        wheelGroup.add(rim);

        const hubcap = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.13, 0.24, 14), chromeMat);
        hubcap.rotation.z = Math.PI / 2;
        wheelGroup.add(hubcap);

        wheelGroup.position.set(x, 0.38, z);
        return wheelGroup;
    };

    const wheels = [
        createRealisticWheel(-1.02, 1.45),
        createRealisticWheel(1.02, 1.45),
        createRealisticWheel(-1.02, -1.45),
        createRealisticWheel(1.02, -1.45)
    ];
    wheels.forEach(w => policeCarGroup.add(w));

    // 13. Driver-Side A-Pillar Police Spotlight (Searchlight)
    const spotlightGroup = new THREE.Group();
    const spotBody = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.14, 10), blackTrimMat);
    spotBody.rotation.x = Math.PI / 2;
    const spotLens = new THREE.Mesh(new THREE.CircleGeometry(0.075, 10), chromeMat);
    spotLens.position.z = 0.072;
    const spotMount = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.15, 6), chromeMat);
    spotMount.rotation.z = Math.PI / 2;
    spotMount.position.x = 0.08;
    spotlightGroup.add(spotBody, spotLens, spotMount);
    spotlightGroup.position.set(-0.92, 1.25, 0.75);
    spotlightGroup.rotation.y = -0.35;
    policeCarGroup.add(spotlightGroup);

    // Side view mirrors
    const mirrorL = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.10, 0.16), blackPaintMat);
    mirrorL.position.set(-1.12, 1.05, 0.65);
    const mirrorR = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.10, 0.16), blackPaintMat);
    mirrorR.position.set(1.12, 1.05, 0.65);
    policeCarGroup.add(mirrorL, mirrorR);

    // Roof Antennas
    const whipAntenna = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.012, 0.85, 6), blackTrimMat);
    whipAntenna.position.set(-0.35, 1.85, -0.65);
    whipAntenna.rotation.z = 0.08;
    const puckAntenna = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.03, 8), blackTrimMat);
    puckAntenna.position.set(0.35, 1.48, -0.75);
    policeCarGroup.add(whipAntenna, puckAntenna);

    // 14. Modern Aerodynamic LED Emergency Lightbar on Roof
    const lightBarGroup = new THREE.Group();
    const lightBarMountMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, metalness: 0.8, roughness: 0.3 });
    const mountFeet = new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.05, 0.22), lightBarMountMat);
    mountFeet.position.set(0, 1.48, -0.05);
    lightBarGroup.add(mountFeet);

    // Clear polycarbonate lightbar outer shell
    const barShellMat = new THREE.MeshStandardMaterial({
        color: 0xe2e8f0,
        transparent: true,
        opacity: 0.45,
        roughness: 0.1,
        metalness: 0.3
    });
    const barShell = new THREE.Mesh(new THREE.BoxGeometry(1.36, 0.09, 0.24), barShellMat);
    barShell.position.set(0, 1.54, -0.05);
    lightBarGroup.add(barShell);

    // Internal High-Intensity Emergency Strobe Modules
    const strobeRedMat = new THREE.MeshStandardMaterial({
        color: 0xff0000,
        emissive: 0xff0000,
        emissiveIntensity: 0.3,
        roughness: 0.2
    });
    const strobeBlueMat = new THREE.MeshStandardMaterial({
        color: 0x0055ff,
        emissive: 0x0055ff,
        emissiveIntensity: 0.3,
        roughness: 0.2
    });
    const strobeWhiteMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: 0xffffff,
        emissiveIntensity: 0.2,
        roughness: 0.2
    });

    // Left (Red side) LED blocks
    const barRedOuter = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.07, 0.18), strobeRedMat);
    barRedOuter.position.set(-0.48, 1.54, -0.05);
    const barRedInner = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.07, 0.18), strobeRedMat);
    barRedInner.position.set(-0.22, 1.54, -0.05);

    // Right (Blue side) LED blocks
    const barBlueInner = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.07, 0.18), strobeBlueMat);
    barBlueInner.position.set(0.22, 1.54, -0.05);
    const barBlueOuter = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.07, 0.18), strobeBlueMat);
    barBlueOuter.position.set(0.48, 1.54, -0.05);

    // Center Takedown / Strobe Block
    const barCenterWhite = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.07, 0.18), strobeWhiteMat);
    barCenterWhite.position.set(0, 1.54, -0.05);

    lightBarGroup.add(barRedOuter, barRedInner, barCenterWhite, barBlueInner, barBlueOuter);
    policeCarGroup.add(lightBarGroup);

    // 15. Front Grille Emergency Strobes
    const grilleStrobeRed = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.08, 0.05), strobeRedMat.clone());
    grilleStrobeRed.position.set(-0.35, 0.58, 2.50);
    const grilleStrobeBlue = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.08, 0.05), strobeBlueMat.clone());
    grilleStrobeBlue.position.set(0.35, 0.58, 2.50);
    policeCarGroup.add(grilleStrobeRed, grilleStrobeBlue);

    // 16. Dynamic Real-Time PointLights (Lightweight: radius 16m)
    const redPointLight = new THREE.PointLight(0xff0022, 0, 16, 1.5);
    redPointLight.position.set(-0.6, 1.8, -0.05);
    const bluePointLight = new THREE.PointLight(0x0066ff, 0, 16, 1.5);
    bluePointLight.position.set(0.6, 1.8, -0.05);
    policeCarGroup.add(redPointLight, bluePointLight);

    // Store references for dynamic siren lighting animation
    policeCarGroup.userData.sirenMaterials = {
        barRed: strobeRedMat,
        barBlue: strobeBlueMat,
        barWhite: strobeWhiteMat,
        grilleRed: grilleStrobeRed.material,
        grilleBlue: grilleStrobeBlue.material,
        headlightL: headlightLensMat,
        headlightR: headlightLensMat,
        taillightL: taillightMat,
        taillightR: taillightR.material,
        redLight: redPointLight,
        blueLight: bluePointLight
    };

    // Multi-pattern fast emergency strobe sequence (lag-free, fast math)
    policeCarGroup.animate = (t) => {
        const s = policeCarGroup.userData.sirenMaterials;
        if (!s) return;

        const cycle = Math.floor(t * 12) % 12; // 12-step rapid strobe sequence
        
        const isRedFlash = (cycle === 0 || cycle === 2 || cycle === 4);
        const isBlueFlash = (cycle === 6 || cycle === 8 || cycle === 10);
        const isWigWag = (cycle % 2 === 0);

        const highEmissive = 3.2;
        const lowEmissive = 0.15;

        s.barRed.emissiveIntensity = isRedFlash ? highEmissive : lowEmissive;
        s.grilleRed.emissiveIntensity = isRedFlash ? (highEmissive * 1.2) : lowEmissive;

        s.barBlue.emissiveIntensity = isBlueFlash ? highEmissive : lowEmissive;
        s.grilleBlue.emissiveIntensity = isBlueFlash ? (highEmissive * 1.2) : lowEmissive;

        s.barWhite.emissiveIntensity = (cycle === 5 || cycle === 11) ? 2.5 : 0.1;

        // Alternating wig-wag headlights & taillights
        s.headlightL.emissiveIntensity = isWigWag ? 1.8 : 0.6;
        s.headlightR.emissiveIntensity = !isWigWag ? 1.8 : 0.6;

        s.taillightL.emissiveIntensity = isRedFlash ? 1.8 : 0.4;
        s.taillightR.emissiveIntensity = isBlueFlash ? 1.8 : 0.4;

        // Dynamic PointLight illumination
        if (s.redLight) s.redLight.intensity = isRedFlash ? 3.5 : 0.1;
        if (s.blueLight) s.blueLight.intensity = isBlueFlash ? 3.5 : 0.1;
    };

    return policeCarGroup;
}

function showArrestMessage() {
    // Stop gameplay without resetting immediately
    gameOver = true;
    endCustomerScuffle(true);
    if (timer) { try { clearInterval(timer); } catch(_) {} timer = null; }
    controls.unlock();
    playerBody.velocity.set(0, 0, 0);
    policeCopAnimation = false;
    if (soundEffects.policeSiren) { soundEffects.policeSiren.pause(); soundEffects.policeSiren.currentTime = 0; }

    // Play fail music for shoplifting arrest
    playFailMusic();

    const overlay = document.createElement('div');
    overlay.id = 'arrest-overlay';
    overlay.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(255,255,255,0.9);padding:20px;border-radius:10px;z-index:200;text-align:center;';
    overlay.innerHTML = '<h2>You have been arrested for shoplifting!</h2><button id="arrest-play-again">Play Again</button> <button id="arrest-menu">Back to Menu</button>';
    document.getElementById('game-container').appendChild(overlay);

    const cleanup = () => {
        if (policeCarModel) { scene.remove(policeCarModel); policeCarModel = null; }
        isBeingArrested = false;
        overlay.remove();
    };

    document.getElementById('arrest-play-again').onclick = () => { cleanup(); restartGameCold(); };
    document.getElementById('arrest-menu').onclick = () => { cleanup(); hardStopGame(); stopMenuMusic(); stopFailMusic(); showMainMenu(); };
}

// One small sample counter per layout. Keep its full footprint (including the
// worker's standing space) clear of shelves, construction and fixed fixtures.
function createFreeSampleBooth() {
    const validSpot = (x, z) => {
        if (blocksStoreRoute(x, z, 1.9)) return false;
        if (Math.hypot(x - 15, z + 15) < 7 ||
            Math.hypot(x + 22, z + 24) < 6 ||
            Math.hypot(x, z + 25) < 5 ||
            Math.hypot(x, z - 20) < 5) return false;
        for (const shelf of shelfUnits) {
            const rot = shelf.userData?.rotY || 0;
            const dx = x - shelf.position.x, dz = z - shelf.position.z;
            const localX = dx * Math.cos(rot) - dz * Math.sin(rot);
            const localZ = dx * Math.sin(rot) + dz * Math.cos(rot);
            if (Math.abs(localX) < 6.2 && Math.abs(localZ) < 3.1) return false;
        }
        return constructionZones.every(zone =>
            Math.abs(x - zone.position.x) > 5.6 || Math.abs(z - zone.position.z) > 5.6
        );
    };

    let spot;
    for (let i = 0; i < 500 && !spot; i++) {
        const x = -24 + Math.random() * 48, z = -22 + Math.random() * 46;
        if (validSpot(x, z)) spot = { x, z };
    }
    // A shuffled grid guarantees a placement even for dense aisle rolls.
    if (!spot) {
        const candidates = [];
        for (let x = -24; x <= 24; x += 2) {
            for (let z = -22; z <= 24; z += 2) candidates.push({ x, z });
        }
        for (let i = candidates.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
        }
        spot = candidates.find(({ x, z }) => validSpot(x, z));
    }
    // Exhaustive fine scan as a final fallback for unusually dense shelf layouts.
    if (!spot) {
        for (let x = -25; x <= 25 && !spot; x += 0.5) {
            for (let z = -24; z <= 25 && !spot; z += 0.5) {
                if (validSpot(x, z)) spot = { x, z };
            }
        }
    }
    if (!spot) return;

    const booth = new THREE.Group();
    booth.position.set(spot.x, 0, spot.z);
    booth.rotation.y = Math.floor(Math.random() * 4) * Math.PI / 2;
    const fabric = new THREE.MeshStandardMaterial({ color: 0xec5046, roughness: 0.85 });
    const trim = new THREE.MeshStandardMaterial({ color: 0xffd782, roughness: 0.65 });
    const top = new THREE.MeshStandardMaterial({ color: 0xf8eee0, roughness: 0.7 });
    const trayMat = new THREE.MeshStandardMaterial({ color: 0xd0d6db, metalness: 0.45, roughness: 0.3 });
    const foods = [0xeab64e, 0xa74c31, 0xf19a60, 0xa2be65].map(color =>
        new THREE.MeshStandardMaterial({ color, roughness: 0.85 })
    );
    const box = (w, h, d, mat, x, y, z) => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
        mesh.position.set(x, y, z);
        booth.add(mesh);
        return mesh;
    };
    box(2.6, 0.95, 1.05, fabric, 0, 0.48, 0);
    box(2.8, 0.12, 1.3, top, 0, 1.02, 0);
    box(2.65, 0.12, 0.08, trim, 0, 0.84, 0.55);
    for (const x of [-1.22, 1.22]) box(0.07, 1.35, 0.07, trim, x, 1.75, -0.43);
    const sign = box(2.55, 0.46, 0.1, fabric, 0, 2.42, -0.43);
    addTextToSign('FREE SAMPLES', sign, 0.32, 0.04, 0xffffff, true);
    booth.userData.samplePieces = [];
    for (const tx of [-0.68, 0.68]) {
        box(0.95, 0.045, 0.67, trayMat, tx, 1.11, 0.06);
        for (let i = 0; i < 5; i++) {
            const piece = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.08, 0.12), foods[Math.floor(Math.random() * foods.length)]);
            booth.userData.samplePieces.push(piece);
            piece.position.set(tx + (i % 3 - 1) * 0.24 + (Math.random() - 0.5) * 0.05,
                1.18, -0.08 + Math.floor(i / 3) * 0.23);
            piece.rotation.y = Math.random() * Math.PI;
            booth.add(piece);
        }
    }
    const worker = createWorkerModel();
    worker.position.set(0, 0, -1.18);
    booth.add(worker);
    scene.add(booth);
    registerCullableObject(booth, 4.1);
    const body = new CANNON.Body({
        mass: 0, shape: new CANNON.Box(new CANNON.Vec3(1.65, 1.1, 1.6))
    });
    body.position.set(spot.x, 1.1, spot.z);
    world.addBody(body);
    sampleBooths.push(booth);
}

// NEW: model + placement for "under construction" barrier zone
function createUnderConstructionZoneModel(x, z) {
    const group = new THREE.Group();

    // Dimensions (~7x7 units footprint, increased from 5x5)
    const zoneSize = 7;
    const half = zoneSize / 2;
    const barricadeHeight = 1.1;
    const barricadeWidth = zoneSize;
    const barricadeDepth = 0.15;

    const postGeom = new THREE.BoxGeometry(0.12, barricadeHeight, 0.12);
    const railGeom = new THREE.BoxGeometry(barricadeWidth * 0.9, 0.18, 0.12);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x444444, roughness: 0.8 });
    const railMat = new THREE.MeshStandardMaterial({ color: 0xffa500, emissive: 0xffa500, emissiveIntensity: 0.3 });

    function makeBarricade() {
        const b = new THREE.Group();
        const leftPost = new THREE.Mesh(postGeom, postMat);
        const rightPost = new THREE.Mesh(postGeom, postMat);
        leftPost.position.set(-barricadeWidth/2 + 0.25, barricadeHeight/2, 0);
        rightPost.position.set(barricadeWidth/2 - 0.25, barricadeHeight/2, 0);

        const topRail = new THREE.Mesh(railGeom, railMat);
        topRail.position.set(0, barricadeHeight * 0.75, 0);
        const midRail = new THREE.Mesh(railGeom, railMat);
        midRail.position.set(0, barricadeHeight * 0.4, 0);

        // subtle diagonal pattern by rotating rails
        topRail.rotation.y = Math.PI * 0.03;
        midRail.rotation.y = -Math.PI * 0.03;

        b.add(leftPost, rightPost, topRail, midRail);
        return b;
    }

    // Four barricades forming a square
    const front = makeBarricade();
    front.position.set(0, 0, -half);
    const back = makeBarricade();
    back.position.set(0, 0, half);
    back.rotation.y = Math.PI;

    const left = makeBarricade();
    left.rotation.y = -Math.PI / 2;
    left.position.set(-half, 0, 0);
    const right = makeBarricade();
    right.rotation.y = Math.PI / 2;
    right.position.set(half, 0, 0);

    group.add(front, back, left, right);

    // Overhead sign
    const signPanelGeom = new THREE.BoxGeometry(zoneSize * 0.9, 0.5, 0.1);
    const signPanelMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.6 });
    const signPanel = new THREE.Mesh(signPanelGeom, signPanelMat);
    signPanel.position.set(0, barricadeHeight + 0.6, 0);
    group.add(signPanel);

    addTextToSign("UNDER CONSTRUCTION!", signPanel, 0.35, 0.05, 0xffffff);

    group.position.set(x, 0, z);
    scene.add(group);

    // Physics barrier to block movement (7x7 footprint, increased from 5x5)
    const barrierShape = new CANNON.Box(new CANNON.Vec3(half, 1, half));
    const barrierBody = new CANNON.Body({
        mass: 0,
        shape: barrierShape
    });
    barrierBody.position.set(x, 1, z);
    // Collide with player (1), customers (4), carts (8) etc.
    barrierBody.collisionFilterGroup = 2;
    barrierBody.collisionFilterMask = 1 | 2 | 4 | 8;
    world.addBody(barrierBody);

    // Track for pathfinding as an obstacle
    group.userData.barrierBody = barrierBody;
    group.radius = half;
    constructionZones.push(group);
    return group;
}

function maybeCreateUnderConstructionZone() {
    const chance = Number.isFinite(CONFIG.UNDER_CONSTRUCTION_CHANCE) ? CONFIG.UNDER_CONSTRUCTION_CHANCE : 15;
    if (Math.random() * 100 >= plus5PercentPercent(chance)) return;

    // Roll a side pocket, not a bottleneck across an aisle or the entrance.
    // Keep the existing event chance and a full 7x7 barrier footprint.
    const candidates = [-7.5, 7.5].flatMap(x => [-9, 1, 11, 21].map(z => ({ x, z })));
    shuffleArray(candidates);
    let chosen = null;

    attemptLoop:
    for (const pocket of candidates) {
        const x = pocket.x + (Math.random() - 0.5) * 0.5;
        const z = pocket.z + (Math.random() - 0.5) * 0.5;
        if (blocksStoreRoute(x, z, 3.5)) continue;

        // Avoid checkout area
        const dxCo = x - 15;
        const dzCo = z + 15;
        if (Math.hypot(dxCo, dzCo) < 6) continue;

        // Avoid being too close to shelves
        for (const u of shelfUnits) {
            const dx = x - u.position.x;
            const dz = z - u.position.z;
            const rot = u.userData.rotY || 0;
            const halfX = Math.abs(Math.cos(rot)) * u.userData.width / 2 + Math.abs(Math.sin(rot)) * u.userData.depth / 2;
            const halfZ = Math.abs(Math.sin(rot)) * u.userData.width / 2 + Math.abs(Math.cos(rot)) * u.userData.depth / 2;
            if (Math.abs(dx) < halfX + 4.2 && Math.abs(dz) < halfZ + 4.2) {
                continue attemptLoop;
            }
        }

        chosen = { x, z };
        break;
    }

    if (!chosen) return;
    underConstructionOccurred = true; // NEW: Track that the zone was created
    createUnderConstructionZoneModel(chosen.x, chosen.z);
}

// NEW: full-screen overlay shown when the store closes before you finish
function showStoreClosedOverlay() {
    gameOver = true;
    gameStarted = false;
    endCustomerScuffle(true);

    // Stop timer cleanly
    if (timer) {
        try { clearInterval(timer); } catch (_) {}
        timer = null;
    }
    // Stop player motion and unlock pointer
    try {
        if (playerBody) {
            playerBody.velocity.set(0, 0, 0);
            playerBody.angularVelocity.set(0, 0, 0);
        }
    } catch (_) {}
    try { controls?.unlock(); } catch (_) {}

    // Play fail music when store closes
    playFailMusic();

    // Create overlay
    const existing = document.getElementById('store-closed-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'store-closed-overlay';
    overlay.innerHTML = `
        <div class="store-closed-panel">
            <div class="store-closed-title">Shopping Failed!</div>
            <div class="store-closed-subtitle">The store closed before you could finish.</div>
            <div class="store-closed-actions">
                <button class="store-closed-btn primary" id="store-closed-restart">Try Again</button>
                <button class="store-closed-btn secondary" id="store-closed-menu">Back to Main Menu</button>
            </div>
        </div>
    `;
    document.getElementById('game-container').appendChild(overlay);

    const restartBtn = document.getElementById('store-closed-restart');
    const menuBtn = document.getElementById('store-closed-menu');

    if (restartBtn) {
        restartBtn.onclick = () => {
            // Use the same cold restart logic as all other restart/new-game buttons
            overlay.remove();
            restartGameCold();
        };
    }
    if (menuBtn) {
        menuBtn.onclick = () => {
            // Back to menu still needs a clean game teardown; hardStopGame()
            // is already called inside restartGameCold via hardStopGame().
            // After that we explicitly show the main menu.
            overlay.remove();
            hardStopGame();
            stopMenuMusic();
            stopFailMusic();
            showMainMenu();
        };
    }
}

// Accidental drops: glass shatters, liquids spill, everything else just lands.
function isGlassItem(itemName) {
    const lower = (itemName || '').toLowerCase();
    return lower === 'soda' ||
           lower === 'coffee' ||
           lower === 'cooking oil' ||
           lower === 'pasta sauce';
}

// Spill colour + behaviour per item. `sticky` spills don't make you slip or
// trip; they just slow you down a lot (peanut butter).
const SPILL_TYPES = {
    'orange juice':      { color: 0xf97316 },
    'cleaning supplies': { color: 0x2563eb },
    'watermelon':        { color: 0xdc2626 },
    'milk':              { color: 0xf8fafc },
    'water bottles':     { color: 0x7dd3fc },
    'peanut butter':     { color: 0x8b5a2b, sticky: true },
};
function spillTypeFor(itemName) {
    return SPILL_TYPES[(itemName || '').toLowerCase()] || null;
}
function isLiquidItem(itemName) {
    return !!spillTypeFor(itemName);
}

let cachedCautionSignTexture = null;
function getCautionSignTexture() {
    if (cachedCautionSignTexture) return cachedCautionSignTexture;
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 384;
    const ctx = canvas.getContext('2d');
    if (ctx) {
        // Bright caution yellow background
        ctx.fillStyle = '#facc15';
        ctx.fillRect(0, 0, 256, 384);
        
        // Dark border
        ctx.strokeStyle = '#1e293b';
        ctx.lineWidth = 10;
        ctx.strokeRect(6, 6, 244, 372);
        
        // CAUTION Header
        ctx.fillStyle = '#0f172a';
        ctx.font = '900 32px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('CAUTION', 128, 54);
        
        // Red warning triangle
        ctx.strokeStyle = '#dc2626';
        ctx.lineWidth = 8;
        ctx.beginPath();
        ctx.moveTo(128, 80);
        ctx.lineTo(210, 205);
        ctx.lineTo(46, 205);
        ctx.closePath();
        ctx.stroke();
        
        // Slipping person icon inside triangle
        ctx.fillStyle = '#0f172a';
        ctx.beginPath();
        ctx.arc(128, 118, 11, 0, Math.PI * 2); // Head
        ctx.fill();
        ctx.lineWidth = 6;
        ctx.strokeStyle = '#0f172a';
        ctx.beginPath();
        ctx.moveTo(128, 132);
        ctx.lineTo(120, 165); // torso
        ctx.lineTo(150, 152); // leg 1 up
        ctx.moveTo(120, 165);
        ctx.lineTo(104, 192); // leg 2 down
        ctx.moveTo(126, 142);
        ctx.lineTo(146, 130); // arm 1
        ctx.moveTo(126, 142);
        ctx.lineTo(106, 138); // arm 2
        ctx.stroke();
        
        // Water puddle swoosh lines under feet
        ctx.lineWidth = 4;
        ctx.strokeStyle = '#2563eb';
        ctx.beginPath();
        ctx.ellipse(128, 198, 40, 6, 0, 0, Math.PI * 2);
        ctx.stroke();
        
        // WET FLOOR text
        ctx.fillStyle = '#0f172a';
        ctx.font = '900 28px sans-serif';
        ctx.fillText('WET FLOOR', 128, 252);
        
        ctx.font = 'bold 17px sans-serif';
        ctx.fillStyle = '#334155';
        ctx.fillText('PISO MOJADO', 128, 288);
        
        // Floor symbol
        ctx.fillStyle = '#dc2626';
        ctx.fillRect(40, 316, 176, 6);
    }
    cachedCautionSignTexture = new THREE.CanvasTexture(canvas);
    return cachedCautionSignTexture;
}

function createCautionSignGroup(width = 0.38, height = 0.62) {
    const signGroup = new THREE.Group();
    const signMat = new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.35, metalness: 0.1 });
    const tex = getCautionSignTexture();
    const decalMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });

    const thickness = 0.025;
    const halfH = height / 2;
    const tiltAngle = 0.22; // ~12.6 degrees tilt
    const zOffset = halfH * Math.sin(tiltAngle); // offset from center
    const yCenter = halfH * Math.cos(tiltAngle); // resting on floor

    // Front board: tilts inward at top (negative X rotation) so top meets at z=0 and bottom rests on floor at +zOffset*2
    const boardA = new THREE.Mesh(new THREE.BoxGeometry(width, height, thickness), signMat);
    boardA.position.set(0, yCenter, zOffset);
    boardA.rotation.x = -tiltAngle;

    // Front decal on outer face (+z)
    const decalA = new THREE.Mesh(new THREE.PlaneGeometry(width * 0.92, height * 0.92), decalMat);
    decalA.position.set(0, 0, thickness / 2 + 0.002);
    boardA.add(decalA);

    // Back board: tilts inward at top (positive X rotation) so top meets at z=0 and bottom rests on floor at -zOffset*2
    const boardB = new THREE.Mesh(new THREE.BoxGeometry(width, height, thickness), signMat);
    boardB.position.set(0, yCenter, -zOffset);
    boardB.rotation.x = tiltAngle;

    // Back decal on outer face (-z)
    const decalB = new THREE.Mesh(new THREE.PlaneGeometry(width * 0.92, height * 0.92), decalMat);
    decalB.position.set(0, 0, -thickness / 2 - 0.002);
    decalB.rotation.y = Math.PI;
    boardB.add(decalB);

    // Top hinge bar connecting the apex
    const hinge = new THREE.Mesh(
        new THREE.CylinderGeometry(0.015, 0.015, width * 0.95, 12),
        new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.4, metalness: 0.6 })
    );
    hinge.rotation.z = Math.PI / 2;
    hinge.position.set(0, height * Math.cos(tiltAngle) + 0.005, 0);

    // Top handle slot / cutout bar
    const handle = new THREE.Mesh(
        new THREE.BoxGeometry(width * 0.35, 0.03, 0.035),
        new THREE.MeshStandardMaterial({ color: 0xeab308, roughness: 0.3 })
    );
    handle.position.set(0, height * Math.cos(tiltAngle) + 0.025, 0);

    signGroup.add(boardA, boardB, hinge, handle);
    return signGroup;
}

function createProductSpillAt(x, z, itemName = 'Liquid') {
    const texture = getLoadedTexture('watercolor-abstract-background-free-png.png', true, 1, 1);
    const type = spillTypeFor(itemName) || { color: 0xb91c1c };
    const tintColor = type.color;
    const sticky = !!type.sticky;
    const spillMaterial = new THREE.MeshBasicMaterial({
        map: texture,
        color: tintColor,
        transparent: true,
        opacity: 0.88,
        depthWrite: false
    });
    const spillGeometry = new THREE.PlaneGeometry(4.5, 4.5);
    const spillMesh = new THREE.Mesh(spillGeometry, spillMaterial);
    spillMesh.position.set(x, 0.015, z);
    spillMesh.rotation.x = -Math.PI / 2;
    spillMesh.rotation.z = Math.random() * Math.PI * 2;
    scene.add(spillMesh);

    // Caution sign (right side up A-frame sign)
    const signGroup = createCautionSignGroup(0.35, 0.60);
    signGroup.position.set(x + 1.2, 0, z + 1.2);
    scene.add(signGroup);

    const spillShape = new CANNON.Box(new CANNON.Vec3(2.5, 0.2, 2.5));
    const spillBody = new CANNON.Body({
        mass: 0,
        shape: spillShape,
        isTrigger: true,
        position: new CANNON.Vec3(x, 0.1, z)
    });
    if (world) world.addBody(spillBody);

    const spillEntry = {
        mesh: spillMesh,
        sign: signGroup,
        body: spillBody,
        x,
        z,
        radius: 2.6,
        trackColor: tintColor,
        sticky
    };
    productSpills.push(spillEntry);
    productSpill = spillMesh;

    if (soundEffects && soundEffects.productSpill) {
        try {
            soundEffects.productSpill.currentTime = 0;
            soundEffects.productSpill.play().catch(() => {});
        } catch (_) {}
    }
    displayMessage(sticky
        ? `⚠️ The ${itemName} splattered everywhere! It's thick and sticky.`
        : `⚠️ The ${itemName} spilled on the floor! Watch your step!`, 3500, true);
}

function createGlassShardsAt(x, z, itemName = 'Glass item') {
    const shardGroup = new THREE.Group();
    const shardMat = new THREE.MeshStandardMaterial({
        color: 0x93c5fd,
        roughness: 0.1,
        metalness: 0.9,
        transparent: true,
        opacity: 0.85,
        depthWrite: false
    });

    // Create a cluster of scattered glass shard fragments on the floor
    for (let i = 0; i < 14; i++) {
        const shardGeo = new THREE.ConeGeometry((Math.random() * 0.06 + 0.03), (Math.random() * 0.14 + 0.06), 3);
        const shardMesh = new THREE.Mesh(shardGeo, shardMat);
        const angle = Math.random() * Math.PI * 2;
        const dist = Math.random() * 1.2;
        shardMesh.position.set(Math.cos(angle) * dist, 0.02, Math.sin(angle) * dist);
        shardMesh.rotation.set(Math.PI / 2 + (Math.random() - 0.5) * 0.3, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.3);
        shardMesh.scale.set(1, 1, 0.2);
        shardGroup.add(shardMesh);
    }
    shardGroup.position.set(x, 0.01, z);
    scene.add(shardGroup);

    const shardEntry = {
        mesh: shardGroup,
        x,
        z,
        radius: 2.2
    };
    glassShardsZones.push(shardEntry);

    // Play glass break / shatter sound
    try {
        if (soundEffects && soundEffects.glassBreak) {
            soundEffects.glassBreak.currentTime = 0;
            soundEffects.glassBreak.volume = Math.min(1.0, (CONFIG.SFX_VOLUME || 0.7) * 1.25);
            soundEffects.glassBreak.play().catch(() => {});
        } else if (soundEffects && soundEffects.shelfCrash) {
            soundEffects.shelfCrash.currentTime = 0;
            soundEffects.shelfCrash.play().catch(() => {});
        }
    } catch (_) {}

    displayMessage(`💥 The ${itemName} shattered into glass shards! Walking here will slow you down.`, 4000, true);
}

function triggerProductSpill() {
    if (!gameStarted || isCheckout || gameOver) return false;
    productSpillOccurred = true;

    // Load watercolor splatter texture
    const texture = getLoadedTexture('watercolor-abstract-background-free-png.png', true, 1, 1);
    const spillMaterial = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity: 0.88,
        depthWrite: false
    });
    const spillGeometry = new THREE.PlaneGeometry(7.5, 7.5);
    const spillMesh = new THREE.Mesh(spillGeometry, spillMaterial);

    // Pick location inside walkable store aisles
    const zone = pickZone();
    const x = zone ? (zone.x + (Math.random() - 0.5) * 4) : ((Math.random() - 0.5) * 28);
    const z = zone ? (zone.z + (Math.random() - 0.5) * 4) : ((Math.random() - 0.5) * 28);

    spillMesh.position.set(x, 0.015, z);
    spillMesh.rotation.x = -Math.PI / 2;
    spillMesh.rotation.z = Math.random() * Math.PI * 2;
    scene.add(spillMesh);

    // Folding yellow Caution Wet Floor cone/sign next to the puddle (right side up)
    const signGroup = createCautionSignGroup(0.40, 0.68);
    signGroup.position.set(x + 1.8, 0, z + 1.8);
    scene.add(signGroup);

    // Physics trigger body for collision / detection
    const spillShape = new CANNON.Box(new CANNON.Vec3(3.8, 0.2, 3.8));
    const spillBody = new CANNON.Body({
        mass: 0,
        shape: spillShape,
        isTrigger: true,
        position: new CANNON.Vec3(x, 0.1, z)
    });
    if (world) world.addBody(spillBody);

    const spillEntry = {
        mesh: spillMesh,
        sign: signGroup,
        body: spillBody,
        x,
        z,
        radius: 3.8,
        trackColor: 0xb91c1c
    };
    productSpills.push(spillEntry);
    productSpill = spillMesh;

    if (soundEffects && soundEffects.productSpill) {
        try {
            soundEffects.productSpill.currentTime = 0;
            soundEffects.productSpill.play().catch(() => {});
        } catch (_) {}
    }

    displayMessage("⚠️ Spill reported in aisle! Puddle will remain on the floor — watch your step!", 4500, true);
    return true;
}

function dropAllItems() {
    triggerTrip();
}

function createTwoInOneItem(x, y, z) {
    const starGroup = new THREE.Group();

    // 1. Build a solid 3D Star shape with beveled edges for true raycast hitbox and bounds
    const outerR = 0.20;
    const innerR = 0.085;
    const numPoints = 5;
    const starShape = new THREE.Shape();
    const step = Math.PI / numPoints;
    for (let i = 0; i < 2 * numPoints; i++) {
        const r = (i % 2 === 0) ? outerR : innerR;
        const angle = i * step - Math.PI / 2;
        const px = Math.cos(angle) * r;
        const py = Math.sin(angle) * r;
        if (i === 0) starShape.moveTo(px, py);
        else starShape.lineTo(px, py);
    }
    starShape.closePath();

    const extrudeSettings = {
        depth: 0.08,
        bevelEnabled: true,
        bevelSegments: 2,
        steps: 1,
        bevelSize: 0.02,
        bevelThickness: 0.02
    };
    const starGeometry = new THREE.ExtrudeGeometry(starShape, extrudeSettings);
    starGeometry.center(); // Center geometry around (0,0,0)

    const starMaterial = new THREE.MeshStandardMaterial({
        color: 0xfacc15,
        emissive: 0xeab308,
        emissiveIntensity: 0.45,
        roughness: 0.25,
        metalness: 0.8
    });
    const starMesh = new THREE.Mesh(starGeometry, starMaterial);
    starGroup.add(starMesh);

    // Subtle golden glow core
    const coreMat = new THREE.MeshBasicMaterial({
        color: 0xfef08a,
        transparent: true,
        opacity: 0.35,
        depthWrite: false
    });
    const coreMesh = new THREE.Mesh(new THREE.SphereGeometry(0.10, 12, 12), coreMat);
    starGroup.add(coreMesh);

    starGroup.position.set(x, y, z);
    scene.add(starGroup);

    // Accurate matching physics body
    const shape = new CANNON.Box(new CANNON.Vec3(0.20, 0.20, 0.08));
    const body = new CANNON.Body({
        mass: 1,
        shape: shape,
        position: new CANNON.Vec3(x, y, z)
    });
    body.type = CANNON.Body.STATIC;
    // Not added to the world while static (see createItem PERF note)

    const twoInOneItem = {
        name: "2 in 1 Item",
        mesh: starGroup,
        body: body,
        size: [0.40, 0.40, 0.16],
        isOnSale: false,
        inCart: false,
        isCollected: false,
        isTwoInOne: true,
        initialPosition: { x, y, z },
        twoInOneTargets: null,
        twoInOneApplied: false,
        update: function(time) {
            // Only spin and bob when free in store, NOT when held in hand or in cart
            if (this.mesh && !this.inCart && heldItem !== this) {
                this.mesh.rotation.y = time * 1.5;
                this.mesh.position.y = this.initialPosition.y + Math.sin(time * 2.5) * 0.06;
                if (this.body) {
                    this.body.position.set(this.mesh.position.x, this.mesh.position.y, this.mesh.position.z);
                }
            }
        }
    };

    allItems.push(twoInOneItem);
    return twoInOneItem;
}

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

function ensureTwoInOneItemExists() {
    // Check if a 2-in-1 item already exists
    const twoInOneExists = allItems.some(item => item.isTwoInOne);
    
    if (!twoInOneExists) {
        // Find a random non-empty shelf to place the 2-in-1 item on
        const candidateShelves = shelves.filter(s => !s.userData?.isEmptyShelf);
        const pool = candidateShelves.length > 0 ? candidateShelves : shelves;
        if (pool.length > 0) {
            const randomShelf = pool[Math.floor(Math.random() * pool.length)];
            const shelfPos = new THREE.Vector3();
            randomShelf.getWorldPosition(shelfPos);
            
            // Add a small offset above the shelf
            shelfPos.y += 0.3;
            
            // Add random offset on the x and z
            shelfPos.x += (Math.random() - 0.5) * 2;
            shelfPos.z += (Math.random() - 0.5) * 0.5;
            
            createTwoInOneItem(shelfPos.x, shelfPos.y, shelfPos.z);
        }
    }
}

function hardStopGame() {
    stopRunTrack();
    Nuke.resetNuke();
    nukeContext = null;
    document.getElementById('game-container')?.classList.remove('nuke-aftermath');
    clearGlassesBlur();
    gameStarted = false;
    clearTweakerAndMoney();
    endCustomerScuffle(true);
    gamePaused = false;
    isCheckout = false;
    gameOver = false;
    introCutsceneActive = false;
    hideIntroCutsceneUI();
    // Stop all audio immediately
    stopAllAudio();
    // Clear any pending timers/intervals globally
    try {
        // Clear timeouts
        const highestTimeoutId = setTimeout(() => {}, 0);
        for (let i = 0; i <= highestTimeoutId; i++) clearTimeout(i);
        // Clear intervals
        const highestIntervalId = setInterval(() => {}, 0);
        for (let i = 0; i <= highestIntervalId; i++) clearInterval(i);
    } catch (_) {}

    // Ensure timer state is reset so restarts don't resume old elapsed time
    gameTime = 0;
    stoppedRunElapsed = null;

    // NEW: Full session cleanup to guarantee clean slate
    cleanupSessionResources();

    // NEW: Unlock pointer and detach input handlers so UI clicks work on menu
    try { controls?.unlock(); } catch (_) {}
    detachAllEventHandlers();
    eventsInitialized = false;

    // NEW: Cancel animation loop to avoid stale rendering/input capture
    if (animationFrameId) {
        try { cancelAnimationFrame(animationFrameId); } catch (_) {}
        animationFrameId = null;
        animationStarted = false;
    }

    // NEW: clear spill trip intervals immediately
    stopSpillTripCheckForPlayer();
    customerSpillTripIntervals.forEach((id, cust) => { try { clearInterval(id); } catch(_) {} });
    customerSpillTripIntervals.clear();

    try { if (timer) { clearInterval(timer); } } catch(_) {}
    // ... existing code ...
}

function showMainMenu() {
    mainMenuVisible = true;
    hardStopGame();
    // Make sure fail music is not playing on menu
    stopFailMusic();
    // Show splash/menu, hide gameplay overlays
    mainMenuElement.classList.remove('hidden');
    document.getElementById('game-container').classList.add('menu-active');
    menuBg.style.display = 'block';
    document.getElementById('open-shop').classList.remove('hidden');
    document.getElementById('open-achievements').classList.remove('hidden');
    setSeedCheckMenuVisible(true);

    // Ensure singleton menu music exists and play without re-instantiating
    initMenuMusicSingleton();
    const playMenuMusic = () => {
        if (!mainMenuVisible) return;
        pauseOtherMusic(menuMusic);
        if (menuMusic.paused) safePlayExt(menuMusic);
    };
    if (menuMusic.paused) {
        pauseOtherMusic(menuMusic);
        safePlayExt(menuMusic);
    }

    // Ensure autoplay after first interaction if blocked
    const ensureMenuMusic = playMenuMusic;
    // Save handlers so we can remove later when leaving the menu
    menuAutoplayHandlers.forEach(h => {
        try { document.removeEventListener(h.type, h.fn); } catch(_) {}
    });
    menuAutoplayHandlers = [
        { type: 'click', fn: ensureMenuMusic },
        { type: 'touchstart', fn: ensureMenuMusic },
        { type: 'keydown', fn: ensureMenuMusic },
    ];
    document.addEventListener('click', ensureMenuMusic, { once: true });
    document.addEventListener('touchstart', ensureMenuMusic, { once: true });
    document.addEventListener('keydown', ensureMenuMusic, { once: true });

    // Wire main menu buttons
    // Ensure listeners added once by replacing instead of adding new each time
    // Timestamp debounce (hardStopGame() clears every setTimeout on the page,
    // so a timer-based reset could leave Play permanently blocked).
    let lastPlayAt = 0;
    const onPlay = (e) => {
        if (e) { e.preventDefault?.(); e.stopPropagation?.(); }
        const t = performance.now();
        if (t - lastPlayAt < 1200 || !mainMenuVisible) return;
        lastPlayAt = t;
        // iPhone/iPad (and any device whose last boot crashed): show the
        // help sheet once per session; its button starts the game from a fresh tap.
        if ((IS_IOS && !iosHelpShown) || lastBootCrashed) {
            iosHelpShown = true;
            const mode = lastBootCrashed ? 'crashed' : 'start';
            lastBootCrashed = false;
            showIosHelp({ mode, onStart: () => { if (mainMenuVisible) startNormalGame(); } });
            return;
        }
        startNormalGame();
    };
    const playBtn = document.getElementById('start-game');
    playBtn.onclick = onPlay;
    // Some mobile browsers swallow the synthetic click (e.g. under an overlay
    // or after a scroll gesture); start directly from the touch as well.
    playBtn.ontouchend = onPlay;

    document.getElementById('customize-game').onclick = () => {
        const menu = document.getElementById('customization-menu');
        if (menu.style.display === 'block') { hideCustomizationMenu(); }
        else { showCustomizationMenu(); }
    };
    const openLbBtn = document.getElementById('open-leaderboard');
    if (openLbBtn) {
        openLbBtn.onclick = () => {
            showLeaderboardMenu();
        };
    }
    document.getElementById('open-settings').onclick = () => {
        const sm = document.getElementById('settings-menu');
        sm.style.display = 'block';
        populateSettingsMenu();
    };

    const closeLbBtn = document.getElementById('leaderboard-close-btn');
    if (closeLbBtn) closeLbBtn.onclick = hideLeaderboardMenu;
    const refreshLbBtn = document.getElementById('leaderboard-refresh-btn');
    if (refreshLbBtn) refreshLbBtn.onclick = pollLeaderboard;

    // Start background live 5s database leaderboard sync
    startLeaderboardPolling();

    // Update mute icon to reflect current state
    updateMuteButtonIcon();
    // Bind mute toggle
    muteBtn.onclick = () => setMusicMuted(!musicMuted);
}

function updateMuteButtonIcon() {
    if (!muteBtn) return;
    muteBtn.textContent = musicMuted ? '🔇' : '🔊';
    muteBtn.title = musicMuted ? 'Unmute music' : 'Mute music';
}

function hideMainMenu() {
    mainMenuElement.classList.add('hidden');
    document.getElementById('open-shop').classList.add('hidden');
    document.getElementById('shop-menu').classList.add('hidden');
    document.getElementById('open-achievements').classList.add('hidden');
    document.getElementById('achievements-menu').classList.add('hidden');
    setSeedCheckMenuVisible(false);
    document.getElementById('game-container').classList.remove('menu-active');
    menuBg.style.display = 'none';
    mainMenuVisible = false;
    // Stop menu music and remove any autoplay listeners to prevent it from resuming during gameplay
    try { if (menuMusic) { menuMusic.pause(); menuMusic.currentTime = 0; } } catch(e) {}
    menuAutoplayHandlers.forEach(h => {
        try { document.removeEventListener(h.type, h.fn); } catch(_) {}
    });
    menuAutoplayHandlers = [];
}

let iosHelpShown = false;
// Any start-up failure used to leave the loading screen up forever with no
// explanation. Catch it, go back to the menu, and tell the player.
async function startNewGame() {
    try {
        await startNewGameInner();
    } catch (err) {
        console.error('[start] failed to open the store', err);
        markBootPending(false);
        try { localStorage.setItem('ss_lite_level', '2'); } catch (_) {}
        try { hideLoadingScreen(); } catch (_) {}
        try { showMainMenu(); } catch (_) {}
        showIosHelp({
            mode: 'error',
            error: String(err && (err.message || err) || ''),
            onStart: () => { if (mainMenuVisible) startNormalGame(); },
        });
    }
}

async function startNewGameInner() {
    // 1. Show loading screen immediately so player never sees an unready or popping level
    showLoadingScreen('Stocking the Shelves...');
    markBootPending(true);

    // Ensure consistent mechanics state at boot
    resetAllMechanicsState();
    // Seal this run's ruleset into its seed before anything can roll events.
    currentRunSeed = createRunSeed(CONFIG, isCustomGame);
    // Choose which batch of items this game will use (50/50 base vs alternate)
    chooseItemBatch();

    // If a previous renderer exists, remove its canvas
    if (renderer && renderer.domElement && renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
    }
    // Free the old GPU context: iOS allows only a handful and they count
    // against the tab's memory cap.
    if (renderer) {
        try { renderer.dispose(); renderer.forceContextLoss(); } catch (_) {}
        renderer = null;
    }
    // Extra safety: ensure menu music is stopped before booting gameplay
    stopMenuMusic();
    // Also ensure fail music is stopped when starting a fresh game
    stopFailMusic();

    // Make sure previous handlers are detached and flags reset so setupEvents runs
    detachAllEventHandlers();
    eventsInitialized = false;

    // Initialize core systems fresh
    setupScene();
    setupPhysics();
    loadSounds();

    // 2. Accurately stream all PBR textures (Roof, Walls, Floor, Skybox) before revealing
    setRandomLoadingHint('Streaming PBR textures...');
    await preloadAllGameAssets((progress) => {
        const hintEl = document.getElementById('loading-hint');
        if (hintEl && progress < 1) {
            hintEl.textContent = `Streaming textures (${Math.round(progress * 100)}%)...`;
        }
    });

    // Reset per-game Falling Shelf trigger
    fallingShelfTriggered = false;
    fallingShelfAnim = null;

    // Roll whole-run Lonely Store modifier (unless forced vanilla after crash)
    if (forceNextGameVanilla) {
        isLonelyStoreMode = false;
        forceNextGameVanilla = false;
    } else {
        isLonelyStoreMode = Math.random() * 100 < (CONFIG.LONELY_STORE_CHANCE ?? 1);
    }
    if (isLonelyStoreMode) unlockAchievement('lonely');

    // 3. Generate shopping list and build environment
    setRandomLoadingHint('Building store layout & stocking aisles...');
    generateShoppingList();
    const layouts = [
        createEnvironment,
        createLayout2,
        createLayout3,
        createLayout4,
        createLayout5
    ];
    const chosenLayout = layouts[Math.floor(Math.random() * layouts.length)];
    chosenLayout();

    createPlayer();
    setupEvents();

    // Add customers and store worker (only if not in Lonely Store mode)
    if (!isLonelyStoreMode) {
        for (let i = 0; i < 12; i++) {
            createCustomer();
        }
        createStoreWorker();
    }

    SQ.setupSideQuestsRun({ enabled: !isLonelyStoreMode, carSpots: playerCarSpots });

    updateScoreboard();

    // Create RNG notifications element if not present
    if (!rngNotificationsElement) {
        rngNotificationsElement = document.createElement('div');
        rngNotificationsElement.id = 'rng-notifications';
        document.getElementById('game-container').appendChild(rngNotificationsElement);
    }

    // Reset money chance per game (exactly the configured percentage)
    noMoneyForGroceries = Math.random() * 100 < CONFIG.NO_MONEY_CHANCE;

    // 4. Pre-compile shaders and do a warm-up render behind loading screen
    if (renderer && scene && camera) {
        try {
            renderer.compile(scene, camera);
            renderer.render(scene, camera);
        } catch(_) {}
    }

    // Start animation loop once
    if (!animationStarted) {
        animationStarted = true;
        animate();
    }

    // Roll powerup for this game before starting gameplay
    rollPowerup();

    // Small delay to ensure rendering pipeline is completely stable before revealing
    await new Promise(resolve => setTimeout(resolve, 150));

    // 5. Hide loading screen smoothly
    hideLoadingScreen();

    startGame();
}

function setAllEventsToZero() {
    const eventSliderIds = [
        'power-outage', 'forgot-glasses', 'slippery-floor', 'store-closing', 'thief-chance',
        'two-in-one', 'single-item-list', 'empty-shelf',
        'trip-chance', 'accidental-drop', 'customer-question', 'customer-theft-chance',
        'no-money', 'out-of-stock-chance', 'cart-stuck-chance', 'product-spill', 'checkout-button',
        'item-add-chance', 'item-remove-chance', 'baby-crying-chance', 'baby-in-cart-chance', 'checkout-busy',
        'gum-craving-chance', 'powerup-chance', 'falling-shelf-chance', 'mislabeled-chance', 'weight-change-chance',
        'under-construction-chance', 'manager-jumpscare', 'wife-call-chance',
        'earthquake-chance', 'nuclear-fallout-chance', 'thermostat-chance', 'customer-scuffle-chance', 'tweaker-chance', 'lonely-store-chance', 'shelf-replace-chance',
        'spare-change-chance', 'change-given-chance', 'more-samples-chance', 'car-trouble-chance'
    ];
    eventSliderIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.value = 0;
            const display = el.parentElement ? el.parentElement.querySelector('.value-display') : null;
            if (display) display.textContent = '0';
        }
    });
}

const SIDE_QUEST_SLIDERS = [
    ['return-item-count', 'RETURN_ITEM_COUNT', 2, '1–3'],
    ['restroom-duration', 'RESTROOM_DURATION', 9, '4–14'],
    ['restroom-targets', 'RESTROOM_TARGETS', 4, '3–6']
];
const SIDE_QUEST_CHANCES = [
    ['spare-change-chance', 'SPARE_CHANGE_CHANCE'],
    ['change-given-chance', 'CHANGE_GIVEN_CHANCE'],
    ['more-samples-chance', 'MORE_SAMPLES_CHANCE'],
    ['car-trouble-chance', 'CAR_TROUBLE_CHANCE']
];
function resetSideQuestConfig() {
    for (const [, key] of [...SIDE_QUEST_SLIDERS, ...SIDE_QUEST_CHANCES]) CONFIG[key] = PROB_DEFAULTS[key];
}
function selectCustomizationTab(id) {
    document.querySelectorAll('#customization-menu [data-custom-tab]').forEach(button => {
        const active = button.dataset.customTab === id;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('#customization-menu .custom-tab-pane').forEach(pane => {
        pane.classList.toggle('active', pane.id === id);
    });
}

function showCustomizationMenu() {
    const menu = document.getElementById('customization-menu');
    if (menu.style.display === 'block') { // toggle close if already open
        hideCustomizationMenu();
        return;
    }
    menu.style.display = 'block';
    selectCustomizationTab('custom-main');
    menu.querySelectorAll('[data-custom-tab]').forEach(button => {
        button.onclick = () => selectCustomizationTab(button.dataset.customTab);
    });

    // Populate all customization sliders with current defaults
    applyConfigToCustomizationSliders();

    // Update all value displays
    document.querySelectorAll('.slider-container input[type="range"]').forEach(slider => {
        const display = slider.parentElement ? slider.parentElement.querySelector('.value-display') : null;
        if (display) display.textContent = slider.value;
        
        slider.oninput = (e) => {
            if (display) display.textContent = e.target.value;
        };
    });
    document.querySelectorAll('.random-vanilla-btn').forEach(button => {
        button.onclick = () => {
            const setting = SIDE_QUEST_SLIDERS.find(([id]) => id === button.dataset.for);
            if (setting) {
                const slider = document.getElementById(setting[0]);
                CONFIG[setting[1]] = CONFIG[setting[1]] == null ? Number(slider.value) : null;
            } else {
                const configKey = button.dataset.for === 'shelf-count' ? 'CUSTOM_RANDOM_SHELVES' : 'CUSTOM_RANDOM_ITEMS';
                CONFIG[configKey] = !CONFIG[configKey];
            }
            syncRandomVanillaButtons();
        };
    });
    syncRandomVanillaButtons();

    // Wire live RNG event keyword search bar
    const searchInput = document.getElementById('customization-search');
    if (searchInput) {
        searchInput.value = '';
        const filterEvents = () => {
            const query = (searchInput.value || '').toLowerCase().trim();
            const containers = document.querySelectorAll('#customization-menu .slider-container');
            containers.forEach(c => {
                const text = c.textContent.toLowerCase();
                const eventAttr = (c.getAttribute('data-event-name') || '').toLowerCase();
                const matches = !query || text.includes(query) || eventAttr.includes(query);
                c.style.display = matches ? '' : 'none';
            });
            // Show/hide sections based on child visibility
            document.querySelectorAll('#customization-menu .customization-section').forEach(sec => {
                const visibleSliders = sec.querySelectorAll('.slider-container:not([style*="display: none"])');
                sec.style.display = visibleSliders.length > 0 ? '' : 'none';
            });
            if (query) {
                const active = menu.querySelector('.custom-tab-pane.active');
                if (!active?.querySelector('.slider-container:not([style*="display: none"])')) {
                    const match = [...menu.querySelectorAll('.custom-tab-pane')].find(pane =>
                        pane.querySelector('.slider-container:not([style*="display: none"])'));
                    if (match) selectCustomizationTab(match.id);
                }
            }
        };
        searchInput.oninput = filterEvents;
        filterEvents();
    }

    // Bind buttons without accumulating duplicates
    const btnZero = document.getElementById('zero-all-events');
    const btnReset = document.getElementById('reset-defaults');
    const btnSave = document.getElementById('save-customization');
    const btnBack = document.getElementById('back-to-menu');
    if (btnZero) btnZero.onclick = setAllEventsToZero;
    if (btnReset) btnReset.onclick = resetToDefaults;
    if (btnSave) btnSave.onclick = saveAndStartCustomGame;
    if (btnBack) btnBack.onclick = () => { hideCustomizationMenu(); };
}

function hideCustomizationMenu() {
    document.getElementById('customization-menu').style.display = 'none';
}

function resetToDefaults() {
    // Restore defaults from config modules
    CONFIG.SHELF_COUNT = DEFAULT_GAME_SETTINGS.SHELF_COUNT;
    CONFIG.MIN_SHOPPING_LIST_ITEMS = DEFAULT_GAME_SETTINGS.MIN_SHOPPING_LIST_ITEMS;
    CONFIG.MAX_SHOPPING_LIST_ITEMS = DEFAULT_GAME_SETTINGS.MAX_SHOPPING_LIST_ITEMS;
    CONFIG.CUSTOM_RANDOM_SHELVES = false;
    CONFIG.CUSTOM_RANDOM_ITEMS = false;

    CONFIG.POWER_OUTAGE_CHANCE = PROB_DEFAULTS.POWER_OUTAGE_CHANCE;
    CONFIG.FORGOT_GLASSES_CHANCE = PROB_DEFAULTS.FORGOT_GLASSES_CHANCE;
    CONFIG.SLIPPERY_FLOOR_CHANCE = PROB_DEFAULTS.SLIPPERY_FLOOR_CHANCE;
    CONFIG.STORE_CLOSING_CHANCE = PROB_DEFAULTS.STORE_CLOSING_CHANCE;
    CONFIG.THIEF_BREAK_IN_CHANCE = PROB_DEFAULTS.THIEF_BREAK_IN_CHANCE;
    CONFIG.TWO_IN_ONE_ITEM_CHANCE = PROB_DEFAULTS.TWO_IN_ONE_ITEM_CHANCE;
    CONFIG.EMPTY_SHELF_CHANCE = PROB_DEFAULTS.EMPTY_SHELF_CHANCE;
    CONFIG.TRIPPING_CHANCE = PROB_DEFAULTS.TRIPPING_CHANCE;
    CONFIG.DROP_ITEM_CHANCE = PROB_DEFAULTS.DROP_ITEM_CHANCE;
    CONFIG.CUSTOMER_THEFT_CHANCE = PROB_DEFAULTS.CUSTOMER_THEFT_CHANCE;
    CONFIG.NO_MONEY_CHANCE = PROB_DEFAULTS.NO_MONEY_CHANCE;
    CONFIG.OUT_OF_STOCK_CHANCE = PROB_DEFAULTS.OUT_OF_STOCK_CHANCE;
    CONFIG.PRODUCT_SPILL_CHANCE = PROB_DEFAULTS.PRODUCT_SPILL_CHANCE;
    CONFIG.CHECKOUT_BUTTON_REQUIRED_CHANCE = PROB_DEFAULTS.CHECKOUT_BUTTON_REQUIRED_CHANCE;
    CONFIG.ADD_ITEM_CHANCE = PROB_DEFAULTS.ADD_ITEM_CHANCE;
    CONFIG.REMOVE_ITEM_CHANCE = PROB_DEFAULTS.REMOVE_ITEM_CHANCE;
    CONFIG.BABY_CRYING_CHANCE = PROB_DEFAULTS.BABY_CRYING_CHANCE;
    CONFIG.BABY_IN_CART_CHANCE = PROB_DEFAULTS.BABY_IN_CART_CHANCE ?? 7;
    CONFIG.CHECKOUT_BUSY_CHANCE = PROB_DEFAULTS.CHECKOUT_BUSY_CHANCE;
    CONFIG.GUM_CRAVING_CHANCE = PROB_DEFAULTS.GUM_CRAVING_CHANCE ?? 35;
    CONFIG.POWERUP_CHANCE = PROB_DEFAULTS.POWERUP_CHANCE;
    CONFIG.MISLABELED_ITEM_CHANCE = PROB_DEFAULTS.MISLABELED_ITEM_CHANCE;
    CONFIG.WEIGHT_CHANGE_CHANCE = PROB_DEFAULTS.WEIGHT_CHANGE_CHANCE;
    CONFIG.CUSTOMER_QUESTION_CHANCE = PROB_DEFAULTS.CUSTOMER_QUESTION_CHANCE;
    // NEW: Under construction default
    CONFIG.UNDER_CONSTRUCTION_CHANCE = PROB_DEFAULTS.UNDER_CONSTRUCTION_CHANCE;
    // NEW: Manager jumpscare default
    CONFIG.MANAGER_JUMPSCARE_CHANCE = PROB_DEFAULTS.MANAGER_JUMPSCARE_CHANCE;
    // NEW: Wife call default
    CONFIG.WIFE_CALL_CHANCE = PROB_DEFAULTS.WIFE_CALL_CHANCE;
    // NEW: Earthquake default
    CONFIG.EARTHQUAKE_CHANCE = PROB_DEFAULTS.EARTHQUAKE_CHANCE;
    CONFIG.NUCLEAR_FALLOUT_CHANCE = PROB_DEFAULTS.NUCLEAR_FALLOUT_CHANCE;
    CONFIG.THERMOSTAT_CHANCE = PROB_DEFAULTS.THERMOSTAT_CHANCE;
    CONFIG.CUSTOMER_SCUFFLE_CHANCE = PROB_DEFAULTS.CUSTOMER_SCUFFLE_CHANCE;
    CONFIG.TWEAKER_CHANCE = PROB_DEFAULTS.TWEAKER_CHANCE;
    // NEW: Lonely store default
    CONFIG.LONELY_STORE_CHANCE = PROB_DEFAULTS.LONELY_STORE_CHANCE;
    // NEW: Shelf replacement default
    CONFIG.SHELF_REPLACE_CHANCE = PROB_DEFAULTS.SHELF_REPLACE_CHANCE ?? 4;

    // NEW: Falling Shelf defaults
    CONFIG.FALLING_SHELF_ENABLED = PROB_DEFAULTS.FALLING_SHELF_ENABLED;
    CONFIG.FALLING_SHELF_CHANCE = PROB_DEFAULTS.FALLING_SHELF_CHANCE;
    resetSideQuestConfig();

    isCustomGame = false;
    // Refresh sliders without closing the customization menu
    applyConfigToCustomizationSliders();
    // Explicitly keep the customization menu open
    const menu = document.getElementById('customization-menu');
    if (menu) menu.style.display = 'block';
    persistUserSettings();
}

function applyConfigToCustomizationSliders() {
    const sliderValues = [
        ['shelf-count', CONFIG.SHELF_COUNT],
        ['item-count', CONFIG.MAX_SHOPPING_LIST_ITEMS],
        ['power-outage', CONFIG.POWER_OUTAGE_CHANCE],
        ['forgot-glasses', CONFIG.FORGOT_GLASSES_CHANCE],
        ['slippery-floor', CONFIG.SLIPPERY_FLOOR_CHANCE],
        ['store-closing', CONFIG.STORE_CLOSING_CHANCE],
        ['thief-chance', CONFIG.THIEF_BREAK_IN_CHANCE],
        ['two-in-one', CONFIG.TWO_IN_ONE_ITEM_CHANCE],
        ['single-item-list', CONFIG.SINGLE_ITEM_LIST_CHANCE],
        ['mislabeled-chance', CONFIG.MISLABELED_ITEM_CHANCE * 100],
        ['weight-change-chance', CONFIG.WEIGHT_CHANGE_CHANCE * 100],
        ['empty-shelf', CONFIG.EMPTY_SHELF_CHANCE],
        ['trip-chance', CONFIG.TRIPPING_CHANCE],
        ['accidental-drop', CONFIG.DROP_ITEM_CHANCE],
        ['customer-question', CONFIG.CUSTOMER_QUESTION_CHANCE],
        ['customer-theft-chance', CONFIG.CUSTOMER_THEFT_CHANCE],
        ['no-money', CONFIG.NO_MONEY_CHANCE],
        ['out-of-stock-chance', CONFIG.OUT_OF_STOCK_CHANCE],
        ['cart-stuck-chance', CONFIG.CART_STUCK_CHANCE],
        ['product-spill', CONFIG.PRODUCT_SPILL_CHANCE],
        ['checkout-button', (CONFIG.CHECKOUT_BUTTON_REQUIRED_CHANCE * 100)],
        ['baby-crying-chance', CONFIG.BABY_CRYING_CHANCE],
        ['baby-in-cart-chance', CONFIG.BABY_IN_CART_CHANCE ?? 7],
        ['item-add-chance', CONFIG.ADD_ITEM_CHANCE],
        ['item-remove-chance', CONFIG.REMOVE_ITEM_CHANCE],
        ['checkout-busy', CONFIG.CHECKOUT_BUSY_CHANCE],
        ['gum-craving-chance', CONFIG.GUM_CRAVING_CHANCE ?? 35],
        ['powerup-chance', CONFIG.POWERUP_CHANCE],
        // NEW
        ['falling-shelf-chance', CONFIG.FALLING_SHELF_CHANCE],
        ['under-construction-chance', CONFIG.UNDER_CONSTRUCTION_CHANCE],
        ['manager-jumpscare', CONFIG.MANAGER_JUMPSCARE_CHANCE],
        ['wife-call-chance', CONFIG.WIFE_CALL_CHANCE],
        ['earthquake-chance', CONFIG.EARTHQUAKE_CHANCE],
        ['nuclear-fallout-chance', CONFIG.NUCLEAR_FALLOUT_CHANCE],
        ['thermostat-chance', CONFIG.THERMOSTAT_CHANCE],
        ['customer-scuffle-chance', CONFIG.CUSTOMER_SCUFFLE_CHANCE],
        ['tweaker-chance', CONFIG.TWEAKER_CHANCE],
        ['lonely-store-chance', CONFIG.LONELY_STORE_CHANCE],
        ['shelf-replace-chance', CONFIG.SHELF_REPLACE_CHANCE],
    ];
    sliderValues.forEach(([id, val]) => {
        const el = document.getElementById(id);
        if (el && Number.isFinite(val)) el.value = val;
    });
    for (const [id, key, fallback] of SIDE_QUEST_SLIDERS) {
        document.getElementById(id).value = CONFIG[key] ?? fallback;
    }
    for (const [id, key] of SIDE_QUEST_CHANCES) {
        document.getElementById(id).value = CONFIG[key];
    }
    document.querySelectorAll('.slider-container input[type="range"]').forEach(slider => {
        const display = slider.parentElement.querySelector('.value-display');
        if (display) display.textContent = slider.value;
    });
    syncRandomVanillaButtons();
}

function syncRandomVanillaButtons() {
    for (const [id, key, range] of [
        ['shelf-count', 'CUSTOM_RANDOM_SHELVES', '5–14'],
        ['item-count', 'CUSTOM_RANDOM_ITEMS', '8–10']
    ]) {
        const button = document.querySelector(`.random-vanilla-btn[data-for="${id}"]`);
        const slider = document.getElementById(id);
        if (!button || !slider) continue;
        const active = !!CONFIG[key];
        button.setAttribute('aria-pressed', String(active));
        slider.disabled = active;
        const display = slider.parentElement.querySelector('.value-display');
        if (display) display.textContent = active ? `Random ${range}` : slider.value;
    }
    for (const [id, key, , range] of SIDE_QUEST_SLIDERS) {
        const button = document.querySelector(`.random-vanilla-btn[data-for="${id}"]`);
        const slider = document.getElementById(id);
        const random = CONFIG[key] == null;
        button.setAttribute('aria-pressed', String(random));
        slider.disabled = random;
        slider.parentElement.querySelector('.value-display').textContent = random ? `Random ${range}` : slider.value;
    }
}

function saveAndStartCustomGame() {
    // Hard-stop any running game to avoid controls/movement conflicts
    hardStopGame();

    // Ensure mechanics state is clean before building custom game
    resetAllMechanicsState();
    // Even in custom games, randomly choose which item batch is active for this run
    chooseItemBatch();

    // Save all customized values
    const parsedShelf = parseInt(document.getElementById('shelf-count').value);
    const parsedItems = parseInt(document.getElementById('item-count').value);
    CONFIG.SHELF_COUNT = Number.isFinite(parsedShelf) ? parsedShelf : 8;
    CONFIG.MIN_SHOPPING_LIST_ITEMS = CONFIG.CUSTOM_RANDOM_ITEMS ? 8 : (Number.isFinite(parsedItems) ? parsedItems : 8);
    CONFIG.MAX_SHOPPING_LIST_ITEMS = CONFIG.CUSTOM_RANDOM_ITEMS ? 10 : (Number.isFinite(parsedItems) ? parsedItems : 8);
    CONFIG.POWER_OUTAGE_CHANCE = parseFloat(document.getElementById('power-outage').value);
    CONFIG.FORGOT_GLASSES_CHANCE = parseFloat(document.getElementById('forgot-glasses').value);
    CONFIG.SLIPPERY_FLOOR_CHANCE = parseFloat(document.getElementById('slippery-floor').value);
    CONFIG.STORE_CLOSING_CHANCE = parseFloat(document.getElementById('store-closing').value);
    CONFIG.THIEF_BREAK_IN_CHANCE = parseFloat(document.getElementById('thief-chance').value);
    CONFIG.TWO_IN_ONE_ITEM_CHANCE = parseFloat(document.getElementById('two-in-one').value);
    CONFIG.SINGLE_ITEM_LIST_CHANCE = parseFloat(document.getElementById('single-item-list').value);
    CONFIG.EMPTY_SHELF_CHANCE = parseFloat(document.getElementById('empty-shelf').value);
    CONFIG.TRIPPING_CHANCE = parseFloat(document.getElementById('trip-chance').value);
    CONFIG.DROP_ITEM_CHANCE = parseFloat(document.getElementById('accidental-drop').value);
    CONFIG.CUSTOMER_QUESTION_CHANCE = parseFloat(document.getElementById('customer-question').value);
    CONFIG.CUSTOMER_THEFT_CHANCE = parseFloat(document.getElementById('customer-theft-chance').value);
    CONFIG.NO_MONEY_CHANCE = parseFloat(document.getElementById('no-money').value);
    const customOos = document.getElementById('out-of-stock-chance');
    if (customOos) CONFIG.OUT_OF_STOCK_CHANCE = parseFloat(customOos.value);
    const customCartStuck = document.getElementById('cart-stuck-chance');
    if (customCartStuck) CONFIG.CART_STUCK_CHANCE = parseFloat(customCartStuck.value);
    CONFIG.PRODUCT_SPILL_CHANCE = parseFloat(document.getElementById('product-spill').value);
    CONFIG.CHECKOUT_BUTTON_REQUIRED_CHANCE = parseFloat(document.getElementById('checkout-button').value) / 100;
    const customAdd = document.getElementById('item-add-chance');
    if (customAdd) CONFIG.ADD_ITEM_CHANCE = parseFloat(customAdd.value);
    const customRemove = document.getElementById('item-remove-chance');
    if (customRemove) CONFIG.REMOVE_ITEM_CHANCE = parseFloat(customRemove.value);
    CONFIG.BABY_CRYING_CHANCE = parseFloat(document.getElementById('baby-crying-chance').value);
    const customBabyCart = document.getElementById('baby-in-cart-chance');
    if (customBabyCart) CONFIG.BABY_IN_CART_CHANCE = parseFloat(customBabyCart.value);
    CONFIG.CHECKOUT_BUSY_CHANCE = parseFloat(document.getElementById('checkout-busy').value);
    const customGum = document.getElementById('gum-craving-chance');
    if (customGum) CONFIG.GUM_CRAVING_CHANCE = parseFloat(customGum.value);
    CONFIG.POWERUP_CHANCE = parseFloat(document.getElementById('powerup-chance').value);
    CONFIG.MISLABELED_ITEM_CHANCE = parseFloat(document.getElementById('mislabeled-chance').value) / 100;
    const weightEl = document.getElementById('weight-change-chance');
    if (weightEl) CONFIG.WEIGHT_CHANGE_CHANCE = parseFloat(weightEl.value) / 100;

    // NEW: Under construction customization
    CONFIG.UNDER_CONSTRUCTION_CHANCE = parseFloat(document.getElementById('under-construction-chance').value);

    // NEW: Manager jumpscare customization
    CONFIG.MANAGER_JUMPSCARE_CHANCE = parseFloat(document.getElementById('manager-jumpscare').value);

    // NEW: Wife call customization
    const customWifeCall = document.getElementById('wife-call-chance');
    if (customWifeCall) CONFIG.WIFE_CALL_CHANCE = parseFloat(customWifeCall.value);

    // NEW: Earthquake customization
    const customEarthquake = document.getElementById('earthquake-chance');
    if (customEarthquake) CONFIG.EARTHQUAKE_CHANCE = parseFloat(customEarthquake.value);
    const customNuclearFallout = document.getElementById('nuclear-fallout-chance');
    if (customNuclearFallout) CONFIG.NUCLEAR_FALLOUT_CHANCE = parseFloat(customNuclearFallout.value);
    const customThermostat = document.getElementById('thermostat-chance');
    if (customThermostat) CONFIG.THERMOSTAT_CHANCE = parseFloat(customThermostat.value);
    CONFIG.CUSTOMER_SCUFFLE_CHANCE = parseFloat(document.getElementById('customer-scuffle-chance').value);
    CONFIG.TWEAKER_CHANCE = parseFloat(document.getElementById('tweaker-chance').value);

    // NEW: Lonely store customization
    const customLonely = document.getElementById('lonely-store-chance');
    if (customLonely) CONFIG.LONELY_STORE_CHANCE = parseFloat(customLonely.value);

    // NEW: Shelf replacement customization
    const customShelfReplace = document.getElementById('shelf-replace-chance');
    if (customShelfReplace) CONFIG.SHELF_REPLACE_CHANCE = parseFloat(customShelfReplace.value);

    // NEW: Falling Shelf customization (no checkbox; enabled if chance > 0)
    CONFIG.FALLING_SHELF_CHANCE = parseFloat(document.getElementById('falling-shelf-chance').value);
    CONFIG.FALLING_SHELF_ENABLED = (CONFIG.FALLING_SHELF_CHANCE ?? 0) > 0;
    for (const [id, key] of SIDE_QUEST_SLIDERS) {
        if (CONFIG[key] != null) CONFIG[key] = Number(document.getElementById(id).value);
    }
    for (const [id, key] of SIDE_QUEST_CHANCES) {
        CONFIG[key] = Number(document.getElementById(id).value);
    }

    // Do not override; respect user customization

    isCustomGame = true;
    hideCustomizationMenu();
    hideMainMenu();
    lockOnStart = true; // ensure pointer lock on custom game start
    stopMenuMusic();
    stopFailMusic();
    startNewGame();
}

// NEW: Delegated UI click handler (persists across overlays)
let uiClickHandler = null;
function addUiDelegation() {
    // DEPRECATED: handled by PauseMenu.bind()
}

function applyRuntimeGraphicsSettings() {
    if (!renderer) return;

    const dpr = window.devicePixelRatio || 1;
    const q = CONFIG.RENDER_QUALITY || 'medium';
    const targetPR = q === 'low' ? Math.min(1, dpr * 0.75) 
                   : q === 'medium' ? Math.min(1.25, dpr) 
                   : q === 'high' ? dpr 
                   : Math.min(2.0, dpr * 1.5);
    renderer.setPixelRatio(targetPR);

    const lq = CONFIG.LIGHTING_QUALITY || 'high';
    const shadowsEnabled = (lq === 'high' || lq === 'ultra');
    renderer.shadowMap.enabled = shadowsEnabled;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    if (sceneLights?.sunLight) {
        sceneLights.sunLight.castShadow = shadowsEnabled;
        if (shadowsEnabled) {
            const mapSize = lq === 'ultra' ? 2048 : 1024;
            sceneLights.sunLight.shadow.mapSize.set(mapSize, mapSize);
            sceneLights.sunLight.shadow.camera.near = 35;
            sceneLights.sunLight.shadow.camera.far = 185;
            sceneLights.sunLight.shadow.camera.left = -42;
            sceneLights.sunLight.shadow.camera.right = 42;
            sceneLights.sunLight.shadow.camera.top = 42;
            sceneLights.sunLight.shadow.camera.bottom = -42;
            sceneLights.sunLight.shadow.bias = -0.0003;
            sceneLights.sunLight.shadow.normalBias = 0.02;
            sceneLights.sunLight.shadow.camera.updateProjectionMatrix();
            if (sceneLights.sunLight.shadow.map) {
                sceneLights.sunLight.shadow.map.dispose();
                sceneLights.sunLight.shadow.map = null;
            }
        }
        sceneLights.sunLight.intensity = (lq === 'low' ? 1.4 : 1.75);
    }
    if (sceneLights?.hemiLight) {
        sceneLights.hemiLight.intensity = (lq === 'low' ? 0.6 : 0.85);
    }
}

let currentSettingsKeybinds = { ...DEFAULT_KEYBINDS };

// Shared settings save action so buttons always work
function performSaveSettings() {
    const musicSlider = document.getElementById('music-volume');
    const sfxSlider = document.getElementById('sfx-volume');
    const lightingSelect = document.getElementById('lighting-quality');
    const pbrSelect = document.getElementById('pbr-quality');
    const qSelect = document.getElementById('render-quality');
    const scenerySelect = document.getElementById('scenery-detail');
    const fpsCheck = document.getElementById('show-fps');
    const mouseSlider = document.getElementById('mouse-sensitivity');
    const hideGuideCheck = document.getElementById('hide-controls-guide');
    const hideBestTimesCheck = document.getElementById('hide-best-times');

    // Apply audio
    const mv = parseFloat(musicSlider?.value ?? CONFIG.MUSIC_VOLUME ?? 0.5);
    const sv = parseFloat(sfxSlider?.value ?? CONFIG.SFX_VOLUME ?? 0.7);
    CONFIG.MUSIC_VOLUME = mv; CONFIG.SFX_VOLUME = sv;
    if (menuMusic) menuMusic.volume = mv;
    if (music) music.volume = mv * (1 - customerScuffleMusicMix);
    if (customerScuffleMusic) customerScuffleMusic.volume = mv * customerScuffleMusicMix;
    if (mrResettiMusic) mrResettiMusic.volume = mv;
    Object.values(soundEffects || {}).forEach(a => { if (a && typeof a.volume === 'number') a.volume = sv; });
    Object.keys(BOOSTED_SFX_MULTIPLIERS).forEach(name => setBoostedSfxVolume(name, sv));

    // Graphics & Performance settings
    const oldPbr = CONFIG.PBR_QUALITY;
    const oldScenery = CONFIG.SCENERY_DETAIL;

    CONFIG.LIGHTING_QUALITY = lightingSelect?.value || (CONFIG.LIGHTING_QUALITY || 'high');
    CONFIG.PBR_QUALITY = pbrSelect?.value || (CONFIG.PBR_QUALITY || 'high');
    CONFIG.RENDER_QUALITY = qSelect?.value || (CONFIG.RENDER_QUALITY || 'medium');
    CONFIG.SCENERY_DETAIL = scenerySelect?.value || (CONFIG.SCENERY_DETAIL || 'high');

    applyRuntimeGraphicsSettings();

    // If PBR quality or Scenery detail changed during an active game session, rebuild layout to apply
    if (gameStarted && (oldPbr !== CONFIG.PBR_QUALITY || oldScenery !== CONFIG.SCENERY_DETAIL)) {
        createStoreLayout();
    }

    CONFIG.SHOW_FPS = !!fpsCheck?.checked;
    fpsOverlay.style.display = CONFIG.SHOW_FPS ? 'block' : 'none';

    // Controls & Keybinds
    CONFIG.LOOK_SENSITIVITY = parseFloat(mouseSlider?.value ?? 1.0);
    if (controls) controls.pointerSpeed = 0; // look is handled by handleSmoothMouseMove (which applies LOOK_SENSITIVITY)

    CONFIG.HIDE_CONTROLS_GUIDE = !!hideGuideCheck?.checked;
    CONFIG.HIDE_BEST_TIMES = !!hideBestTimesCheck?.checked;
    scoreboardElement.style.display = CONFIG.HIDE_BEST_TIMES ? 'none' : '';
    CONFIG.KEYBINDS = { ...currentSettingsKeybinds };
    updateControlsGuideDisplay();

    persistUserSettings();
    hideSettingsMenu();
    displayMessage('Settings saved', 3500);
}

function populateSettingsMenu() {
    const musicSlider = document.getElementById('music-volume');
    const sfxSlider = document.getElementById('sfx-volume');
    const lightingSelect = document.getElementById('lighting-quality');
    const pbrSelect = document.getElementById('pbr-quality');
    const qSelect = document.getElementById('render-quality');
    const scenerySelect = document.getElementById('scenery-detail');
    const fpsCheck = document.getElementById('show-fps');
    const mouseSlider = document.getElementById('mouse-sensitivity');
    const hideGuideCheck = document.getElementById('hide-controls-guide');
    const hideBestTimesCheck = document.getElementById('hide-best-times');

    // Set current values
    if (musicSlider) musicSlider.value = CONFIG.MUSIC_VOLUME ?? 0.5;
    if (sfxSlider) sfxSlider.value = CONFIG.SFX_VOLUME ?? 0.7;
    if (lightingSelect) lightingSelect.value = (CONFIG.LIGHTING_QUALITY || 'high');
    if (pbrSelect) pbrSelect.value = (CONFIG.PBR_QUALITY || 'high');
    if (qSelect) qSelect.value = (CONFIG.RENDER_QUALITY || 'medium');
    if (scenerySelect) scenerySelect.value = (CONFIG.SCENERY_DETAIL || 'high');
    if (fpsCheck) fpsCheck.checked = !!CONFIG.SHOW_FPS;
    if (hideGuideCheck) hideGuideCheck.checked = !!CONFIG.HIDE_CONTROLS_GUIDE;
    if (hideBestTimesCheck) hideBestTimesCheck.checked = !!CONFIG.HIDE_BEST_TIMES;
    if (mouseSlider) mouseSlider.value = (typeof CONFIG.LOOK_SENSITIVITY === 'number' ? CONFIG.LOOK_SENSITIVITY : 1.0);

    // Show current slider values
    if (musicSlider) musicSlider.parentElement.querySelector('.value-display').textContent = musicSlider.value;
    if (sfxSlider) sfxSlider.parentElement.querySelector('.value-display').textContent = sfxSlider.value;
    if (mouseSlider) mouseSlider.parentElement.querySelector('.value-display').textContent = mouseSlider.value;

    if (musicSlider) {
        musicSlider.oninput = (e) => {
            e.target.parentElement.querySelector('.value-display').textContent = e.target.value;
        };
    }
    if (sfxSlider) {
        sfxSlider.oninput = (e) => {
            e.target.parentElement.querySelector('.value-display').textContent = e.target.value;
        };
    }
    if (mouseSlider) {
        mouseSlider.oninput = (e) => {
            e.target.parentElement.querySelector('.value-display').textContent = e.target.value;
        };
    }

    // Tab switching
    const tabBtns = document.querySelectorAll('.settings-tab-btn');
    const tabPanes = document.querySelectorAll('.settings-tab-pane');
    tabBtns.forEach(btn => {
        btn.onclick = () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            tabPanes.forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            const targetId = btn.getAttribute('data-tab');
            const targetPane = document.getElementById(targetId);
            if (targetPane) targetPane.classList.add('active');
        };
    });

    // Keybind configuration
    currentSettingsKeybinds = { ...DEFAULT_KEYBINDS, ...(CONFIG.KEYBINDS || {}) };
    let currentKeybindListener = null;
    let activeKeybindBtn = null;

    function cleanupKeybindListener() {
        if (currentKeybindListener) {
            window.removeEventListener('keydown', currentKeybindListener, true);
            currentKeybindListener = null;
        }
        if (activeKeybindBtn) {
            activeKeybindBtn.classList.remove('listening');
            const action = activeKeybindBtn.getAttribute('data-action');
            if (action && currentSettingsKeybinds[action]) {
                activeKeybindBtn.textContent = formatKeyName(currentSettingsKeybinds[action]);
            }
            activeKeybindBtn = null;
        }
    }

    const keybindButtons = document.querySelectorAll('.keybind-btn');
    keybindButtons.forEach(btn => {
        const action = btn.getAttribute('data-action');
        if (action && currentSettingsKeybinds[action]) {
            btn.textContent = formatKeyName(currentSettingsKeybinds[action]);
        }
        btn.onclick = (e) => {
            e.stopPropagation();
            if (activeKeybindBtn === btn) {
                cleanupKeybindListener();
                return;
            }
            cleanupKeybindListener();

            activeKeybindBtn = btn;
            btn.classList.add('listening');
            btn.textContent = '...';

            currentKeybindListener = (keyEvent) => {
                keyEvent.preventDefault();
                keyEvent.stopPropagation();
                if (keyEvent.code !== 'Escape') {
                    currentSettingsKeybinds[action] = keyEvent.code;
                    btn.textContent = formatKeyName(keyEvent.code);
                } else {
                    btn.textContent = formatKeyName(currentSettingsKeybinds[action]);
                }
                btn.classList.remove('listening');
                window.removeEventListener('keydown', currentKeybindListener, true);
                currentKeybindListener = null;
                activeKeybindBtn = null;
            };
            window.addEventListener('keydown', currentKeybindListener, true);
        };
    });

    const resetKbBtn = document.getElementById('reset-keybinds-btn');
    if (resetKbBtn) {
        resetKbBtn.onclick = () => {
            cleanupKeybindListener();
            currentSettingsKeybinds = { ...DEFAULT_KEYBINDS };
            keybindButtons.forEach(btn => {
                const action = btn.getAttribute('data-action');
                if (action && currentSettingsKeybinds[action]) {
                    btn.textContent = formatKeyName(currentSettingsKeybinds[action]);
                    btn.classList.remove('listening');
                }
            });
        };
    }

    document.getElementById('save-settings').onclick = performSaveSettings;
    document.getElementById('back-from-settings').onclick = hideSettingsMenu;
}

function hideSettingsMenu() {
    const sm = document.getElementById('settings-menu');
    if (sm) sm.style.display = 'none';
    // If settings were opened from pause, return to the pause menu
    if (gamePaused && settingsOpenedFromPause) {
        settingsOpenedFromPause = false;
        PauseMenu.show();
    }
}

function init() {
    // Only show main menu initially; defer heavy game setup until Play is pressed
    updateScoreboard();
    loadingElement.style.display = 'none';

    // Begin background pre-streaming textures while player is in menu
    preloadAllGameAssets().catch(e => console.warn('Background texture pre-stream:', e));

    // Ensure alert overlay exists at boot
    if (!centerAlertElement) {
        const overlay = document.getElementById('alerts-overlay') || (() => {
            const o = document.createElement('div');
            o.id = 'alerts-overlay';
            document.getElementById('game-container').appendChild(o);
            return o;
        })();
        centerAlertElement = document.getElementById('center-alert') || (() => {
            const c = document.createElement('div');
            c.id = 'center-alert';
            overlay.appendChild(c);
            return c;
        })();
    }
    // Ensure RNG element exists (legacy, non-visual)
    if (!rngNotificationsElement) {
        rngNotificationsElement = document.createElement('div');
        rngNotificationsElement.id = 'rng-notifications';
        document.getElementById('game-container').appendChild(rngNotificationsElement);
    }
    // Guard against uncaught window drag & drop events
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
        try {
            e.preventDefault();
            e.stopPropagation();
        } catch (_) {}
    });

    // Initialize menu music once before showing the menu
    initMenuMusicSingleton();
    showMainMenu();
    // Initialize FPS overlay visibility from config
    fpsOverlay.style.display = CONFIG.SHOW_FPS ? 'block' : 'none';

    window.triggerWifeCallEvent = triggerWifeCallEvent;
    window.triggerEarthquakeEvent = triggerEarthquakeEvent;
    window.triggerThermostatMalfunction = triggerThermostatMalfunction;
    window.activateCurrentPowerup = activateCurrentPowerup;
    window.rollPowerup = rollPowerup;
    window.performEventReroll = performEventReroll;
    window.grantPowerup = (type = 'super_speed') => {
        currentPowerup = type;
        powerupUsed = false;
        powerupActive = false;
        showPowerupIndicator();
    };
    // Ensure UI delegation is active once at boot
    // addUiDelegation(); // removed - PauseMenu handles bindings
}

function rollPowerup() {
    // Decide if a powerup is granted this game
    const chance = Number.isFinite(CONFIG.POWERUP_CHANCE) ? CONFIG.POWERUP_CHANCE : 2;
    if (Math.random() * 100 < chance) {
        const types = ['super_speed', 'eagle_eye', 'crazy_scanner', 'extendo_arm'];
        currentPowerup = types[Math.floor(Math.random() * types.length)];
        powerupUsed = false;
        powerupActive = false;
        showPowerupIndicator();
    } else {
        currentPowerup = null;
        powerupUsed = false;
        powerupActive = false;
        hidePowerupIndicator();
    }
}

function showPowerupIndicator() {
    const card = document.getElementById('powerup-card');
    const iconEl = document.getElementById('powerup-card-icon');
    const titleEl = document.getElementById('powerup-card-title');
    const statusEl = document.getElementById('powerup-card-status');
    const barEl = document.getElementById('powerup-progress-bar');

    if (!currentPowerup) {
        hidePowerupIndicator();
        return;
    }

    const label = currentPowerup === 'super_speed' ? 'Super Speed'
        : currentPowerup === 'eagle_eye' ? 'Eagle Eye'
        : currentPowerup === 'crazy_scanner' ? 'Crazy Scanner'
        : currentPowerup === 'extendo_arm' ? 'Extendo Arm'
        : 'Powerup';
    const symbol = currentPowerup === 'super_speed' ? '⚡'
        : currentPowerup === 'eagle_eye' ? '👁️'
        : currentPowerup === 'crazy_scanner' ? '💰'
        : currentPowerup === 'extendo_arm' ? '🦾'
        : '⭐';

    if (iconEl) iconEl.textContent = symbol;
    if (titleEl) titleEl.textContent = label;
    const pKey = formatKeyName((CONFIG.KEYBINDS && CONFIG.KEYBINDS.powerup) || 'KeyY');
    if (statusEl) statusEl.innerHTML = `Press <kbd>${pKey}</kbd> or Click to Activate!`;
    if (barEl) barEl.style.width = '0%';
    if (card) {
        card.classList.remove('hidden', 'active');
        card.style.display = 'flex';
        card.onclick = () => {
            if (gameStarted && !powerupUsed && currentPowerup && !powerupActive) {
                activateCurrentPowerup();
            }
        };
    }
}

function hidePowerupIndicator() {
    const card = document.getElementById('powerup-card');
    if (card) {
        card.classList.add('hidden');
        card.classList.remove('active');
        card.style.display = 'none';
        card.onclick = null;
    }
}

function startPowerupCountdown(ms, label, symbol) {
    if (powerupCountdownInterval) clearInterval(powerupCountdownInterval);
    const start = Date.now();
    const end = start + ms;
    const card = document.getElementById('powerup-card');
    const statusEl = document.getElementById('powerup-card-status');
    const barEl = document.getElementById('powerup-progress-bar');
    if (card) {
        card.classList.remove('hidden');
        card.classList.add('active');
        card.style.display = 'flex';
    }

    powerupCountdownInterval = setInterval(() => {
        const now = Date.now();
        const remain = Math.max(0, Math.ceil((end - now) / 1000));
        const progress = Math.min(100, Math.max(0, ((now - start) / ms) * 100));
        if (statusEl) statusEl.innerHTML = `${symbol || '⚡'} ACTIVE (${remain}s left)`;
        if (barEl) barEl.style.width = `${100 - progress}%`;
        if (remain <= 0) {
            clearInterval(powerupCountdownInterval);
            powerupCountdownInterval = null;
        }
    }, 100);
}

function activateCurrentPowerup() {
    if (!currentPowerup || powerupActive || powerupUsed) return;
    powerupActive = true;
    powerupUsed = true;
    unlockAchievement('superPower');
    
    const pType = currentPowerup;
    const symbol = pType === 'super_speed' ? '⚡'
        : pType === 'eagle_eye' ? '👁️'
        : pType === 'crazy_scanner' ? '💰'
        : pType === 'extendo_arm' ? '🦾'
        : '';
    const label = pType === 'super_speed' ? 'Super Speed'
        : pType === 'eagle_eye' ? 'Eagle Eye'
        : pType === 'crazy_scanner' ? 'Crazy Scanner'
        : pType === 'extendo_arm' ? 'Extendo Arm'
        : 'Powerup';

    if (pType === 'super_speed') {
        activeSpeedMultiplier = 2;
        startPowerupCountdown(10000, label, symbol);
        if (superSpeedTimeoutId) clearTimeout(superSpeedTimeoutId);
        superSpeedTimeoutId = setTimeout(() => {
            activeSpeedMultiplier = 1;
            powerupActive = false;
            currentPowerup = null;
            powerupUsed = false;
            superSpeedTimeoutId = null;
            hidePowerupIndicator();
            if (powerupCountdownInterval) { clearInterval(powerupCountdownInterval); powerupCountdownInterval = null; }
        }, 10000);
    } else if (pType === 'eagle_eye') {
        applyEagleEyeOutlines();
        startPowerupCountdown(5000, label, symbol);
        if (eagleEyeTimeoutId) clearTimeout(eagleEyeTimeoutId);
        eagleEyeTimeoutId = setTimeout(() => {
            clearEagleEyeOutlines();
            powerupActive = false;
            currentPowerup = null;
            powerupUsed = false;
            eagleEyeTimeoutId = null;
            hidePowerupIndicator();
            if (powerupCountdownInterval) { clearInterval(powerupCountdownInterval); powerupCountdownInterval = null; }
        }, 5000);
    } else if (pType === 'crazy_scanner') {
        crazyScannerActive = true;
        startPowerupCountdown(10000, label, symbol);
        if (crazyScannerTimeoutId) clearTimeout(crazyScannerTimeoutId);
        crazyScannerTimeoutId = setTimeout(() => {
            crazyScannerActive = false;
            powerupActive = false;
            currentPowerup = null;
            powerupUsed = false;
            crazyScannerTimeoutId = null;
            hidePowerupIndicator();
            if (powerupCountdownInterval) { clearInterval(powerupCountdownInterval); powerupCountdownInterval = null; }
        }, 10000);
    } else if (pType === 'extendo_arm') {
        startPowerupCountdown(8000, label, symbol);
        if (extendoArmTimeoutId) clearTimeout(extendoArmTimeoutId);
        extendoArmTimeoutId = setTimeout(() => {
            powerupActive = false;
            currentPowerup = null;
            powerupUsed = false;
            extendoArmTimeoutId = null;
            hidePowerupIndicator();
            if (powerupCountdownInterval) { clearInterval(powerupCountdownInterval); powerupCountdownInterval = null; }
        }, 8000);
    }
}

function applyEagleEyeOutlines() {
    clearEagleEyeOutlines();
    const needed = new Set(shoppingList.filter(i => i.collected < i.quantity).map(i => i.name));
    allItems.forEach(item => {
        if (!needed.has(item.name) || item.inCart || !item.mesh || item.eagleGlow) return;
        const box = new THREE.Box3().setFromObject(item.mesh), size = new THREE.Vector3(), center = new THREE.Vector3();
        box.getSize(size); box.getCenter(center);
        const geo = new THREE.BoxGeometry(size.x * 1.25, size.y * 1.25, size.z * 1.25);
        const mat = new THREE.MeshBasicMaterial({ color: 0xff00aa, transparent: true, opacity: 0.35, depthTest: false });
        const glow = new THREE.Mesh(geo, mat); glow.renderOrder = 999; glow.position.copy(item.mesh.worldToLocal(center.clone()));
        item.mesh.add(glow); item.eagleGlow = glow;
    });
}

function clearEagleEyeOutlines() {
    allItems.forEach(item => {
        if (item.eagleGlow) {
            if (item.eagleGlow.parent) item.eagleGlow.parent.remove(item.eagleGlow);
            if (item.eagleGlow.geometry) item.eagleGlow.geometry.dispose();
            if (item.eagleGlow.material) item.eagleGlow.material.dispose();
            item.eagleGlow = null;
        }
    });
}

function cleanupTransientFeatures() {
    // Clear Eagle Eye outlines and powerup UI/state to avoid carry-over
    clearEagleEyeOutlines();
    if (powerupCountdownInterval) { clearInterval(powerupCountdownInterval); powerupCountdownInterval = null; }
    if (superSpeedTimeoutId) { clearTimeout(superSpeedTimeoutId); superSpeedTimeoutId = null; }
    if (eagleEyeTimeoutId) { clearTimeout(eagleEyeTimeoutId); eagleEyeTimeoutId = null; }
    if (crazyScannerTimeoutId) { clearTimeout(crazyScannerTimeoutId); crazyScannerTimeoutId = null; }
    if (extendoArmTimeoutId) { clearTimeout(extendoArmTimeoutId); extendoArmTimeoutId = null; }
    currentPowerup = null;
    powerupUsed = false;
    powerupActive = false;
    activeSpeedMultiplier = 1;
    crazyScannerActive = false;
    if (powerupIndicatorEl) powerupIndicatorEl.classList.remove('visible');
    hidePowerupIndicator();
}

// Start a NORMAL game with pristine defaults every time
function startNormalGame() {
    try {
        startNormalGameInner();
    } catch (err) {
        console.error('[start] Play failed before loading', err);
        try { showMainMenu(); } catch (_) {}
        showIosHelp({ mode: 'error', error: String(err && (err.stack || err.message) || err), onStart: () => { if (mainMenuVisible) startNormalGame(); } });
    }
}

function startNormalGameInner() {
    // Stop any running game fully and silence menu music
    hardStopGame();
    stopMenuMusic();
    // Ensure fail music is stopped for a normal new game
    stopFailMusic();

    // Reset config/state to defaults
    restoreDefaultConfig();
    cleanupTransientFeatures();
    isCustomGame = false;

    // Hide menu and boot a fresh game
    hideMainMenu();
    lockOnStart = true;
    purchaseComplete = false;
    startNewGame();
}

function restoreDefaultConfig() {
    // Every rule that affects play goes back to its exact vanilla value, so a
    // Play run can never inherit leftover custom settings.
    for (const key of RULESET_KEYS) CONFIG[key] = vanillaRulesetValue(key);
    // Game settings
    CONFIG.SHELF_COUNT = DEFAULT_GAME_SETTINGS.SHELF_COUNT;
    CONFIG.MIN_SHOPPING_LIST_ITEMS = DEFAULT_GAME_SETTINGS.MIN_SHOPPING_LIST_ITEMS;
    CONFIG.MAX_SHOPPING_LIST_ITEMS = DEFAULT_GAME_SETTINGS.MAX_SHOPPING_LIST_ITEMS;
    // (Graphics settings like RENDER_QUALITY / SHOW_FPS are user preferences and
    // are intentionally NOT reset here.)

    // Probabilities (from module defaults)
    CONFIG.DROP_ITEM_CHANCE = PROB_DEFAULTS.DROP_ITEM_CHANCE;
    CONFIG.POWER_OUTAGE_CHANCE = PROB_DEFAULTS.POWER_OUTAGE_CHANCE;
    CONFIG.FORGOT_GLASSES_CHANCE = PROB_DEFAULTS.FORGOT_GLASSES_CHANCE;
    CONFIG.OUT_OF_STOCK_CHANCE = PROB_DEFAULTS.OUT_OF_STOCK_CHANCE;
    CONFIG.SLIPPERY_FLOOR_CHANCE = PROB_DEFAULTS.SLIPPERY_FLOOR_CHANCE;
    CONFIG.CART_STUCK_CHANCE = PROB_DEFAULTS.CART_STUCK_CHANCE;
    CONFIG.STORE_CLOSING_CHANCE = PROB_DEFAULTS.STORE_CLOSING_CHANCE;
    CONFIG.TRIPPING_CHANCE = PROB_DEFAULTS.TRIPPING_CHANCE;
    CONFIG.CHECKOUT_BUTTON_REQUIRED_CHANCE = PROB_DEFAULTS.CHECKOUT_BUTTON_REQUIRED_CHANCE;
    CONFIG.CHECKOUT_BUSY_CHANCE = PROB_DEFAULTS.CHECKOUT_BUSY_CHANCE;
    CONFIG.POWERUP_CHANCE = PROB_DEFAULTS.POWERUP_CHANCE;
    CONFIG.SINGLE_ITEM_LIST_CHANCE = PROB_DEFAULTS.SINGLE_ITEM_LIST_CHANCE;
    CONFIG.EMPTY_SHELF_CHANCE = PROB_DEFAULTS.EMPTY_SHELF_CHANCE;
    CONFIG.TWO_IN_ONE_ITEM_CHANCE = PROB_DEFAULTS.TWO_IN_ONE_ITEM_CHANCE;
    CONFIG.ADD_ITEM_CHANCE = PROB_DEFAULTS.ADD_ITEM_CHANCE;
    CONFIG.REMOVE_ITEM_CHANCE = PROB_DEFAULTS.REMOVE_ITEM_CHANCE;
    CONFIG.CUSTOMER_QUESTION_CHANCE = PROB_DEFAULTS.CUSTOMER_QUESTION_CHANCE;
    CONFIG.NO_MONEY_CHANCE = PROB_DEFAULTS.NO_MONEY_CHANCE;
    CONFIG.THIEF_BREAK_IN_CHANCE = PROB_DEFAULTS.THIEF_BREAK_IN_CHANCE;
    CONFIG.PRODUCT_SPILL_CHANCE = PROB_DEFAULTS.PRODUCT_SPILL_CHANCE;
    CONFIG.BABY_CRYING_CHANCE = PROB_DEFAULTS.BABY_CRYING_CHANCE;
    CONFIG.BABY_IN_CART_CHANCE = PROB_DEFAULTS.BABY_IN_CART_CHANCE ?? 7;
    CONFIG.ENSURE_TWO_IN_ONE_ITEM = PROB_DEFAULTS.ENSURE_TWO_IN_ONE_ITEM;
    CONFIG.MISLABELED_ITEM_CHANCE = PROB_DEFAULTS.MISLABELED_ITEM_CHANCE;
    CONFIG.WEIGHT_CHANGE_CHANCE = PROB_DEFAULTS.WEIGHT_CHANGE_CHANCE;
    CONFIG.CUSTOMER_THEFT_CHANCE = PROB_DEFAULTS.CUSTOMER_THEFT_CHANCE;
    // NEW: ensure vanilla games use default under‑construction and manager chances
    CONFIG.UNDER_CONSTRUCTION_CHANCE = PROB_DEFAULTS.UNDER_CONSTRUCTION_CHANCE;
    CONFIG.MANAGER_JUMPSCARE_CHANCE = PROB_DEFAULTS.MANAGER_JUMPSCARE_CHANCE;
    CONFIG.WIFE_CALL_CHANCE = PROB_DEFAULTS.WIFE_CALL_CHANCE;
    CONFIG.EARTHQUAKE_CHANCE = PROB_DEFAULTS.EARTHQUAKE_CHANCE;
    CONFIG.NUCLEAR_FALLOUT_CHANCE = PROB_DEFAULTS.NUCLEAR_FALLOUT_CHANCE;
    CONFIG.THERMOSTAT_CHANCE = PROB_DEFAULTS.THERMOSTAT_CHANCE;
    CONFIG.CUSTOMER_SCUFFLE_CHANCE = PROB_DEFAULTS.CUSTOMER_SCUFFLE_CHANCE;
    CONFIG.TWEAKER_CHANCE = PROB_DEFAULTS.TWEAKER_CHANCE;
    CONFIG.SHELF_REPLACE_CHANCE = PROB_DEFAULTS.SHELF_REPLACE_CHANCE ?? 4;
    CONFIG.FALLING_SHELF_CHANCE = PROB_DEFAULTS.FALLING_SHELF_CHANCE;
    CONFIG.FALLING_SHELF_ENABLED = PROB_DEFAULTS.FALLING_SHELF_ENABLED;
    CONFIG.LONELY_STORE_CHANCE = PROB_DEFAULTS.LONELY_STORE_CHANCE;
    CONFIG.GUM_CRAVING_CHANCE = PROB_DEFAULTS.GUM_CRAVING_CHANCE;

    // Audio defaults
    // Use the module defaults already merged into CONFIG at boot if available,
    // otherwise set safe defaults
    CONFIG.MUSIC_VOLUME = (typeof CONFIG.MUSIC_VOLUME === 'number') ? CONFIG.MUSIC_VOLUME : 0.5;
    CONFIG.SFX_VOLUME = (typeof CONFIG.SFX_VOLUME === 'number') ? CONFIG.SFX_VOLUME : 0.7;
}

// New robust Pause Menu controller (visuals unchanged)
const PauseMenu = (() => {
  let overlay = null;
  const gc = () => document.getElementById('game-container');

  function ensureOverlay() {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'pause-overlay';
      gc().appendChild(overlay);
    }
    return overlay;
  }

  function render() {
    const ov = ensureOverlay();
    ov.innerHTML = `
      <div class="pause-panel">
        <div class="pause-title">Paused</div>
        <div class="pause-actions">
          <button class="pause-btn primary" id="pause-resume">Resume</button>
          <button class="pause-btn secondary" id="pause-restart">Restart Game</button>
          <button class="pause-btn secondary" id="pause-settings">Settings</button>
          <button class="pause-btn secondary" id="pause-menu">Return to Main Menu</button>
        </div>
        ${seedBadgeHtml(currentRunSeed)}
      </div>`;
  }

  function bind() {
    const ov = overlay;
    const resume = ov.querySelector('#pause-resume');
    const restart = ov.querySelector('#pause-restart');
    const settings = ov.querySelector('#pause-settings');
    const menu = ov.querySelector('#pause-menu');

    resume.onclick = () => { hide(); resumeGame(); };
    restart.onclick = () => { hide(); restartGameCold(); };
    settings.onclick = () => {
      hide();
      settingsOpenedFromPause = true;
      const sm = document.getElementById('settings-menu');
      sm.style.display = 'block';
      populateSettingsMenu();
    };
    menu.onclick = () => { hide(); hardStopGame(); stopMenuMusic(); stopFailMusic(); showMainMenu(); };
  }

  function show() {
    gamePaused = true;
    controls?.unlock();
    render();
    bind();
    requestAnimationFrame(() => ensureOverlay().classList.add('visible'));
  }

  function hide() {
    if (!overlay) return;
    const panel = overlay.querySelector('.pause-panel');
    if (panel) panel.classList.add('closing');
    overlay.classList.remove('visible');
    // remove after animation completes and fully clean instance
    setTimeout(() => { try { overlay.remove(); } catch(_) {} overlay = null; }, 260);
  }

  return { show, hide };
})();

init();

// Helper: scatter items from a shelf unit using physics impulses
function scatterItemsFromUnit(unit) {
    if (!unit || !unit.userData || !unit.userData.items) return;
    const basePos = new THREE.Vector3();
    unit.getWorldPosition(basePos);

    unit.userData.items.forEach(item => {
        if (!item || item.inCart) return;
        // Make item visible and free in world
        if (item.mesh && item.mesh.parent) {
            item.mesh.parent.remove(item.mesh);
            scene.add(item.mesh);
            // Restore depth so occlusion works
            try {
                item.mesh.traverse(o => {
                    if (o.isMesh && o.material) {
                        if (Array.isArray(o.material)) o.material.forEach(m => { m.depthTest = true; m.depthWrite = true; });
                        else { o.material.depthTest = true; o.material.depthWrite = true; }
                    }
                    o.renderOrder = 0;
                });
            } catch(_) {}
        }
        // Remove any existing static body and recreate as dynamic
        if (item.body) { try { world.removeBody(item.body); } catch(_) {} }
        const shape = new CANNON.Box(new CANNON.Vec3(item.size[0]/2, item.size[1]/2, item.size[2]/2));
        const b = new CANNON.Body({ mass: 1, shape });
        const rx = basePos.x + (Math.random() - 0.5) * 2.5;
        const rz = basePos.z + (Math.random() - 0.5) * 2.5;
        const ry = Math.max(0.3, basePos.y - 0.8);
        b.position.set(rx, ry, rz);
        // Impulse outward
        b.velocity.set((Math.random() - 0.5) * 3, 2 + Math.random() * 2, (Math.random() - 0.5) * 3);
        world.addBody(b);
        item.body = b;
        item.isStatic = false;
        item.mesh.position.copy(b.position);
        item.mesh.quaternion.copy(b.quaternion);
    });
}

// Immediate fail helper
function failCrushedByShelf() {
    unlockAchievement('crushed');
    gameOver = true;
    endCustomerScuffle(true);
    if (timer) { try { clearInterval(timer); } catch(_) {} timer = null; }
    controls?.unlock();
    playerBody?.velocity.set(0,0,0);

    // Play fail music for shelf crush
    playFailMusic();

    // Unified failure overlay for crush event
    showShoppingFailureOverlay(
        'Shopping Failed!',
        'You were crushed by a falling shelf!'
    );
}

function triggerFallingShelfEvent() {
    if (fallingShelfTriggered || shelfUnits.length === 0 || !gameStarted || isCheckout || gameOver) return false;
    fallingShelfTriggered = true;
    fallingShelfOccurred = true;

    // Pick a random shelf unit
    const unit = shelfUnits[Math.floor(Math.random() * shelfUnits.length)];
    if (!unit) return;

    // Prepare animation state
    const initialY = unit.position.y;
    // Land cleanly near the floor; small cushion above 0 to avoid z-fighting
    const targetY = 0.5;
    fallingShelfAnim = {
        unit,
        start: performance.now(),
        duration: 1500, // 1.5s for realistic tip-and-hit
        tiltAxis: Math.random() < 0.5 ? 'z' : 'x',
        finished: false,
        scattered: false,
        initialY,
        targetY
    };

    displayMessage("A shelf is falling over!", 3000, true);
}

function triggerWifeCallEvent() {
    if (wifeCallActive || !gameStarted || isCheckout || gameOver || purchaseComplete) return false;
    wifeCallActive = true;
    wifeCallRinging = true;
    phoneEventActive = true;
    wifeCallCount++;

    // Release mouse pointer lock so the user can freely click the phone buttons
    if (controls && controls.isLocked) {
        try { controls.unlock(); } catch (_) {}
    }

    // Remove any previous widget
    const existing = document.getElementById('phone-call-container');
    if (existing) existing.remove();

    const phoneEl = document.createElement('div');
    phoneEl.id = 'phone-call-container';

    // Prepare candidate item pool
    const candidates = ACTIVE_ITEMS.filter(item => !shoppingList.some(li => li?.name === item?.name));
    const pool = candidates.length >= 2 ? candidates : ACTIVE_ITEMS;
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    const item1 = shuffled[0] || ACTIVE_ITEMS[0];
    const item2 = shuffled[1] || ACTIVE_ITEMS[1] || ACTIVE_ITEMS[0];

    phoneEl.innerHTML = `
        <div class="android-top-bar">
            <span>12:45</span>
            <div class="android-punchhole"></div>
            <span>5G 📶 🔋 92%</span>
        </div>
        <div class="android-call-screen">
            <div class="android-caller-avatar-wrap">
                <div class="android-pulse-ring"></div>
                <div class="android-avatar">👩❤️</div>
            </div>
            <div class="android-caller-name">Wife ❤️</div>
            <div class="android-call-type">Incoming Call • Mobile</div>
            <div class="android-call-subtitle">
                "Honey, please pick up! I need you to grab something else!"
                <span style="font-size:0.75rem; color:#94a3b8; display:block; margin-top:4px;">Click to Answer (+1 Item) or Decline (50/50 Gamble)</span>
            </div>
            <div class="android-action-buttons">
                <button class="android-btn android-btn-decline" id="phone-btn-decline" title="Decline Call">
                    <span class="android-btn-icon">📵</span>
                    <span>Decline</span>
                </button>
                <button class="android-btn android-btn-answer" id="phone-btn-answer" title="Answer Call">
                    <span class="android-btn-icon">📞</span>
                    <span>Answer</span>
                </button>
            </div>
        </div>
        <div class="android-gesture-pill"></div>
    `;

    document.getElementById('game-container').appendChild(phoneEl);

    // Audio - start ringtone
    if (soundEffects && soundEffects.phoneRing) {
        try {
            soundEffects.phoneRing.currentTime = 0;
            soundEffects.phoneRing.play().catch(() => {});
        } catch (_) {}
    }

    displayMessage("📱 Incoming call from Wife!", 3500, true);

    const stopPhoneAudio = () => {
        if (soundEffects && soundEffects.phoneRing) {
            try {
                soundEffects.phoneRing.pause();
                soundEffects.phoneRing.currentTime = 0;
            } catch (_) {}
        }
    };

    const closePhoneWidget = (delayMs = 3500) => {
        setTimeout(() => {
            if (!phoneEl.parentNode) {
                // Widget already gone: still release the flags so later calls can happen
                wifeCallActive = false;
                wifeCallRinging = false;
                phoneEventActive = false;
                return;
            }
            phoneEl.style.transition = 'opacity 0.3s, transform 0.3s';
            phoneEl.style.opacity = '0';
            phoneEl.style.transform = 'translateY(20px)';
            setTimeout(() => {
                if (phoneEl.parentNode) phoneEl.remove();
                wifeCallActive = false;
                wifeCallRinging = false;
                phoneEventActive = false;
            }, 300);
        }, delayMs);
    };

    const handleTimeout = () => {
        if (!wifeCallActive && !wifeCallRinging) return;
        if (wifeCallTimeoutId) {
            clearTimeout(wifeCallTimeoutId);
            wifeCallTimeoutId = null;
        }
        wifeCallRinging = false;
        stopPhoneAudio();

        phoneEl.innerHTML = `
            <div class="android-top-bar">
                <span>12:45</span>
                <div class="android-punchhole"></div>
                <span>5G 📶 🔋 92%</span>
            </div>
            <div class="android-call-screen">
                <div class="android-caller-avatar-wrap" style="margin-bottom: 4px;">
                    <div class="android-avatar" style="background:#64748b; width:48px; height:48px; font-size:1.4rem;">📵</div>
                </div>
                <div class="android-caller-name">Wife ❤️</div>
                <div class="android-call-type" style="color:#94a3b8;">Missed Call</div>
                <div class="android-call-subtitle" style="color:#cbd5e1; background:rgba(100, 116, 139, 0.15); border-color:rgba(100, 116, 139, 0.3);">
                    "Missed call from Wife. No items added."
                </div>
            </div>
            <div class="android-gesture-pill"></div>
        `;
        displayMessage("📵 Missed call from Wife", 2200);
        closePhoneWidget(1800);
    };

    const handleDecline = () => {
        if (!wifeCallActive && !wifeCallRinging) return;
        if (wifeCallTimeoutId) {
            clearTimeout(wifeCallTimeoutId);
            wifeCallTimeoutId = null;
        }
        wifeCallRinging = false;
        stopPhoneAudio();

        // 50/50 Gamble when declining call
        const gambleLost = Math.random() < 0.50;

        if (gambleLost) {
            // Gamble Lost: Wife texts and adds 2 items!
            const itemsToAdd = [item1, item2];
            itemsToAdd.forEach(reqItem => {
                const existing = shoppingList.find(li => li?.name === reqItem.name);
                if (existing) {
                    existing.quantity += 1;
                } else {
                    shoppingList.push({
                        name: reqItem.name,
                        quantity: 1,
                        collected: 0
                    });
                }
            });
            updateShoppingListDisplay();

            if (soundEffects && soundEffects.textChime) {
                try {
                    soundEffects.textChime.currentTime = 0;
                    soundEffects.textChime.play().catch(() => {});
                } catch (_) {}
            }
            if (soundEffects && soundEffects.itemAddedToList) {
                try {
                    soundEffects.itemAddedToList.currentTime = 0;
                    soundEffects.itemAddedToList.play().catch(() => {});
                } catch (_) {}
            }

            phoneEl.classList.add('sms-mode');
            phoneEl.innerHTML = `
                <div class="android-top-bar">
                    <span>12:45</span>
                    <div class="android-punchhole"></div>
                    <span>5G 📶 🔋 92%</span>
                </div>
                <div class="android-call-screen">
                    <div class="android-caller-avatar-wrap" style="margin-bottom: 4px;">
                        <div class="android-avatar" style="background:#ef4444; width:48px; height:48px; font-size:1.4rem;">💬</div>
                    </div>
                    <div class="android-caller-name">Wife ❤️</div>
                    <div class="android-call-type" style="color:#ef4444;">New Text Message • Gamble Lost</div>
                    <div class="android-call-subtitle" style="color:#fecaca; background:rgba(239, 68, 68, 0.15); border-color:rgba(239, 68, 68, 0.3);">
                        "Since you declined, please add <strong>${item1.name} & ${item2.name}</strong> to the cart! 😡❤️"
                    </div>
                </div>
                <div class="android-gesture-pill"></div>
            `;
            displayMessage(`📱 Gamble Lost! Wife texted & added ${item1.name} & ${item2.name}!`, 4200, true);
            closePhoneWidget(4500);
        } else {
            // Gamble Won: 0 items added
            phoneEl.innerHTML = `
                <div class="android-top-bar">
                    <span>12:45</span>
                    <div class="android-punchhole"></div>
                    <span>5G 📶 🔋 92%</span>
                </div>
                <div class="android-call-screen">
                    <div class="android-caller-avatar-wrap" style="margin-bottom: 4px;">
                        <div class="android-avatar" style="background:#10b981; width:48px; height:48px; font-size:1.4rem;">🍀</div>
                    </div>
                    <div class="android-caller-name">Wife ❤️</div>
                    <div class="android-call-type" style="color:#10b981;">Call Declined • Gamble Won!</div>
                    <div class="android-call-subtitle" style="color:#d1fae5; background:rgba(16, 185, 129, 0.15); border-color:rgba(16, 185, 129, 0.3);">
                        "Call ended. She didn't text back — no new items added! 🍀"
                    </div>
                </div>
                <div class="android-gesture-pill"></div>
            `;
            displayMessage("🍀 Gamble Won! No items added.", 3500);
            closePhoneWidget(3500);
        }
    };

    const handleAnswer = () => {
        if (!wifeCallActive && !wifeCallRinging) return;
        if (wifeCallTimeoutId) {
            clearTimeout(wifeCallTimeoutId);
            wifeCallTimeoutId = null;
        }
        wifeCallRinging = false;
        stopPhoneAudio();
        wifeCallsAnsweredCount++;
        logRunEvent('📱 Answered your wife\'s call');

        // Add 1 item requested by wife
        const existing = shoppingList.find(li => li?.name === item1.name);
        if (existing) {
            existing.quantity += 1;
        } else {
            shoppingList.push({
                name: item1.name,
                quantity: 1,
                collected: 0
            });
        }
        updateShoppingListDisplay();

        if (soundEffects && soundEffects.itemAddedToList) {
            try {
                soundEffects.itemAddedToList.currentTime = 0;
                soundEffects.itemAddedToList.play().catch(() => {});
            } catch (_) {}
        }

        phoneEl.style.animation = 'none';
        phoneEl.innerHTML = `
            <div class="android-top-bar">
                <span>12:45</span>
                <div class="android-punchhole"></div>
                <span>5G 📶 🔋 92%</span>
            </div>
            <div class="android-call-screen">
                <div class="android-caller-avatar-wrap" style="margin-bottom: 4px;">
                    <div class="android-avatar" style="background:#10b981; width:48px; height:48px; font-size:1.4rem;">📲</div>
                </div>
                <div class="android-caller-name">Wife ❤️</div>
                <div class="android-call-type" style="color:#10b981;">Call Connected (00:04)</div>
                <div class="android-call-subtitle" style="color:#d1fae5; background:rgba(16, 185, 129, 0.15); border-color:rgba(16, 185, 129, 0.3);">
                    "Thanks for answering! Grab some <strong>${item1.name}</strong> for me, love you!"
                </div>
            </div>
            <div class="android-gesture-pill"></div>
        `;
        displayMessage(`📞 Call Answered! Wife added ${item1.name} to shopping list!`, 3500, true);
        closePhoneWidget(4000);
    };

    // Forced click only - wire up click, pointerdown, and touchstart
    const answerBtn = phoneEl.querySelector('#phone-btn-answer');
    if (answerBtn) {
        const onAnswer = (e) => {
            e.stopPropagation();
            e.preventDefault();
            handleAnswer();
        };
        answerBtn.onclick = onAnswer;
        answerBtn.onpointerdown = onAnswer;
        answerBtn.ontouchstart = onAnswer;
    }

    const declineBtn = phoneEl.querySelector('#phone-btn-decline');
    if (declineBtn) {
        const onDecline = (e) => {
            e.stopPropagation();
            e.preventDefault();
            handleDecline();
        };
        declineBtn.onclick = onDecline;
        declineBtn.onpointerdown = onDecline;
        declineBtn.ontouchstart = onDecline;
    }

    // Auto-timeout if ignored: simply closes without adding items or gambling
    const ringTimeoutDuration = 10500;
    wifeCallTimeoutId = setTimeout(() => {
        if (wifeCallActive) {
            handleTimeout();
        }
    }, ringTimeoutDuration);

    return true;
}

// Live view of game state for the thermostat module. Built once and read
// through getters, since it is consulted every frame while the event runs.
let thermostatContext = null;
function thermostatCtx() {
    if (thermostatContext) return thermostatContext;
    thermostatContext = {
        get scene() { return scene; },
        get world() { return world; },
        get navGrid() { return navGrid; },
        isWalkable,
        get shelfUnits() { return shelfUnits; },
        get playerPos() { return playerBody ? playerBody.position : null; },
        get cartPos() { return cartObject ? cartObject.position : null; },
        get soundEffects() { return soundEffects; },
        get paused() { return gamePaused || introCutsceneActive; },
        onEnd: () => displayMessage("🌡️ Thermostat fixed! The store is back to room temperature.", 3500, true)
    };
    return thermostatContext;
}

function triggerThermostatMalfunction() {
    if (!gameStarted || isCheckout || gameOver || Thermo.isThermostatActive()) return false;
    if (!Thermo.startThermostatEvent(thermostatCtx())) return false;
    displayMessage("🌡️ THERMOSTAT MALFUNCTION! It's getting HOT in here... for now.", 5000, true);
    return true;
}

function triggerEarthquakeEvent() {
    if (!gameStarted || isCheckout || gameOver) return false;

    earthquakeOccurred = true;
    earthquakeCount++;
    const quakeDuration = 6000;
    earthquakeTremorsUntil = performance.now() + quakeDuration;

    // Play earthquake rumble audio
    if (soundEffects && soundEffects.earthquake) {
        try {
            soundEffects.earthquake.currentTime = 0;
            soundEffects.earthquake.volume = Math.min(1.0, (CONFIG.SFX_VOLUME || 0.7) * 1.3);
            soundEffects.earthquake.play().catch(() => {});
        } catch (_) {}
    }

    // Trigger visual screen tremor effect (6 seconds)
    const gc = document.getElementById('game-container');
    if (gc) {
        gc.classList.add('earthquake-shake');
        setTimeout(() => {
            gc.classList.remove('earthquake-shake');
        }, quakeDuration);
    }

    displayMessage("⚠️ EARTHQUAKE! Ground tremors are shaking the store shelves!", 5000, true);

    // Panicking customers scatter and flee
    customers.forEach(c => {
        if (typeof makeCustomerFlee === 'function') {
            try { makeCustomerFlee(c, 7000); } catch (_) {}
        }
    });

    // Reorganize only items currently on the store shelves (excluding the checkout gum rack)
    const shelfItems = allItems.filter(item => 
        !item.inCart && 
        !item.inCustomerCart && 
        item !== heldItem && 
        item.mesh && 
        item.mesh.visible && 
        !item.stolen &&
        item.name !== 'Gum' &&
        !item.isCheckoutGum
    );
    if (shelfItems.length > 1) {
        // Collect all slot positions (parent shelf group, local position, local rotation)
        const slots = shelfItems.map(item => ({
            parent: item.mesh.parent,
            position: item.mesh.position.clone(),
            rotation: item.mesh.rotation.clone()
        }));

        // Shuffle slots
        for (let i = slots.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [slots[i], slots[j]] = [slots[j], slots[i]];
        }

        // Relocate each item to its newly scrambled shelf position
        shelfItems.forEach((item, idx) => {
            const targetSlot = slots[idx];
            if (item.mesh.parent !== targetSlot.parent) {
                if (item.mesh.parent) item.mesh.parent.remove(item.mesh);
                if (targetSlot.parent) targetSlot.parent.add(item.mesh);
                else scene.add(item.mesh);
            }
            item.mesh.position.copy(targetSlot.position);
            item.mesh.rotation.copy(targetSlot.rotation);

            // Update item physics body if it exists
            if (item.body) {
                const worldPos = new THREE.Vector3();
                item.mesh.getWorldPosition(worldPos);
                item.body.position.set(worldPos.x, worldPos.y, worldPos.z);
                item.body.quaternion.copy(item.mesh.quaternion);
                item.body.velocity.set(0, 0, 0);
                item.body.angularVelocity.set(0, 0, 0);
            }
        });
    }

    return true;
}

// ---------------------------------------------------------------------------
// NUCLEAR FALLOUT (rarest RNG event). Visuals/audio/timeline live in
// src/nuke.js; this is the glue with customers, the player and game state.
// ---------------------------------------------------------------------------
function isPlayerInRestroom() {
    if (!playerBody) return false;
    const p = playerBody.position;
    return p.x > BATHROOM.x0 + 0.25 && p.x < BATHROOM.x1 - 0.25 &&
        p.z > BATHROOM.z0 + 0.25 && p.z < BATHROOM.z1 - 0.25;
}

function nukeCtx() {
    if (nukeContext) return nukeContext;
    nukeContext = {
        get scene() { return scene; },
        get world() { return world; },
        get camera() { return camera; },
        get lights() { return sceneLights; },
        get paused() { return gamePaused; },
        get keepBodies() { return new Set([...nukeShelterBodies, storeFloorBody, playerBody].filter(Boolean)); },
        get bathroomMats() { return nukeShelterMats; },
        // Fresh model of a store product, for the charred debris in the wasteland.
        makeItemModel: (name) => {
            const tpl = BASE_ITEMS.find(it => it.name === name);
            try { return tpl && typeof tpl.model === 'function' ? tpl.model() : null; } catch (_) { return null; }
        },
        getPlayerPos: () => playerBody ? playerBody.position : null,
        isGameOver: () => gameOver || !gameStarted,
        isInShelter: isPlayerInRestroom,
        onShelteredImpact: () => {
            nukeFreezeRun();
            try { SQ.resetSideQuests(); } catch (_) {}
        },
        onUnshelteredImpact: () => {
            nukeFreezeRun();
            gameOver = true;
            try { controls?.unlock(); } catch (_) {}
        },
        onObliterated: () => {
            gameOver = true;
            endCustomerScuffle(true);
            playFailMusic();
            showShoppingFailureOverlay('Shopping Failed!', 'You got absolutely obliterated by a nuke.');
            try { controls?.unlock(); } catch (_) {}
        },
        onBuildAftermath: () => {
            // Everything but the restroom is about to be wiped from the world.
            if (heldItem) heldItem = null;
            cartAttached = false;
            customers = [];
            document.getElementById('game-container')?.classList.add('nuke-aftermath');
        },
        onSurvived: () => {
            unlockAchievement('nukeSurvivor');
        }
    };
    return nukeContext;
}

// Stop the clock and every other system: nothing else happens from here on.
function nukeFreezeRun() {
    stopRunTimer();
    stopEventRerollCycle();
    cancelScheduledEvents(true);
    if (addItemIntervalId) { clearInterval(addItemIntervalId); addItemIntervalId = null; }
    if (removeItemIntervalId) { clearInterval(removeItemIntervalId); removeItemIntervalId = null; }
    cartRollingRequested = false;
    try { updateCartRollingSound(false); } catch (_) {}
    if (soundEffects?.entranceBeep) { try { soundEffects.entranceBeep.pause(); } catch (_) {} }
}

function triggerNuclearFallout() {
    if (!gameStarted || isCheckout || gameOver || isLonelyStoreMode || Nuke.isNukeActive()) return false;
    if (!Nuke.startNuke(nukeCtx())) return false;

    // Every other event is shut down for the rest of the run.
    stopEventRerollCycle();
    cancelScheduledEvents(true);
    try { endCustomerScuffle(true); } catch (_) {}
    try { endTweakerEvent(); } catch (_) {}
    try { Thermo.resetThermostat(); } catch (_) {}
    try { if (babyCrying) endBabyCrying(); } catch (_) {}
    earthquakeTremorsUntil = 0;
    if (storeClosingInterval) { clearInterval(storeClosingInterval); storeClosingInterval = null; }
    document.getElementById('closing-warning')?.remove();
    document.getElementById('game-container')?.classList.remove('earthquake-shake');
    try { if (soundEffects?.earthquake) soundEffects.earthquake.pause(); } catch (_) {}
    if (wifeCallActive || wifeCallRinging) {
        wifeCallActive = false;
        wifeCallRinging = false;
        phoneEventActive = false;
        removePhoneKeyListener();
        document.getElementById('phone-call-container')?.remove();
        try { if (soundEffects?.phoneRing) soundEffects.phoneRing.pause(); } catch (_) {}
    }
    // The siren replaces the store music.
    try { music?.pause(); } catch (_) {}
    try { customerScuffleMusic?.pause(); } catch (_) {}

    nukePanicCustomers();
    return true;
}

// Customers abandon their carts; about half run for the exit, the rest lose it.
function nukePanicCustomers() {
    const now = performance.now();
    customers.forEach(c => {
        if (!c?.body) return;
        if (c.hasCart && c.cart?.group) {
            c.hasCart = false;
            c.cart.group.rotation.x = 0;
            c.cart.group.rotation.y += (Math.random() - 0.5) * 0.8;
        }
        c.interacting = false;
        c.socialPartner = null;
        c.scufflePartner = null;
        c.walkSpeedBackup = c.walkSpeedBackup || c.walkSpeed;
        const hidden = c.visible === false || c.body.position.y < -5;
        c.nukeMode = hidden ? 'gone' : (Math.random() < 0.5 ? 'leave' : 'crazy');
        c.fleeUntil = now + 1e9;
        c.fleeSpeed = c.nukeMode === 'leave' ? 4.2 + Math.random() * 1.2 : 4.5 + Math.random() * 2.5;
        c.fleeDir = { x: 0, z: 0 };
        c.nukeNextTurn = 0;
        c.nukePath = null;
        c.nukeWaypoint = 0;
    });
}

// Update a customer's flee heading in place (each customer owns its own object).
function setFleeDir(c, x, z) {
    if (c.fleeDir) { c.fleeDir.x = x; c.fleeDir.z = z; }
    else c.fleeDir = { x, z };
}

function updateNukePanic(now) {
    if (!Nuke.isNukeActive() || Nuke.isWorldFrozen()) return;
    updateStaffNukePanic(now);
    for (let i = customers.length - 1; i >= 0; i--) {
        const c = customers[i];
        if (!c?.body || !c.nukeMode) continue;
        const pos = c.body.position;
        if (c.nukeMode === 'gone') { setFleeDir(c, 0, 0); continue; }
        if (c.nukeMode === 'crazy') {
            if (now >= c.nukeNextTurn) {
                const a = Math.random() * Math.PI * 2;
                c.fleeDir = { x: Math.cos(a), z: Math.sin(a) };
                c.nukeNextTurn = now + 350 + Math.random() * 900;
            }
            continue;
        }
        // Leaving: follow a path out through the front doors, then vanish.
        if (!c.nukePath) {
            const door = { x: (Math.random() - 0.5) * 1.5, z: -27.5 };
            const path = navGrid ? (findPath(navGrid, { x: pos.x, z: pos.z }, door) || [door]) : [door];
            c.nukePath = [...path, { x: door.x, z: -33 }, { x: door.x + (Math.random() - 0.5) * 30, z: -60 }];
            c.nukeWaypoint = 0;
        }
        while (c.nukeWaypoint < c.nukePath.length - 1 &&
            Math.hypot(c.nukePath[c.nukeWaypoint].x - pos.x, c.nukePath[c.nukeWaypoint].z - pos.z) < 0.8) c.nukeWaypoint++;
        const tgt = c.nukePath[c.nukeWaypoint];
        const dx = tgt.x - pos.x, dz = tgt.z - pos.z, len = Math.hypot(dx, dz) || 1;
        setFleeDir(c, dx / len, dz / len);
        if (pos.z < -44) {
            // Out of sight: gone for good
            c.nukeMode = 'gone';
            c.visible = false;
            c.body.velocity.set(0, 0, 0);
            c.body.position.set(0, -60, 0);
            c.body.type = CANNON.Body.STATIC;
            c.body.updateMassProperties?.();
        }
    }
}

window.triggerNuclearFallout = triggerNuclearFallout;

function canInteractWithCart() {
    if (!cartObject || !playerBody) return false;
    if (cartAttached) return true;
    const cartPos = new THREE.Vector3();
    cartObject.getWorldPosition(cartPos);
    const dist = playerBody.position.distanceTo(cartPos);
    if (dist <= 3.6) return true;
    if (cart3D) {
        const dir = new THREE.Vector3();
        camera.getWorldDirection(dir);
        sharedRaycaster.set(camera.position, dir);
        const hits = sharedRaycaster.intersectObject(cart3D, true);
        return hits.length > 0 && hits[0].distance <= 4.2;
    }
    return false;
}

// NEW: Spill trip check helpers
function startSpillTripCheckForPlayer() {
    stopSpillTripCheckForPlayer();
    spillTripIntervalPlayer = setInterval(() => {
        if (!playerOnSpill) return;
        // 1-in-3 chance each second; only when cart is attached
        if (cartAttached && Math.random() < (1/3)) {
            triggerTrip();
        }
    }, 1000);
}
function stopSpillTripCheckForPlayer() {
    if (spillTripIntervalPlayer) {
        try { clearInterval(spillTripIntervalPlayer); } catch(_) {}
        spillTripIntervalPlayer = null;
    }
}

function startSpillTripCheckForCustomer(cust) {
    // Avoid duplicates
    if (customerSpillTripIntervals.has(cust)) return;
    const id = setInterval(() => {
        // Light stumble for NPCs with 1-in-3 chance
        if (Math.random() < (1/3)) {
            try {
                // Play slip sound softly
                soundEffects.trip.currentTime = 0;
                soundEffects.trip.play();
            } catch(_) {}
            // Brief upward kick and slowdown
            if (cust.body) {
                cust.body.velocity.y = 3.5;
                cust.walkSpeed = Math.max(0.2, cust.walkSpeed * 0.5);
                // restore speed after short delay
                setTimeout(() => { cust.walkSpeed = (Math.random() * 0.5 + 0.1) * 2; }, 1500);
            }
        }
    }, 1000);
    customerSpillTripIntervals.set(cust, id);
}

function stopSpillTripCheckForCustomer(cust) {
    const id = customerSpillTripIntervals.get(cust);
    if (id) {
        try { clearInterval(id); } catch(_) {}
        customerSpillTripIntervals.delete(cust);
    }
}

function persistUserSettings() {
    const keys = [
        // Graphics / display / lighting / PBR
        'RENDER_QUALITY','LIGHTING_QUALITY','PBR_QUALITY','SCENERY_DETAIL','SHOW_FPS',
        // Audio
        'MUSIC_VOLUME','SFX_VOLUME',
        // Gameplay counts
        'SHELF_COUNT','MIN_SHOPPING_LIST_ITEMS','MAX_SHOPPING_LIST_ITEMS','CUSTOM_RANDOM_SHELVES','CUSTOM_RANDOM_ITEMS',
        // Event chances
        'POWER_OUTAGE_CHANCE','SLIPPERY_FLOOR_CHANCE','STORE_CLOSING_CHANCE','THIEF_BREAK_IN_CHANCE',
        'TWO_IN_ONE_ITEM_CHANCE','EMPTY_SHELF_CHANCE','TRIPPING_CHANCE','NO_MONEY_CHANCE',
        'PRODUCT_SPILL_CHANCE','CHECKOUT_BUTTON_REQUIRED_CHANCE','ADD_ITEM_CHANCE','REMOVE_ITEM_CHANCE',
        'BABY_CRYING_CHANCE','BABY_IN_CART_CHANCE','CHECKOUT_BUSY_CHANCE','POWERUP_CHANCE','FALLING_SHELF_CHANCE','FALLING_SHELF_ENABLED','MISLABELED_ITEM_CHANCE','WEIGHT_CHANGE_CHANCE',
        // Controls
        'LOOK_SENSITIVITY',
        'HIDE_CONTROLS_GUIDE',
        'HIDE_BEST_TIMES',
        'KEYBINDS',
        'CUSTOMER_THEFT_CHANCE',
        // NEW: Under construction zone chance
        'UNDER_CONSTRUCTION_CHANCE',
        // NEW: Manager jumpscare chance
        'MANAGER_JUMPSCARE_CHANCE',
        // NEW: Wife call and Earthquake chances
        'WIFE_CALL_CHANCE',
        'EARTHQUAKE_CHANCE',
        'NUCLEAR_FALLOUT_CHANCE',
        'THERMOSTAT_CHANCE',
        'CUSTOMER_SCUFFLE_CHANCE',
        'TWEAKER_CHANCE'
    ];
    const saved = {};
    keys.forEach(k => { if (CONFIG[k] !== undefined) saved[k] = CONFIG[k]; });
    try { localStorage.setItem('userSettings', JSON.stringify(saved)); } catch (_) {}
}

// NEW: unified handler detacher
function detachAllEventHandlers() {
    try {
        if (keydownHandler) { document.removeEventListener('keydown', keydownHandler); keydownHandler = null; }
        if (keyupHandler) { document.removeEventListener('keyup', keyupHandler); keyupHandler = null; }
        if (windowBlurHandler) { window.removeEventListener('blur', windowBlurHandler); windowBlurHandler = null; }
        if (windowFocusHandler) { window.removeEventListener('focus', windowFocusHandler); windowFocusHandler = null; }
        if (rendererClickHandler && renderer?.domElement) { renderer.domElement.removeEventListener('click', rendererClickHandler); rendererClickHandler = null; }
        if (smoothMouseMoveHandler) { document.removeEventListener('mousemove', smoothMouseMoveHandler); smoothMouseMoveHandler = null; }
    } catch (_) {}
}

// Centralized session cleanup: stop audio, loops, timers, event listeners, physics, animations, and UI overlays
function cleanupSessionResources() {
    clearGlassesBlur();
    clearSpillTracks();
    if (slapHand?.parent) slapHand.parent.remove(slapHand);
    slapHand = null;
    slapActive = false;
    if (cart3D?.userData.playerHands) {
        cart3D.userData.playerHands.left.visible = false;
        cart3D.userData.playerHands.right.visible = false;
    }
    // 1) Stop all audio and loops
    stopAllAudio();

    // 2) Clear all timers/intervals (global brute-force + tracked ones)
    try {
        // Clear timeouts
        const highestTimeoutId = setTimeout(() => {}, 0);
        for (let i = 0; i <= highestTimeoutId; i++) clearTimeout(i);
        // Clear intervals
        const highestIntervalId = setInterval(() => {}, 0);
        for (let i = 0; i <= highestIntervalId; i++) clearInterval(i);
    } catch (_) {}
    cartBabyActionTimerId = null;
    cartBabyAction = null;
    cartBaby = null;
    cartBabyIsGood = false;
    cartBabyHead = null;
    cartBabyPacifier = null;
    cartBabyActionCount = 0;
    cartBabyActionLimit = 0;
    try {
        if (timer) {
            clearInterval(timer);
            timer = null; // ensure new games always restart the timer interval
        }
    } catch(_) {}
    try { if (movementIntervalId) { clearInterval(movementIntervalId); } } catch(_) {}
    try { if (addItemIntervalId) { clearInterval(addItemIntervalId); } } catch(_) {}
    try { if (removeItemIntervalId) { clearInterval(removeItemIntervalId); } } catch(_) {}
    try { if (storeClosingInterval) { clearInterval(storeClosingInterval); } } catch(_) {}
    try { if (checkoutBusyInterval) { clearInterval(checkoutBusyInterval); } } catch(_) {}
    try { if (powerupCountdownInterval) { clearInterval(powerupCountdownInterval); } } catch(_) {}
    try { if (customerTheftIntervalId) { clearInterval(customerTheftIntervalId); } } catch(_) {}
    try { if (managerStompInterval) { clearInterval(managerStompInterval); managerStompInterval = null; } } catch(_) {}

    // 3) Cancel animation loop
    if (animationFrameId) { try { cancelAnimationFrame(animationFrameId); } catch(_) {} animationFrameId = null; }
    animationStarted = false;

    // 4) Detach all event listeners
    try {
        if (keydownHandler) { document.removeEventListener('keydown', keydownHandler); keydownHandler = null; }
        if (keyupHandler) { document.removeEventListener('keyup', keyupHandler); keyupHandler = null; }
        if (windowBlurHandler) { window.removeEventListener('blur', windowBlurHandler); windowBlurHandler = null; }
        if (windowFocusHandler) { window.removeEventListener('focus', windowFocusHandler); windowFocusHandler = null; }
        if (rendererClickHandler && renderer?.domElement) { renderer.domElement.removeEventListener('click', rendererClickHandler); rendererClickHandler = null; }
        // uiClickHandler removed; PauseMenu manages its own bindings
    } catch (_) {}

    // 5) Remove physics world listeners and bodies
    try {
        if (world) {
            if (spillBeginHandler) { world.removeEventListener('beginContact', spillBeginHandler); spillBeginHandler = null; }
            if (spillEndHandler) { world.removeEventListener('endContact', spillEndHandler); spillEndHandler = null; }
            if (globalBeginContactHandler) { world.removeEventListener('beginContact', globalBeginContactHandler); globalBeginContactHandler = null; }
            if (globalEndContactHandler) { world.removeEventListener('endContact', globalEndContactHandler); globalEndContactHandler = null; }
            // Remove all bodies except player (player is re-added later if needed)
            world.bodies.slice().forEach(b => {
                try { world.removeBody(b); } catch(_) {}
            });
        }
    } catch(_) {}
    // Null physics references (fresh world will be built on next start)
    world = null;

    // 6) Dispose of scene content and renderer
    try {
        if (scene) {
            // Remove all meshes/groups added by session
            const children = scene.children.slice();
            children.forEach(ch => {
                try {
                    // Attempt to dispose geometry/material to free GPU memory
                    if (ch.geometry && typeof ch.geometry.dispose === 'function') ch.geometry.dispose();
                    if (ch.material) {
                        const mats = Array.isArray(ch.material) ? ch.material : [ch.material];
                        mats.forEach(m => { try { if (m && typeof m.dispose === 'function') m.dispose(); } catch(_) {} });
                    }
                    scene.remove(ch);
                } catch(_) {}
            });
        }
        // Remove renderer canvas and dispose
        if (renderer) {
            try {
                if (renderer.domElement && renderer.domElement.parentNode) {
                    renderer.domElement.parentNode.removeChild(renderer.domElement);
                }
                renderer.dispose();
                try { renderer.forceContextLoss(); } catch (_) {}
            } catch(_) {}
        }
    } catch(_) {}
    renderer = null;
    scene = null;
    camera = null;

    // Clean up persistent product spills on game reset
    if (productSpills && productSpills.length > 0) {
        productSpills.forEach(sp => {
            if (sp.mesh?.parent) sp.mesh.parent.remove(sp.mesh);
            if (sp.sign?.parent) sp.sign.parent.remove(sp.sign);
            if (sp.body && world) { try { world.removeBody(sp.body); } catch(_) {} }
        });
        productSpills = [];
        productSpill = null;
    }
    playerOnSpill = false;
    playerOnSticky = false;

    // Clean up persistent glass shards on game reset
    if (glassShardsZones && glassShardsZones.length > 0) {
        glassShardsZones.forEach(gz => {
            if (gz.mesh?.parent) gz.mesh.parent.remove(gz.mesh);
        });
        glassShardsZones = [];
    }
    playerOnGlassShards = false;

    // Reset Lonely Store mode & entities
    stopLonelyStoreOminousNotifs();
    if (lonelyStoreStalker && lonelyStoreStalker.parent) {
        try { lonelyStoreStalker.parent.remove(lonelyStoreStalker); } catch(_) {}
    }
    lonelyStoreStalker = null;
    if (playerFlashlight && playerFlashlight.parent) {
        try { playerFlashlight.parent.remove(playerFlashlight); } catch(_) {}
    }
    playerFlashlight = null;
    isLonelyStoreMode = false;

    // Timers have stopped, so remove notifications explicitly before leaving the session.
    clearAllAlertsAndNotifications();

    // 7) Clear UI overlays and transient DOM elements
    [
        'rng-notifications', 'pickup-text', 'pause-menu', 'customer-interaction-message',
        'closing-warning', 'arrest-overlay', 'fake-crash-overlay', 'lonely-ominous-banner', 'manager-warning', 'manager-question', 'manager-jumpscare-overlay'
    ].forEach(id => {
        const el = document.getElementById(id);
        if (el) { try { el.remove(); } catch(_) {} }
    });
    // Power outage overlay is not id-ed; remove by class
    document.querySelectorAll('.power-outage').forEach(el => { try { el.remove(); } catch(_) {} });
    // Baby crying bars/overlay
    document.querySelectorAll('.baby-black-bar').forEach(el => { try { el.remove(); } catch(_) {} });
    const headache = document.querySelector('.baby-headache-overlay'); if (headache) { try { headache.remove(); } catch(_) {} }
    // Busy checkout banner reset
    if (checkoutBusyBanner) checkoutBusyBanner.classList.add('hidden');

    // Clear jumpscare animation and renderer
    managerJumpscareActive = false;
    if (jumpscareAnimId) {
        try { cancelAnimationFrame(jumpscareAnimId); } catch(_) {}
        jumpscareAnimId = null;
    }
    if (jumpscareRenderer) {
        try { jumpscareRenderer.dispose(); } catch(_) {}
        jumpscareRenderer = null;
    }
    jumpscareScene = null;
    jumpscareCamera = null;
    const jsCanvas = document.getElementById('jumpscare-canvas');
    if (jsCanvas) { try { jsCanvas.remove(); } catch(_) {} }
    if (soundEffects && soundEffects.managerJumpscare) {
        try { soundEffects.managerJumpscare.pause(); soundEffects.managerJumpscare.currentTime = 0; } catch(_) {}
    }

    // Clear and reset all random event states
    cancelScheduledEvents();
    powerOutage = false;
    managerActive = false;
    managerApproachActive = false;
    managerQuestionVisible = false;
    managerGroup = null;
    storeClosing = false;
    babyCrying = false;
    slipperyFloor = false;
    cartStuckActive = false;
    cartStuckPull = 0;
    lastMajorEventEndTime = 0;
    // Clear stale customer contact / question state so it can't leak into the next run
    try { touchingCustomers.clear(); } catch (_) {}
    customerQuestionInProgress = false;
    customerQuestionActor = null;

    // NEW: Clear alerts overlay items and timers
    try {
        const alertsStack = document.getElementById('alerts-stack');
        if (alertsStack) alertsStack.innerHTML = '';
        if (messageTimeoutId) { clearTimeout(messageTimeoutId); messageTimeoutId = null; }
        if (typeof displayMessage !== 'undefined') displayMessage._current = null;
    } catch (_) {}

    // 8) Clear entity arrays and references
    try {
        // Items
        allItems.forEach(item => {
            try {
                if (item.mesh && item.mesh.parent) item.mesh.parent.remove(item.mesh);
                if (item.body && world) world.removeBody(item.body);
            } catch(_) {}
        });
    } catch(_) {}
    allItems = [];
    shelves = [];
    shelfUnits = [];
    sampleBooths = [];
    bathroomStallDoor = null;
    bathroomDoor = null;
    customers.forEach(c => {
        try {
            clearCustomerSlapMark(c);
            if (c.parent) c.parent.remove(c);
            if (c.body && world) world.removeBody(c.body);
        } catch(_) {}
    });
    customers = [];
    obstacles = [];
    thief = null;
    policeCarModel = null;

    // 9) Reset gameplay/session flags
    gameStarted = false;
    gamePaused = false;
    gameOver = false;
    isCheckout = false;
    tripped = false;
    cartAttached = true;
    playerOnSpill = false;
    playerOnSticky = false;
    purchaseComplete = false;
    fallingShelfTriggered = false;
    fallingShelfAnim = null;
    currentPowerup = null;
    powerupUsed = false;
    powerupActive = false;
    activeSpeedMultiplier = 1;
    crazyScannerActive = false;
    clearEagleEyeOutlines();
    if (powerupCountdownInterval) { clearInterval(powerupCountdownInterval); powerupCountdownInterval = null; }
    if (superSpeedTimeoutId) { try { clearTimeout(superSpeedTimeoutId); } catch(_) {} superSpeedTimeoutId = null; }
    if (eagleEyeTimeoutId) { try { clearTimeout(eagleEyeTimeoutId); } catch(_) {} eagleEyeTimeoutId = null; }
    if (crazyScannerTimeoutId) { try { clearTimeout(crazyScannerTimeoutId); } catch(_) {} crazyScannerTimeoutId = null; }
    if (extendoArmTimeoutId) { try { clearTimeout(extendoArmTimeoutId); } catch(_) {} extendoArmTimeoutId = null; }
    if (powerupIndicatorEl) powerupIndicatorEl.classList.remove('visible');
    hidePowerupIndicator();
    checkoutButtonAlertShown = false;
    gumCravingActive = false;
    gumCravingSatisfied = false;
    gumCravingEvaluatedThisGame = false;
    gumCravingTriggered = false;
    checkoutExitCooldownUntil = 0;
    if (gumCravingTimeoutId) { try { clearTimeout(gumCravingTimeoutId); } catch(_) {} gumCravingTimeoutId = null; }
    productSpillOccurred = false;
    underConstructionOccurred = false; // NEW: Reset
    thiefEventOccurred = false;
    customerTheftEventsCount = 0;
    customerScuffleCount = 0;
    fallingShelfOccurred = false;
    babyTantrumCount = 0;
    managerQuestionsAsked = 0;
    managerAnsweredYes = 0;
    managerAnsweredNo = 0;
    suppressLockMessage = false;

    // 10) Unlock pointer safely
    try { controls?.unlock(); } catch(_) {}
    controls = null;

    // 11) Clear menu autoplay handlers
    menuAutoplayHandlers.forEach(h => { try { document.removeEventListener(h.type, h.fn); } catch(_) {} });
    menuAutoplayHandlers = [];

    // 12) Reset UI basics
    if (timerElement) timerElement.textContent = "00:00:00.00";
    messageElement?.classList.remove('message-visible');
    checkoutUIElement?.classList.remove('visible');
    if (checkoutUIElement) checkoutUIElement.innerHTML = '';
    gameOverElement?.classList.add('hidden');

    // 13) Clear spill tracking intervals for NPCs/player
    stopSpillTripCheckForPlayer();
    customerSpillTripIntervals.forEach((id) => { try { clearInterval(id); } catch(_) {} });
    customerSpillTripIntervals.clear();
}

function createHandMesh() {
    // compact reusable hand model: palm + four finger strips + thumb
    const g = new THREE.Group();
    const skinMat = new THREE.MeshBasicMaterial({ color: 0xFFCC99, depthTest: false, depthWrite: false });
    const palm = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.4, 0.05), skinMat);
    palm.position.set(0, 0, -0.6);
    g.add(palm);
    // four simple fingers as thin boxes
    for (let i = -1.5; i <= 1.5; i += 1) {
        const f = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.32, 0.05), skinMat);
        f.position.set(i * 0.16, 0.18, -0.55);
        f.rotation.x = -0.12;
        g.add(f);
    }
    const thumb = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.28, 8), skinMat);
    thumb.rotation.z = Math.PI / 2;
    thumb.position.set(0.32, -0.06, -0.6);
    g.add(thumb);
    g.scale.set(1.6, 1.6, 1.6);
    return g;
}

// NEW: attempt theft from player's cart by a touching customer
function tryAttemptCustomerTheft(cust) {
    if (!cust || !cust.body || collectedItems.length === 0 || purchaseComplete) return;
    const chance = plus5PercentPercent(Number.isFinite(CONFIG.CUSTOMER_THEFT_CHANCE) ? CONFIG.CUSTOMER_THEFT_CHANCE : 0);
    if (chance <= 0) return;
    if (Math.random() * 100 >= chance) return;

    // Pick a random item from cart
    const idx = Math.floor(Math.random() * collectedItems.length);
    const item = collectedItems.splice(idx, 1)[0];
    if (!item) return;
    customerTheftEventsCount++;
    logRunEvent('🦹 A customer stole from your cart');

    // Remove from cart state
    item.inCart = false;
    refreshGumCravingState();

    // Adjust shopping list progress (decrement collected for this item if possible)
    const entry = shoppingList.find(row => row.name === item.name);
    if (entry && entry.collected > 0) {
        entry.collected -= 1;
    }
    updateShoppingListDisplay();

    // Ensure item has no physics while held
    if (item.body) {
        try { world.removeBody(item.body); } catch (_) {}
        item.body = null;
    }
    item.isStatic = true;
    item.inCustomerCart = false;
    item.isCustomerHeld = true;

    // Make sure mesh is visible and in scene
    if (item.mesh) {
        try {
            if (item.mesh.parent) item.mesh.parent.remove(item.mesh);
            scene.add(item.mesh);
            item.mesh.visible = true;
            item.mesh.traverse(o => {
                if (o.isMesh && o.material) {
                    (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
                        m.depthTest = true;
                        m.depthWrite = true;
                    });
                }
                o.renderOrder = 0;
            });
        } catch (_) {}
    }

    // If customer already holding something, drop it to the floor
    if (cust.handItem) {
        dropMeshItemToFloor(cust.handItem, cust.body.position.x, cust.body.position.z);
        cust.handItem = null;
    }

    // Attach stolen item to customer's hand
    if (item.mesh) {
        try {
            // Slight downscale for hand-carry
            item.mesh.scale.setScalar(0.8);
        } catch (_) {}
        item.mesh.position.set(0, 1.0, 0.35);
        item.mesh.rotation.set(0, Math.PI / 12, 0);
        cust.add(item.mesh);
        cust.handItem = item;
        const now = performance.now();
        cust.analyzeCooldownUntil = now + (5000 + Math.random() * 5000);
    }

    // Play yoink sound effect
    try {
        if (soundEffects && soundEffects.yoink) {
            soundEffects.yoink.currentTime = 0;
            soundEffects.yoink.play().catch(() => {});
        }
    } catch (_) {}

    // Show prominent visual theft alert overlay
    const theftOverlay = document.getElementById('theft-alert-overlay');
    const theftMsg = document.getElementById('theft-alert-msg');
    if (theftOverlay && theftMsg) {
        theftMsg.innerHTML = `A customer just <strong>YOINKED</strong> your <strong>${item.name || 'item'}</strong> right out of your cart!`;
        theftOverlay.classList.remove('hidden');
        setTimeout(() => {
            if (theftOverlay) theftOverlay.classList.add('hidden');
        }, 4000);
    }

    // Alert message
    displayMessage(`🚨 YOINK! A customer stole ${item.name || 'an item'} from your cart!`, CONFIG.NOTIFICATION_DURATION, true);

    // Make the customer flee for ~5 seconds
    makeCustomerFlee(cust, 5000);
}

// Build unified stats HTML for all events (only show lines that occurred in the current run)
function buildStatsHtml(runMetrics = null, sideQuestStats = null) {
    const lines = [];
    lines.push(`<div class="run-final-time">Final Shopping Time: <strong>${timerElement.textContent || '00:00:00.00'}</strong></div>`);

    // Run summary if available
    if (runMetrics) {
        lines.push(`<strong>List Completion: ${runMetrics.totalCollected} / ${runMetrics.totalRequired} items (${runMetrics.completionPercent}%)</strong>`);
        if (outOfStockListItems.length > 0) {
            lines.push(`<em>Out of stock on shelves: ${outOfStockListItems.join(', ')}</em>`);
        }
    }
    if (sideQuestStats) {
        lines.push(`<strong>Other Tasks</strong>`);
        lines.push(`Restroom: ${sideQuestStats.restroomDone ? 'Done' : 'Incomplete'}`);
        lines.push(`Returns: ${sideQuestStats.returnsDone}/${sideQuestStats.returnsTotal}`);
        if (sideQuestStats.changeCents !== null) {
            lines.push(`Spare Change: $${(Math.min(sideQuestStats.changeCents, 100) / 100).toFixed(2)}/$1.00`);
        }
        lines.push(`Free Samples: ${sideQuestStats.sampleAvailable ? sideQuestStats.sampleEaten + ' eaten' : 'Unavailable'}`);
        lines.push(`Drive Home: ${sideQuestStats.droveHome ? 'Done' : 'Incomplete'}`);
    }

    // Core gameplay stats
    if (footstepCount > 0) lines.push(`Footsteps: ${footstepCount}`);
    if (collectedItems.length > 0) lines.push(`Items in Cart: ${collectedItems.length}`);
    if (tripCount > 0) lines.push(`Times Tripped: ${tripCount}`);
    if (itemsFallenCount > 0) lines.push(`Items Fallen from Cart: ${itemsFallenCount}`);
    if (slapCount > 0) lines.push(`Slaps Delivered: ${slapCount}`);

    // Environmental / RNG events
    if (powerOutageCount > 0) lines.push(`Power Outages: ${powerOutageCount}`);
    if (slipperyFloorCount > 0) lines.push(`Slippery Floor Events: ${slipperyFloorCount}`);
    if (storeClosingCount > 0) lines.push(`Store Closing Event: Triggered`);
    if (productSpillOccurred || productSpillCount > 0) lines.push(`Product Spill Event: Yes`);
    if (underConstructionOccurred) lines.push(`Store Under Construction: Yes`);
    if (fallingShelfOccurred) lines.push(`Falling Shelf Event: Yes`);
    if (thiefEventOccurred) lines.push(`Thief Break‑in: Yes`);
    if (babyTantrumCount > 0) lines.push(`Baby Tantrums: ${babyTantrumCount}`);
    if (wifeCallCount > 0) lines.push(`Calls from Wife: ${wifeCallCount} (Answered: ${wifeCallsAnsweredCount})`);
    if (earthquakeCount > 0 || earthquakeOccurred) lines.push(`Earthquake Tremors: Yes`);
    if (Thermo.thermostatOccurred()) lines.push(`Thermostat Malfunction: Yes`);
    if (managerJumpscareOccurred) lines.push(`Manager Encounter: Yes`);
    if (isLonelyStoreMode) lines.push(`Lonely Store Anomaly: Yes`);
    if (gumCravingTriggered) lines.push(`Gum Craving: ${hasGumInCart() ? 'Satisfied ✨' : 'Triggered'}`);
    if (checkoutBusyOccurred) lines.push(`Busy Checkout Encounter: Yes`);
    if (shelfReplacedCount > 0) lines.push(`Freezer Aisles Discovered: ${shelfReplacedCount}`);
    if (powerupCollectedCount > 0) lines.push(`Powerups Used: ${powerupCollectedCount}`);

    // List manipulation and special items
    if (singleItemList) lines.push(`Single Item List Challenge: Yes`);
    if (emptyShelfEvent) lines.push(`Empty Shelf Event: Yes`);
    if (itemAddedEventCount > 0) lines.push(`Items Added to List: ${itemAddedEventCount}`);
    if (itemRemovedEventCount > 0) lines.push(`Items Removed from List: ${itemRemovedEventCount}`);
    if (twoInOneItemCollected) lines.push(`2‑in‑1 Items Found: Yes`);
    if (mislabeledItemsCount > 0) lines.push(`Mislabeled Items Found: ${mislabeledItemsCount}`);

    // Fail‑related stats
    const wrongInCart = paidListSnapshot ? purchaseWrongItemsCount : countWrongItemsInCart();
    if (wrongInCart > 0) lines.push(`Wrong Items in Cart: ${wrongInCart}`);
    if (walletFailed || noMoneyForGroceries) lines.push(`Forgot Wallet / No Money: Yes`);
    if (customerTheftEventsCount > 0) lines.push(`Items Stolen by Customers: ${customerTheftEventsCount}`);
    if (customerQuestionsCount > 0) lines.push(`Customer Questions: ${customerQuestionsCount}`);
    if (customerScuffleCount > 0) lines.push(`Customer Scuffles: ${customerScuffleCount}`);
    if (managerQuestionsAsked > 0) {
        lines.push(`Manager Questions: ${managerQuestionsAsked}`);
        if (managerAnsweredYes > 0) lines.push(`Manager "Yes" Answers: ${managerAnsweredYes}`);
        if (managerAnsweredNo > 0) lines.push(`Manager "No" Answers: ${managerAnsweredNo}`);
    }

    // Custom game note
    if (!countsForLeaderboard()) {
        lines.push(`<em>This was a customized game (not counted on official leaderboard)</em>`);
    }

    return lines.join('<br>');
}

// Unified modern "Shopping Failed" overlay with shared layout & stats
function showShoppingFailureOverlay(title, subtitle) {
    // Remove any existing failure overlay
    const existing = document.getElementById('store-closed-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'store-closed-overlay';
    overlay.innerHTML = `
        <div class="store-closed-panel">
            <div class="store-closed-title">${title}</div>
            <div class="store-closed-subtitle">${subtitle}</div>
            ${seedBadgeHtml(currentRunSeed)}
            <div class="store-closed-actions">
                <button class="store-closed-btn primary" id="store-closed-restart">Try Again</button>
                <button class="store-closed-btn secondary" id="store-closed-menu">Back to Main Menu</button>
            </div>
        </div>
    `;
    document.getElementById('game-container').appendChild(overlay);

    const restartBtn = document.getElementById('store-closed-restart');
    const menuBtn = document.getElementById('store-closed-menu');

    if (restartBtn) {
        restartBtn.onclick = () => {
            // "Try Again" is a full cold restart, same as pause-menu Restart.
            overlay.remove();
            restartGameCold();
        };
    }
    if (menuBtn) {
        menuBtn.onclick = () => {
            // Go back to main menu from a clean state.
            overlay.remove();
            hardStopGame();
            stopMenuMusic();
            stopFailMusic();
            showMainMenu();
        };
    }
}

// Unified modern "Shopping Complete" overlay sharing the same style as failures
function showShoppingCompleteOverlay(statsHtml, bestTimeMessage = "", runMetrics = null) {
    const existing = document.getElementById('store-closed-overlay');
    if (existing) existing.remove();

    const isPerfect = !runMetrics || runMetrics.missingItems === 0;
    const title = isPerfect ? 'Shopping Complete! 🛒' : 'Shopping Finished! 🛍️';
    const subtitle = isPerfect
        ? 'You collected all items and checked out in record time!'
        : `Checked out with ${runMetrics.totalCollected} of ${runMetrics.totalRequired} items (${runMetrics.completionPercent}%). Some items were out of stock!`;

    const finalTimeStr = timerElement ? (timerElement.textContent || '00:00:00.00') : '00:00:00.00';
    const shoppingCardHtml = `
        <div style="background: rgba(16, 185, 129, 0.15); border-radius: 14px; padding: 14px 18px; margin: 12px 0 16px; border: 1px solid rgba(16, 185, 129, 0.4); text-align: center;">
            <div style="font-size: 0.85rem; font-weight: 800; color: #6ee7b7; letter-spacing: 0.1em; text-transform: uppercase;">
                🛒 FINAL SHOPPING TIME
            </div>
            <div style="font-size: 2.2rem; font-family: monospace; font-weight: 900; color: #34d399; letter-spacing: 0.05em; text-shadow: 0 0 15px rgba(52, 211, 153, 0.5); margin: 4px 0;">
                ${finalTimeStr}
            </div>
            <div style="display: flex; justify-content: space-around; flex-wrap: wrap; gap: 8px; font-size: 0.85rem; margin-top: 4px; opacity: 0.95; color: #cbd5e1;">
                <span>🛒 Items: ${runMetrics ? runMetrics.totalCollected : 0}/${runMetrics ? runMetrics.totalRequired : 0} (${runMetrics ? runMetrics.completionPercent : 100}%)</span>
                <span>⏱️ Best Time Logged</span>
            </div>
        </div>
    `;

    const overlay = document.createElement('div');
    overlay.id = 'store-closed-overlay';
    overlay.innerHTML = `
        <div class="store-closed-panel">
            <div class="store-closed-title">${title}</div>
            <div class="store-closed-subtitle">${subtitle}</div>
            ${shoppingCardHtml}
            <div class="store-closed-stats">
                ${statsHtml}${bestTimeMessage}
            </div>
            ${seedBadgeHtml(currentRunSeed)}
            <div class="store-closed-actions">
                <button class="store-closed-btn primary" id="store-closed-restart">Shop Again</button>
                <button class="store-closed-btn secondary" id="store-closed-menu">Back to Main Menu</button>
            </div>
        </div>
    `;
    document.getElementById('game-container').appendChild(overlay);

    const restartBtn = document.getElementById('store-closed-restart');
    const menuBtn = document.getElementById('store-closed-menu');

    if (restartBtn) {
        restartBtn.onclick = () => {
            // "Shop Again" uses the same cold restart path as all other restart buttons.
            overlay.remove();
            restartGameCold();
        };
    }
    if (menuBtn) {
        menuBtn.onclick = () => {
            overlay.remove();
            hardStopGame();
            stopMenuMusic();
            stopFailMusic();
            showMainMenu();
        };
    }
}

function triggerManagerJumpscare() {
    if (managerActive || !scene || !playerBody || !gameStarted || isCheckout || gameOver) return false;
    managerActive = true;
    managerJumpscareOccurred = true;

    // NEW: Show warning text immediately (2 seconds before manager spawns)
    showManagerWarningText();

    // NEW: Delay actual manager spawn and approach by 2 seconds
    const spawnTimerId = setTimeout(() => {
        if (!managerActive || !scene || !playerBody || !gameStarted || isCheckout || gameOver) {
            managerActive = false;
            return;
        }

        // Create manager model near the edge of the store, aimed at the player
        managerGroup = createManagerModel();
        const spawnRadius = 25;
        const angle = Math.random() * Math.PI * 2;
        const sx = Math.cos(angle) * spawnRadius;
        const sz = Math.sin(angle) * spawnRadius;
        managerGroup.position.set(sx, 0, sz);
        scene.add(managerGroup);

        // Start manager stomp loop quietly; volume will ramp as he approaches
        startManagerStompLoop();

        managerApproachActive = true;
    }, 2000);
    scheduledEventTimeouts.push(spawnTimerId);
    return true;
}

function showManagerWarningText() {
    // Remove any existing warning
    const existing = document.getElementById('manager-warning');
    if (existing) removeEventTextElement(existing);

    const warning = document.createElement('div');
    warning.id = 'manager-warning';
    warning.className = 'event-text-banner manager-warning-banner';
    warning.style.fontSize = '2.2em';
    warning.style.fontWeight = 'bold';
    warning.style.textAlign = 'center';
    warning.style.zIndex = '2005';
    warning.style.pointerEvents = 'none';
    warning.style.fontFamily = 'Comic Sans MS, cursive';
    warning.style.textShadow = '3px 3px 0px #000';
    warning.style.padding = '14px 28px';
    warning.style.borderRadius = '16px';
    warning.style.backgroundColor = 'rgba(0, 40, 20, 0.88)';
    warning.style.border = '2px solid rgba(0, 255, 100, 0.6)';
    warning.textContent = 'THE MANAGER IS COMING';

    placeEventTextElement(warning, true);
    document.getElementById('alerts-overlay').appendChild(warning);

    // Blink animation: alternate between green and pink every 450ms
    let isGreen = true;
    const blinkInterval = setInterval(() => {
        if (!warning || !warning.parentNode) {
            clearInterval(blinkInterval);
            return;
        }
        isGreen = !isGreen;
        warning.style.color = isGreen ? '#00ff66' : '#ff1493';
        warning.style.backgroundColor = isGreen ? 'rgba(0, 40, 20, 0.88)' : 'rgba(50, 0, 30, 0.88)';
        warning.style.borderColor = isGreen ? 'rgba(0, 255, 100, 0.6)' : 'rgba(255, 20, 147, 0.6)';
    }, 450);

    // Store interval ID for cleanup
    warning.blinkInterval = blinkInterval;
}

function hideManagerWarningText() {
    const warning = document.getElementById('manager-warning');
    if (warning) {
        if (warning.blinkInterval) {
            try { clearInterval(warning.blinkInterval); } catch (_) {}
            warning.blinkInterval = null;
        }
        removeEventTextElement(warning);
    }
}

function createManagerModel() {
    const g = new THREE.Group();

    const legHeight = 0.8;
    const torsoHeight = 0.8;
    const headRadius = 0.22;
    const hipY = legHeight;
    const chestY = hipY + torsoHeight / 2;
    const headY = hipY + torsoHeight + headRadius;

    // Legs
    const legGeom = new THREE.CylinderGeometry(0.09, 0.09, legHeight, 12);
    const legMat = new THREE.MeshStandardMaterial({ color: 0x555555 });
    const leftLeg = new THREE.Mesh(legGeom, legMat);
    leftLeg.position.set(-0.18, legHeight / 2, 0);
    const rightLeg = new THREE.Mesh(legGeom, legMat);
    rightLeg.position.set(0.18, legHeight / 2, 0);
    g.add(leftLeg, rightLeg);

    // Torso (bright pink shirt)
    const torsoGeom = new THREE.CylinderGeometry(0.35, 0.3, torsoHeight, 16);
    const torsoMat = new THREE.MeshStandardMaterial({ color: 0xff4aa8 });
    const torso = new THREE.Mesh(torsoGeom, torsoMat);
    torso.position.y = chestY;
    g.add(torso);

    // Head
    const headGeom = new THREE.SphereGeometry(headRadius, 16, 16);
    const headMat = new THREE.MeshStandardMaterial({ color: 0xF1C27D });
    const head = new THREE.Mesh(headGeom, headMat);
    head.position.y = headY;
    g.add(head);

    // Hair
    const hairGeom = new THREE.SphereGeometry(headRadius * 1.05, 16, 16, 0, Math.PI * 2, 0, Math.PI / 2);
    const hairMat = new THREE.MeshStandardMaterial({ color: 0x3b2b24 });
    const hair = new THREE.Mesh(hairGeom, hairMat);
    hair.position.set(0, headY + 0.02, 0);
    g.add(hair);

    // Eyes
    const eyeWhiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const pupilMat = new THREE.MeshStandardMaterial({ color: 0x000000 });
    const eyeR = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 12), eyeWhiteMat);
    const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 12), eyeWhiteMat);
    eyeR.position.set(0.1, headY + 0.02, 0.18);
    eyeL.position.set(-0.1, headY + 0.02, 0.18);
    const pupilR = new THREE.Mesh(new THREE.SphereGeometry(0.025, 12, 12), pupilMat);
    const pupilL = new THREE.Mesh(new THREE.SphereGeometry(0.025, 12, 12), pupilMat);
    pupilR.position.set(0.1, headY + 0.02, 0.21);
    pupilL.position.set(-0.1, headY + 0.02, 0.21);
    g.add(eyeR, eyeL, pupilR, pupilL);

    // Make the manager a bit larger overall
    g.scale.set(1.25, 1.25, 1.25);

    return g;
}

function startManagerFNAFJumpscare() {
    if (managerJumpscareActive || managerQuestionVisible) return;
    managerJumpscareActive = true;
    try { controls?.unlock(); } catch (_) {}

    // 1. Stop stomp audio loop immediately and hide warning text
    stopManagerStompLoop();
    hideManagerWarningText();

    // 2. Play scary FNAF jumpscare screech sound
    if (soundEffects && soundEffects.managerJumpscare) {
        soundEffects.managerJumpscare.currentTime = 0;
        soundEffects.managerJumpscare.volume = Math.min(1.0, (CONFIG.SFX_VOLUME || 0.7) * 1.35);
        soundEffects.managerJumpscare.play().catch(() => {});
    }

    // 3. Hide in-world walking manager group during the jumpscare sequence
    if (managerGroup) {
        managerGroup.visible = false;
    }

    // 4. Create / show translucent blurry background overlay (behind the 3D jumpscare manager)
    let overlay = document.getElementById('manager-jumpscare-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'manager-jumpscare-overlay';
        document.getElementById('game-container').appendChild(overlay);
    }
    overlay.className = 'active';

    // 5. Create dedicated transparent overlay canvas above the 2D blur overlay
    let jsCanvas = document.getElementById('jumpscare-canvas');
    if (!jsCanvas) {
        jsCanvas = document.createElement('canvas');
        jsCanvas.id = 'jumpscare-canvas';
        document.getElementById('game-container').appendChild(jsCanvas);
    }
    jsCanvas.style.display = 'block';

    const w = window.innerWidth;
    const h = window.innerHeight;
    jsCanvas.width = w;
    jsCanvas.height = h;

    if (!jumpscareRenderer) {
        jumpscareRenderer = new THREE.WebGLRenderer({ canvas: jsCanvas, alpha: true, antialias: true });
        jumpscareRenderer.setSize(w, h);
        jumpscareRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    } else {
        jumpscareRenderer.setSize(w, h);
    }

    jumpscareScene = new THREE.Scene();
    jumpscareCamera = new THREE.PerspectiveCamera(46, w / h, 0.1, 100);
    // Camera positioned at upper chest level looking slightly up into face
    jumpscareCamera.position.set(0, 1.40, 1.82);
    jumpscareCamera.lookAt(0, 1.55, 0);

    // Eerie lighting for the 3D jumpscare manager
    const amb = new THREE.AmbientLight(0xffffff, 0.75);
    jumpscareScene.add(amb);

    const redUnderLight = new THREE.PointLight(0xff2244, 4.5, 6.0);
    redUnderLight.position.set(-0.2, 0.5, 1.2);
    jumpscareScene.add(redUnderLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.4);
    dirLight.position.set(1.5, 3.5, 2.5);
    jumpscareScene.add(dirLight);

    // 3D Manager Model (Classic customer with pink shirt and hair, no arms)
    const managerMesh = createManagerModel();
    // Profile angle shot of head & upper shoulders
    managerMesh.rotation.y = 0.26;
    jumpscareScene.add(managerMesh);

    // Animation trajectory: Smooth rise into lower/mid screen framing
    const startY = -2.8;
    const targetY = -0.52; // Lower on the screen: head and upper shoulders in frame
    const startZ = -0.35;
    const targetZ = 0.35;

    managerMesh.position.set(0, startY, startZ);

    const startTime = performance.now();
    const riseDuration = 380; // ms for quick upward lunge
    const totalJumpscareDuration = 1400; // ms before question box appears

    if (jumpscareAnimId) {
        cancelAnimationFrame(jumpscareAnimId);
        jumpscareAnimId = null;
    }

    function animateJumpscare(now) {
        if (!managerJumpscareActive || !jumpscareRenderer || !jumpscareScene || !jumpscareCamera) return;
        const elapsed = now - startTime;
        const progress = Math.min(1.0, elapsed / riseDuration);

        // Smooth cubic-out rise from below upward into lower/mid screen
        const ease = 1 - Math.pow(1 - progress, 3);
        const curY = startY + (targetY - startY) * ease;
        const curZ = startZ + (targetZ - startZ) * ease;

        // FNAF styled jitter / slight shake
        const jitterFactor = (elapsed < totalJumpscareDuration) ? 1.0 : 0.15;
        const shakeX = (Math.sin(elapsed * 0.085) * 0.035 + (Math.random() - 0.5) * 0.02) * jitterFactor;
        const shakeY = (Math.cos(elapsed * 0.095) * 0.025 + (Math.random() - 0.5) * 0.015) * jitterFactor;
        const shakeZ = ((Math.random() - 0.5) * 0.01) * jitterFactor;

        // Angular twitch
        const rotZ = (Math.sin(elapsed * 0.07) * 0.06 + (Math.random() - 0.5) * 0.03) * jitterFactor;
        const rotX = (Math.cos(elapsed * 0.06) * 0.04 + (Math.random() - 0.5) * 0.02) * jitterFactor;
        const rotY = 0.26 + (Math.sin(elapsed * 0.05) * 0.05) * jitterFactor;

        managerMesh.position.set(shakeX, curY + shakeY, curZ + shakeZ);
        managerMesh.rotation.set(rotX, rotY, rotZ);

        jumpscareRenderer.render(jumpscareScene, jumpscareCamera);

        if (elapsed < totalJumpscareDuration) {
            jumpscareAnimId = requestAnimationFrame(animateJumpscare);
        } else {
            // Settle jumpscare and smoothly present the question box
            overlay.className = 'settled';
            showManagerQuestionOverlay();
            // Continue steady render loop while question is open
            function renderSettled() {
                if (!managerJumpscareActive || !jumpscareRenderer || !jumpscareScene || !jumpscareCamera) return;
                jumpscareRenderer.render(jumpscareScene, jumpscareCamera);
                jumpscareAnimId = requestAnimationFrame(renderSettled);
            }
            jumpscareAnimId = requestAnimationFrame(renderSettled);
        }
    }

    jumpscareAnimId = requestAnimationFrame(animateJumpscare);
}

function showManagerQuestionOverlay() {
    if (managerQuestionVisible) return;
    managerQuestionVisible = true;
    try { controls?.unlock(); } catch (_) {}

    // Stop stomp sound and hide warning banner
    stopManagerStompLoop();
    hideManagerWarningText();

    managerQuestionsAsked += 1;
    logRunEvent('👔 The manager asked about your visit');

    const existing = document.getElementById('manager-question');
    if (existing) existing.remove();

    const container = document.createElement('div');
    container.id = 'manager-question';
    container.innerHTML = `
        <div class="manager-q-title">Manager</div>
        <div class="manager-q-badge">SUPERVISOR</div>
        <p class="manager-q-text">Are you enjoying your experience today?</p>
        <div class="manager-q-buttons">
            <button id="manager-yes" class="manager-btn manager-btn-yes">Yes</button>
            <button id="manager-no" class="manager-btn manager-btn-no">No</button>
        </div>
    `;
    document.getElementById('game-container').appendChild(container);

    const btnYes = document.getElementById('manager-yes');
    const btnNo = document.getElementById('manager-no');

    btnYes.onclick = () => {
        handleManagerResponse(true);
    };
    btnNo.onclick = () => {
        handleManagerResponse(false);
    };
}

function hideManagerQuestionOverlay() {
    managerQuestionVisible = false;
    gamePaused = false;
    const container = document.getElementById('manager-question');
    if (container) {
        container.remove();
    }
}

function handleManagerResponse(isYes) {
    hideManagerQuestionOverlay();

    // Clean up jumpscare canvas & animation
    if (jumpscareAnimId) {
        try { cancelAnimationFrame(jumpscareAnimId); } catch (_) {}
        jumpscareAnimId = null;
    }
    if (jumpscareRenderer) {
        try { jumpscareRenderer.clear(); } catch (_) {}
    }
    const jsCanvas = document.getElementById('jumpscare-canvas');
    if (jsCanvas) {
        // Keep the canvas paired with its WebGL renderer for subsequent rolls.
        jsCanvas.style.display = 'none';
    }
    jumpscareScene = null;
    jumpscareCamera = null;

    // Fade out and remove the translucent blur overlay
    const overlay = document.getElementById('manager-jumpscare-overlay');
    if (overlay) {
        overlay.style.opacity = '0';
        setTimeout(() => {
            try { overlay.remove(); } catch (_) {}
        }, 350);
    }
    managerJumpscareActive = false;

    // Position in-world manager directly in front of player facing away to flee
    if (playerBody && camera) {
        const camDir = new THREE.Vector3();
        camera.getWorldDirection(camDir);
        camDir.y = 0;
        if (camDir.lengthSq() > 0.001) camDir.normalize();
        else camDir.set(0, 0, -1);

        if (managerGroup) {
            managerGroup.visible = true;
            managerGroup.position.set(
                playerBody.position.x + camDir.x * 1.5,
                0,
                playerBody.position.z + camDir.z * 1.5
            );
            managerGroup.fleeAngle = Math.atan2(-camDir.z, -camDir.x);
            managerGroup.fleeDist = 0;
            managerGroup.fleeing = true;
            managerApproachActive = false;
            startManagerStompLoop();
        }
    }

    if (isYes) {
        managerAnsweredYes += 1;
        // Manager gives you a random item from the shopping list
        if (shoppingList.length > 0) {
            const unfilled = shoppingList.filter(i => i.collected < i.quantity);
            const pool = unfilled.length ? unfilled : shoppingList;
            const choice = pool[Math.floor(Math.random() * pool.length)];
            if (choice) {
                if (giveManagerGift(choice.name)) {
                    displayMessage(`The manager put a free ${choice.name} in your cart!`, 4500, true);
                } else {
                    displayMessage('The manager was pleased with you!', 3000, true);
                }
            } else {
                displayMessage('The manager was pleased with you!', 3000, true);
            }
        } else {
            displayMessage('The manager was pleased with you!', 3000, true);
        }
    } else {
        managerAnsweredNo += 1;
        // Answering no: run half as slow for 5 seconds
        if (managerSlowTimeoutId) {
            try { clearTimeout(managerSlowTimeoutId); } catch (_) {}
            managerSlowTimeoutId = null;
        }
        currentMoveSpeed = CONFIG.MOVE_SPEED * 0.5;
        displayMessage('The manager was disappointed and you feel yourself moving slower...', 4500, true);
        managerSlowTimeoutId = setTimeout(() => {
            currentMoveSpeed = CONFIG.MOVE_SPEED;
            managerSlowTimeoutId = null;
            displayMessage('You feel back up to your normal speed.', 3000);
        }, 5000);
    }

    // Manager disappears after 5 seconds of fleeing
    setTimeout(() => {
        stopManagerStompLoop();
        if (managerGroup && managerGroup.parent) {
            managerGroup.parent.remove(managerGroup);
        }
        managerGroup = null;
        managerActive = false;
    }, 5000);

    // Resume controls if still in gameplay
    if (gameStarted && !isCheckout && !gameOver) {
        suppressLockMessage = true;
        try { controls.lock(); } catch (_) {}
    }
}

// NEW: Manager stomp audio helpers: overlapping, slightly faster loop
function startManagerStompLoop() {
    if (!soundEffects || !soundEffects.managerStomp) return;
    if (managerStompInterval) return;
    let toggle = 0;
    managerStompInterval = setInterval(() => {
        try {
            const s = toggle === 0 ? soundEffects.managerStomp : soundEffects.managerStomp2 || soundEffects.managerStomp;
            toggle = 1 - toggle;
            if (!s) return;
            s.pause();
            s.currentTime = 0;
            s.playbackRate = 1.2; // a little faster than normal
            
            // NEW: Adjust volume based on distance if manager is fleeing
            let vol = (CONFIG.SFX_VOLUME || 0.7);
            if (managerGroup && managerGroup.fleeing && playerBody) {
                const dist = managerGroup.position.distanceTo(playerBody.position);
                const maxDist = 35; // fade out completely at this distance
                const t = Math.max(0, Math.min(1, dist / maxDist));
                vol = vol * (1 - t); // Decrease volume as distance increases
            }
            s.volume = vol;
            s.play();
        } catch (_) {}
    }, 180); // short interval so stomps overlap slightly
}

function stopManagerStompLoop() {
    try {
        if (managerStompInterval) {
            clearInterval(managerStompInterval);
            managerStompInterval = null;
        }
        if (soundEffects && soundEffects.managerStomp) {
            soundEffects.managerStomp.pause();
            soundEffects.managerStomp.currentTime = 0;
        }
        if (soundEffects && soundEffects.managerStomp2) {
            soundEffects.managerStomp2.pause();
            soundEffects.managerStomp2.currentTime = 0;
        }
    } catch (_) {}
}

// ---- Spectator mode hook (read by src/spectate.js) ----
window.__ssGameState = () => {
    const loadingEl = document.getElementById('loading');
    const loading = !!loadingEl && getComputedStyle(loadingEl).display !== 'none' && !mainMenuVisible;
    return {
        live: !mainMenuVisible && (gameStarted || gameOver || loading || introCutsceneActive),
        started: gameStarted,
        replayEligible: countsForLeaderboard(),
        over: gameOver,
        paused: gamePaused,
        loading,
        renderer: renderer || null,
    };
};
