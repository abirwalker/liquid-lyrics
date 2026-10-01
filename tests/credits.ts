import { createSpotifyCreditsLookup, parseSpotifySongwriters } from '../src/player/credits';
import { fromTTML } from '../src/lyrics/formats';
import { adaptLyricsPlus } from '../src/lyrics/providers/lyricsplus';
import { getSongwriters, isValidResult } from '../src/types/types';

export async function runCreditChecks() {
  let checks = 0;
  function check(ok: unknown, message: string) {
    if (!ok) throw new Error(message);
    checks++;
  }
  const response = (items: unknown[]) => ({ data: { trackUnion: {
    __typename: 'Track', creditsTrait: { contributors: { items } },
  } } });
  const writers = response([
    { name: '  First   Writer ', role: 'Composer' },
    { name: 'First Writer', role: 'Lyricist' },
    { name: 'Second Writer', roleGroup: { name: 'Written by' } },
    { name: 'Performer', role: 'MainArtist', roleGroup: { name: 'Performed by' } },
    { name: 'Producer', role: 'Producer' }, null, { name: 1, role: 'Composer' },
  ]);
  check(parseSpotifySongwriters(writers)?.join('|') === 'First Writer|Second Writer',
    'Spotify credits include writing roles only, with normalized unique names');
  check(parseSpotifySongwriters(response([]))?.length === 0, 'Empty native contributors are valid');
  check(parseSpotifySongwriters({}) === null && parseSpotifySongwriters({ ...writers, errors: [{}] }) === null,
    'Malformed and partial-error responses are not cached as empty credits');
  check(getSongwriters([' Name ', 'Name', '', null]).join('|') === 'Name', 'Writer normalization');
  const ttml = '<tt xmlns="http://www.w3.org/ns/ttml"><head><metadata>' +
    '<iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal"><songwriters>' +
    '<songwriter>First Writer</songwriter></songwriters></iTunesMetadata>' +
    '<songwriter xmlns="urn:unrelated">Not a songwriter credit</songwriter>' +
    '</metadata></head><body><div><p begin="1s" end="2s">Fixture</p></div></body></tt>';
  const parsed = fromTTML('binilyrics', ttml);
  check(parsed?.songwriters?.join('|') === 'First Writer', 'TTML writer metadata excludes unrelated tags');
  check(isValidResult({ ...parsed, songwriters: undefined }) &&
    !isValidResult({ ...parsed, songwriters: [7] }), 'Older cached results work; malformed writers are rejected');
  const lp = adaptLyricsPlus({ metadata: { title: 'Fixture', artist: 'Artist', totalDuration: '0:02',
    songWriters: ['First Writer', null] }, lyrics: [{ text: 'Fixture', time: 1000, duration: 1000 }] },
  { song: 'Fixture', artist: 'Artist', durationMs: 2000 });
  check(lp?.songwriters?.join('|') === 'First Writer', 'LyricsPlus preserves its writer metadata');

  const id = '1'.repeat(22);
  let calls = 0;
  let finish!: (value: unknown) => void;
  let result: unknown = writers;
  let fail = false;
  const api: NonNullable<Spicetify.API['GraphQL']> = {
    Definitions: { queryTrackCreditsGroupedModal: { name: 'Synthetic definition' } },
    Request: async (_definition, variables) => {
      calls++;
      check(variables.trackUri === `spotify:track:${id}` && variables.contributorsLimit === 100 &&
        variables.contributorsOffset === 0, 'Native query uses the installed client variables');
      if (fail) throw new Error('Offline fixture');
      return result;
    },
  };
  const lookup = createSpotifyCreditsLookup(() => api);
  check((await lookup('invalid')).length === 0 && calls === 0, 'Non-track IDs make no request');
  check((await createSpotifyCreditsLookup(() => undefined)(id)).length === 0 && calls === 0,
    'Unavailable native GraphQL leaves provider-only credits');
  result = new Promise(resolve => { finish = resolve; });
  const first = lookup(id);
  const second = lookup(id);
  await Promise.resolve();
  check(calls === 1, 'Simultaneous credit lookups share one request');
  finish(writers);
  const names = await first;
  check((await second).join('|') === names.join('|'), 'Shared request serves both callers');
  names.push('Mutated outside cache');
  check((await lookup(id)).length === 2 && calls === 1, 'Successful cache is reused and protected from mutation');

  result = response([]);
  const emptyLookup = createSpotifyCreditsLookup(() => api);
  await emptyLookup(id);
  const callsAfterEmpty = calls;
  check((await emptyLookup(id)).length === 0 && calls === callsAfterEmpty,
    'Native empty credits are reused without another network request');
  const retryLookup = createSpotifyCreditsLookup(() => api);
  fail = true;
  check((await retryLookup(id)).length === 0, 'Network failures leave lyrics intact');
  fail = false;
  result = writers;
  check((await retryLookup(id)).length === 2, 'A failed credit lookup can recover on a later visit');
  return { checks };
}
