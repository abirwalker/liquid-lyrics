import type { LyricsProvider, LyricsQuery, LyricsResult } from '../types/types';
import { hasCollapsedTiming, isValidResult, normalizeCollapsedTiming } from '../types/types';
import { createLyricsPlusProvider } from './providers/lyricsplus';
import { createBiniLyricsProvider } from './providers/binilyrics';
import { createAmllProvider } from './providers/amll';
import { createLrclibProvider } from './providers/lrclib';
import { createSpotifyLyricsProvider, isSpotifyInterludeText } from './providers/spotify';
import { defaultCache } from '../storage/cache';
import { cleanTitle, getPrimaryArtist, createCleanQuery } from './cleaner';

export { cleanTitle, getPrimaryArtist, createCleanQuery };

function lyricQuality(result: LyricsResult | null): number {
  if (!result) return -1;
  if (result.instrumental) return 0;
  if (result.lines.some(line => line.timing === 'word')) return 3;
  if (result.lines.some(line => line.timing === 'line')) return 2;
  return 1;
}

type ProviderOutcome = 'unavailable' | 'invalid' | 'instrumental' | 'static' | 'line' | 'word' | 'error';
type ProviderAttempt = { provider: string; outcome: ProviderOutcome; elapsedMs: number };

async function runLyricsChain(
  query: LyricsQuery,
  providers: LyricsProvider[],
  signal?: AbortSignal,
  stopOnLine = false,
  record?: (attempt: ProviderAttempt) => void,
): Promise<LyricsResult | null> {
  let best: LyricsResult | null = null;
  for (const provider of providers) {
    if (signal?.aborted) return null;
    const started = performance.now();
    const report = (outcome: ProviderOutcome) => record?.({
      provider: provider.id, outcome, elapsedMs: Math.round(performance.now() - started),
    });
    try {
      const result = await provider.fetch(query, signal);
      if (signal?.aborted) return null;
      if (!isValidResult(result) || result.source !== provider.id) {
        report(result === null ? 'unavailable' : 'invalid');
        continue;
      }
      const normalized = normalizeCollapsedTiming(result);
      const quality = lyricQuality(normalized);
      report(quality === 3 ? 'word' : quality === 2 ? 'line' : quality === 1 ? 'static' : 'instrumental');
      if (quality === 3 || (stopOnLine && quality === 2)) return normalized;
      if (quality > lyricQuality(best)) best = normalized;
    } catch {
      report('error');
      continue;
    }
  }
  return best;
}

export async function fetchLyricsChain(
  query: LyricsQuery,
  providers: LyricsProvider[],
  signal?: AbortSignal,
  stopOnLine = false,
): Promise<LyricsResult | null> {
  return runLyricsChain(query, providers, signal, stopOnLine);
}

function createProviderTiers(): { primary: LyricsProvider[]; fallback: LyricsProvider[] } {
  return {
    primary: [createBiniLyricsProvider(), createLyricsPlusProvider()],
    fallback: [createSpotifyLyricsProvider(), createAmllProvider(), createLrclibProvider()],
  };
}

export function createDefaultChain(): LyricsProvider[] {
  const { primary, fallback } = createProviderTiers();
  return [...primary, ...fallback];
}

export async function fetchLyrics(
  query: LyricsQuery,
  signal?: AbortSignal,
  cache = defaultCache,
): Promise<LyricsResult | null> {
  const cleanQ = createCleanQuery(query);
  const { primary, fallback } = createProviderTiers();
  const providers = [...primary, ...fallback];
  const attempts: Array<ProviderAttempt & { query: 'original' | 'cleaned' }> = [];
  const reportPath = (selected: LyricsResult | null) => {
    if (attempts.length <= 1 || signal?.aborted) return;
    console.info('[Liquid Lyrics] Provider path:', {
      song: query.song, selected: selected?.source ?? null, attempts,
    });
  };
  const fetchPreferred = async (candidate: LyricsQuery, variant: 'original' | 'cleaned'): Promise<LyricsResult | null> => {
    const record = (attempt: ProviderAttempt) => attempts.push({ ...attempt, query: variant });
    const preferred = await runLyricsChain(candidate, primary, signal, false, record);
    if (signal?.aborted || lyricQuality(preferred) >= 2) return preferred;
    const fallbackResult = await runLyricsChain(candidate, fallback, signal, true, record);
    return lyricQuality(fallbackResult) > lyricQuality(preferred) ? fallbackResult : preferred;
  };
  const readCache = async (candidate: LyricsQuery) => {
    const entry = await cache.get(candidate);
    if (entry.result && (hasCollapsedTiming(entry.result) ||
        (entry.result.source === 'spotify' && entry.result.lines.some(line => isSpotifyInterludeText(line.text))))) {
      await cache.delete(candidate);
      return { hit: false, result: null };
    }
    if (entry.result && !providers.some(provider => provider.id === entry.result!.source)) {
      return { hit: false, result: null };
    }
    return entry;
  };

  let cachedFallback: LyricsResult | null = null;
  if (!query.skipCache && cache) {
    for (const candidate of cleanQ ? [query, cleanQ] : [query]) {
      const cached = await readCache(candidate);
      if (!cached.hit || !cached.result) continue;
      if (lyricQuality(cached.result) === 3) return { ...cached.result, cached: true };
      if (lyricQuality(cached.result) > lyricQuality(cachedFallback)) cachedFallback = cached.result;
    }
    if (cachedFallback && lyricQuality(cachedFallback) === 2) return { ...cachedFallback, cached: true };
  }

  let result = await fetchPreferred(query, 'original');
  if (signal?.aborted) return null;

  if (lyricQuality(result) < 2 && cleanQ) {
    const record = (attempt: ProviderAttempt) => attempts.push({ ...attempt, query: 'cleaned' });
    const cleanResult = await runLyricsChain(cleanQ, fallback.filter(provider => provider.id !== 'spotify'), signal, true, record);
    if (signal?.aborted) return null;
    if (lyricQuality(cleanResult) > lyricQuality(result)) result = cleanResult;
  }

  if (cachedFallback && lyricQuality(cachedFallback) > lyricQuality(result)) {
    const selected = { ...cachedFallback, cached: true };
    reportPath(selected);
    return selected;
  }

  if (cache) {
    if (result !== null) {
      await cache.set(query, result);
      if (cleanQ) await cache.set(cleanQ, result);
    }
  }

  reportPath(result);
  return result;
}
