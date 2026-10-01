export const ICE_SERVERS = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
];

// Spectator-mode UI elements; never mirrored into a spectator's HUD.
export const SPECTATE_UI_IDS = ['ss-open', 'ss-list', 'ss-viewer', 'ss-watchers', 'rp-viewer'];

// Stream quality levels a spectator can pick (height, video bitrate, relay JPEG width).
export const QUALITY = {
    sd: { label: '720p', h: 720, br: 2_500_000, jw: 640 },
    hd: { label: '1080p', h: 1080, br: 6_000_000, jw: 800 },
    max: { label: '1440p', h: 1440, br: 12_000_000, jw: 960 },
};
export const DEFAULT_QUALITY = 'sd';
