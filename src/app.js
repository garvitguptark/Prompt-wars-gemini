// The HTTP layer, on node:http with no framework: four JSON routes, the static page, security headers on every
// response and per-IP rate limits on the routes that cost money upstream.
/** @import { IncomingMessage, ServerResponse } from 'node:http' */
/** @import { AirService, Logger, Planner } from './types.js' */
import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { gzipSync, brotliCompressSync, constants as zlib } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readCityQuery, readPlace, readProfile, readQuestion } from './profile.js';
import { HttpError, InputError } from './errors.js';
import { log as defaultLog } from './log.js';
import { MINUTE_MS } from './util.js';

export const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'geolocation=(self), camera=(), microphone=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

/** @type {Record<string, string>} Content-Type per extension; other files are never served */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};
const MAX_BODY_BYTES = 16 * 1024;

/** Calls allowed per client IP in each window, per route group. The AI routes cost money upstream. */
export const RATE_LIMITS = {
  air: { max: 60, windowMs: 10 * MINUTE_MS },
  ai: { max: 20, windowMs: 10 * MINUTE_MS },
};
/** Expired rate-limit entries are swept once this many clients are being tracked. */
const RATE_LIMIT_SWEEP_SIZE = 10_000;

/**
 * Fixed-window counter per key. Returns 0 when the call is allowed, else the seconds until the window resets.
 * ponytail: memory of one instance; put Cloud Armor rate limiting in front if abuse ever spans instances.
 * @param {number} max  calls allowed per window
 * @param {number} windowMs
 * @param {() => number} [now]
 * @returns {(key: string) => number}
 */
export function rateLimiter(max, windowMs, now = Date.now) {
  /** @type {Map<string, { count: number, reset: number }>} */
  const hits = new Map();
  return function check(key) {
    const time = now();
    if (hits.size > RATE_LIMIT_SWEEP_SIZE) {
      for (const [tracked, entry] of hits) if (entry.reset <= time) hits.delete(tracked);
    }
    let entry = hits.get(key);
    if (!entry || entry.reset <= time) {
      entry = { count: 0, reset: time + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    return entry.count > max ? Math.ceil((entry.reset - time) / 1000) : 0;
  };
}

/**
 * A static file, read once at start-up and pre-compressed.
 * @typedef {object} StaticFile
 * @property {string} type  Content-Type
 * @property {Buffer} body
 * @property {Buffer} gzip
 * @property {Buffer} br
 * @property {string} etag
 * @property {string} cache  Cache-Control
 */

/**
 * A JSON route. `group` names the rate limit it counts against.
 * @typedef {object} Route
 * @property {keyof typeof RATE_LIMITS} [group]
 * @property {(req: IncomingMessage, url: URL) => Promise<unknown>} run
 */

/**
 * The caller's IP. Cloud Run's front end appends the caller's address last; anything before it was sent by the
 * client and can be faked.
 * @param {Pick<IncomingMessage, 'headers' | 'socket'>} req
 */
export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const chain = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  return chain?.split(',').at(-1)?.trim() || req.socket.remoteAddress || 'unknown';
}

/**
 * Every file in `dir`, read once and pre-compressed, so serving one is a Map lookup (and no path ever touches the disk).
 * @param {string} dir
 * @returns {Map<string, StaticFile>}  by URL path
 */
export function loadStatic(dir) {
  /** @type {Map<string, StaticFile>} */
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
  const index = files.get('/index.html');
  if (index) files.set('/', index);
  return files;
}

/**
 * The request body as a JSON object, read with a size cap.
 * @param {IncomingMessage} req
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJson(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'Send JSON with Content-Type: application/json.');
  }
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body && typeof body === 'object') return body;
  } catch {
    /* fall through */
  }
  throw new InputError('Request body must be a JSON object.');
}

/**
 * @param {ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(json),
  });
  res.end(json);
}

/**
 * The smallest copy of a file the client accepts: brotli, then gzip, then the file as it is.
 * @param {StaticFile} file
 * @param {string} acceptEncoding  the request's Accept-Encoding header
 * @returns {{ body: Buffer, encoding?: string }}
 */
function pickEncoding(file, acceptEncoding) {
  if (/\bbr\b/.test(acceptEncoding)) return { body: file.br, encoding: 'br' };
  if (/\bgzip\b/.test(acceptEncoding)) return { body: file.gzip, encoding: 'gzip' };
  return { body: file.body };
}

/**
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {StaticFile} file
 */
