import type { LyricsQuery, LyricsResult } from '../types/types';

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

  return {
    song,
    artist,
    album,
    durationMs,
    spotifyId,
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

export function createLyricsController(
  fetcher: (query: LyricsQuery, signal?: AbortSignal) => Promise<LyricsResult | null>,
  logger: LyricsLogger = defaultLogger,
) {
  let activeUri: string | null = null;
  let activeAbort: AbortController | null = null;

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
    if (!query) {
      return;
    }

    const abort = new AbortController();
    activeAbort = abort;

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
        const lineCount = result.lines.length;
        const timingDesc = wordLines > 0 ? `${wordLines}/${lineCount} word-synced lines` : `${lineCount} line-synced lines`;
        const cacheLabel = result.cached ? ' [cached]' : '';
        logger.info(`[Liquid Lyrics] Lyrics provided by: ${result.source}${cacheLabel} (${timingDesc})`);
        logger.info('[Liquid Lyrics] Lyrics data:', result);
      }
    } catch (error: any) {
      if (!abort.signal.aborted) {
        logger.error(`[Liquid Lyrics] Error fetching lyrics for "${query.song}":`, error?.message ?? error);
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
  }

  return {
    onTrackChange,
    destroy,
    getActiveUri: () => activeUri,
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
