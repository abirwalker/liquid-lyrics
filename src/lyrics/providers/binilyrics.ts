import type { LyricsProvider, LyricsQuery, LyricsResult } from '../../types/types';
import { hasSyncedLyrics, isRecord } from '../../types/types';
import { fromTTML } from '../formats';
import { cleanTitle, getPrimaryArtist } from '../cleaner';
import { scoreCandidate } from './matching';

const BINILYRICS_API = 'https://lyrics-api.binimum.org';

interface BiniItem {
  track_name?: string;
  artist_name?: string;
  album_name?: string;
  duration?: number;
  isrc?: string;
  timing_type?: string;
  lyricsUrl?: string;
}

export interface BiniSearchPlan {
  song: string;
  artist: string;
  term: string;
}

function isBiniItem(value: unknown): value is BiniItem {
  if (!isRecord(value)) return false;
  return ['track_name', 'artist_name', 'lyricsUrl'].every(key => typeof value[key] === 'string') &&
    (value.duration === undefined || (typeof value.duration === 'number' && Number.isFinite(value.duration)));
}

export function adaptBiniLyrics(ttml: unknown): LyricsResult | null {
  return fromTTML('binilyrics', ttml);
}

export function createBiniSearchPlan(query: LyricsQuery): BiniSearchPlan | null {
  const song = cleanTitle(query.song?.trim() ?? '');
  const artist = getPrimaryArtist(query.artist?.trim() ?? '');
  if (!song || !artist) return null;
  return { song, artist, term: `${song} ${artist}` };
}

export function selectBiniItems(
  values: unknown[],
  query: LyricsQuery,
): BiniItem[] {
  const items = values.filter(isBiniItem);
  const scored = items.map(item => ({ item, score: scoreCandidate(query, {
    titles: [item.track_name ?? ''], artists: [item.artist_name ?? ''],
    albums: item.album_name ? [item.album_name] : [],
    durationMs: typeof item.duration === 'number' ? item.duration * 1000 : undefined,
  }) }));
  return scored.filter((entry): entry is { item: BiniItem; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score).map(entry => entry.item);
}

export function createBiniSearchQueries(query: LyricsQuery, plan: BiniSearchPlan): string[] {
  const title = query.song.trim();
  const primaryArtist = plan.artist;
  const artists = query.artist.trim();
  return [...new Set([
    plan.term,
    `${plan.song} ${artists}`,
    `${title} ${primaryArtist}`,
    plan.song,
  ].map(value => value.trim()).filter(Boolean))];
}

export function createBiniLyricsProvider(): LyricsProvider {
  return {
    id: 'binilyrics',
    async fetch(query: LyricsQuery, signal?: AbortSignal): Promise<LyricsResult | null> {
      const plan = createBiniSearchPlan(query);
      if (!plan || signal?.aborted) return null;

      const timeout = AbortSignal.timeout(18000);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const lookup = new URL(BINILYRICS_API);
      lookup.searchParams.set('track', plan.song);
      lookup.searchParams.set('artist', plan.artist);
      if (query.durationMs && Number.isFinite(query.durationMs) && query.durationMs > 0) {
        lookup.searchParams.set('duration', String(Math.round(query.durationMs / 1000)));
      }
      const requests = [lookup.href, ...createBiniSearchQueries(query, plan)
        .map(term => `${BINILYRICS_API}/getLyrics?q=${encodeURIComponent(term)}`)];
      let staticFallback: LyricsResult | null = null;
      const seen = new Set<string>();

      for (const requestUrl of requests) {
        if (requestSignal.aborted) return null;
        let found: unknown[];
        try {
          const deadline = AbortSignal.any([requestSignal, AbortSignal.timeout(5000)]);
          const response = await fetch(requestUrl, {
            signal: deadline, credentials: 'omit',
          });
          if (!response.ok) continue;
          const body: unknown = await response.json();
          const results = isRecord(body) ? body.results : null;
          if (!Array.isArray(results)) continue;
          found = results;
        } catch {
          if (requestSignal.aborted) return null;
          continue;
        }

        let attempted = 0;
        for (const item of selectBiniItems(found, query)) {
          if (requestSignal.aborted) return null;
          try {
            const url = new URL(item.lyricsUrl ?? '');
            if (url.protocol !== 'https:' || url.username || url.password) continue;
            if (seen.has(url.href)) continue;
            if (attempted >= 5) break;
            seen.add(url.href);
            attempted++;
            const deadline = AbortSignal.any([requestSignal, AbortSignal.timeout(5000)]);
            const lyricsResponse = await fetch(url, { signal: deadline, credentials: 'omit' });
            if (!lyricsResponse.ok) continue;
            const result = adaptBiniLyrics(await lyricsResponse.text());
            if (requestSignal.aborted) return null;
            if (result) {
              if (hasSyncedLyrics(result)) return result;
              staticFallback ??= result;
            }
          } catch {
            if (requestSignal.aborted) return null;
          }
        }
      }
      return staticFallback;
    },
  };
}
