// The game's sounds. How to work with them (src/audio-engine.js does the playing):
//  - Add a sound: put the file in sfx/ and add it below with createSound('sfx/name.wav'). It behaves like an
//    <audio> element: play(), pause(), volume, loop, currentTime, cloneNode(). Keep it in soundEffects and set
//    its volume from CONFIG.SFX_VOLUME, like the others, so the settings slider reaches it.
//  - The same sound overlapping itself (rapid hits): play sound.cloneNode() instead of the sound.
//  - Long files (music, ambience; over ~15 s): createSound(src, { stream: true, loop: true }), so they stream
//    instead of sitting in memory. Music also goes through registerMusic() in game.js (the mute button).
//  - A sound somewhere in the world: createSound(src, { spatial: true, position: { x, y, z } }): quieter with
//    distance and panned left/right from the camera. setPosition(x, y, z) moves it.
//  - volume above 1 boosts it (the engine's limiter keeps it from clipping).
//  - sfx/pack.mp3 holds the sounds every run uses, loaded at start (list: src/sfx-pack.js). A new sound needn't be
//    in it. If you replace the audio of a file listed there, rebuild the pack (cd tools && npm i && node
//    pack-sfx.mjs) or delete that file's line in src/sfx-pack.js.
//  - Sounds picked on the soundboard (cart, doors, footsteps, item drops): src/sound-picks.js.
import { CONFIG } from '../config.js';
import { createSound } from './audio-engine.js';
import { SOUND_PICKS } from './sound-picks.js';

// Button hover/click sounds: made with the page (not with a run), so the main menu has them too
export const UI_SOUNDS = { uiHover: createSound('sfx/ui_hover.wav'), uiClick: createSound('sfx/ui_click.wav') };
UI_SOUNDS.uiHover.volume = CONFIG.SFX_VOLUME * 0.55;
UI_SOUNDS.uiClick.volume = CONFIG.SFX_VOLUME * 0.8;

export async function safePlay(audio) {
  if (!audio || !audio.src) return;
  try {
    const p = audio.play();
    if (p && typeof p.catch === 'function') {
      await p.catch(() => {});
    }
  } catch (_) {}
}

export function stopAllAudio(music, menuMusic, soundEffects, singles = []) {
  try {
    if (music) { music.pause(); music.currentTime = 0; }
    if (menuMusic) { menuMusic.pause(); menuMusic.currentTime = 0; }
    if (soundEffects) {
      Object.values(soundEffects).forEach(a => {
        try {
          if (a && typeof a.pause === 'function') { a.pause(); a.currentTime = 0; }
        } catch (_) {}
      });
    }
    (singles || []).forEach(a => {
      try { if (a) { a.pause(); a.currentTime = 0; } } catch (_) {}
    });
  } catch (_) {}
}

