'use strict';

// trak-mapas — servicio de recorte de zonas .pmtiles para RudaTrak.
//
// Recibe un bbox + rango de zoom, estima el tamaño con `pmtiles extract --dry-run`
// y lanza extracciones asíncronas (una a la vez) sobre el archivo base de Sudamérica continental.
// Usa módulos nativos de Node (http, child_process, crypto, fs) más la librería
// `send` (solo para el streaming de /maps/base: maneja Range/ETag/limpieza probadas).

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
// Tope de zoom de las extracciones, configurable por entorno. El build Protomaps
// vigente es z15; bajar MAX_ZOOM a 14 permite volver atrás sin tocar el código.
const MAX_ZOOM = parseInt(process.env.MAX_ZOOM || '15', 10);
const AUTH_TIMEOUT_MS = parseInt(process.env.AUTH_TIMEOUT_MS || '5000', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const RATE_LIMIT_ESTIMATE = parseInt(process.env.RATE_LIMIT_ESTIMATE || '30', 10);
const RATE_LIMIT_EXTRACT = parseInt(process.env.RATE_LIMIT_EXTRACT || '5', 10);
const RATE_LIMIT_TILES = parseInt(process.env.RATE_LIMIT_TILES || '3000', 10);
const RETRY_AFTER_SECONDS = parseInt(process.env.RETRY_AFTER_SECONDS || '15', 10);
// /maps/base: tope de bytes por pedido (un rango más grande se rechaza con 416) y
// tope de streams concurrentes por IP y por usuario (más → 429). 32 admite "decenas"
// de pedidos paralelos de un mapa vectorial (una pantalla son ~15-25 tiles).
const MAX_RANGE_BYTES = parseInt(process.env.MAX_RANGE_BYTES || String(4 * 1024 * 1024), 10);
const MAX_CONCURRENT_STREAMS = parseInt(process.env.MAX_CONCURRENT_STREAMS || '32', 10);
// Redes desde las que se confía en X-Forwarded-For / CF-Connecting-IP para deducir la
// IP real del cliente (detrás de NPM/Cloudflare). Por defecto, las redes privadas de
// Docker + loopback; fuera de ellas esos headers se ignoran y se usa la IP del socket.
const TRUSTED_PROXY_CIDRS = (process.env.TRUSTED_PROXY_CIDRS
  || '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8')
  .split(',').map((s) => s.trim()).filter(Boolean);

const RATE_LIMIT_VERSION = parseInt(process.env.RATE_LIMIT_VERSION || '60', 10);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Identidad del base en servicio
// ---------------------------------------------------------------------------
// Las zonas descargadas guardan este valor (buildVersion). Es lo que permite marcar
// como "desactualizada" una zona recortada de un base distinto del vigente aunque su
// maxZoom ya sea el actual (caso real: el recorte viejo perdía teselas costeras que
// el nuevo sí tiene, y ambas zonas son z15).
//
// Por defecto <archivo>:<tamaño>. Se descarta el mtime a propósito: cambia con
// cualquier copia o rsync del mismo contenido y marcaría todo el parque como
// desactualizado de golpe. BASE_VERSION es un override EXCEPCIONAL: si se fija a
// mano y se olvida actualizarla al cambiar de base, las zonas quedan mal
// etiquetadas (ver .env.example). Se calcula una vez, al arrancar.
const BASE_VERSION = process.env.BASE_VERSION || (() => {
  const name = path.basename(BASE_PMTILES);
  try {
    return `${name}:${fs.statSync(BASE_PMTILES).size}`;
  } catch {
    log('aviso: no se pudo leer el base para calcular BASE_VERSION:', BASE_PMTILES);
    return `${name}:desconocido`;
  }
})();

// ---------------------------------------------------------------------------
// Estado en memoria
// ---------------------------------------------------------------------------
const jobs = new Map();       // jobId -> job
let activeExtract = null;     // jobId del extract en curso
const tokenCache = new Map(); // token -> { valid, userId, unavailable, at }
const rateLimiters = new Map(); // userKey -> { windowStart, count }
const activeStreams = new Map(); // clave -> streams de /maps/base actualmente abiertos

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

// ---- IP real del cliente --------------------------------------------------
// Detrás de Cloudflare/NPM el socket solo ve la IP del proxy. Para deducir la IP
// real se confía en CF-Connecting-IP (Cloudflare) o X-Forwarded-For (NPM), PERO
// únicamente si la conexión directa (socket) viene de la red del proxy. Si un
// cliente conecta directo (fuera de la red de confianza), esos headers se ignoran
// y se usa la IP del socket: no se puede falsear el rate limit con headers propios.

function parseIpv4(ip) {
  let s = ip;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (mapped) s = mapped[1];
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => {
    const n = Number(p);
    return Number.isInteger(n) && n >= 0 && n <= 255 ? n : NaN;
  });
  if (nums.some((n) => Number.isNaN(n))) return null;
  return ((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0;
}

function isTrustedProxy(ip) {
  const addr = parseIpv4(ip);
  if (addr === null) return false;
  for (const cidr of TRUSTED_PROXY_CIDRS) {
    const slash = cidr.indexOf('/');
    const base = slash === -1 ? cidr : cidr.slice(0, slash);
    const bits = slash === -1 ? 32 : parseInt(cidr.slice(slash + 1), 10);
    const baseAddr = parseIpv4(base);
    if (baseAddr === null || !Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((addr & mask) === (baseAddr & mask)) return true;
  }
  return false;
}

function clientIp(req) {
  const socketIp = req.socket.remoteAddress || 'unknown';
  if (!isTrustedProxy(socketIp)) return socketIp;
  // Cloudflare setea CF-Connecting-IP con la IP real del cliente; se prefiere.
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim().length) return cf.trim();
  // X-Forwarded-For es una lista "cliente, proxy1, proxy2, …". Se recorre de derecha
  // a izquierda y se toma la primera entrada que NO sea un proxy de confianza: así un
  // valor falso antepuesto (más a la izquierda) no engaña el rate limit. Si todas las
  // entradas son de confianza, se cae a la IP del socket (el proxy más cercano).
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) {
    const values = fwd.split(',').map((s) => s.trim()).filter(Boolean);
    for (let i = values.length - 1; i >= 0; i -= 1) {
      if (!isTrustedProxy(values[i])) return values[i];
    }
  }
  return socketIp;
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

// ---- Tope de streams concurrentes (/maps/base) ---------------------------
// Cuenta los streams abiertos por clave (IP o usuario). Adquiere todas las claves
// de forma atómica; si alguna ya llegó al tope, revierte las ya adquiridas y
// devuelve false (la respuesta será 429).
function tryAcquireStreams(keys) {
  const acquired = [];
  for (const key of keys) {
    const current = activeStreams.get(key) || 0;
    if (current >= MAX_CONCURRENT_STREAMS) {
      for (const k of acquired) {
        const v = activeStreams.get(k) - 1;
        if (v <= 0) activeStreams.delete(k); else activeStreams.set(k, v);
      }
      return false;
    }
    activeStreams.set(key, current + 1);
    acquired.push(key);
  }
  return true;
}

function releaseStreams(keys) {
  for (const key of keys) {
    const v = activeStreams.get(key);
    if (v == null) continue;
    if (v <= 1) activeStreams.delete(key); else activeStreams.set(key, v - 1);
  }
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
    // Base del que se recortó la zona: se fija al crear el job (y no al descargar)
    // para que valga el base que regía durante la extracción.
    baseVersion: BASE_VERSION,
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
    baseVersion: job.baseVersion,
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
// GET /maps/version — identidad del base en servicio. La app la consulta para marcar
// como "desactualizada" una zona descargada de un base anterior. Es un GET sin body
// ni archivo: la app nunca depende de leer headers de /maps/base.
async function handleVersion(req, res, user) {
  const retryAfter = checkRateLimit(userKey(user) + ':version', RATE_LIMIT_VERSION);
  if (retryAfter) {
    log('429 version usuario=' + userKey(user));
    return sendRateLimited(res, 'Demasiados pedidos', retryAfter);
  }
  sendJson(res, 200, { ok: true, baseVersion: BASE_VERSION });
}

async function handleEstimate(req, res, user) {
  const retryAfter = checkRateLimit(userKey(user) + ':estimate', RATE_LIMIT_ESTIMATE);
  if (retryAfter) {
    log('429 estimate usuario=' + userKey(user));
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
      baseVersion: BASE_VERSION,
    });
  }
  sendJson(res, 200, {
    ok: true, tiles: est.tiles, bytes: est.bytes, maxBytes: MAX_ZONE_BYTES,
    baseVersion: BASE_VERSION,
    minLng: zone.minLng, minLat: zone.minLat, maxLng: zone.maxLng, maxLat: zone.maxLat,
    minZoom: zone.minZoom, maxZoom: zone.maxZoom,
  });
}

async function handleExtract(req, res, user) {
  const retryAfter = checkRateLimit(userKey(user) + ':extract', RATE_LIMIT_EXTRACT);
  if (retryAfter) {
    log('429 extract usuario=' + userKey(user));
    return sendRateLimited(res, 'Demasiados pedidos de extracción', retryAfter);
  }
  const zone = await readZone(req, res);
  if (!zone) return;

  if (activeExtract) {
    log('429 extract: ya hay una extracción en curso');
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
      baseVersion: BASE_VERSION,
    });
  }

  const job = createJob(zone, user.id);
  job.tiles = est.tiles;
  job.bytes = est.bytes;
  job.status = 'running';
  job.startedAt = Date.now();
  activeExtract = job.id;
  runExtract(job); // en segundo plano; no se espera.

  sendJson(res, 202, {
    ok: true, jobId: job.id, tiles: est.tiles, bytes: est.bytes,
    baseVersion: job.baseVersion,
  });
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

