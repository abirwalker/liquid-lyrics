export interface LyricsWord {
  text: string;
  begin: number;
  end: number;
}

export interface LyricsLine {
  begin: number;
  end: number;
  words: LyricsWord[];
}

export interface LyricsResult {
  lines: LyricsLine[];
  score: number;
}
