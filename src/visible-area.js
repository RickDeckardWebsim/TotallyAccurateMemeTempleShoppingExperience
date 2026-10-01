// websim's phone layout makes the game's frame as tall as the whole screen but hides its bottom behind websim's
// toolbar (about 80 px). No CSS unit can see that from inside the frame; an IntersectionObserver can, since it
// reports how much of the frame is really on screen. --hidden-bottom (px) is that hidden strip (0 wherever the
// frame isn't clipped), and the CSS for things pinned to the bottom adds it.
export function watchHiddenBottom() {
    if (!('IntersectionObserver' in window)) return;
    const probe = document.createElement('div');
    probe.style.cssText = 'position: fixed; inset: 0; pointer-events: none; visibility: hidden';
    document.body.appendChild(probe);
    new IntersectionObserver(([e]) => {
        if (!e.isIntersecting) return; // (scrolled out of view entirely: keep the last value)
        const hidden = Math.max(0, Math.round(innerHeight - e.intersectionRect.bottom));
        document.documentElement.style.setProperty('--hidden-bottom', hidden + 'px');
    }, { threshold: Array.from({ length: 101 }, (_, i) => i / 100) }).observe(probe);
}
