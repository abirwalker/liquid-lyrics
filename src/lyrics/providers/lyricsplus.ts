import type { LyricsLine, LyricsProvider, LyricsQuery, LyricsResult, LyricsSegment } from '../../types/types';
import { isRecord, isValidResult } from '../../types/types';
import { cleanTitle, getPrimaryArtist } from '../cleaner';
import { scoreCandidate } from './matching';

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
  const result: LyricsResult = { source: 'lyricsplus', instrumental: false, lines };
  return isValidResult(result) ? result : null;
}

export function createLyricsPlusProvider(): LyricsProvider {
  return {
    id: 'lyricsplus',
    async fetch(query: LyricsQuery, signal?: AbortSignal): Promise<LyricsResult | null> {
      const title = cleanTitle(query.song.trim());
      const artist = getPrimaryArtist(query.artist.trim());
      if (!title || !artist || signal?.aborted) return null;
      const params = new URLSearchParams({ title, artist });
      if (query.album) params.set('album', query.album);
      if (query.durationMs && Number.isFinite(query.durationMs) && query.durationMs > 0) {
        params.set('duration', String(Math.round(query.durationMs / 1000)));
      }
      const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000);
      try {
        const response = await fetch(`${API}?${params}`, { signal: deadline, credentials: 'omit' });
        if (!response.ok) return null;
        const result = adaptLyricsPlus(await response.json(), query);
        return deadline.aborted ? null : result;
      } catch {
        return null;
      }
    },
  };
}
