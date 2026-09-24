import type { LyricLine, LyricWord } from '@applemusic-like-lyrics/core';
import type { LyricsLine, LyricsResult } from '../types/types';

// Raw ttm:agent values from Apple TTML. formats.ts passes them through
// untouched, so the renderer must match v1/v2, not display names.
const SECONDARY_AGENTS = new Set(['v2', 'duet', 'vocal-2']);
const PLAIN_SLOT_MS = 4000;
const LAST_LINE_FALLBACK_MS = 3500;
const MIN_SEGMENT_MS = 50;
const SEGMENT_FALLBACK_MS = 300;

/**
 * Converts Liquid Lyrics unified LyricsResult into AMLL's LyricLine format.
 */
export function convertToAmllLines(result: LyricsResult | null): LyricLine[] {
  if (!result || result.instrumental || !Array.isArray(result.lines) || result.lines.length === 0) {
    return [];
  }

  const amllLines: LyricLine[] = [];
  const rawLines = result.lines;

  for (let i = 0; i < rawLines.length; i++) {
    const converted = convertLine(rawLines[i], rawLines[i + 1], i);
    if (converted) {
      amllLines.push(converted);
    }
  }

  return amllLines;
}

function isBackground(line: LyricsLine): boolean {
  return line.segments.some((s) => s.role === 'background');
}

function isSecondary(agent: string | null): boolean {
  return agent !== null && SECONDARY_AGENTS.has(agent.trim().toLowerCase());
}

function convertLine(line: LyricsLine, nextLine: LyricsLine | undefined, index: number): LyricLine | null {
  // Untimed lines have no sync data, so they get sequential display slots.
  // Slots are ordering only, never real timing.
  const lineStart = line.startMs ?? index * PLAIN_SLOT_MS;

  let lineEnd = line.endMs;
  if (lineEnd === null || lineEnd === undefined || lineEnd <= lineStart) {
    if (nextLine?.startMs !== null && nextLine?.startMs !== undefined && nextLine.startMs > lineStart) {
      lineEnd = nextLine.startMs;
    } else if (line.startMs === null) {
      lineEnd = lineStart + PLAIN_SLOT_MS;
    } else {
      lineEnd = lineStart + LAST_LINE_FALLBACK_MS;
    }
  }
  // An end past the next line start would double-activate lines.
  if (nextLine?.startMs !== null && nextLine?.startMs !== undefined && nextLine.startMs > lineStart) {
    lineEnd = Math.min(lineEnd, nextLine.startMs);
  }

  const isBG = isBackground(line);
  const isDuet = isSecondary(line.agent);

  let words: LyricWord[] = [];

  if (line.timing === 'word' && line.segments.length > 0) {
    words = line.segments.map((seg, idx) => {
      const segStart = seg.startMs ?? lineStart;
      let segEnd = seg.endMs;

      if (segEnd === null || segEnd === undefined || segEnd <= segStart) {
        const nextSeg = line.segments[idx + 1];
        if (nextSeg?.startMs !== null && nextSeg?.startMs !== undefined && nextSeg.startMs > segStart) {
          segEnd = Math.min(nextSeg.startMs, lineEnd);
        } else {
          segEnd = Math.min(lineEnd, segStart + SEGMENT_FALLBACK_MS);
        }
      } else {
        segEnd = Math.min(segEnd, lineEnd);
      }

      return { word: seg.text, startTime: segStart, endTime: Math.max(segStart + MIN_SEGMENT_MS, segEnd) };
    });
  } else {
    // Line timing keeps one word for the whole line; AMLL handles the rest.
    words = [{ word: line.text, startTime: lineStart, endTime: lineEnd }];
  }

  // Sanity check: Ensure line startTime/endTime encompass all words
  const actualStart = words.length > 0 ? Math.min(lineStart, words[0].startTime) : lineStart;
  const actualEnd = words.length > 0 ? Math.max(lineEnd, words[words.length - 1].endTime) : lineEnd;

  return {
    words,
    translatedLyric: '',
    romanLyric: '',
    startTime: actualStart,
    endTime: actualEnd,
    isBG,
    isDuet,
  };
}
