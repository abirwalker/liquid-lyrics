import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const allowedOrigins = new Set(['https://xpui.app.spotify.com', 'https://open.spotify.com']);
const upstream = 'https://lyrics-api.boidu.dev/getLyrics';

export function createRelay({ request = fetch, timeoutMs = 10000 } = {}) {
  return createServer(async (req, res) => {
    const origin = req.headers.origin;
    res.setHeader('Vary', 'Origin');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    const fail = (status, error) => {
      res.writeHead(status);
      res.end(JSON.stringify({ error }));
    };
    if (req.headers.host !== `127.0.0.1:${req.socket.localPort}`) return fail(403, 'Invalid host');
    if (origin && !allowedOrigins.has(origin)) return fail(403, 'Origin not allowed');
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    if (req.method === 'OPTIONS') {
      if (req.headers['access-control-request-method'] !== 'GET' || req.headers['access-control-request-headers']) {
        return fail(403, 'Preflight not allowed');
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      res.writeHead(204);
      return res.end();
    }
    if (req.method !== 'GET') return fail(405, 'GET required');
    if (!req.url || req.url.length > 4096) return fail(400, 'Invalid URL');
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/getLyrics') return fail(404, 'Not found');
    const params = new URLSearchParams();
    for (const [key, value] of url.searchParams) {
      if (!['s', 'a', 'al', 'd'].includes(key) || params.has(key) || !value.trim() || value.length > 512) {
        return fail(400, 'Invalid query');
      }
      params.set(key, value.trim());
    }
    if (!params.has('s') || !params.has('a')) return fail(400, 'Song and artist required');
    if (params.has('d') && !/^\d{1,6}$/.test(params.get('d'))) return fail(400, 'Invalid duration');
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    try {
      const response = await request(`${upstream}?${params}`, {
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]),
      });
      const body = await response.json();
      if (res.destroyed) return;
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter) res.setHeader('Retry-After', retryAfter);
      res.writeHead(response.status);
      res.end(JSON.stringify(body));
    } catch (error) {
      if (!res.destroyed) fail(error?.name === 'TimeoutError' ? 504 : 502, 'Lyrics upstream unavailable');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createRelay();
  server.on('error', error => {
    console.error(error.message);
    process.exitCode = 1;
  });
  server.listen(17381, '127.0.0.1', () => console.log('BetterLyrics relay: http://127.0.0.1:17381'));
}
