import type { LyricsProvider, LyricsQuery, LyricsResult } from '../../types/types';
import { hasSyncedLyrics, isRecord } from '../../types/types';
import { fromTTML } from '../formats';
import { cleanTitle, getPrimaryArtist } from '../cleaner';
import { normalizeMatchText, scoreCandidate, titleArtistCredits } from './matching';
import { fetchFrom, ProviderUnavailable, rethrowIfUnreachable } from './request';

const BINILYRICS_API = 'https://lyrics-api.binimum.org';
const LATIN = /\p{Script=Latin}/u;
const RELEASE_SUFFIX = /\s+(?:[-–—]\s*(?:single|ep)|\((?:single|ep)\))\s*$/i;

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
  return { song, artist };
}

// Regional catalogs can list a Latin-script artist in katakana or hangul, which no
// name comparison can bridge. Accept that only for a solo recording whose exact
// title, release and length all agree, and rank it below every real artist match.
function isTransliteratedSoloMatch(query: LyricsQuery, item: BiniItem): boolean {
  const artist = item.artist_name ?? '';
  if (LATIN.test(artist) || !/\p{L}/u.test(artist) || !LATIN.test(query.artist)) return false;
  if (/[,;&/]|\b(?:feat|ft|with)\b/i.test(query.artist) || titleArtistCredits(query.song).length) return false;
  const release = (album: string | undefined) => normalizeMatchText(album?.replace(RELEASE_SUFFIX, ''));
  if (!query.album || !item.album_name || release(query.album) !== release(item.album_name)) return false;
  if (normalizeMatchText(query.song) !== normalizeMatchText(item.track_name)) return false;
  return typeof query.durationMs === 'number' && typeof item.duration === 'number' &&
    Math.abs(query.durationMs - item.duration * 1000) <= 2000;
}

export function selectBiniItems(
  values: unknown[],
  query: LyricsQuery,
): BiniItem[] {
  const items = values.filter(isBiniItem);
  const mixMarker = /^(?:mixed|dj mix|medley|mash[ -]?up)$|(?:[([]|\s[-–—]\s)\s*(?:mixed|dj mix|medley|mash[ -]?up)\s*(?:[)\]]|$)/i;
  const requestedMix = mixMarker.test(query.song) || mixMarker.test(query.album ?? '');
  const scored = items.map(item => ({ item, score: scoreCandidate(query, {
    titles: [item.track_name ?? ''], artists: [item.artist_name ?? ''],
    albums: item.album_name ? [item.album_name] : [],
    durationMs: typeof item.duration === 'number' ? item.duration * 1000 : undefined,
  }) ?? (isTransliteratedSoloMatch(query, item) ? 0 : null),
  mixed: mixMarker.test(item.track_name ?? '') || mixMarker.test(item.album_name ?? '') }));
  return scored.filter((entry): entry is { item: BiniItem; score: number; mixed: boolean } =>
    entry.score !== null && (requestedMix || !entry.mixed))
    .sort((a, b) => b.score - a.score).map(entry => entry.item);
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
      let found: unknown[];
      const searchDeadline = AbortSignal.any([requestSignal, AbortSignal.timeout(5000)]);
      try {
        const response = await fetchFrom('binilyrics', lookup, { signal: searchDeadline, credentials: 'omit' }, signal);
        if (!response.ok) return null;
        const body: unknown = await response.json();
        const results = isRecord(body) ? body.results : null;
        if (!Array.isArray(results)) return null;
        found = results;
      } catch (error) {
        rethrowIfUnreachable('binilyrics', error, searchDeadline, signal);
        return null;
      }

      let lineFallback: LyricsResult | null = null;
      let staticFallback: LyricsResult | null = null;
      const seen = new Set<string>();
      const failedOrigins = new Set<string>();
      let attempted = 0;

      for (const item of selectBiniItems(found, query)) {
        if (requestSignal.aborted) break;
        let url: URL;
        try {
          url = new URL(item.lyricsUrl ?? '');
        } catch {
          continue;
        }
        if (url.protocol !== 'https:' || url.username || url.password) continue;
        if (failedOrigins.has(url.origin) || seen.has(url.href)) continue;
        if (attempted >= 3) break;
        seen.add(url.href);
        attempted++;
        const deadline = AbortSignal.any([requestSignal, AbortSignal.timeout(5000)]);
        let lyricsResponse: Response;
        try {
          lyricsResponse = await fetchFrom('binilyrics', url, { signal: deadline, credentials: 'omit' }, signal);
        } catch {
          if (requestSignal.aborted) break;
          failedOrigins.add(url.origin);
          continue;
        }
        if (!lyricsResponse.ok) continue;
        try {
          const result = adaptBiniLyrics(await lyricsResponse.text());
          if (requestSignal.aborted) break;
          if (result) {
            if (result.lines.some(line => line.timing === 'word')) return result;
            if (hasSyncedLyrics(result)) lineFallback ??= result;
            else staticFallback ??= result;
          }
        } catch {
          if (requestSignal.aborted) break;
        }
      }
      if (signal?.aborted) return null;
      const best = lineFallback ?? staticFallback;
      // The search found the song, so a lyric file that failed to download is an outage, not a miss.
      if (best || (!failedOrigins.size && !requestSignal.aborted)) return best;
      throw new ProviderUnavailable('binilyrics', 'lyric files could not be downloaded');
    },
  };
}
