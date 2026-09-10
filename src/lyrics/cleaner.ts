import type { LyricsQuery } from '../types/types';

export function cleanTitle(title: string): string {
  if (!title) return '';
  return title
    .replace(/[\(\[](?:feat|ft)\.?\s+[^\)\]]+[\)\]]/gi, '')
    .replace(/[\(\[]with\s+[^\)\]]+[\)\]]/gi, '')
    .replace(/[\(\[](?:remastered|remaster|bonus track|deluxe edition|anniversary edition)[^\)\]]*[\)\]]/gi, '')
    .replace(/\s*-\s*(?:remastered|remaster|\d{4}\s+remaster|single version|radio edit|original mix|bonus track).*/gi, '')
    .replace(/\s+(?:feat|ft)\.?\s+.*/gi, '')
    .trim();
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
