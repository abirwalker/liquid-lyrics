import { build } from 'esbuild';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import strictAssert, { AssertionError } from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { annotateFailuresOnCi, launchHeadlessChrome, stopChrome } from './lib/chrome.mjs';

annotateFailuresOnCi('Renderer and UI tests');
// Failed checks are collected instead of stopping the run, so one CI run lists every broken check.
const failedChecks = [];
const assert = Object.fromEntries(['ok', 'equal', 'deepEqual'].map(name => [name, (...args) => {
  try {
    strictAssert[name](...args);
  } catch (error) {
    if (!(error instanceof AssertionError)) throw error;
    failedChecks.push(error.message);
    console.error(`Check failed: ${error.message}`);
  }
}]));
const failedSummary = () => `${failedChecks.length} renderer check(s) failed:\n- ${failedChecks.join('\n- ')}`;
const out = resolve('logs/renderer-tests');
await mkdir(out, { recursive: true });
await build({ entryPoints: ['tests/renderer-adapter.test.ts'], bundle: true, platform: 'node', outfile: resolve(out, 'adapter-tests.cjs') });
await import(pathToFileURL(resolve(out, 'adapter-tests.cjs')).href);
const buildDefine = version => ({ 'process.env.NODE_ENV': '"production"',
  __LIQUID_LYRICS_VERSION__: JSON.stringify(version), __LIQUID_LYRICS_CSS_ID__: JSON.stringify(`ll-test-${version}`) });
await build({ entryPoints: { harness: resolve('tests/renderer-browser.ts'), 'app-harness': resolve('tests/renderer-app.ts') }, bundle: true, outdir: out,
  format: 'iife', platform: 'browser', define: buildDefine('1.0.0') });
