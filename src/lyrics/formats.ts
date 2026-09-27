import type { LyricsLine as Line, LyricsSegment as Segment, LyricsResult } from '../types/types';
import { isValidResult, normalizeCollapsedTiming } from '../types/types';

function time(value: string | null): number | null {
  if (value === null) return null;
  value = value.trim();
  const unit = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value);
  if (unit) {
    const factors: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000 };
    const milliseconds = Math.round(Number(unit[1]) * factors[unit[2]]);
    if (!Number.isSafeInteger(milliseconds)) throw new Error('Invalid time');
    return milliseconds;
  }
  if (!/^\d+(?::[0-5]?\d){0,2}(?:\.\d+)?$/.test(value)) throw new Error('Unsupported time');
  const seconds = value.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
  const milliseconds = Math.round(seconds * 1000);
  if (!Number.isSafeInteger(milliseconds)) throw new Error('Invalid time');
  return milliseconds;
}

const BACKGROUND_ROLES = new Set(['x-bg', 'background']);

function role(element: Element): string | null {
  return element.getAttributeNS('http://www.w3.org/ns/ttml#metadata', 'role')
    ?? element.getAttribute('ttm:role')
    ?? element.getAttribute('role');
}

function isBackground(roleName: string | null): boolean {
  return roleName !== null && BACKGROUND_ROLES.has(roleName.trim().toLowerCase());
}

function hasBackgroundAncestor(element: Element, paragraph: Element): boolean {
  for (let current: Element | null = element; current && current !== paragraph; current = current.parentElement) {
    if (isBackground(role(current))) return true;
  }
  return false;
}

function inheritedAgent(element: Element): string | null {
  for (let current: Element | null = element; current; current = current.parentElement) {
    const agent = current.getAttributeNS('http://www.w3.org/ns/ttml#metadata', 'agent')
      ?? current.getAttribute('ttm:agent')
      ?? current.getAttribute('agent');
    if (agent) return agent;
  }
  return null;
}

function supportsAmllTiming(xml: Document): boolean {
  const body = Array.from(xml.getElementsByTagName('*')).find(el => el.localName === 'body');
  if (body) {
    if (body.hasAttribute('begin') || body.hasAttribute('end')) return false;
    let bodyDuration: number | null = null;
    if (body.hasAttribute('dur')) {
      try {
        const dur = time(body.getAttribute('dur'));
        if (dur === null || dur <= 0) return false;
        bodyDuration = dur;
      } catch {
        return false;
      }
    }

    for (const div of Array.from(body.getElementsByTagName('*')).filter(el => el.localName === 'div')) {
      if (div.hasAttribute('dur')) return false;
      const divStart = div.hasAttribute('begin') ? time(div.getAttribute('begin')) : null;
      const divEnd = div.hasAttribute('end') ? time(div.getAttribute('end')) : null;
      if ((divStart === null) !== (divEnd === null)) return false;
      if (divStart !== null && divEnd !== null && divEnd <= divStart) return false;
      if (bodyDuration !== null && divEnd !== null && divEnd > bodyDuration) return false;

      for (const paragraph of Array.from(div.getElementsByTagName('*')).filter(el => el.localName === 'p')) {
        if (paragraph.hasAttribute('dur')) return false;
        const lineStart = paragraph.hasAttribute('begin') ? time(paragraph.getAttribute('begin')) : null;
        const lineEnd = paragraph.hasAttribute('end') ? time(paragraph.getAttribute('end')) : null;
        if ((lineStart === null) !== (lineEnd === null)) return false;
        if (lineStart !== null && lineEnd !== null) {
          if (lineEnd <= lineStart) return false;
          if (divStart !== null && lineStart < divStart) return false;
          if (divEnd !== null && lineEnd > divEnd) return false;
          if (bodyDuration !== null && lineEnd > bodyDuration) return false;
        }

        for (const span of Array.from(paragraph.getElementsByTagName('*')).filter(el => el.localName === 'span')) {
          if (span.hasAttribute('dur')) return false;
          const start = span.hasAttribute('begin') ? time(span.getAttribute('begin')) : null;
          const end = span.hasAttribute('end') ? time(span.getAttribute('end')) : null;
          if ((start === null) !== (end === null)) return false;
          if (start !== null && end !== null) {
            if (lineStart === null || lineEnd === null || end <= start) return false;
            if (start < lineStart) return false;
            if (!hasBackgroundAncestor(span, paragraph) && end > lineEnd) return false;
            if (divEnd !== null && end > divEnd) return false;
            if (bodyDuration !== null && end > bodyDuration) return false;
          }
        }
      }
    }
  }
  return true;
}

