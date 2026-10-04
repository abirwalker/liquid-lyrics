import { createLyricsController, initPlayerListener, type LyricsState } from '../src/player/listener';
import type { LyricsResult } from '../src/types/types';

export async function runSharedLyricsStateChecks() {
  let checks = 0;
  function check(condition: unknown, message: string) {
    if (!condition) throw new Error(message);
    checks++;
  }
  const logger = { info() {}, error() {} };
  const first = { uri: 'spotify:track:first', name: 'First', artists: [{ name: 'Artist' }] };
  const second = { uri: 'spotify:track:second', name: 'Second', artists: [{ name: 'Artist' }] };
  const result: LyricsResult = { source: 'fixture', instrumental: false, lines: [{
    text: 'First line', timing: 'line', startMs: 1000, endMs: 2000, agent: null,
    segments: [{ text: 'First line', startMs: null, endMs: null, role: null }],
  }] };
  let fetches = 0;
  const pending: Array<{ signal?: AbortSignal; resolve: (result: LyricsResult | null) => void }> = [];
  const controller = createLyricsController((_query, signal) => {
    fetches++;
    return new Promise(resolve => pending.push({ signal, resolve }));
  }, logger);
  const page: LyricsState[] = [];
  const sidebar: LyricsState[] = [];
  const unsubscribePage = controller.subscribe(state => page.push(state));
  controller.subscribe(state => sidebar.push(state));
  check(page[0] === sidebar[0] && page[0].status === 'idle', 'Views receive the same initial snapshot');
  const firstTask = controller.onTrackChange(first);
  await controller.onTrackChange(first);
  check(fetches === 1 && controller.getState().status === 'loading', 'Repeated track events share one in-flight lookup');
  const late: LyricsState[] = [];
  const unsubscribeLate = controller.subscribe(state => late.push(state));
  check(late[0] === controller.getState() && late[0].status === 'loading' && fetches === 1,
    'Opening a view during loading observes the existing lookup');
  pending[0].resolve(result);
  await firstTask;
  check(page.at(-1) === sidebar.at(-1) && sidebar.at(-1) === late.at(-1) &&
    controller.getState().result === result, 'All views receive the same resolved lyric data');
  let newlyOpened: LyricsState | null = null;
  controller.subscribe(state => { newlyOpened = state; });
  check(newlyOpened === controller.getState() && fetches === 1,
    'Opening a view after loading receives lyrics without another lookup');
  const oldQuery = controller.getState().query!;
  controller.setSongwriters(oldQuery, ['Writer']);
  check(controller.getState().result?.songwriters?.join() === 'Writer' &&
    controller.getState().result?.lines === result.lines && page.at(-1) === sidebar.at(-1),
    'Shared writer updates preserve timing and reach every view');
  const beforeUnsubscribe = page.length;
  unsubscribePage();
  unsubscribeLate();
  const secondTask = controller.onTrackChange(second);
  check(page.length === beforeUnsubscribe && sidebar.at(-1)?.result === null,
    'Unmounted views stop receiving updates and old lyrics clear on track change');
  controller.setSongwriters(oldQuery, ['Stale writer']);
  check(controller.getState().result === null, 'Stale writer responses cannot update a new track');
  const restartTask = controller.onTrackChange(first);
  check(pending[1].signal?.aborted && fetches === 3, 'Track replacement aborts the previous shared lookup');
  pending[2].resolve(result);
  await restartTask;
  pending[1].resolve({ ...result, source: 'stale' });
  await secondTask;
  check(controller.getState().result?.source === 'fixture' && controller.getState().item === first,
    'A late response cannot overwrite the current track');
  controller.setSongwriters(oldQuery, ['Wrong generation']);
  check(!controller.getState().result?.songwriters, 'Returning to the same track does not accept old writer responses');
  await controller.onTrackChange({ uri: 'spotify:ad:ad', metadata: { is_advertisement: 'true' } });
  check(controller.getState().status === 'idle' && controller.getState().result === null && fetches === 3,
    'Ads clear shared lyrics without fetching');
  const emptyTask = controller.onTrackChange(second);
  pending[3].resolve(null);
  await emptyTask;
  check(controller.getState().status === 'unavailable', 'No-result state is shared explicitly');
  const destroyTask = controller.onTrackChange(first);
  controller.destroy();
  const notificationsAfterDestroy = sidebar.length;
  check(pending[4].signal?.aborted && controller.getState().status === 'idle', 'Destroy aborts the shared request');
  pending[4].resolve(result);
  await destroyTask;
  check(sidebar.length === notificationsAfterDestroy && controller.getState().result === null,
    'Destroy discards pending results and releases subscribers');

  let viewErrors = 0;
  const failing = createLyricsController(async () => { throw new Error('Network failure'); }, {
    logger: { info() {}, error() { viewErrors++; } },
  });
  failing.subscribe(() => { throw new Error('Detached view'); });
  const healthy: LyricsState[] = [];
  failing.subscribe(state => healthy.push(state));
  await failing.onTrackChange(first);
  check(healthy.at(-1)?.status === 'error' && healthy.at(-1)?.error === 'Network failure' && viewErrors > 0,
    'A failing view cannot block another view or hide lookup errors');
  failing.destroy();

  const requestedSongs: string[] = [];
  const redirected = createLyricsController(async query => {
    requestedSongs.push(query.song);
    return result;
  }, logger);
  redirected.subscribe(state => {
    if (state.status === 'loading' && state.item === first) void redirected.onTrackChange(second);
  });
  await redirected.onTrackChange(first);
  await Promise.resolve();
  check(requestedSongs.join() === 'Second' && redirected.getState().item === second &&
    redirected.getState().status === 'ready',
    'A track switch during notification cannot start the superseded lookup');
  redirected.destroy();

  let listenerFetches = 0;
  const listenerController = createLyricsController(async () => { listenerFetches++; return result; }, logger);
  let songChange: ((event?: unknown) => void) | null = null;
  const stop = initPlayerListener(listenerController, { Player: {
    data: { item: first },
    addEventListener(_event: string, callback: (event?: unknown) => void) { songChange = callback; },
    removeEventListener(_event: string, callback: (event?: unknown) => void) {
      if (songChange === callback) songChange = null;
    },
  } });
  const dispatch = songChange as ((event?: unknown) => void) | null;
  dispatch?.({ data: { item: first } });
  await Promise.resolve();
  check(listenerFetches === 1, 'Startup and songchange events use one controller request');
  stop();
  check(songChange === null, 'Stopping the player listener releases its shared controller');
  return { checks };
}
