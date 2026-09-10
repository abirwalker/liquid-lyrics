import type { LyricsProvider, LyricsQuery, LyricsResult } from '../../types/types';
import { isRecord } from '../../types/types';
import { fromLRC, fromPlain } from '../formats';

const LRCLIB_API = 'https://lrclib.net/api/get';

export function adaptLrclib(body: unknown, durationMs?: number): LyricsResult | null {
  if (!isRecord(body)) return null;
  if (body.instrumental === true) return { source: 'lrclib', instrumental: true, lines: [] };
  return fromLRC('lrclib', body.syncedLyrics, durationMs) ?? fromPlain('lrclib', body.plainLyrics);
}

export function createLrclibProvider(): LyricsProvider {
  return {
    id: 'lrclib',
    async fetch(query: LyricsQuery, signal?: AbortSignal): Promise<LyricsResult | null> {
      const song = query.song.trim();
      const artist = query.artist.trim();
      if (!song || !artist || signal?.aborted) return null;
      const params = new URLSearchParams({ track_name: song, artist_name: artist });
      if (typeof query.durationMs === 'number' && Number.isFinite(query.durationMs) && query.durationMs > 0) {
        params.set('duration', Math.round(query.durationMs / 1000).toString());
      }
      const timeout = AbortSignal.timeout(12000);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        const response = await fetch(`${LRCLIB_API}?${params}`, { signal: requestSignal, credentials: 'omit' });
        if (!response.ok) return null;
        const result = adaptLrclib(await response.json(), query.durationMs);
        return requestSignal.aborted ? null : result;
      } catch {
        return null;
      }
    },
  };
}
