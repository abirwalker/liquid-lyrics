import type { LyricsProvider, LyricsQuery, LyricsResult } from '../../types/types';
import { isRecord } from '../../types/types';
import { fromTTML } from '../formats';
import { cleanTitle, getPrimaryArtist } from '../cleaner';

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
  else if (norm(item.track_name).includes(song.toLowerCase()) || song.toLowerCase().includes(norm(item.track_name))) score += 5;
  if (norm(item.artist_name) === artist.toLowerCase()) score += 10;
  else if (norm(item.artist_name).includes(artist.toLowerCase()) || artist.toLowerCase().includes(norm(item.artist_name))) score += 5;
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

export function createBiniLyricsProvider(): LyricsProvider {
  return {
    id: 'binilyrics',
    async fetch(query: LyricsQuery, signal?: AbortSignal): Promise<LyricsResult | null> {
      const song = query.song?.trim() ?? '';
      const artist = query.artist?.trim() ?? '';
      if (!song || !artist || signal?.aborted) return null;

      const cleanSong = cleanTitle(song);
      const cleanArtist = getPrimaryArtist(artist);
      const rawSearch = `${song} ${artist}`;
      const cleanSearch = `${cleanSong} ${cleanArtist}`.trim();

      const attempts = [rawSearch];
      if (cleanSearch && cleanSearch.toLowerCase() !== rawSearch.toLowerCase()) {
        attempts.push(cleanSearch);
      }

      const timeout = AbortSignal.timeout(12000);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

      for (const searchTerm of attempts) {
        if (requestSignal.aborted) return null;
        try {
          const res = await fetch(`${BINILYRICS_API}/getLyrics?q=${encodeURIComponent(searchTerm)}`, {
            signal: requestSignal, credentials: 'omit',
          });
          if (!res.ok) continue;
          const body: unknown = await res.json();
          const results = isRecord(body) ? body.results : null;
          if (!Array.isArray(results) || results.length === 0) continue;

          const ranked = results.filter(isBiniItem).sort(
            (a, b) => scoreBiniItem(b, query, cleanSong || song, cleanArtist || artist) -
                      scoreBiniItem(a, query, cleanSong || song, cleanArtist || artist),
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
        } catch {
          continue;
        }
      }
      return null;
    },
  };
}
