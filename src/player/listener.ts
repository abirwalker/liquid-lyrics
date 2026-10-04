import type { LyricsQuery, LyricsResult } from '../types/types';
import { getSongwriters } from '../types/types';

export function extractQuery(item: unknown): LyricsQuery | null {
  if (!item || typeof item !== 'object') return null;
  const raw = item as Record<string, any>;

  const meta = raw.metadata;
  if (meta?.is_advertisement === 'true' || meta?.is_advertisement === true) {
    return null;
  }

  const song = (typeof raw.name === 'string' && raw.name.trim()) ||
               (typeof meta?.title === 'string' && meta.title.trim()) || '';

  let artist = '';
  if (Array.isArray(raw.artists) && raw.artists.length > 0) {
    artist = raw.artists
      .map((a: any) => (typeof a?.name === 'string' ? a.name.trim() : ''))
      .filter(Boolean)
      .join(', ');
  }
  if (!artist && typeof meta?.artist_name === 'string') {
    artist = meta.artist_name.trim();
  }

  if (!song || !artist) return null;

  const album = (typeof raw.album?.name === 'string' && raw.album.name.trim()) ||
                (typeof meta?.album_title === 'string' && meta.album_title.trim()) ||
                undefined;

  let durationMs: number | undefined;
  if (typeof raw.duration?.milliseconds === 'number' && Number.isSafeInteger(raw.duration.milliseconds)) {
    durationMs = raw.duration.milliseconds;
  } else if (meta?.duration) {
    const parsed = Number(meta.duration);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      durationMs = parsed;
    }
  }

  let spotifyId: string | undefined;
  if (typeof raw.uri === 'string' && raw.uri.startsWith('spotify:track:')) {
    const parts = raw.uri.split(':');
    if (parts[2]) spotifyId = parts[2];
  }

  const imageUri = typeof meta?.image_url === 'string' && meta.image_url.startsWith('spotify:image:')
    ? meta.image_url
    : undefined;

  return {
    song,
    artist,
    album,
    durationMs,
    spotifyId,
    imageUri,
  };
}