export function fromTTML(source: string, input: unknown): LyricsResult | null {
  if (typeof input !== 'string' || /<!DOCTYPE/i.test(input)) return null;
  try {
    const xml = new DOMParser().parseFromString(input, 'application/xml');
    if (xml.getElementsByTagName('parsererror').length || xml.documentElement.localName !== 'tt') return null;
    const appleTiming = xml.documentElement.getAttributeNS('http://music.apple.com/lyric-ttml-internal', 'timing') ??
      xml.documentElement.getAttributeNS('http://itunes.apple.com/lyric-ttml-extensions', 'timing') ??
      xml.documentElement.getAttribute('itunes:timing');
    const appleProfile = appleTiming?.toLowerCase() === 'word' || appleTiming?.toLowerCase() === 'line';
    const lrcTiming = xml.documentElement.getAttributeNS('http://lrc.red/lyric-ttml-internal', 'timing');
    const lrcProfile = source === 'binilyrics' &&
      (lrcTiming?.toLowerCase() === 'word' || lrcTiming?.toLowerCase() === 'line');
    for (const element of Array.from(xml.getElementsByTagName('*'))) {
      if (element.getAttribute('timeContainer') === 'seq') return null;
      if (source !== 'amll' && !lrcProfile) {
        if (element.hasAttribute('dur') && !(appleProfile && element.localName === 'body')) return null;
        if (['body', 'div'].includes(element.localName) &&
            (element.hasAttribute('begin') || element.hasAttribute('end')) && !appleProfile) return null;
      }
    }
    if ((source === 'amll' || lrcProfile) && !supportsAmllTiming(xml)) return null;
    const lines: Line[] = [];
    for (const paragraph of Array.from(xml.getElementsByTagNameNS('*', 'p'))) {
      const startMs = time(paragraph.getAttribute('begin'));
      const endMs = time(paragraph.getAttribute('end'));
      const segments: Segment[] = [];
      function walk(node: Node, inheritedStart: number | null, inheritedEnd: number | null, inheritedRole: string | null) {
        if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
          const text = (node.textContent ?? '').replace(/[\t\r\n ]+/g, ' ');
          if (text) segments.push({ text, startMs: inheritedStart, endMs: inheritedEnd, role: inheritedRole });
          return;
        }
        if (!(node instanceof Element)) return;
        if (node.localName === 'br') {
          segments.push({ text: '\n', startMs: null, endMs: null, role: inheritedRole });
          return;
        }
        if (node.localName !== 'span') return;
        const nextStart = node.hasAttribute('begin') ? time(node.getAttribute('begin')) : inheritedStart;
        const nextEnd = node.hasAttribute('end') ? time(node.getAttribute('end')) : inheritedEnd;
        for (const child of Array.from(node.childNodes)) walk(child, nextStart, nextEnd, role(node) ?? inheritedRole);
      }
      for (const child of Array.from(paragraph.childNodes)) walk(child, null, null, role(paragraph));
      if (!segments.length) continue;
      segments[0].text = segments[0].text.trimStart();
      segments[segments.length - 1].text = segments[segments.length - 1].text.trimEnd();
      const nonemptySegments = segments.filter(segment => segment.text.length > 0);
      const text = nonemptySegments.map(segment => segment.text).join('');
      if (!text.trim()) continue;
      const hasWordTiming = segments.some(segment => segment.text.trim() && segment.startMs !== null);
      if (hasWordTiming && startMs === null) return null;
      lines.push({ text, startMs, endMs, segments: nonemptySegments,
        timing: startMs === null ? 'none' : hasWordTiming ? 'word' : 'line',
        agent: inheritedAgent(paragraph) });
    }
    lines.sort((a, b) => (a.startMs ?? Number.MAX_SAFE_INTEGER) - (b.startMs ?? Number.MAX_SAFE_INTEGER));
    const result = { source, instrumental: false, lines };
    return isValidResult(result) ? normalizeCollapsedTiming(result) : null;
  } catch { return null; }
}

export function fromPlain(source: string, input: unknown): LyricsResult | null {
  if (typeof input !== 'string') return null;
  const lines: Line[] = input.split(/\r?\n/).map(text => text.trim()).filter(Boolean).map(text => ({
    text, timing: 'none', startMs: null, endMs: null, agent: null,
    segments: [{ text, startMs: null, endMs: null, role: null }],
  }));
  const result = { source, instrumental: false, lines };
  return isValidResult(result) ? result : null;
}

export function fromLRC(source: string, input: unknown, durationMs?: number): LyricsResult | null {
  if (typeof input !== 'string') return null;
  if (/<\d+:\d+(?:\.\d+)?>/.test(input)) return null;
  const offset = Number(/\[offset:([+-]?\d+)\]/i.exec(input)?.[1] ?? 0);
  if (!Number.isSafeInteger(offset)) return null;
  const lines: Line[] = [];
  const boundaries: number[] = [];
  for (const raw of input.split(/\r?\n/)) {
    const prefix = /^(?:\[\d+:[0-5]?\d(?:\.\d+)?\])+/.exec(raw.trim())?.[0];
    if (!prefix) continue;
    const text = raw.trim().slice(prefix.length).trim();
    for (const stamp of prefix.matchAll(/\[(\d+):([0-5]?\d(?:\.\d+)?)\]/g)) {
      const startMs = Math.max(0, Math.round((Number(stamp[1]) * 60 + Number(stamp[2])) * 1000) - offset);
      boundaries.push(startMs);
      if (text) lines.push({ text, timing: 'line', startMs, endMs: null, agent: null,
        segments: [{ text, startMs: null, endMs: null, role: null }] });
    }
  }
  lines.sort((a, b) => a.startMs! - b.startMs!);
  boundaries.sort((a, b) => a - b);
  for (const line of lines) {
    const next = boundaries.find(boundary => boundary > line.startMs!);
    line.endMs = next ?? (typeof durationMs === 'number' && Number.isSafeInteger(durationMs) && durationMs > line.startMs! ? durationMs : null);
  }
  const result = { source, instrumental: false, lines };
  return isValidResult(result) ? normalizeCollapsedTiming(result) : null;
}
