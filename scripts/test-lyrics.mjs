import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

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
    const report = { formats: LyricsTests.runChecks(), boundaries: await LyricsTests.runBoundaryChecks() };
    ${fixtureArguments}
    document.body.textContent = JSON.stringify(report);
  } catch (error) { document.body.textContent = JSON.stringify({ error: error.message }); }
})();`;
const page = resolve(outputDirectory, staged ? 'staged.html' : 'source.html');
await writeFile(page, '<!doctype html><body><script>' + script.replace(/<\/script/gi, '<\\/script') + '</script></body>');
const profile = await mkdtemp(resolve(outputDirectory, 'browser-'));
const { stdout } = await promisify(execFile)(browser, [
  '--headless=new', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
  '--virtual-time-budget=10000', '--dump-dom', page,
], { windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
const body = /<body>([\s\S]*?)<\/body>/.exec(stdout)?.[1];
if (!body) throw new Error('Browser did not return test results.');
const report = JSON.parse(body.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
await writeFile(resolve(outputDirectory, staged ? 'staged-result.json' : 'source-result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (report.error) process.exitCode = 1;
