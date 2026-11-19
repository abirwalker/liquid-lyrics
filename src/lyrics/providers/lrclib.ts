import type { LyricsProvider, LyricsQuery, LyricsResult } from '../../types/types';
import { hasSyncedLyrics, isRecord } from '../../types/types';
import { fromLRC, fromPlain } from '../formats';
import { scoreCandidate } from './matching';
import { fetchFrom, rethrowIfUnreachable } from './request';
import { version } from '../../../package.json';

const LRCLIB_API = 'https://lrclib.net/api';
const HEADERS = { 'Lrclib-Client': `LiquidLyrics/${version} (https://github.com/abirwalker/liquid-lyrics)` };

function matchItem(query: LyricsQuery, item: Record<string, unknown>): number | null {
  return scoreCandidate(query, {
    titles: [String(item.trackName ?? item.name ?? '')],
    artists: [String(item.artistName ?? '')],
    albums: [String(item.albumName ?? '')],
    durationMs: typeof item.duration === 'number' ? item.duration * 1000 : undefined,
  });
}

async function request(url: string, requestSignal: AbortSignal, callerSignal?: AbortSignal): Promise<Response> {
  const deadline = AbortSignal.any([requestSignal, AbortSignal.timeout(5000)]);
  return fetchFrom('lrclib', url, { signal: deadline, credentials: 'omit', headers: HEADERS }, callerSignal);
}

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
      const timeout = AbortSignal.timeout(15000);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let fallback: LyricsResult | null = null;
      try {
        const response = await request(`${LRCLIB_API}/get?${params}`, requestSignal, signal);
        if (response.ok) {
          const body: unknown = await response.json();
          const needsArtistValidation = /[,;&]|\b(?:feat|ft|with)\b/i.test(artist) ||
            (isRecord(body) && typeof body.artistName === 'string');
          const result = needsArtistValidation && (!isRecord(body) || matchItem(query, body) === null)
            ? null : adaptLrclib(body, query.durationMs);
          if (result && hasSyncedLyrics(result)) return result;
          fallback = result;
          if (result?.instrumental) return result;
        }
      } catch (error) {
        rethrowIfUnreachable('lrclib', error, requestSignal, signal);
        return null;
      }

      const searchParams = new URLSearchParams({ track_name: song, artist_name: artist });
      for (const search of [searchParams]) {
        if (requestSignal.aborted) return null;
        try {
          const response = await request(`${LRCLIB_API}/search?${search}`, requestSignal, signal);
          if (!response.ok) continue;
          const body: unknown = await response.json();
          if (!Array.isArray(body)) continue;
          const ranked = body.filter(isRecord).map(item => ({ item, score: matchItem(query, item) }))
            .filter((entry): entry is { item: Record<string, unknown>; score: number } => entry.score !== null)
            .sort((a, b) => b.score - a.score).slice(0, 5);
          for (const { item } of ranked) {
            const result = adaptLrclib(item, query.durationMs);
            if (result && hasSyncedLyrics(result)) return result;
            fallback ??= result;
          }
        } catch (error) {
          if (!fallback) rethrowIfUnreachable('lrclib', error, requestSignal, signal);
          return signal?.aborted ? null : fallback;
        }
      }
      return fallback;
    },
  };
}