export interface LyricsLogger {
  info(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const defaultLogger: LyricsLogger = {
  info: (msg, ...args) => console.log(msg, ...args),
  error: (msg, ...args) => console.error(msg, ...args),
};

export interface LyricsControllerOptions {
  logger?: LyricsLogger;
  onTrackChangeStarted?: (item: unknown, query: LyricsQuery | null) => void;
  onLyricsLoaded?: (result: LyricsResult | null, query: LyricsQuery) => void;
}

export interface LyricsState {
  readonly item: unknown;
  readonly query: LyricsQuery | null;
  readonly status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';
  readonly result: LyricsResult | null;
  readonly error: string | null;
}

export function createLyricsController(
  fetcher: (query: LyricsQuery, signal?: AbortSignal) => Promise<LyricsResult | null>,
  loggerOrOptions: LyricsLogger | LyricsControllerOptions = defaultLogger,
) {
  const logger: LyricsLogger =
    typeof (loggerOrOptions as any)?.info === 'function'
      ? (loggerOrOptions as LyricsLogger)
      : (loggerOrOptions as LyricsControllerOptions)?.logger ?? defaultLogger;

  const callbacks =
    typeof (loggerOrOptions as any)?.info === 'function'
      ? {}
      : (loggerOrOptions as LyricsControllerOptions);

  let activeUri: string | null = null;
  let activeAbort: AbortController | null = null;
  let state: LyricsState = Object.freeze({ item: null, query: null, status: 'idle', result: null, error: null });
  const subscribers = new Set<(state: LyricsState) => void>();

  function notify(subscriber: (state: LyricsState) => void) {
    try {
      subscriber(state);
    } catch (error) {
      logger.error('[Liquid Lyrics] View update failed:', error);
    }
  }

  function publish(next: LyricsState) {
    state = Object.freeze(next);
    const published = state;
    for (const subscriber of [...subscribers]) {
      if (state !== published) break;
      if (subscribers.has(subscriber)) notify(subscriber);
    }
  }

  function subscribe(subscriber: (state: LyricsState) => void) {
    subscribers.add(subscriber);
    notify(subscriber);
    return () => { subscribers.delete(subscriber); };
  }

  function setSongwriters(query: LyricsQuery, names: string[]) {
    const songwriters = getSongwriters(names);
    if (state.query !== query || !state.result || state.result.instrumental ||
        state.result.songwriters?.length || !songwriters.length) return;
    publish({ ...state, result: { ...state.result, songwriters } });
  }

  async function onTrackChange(item: unknown) {
    const raw = item as Record<string, any> | null;
    const uri = typeof raw?.uri === 'string' ? raw.uri : null;

    if (uri && uri === activeUri) {
      return;
    }

    if (activeAbort) {
      activeAbort.abort();
      activeAbort = null;
    }

    activeUri = uri;

    const query = extractQuery(item);
    const abort = query ? new AbortController() : null;
    activeAbort = abort;
    publish({ item, query, status: query ? 'loading' : 'idle', result: null, error: null });
    callbacks.onTrackChangeStarted?.(item, query);

    if (!query || !abort || abort.signal.aborted || activeAbort !== abort) {
      return;
    }

    logger.info(`[Liquid Lyrics] Track changed: ${query.artist} - ${query.song}`);
    logger.info('[Liquid Lyrics] Fetching lyrics for:', {
      song: query.song,
      artist: query.artist,
      album: query.album,
      durationMs: query.durationMs,
      spotifyId: query.spotifyId,
    });

    try {
      const result = await fetcher(query, abort.signal);
      if (abort.signal.aborted) return;

      if (!result) {
        logger.info(`[Liquid Lyrics] No lyrics found for "${query.song}" by ${query.artist}`);
      } else if (result.instrumental) {
        const cacheLabel = result.cached ? ' [cached]' : '';
        logger.info(`[Liquid Lyrics] Instrumental track (provided by: ${result.source}${cacheLabel})`);
        logger.info('[Liquid Lyrics] Lyrics data:', result);
      } else {
        const wordLines = result.lines.filter((l) => l.timing === 'word').length;
        const syncedLines = result.lines.filter((l) => l.timing === 'line').length;
        const lineCount = result.lines.length;
        const timingDesc = wordLines > 0 ? `${wordLines}/${lineCount} word-synced lines`
          : syncedLines > 0 ? `${syncedLines}/${lineCount} line-synced lines`
            : `${lineCount} static lines`;
        const cacheLabel = result.cached ? ' [cached]' : '';
        logger.info(`[Liquid Lyrics] Lyrics provided by: ${result.source}${cacheLabel} (${timingDesc})`);
        logger.info('[Liquid Lyrics] Lyrics data:', result);
      }

      publish({ item, query, status: result ? 'ready' : 'unavailable', result, error: null });
      if (!abort.signal.aborted) callbacks.onLyricsLoaded?.(result, query);
    } catch (error: any) {
      if (!abort.signal.aborted) {
        logger.error(`[Liquid Lyrics] Error fetching lyrics for "${query.song}":`, error?.message ?? error);
        publish({ item, query, status: 'error', result: null,
          error: error instanceof Error ? error.message : String(error) });
        callbacks.onLyricsLoaded?.(null, query);
      }
    } finally {
      if (activeAbort === abort) {
        activeAbort = null;
      }
    }
  }

  function destroy() {
    if (activeAbort) {
      activeAbort.abort();
      activeAbort = null;
    }
    activeUri = null;
    publish({ item: null, query: null, status: 'idle', result: null, error: null });
    subscribers.clear();
  }

  return {
    onTrackChange,
    destroy,
    getActiveUri: () => activeUri,
    getState: () => state,
    subscribe,
    setSongwriters,
  };
}

export function initPlayerListener(
  controller: ReturnType<typeof createLyricsController>,
  spicetify: any = (globalThis as any).Spicetify,
) {
  if (!spicetify?.Player) {
    throw new Error('Spicetify.Player is not available');
  }

  const handler = (event?: any) => {
    const item = event?.data?.item ?? spicetify.Player.data?.item;
    controller.onTrackChange(item);
  };

  spicetify.Player.addEventListener('songchange', handler);

  const currentItem = spicetify.Player.data?.item;
  if (currentItem) {
    controller.onTrackChange(currentItem);
  }

  return () => {
    spicetify.Player.removeEventListener('songchange', handler);
    controller.destroy();
  };
}
