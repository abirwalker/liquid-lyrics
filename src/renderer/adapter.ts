import type { LyricLine, LyricWord } from '@applemusic-like-lyrics/core';
import type { LyricsLine, LyricsResult, LyricsSegment } from '../types/types';

// Raw ttm:agent values from Apple TTML. formats.ts passes them through
// untouched, so the renderer must match v1/v2, not display names.
const SECONDARY_AGENTS = new Set(['v2', 'duet', 'vocal-2']);
const PLAIN_SLOT_MS = 4000;
const LAST_LINE_FALLBACK_MS = 3500;
const MIN_SEGMENT_MS = 50;
const SEGMENT_FALLBACK_MS = 300;
const BG_PLACEMENT_OFFSET_MS = 1;
const STANDALONE_BG_MAX_GAP_MS = 1000;
const WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' });

export type DisplayLyricLine = LyricLine & { inferredBacking?: true };

/**
 * Converts Liquid Lyrics unified LyricsResult into AMLL's LyricLine format.
 */
export function convertToAmllLines(result: LyricsResult | null): DisplayLyricLine[] {
  if (!result || result.instrumental || !Array.isArray(result.lines) || result.lines.length === 0) {
    return [];
  }

  const amllLines: DisplayLyricLine[] = [];
  const rawLines = result.lines;
  let forwardBacking: { index: number; line: DisplayLyricLine } | null = null;

  for (let i = 0; i < rawLines.length; i++) {
    const append = (...lines: DisplayLyricLine[]) => {
      amllLines.push(...lines);
      if (forwardBacking?.index === i) {
        amllLines.push(forwardBacking.line);
        forwardBacking = null;
      }
    };
    const line = rawLines[i];
    const bracketed = line.timing !== 'none' && !line.segments.some(isBackground)
      ? splitEdgeBrackets(line.text) : null;
    if (bracketed && line.timing === 'line') {
      const lead = convertLine({ ...line, text: bracketed.lead,
        segments: [{ text: bracketed.lead, startMs: null, endMs: null, role: null }] }, rawLines[i + 1], i, false);
      const backing = convertLine({ ...line, text: bracketed.background,
        segments: [{ text: bracketed.background, startMs: null, endMs: null, role: null }] }, rawLines[i + 1], i, true);
      backing.startTime = lead.startTime;
      backing.endTime = lead.endTime;
      backing.words[0].endTime = lead.endTime;
      // AMLL uses the first word's time to choose whether backing text sits above or below.
      if (bracketed.first) {
        if (lead.words[0].startTime === 0) lead.words[0].startTime = BG_PLACEMENT_OFFSET_MS;
        else backing.words[0].startTime = lead.words[0].startTime - BG_PLACEMENT_OFFSET_MS;
      }
      append(lead, backing);
      continue;
    }
    if (bracketed && line.timing === 'word') {
      const split = splitTimedSegments(line.segments, bracketed.start, bracketed.end);
      const lead = trimVocalWhitespace(split.lead);
      const backing = trimVocalWhitespace(trimBackgroundBrackets(split.background));
      if (lead.length && backing.length) {
        const leadLine = convertLine(vocalLine(line, lead), rawLines[i + 1], i, false);
        const backingLine = convertLine(vocalLine(line, backing), undefined, i, true);
        if (bracketed.first && backingLine.words[0].startTime >= leadLine.words[0].startTime) {
          if (leadLine.words[0].startTime === 0) leadLine.words[0].startTime = BG_PLACEMENT_OFFSET_MS;
          else backingLine.words[0].startTime = leadLine.words[0].startTime - BG_PLACEMENT_OFFSET_MS;
        }
        append(leadLine, backingLine);
        continue;
      }
    }
    const previous = rawLines[i - 1];
    const next = rawLines[i + 1];
    const standalone = line.timing !== 'none' && !line.segments.some(isBackground) &&
      (followsTimedLead(previous, line) || precedesTimedLead(line, next))
      ? standaloneBracketText(line.text) : null;
    if (standalone) {
      const segments = line.timing === 'word'
        ? trimVocalWhitespace(trimBackgroundBrackets(line.segments))
        : [{ text: standalone, startMs: null, endMs: null, role: null }];
      if (segments.length) {
        const backing: DisplayLyricLine = convertLine(vocalLine(line, segments), undefined, i, true);
        backing.inferredBacking = true;
        const previousMatches = previous && !standaloneBracketText(previous.text)
          ? matchingWordCount(standalone, previous.text) : 0;
        const nextMatches = next && !standaloneBracketText(next.text)
          ? matchingWordCount(standalone, next.text) : 0;
        if (next && precedesTimedLead(line, next) && nextMatches >= 2 && nextMatches > previousMatches &&
            !next.segments.some(isBackground) && !splitEdgeBrackets(next.text)) {
          forwardBacking = { index: i + 1, line: backing };
          continue;
        }
        if (followsTimedLead(previous, line)) {
          append(backing);
          continue;
        }
      }
    }
    const background = line.segments.filter(isBackground);
    const lead = line.segments.filter((segment) => !isBackground(segment));
    if (background.length && lead.some((segment) => segment.text.trim())) {
      append(convertLine(vocalLine(line, lead), rawLines[i + 1], i, false));
      const backing = trimBackgroundBrackets(background);
      if (backing.length) append(convertLine(vocalLine(line, backing), undefined, i, true));
    } else {
      const isBG = background.length > 0;
      const segments = isBG ? trimBackgroundBrackets(line.segments) : line.segments;
      if (segments.length) append(convertLine(isBG ? vocalLine(line, segments) : line, rawLines[i + 1], i, isBG));
    }
  }

  return amllLines;
}

