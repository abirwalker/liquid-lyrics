import type { LyricsProvider, LyricsQuery, LyricsResult } from '../../types/types';
import { isRecord } from '../../types/types';
import { fromTTML } from '../formats';
import { cleanTitle, getPrimaryArtist } from '../cleaner';

const BINILYRICS_API = 'https://lyrics-api.binimum.org';
const CJK_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

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
  titleOnly: boolean;
}

function isBiniItem(value: unknown): value is BiniItem {
  if (!isRecord(value)) return false;
  return ['track_name', 'artist_name', 'lyricsUrl'].every(key => typeof value[key] === 'string') &&
    (value.duration === undefined || (typeof value.duration === 'number' && Number.isFinite(value.duration)));
}

export function adaptBiniLyrics(ttml: unknown): LyricsResult | null {
  return fromTTML('binilyrics', ttml);
}

function normalize(value: string | undefined): string {
  return (value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function createBiniSearchPlan(query: LyricsQuery): BiniSearchPlan | null {
  const song = cleanTitle(query.song?.trim() ?? '');
  const artist = getPrimaryArtist(query.artist?.trim() ?? '');
  if (!song || !artist) return null;
  const titleOnly = CJK_SCRIPT.test(song) && CJK_SCRIPT.test(artist);
  return { song, artist, titleOnly, term: titleOnly ? song : `${song} ${artist}` };
}

export function scoreBiniItem(item: BiniItem, query: LyricsQuery, song: string, artist: string): number {
  const norm = normalize;
  const normalizedSong = norm(song);
  const normalizedArtist = norm(artist);
  let score = 0;
  if (norm(item.track_name) === normalizedSong) score += 10;
  else if (norm(item.track_name).includes(normalizedSong) || normalizedSong.includes(norm(item.track_name))) score += 5;
  if (norm(item.artist_name) === normalizedArtist) score += 10;
  else if (norm(item.artist_name).includes(normalizedArtist) || normalizedArtist.includes(norm(item.artist_name))) score += 5;
  if (query.album && item.album_name) {
    if (norm(item.album_name) === norm(query.album)) score += 3;
    else if (norm(item.album_name).includes(norm(query.album)) || norm(query.album).includes(norm(item.album_name))) score += 1;
  }
  if (typeof query.durationMs === 'number' && query.durationMs > 0 && typeof item.duration === 'number') {
    const diff = Math.abs(item.duration - Math.round(query.durationMs / 1000));
    if (diff <= 3) score += 5;
    else if (diff <= 8) score += 2;
  }
  if (item.timing_type === 'word') score += 2;
  return score;
}

export function selectBiniItems(
  values: unknown[],
  query: LyricsQuery,
  plan: BiniSearchPlan,
): BiniItem[] {
  const items = values.filter(isBiniItem);
  if (plan.titleOnly) {
    if (typeof query.durationMs !== 'number' || !Number.isFinite(query.durationMs) || query.durationMs <= 0) return [];
    const duration = Math.round(query.durationMs / 1000);
    const exact = items.filter(item =>
      normalize(item.track_name) === normalize(plan.song) &&
      typeof item.duration === 'number' && Math.abs(item.duration - duration) <= 3,
    );
    return exact.length === 1 ? exact : [];
  }

  const song = normalize(plan.song);
  const artist = normalize(plan.artist);
  return items.filter(item => {
    const itemSong = normalize(item.track_name);
    const itemArtist = normalize(item.artist_name);
    const titleMatches = itemSong === song || itemSong.includes(song) || song.includes(itemSong);
    const artistMatches = itemArtist === artist || itemArtist.includes(artist) || artist.includes(itemArtist);
    const durationMatches = typeof query.durationMs !== 'number' || typeof item.duration !== 'number' ||
      Math.abs(item.duration - Math.round(query.durationMs / 1000)) <= 8;
    return titleMatches && artistMatches && durationMatches;
  }).sort((a, b) => scoreBiniItem(b, query, plan.song, plan.artist) - scoreBiniItem(a, query, plan.song, plan.artist));
}

export function createBiniLyricsProvider(): LyricsProvider {
  return {
    id: 'binilyrics',
    async fetch(query: LyricsQuery, signal?: AbortSignal): Promise<LyricsResult | null> {
      const plan = createBiniSearchPlan(query);
      if (!plan || signal?.aborted) return null;

      const timeout = AbortSignal.timeout(12000);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

      try {
        const response = await fetch(`${BINILYRICS_API}/getLyrics?q=${encodeURIComponent(plan.term)}`, {
          signal: requestSignal, credentials: 'omit',
        });
        if (!response.ok) return null;
        const body: unknown = await response.json();
        const results = isRecord(body) ? body.results : null;
        if (!Array.isArray(results)) return null;

        for (const item of selectBiniItems(results, query, plan).slice(0, 3)) {
          if (requestSignal.aborted) return null;
          try {
            const url = new URL(item.lyricsUrl ?? '');
            if (url.protocol !== 'https:' || url.username || url.password) continue;
            const lyricsResponse = await fetch(url, { signal: requestSignal, credentials: 'omit' });
            if (!lyricsResponse.ok) continue;
            const result = adaptBiniLyrics(await lyricsResponse.text());
            if (requestSignal.aborted) return null;
            if (result) return result;
          } catch {
            if (requestSignal.aborted) return null;
          }
        }
      } catch {
        return null;
      }
      return null;
    },
  };
}
