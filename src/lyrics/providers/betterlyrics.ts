import type { LyricsProvider, LyricsQuery, LyricsResult } from '../../types/types';
import { isRecord } from '../../types/types';
import { fromTTML } from '../formats';

export function adaptBetterLyrics(body: unknown): LyricsResult | null {
  if (!isRecord(body)) return null;
  const ttml = typeof body.ttml === 'string' ? body.ttml : body.lyrics;
  return fromTTML('betterlyrics', ttml);
}

export function createBetterLyricsProvider(endpoint = 'http://127.0.0.1:17381/getLyrics'): LyricsProvider {
  return {
    id: 'betterlyrics',
    async fetch(query: LyricsQuery, signal?: AbortSignal): Promise<LyricsResult | null> {
      const song = query.song.trim();
      const artist = query.artist.trim();
      if (!song || !artist || signal?.aborted) return null;
      const base = new URLSearchParams({ s: song, a: artist });
      const detailed = new URLSearchParams(base);
      if (query.album?.trim()) detailed.set('al', query.album.trim());
      if (typeof query.durationMs === 'number' && Number.isFinite(query.durationMs) && query.durationMs > 0) {
        detailed.set('d', String(Math.round(query.durationMs / 1000)));
      }
      const attempts = detailed.toString() === base.toString() ? [base] : [detailed, base];
      const timeout = AbortSignal.timeout(12000);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        for (const params of attempts) {
          const response = await fetch(`${endpoint}?${params}`, { signal: requestSignal, credentials: 'omit' });
          if (!response.ok) {
            if (response.status === 401 || response.status === 404) continue;
            return null;
          }
          const result = adaptBetterLyrics(await response.json());
          if (requestSignal.aborted) return null;
          if (result) return result;
        }
      } catch {
        return null;
      }
      return null;
    },
  };
}