// Stand-ins for other installed releases booting in the same page.
const copyVersions = ['0.0.1', '9.9.9'];
for (const version of copyVersions) {
  await build({ entryPoints: { [`copy-${version}`]: resolve('src/app.tsx') }, bundle: true, outdir: out,
    format: 'iife', platform: 'browser', define: buildDefine(version) });
}
const served = ['/harness.js', '/harness.css', '/app-harness.js', '/app-harness.css', ...copyVersions.map(version => `/copy-${version}.js`)];
// Spicetify serves file-installed extensions from /extensions/; this one is renamed on purpose.
const aliases = { '/extensions/lyricsapp.js': 'copy-0.0.1.js' };
const server = http.createServer(async (req, res) => {
  const file = aliases[req.url] ?? (served.includes(req.url) ? req.url.slice(1) : null);
  res.setHeader('Content-Type', file?.endsWith('.js') ? 'text/javascript' : file ? 'text/css' : 'text/html');
  const entry = req.url.startsWith('/app') ? 'app-harness' : 'harness';
  res.end(file ? await readFile(resolve(out, file)) : `<!doctype html><link rel="stylesheet" href="/${entry}.css"><body><script src="/${entry}.js"></script></body>`);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const profile = await mkdtemp(resolve(out, 'chrome-'));
const { chrome, endpoint } = await launchHeadlessChrome({ userDataDir: profile });
const socket = new WebSocket(endpoint);
await new Promise(r => socket.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
const errors = [];
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data);
  if (message.id) {
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request?.reject(new Error(JSON.stringify(message.error)));
    else request?.resolve(message.result);
  }
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
});
function send(method, params = {}, sessionId) {
  return new Promise((resolveRequest, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve: resolveRequest, reject });
    socket.send(JSON.stringify({ id: requestId, method, params, sessionId }));
  });
}
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const { windowId } = await send('Browser.getWindowForTarget', { targetId });
const command = async (method, params) => {
  if (method === 'Emulation.setDeviceMetricsOverride') {
    await send('Browser.setWindowBounds', { windowId, bounds: { width: params.width, height: params.height } }).catch(() => {});
  }
  return send(method, params, sessionId);
};
const evaluate = async expression => {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(expression, tries = 100, stepMs = 50) {
  for (let count = 0; count < tries; count++) {
    if (await evaluate(expression)) return;
    await wait(stepMs);
  }
  throw new Error(`Timed out: ${expression}`);
}
// One CDP round trip on a slow CI runner can outlast a short transition, so mid-animation
// values are sampled every frame inside the page rather than polled from Node.
function sampleFrames(action, measure, durationMs) {
  return evaluate(`(async () => {
    const measure = () => (${measure});
    ${action};
    const samples = [];
    const start = performance.now();
    do {
      await new Promise(r => requestAnimationFrame(r));
      samples.push(measure());
    } while (performance.now() - start < ${durationMs});
    return samples;
  })()`);
}
const sawFrame = (frames, expected) => frames.some(frame => isDeepStrictEqual(frame, expected));
// Fixed sleeps assumed a fast machine; on a ~7 fps CI runner AMLL's scroll springs were still
// moving when they expired. Wait until the lyric rows and credits hold still instead.
// A stage resize makes AMLL rebuild its lines, so the element can be briefly absent on a slow runner;
// lookup and read happen in one evaluation so it cannot vanish in between.
async function fontSizeOf(selector) {
  for (let tries = 0; tries < 100; tries++) {
    const size = await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)});
      return element ? parseFloat(getComputedStyle(element).fontSize) : null; })()`);
    if (size !== null) return size;
    await wait(50);
  }
  throw new Error(`No element to measure: ${selector}`);
}
// Track panel sizes the lyric font in a rAF after each resize; on a slow runner a fixed sleep can
// read the font from the previous viewport. Wait until its recorded size matches the overlay.
function untilPanelMeasured() {
  return until(`(() => { const overlay = document.getElementById('liquid-lyrics-overlay'); if (!overlay) return false;
    const box = overlay.getBoundingClientRect();
    return Math.abs(parseFloat(overlay.style.getPropertyValue('--ll-view-width')) - box.width) < .5 &&
      Math.abs(parseFloat(overlay.style.getPropertyValue('--ll-view-height')) - box.height) < .5; })()`);
}
function settleLayout() {
  return evaluate(`(async () => {
    const probe = () => [document.querySelector('.ll-player .ll-credits')?.getBoundingClientRect().top ?? 0,
      ...fixture.view.player.currentLyricGroups.map(group => group.element.getBoundingClientRect().top)];
    const start = performance.now();
    let last = probe();
    let stillSince = start;
    while (performance.now() - start < 10000) {
      await new Promise(requestAnimationFrame);
      const next = probe();
      const now = performance.now();
      if (next.length !== last.length || next.some((y, i) => Math.abs(y - last[i]) > 0.05)) stillSince = now;
      else if (now - start >= 600 && now - stillSince >= 400) return;
      last = next;
    }
    throw new Error('lyric layout did not settle within 10s');
  })()`);
}
try {
  await command('Runtime.enable');
  await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1148, height: 964, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}` });
  for (let tries = 0; tries < 100 && !await evaluate('!!window.fixture'); tries++) await wait(100);
  assert.ok(await evaluate('!!window.fixture'), 'fixture loaded');
  const reports = [];
  for (const width of [400, 700, 1100, 1700]) {
    await command('Emulation.setDeviceMetricsOverride', { width: width + 48, height: 964, deviceScaleFactor: 1, mobile: false });
    for (const timing of ['line', 'word']) {
      await evaluate(`fixture.view.setLyrics(fixture.fixture('${timing}')); fixture.setProgress(12500)`);
      await wait(700);
      const report = { width, timing, ...await evaluate('fixture.measure()') };
      reports.push(report);
      for (const line of report.lines) {
        assert.ok(line.textLeft >= report.player.left - 1 && line.textRight <= report.player.right + 1,
          `${width}px ${timing}: text clipped: ${line.text} (${line.textLeft}, ${line.textRight})`);
      }
    }
    if (width === 1100 || width === 400) {
      await evaluate('fixture.artwork()');
      await wait(900);
      const shot = await command('Page.captureScreenshot', { format: 'png' });
      await writeFile(resolve(out, `lyrics-${width}.png`), Buffer.from(shot.data, 'base64'));
    }
  }
  await command('Emulation.setDeviceMetricsOverride', { width: 1148, height: 964, deviceScaleFactor: 1, mobile: false });
  assert.equal(await evaluate("document.querySelector('.ll-background').dataset.ready"), 'true', 'first artwork is visible');
  const transitionState = await evaluate(`(() => {
    const cover = document.createElement('canvas');
    cover.width = cover.height = 128;
    const context = cover.getContext('2d');
    context.fillStyle = '#195a87';
    context.fillRect(0, 0, 128, 128);
    context.fillStyle = '#e89655';
    context.fillRect(0, 0, 64, 64);
    fixture.view.updateTrack({ metadata: { image_url: cover.toDataURL() } });
    return { ready: document.querySelector('.ll-background').dataset.ready,
      artworkUrl: fixture.view.artworkUrl, coverUrl: cover.toDataURL() };
  })()`);
  assert.equal(transitionState.artworkUrl, transitionState.coverUrl, 'new cover was selected');
  assert.equal(transitionState.ready, 'true',
    'previous artwork stays visible while the next cover loads');
  await wait(700);
  assert.equal(await evaluate("document.querySelector('.ll-background').dataset.ready"), 'true',
    'background remains visible through the album transition');
  const spotifyInterludeRows = await evaluate("fixture.spotifyInterludeFixture().lines.map(line => line.text)");
  assert.deepEqual(spotifyInterludeRows, ['First line', 'Next line']);
  await evaluate('fixture.setProgress(6000); fixture.setAutoAdvance(true); fixture.view.setLyrics(fixture.spotifyInterludeFixture())');
  let dotsInfo = null;
  for (let tries = 0; tries < 60; tries++) {
    await wait(50);
    dotsInfo = await evaluate("(() => { const el = document.querySelector('.FmKaba_interludeDots'); return { html: el?.outerHTML, style: el?.getAttribute('style'), computedOpacity: el ? getComputedStyle(el).opacity : null, progress: Spicetify.Player.getProgress() }; })()");
    if (dotsInfo && Number(dotsInfo.computedOpacity) > 0) break;
  }
  await evaluate('fixture.setAutoAdvance(false)');
  assert.ok(dotsInfo && Number(dotsInfo.computedOpacity) > 0,
    `Spotify music note leaves a timed gap for AMLL interlude dots: ${JSON.stringify(dotsInfo)}`);
  await evaluate('fixture.setProgress(5500); fixture.view.setLyrics(fixture.backgroundFixture())');
  await until("document.querySelectorAll('.FmKaba_lyricBgLine').length === 1 && getComputedStyle(document.querySelector('.FmKaba_lyricBgLine')).opacity === '0'");
  assert.equal(await evaluate("document.querySelectorAll('.FmKaba_lyricBgLine').length"), 1, 'one backing line');
  assert.equal(await evaluate("document.querySelector('.FmKaba_lyricBgLine .FmKaba_lyricMainLine').textContent"), 'How long?');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.FmKaba_lyricBgLine')).opacity"), '0');
  const enteringOpacity = await sampleFrames('fixture.setProgress(2200)',
    "Number(getComputedStyle(document.querySelector('.FmKaba_lyricBgLine')).opacity)", 800);
  assert.ok(enteringOpacity.some(opacity => opacity > 0 && opacity < .4), `backing line fade: ${enteringOpacity}`);
  await until("getComputedStyle(document.querySelector('.FmKaba_lyricBgLine')).opacity === '0.4'");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.FmKaba_lyricBgLine')).opacity"), '0.4');
  const backingShot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(out, 'lyrics-background.png'), Buffer.from(backingShot.data, 'base64'));
  await evaluate('fixture.setProgress(133500); fixture.view.setLyrics(fixture.overlappingTaggedBackingFixture())');
  const taggedBackingState = index => evaluate(`(() => {
    const group = fixture.view.player.currentLyricGroups[${index}];
    return group?.bgLine && group?.bgWrapper ? { opacity: Number(getComputedStyle(group.bgLine.getElement()).opacity),
      height: group.bgWrapper.getBoundingClientRect().height } : null;
  })()`);
  await until("fixture.view.player.currentLyricGroups[0]?.bgWrapper?.getBoundingClientRect().height > 0");
  assert.ok((await taggedBackingState(0)).height > 0, 'first tagged backing is visible while sung');
  await evaluate('fixture.setProgress(135000)');
  await until("(() => { const g = fixture.view.player.currentLyricGroups[0]; return g?.bgWrapper?.getBoundingClientRect().height === 0 && getComputedStyle(g.bgLine.getElement()).opacity === '0'; })()");
  assert.deepEqual(await taggedBackingState(0), { opacity: 0, height: 0 },
    'first tagged backing hides at its own end while the following lead plays');
  await evaluate('fixture.setProgress(138500)');
  await until("fixture.view.player.currentLyricGroups[1]?.bgWrapper?.getBoundingClientRect().height > 0");
  assert.ok((await taggedBackingState(1)).height > 0, 'second tagged backing is visible while sung');
  await evaluate('fixture.setProgress(139800)');
  await until("(() => { const g = fixture.view.player.currentLyricGroups[1]; return g?.bgWrapper?.getBoundingClientRect().height === 0 && getComputedStyle(g.bgLine.getElement()).opacity === '0'; })()");
  assert.deepEqual(await taggedBackingState(1), { opacity: 0, height: 0 },
    'second tagged backing hides at its own end while the following lead plays');
  for (const first of [true, false]) {
    await evaluate(`fixture.setProgress(800); fixture.view.setLyrics(fixture.bracketFixture(${first}))`);
    await until("document.querySelector('.FmKaba_lyricBgLine')?.classList.contains('FmKaba_active') === true");
    const placement = await evaluate("(() => { const bg = document.querySelector('.FmKaba_lyricBgLine'); const group = bg.closest('.FmKaba_lyricLineWrapper'); return { text: bg.textContent, top: group.firstElementChild.contains(bg), active: bg.classList.contains('FmKaba_active') }; })()");
    assert.equal(placement.text, 'How long?');
    assert.equal(placement.top, first, 'backing position follows bracket order');
    assert.equal(placement.active, true, 'backing appears with lead group');
    const placementShot = await command('Page.captureScreenshot', { format: 'png' });
    await writeFile(resolve(out, `lyrics-line-background-${first ? 'above' : 'below'}.png`), Buffer.from(placementShot.data, 'base64'));
    await evaluate('fixture.setProgress(3100)');
    await wait(500);
    assert.equal(await evaluate("document.querySelector('.FmKaba_lyricBgLine').classList.contains('FmKaba_active')"), true,
      'line-synced backing remains visible through its parent line');
    await evaluate('fixture.setProgress(5500)');
    await until("getComputedStyle(document.querySelector('.FmKaba_lyricBgLine')).opacity === '0'");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.FmKaba_lyricBgLine')).opacity"), '0',
      'line-synced backing fades when its parent line ends');
  }
  await evaluate('fixture.setProgress(3000); fixture.view.setLyrics(fixture.sunflowerFixture())');
  await until("document.querySelector('.FmKaba_lyricBgLine')?.classList.contains('FmKaba_active') === true && document.querySelectorAll('.FmKaba_lyricBgLine .FmKaba_lyricMainLine > span').length > 0");
  assert.equal(await evaluate("document.querySelector('.FmKaba_lyricBgLine .FmKaba_lyricMainLine').textContent"), 'Yeah, yeah');
  assert.equal(await evaluate("document.querySelector('.FmKaba_lyricBgLine').classList.contains('FmKaba_active')"), true);
  assert.equal(await evaluate("document.querySelectorAll('.FmKaba_lyricBgLine .FmKaba_lyricMainLine > span').length > 0"), true);
  const sunflowerShot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(out, 'lyrics-word-background-sunflower.png'), Buffer.from(sunflowerShot.data, 'base64'));
  await evaluate('fixture.setProgress(14500); fixture.view.setLyrics(fixture.standaloneBackingFixture())');
  await until("(() => { const line = [...document.querySelectorAll('.FmKaba_lyricBgLine')].find(el => el.textContent?.includes('Backing one')); return line && Number(getComputedStyle(line).opacity) === 0.4; })()");
  const separateRows = await evaluate("fixture.view.player.currentLyricGroups.map(group => ({ lead: group.mainLine.getLine().words.map(word => word.word).join(''), backing: group.bgLine?.getLine().words.map(word => word.word).join('') ?? null, leadEnd: group.mainLine.getLine().words.at(-1).endTime, backingStart: group.bgLine?.getLine().words[0].startTime ?? null, backingEnd: group.bgLine?.getLine().words.at(-1).endTime ?? null }))");
  assert.equal(separateRows.length, 3, 'standalone vocals share their preceding lyric groups');
  assert.deepEqual(separateRows.map(row => row.backing), ['Backing one', 'Backing two', null]);
  assert.equal(separateRows[0].leadEnd, 16311);
  assert.equal(separateRows[0].backingStart, 16564);
  assert.equal(separateRows[1].backingEnd, 79276);
  const standaloneState = () => evaluate("(() => { const line = [...document.querySelectorAll('.FmKaba_lyricBgLine')].find(el => el.textContent?.includes('Backing one')); return line ? { active: line.classList.contains('FmKaba_active'), opacity: Number(getComputedStyle(line).opacity), font: parseFloat(getComputedStyle(line).fontSize), mask: line.querySelector('.FmKaba_lyricMainLine > span')?.style.maskPosition ?? '' } : null; })()");
  const beforeBacking = await standaloneState();
  assert.equal(beforeBacking?.active, true, 'background row appears with the lead without a blank slot');
  assert.equal(beforeBacking?.opacity, .4);
  await evaluate('fixture.setProgress(17100)');
  await until("(() => { const line = [...document.querySelectorAll('.FmKaba_lyricBgLine')].find(el => el.textContent?.includes('Backing one')); return line && Number(getComputedStyle(line).opacity) === 0.75; })()");
  const duringBacking = await standaloneState();
  assert.equal(duringBacking?.active, true);
  assert.equal(duringBacking?.opacity, .75, 'background vocal brightens during its own timed phrase');
  assert.ok(duringBacking.font < 58, 'standalone vocal uses smaller type');
  const standaloneShot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(out, 'lyrics-standalone-background.png'), Buffer.from(standaloneShot.data, 'base64'));
  await evaluate('fixture.setProgress(19100)');
  await until("(() => { const line = [...document.querySelectorAll('.FmKaba_lyricBgLine')].find(el => el.textContent?.includes('Backing one')); return line && Number(getComputedStyle(line).opacity) === 0; })()");
  assert.equal((await standaloneState())?.opacity, 0, 'standalone vocal fades after its own end');
  await evaluate('fixture.setProgress(17000)');
  await until("(() => { const line = [...document.querySelectorAll('.FmKaba_lyricBgLine')].find(el => el.textContent?.includes('Backing one')); return line && Number(getComputedStyle(line).opacity) === 0.75; })()");
  assert.equal((await standaloneState())?.opacity, .75, 'seek back restores standalone vocal');
  await evaluate('fixture.setProgress(79100)');
  await until("fixture.view.player.currentLyricGroups[1]?.isActive === true && fixture.view.player.currentLyricGroups[1]?.bgWrapper?.getBoundingClientRect().height > 10 && getComputedStyle(fixture.view.player.currentLyricGroups[1].bgWrapper).position === 'relative'");
  const overlappingRows = await evaluate("fixture.view.player.currentLyricGroups.slice(1, 3).map(group => ({ active: group.isActive, start: group.mainLine.getLine().startTime, end: group.mainLine.getLine().endTime }))");
  assert.equal(overlappingRows[0].active, true, 'backing stays active through its supplied end');
  assert.equal(overlappingRows[0].end, 79276);
  assert.equal(overlappingRows[1].start, 78959);
  const backingLayout = () => evaluate("(() => { const group = fixture.view.player.currentLyricGroups[1]; return { height: group.element.getBoundingClientRect().height, wrapperHeight: group.bgWrapper.getBoundingClientRect().height, position: getComputedStyle(group.bgWrapper).position }; })()");
  const beforeBackingEnd = await backingLayout();
  assert.ok(beforeBackingEnd.wrapperHeight > 10, 'the active backing row occupies space');
  const overlapShot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(out, 'lyrics-standalone-background-overlap.png'), Buffer.from(overlapShot.data, 'base64'));
  const collapsingBacking = await sampleFrames('fixture.setProgress(79500)',
    "(() => { const group = fixture.view.player.currentLyricGroups[1]; return { height: group.element.getBoundingClientRect().height, wrapperHeight: group.bgWrapper.getBoundingClientRect().height }; })()", 800);
  assert.ok(collapsingBacking.some(layout => layout.height < beforeBackingEnd.height && layout.wrapperHeight > 0),
    `backing row eases out instead of snapping shut: ${JSON.stringify({ beforeBackingEnd, collapsingBacking })}`);
  await until("fixture.view.player.currentLyricGroups[1].bgWrapper.getBoundingClientRect().height === 0 && getComputedStyle(fixture.view.player.currentLyricGroups[1].bgLine.getElement()).opacity === '0'");
  const afterOverlap = await evaluate("fixture.view.player.currentLyricGroups.slice(1, 3).map(group => ({ active: group.isActive, start: group.mainLine.getLine().startTime, end: group.mainLine.getLine().endTime }))");
  assert.equal(await evaluate("getComputedStyle(fixture.view.player.currentLyricGroups[1].bgLine.getElement()).opacity"), '0',
    `backing fades after its own end while the next lead continues: ${JSON.stringify(afterOverlap)}`);
  const afterBackingEnd = await backingLayout();
  assert.equal(afterBackingEnd.wrapperHeight, 0, 'finished backing no longer occupies lyric group height');
  assert.ok(afterBackingEnd.height < beforeBackingEnd.height - 10,
    `the lyric group contracts at the backing end: ${JSON.stringify({ beforeBackingEnd, afterBackingEnd })}`);
  await evaluate('fixture.setProgress(79100)');
  await until(`fixture.view.player.currentLyricGroups[1].element.getBoundingClientRect().height > ${afterBackingEnd.height} + 10 && getComputedStyle(fixture.view.player.currentLyricGroups[1].bgWrapper).position === 'relative'`);
  const restoredBacking = await backingLayout();
  assert.equal(restoredBacking.position, 'relative', 'seeking backward restores backing layout');
  assert.ok(restoredBacking.height > afterBackingEnd.height + 10);
  await evaluate('fixture.setProgress(1700); fixture.view.setLyrics(fixture.forwardBackingFixture())');
  await until("fixture.view.player.currentLyricGroups[1]?.bgLine?.getElement().classList.contains('FmKaba_active') === true");
  const forwardPlacement = await evaluate("(() => { const groups = fixture.view.player.currentLyricGroups; const next = groups[1]; return { count: groups.length, backing: next.bgLine?.getLine().words[0].word, top: next.element.firstElementChild.contains(next.bgLine.getElement()), active: next.bgLine.getElement().classList.contains('FmKaba_active') }; })()");
  assert.deepEqual(forwardPlacement, { count: 2, backing: 'Come closer tonight', top: true, active: true },
    'a stronger following-line word match places backing above that line');
  await evaluate('fixture.setProgress(49000); fixture.view.setLyrics(fixture.rockabyeShapeFixture())');
  await until("getComputedStyle(fixture.view.player.currentLyricGroups[1]?.bgLine?.getElement()).opacity === '0.75'");
  const rockabyeState = () => evaluate("(() => { const group = fixture.view.player.currentLyricGroups[1]; return { opacity: getComputedStyle(group.bgLine.getElement()).opacity, wrapperHeight: group.bgWrapper.getBoundingClientRect().height }; })()");
  assert.equal((await rockabyeState()).opacity, '0.75', 'line-timed bracket backing brightens with its lead');
  for (let time = 49100; time <= 52000; time += 100) {
    await evaluate(`fixture.setProgress(${time})`);
    await wait(30);
  }
  await until("Number(getComputedStyle(fixture.view.player.currentLyricGroups[1].bgLine.getElement()).opacity) < 0.01 && fixture.view.player.currentLyricGroups[1].bgWrapper.getBoundingClientRect().height === 0");
  const rockabyeFinished = await rockabyeState();
  assert.ok(Number(rockabyeFinished.opacity) < .01 && rockabyeFinished.wrapperHeight === 0,
    'line-timed bracket backing is gone before the following lead finishes');
  await evaluate('fixture.setPlaying(true); fixture.setProgress(167000); fixture.view.setLyrics(fixture.pausedBackingFixture())');
  await until("fixture.view.player.currentLyricGroups.slice(0, 2).every(g => g.bgWrapper && getComputedStyle(g.bgWrapper).position === 'absolute')");
  const pausedBackingState = () => evaluate("fixture.view.player.currentLyricGroups.slice(0, 2).map(group => ({ active: group.isActive, bgActive: group.bgWrapper?.classList.contains('FmKaba_bgWrapperActive'), height: group.element.getBoundingClientRect().height, wrapperHeight: group.bgWrapper?.getBoundingClientRect().height, wrapperPosition: group.bgWrapper ? getComputedStyle(group.bgWrapper).position : null, bgOpacity: group.bgLine ? getComputedStyle(group.bgLine.getElement()).opacity : null }))");
  const playingBacking = await pausedBackingState();
  assert.deepEqual(playingBacking.map(row => row.wrapperPosition), ['absolute', 'absolute'],
    'inactive backing rows do not occupy lyric layout while playing');
  await evaluate('fixture.setPlaying(false)');
  await wait(550);
  const pausedBacking = await pausedBackingState();
  assert.deepEqual(pausedBacking.map(row => row.wrapperPosition), ['absolute', 'absolute'],
    'pause keeps inactive backing rows outside lyric layout');
  assert.ok(pausedBacking.every((row, index) => Math.abs(row.height - playingBacking[index].height) < 2),
    `pause changed lyric spacing: ${JSON.stringify({ playingBacking, pausedBacking })}`);
  await evaluate('fixture.setPlaying(true)');
  await wait(550);
  const resumedBacking = await pausedBackingState();
  assert.ok(resumedBacking.every((row, index) => Math.abs(row.height - playingBacking[index].height) < 2),
    'resume preserves the same lyric spacing');
  await evaluate('fixture.setProgress(159000)');
  await until("fixture.view.player.currentLyricGroups[0]?.bgWrapper?.classList.contains('FmKaba_bgWrapperActive') === true && getComputedStyle(fixture.view.player.currentLyricGroups[0].bgWrapper).position === 'relative'");
  const currentBacking = (await pausedBackingState())[0];
  assert.equal(currentBacking.bgActive, true, 'current backing stays in its lyric group');
  assert.equal(currentBacking.wrapperPosition, 'relative');
  await evaluate('fixture.setPlaying(false)');
  await wait(550);
  const pausedCurrentBacking = (await pausedBackingState())[0];
  assert.equal(pausedCurrentBacking.wrapperPosition, 'relative', 'pausing keeps the current vocal in place');
  assert.ok(Math.abs(pausedCurrentBacking.height - currentBacking.height) < 2);
  await evaluate('fixture.setPlaying(true)');
  await evaluate("fixture.view.setLyrics(fixture.fixture()); fixture.setProgress(12500)");
  await until("document.querySelectorAll('.FmKaba_lyricLineWrapper:not(.FmKaba_bottomLineWrapper)').length > 0");
  await evaluate("document.querySelector('.FmKaba_lyricLineWrapper:not(.FmKaba_bottomLineWrapper)').click()");
  assert.equal(await evaluate('fixture.seeks.at(-1)'), 0, 'line click seeks');
  await evaluate("document.querySelector('.ll-player').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown',bubbles:true}))");
  assert.equal(await evaluate('fixture.seeks.at(-1)'), 4000, 'keyboard seeks');
  await evaluate("fixture.view.setLyrics(fixture.fixture('none'))");
  assert.equal(await evaluate("document.querySelectorAll('.ll-plain-lyrics > p').length"), 8);
  await evaluate(`document.querySelector('.ll-plain-lyrics > p').dataset.creditFixture = 'plain';
    fixture.view.setSongwriters(['<img src=x onerror=alert(1)>'])`);
  assert.equal(await evaluate("document.querySelector('.ll-plain-lyrics .ll-credits-writers').textContent"),
    '<img src=x onerror=alert(1)>', 'writer names render safely as text');
  assert.equal(await evaluate("document.querySelector('.ll-credits img')"), null);
  assert.equal(await evaluate("document.querySelector('.ll-plain-lyrics > p').dataset.creditFixture"), 'plain',
    'writer update preserves plain lyric elements');
  assert.equal(await evaluate("document.querySelector('.ll-player').hidden"), true);
  assert.equal(await evaluate("getComputedStyle(document.getElementById('liquid-lyrics-overlay'), '::after').backgroundColor"),
    'rgba(0, 0, 0, 0.65)', 'plain lyric contrast is preserved');
  await evaluate('fixture.view.setLyrics(null)');
  assert.equal(await evaluate("document.querySelector('.ll-credits')"), null, 'no stale credits after clearing lyrics');
  const noLyricsCheck = await evaluate(`(() => {
    const status = document.querySelector('.ll-status-msg');
    const player = document.querySelector('.ll-player');
    const sRect = status.getBoundingClientRect();
    const pRect = player.getBoundingClientRect();
    const sStyle = getComputedStyle(status);
    const pStyle = getComputedStyle(player);
    return {
      text: status.textContent,
      cxDelta: Math.abs((sRect.left + sRect.right) / 2 - (pRect.left + pRect.right) / 2),
      cyDelta: Math.abs((sRect.top + sRect.bottom) / 2 - (pRect.top + pRect.bottom) / 2),
      widthDelta: Math.abs(sRect.width - pRect.width),
      statusWeight: sStyle.fontWeight,
      playerWeight: pStyle.fontWeight,
      statusSize: sStyle.fontSize,
      playerSize: pStyle.fontSize,
    };
  })()`);
  assert.ok([
    "Just vibe. We'll bring the lyrics back next track.",
    "Congratulations, you get a break from singing!",
    "Words would only ruin the masterpiece.",
    "Humming instructions not included.",
    "You're gonna have to guess this one... if it even has one.",
    "No lyrics for this one, just listen.",
    "Make up your own words. Nobody's judging.",
    "All rhythm, zero reading required.",
    "Too mysterious to have written lyrics.",
    "Checked everywhere. Still nothing.",
    "Just nod along like you know every word.",
  ].includes(noLyricsCheck.text), `unexpected no-lyrics message: ${noLyricsCheck.text}`);
  assert.ok(noLyricsCheck.cxDelta < 0.5 && noLyricsCheck.cyDelta < 0.5 && noLyricsCheck.widthDelta < 0.5,
    `status box must align mathematically with lyric player: ${JSON.stringify(noLyricsCheck)}`);
  assert.equal(noLyricsCheck.statusWeight, noLyricsCheck.playerWeight, 'no-lyrics font weight matches lyrics');
  assert.equal(noLyricsCheck.statusSize, noLyricsCheck.playerSize, 'no-lyrics font size matches lyrics');
  await evaluate("fixture.view.setLyrics({source:'test',instrumental:true,lines:[]})");
  assert.equal(await evaluate("document.querySelector('.ll-status-msg').textContent"), 'Instrumental track');
  await evaluate('fixture.view.unmount()');
  assert.equal(await evaluate("document.querySelector('#original').style.display"), 'flex');
  assert.equal(await evaluate("document.querySelector('#liquid-lyrics-overlay') === null"), true);
  await evaluate('fixture.view.mount(); fixture.view.setLyrics(fixture.fixture())');
  await wait(200);
  for (const [setup, label] of [
    [`const field=document.createElement('input');field.className='escape-probe';document.body.append(field);field.focus();
      field.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`, 'search field outside lyrics'],
    [`const menu=document.createElement('ul');menu.className='escape-probe';menu.setAttribute('role','menu');menu.append(document.createElement('li'));
      document.body.append(menu);menu.firstChild.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`, 'Spotify context menu'],
    [`document.addEventListener('keydown',event=>event.preventDefault(),{once:true});
      document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`, 'Escape already handled'],
    [`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,isComposing:true}))`, 'IME composition'],
  ]) {
    await evaluate(setup);
    assert.equal(await evaluate('fixture.view.getIsVisible()'), true, `Escape from ${label} keeps lyrics open`);
  }
  await evaluate("document.querySelectorAll('.escape-probe').forEach(element => element.remove())");
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))");
  assert.equal(await evaluate('fixture.view.getIsVisible()'), false);
  await evaluate("document.querySelector('.Root__main-view').className = 'missing'; document.querySelector('main').className = ''; fixture.view.mount(); fixture.view.unmount(); document.querySelector('main').className = 'main-view-container'; document.querySelector('.missing').className = 'Root__main-view'");
  await wait(200);
  assert.equal(await evaluate("document.querySelector('#liquid-lyrics-overlay') === null"), true, 'pending mount cancelled');
  for (const height of [500, 900]) {
    await evaluate(`fixture.resize(${height}); fixture.view.mount(); fixture.view.setLyrics(fixture.fixture()); fixture.setProgress(28500)`);
    await until("(() => { const r = fixture.measure(); const last = r.lines.at(-1)?.rect; return last && last.top >= r.player.top && last.bottom <= r.player.bottom; })()");
    const report = await evaluate('fixture.measure()');
    const last = report.lines.at(-1).rect;
    assert.ok(last.top >= report.player.top && last.bottom <= report.player.bottom, 'last line fully visible');
    await evaluate('fixture.setProgress(0)');
    await until("(() => { const r = fixture.measure(); return r.lines[0] && r.lines[0].rect.top >= r.player.top; })()");
    const firstReport = await evaluate('fixture.measure()');
    assert.ok(firstReport.lines[0].rect.top >= firstReport.player.top, 'first line visible');
  }
  await command('Emulation.setEmulatedMedia', { features: [{name:'prefers-reduced-motion', value:'reduce'}] });
  const lineFilters = () => evaluate("[...document.querySelectorAll('.FmKaba_lyricLineWrapper')].map(el => getComputedStyle(el).filter)");
  let filters = await lineFilters();
  // Existing blur fades out through AMLL's 0.4s filter transition, which a slow runner stretches past any fixed wait.
  for (let tries = 0; tries < 60 && !filters.every(filter => filter === 'none'); tries++) {
    await wait(50);
    filters = await lineFilters();
  }
  assert.ok(filters.every(filter => filter === 'none'), `reduced motion has no blur: ${filters}`);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('[data-bottom-line=true]')).transitionDuration"),
    '0s', 'reduced motion disables the credits transition');
  await command('Emulation.setEmulatedMedia', { features: [] });
  await evaluate("fixture.view.setLyrics(fixture.fixture('word')); fixture.setProgress(12500); fixture.setPlaying(true)");
  await until("!!document.querySelector('.FmKaba_lyricLine:has(.FmKaba_lyricMainLine)')");
  const lineWidth = () => evaluate("document.querySelector('.FmKaba_lyricLine:has(.FmKaba_lyricMainLine)').getBoundingClientRect().width");
  const playingWidth = await lineWidth();
  await evaluate('fixture.setPlaying(false)');
  await wait(700);
  const pausedWidth = await lineWidth();
  await evaluate('fixture.setPlaying(true)');
  await wait(700);
  const resumedWidth = await lineWidth();
  assert.ok(Math.abs(playingWidth - pausedWidth) < 1 && Math.abs(playingWidth - resumedWidth) < 1,
    `pause/resume changed lyric width: ${playingWidth}, ${pausedWidth}, ${resumedWidth}`);
  await evaluate(`(() => {
    const result = fixture.fixture();
    result.lines.at(-1).endMs = 120000;
    result.songwriters = ['Synthetic Writer'];
    fixture.view.setLyrics(result);
    fixture.setProgress(60000);
    fixture.setPlaying(false);
  })()`);
  await until("(() => { const b = document.querySelector('[data-bottom-line=\"true\"]')?.parentElement ?? document.querySelector('[data-bottom-line=\"true\"]'); const f = b ? getComputedStyle(b).filter : ''; return !![...document.querySelectorAll('.FmKaba_lyricLineWrapper')].at(-1)?.querySelector('.FmKaba_active') && (f === 'blur(0px)' || f === 'none'); })()");
  const longFinal = await evaluate(`(() => {
    const bottom = document.querySelector('[data-bottom-line="true"]')?.parentElement ?? document.querySelector('[data-bottom-line="true"]');
    const content = document.querySelector('[data-bottom-line="true"]');
    const wrappers = [...document.querySelectorAll('.FmKaba_lyricLineWrapper')];
    return { focused: (bottom?.dataset?.focused ?? content?.dataset?.focused) === 'true', filter: bottom ? getComputedStyle(bottom).filter : '',
      lastActive: !!wrappers.at(-1)?.querySelector('.FmKaba_active'),
      previousBlurred: wrappers.slice(0, -1).some(wrapper => getComputedStyle(wrapper).filter !== 'none') };
  })()`);
  assert.equal(longFinal.focused, false, 'supplied final lyric end is preserved');
  assert.equal(longFinal.lastActive, true, 'long final lyric remains active');
  assert.equal(longFinal.filter, 'blur(0px)', 'credits remain readable below an active final lyric');
  assert.equal(longFinal.previousBlurred, true, 'credit fix preserves lyric blur');
  const beforeLyricEndShade = await evaluate("getComputedStyle(document.getElementById('liquid-lyrics-overlay'), '::after').backgroundColor");
  assert.equal(beforeLyricEndShade, 'rgba(0, 0, 0, 0.16)', 'active final lyric uses normal background shade');
  await evaluate('fixture.setProgress(121000)');
  await until("(document.querySelector('.FmKaba_bottomLineWrapper')?.dataset.focused ?? document.querySelector('[data-bottom-line=true]').dataset.focused) === 'true'");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.FmKaba_bottomLineWrapper') ?? document.querySelector('[data-bottom-line=true]')).filter"), 'blur(0px)',
    'credits stay clear when playback crosses the final lyric end');
  assert.equal(await evaluate("document.querySelector('.FmKaba_bottomLineWrapper')?.dataset.focused ?? document.querySelector('[data-bottom-line=true]').dataset.focused"), 'true',
    'credits become focused after the final lyric');
  assert.equal(await evaluate("getComputedStyle(document.getElementById('liquid-lyrics-overlay'), '::after').backgroundColor"),
    beforeLyricEndShade, 'credits focus does not darken the background');
  const creditBlur = async () => {
    const filter = await evaluate("getComputedStyle(document.querySelector('.FmKaba_bottomLineWrapper') ?? document.querySelector('[data-bottom-line=true]')).filter");
    return filter === 'none' ? 0 : parseFloat(filter.slice(5));
  };
  const creditBlurInPage = "(() => { const filter = getComputedStyle(document.querySelector('.FmKaba_bottomLineWrapper') ?? document.querySelector('[data-bottom-line=true]')).filter; return filter === 'none' ? 0 : parseFloat(filter.slice(5)); })()";
  // The reference must be the settled blur; a reading taken mid-transition makes every later intermediate frame look too large.
  const beforeFinalBlur = (await sampleFrames('fixture.setProgress(24000)', creditBlurInPage, 1200)).at(-1);
  assert.equal(await evaluate("getComputedStyle(document.getElementById('liquid-lyrics-overlay'), '::after').backgroundColor"),
    beforeLyricEndShade, 'seeking before the final lyric keeps the background shade');
  assert.ok(beforeFinalBlur > 0, 'credits remain blurred before the final lyric');
  const clearing = await sampleFrames('fixture.setProgress(28000)', creditBlurInPage, 900);
  assert.ok(clearing.some(blur => blur > 0 && blur < beforeFinalBlur), `credits blur eases into clarity: ${clearing}`);
  await until("(getComputedStyle(document.querySelector('.FmKaba_bottomLineWrapper') ?? document.querySelector('[data-bottom-line=true]')).filter) === 'blur(0px)' || (getComputedStyle(document.querySelector('.FmKaba_bottomLineWrapper') ?? document.querySelector('[data-bottom-line=true]')).filter) === 'none'");
  assert.equal(await creditBlur(), 0, 'credits settle clear during the final lyric');
  const reblurring = await sampleFrames('fixture.setProgress(24000)', creditBlurInPage, 900);
  assert.ok(reblurring.some(blur => blur > 0 && blur < beforeFinalBlur), `credits blur eases back when seeking earlier: ${reblurring}`);
  assert.ok(reblurring.at(-1) > 0, 'credit blur returns before the final lyric');
  await evaluate(`(() => {
    const data = fixture.fixture(); data.lines.at(-1).endMs = 120000;
    data.songwriters = ['Synthetic Writer'];
    fixture.setPlaying(true); fixture.setProgress(60000); fixture.view.setLyrics(data);
  })()`);
  await settleLayout();
  const stopMovement = await evaluate(`(async () => {
    const player = fixture.view.player;
    const groups = [player.currentLyricGroups[0], player.currentLyricGroups.at(-2)];
    const initial = groups.map(group => group.posY.getCurrentPosition());
    let maxMovement = 0;
    for (let frame = 0; frame < 45; frame++) {
      player.getElement().dispatchEvent(new WheelEvent('wheel', {deltaY:10000, bubbles:true, cancelable:true}));
      player.update(16);
      await new Promise(requestAnimationFrame);
      groups.forEach((group, index) => {
        maxMovement = Math.max(maxMovement, Math.abs(group.posY.getCurrentPosition() - initial[index]));
      });
    }
    return maxMovement;
  })()`);
  assert.ok(stopMovement < 1, `wheel input at the stop does not make earlier lyrics wobble: ${stopMovement}px`);
  await evaluate('fixture.setPlaying(false)');
  const endLayout = () => evaluate(`(() => {
    const player = document.querySelector('.ll-player').getBoundingClientRect();
    const footer = document.querySelector('.ll-player .ll-credits').getBoundingClientRect();
    const last = fixture.view.player.currentLyricGroups.at(-1).element.getBoundingClientRect();
    const firstLine = document.querySelector('.ll-player .FmKaba_lyricLine').getBoundingClientRect();
    return {
      bottom: footer.bottom - player.top,
      height: player.height,
      lastTop: last.top - player.top,
      footerLeft: footer.left,
      lineLeft: firstLine.left
    };
  })()`);
  for (const [width, height] of [[1100, 900], [700, 500], [400, 800]]) {
    await command('Emulation.setDeviceMetricsOverride', { width: width + 48, height: height + 64, deviceScaleFactor: 1, mobile: false });
    await evaluate(`(() => { fixture.resize(${height}); fixture.setPlaying(false); fixture.setProgress(28500);
      const data = fixture.fixture(); data.songwriters = ['Synthetic Writer One', 'Synthetic Writer Two'];
      fixture.view.setLyrics(data); })()`);
    await settleLayout();
    const lastLine = await endLayout();
    await until(`(() => { const s = getComputedStyle(document.querySelector('.ll-player [data-bottom-line="true"]')); return parseFloat(s.opacity) === 1 && (s.filter === 'none' || s.filter === 'blur(0px)'); })()`);
    const lastLineState = await evaluate(`(() => {
      const bottomLine = document.querySelector('.ll-player [data-bottom-line="true"]');
      const s = getComputedStyle(bottomLine);
      return {
        readable: bottomLine.classList.contains('ll-credits-readable'),
        opacity: parseFloat(s.opacity),
        filter: s.filter
      };
    })()`);
    assert.equal(lastLineState.readable, true, 'credits are readable during last line');
    assert.equal(lastLineState.opacity, 1, 'credits have 100% opacity on last line');
    assert.ok(lastLineState.filter === 'none' || lastLineState.filter === 'blur(0px)', 'credits are unblurred on last line');
    await evaluate('fixture.setProgress(33000)');
    await settleLayout();
    const finished = await endLayout();
    await until(`(() => { const s = getComputedStyle(document.querySelector('.ll-player [data-bottom-line="true"]')); return parseFloat(s.opacity) === 1 && (s.filter === 'none' || s.filter === 'blur(0px)'); })()`);
    const finishedState = await evaluate(`(() => {
      const bottomLine = document.querySelector('.ll-player [data-bottom-line="true"]');
      const s = getComputedStyle(bottomLine);
      return {
        opacity: parseFloat(s.opacity),
        filter: s.filter
      };
    })()`);
    assert.equal(finishedState.opacity, 1, 'credits have 100% opacity after track ends');
    assert.ok(finishedState.filter === 'none' || finishedState.filter === 'blur(0px)', 'credits are unblurred after track ends');
    assert.ok(Math.abs(finished.bottom - finished.height * .7) < 2, `end credits stop at 70%: ${JSON.stringify(finished)}`);
    assert.ok(Math.abs(finished.footerLeft - finished.lineLeft) < 1, `credits align horizontally with lyrics: footerLeft ${finished.footerLeft} vs lineLeft ${finished.lineLeft}`);
    if (lastLine.bottom <= lastLine.height * .7 + 5) {
      assert.ok(Math.abs(lastLine.bottom - finished.bottom) < 5, 'last line ending does not recenter the footer');
    }
    await evaluate(`document.querySelector('.ll-player').dispatchEvent(new WheelEvent('wheel', {deltaY:10000, bubbles:true, cancelable:true}))`);
    await settleLayout();
    const scrolledEnd = await endLayout();
    assert.ok(Math.abs(scrolledEnd.bottom - finished.bottom) < 2, 'wheel cannot scroll credits beyond the end');
    await evaluate(`document.querySelector('.ll-player').dispatchEvent(new WheelEvent('wheel', {deltaY:-200, bubbles:true, cancelable:true}))`);
    await settleLayout();
    const scrolledBack = await endLayout();
    assert.ok(scrolledBack.lastTop > scrolledEnd.lastTop + 100, 'wheel still scrolls back to earlier lyrics');
    await evaluate(`document.querySelector('.ll-player').dispatchEvent(new WheelEvent('wheel', {deltaY:10000, bubbles:true, cancelable:true}))`);
    await settleLayout();
    assert.ok(Math.abs((await endLayout()).bottom - finished.bottom) < 2, 'scrolling returns to the same end limit');
    await evaluate(`fixture.view.setLyrics(fixture.fixture()); fixture.setProgress(33000)`);
    await settleLayout();
    await evaluate(`fixture.view.setSongwriters(['Synthetic Writer One', 'Synthetic Writer Two', 'Synthetic Writer Three'])`);
    await settleLayout();
    const lateWriters = await endLayout();
    assert.ok(Math.abs(lateWriters.bottom - lateWriters.height * .7) < 2, 'late writer names remeasure the scroll end');
    await evaluate('fixture.setProgress(12500)');
    await settleLayout();
    await evaluate(`document.querySelector('.ll-player').dispatchEvent(new WheelEvent('wheel', {deltaY:10000, bubbles:true, cancelable:true}))`);
    await settleLayout();
    const earlyScroll = await endLayout();
    assert.ok(Math.abs(earlyScroll.bottom - earlyScroll.height * .7) < 2, 'manual scroll stops at credits during earlier playback too');
  }
  await evaluate(`document.querySelector('.ll-player').dispatchEvent(new WheelEvent('wheel', {deltaY:-200, bubbles:true, cancelable:true}))`);
  await settleLayout();
  await evaluate(`(() => {
    const element = document.querySelector('.ll-player');
    const touch = new Touch({identifier:1, target:element, screenX:200, screenY:600, clientX:200, clientY:600});
    element.dispatchEvent(new TouchEvent('touchstart', {touches:[touch], changedTouches:[touch], bubbles:true, cancelable:true}));
  })()`);
  await wait(100);
  await evaluate(`(() => {
    const element = document.querySelector('.ll-player');
    const touch = new Touch({identifier:1, target:element, screenX:200, screenY:0, clientX:200, clientY:0});
    element.dispatchEvent(new TouchEvent('touchmove', {touches:[touch], changedTouches:[touch], bubbles:true, cancelable:true}));
    element.dispatchEvent(new TouchEvent('touchend', {touches:[], changedTouches:[touch], bubbles:true, cancelable:true}));
  })()`);
  await settleLayout();
  const touchEnd = await endLayout();
  assert.ok(Math.abs(touchEnd.bottom - touchEnd.height * .7) < 2, 'touch drag and inertia respect the credit scroll limit');
  await evaluate(`(() => {
    const data = fixture.fixture();
    data.lines.forEach(line => {line.startMs += 8000; line.endMs += 8000;});
    fixture.setPlaying(false); fixture.setProgress(1000); fixture.view.setLyrics(data);
  })()`);
  await settleLayout();
  await evaluate(`document.querySelector('.ll-player').dispatchEvent(new WheelEvent('wheel', {deltaY:10000, bubbles:true, cancelable:true}))`);
  await settleLayout();
  const introScroll = await endLayout();
  assert.ok(Math.abs(introScroll.bottom - introScroll.height * .7) < 2, 'intro dots are included in the manual end limit');
  await evaluate(`(() => {
    const data = fixture.fixture(); data.lines[0].endMs = 1000; data.lines[1].startMs = 7000;
    fixture.setProgress(2000); fixture.view.setLyrics(data);
  })()`);
  await settleLayout();
  await evaluate(`document.querySelector('.ll-player').dispatchEvent(new WheelEvent('wheel', {deltaY:10000, bubbles:true, cancelable:true}))`);
  await settleLayout();
  const interludeScroll = await endLayout();
  assert.ok(Math.abs(interludeScroll.bottom - interludeScroll.height * .7) < 2, 'interior dots preserve the manual end limit');
  await evaluate(`(() => {
    const sidebar = document.createElement('div'); sidebar.id = 'artwork-sidebar';
    sidebar.setAttribute('aria-hidden', 'true'); sidebar.style.cssText = 'position:fixed;right:8px;top:40px;width:420px;height:600px;overflow:hidden';
    const panel = document.createElement('aside'); panel.id = 'Desktop_PanelContainer_Id';
    panel.setAttribute('aria-label', 'Now playing view'); panel.style.cssText = 'width:420px;height:600px';
    sidebar.append(panel); document.body.append(sidebar);
    const trigger = document.createElement('button'); trigger.dataset.testid = 'cover-art-button';
    trigger.setAttribute('aria-label', 'Now playing view'); trigger.hidden = true; document.body.append(trigger);
    fixture.artwork();
    window.artworkTestUrl = fixture.view.artworkUrl;
    fixture.view.updateTrack({ name: 'Artwork test track', artists: [{name:'Artist one'}, {name:'Artist two'}], metadata: {image_url:artworkTestUrl} });
  })()`);
  const artworkVisible = () => evaluate("!document.querySelector('.ll-track-panel').hidden");
  const untilArtwork = expected => until(`!document.querySelector('.ll-track-panel').hidden === ${expected}`);
  let previousArtworkSize = null;
  for (const [width, height] of [[400,800], [1119,800], [1120,800], [1500,800], [2200,800],
    [1438,882], [2116,1242], [3398,1962]]) {
    await command('Emulation.setDeviceMetricsOverride', { width: width + 48, height: height + 64, deviceScaleFactor: 1, mobile: false });
    await evaluate(`fixture.resize(${height})`);
    for (const timing of ['line', 'word', 'none']) {
      await evaluate(`fixture.setProgress(12500); fixture.view.setLyrics(fixture.fixture('${timing}'))`);
      await until(timing === 'none' ? "!document.querySelector('.ll-plain-lyrics').hidden" : "document.querySelectorAll('.FmKaba_lyricMainLine').length > 0");
      await wait(150); await untilPanelMeasured(); await untilArtwork(width >= 1120);
      assert.equal(await artworkVisible(), width >= 1120, `${width}px ${timing}: artwork only with enough lyric space`);
      if (width >= 1120) {
        const layout = await evaluate(`(() => {
          const cover = document.querySelector('.ll-track-panel').getBoundingClientRect();
          const stage = document.querySelector('.ll-lyric-stage').getBoundingClientRect();
          return { separated:cover.right < stage.left, lyricWidth:stage.width };
        })()`);
        assert.ok(layout.separated && layout.lyricWidth >= 480, 'artwork leaves a separate readable lyric column');
        const bounds = await evaluate(`(() => {
          const plain = document.querySelector('.ll-plain-lyrics');
          const elements = plain.hidden ? document.querySelectorAll('.FmKaba_lyricMainLine') : plain.querySelectorAll('p');
          const stage = document.querySelector('.ll-lyric-stage').getBoundingClientRect();
          return [...elements].every(element => {
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
              const range = document.createRange(); range.selectNodeContents(walker.currentNode);
              if ([...range.getClientRects()].some(rect => rect.width &&
                  (rect.left < stage.left - 1 || rect.right > stage.right + 1))) return false;
            }
            return true;
          });
        })()`);
        assert.equal(bounds, true, `${width}px ${timing}: lyric text stays within the reading column`);
      }
    }
    if (height > 800) {
      const size = await evaluate(`({cover:document.querySelector('.ll-track-cover').getBoundingClientRect().width,
        font:parseFloat(getComputedStyle(document.querySelector('.ll-plain-lyrics')).fontSize)})`);
      if (previousArtworkSize) {
        assert.ok(size.cover > previousArtworkSize.cover && size.font > previousArtworkSize.font,
          'larger views grow both cover and lyric text');
        assert.ok(Math.abs(size.font / size.cover - previousArtworkSize.font / previousArtworkSize.cover) < .01,
          'text-to-cover proportion stays consistent across resolutions');
      }
      previousArtworkSize = size;
    }
  }
  // Use real page zoom here: a DPR-only viewport override cannot catch zoom cancellation.
  await command('Emulation.clearDeviceMetricsOverride');
  await send('Browser.setWindowBounds', { windowId, bounds: { width: 2560, height: 1440 } }).catch(() => {});
  const { targetId: settingsTarget } = await send('Target.createTarget', { url: 'chrome://settings' });
  const { sessionId: settingsSession } = await send('Target.attachToTarget', { targetId: settingsTarget, flatten: true });
  for (let attempt = 0; attempt < 50; attempt++) {
    const api = await send('Runtime.evaluate', { expression: 'typeof chrome.settingsPrivate?.setDefaultZoom', returnByValue: true }, settingsSession);
    if (api.result.value === 'function') break;
    await wait(100);
  }
  const zoomSizes = new Map();
  for (const zoom of [1, 1.2, .8, 1]) {
    const changed = await send('Runtime.evaluate', { expression:
      `new Promise(resolve => chrome.settingsPrivate.setDefaultZoom(${zoom}, resolve))`,
      returnByValue: true, awaitPromise: true }, settingsSession);
    assert.equal(changed.result.value, true, 'isolated browser zoom setting accepted');
    await command('Page.bringToFront');
    await evaluate('fixture.resize(innerHeight - 64)');
    for (const timing of ['line', 'word', 'none']) {
      await evaluate(`fixture.view.setLyrics(fixture.fixture('${timing}'))`);
      await until(timing === 'none' ? "!document.querySelector('.ll-plain-lyrics').hidden" : "document.querySelectorAll('.FmKaba_lyricMainLine').length > 0");
      const zoomLayout = `(() => {
        const panel = document.querySelector('.ll-track-panel');
        const stage = document.querySelector('.ll-lyric-stage').getBoundingClientRect();
        const plain = document.querySelector('.ll-plain-lyrics');
        const elements = plain.hidden ? document.querySelectorAll('.FmKaba_lyricMainLine') : plain.querySelectorAll('p');
        const fits = [...elements].every(element => {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const range = document.createRange(); range.selectNodeContents(walker.currentNode);
            if ([...range.getClientRects()].some(rect => rect.width &&
                (rect.left < stage.left - 1 || rect.right > stage.right + 1))) return false;
          }
          return true;
        });
        return {visible:!panel.hidden, fits, dpr:devicePixelRatio,
          cover:document.querySelector('.ll-track-cover').getBoundingClientRect().width * devicePixelRatio,
          font:parseFloat(getComputedStyle(plain).fontSize) * devicePixelRatio};
      })()`;
      // Zoom changes relayout over several frames on a slow runner; wait until the stage reports readable before measuring.
      await untilPanelMeasured();
      await until(`(() => { const layout = ${zoomLayout}; return layout.visible && layout.fits; })()`);
      const size = await evaluate(zoomLayout);
      assert.ok(Math.abs(size.dpr - zoom) < .01, 'native browser zoom is active');
      assert.ok(size.visible && size.fits, `${zoom}x ${timing}: zoom leaves artwork and lyrics readable`);
      await evaluate(`document.getElementById('artwork-sidebar').setAttribute('aria-hidden','false')`);
      await wait(100);
      const noCoverFont = await fontSizeOf(timing === 'none' ? '.ll-plain-lyrics' : '.FmKaba_lyricMainLine') * await evaluate('devicePixelRatio');
      assert.ok(Math.abs(noCoverFont - size.font) < .02, `${zoom}x ${timing}: default font matches the cover font`);
      await evaluate(`document.getElementById('artwork-sidebar').setAttribute('aria-hidden','true')`);
      await wait(100);
      if (zoomSizes.has(timing)) {
        const baseline = zoomSizes.get(timing);
        if (zoom > 1) assert.ok(size.cover > baseline.cover * 1.1 && size.font > baseline.font * 1.1,
          'zoom in enlarges both cover and font');
        if (zoom < 1) assert.ok(size.cover < baseline.cover * .9 && size.font < baseline.font * .9,
          'zoom out reduces both cover and font');
        if (zoom === 1) assert.ok(Math.abs(size.cover - baseline.cover) < 1 && Math.abs(size.font - baseline.font) < 1,
          'reset zoom restores the original sizes without remount');
      } else zoomSizes.set(timing, size);
    }
  }
  await send('Target.closeTarget', { targetId: settingsTarget });
  const fontLayoutRestore = await evaluate(`(() => {
    const root = document.querySelector('.Root__main-view');
    const sidebar = document.getElementById('artwork-sidebar');
    const styles = {root:root.getAttribute('style'), sidebar:sidebar.getAttribute('style')};
    const grid = document.createElement('div'); grid.id='font-layout-grid';
    grid.style.cssText='display:grid;grid-template-areas:"main-view right-sidebar";grid-template-columns:minmax(0,1fr) 32px;gap:8px';
    root.before(grid); grid.append(root,sidebar);
    root.style.gridArea='main-view'; root.style.minWidth='0';
    sidebar.style.cssText='grid-area:right-sidebar;overflow:hidden';
    return styles;
  })()`);
  for (const [width, height] of [[1438,882], [2116,1242], [3398,1962], [1120,800]]) {
    await command('Emulation.setDeviceMetricsOverride', { width:width+88, height:height+64, deviceScaleFactor:1, mobile:false });
    await evaluate(`fixture.resize(${height})`);
    for (const timing of ['line','word','none']) {
      await evaluate(`document.getElementById('font-layout-grid').style.gridTemplateColumns='minmax(0,1fr) 32px';
        document.getElementById('artwork-sidebar').setAttribute('aria-hidden','true');
        fixture.view.setLyrics(fixture.fixture('${timing}'))`);
      await until(timing === 'none' ? "!document.querySelector('.ll-plain-lyrics').hidden" : "document.querySelectorAll('.FmKaba_lyricMainLine').length > 0");
      await wait(150);
      const readFont = () => fontSizeOf(timing === 'none' ? '.ll-plain-lyrics' : '.FmKaba_lyricMainLine');
      await untilPanelMeasured();
      const referenceFont = await readFont();
      await evaluate(`document.getElementById('font-layout-grid').style.gridTemplateColumns='minmax(0,1fr) 420px';
        document.getElementById('artwork-sidebar').setAttribute('aria-hidden','false')`);
      await wait(100); await untilArtwork(false);
      assert.equal(await artworkVisible(), false, 'NPV opens and hides the artwork');
      await untilPanelMeasured();
      const npvFont = await readFont();
      assert.ok(Math.abs(npvFont - referenceFont) < .02, `${width}px ${timing}: NPV width change preserves font size: ${referenceFont}px -> ${npvFont}px`);
    }
  }
  await evaluate(`(() => {
    const styles=${JSON.stringify(fontLayoutRestore)};
    const root=document.querySelector('.Root__main-view'),sidebar=document.getElementById('artwork-sidebar');
    const grid=document.getElementById('font-layout-grid'); grid.before(root);document.body.append(sidebar);grid.remove();
    if(styles.root === null)root.removeAttribute('style');else root.setAttribute('style',styles.root);
    sidebar.setAttribute('style',styles.sidebar);
  })()`);
  await evaluate('fixture.resize(800)');
  await command('Emulation.setDeviceMetricsOverride', { width: 1548, height: 964, deviceScaleFactor: 1, mobile: false });
  await evaluate(`(() => {
    const queue = document.createElement('button'); queue.dataset.testid = 'control-button-queue';
    queue.hidden = true; queue.setAttribute('aria-pressed','false'); document.body.append(queue);
    document.getElementById('Desktop_PanelContainer_Id').setAttribute('aria-label','Now playing view');
    document.getElementById('artwork-sidebar').setAttribute('aria-hidden','false');
  })()`);
  await wait(100); await untilArtwork(false);
  assert.equal(await artworkVisible(),false,'visible Now Playing hides artwork before Queue opens');
  await evaluate(`document.querySelector('[data-testid="control-button-queue"]').setAttribute('aria-pressed','true')`);
  await wait(100); await untilArtwork(false);
  assert.equal(await artworkVisible(),false,'open NPV keeps artwork hidden while Queue retains stale NPV label');
  await evaluate(`document.getElementById('Desktop_PanelContainer_Id').setAttribute('aria-label','Queue')`);
  await wait(100); await untilArtwork(false);
  assert.equal(await artworkVisible(),false,'open NPV keeps artwork hidden after Queue content arrives');
  await evaluate(`document.querySelector('[data-testid="control-button-queue"]').remove()`);
  await wait(100); await untilArtwork(false);
  assert.equal(await artworkVisible(),false,'Queue button removal preserves the prior open NPV state');
  for (const [label, hidden, expected] of [['Now playing view','false',false], ['Queue','false',false], ['Now playing view','true',true], ['Queue','false',true], ['','false',false]]) {
    await evaluate(`document.getElementById('Desktop_PanelContainer_Id').setAttribute('aria-label', '${label}'); document.getElementById('artwork-sidebar').setAttribute('aria-hidden', '${hidden}')`);
    await wait(100); await untilArtwork(expected);
    assert.equal(await artworkVisible(), expected, `${label || 'unknown'} sidebar: artwork visibility`);
  }
  await evaluate(`document.getElementById('artwork-sidebar').setAttribute('aria-hidden','true');
    fixture.view.updateTrack({name:'Second track, same cover', artists:[{name:'New artist'}], metadata:{image_url:artworkTestUrl}})`);
  await wait(100);
  assert.equal(await evaluate("document.querySelector('.ll-track-title').textContent"), 'Second track, same cover');
  assert.equal(await evaluate("document.querySelector('.ll-track-artist').textContent"), 'New artist');
  assert.equal(await evaluate("document.querySelectorAll('.ll-track-cover img').length"), 1, 'reuse decoded cover on same-album track change');
  await evaluate(`fixture.view.updateTrack({name:'LongTitleWithoutSpaces'.repeat(20), artists:[{name:'LongArtistWithoutSpaces'.repeat(15)}], metadata:{image_url:artworkTestUrl}})`);
  await wait(100);
  assert.equal(await evaluate("[...document.querySelectorAll('.ll-track-title,.ll-track-artist')].every(el=>el.scrollWidth <= el.clientWidth + 1)"), true, 'metadata stays within its column');
  await evaluate('fixture.resize(470)'); await wait(100); await untilArtwork(false);
  assert.equal(await artworkVisible(), false, 'short view hides artwork');
  await evaluate('fixture.resize(800); fixture.view.unmount(); fixture.view.mount()'); await wait(200); await untilArtwork(true);
  assert.equal(await artworkVisible(), true, 'observers reconnect after reopening');
  await evaluate('fixture.view.setLyrics(null)');
  const splitNoLyricsCheck = await evaluate(`(() => {
    const status = document.querySelector('.ll-status-msg');
    const player = document.querySelector('.ll-player');
    const sRect = status.getBoundingClientRect();
    const pRect = player.getBoundingClientRect();
    const sStyle = getComputedStyle(status);
    const pStyle = getComputedStyle(player);
    return {
      cxDelta: Math.abs((sRect.left + sRect.right) / 2 - (pRect.left + pRect.right) / 2),
      cyDelta: Math.abs((sRect.top + sRect.bottom) / 2 - (pRect.top + pRect.bottom) / 2),
      widthDelta: Math.abs(sRect.width - pRect.width),
      statusWeight: sStyle.fontWeight,
      playerWeight: pStyle.fontWeight,
      statusSize: sStyle.fontSize,
      playerSize: pStyle.fontSize,
    };
  })()`);
  assert.ok(splitNoLyricsCheck.cxDelta < 0.5 && splitNoLyricsCheck.cyDelta < 0.5 && splitNoLyricsCheck.widthDelta < 0.5,
    `with-track status aligns mathematically with lyric player: ${JSON.stringify(splitNoLyricsCheck)}`);
  assert.equal(splitNoLyricsCheck.statusWeight, splitNoLyricsCheck.playerWeight, 'with-track no-lyrics font weight matches lyrics');
  assert.equal(splitNoLyricsCheck.statusSize, splitNoLyricsCheck.playerSize, 'with-track no-lyrics font size matches lyrics');
  await evaluate(`fixture.view.updateTrack({name:'Missing cover',metadata:{}})`); await wait(100); await untilArtwork(false);
  assert.equal(await artworkVisible(), false, 'missing cover restores lyrics-only layout');
  assert.equal(await evaluate("document.querySelectorAll('.ll-track-cover img').length"), 0, 'old cover removed');
  await evaluate("document.getElementById('artwork-sidebar').remove(); document.querySelector('[data-testid=cover-art-button]').remove()");
  await command('Emulation.setDeviceMetricsOverride', { width: 1148, height: 964, deviceScaleFactor: 1, mobile: false });
  await evaluate('fixture.resize(800)');
  await evaluate(`fixture.view.setLyrics(fixture.fixture('word')); fixture.setProgress(12500); fixture.view.updateTrack({name:'Full-screen track',artists:[{name:'Fixture Artist'}],metadata:{image_url:artworkTestUrl}});
    window.fullscreenRequests=0; window.originalRequestFullscreen=HTMLElement.prototype.requestFullscreen;
    HTMLElement.prototype.requestFullscreen=function(){window.fullscreenRequests++;return Promise.reject(new Error('Fixture denied full screen'));};
    window.transportCalls=[]; window.volumeChanges=[]; window.fixtureVolume=.5; Spicetify.Player.getVolume=()=>fixtureVolume; Spicetify.Player.setVolume=value=>{fixtureVolume=value;volumeChanges.push(value);}; Spicetify.Player.togglePlay=()=>transportCalls.push('play');
    Spicetify.Player.back=()=>transportCalls.push('previous'); Spicetify.Player.next=()=>transportCalls.push('next');
    window.mainPlayerBefore=document.querySelector('.ll-player'); fixture.setPlaying(true); fixture.view.enterFullscreen();`);
  await wait(300); await until('fullscreenRequests === 1');
  assert.equal(await evaluate('fullscreenRequests'),1,'fullscreen requests browser mode');
  assert.equal(await evaluate(`document.querySelector('.ll-fullscreen').parentElement===document.body`),true,'fallback portal fills window');
  assert.equal(await evaluate(`document.querySelector('.ll-player')===mainPlayerBefore`),true,'fullscreen reuses main player');
  assert.equal(await evaluate(`document.querySelector('.ll-fullscreen').getBoundingClientRect().width`),1148,'fallback spans viewport');
  assert.equal(await artworkVisible(),true,'fullscreen shows artwork independently of NPV');
  await evaluate(`document.querySelector('.ll-fullscreen-controls button[aria-label="Pause"]').click();
    document.querySelector('.ll-fullscreen-controls button[aria-label="Previous track"]').click();
    document.querySelector('.ll-fullscreen-controls button[aria-label="Next track"]').click();
    const range=document.querySelector('.ll-fullscreen-timeline input');range.value='22000';range.dispatchEvent(new Event('input'));range.dispatchEvent(new Event('change'));`);
  assert.deepEqual(await evaluate('transportCalls'),['play','previous','next'],'transport uses Spotify');
  assert.equal(await evaluate('fixture.seeks.at(-1)'),22000,'slider seeks milliseconds');
  await evaluate(`fixture.setProgress(22037)`);
  await until(`Number(document.querySelector('.ll-fullscreen-timeline input').value) === 22037`);
  assert.equal(await evaluate(`Number(document.querySelector('.ll-fullscreen-timeline input').value)`),22037,'timeline preserves progress between whole seconds');
  await wait(220);
  const fillBefore=await evaluate(`parseFloat(getComputedStyle(document.querySelector('.ll-fullscreen-timeline input')).getPropertyValue('--ll-progress'))`);
  const fillDuring=await sampleFrames(`fixture.setProgress(22537)`,
    `(()=>{const e=document.querySelector('.ll-fullscreen-timeline input');return{target:parseFloat(e.style.getPropertyValue('--ll-progress')),easing:e.getAnimations().some(animation=>animation.transitionProperty==='--ll-progress')};})()`,400);
  assert.ok(fillDuring.some(frame=>frame.easing&&frame.target>fillBefore),`timeline interpolates between coarse Spotify samples: ${JSON.stringify({fillBefore,fillDuring})}`);
  await evaluate(`fixture.setPlaying(false);fixture.setProgress(22381)`);
  await until(`Number(document.querySelector('.ll-fullscreen-timeline input').value) === 22381`);
  assert.equal(await evaluate(`Number(document.querySelector('.ll-fullscreen-timeline input').value)`),22381,'paused timeline reflects exact Spotify position');
  await wait(80);
  assert.equal(await evaluate(`Number(document.querySelector('.ll-fullscreen-timeline input').value)`),22381,'paused timeline does not drift');
  const seekRestHeight=await evaluate(`document.querySelector('.ll-fullscreen-timeline input').getBoundingClientRect().height`);
  await evaluate(`document.querySelector('.ll-fullscreen-timeline input').focus()`);
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
  await wait(220); await until('fixture.seeks.at(-1) === 23381');
  assert.equal(await evaluate('fixture.seeks.at(-1)'),23381,'keyboard seeking retains one-second increments');
  let focusedHeight=0;
  for(let tries=0;tries<40&&!(focusedHeight>seekRestHeight*1.5);tries++){
    if(tries)await wait(50);
    focusedHeight=await evaluate(`document.querySelector('.ll-fullscreen-timeline input').getBoundingClientRect().height`);
  }
  assert.ok(focusedHeight>seekRestHeight*1.5,`focused timeline thickens: ${seekRestHeight}px -> ${focusedHeight}px`);
  await writeFile(resolve(out,'timeline-focused.png'),Buffer.from((await command('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await evaluate(`document.activeElement.blur();fixture.setPlaying(true)`);
  await wait(220);
  await evaluate(`const volumeSlider=document.querySelector('.ll-fullscreen-volume input');volumeSlider.value='.25';volumeSlider.dispatchEvent(new Event('input'));`);
  assert.deepEqual(await evaluate('volumeChanges'),[.25],'volume uses Spotify API');
  await evaluate(`window.savedPlayerData=Spicetify.Player.data;window.savedPlatform=Spicetify.Platform;
    window.liked=false;window.heartCalls=0;window.trackNavigation=[];
    Spicetify.Player.getHeart=()=>liked;Spicetify.Player.toggleHeart=()=>{liked=!liked;heartCalls++;};
    Spicetify.Player.data={item:{uri:'spotify:track:1234567890123456789012',artists:[{name:'Artist',uri:'spotify:artist:2234567890123456789012'}],album:{name:'Album',uri:'spotify:album:3234567890123456789012'}}};
    Spicetify.Platform={History:{push:path=>trackNavigation.push(path)}};`);
  await until(`!document.querySelector('.ll-track-like').hidden`);
  assert.equal(await evaluate(`document.querySelector('.ll-track-like').hidden`),false,'valid track exposes like control');
  const likeFrames=await sampleFrames(`document.querySelector('.ll-track-like').click()`,
    `({popping:document.querySelector('.ll-track-like').classList.contains('ll-heart-popping'),
      particles:document.querySelectorAll('.ll-track-like .ll-heart-fx .ll-heart-particle').length,
      fading:document.querySelector('.ll-heart-fill').getAnimations().some(animation=>animation.transitionProperty==='opacity')})`,600);
  assert.equal(await evaluate(`liked && document.querySelector('.ll-track-like').getAttribute('aria-pressed')==='true'`),true,'like control uses Spotify saved state');
  assert.ok(likeFrames.some(frame=>frame.popping),'liking triggers micro-bounce');
  assert.ok(likeFrames.some(frame=>frame.particles===7),'liking emits 7 monochrome radial particles');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.ll-track-like svg')).stroke`),'none','liked heart has no extra outline');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.ll-track-like')).backgroundColor`),'rgba(0, 0, 0, 0)','liked heart has no persistent outer circle');
  assert.ok(likeFrames.some(frame=>frame.fading),'heart fill crossfades without moving the symbol');
  await until(`!document.querySelector('.ll-track-like').classList.contains('ll-heart-popping') && !document.querySelector('.ll-track-like .ll-heart-fx')`);
  assert.equal(await evaluate(`document.querySelector('.ll-track-like').classList.contains('ll-heart-popping') || Boolean(document.querySelector('.ll-track-like .ll-heart-fx'))`),false,'like fx cleans up after animation');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.ll-heart-outline')).opacity`),'0','liked heart outline disappears');
  const unlikeFrames=await sampleFrames(`document.querySelector('.ll-track-like').click()`,`({breaking:document.querySelector('.ll-track-like').classList.contains('ll-heart-breaking'),splits:document.querySelectorAll('.ll-track-like .ll-heart-split').length,particles:document.querySelectorAll('.ll-track-like .ll-heart-particle').length})`,200);
  assert.equal(await evaluate('liked'),false,'unlike uses same Spotify API');
  assert.ok(sawFrame(unlikeFrames,{breaking:true,splits:2,particles:6}),`unliking splits heart halves with particle burst: ${JSON.stringify(unlikeFrames.at(-1))}`);
  await wait(460); await until(`!document.querySelector('.ll-track-like').classList.contains('ll-heart-breaking') && !document.querySelector('.ll-track-like .ll-heart-fx')`);
  assert.equal(await evaluate(`document.querySelector('.ll-track-like').classList.contains('ll-heart-breaking') || Boolean(document.querySelector('.ll-track-like .ll-heart-fx'))`),false,'unlike fx cleans up after animation');
  await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await evaluate(`document.querySelector('.ll-track-like').click()`);
  await wait(35);
  assert.equal(await evaluate(`document.querySelector('.ll-track-like .ll-heart-fx')`),null,'reduced motion skips heart particle fx');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.ll-heart-fill')).transitionDuration`),'0.18s','system motion preference preserves heart crossfade');
  await command('Emulation.setEmulatedMedia',{features:[]});
  await evaluate(`document.querySelector('.ll-track-like').click()`);
  await wait(480); await until(`!(liked && document.querySelector('.ll-track-like').getAttribute('aria-pressed')==='true')`);
  assert.equal(await evaluate(`liked && document.querySelector('.ll-track-like').getAttribute('aria-pressed')==='true'`),false,'sync mock reset to unliked');
  const asyncLikeFrames=await sampleFrames(`window.__syncToggle = Spicetify.Player.toggleHeart;
    Spicetify.Player.toggleHeart = () => { const next = !liked; setTimeout(() => { liked = next; }, 120); };
    document.querySelector('.ll-track-like').click()`,`({pressed:document.querySelector('.ll-track-like').getAttribute('aria-pressed'),popping:document.querySelector('.ll-track-like').classList.contains('ll-heart-popping'),splits:document.querySelectorAll('.ll-track-like .ll-heart-split').length,particles:document.querySelectorAll('.ll-track-like .ll-heart-particle').length})`,200);
  assert.ok(sawFrame(asyncLikeFrames,{pressed:'true',popping:true,splits:0,particles:7}),`async toggleHeart plays like fx immediately instead of inverted unheart: ${JSON.stringify(asyncLikeFrames.at(-1))}`);
  await until('liked === true');
  const asyncUnlikeFrames=await sampleFrames(`document.querySelector('.ll-track-like').click()`,`({pressed:document.querySelector('.ll-track-like').getAttribute('aria-pressed'),breaking:document.querySelector('.ll-track-like').classList.contains('ll-heart-breaking'),splits:document.querySelectorAll('.ll-track-like .ll-heart-split').length,particles:document.querySelectorAll('.ll-track-like .ll-heart-particle').length})`,200);
  assert.ok(sawFrame(asyncUnlikeFrames,{pressed:'false',breaking:true,splits:2,particles:6}),`async toggleHeart plays unheart split fx immediately on unlike: ${JSON.stringify(asyncUnlikeFrames.at(-1))}`);
  await wait(460);
  await evaluate(`Spicetify.Player.toggleHeart = window.__syncToggle; delete window.__syncToggle;`);
  await evaluate(`document.querySelector('.ll-track-actions > button[aria-haspopup="menu"]').click()`);
  assert.equal(await evaluate(`document.activeElement.textContent`),'Save to Liked Songs','menu focuses first action');
  const menuRow=await evaluate(`(()=>{const e=document.activeElement,s=getComputedStyle(e);return{height:e.getBoundingClientRect().height,padding:parseFloat(s.paddingLeft),align:s.textAlign};})()`);
  assert.ok(menuRow.height>=40&&menuRow.padding>=12,'track menu keeps readable row padding outside transport button styles');
  assert.ok(['start','left'].includes(menuRow.align),'track menu labels align to leading edge');
  assert.equal(await evaluate(`document.querySelector('.ll-track-menu').getBoundingClientRect().bottom < document.querySelector('.ll-track-actions').getBoundingClientRect().top`),true,'track menu opens upward over artwork instead of playback');
  assert.ok(await evaluate(`(()=>{const m=document.querySelector('.ll-track-menu').getBoundingClientRect(),b=document.querySelector('.ll-track-actions > button[aria-haspopup="menu"]').getBoundingClientRect();return Math.abs((m.left+m.right-b.left-b.right)/2)<1;})()`),'track menu centers over the dots');
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
  assert.equal(await evaluate(`document.activeElement.textContent`),'Go to song','menu arrow keys move focus');
  await evaluate(`document.activeElement.click()`);
  assert.deepEqual(await evaluate('trackNavigation'),['/track/1234567890123456789012'],'menu opens current track');
  for (const [label,path] of [['Go to artist','/artist/2234567890123456789012'],['Go to album','/album/3234567890123456789012']]) {
    await evaluate(`document.querySelector('.ll-track-actions > button[aria-haspopup="menu"]').click();[...document.querySelectorAll('.ll-track-menu button')].find(b=>b.textContent===${JSON.stringify(label)}).click();`);
    assert.equal(await evaluate('trackNavigation.at(-1)'),path,'menu resolves current '+label);
  }
  await evaluate(`document.querySelector('.ll-track-actions > button[aria-haspopup="menu"]').click()`);
  await wait(180);
  await writeFile(resolve(out,'track-actions-menu.png'),Buffer.from((await command('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await evaluate(`[...document.querySelectorAll('.ll-track-menu button')].find(b=>b.textContent==='Save to Liked Songs').click();`);
  assert.equal(await evaluate(`liked && document.querySelector('.ll-track-like').getAttribute('aria-pressed')==='true'`), true, 'menu item toggles heart');
  await evaluate(`document.querySelector('.ll-track-actions > button[aria-haspopup="menu"]').click()`);
  assert.equal(await evaluate(`document.activeElement.textContent`), 'Remove from Liked Songs', 'liked menu item reflects state');
  assert.equal(await evaluate(`document.activeElement.classList.contains('ll-menu-liked')`), true, 'liked menu item reflects saved state');
  assert.equal(await evaluate(`getComputedStyle(document.activeElement).textShadow`),'none','liked menu has no glow');
  await wait(180);
  await writeFile(resolve(out,'track-actions-menu-liked.png'),Buffer.from((await command('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  assert.equal(await evaluate(`!!document.querySelector('.ll-fullscreen') && document.querySelector('.ll-track-menu').hidden`),true,'Escape closes menu without exiting full screen');
  await evaluate(`window.savedClipboard=Object.getOwnPropertyDescriptor(navigator,'clipboard');window.savedNotification=Spicetify.showNotification;
    window.copyNotifications=[];window.copiedLinks=[];
    Spicetify.showNotification=(...args)=>copyNotifications.push(args);
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{copiedLinks.push(text);}}});
    document.querySelector('.ll-track-actions > button[aria-haspopup="menu"]').click();
    [...document.querySelectorAll('.ll-track-menu button')].find(b=>b.textContent==='Copy Song Link').click();`);
  assert.deepEqual(await evaluate('copiedLinks'),['https://open.spotify.com/track/1234567890123456789012'],'copy writes the selected song link');
  assert.equal(await evaluate(`(()=>{const e=document.querySelector('.ll-track-feedback');return !e.hidden && e.dataset.state==='success' && e.textContent==='Song link copied' && e.closest('.ll-fullscreen')!==null;})()`),true,'copy confirmation appears inside full screen immediately');
  const feedbackLayout = await evaluate(`(()=>{const e=document.querySelector('.ll-track-feedback');const i=e.querySelector('.ll-feedback-icon svg');const l=e.querySelector('.ll-feedback-label');const er=e.getBoundingClientRect();const ir=i.getBoundingClientRect();const lr=l.getBoundingClientRect();return {centerDelta:Math.abs((er.left+er.width/2)-innerWidth/2),iconW:ir.width,iconH:ir.height,yDelta:Math.abs((ir.top+ir.height/2)-(lr.top+lr.height/2)),radius:getComputedStyle(e).borderRadius,wraps:lr.height>parseFloat(getComputedStyle(l).lineHeight)*1.4};})()`);
  assert.ok(feedbackLayout.centerDelta<=1 && feedbackLayout.iconW>=14 && feedbackLayout.iconH>=14 && feedbackLayout.yDelta<=1.5 && !feedbackLayout.wraps,`copy feedback layout is aligned and single-line: ${JSON.stringify(feedbackLayout)}`);
  assert.equal(await evaluate(`document.querySelector('.ll-track-feedback').getAttribute('role')`),'status','copy confirmation is announced without moving focus');
  await wait(180);
  await writeFile(resolve(out,'track-copy-feedback.png'),Buffer.from((await command('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await wait(2400); await until(`document.querySelector('.ll-track-feedback').hidden`);
  assert.equal(await evaluate(`document.querySelector('.ll-track-feedback').hidden`),true,'copy confirmation expires inside full screen');
  await evaluate(`navigator.clipboard.writeText=async()=>{throw new Error('Clipboard denied');};
    document.querySelector('.ll-track-actions > button[aria-haspopup="menu"]').click();
    [...document.querySelectorAll('.ll-track-menu button')].find(b=>b.textContent==='Copy Song Link').click();`);
  assert.equal(await evaluate(`(()=>{const e=document.querySelector('.ll-track-feedback');return e.dataset.state==='error' && e.textContent==='Could not copy song link' && e.querySelector('.ll-feedback-icon svg')!==null;})()`),true,'clipboard failure receives immediate local feedback with error icon');
  assert.deepEqual(await evaluate('copyNotifications'),[],'copy feedback never queues a Spotify notification');
  await evaluate(`navigator.clipboard.writeText=()=>new Promise(resolve=>{window.finishCopy=resolve;});
    document.querySelector('.ll-track-actions > button[aria-haspopup="menu"]').click();
    [...document.querySelectorAll('.ll-track-menu button')].find(b=>b.textContent==='Copy Song Link').click();
    fixture.view.exitFullscreen();finishCopy();`);
  assert.equal(await evaluate(`document.querySelector('.ll-track-feedback')===null`),true,'exiting disposes feedback before pending clipboard completion');
  assert.deepEqual(await evaluate('copyNotifications'),[],'copy completion after exit does not create a delayed notification');
  await evaluate(`if(savedClipboard)Object.defineProperty(navigator,'clipboard',savedClipboard);else delete navigator.clipboard;
    Spicetify.showNotification=savedNotification;fixture.view.enterFullscreen();`);
  await evaluate(`document.querySelector('.ll-track-like').click()`);
  await evaluate(`document.querySelector('.ll-track-actions > button[aria-haspopup="menu"]').click();Spicetify.Player.data={item:{uri:'spotify:track:4234567890123456789012'}};`);
  await until(`document.querySelector('.ll-track-menu').hidden`);
  assert.equal(await evaluate(`document.querySelector('.ll-track-menu').hidden`),true,'track change closes stale menu');
  await evaluate(`Spicetify.Player.data=savedPlayerData;Spicetify.Platform=savedPlatform;delete Spicetify.Player.getHeart;delete Spicetify.Player.toggleHeart;`);
  await until(`document.querySelector('.ll-track-like').hidden`);
  assert.equal(await evaluate(`document.querySelector('.ll-track-like').hidden`),true,'unsupported saved-track API hides control');
  const muteFading=await sampleFrames(`document.querySelector('.ll-fullscreen-mute-btn').click()`,
    `document.querySelector('.ll-mute-silent').getAnimations().some(animation=>animation.transitionProperty==='opacity')`,400);
  assert.equal(await evaluate('fixtureVolume'),0,'mute sets volume to zero');
  assert.equal(await evaluate(`document.querySelector('.ll-fullscreen-mute-btn').getAttribute('aria-label')`),'Unmute','mute exposes current action');
  assert.ok(muteFading.some(Boolean),'mute icon crossfades after volume changes immediately');
  await until(`getComputedStyle(document.querySelector('.ll-mute-silent')).opacity==='1'`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.ll-mute-silent')).opacity`),'1','muted icon settles');
  await evaluate(`document.querySelector('.ll-fullscreen-mute-btn').click()`);
  assert.equal(await evaluate('fixtureVolume'),.25,'unmute restores last audible volume');
  await wait(220); await until(`getComputedStyle(document.querySelector('.ll-mute-silent')).opacity==='0'`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.ll-mute-silent')).opacity`),'0','unmute restores speaker icon');
  await evaluate(`window.fixtureRepeat=2; Spicetify.Player.getRepeat=()=>fixtureRepeat;`);
  await until(`document.querySelector('.ll-fullscreen-repeat').getAttribute('aria-label') === 'Repeat one'`);
  assert.equal(await evaluate(`document.querySelector('.ll-fullscreen-repeat').getAttribute('aria-label')`),'Repeat one','repeat-one label follows Spotify');
  assert.equal(await evaluate(`document.querySelector('.ll-fullscreen-volume input').style.getPropertyValue('--ll-volume')`),'25%','volume fill follows Spotify');
  const volumeRest = await evaluate(`(()=>{const e=document.querySelector('.ll-fullscreen-volume input'),r=e.getBoundingClientRect();return{x:r.x+r.width*.25,y:r.y+r.height/2,height:r.height,capsuleHeight:e.parentElement.getBoundingClientRect().height};})()`);
  await command('Input.dispatchMouseEvent',{type:'mousePressed',x:volumeRest.x,y:volumeRest.y,button:'left',clickCount:1});
  await until(`document.querySelector('.ll-fullscreen-volume input').getBoundingClientRect().height > ${volumeRest.height * 2}`);
  assert.ok(await evaluate(`document.querySelector('.ll-fullscreen-volume input').getBoundingClientRect().height`)>volumeRest.height*2,'pressed volume track expands');
  assert.ok(await evaluate(`document.querySelector('.ll-fullscreen-volume').getBoundingClientRect().height`)>volumeRest.capsuleHeight,'pressed volume capsule expands');
  await writeFile(resolve(out,'volume-active.png'),Buffer.from((await command('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await command('Input.dispatchMouseEvent',{type:'mouseReleased',x:volumeRest.x,y:volumeRest.y,button:'left',clickCount:1});
  await until(`Math.abs(document.querySelector('.ll-fullscreen-volume input').getBoundingClientRect().height - ${volumeRest.height}) < .5`);
  assert.ok(Math.abs(await evaluate(`document.querySelector('.ll-fullscreen-volume input').getBoundingClientRect().height`)-volumeRest.height)<.5,'pointer release restores compact volume');
  await evaluate(`document.querySelector('.ll-fullscreen-mute-btn').focus()`);
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  await until(`document.activeElement === document.querySelector('.ll-fullscreen-volume input') && document.querySelector('.ll-fullscreen-volume input').getBoundingClientRect().height > ${volumeRest.height * 2}`);
  assert.equal(await evaluate(`document.activeElement===document.querySelector('.ll-fullscreen-volume input')`),true,'volume is keyboard reachable');
  assert.ok(await evaluate(`document.querySelector('.ll-fullscreen-volume input').getBoundingClientRect().height`)>volumeRest.height*2,'keyboard focus expands volume');
  await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  assert.ok(await evaluate(`parseFloat(getComputedStyle(document.querySelector('.ll-fullscreen-volume')).transitionDuration)>0`),'system motion preference preserves volume animation');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.ll-mute-silent')).transitionDuration`),'0.16s','system motion preference preserves mute animation');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.ll-track-menu')).animationName`),'ll-track-menu-open','system motion preference preserves menu animation');
  await command('Emulation.setEmulatedMedia',{features:[]});
  await evaluate(`document.activeElement.blur()`);
  await wait(220); await until(`document.querySelector('.ll-fullscreen-timeline').getBoundingClientRect().top >= document.querySelector('.ll-track-cover').getBoundingClientRect().bottom`);
  assert.ok(await evaluate(`document.querySelector('.ll-fullscreen-timeline').getBoundingClientRect().top >= document.querySelector('.ll-track-cover').getBoundingClientRect().bottom`),'playback timeline sits beneath cover');
  await writeFile(resolve(out,'fullscreen-desktop.png'),Buffer.from((await command('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await command('Emulation.setDeviceMetricsOverride',{width:2560,height:1440,deviceScaleFactor:1,mobile:false});
  await wait(250); await until(`(()=>{const cover=document.querySelector('.ll-track-cover').getBoundingClientRect().width;return Math.abs(document.querySelector('.ll-fullscreen-play svg').getBoundingClientRect().height/cover-22/320)<.001&&Math.abs(document.querySelector('.ll-fullscreen-exit').getBoundingClientRect().width/cover-28/320)<.001;})()`);
  const controlRatios = await evaluate(`(()=>{const cover=document.querySelector('.ll-track-cover').getBoundingClientRect().width;const play=document.querySelector('.ll-fullscreen-play svg').getBoundingClientRect();const exit=document.querySelector('.ll-fullscreen-exit').getBoundingClientRect();return {cover,playHeight:play.height,exitWidth:exit.width};})()`);
  assert.ok(Math.abs(controlRatios.playHeight/controlRatios.cover-22/320)<.001,'large fullscreen keeps play-to-cover proportion');
  assert.ok(Math.abs(controlRatios.exitWidth/controlRatios.cover-28/320)<.001,'large fullscreen keeps close-to-cover proportion');
  await writeFile(resolve(out,'fullscreen-large.png'),Buffer.from((await command('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await command('Emulation.setDeviceMetricsOverride',{width:448,height:900,deviceScaleFactor:1,mobile:false});
  await wait(250); await untilPanelMeasured(); await untilArtwork(true);
  assert.equal(await artworkVisible(),true,'narrow fullscreen keeps cover visible');
  assert.equal(await evaluate(`document.querySelector('.ll-track-cover').getBoundingClientRect().width>0`),true,'narrow fullscreen has real artwork area');
  const narrowStageWidth=await evaluate(`document.querySelector('.ll-lyric-stage').getBoundingClientRect().width`);
  assert.ok(narrowStageWidth>200,`narrow fullscreen reserves readable lyrics: stage ${narrowStageWidth}px`);
  assert.equal(await evaluate(`(()=>{const buttons=[...document.querySelectorAll('.ll-fullscreen-transport button')].filter(b=>!b.hidden).map(b=>b.getBoundingClientRect());return buttons.every((b,i)=>i===0||buttons[i-1].right<=b.left+.5);})()`),true,'narrow transport buttons do not overlap');
  await writeFile(resolve(out,'fullscreen-narrow.png'),Buffer.from((await command('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await command('Emulation.setDeviceMetricsOverride',{width:1148,height:964,deviceScaleFactor:1,mobile:false});
  await evaluate(`fixture.view.updateTrack({name:'Missing cover',metadata:{}})`);
  await wait(150); await untilArtwork(true);
  assert.equal(await artworkVisible(),true,'fullscreen retains artwork space when image is unavailable');
  assert.ok(await evaluate(`document.querySelector('.ll-fullscreen-timeline').getBoundingClientRect().height>0`),'missing artwork does not hide playback');
  await evaluate(`document.querySelector('.ll-fullscreen-timeline input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  assert.equal(await evaluate(`!!document.querySelector('.ll-fullscreen')`),false,'Escape inside the full screen dialog exits it');
  assert.equal(await evaluate(`document.querySelector('.ll-player')===mainPlayerBefore && !!document.querySelector('.main-view-container > #liquid-lyrics-overlay')`),true,'restores original main player');
  assert.equal(await evaluate(`document.querySelectorAll('.ll-fullscreen-controls').length`),0,'controls cleaned up');
  await evaluate(`fixture.view.unmount(); fixture.view.enterFullscreen(); window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));`);
  assert.equal(await evaluate(`document.querySelector('#liquid-lyrics-overlay')===null`),true,'closed-origin fullscreen returns to Spotify');
  assert.equal(await evaluate(`document.getElementById('original').style.display`),'flex','host content restored');
  await evaluate(`fixture.view.mount(); HTMLElement.prototype.requestFullscreen=originalRequestFullscreen;`);
  await command('Runtime.evaluate',{expression:'fixture.view.enterFullscreen()',userGesture:true});
  await wait(400); await until(`document.fullscreenElement===document.querySelector('#liquid-lyrics-overlay')`);
  assert.equal(await evaluate(`document.fullscreenElement===document.querySelector('#liquid-lyrics-overlay')`),true,'real browser fullscreen enters on user activation');
  await evaluate('document.exitFullscreen()');
  await wait(200); await until(`document.querySelector('.ll-fullscreen')===null && fixture.view.getIsVisible()`);
  assert.equal(await evaluate(`document.querySelector('.ll-fullscreen')===null && fixture.view.getIsVisible()`),true,'browser exit restores main view');
  for (const mode of ['?modern', '?legacy', '?detached']) {
    await command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/app${mode}` });
    await until('!!globalThis.Spicetify?.Player?.data && !!window.appFixture');
    if (mode === '?detached') {
      await wait(150);
      assert.equal(await evaluate("document.querySelectorAll('.ll-toggle').length"), 0, 'fallback starts detached');
      await evaluate('appFixture.mountControls()');
    }
    await until("document.querySelectorAll('.ll-toggle').length === 1 && document.querySelector('.ll-toggle')?.dataset.tooltip === 'Liquid Lyrics'");
    assert.equal(await evaluate("document.querySelectorAll('.ll-toggle').length"), 1, `${mode}: one visible button`);
    assert.equal(await evaluate("document.querySelector('.ll-toggle').getAttribute('aria-pressed')"), 'true', 'initial active state');
    assert.equal(await evaluate("document.querySelector('.ll-toggle').dataset.tooltip"), 'Liquid Lyrics', 'tooltip retained');
    assert.equal(await evaluate("document.querySelector('.ll-toggle').getBoundingClientRect().width"), 32, 'button has visible bounds');
    await evaluate("document.querySelector('.ll-toggle').click()");
    assert.equal(await evaluate('appFixture.history.location.pathname'), '/', 'button closes lyric route');
    await evaluate('appFixture.mountControls()');
    await until("document.querySelectorAll('.ll-toggle').length === 1");
    assert.equal(await evaluate("document.querySelectorAll('.ll-toggle').length"), 1, 'controls replacement restores one button');
    assert.equal(await evaluate("document.querySelector('.ll-toggle').getAttribute('aria-pressed')"), 'false', 'replacement preserves inactive state');
    assert.equal(await evaluate("document.querySelectorAll('[data-testid=control-button-queue]').length"), 1, 'native queue control preserved');
    await evaluate("document.querySelector('.ll-toggle').click()");
    assert.equal(await evaluate('appFixture.history.location.pathname'), '/liquid-lyrics', 'remounted button opens view');
    await evaluate("appFixture.mountControls('alternate')");
    await until("document.querySelectorAll('.ll-toggle').length === 1");
    assert.equal(await evaluate("document.querySelectorAll('.ll-toggle').length"), 1, 'mounts beside miniplayer if lyrics control is absent');
    await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', {key:'l',ctrlKey:true,altKey:true}))");
    assert.equal(await evaluate('appFixture.history.location.pathname'), '/', 'keyboard shortcut still closes view');
  }
  for (const mode of ['', '?fallback=1', '?topbar=1']) {
    await command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/app${mode}` });
    await until('window.appFixture?.registerCalls() > 0 && appFixture.registrations.length > 0');
    assert.equal(await evaluate('appFixture.registerCalls()'), 1, 'button registered once');
    assert.equal(await evaluate("appFixture.registrations[0].element.getAttribute('aria-pressed')"), String(!mode.includes('fallback')), 'initial route state');
    if (!mode.includes('fallback')) await evaluate('appFixture.registrations[0].element.click()');
    await evaluate('appFixture.registrations[0].element.click()');
    await wait(100); await until("document.querySelectorAll('#liquid-lyrics-overlay').length === 1");
    assert.equal(await evaluate("document.querySelectorAll('#liquid-lyrics-overlay').length"), 1, 'button opens one view');
    assert.equal(await evaluate("appFixture.registrations[0].element.getAttribute('aria-pressed')"), 'true', 'button active');
    const icon = await evaluate("appFixture.registrations[0].element.querySelector('svg').getBoundingClientRect().toJSON()");
    assert.equal(icon.width, 24); assert.equal(icon.height, 24);
    if (mode === '') {
      const shot = await command('Page.captureScreenshot', { format: 'png' });
      await writeFile(resolve(out, 'icon.png'), Buffer.from(shot.data, 'base64'));
    }
    await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))");
    assert.equal(await evaluate("appFixture.registrations[0].element.getAttribute('aria-pressed')"), 'false', 'Escape updates button');
    assert.equal(await evaluate("document.querySelector('#original').style.display"), 'flex', 'host restored');
  }
  await command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/app?credits` });
  await until('window.appFixture?.registerCalls() > 0');
  const firstId = '1'.repeat(22), secondId = '2'.repeat(22), thirdId = '3'.repeat(22);
  await evaluate(`appFixture.changeTrack('${firstId}')`);
  await until(`appFixture.creditRequests.has('spotify:track:${firstId}')`);
  assert.equal(await evaluate(`document.querySelector('.ll-credits-source')?.textContent`), 'Provided by LRCLIB');
  await evaluate(`appFixture.changeTrack('${secondId}')`);
  await until(`appFixture.creditRequests.has('spotify:track:${secondId}')`);
  await evaluate(`appFixture.finishCredits('${firstId}', 'Stale Writer')`);
  await wait(50);
  assert.equal(await evaluate(`!!document.querySelector('.ll-credits-writers')`), false, 'stale track writers ignored');
  await until(`!!document.querySelector('.FmKaba_lyricLine:has(.FmKaba_lyricMainLine)')`);
  await evaluate(`document.querySelector('.FmKaba_lyricLine:has(.FmKaba_lyricMainLine)').dataset.creditFixture = 'current'`);
  await evaluate(`appFixture.finishCredits('${secondId}', 'Current Writer')`);
  await until(`document.querySelector('.ll-credits-writers')?.textContent === 'Current Writer'`);
  assert.equal(await evaluate(`document.querySelector('.ll-credits-source')?.textContent`), 'Provided by LRCLIB');
  assert.equal(await evaluate(`document.querySelector('.FmKaba_lyricLine:has(.FmKaba_lyricMainLine)').dataset.creditFixture`),
    'current', 'late credits do not recreate lyric lines');
  await evaluate(`appFixture.changeTrack('${thirdId}', 'With writers')`);
  await until(`document.querySelector('.ll-credits-writers')?.textContent === 'Provider Writer'`);
  assert.equal(await evaluate(`appFixture.creditRequests.size`), 2, 'existing writer metadata skips native requests');
  await command('Emulation.setDeviceMetricsOverride', { width: 1600, height: 964, deviceScaleFactor: 1, mobile: false });
  const linkedId = '4'.repeat(22), artistId = '5'.repeat(22), secondArtistId = '6'.repeat(22), albumId = '7'.repeat(22);
  await evaluate(`(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 10;
    appFixture.changeTrack('${linkedId}', 'With writers', {metadata:{image_url:canvas.toDataURL()},
      album:{name:'Album fixture',uri:'spotify:album:${albumId}'},
      artists:[{name:'First artist',uri:'spotify:artist:${artistId}'},{name:'Second artist',uri:'spotify:artist:${secondArtistId}'}]});
  })()`);
  await until(`document.querySelector('.ll-track-panel')?.hidden === false`);
  assert.equal(await evaluate(`document.querySelector('.ll-track-artist').textContent`), 'First artist, Second artist — Album fixture');
  assert.equal(await evaluate(`document.querySelector('.ll-track-album').textContent`), 'Album fixture');
  assert.equal(await evaluate(`document.querySelector('.ll-track-panel [title]')`), null, 'metadata does not repeat in native tooltips');
  await evaluate(`document.querySelector('.ll-track-title a').click()`);
  assert.equal(await evaluate('appFixture.history.location.pathname'), `/track/${linkedId}`, 'title navigates to the track');
  assert.equal(await evaluate(`!!document.querySelector('#liquid-lyrics-overlay')`), false, 'navigation unmounts the lyric overlay');
  assert.equal(await evaluate(`document.querySelector('#original').style.display`), 'flex', 'track navigation restores the host');
  for (const [index, artist] of [artistId, secondArtistId].entries()) {
    await evaluate(`appFixture.history.push('/liquid-lyrics')`);
    await until(`document.querySelector('.ll-track-panel')?.hidden === false`);
    await evaluate(`document.querySelectorAll('.ll-track-artist a')[${index}].focus()`);
    await command('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await command('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    assert.equal(await evaluate('appFixture.history.location.pathname'), `/artist/${artist}`, 'Enter opens the individual artist profile');
    assert.equal(await evaluate(`!!document.querySelector('#liquid-lyrics-overlay')`), false, 'artist navigation unmounts the lyric overlay');
  }
  await evaluate(`appFixture.history.push('/liquid-lyrics')`);
  await until(`document.querySelector('.ll-track-panel')?.hidden === false`);
  await evaluate(`document.querySelector('.ll-track-album a').click()`);
  assert.equal(await evaluate('appFixture.history.location.pathname'), `/album/${albumId}`, 'album navigates to its page');
  assert.equal(await evaluate(`!!document.querySelector('#liquid-lyrics-overlay')`), false, 'album navigation unmounts the lyric overlay');
  await evaluate(`appFixture.history.push('/liquid-lyrics'); appFixture.changeTrack('${'8'.repeat(22)}','With writers',
    {metadata:{album_title:'Metadata album',album_uri:'spotify:album:${albumId}'}})`);
  assert.equal(await evaluate(`document.querySelector('.ll-track-album a').getAttribute('href')`), `https://open.spotify.com/album/${albumId}`, 'metadata album fallback links correctly');
  await evaluate(`appFixture.changeTrack('${'9'.repeat(22)}','With writers',{album:{name:'Unlinked album',uri:'javascript:alert(1)'}})`);
  assert.equal(await evaluate(`document.querySelector('.ll-track-album').textContent`), 'Unlinked album');
  assert.equal(await evaluate(`document.querySelector('.ll-track-album a')`), null, 'invalid album URI stays plain text');
  await evaluate(`appFixture.changeTrack('${'a'.repeat(22)}','With writers')`);
  assert.equal(await evaluate(`document.querySelector('.ll-track-album').hidden`), true, 'missing album clears and hides stale metadata');
  await writeFile(resolve(out, 'report.json'), JSON.stringify({ reports, errors }, null, 2));
  await command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/app?modern` });
  await until("document.querySelectorAll('.ll-toggle').length === 1 && !!globalThis.Spicetify?.Player?.data");
  await evaluate(`window.stockClicks=0; HTMLElement.prototype.requestFullscreen=()=>Promise.reject(new Error('Fixture fallback'));
    const button=document.createElement('button');button.dataset.testid='fullscreen-mode-button';button.innerHTML='<svg><path/></svg>';
    button.addEventListener('click',()=>stockClicks++);document.querySelector('.updated-controls').append(button);
    button.querySelector('path').dispatchEvent(new MouseEvent('click',{bubbles:true}));`);
  await wait(200); await until(`document.querySelectorAll('.ll-fullscreen').length === 1`);
  assert.equal(await evaluate('stockClicks'),0,'stock fullscreen intercepted before Spotify');
  assert.equal(await evaluate(`document.querySelectorAll('.ll-fullscreen').length`),1,'stock fullscreen opens Liquid');
  await evaluate(`document.querySelector('.ll-fullscreen-exit').click(); document.querySelector('[data-testid="fullscreen-mode-button"]').remove();
    const replacementButton=document.createElement('button');replacementButton.dataset.testid='fullscreen-mode-button';document.querySelector('.updated-controls').append(replacementButton);replacementButton.click();`);
  assert.equal(await evaluate(`document.querySelectorAll('.ll-fullscreen-controls').length`),1,'replacement button works without duplicate controls');
  await evaluate(`appFixture.history.push('/')`);
  assert.equal(await evaluate(`document.querySelector('#liquid-lyrics-overlay')===null`),true,'route change cleans fullscreen');
  // Updating from Marketplace leaves the older release installed under its own path, in localStorage
  // (older Marketplace) or IndexedDB (newer Marketplace).
  const appUrl = `http://127.0.0.1:${server.address().port}/app?modern`;
  const installKey = version => `marketplace:installed:abirwalker/liquid-lyrics/Extension/Build/v${version}/liquid-lyrics.js`;
  // A fixed-path install keeps its install-time version while loading the newest build, so it must stay.
  const fixedInstall = 'marketplace:installed:abirwalker/liquid-lyrics/Extension/liquid-lyrics.js';
  const installs = [installKey('0.9.0'), installKey('1.0.0'), installKey('2.0.0'), fixedInstall, 'marketplace:installed:someone/other/other.js'];
  const record = key => key === fixedInstall ? JSON.stringify({ manifest: { version: '0.1.0' } }) : '{}';
  await evaluate(`(async () => {
    const keys = ${JSON.stringify(installs)};
    localStorage.removeItem('liquid-lyrics:clean-version');
    localStorage.setItem('marketplace:installed-extensions', JSON.stringify(keys));
    const records = ${JSON.stringify(Object.fromEntries(installs.map(key => [key, record(key)])))};
    for (const key of keys) localStorage.setItem(key, records[key]);
    const opening = indexedDB.open('spicetify-marketplace', 20);
    opening.onupgradeneeded = () => opening.result.createObjectStore('settings', { keyPath: 'key' });
    const db = await new Promise(resolve => { opening.onsuccess = () => resolve(opening.result); });
    const writing = db.transaction('settings', 'readwrite');
    writing.objectStore('settings').put({ key: 'marketplace:installed-extensions', value: JSON.stringify(keys) });
    for (const key of keys) writing.objectStore('settings').put({ key, value: records[key] });
    await new Promise(resolve => { writing.oncomplete = resolve; });
    db.close();
  })()`);
  const readInstalls = `(async () => {
    const opening = indexedDB.open('spicetify-marketplace');
    const db = await new Promise(resolve => { opening.onsuccess = () => resolve(opening.result); });
    const reading = db.transaction('settings').objectStore('settings').getAll();
    const records = await new Promise(resolve => { reading.onsuccess = () => resolve(reading.result); });
    db.close();
    return JSON.stringify({
      localList: JSON.parse(localStorage.getItem('marketplace:installed-extensions')),
      localRecords: ${JSON.stringify(installs)}.filter(key => localStorage.getItem(key) !== null),
      dbList: JSON.parse(records.find(record => record.key === 'marketplace:installed-extensions').value),
      dbRecords: records.map(record => record.key).filter(key => key !== 'marketplace:installed-extensions'),
    });
  })()`;
  const cleanVersion = "localStorage.getItem('liquid-lyrics:clean-version')";
  await command('Page.navigate', { url: appUrl });
  await until("document.querySelectorAll('.ll-toggle').length === 1 && !!globalThis.Spicetify?.Player?.data");
  await until(`(${readInstalls}).then(state => !state.includes('v0.9.0'))`);
  const kept = installs.slice(1);
  assert.deepEqual(JSON.parse(await evaluate(readInstalls)), { localList: kept, localRecords: kept, dbList: kept, dbRecords: kept },
    'older Liquid Lyrics installs are removed; current, newer, fixed-path and other extensions stay');
  assert.equal(await evaluate(cleanVersion), null, 'a check that removed something runs again next start');
  await command('Page.navigate', { url: appUrl });
  await until(`${cleanVersion} === '1.0.0'`);
  assert.equal(await evaluate(cleanVersion), '1.0.0', 'a check that finds nothing is remembered');

  // Marketplace treats each release path as a separate install, so several copies can boot in one page.
  await command('Page.navigate', { url: appUrl });
  await until("document.querySelectorAll('.ll-toggle').length === 1 && !!globalThis.Spicetify?.Player?.data");
  const addStyle = version => evaluate(`document.head.append(Object.assign(document.createElement('style'), { id: 'll-test-${version}' }))`);
  const loadCopy = async (version, path = `/copy-${version}.js`) => {
    await addStyle(version);
    await evaluate(`new Promise((resolve, reject) => document.body.append(Object.assign(document.createElement('script'),
      { src: '${path}', onload: resolve, onerror: reject })))`);
  };
  const running = () => evaluate("[document.querySelectorAll('.ll-toggle').length, window.LiquidLyrics?.version].join()");
  const hasStyle = version => evaluate(`!!document.getElementById('ll-test-${version}')`);
  await addStyle('1.0.0');
  await until("document.querySelectorAll('#liquid-lyrics-overlay').length === 1");
  await loadCopy('0.0.1');
  assert.equal(await running(), '1,1.0.0', 'older copy does not start beside a newer one');
  assert.equal(await hasStyle('0.0.1'), false, 'older copy removes its own styles');
  assert.equal(await hasStyle('1.0.0'), true, 'running copy keeps its styles');
  await loadCopy('9.9.9');
  assert.equal(await running(), '1,9.9.9', 'newer copy replaces the running one');
  assert.equal(await hasStyle('1.0.0'), false, 'replaced copy takes its styles with it');
  await until("document.querySelectorAll('#liquid-lyrics-overlay').length === 1");
  assert.equal(await evaluate("document.querySelectorAll('#liquid-lyrics-overlay').length"), 1, 'one lyrics view after takeover');
  assert.equal(await evaluate('appFixture.playerListenerCount()'), 1, 'replaced copy stops listening to the player');
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, altKey: true }))");
  assert.equal(await evaluate("document.querySelector('.ll-toggle').getAttribute('aria-pressed')"), 'false', 'shortcut toggles one copy');
  assert.equal(await evaluate("document.querySelector('#liquid-lyrics-overlay')"), null, 'shortcut closes the only view');
  // A copy installed from a renamed file is still recognised, and the user gets the command to remove it.
  await loadCopy('0.0.1', '/extensions/lyricsapp.js');
  assert.equal(await running(), '1,9.9.9', 'file-installed older copy does not start');
  await until('appFixture.modals.length > 0', 100, 100);
  assert.ok((await evaluate('appFixture.modals.join()')).includes('spicetify config extensions lyricsapp.js-'),
    'renamed file copy gets its remove command');
  assert.equal(await evaluate('appFixture.modals.length'), 1, 'remove command shown once');

  // v1.3.2 and older cannot be stopped; their style element is the sign one has loaded.
  await evaluate("localStorage.removeItem('liquid-lyrics:clean-version')");
  await command('Page.navigate', { url: appUrl });
  await until("document.querySelectorAll('.ll-toggle').length === 1 && !!globalThis.Spicetify?.Player?.data");
  await addStyle('1.0.0');
  await evaluate("document.head.append(Object.assign(document.createElement('style'), { id: 'liquid-lyrics-styles' }))");
  await until("document.querySelectorAll('.ll-toggle').length === 0 && appFixture.modals.length > 0");
  assert.equal(await evaluate("document.querySelector('#liquid-lyrics-overlay')"), null, 'copy steps aside for an older unguarded copy');
  assert.ok((await evaluate('appFixture.modals[0]')).includes('Older Liquid Lyrics still running'), 'user is told about the old copy');
  assert.equal(await hasStyle('1.0.0'), false, 'stepped-aside copy removes its styles');
  assert.equal(await evaluate("Symbol.for('liquid-lyrics.instance') in globalThis"), false, 'stepped-aside copy leaves the registry');
  assert.equal(await evaluate('typeof window.LiquidLyrics?.cleanUp'), 'function', 'manual clean-up stays available');
  await loadCopy('9.9.9');
  assert.equal(await evaluate("document.querySelectorAll('.ll-toggle').length"), 0, 'no copy starts while an unguarded one runs');
  assert.equal(await evaluate('appFixture.playerListenerCount()'), 0, 'no player listeners left behind');
  assert.equal(errors.length, 0, 'no runtime exceptions');
  for (const report of reports) {
    assert.ok(report.player.left >= report.host.left && report.player.right <= report.host.right, 'player inside host');
    for (const line of report.lines) {
      assert.ok(line.textLeft >= report.player.left - 1 && line.textRight <= report.player.right + 1,
        `${report.width}px ${report.timing}: text clipped: ${line.text}`);
    }
  }
  if (failedChecks.length) throw new Error(failedSummary());
  console.log('Browser checks passed: main renderer/app regressions, full-screen entry/exit and restoration, stock button remount, playback/seek/volume, narrow cover and missing-artwork controls.');
} catch (error) {
  if (!failedChecks.length || error.message === failedSummary()) throw error;
  throw new Error(`${error.message}\n${failedSummary()}`, { cause: error });
} finally {
  await send('Browser.close').catch(() => {});
  socket.close();
  await stopChrome(chrome);
  server.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
