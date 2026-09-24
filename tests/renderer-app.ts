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
  register() { registerCalls++; document.querySelector('footer')!.append(this.element); }
  deregister() { this.element.remove(); }
}
const parameters = new URLSearchParams(location.search);
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
    Player: { data: {}, getProgress: () => 0, getDuration: () => 0, isPlaying: () => false,
      seek: () => {}, addEventListener: () => {}, removeEventListener: () => {} },
    showNotification: () => {},
    Platform: parameters.has('fallback') ? undefined : { History: history },
    Playbar: parameters.has('topbar') ? undefined : { Button },
    Topbar: { Button: TopbarButton },
  };
}, 150);
Object.assign(window, { appFixture: { history, registrations, registerCalls: () => registerCalls } });
