import type { LyricsProvider, LyricsQuery, LyricsResult } from '../../types/types';
import { hasSyncedLyrics, isRecord } from '../../types/types';
import { fromTTML } from '../formats';
import { scoreCandidate } from './matching';

const API = 'https://api.amll.dev/v1/lyrics';
const unavailable = new Error('AMLL unavailable');

interface AmllItem {
  id?: number | string;
  filename?: string;
  musicNames?: string[];
  artistNames?: string[];
  albumNames?: string[];
  spotifyIds?: string[];
  lyrics?: string;
}

function itemFromBody(body: unknown): AmllItem | null {
  return isRecord(body) && isRecord(body.data) ? body.data as AmllItem : null;
}

function itemScore(query: LyricsQuery, item: AmllItem): number | null {
  return scoreCandidate(query, {
    titles: Array.isArray(item.musicNames) ? item.musicNames.filter((value): value is string => typeof value === 'string') : [],
    artists: Array.isArray(item.artistNames) ? item.artistNames.filter((value): value is string => typeof value === 'string') : [],
    albums: Array.isArray(item.albumNames) ? item.albumNames.filter((value): value is string => typeof value === 'string') : [],
    spotifyIds: Array.isArray(item.spotifyIds) ? item.spotifyIds.filter((value): value is string => typeof value === 'string') : [],
  });
}

async function request(url: string, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(5000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(url, { signal: requestSignal, credentials: 'omit' });
  if (response.status === 429 || response.status >= 500) throw unavailable;
  return response.ok ? response.json() : null;
}

async function getItem(params: URLSearchParams, signal?: AbortSignal): Promise<AmllItem | null> {
  return itemFromBody(await request(`${API}/get?${params}`, signal));
}

export function createAmllProvider(): LyricsProvider {
  return {
    id: 'amll',
    async fetch(query: LyricsQuery, signal?: AbortSignal): Promise<LyricsResult | null> {
      if (!query.song.trim() || !query.artist.trim() || signal?.aborted) return null;
      let staticFallback: LyricsResult | null = null;
      const accept = (item: AmllItem | null): LyricsResult | null => {
        const result = fromTTML('amll', item?.lyrics);
        if (!result) return null;
        if (hasSyncedLyrics(result)) return result;
        staticFallback ??= result;
        return null;
      };

      if (query.spotifyId?.trim()) {
        try {
          const exact = accept(await getItem(new URLSearchParams({ spotifyId: query.spotifyId.trim() }), signal));
          if (exact || signal?.aborted) return exact;
        } catch (error) {
          if (error === unavailable) return staticFallback;
          if (signal?.aborted) return null;
        }
      }

      try {
        const params = new URLSearchParams({ musicName: query.song, artistName: query.artist.split(',')[0].trim(), pageSize: '8' });
        const search = async (): Promise<AmllItem[]> => {
          const body = await request(`${API}/search?${params}`, signal);
          const data = isRecord(body) && isRecord(body.data) ? body.data : null;
          return data && Array.isArray(data.items) ? data.items.filter(isRecord) as AmllItem[] : [];
        };
        const items = await search();
        const ranked = items.map(item => ({ item, score: itemScore(query, item) }))
          .filter((entry): entry is { item: AmllItem; score: number } => entry.score !== null)
          .sort((a, b) => b.score - a.score).slice(0, 2);
        for (const { item } of ranked) {
          if (signal?.aborted) return null;
          const itemParams = new URLSearchParams();
          if (item.id !== undefined) itemParams.set('id', String(item.id));
          else if (item.filename) itemParams.set('filename', item.filename);
          else continue;
          try {
            const result = accept(await getItem(itemParams, signal));
            if (result) return result;
          } catch (error) {
            if (error === unavailable) return staticFallback;
            if (signal?.aborted) return null;
          }
        }
      } catch (error) {
        if (error === unavailable) return staticFallback;
        if (signal?.aborted) return null;
      }
      return staticFallback;
    },
  };
}
