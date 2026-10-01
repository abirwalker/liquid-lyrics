import type { LyricsLine, LyricsProvider, LyricsQuery, LyricsResult, LyricsSegment } from '../../types/types';
import { isRecord, isValidResult, normalizeCollapsedTiming, getSongwriters } from '../../types/types';
import { cleanTitle, getPrimaryArtist } from '../cleaner';
import { normalizeMatchText, scoreCandidate } from './matching';

const API = 'https://lyricsplus.binimum.org/v2/lyrics/get';

function milliseconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function durationMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value * 1000);
  if (typeof value !== 'string' || !/^\d+(?::[0-5]?\d){1,2}(?:\.\d+)?$/.test(value)) return undefined;
  return Math.round(value.split(':').reduce((sum, part) => sum * 60 + Number(part), 0) * 1000);
}

function lineFromBody(value: unknown): LyricsLine | null {
  if (!isRecord(value) || typeof value.text !== 'string' || !value.text.trim()) return null;
  const text = value.text;
  const startMs = milliseconds(value.time);
  const duration = milliseconds(value.duration);
  const endMs = startMs !== null && duration !== null ? startMs + duration : null;
  const rawSyllables = Array.isArray(value.syllabus) ? value.syllabus : [];
  const segments: LyricsSegment[] = rawSyllables.filter(isRecord).map(syllable => {
    const start = milliseconds(syllable.time);
    const length = milliseconds(syllable.duration);
    return {
      text: typeof syllable.text === 'string' ? syllable.text : '',
      startMs: start,
      endMs: start !== null && length !== null ? start + length : null,
      role: null,
    };
  });
  const wordTimed = startMs !== null && segments.length > 0 &&
    segments.every(segment => segment.text && segment.startMs !== null && segment.endMs !== null) &&
    segments.map(segment => segment.text).join('') === text;
  return {
    text,
    timing: startMs === null ? 'none' : wordTimed ? 'word' : 'line',
    startMs,
    endMs,
    segments: wordTimed ? segments : [{ text, startMs: null, endMs: null, role: null }],
    agent: null,
  };
}

export function adaptLyricsPlus(body: unknown, query: LyricsQuery): LyricsResult | null {
  if (!isRecord(body) || !Array.isArray(body.lyrics)) return null;
  const metadata = isRecord(body.metadata) ? body.metadata : null;
  if (!metadata) return null;
  const title = typeof metadata.title === 'string' ? metadata.title : '';
  const artist = typeof metadata.artist === 'string' ? metadata.artist : '';
  const album = typeof metadata.album === 'string' ? metadata.album : '';
  if (scoreCandidate(query, {
    titles: [title], artists: [artist], albums: album ? [album] : [],
    durationMs: durationMs(metadata.totalDuration),
  }) === null) return null;
  const lines = body.lyrics.map(lineFromBody).filter((line): line is LyricsLine => line !== null);
  lines.sort((a, b) => (a.startMs ?? Number.MAX_SAFE_INTEGER) - (b.startMs ?? Number.MAX_SAFE_INTEGER));
  const songwriters = getSongwriters(metadata.songWriters);
  const result: LyricsResult = { source: 'lyricsplus', instrumental: false, lines,
    ...(songwriters.length ? { songwriters } : {}) };
  return isValidResult(result) ? normalizeCollapsedTiming(result) : null;
}

function matchesBroadResult(
  body: unknown, title: string, originalTitle: string, artist: string, expectedDurationMs: number | null,
): boolean {
  if (!isRecord(body) || !isRecord(body.metadata)) return false;
  const metadata = body.metadata;
  const actualDurationMs = durationMs(metadata.totalDuration);
  const actualTitle = typeof metadata.title === 'string' ? normalizeMatchText(cleanTitle(metadata.title)) : '';
  return (actualTitle === normalizeMatchText(title) || actualTitle === normalizeMatchText(originalTitle)) &&
    typeof metadata.artist === 'string' &&
    normalizeMatchText(getPrimaryArtist(metadata.artist)) === normalizeMatchText(artist) &&
    (expectedDurationMs === null || (actualDurationMs !== undefined &&
      Math.abs(actualDurationMs - expectedDurationMs) <= 4000));
}

function lookupTitle(song: string, album?: string): string {
  const title = cleanTitle(song.trim());
  const separator = title.lastIndexOf(' - ');
  if (separator < 1) return title;
  const suffix = normalizeMatchText(title.slice(separator + 3));
  const normalizedAlbum = normalizeMatchText(album);
  return suffix === 'spider man into the spider verse' ||
    (suffix.length >= 8 && normalizedAlbum.startsWith(suffix))
    ? title.slice(0, separator) : title;
}

export function createLyricsPlusProvider(): LyricsProvider {
  return {
    id: 'lyricsplus',
    async fetch(query: LyricsQuery, signal?: AbortSignal): Promise<LyricsResult | null> {
      const title = lookupTitle(query.song, query.album);
      const artist = getPrimaryArtist(query.artist.trim());
      if (!title || !artist || signal?.aborted) return null;
      const params = new URLSearchParams({ title, artist });
      const expectedDurationMs = typeof query.durationMs === 'number' &&
        Number.isFinite(query.durationMs) && query.durationMs > 0
        ? query.durationMs : null;
      const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000);
      try {
        const response = await fetch(`${API}?${params}`, { signal: deadline, credentials: 'omit' });
        if (!response.ok) return null;
        const body: unknown = await response.json();
        if (!matchesBroadResult(body, title, query.song, artist, expectedDurationMs)) return null;
        const result = adaptLyricsPlus(body, query);
        return deadline.aborted ? null : result;
      } catch {
        return null;
      }
    },
  };
}
