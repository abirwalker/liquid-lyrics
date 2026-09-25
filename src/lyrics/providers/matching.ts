import type { LyricsQuery } from '../../types/types';

const VERSION_MARKER = /\b(remix|stripped|acoustic|live|instrumental|karaoke|sped[ -]?up|slowed|rework|vip|demo|radio[ -]?edit)\b/gi;

export interface MatchCandidate {
  titles: string[];
  artists: string[];
  albums?: string[];
  durationMs?: number;
  spotifyIds?: string[];
}

export function normalizeMatchText(value: string | undefined): string {
  return (value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase().replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function artistNames(value: string): string[] {
  return value.split(/\s*(?:,|&|\bfeat\.?\b|\bft\.?\b|\bwith\b)\s*/gi)
    .map(part => normalizeMatchText(part)).filter(Boolean);
}

function textMatches(left: string, right: string): boolean {
  const a = normalizeMatchText(left);
  const b = normalizeMatchText(right);
  if (!a || !b) return false;
  if (a === b) return true;
  return Math.min([...a].length, [...b].length) >= 4 && (a.includes(b) || b.includes(a));
}

function versions(value: string): Set<string> {
  return new Set([...value.matchAll(VERSION_MARKER)].map(match => normalizeMatchText(match[0])));
}

export function scoreCandidate(query: LyricsQuery, candidate: MatchCandidate): number | null {
  if (query.spotifyId && candidate.spotifyIds?.includes(query.spotifyId)) return 950;
  const requestedVersions = versions(query.song);
  if (candidate.titles.some(title => [...versions(title)].some(version => !requestedVersions.has(version)))) return null;

  const exactTitle = candidate.titles.some(title => normalizeMatchText(title) === normalizeMatchText(query.song));
  if (!candidate.titles.some(title => textMatches(title, query.song))) return null;
  const wantedArtists = artistNames(query.artist);
  const artistMatch = wantedArtists.some(wanted => candidate.artists.some(artist =>
    artistNames(artist).some(name => textMatches(wanted, name))));
  if (!artistMatch) return null;

  let score = (exactTitle ? 120 : 55) + 80;
  if (query.album && candidate.albums?.some(album => textMatches(album, query.album!))) score += 20;
  if (query.durationMs && candidate.durationMs) {
    const difference = Math.abs(query.durationMs - candidate.durationMs);
    if (difference <= 2000) score += 80;
    else if (difference <= 4000) score += 35;
    else if (difference > 10000) return null;
  }
  return score;
}
