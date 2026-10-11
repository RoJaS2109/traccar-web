// AUTH_BACKEND (spec de mytrip §3): quién valida el Bearer. `traccar` (default) pregunta a
// Traccar; `mytrip` pregunta a `GET {MYTRIP_URL}/v1/yo` con el mismo Bearer. En los dos: 401 si
// el token se rechaza, 503 si el servicio no responde, y la misma caché de 5 minutos.
//
// El entorno se lee al cargar server.js, así que cada caso carga una copia nueva del módulo
// (se vacía su entrada de require.cache) con el AUTH_BACKEND que prueba. Los servicios de
// identidad se simulan interceptando fetch únicamente para sus URLs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const RUTA_SERVER = require.resolve('./server.js');

const TRACCAR = 'http://traccar-falso:8082';
const MYTRIP = 'http://mytrip-api-falso:3000';
const CINCO_MINUTOS = 5 * 60 * 1000;

let tmp;
let fetchReal;
let llamadas; // pedidos que llegaron a los servicios de identidad simulados
let respuesta; // qué contesta el servicio simulado: () => Response, o lanza para simular caída
let server;
let base;

// Responde `fn` solo a la API de mytrip; Traccar contesta 200 a todo. Así un caso de mytrip que
// pasara consultando a Traccar por error se vería como 200 y no como el 401/503 que espera.
const soloMytrip = (fn) => (url) => (url.startsWith(MYTRIP) ? fn() : json(200, { id: 7 }));

const json = (status, cuerpo = {}) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'Content-Type': 'application/json' } });

async function cargar(env) {
  for (const clave of ['AUTH_BACKEND', 'MYTRIP_URL', 'TRACCAR_URL']) delete process.env[clave];
  Object.assign(process.env, env);
  delete require.cache[RUTA_SERVER];
  const mod = require('./server.js');
  server = mod.server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  return mod;
}

const version = (token) =>
  fetch(`${base}/maps/version`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'trak-mapas-auth-'));
  const baseFile = path.join(tmp, 'base-de-prueba.pmtiles');
  await writeFile(baseFile, Buffer.alloc(1024));
  process.env.BASE_PMTILES = baseFile;
  process.env.OUTPUT_DIR = path.join(tmp, 'output');
  delete process.env.BASE_VERSION;

  llamadas = [];
  respuesta = () => json(200, { id: 7 });
  fetchReal = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith(TRACCAR) || url.startsWith(MYTRIP)) {
      llamadas.push({ url, headers: init?.headers ?? {} });
      return Promise.resolve().then(() => respuesta(url));
    }
    return fetchReal(input, init);
  };
});

afterEach(async () => {
  vi.useRealTimers();
  globalThis.fetch = fetchReal;
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  server = undefined;
  await rm(tmp, { recursive: true, force: true });
});

describe('AUTH_BACKEND=traccar (default)', () => {
  it('sin AUTH_BACKEND valida contra Traccar, como siempre', async () => {
    await cargar({ TRACCAR_URL: TRACCAR });
    const res = await version('tok-traccar');
    expect(res.status).toBe(200);
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0].url).toBe(`${TRACCAR}/api/session?token=tok-traccar`);
  });

  it('token rechazado por Traccar: 401', async () => {
    respuesta = () => json(401);
    await cargar({ TRACCAR_URL: TRACCAR });
    expect((await version('malo')).status).toBe(401);
  });

  it('Traccar caído: 503', async () => {
    respuesta = () => {
      throw new TypeError('fetch failed');
    };
    await cargar({ TRACCAR_URL: TRACCAR });
    expect((await version('cualquiera')).status).toBe(503);
  });

  it('un valor desconocido de AUTH_BACKEND no arranca: falla cerrado, no cae al default', async () => {
    await expect(cargar({ AUTH_BACKEND: 'traccr', TRACCAR_URL: TRACCAR })).rejects.toThrow(
      /AUTH_BACKEND/,
    );
  });
});

describe('AUTH_BACKEND=mytrip', () => {
  const ENTORNO = { AUTH_BACKEND: 'mytrip', MYTRIP_URL: MYTRIP, TRACCAR_URL: TRACCAR };

  it('valida con GET {MYTRIP_URL}/v1/yo y el mismo Bearer; Traccar no se consulta', async () => {
    await cargar(ENTORNO);
    const res = await version('tok-mytrip');
    expect(res.status).toBe(200);
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0].url).toBe(`${MYTRIP}/v1/yo`);
    expect(llamadas[0].headers.Authorization).toBe('Bearer tok-mytrip');
  });

  it('MYTRIP_URL con barra final no duplica la barra', async () => {
    await cargar({ ...ENTORNO, MYTRIP_URL: `${MYTRIP}/` });
    await version('tok');
    expect(llamadas[0].url).toBe(`${MYTRIP}/v1/yo`);
  });

  it('token rechazado por la API de mytrip: 401', async () => {
    respuesta = soloMytrip(() => json(401, { codigo: 'no_autenticado' }));
    await cargar(ENTORNO);
    expect((await version('de-traccar')).status).toBe(401);
  });

  it('API de mytrip caída: 503', async () => {
    respuesta = soloMytrip(() => {
      throw new TypeError('fetch failed');
    });
    await cargar(ENTORNO);
    expect((await version('cualquiera')).status).toBe(503);
  });

  it('API de mytrip con 5xx: 503, no 401 (no es culpa del token)', async () => {
    respuesta = soloMytrip(() => json(500));
    await cargar(ENTORNO);
    expect((await version('tok')).status).toBe(503);
  });

  it('sin token no se consulta a nadie: 401', async () => {
    await cargar(ENTORNO);
    expect((await version(null)).status).toBe(401);
    expect(llamadas).toHaveLength(0);
  });

  it('sin MYTRIP_URL no arranca', async () => {
    await expect(cargar({ AUTH_BACKEND: 'mytrip', TRACCAR_URL: TRACCAR })).rejects.toThrow(
      /MYTRIP_URL/,
    );
  });
});

describe.each([
  ['traccar', { TRACCAR_URL: TRACCAR }],
  ['mytrip', { AUTH_BACKEND: 'mytrip', MYTRIP_URL: MYTRIP, TRACCAR_URL: TRACCAR }],
])('caché de 5 minutos (%s)', (_nombre, entorno) => {
  it('un token válido se consulta una vez en 5 minutos y otra vez pasado el plazo', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await cargar(entorno);
    expect((await version('tok')).status).toBe(200);
    vi.advanceTimersByTime(CINCO_MINUTOS - 1000);
    expect((await version('tok')).status).toBe(200);
    expect(llamadas).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    expect((await version('tok')).status).toBe(200);
    expect(llamadas).toHaveLength(2);
  });

  it('un token rechazado también se cachea', async () => {
    respuesta = () => json(401);
    await cargar(entorno);
    expect((await version('malo')).status).toBe(401);
    expect((await version('malo')).status).toBe(401);
    expect(llamadas).toHaveLength(1);
  });

  it('un 503 no se cachea: cuando el servicio vuelve, el siguiente pedido pasa', async () => {
    respuesta = () => {
      throw new TypeError('fetch failed');
    };
    await cargar(entorno);
    expect((await version('tok')).status).toBe(503);
    respuesta = () => json(200, { id: 7 });
    expect((await version('tok')).status).toBe(200);
    expect(llamadas).toHaveLength(2);
  });
});
