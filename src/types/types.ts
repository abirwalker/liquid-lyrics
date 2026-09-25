export interface LyricsSegment {
  text: string;
  startMs: number | null;
  endMs: number | null;
  role: string | null;
}

export interface LyricsLine {
  text: string;
  timing: 'word' | 'line' | 'none';
  startMs: number | null;
  endMs: number | null;
  segments: LyricsSegment[];
  agent: string | null;
}

export interface LyricsResult {
  source: string;
  instrumental: boolean;
  lines: LyricsLine[];
  cached?: boolean;
}

export interface LyricsQuery {
  song: string;
  artist: string;
  album?: string;
  durationMs?: number;
  spotifyId?: string;
  skipCache?: boolean;
}

export interface LyricsProvider {
  readonly id: string;
  fetch(query: LyricsQuery, signal?: AbortSignal): Promise<LyricsResult | null>;
}

export function hasSyncedLyrics(result: LyricsResult): boolean {
  return !result.instrumental && result.lines.some(line => line.timing !== 'none');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validRange(start: unknown, end: unknown): boolean {
  return (start === null || isTime(start)) &&
    (end === null || (isTime(start) && isTime(end) && end >= start));
}

export function isValidResult(value: unknown): value is LyricsResult {
  if (!isRecord(value) || typeof value.source !== 'string' || !value.source.trim() ||
      typeof value.instrumental !== 'boolean' || !Array.isArray(value.lines)) return false;
  if (value.instrumental) return value.lines.length === 0;
  if (!value.lines.length) return false;
  let previousStart = -1;
  for (const line of value.lines) {
    if (!isRecord(line) || typeof line.text !== 'string' || !line.text.trim() ||
        typeof line.timing !== 'string' || !['word', 'line', 'none'].includes(line.timing) ||
        !validRange(line.startMs, line.endMs) ||
        !(line.agent === null || typeof line.agent === 'string') ||
        !Array.isArray(line.segments) || !line.segments.length) return false;
    if ((line.timing === 'none') !== (line.startMs === null)) return false;
    if (isTime(line.startMs)) {
      if (line.startMs < previousStart) return false;
      previousStart = line.startMs;
    }
    let text = '';
    let timedText = false;
    for (const segment of line.segments) {
      if (!isRecord(segment) || typeof segment.text !== 'string' || !segment.text ||
          !validRange(segment.startMs, segment.endMs) ||
          !(segment.role === null || typeof segment.role === 'string')) return false;
      if (line.timing !== 'word' && segment.startMs !== null) return false;
      if (segment.text.trim() && segment.startMs !== null) timedText = true;
      text += segment.text;
    }
    if (text !== line.text || (line.timing === 'word' && !timedText)) return false;
  }
  return true;
}
