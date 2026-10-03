'use strict';

// trak-mapas — servicio de recorte de zonas .pmtiles para RudaTrak.
//
// Recibe un bbox + rango de zoom, estima el tamaño con `pmtiles extract --dry-run`
// y lanza extracciones asíncronas (una a la vez) sobre el archivo base de Argentina.
// Sin dependencias npm: usa los módulos nativos de Node (http, child_process, crypto, fs).

const http = require('http');
const { spawn } = require('child_process');
const { randomUUID, createHash } = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const send = require('send');

// ---------------------------------------------------------------------------
// Configuración (variables de entorno)
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3006', 10);
const PMTILES_BIN = process.env.PMTILES_BIN || 'pmtiles';
const BASE_PMTILES = process.env.BASE_PMTILES || '/data/maps/base.pmtiles';
const OUTPUT_DIR = process.env.OUTPUT_DIR || '/data/output';
const TRACCAR_URL = (process.env.TRACCAR_URL || 'http://rudatrak:8082').replace(/\/+$/, '');
const TOKEN_CACHE_TTL_MS = parseInt(process.env.TOKEN_CACHE_TTL_MS || '300000', 10);
const MAX_ZONE_BYTES = parseInt(process.env.MAX_ZONE_BYTES || String(300 * 1024 * 1024), 10);
const JOB_TIMEOUT_MS = parseInt(process.env.JOB_TIMEOUT_MS || '1800000', 10);
const ESTIMATE_TIMEOUT_MS = parseInt(process.env.ESTIMATE_TIMEOUT_MS || '60000', 10);
const CLEANUP_INTERVAL_MS = parseInt(process.env.CLEANUP_INTERVAL_MS || '600000', 10);
const OUTPUT_RETENTION_MS = parseInt(process.env.OUTPUT_RETENTION_MS || '3600000', 10);
const MIN_ZOOM = 0;
const MAX_ZOOM = 14;
const AUTH_TIMEOUT_MS = parseInt(process.env.AUTH_TIMEOUT_MS || '5000', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const RATE_LIMIT_ESTIMATE = parseInt(process.env.RATE_LIMIT_ESTIMATE || '30', 10);
const RATE_LIMIT_EXTRACT = parseInt(process.env.RATE_LIMIT_EXTRACT || '5', 10);
const RATE_LIMIT_TILES = parseInt(process.env.RATE_LIMIT_TILES || '1000', 10);
const RETRY_AFTER_SECONDS = parseInt(process.env.RETRY_AFTER_SECONDS || '15', 10);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Estado en memoria
// ---------------------------------------------------------------------------
const jobs = new Map();       // jobId -> job
let activeExtract = null;     // jobId del extract en curso
const tokenCache = new Map(); // token -> { valid, userId, unavailable, at }
const rateLimiters = new Map(); // userKey -> { windowStart, count }

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
function log(...args) {
  // Nunca se loguean tokens: solo se llama con datos seguros (jobId, bbox, estado).
  console.log(new Date().toISOString(), ...args);
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 65536) {
        reject(new Error('cuerpo demasiado grande'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

function humanSizeToBytes(value, unit) {
  const v = parseFloat(value);
  if (!Number.isFinite(v)) return null;
  const mult = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15 }[unit.trim().toUpperCase()];
  if (!mult) return null;
  return Math.round(v * mult);
}

// Clave de rate limit: el userId de Traccar, o un hash del token como fallback
// (nunca se guarda ni se loguea el token crudo).
function userKey(user) {
  if (user.id != null) return `u${user.id}`;
  return 't' + createHash('sha256').update(user.token).digest('hex');
}

// IP del cliente para el rate limit por IP. Detrás de NPM el socket ve la IP del
// proxy, así que se usa X-Forwarded-For (primer valor) con fallback al socket.
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) {
    return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

// Rate limit por ventana fija (fixed window). Devuelve 0 si está permitido, o
// los segundos que faltan para reintentar si se excedió el límite.
function checkRateLimit(key, limit) {
  const now = Date.now();
  let entry = rateLimiters.get(key);
  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    entry = { windowStart: now, count: 0 };
    rateLimiters.set(key, entry);
  }
  entry.count += 1;
  if (entry.count <= limit) return 0;
  return Math.ceil((entry.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000);
}

function sendRateLimited(res, message, retryAfter) {
  const body = JSON.stringify({ ok: false, error: message, retryAfter });
  res.writeHead(429, {
    'Content-Type': 'application/json; charset=utf-8',
    'Retry-After': String(retryAfter),
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Autenticación contra Traccar
// ---------------------------------------------------------------------------
async function validateToken(token) {
  const cached = tokenCache.get(token);
  if (cached && Date.now() - cached.at < TOKEN_CACHE_TTL_MS) {
    return cached;
  }
  let res;
  try {
    res = await fetch(`${TRACCAR_URL}/api/session?token=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
  } catch {
    // Traccar caído o lento: fallar cerrado, sin cachear (transitorio).
    log('auth: traccar inalcanzable o timeout');
    return { valid: false, userId: null, unavailable: true };
  }
  if (res.ok) {
    const user = await res.json().catch(() => ({}));
    const result = { valid: true, userId: user.id ?? null, unavailable: false };
    tokenCache.set(token, { ...result, at: Date.now() });
    return result;
  }
  if (res.status === 401 || res.status === 400) {
    // Token inválido/revocado (401) o malformado (400): definitivo, cacheable.
    const result = { valid: false, userId: null, unavailable: false };
    tokenCache.set(token, { ...result, at: Date.now() });
    return result;
  }
  // Cualquier otra respuesta (5xx, etc.): Traccar con problemas, no cachear.
  log('auth: traccar respondió', res.status);
  return { valid: false, userId: null, unavailable: true };
}

async function requireAuth(req, res) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    sendJson(res, 401, { ok: false, error: 'Token requerido' });
    return null;
  }
  const result = await validateToken(token);
  if (result.valid) {
    return { id: result.userId, token };
  }
  if (result.unavailable) {
    sendJson(res, 503, { ok: false, error: 'Servicio de autenticación no disponible' });
  } else {
    sendJson(res, 401, { ok: false, error: 'Token inválido' });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Validación de la zona
// ---------------------------------------------------------------------------
function parseZone(body) {
  const errors = [];
  const field = (name, min, max, integer) => {
    const raw = body && body[name];
    const n = typeof raw === 'number' ? raw : parseFloat(raw);
    if (raw === undefined || raw === null || raw === '' || !Number.isFinite(n)) {
      errors.push(`${name} es obligatorio y debe ser numérico`);
      return NaN;
    }
    if (n < min || n > max) errors.push(`${name} debe estar entre ${min} y ${max}`);
    if (integer && !Number.isInteger(n)) errors.push(`${name} debe ser entero`);
    return n;
  };

  const minLng = field('minLng', -180, 180, false);
  const minLat = field('minLat', -90, 90, false);
  const maxLng = field('maxLng', -180, 180, false);
  const maxLat = field('maxLat', -90, 90, false);
  const minZoom = field('minZoom', MIN_ZOOM, MAX_ZOOM, true);
  const maxZoom = field('maxZoom', MIN_ZOOM, MAX_ZOOM, true);

  if (errors.length === 0) {
    if (minLng >= maxLng) errors.push('minLng debe ser menor que maxLng');
    if (minLat >= maxLat) errors.push('minLat debe ser menor que maxLat');
    if (minZoom > maxZoom) errors.push('minZoom debe ser menor o igual que maxZoom');
  }

  if (errors.length) return { errors };
  return { minLng, minLat, maxLng, maxLat, minZoom, maxZoom, errors: [] };
}

async function readZone(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { ok: false, error: 'Cuerpo JSON inválido' });
    return null;
  }
  const zone = parseZone(body);
  if (zone.errors.length) {
    sendJson(res, 400, { ok: false, errors: zone.errors });
    return null;
  }
  return zone;
}

// ---------------------------------------------------------------------------
// Ejecución de pmtiles
// ---------------------------------------------------------------------------
function extractArgs(zone, outputFile, dryRun) {
  const args = ['extract', BASE_PMTILES, outputFile];
  // Se usa la forma --flag=valor porque el bbox empieza con un número negativo y
  // kong lo interpretaría como flag si fuera un argumento separado.
  args.push(`--bbox=${zone.minLng},${zone.minLat},${zone.maxLng},${zone.maxLat}`);
  args.push(`--minzoom=${zone.minZoom}`);
  args.push(`--maxzoom=${zone.maxZoom}`);
  if (dryRun) args.push('--dry-run');
  return args;
}

function runPmtiles(args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      // Se usa un arreglo de argumentos (nunca shell): no hay inyección de comandos.
      child = spawn(PMTILES_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, code: null, stdout: '', stderr: String(err.message), timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: String(err.message), timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr, timedOut: false });
    });
  });
}

function parseDryRun(stdout) {
  const tilesMatch = stdout.match(/result tile entries (\d+)/);
  const sizeMatch = stdout.match(/archive size of ([0-9.]+)\s*([A-Za-z]+)/);
  return {
    tiles: tilesMatch ? parseInt(tilesMatch[1], 10) : null,
    bytes: sizeMatch ? humanSizeToBytes(sizeMatch[1], sizeMatch[2]) : null,
  };
}

async function estimateZone(zone) {
  const dummy = path.join(OUTPUT_DIR, '.dryrun');
  const result = await runPmtiles(extractArgs(zone, dummy, true), ESTIMATE_TIMEOUT_MS);
  if (!result.ok) return null;
  // go-pmtiles loguea a stderr (log de Go), no a stdout: se parsean ambos streams.
  const { tiles, bytes } = parseDryRun(result.stdout + '\n' + result.stderr);
  if (tiles === null || bytes === null) return null;
  return { tiles, bytes };
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------
function createJob(zone, userId) {
  const id = randomUUID();
  const job = {
    id,
    userId,
    status: 'pending',
    minLng: zone.minLng,
    minLat: zone.minLat,
    maxLng: zone.maxLng,
    maxLat: zone.maxLat,
    minZoom: zone.minZoom,
    maxZoom: zone.maxZoom,
    tiles: null,
    bytes: null,
    outputFile: path.join(OUTPUT_DIR, `${id}.pmtiles`),
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    error: null,
  };
  jobs.set(id, job);
  return job;
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    minLng: job.minLng,
    minLat: job.minLat,
    maxLng: job.maxLng,
    maxLat: job.maxLat,
    minZoom: job.minZoom,
    maxZoom: job.maxZoom,
    tiles: job.tiles,
    bytes: job.bytes,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
  };
}

async function runExtract(job) {
  log('extract:inicio', job.id, `bbox=${job.minLng},${job.minLat},${job.maxLng},${job.maxLat}`, `zoom=${job.minZoom}-${job.maxZoom}`);
  try {
    const result = await runPmtiles(extractArgs(job, job.outputFile, false), JOB_TIMEOUT_MS);
    if (result.timedOut) {
      job.status = 'failed';
      job.error = 'timeout';
    } else if (!result.ok) {
      job.status = 'failed';
      job.error = (result.stderr || `exit ${result.code}`).slice(0, 500);
    } else {
      job.status = 'done';
    }
  } catch (err) {
    job.status = 'failed';
    job.error = String((err && err.message) || err).slice(0, 500);
  } finally {
    job.finishedAt = Date.now();
    if (activeExtract === job.id) activeExtract = null;
    log('extract:fin', job.id, job.status);
  }
}

// ---------------------------------------------------------------------------
// Limpieza de temporales
// ---------------------------------------------------------------------------
async function cleanup(removeAll) {
  try {
    const files = await fsp.readdir(OUTPUT_DIR);
    const now = Date.now();
    for (const name of files) {
      const p = path.join(OUTPUT_DIR, name);
      const st = await fsp.stat(p).catch(() => null);
      if (!st) continue;
      if (removeAll || now - st.mtimeMs > OUTPUT_RETENTION_MS) {
        await fsp.unlink(p).catch(() => {});
      }
    }
  } catch {
    // OUTPUT_DIR puede no existir todavía; se ignora.
  }
  for (const [id, job] of jobs) {
    if (job.finishedAt && Date.now() - job.finishedAt > OUTPUT_RETENTION_MS) {
      jobs.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Handlers de rutas
// ---------------------------------------------------------------------------
async function handleEstimate(req, res, user) {
  const retryAfter = checkRateLimit(userKey(user) + ':estimate', RATE_LIMIT_ESTIMATE);
  if (retryAfter) {
    return sendRateLimited(res, 'Demasiados pedidos de estimación', retryAfter);
  }
  const zone = await readZone(req, res);
  if (!zone) return;
  const est = await estimateZone(zone);
  if (!est) {
    return sendJson(res, 500, { ok: false, error: 'Error al estimar la zona' });
  }
  if (est.bytes > MAX_ZONE_BYTES) {
    return sendJson(res, 413, {
      ok: false, error: 'La zona excede el límite de tamaño',
      bytes: est.bytes, maxBytes: MAX_ZONE_BYTES, tiles: est.tiles,
    });
  }
  sendJson(res, 200, {
    ok: true, tiles: est.tiles, bytes: est.bytes, maxBytes: MAX_ZONE_BYTES,
    minLng: zone.minLng, minLat: zone.minLat, maxLng: zone.maxLng, maxLat: zone.maxLat,
    minZoom: zone.minZoom, maxZoom: zone.maxZoom,
  });
}

async function handleExtract(req, res, user) {
  const retryAfter = checkRateLimit(userKey(user) + ':extract', RATE_LIMIT_EXTRACT);
  if (retryAfter) {
    return sendRateLimited(res, 'Demasiados pedidos de extracción', retryAfter);
  }
  const zone = await readZone(req, res);
  if (!zone) return;

  if (activeExtract) {
    return sendRateLimited(res, 'Ya hay una extracción en curso', RETRY_AFTER_SECONDS);
  }

  // Pre-flight: estimar para aplicar el tope de tamaño antes de encolar.
  const est = await estimateZone(zone);
  if (!est) {
    return sendJson(res, 500, { ok: false, error: 'Error al estimar la zona' });
  }
  if (est.bytes > MAX_ZONE_BYTES) {
    return sendJson(res, 413, {
      ok: false, error: 'La zona excede el límite de tamaño',
      bytes: est.bytes, maxBytes: MAX_ZONE_BYTES, tiles: est.tiles,
    });
  }

  const job = createJob(zone, user.id);
  job.tiles = est.tiles;
  job.bytes = est.bytes;
  job.status = 'running';
  job.startedAt = Date.now();
  activeExtract = job.id;
  runExtract(job); // en segundo plano; no se espera.

  sendJson(res, 202, { ok: true, jobId: job.id, tiles: est.tiles, bytes: est.bytes });
}

async function handleJob(req, res, user) {
  const id = req.pathParams.id || '';
  if (!UUID_RE.test(id)) {
    return sendJson(res, 404, { ok: false, error: 'Job no encontrado' });
  }
  const job = jobs.get(id);
  if (!job || job.userId !== user.id) {
    return sendJson(res, 404, { ok: false, error: 'Job no encontrado' });
  }
  sendJson(res, 200, { ok: true, job: publicJob(job) });
}

async function handleDownload(req, res, user) {
  const id = req.pathParams.id || '';
  if (!UUID_RE.test(id)) {
    return sendJson(res, 404, { ok: false, error: 'Job no encontrado' });
  }
  const job = jobs.get(id);
  if (!job || job.userId !== user.id) {
    return sendJson(res, 404, { ok: false, error: 'Job no encontrado' });
  }
  if (job.status !== 'done') {
    const code = job.status === 'failed' ? 410 : 409;
    return sendJson(res, code, { ok: false, error: `La zona no está lista (estado: ${job.status})` });
  }
  const stat = await fsp.stat(job.outputFile).catch(() => null);
  if (!stat) {
    return sendJson(res, 404, { ok: false, error: 'Archivo no encontrado' });
  }
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${id}.pmtiles"`,
  });
  fs.createReadStream(job.outputFile).pipe(res);
}

// Sirve el archivo base .pmtiles por rangos HTTP (mapa vectorial online). La ruta
// es fija (BASE_PMTILES): ningún input del cliente entra en el path del archivo.
// El streaming y el soporte de Range/If-Range/ETag/416 los maneja la librería `send`
// (mismo motor que res.sendFile de Express); aquí solo se agrega el rate limit por IP
// (la autenticación ya corrió en el router, antes de abrir el archivo).
async function handleBase(req, res) {
  const retryAfter = checkRateLimit(`ip:${clientIp(req)}`, RATE_LIMIT_TILES);
  if (retryAfter) {
    return sendRateLimited(res, 'Demasiados pedidos de tiles', retryAfter);
  }
  const stream = send(req, path.basename(BASE_PMTILES), {
    root: path.dirname(BASE_PMTILES),
    index: false,
    dotfiles: 'deny',
    acceptRanges: true,
    etag: true,
  });
  stream.on('error', (err) => {
    // Cliente que cortó la conexión a mitad del stream: headers ya enviados, no hay
    // nada que responder, solo se cierra.
    if (res.headersSent) {
      res.end();
      return;
    }
    const status = err.status || err.statusCode || 500;
    // Preserva los headers que la librería adjuntó al error (ej. Content-Range en 416).
    if (err.headers) {
      for (const [name, value] of Object.entries(err.headers)) {
        res.setHeader(name, value);
      }
    }
    const message = status === 404 ? 'Mapa base no disponible' : 'Error al servir el mapa';
    sendJson(res, status, { ok: false, error: message });
  });
  stream.pipe(res);
}

// ---------------------------------------------------------------------------
// Servidor HTTP
// ---------------------------------------------------------------------------
const ROUTES = [
  ['POST', '/maps/zone/estimate', handleEstimate],
  ['POST', '/maps/zone/extract', handleExtract],
  ['GET', '/maps/zone/job/', handleJob],
  ['GET', '/maps/zone/download/', handleDownload],
  ['GET', '/maps/base', handleBase],
  ['HEAD', '/maps/base', handleBase],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, { ok: true });
  }

  let matched = null;
  for (const [method, prefix, handler] of ROUTES) {
    if (req.method !== method) continue;
    if (prefix.endsWith('/')) {
      if (pathname.startsWith(prefix)) {
        matched = { handler, id: pathname.slice(prefix.length) };
        break;
      }
    } else if (pathname === prefix) {
      matched = { handler, id: null };
      break;
    }
  }
  if (!matched) {
    return sendJson(res, 404, { ok: false, error: 'No encontrado' });
  }

  try {
    const user = await requireAuth(req, res);
    if (!user) return; // requireAuth ya respondió 401
    req.pathParams = { id: matched.id };
    await matched.handler(req, res, user);
  } catch (err) {
    log('error:', (err && err.message) || err);
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: 'Error interno' });
    } else {
      res.end();
    }
  }
});

async function start() {
  await fsp.mkdir(OUTPUT_DIR, { recursive: true });
  await cleanup(true); // borrar huérfanos de un arranque anterior
  setInterval(() => cleanup(false), CLEANUP_INTERVAL_MS);
  server.listen(PORT, () => {
    log('trak-mapas escuchando en :' + PORT);
    log(`base=${BASE_PMTILES} traccar=${TRACCAR_URL} maxBytes=${MAX_ZONE_BYTES}`);
  });
}

start().catch((err) => {
  console.error('Error al iniciar:', err);
  process.exit(1);
});