// Sirve el archivo base .pmtiles por rangos HTTP (mapa vectorial online). La ruta es
// fija (BASE_PMTILES): ningún input del cliente entra en el path del archivo.
//
// Endurecido:
//  1. Rate limit por IP real: confía en CF-Connecting-IP/X-Forwarded-For solo si el
//     socket viene de la red del proxy (ver clientIp); si no, usa la IP del socket.
//  2. Exige UN rango bytes=a-b válido y con tope de tamaño. Sin Range, multi-range,
//     rango abierto o mayor a MAX_RANGE_BYTES → 416 (nunca 200 con el archivo entero).
//  3. Tope de streams concurrentes por IP y por usuario → 429.
// El streaming de bytes y la limpieza ante desconexión los maneja `send`, con
// etag/lastModified desactivados para eliminar la rama condicional que serviría el
// archivo completo. La autenticación ya corrió en el router, antes de abrir el archivo.
async function handleBase(req, res, user) {
  const ip = clientIp(req);

  const retryAfter = checkRateLimit(`ip:${ip}`, RATE_LIMIT_TILES);
  if (retryAfter) {
    log(`429 /maps/base rate-limit ip=${ip}`);
    return sendRateLimited(res, 'Demasiados pedidos de tiles', retryAfter);
  }

  const stat = await fsp.stat(BASE_PMTILES).catch(() => null);
  if (!stat || !stat.isFile()) {
    return sendJson(res, 404, { ok: false, error: 'Mapa base no disponible' });
  }

  const opts = {
    root: path.dirname(BASE_PMTILES),
    index: false,
    dotfiles: 'deny',
    acceptRanges: true,
    etag: false,
    lastModified: false,
  };

  if (req.method !== 'GET') {
    // HEAD: solo cabeceras (Content-Length, Accept-Ranges), sin body ni Range.
    const stream = send(req, path.basename(BASE_PMTILES), opts);
    stream.on('error', (err) => handleSendError(res, err));
    stream.pipe(res);
    return;
  }

  const range = parseByteRange(req.headers.range, stat.size);
  if (!range) {
    return sendRangeNotSatisfiable(res, stat.size);
  }

  const keys = [`ip:${ip}`, `user:${userKey(user)}`];
  if (!tryAcquireStreams(keys)) {
    log(`429 /maps/base streams ip=${ip} usuario=${userKey(user)}`);
    return sendRateLimited(res, 'Demasiados streams concurrentes', RETRY_AFTER_SECONDS);
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseStreams(keys);
  };

  const stream = send(req, path.basename(BASE_PMTILES), opts);
  stream.on('error', (err) => {
    release();
    handleSendError(res, err);
  });
  stream.on('end', release);
  res.on('close', release);
  stream.pipe(res);
}