function isBackground(segment: LyricsSegment): boolean {
  return segment.role === 'x-bg' || segment.role === 'background';
}

function standaloneBracketText(value: string): string | null {
  const text = value.trim();
  const match = /^(?:\(([^()]*)\)|（([^（）]*)）)$/.exec(text);
  return (match?.[1] ?? match?.[2])?.trim() || null;
}

function followsTimedLead(previous: LyricsLine | undefined, line: LyricsLine): boolean {
  if (!previous || previous.timing === 'none' || previous.startMs === null ||
      previous.endMs === null || line.startMs === null || standaloneBracketText(previous.text)) return false;
  return line.startMs >= previous.startMs &&
    line.startMs <= previous.endMs + STANDALONE_BG_MAX_GAP_MS;
}

function precedesTimedLead(line: LyricsLine, next: LyricsLine | undefined): boolean {
  if (!next || next.timing === 'none' || next.startMs === null || line.startMs === null ||
      line.endMs === null || standaloneBracketText(next.text)) return false;
  return line.startMs < next.startMs && next.startMs <= line.endMs + STANDALONE_BG_MAX_GAP_MS;
}

function matchingWordCount(a: string, b: string): number {
  const words = (text: string) => new Set([...WORD_SEGMENTER.segment(text.normalize('NFKC').toLowerCase())]
    .filter(part => part.isWordLike).map(part => part.segment));
  const left = words(a);
  const right = words(b);
  return [...left].filter(word => right.has(word)).length;
}

function splitEdgeBrackets(value: string): { lead: string; background: string; first: boolean; start: number; end: number } | null {
  const text = value.trim();
  const offset = value.length - value.trimStart().length;
  for (const [open, close] of [['(', ')'], ['（', '）']]) {
    if (text.startsWith(open)) {
      const closeIndex = text.indexOf(close, open.length);
      const background = text.slice(open.length, closeIndex).trim();
      const lead = text.slice(closeIndex + close.length).trim();
      if (closeIndex > open.length && background && lead &&
          !background.includes(open) && !background.includes(close)) {
        return { lead, background, first: true, start: offset, end: offset + closeIndex + close.length };
      }
    }
    if (text.endsWith(close)) {
      const openIndex = text.lastIndexOf(open, text.length - close.length - 1);
      const lead = text.slice(0, openIndex).trim();
      const background = text.slice(openIndex + open.length, text.length - close.length).trim();
      if (openIndex > 0 && lead && background &&
          !background.includes(open) && !background.includes(close)) {
        return { lead, background, first: false, start: offset + openIndex, end: offset + text.length };
      }
    }
  }
  return null;
}

