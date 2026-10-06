// Routine confirmations are already communicated by the world, HUD or sound.
// Unknown messages stay visible in Reduced so new objectives aren't silently lost.
const ROUTINE = /^(?:Detached from cart\.|Attached to shopping cart!|Welcome to MagMart!|Picked up (?!\$)|👼 This shopper has ascended|👀 Your eyes have adjusted|Oops! You tripped!|Careful now!|Ugh, peanut butter!|Oops, slippery spill!|⚠️ Crunch!|The wheel popped loose\.|The floor is dry again\.|Store worker restocked |The baby stopped crying\.|You feel back up to your normal speed\.|The manager was pleased with you!|You avoided the manager\.|🍀 Gamble Won!|Music (?:muted|unmuted))/u;

export function shouldShowNotification(mode, message, importance = 'auto') {
    if (mode === 'none') return false;
    if (mode === 'full') return true;
    return importance === 'important' || (importance !== 'routine' && !ROUTINE.test(String(message)));
}
