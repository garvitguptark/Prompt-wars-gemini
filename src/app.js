// The HTTP layer, on node:http with no framework: four JSON routes, the static page, security headers on every
// response and per-IP rate limits on the routes that cost money upstream.
import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { gzipSync, brotliCompressSync, constants as zlib } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readCityQuery, readPlace, readProfile, readQuestion, InputError } from './profile.js';
import { log as defaultLog } from './log.js';

export const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'self'", "script-src 'self'", "style-src 'self' https://fonts.googleapis.com", 'font-src https://fonts.gstatic.com',
    "img-src 'self' data:", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ].join('; '),
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'geolocation=(self), camera=(), microphone=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
};
const MAX_BODY = 16 * 1024;

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

/**
 * Fixed-window counter per key. Returns 0 when the call is allowed, else the seconds until the window resets.
 * ponytail: memory of one instance; put Cloud Armor rate limiting in front if abuse ever spans instances.
 */
export function rateLimiter(max, windowMs, now = Date.now) {
  const hits = new Map();
  return (key) => {
    const t = now();
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
    let entry = hits.get(key);
    if (!entry || entry.reset <= t) hits.set(key, (entry = { count: 0, reset: t + windowMs }));
    entry.count += 1;
    return entry.count > max ? Math.ceil((entry.reset - t) / 1000) : 0;
  };
}

/** Cloud Run's front end appends the caller's address last; anything before it was sent by the client and can be faked. */
export const clientIp = (req) => req.headers['x-forwarded-for']?.split(',').at(-1).trim() || req.socket.remoteAddress || 'unknown';

/** Every file in `dir`, read once and pre-compressed, so serving one is a Map lookup (and no path ever touches the disk). */
export function loadStatic(dir) {
  const files = new Map();
  for (const name of readdirSync(dir)) {
    const type = TYPES[extname(name)];
    if (!type) continue;
    const body = readFileSync(join(dir, name));
    files.set(`/${name}`, {
      type,
      body,
      gzip: gzipSync(body, { level: 9 }),
      br: brotliCompressSync(body, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11 } }),
      etag: `"${createHash('sha256').update(body).digest('base64url').slice(0, 22)}"`,
      cache: type.startsWith('text/html') ? 'no-cache' : 'public, max-age=3600',
    });
  }
  if (files.has('/index.html')) files.set('/', files.get('/index.html'));
  return files;
}

async function readJson(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Send JSON with Content-Type: application/json.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body && typeof body === 'object') return body;
  } catch { /* fall through */ }
  throw new InputError('Request body must be a JSON object.');
}

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(json) });
  res.end(json);
}

function sendFile(req, res, file) {
  const headers = { 'content-type': file.type, etag: file.etag, 'cache-control': file.cache, vary: 'accept-encoding' };
  if (req.headers['if-none-match'] === file.etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  const accepts = req.headers['accept-encoding'] ?? '';
  const [body, encoding] = /\bbr\b/.test(accepts) ? [file.br, 'br'] : /\bgzip\b/.test(accepts) ? [file.gzip, 'gzip'] : [file.body];
  if (encoding) headers['content-encoding'] = encoding;
  res.writeHead(200, { ...headers, 'content-length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/**
 * @param {object} deps
 * @param {{ lookup: Function, geocode: Function }} deps.air
 * @param {{ plan: Function, ask: Function }} deps.planner
 * @param {string} deps.publicDir  folder of static files
 */
export function createApp({ air, planner, publicDir, log = defaultLog, limits = { air: [60, 600_000], ai: [20, 600_000] } }) {
  const files = loadStatic(publicDir);
  const limit = { air: rateLimiter(...limits.air), ai: rateLimiter(...limits.ai) };

  const routes = {
    'GET /health': { run: async () => ({ status: 'ok' }) },
    'GET /api/air': {
      group: 'air',
      async run(req, url) {
        const q = url.searchParams.get('q');
        const p = url.searchParams;
        const place = q ? await air.geocode(readCityQuery(q)) : readPlace({ lat: p.get('lat'), lon: p.get('lon'), tz: p.get('tz'), name: 'your location' });
        return { place, air: await air.lookup(place) };
      },
    },
    'POST /api/plan': {
      group: 'ai',
      async run(req) {
        const body = await readJson(req);
        const place = readPlace(body.place);
        return { place, ...(await planner.plan(place, readProfile(body.profile))) };
      },
    },
    'POST /api/ask': {
      group: 'ai',
      async run(req) {
        const body = await readJson(req);
        return planner.ask(readPlace(body.place), readProfile(body.profile), readQuestion(body.question));
      },
    },
  };
  const methodsFor = (path) => Object.keys(routes).filter((r) => r.endsWith(` ${path}`)).map((r) => r.split(' ')[0]);

  return async function handle(req, res) {
    const started = performance.now();
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      url = new URL('http://localhost/');
    }
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    const route = routes[`${req.method} ${url.pathname}`];
    try {
      if (route) {
        const wait = route.group ? limit[route.group](clientIp(req)) : 0;
        if (wait) throw new HttpError(429, 'Too many requests. Please wait a few minutes and try again.', { 'retry-after': String(wait) });
        sendJson(res, 200, await route.run(req, url));
      } else if ((req.method === 'GET' || req.method === 'HEAD') && files.has(url.pathname)) {
        sendFile(req, res, files.get(url.pathname));
      } else if (methodsFor(url.pathname).length) {
        throw new HttpError(405, 'Method not allowed.', { allow: methodsFor(url.pathname).join(', ') });
      } else {
        throw new HttpError(404, 'Not found.');
      }
    } catch (err) {
      const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
      if (status >= 500) log('ERROR', err.message, { detail: err.detail, stack: status === 500 ? err.stack : undefined, path: url.pathname });
      for (const [name, value] of Object.entries(err.headers ?? {})) res.setHeader(name, value);
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Something went wrong on our side. Please try again.' : err.message });
    } finally {
      if (url.pathname.startsWith('/api/')) {
        // Path only: the query can hold a location, which stays out of the logs.
        log('INFO', `${req.method} ${url.pathname} ${res.statusCode}`, {
          httpRequest: { requestMethod: req.method, requestUrl: url.pathname, status: res.statusCode, latency: `${((performance.now() - started) / 1000).toFixed(3)}s` },
        });
      }
    }
  };
}
