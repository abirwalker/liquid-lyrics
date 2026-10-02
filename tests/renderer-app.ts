import '../src/app';

document.body.innerHTML = '<div class="Root__main-view"><main class="main-view-container" style="height:600px;position:relative"><div id="original" style="display:flex">Spotify fixture</div></main></div><footer style="height:64px;display:flex;align-items:center;justify-content:center;gap:16px"></footer>';
document.body.style.cssText = 'background:#121212;color:#ddd;margin:0;font-family:Segoe UI';
const listeners: Array<() => void> = [];
const registrations: Button[] = [];
let registerCalls = 0;
const history = {
  location: { pathname: '/liquid-lyrics' },
  push(path: string) { this.location.pathname = path; listeners.forEach(listener => listener()); },
  goBack() { this.push('/'); },
  listen(listener: () => void) { listeners.push(listener); return () => {}; },
};
class Button {
  element = document.createElement('button');
  private state = false;
  constructor(label: string, icon: string, onClick: () => void) {
    this.element.title = label;
    this.element.innerHTML = icon;
    this.element.onclick = onClick;
    this.element.style.cssText = 'width:32px;height:32px;padding:8px;border:0;background:transparent;color:inherit;display:grid;place-content:center';
    this.register();
    registrations.push(this);
  }
  get active() { return this.state; }
  set active(value: boolean) { this.state = value; this.element.style.color = value ? '#1ed760' : '#ddd'; }
  register() {
    registerCalls++;
    if (!parameters.has('detached')) document.querySelector('footer')!.append(this.element);
  }
  deregister() { this.element.remove(); }
}
const parameters = new URLSearchParams(location.search);
function mountControls(kind: 'modern' | 'legacy' | 'alternate' = 'modern') {
  const footer = document.querySelector('footer')!;
  footer.setAttribute('data-testid', 'now-playing-bar');
  footer.className = 'Root__now-playing-bar';
  footer.innerHTML = kind === 'legacy'
    ? '<div class="main-nowPlayingBar-extraControls"><button data-testid="control-button-queue">Queue</button></div>'
    : `<div class="updated-controls"><button data-testid="${kind === 'alternate' ? 'pip-toggle-button' : 'lyrics-button'}">Native control</button><button data-testid="control-button-queue">Queue</button></div>`;
}
if (parameters.has('modern')) mountControls();
if (parameters.has('legacy')) mountControls('legacy');
const playerEvents = new Map<string, Array<(event?: unknown) => void>>();
const creditRequests = new Map<string, (response: unknown) => void>();
if (parameters.has('credits')) {
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.searchParams.get('title') === 'With writers') return Response.json({
      metadata: { title: 'With writers', artist: 'Fixture Artist', totalDuration: '0:06',
        songWriters: ['Provider Writer'] }, lyrics: [{ text: 'Fixture lyric', time: 1000, duration: 1000 }],
    });
    return Response.json({ syncedLyrics: '[00:01]Fixture lyric' });
  };
}
class TopbarButton {
  element = document.createElement('div');
  button: HTMLButtonElement;
  constructor(label: string, icon: string, onClick: () => void) {
    const mock = new Button(label, icon, onClick);
    this.button = mock.element;
    this.element.append(this.button);
    document.querySelector('footer')!.append(this.element);
  }
}
setTimeout(() => {
  globalThis.Spicetify = {
    Player: { data: {}, getProgress: () => parameters.has('credits') ? 1500 : 0, getDuration: () => 0, isPlaying: () => false,
      seek: () => {}, addEventListener: (event, callback) => {
        playerEvents.set(event, [...playerEvents.get(event) ?? [], callback]);
      }, removeEventListener: () => {} },
    GraphQL: parameters.has('credits') ? {
      Definitions: { queryTrackCreditsGroupedModal: { name: 'Synthetic definition' } },
      Request: (_definition, variables) => new Promise(resolve => {
        creditRequests.set(String(variables.trackUri), resolve);
      }),
    } : undefined,
    showNotification: () => {},
    Tippy: (element, options) => { (element as HTMLElement).dataset.tooltip = String(options.content); },
    Platform: parameters.has('fallback') ? undefined : { History: history },
    Playbar: parameters.has('topbar') ? undefined : { Button },
    Topbar: { Button: TopbarButton },
  };
}, 150);
Object.assign(window, { appFixture: { history, registrations, registerCalls: () => registerCalls,
  mountControls,
  creditRequests,
  changeTrack: (id: string, name = 'Fixture', details: Spicetify.PlayerItem = {}) => {
    globalThis.Spicetify!.Player.data!.item = { uri: `spotify:track:${id}`, name,
      artists: [{ name: 'Fixture Artist' }], duration: { milliseconds: 6000 }, ...details };
    playerEvents.get('songchange')?.forEach(callback => callback());
  },
  finishCredits: (id: string, writer: string) => {
    creditRequests.get(`spotify:track:${id}`)?.({ data: { trackUnion: { __typename: 'Track',
      creditsTrait: { contributors: { items: [{ name: writer, role: 'Composer' }] } } } } });
  },
} });
