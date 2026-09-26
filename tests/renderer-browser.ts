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
function backgroundFixture(): LyricsResult {
  return { source: 'amll', instrumental: false, lines: [
    { text: "Slittin' my throat (How long?)", timing: 'word', startMs: 0, endMs: 4000, agent: null, segments: [
      { text: "Slittin' my throat ", startMs: 0, endMs: 2600, role: null },
      { text: '(How long?)', startMs: 1800, endMs: 3600, role: 'x-bg' },
    ] },
    { text: 'Next verse', timing: 'line', startMs: 5000, endMs: 8000, agent: null,
      segments: [{ text: 'Next verse', startMs: null, endMs: null, role: null }] },
  ] };
}
function bracketFixture(first: boolean): LyricsResult {
  const text = first ? "(How long?) Slittin' my throat" : "Slittin' my throat (How long?)";
  return { source: 'lyricsplus', instrumental: false, lines: [
    { text, timing: 'line', startMs: 0, endMs: 4000, agent: null,
      segments: [{ text, startMs: null, endMs: null, role: null }] },
    { text: 'Next verse', timing: 'line', startMs: 5000, endMs: 8000, agent: null,
      segments: [{ text: 'Next verse', startMs: null, endMs: null, role: null }] },
  ] };
}
function sunflowerFixture(): LyricsResult {
  return { source: 'lyricsplus', instrumental: false, lines: [
    { text: "You're the sunflower (Yeah, yeah)", timing: 'word', startMs: 0, endMs: 4200,
      agent: null, segments: [
        { text: "You're ", startMs: 0, endMs: 800, role: null },
        { text: 'the ', startMs: 800, endMs: 1200, role: null },
        { text: 'sunflower ', startMs: 1200, endMs: 2700, role: null },
        { text: '(Yeah, ', startMs: 2700, endMs: 3400, role: null },
        { text: 'yeah)', startMs: 3400, endMs: 4200, role: null },
      ] },
    { text: 'Next verse', timing: 'line', startMs: 5000, endMs: 8000, agent: null,
      segments: [{ text: 'Next verse', startMs: null, endMs: null, role: null }] },
  ] };
}
function standaloneBackingFixture(): LyricsResult {
  const rows: Array<[string, number, number]> = [
    ['Lead one', 14178, 16311],
    ['(Backing one)', 16564, 18563],
    ['Lead two', 74219, 76071],
    ['(Backing two)', 76578, 79276],
    ['Next lead', 78959, 80891],
  ];
  return { source: 'binilyrics', instrumental: false, lines: rows.map(([text, startMs, endMs]) => ({
    text, timing: 'line', startMs, endMs, agent: null,
    segments: [{ text, startMs: null, endMs: null, role: null }],
  })) };
}
function forwardBackingFixture(): LyricsResult {
  const rows: Array<[string, number, number]> = [
    ['Distant thought', 0, 1000],
    ['(Come closer tonight)', 1200, 1800],
    ['Come closer tonight', 1600, 2800],
  ];
  return { source: 'binilyrics', instrumental: false, lines: rows.map(([text, startMs, endMs]) => ({
    text, timing: 'line', startMs, endMs, agent: null,
    segments: [{ text, startMs: null, endMs: null, role: null }],
  })) };
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
  view, fixture, backgroundFixture, bracketFixture, sunflowerFixture, standaloneBackingFixture,
  forwardBackingFixture,
  measure, seeks, visibility,
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
