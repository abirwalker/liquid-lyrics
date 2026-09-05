import type { LyricsLine, LyricsWord, LyricsResult } from '../../types/types';

const BETTER_LYRICS_API = 'https://lyrics-api.boidu.dev';

export interface FetchLyricsOptions {
  apiKey?: string;
}

export function parseTime(timeStr: string | null | undefined): number {
  if (!timeStr) return 0;
  const parts = timeStr.trim().split(':');

  if (parts.length === 1) {
    const val = parseFloat(parts[0]);
    return Number.isFinite(val) ? Math.round(val * 1000) : 0;
  }

  if (parts.length === 2) {
    const minutes = parseInt(parts[0], 10);
    const seconds = parseFloat(parts[1]);
    if (Number.isFinite(minutes) && Number.isFinite(seconds)) {
      return Math.round((minutes * 60 + seconds) * 1000);
    }
  }

  if (parts.length === 3) {
    const hours = parseInt(parts[0], 10);
    const minutes = parseInt(parts[1], 10);
    const seconds = parseFloat(parts[2]);
    if (Number.isFinite(hours) && Number.isFinite(minutes) && Number.isFinite(seconds)) {
      return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
    }
  }

  return 0;
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

export function parseTTML(ttmlXml: string): LyricsLine[] {
  if (!ttmlXml || typeof ttmlXml !== 'string') {
    return [];
  }

  const lines: LyricsLine[] = [];
  const pRegex = /<p\s+[^>]*begin="([^"]+)"(?:\s+[^>]*end="([^"]+)")?[^>]*>([\s\S]*?)<\/p>/gi;
  let pMatch: RegExpExecArray | null;

  while ((pMatch = pRegex.exec(ttmlXml)) !== null) {
    const beginStr = pMatch[1];
    const endStr = pMatch[2];
    const content = pMatch[3];

    const lineBegin = parseTime(beginStr);
    const lineEnd = endStr ? parseTime(endStr) : lineBegin;

    const words: LyricsWord[] = [];
    const spanRegex = /<span\s+[^>]*begin="([^"]+)"(?:\s+[^>]*end="([^"]+)")?[^>]*>([\s\S]*?)<\/span>/gi;
    let spanMatch: RegExpExecArray | null;

    while ((spanMatch = spanRegex.exec(content)) !== null) {
      const wordBeginStr = spanMatch[1];
      const wordEndStr = spanMatch[2];
      const rawText = spanMatch[3];

      const cleanWord = decodeHtmlEntities(rawText.replace(/<[^>]+>/g, '')).trim();
      if (cleanWord) {
        words.push({
          text: cleanWord,
          begin: parseTime(wordBeginStr),
          end: wordEndStr ? parseTime(wordEndStr) : lineEnd,
        });
      }
    }

    if (words.length > 0) {
      lines.push({
        begin: lineBegin,
        end: lineEnd,
        words,
      });
    } else {
      const plainText = decodeHtmlEntities(content.replace(/<[^>]+>/g, '')).trim();
      if (plainText) {
        lines.push({
          begin: lineBegin,
          end: lineEnd,
          words: [
            {
              text: plainText,
              begin: lineBegin,
              end: lineEnd,
            },
          ],
        });
      }
    }
  }

  return lines;
}

async function executeLyricsRequest(
  params: URLSearchParams,
  apiKey?: string
): Promise<string | null> {
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }

  const url = `${BETTER_LYRICS_API}/getLyrics?${params.toString()}`;
  const response = await fetch(url, { headers });

  if (!response.ok) {
    return null;
  }

  const data = await response.json();
  if (data && typeof data.ttml === 'string') {
    return data.ttml;
  }
  if (data && typeof data.lyrics === 'string') {
    return data.lyrics;
  }
  return null;
}

export async function fetchLyrics(
  song: string,
  artist: string,
  album?: string,
  duration?: number,
  options?: FetchLyricsOptions
): Promise<LyricsResult | null> {
  const trimmedSong = song ? song.trim() : '';
  const trimmedArtist = artist ? artist.trim() : '';

  if (!trimmedSong || !trimmedArtist) {
    return null;
  }

  const baseParams = new URLSearchParams();
  baseParams.set('s', trimmedSong);
  baseParams.set('a', trimmedArtist);

  const fullParams = new URLSearchParams(baseParams);
  let hasExtraParams = false;

  if (album && album.trim()) {
    fullParams.set('al', album.trim());
    hasExtraParams = true;
  }

  if (typeof duration === 'number' && duration > 0) {
    const durationSeconds = duration > 1000 ? Math.round(duration / 1000) : Math.round(duration);
    fullParams.set('d', durationSeconds.toString());
    hasExtraParams = true;
  }

  try {
    let ttml = await executeLyricsRequest(fullParams, options?.apiKey);

    if (!ttml && hasExtraParams) {
      ttml = await executeLyricsRequest(baseParams, options?.apiKey);
    }

    if (!ttml) {
      return null;
    }

    const lines = parseTTML(ttml);
    if (lines.length === 0) {
      return null;
    }

    return {
      lines,
      score: 100,
    };
  } catch {
    return null;
  }
}
