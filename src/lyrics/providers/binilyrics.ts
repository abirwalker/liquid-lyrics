import type { LyricsProvider, LyricsQuery, LyricsResult } from '../../types/types';
import { isRecord } from '../../types/types';
import { fromTTML } from '../formats';

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

function isBiniItem(value: unknown): value is BiniItem {
  if (!isRecord(value)) return false;
  return ['track_name', 'artist_name', 'lyricsUrl'].every(key => typeof value[key] === 'string') &&
    (value.duration === undefined || (typeof value.duration === 'number' && Number.isFinite(value.duration)));
}

export function adaptBiniLyrics(ttml: unknown): LyricsResult | null {
  return fromTTML('binilyrics', ttml);
}

export function scoreBiniItem(item: BiniItem, query: LyricsQuery, song: string, artist: string): number {
  const norm = (s: string | undefined) => (s || '').toLowerCase();
  let score = 0;
  if (norm(item.track_name) === song.toLowerCase()) score += 10;
  else if (norm(item.track_name).includes(song.toLowerCase())) score += 5;
  if (norm(item.artist_name) === artist.toLowerCase()) score += 10;
  else if (norm(item.artist_name).includes(artist.toLowerCase())) score += 5;
  if (typeof query.durationMs === 'number' && query.durationMs > 0 && typeof item.duration === 'number') {
    const diff = Math.abs(item.duration - Math.round(query.durationMs / 1000));
    if (diff <= 3) score += 5;
    else if (diff <= 8) score += 2;
  }
  return score;
}

export function createBiniLyricsProvider(): LyricsProvider {
  return {
    id: 'binilyrics',
    async fetch(query: LyricsQuery, signal?: AbortSignal): Promise<LyricsResult | null> {
      const song = query.song?.trim() ?? '';
      const artist = query.artist?.trim() ?? '';
      if (!song || !artist || signal?.aborted) return null;
      const timeout = AbortSignal.timeout(12000);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

      try {
        const res = await fetch(`${BINILYRICS_API}/getLyrics?q=${encodeURIComponent(`${song} ${artist}`)}`, {
          signal: requestSignal, credentials: 'omit',
        });
        if (!res.ok) return null;
        const body: unknown = await res.json();
        const results = isRecord(body) ? body.results : null;
        if (!Array.isArray(results) || results.length === 0) return null;

        const ranked = results.filter(isBiniItem).sort(
          (a, b) => scoreBiniItem(b, query, song, artist) - scoreBiniItem(a, query, song, artist),
        );
        for (const item of ranked.slice(0, 3)) {
          if (requestSignal.aborted) return null;
          try {
            const url = new URL(item.lyricsUrl ?? '');
            if (url.protocol !== 'https:' || url.username || url.password) continue;
            const lyr = await fetch(url, { signal: requestSignal, credentials: 'omit' });
            if (!lyr.ok) continue;
            const result = adaptBiniLyrics(await lyr.text());
            if (requestSignal.aborted) return null;
            if (result) return result;
          } catch {
            if (requestSignal.aborted) return null;
          }
        }
        return null;
      } catch {
        return null;
      }
    },
  };
}
