# Changelog

## [1.1.4] - 2026-10-03

- Keep lyric font sizes consistent with and without the artwork panel when Now Playing opens or closes.
- Preserve the artwork layout's font proportions while respecting Spotify zoom and sidebar resizing.

## [1.1.3] - 2026-10-03

- Keep the cover hidden when switching from an open Now Playing view to Queue, and visible when Queue opens from a closed Now Playing view.
- Preserve the cover state through Queue loading so the lyric layout does not briefly jump.

## [1.1.2] - 2026-10-03

- Keep the artwork panel visible while Queue opens, avoiding a brief jump in the lyric layout.

## [1.1.1] - 2026-10-03

- Link the track title, artists and album name to their Spotify pages.

## [1.1.0] - 2026-10-02

- Show album artwork, track title and artists beside the lyrics when Now Playing is hidden.
- Hide the artwork panel when Now Playing is open or there is not enough room for readable lyrics.
- Scale the artwork and lyric text with the view and Spotify's zoom controls.

## [1.0.0] - 2026-10-01

First public release of Liquid Lyrics.

- An Apple Music-inspired lyric view with word highlighting, line sync and an animated background.
- BiniLyrics and LyricsPlus for synced lyrics, with Spotify, AMLL and LRCLIB as fallbacks.
- Cleaner song queries and local matching to distinguish recordings without repeated searches.
- Backing vocals, interlude dots, songwriter credits and lyric provider attribution.
- Playback control button, keyboard shortcut and click-to-seek support.
- Versioned extension builds and a Marketplace manifest, licensed under AGPL-3.0-only.