function splitTimedSegments(segments: LyricsSegment[], start: number, end: number):
    { lead: LyricsSegment[]; background: LyricsSegment[] } {
  const lead: LyricsSegment[] = [];
  const background: LyricsSegment[] = [];
  let offset = 0;
  for (const segment of segments) {
    const segmentEnd = offset + segment.text.length;
    const before = segment.text.slice(0, Math.max(0, Math.min(segmentEnd, start) - offset));
    const inside = segment.text.slice(Math.max(0, start - offset), Math.max(0, Math.min(segmentEnd, end) - offset));
    const after = segment.text.slice(Math.max(0, end - offset));
    if (before) lead.push({ ...segment, text: before });
    if (inside) background.push({ ...segment, text: inside });
    if (after) lead.push({ ...segment, text: after });
    offset = segmentEnd;
  }
  return { lead, background };
}

function trimVocalWhitespace(segments: LyricsSegment[]): LyricsSegment[] {
  const trimmed = segments.map((segment) => ({ ...segment }));
  while (trimmed.length && !trimmed[0].text.trim()) trimmed.shift();
  while (trimmed.length && !trimmed[trimmed.length - 1].text.trim()) trimmed.pop();
  if (trimmed.length) {
    trimmed[0].text = trimmed[0].text.trimStart();
    trimmed[trimmed.length - 1].text = trimmed[trimmed.length - 1].text.trimEnd();
  }
  return trimmed.filter((segment) => segment.text.length > 0);
}

function vocalLine(line: LyricsLine, segments: LyricsSegment[]): LyricsLine {
  const timed = segments.filter((segment) => segment.startMs !== null);
  const startMs = timed.length ? Math.min(...timed.map((segment) => segment.startMs!)) : line.startMs;
  const ends = segments.filter((segment) => segment.endMs !== null);
  const endMs = ends.length ? Math.max(...ends.map((segment) => segment.endMs!)) : line.endMs;
  return { ...line, text: segments.map((segment) => segment.text).join(''), segments, startMs, endMs };
}

function trimBackgroundBrackets(segments: LyricsSegment[]): LyricsSegment[] {
  const text = segments.map((segment) => segment.text).join('').trim();
  const brackets = text.startsWith('(') && text.endsWith(')') ? ['(', ')']
    : text.startsWith('（') && text.endsWith('）') ? ['（', '）'] : null;
  if (!brackets || text.length <= 2) return segments;
  const trimmed = segments.map((segment) => ({ ...segment }));
  const first = trimmed.find((segment) => segment.text.trim());
  const last = [...trimmed].reverse().find((segment) => segment.text.trim());
  if (!first || !last) return segments;
  first.text = first.text.replace(brackets[0], '');
  const closingIndex = last.text.lastIndexOf(brackets[1]);
  last.text = last.text.slice(0, closingIndex) + last.text.slice(closingIndex + 1);
  return trimmed.filter((segment) => segment.text.length > 0);
}

function isSecondary(agent: string | null): boolean {
  return agent !== null && SECONDARY_AGENTS.has(agent.trim().toLowerCase());
}

function convertLine(line: LyricsLine, nextLine: LyricsLine | undefined, index: number, isBG: boolean): LyricLine {
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
  if (!isBG && nextLine?.startMs !== null && nextLine?.startMs !== undefined && nextLine.startMs > lineStart) {
    lineEnd = Math.min(lineEnd, nextLine.startMs);
  }

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
