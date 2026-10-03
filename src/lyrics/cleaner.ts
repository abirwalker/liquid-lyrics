import type { LyricsQuery } from '../types/types';

function stripSoundtrackCredit(title: string): string {
  const credit = /\s+(?:[-–—]\s*from\s+(.+)|\(from\s+([^()]*)\)|\[from\s+([^\[\]]*)\])\s*$/i.exec(title);
  if (!credit || credit.index === 0) return title;
  const source = credit[1] ?? credit[2] ?? credit[3];
  if (!/\p{L}/u.test(source) ||
      /\b(?:remix|stripped|acoustic|live|instrumental|karaoke|sped[ -]?up|slowed|rework|vip|demo|radio[ -]?edit)\b/i.test(source)) return title;
  return title.slice(0, credit.index);
}

function stripFeaturedCredit(title: string): string {
  let depth = 0;
  for (let index = 0; index < title.length; index++) {
    const character = title[index];
    if (character === '(' || character === '[') depth++;
    else if (character === ')' || character === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && /\s/.test(character) && /^\s+(?:feat|ft)\.?\s+/i.test(title.slice(index))) {
      return title.slice(0, index);
    }
  }
  return title;
}

export function cleanTitle(title: string): string {
  if (!title) return '';
  return stripSoundtrackCredit(stripFeaturedCredit(title
    .replace(/[\(\[](?:feat|ft)\.?\s+[^\)\]]+[\)\]]/gi, '')
    .replace(/[\(\[]with\s+[^\)\]]+[\)\]]/gi, '')
    .replace(/[\(\[](?:remastered|remaster|bonus track|deluxe edition|anniversary edition)[^\)\]]*[\)\]]/gi, '')
    .replace(/\s*-\s*(?:remastered|remaster|\d{4}\s+remaster|single version|radio edit|original mix|bonus track).*/gi, '')
    .trim())).trim();
}

export function getPrimaryArtist(artist: string): string {
  if (!artist) return '';
  const first = artist.split(/[,;/]|\s+(?:feat|ft)\.?\s+/i)[0];
  return first ? first.trim() : artist.trim();
}

export function createCleanQuery(query: LyricsQuery): LyricsQuery | null {
  const cleanedSong = cleanTitle(query.song);
  const primaryArtist = getPrimaryArtist(query.artist);

  const isSongChanged = cleanedSong && cleanedSong.toLowerCase() !== query.song.toLowerCase().trim();
  const isArtistChanged = primaryArtist && primaryArtist.toLowerCase() !== query.artist.toLowerCase().trim();

  if (!isSongChanged && !isArtistChanged) {
    return null;
  }

  return {
    song: cleanedSong || query.song,
    artist: primaryArtist || query.artist,
    album: query.album ? cleanTitle(query.album) || query.album : undefined,
    durationMs: query.durationMs,
  };
}
