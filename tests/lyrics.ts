import { adaptLyricsPlus, createLyricsPlusProvider } from '../src/lyrics/providers/lyricsplus';
import { adaptLrclib, createLrclibProvider } from '../src/lyrics/providers/lrclib';
import { adaptSpotifyLyrics, createSpotifyLyricsProvider } from '../src/lyrics/providers/spotify';
import { createAmllProvider } from '../src/lyrics/providers/amll';
import { createBiniLyricsProvider, createBiniSearchPlan, selectBiniItems } from '../src/lyrics/providers/binilyrics';
import { scoreCandidate } from '../src/lyrics/providers/matching';
import { fromLRC, fromPlain, fromTTML } from '../src/lyrics/formats';
import { isValidResult as validLyrics } from '../src/types/types';
import type { LyricsResult as Lyrics, LyricsProvider } from '../src/types/types';
import { fetchLyricsChain, createDefaultChain, fetchLyrics } from '../src/lyrics/chain';
import { LyricsCache, getCacheKeys, normalizeString } from '../src/storage/cache';
import { extractQuery } from '../src/player/listener';
import { cleanTitle } from '../src/lyrics/cleaner';
import { runBudgetChecks } from './request-budget';

export function runIpadChecks(bini: unknown, lrc: unknown) {
  const biniResult = fromTTML('fixture', bini);
  const lrcResult = adaptLrclib(lrc);
  const plainInput = typeof lrc === 'object' && lrc !== null && 'plainLyrics' in lrc ? lrc.plainLyrics : null;
  const plainResult = fromPlain('lrclib', plainInput);
  function summarize(result: Lyrics | null, timing: 'line' | 'none') {
    if (!result || !validLyrics(result)) throw new Error(`Invalid ${timing} result`);
    if (!result.lines.every(line => line.timing === timing)) throw new Error('Incorrect timing capability');
    if (result.lines.some(line => line.segments.some(segment => segment.startMs !== null))) throw new Error('Invented word timing');
    return { source: result.source, lines: result.lines.length, timing,
      timedSegments: 0, lastEndMs: result.lines[result.lines.length - 1].endMs };
  }
  return { song: 'iPad', artist: 'The Chainsmokers',
    bini: summarize(biniResult, 'line'), lrc: summarize(lrcResult, 'line'), plain: summarize(plainResult, 'none') };
}

export function runChecks(liveTTML?: string) {
  let checks = 0;
  function check(condition: boolean, description: string) {
    if (!condition) throw new Error(description);
    checks++;
  }
  const ttml = `<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p end='2.5' begin='1.0'><span end='1.5' begin='1.0'>Hello</span> <span begin='1.5' end='2.5'>world &amp; &#x2665;</span></p></div></body></tt>`;
  const parsedTtml = fromTTML('fixture', ttml);
  check(parsedTtml !== null && validLyrics(parsedTtml), 'TTML returns validated contract');
  check(parsedTtml?.lines[0].text === 'Hello world & ♥', 'Spacing, entities, and attribute order preserved');
  check(parsedTtml?.lines[0].timing === 'word' && parsedTtml.lines[0].segments[0].startMs === 1000, 'Word timing in milliseconds');
  const plain = fromPlain('lrclib', 'One short line');
  check(plain?.lines[0].timing === 'none' && plain.lines[0].startMs === null, 'Plain text has no invented timestamps');
  const lrc = fromLRC('lrclib', '[00:01.00]Hello\n[00:03.00]');
  check(lrc?.lines[0].endMs === 3000 && lrc.lines[0].timing === 'line', 'Blank LRC timestamp ends previous line');
  check(lrc?.lines[0].segments[0].startMs === null, 'Line timing is not presented as word timing');
  check(fromLRC('lrclib', '[00:01]Short')?.lines[0].endMs === null, 'Last LRC end remains unknown');
  check(fromLRC('lrclib', '[00:01]Short', 4000)?.lines[0].endMs === 4000, 'Track duration bounds last line');
  const repeated = fromLRC('lrclib', '[offset:100]\n[00:01][00:02]Repeat');
  check(repeated?.lines.length === 2 && repeated.lines[0].startMs === 900 && repeated.lines[1].startMs === 1900, 'Repeated timestamps and offset');
  check(adaptLrclib({ syncedLyrics: 'invalid', plainLyrics: 'Fallback' })?.lines[0].timing === 'none', 'Malformed LRC falls back to plain lyrics');
  check(adaptLrclib({ instrumental: true })?.instrumental === true, 'Instrumental is distinct from missing lyrics');
  check(adaptLrclib(null) === null && fromTTML('fixture', 42) === null, 'Malformed envelopes rejected');
  check(fromTTML('binilyrics', '<tt><p>broken</tt>') === null, 'Malformed XML rejected');
  check(fromTTML('binilyrics', '<tt><p begin="bad" end="3">Wrong</p></tt>') === null, 'Invalid timestamp is not silently zero');
  check(fromTTML('binilyrics', '<tt><p begin="3" end="1">Wrong</p></tt>') === null, 'Reversed timing rejected');
  check(fromTTML('binilyrics', '<tt><p begin="1" end="2">Short</p></tt>')?.lines[0].timing === 'line', 'TTML without timed spans is line-timed');
  check(fromTTML('binilyrics', '<tt><p begin="1" dur="2s">Unsupported</p></tt>') === null, 'Unsupported timing profile fails explicitly');
  const lrcTtml = '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:lrc="http://lrc.red/lyric-ttml-internal" lrc:timing="Line"><body dur="4:08.827"><div begin="17.782" end="50.766"><p begin="17.782" end="21.492">Runaway</p></div></body></tt>';
  check(fromTTML('binilyrics', lrcTtml)?.lines[0].timing === 'line', 'Bini accepts lrc.red container timing');
  check(fromTTML('binilyrics', lrcTtml.replace(' end="50.766"', ' end="16.000"')) === null,
    'Bini rejects invalid lrc.red container bounds');
  check(fromTTML('binilyrics', lrcTtml.replace(' lrc:timing="Line"', '')) === null,
    'Bini requires the lrc.red timing marker for container timing');
  const nested = fromTTML('binilyrics', '<tt><p begin="1" end="2"><span begin="1" end="2"><span>Nested</span> text</span></p></tt>');
  check(nested?.lines[0].text === 'Nested text', 'Nested spans preserve text');
  const live = fromTTML('fixture', liveTTML ?? ttml);
  check(live !== null && validLyrics(live), 'TTML payload normalizes');
  return { checks, live: live && {
    source: live.source, lines: live.lines.length,
    wordTimedLines: live.lines.filter(line => line.timing === 'word').length,
    lineTimedLines: live.lines.filter(line => line.timing === 'line').length,
    timedSegments: live.lines.reduce((sum, line) => sum + line.segments.filter(segment => segment.startMs !== null).length, 0),
  } };
}


