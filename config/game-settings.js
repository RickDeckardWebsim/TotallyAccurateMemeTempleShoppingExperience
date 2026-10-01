// General game settings

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

export const DEFAULT_GAME_SETTINGS = {
    // Game settings
    MIN_SHOPPING_LIST_ITEMS: 8,    // Minimum items on shopping list
    MAX_SHOPPING_LIST_ITEMS: 10,   // Maximum items on shopping list
    SHELF_COUNT: 8,                // Number of shelves in the store (base/default; actual game may randomize)
    CUSTOM_RANDOM_SHELVES: false,
    CUSTOM_RANDOM_ITEMS: false,
    RENDER_QUALITY: 'medium',      // 'low' | 'medium' | 'high' | 'ultra'
    LIGHTING_QUALITY: 'high',      // 'low' | 'medium' | 'high' | 'ultra'
    PBR_QUALITY: 'high',           // 'off' | 'low' | 'medium' | 'high'
    SCENERY_DETAIL: 'high',        // 'low' | 'medium' | 'high'
    SHOW_FPS: false,               // Show FPS overlay
    HIDE_CONTROLS_GUIDE: false,    // Hide controls box in game
    HIDE_BEST_TIMES: false,
    KEYBINDS: { ...DEFAULT_KEYBINDS }
};

export let GAME_SETTINGS = {
    ...DEFAULT_GAME_SETTINGS,
    KEYBINDS: { ...DEFAULT_KEYBINDS }
};

export function resetGameSettings() {
    GAME_SETTINGS = {
        ...DEFAULT_GAME_SETTINGS,
        KEYBINDS: { ...DEFAULT_KEYBINDS }
    };
}
