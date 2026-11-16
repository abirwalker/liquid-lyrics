export const NO_LYRICS_MESSAGES = [
  "Just vibe. We'll bring the lyrics back next track.",
  "Congratulations, you get a break from singing!",
  "Words would only ruin the masterpiece.",
  "Humming instructions not included.",
  "You're gonna have to guess this one... if it even has one.",
  "No lyrics for this one, just listen.",
  "Make up your own words. Nobody's judging.",
  "All rhythm, zero reading required.",
  "Too mysterious to have written lyrics.",
  "Checked everywhere. Still nothing.",
  "Just nod along like you know every word.",
] as const;

let currentMessage: string | null = null;
let previousMessage: string | null = null;

/** Pick and cache a random no-lyrics message until reset on track change. */
export function getNoLyricsMessage(): string {
  if (!currentMessage) {
    const candidates = previousMessage
      ? NO_LYRICS_MESSAGES.filter((msg) => msg !== previousMessage)
      : NO_LYRICS_MESSAGES;
    const pool = candidates.length > 0 ? candidates : NO_LYRICS_MESSAGES;
    currentMessage = pool[Math.floor(Math.random() * pool.length)];
    previousMessage = currentMessage;
  }
  return currentMessage;
}

/** Clear the cached no-lyrics message so the next track without lyrics picks a fresh line. */
export function resetNoLyricsMessage(): void {
  currentMessage = null;
}
