import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import http from 'node:http';

const root = fileURLToPath(new URL('../', import.meta.url));
const staged = process.argv.includes('--staged');
const fixtures = process.argv.includes('--fixtures');
const outputDirectory = resolve(root, 'logs/adapter-tests');
await mkdir(outputDirectory, { recursive: true });
const candidates = [process.env.LYRICS_TEST_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean);
let browser;
for (const candidate of candidates) {
  try { await access(candidate); browser = candidate; break; } catch { continue; }
}
if (!browser) throw new Error('Set LYRICS_TEST_BROWSER to an installed Chromium browser executable.');
const result = await build({ entryPoints: [resolve(root, 'tests/lyrics.ts')], bundle: true, write: false,
  format: 'iife', globalName: 'LyricsTests', platform: 'browser',
  plugins: staged ? [{ name: 'staged-source', setup(builder) {
    builder.onResolve({ filter: /^\.\.\/src\// }, args => ({
      path: resolve(root, 'logs/sandbox/adapter-integration/src', args.path.slice('../src/'.length) + '.ts'),
    }));
  } }] : [],
});
let fixtureArguments = '';
if (fixtures) {
  const ipad = await Promise.all(['binilyrics', 'lrclib'].map(async source =>
    JSON.parse(await readFile(resolve(root, `logs/sandbox/lyrics-adapters/ipad-${source}.json`), 'utf8')).body));
  fixtureArguments = `report.ipad = LyricsTests.runIpadChecks(...${JSON.stringify(ipad)});`;
}
const script = result.outputFiles[0].text + `
(async () => {
  try {
    await new Promise((resolveDb, rejectDb) => {
      const request = indexedDB.open('liquid-lyrics-cache', 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('lyrics', { keyPath: 'key' });
        store.createIndex('cachedAt', 'cachedAt', { unique: false });
      };
      request.onsuccess = () => { request.result.close(); resolveDb(); };
      request.onerror = () => rejectDb(request.error);
    });
    const report = { formats: LyricsTests.runChecks(), boundaries: await LyricsTests.runBoundaryChecks() };
    ${fixtureArguments}
    document.body.textContent = JSON.stringify(report);
  } catch (error) { document.body.textContent = JSON.stringify({ error: error.message }); }
})();`;
const page = resolve(outputDirectory, staged ? 'staged.html' : 'source.html');
await writeFile(page, '<!doctype html><html><head><meta charset="utf-8"></head><body><script>' + script.replace(/<\/script/gi, '<\\/script') + '</script></body></html>');
const profile = await mkdtemp(resolve(outputDirectory, 'browser-'));
const server = http.createServer(async (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(await readFile(page));
});
await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
const chrome = spawn(browser, ['--headless=new', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'],
{ windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
let report;
try {
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Chrome startup timed out')), 15000);
    chrome.once('error', error => { clearTimeout(timer); reject(error); });
    chrome.stderr.on('data', chunk => {
      output += chunk;
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(output);
      if (match) { clearTimeout(timer); resolveEndpoint(match[1]); }
    });
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') console.error(message.params.args);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolveRequest, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} timed out`)); }, 15000);
    pending.set(requestId, { resolve: resolveRequest, reject, timer });
    socket.send(JSON.stringify({ id: requestId, method, params, sessionId }));
  });
  const address = server.address();
  const { targetId } = await send('Target.createTarget', { url: `http://127.0.0.1:${address.port}` });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const evaluated = await send('Runtime.evaluate', { expression: 'document.body?.textContent', returnByValue: true }, sessionId);
    const body = evaluated.result.value;
    if (typeof body === 'string' && body.trim().startsWith('{')) { report = JSON.parse(body); break; }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  if (!report) throw new Error('Browser did not return test results.');
} finally {
  socket?.close();
  chrome.kill();
  server.close();
}
await writeFile(resolve(outputDirectory, staged ? 'staged-result.json' : 'source-result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (report.error) process.exitCode = 1;