function sendFile(req, res, file) {
  /** @type {Record<string, string | number>} */
  const headers = { 'content-type': file.type, etag: file.etag, 'cache-control': file.cache, vary: 'accept-encoding' };
  if (req.headers['if-none-match'] === file.etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  const { body, encoding } = pickEncoding(file, req.headers['accept-encoding'] ?? '');
  if (encoding) headers['content-encoding'] = encoding;
  res.writeHead(200, { ...headers, 'content-length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/**
 * The JSON routes, keyed by "METHOD /path".
 * @param {{ air: AirService, planner: Planner }} services
 * @returns {Record<string, Route>}
 */
function apiRoutes({ air, planner }) {
  return {
    'GET /health': { run: async () => ({ status: 'ok' }) },
    'GET /api/air': {
      group: 'air',
      async run(_req, url) {
        const params = url.searchParams;
        const city = params.get('q');
        const place = city
          ? await air.geocode(readCityQuery(city))
          : readPlace({ lat: params.get('lat'), lon: params.get('lon'), tz: params.get('tz'), name: 'your location' });
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
}

/**
 * The request URL, or "/" when it can't be parsed.
 * @param {IncomingMessage} req
 */
function parseUrl(req) {
  try {
    return new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return new URL('http://localhost/');
  }
}

/**
 * Turns any thrown error into a JSON reply. Only 4xx messages, which we wrote, reach the client.
 * @param {ServerResponse} res
 * @param {unknown} err
 * @param {Logger} log
 * @param {string} path
 */
function sendError(res, err, log, path) {
  const { status: given, message, detail, stack, headers = {} } = /** @type {Partial<HttpError>} */ (err ?? {});
  const status = typeof given === 'number' && Number.isInteger(given) && given >= 400 && given < 600 ? given : 500;
  if (status >= 500) log('ERROR', String(message), { detail, stack: status === 500 ? stack : undefined, path });
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  if (res.headersSent) return;
  sendJson(res, status, {
    error: status === 500 ? 'Something went wrong on our side. Please try again.' : message,
  });
}

/**
 * One structured line per API call. Path only: the query can hold a location, which stays out of the logs.
 * @param {Logger} log
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {string} path
 * @param {number} started  performance.now() when the request arrived
 */
function logRequest(log, req, res, path, started) {
  const latency = `${((performance.now() - started) / 1000).toFixed(3)}s`;
  log('INFO', `${req.method} ${path} ${res.statusCode}`, {
    httpRequest: { requestMethod: req.method, requestUrl: path, status: res.statusCode, latency },
  });
}

/**
 * The request handler for the whole app.
 * @param {object} deps
 * @param {AirService} deps.air
 * @param {Planner} deps.planner
 * @param {string} deps.publicDir  folder of static files
 * @param {Logger} [deps.log]
 * @param {typeof RATE_LIMITS} [deps.limits]
 * @returns {(req: IncomingMessage, res: ServerResponse) => Promise<void>}
 */
export function createApp({ air, planner, publicDir, log = defaultLog, limits = RATE_LIMITS }) {
  const files = loadStatic(publicDir);
  const limit = {
    air: rateLimiter(limits.air.max, limits.air.windowMs),
    ai: rateLimiter(limits.ai.max, limits.ai.windowMs),
  };
  const routes = apiRoutes({ air, planner });
  /** @param {string} path  the methods some route answers on this path, for a 405's Allow header */
  const methodsFor = (path) =>
    Object.keys(routes)
      .filter((key) => key.endsWith(` ${path}`))
      .map((key) => key.split(' ')[0]);

  /**
   * Runs the matching route or serves the matching file; anything else throws an HttpError.
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @param {URL} url
   */
  async function dispatch(req, res, url) {
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) {
      const wait = route.group ? limit[route.group](clientIp(req)) : 0;
      if (wait) {
        throw new HttpError(429, 'Too many requests. Please wait a few minutes and try again.', {
          headers: { 'retry-after': String(wait) },
        });
      }
      sendJson(res, 200, await route.run(req, url));
      return;
    }
    const file = req.method === 'GET' || req.method === 'HEAD' ? files.get(url.pathname) : undefined;
    if (file) {
      sendFile(req, res, file);
      return;
    }
    const allowed = methodsFor(url.pathname);
    if (allowed.length > 0) throw new HttpError(405, 'Method not allowed.', { headers: { allow: allowed.join(', ') } });
    throw new HttpError(404, 'Not found.');
  }

  return async function handle(req, res) {
    const started = performance.now();
    const url = parseUrl(req);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    try {
      await dispatch(req, res, url);
    } catch (err) {
      sendError(res, err, log, url.pathname);
    } finally {
      if (url.pathname.startsWith('/api/')) logRequest(log, req, res, url.pathname, started);
    }
  };
}