// Maneja el error del stream de `send`: si ya se enviaron headers (cliente que cortó
// a mitad), solo cierra; si no, responde el status del error preservando sus headers.
function handleSendError(res, err) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const status = err.status || err.statusCode || 500;
  if (err.headers) {
    for (const [name, value] of Object.entries(err.headers)) {
      res.setHeader(name, value);
    }
  }
  const message = status === 404 ? 'Mapa base no disponible' : 'Error al servir el mapa';
  sendJson(res, status, { ok: false, error: message });
}

// Solo se acepta UN rango cerrado bytes=a-b, dentro del archivo y de hasta
// MAX_RANGE_BYTES. Cualquier otra cosa (sin Range, multi-range, abierto bytes=a- o
// bytes=-N, fuera de rango o mayor al tope) devuelve null → 416.
function parseByteRange(header, size) {
  if (typeof header !== 'string') return null;
  const m = /^bytes=(\d+)-(\d+)$/.exec(header.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  if (start > end || start >= size || end >= size) return null;
  if (end - start + 1 > MAX_RANGE_BYTES) return null;
  return { start, end };
}

function sendRangeNotSatisfiable(res, size) {
  const body = JSON.stringify({ ok: false, error: 'Rango inválido o demasiado grande' });
  res.writeHead(416, {
    'Content-Range': `bytes */${size}`,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Servidor HTTP
// ---------------------------------------------------------------------------
const ROUTES = [
  ['GET', '/maps/version', handleVersion],
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
    log(`base=${BASE_PMTILES} baseVersion=${BASE_VERSION} traccar=${TRACCAR_URL} maxBytes=${MAX_ZONE_BYTES}`);
    log(`trustedProxyCidrs=${TRUSTED_PROXY_CIDRS.join(',')}`);
  });
}

// Solo arranca si se ejecuta como programa (`node server.js`). Al requerirlo desde un
// test, el módulo se carga sin abrir el puerto ni tocar /data.
if (require.main === module) {
  start().catch((err) => {
    console.error('Error al iniciar:', err);
    process.exit(1);
  });
}

module.exports = {
  server,
  start,
  BASE_VERSION,
  ROUTES,
  handleVersion,
  handleEstimate,
  handleExtract,
  handleJob,
  createJob,
  publicJob,
};
