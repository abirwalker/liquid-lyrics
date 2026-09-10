import { adaptBiniLyrics, createBiniLyricsProvider, createBiniSearchPlan, selectBiniItems } from '../src/lyrics/providers/binilyrics';
import { adaptLrclib, createLrclibProvider } from '../src/lyrics/providers/lrclib';
import { adaptSpotifyLyrics, createSpotifyLyricsProvider } from '../src/lyrics/providers/spotify';
import { fromLRC, fromPlain, fromTTML } from '../src/lyrics/formats';
import { isValidResult as validLyrics } from '../src/types/types';
import type { LyricsResult as Lyrics, LyricsProvider } from '../src/types/types';
import { fetchLyricsChain, createDefaultChain, fetchLyrics } from '../src/lyrics/chain';
import { LyricsCache, getCacheKeys, normalizeString } from '../src/storage/cache';

export function runIpadChecks(bini: unknown, lrc: unknown) {
  const biniResult = adaptBiniLyrics(bini);
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
  const equivalent = [fromTTML('binilyrics', ttml), adaptBiniLyrics(ttml)];
  for (const result of equivalent) {
    check(result !== null && validLyrics(result), 'Provider wrapper returns validated contract');
    check(result?.lines[0].text === 'Hello world & ♥', 'Spacing, entities, and attribute order preserved');
    check(result?.lines[0].timing === 'word' && result.lines[0].segments[0].startMs === 1000, 'Word timing in milliseconds');
  }
  check(JSON.stringify(equivalent[0]?.lines) === JSON.stringify(equivalent[1]?.lines), 'BiniLyrics adapter preserves the shared TTML result');
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
  check(adaptLrclib(null) === null && adaptBiniLyrics(42) === null, 'Malformed envelopes rejected');
  check(fromTTML('binilyrics', '<tt><p>broken</tt>') === null, 'Malformed XML rejected');
  check(fromTTML('binilyrics', '<tt><p begin="bad" end="3">Wrong</p></tt>') === null, 'Invalid timestamp is not silently zero');
  check(fromTTML('binilyrics', '<tt><p begin="3" end="1">Wrong</p></tt>') === null, 'Reversed timing rejected');
  check(fromTTML('binilyrics', '<tt><p begin="1" end="2">Short</p></tt>')?.lines[0].timing === 'line', 'TTML without timed spans is line-timed');
  check(fromTTML('binilyrics', '<tt><p begin="1" dur="2s">Unsupported</p></tt>') === null, 'Unsupported timing profile fails explicitly');
  const nested = fromTTML('binilyrics', '<tt><p begin="1" end="2"><span begin="1" end="2"><span>Nested</span> text</span></p></tt>');
  check(nested?.lines[0].text === 'Nested text', 'Nested spans preserve text');
  const live = adaptBiniLyrics(liveTTML ?? ttml);
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
  const controller = new AbortController();
  check(await fetchLyricsChain(query, [{ id: 'custom', fetch: async () => { controller.abort(); return good; } }], controller.signal) === null, 'Late response after cancellation rejected');
  check(await fetchLyricsChain(query, [{ id: 'wrong', fetch: async () => good }]) === null, 'Incorrect provenance rejected');
  check(createDefaultChain().map(provider => provider.id).join(',') === 'binilyrics,lrclib,spotify', 'Three active providers in order');
  const featuredPlan = createBiniSearchPlan({ song: 'Be Kind (with Halsey)', artist: 'Marshmello, Halsey' });
  check(featuredPlan?.term === 'Be Kind Marshmello' && !featuredPlan.titleOnly, 'Bini uses one cleaned metadata query');
  const localizedQuery = { song: '芒种', artist: '音阙诗听, 赵方婧', durationMs: 216000 };
  const localizedPlan = createBiniSearchPlan(localizedQuery)!;
  check(localizedPlan.term === '芒种' && localizedPlan.titleOnly, 'Bini uses title-only query for localized CJK metadata');
  const localizedItem = { track_name: '芒种', artist_name: "Listening to Yinque's Poems & Fangjing Zhao",
    duration: 216, timing_type: 'word', lyricsUrl: 'https://fixture.invalid/localized' };
  check(selectBiniItems([localizedItem], localizedQuery, localizedPlan).length === 1, 'Unique exact title and duration accepted');
  check(selectBiniItems([{ ...localizedItem, duration: 240 }], localizedQuery, localizedPlan).length === 0,
    'Title-only duration mismatch rejected');
  check(selectBiniItems([localizedItem, { ...localizedItem }], localizedQuery, localizedPlan).length === 0,
    'Ambiguous title-only candidates rejected');
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
  check(adaptSpotifyLyrics({ lyrics: { syncType: 'UNSYNCED', lines: [{ words: 'Plain line' }] } })?.lines[0].timing === 'none',
    'Spotify unsynced lyrics adapt without invented timing');
  check(adaptSpotifyLyrics({ lyrics: { syncType: 'SYLLABLE_SYNCED', lines: [{ words: 'Unsupported' }] } }) === null,
    'Unsupported Spotify timing rejected');
  const originalSpicetify = (globalThis as any).Spicetify;
  try {
    let lrclibUrl = '';
    globalThis.fetch = async input => { lrclibUrl = String(input); return Response.json({ instrumental: true }); };
    check((await createLrclibProvider().fetch({ ...query, album: 'Over-constrained album', durationMs: 4000 }))?.instrumental === true,
      'Instrumental transport adapts');
    check(!new URL(lrclibUrl).searchParams.has('album_name') && new URL(lrclibUrl).searchParams.get('duration') === '4',
      'LRCLIB omits album and retains duration');
    globalThis.fetch = async () => Response.json({ syncedLyrics: 'broken', plainLyrics: 'Fallback' });
    check((await createLrclibProvider().fetch(query))?.lines[0].timing === 'none', 'Plain fallback through fetcher');
    globalThis.fetch = async input => {
      const url = String(input);
      if (url.includes('getLyrics')) return Response.json({ results: [
        null, { track_name: 42 },
        { track_name: 'Test', artist_name: 'Artist', lyricsUrl: 'https://fixture.invalid/failed' },
        { track_name: 'Test', artist_name: 'Artist', lyricsUrl: 'https://fixture.invalid/good' },
      ] });
      if (url.endsWith('failed')) throw new Error('candidate unavailable');
      return new Response(ttml);
    };
    check((await createBiniLyricsProvider().fetch(query))?.source === 'binilyrics', 'Malformed search items and failed candidate do not block valid candidate');
    let spotifyUrl = '';
    (globalThis as any).Spicetify = { CosmosAsync: { get: async (url: string) => {
      spotifyUrl = url;
      return spotifyFixture;
    } } };
    check((await createSpotifyLyricsProvider().fetch({ ...query, spotifyId: 'track123', durationMs: 5000 }))?.source === 'spotify' &&
      spotifyUrl.includes('/track/track123?'), 'Spotify provider uses track ID and adapts Cosmos response');
    check(await createSpotifyLyricsProvider().fetch({ ...query, spotifyId: undefined }) === null,
      'Spotify provider requires track ID');
    (globalThis as any).Spicetify.CosmosAsync.get = () => new Promise(() => {});
    const spotifyAbort = new AbortController();
    setTimeout(() => spotifyAbort.abort(), 10);
    check(await createSpotifyLyricsProvider().fetch({ ...query, spotifyId: 'track123' }, spotifyAbort.signal) === null,
      'Spotify provider stops waiting when caller aborts');
    (globalThis as any).Spicetify = originalSpicetify;
    globalThis.fetch = async () => { throw new Error('network unavailable'); };
    for (const provider of createDefaultChain()) check(await provider.fetch(query) === null, 'Offline provider returns null');
    const stopped = new AbortController();
    stopped.abort();
    let requested = false;
    globalThis.fetch = async () => { requested = true; return new Response('unexpected'); };
    for (const provider of createDefaultChain()) check(await provider.fetch(query, stopped.signal) === null, 'Pre-aborted provider returns null');
    // Cache boundary checks
    check(normalizeString('  Glass  Animals ') === 'glass animals', 'Cache key normalization');
    const cacheKeys = getCacheKeys({ song: 'Heat Waves', artist: 'Glass Animals', spotifyId: '123' });
    check(cacheKeys.includes('v2:id:123') && cacheKeys.includes('v2:meta:glass animals:heat waves'), 'Versioned cache dual keys');

    const testCache = new LyricsCache();
    let networkCalls = 0;
    globalThis.fetch = async () => {
      networkCalls++;
      return Response.json({ syncedLyrics: '[00:01]Short' });
    };

    // First call: hits network
    await testCache.set(query, { ...fromPlain('retired-provider', 'Old result')! });
    const call1 = await fetchLyrics(query, undefined, testCache);
    check(call1?.source === 'lrclib' && !call1.cached && networkCalls === 2, 'Initial fetch populates cache');

    // Second call: hits cache without network
    const call2 = await fetchLyrics(query, undefined, testCache);
    check(call2?.source === 'lrclib' && call2.cached === true && networkCalls === 2, 'Repeat fetch served from cache');

    // Third call with skipCache: hits network
    const call3 = await fetchLyrics({ ...query, skipCache: true }, undefined, testCache);
    check(call3?.source === 'lrclib' && !call3.cached && networkCalls === 4, 'skipCache bypasses cache');

    // Negative caching check
    const negQuery = { song: 'Unknown', artist: 'Unknown' };
    globalThis.fetch = async () => { networkCalls++; return new Response('not found', { status: 404 }); };
    const neg1 = await fetchLyrics(negQuery, undefined, testCache);
    check(neg1 === null, 'Negative fetch returns null');
    const negCallsAfterFirst = networkCalls;
    const neg2 = await fetchLyrics(negQuery, undefined, testCache);
    check(neg2 === null && networkCalls === negCallsAfterFirst, 'Negative cache suppresses subsequent network calls');
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as any).Spicetify = originalSpicetify;
  }
  return { checks };
}
