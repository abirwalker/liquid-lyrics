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
const { windowId } = await send('Browser.getWindowForTarget', { targetId });
const command = async (method, params) => {
  if (method === 'Emulation.setDeviceMetricsOverride') {
    await send('Browser.setWindowBounds', { windowId, bounds: { width: params.width, height: params.height } });
  }
  return send(method, params, sessionId);
};
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
  assert.equal(await evaluate("document.querySelectorAll('.ll-plain-lyrics > p').length"), 8);
  await evaluate(`document.querySelector('.ll-plain-lyrics > p').dataset.creditFixture = 'plain';
    fixture.view.setSongwriters(['<img src=x onerror=alert(1)>'])`);
  assert.equal(await evaluate("document.querySelector('.ll-plain-lyrics .ll-credits-writers').textContent"),
    '<img src=x onerror=alert(1)>', 'writer names render safely as text');
  assert.equal(await evaluate("document.querySelector('.ll-credits img')"), null);
  assert.equal(await evaluate("document.querySelector('.ll-plain-lyrics > p').dataset.creditFixture"), 'plain',
    'writer update preserves plain lyric elements');
  assert.equal(await evaluate("document.querySelector('.ll-player').hidden"), true);
  await evaluate('fixture.view.setLyrics(null)');
  assert.equal(await evaluate("document.querySelector('.ll-credits')"), null, 'no stale credits after clearing lyrics');
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
  assert.equal(await evaluate("getComputedStyle(document.querySelector('[data-bottom-line=true]')).transitionDuration"),
    '0s', 'reduced motion disables the credits transition');
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
  await evaluate(`(() => {
    const result = fixture.fixture();
    result.lines.at(-1).endMs = 120000;
    result.songwriters = ['Synthetic Writer'];
    fixture.view.setLyrics(result);
    fixture.setProgress(60000);
    fixture.setPlaying(false);
  })()`);
  await wait(600);
  const longFinal = await evaluate(`(() => {
    const bottom = document.querySelector('[data-bottom-line="true"]');
    const wrappers = [...document.querySelectorAll('.FmKaba_lyricLineWrapper')];
    return { focused: bottom.dataset.focused === 'true', filter: getComputedStyle(bottom).filter,
      lastActive: !!wrappers.at(-1)?.querySelector('.FmKaba_active'),
      previousBlurred: wrappers.slice(0, -1).some(wrapper => getComputedStyle(wrapper).filter !== 'none') };
  })()`);
  assert.equal(longFinal.focused, false, 'supplied final lyric end is preserved');
  assert.equal(longFinal.lastActive, true, 'long final lyric remains active');
  assert.equal(longFinal.filter, 'blur(0px)', 'credits remain readable below an active final lyric');
  assert.equal(longFinal.previousBlurred, true, 'credit fix preserves lyric blur');
  await evaluate('fixture.setProgress(121000)');
  await wait(400);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('[data-bottom-line=true]')).filter"), 'blur(0px)',
    'credits stay clear when playback crosses the final lyric end');
  const creditBlur = async () => {
    const filter = await evaluate("getComputedStyle(document.querySelector('[data-bottom-line=true]')).filter");
    return filter === 'none' ? 0 : parseFloat(filter.slice(5));
  };
  await evaluate('fixture.setProgress(24000)');
  await wait(600);
  const beforeFinalBlur = await creditBlur();
  assert.ok(beforeFinalBlur > 0, 'credits remain blurred before the final lyric');
  await evaluate('fixture.setProgress(28000)');
  await wait(120);
  const midwayClear = await creditBlur();
  assert.ok(midwayClear > 0 && midwayClear < beforeFinalBlur, 'credits blur eases into clarity');
  await wait(450);
  assert.equal(await creditBlur(), 0, 'credits settle clear during the final lyric');
  await evaluate('fixture.setProgress(24000)');
  await wait(120);
  const midwayBlur = await creditBlur();
  assert.ok(midwayBlur > 0 && midwayBlur < beforeFinalBlur, 'credits blur eases back when seeking earlier');
  await wait(450);
  assert.ok(await creditBlur() > 0, 'credit blur returns before the final lyric');
  await evaluate(`(() => {
    const data = fixture.fixture(); data.lines.at(-1).endMs = 120000;
    data.songwriters = ['Synthetic Writer'];
    fixture.setPlaying(true); fixture.setProgress(60000); fixture.view.setLyrics(data);
  })()`);
  await wait(1500);
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
    return { bottom: footer.bottom - player.top, height: player.height, lastTop: last.top - player.top };
  })()`);
  for (const [width, height] of [[1100, 900], [700, 500], [400, 800]]) {
    await command('Emulation.setDeviceMetricsOverride', { width: width + 48, height: height + 64, deviceScaleFactor: 1, mobile: false });
    await evaluate(`(() => { fixture.resize(${height}); fixture.setPlaying(false); fixture.setProgress(28500);
      const data = fixture.fixture(); data.songwriters = ['Synthetic Writer One', 'Synthetic Writer Two'];
      fixture.view.setLyrics(data); })()`);
    await wait(1500);
    const lastLine = await endLayout();
    await evaluate('fixture.setProgress(33000)');
    await wait(900);
    const finished = await endLayout();
    assert.ok(Math.abs(finished.bottom - finished.height * .7) < 2, `end credits stop at 70%: ${JSON.stringify(finished)}`);
    if (lastLine.bottom <= lastLine.height * .7 + 5) {
      assert.ok(Math.abs(lastLine.bottom - finished.bottom) < 5, 'last line ending does not recenter the footer');
    }
    await evaluate(`document.querySelector('.ll-player').dispatchEvent(new WheelEvent('wheel', {deltaY:10000, bubbles:true, cancelable:true}))`);
    await wait(900);
    const scrolledEnd = await endLayout();
    assert.ok(Math.abs(scrolledEnd.bottom - finished.bottom) < 2, 'wheel cannot scroll credits beyond the end');
    await evaluate(`document.querySelector('.ll-player').dispatchEvent(new WheelEvent('wheel', {deltaY:-200, bubbles:true, cancelable:true}))`);
    await wait(900);
    const scrolledBack = await endLayout();
    assert.ok(scrolledBack.lastTop > scrolledEnd.lastTop + 100, 'wheel still scrolls back to earlier lyrics');
    await evaluate(`document.querySelector('.ll-player').dispatchEvent(new WheelEvent('wheel', {deltaY:10000, bubbles:true, cancelable:true}))`);
    await wait(900);
    assert.ok(Math.abs((await endLayout()).bottom - finished.bottom) < 2, 'scrolling returns to the same end limit');
    await evaluate(`fixture.view.setLyrics(fixture.fixture()); fixture.setProgress(33000)`);
    await wait(900);
    await evaluate(`fixture.view.setSongwriters(['Synthetic Writer One', 'Synthetic Writer Two', 'Synthetic Writer Three'])`);
    await wait(900);
    const lateWriters = await endLayout();
    assert.ok(Math.abs(lateWriters.bottom - lateWriters.height * .7) < 2, 'late writer names remeasure the scroll end');
    await evaluate('fixture.setProgress(12500)');
    await wait(900);
    await evaluate(`document.querySelector('.ll-player').dispatchEvent(new WheelEvent('wheel', {deltaY:10000, bubbles:true, cancelable:true}))`);
    await wait(900);
    const earlyScroll = await endLayout();
    assert.ok(Math.abs(earlyScroll.bottom - earlyScroll.height * .7) < 2, 'manual scroll stops at credits during earlier playback too');
  }
  await evaluate(`document.querySelector('.ll-player').dispatchEvent(new WheelEvent('wheel', {deltaY:-200, bubbles:true, cancelable:true}))`);
  await wait(900);
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
  await wait(1500);
  const touchEnd = await endLayout();
  assert.ok(Math.abs(touchEnd.bottom - touchEnd.height * .7) < 2, 'touch drag and inertia respect the credit scroll limit');
  await evaluate(`(() => {
    const data = fixture.fixture();
    data.lines.forEach(line => {line.startMs += 8000; line.endMs += 8000;});
    fixture.setPlaying(false); fixture.setProgress(1000); fixture.view.setLyrics(data);
  })()`);
  await wait(1500);
  await evaluate(`document.querySelector('.ll-player').dispatchEvent(new WheelEvent('wheel', {deltaY:10000, bubbles:true, cancelable:true}))`);
  await wait(1500);
  const introScroll = await endLayout();
  assert.ok(Math.abs(introScroll.bottom - introScroll.height * .7) < 2, 'intro dots are included in the manual end limit');
  await evaluate(`(() => {
    const data = fixture.fixture(); data.lines[0].endMs = 1000; data.lines[1].startMs = 7000;
    fixture.setProgress(2000); fixture.view.setLyrics(data);
  })()`);
  await wait(1500);
  await evaluate(`document.querySelector('.ll-player').dispatchEvent(new WheelEvent('wheel', {deltaY:10000, bubbles:true, cancelable:true}))`);
  await wait(1500);
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
  let previousArtworkSize = null;
  for (const [width, height] of [[400,800], [1119,800], [1120,800], [1500,800], [2200,800],
    [1438,882], [2116,1242], [3398,1962]]) {
    await command('Emulation.setDeviceMetricsOverride', { width: width + 48, height: height + 64, deviceScaleFactor: 1, mobile: false });
    await evaluate(`fixture.resize(${height})`);
    for (const timing of ['line', 'word', 'none']) {
      await evaluate(`fixture.setProgress(12500); fixture.view.setLyrics(fixture.fixture('${timing}'))`);
      await wait(300);
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
  await send('Browser.setWindowBounds', { windowId, bounds: { width: 2560, height: 1440 } });
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
      await wait(300);
      const size = await evaluate(`(() => {
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
      })()`);
      assert.ok(Math.abs(size.dpr - zoom) < .01, 'native browser zoom is active');
      assert.ok(size.visible && size.fits, `${zoom}x ${timing}: zoom leaves artwork and lyrics readable`);
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
  await evaluate('fixture.resize(800)');
  await command('Emulation.setDeviceMetricsOverride', { width: 1548, height: 964, deviceScaleFactor: 1, mobile: false });
  for (const [label, hidden, expected] of [['Now playing view','false',false], ['Queue','false',true], ['Now playing view','true',true], ['','false',false]]) {
    await evaluate(`document.getElementById('Desktop_PanelContainer_Id').setAttribute('aria-label', '${label}'); document.getElementById('artwork-sidebar').setAttribute('aria-hidden', '${hidden}')`);
    await wait(100);
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
  await evaluate('fixture.resize(470)'); await wait(100);
  assert.equal(await artworkVisible(), false, 'short view hides artwork');
  await evaluate('fixture.resize(800); fixture.view.unmount(); fixture.view.mount()'); await wait(200);
  assert.equal(await artworkVisible(), true, 'observers reconnect after reopening');
  await evaluate(`fixture.view.updateTrack({name:'Missing cover',metadata:{}})`); await wait(100);
  assert.equal(await artworkVisible(), false, 'missing cover restores lyrics-only layout');
  assert.equal(await evaluate("document.querySelectorAll('.ll-track-cover img').length"), 0, 'old cover removed');
  await evaluate("document.getElementById('artwork-sidebar').remove(); document.querySelector('[data-testid=cover-art-button]').remove()");
  await command('Emulation.setDeviceMetricsOverride', { width: 1148, height: 964, deviceScaleFactor: 1, mobile: false });
  await evaluate('fixture.resize(800)');
  for (const mode of ['?modern', '?legacy', '?detached']) {
    await command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/app${mode}` });
    await wait(600);
    if (mode === '?detached') {
      assert.equal(await evaluate("document.querySelectorAll('.ll-toggle').length"), 0, 'fallback starts detached');
      await evaluate('appFixture.mountControls()');
      await wait(100);
    }
    assert.equal(await evaluate("document.querySelectorAll('.ll-toggle').length"), 1, `${mode}: one visible button`);
    assert.equal(await evaluate("document.querySelector('.ll-toggle').getAttribute('aria-pressed')"), 'true', 'initial active state');
    assert.equal(await evaluate("document.querySelector('.ll-toggle').dataset.tooltip"), 'Liquid Lyrics', 'tooltip retained');
    assert.equal(await evaluate("document.querySelector('.ll-toggle').getBoundingClientRect().width"), 32, 'button has visible bounds');
    await evaluate("document.querySelector('.ll-toggle').click()");
    assert.equal(await evaluate('appFixture.history.location.pathname'), '/', 'button closes lyric route');
    await evaluate('appFixture.mountControls()');
    await wait(100);
    assert.equal(await evaluate("document.querySelectorAll('.ll-toggle').length"), 1, 'controls replacement restores one button');
    assert.equal(await evaluate("document.querySelector('.ll-toggle').getAttribute('aria-pressed')"), 'false', 'replacement preserves inactive state');
    assert.equal(await evaluate("document.querySelectorAll('[data-testid=control-button-queue]').length"), 1, 'native queue control preserved');
    await evaluate("document.querySelector('.ll-toggle').click()");
    assert.equal(await evaluate('appFixture.history.location.pathname'), '/liquid-lyrics', 'remounted button opens view');
    await evaluate("appFixture.mountControls('alternate')");
    await wait(100);
    assert.equal(await evaluate("document.querySelectorAll('.ll-toggle').length"), 1, 'mounts beside miniplayer if lyrics control is absent');
    await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', {key:'l',ctrlKey:true,altKey:true}))");
    assert.equal(await evaluate('appFixture.history.location.pathname'), '/', 'keyboard shortcut still closes view');
  }
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
  await command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/app?credits` });
  async function until(expression) {
    for (let count = 0; count < 100; count++) {
      if (await evaluate(expression)) return;
      await wait(50);
    }
    throw new Error(`Timed out: ${expression}`);
  }
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
  assert.equal(errors.length, 0, 'no runtime exceptions');
  for (const report of reports) {
    assert.ok(report.player.left >= report.host.left && report.player.right <= report.host.right, 'player inside host');
    for (const line of report.lines) {
      assert.ok(line.textLeft >= report.player.left - 1 && line.textRight <= report.player.right + 1,
        `${report.width}px ${report.timing}: text clipped: ${line.text}`);
    }
  }
  console.log('Browser checks passed: lyric wrapping, backing vocals, seeking, credit scroll/blur, artwork sizing and NPV/Queue switching, same-cover metadata, long metadata, missing artwork, remount, reduced motion, Playbar/Topbar, route state, Escape and writer credits.');
} finally {
  await send('Browser.close').catch(() => {});
  socket.close();
  chrome.kill();
  server.close();
}