export async function runBoundaryChecks() {
  let checks = 0;
  function check(condition: boolean, message: string) {
    if (!condition) throw new Error(message);
    checks++;
  }
  const query = { song: 'Test', artist: 'Artist' };
  const good = fromPlain('custom', 'A short song')!;
  for (const bad of [null, {}, [], { ...good, source: '' }, { ...good, lines: [null] },
    { ...good, instrumental: true }, { ...good, lines: [{ ...good.lines[0], startMs: NaN }] },
    { ...good, lines: [{ ...good.lines[0], timing: 'word' }] },
    { ...good, lines: [{ ...good.lines[0], text: 'mismatched text' }] },
    { ...good, lines: [{ ...good.lines[0], segments: [{ text: 'bad' }] }] },
  ]) check(!validLyrics(bad), 'Malformed result rejected without throwing');
  check(validLyrics(good), 'Short lyrics valid');
  check(validLyrics({ source: 'custom', instrumental: true, lines: [] }), 'Instrumental contract valid');
  const providers: LyricsProvider[] = [
    { id: 'broken', fetch: async () => { throw new Error('offline'); } },
    { id: 'custom', fetch: async () => good },
  ];
  check((await fetchLyricsChain(query, providers))?.source === 'custom', 'Unknown provider needs no engine changes');
  const synced = fromLRC('synced', '[00:01]A short song')!;
  const word = fromTTML('word', '<tt><p begin="1" end="2"><span begin="1" end="2">A short song</span></p></tt>')!;
  check((await fetchLyricsChain(query, [
    { id: 'synced', fetch: async () => synced },
    { id: 'word', fetch: async () => word },
  ]))?.source === 'word', 'Later word timing supersedes earlier line timing');
  let laterProviderCalled = false;
  check((await fetchLyricsChain(query, [
    { id: 'synced', fetch: async () => synced },
    { id: 'word', fetch: async () => { laterProviderCalled = true; return word; } },
  ], undefined, true))?.source === 'synced' && !laterProviderCalled,
  'Line-timed fallback stops before later providers');
  const staticProviders: LyricsProvider[] = [
    { id: 'custom', fetch: async () => good },
    { id: 'synced', fetch: async () => synced },
  ];
  check((await fetchLyricsChain(query, staticProviders))?.source === 'synced', 'Synced provider supersedes earlier static lyrics');
  const collapsedProvider: LyricsProvider = { id: 'collapsed', fetch: async () => ({
    source: 'collapsed', instrumental: false, lines: ['First', 'Second'].map(text => ({
      text, timing: 'line', startMs: 0, endMs: 0, agent: null,
      segments: [{ text, startMs: null, endMs: null, role: null }],
    })),
  }) };
  check((await fetchLyricsChain(query, [collapsedProvider, { id: 'synced', fetch: async () => synced }]))?.source === 'synced',
    'Repeated zero timestamps from any provider cannot beat real synced lyrics');
  check((await fetchLyricsChain(query, [staticProviders[0], { id: 'offline', fetch: async () => null }]))?.source === 'custom',
    'Static lyrics remain fallback when no synced result exists');
  check((await fetchLyricsChain(query, [staticProviders[0], { id: 'instrumental', fetch: async () =>
    ({ source: 'instrumental', instrumental: true, lines: [] }) }, staticProviders[1]]))?.source === 'synced',
    'Instrumental response after static lyrics does not hide a later synced result');
  check((await fetchLyricsChain(query, [{ id: 'instrumental', fetch: async () =>
    ({ source: 'instrumental', instrumental: true, lines: [] }) }, staticProviders[1]]))?.source === 'synced',
    'Instrumental response does not block later synced lyrics');
  const controller = new AbortController();
  check(await fetchLyricsChain(query, [{ id: 'custom', fetch: async () => { controller.abort(); return good; } }], controller.signal) === null, 'Late response after cancellation rejected');
  check(await fetchLyricsChain(query, [{ id: 'wrong', fetch: async () => good }]) === null, 'Incorrect provenance rejected');
  check(createDefaultChain().map(provider => provider.id).join(',') === 'binilyrics,lyricsplus,spotify,amll,lrclib',
    'Word-first providers precede line-timed fallbacks');
  check(scoreCandidate(query, { titles: ['Test'], artists: ['Artist'] }) !== null, 'Matching title and artist accepted');
  check(scoreCandidate(query, { titles: ['Test (Live)'], artists: ['Artist'] }) === null, 'Unexpected live version rejected');
  check(scoreCandidate({ ...query, durationMs: 200000 },
    { titles: ['Test'], artists: ['Artist'], durationMs: 240000 }) === null, 'Wrong duration rejected');
  const cjkQuery = { song: '芒种', artist: '音阙诗听, 赵方婧', durationMs: 175000 };
  const cjkPlan = createBiniSearchPlan(cjkQuery)!;
  check(cjkPlan.song === '芒种' && cjkPlan.artist === '音阙诗听' &&
    selectBiniItems([{ track_name: '芒种', artist_name: '音阙诗听', duration: 175, lyricsUrl: 'https://example.com/a.ttml' }], cjkQuery).length === 1,
  'CJK tracks use artist matching without a unique title-only result');
  const lyricsPlusFixture = { type: 'Word', metadata: { title: 'Test', artist: 'Artist', totalDuration: '3:20' },
    lyrics: [{ time: 1000, duration: 700, text: 'Hello world', syllabus: [
      { time: 1000, duration: 300, text: 'Hello ' }, { time: 1300, duration: 400, text: 'world' },
    ] }] };
  check(adaptLyricsPlus(lyricsPlusFixture, { ...query, durationMs: 200000 })?.lines[0].timing === 'word',
    'LyricsPlus word timestamps adapt without losing spaces');
  check(adaptLyricsPlus({ ...lyricsPlusFixture, metadata: { title: 'Different', artist: 'Artist' } }, query) === null,
    'LyricsPlus wrong-song response rejected');
  check(adaptLyricsPlus({ ...lyricsPlusFixture, lyrics: [{ ...lyricsPlusFixture.lyrics[0], syllabus: [] }] }, query)?.lines[0].timing === 'line',
    'LyricsPlus line timing survives missing syllables');
  const collapsedLyricsPlus = { ...lyricsPlusFixture, lyrics: [
    { time: 0, duration: 0, text: 'First line', syllabus: [] },
    { time: 0, duration: 0, text: 'Second line', syllabus: [] },
  ] };
  const collapsedResult = adaptLyricsPlus(collapsedLyricsPlus, query);
  check(collapsedResult?.lines.length === 2 && collapsedResult.lines.every(line =>
    line.timing === 'none' && line.startMs === null && line.endMs === null),
  'LyricsPlus repeated zero timestamps are untimed, not synchronized');
  check(fromTTML('binilyrics', '<tt><p begin="0">First</p><p begin="0">Second</p></tt>')?.lines.every(line =>
    line.timing === 'none' && line.startMs === null) === true,
  'Bini TTML with repeated zero timestamps becomes untimed');
  check(fromTTML('amll', '<tt><p begin="0" end="2">First voice</p><p begin="0" end="2">Second voice</p></tt>')?.lines.every(line =>
    line.timing === 'line' && line.endMs === 2000) === true,
  'Two genuinely simultaneous timed lines remain synced');
  check(fromLRC('lrclib', '[00:00]First\n[00:00]Second')?.lines.every(line =>
    line.timing === 'none' && line.startMs === null) === true,
  'LRC with repeated zero timestamps becomes untimed');
  check(fromLRC('custom', '[offset:100]\n[00:00.05]Early')?.lines[0].startMs === 0, 'Offset clamps after subtraction');
  check(adaptLrclib({ syncedLyrics: '[00:01]<00:01.00>Word', plainLyrics: 'Word' })?.lines[0].timing === 'none', 'Unsupported enhanced LRC falls back to plain text');
  check(fromTTML('custom', '<tt><p begin="1" end="2"><![CDATA[Test & text]]></p></tt>')?.lines[0].text === 'Test & text', 'CDATA preserved');
  const originalFetch = globalThis.fetch;
  const ttml = '<tt><p begin="1" end="2">Short</p></tt>';
  const spotifyFixture = { lyrics: { syncType: 'LINE_SYNCED', lines: [
    { startTimeMs: '1000', words: 'First line', endTimeMs: '0' },
    { startTimeMs: '3000', words: 'Second line', endTimeMs: '5000' },
  ] } };
  const spotifyResult = adaptSpotifyLyrics(spotifyFixture, 5000);
  check(spotifyResult?.lines.length === 2 && spotifyResult.lines[0].endMs === 3000,
    'Spotify line timing adapts and infers missing boundary');
  check(adaptSpotifyLyrics({ lyrics: { syncType: 'LINE_SYNCED', lines: [
    { startTimeMs: '0', words: 'First', endTimeMs: '0' },
    { startTimeMs: '0', words: 'Second', endTimeMs: '0' },
  ] } })?.lines.every(line => line.timing === 'none' && line.startMs === null) === true,
  'Spotify with repeated zero timestamps becomes untimed');
  const spotifyInterlude = adaptSpotifyLyrics({ lyrics: { syncType: 'LINE_SYNCED', lines: [
    { startTimeMs: '1000', words: 'First line', endTimeMs: '9000' },
    { startTimeMs: '3000', words: '♪', endTimeMs: '0' },
    { startTimeMs: '12000', words: 'Next line', endTimeMs: '14000' },
  ] } });
  check(spotifyInterlude?.lines.length === 2 && spotifyInterlude.lines[0].endMs === 3000 &&
    spotifyInterlude.lines[1].startMs === 12000,
  'Spotify music note marks an instrumental gap without rendering as a lyric');
  check(adaptSpotifyLyrics({ lyrics: { syncType: 'UNSYNCED', lines: [{ words: 'Plain line' }] } })?.lines[0].timing === 'none',
    'Spotify unsynced lyrics adapt without invented timing');
  check(adaptSpotifyLyrics({ lyrics: { syncType: 'SYLLABLE_SYNCED', lines: [{ words: 'Unsupported' }] } }) === null,
    'Unsupported Spotify timing rejected');
  check(extractQuery({ name: 'Test', artists: [{ name: 'Artist' }], uri: 'spotify:track:track123',
    metadata: { image_url: 'spotify:image:cover' } })?.imageUri === 'spotify:image:cover',
    'Player query carries artwork URI for native Spotify lyrics request');
  const originalSpicetify = (globalThis as any).Spicetify;
  let spotifyHost = '';
  let spotifyPath = '';
  let spotifyParams: Record<string, string | boolean> = {};
  let spotifySend = async (): Promise<{ body: unknown; status: number }> => ({ body: spotifyFixture, status: 200 });
  const spotifyRequest = {
    withHost(value: string) { spotifyHost = value; return this; },
    withPath(value: string) { spotifyPath = value; return this; },
    withQueryParameters(value: Record<string, string | boolean>) { spotifyParams = value; return this; },
    withEndpointIdentifier(_value: string) { return this; },
    withAbortSignal(_value: AbortSignal) { return this; },
    send() { return spotifySend(); },
  };
  const spotifyApi = { Platform: { RequestBuilder: { build: () => spotifyRequest } } };
  try {
    let lrclibUrl = '';
    globalThis.fetch = async input => {
      if (String(input).includes('/get?')) lrclibUrl = String(input);
      return Response.json({ instrumental: true });
    };
    check((await createLrclibProvider().fetch({ ...query, album: 'Over-constrained album', durationMs: 4000 }))?.instrumental === true,
      'Instrumental transport adapts');
    check(!new URL(lrclibUrl).searchParams.has('album_name') && new URL(lrclibUrl).searchParams.get('duration') === '4',
      'LRCLIB omits album and retains duration');
    globalThis.fetch = async () => Response.json({ syncedLyrics: 'broken', plainLyrics: 'Fallback' });
    check((await createLrclibProvider().fetch(query))?.lines[0].timing === 'none', 'Plain fallback through fetcher');
    let lyricsPlusUrl = '';
    globalThis.fetch = async input => {
      lyricsPlusUrl = String(input);
      return Response.json(lyricsPlusFixture);
    };
    check((await createLyricsPlusProvider().fetch({ ...query, durationMs: 200000 }))?.lines[0].timing === 'word' &&
      new URL(lyricsPlusUrl).searchParams.get('title') === 'Test' &&
      !new URL(lyricsPlusUrl).searchParams.has('duration'),
    'LyricsPlus validates a title and artist lookup locally');
    const soundtrackTitle = 'Love Me Like You Do - From "Fifty Shades Of Grey"';
    const soundtrackUrls: URL[] = [];
    globalThis.fetch = async input => {
      soundtrackUrls.push(new URL(String(input)));
      return Response.json({ ...lyricsPlusFixture,
        metadata: { title: 'Love Me Like You Do', artist: 'Ellie Goulding', totalDuration: '4:10' } });
    };
    check(cleanTitle(soundtrackTitle) === 'Love Me Like You Do' &&
      cleanTitle('From Here to You') === 'From Here to You' &&
      (await createLyricsPlusProvider().fetch({ song: soundtrackTitle, artist: 'Ellie Goulding',
        album: 'Fifty Shades Of Grey (Original Motion Picture Soundtrack)', durationMs: 250000 }))?.lines[0].timing === 'word' &&
      soundtrackUrls.length === 1 &&
      soundtrackUrls[0].searchParams.toString() === 'title=Love+Me+Like+You+Do&artist=Ellie+Goulding',
    'Soundtrack suffix is removed before one LyricsPlus lookup');
    globalThis.fetch = async () => Response.json({ ...lyricsPlusFixture,
      metadata: { title: soundtrackTitle, artist: 'Ellie Goulding', totalDuration: '4:10' } });
    check((await createLyricsPlusProvider().fetch({ song: soundtrackTitle,
      artist: 'Ellie Goulding', durationMs: 250000 }))?.lines[0].timing === 'word',
    'LyricsPlus accepts a response that retains the quoted soundtrack suffix');
    const sunflowerUrls: URL[] = [];
    globalThis.fetch = async input => {
      sunflowerUrls.push(new URL(String(input)));
      return Response.json({ ...lyricsPlusFixture,
        metadata: { title: 'Sunflower (Spider-Man: Into the Spider-Verse)',
          artist: 'Post Malone, Swae Lee', totalDuration: '2:38.040' } });
    };
    check((await createLyricsPlusProvider().fetch({
      song: 'Sunflower - Spider-Man: Into the Spider-Verse', artist: 'Post Malone, Swae Lee',
      album: 'Sunflower - Single',
      durationMs: 158000,
    }))?.lines[0].timing === 'word' && sunflowerUrls.length === 1 &&
      sunflowerUrls[0].searchParams.get('title') === 'Sunflower' &&
      sunflowerUrls[0].searchParams.get('artist') === 'Post Malone',
    'LyricsPlus omits the known Spider-Verse movie credit with a different album');
    sunflowerUrls.length = 0;
    check((await createLyricsPlusProvider().fetch({
      song: 'Sunflower - Spider-Man: Into the Spider-Verse', artist: 'Post Malone',
      durationMs: 158000,
    }))?.lines[0].timing === 'word' && sunflowerUrls.length === 1 &&
      sunflowerUrls[0].searchParams.get('title') === 'Sunflower',
    'LyricsPlus omits the movie credit when album metadata is missing');
    globalThis.fetch = async () => Response.json({ ...lyricsPlusFixture,
      metadata: { title: 'Sunflower (Different Film)', artist: 'Post Malone, Swae Lee',
        totalDuration: '2:38.040' } });
    check(await createLyricsPlusProvider().fetch({
      song: 'Sunflower - Spider-Man: Into the Spider-Verse', artist: 'Post Malone',
      durationMs: 158000,
    }) === null, 'LyricsPlus rejects a different movie title even with matching artist and duration');
    globalThis.fetch = async input => {
      sunflowerUrls.push(new URL(String(input)));
      return Response.json({ ...lyricsPlusFixture,
        metadata: { title: 'Sunflower', artist: 'Post Malone', totalDuration: '2:38' } });
    };
    sunflowerUrls.length = 0;
    check((await createLyricsPlusProvider().fetch({
      song: 'Sunflower - Film Title', artist: 'Post Malone',
      album: 'Film Title (Original Motion Picture Soundtrack)', durationMs: 158000,
    }))?.lines[0].timing === 'word' && sunflowerUrls[0].searchParams.get('title') === 'Sunflower',
    'LyricsPlus omits another subtitle only when the album confirms it');
    sunflowerUrls.length = 0;
    check(await createLyricsPlusProvider().fetch({
      song: 'Run - Away', artist: 'Post Malone', album: 'Unrelated Album', durationMs: 158000,
    }) === null && sunflowerUrls[0].searchParams.get('title') === 'Run - Away',
    'LyricsPlus preserves a title suffix unrelated to the album');
    const strictQuery = { ...query, album: 'Other release', durationMs: 200000 };
    let missingAttempts = 0;
    globalThis.fetch = async () => { missingAttempts++; return new Response(null, { status: 404 }); };
    check(await createLyricsPlusProvider().fetch(strictQuery) === null && missingAttempts === 1,
      'LyricsPlus does not retry a missing title and artist lookup');
    for (const [metadata, mismatch] of [
      [{ title: 'Different' }, 'title'],
      [{ artist: 'Different' }, 'artist'],
      [{ totalDuration: '3:28' }, 'duration'],
      [{ totalDuration: '' }, 'missing duration'],
    ] as const) {
      let rejectedAttempts = 0;
      globalThis.fetch = async () => { rejectedAttempts++; return Response.json({ ...lyricsPlusFixture,
        metadata: { ...lyricsPlusFixture.metadata, ...metadata } }); };
      check(await createLyricsPlusProvider().fetch(strictQuery) === null && rejectedAttempts === 1,
        `LyricsPlus rejects a recording with mismatched ${mismatch} without retrying`);
    }
    let serverErrorAttempts = 0;
    globalThis.fetch = async () => { serverErrorAttempts++; return new Response(null, { status: 500 }); };
    check(await createLyricsPlusProvider().fetch(strictQuery) === null && serverErrorAttempts === 1,
      'LyricsPlus does not retry server errors');
    let rateLimitAttempts = 0;
    globalThis.fetch = async () => { rateLimitAttempts++; return new Response(null, { status: 429 }); };
    check(await createLyricsPlusProvider().fetch(strictQuery) === null && rateLimitAttempts === 1,
      'LyricsPlus falls through after one rate-limited request');
    const biniLookupRequests: string[] = [];
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      biniLookupRequests.push(url.href);
      if (url.hostname === 'lyrics-api.binimum.org' && url.pathname === '/') {
        return Response.json({ results: [{ track_name: 'Test', artist_name: 'Artist', duration: 201,
          lyricsUrl: 'https://example.com/lookup.ttml' }] });
      }
      if (url.href === 'https://example.com/lookup.ttml') return new Response(ttml);
      throw new Error('A successful lookup should not search again');
    };
    check((await createBiniLyricsProvider().fetch({ ...query, album: 'Different release', durationMs: 200500 }))?.lines[0].timing === 'line' &&
      biniLookupRequests.filter(url => url.includes('lyrics-api.binimum.org')).length === 1 &&
      new URL(biniLookupRequests[0]).searchParams.get('track') === 'Test' &&
      new URL(biniLookupRequests[0]).searchParams.get('artist') === 'Artist' &&
      !new URL(biniLookupRequests[0]).searchParams.has('duration') &&
      !new URL(biniLookupRequests[0]).searchParams.has('album'),
    'Bini sends one track and artist lookup, then matches duration locally');
    const loveMeNotCalls: string[] = [];
    globalThis.fetch = async input => {
      const url = String(input);
      loveMeNotCalls.push(url);
      if (url.startsWith('https://lyrics-api.binimum.org/')) return Response.json({ results: [
        { track_name: 'Love Me Not (feat. Rex Orange County)', artist_name: 'Ravyn Lenae',
          album_name: 'Love Me Not (feat. Rex Orange County) - Single', duration: 188,
          timing_type: 'word', lyricsUrl: 'https://lrc.red/s/featured.ttml' },
        { track_name: 'Love Me Not (Mixed)', artist_name: 'Ravyn Lenae',
          album_name: "Today's Hits (DJ Mix)", duration: 145,
          timing_type: 'none', lyricsUrl: 'https://lrc.red/s/mixed.ttml' },
        { track_name: 'Love Me Not', artist_name: 'Ravyn Lenae',
          album_name: "Bird's Eye", duration: 213,
          timing_type: 'word', lyricsUrl: 'https://lrc.red/s/exact.ttml' },
      ] });
      if (url === 'https://lrc.red/s/exact.ttml') {
        return new Response('<tt><p begin="1" end="2"><span begin="1" end="2">Love</span></p></tt>');
      }
      throw new Error(`Wrong lyric candidate requested: ${url}`);
    };
    check((await createBiniLyricsProvider().fetch({ song: 'Love Me Not', artist: 'Ravyn Lenae',
      album: "Bird's Eye", durationMs: 213000 }))?.lines[0].timing === 'word' &&
      loveMeNotCalls.length === 2 &&
      new URL(loveMeNotCalls[0]).searchParams.toString() === 'track=Love+Me+Not&artist=Ravyn+Lenae' &&
      loveMeNotCalls[1] === 'https://lrc.red/s/exact.ttml',
    'One Bini lookup selects the exact recording from featured and mixed variants');
    const biniWordRequests: string[] = [];
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      biniWordRequests.push(url.href);
      if (url.hostname === 'lyrics-api.binimum.org' && url.pathname === '/') {
        return Response.json({ results: [
          { track_name: 'Test', artist_name: 'Artist', lyricsUrl: 'https://example.com/line.ttml' },
          { track_name: 'Test', artist_name: 'Artist', lyricsUrl: 'https://example.com/word.ttml' },
        ] });
      }
      if (url.pathname === '/line.ttml') return new Response(ttml);
      if (url.pathname === '/word.ttml') return new Response('<tt><p begin="1" end="2"><span begin="1" end="2">Short</span></p></tt>');
      throw new Error('Bini should finish after the lookup candidates');
    };
    check((await createBiniLyricsProvider().fetch(query))?.lines[0].timing === 'word' &&
      biniWordRequests.filter(url => url.includes('lyrics-api.binimum.org')).length === 1,
    'Bini prefers word timing over an earlier line-timed lookup candidate');
    const biniFallbackRequests: string[] = [];
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      biniFallbackRequests.push(url.href);
      if (url.hostname === 'lyrics-api.binimum.org') {
        return Response.json({ results: [
          { track_name: 'Test', artist_name: 'Artist', lyricsUrl: 'https://example.com/static.ttml' },
        ] });
      }
      if (url.pathname === '/static.ttml') return new Response('<tt><p>Static</p></tt>');
      throw new Error('Unexpected Bini URL');
    };
    check((await createBiniLyricsProvider().fetch(query))?.lines[0].timing === 'none' &&
      biniFallbackRequests.filter(url => url.includes('lyrics-api.binimum.org')).length === 1 &&
      biniFallbackRequests.filter(url => url === 'https://example.com/static.ttml').length === 1,
    'Bini keeps the static result without a second metadata query');
    globalThis.fetch = async input => {
      const url = String(input);
      if (url.startsWith('https://lyrics-api.binimum.org/')) {
        return Response.json({ results: [{ track_name: 'Test', artist_name: 'Artist',
          lyricsUrl: 'https://example.com/line.ttml' }] });
      }
      if (url === 'https://example.com/line.ttml') return new Response(ttml);
      if (url.startsWith('https://lyricsplus.binimum.org/')) return Response.json(lyricsPlusFixture);
      throw new Error('Word timing should stop the chain before later providers');
    };
    check((await fetchLyrics({ ...query, skipCache: true }, undefined, new LyricsCache()))?.source === 'lyricsplus',
      'LyricsPlus word timing supersedes Bini line timing');
    let fallbackCalls = 0;
    globalThis.fetch = async input => {
      const url = String(input);
      if (url.startsWith('https://lyrics-api.binimum.org/')) {
        return Response.json({ results: [{ track_name: 'Test', artist_name: 'Artist',
          lyricsUrl: 'https://example.com/line.ttml' }] });
      }
      if (url === 'https://example.com/line.ttml') return new Response(ttml);
      if (url.startsWith('https://lyricsplus.binimum.org/')) {
        return Response.json({ ...lyricsPlusFixture, lyrics: [{ time: 1000, duration: 700,
          text: 'Hello world', syllabus: [] }] });
      }
      fallbackCalls++;
      throw new Error('Line-synced primary result should stop before fallbacks');
    };
    (globalThis as any).Spicetify = spotifyApi;
    spotifySend = async () => {
      fallbackCalls++;
      return { body: spotifyFixture, status: 200 };
    };
    check((await fetchLyrics({ ...query, spotifyId: 'track123', imageUri: 'spotify:image:cover', skipCache: true }, undefined, new LyricsCache()))?.source === 'binilyrics' &&
      fallbackCalls === 0, 'Bini line timing stops before Spotify and AMLL');
    let spotifyFallbackCalls = 0;
    globalThis.fetch = async input => {
      const url = String(input);
      if (url.startsWith('https://lyrics-api.binimum.org/')) return Response.json({ results: [] });
      if (url.startsWith('https://lyricsplus.binimum.org/')) {
        return Response.json(collapsedLyricsPlus);
      }
      throw new Error('Spotify line timing should stop before AMLL and LRCLIB');
    };
    spotifySend = async () => {
      spotifyFallbackCalls++;
      return { body: spotifyFixture, status: 200 };
    };
    const providerMessages: unknown[][] = [];
    const originalInfo = console.info;
    console.info = (...args) => { providerMessages.push(args); };
    let spotifyFallback: Lyrics | null;
    try {
      spotifyFallback = await fetchLyrics({ ...query, spotifyId: 'track123', imageUri: 'spotify:image:cover', skipCache: true }, undefined, new LyricsCache());
    } finally {
      console.info = originalInfo;
    }
    const providerPath = providerMessages.find(([message]) => message === '[Liquid Lyrics] Provider path:')?.[1] as
      { selected?: string; attempts?: Array<{ provider: string; outcome: string }> } | undefined;
    check(spotifyFallback?.source === 'spotify' && spotifyFallbackCalls === 1,
      'Static primary lyrics fall through to Spotify line timing');
    check(providerPath?.selected === 'spotify' &&
      providerPath.attempts?.map(attempt => `${attempt.provider}:${attempt.outcome}`).join(',') ===
        'binilyrics:unavailable,lyricsplus:static,spotify:line',
    'Provider path reports only observed outcomes in order');
    const cachedNote = { ...spotifyInterlude!, lines: [
      { ...spotifyInterlude!.lines[0], endMs: 9000 },
      { text: '♪', timing: 'line' as const, startMs: 3000, endMs: 12000, agent: null,
        segments: [{ text: '♪', startMs: null, endMs: null, role: null }] },
      spotifyInterlude!.lines[1],
    ] };
    const cacheWithNote = new LyricsCache();
    const spotifyQuery = { ...query, spotifyId: 'track123', imageUri: 'spotify:image:cover' };
    await cacheWithNote.set(spotifyQuery, cachedNote);
    const refreshed = await fetchLyrics(spotifyQuery, undefined, cacheWithNote);
    check(refreshed?.source === 'spotify' && !refreshed.cached && spotifyFallbackCalls === 2 &&
      !refreshed.lines.some(line => line.text === '♪'),
    'Cached Spotify music-note lines are refreshed through the provider');
    for (const source of ['lyricsplus', 'binilyrics']) {
      const staleTiming: Lyrics = { ...collapsedResult!, source, lines: collapsedResult!.lines.map(line =>
        ({ ...line, timing: 'line', startMs: 0, endMs: 0 })) };
      const cacheWithCollapsed = new LyricsCache();
      await cacheWithCollapsed.set(spotifyQuery, staleTiming);
      const recovered = await fetchLyrics(spotifyQuery, undefined, cacheWithCollapsed);
      check(recovered?.source === 'spotify' && !recovered.cached &&
        !recovered.lines.some(line => line.startMs === 0 && line.endMs === 0),
      `Cached ${source} zero-time rows cannot block synced fallback`);
    }
    (globalThis as any).Spicetify = originalSpicetify;
    let biniAttempts = 0;
    globalThis.fetch = async input => {
      if (String(input).includes('lyrics-api.binimum.org')) {
        biniAttempts++;
        throw new TypeError('CORS blocked');
      }
      if (String(input).includes('lyricsplus.binimum.org')) return Response.json(lyricsPlusFixture);
      throw new Error('Later provider should not run');
    };
    const afterBiniFailure = await fetchLyrics({ ...query, skipCache: true }, undefined, new LyricsCache());
    check(biniAttempts === 1 && afterBiniFailure?.source === 'lyricsplus' && afterBiniFailure.lines[0].timing === 'word',
      'Bini network failures stop its variants and fall through to LyricsPlus');
    const staticCache = new LyricsCache();
    await staticCache.set(query, { ...good, source: 'lrclib' });
    const upgraded = await fetchLyrics(query, undefined, staticCache);
    check(upgraded?.source === 'lyricsplus' && upgraded.lines[0].timing === 'word' && !upgraded.cached,
      'Cached static lyrics are upgraded when a synced provider responds');
    let mixedBiniAttempts = 0;
    globalThis.fetch = async input => {
      const url = String(input);
      if (url.startsWith('https://lyrics-api.binimum.org/')) {
        mixedBiniAttempts++;
        if (mixedBiniAttempts === 1) throw new TypeError('CORS blocked');
        return Response.json({ results: [{ track_name: 'Test', artist_name: 'Artist', lyricsUrl: 'https://example.com/test.ttml' }] });
      }
      if (url === 'https://example.com/test.ttml') return new Response(ttml);
      throw new Error('Later provider should not run');
    };
    check(await createBiniLyricsProvider().fetch(query) === null && mixedBiniAttempts === 1,
      'Bini does not repeat metadata searches after a network failure');
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/get') && url.searchParams.has('spotifyId')) {
        return Response.json({ data: { lyrics: '<tt><p>Static</p></tt>' } });
      }
      if (url.pathname.endsWith('/search')) return Response.json({ data: { items: [
        { id: 7, musicNames: ['Test'], artistNames: ['Artist'] },
      ] } });
      return Response.json({ data: { lyrics: ttml } });
    };
    check((await createAmllProvider().fetch({ ...query, spotifyId: 'track123' }))?.lines[0].timing === 'line',
      'AMLL search can replace a static exact-ID response');
    let albumFiltered = false;
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/search')) {
        albumFiltered = url.searchParams.has('albumName');
        return Response.json({ data: { items: [
          { id: 7, musicNames: ['Test'], artistNames: ['Artist'] },
        ] } });
      }
      return Response.json({ data: { lyrics: ttml } });
    };
    check((await createAmllProvider().fetch({ ...query, album: 'Different release' }))?.lines[0].timing === 'line' && !albumFiltered,
      'AMLL searches once without a restrictive album filter');
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      return url.pathname.endsWith('/get')
        ? Response.json({ plainLyrics: 'Static exact' })
        : Response.json([{ trackName: 'Test', artistName: 'Artist', syncedLyrics: '[00:01]Synced search' }]);
    };
    check((await createLrclibProvider().fetch(query))?.lines[0].timing === 'line',
      'LRCLIB search can replace static exact response');
    (globalThis as any).Spicetify = spotifyApi;
    spotifySend = async () => ({ body: spotifyFixture, status: 200 });
    check((await createSpotifyLyricsProvider().fetch({ ...query, spotifyId: 'track123', imageUri: 'spotify:image:cover', durationMs: 5000 }))?.source === 'spotify' &&
      spotifyHost === 'https://spclient.wg.spotify.com/color-lyrics/v2' &&
      spotifyPath === '/track/track123/image/spotify%3Aimage%3Acover' &&
      spotifyParams.format === 'json' && spotifyParams.vocalRemoval === false,
      'Spotify provider uses native request builder with track and image IDs');
    check(await createSpotifyLyricsProvider().fetch({ ...query, spotifyId: undefined }) === null,
      'Spotify provider requires track ID');
    check(await createSpotifyLyricsProvider().fetch({ ...query, spotifyId: 'track123' }) === null,
      'Spotify provider requires image URI');
    spotifySend = () => new Promise(() => {});
    const spotifyAbort = new AbortController();
    setTimeout(() => spotifyAbort.abort(), 10);
    check(await createSpotifyLyricsProvider().fetch({ ...query, spotifyId: 'track123', imageUri: 'spotify:image:cover' }, spotifyAbort.signal) === null,
      'Spotify provider stops waiting when caller aborts');
    (globalThis as any).Spicetify = originalSpicetify;
    globalThis.fetch = async () => { throw new Error('network unavailable'); };
    for (const provider of createDefaultChain()) check(await provider.fetch(query) === null, 'Offline provider returns null');
    const stopped = new AbortController();
    stopped.abort();
    let requested = false;
    globalThis.fetch = async () => { requested = true; return new Response('unexpected'); };
    for (const provider of createDefaultChain()) check(await provider.fetch(query, stopped.signal) === null, 'Pre-aborted provider returns null');
    check(!requested, 'Pre-aborted providers make no network requests');
    // Cache boundary checks
    check(normalizeString('  Glass  Animals ') === 'glass animals', 'Cache key normalization');
    const cacheKeys = getCacheKeys({ song: 'Heat Waves', artist: 'Glass Animals', spotifyId: '123' });
    check(cacheKeys.includes('v4:id:123') && cacheKeys.includes('v4:meta:glass animals:heat waves'), 'Versioned cache dual keys');

    const testCache = new LyricsCache();
    let networkCalls = 0;
    globalThis.fetch = async () => {
      networkCalls++;
      return Response.json({ syncedLyrics: '[00:01]Short' });
    };

    // First call: hits network
    await testCache.set(query, { ...fromPlain('retired-provider', 'Old result')! });
    const call1 = await fetchLyrics(query, undefined, testCache);
    check(call1?.source === 'lrclib' && !call1.cached && networkCalls > 0, 'Initial fetch populates cache');
    const callsAfterFirst = networkCalls;

    // Second call: hits cache without network
    const call2 = await fetchLyrics(query, undefined, testCache);
    check(call2?.source === 'lrclib' && call2.cached === true && networkCalls === callsAfterFirst,
      'Line timing chosen after provider search is cached');

    // Third call with skipCache: hits network
    const call3 = await fetchLyrics({ ...query, skipCache: true }, undefined, testCache);
    check(call3?.source === 'lrclib' && !call3.cached && networkCalls > callsAfterFirst, 'skipCache bypasses cache');

    // Negative caching check
    const negQuery = { song: 'Unknown', artist: 'Unknown' };
    globalThis.fetch = async () => { networkCalls++; return new Response('not found', { status: 404 }); };
    const neg1 = await fetchLyrics(negQuery, undefined, testCache);
    check(neg1 === null, 'Negative fetch returns null');
    const negCallsAfterFirst = networkCalls;
    const neg2 = await fetchLyrics(negQuery, undefined, testCache);
    check(neg2 === null && networkCalls > negCallsAfterFirst, 'Transient and unknown misses are retried');

    const cleanCache = new LyricsCache();
    let cleanCalls = 0;
    globalThis.fetch = async input => {
      cleanCalls++;
      const url = new URL(String(input));
      if (url.pathname.endsWith('/getLyrics')) return Response.json({ results: [] });
      return Response.json(url.searchParams.get('track_name') === 'Test'
        ? { syncedLyrics: '[00:01]Clean match' } : { plainLyrics: 'Static raw match' });
    };
    const remastered = { song: 'Test (Remastered)', artist: 'Artist' };
    const cleanResult = await fetchLyrics(remastered, undefined, cleanCache);
    check(cleanResult?.lines[0].timing === 'line' && cleanCalls > 0,
      'Static raw result does not block synced lyrics from cleaned metadata');
    const callsAfterClean = cleanCalls;
    const cachedCleanResult = await fetchLyrics(remastered, undefined, cleanCache);
    check(cachedCleanResult?.cached === true && cachedCleanResult.lines[0].timing === 'line' && cleanCalls === callsAfterClean,
      'Cleaned line timing is cached for the original track query');
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as any).Spicetify = originalSpicetify;
  }
  checks += (await runBudgetChecks()).checks;
  return { checks };
}
