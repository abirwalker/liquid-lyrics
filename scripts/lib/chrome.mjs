import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const BROWSER_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

export async function findBrowser() {
  const configured = process.env.LYRICS_TEST_BROWSER?.trim();
  if (configured) {
    await access(configured);
    return configured;
  }
  for (const candidate of BROWSER_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error('Set LYRICS_TEST_BROWSER to an installed Chromium or Chrome executable.');
}

export async function launchHeadlessChrome({
  userDataDir,
  url = 'about:blank',
  timeoutMs = process.env.CI ? 45000 : 15000,
}) {
  const executable = await findBrowser();
  const args = [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    '--enable-unsafe-swiftshader',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--metrics-recording-only',
    '--mute-audio',
  ];
  if (process.platform === 'linux') {
    args.push('--use-gl=angle', '--use-angle=swiftshader');
    if (process.env.CI || process.getuid?.() === 0) {
      args.push('--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage');
    }
  }
  args.push(`--user-data-dir=${userDataDir}`, url);

  const spawnOnce = async () => {
    const chrome = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    try {
      const endpoint = await new Promise((resolveEndpoint, reject) => {
        let settled = false;
        let stderr = '';
        const fail = (reason) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const detail = stderr.trim().slice(-1500);
          reject(new Error(detail ? `${reason}\nChrome stderr:\n${detail}` : reason));
        };
        const timer = setTimeout(() => fail('Chrome startup timed out'), timeoutMs);
        chrome.once('error', error => fail(`Failed to spawn browser (${executable}): ${error.message}`));
        chrome.once('exit', (code, signal) => fail(`Chrome exited before DevTools opened (code=${code}, signal=${signal})`));
        chrome.stderr.on('data', chunk => {
          stderr = (stderr + chunk).slice(-4000);
          const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr);
          if (match && !settled) {
            settled = true;
            clearTimeout(timer);
            resolveEndpoint(match[1]);
          }
        });
      });
      return { chrome, endpoint };
    } catch (error) {
      await stopChrome(chrome);
      throw error;
    }
  };

  // A cold CI runner occasionally stalls Chrome's first start; one fresh retry is cheaper than a red PR.
  const maxAttempts = process.env.CI ? 2 : 1;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await spawnOnce();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) console.warn(`Chrome launch attempt ${attempt} failed, retrying: ${error.message.split('\n')[0]}`);
    }
  }
  throw lastError;
}

// Profile reuse (retry) and profile deletion both need the process gone; Windows keeps its files locked until exit.
export async function stopChrome(chrome) {
  if (chrome.pid === undefined || chrome.exitCode !== null || chrome.signalCode !== null) return;
  const exited = once(chrome, 'exit');
  chrome.kill();
  const forceKill = setTimeout(() => chrome.kill('SIGKILL'), 5000);
  await exited;
  clearTimeout(forceKill);
}

// Uncaught assertion text otherwise only lives in the raw job log; an annotation puts it on the PR checks page.
export function annotateFailuresOnCi(title) {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  process.on('uncaughtExceptionMonitor', error => {
    const message = String(error?.stack ?? error).slice(0, 4000)
      .replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
    console.log(`::error title=${title}::${message}`);
  });
}