export function loadSounds({ musicMuted = false } = {}) {
  const soundEffects = {};
  // Pick background music
  const musicFiles = [
    'Shopping.mp3',
    'Cruisin Elavator.mp3',
    'Convenience Store.mp3',
    '28. eShop - Menu (Track 3).mp3',
    "Animal Crossing City Folk OST '11 AM (Normal)' (1).mp3"
  ];
  const chosenMusicFile = musicFiles[Math.floor(Math.random() * musicFiles.length)];
  const music = createSound(chosenMusicFile, { stream: true, loop: true, volume: CONFIG.MUSIC_VOLUME });
  music.muted = musicMuted;

  // Footstep (replacement already wired to FOOT3.mp3)
  soundEffects.footstep = createSound('FOOT3.mp3');
  soundEffects.footstep.volume = CONFIG.SFX_VOLUME * 0.5;
  soundEffects.footstep.playing = false;

  const audioFile = 'footsteps-on-wood-floor-14735.wav';
  soundEffects.grab = createSound(audioFile); soundEffects.grab.volume = CONFIG.SFX_VOLUME;
  // Use the new whu6.wav for accidental drop sound
  soundEffects.drop = createSound('whu6.wav'); soundEffects.drop.volume = CONFIG.SFX_VOLUME;
  soundEffects.checkout = createSound(audioFile); soundEffects.checkout.volume = CONFIG.SFX_VOLUME;
  soundEffects.cartAdd = createSound('sfx/cart_drop.wav'); soundEffects.cartAdd.volume = CONFIG.SFX_VOLUME;
  soundEffects.cartRoll = createSound('sfx/cart_roll.wav');
  soundEffects.cartRoll.loop = true;
  soundEffects.cartRoll.volume = Math.min(1, CONFIG.SFX_VOLUME * 1.4);
  soundEffects.powerOutage = createSound(audioFile); soundEffects.powerOutage.volume = CONFIG.SFX_VOLUME;
  soundEffects.storeClosing = createSound(audioFile); soundEffects.storeClosing.volume = CONFIG.SFX_VOLUME;

  soundEffects.trip = createSound('cartoonslip.mp3'); soundEffects.trip.volume = CONFIG.SFX_VOLUME;
  soundEffects.wrongItem = createSound('run.wav'); soundEffects.wrongItem.volume = CONFIG.SFX_VOLUME;

  soundEffects.cashRegister = createSound('Cash_Register_Open_01.wav'); soundEffects.cashRegister.volume = CONFIG.SFX_VOLUME;
  soundEffects.policeSiren = createSound('20120126_Police Siren Sound Effect.mp3', { stream: true }); soundEffects.policeSiren.volume = CONFIG.SFX_VOLUME;
  soundEffects.productSpill = createSound('20200624_Cartoon Splat sound effect.wav'); soundEffects.productSpill.volume = CONFIG.SFX_VOLUME;
  soundEffects.checkoutScan = createSound('beep2.mp3'); soundEffects.checkoutScan.volume = CONFIG.SFX_VOLUME;
  soundEffects.itemRemoved = createSound('Kerplunk.wav'); soundEffects.itemRemoved.volume = CONFIG.SFX_VOLUME;
  soundEffects.itemAddedToList = createSound('ES_Notification, Attention, Text, Reveal, Positive 01 - Epidemic Sound - 4178-4632.wav'); soundEffects.itemAddedToList.volume = CONFIG.SFX_VOLUME;
  soundEffects.shelfCrash = createSound('crash.wav'); soundEffects.shelfCrash.volume = CONFIG.SFX_VOLUME;
  soundEffects.customerQuestion = createSound('villager.mp3'); soundEffects.customerQuestion.volume = CONFIG.SFX_VOLUME;

  // Baby crying loop (a WAV of BABYCRY.mp3.opus: older Safari can't decode .opus)
  soundEffects.babyCry = createSound('sfx/baby_cry.wav');
  soundEffects.babyCry.volume = CONFIG.SFX_VOLUME;
  soundEffects.babyCry.loop = true;

  // Add a funny slap SFX (cartoony squeak)
  soundEffects.slap = createSound('slap.mp3'); soundEffects.slap.volume = CONFIG.SFX_VOLUME;

  // NEW: Manager stomp loop (starts when manager appears, stops at question)
  // Use two instances so we can overlap them for a denser, faster stomp feel.
  soundEffects.managerStomp = createSound('STOMP2.ogg');
  soundEffects.managerStomp.loop = false;
  soundEffects.managerStomp.volume = 0;
  soundEffects.managerStomp2 = createSound('STOMP2.ogg');
  soundEffects.managerStomp2.loop = false;
  soundEffects.managerStomp2.volume = 0;

  // FNAF styled jumpscare screech SFX
  soundEffects.managerJumpscare = createSound('sfx/fnaf_jumpscare.wav');
  soundEffects.managerJumpscare.volume = Math.min(1.0, (CONFIG.SFX_VOLUME || 0.7) * 1.3);

  // Phone call from wife & text message SFX
  soundEffects.phoneRing = createSound('sfx/phone_ring.wav');
  soundEffects.phoneRing.volume = CONFIG.SFX_VOLUME;
  soundEffects.phoneRing.loop = true;

  soundEffects.textChime = createSound('sfx/text_chime.wav');
  soundEffects.textChime.volume = CONFIG.SFX_VOLUME;

  // Soft UI sounds used by the shared button hover/click handlers.
  Object.assign(soundEffects, UI_SOUNDS);

  // Earthquake rumble SFX
  soundEffects.earthquake = createSound('sfx/earthquake.wav', { stream: true });
  soundEffects.earthquake.volume = Math.min(1.0, (CONFIG.SFX_VOLUME || 0.7) * 1.25);

  soundEffects.thermostatFire = createSound('sfx/thermostat_fire.wav', { stream: true });
  soundEffects.thermostatFire.loop = true;
  soundEffects.thermostatFire.volume = 0;
  soundEffects.thermostatWind = createSound('sfx/thermostat_wind.wav', { stream: true });
  soundEffects.thermostatWind.loop = true;
  soundEffects.thermostatWind.volume = 0;
  soundEffects.thermostatIceCrack = createSound('sfx/thermostat_ice_crack.wav');
  soundEffects.thermostatIceCrack.volume = CONFIG.SFX_VOLUME * 0.55;

  // Amnesia freezer sound effects & shelf replacement
  soundEffects.freezerDoorCreak = createSound('sfx/freezer_door_creak.wav');
  soundEffects.freezerDoorCreak.volume = (CONFIG.SFX_VOLUME || 0.7) * 0.85;
  soundEffects.freezerSealPop = createSound('sfx/freezer_seal_pop.wav');
  soundEffects.freezerSealPop.volume = CONFIG.SFX_VOLUME || 0.7;
  soundEffects.freezerDoorSlam = createSound('sfx/freezer_door_slam.wav');
  soundEffects.freezerDoorSlam.volume = CONFIG.SFX_VOLUME || 0.7;
  soundEffects.freezerHum = createSound('sfx/freezer_hum.wav', { stream: true });
  soundEffects.freezerHum.volume = (CONFIG.SFX_VOLUME || 0.7) * 0.35;
  soundEffects.freezerHum.loop = true;
  soundEffects.shelfReplace = createSound('sfx/shelf_replace.wav');
  soundEffects.shelfReplace.volume = CONFIG.SFX_VOLUME || 0.7;

  // Customer theft yoink SFX
  soundEffects.yoink = createSound('sfx/yoink.wav');
  soundEffects.yoink.volume = CONFIG.SFX_VOLUME || 0.7;

  // Entrance sliding door electronic beep/chime SFX
  soundEffects.entranceBeep = createSound('sfx/entrance_beep.wav');
  soundEffects.entranceBeep.volume = (CONFIG.SFX_VOLUME || 0.7) * 0.9;

  // Sliding doors (picked on the soundboard; game.js times the slide to them)
  for (const [name, job] of [['doorOpen', 'door-open'], ['doorClose', 'door-close']]) {
    // spatial, at the doorway (x 0, z -30): heard from wherever the camera is
    if (SOUND_PICKS[job]) soundEffects[name] = createSound(SOUND_PICKS[job].src, { spatial: { refDistance: 4, maxDistance: 80 }, position: { x: 0, y: 2, z: -30 } });
  }

  // Cart rolling: an empty cart and a loaded one, looped (game.js blends them by how full the cart is),
  // and on top of them rough ground outside and a squeaking wheel while it's stuck
  for (const [name, job] of [['cartRollEmpty', 'cart-roll-empty'], ['cartRollFull', 'cart-roll-full'], ['cartRollRough', 'cart-roll-rough'], ['cartStuckSqueak', 'cart-stuck']]) {
    if (SOUND_PICKS[job]) soundEffects[name] = createSound(SOUND_PICKS[job].src, { loop: true, volume: 0 });
  }

  // Footsteps: a file of single steps each (the store floor, the parking lot); game.js plays one at a time
  for (const [name, job] of [['stepsStore', 'steps-store'], ['stepsLot', 'steps-lot']]) {
    if (SOUND_PICKS[job]) { soundEffects[name] = createSound(SOUND_PICKS[job].src); soundEffects[name].volume = CONFIG.SFX_VOLUME; }
  }

  // The cart bumping into shelves, walls, people (game.js onBump; louder for harder hits)
  if (SOUND_PICKS['cart-bump']) { soundEffects.cartBump = createSound(SOUND_PICKS['cart-bump'].src); soundEffects.cartBump.volume = CONFIG.SFX_VOLUME; }

  // The cart crashing back down after being flung (tripping); spatial, placed where it lands
  if (SOUND_PICKS['cart-crash']) soundEffects.cartCrash = createSound(SOUND_PICKS['cart-crash'].src, { spatial: { refDistance: 6, maxDistance: 60 } });

  // Grabbing / letting go of the cart handle (F)
  if (SOUND_PICKS['cart-handle']) soundEffects.cartHandle = createSound(SOUND_PICKS['cart-handle'].src);

  // Glass shattering SFX
  soundEffects.glassBreak = createSound('sfx/glass_break.wav');
  soundEffects.glassBreak.volume = Math.min(1.0, (CONFIG.SFX_VOLUME || 0.7) * 1.25);

  // Lonely Store ambient low drone SFX
  soundEffects.lowDrone = createSound('sfx/low_drone.wav', { stream: true });
  soundEffects.lowDrone.loop = true;
  soundEffects.lowDrone.volume = 1.0;
  soundEffects.stalkerWhispers = createSound('sfx/stalker_whispers.wav', { stream: true });
  soundEffects.stalkerWhispers.loop = true;
  soundEffects.stalkerWhispers.volume = 0;

  // Preloaded single-fire SFX
  const sfxKey = createSound('key.wav'); sfxKey.volume = CONFIG.SFX_VOLUME;
  const sfxTada = createSound('tada.wav'); sfxTada.volume = CONFIG.SFX_VOLUME;
  const sfxPowerDown = createSound('powerdown.wav', { stream: true }); sfxPowerDown.volume = CONFIG.SFX_VOLUME;
  const sfxAttentionCustomers = createSound('attentioncustomers.wav'); sfxAttentionCustomers.volume = CONFIG.SFX_VOLUME;
  const sfxSqueak = createSound('squeak-duck.mp3'); sfxSqueak.volume = CONFIG.SFX_VOLUME;

  return {
    music,
    soundEffects,
    singles: { sfxKey, sfxTada, sfxPowerDown, sfxAttentionCustomers, sfxSqueak }
  };
}

export function stopMenuMusic(menuMusic) {
  try {
    if (menuMusic) {
      menuMusic.pause();
      menuMusic.currentTime = 0;
    }
  } catch (_) {}
}
