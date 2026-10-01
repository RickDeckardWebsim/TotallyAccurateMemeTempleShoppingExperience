import { CONFIG } from '../config.js';

export function createCompatibleAudio(sources) {
  const audio = new Audio();
  const test = new Audio();
  const pickSrc = (src) => {
    const ext = src.split('.').pop().toLowerCase();
    let mime = '';
    if (ext === 'mp3') mime = 'audio/mpeg';
    else if (ext === 'wav') mime = 'audio/wav';
    else if (ext === 'ogg') mime = 'audio/ogg';
    else if (ext === 'opus') mime = 'audio/ogg; codecs=opus';
    const canPlay = test.canPlayType(mime);
    return canPlay && canPlay !== '';
  };
  for (const src of sources) {
    if (pickSrc(src)) {
      audio.src = src;
      return audio;
    }
  }
  return audio;
}

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
    'Cruisin Elavator.wav',
    'Convenience Store.mp3',
    '28. eShop - Menu (Track 3).mp3',
    "Animal Crossing City Folk OST '11 AM (Normal)' (1).mp3"
  ];
  const chosenMusicFile = musicFiles[Math.floor(Math.random() * musicFiles.length)];
  const music = new Audio(chosenMusicFile);
  music.loop = true;
  music.volume = CONFIG.MUSIC_VOLUME;
  music.muted = musicMuted;

  // Footstep (replacement already wired to FOOT3.mp3)
  soundEffects.footstep = new Audio('FOOT3.mp3');
  soundEffects.footstep.volume = CONFIG.SFX_VOLUME * 0.5;
  soundEffects.footstep.playing = false;

  const audioFile = 'footsteps-on-wood-floor-14735.wav';
  soundEffects.grab = new Audio(audioFile); soundEffects.grab.volume = CONFIG.SFX_VOLUME;
  // Use the new whu6.wav for accidental drop sound
  soundEffects.drop = new Audio('whu6.wav'); soundEffects.drop.volume = CONFIG.SFX_VOLUME;
  soundEffects.checkout = new Audio(audioFile); soundEffects.checkout.volume = CONFIG.SFX_VOLUME;
  soundEffects.cartAdd = new Audio('sfx/cart_drop.wav'); soundEffects.cartAdd.volume = CONFIG.SFX_VOLUME;
  soundEffects.cartRoll = new Audio('sfx/cart_roll.wav');
  soundEffects.cartRoll.loop = true;
  soundEffects.cartRoll.volume = Math.min(1, CONFIG.SFX_VOLUME * 1.4);
  soundEffects.powerOutage = new Audio(audioFile); soundEffects.powerOutage.volume = CONFIG.SFX_VOLUME;
  soundEffects.storeClosing = new Audio(audioFile); soundEffects.storeClosing.volume = CONFIG.SFX_VOLUME;

  soundEffects.trip = new Audio('cartoonslip.mp3'); soundEffects.trip.volume = CONFIG.SFX_VOLUME;
  soundEffects.wrongItem = new Audio('run.wav'); soundEffects.wrongItem.volume = CONFIG.SFX_VOLUME;

  soundEffects.cashRegister = new Audio('Cash_Register_Open_01.wav'); soundEffects.cashRegister.volume = CONFIG.SFX_VOLUME;
  soundEffects.policeSiren = new Audio('20120126_Police Siren Sound Effect.wav'); soundEffects.policeSiren.volume = CONFIG.SFX_VOLUME;
  soundEffects.productSpill = new Audio('20200624_Cartoon Splat sound effect.wav'); soundEffects.productSpill.volume = CONFIG.SFX_VOLUME;
  soundEffects.checkoutScan = new Audio('beep2.mp3'); soundEffects.checkoutScan.volume = CONFIG.SFX_VOLUME;
  soundEffects.itemRemoved = new Audio('Kerplunk.wav'); soundEffects.itemRemoved.volume = CONFIG.SFX_VOLUME;
  soundEffects.itemAddedToList = new Audio('ES_Notification, Attention, Text, Reveal, Positive 01 - Epidemic Sound - 4178-4632.wav'); soundEffects.itemAddedToList.volume = CONFIG.SFX_VOLUME;
  soundEffects.shelfCrash = new Audio('crash.wav'); soundEffects.shelfCrash.volume = CONFIG.SFX_VOLUME;
  soundEffects.customerQuestion = new Audio('villager.mp3'); soundEffects.customerQuestion.volume = CONFIG.SFX_VOLUME;

  // Baby crying loop (with compatibility)
  soundEffects.babyCry = createCompatibleAudio(['BABYCRY.mp3.opus', 'beep2.mp3']);
  soundEffects.babyCry.volume = CONFIG.SFX_VOLUME;
  soundEffects.babyCry.loop = true;

  // Add a funny slap SFX (cartoony squeak)
  soundEffects.slap = new Audio('slap.mp3'); soundEffects.slap.volume = CONFIG.SFX_VOLUME;

  // NEW: Manager stomp loop (starts when manager appears, stops at question)
  // Use two instances so we can overlap them for a denser, faster stomp feel.
  soundEffects.managerStomp = new Audio('STOMP2.ogg');
  soundEffects.managerStomp.loop = false;
  soundEffects.managerStomp.volume = 0;
  soundEffects.managerStomp2 = new Audio('STOMP2.ogg');
  soundEffects.managerStomp2.loop = false;
  soundEffects.managerStomp2.volume = 0;

  // FNAF styled jumpscare screech SFX
  soundEffects.managerJumpscare = new Audio('sfx/fnaf_jumpscare.wav');
  soundEffects.managerJumpscare.volume = Math.min(1.0, (CONFIG.SFX_VOLUME || 0.7) * 1.3);

  // Phone call from wife & text message SFX
  soundEffects.phoneRing = new Audio('sfx/phone_ring.wav');
  soundEffects.phoneRing.volume = CONFIG.SFX_VOLUME;
  soundEffects.phoneRing.loop = true;

  soundEffects.textChime = new Audio('sfx/text_chime.wav');
  soundEffects.textChime.volume = CONFIG.SFX_VOLUME;

  // Soft UI sounds used by the shared button hover/click handlers.
  soundEffects.uiHover = new Audio('sfx/ui_hover.wav');
  soundEffects.uiHover.volume = CONFIG.SFX_VOLUME * 0.55;
  soundEffects.uiClick = new Audio('sfx/ui_click.wav');
  soundEffects.uiClick.volume = CONFIG.SFX_VOLUME * 0.8;

  // Earthquake rumble SFX
  soundEffects.earthquake = new Audio('sfx/earthquake.wav');
  soundEffects.earthquake.volume = Math.min(1.0, (CONFIG.SFX_VOLUME || 0.7) * 1.25);

  soundEffects.thermostatFire = new Audio('sfx/thermostat_fire.wav');
  soundEffects.thermostatFire.loop = true;
  soundEffects.thermostatFire.volume = 0;
  soundEffects.thermostatWind = new Audio('sfx/thermostat_wind.wav');
  soundEffects.thermostatWind.loop = true;
  soundEffects.thermostatWind.volume = 0;
  soundEffects.thermostatIceCrack = new Audio('sfx/thermostat_ice_crack.wav');
  soundEffects.thermostatIceCrack.volume = CONFIG.SFX_VOLUME * 0.55;

  // Amnesia freezer sound effects & shelf replacement
  soundEffects.freezerDoorCreak = new Audio('sfx/freezer_door_creak.wav');
  soundEffects.freezerDoorCreak.volume = (CONFIG.SFX_VOLUME || 0.7) * 0.85;
  soundEffects.freezerSealPop = new Audio('sfx/freezer_seal_pop.wav');
  soundEffects.freezerSealPop.volume = CONFIG.SFX_VOLUME || 0.7;
  soundEffects.freezerDoorSlam = new Audio('sfx/freezer_door_slam.wav');
  soundEffects.freezerDoorSlam.volume = CONFIG.SFX_VOLUME || 0.7;
  soundEffects.freezerHum = new Audio('sfx/freezer_hum.wav');
  soundEffects.freezerHum.volume = (CONFIG.SFX_VOLUME || 0.7) * 0.35;
  soundEffects.freezerHum.loop = true;
  soundEffects.shelfReplace = new Audio('sfx/shelf_replace.wav');
  soundEffects.shelfReplace.volume = CONFIG.SFX_VOLUME || 0.7;

  // Customer theft yoink SFX
  soundEffects.yoink = new Audio('sfx/yoink.wav');
  soundEffects.yoink.volume = CONFIG.SFX_VOLUME || 0.7;

  // Entrance sliding door electronic beep/chime SFX
  soundEffects.entranceBeep = new Audio('sfx/entrance_beep.wav');
  soundEffects.entranceBeep.volume = (CONFIG.SFX_VOLUME || 0.7) * 0.9;

  // Glass shattering SFX
  soundEffects.glassBreak = new Audio('sfx/glass_break.wav');
  soundEffects.glassBreak.volume = Math.min(1.0, (CONFIG.SFX_VOLUME || 0.7) * 1.25);

  // Lonely Store ambient low drone SFX
  soundEffects.lowDrone = new Audio('sfx/low_drone.wav');
  soundEffects.lowDrone.loop = true;
  soundEffects.lowDrone.volume = 1.0;
  soundEffects.stalkerWhispers = new Audio('sfx/stalker_whispers.wav');
  soundEffects.stalkerWhispers.loop = true;
  soundEffects.stalkerWhispers.volume = 0;

  // Preloaded single-fire SFX
  const sfxKey = new Audio('key.wav'); sfxKey.volume = CONFIG.SFX_VOLUME;
  const sfxTada = new Audio('tada.wav'); sfxTada.volume = CONFIG.SFX_VOLUME;
  const sfxPowerDown = new Audio('powerdown.wav'); sfxPowerDown.volume = CONFIG.SFX_VOLUME;
  const sfxAttentionCustomers = new Audio('attentioncustomers.wav'); sfxAttentionCustomers.volume = CONFIG.SFX_VOLUME;
  const sfxSqueak = new Audio('squeak-duck.mp3'); sfxSqueak.volume = CONFIG.SFX_VOLUME;

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
