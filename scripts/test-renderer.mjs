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
