import { createBiniLyricsProvider } from '../src/lyrics/providers/binilyrics';
import { createAmllProvider } from '../src/lyrics/providers/amll';
import { createLrclibProvider } from '../src/lyrics/providers/lrclib';
import { fetchLyrics } from '../src/lyrics/chain';
import { LyricsCache } from '../src/storage/cache';

export async function runBudgetChecks() {
  const originalFetch = globalThis.fetch;
  let checks = 0;
  function check(ok: boolean, message: string) {
    if (!ok) throw new Error(message);
    checks++;
  }
  try {
    const calls: string[] = [];
    globalThis.fetch = async input => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith('https://lyrics-api.binimum.org')) return new Response(null, { status: 503 });
      if (url.startsWith('https://lyricsplus.binimum.org')) return Response.json({
        metadata: { title: 'Test', artist: 'Artist', totalDuration: '3:20' },
        lyrics: [{ text: 'Hello', time: 1000, duration: 500,
          syllabus: [{ text: 'Hello', time: 1000, duration: 500 }] }],
      });
      throw new Error(`Unexpected request: ${url}`);
    };
    const chosen = await fetchLyrics({ song: 'Test', artist: 'Artist', durationMs: 200000,
      skipCache: true }, undefined, new LyricsCache());
    check(chosen?.source === 'lyricsplus' && calls.filter(url =>
      url.startsWith('https://lyrics-api.binimum.org')).length === 1,
    'Bini 503 stops Bini variants but still reaches LyricsPlus');

    calls.length = 0;
    globalThis.fetch = async input => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith('https://lyrics-api.binimum.org')) return Response.json({ results: [
        { track_name: 'Test', artist_name: 'Artist', lyricsUrl: 'https://lrc.red/s/one.ttml' },
        { track_name: 'Test', artist_name: 'Artist', lyricsUrl: 'https://lrc.red/s/two.ttml' },
      ] });
      if (url.startsWith('https://lrc.red')) return new Response(null, { status: 504 });
      throw new Error(`Unexpected request: ${url}`);
    };
    check(await createBiniLyricsProvider().fetch({ song: 'Test', artist: 'Artist' }) === null &&
      calls.filter(url => url.startsWith('https://lrc.red')).length === 1,
    'A failed lyric-file host is skipped only for this Bini lookup');

    calls.length = 0;
    globalThis.fetch = async input => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith('https://lyrics-api.binimum.org')) return Response.json({ results: [
        { track_name: 'Test', artist_name: 'Artist', lyricsUrl: 'https://lrc.red/s/one.ttml' },
        { track_name: 'Test', artist_name: 'Artist', lyricsUrl: 'https://lrc.red/s/two.ttml' },
      ] });
      if (url.startsWith('https://lrc.red')) return new Response(null, { status: 504 });
      if (url.startsWith('https://lyricsplus.binimum.org')) return Response.json({
        metadata: { title: 'Test', artist: 'Artist', totalDuration: '3:20' },
        lyrics: [{ text: 'Hello', time: 1000, duration: 500,
          syllabus: [{ text: 'Hello', time: 1000, duration: 500 }] }],
      });
      throw new Error(`Unexpected request: ${url}`);
    };
    const afterFileError = await fetchLyrics({ song: 'Test', artist: 'Artist', durationMs: 200000,
      skipCache: true }, undefined, new LyricsCache());
    check(afterFileError?.source === 'lyricsplus' &&
      calls.filter(url => url.startsWith('https://lrc.red')).length === 1,
    'A Bini lyric-file 504 does not block the next provider');

    calls.length = 0;
    globalThis.fetch = async input => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith('https://lyrics-api.binimum.org')) return Response.json({ results: [
        { track_name: 'Test', artist_name: 'Artist', lyricsUrl: 'https://lrc.red/s/one.ttml' },
        { track_name: 'Test', artist_name: 'Artist', lyricsUrl: 'https://lrc.red/s/two.ttml' },
      ] });
      if (url.startsWith('https://lrc.red')) throw new DOMException('Timed out', 'TimeoutError');
      if (url.startsWith('https://lyricsplus.binimum.org')) return Response.json({
        metadata: { title: 'Test', artist: 'Artist', totalDuration: '3:20' },
        lyrics: [{ text: 'Hello', time: 1000, duration: 500,
          syllabus: [{ text: 'Hello', time: 1000, duration: 500 }] }],
      });
      throw new Error(`Unexpected request: ${url}`);
    };
    const afterTimeout = await fetchLyrics({ song: 'Test', artist: 'Artist', durationMs: 200000,
      skipCache: true }, undefined, new LyricsCache());
    check(afterTimeout?.source === 'lyricsplus' &&
      calls.filter(url => url.startsWith('https://lrc.red')).length === 1 &&
      calls.filter(url => url.startsWith('https://lyrics-api.binimum.org')).length === 1,
    'A timed-out lyric-file host is not retried during the same Bini lookup');

    calls.length = 0;
    globalThis.fetch = async input => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith('https://lyrics-api.binimum.org')) return Response.json({ results: [
        { track_name: 'Test', artist_name: 'Artist', lyricsUrl: 'https://lrc.red/s/one.ttml' },
      ] });
      return new Response('<tt><p begin="1" end="2">Recovered</p></tt>');
    };
    check((await createBiniLyricsProvider().fetch({ song: 'Test', artist: 'Artist' }))?.source === 'binilyrics' &&
      calls.some(url => url.startsWith('https://lrc.red')),
    'A later Bini lookup can retry the former failing file host');

    calls.length = 0;
    globalThis.fetch = async input => {
      calls.push(String(input));
      return new Response(null, { status: 504 });
    };
    check(await createAmllProvider().fetch({ song: 'Test', artist: 'Artist', spotifyId: 'track123' }) === null &&
      calls.length === 1, 'AMLL 504 stops AMLL search variants');
    calls.length = 0;
    check(await createLrclibProvider().fetch({ song: 'Test', artist: 'Artist' }) === null &&
      calls.length === 1, 'LRCLIB 504 stops LRCLIB search variants');

    calls.length = 0;
    globalThis.fetch = async input => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith('https://lyrics-api.binimum.org')) return Response.json({ results: [] });
      if (url.startsWith('https://lyricsplus.binimum.org')) return Response.json({
        metadata: { title: 'Test', artist: 'Artist' }, lyrics: [{ text: 'Plain', time: 0, duration: 0 }],
      });
      return new Response(null, { status: 404 });
    };
    await fetchLyrics({ song: 'Test (Remastered)', artist: 'Artist, Other', skipCache: true },
      undefined, new LyricsCache());
    check(calls.filter(url => url.startsWith('https://lyrics-api.binimum.org')).length === 1 &&
      calls.filter(url => url.startsWith('https://lyricsplus.binimum.org')).length === 1,
    'Bini makes one lookup and the cleaned-title pass does not repeat Bini or LyricsPlus');
  } finally {
    globalThis.fetch = originalFetch;
  }
  return { checks };
}
