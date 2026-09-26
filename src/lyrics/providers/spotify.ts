import type { LyricsProvider, LyricsQuery, LyricsResult, LyricsLine } from '../../types/types';
import { isRecord, isValidResult } from '../../types/types';

export function adaptSpotifyLyrics(body: unknown, durationMs?: number): LyricsResult | null {
  if (!isRecord(body) || !isRecord(body.lyrics)) return null;

  const lyrics = body.lyrics;
  const rawLines = Array.isArray(lyrics.lines) ? lyrics.lines : null;
  if (!rawLines || rawLines.length === 0) return null;

  const syncType = typeof lyrics.syncType === 'string' ? lyrics.syncType.toUpperCase() : 'LINE_SYNCED';
  const isLineSynced = syncType === 'LINE_SYNCED';
  const isUnsynced = syncType === 'UNSYNCED';

  if (!isLineSynced && !isUnsynced) {
    return null;
  }

  const lines: LyricsLine[] = [];
  const boundaries: number[] = [];

  for (const rawLine of rawLines) {
    if (!isRecord(rawLine)) continue;
    const text = typeof rawLine.words === 'string' ? rawLine.words : '';
    if (!text.trim()) continue;

    if (isUnsynced) {
      lines.push({
        text,
        timing: 'none',
        startMs: null,
        endMs: null,
        agent: null,
        segments: [{ text, startMs: null, endMs: null, role: null }],
      });
    } else {
      const rawStart = Number(rawLine.startTimeMs);
      if (!Number.isSafeInteger(rawStart) || rawStart < 0) continue;

      const rawEnd = Number(rawLine.endTimeMs);
      const parsedEnd = Number.isSafeInteger(rawEnd) && rawEnd > rawStart ? rawEnd : null;

      boundaries.push(rawStart);
      lines.push({
        text,
        timing: 'line',
        startMs: rawStart,
        endMs: parsedEnd,
        agent: null,
        segments: [{ text, startMs: null, endMs: null, role: null }],
      });
    }
  }

  if (lines.length === 0) return null;

  if (isLineSynced) {
    lines.sort((a, b) => a.startMs! - b.startMs!);
    boundaries.sort((a, b) => a - b);

    for (const line of lines) {
      if (line.endMs === null) {
        const next = boundaries.find(b => b > line.startMs!);
        line.endMs =
          next ??
          (typeof durationMs === 'number' && Number.isSafeInteger(durationMs) && durationMs > line.startMs!
            ? durationMs
            : null);
      }
    }
  }

  const result: LyricsResult = {
    source: 'spotify',
    instrumental: false,
    lines,
  };

  return isValidResult(result) ? result : null;
}

export function createSpotifyLyricsProvider(): LyricsProvider {
  return {
    id: 'spotify',
    async fetch(query: LyricsQuery, signal?: AbortSignal): Promise<LyricsResult | null> {
      const spotifyId = query.spotifyId?.trim();
      const imageUri = query.imageUri?.trim();
      if (!spotifyId || !imageUri || signal?.aborted) return null;

      const api = globalThis.Spicetify?.Platform?.RequestBuilder;
      const builder = typeof api?.getInstance === 'function' ? api.getInstance() : api;
      if (typeof builder?.build !== 'function') return null;

      const timeout = AbortSignal.timeout(10000);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

      let rejectOnAbort: (() => void) | null = null;
      try {
        const aborted = new Promise<never>((_, reject) => {
          rejectOnAbort = () => reject(new DOMException('Lyrics request aborted', 'AbortError'));
          requestSignal.addEventListener('abort', rejectOnAbort, { once: true });
        });
        const path = `/track/${encodeURIComponent(spotifyId)}/image/${encodeURIComponent(imageUri)}`;
        const response = await Promise.race([
          builder.build()
            .withHost('https://spclient.wg.spotify.com/color-lyrics/v2')
            .withPath(path)
            .withQueryParameters({ format: 'json', vocalRemoval: false })
            .withEndpointIdentifier('/track/{trackId}')
            .withAbortSignal(requestSignal)
            .send(),
          aborted,
        ]);
        if (requestSignal.aborted) return null;

        return adaptSpotifyLyrics(response.body, query.durationMs);
      } catch {
        return null;
      } finally {
        if (rejectOnAbort) requestSignal.removeEventListener('abort', rejectOnAbort);
      }
    },
  };
}
