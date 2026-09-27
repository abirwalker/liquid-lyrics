import { build } from 'esbuild';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import assert from 'node:assert/strict';

const out = resolve('logs/renderer-tests');
await mkdir(out, { recursive: true });
await build({ entryPoints: ['tests/renderer-adapter.test.ts'], bundle: true, platform: 'node', outfile: resolve(out, 'adapter-tests.cjs') });
await import(pathToFileURL(resolve(out, 'adapter-tests.cjs')).href);
await build({ entryPoints: { harness: resolve('tests/renderer-browser.ts'), 'app-harness': resolve('tests/renderer-app.ts') }, bundle: true, outdir: out,
  format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
const server = http.createServer(async (req, res) => {
  const file = ['/harness.js', '/harness.css', '/app-harness.js', '/app-harness.css'].includes(req.url) ? req.url.slice(1) : null;
  res.setHeader('Content-Type', file?.endsWith('.js') ? 'text/javascript' : file ? 'text/css' : 'text/html');
  const entry = req.url.startsWith('/app') ? 'app-harness' : 'harness';
  res.end(file ? await readFile(resolve(out, file)) : `<!doctype html><link rel="stylesheet" href="/${entry}.css"><body><script src="/${entry}.js"></script></body>`);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const profile = await mkdtemp(resolve(out, 'chrome-'));
const chrome = spawn(process.env.LYRICS_TEST_BROWSER ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--no-first-run',
  '--no-default-browser-check', '--remote-debugging-port=0', '--enable-unsafe-swiftshader',
  `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
const endpoint = await new Promise((resolveEndpoint, reject) => {
  let output = '';
  const timeout = setTimeout(() => reject(new Error('Chrome startup timed out')), 15000);
  chrome.stderr.on('data', chunk => {
    output += chunk;
    const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (match) { clearTimeout(timeout); resolveEndpoint(match[1]); }
  });
  chrome.once('error', reject);
});
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
const command = (method, params) => send(method, params, sessionId);
const evaluate = async expression => {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const wait = ms => new Promise(r => setTimeout(r, ms));
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
  await evaluate('fixture.setProgress(6000); fixture.view.setLyrics(fixture.spotifyInterludeFixture())');
  await wait(200);
  const spotifyLineTexts = await evaluate("[...document.querySelectorAll('.FmKaba_lyricMainLine')].map(line => line.textContent)");
  assert.ok(!spotifyLineTexts.includes('♪'), `Spotify music note rendered as a lyric line: ${spotifyLineTexts}`);
  assert.equal(await evaluate("document.querySelector('.FmKaba_interludeDots')?.classList.contains('FmKaba_enabled')"), true,
    'Spotify music note leaves a timed gap for AMLL interlude dots');
  await evaluate('fixture.setProgress(5500); fixture.view.setLyrics(fixture.backgroundFixture())');
  await wait(400);
  assert.equal(await evaluate("document.querySelectorAll('.FmKaba_lyricBgLine').length"), 1, 'one backing line');
  assert.equal(await evaluate("document.querySelector('.FmKaba_lyricBgLine .FmKaba_lyricMainLine').textContent"), 'How long?');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.FmKaba_lyricBgLine')).opacity"), '0');
  await evaluate('fixture.setProgress(2200)');
  await wait(120);
  const enteringOpacity = Number(await evaluate("getComputedStyle(document.querySelector('.FmKaba_lyricBgLine')).opacity"));
  assert.ok(enteringOpacity > 0 && enteringOpacity < .4, `backing line fade: ${enteringOpacity}`);
  await wait(450);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.FmKaba_lyricBgLine')).opacity"), '0.4');
  const backingShot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(out, 'lyrics-background.png'), Buffer.from(backingShot.data, 'base64'));
  await evaluate('fixture.setProgress(133500); fixture.view.setLyrics(fixture.overlappingTaggedBackingFixture())');
  await wait(550);
  const taggedBackingState = index => evaluate(`(() => {
    const group = fixture.view.player.currentLyricGroups[${index}];
    return { opacity: Number(getComputedStyle(group.bgLine.getElement()).opacity),
      height: group.bgWrapper.getBoundingClientRect().height };
  })()`);
  assert.ok((await taggedBackingState(0)).height > 0, 'first tagged backing is visible while sung');
  await evaluate('fixture.setProgress(135000)');
  await wait(600);
  assert.deepEqual(await taggedBackingState(0), { opacity: 0, height: 0 },
    'first tagged backing hides at its own end while the following lead plays');
  await evaluate('fixture.setProgress(138500)');
  await wait(550);
  assert.ok((await taggedBackingState(1)).height > 0, 'second tagged backing is visible while sung');
  await evaluate('fixture.setProgress(139800)');
  await wait(600);
  assert.deepEqual(await taggedBackingState(1), { opacity: 0, height: 0 },
    'second tagged backing hides at its own end while the following lead plays');
  for (const first of [true, false]) {
    await evaluate(`fixture.setProgress(800); fixture.view.setLyrics(fixture.bracketFixture(${first}))`);
    await wait(600);
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
    await wait(500);
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.FmKaba_lyricBgLine')).opacity"), '0',
      'line-synced backing fades when its parent line ends');
  }
  await evaluate('fixture.setProgress(3000); fixture.view.setLyrics(fixture.sunflowerFixture())');
  await wait(600);
  assert.equal(await evaluate("document.querySelector('.FmKaba_lyricBgLine .FmKaba_lyricMainLine').textContent"), 'Yeah, yeah');
  assert.equal(await evaluate("document.querySelector('.FmKaba_lyricBgLine').classList.contains('FmKaba_active')"), true);
  assert.equal(await evaluate("document.querySelectorAll('.FmKaba_lyricBgLine .FmKaba_lyricMainLine > span').length > 0"), true);
  const sunflowerShot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(out, 'lyrics-word-background-sunflower.png'), Buffer.from(sunflowerShot.data, 'base64'));
  await evaluate('fixture.setProgress(14500); fixture.view.setLyrics(fixture.standaloneBackingFixture())');
  await wait(500);
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
  await wait(550);
  const duringBacking = await standaloneState();
  assert.equal(duringBacking?.active, true);
  assert.equal(duringBacking?.opacity, .75, 'background vocal brightens during its own timed phrase');
  assert.ok(duringBacking.font < 58, 'standalone vocal uses smaller type');
  const standaloneShot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(out, 'lyrics-standalone-background.png'), Buffer.from(standaloneShot.data, 'base64'));
  await evaluate('fixture.setProgress(19100)');
  await wait(550);
  assert.equal((await standaloneState())?.opacity, 0, 'standalone vocal fades after its own end');
  await evaluate('fixture.setProgress(17000)');
  await wait(550);
  assert.equal((await standaloneState())?.opacity, .75, 'seek back restores standalone vocal');
  await evaluate('fixture.setProgress(79100)');
  await wait(550);
  const overlappingRows = await evaluate("fixture.view.player.currentLyricGroups.slice(1, 3).map(group => ({ active: group.isActive, start: group.mainLine.getLine().startTime, end: group.mainLine.getLine().endTime }))");
  assert.equal(overlappingRows[0].active, true, 'backing stays active through its supplied end');
  assert.equal(overlappingRows[0].end, 79276);
  assert.equal(overlappingRows[1].start, 78959);
  const backingLayout = () => evaluate("(() => { const group = fixture.view.player.currentLyricGroups[1]; return { height: group.element.getBoundingClientRect().height, wrapperHeight: group.bgWrapper.getBoundingClientRect().height, position: getComputedStyle(group.bgWrapper).position }; })()");
  const beforeBackingEnd = await backingLayout();
  assert.ok(beforeBackingEnd.wrapperHeight > 10, 'the active backing row occupies space');
  const overlapShot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(out, 'lyrics-standalone-background-overlap.png'), Buffer.from(overlapShot.data, 'base64'));
  await evaluate('fixture.setProgress(79500)');
  await wait(120);
  const collapsingBacking = await backingLayout();
  assert.ok(collapsingBacking.height < beforeBackingEnd.height && collapsingBacking.wrapperHeight > 0,
    `backing row eases out instead of snapping shut: ${JSON.stringify({ beforeBackingEnd, collapsingBacking })}`);
  await wait(450);
  const afterOverlap = await evaluate("fixture.view.player.currentLyricGroups.slice(1, 3).map(group => ({ active: group.isActive, start: group.mainLine.getLine().startTime, end: group.mainLine.getLine().endTime }))");
  assert.equal(await evaluate("getComputedStyle(fixture.view.player.currentLyricGroups[1].bgLine.getElement()).opacity"), '0',
    `backing fades after its own end while the next lead continues: ${JSON.stringify(afterOverlap)}`);
  const afterBackingEnd = await backingLayout();
  assert.equal(afterBackingEnd.wrapperHeight, 0, 'finished backing no longer occupies lyric group height');
  assert.ok(afterBackingEnd.height < beforeBackingEnd.height - 10,
    `the lyric group contracts at the backing end: ${JSON.stringify({ beforeBackingEnd, afterBackingEnd })}`);
  await evaluate('fixture.setProgress(79100)');
  await wait(550);
  const restoredBacking = await backingLayout();
  assert.equal(restoredBacking.position, 'relative', 'seeking backward restores backing layout');
  assert.ok(restoredBacking.height > afterBackingEnd.height + 10);
  await evaluate('fixture.setProgress(1700); fixture.view.setLyrics(fixture.forwardBackingFixture())');
  await wait(600);
  const forwardPlacement = await evaluate("(() => { const groups = fixture.view.player.currentLyricGroups; const next = groups[1]; return { count: groups.length, backing: next.bgLine?.getLine().words[0].word, top: next.element.firstElementChild.contains(next.bgLine.getElement()), active: next.bgLine.getElement().classList.contains('FmKaba_active') }; })()");
  assert.deepEqual(forwardPlacement, { count: 2, backing: 'Come closer tonight', top: true, active: true },
    'a stronger following-line word match places backing above that line');
  await evaluate('fixture.setProgress(49000); fixture.view.setLyrics(fixture.rockabyeShapeFixture())');
  await wait(550);
  const rockabyeState = () => evaluate("(() => { const group = fixture.view.player.currentLyricGroups[1]; return { opacity: getComputedStyle(group.bgLine.getElement()).opacity, wrapperHeight: group.bgWrapper.getBoundingClientRect().height }; })()");
  assert.equal((await rockabyeState()).opacity, '0.75', 'line-timed bracket backing brightens with its lead');
  for (let time = 49100; time <= 52000; time += 100) {
    await evaluate(`fixture.setProgress(${time})`);
    await wait(30);
  }
  const rockabyeFinished = await rockabyeState();
  assert.ok(Number(rockabyeFinished.opacity) < .01 && rockabyeFinished.wrapperHeight === 0,
    'line-timed bracket backing is gone before the following lead finishes');
  await evaluate('fixture.setPlaying(true); fixture.setProgress(166000); fixture.view.setLyrics(fixture.pausedBackingFixture())');
  await wait(550);
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
  await wait(550);
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
  await wait(300);
  await evaluate("document.querySelector('.FmKaba_lyricLineWrapper').click()");
  assert.equal(await evaluate('fixture.seeks.at(-1)'), 0, 'line click seeks');
  await evaluate("document.querySelector('.ll-player').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown',bubbles:true}))");
  assert.equal(await evaluate('fixture.seeks.at(-1)'), 4000, 'keyboard seeks');
  await evaluate("fixture.view.setLyrics(fixture.fixture('none'))");
  assert.equal(await evaluate("document.querySelectorAll('.ll-plain-lyrics p').length"), 8);
  assert.equal(await evaluate("document.querySelector('.ll-player').hidden"), true);
  await evaluate('fixture.view.setLyrics(null)');
  assert.equal(await evaluate("document.querySelector('.ll-status-msg').textContent"), 'No lyrics available');
  await evaluate("fixture.view.setLyrics({source:'test',instrumental:true,lines:[]})");
  assert.equal(await evaluate("document.querySelector('.ll-status-msg').textContent"), 'Instrumental track');
  await evaluate('fixture.view.unmount()');
  assert.equal(await evaluate("document.querySelector('#original').style.display"), 'flex');
  assert.equal(await evaluate("document.querySelector('#liquid-lyrics-overlay') === null"), true);
  await evaluate('fixture.view.mount(); fixture.view.setLyrics(fixture.fixture())');
  await wait(200);
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))");
  assert.equal(await evaluate('fixture.view.getIsVisible()'), false);
  await evaluate("document.querySelector('.Root__main-view').className = 'missing'; document.querySelector('main').className = ''; fixture.view.mount(); fixture.view.unmount(); document.querySelector('main').className = 'main-view-container'; document.querySelector('.missing').className = 'Root__main-view'");
  await wait(200);
  assert.equal(await evaluate("document.querySelector('#liquid-lyrics-overlay') === null"), true, 'pending mount cancelled');
  for (const height of [500, 900]) {
    await evaluate(`fixture.resize(${height}); fixture.view.mount(); fixture.view.setLyrics(fixture.fixture()); fixture.setProgress(28500)`);
    await wait(400);
    const report = await evaluate('fixture.measure()');
    const last = report.lines.at(-1).rect;
    assert.ok(last.top >= report.player.top && last.bottom <= report.player.bottom, 'last line fully visible');
    await evaluate('fixture.setProgress(0)');
    await wait(400);
    const firstReport = await evaluate('fixture.measure()');
    assert.ok(firstReport.lines[0].rect.top >= firstReport.player.top, 'first line visible');
  }
  await command('Emulation.setEmulatedMedia', { features: [{name:'prefers-reduced-motion', value:'reduce'}] });
  await wait(700);
  const filters = await evaluate("[...document.querySelectorAll('.FmKaba_lyricLineWrapper')].map(el => getComputedStyle(el).filter)");
  assert.ok(filters.every(filter => filter === 'none'), `reduced motion has no blur: ${filters}`);
  await command('Emulation.setEmulatedMedia', { features: [] });
  await evaluate("fixture.view.setLyrics(fixture.fixture('word')); fixture.setProgress(12500); fixture.setPlaying(true)");
  await wait(700);
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
  for (const mode of ['', '?fallback=1', '?topbar=1']) {
    await command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/app${mode}` });
    await wait(600);
    assert.equal(await evaluate('appFixture.registerCalls()'), 1, 'button registered once');
    assert.equal(await evaluate("appFixture.registrations[0].element.getAttribute('aria-pressed')"), String(!mode.includes('fallback')), 'initial route state');
    if (!mode.includes('fallback')) await evaluate('appFixture.registrations[0].element.click()');
    await evaluate('appFixture.registrations[0].element.click()');
    await wait(100);
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
  await writeFile(resolve(out, 'report.json'), JSON.stringify({ reports, errors }, null, 2));
  assert.equal(errors.length, 0, 'no runtime exceptions');
  for (const report of reports) {
    assert.ok(report.player.left >= report.host.left && report.player.right <= report.host.right, 'player inside host');
    for (const line of report.lines) {
      assert.ok(line.textLeft >= report.player.left - 1 && line.textRight <= report.player.right + 1,
        `${report.width}px ${report.timing}: text clipped: ${line.text}`);
    }
  }
  console.log('Browser checks passed: 4 widths, 2 heights, line/word wrapping, duet bounds, mouse/keyboard seeking, plain/empty/instrumental states, mount cancellation, reduced motion, Playbar/Topbar, route state, Escape.');
} finally {
  await send('Browser.close').catch(() => {});
  socket.close();
  chrome.kill();
  server.close();
}
