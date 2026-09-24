import { LyricsView } from '../src/renderer/lyrics-view';
import type { LyricsResult } from '../src/types/types';

let progress = 12500;
let playing = true;
const seeks: number[] = [];
const visibility: boolean[] = [];
globalThis.Spicetify = {
  Player: {
    data: {},
    getProgress: () => progress,
    getDuration: () => 60000,
    isPlaying: () => playing,
    seek: (time) => { seeks.push(time); progress = time; },
    addEventListener: () => {},
    removeEventListener: () => {},
  },
  showNotification: (message) => console.warn(message),
};

document.body.innerHTML = '<header>Liquid Lyrics · renderer test fixture</header><div class="Root__main-view"><main class="main-view-container"><div id="original" style="display:flex">Original Spotify content</div></main></div>';
const style = document.createElement('style');
style.textContent = `html,body{margin:0;background:#101010;color:white;font:14px "Segoe UI",sans-serif} header{height:40px;padding:12px 24px;box-sizing:border-box;color:#aaa}.Root__main-view{padding:0 24px 24px}.main-view-container{width:100%;height:800px;position:relative;overflow:hidden;border-radius:8px}`;
document.head.append(style);
const view = new LyricsView({ onClose: () => view.unmount(), onVisibilityChange: (state) => visibility.push(state) });
const texts = [
  'The morning light moves slowly through the open window',
  'We take a breath and let the silence answer',
  'Every little turn brings us closer to the place we started',
  'I can hear you from the other side of the room',
  'And we are here again',
  '雨上がりの空に光が差している',
  'AReallyLongUnbrokenWordThatMustStayInsideTheVisibleReadingArea',
  'Let the last note settle',
];
function fixture(timing: 'line' | 'word' | 'none' = 'line'): LyricsResult {
  return { source: 'synthetic browser fixture', instrumental: false, lines: texts.map((text, i) => {
    const startMs = timing === 'none' ? null : i * 4000;
    const endMs = timing === 'none' ? null : (i + 1) * 4000;
    const words = timing === 'word' ? text.split(/(?<=\s)/) : [text];
    return { text, timing, startMs, endMs, agent: i % 2 ? 'v2' : 'v1', segments: words.map((word, j) => ({
      text: word, role: null,
      startMs: timing === 'word' ? i * 4000 + j * 4000 / words.length : null,
      endMs: timing === 'word' ? i * 4000 + (j + 1) * 4000 / words.length : null,
    })) };
  }) };
}
view.mount();
view.setLyrics(fixture());

function measure() {
  const host = document.querySelector<HTMLElement>('.main-view-container')!;
  const player = document.querySelector<HTMLElement>('.ll-player')!;
  const hostRect = host.getBoundingClientRect();
  const playerRect = player.getBoundingClientRect();
  const lines = [...player.querySelectorAll<HTMLElement>('.FmKaba_lyricLine:has(.FmKaba_lyricMainLine)')].map((line) => {
    const main = line.querySelector('.FmKaba_lyricMainLine')!;
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    const bounds: DOMRect[] = [];
    while (walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      bounds.push(...[...range.getClientRects()].filter((rect) => rect.width > 0));
    }
    return { text: main.textContent, rect: line.getBoundingClientRect().toJSON(),
      textLeft: Math.min(...bounds.map(r => r.left)), textRight: Math.max(...bounds.map(r => r.right)),
      opacity: getComputedStyle(line).opacity, filter: getComputedStyle(line.parentElement!).filter };
  });
  return { host: hostRect.toJSON(), player: playerRect.toJSON(), font: getComputedStyle(player).font,
    padding: getComputedStyle(player).getPropertyValue('--lyric-line-padding-x'), lines };
}

Object.assign(window, { fixture: {
  view, fixture, measure, seeks, visibility,
  setProgress: (time: number) => { progress = time; },
  setPlaying: (state: boolean) => { playing = state; },
  resize: (height: number) => { document.querySelector<HTMLElement>('.main-view-container')!.style.height = `${height}px`; },
  artwork: () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#d3b592'; context.fillRect(0, 0, 128, 128);
    context.fillStyle = '#687847'; context.fillRect(0, 0, 64, 84);
    context.fillStyle = '#5e3939'; context.fillRect(70, 50, 58, 78);
    view.updateTrack({ metadata: { image_url: canvas.toDataURL() } });
  },
} });
