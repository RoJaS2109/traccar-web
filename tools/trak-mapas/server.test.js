// Contrato HTTP de trak-mapas: el endpoint /maps/version y la presencia de
// `baseVersion` en estimate, extract y job (lo que consume la app para etiquetar las
// zonas descargadas). Además verifica que /maps/base NO exponga ese dato por header.
//
// Se carga server.js como módulo CommonJS (no arranca solo: `require.main === module`)
// y se abre en un puerto efímero. Traccar se mockea interceptando fetch únicamente
// para su URL: el resto de los pedidos (los del test contra el servidor local) pasan
// al fetch real.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

// Emula el binario `pmtiles`: la salida que parsea estimateZone y, en el extract real,
// crea el archivo de salida para que el job termine en 'done'.
const PMTILES_FALSO = `#!/bin/sh
if [ "$1" = "extract" ]; then
  case "$3" in
    *.dryrun) ;;
    *) : > "$3" ;;
  esac
fi
echo "result tile entries 42"
echo "archive size of 1.5 MB"
exit 0
`;

const TRACCAR = 'http://traccar-falso:8082';
const TOKEN = 'token-de-prueba';

let mod;
let server;
let base;
let tmp;
let fetchReal;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'trak-mapas-'));
  const bin = path.join(tmp, 'pmtiles-falso');
  await writeFile(bin, PMTILES_FALSO, 'utf8');
  await chmod(bin, 0o755);

  const output = path.join(tmp, 'output');
  await mkdir(output, { recursive: true });
  const baseFile = path.join(tmp, 'sudamerica-de-prueba.pmtiles');
  await writeFile(baseFile, Buffer.alloc(4096));

  // El entorno se fija ANTES de requerir el módulo: las constantes se leen al cargar.
  process.env.PMTILES_BIN = bin;
  process.env.OUTPUT_DIR = output;
  process.env.BASE_PMTILES = baseFile;
  process.env.TRACCAR_URL = TRACCAR;
  delete process.env.BASE_VERSION; // forzar el cálculo automático
  // Topes bajos para provocar 429 de verdad en «registros sin datos personales» (los demás tests hacen 1 o 2 pedidos).
  process.env.RATE_LIMIT_VERSION = '5';
  process.env.RATE_LIMIT_TILES = '5';

  fetchReal = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith(TRACCAR)) {
      return Promise.resolve(
        new Response(JSON.stringify({ id: 7 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    return fetchReal(input, init);
  };

  mod = require('./server.js');
  server = mod.server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  globalThis.fetch = fetchReal;
  await new Promise((resolve) => server.close(resolve));
  await rm(tmp, { recursive: true, force: true });
});

const pedir = (ruta, { method = 'GET', token = TOKEN, body } = {}) =>
  fetch(`${base}${ruta}`, {
    method,
    headers: token
      ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const ZONA = { minLng: -58.6, minLat: -34.8, maxLng: -58.2, maxLat: -34.4, minZoom: 0, maxZoom: 12 };

describe('BASE_VERSION', () => {
  it('se calcula como <archivo>:<tamaño> cuando no hay override por entorno', () => {
    expect(mod.BASE_VERSION).toBe('sudamerica-de-prueba.pmtiles:4096');
  });
});

describe('GET /maps/version', () => {
  it('sin token responde 401', async () => {
    const res = await pedir('/maps/version', { token: null });
    expect(res.status).toBe(401);
  });

  it('con token devuelve { ok, baseVersion }', async () => {
    const res = await pedir('/maps/version');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, baseVersion: mod.BASE_VERSION });
  });
});

describe('baseVersion en estimate, extract y job', () => {
  it('POST /maps/zone/estimate la incluye', async () => {
    const res = await pedir('/maps/zone/estimate', { method: 'POST', body: ZONA });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.baseVersion).toBe(mod.BASE_VERSION);
    expect(data.tiles).toBe(42);
    expect(data.bytes).toBe(1500000);
  });

  it('POST /maps/zone/extract la incluye junto al jobId', async () => {
    const res = await pedir('/maps/zone/extract', { method: 'POST', body: ZONA });
    expect(res.status).toBe(202);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.baseVersion).toBe(mod.BASE_VERSION);
    expect(data.jobId).toMatch(/^[0-9a-f-]{36}$/);

    const jobRes = await pedir(`/maps/zone/job/${data.jobId}`);
    expect(jobRes.status).toBe(200);
    const job = (await jobRes.json()).job;
    expect(job.baseVersion).toBe(mod.BASE_VERSION);
    expect(job.id).toBe(data.jobId);
    expect(['running', 'done']).toContain(job.status);
  });
});

describe('/maps/base', () => {
  it('sirve el archivo pero NO expone X-Base-Version (la versión va por /maps/version)', async () => {
    const res = await pedir('/maps/base', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-base-version')).toBeNull();
    expect(Number(res.headers.get('content-length'))).toBe(4096);
  });
});

// Los registros técnicos no guardan datos personales (privacidad de mytrip, punto 6): un 429 se registra, pero sin la IP
// ni el usuario. Esos registros los guarda Docker por tamaño, no por tiempo, y podrían vivir más de 30 días.
describe('registros sin datos personales', () => {
  const PERSONALES = [/\bip=/, /\busuario=/, /127\.0\.0\.1/, /\bu7\b/];

  async function hasta429(ruta, opciones) {
    for (let i = 0; i < 20; i += 1) {
      const res = await pedir(ruta, opciones);
      if (res.status === 429) return;
    }
    throw new Error(`${ruta} nunca respondió 429`);
  }

  for (const [nombre, ruta, opciones] of [
    ['el 429 de /maps/version', '/maps/version', {}],
    ['el 429 de /maps/base', '/maps/base', { method: 'HEAD' }],
  ]) {
    it(`${nombre} se registra sin IP ni usuario`, async () => {
      const espia = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await hasta429(ruta, opciones);
        const lineas = espia.mock.calls.map((args) => args.join(' '));
        const del429 = lineas.filter((l) => l.includes('429'));
        expect(del429.length, `esperaba una línea de 429; recibí: ${lineas.join(' | ')}`).toBeGreaterThan(0);
        for (const linea of del429) {
          for (const patron of PERSONALES) expect(linea, `la línea «${linea}» lleva ${patron}`).not.toMatch(patron);
        }
      } finally {
        espia.mockRestore();
      }
    });
  }

  // Los 429 que no se provocan acá (estimate, extract y streams concurrentes): ninguna llamada a `log` arma `ip=` ni `usuario=`.
  it('ninguna llamada a log de server.js escribe ip= ni usuario=', async () => {
    const fuente = await readFile(new URL('./server.js', import.meta.url), 'utf8');
    const conDatos = fuente.split('\n').filter((l) => /\blog\(/.test(l) && /\bip=|\busuario=/.test(l));
    expect(conDatos, `líneas con datos personales: ${conDatos.join(' | ')}`).toEqual([]);
  });
});
