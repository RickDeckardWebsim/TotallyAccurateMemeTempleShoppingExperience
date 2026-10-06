// Main configuration file that imports and combines all modular configs
import { GAME_MECHANICS } from './config/game-mechanics.js';
import { PROBABILITIES } from './config/probabilities.js';
import { GAME_SETTINGS, DEFAULT_KEYBINDS } from './config/game-settings.js';
import { COLORS } from './config/colors.js';
import { ITEM_SETTINGS } from './config/item-settings.js';
import { NOTIFICATION_SETTINGS } from './config/notification-settings.js';
import { SOUND_SETTINGS } from './config/sound-settings.js';

// Export combined configuration
export const CONFIG = {
    ...GAME_MECHANICS,
    ...PROBABILITIES,
    ...GAME_SETTINGS,
    ...COLORS,
    ...ITEM_SETTINGS,
    ...NOTIFICATION_SETTINGS,
    ...SOUND_SETTINGS
};

// Load persisted settings and merge into CONFIG
try {
    const saved = JSON.parse(localStorage.getItem('userSettings') || 'null');
    if (saved && typeof saved === 'object') {
        Object.assign(CONFIG, saved);
        if (saved.KEYBINDS && typeof saved.KEYBINDS === 'object') {
            CONFIG.KEYBINDS = { ...CONFIG.KEYBINDS, ...saved.KEYBINDS };
        }
    }
} catch (_) {}

// Older saves inherit the quieter, simpler defaults. Ignore stale mute bindings.
CONFIG.SIMPLIFIED_CONTROLS = CONFIG.SIMPLIFIED_CONTROLS !== false;
if (!['full', 'reduced', 'none'].includes(CONFIG.POPUP_MODE)) CONFIG.POPUP_MODE = 'reduced';
CONFIG.KEYBINDS = { ...DEFAULT_KEYBINDS, ...(CONFIG.KEYBINDS && typeof CONFIG.KEYBINDS === 'object' ? CONFIG.KEYBINDS : {}) };
delete CONFIG.KEYBINDS.mute;
