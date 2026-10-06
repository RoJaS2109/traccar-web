# Servicio de enrolamiento — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir el servicio que decide qué dispositivos pueden usar RudaTrak, emitiendo tokens de Traccar solo para los enrolamientos que Rodrigo aprueba a mano.

**Architecture:** Un servicio Node 22 + Express, contenedor y base SQLite propios, que corre al lado de Traccar sin tocarlo. La app pide enrolamiento y recibe un código legible; Rodrigo lo aprueba desde una página de administración; el servicio crea el usuario en Traccar y emite un token **por suplantación de la sesión de admin**, sin conocer nunca la contraseña del usuario. La app renueva ese token sola con el secreto del dispositivo.

**Tech Stack:** Node 22 (`node:sqlite`, `node:test`, `fetch` y `AbortSignal.timeout` globales), Express 4, Docker (`node:22-alpine`).

**Spec:** `traccar/traccar-web/docs/superpowers/specs/2026-10-06-enrolamiento-dispositivos-design.md`

## Global Constraints

- **Node ≥ 22.13.0.** `node:sqlite` dejó de necesitar `--experimental-sqlite` en 22.13. En 22.5–22.12 el módulo existe pero requiere el flag. La imagen `node:22-alpine` cumple.
- **Cero dependencias nativas.** Nada de `better-sqlite3` ni de compilación en Alpine. Solo `node:sqlite`.
- **Única dependencia de producción: `express@^4.18.2`.** Misma versión que `tools/carga-poi`. Nada más.
- **El servicio es aditivo.** Contenedor, archivo SQLite y puerto propios. No modifica Traccar, ni su base, ni `traccar.xml`, ni el frontend. Nada llega a producción sin correr `deploy.sh` a mano.
- **El secreto del dispositivo nunca se guarda en claro**, ni en la base ni en los registros. Solo su `SHA-256`.
- **Ningún secreto se escribe en un `console.log`.** Ni el secreto, ni el token, ni la contraseña generada, ni las credenciales de admin.
- **Token de 365 días.** Sin renovación automática del lado de Traccar: la renovación la maneja este servicio (spec §4, §7.2).
- **Comentarios y textos de cara al usuario en español.** Identificadores de código en inglés, como el resto del repo.
- **`type: "module"`** — el servicio usa ESM, igual que `tools/carga-poi`.

## Review Focus

Cinco condiciones que el spec implica pero que ningún requisito enumera. Cada una tiene su test en la tarea que la posee.

1. **Doble aprobación del mismo código.** Rodrigo hace doble clic en "Aprobar". Un segundo clic no debe crear un segundo usuario en Traccar ni pisar el token del primero. (Tarea 6)
2. **Traccar caído a mitad de la aprobación.** El usuario se creó pero la emisión del token falló. El registro **no** debe quedar marcado como aprobado, y el mensaje de error no debe dejar a Rodrigo adivinando. (Tarea 6)
3. **Código vencido o inventado.** Aprobar un código que no existe, o uno de hace tres semanas, debe devolver un error claro **sin** crear usuarios en Traccar. (Tarea 6)
4. **Renovación de un dispositivo revocado.** Un dispositivo revocado que sigue teniendo el secreto no debe poder renovar y recuperar acceso. (Tarea 7)
5. **Código tipeado por una persona.** Minúsculas, sin guiones, con espacios de más, o pegado desde WhatsApp con un salto de línea. Debe resolver al mismo registro. (Tarea 2, Tarea 6)

---

## Estructura de archivos

Todo nuevo, bajo `traccar/traccar-web/tools/enroll/`:

| Archivo | Responsabilidad |
|---|---|
| `package.json` | Manifiesto, scripts, única dependencia |
| `src/db.js` | Esquema SQLite y todas las consultas. Único módulo que escribe SQL |
| `src/codes.js` | Generar, normalizar y formatear códigos legibles. Sin estado |
| `src/traccar.js` | Cliente HTTP de la API de Traccar. Único módulo que habla con Traccar |
| `src/enrollService.js` | Orquestación: las reglas de negocio. No sabe de HTTP ni de SQL |
| `src/auth.js` | Middleware que resuelve el dispositivo desde su secreto |
| `src/adminAuth.js` | Middleware de Basic auth del administrador del servicio |
| `src/enrollRoutes.js` | Rutas `/enroll/*` |
| `src/adminRoutes.js` | Rutas `/admin/*` |
| `src/adminPage.js` | Página de administración (HTML del servidor, sin build) |
| `src/server.js` | Cableado de Express y arranque |
| `Dockerfile` | Imagen del servicio |
| `docker-compose.staging.yml` | Stack de pruebas en la Pi, sin tocar producción |
| `test/helpers.js` | Traccar falso, servicio sobre base en memoria y reloj fijo. Compartido por todos los tests. **No** termina en `.test.js` a propósito: `node --test` solo levanta esos |
| `test/*.test.js` | Tests con `node:test` |

La separación importa: `enrollService.js` se testea entero con un Traccar falso y una base en memoria, sin levantar Express ni pegarle a la red.

---

### Task 1: Andamiaje y esquema SQLite

**Files:**
- Create: `traccar/traccar-web/tools/enroll/package.json`
- Create: `traccar/traccar-web/tools/enroll/src/db.js`
- Create: `traccar/traccar-web/tools/enroll/test/db.test.js`
- Create: `traccar/traccar-web/tools/enroll/.gitignore`

**Interfaces:**
- Consumes: nada.
- Produces: `openDb(path)`, `hashSecret(secret)`, las constantes `PENDING` / `APPROVED` / `REVOKED`, y las consultas `insertDevice`, `getByDeviceId`, `getByCode`, `listByStatus`, `markApproved`, `setToken`, `markRevoked`, `touch`, `deleteDevice`. Todas reciben `db` como primer argumento.

- [ ] **Step 1: Crear el manifiesto**

`traccar/traccar-web/tools/enroll/package.json`:

```json
{
  "name": "rudatrak-enroll",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "Servicio de enrolamiento de dispositivos de RudaTrak",
  "engines": {
    "node": ">=22.13.0"
  },
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test test/"
  },
  "dependencies": {
    "express": "^4.18.2"
  }
}
```

`traccar/traccar-web/tools/enroll/.gitignore`:

```
node_modules/
data/
*.db
*.db-wal
*.db-shm
```

- [ ] **Step 2: Instalar y verificar la versión de Node**

Run:
```bash
cd traccar/traccar-web/tools/enroll && npm install && node --version
```
Expected: instala `express` sin compilar nada nativo. `node --version` debe dar `v22.13.0` o superior. Si da menos, **parar**: `node:sqlite` necesita el flag `--experimental-sqlite` y el plan asume que no hace falta.

- [ ] **Step 3: Escribir el test que falla**

`traccar/traccar-web/tools/enroll/test/db.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, hashSecret, insertDevice, getByDeviceId, getByCode,
         markApproved, setToken, markRevoked, listByStatus,
         PENDING, APPROVED, REVOKED } from '../src/db.js';

function freshDb() {
  return openDb(':memory:');
}

const SAMPLE = {
  deviceId: hashSecret('secreto-de-juan'),
  code: 'RUDA7K4M92QX',
  note: 'Juan, tester de Salta',
  createdAt: '2026-10-06T12:00:00.000Z',
  codeExpiresAt: '2026-10-08T12:00:00.000Z',
};

test('hashSecret es estable y no devuelve el secreto', () => {
  const a = hashSecret('secreto-de-juan');
  const b = hashSecret('secreto-de-juan');
  assert.equal(a, b);
  assert.equal(a.length, 64);
  assert.ok(!a.includes('secreto'));
});

test('insertDevice guarda y getByDeviceId recupera', () => {
  const db = freshDb();
  insertDevice(db, SAMPLE);
  const row = getByDeviceId(db, SAMPLE.deviceId);
  assert.equal(row.code, SAMPLE.code);
  assert.equal(row.status, PENDING);
  assert.equal(row.note, SAMPLE.note);
  assert.equal(row.token, null);
  assert.equal(row.traccar_user_id, null);
});

test('getByCode encuentra por código', () => {
  const db = freshDb();
  insertDevice(db, SAMPLE);
  assert.equal(getByCode(db, SAMPLE.code).device_id, SAMPLE.deviceId);
  assert.equal(getByCode(db, 'RUDA00000000'), null);
});

test('no se puede insertar dos veces el mismo device_id', () => {
  const db = freshDb();
  insertDevice(db, SAMPLE);
  assert.throws(() => insertDevice(db, SAMPLE), /UNIQUE|PRIMARY/i);
});

test('no se puede repetir un código', () => {
  const db = freshDb();
  insertDevice(db, SAMPLE);
  assert.throws(
    () => insertDevice(db, { ...SAMPLE, deviceId: hashSecret('otro') }),
    /UNIQUE/i,
  );
});

test('markApproved deja el registro aprobado con su usuario y token', () => {
  const db = freshDb();
  insertDevice(db, SAMPLE);
  markApproved(db, SAMPLE.deviceId, {
    label: 'Juan',
    traccarUserId: 42,
    token: 'tok-abc',
    approvedAt: '2026-10-06T13:00:00.000Z',
  });
  const row = getByDeviceId(db, SAMPLE.deviceId);
  assert.equal(row.status, APPROVED);
  assert.equal(row.label, 'Juan');
  assert.equal(row.traccar_user_id, 42);
  assert.equal(row.token, 'tok-abc');
  assert.equal(row.approved_at, '2026-10-06T13:00:00.000Z');
});

test('setToken reemplaza el token sin tocar el estado', () => {
  const db = freshDb();
  insertDevice(db, SAMPLE);
  markApproved(db, SAMPLE.deviceId, {
    label: 'Juan', traccarUserId: 42, token: 'viejo', approvedAt: '2026-10-06T13:00:00.000Z',
  });
  setToken(db, SAMPLE.deviceId, 'nuevo');
  const row = getByDeviceId(db, SAMPLE.deviceId);
  assert.equal(row.token, 'nuevo');
  assert.equal(row.status, APPROVED);
  assert.equal(row.traccar_user_id, 42);
});

test('markRevoked marca revocado y borra el token', () => {
  const db = freshDb();
  insertDevice(db, SAMPLE);
  markApproved(db, SAMPLE.deviceId, {
    label: 'Juan', traccarUserId: 42, token: 'tok', approvedAt: '2026-10-06T13:00:00.000Z',
  });
  markRevoked(db, SAMPLE.deviceId);
  const row = getByDeviceId(db, SAMPLE.deviceId);
  assert.equal(row.status, REVOKED);
  assert.equal(row.token, null);
});

test('listByStatus filtra por estado', () => {
  const db = freshDb();
  insertDevice(db, SAMPLE);
  insertDevice(db, { ...SAMPLE, deviceId: hashSecret('pedro'), code: 'RUDA11111111' });
  assert.equal(listByStatus(db, PENDING).length, 2);
  assert.equal(listByStatus(db, APPROVED).length, 0);
});
```

- [ ] **Step 4: Correr el test para verificar que falla**

Run: `cd traccar/traccar-web/tools/enroll && npm test`
Expected: FAIL — `Cannot find module '../src/db.js'`.

- [ ] **Step 5: Implementar `src/db.js`**

```js
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

export const PENDING = 'pending';
export const APPROVED = 'approved';
export const REVOKED = 'revoked';

/**
 * El secreto del dispositivo nunca se guarda. Solo este hash, que es la
 * clave primaria de la tabla.
 */
export function hashSecret(secret) {
  return createHash('sha256').update(String(secret)).digest('hex');
}

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS devices (
      device_id       TEXT PRIMARY KEY,
      code            TEXT NOT NULL UNIQUE,
      status          TEXT NOT NULL,
      label           TEXT,
      note            TEXT,
      traccar_user_id INTEGER,
      token           TEXT,
      created_at      TEXT NOT NULL,
      approved_at     TEXT,
      last_seen_at    TEXT,
      code_expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_devices_status ON devices (status);
  `);
  return db;
}

export function insertDevice(db, { deviceId, code, note, createdAt, codeExpiresAt }) {
  db.prepare(`
    INSERT INTO devices (device_id, code, status, note, created_at, code_expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(deviceId, code, PENDING, note ?? null, createdAt, codeExpiresAt);
}

export function getByDeviceId(db, deviceId) {
  return db.prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId) ?? null;
}

export function getByCode(db, code) {
  return db.prepare('SELECT * FROM devices WHERE code = ?').get(code) ?? null;
}

export function listByStatus(db, status) {
  return db.prepare('SELECT * FROM devices WHERE status = ? ORDER BY created_at DESC').all(status);
}

export function markApproved(db, deviceId, { label, traccarUserId, token, approvedAt }) {
  db.prepare(`
    UPDATE devices
       SET status = ?, label = ?, traccar_user_id = ?, token = ?, approved_at = ?
     WHERE device_id = ?
  `).run(APPROVED, label, traccarUserId, token, approvedAt, deviceId);
}

export function setToken(db, deviceId, token) {
  db.prepare('UPDATE devices SET token = ? WHERE device_id = ?').run(token, deviceId);
}

export function markRevoked(db, deviceId) {
  db.prepare('UPDATE devices SET status = ?, token = NULL WHERE device_id = ?').run(REVOKED, deviceId);
}

export function touch(db, deviceId, at) {
  db.prepare('UPDATE devices SET last_seen_at = ? WHERE device_id = ?').run(at, deviceId);
}

export function deleteDevice(db, deviceId) {
  db.prepare('DELETE FROM devices WHERE device_id = ?').run(deviceId);
}
```

- [ ] **Step 6: Correr los tests**

Run: `cd traccar/traccar-web/tools/enroll && npm test`
Expected: PASS, 9 tests. Si aparece `ExperimentalWarning: SQLite is an experimental feature`, es benigno — no requiere ningún flag.

- [ ] **Step 7: Commit**

```bash
cd traccar/traccar-web
git add tools/enroll/package.json tools/enroll/.gitignore tools/enroll/src/db.js tools/enroll/test/db.test.js tools/enroll/package-lock.json
git commit -m "Enrolamiento: andamiaje del servicio y esquema SQLite"
```

---

### Task 2: Códigos legibles

**Files:**
- Create: `traccar/traccar-web/tools/enroll/src/codes.js`
- Create: `traccar/traccar-web/tools/enroll/test/codes.test.js`

**Interfaces:**
- Consumes: nada.
- Produces: `generateCode(random?)` → canónico sin guiones (`"RUDA7K4M92QX"`); `normalizeCode(input)` → canónico, tolera lo que tipee una persona; `formatCode(code)` → `"RUDA-7K4M-92QX"` para mostrar.

**Decisión de formato:** el código se guarda **canónico, sin guiones**. Los guiones son solo presentación. Así la búsqueda es una igualdad exacta y no hay que adivinar dónde los puso la persona al tipear.

- [ ] **Step 1: Escribir el test que falla**

`traccar/traccar-web/tools/enroll/test/codes.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateCode, normalizeCode, formatCode } from '../src/codes.js';

test('generateCode tiene el prefijo y el largo esperados', () => {
  const code = generateCode();
  assert.match(code, /^RUDA[A-Z0-9]{8}$/);
});

test('generateCode no usa caracteres ambiguos', () => {
  // Se genera un lote grande: si el alfabeto incluyera I, O, 0 o 1,
  // con 2000 códigos la probabilidad de no verlos es despreciable.
  const todos = Array.from({ length: 2000 }, () => generateCode().slice(4)).join('');
  for (const ambiguo of ['I', 'O', '0', '1']) {
    assert.ok(!todos.includes(ambiguo), `el alfabeto no debe incluir ${ambiguo}`);
  }
});

test('generateCode usa el generador inyectado', () => {
  assert.equal(generateCode(() => 0), 'RUDAAAAAAAAA');
});

test('normalizeCode tolera minúsculas, espacios y guiones', () => {
  assert.equal(normalizeCode('ruda-7k4m-92qx'), 'RUDA7K4M92QX');
  assert.equal(normalizeCode('  RUDA 7K4M 92QX \n'), 'RUDA7K4M92QX');
  assert.equal(normalizeCode('RUDA7K4M92QX'), 'RUDA7K4M92QX');
});

test('normalizeCode no explota con vacío ni con null', () => {
  assert.equal(normalizeCode(''), '');
  assert.equal(normalizeCode(null), '');
  assert.equal(normalizeCode(undefined), '');
});

test('formatCode inserta los guiones para mostrar', () => {
  assert.equal(formatCode('RUDA7K4M92QX'), 'RUDA-7K4M-92QX');
  assert.equal(formatCode('ruda-7k4m-92qx'), 'RUDA-7K4M-92QX');
});

test('formatCode devuelve lo que recibe si no tiene la forma esperada', () => {
  assert.equal(formatCode('cualquier-cosa'), 'CUALQUIERCOSA');
  assert.equal(formatCode(''), '');
});

test('ida y vuelta: formatCode y normalizeCode son inversas', () => {
  const code = generateCode();
  assert.equal(normalizeCode(formatCode(code)), code);
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `cd traccar/traccar-web/tools/enroll && node --test test/codes.test.js`
Expected: FAIL — `Cannot find module '../src/codes.js'`.

- [ ] **Step 3: Implementar `src/codes.js`**

```js
import { randomInt } from 'node:crypto';

// Sin I, O, 0 ni 1: son los que se confunden al dictar un código por teléfono
// o al copiarlo de una captura de pantalla.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PREFIX = 'RUDA';
const BODY_LENGTH = 8;

/**
 * Devuelve el código en forma canónica: mayúsculas, sin separadores.
 * Los guiones son presentación, no parte del dato.
 */
export function generateCode(random = randomInt) {
  let body = '';
  for (let i = 0; i < BODY_LENGTH; i += 1) {
    body += ALPHABET[random(ALPHABET.length)];
  }
  return PREFIX + body;
}

/**
 * Deja cualquier entrada humana en forma canónica. Acepta minúsculas,
 * espacios, guiones y saltos de línea: lo que sale de un mensaje de
 * WhatsApp pegado en el formulario.
 */
export function normalizeCode(input) {
  return String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Presentación: RUDA-7K4M-92QX */
export function formatCode(code) {
  const canonical = normalizeCode(code);
  if (!/^RUDA[A-Z0-9]{8}$/.test(canonical)) {
    return canonical;
  }
  return `${canonical.slice(0, 4)}-${canonical.slice(4, 8)}-${canonical.slice(8, 12)}`;
}
```

- [ ] **Step 4: Correr los tests**

Run: `cd traccar/traccar-web/tools/enroll && node --test test/codes.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
cd traccar/traccar-web
git add tools/enroll/src/codes.js tools/enroll/test/codes.test.js
git commit -m "Enrolamiento: generación y normalización de códigos"
```

---

### Task 3: Cliente de la API de Traccar

**Files:**
- Create: `traccar/traccar-web/tools/enroll/src/traccar.js`
- Create: `traccar/traccar-web/tools/enroll/test/traccar.test.js`

**Interfaces:**
- Consumes: nada.
- Produces: `createTraccarClient({ baseUrl, adminEmail, adminPassword, fetchImpl?, timeoutMs? })` → un objeto con `createUser({ name, email, password })` → `{ id, ... }`, `issueToken(userId, expiration)` → `string`, y `revokeToken(token)` → `boolean`. También `extractSessionCookie(setCookies)` y la clase `TraccarError`.

**Lo que hay que entender antes de escribir esto** (verificado en el backend, spec §6.3):

1. `GET /api/session/{userId}` con Basic auth de admin pasa por `PermissionsService.checkUser`, que autoriza al administrador sobre cualquier usuario, y después llama a `SessionHelper.userLogin`, que **pisa el `USER_ID` de la sesión** con el del usuario destino.
2. `POST /api/session/token` toma ese `USER_ID` y firma un token para él.

Por eso la emisión son **dos** peticiones y no una. Dos detalles que no son obvios y que los tests fijan:

- `userLogin` arranca con `request.getSession().invalidate()`, así que la cookie que devuelve el paso 1 es nueva y es la única válida para el paso 2.
- En el paso 2 **no** hay que mandar `Authorization`. Si se manda, el filtro de seguridad arma el contexto desde esas credenciales y no toca los atributos de la sesión: el token saldría a nombre del admin.

- [ ] **Step 1: Escribir el test que falla**

`traccar/traccar-web/tools/enroll/test/traccar.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTraccarClient, extractSessionCookie, TraccarError } from '../src/traccar.js';

/** Registra las peticiones y devuelve respuestas prefabricadas. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, options) => {
    const path = new URL(url).pathname;
    calls.push({ path, options });
    const route = routes[`${options.method ?? 'GET'} ${path}`];
    if (!route) throw new Error(`ruta no prevista: ${options.method} ${path}`);
    return route(options);
  };
  impl.calls = calls;
  return impl;
}

const json = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });

function client(fetchImpl) {
  return createTraccarClient({
    baseUrl: 'https://traccar.test/',
    adminEmail: 'enroll@rudatrak.com',
    adminPassword: 'secreto-admin',
    fetchImpl,
  });
}

test('extractSessionCookie prefiere JSESSIONID', () => {
  const cookies = ['otra=1; Path=/', 'JSESSIONID=abc123; Path=/; HttpOnly'];
  assert.equal(extractSessionCookie(cookies), 'JSESSIONID=abc123');
});

test('extractSessionCookie cae a la primera cookie si no hay JSESSIONID', () => {
  assert.equal(extractSessionCookie(['sesion=xyz; Path=/']), 'sesion=xyz');
});

test('extractSessionCookie devuelve null sin cookies', () => {
  assert.equal(extractSessionCookie([]), null);
});

test('createUser manda JSON con Basic auth y devuelve el usuario creado', async () => {
  const impl = fakeFetch({
    'POST /api/users': () => json({ id: 42, name: 'Juan', email: 'device-ruda@rudatrak.invalid' }),
  });
  const user = await client(impl).createUser({
    name: 'Juan', email: 'device-ruda@rudatrak.invalid', password: 'pw',
  });

  assert.equal(user.id, 42);
  const [call] = impl.calls;
  assert.equal(call.options.headers['Content-Type'], 'application/json');
  assert.match(call.options.headers.Authorization, /^Basic /);
  const payload = JSON.parse(call.options.body);
  assert.equal(payload.name, 'Juan');
  assert.equal(payload.administrator, false);
});

test('createUser no duplica la barra entre la base y la ruta', async () => {
  const impl = fakeFetch({
    'POST /api/users': () => json({ id: 1 }),
  });
  // baseUrl se pasa con barra final; el cliente debe sacarla.
  await client(impl).createUser({ name: 'x', email: 'y@z.invalid', password: 'p' });
  assert.equal(impl.calls[0].path, '/api/users');
});

test('createUser falla con TraccarError si Traccar responde error', async () => {
  const impl = fakeFetch({
    'POST /api/users': () => new Response('boom', { status: 500 }),
  });
  await assert.rejects(
    () => client(impl).createUser({ name: 'x', email: 'y@z.invalid', password: 'p' }),
    (error) => error instanceof TraccarError && error.status === 500,
  );
});

test('issueToken suplanta la sesión y después pide el token SIN Authorization', async () => {
  const impl = fakeFetch({
    'GET /api/session/42': () =>
      json({ id: 42 }, { headers: { 'Set-Cookie': 'JSESSIONID=sess-1; Path=/; HttpOnly' } }),
    'POST /api/session/token': () => new Response('tok-abc', { status: 200 }),
  });

  const token = await client(impl).issueToken(42, new Date('2027-10-06T00:00:00.000Z'));
  assert.equal(token, 'tok-abc');

  const [impersonate, mint] = impl.calls;
  assert.match(impersonate.options.headers.Authorization, /^Basic /);
  assert.equal(impersonate.options.headers.Cookie, undefined);

  // Lo que hace que el token salga a nombre del usuario y no del admin:
  assert.equal(mint.options.headers.Authorization, undefined);
  assert.equal(mint.options.headers.Cookie, 'JSESSIONID=sess-1');
});

test('issueToken manda la expiración en ISO 8601', async () => {
  const impl = fakeFetch({
    'GET /api/session/42': () =>
      json({ id: 42 }, { headers: { 'Set-Cookie': 'JSESSIONID=s; Path=/' } }),
    'POST /api/session/token': () => new Response('tok', { status: 200 }),
  });
  await client(impl).issueToken(42, new Date('2027-10-06T00:00:00.000Z'));

  const body = new URLSearchParams(impl.calls[1].options.body);
  assert.equal(body.get('expiration'), '2027-10-06T00:00:00.000Z');
});

test('issueToken falla si Traccar no devuelve cookie de sesión', async () => {
  const impl = fakeFetch({
    'GET /api/session/42': () => json({ id: 42 }), // sin Set-Cookie
  });
  await assert.rejects(
    () => client(impl).issueToken(42, new Date()),
    (error) => error instanceof TraccarError && /cookie/i.test(error.message),
  );
});

test('issueToken falla si la suplantación es rechazada', async () => {
  const impl = fakeFetch({
    'GET /api/session/42': () => new Response('denied', { status: 403 }),
  });
  await assert.rejects(
    () => client(impl).issueToken(42, new Date()),
    (error) => error instanceof TraccarError && error.status === 403,
  );
});

test('revokeToken manda el token como formulario', async () => {
  const impl = fakeFetch({
    'POST /api/session/token/revoke': () => new Response(null, { status: 204 }),
  });
  const ok = await client(impl).revokeToken('tok-abc');
  assert.equal(ok, true);
  assert.equal(new URLSearchParams(impl.calls[0].options.body).get('token'), 'tok-abc');
});

test('el mensaje de error nunca incluye las credenciales de admin', async () => {
  const impl = fakeFetch({
    'POST /api/users': () => new Response('boom', { status: 401 }),
  });
  const error = await client(impl)
    .createUser({ name: 'x', email: 'y@z.invalid', password: 'p' })
    .then(() => null, (e) => e);
  assert.ok(error);
  assert.ok(!String(error.message).includes('secreto-admin'));
  assert.ok(!String(error.body).includes('secreto-admin'));
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `cd traccar/traccar-web/tools/enroll && node --test test/traccar.test.js`
Expected: FAIL — `Cannot find module '../src/traccar.js'`.

- [ ] **Step 3: Implementar `src/traccar.js`**

```js
const DEFAULT_TIMEOUT_MS = 15000;

export class TraccarError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'TraccarError';
    this.status = status;
    this.body = body;
  }
}

/**
 * De una lista de cabeceras Set-Cookie elige la de sesión.
 * Prefiere JSESSIONID, que es la de Jetty; si Traccar la renombrara,
 * cae a la primera cookie con nombre y valor.
 */
export function extractSessionCookie(setCookies) {
  const pairs = (setCookies ?? [])
    .map((raw) => String(raw).split(';')[0].trim())
    .filter((pair) => pair.includes('='));
  return pairs.find((pair) => /^JSESSIONID=/i.test(pair)) ?? pairs[0] ?? null;
}

async function failure(prefix, response) {
  // El cuerpo puede traer la traza de Traccar. No se propaga tal cual a la
  // interfaz, pero sí se guarda para los registros del servidor.
  let body = '';
  try {
    body = await response.text();
  } catch {
    body = '';
  }
  return new TraccarError(`${prefix} (HTTP ${response.status})`, {
    status: response.status,
    body: body.slice(0, 2000),
  });
}

export function createTraccarClient({
  baseUrl,
  adminEmail,
  adminPassword,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const root = String(baseUrl).replace(/\/+$/, '');
  const basic = `Basic ${Buffer.from(`${adminEmail}:${adminPassword}`).toString('base64')}`;

  async function request(path, { method = 'GET', body, contentType, cookie, auth = true } = {}) {
    const headers = { Accept: 'application/json' };
    if (contentType) {
      headers['Content-Type'] = contentType;
    }
    if (auth) {
      headers.Authorization = basic;
    }
    if (cookie) {
      headers.Cookie = cookie;
    }
    return fetchImpl(`${root}${path}`, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function createUser({ name, email, password }) {
    const response = await request('/api/users', {
      method: 'POST',
      contentType: 'application/json',
      // administrator en false explícito: no dependemos del valor por defecto.
      // deviceLimit 0 = sin límite; el alta por admin no pasa por
      // UserUtil.setUserDefaults, así que lo fijamos nosotros.
      body: JSON.stringify({ name, email, password, administrator: false, deviceLimit: 0 }),
    });
    if (!response.ok) {
      throw await failure('No se pudo crear el usuario en Traccar', response);
    }
    const user = await response.json();
    if (!user?.id) {
      throw new TraccarError('Traccar devolvió un usuario sin id');
    }
    return user;
  }

  /**
   * Emite un token para `userId` sin conocer su contraseña.
   *
   * Paso 1: como admin, `GET /api/session/{id}` pisa el USER_ID de la sesión
   *         con el del usuario destino y devuelve una cookie nueva.
   * Paso 2: `POST /api/session/token` firma el token para el dueño de esa
   *         sesión. Va SIN Authorization a propósito: el filtro de seguridad
   *         de Traccar, cuando ve esa cabecera, no lee ni escribe los
   *         atributos de la sesión, y el token saldría a nombre del admin.
   */
  async function issueToken(userId, expiration) {
    const impersonated = await request(`/api/session/${encodeURIComponent(userId)}`);
    if (!impersonated.ok) {
      throw await failure(`No se pudo suplantar la sesión del usuario ${userId}`, impersonated);
    }
    await impersonated.text();

    const cookie = extractSessionCookie(
      typeof impersonated.headers.getSetCookie === 'function'
        ? impersonated.headers.getSetCookie()
        : [impersonated.headers.get('set-cookie')].filter(Boolean),
    );
    if (!cookie) {
      throw new TraccarError('Traccar no devolvió la cookie de sesión al suplantar');
    }

    const response = await request('/api/session/token', {
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      body: new URLSearchParams({ expiration: new Date(expiration).toISOString() }).toString(),
      cookie,
      auth: false,
    });
    if (!response.ok) {
      throw await failure('No se pudo emitir el token', response);
    }
    const token = (await response.text()).trim();
    if (!token) {
      throw new TraccarError('Traccar devolvió un token vacío');
    }
    return token;
  }

  async function revokeToken(token) {
    const response = await request('/api/session/token/revoke', {
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      body: new URLSearchParams({ token }).toString(),
    });
    return response.ok;
  }

  return { createUser, issueToken, revokeToken };
}
```

- [ ] **Step 4: Correr los tests**

Run: `cd traccar/traccar-web/tools/enroll && node --test test/traccar.test.js`
Expected: PASS, 11 tests.

Nota: el test `'createUser usa la URL base sin barra final duplicada'` verifica que la barra final de `baseUrl` no se duplique. Si `fetchImpl` recibe la URL como primer argumento, `options.url` es `undefined` — eso es lo que afirma el test, y el `path` correcto lo confirma.

- [ ] **Step 5: Commit**

```bash
cd traccar/traccar-web
git add tools/enroll/src/traccar.js tools/enroll/test/traccar.test.js
git commit -m "Enrolamiento: cliente de la API de Traccar con emisión por suplantación"
```

---

### Task 4: Servicio — alta de pedido y consulta de estado

**Files:**
- Create: `traccar/traccar-web/tools/enroll/src/enrollService.js`
- Create: `traccar/traccar-web/tools/enroll/test/helpers.js`
- Create: `traccar/traccar-web/tools/enroll/test/enrollService.test.js`

**Interfaces:**
- Consumes: `openDb`, `hashSecret`, `insertDevice`, `getByDeviceId`, `getByCode`, `setToken`, `markApproved`, `markRevoked`, `touch`, `deleteDevice`, `PENDING`, `APPROVED`, `REVOKED` de `./db.js` (Tarea 1); `generateCode`, `normalizeCode` de `./codes.js` (Tarea 2).
- Produces: `createEnrollService({ db, traccar, now?, codeTtlHours?, tokenDays? })` → objeto con `requestEnrollment`, `getStatus`, `approve`, `renew`, `revoke`, `rebind`. También `EnrollError` (con `status` HTTP) y los helpers `effectiveStatus(device, now)` y `expirationInDays(days, now)`.

**Regla de vencimiento:** no hay tarea programada. El vencimiento del código se calcula **al leer**, no se escribe: un `pending` cuyo `code_expires_at` ya pasó se reporta como `expired`. Así no hace falta ningún proceso de fondo.

Esta tarea implementa solo `requestEnrollment` y `getStatus`. Las otras cuatro operaciones se agregan en las Tareas 6 a 9, cada una con su test.

- [ ] **Step 1: Escribir los helpers compartidos**

`traccar/traccar-web/tools/enroll/test/helpers.js`:

```js
import { openDb } from '../src/db.js';
import { createEnrollService } from '../src/enrollService.js';

/** Reloj fijo: todos los tests calculan vencimientos a partir de acá. */
export const T0 = new Date('2026-10-06T12:00:00.000Z');

/** Traccar de mentira. Anota cada llamada en `calls`. */
export function fakeTraccar(overrides = {}) {
  const calls = [];
  const base = {
    async createUser(payload) {
      calls.push({ op: 'createUser', payload });
      return { id: 42, ...payload };
    },
    async issueToken(userId, expiration) {
      calls.push({ op: 'issueToken', userId, expiration });
      return `tok-${userId}-${calls.length}`;
    },
    async revokeToken(token) {
      calls.push({ op: 'revokeToken', token });
      return true;
    },
  };
  return Object.assign(base, overrides, { calls });
}

/** Servicio sobre una base en memoria, con reloj controlable. */
export function serviceFor({ now, traccar = fakeTraccar(), db = openDb(':memory:') } = {}) {
  const service = createEnrollService({ db, traccar, now });
  return { service, db, traccar };
}
```

Este archivo **no** se llama `*.test.js` a propósito: `node --test test/` solo levanta los que terminan en `.test.js`, y si los helpers vivieran dentro de uno de ellos, importarlos desde otro archivo duplicaría la ejecución de sus tests.

- [ ] **Step 2: Escribir el test que falla**

`traccar/traccar-web/tools/enroll/test/enrollService.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashSecret, APPROVED, PENDING } from '../src/db.js';
import { EnrollError, effectiveStatus, expirationInDays } from '../src/enrollService.js';
import { T0, serviceFor } from './helpers.js';

test('effectiveStatus respeta el estado guardado', () => {
  assert.equal(effectiveStatus({ status: APPROVED, code_expires_at: '2026-10-08T12:00:00.000Z' }, T0), APPROVED);
  assert.equal(effectiveStatus({ status: 'revoked', code_expires_at: '2026-10-08T12:00:00.000Z' }, T0), 'revoked');
});

test('effectiveStatus reporta expired si el código pendiente venció', () => {
  const device = { status: PENDING, code_expires_at: '2026-10-06T11:59:59.000Z' };
  assert.equal(effectiveStatus(device, T0), 'expired');
});

test('effectiveStatus no vence un código que todavía sirve', () => {
  const device = { status: PENDING, code_expires_at: '2026-10-06T12:00:01.000Z' };
  assert.equal(effectiveStatus(device, T0), PENDING);
});

test('expirationInDays suma días exactos', () => {
  assert.equal(expirationInDays(365, T0).toISOString(), '2027-10-06T12:00:00.000Z');
});

test('requestEnrollment crea un pedido pendiente con código y vencimiento', async () => {
  const { service, db } = serviceFor({ now: () => T0 });

  const device = await service.requestEnrollment({ secret: 'secreto-juan', note: 'tester' });

  assert.match(device.code, /^RUDA[A-Z0-9]{8}$/);
  assert.equal(device.status, PENDING);
  assert.equal(device.note, 'tester');
  assert.equal(device.code_expires_at, '2026-10-08T12:00:00.000Z');
  assert.equal(device.traccar_user_id, null);
  // El secreto no quedó guardado en ninguna columna.
  assert.ok(!JSON.stringify(device).includes('secreto-juan'));
  assert.ok(db.prepare('SELECT * FROM devices').all().length === 1);
});

test('requestEnrollment es idempotente con el mismo secreto', async () => {
  const { service, db } = serviceFor({ now: () => T0 });

  const primero = await service.requestEnrollment({ secret: 'secreto-juan' });
  const segundo = await service.requestEnrollment({ secret: 'secreto-juan' });

  assert.equal(segundo.code, primero.code);
  assert.equal(db.prepare('SELECT * FROM devices').all().length, 1);
});

test('getStatus devuelve el código sin el token', async () => {
  const { service } = serviceFor({ now: () => T0 });
  await service.requestEnrollment({ secret: 'secreto-juan' });

  const status = await service.getStatus(hashSecret('secreto-juan'));

  assert.equal(status.status, PENDING);
  assert.ok(!('token' in status));
});

test('getStatus de un dispositivo desconocido da 404', async () => {
  const { service } = serviceFor({ now: () => T0 });
  await assert.rejects(
    () => service.getStatus(hashSecret('no-existe')),
    (error) => error instanceof EnrollError && error.status === 404,
  );
});
```

El helper `approvedFixture` no va en este archivo: necesita `service.approve`, que llega en la Tarea 6, así que se agrega en esa tarea.

- [ ] **Step 3: Correr el test para verificar que falla**

Run: `cd traccar/traccar-web/tools/enroll && node --test test/enrollService.test.js`
Expected: FAIL — `Cannot find module '../src/enrollService.js'`.

- [ ] **Step 4: Implementar el núcleo de `src/enrollService.js`**

```js
import { randomBytes } from 'node:crypto';
import {
  hashSecret, insertDevice, getByDeviceId, getByCode, setToken,
  markApproved, markRevoked, touch, deleteDevice,
  PENDING, APPROVED, REVOKED,
} from './db.js';
import { generateCode, normalizeCode } from './codes.js';

const CODE_TTL_HOURS = 48;
const TOKEN_DAYS = 365;
const MAX_CODE_ATTEMPTS = 5;

/** Error con status HTTP, para que las rutas lo traduzcan sin adivinar. */
export class EnrollError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'EnrollError';
    this.status = status;
  }
}

/**
 * El vencimiento del código se calcula al leer, no se escribe: no hay
 * tarea programada que recorra la base.
 */
export function effectiveStatus(device, now) {
  if (device.status === PENDING && new Date(device.code_expires_at) <= now) {
    return 'expired';
  }
  return device.status;
}

export function expirationInDays(days, from) {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * La dirección nunca recibe correo: .invalid está reservado por la RFC 2606
 * justamente para esto. Traccar no valida el formato (User.java no tiene
 * anotación de email), así que alcanza con que sea única.
 */
function emailForCode(code) {
  return `device-${code.toLowerCase()}@rudatrak.invalid`;
}

export function createEnrollService({
  db,
  traccar,
  now = () => new Date(),
  codeTtlHours = CODE_TTL_HOURS,
  tokenDays = TOKEN_DAYS,
}) {
  function pickUnusedCode() {
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i += 1) {
      const candidate = generateCode();
      if (!getByCode(db, candidate)) {
        return candidate;
      }
    }
    throw new EnrollError('No se pudo generar un código libre', 500);
  }

  async function requestEnrollment({ secret, note }) {
    if (!secret) {
      throw new EnrollError('Falta el secreto del dispositivo');
    }
    const deviceId = hashSecret(secret);
    const existing = getByDeviceId(db, deviceId);
    if (existing) {
      return existing;
    }

    const createdAt = now();
    insertDevice(db, {
      deviceId,
      code: pickUnusedCode(),
      note,
      createdAt: createdAt.toISOString(),
      codeExpiresAt: expirationInDays(codeTtlHours / 24, createdAt).toISOString(),
    });
    return getByDeviceId(db, deviceId);
  }

  async function getStatus(deviceId) {
    const device = getByDeviceId(db, deviceId);
    if (!device) {
      throw new EnrollError('Dispositivo desconocido', 404);
    }
    const { token, ...safe } = device;
    return { ...safe, status: effectiveStatus(device, now()) };
  }

  return { requestEnrollment, getStatus };
}
```

- [ ] **Step 5: Correr los tests**

Run: `cd traccar/traccar-web/tools/enroll && node --test test/enrollService.test.js`
Expected: PASS, los 8 tests de esta tarea y de la anterior.

- [ ] **Step 6: Commit**

```bash
cd traccar/traccar-web
git add tools/enroll/src/enrollService.js tools/enroll/test/helpers.js tools/enroll/test/enrollService.test.js
git commit -m "Enrolamiento: alta de pedidos y consulta de estado"
```

---

### Task 5: Rutas públicas `/enroll/*`

**Files:**
- Create: `traccar/traccar-web/tools/enroll/src/auth.js`
- Create: `traccar/traccar-web/tools/enroll/src/enrollRoutes.js`
- Create: `traccar/traccar-web/tools/enroll/src/server.js`
- Create: `traccar/traccar-web/tools/enroll/test/enrollRoutes.test.js`

**Interfaces:**
- Consumes: `hashSecret` de `./db.js`; `createEnrollService`, `EnrollError` de `./enrollService.js`; `createTraccarClient` de `./traccar.js`.
- Produces: `requireDeviceSecret(db)` → middleware de Express que deja `req.device`; `createEnrollRouter({ service, db })` → `express.Router`; `createServer({ db, traccar, service })` → app de Express; `loadConfig(env)` → objeto de configuración.

- [ ] **Step 1: Escribir el test que falla**

`traccar/traccar-web/tools/enroll/test/enrollRoutes.test.js`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createEnrollService } from '../src/enrollService.js';
import { createServer } from '../src/server.js';
import { fakeTraccar } from './helpers.js';

let server;
let base;
let db;

before(async () => {
  db = openDb(':memory:');
  const traccar = fakeTraccar();
  const service = createEnrollService({ db, traccar, now: () => new Date('2026-10-06T12:00:00.000Z') });
  const app = createServer({ db, traccar, service, adminUser: 'rodrigo', adminPassword: 'pw-admin' });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

test('POST /enroll/request devuelve un código formateado y sin secreto', async () => {
  const response = await fetch(`${base}/enroll/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'secreto-de-pedro', note: 'Pedro' }),
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.match(body.code, /^RUDA-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(body.status, 'pending');
  assert.ok(!JSON.stringify(body).includes('secreto-de-pedro'));
  assert.ok(!('token' in body));
});

test('POST /enroll/request sin secreto da 400', async () => {
  const response = await fetch(`${base}/enroll/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 400);
});

test('GET /enroll/status sin cabecera da 401', async () => {
  const response = await fetch(`${base}/enroll/status`);
  assert.equal(response.status, 401);
});

test('GET /enroll/status con un secreto desconocido da 401 y no 404', async () => {
  const response = await fetch(`${base}/enroll/status`, {
    headers: { Authorization: 'Bearer secreto-que-nadie-registro' },
  });
  assert.equal(response.status, 401);
});

test('GET /enroll/status devuelve el estado del dispositivo', async () => {
  await fetch(`${base}/enroll/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'secreto-de-ana' }),
  });

  const response = await fetch(`${base}/enroll/status`, {
    headers: { Authorization: 'Bearer secreto-de-ana' },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'pending');
  assert.match(body.code, /^RUDA-/);
  assert.ok(!('token' in body));
});

test('el esquema de la cabecera no distingue mayúsculas', async () => {
  await fetch(`${base}/enroll/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'secreto-de-luis' }),
  });

  const response = await fetch(`${base}/enroll/status`, {
    headers: { Authorization: 'bearer secreto-de-luis' },
  });
  assert.equal(response.status, 200);
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `cd traccar/traccar-web/tools/enroll && node --test test/enrollRoutes.test.js`
Expected: FAIL — `Cannot find module '../src/server.js'`.

- [ ] **Step 3: Implementar `src/auth.js`**

```js
import { hashSecret, getByDeviceId } from './db.js';

function readBearer(request) {
  const header = request.get('authorization') ?? '';
  const separator = header.indexOf(' ');
  if (separator === -1) {
    return null;
  }
  const [scheme, value] = [header.slice(0, separator), header.slice(separator + 1)];
  if (scheme.toLowerCase() !== 'bearer') {
    return null;
  }
  const secret = value.trim();
  return secret || null;
}

/**
 * Resuelve el dispositivo desde su secreto y lo deja en `req.device`.
 * Un secreto desconocido da 401, nunca 404: no confirmamos si un
 * dispositivo existe o no.
 */
export function requireDeviceSecret(db) {
  return (request, response, next) => {
    const secret = readBearer(request);
    if (!secret) {
      return response.status(401).json({ error: 'Falta el secreto del dispositivo' });
    }
    const device = getByDeviceId(db, hashSecret(secret));
    if (!device) {
      return response.status(401).json({ error: 'Dispositivo no reconocido' });
    }
    request.device = device;
    return next();
  };
}
```

- [ ] **Step 4: Implementar `src/enrollRoutes.js`**

```js
import express from 'express';
import { requireDeviceSecret } from './auth.js';
import { formatCode, normalizeCode } from './codes.js';

/** Vista pública de un dispositivo: nunca incluye el token. */
function publicView(device) {
  return {
    code: formatCode(device.code),
    status: device.status,
    label: device.label ?? null,
    createdAt: device.created_at,
    approvedAt: device.approved_at ?? null,
  };
}

export function createEnrollRouter({ service, db }) {
  const router = express.Router();

  router.post('/request', async (request, response, next) => {
    try {
      const device = await service.requestEnrollment({
        secret: request.body?.secret,
        note: request.body?.note,
      });
      return response.json({
        ...publicView(device),
        status: device.status === 'pending' ? 'pending' : device.status,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/status', requireDeviceSecret(db), async (request, response, next) => {
    try {
      const status = await service.getStatus(request.device.device_id);
      // El token solo se entrega cuando el enrolamiento está aprobado.
      const payload = publicView(status);
      if (status.status === 'approved' && request.device.token) {
        payload.token = request.device.token;
      }
      return response.json(payload);
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
```

Nota sobre `normalizeCode`: en esta tarea todavía no se usa acá (el código entra por `/admin`). El import queda para la Tarea 6; si el linter se queja, quitarlo ahora y volver a agregarlo en la Tarea 6.

- [ ] **Step 5: Implementar `src/server.js`**

```js
import express from 'express';
import { openDb } from './db.js';
import { createTraccarClient } from './traccar.js';
import { createEnrollService } from './enrollService.js';
import { createEnrollRouter } from './enrollRoutes.js';
import { EnrollError } from './enrollService.js';

export function loadConfig(env = process.env) {
  const required = ['TRACCAR_URL', 'TRACCAR_ADMIN_EMAIL', 'TRACCAR_ADMIN_PASSWORD', 'ENROLL_ADMIN_PASSWORD'];
  const missing = required.filter((key) => !env[key]);
  if (missing.length) {
    throw new Error(`Faltan variables de entorno: ${missing.join(', ')}`);
  }
  return {
    port: Number(env.PORT ?? 3008),
    dbPath: env.DB_PATH ?? './data/enroll.db',
    traccarUrl: env.TRACCAR_URL,
    traccarAdminEmail: env.TRACCAR_ADMIN_EMAIL,
    traccarAdminPassword: env.TRACCAR_ADMIN_PASSWORD,
    adminUser: env.ENROLL_ADMIN_USER ?? 'admin',
    adminPassword: env.ENROLL_ADMIN_PASSWORD,
  };
}

export function createServer({ db, traccar, service, adminUser, adminPassword }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use(express.urlencoded({ extended: false }));

  app.get('/health', (request, response) => response.json({ status: 'ok' }));
  app.use('/enroll', createEnrollRouter({ service, db }));

  // Los errores de negocio salen con su status; el resto, como 500 sin
  // filtrar detalles internos al cliente.
  app.use((error, request, response, next) => {
    if (response.headersSent) {
      return next(error);
    }
    if (error instanceof EnrollError) {
      return response.status(error.status).json({ error: error.message });
    }
    console.error(`[enroll] error inesperado en ${request.method} ${request.path}:`, error);
    return response.status(500).json({ error: 'Error interno' });
  });

  return app;
}

export function buildApp(config) {
  const db = openDb(config.dbPath);
  const traccar = createTraccarClient({
    baseUrl: config.traccarUrl,
    adminEmail: config.traccarAdminEmail,
    adminPassword: config.traccarAdminPassword,
  });
  const service = createEnrollService({ db, traccar });
  return createServer({ db, traccar, service, adminUser: config.adminUser, adminPassword: config.adminPassword });
}

// Arranque real. No se ejecuta al importar, así los tests pueden usar
// createServer sin abrir un puerto.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  buildApp(config).listen(config.port, () => {
    console.log(`[enroll] escuchando en el puerto ${config.port}`);
  });
}
```

- [ ] **Step 6: Correr los tests**

Run: `cd traccar/traccar-web/tools/enroll && npm test`
Expected: PASS. Los 6 tests de `enrollRoutes.test.js` y los de las tareas anteriores.

- [ ] **Step 7: Commit**

```bash
cd traccar/traccar-web
git add tools/enroll/src/auth.js tools/enroll/src/enrollRoutes.js tools/enroll/src/server.js tools/enroll/test/enrollRoutes.test.js
git commit -m "Enrolamiento: rutas públicas de pedido y estado"
```

---

### Task 6: Aprobación y página de administración

**Files:**
- Modify: `traccar/traccar-web/tools/enroll/src/db.js` (agregar `setTraccarUser`)
- Modify: `traccar/traccar-web/tools/enroll/src/enrollService.js` (agregar `approve`)
- Modify: `traccar/traccar-web/tools/enroll/test/enrollService.test.js` (agregar `approvedFixture`, el test de re-pedido y los de `approve`)
- Create: `traccar/traccar-web/tools/enroll/src/adminAuth.js`
- Create: `traccar/traccar-web/tools/enroll/src/adminPage.js`
- Create: `traccar/traccar-web/tools/enroll/src/adminRoutes.js`
- Modify: `traccar/traccar-web/tools/enroll/src/server.js` (montar `/admin`)
- Create: `traccar/traccar-web/tools/enroll/test/admin.test.js`

**Interfaces:**
- Consumes: todo lo de las tareas 1 a 5.
- Produces: `setTraccarUser(db, deviceId, traccarUserId, label)`; `service.approve({ code, label })` → registro aprobado; `requireAdmin({ user, password })` → middleware; `renderAdminPage({ pending, approved })` → HTML; `createAdminRouter({ service, db, adminUser, adminPassword })`.

**Review Focus cubierto acá:** doble aprobación, Traccar caído a mitad de camino, código vencido o inventado, y código tipeado por una persona.

**Decisión que resuelve el caso "Traccar caído a mitad de la aprobación":** el `traccar_user_id` se guarda en la base **apenas se crea el usuario**, antes de pedir el token. Si la emisión falla, el registro queda pendiente pero con el usuario ya anotado, y el reintento lo reutiliza en vez de crear un usuario huérfano nuevo. Sin esto, cada reintento acumularía basura en Traccar.

- [ ] **Step 1: Escribir los tests de `approve` que fallan**

Agregar al final de `test/enrollService.test.js`. Este bloque incluye el helper `approvedFixture`, que las Tareas 7, 8 y 9 reutilizan, y el test de re-pedido de un dispositivo ya aprobado, que no podía vivir en la Tarea 4 porque necesita `approve`:

```js
/** Deja un dispositivo aprobado y listo, para los tests que lo necesitan. */
export async function approvedFixture(service, secret = 'secreto-juan', label = 'Juan') {
  await service.requestEnrollment({ secret });
  const pending = await service.getStatus(hashSecret(secret));
  const device = await service.approve({ code: pending.code, label });
  return { device, secret };
}

test('requestEnrollment devuelve el registro existente si ya está aprobado', async () => {
  const { service } = serviceFor({ now: () => T0 });
  const { device } = await approvedFixture(service);

  const otraVez = await service.requestEnrollment({ secret: 'secreto-juan' });
  assert.equal(otraVez.status, APPROVED);
  assert.equal(otraVez.device_id, device.device_id);
});

test('approve crea el usuario, emite el token y deja el registro aprobado', async () => {
  const { service, traccar } = serviceFor({ now: () => T0 });
  await service.requestEnrollment({ secret: 'secreto-juan' });
  const pending = await service.getStatus(hashSecret('secreto-juan'));

  const device = await service.approve({ code: pending.code, label: 'Juan' });

  assert.equal(device.status, APPROVED);
  assert.equal(device.label, 'Juan');
  assert.equal(device.traccar_user_id, 42);
  assert.ok(device.token);
  assert.deepEqual(traccar.calls.map((c) => c.op), ['createUser', 'issueToken']);
  assert.equal(traccar.calls[1].userId, 42);
});

test('approve acepta el código tipeado por una persona', async () => {
  const { service } = serviceFor({ now: () => T0 });
  await service.requestEnrollment({ secret: 'secreto-juan' });
  const pending = await service.getStatus(hashSecret('secreto-juan'));

  const tipeado = `  ${pending.code.toLowerCase().replace(/-/g, ' ')} \n`;
  const device = await service.approve({ code: tipeado, label: 'Juan' });
  assert.equal(device.status, APPROVED);
});

test('approve rechaza un código desconocido sin tocar Traccar', async () => {
  const { service, traccar } = serviceFor({ now: () => T0 });
  await assert.rejects(
    () => service.approve({ code: 'RUDAZZZZZZZZ', label: 'Nadie' }),
    (error) => error instanceof EnrollError && error.status === 404,
  );
  assert.equal(traccar.calls.length, 0);
});

test('approve rechaza un código vencido sin tocar Traccar', async () => {
  let reloj = T0;
  const { service, traccar } = serviceFor({ now: () => reloj });
  await service.requestEnrollment({ secret: 'secreto-juan' });
  const pending = await service.getStatus(hashSecret('secreto-juan'));

  reloj = new Date('2026-10-09T12:00:00.000Z'); // tres días después

  await assert.rejects(
    () => service.approve({ code: pending.code, label: 'Juan' }),
    (error) => error instanceof EnrollError && error.status === 410,
  );
  assert.equal(traccar.calls.length, 0);
});

test('approve dos veces no crea un segundo usuario en Traccar', async () => {
  const { service, db, traccar } = serviceFor({ now: () => T0 });
  await service.requestEnrollment({ secret: 'secreto-juan' });
  const pending = await service.getStatus(hashSecret('secreto-juan'));

  const primero = await service.approve({ code: pending.code, label: 'Juan' });
  await assert.rejects(
    () => service.approve({ code: pending.code, label: 'Juan' }),
    (error) => error instanceof EnrollError && error.status === 409,
  );

  assert.equal(traccar.calls.filter((c) => c.op === 'createUser').length, 1);
  // El rechazo no pisó nada de lo que dejó la primera aprobación.
  const row = db.prepare('SELECT * FROM devices').get();
  assert.equal(row.token, primero.token);
  assert.equal(row.traccar_user_id, 42);
});

test('si falla la emisión del token el registro NO queda aprobado', async () => {
  const traccar = fakeTraccar({
    async issueToken() {
      throw new Error('Traccar no responde');
    },
  });
  const { service, db } = serviceFor({ now: () => T0, traccar });
  await service.requestEnrollment({ secret: 'secreto-juan' });
  const pending = await service.getStatus(hashSecret('secreto-juan'));

  await assert.rejects(() => service.approve({ code: pending.code, label: 'Juan' }));

  const row = db.prepare('SELECT * FROM devices').get();
  assert.equal(row.status, 'pending');
  assert.equal(row.approved_at, null);
  assert.equal(row.token, null);
  // Pero el usuario ya creado quedó anotado, para no duplicarlo al reintentar.
  assert.equal(row.traccar_user_id, 42);
});

test('el reintento después de un fallo reutiliza el usuario ya creado', async () => {
  let falla = true;
  const traccar = fakeTraccar({
    async issueToken(userId, expiration) {
      traccar.calls.push({ op: 'issueToken', userId, expiration });
      if (falla) {
        throw new Error('Traccar no responde');
      }
      return 'tok-recuperado';
    },
  });
  const { service } = serviceFor({ now: () => T0, traccar });
  await service.requestEnrollment({ secret: 'secreto-juan' });
  const pending = await service.getStatus(hashSecret('secreto-juan'));

  await assert.rejects(() => service.approve({ code: pending.code, label: 'Juan' }));
  falla = false;
  const device = await service.approve({ code: pending.code, label: 'Juan' });

  assert.equal(device.status, APPROVED);
  assert.equal(device.token, 'tok-recuperado');
  assert.equal(traccar.calls.filter((c) => c.op === 'createUser').length, 1);
});

test('la contraseña generada no queda guardada en ningún lado', async () => {
  const { service, db, traccar } = serviceFor({ now: () => T0 });
  await service.requestEnrollment({ secret: 'secreto-juan' });
  const pending = await service.getStatus(hashSecret('secreto-juan'));
  await service.approve({ code: pending.code, label: 'Juan' });

  const password = traccar.calls[0].payload.password;
  assert.ok(password.length >= 32);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM devices').all()).includes(password));
});
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

Run: `cd traccar/traccar-web/tools/enroll && node --test test/enrollService.test.js`
Expected: FAIL — `service.approve is not a function`.

- [ ] **Step 3: Agregar `setTraccarUser` a `src/db.js`**

```js
/**
 * Anota el usuario de Traccar apenas se crea, antes de emitir el token.
 * Si la emisión falla, el reintento reutiliza este id en vez de crear
 * un usuario huérfano nuevo.
 */
export function setTraccarUser(db, deviceId, traccarUserId, label) {
  db.prepare('UPDATE devices SET traccar_user_id = ?, label = ? WHERE device_id = ?')
    .run(traccarUserId, label, deviceId);
}
```

- [ ] **Step 4: Agregar `approve` a `src/enrollService.js`**

Actualizar el import de `./db.js` para incluir `setTraccarUser`, y agregar la función antes del `return`:

```js
  async function approve({ code, label }) {
    const device = getByCode(db, normalizeCode(code));
    if (!device) {
      throw new EnrollError('Código desconocido', 404);
    }
    if (device.status === APPROVED) {
      throw new EnrollError('Ese dispositivo ya está aprobado', 409);
    }
    if (device.status === REVOKED) {
      throw new EnrollError('Ese dispositivo fue revocado', 409);
    }
    if (effectiveStatus(device, now()) === 'expired') {
      throw new EnrollError('El código venció, pedile uno nuevo', 410);
    }

    let userId = device.traccar_user_id;
    if (!userId) {
      // Se genera y se usa en esta llamada. No se guarda ni se registra:
      // el token se emite por suplantación, así que no hace falta después.
      const password = randomBytes(32).toString('base64url');
      const user = await traccar.createUser({
        name: label,
        email: emailForCode(device.code),
        password,
      });
      userId = user.id;
      setTraccarUser(db, device.device_id, userId, label);
    }

    const token = await traccar.issueToken(userId, expirationInDays(tokenDays, now()));
    markApproved(db, device.device_id, {
      label,
      traccarUserId: userId,
      token,
      approvedAt: now().toISOString(),
    });
    return getByDeviceId(db, device.device_id);
  }
```

Y sumar `approve` al objeto que devuelve `createEnrollService`.

- [ ] **Step 5: Correr los tests de la capa de servicio**

Run: `cd traccar/traccar-web/tools/enroll && node --test test/enrollService.test.js`
Expected: PASS, todos.

- [ ] **Step 6: Implementar `src/adminAuth.js`**

```js
import { timingSafeEqual } from 'node:crypto';

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

/** Basic auth del administrador del servicio (no de Traccar). */
export function requireAdmin({ user, password }) {
  return (request, response, next) => {
    const header = request.get('authorization') ?? '';
    if (!header.toLowerCase().startsWith('basic ')) {
      return response.status(401).set('WWW-Authenticate', 'Basic realm="rudatrak-enroll"').send('Autenticación requerida');
    }
    const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    const givenUser = separator === -1 ? decoded : decoded.slice(0, separator);
    const givenPassword = separator === -1 ? '' : decoded.slice(separator + 1);

    // Las dos comparaciones se evalúan siempre, para no filtrar por tiempo
    // cuál de los dos campos falló.
    const userOk = safeEqual(givenUser, user);
    const passwordOk = safeEqual(givenPassword, password);
    if (!userOk || !passwordOk) {
      return response.status(401).set('WWW-Authenticate', 'Basic realm="rudatrak-enroll"').send('Credenciales inválidas');
    }
    return next();
  };
}
```

- [ ] **Step 7: Implementar `src/adminPage.js`**

```js
import { formatCode } from './codes.js';

function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function row(device) {
  const when = escape(device.created_at?.slice(0, 16).replace('T', ' ') ?? '');
  return `
    <tr>
      <td><code>${escape(formatCode(device.code))}</code></td>
      <td>${escape(device.note ?? '—')}</td>
      <td>${when}</td>
      <td>
        <form method="POST" action="/admin/approve">
          <input type="hidden" name="code" value="${escape(device.code)}">
          <input name="label" placeholder="Nombre" required>
          <button type="submit">Aprobar</button>
        </form>
      </td>
    </tr>`;
}

function approvedRow(device) {
  return `
    <tr>
      <td>${escape(device.label ?? '—')}</td>
      <td><code>${escape(device.device_id.slice(0, 12))}…</code></td>
      <td>${escape(device.approved_at?.slice(0, 16).replace('T', ' ') ?? '')}</td>
      <td>
        <form method="POST" action="/admin/rebind">
          <input type="hidden" name="target" value="${escape(device.device_id)}">
          <input name="code" placeholder="Código del teléfono nuevo" required>
          <button type="submit">Re-enrolar</button>
        </form>
        <form method="POST" action="/admin/revoke"
              onsubmit="return confirm('¿Revocar el acceso de este dispositivo?')">
          <input type="hidden" name="device_id" value="${escape(device.device_id)}">
          <button type="submit">Revocar</button>
        </form>
      </td>
    </tr>`;
}

export function renderAdminPage({ pending, approved, message }) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Enrolamientos — RudaTrak</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0 auto; max-width: 60rem; padding: 1.5rem; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 2rem; }
  th, td { border-bottom: 1px solid #ddd; padding: .5rem; text-align: left; vertical-align: top; }
  form { display: inline-flex; gap: .25rem; }
  input, button { padding: .35rem .5rem; font: inherit; }
  .msg { background: #eef; padding: .75rem 1rem; border-radius: .25rem; margin-bottom: 1rem; }
  code { background: #f4f4f4; padding: .1rem .3rem; }
</style>
</head>
<body>
  <h1>Enrolamientos</h1>
  ${message ? `<p class="msg">${escape(message)}</p>` : ''}
  <h2>Pendientes (${pending.length})</h2>
  <table>
    <thead><tr><th>Código</th><th>Nota</th><th>Pedido</th><th>Aprobar</th></tr></thead>
    <tbody>${pending.map(row).join('') || '<tr><td colspan="4">Sin pedidos pendientes</td></tr>'}</tbody>
  </table>
  <h2>Aprobados (${approved.length})</h2>
  <table>
    <thead><tr><th>Nombre</th><th>Dispositivo</th><th>Aprobado</th><th>Acciones</th></tr></thead>
    <tbody>${approved.map(approvedRow).join('') || '<tr><td colspan="4">Sin dispositivos aprobados</td></tr>'}</tbody>
  </table>
</body>
</html>`;
}
```

- [ ] **Step 8: Implementar `src/adminRoutes.js`**

```js
import express from 'express';
import { listByStatus, PENDING, APPROVED } from './db.js';
import { requireAdmin } from './adminAuth.js';
import { renderAdminPage } from './adminPage.js';

export function createAdminRouter({ service, db, adminUser, adminPassword }) {
  const router = express.Router();
  router.use(requireAdmin({ user: adminUser, password: adminPassword }));

  router.get('/', (request, response) => {
    response.type('html').send(renderAdminPage({
      pending: listByStatus(db, PENDING),
      approved: listByStatus(db, APPROVED),
      message: request.query.message,
    }));
  });

  router.post('/approve', async (request, response, next) => {
    try {
      const device = await service.approve({ code: request.body.code, label: request.body.label });
      return response.redirect(`/admin?message=${encodeURIComponent(`Aprobado: ${device.label}`)}`);
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
```

- [ ] **Step 9: Montar `/admin` en `src/server.js`**

Agregar el import y, justo debajo del `app.use('/enroll', ...)`:

```js
  app.use('/admin', createAdminRouter({ service, db, adminUser, adminPassword }));
```

- [ ] **Step 10: Escribir los tests de las rutas de admin**

`test/admin.test.js`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createEnrollService } from '../src/enrollService.js';
import { createServer } from '../src/server.js';
import { fakeTraccar } from './helpers.js';

let server;
let base;
let db;
let traccar;
const auth = 'Basic ' + Buffer.from('rodrigo:pw-admin').toString('base64');

before(async () => {
  db = openDb(':memory:');
  traccar = fakeTraccar();
  const service = createEnrollService({ db, traccar, now: () => new Date('2026-10-06T12:00:00.000Z') });
  const app = createServer({ db, traccar, service, adminUser: 'rodrigo', adminPassword: 'pw-admin' });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  await fetch(`${base}/enroll/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'secreto-admin-test', note: 'Tester' }),
  });
});

after(() => server?.close());

const form = (fields) => ({
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
  redirect: 'manual',
});

test('GET /admin sin credenciales da 401', async () => {
  const response = await fetch(`${base}/admin`, { redirect: 'manual' });
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate') ?? '', /Basic/);
});

test('GET /admin con credenciales incorrectas da 401', async () => {
  const mala = 'Basic ' + Buffer.from('rodrigo:incorrecta').toString('base64');
  const response = await fetch(`${base}/admin`, { headers: { Authorization: mala }, redirect: 'manual' });
  assert.equal(response.status, 401);
});

test('GET /admin lista el pedido pendiente con su código formateado', async () => {
  const response = await fetch(`${base}/admin`, { headers: { Authorization: auth } });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /RUDA-[A-Z0-9]{4}-[A-Z0-9]{4}/);
  assert.match(html, /Tester/);
});

test('POST /admin/approve aprueba y redirige', async () => {
  const pending = db.prepare("SELECT code FROM devices WHERE status = 'pending'").get();
  const response = await fetch(`${base}/admin/approve`, form({ code: pending.code, label: 'Juan' }));

  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /^\/admin\?message=/);
  const row = db.prepare('SELECT * FROM devices').get();
  assert.equal(row.status, 'approved');
  assert.equal(row.label, 'Juan');
});

test('el HTML de admin escapa la nota que escribió el usuario', async () => {
  await fetch(`${base}/enroll/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'secreto-xss', note: '<script>alert(1)</script>' }),
  });
  const response = await fetch(`${base}/admin`, { headers: { Authorization: auth } });
  const html = await response.text();
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('aprobar un código inexistente da 404 y no rompe', async () => {
  const response = await fetch(`${base}/admin/approve`, form({ code: 'RUDAZZZZZZZZ', label: 'Nadie' }));
  assert.equal(response.status, 404);
});
```

- [ ] **Step 11: Correr toda la suite**

Run: `cd traccar/traccar-web/tools/enroll && npm test`
Expected: PASS.

- [ ] **Step 12: Probar a mano contra Traccar de verdad**

Con el servicio corriendo en local apuntando a un Traccar de pruebas, verificar que un pedido aprobado devuelve un token que sirve. Este paso es el que valida la suplantación contra el backend real; los tests usan un `fetch` falso y no lo prueban.

Run:
```bash
cd traccar/traccar-web/tools/enroll
TRACCAR_URL=https://mh.rudatrak.com TRACCAR_ADMIN_EMAIL=<admin> TRACCAR_ADMIN_PASSWORD=<pass> \
ENROLL_ADMIN_PASSWORD=prueba PORT=3008 node src/server.js
```
En otra terminal:
```bash
curl -s -X POST localhost:3008/enroll/request -H 'Content-Type: application/json' -d '{"secret":"prueba-manual-1","note":"prueba"}'
# aprobar desde http://localhost:3008/admin (rodrigo / prueba)
curl -s localhost:3008/enroll/status -H 'Authorization: Bearer prueba-manual-1'
# copiar el token devuelto y comprobar que Traccar lo acepta:
curl -s https://mh.rudatrak.com/api/session -H 'Authorization: Bearer <token>' | head -c 200
```
Expected: el último comando devuelve el JSON del usuario creado, no un 401. **Usar el Traccar de pruebas, no el de producción**: la aprobación crea un usuario real.

- [ ] **Step 13: Commit**

```bash
cd traccar/traccar-web
git add tools/enroll/src tools/enroll/test
git commit -m "Enrolamiento: aprobación, autenticación y página de administración"
```

---

### Task 7: Renovación silenciosa

**Files:**
- Modify: `traccar/traccar-web/tools/enroll/src/enrollService.js` (`renew`)
- Modify: `traccar/traccar-web/tools/enroll/src/enrollRoutes.js` (`POST /enroll/renew`)
- Modify: `traccar/traccar-web/tools/enroll/test/enrollService.test.js`
- Modify: `traccar/traccar-web/tools/enroll/test/enrollRoutes.test.js`

**Interfaces:**
- Consumes: `requireDeviceSecret(db)` (Tarea 5), `setToken`, `touch` (Tarea 1).
- Produces: `service.renew(device)` → token nuevo; `POST /enroll/renew` → `{ token, status: 'approved' }`.

Esta es la pieza que sostiene "el usuario nunca conoce su contraseña" (spec §7.2). Sin ella, cada vencimiento deja a la persona varada en un login donde no tiene nada que tipear.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar a `test/enrollService.test.js`:

```js
test('renew emite un token nuevo para un dispositivo aprobado', async () => {
  const { service } = serviceFor({ now: () => T0 });
  const { device, secret } = await approvedFixture(service);

  const token = await service.renew(device);
  assert.ok(token);
  assert.notEqual(token, device.token);
});

test('renew exige que el enrolamiento esté aprobado', async () => {
  const { service, traccar } = serviceFor({ now: () => T0 });
  await service.requestEnrollment({ secret: 'secreto-juan' });
  const pendiente = await service.getStatus(hashSecret('secreto-juan'));

  await assert.rejects(
    () => service.renew({ ...pendiente, status: 'pending' }),
    (error) => error instanceof EnrollError && error.status === 403,
  );
  assert.equal(traccar.calls.filter((c) => c.op === 'issueToken').length, 0);
});

test('renew NO revive un dispositivo revocado', async () => {
  const { service } = serviceFor({ now: () => T0 });
  const { device } = await approvedFixture(service);
  await service.revoke(device);

  const revocado = { ...device, status: 'revoked' };
  await assert.rejects(
    () => service.renew(revocado),
    (error) => error instanceof EnrollError && error.status === 403,
  );
});

test('renew guarda el token nuevo y actualiza last_seen_at', async () => {
  let reloj = T0;
  const { service, db } = serviceFor({ now: () => reloj });
  const { device } = await approvedFixture(service);

  reloj = new Date('2027-04-01T00:00:00.000Z');
  const token = await service.renew(db.prepare('SELECT * FROM devices').get());

  const row = db.prepare('SELECT * FROM devices').get();
  assert.equal(row.token, token);
  assert.equal(row.last_seen_at, '2027-04-01T00:00:00.000Z');
});
```

Nota: los tests de `renew` para un dispositivo revocado usan `service.revoke`, que llega en la Tarea 8. **Adelantar `revoke` a esta tarea** es aceptable — son cuatro líneas y evitan dejar un test comentado. Si se prefiere el orden estricto, escribir el test con `markRevoked(db, device.device_id)` directo.

Agregar a `test/enrollRoutes.test.js`:

```js
test('POST /enroll/renew sin secreto da 401', async () => {
  const response = await fetch(`${base}/enroll/renew`, { method: 'POST' });
  assert.equal(response.status, 401);
});

test('POST /enroll/renew de un pendiente da 403', async () => {
  await fetch(`${base}/enroll/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'secreto-pendiente-renew' }),
  });
  const response = await fetch(`${base}/enroll/renew`, {
    method: 'POST',
    headers: { Authorization: 'Bearer secreto-pendiente-renew' },
  });
  assert.equal(response.status, 403);
});

test('POST /enroll/renew devuelve el token y el estado aprobado', async () => {
  const created = await fetch(`${base}/enroll/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'secreto-renovable' }),
  }).then((response) => response.json());

  const adminAuth = 'Basic ' + Buffer.from('rodrigo:pw-admin').toString('base64');
  await fetch(`${base}/admin/approve`, {
    method: 'POST',
    headers: { Authorization: adminAuth, 'Content-Type': 'application/x-www-form-urlencoded' },
    // Se aprueba con el código tal como lo muestra la app, con guiones:
    // comprueba de paso que la normalización funciona de punta a punta.
    body: new URLSearchParams({ code: created.code, label: 'Renovable' }).toString(),
    redirect: 'manual',
  });

  const response = await fetch(`${base}/enroll/renew`, {
    method: 'POST',
    headers: { Authorization: 'Bearer secreto-renovable' },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'approved');
  assert.ok(body.token);
});
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

Run: `cd traccar/traccar-web/tools/enroll && npm test`
Expected: FAIL — `service.renew is not a function` y 404 en `/enroll/renew`.

- [ ] **Step 3: Implementar `renew` en `src/enrollService.js`**

```js
  /**
   * Emite un token nuevo con el mismo secreto del dispositivo. Es lo que
   * permite que la persona nunca vea una contraseña: renueva sola, sin
   * código nuevo y sin aprobación manual.
   */
  async function renew(device) {
    if (device.status !== APPROVED) {
      throw new EnrollError('El enrolamiento no está aprobado', 403);
    }
    const token = await traccar.issueToken(device.traccar_user_id, expirationInDays(tokenDays, now()));
    setToken(db, device.device_id, token);
    touch(db, device.device_id, now().toISOString());
    return token;
  }
```

Sumar `renew` al objeto que devuelve `createEnrollService`.

- [ ] **Step 4: Agregar la ruta en `src/enrollRoutes.js`**

```js
  router.post('/renew', requireDeviceSecret(db), async (request, response, next) => {
    try {
      const token = await service.renew(request.device);
      return response.json({ status: 'approved', token });
    } catch (error) {
      return next(error);
    }
  });
```

- [ ] **Step 5: Correr toda la suite**

Run: `cd traccar/traccar-web/tools/enroll && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd traccar/traccar-web
git add tools/enroll/src tools/enroll/test
git commit -m "Enrolamiento: renovación silenciosa del token"
```

---

### Task 8: Revocación

**Files:**
- Modify: `traccar/traccar-web/tools/enroll/src/enrollService.js` (`revoke`)
- Modify: `traccar/traccar-web/tools/enroll/src/adminRoutes.js` (`POST /admin/revoke`)
- Modify: `traccar/traccar-web/tools/enroll/test/enrollService.test.js`

**Interfaces:**
- Consumes: `traccar.revokeToken` (Tarea 3), `markRevoked` (Tarea 1).
- Produces: `service.revoke(device)` → `boolean` (si Traccar confirmó la revocación).

**Qué hace y qué no hace la revocación** (spec §7.4): el corte real lo produce `TokenManager.verifyToken`, que en cada petición consulta la tabla `RevokedToken` y rechaza el token si está ahí. Lo que **no** hace es alcanzar a un dispositivo sin red: la app conserva su token y sigue funcionando offline. Eso es un límite aceptado del diseño, no un defecto a corregir acá.

- [ ] **Step 1: Escribir los tests que fallan**

```js
test('revoke pide a Traccar que invalide el token y marca el registro', async () => {
  const { service, db, traccar } = serviceFor({ now: () => T0 });
  const { device } = await approvedFixture(service);

  await service.revoke(device);

  const revocado = traccar.calls.find((c) => c.op === 'revokeToken');
  assert.equal(revocado.token, device.token);
  const row = db.prepare('SELECT * FROM devices').get();
  assert.equal(row.status, 'revoked');
  assert.equal(row.token, null);
});

test('revoke avisa si Traccar no pudo invalidar el token', async () => {
  const traccar = fakeTraccar({ async revokeToken() { return false; } });
  const { service, db } = serviceFor({ now: () => T0, traccar });
  const { device } = await approvedFixture(service);

  await assert.rejects(
    () => service.revoke(device),
    (error) => error instanceof EnrollError && error.status === 502,
  );
  // El registro local NO se marcó: preferimos que se pueda reintentar
  // antes que dar por revocado algo que sigue vivo en Traccar.
  assert.equal(db.prepare('SELECT * FROM devices').get().status, 'approved');
});

test('revoke de un pendiente no llama a Traccar', async () => {
  const { service, db, traccar } = serviceFor({ now: () => T0 });
  await service.requestEnrollment({ secret: 'secreto-juan' });
  const device = db.prepare('SELECT * FROM devices').get();

  await service.revoke(device);

  assert.equal(traccar.calls.filter((c) => c.op === 'revokeToken').length, 0);
  assert.equal(db.prepare('SELECT * FROM devices').get().status, 'revoked');
});
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

Run: `cd traccar/traccar-web/tools/enroll && node --test test/enrollService.test.js`
Expected: FAIL — `service.revoke is not a function`.

- [ ] **Step 3: Implementar `revoke` en `src/enrollService.js`**

```js
  /**
   * Corta el acceso del dispositivo. El rechazo efectivo lo hace Traccar:
   * `TokenManager.verifyToken` consulta la tabla RevokedToken en cada
   * petición. Un dispositivo sin red conserva su token hasta reconectarse
   * — es un límite aceptado, ver spec §7.4.
   */
  async function revoke(device) {
    if (device.token) {
      const ok = await traccar.revokeToken(device.token);
      if (!ok) {
        // No marcamos nada: si Traccar no confirmó, el token sigue vivo y
        // darlo por revocado sería mentir. Mejor que se pueda reintentar.
        throw new EnrollError('Traccar no confirmó la revocación, reintentar', 502);
      }
    }
    markRevoked(db, device.device_id);
    return true;
  }
```

- [ ] **Step 4: Agregar la ruta en `src/adminRoutes.js`**

```js
  router.post('/revoke', async (request, response, next) => {
    try {
      const device = getByDeviceId(db, request.body.device_id);
      if (!device) {
        throw new EnrollError('Dispositivo desconocido', 404);
      }
      await service.revoke(device);
      return response.redirect(`/admin?message=${encodeURIComponent(`Revocado: ${device.label ?? device.device_id.slice(0, 8)}`)}`);
    } catch (error) {
      return next(error);
    }
  });
```

Agregar a los imports de `adminRoutes.js`: `getByDeviceId` desde `./db.js` y `EnrollError` desde `./enrollService.js`.

- [ ] **Step 5: Correr toda la suite**

Run: `cd traccar/traccar-web/tools/enroll && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd traccar/traccar-web
git add tools/enroll/src tools/enroll/test
git commit -m "Enrolamiento: revocación por dispositivo"
```

---

### Task 9: Re-enrolamiento (Juan cambia de teléfono)

**Files:**
- Modify: `traccar/traccar-web/tools/enroll/src/enrollService.js` (`rebind`)
- Modify: `traccar/traccar-web/tools/enroll/src/adminRoutes.js` (`POST /admin/rebind`)
- Modify: `traccar/traccar-web/tools/enroll/test/enrollService.test.js`

**Interfaces:**
- Consumes: `deleteDevice`, `markApproved` (Tarea 1), `getByCode`, `getByDeviceId`.
- Produces: `service.rebind({ code, target })` → registro nuevo aprobado.

**El flujo real:** Juan instala la APK en el teléfono nuevo. La app no tiene token, así que pide enrolamiento y muestra un código nuevo. Rodrigo ve ese pedido pendiente, y en vez de aprobarlo como persona nueva, lo ata al enrolamiento que Juan ya tenía: mismo usuario de Traccar, mismo nombre, token nuevo, y el dispositivo viejo deja de existir.

- [ ] **Step 1: Escribir los tests que fallan**

```js
test('rebind mueve el enrolamiento al teléfono nuevo', async () => {
  const { service, db, traccar } = serviceFor({ now: () => T0 });
  const { device: viejo } = await approvedFixture(service, 'secreto-viejo', 'Juan');

  await service.requestEnrollment({ secret: 'secreto-nuevo' });
  const nuevo = db.prepare("SELECT code FROM devices WHERE code != ?").get(viejo.code);

  const device = await service.rebind({ code: nuevo.code, target: viejo.device_id });

  assert.equal(device.status, APPROVED);
  assert.equal(device.label, 'Juan');
  assert.equal(device.traccar_user_id, viejo.traccar_user_id);
  assert.ok(device.token);
  // El dispositivo viejo desaparece: ya no puede renovar.
  assert.equal(getByDeviceId(db, viejo.device_id), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM devices').get().n, 1);
});

test('rebind invalida el token del teléfono viejo en Traccar', async () => {
  const { service, db, traccar } = serviceFor({ now: () => T0 });
  const { device: viejo } = await approvedFixture(service, 'secreto-viejo', 'Juan');
  await service.requestEnrollment({ secret: 'secreto-nuevo' });
  const nuevo = db.prepare("SELECT code FROM devices WHERE code != ?").get(viejo.code);

  await service.rebind({ code: nuevo.code, target: viejo.device_id });

  const revocado = traccar.calls.find((c) => c.op === 'revokeToken');
  assert.equal(revocado.token, viejo.token);
});

test('rebind no reutiliza un usuario de Traccar ya creado para el pendiente', async () => {
  const { service, db, traccar } = serviceFor({ now: () => T0 });
  const { device: viejo } = await approvedFixture(service, 'secreto-viejo', 'Juan');
  await service.requestEnrollment({ secret: 'secreto-nuevo' });
  const nuevo = db.prepare("SELECT code FROM devices WHERE code != ?").get(viejo.code);

  await service.rebind({ code: nuevo.code, target: viejo.device_id });

  assert.equal(traccar.calls.filter((c) => c.op === 'createUser').length, 1);
});

test('rebind rechaza un código desconocido', async () => {
  const { service } = serviceFor({ now: () => T0 });
  const { device } = await approvedFixture(service);
  await assert.rejects(
    () => service.rebind({ code: 'RUDAZZZZZZZZ', target: device.device_id }),
    (error) => error instanceof EnrollError && error.status === 404,
  );
});

test('rebind rechaza un origen que no está aprobado', async () => {
  const { service, db } = serviceFor({ now: () => T0 });
  await service.requestEnrollment({ secret: 'secreto-pendiente' });
  const pendiente = db.prepare('SELECT * FROM devices').get();
  await service.requestEnrollment({ secret: 'secreto-nuevo' });
  const nuevo = db.prepare('SELECT code FROM devices WHERE device_id != ?').get(pendiente.device_id);

  await assert.rejects(
    () => service.rebind({ code: nuevo.code, target: pendiente.device_id }),
    (error) => error instanceof EnrollError && error.status === 403,
  );
});

test('rebind rechaza un código que ya fue aprobado', async () => {
  const { service, db } = serviceFor({ now: () => T0 });
  const { device: viejo } = await approvedFixture(service, 'secreto-viejo', 'Juan');
  const { device: otro } = await approvedFixture(service, 'secreto-otro', 'Pedro');

  await assert.rejects(
    () => service.rebind({ code: otro.code, target: viejo.device_id }),
    (error) => error instanceof EnrollError && error.status === 409,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM devices').get().n, 2);
});
```

Agregar a los imports del test: `getByDeviceId`.

- [ ] **Step 2: Correr los tests para verificar que fallan**

Run: `cd traccar/traccar-web/tools/enroll && node --test test/enrollService.test.js`
Expected: FAIL — `service.rebind is not a function`.

- [ ] **Step 3: Implementar `rebind` en `src/enrollService.js`**

```js
  /**
   * Ata un teléfono nuevo al enrolamiento que ya existía. No crea usuario
   * en Traccar: reutiliza el del dispositivo viejo, le emite un token
   * nuevo y borra el registro anterior para que el teléfono viejo no
   * pueda renovar.
   */
  async function rebind({ code, target }) {
    const nuevo = getByCode(db, normalizeCode(code));
    if (!nuevo) {
      throw new EnrollError('Código desconocido', 404);
    }
    if (nuevo.status === APPROVED) {
      throw new EnrollError('Ese código ya fue aprobado', 409);
    }

    const viejo = getByDeviceId(db, target);
    if (!viejo) {
      throw new EnrollError('Dispositivo de origen desconocido', 404);
    }
    if (viejo.status !== APPROVED) {
      throw new EnrollError('El enrolamiento de origen no está aprobado', 403);
    }

    if (viejo.token) {
      const ok = await traccar.revokeToken(viejo.token);
      if (!ok) {
        throw new EnrollError('Traccar no confirmó la revocación del teléfono anterior', 502);
      }
    }

    const token = await traccar.issueToken(viejo.traccar_user_id, expirationInDays(tokenDays, now()));
    markApproved(db, nuevo.device_id, {
      label: viejo.label,
      traccarUserId: viejo.traccar_user_id,
      token,
      approvedAt: now().toISOString(),
    });
    deleteDevice(db, viejo.device_id);
    return getByDeviceId(db, nuevo.device_id);
  }
```

Sumar `rebind` al objeto que devuelve `createEnrollService`.

- [ ] **Step 4: Agregar la ruta en `src/adminRoutes.js`**

```js
  router.post('/rebind', async (request, response, next) => {
    try {
      const device = await service.rebind({ code: request.body.code, target: request.body.target });
      return response.redirect(`/admin?message=${encodeURIComponent(`Re-enrolado: ${device.label}`)}`);
    } catch (error) {
      return next(error);
    }
  });
```

- [ ] **Step 5: Correr toda la suite**

Run: `cd traccar/traccar-web/tools/enroll && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd traccar/traccar-web
git add tools/enroll/src tools/enroll/test
git commit -m "Enrolamiento: re-enrolamiento al cambiar de teléfono"
```

---

### Task 10: Imagen Docker y stack de pruebas

**Files:**
- Create: `traccar/traccar-web/tools/enroll/Dockerfile`
- Create: `traccar/traccar-web/tools/enroll/.dockerignore`
- Create: `traccar/traccar-web/tools/enroll/docker-compose.staging.yml`
- Create: `traccar/traccar-web/tools/enroll/README.md`

**Interfaces:**
- Consumes: `src/server.js` y las variables de `loadConfig` (Tarea 5).
- Produces: imagen `rudatrak-enroll:latest` y el stack `enroll-staging`.

**Garantía de no regresión (spec §11):** este stack es **aditivo**. Contenedor, base y puerto propios; no comparte red con el stack `rudatrak` salvo la red externa del proxy, y no toca ningún volumen existente. Si algo sale mal, se apaga con `docker compose -f docker-compose.staging.yml down -v` y producción no se enteró.

- [ ] **Step 1: Escribir el `Dockerfile`**

```dockerfile
FROM node:22-alpine

WORKDIR /app

# Solo el manifiesto primero: la capa de dependencias se cachea entre builds
# y no se reinstala cuando cambia el código.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV PORT=3008
ENV DB_PATH=/data/enroll.db

RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 3008
CMD ["node", "src/server.js"]
```

No hay directorio de estáticos: la página de administración la genera el servidor (Tarea 6) y no hay build de frontend. Los tests tampoco entran a la imagen (están en `.dockerignore`), así que el paso 5 los corre con un montaje.

- [ ] **Step 2: Escribir `.dockerignore`**

```
node_modules
test
data
*.db
*.db-wal
*.db-shm
.git
```

- [ ] **Step 3: Escribir `docker-compose.staging.yml`**

```yaml
services:
  enroll-staging:
    image: rudatrak-enroll:latest
    build: .
    container_name: rudatrak-enroll-staging
    restart: unless-stopped
    environment:
      PORT: 3008
      DB_PATH: /data/enroll.db
      TRACCAR_URL: ${TRACCAR_URL}
      TRACCAR_ADMIN_EMAIL: ${TRACCAR_ADMIN_EMAIL}
      TRACCAR_ADMIN_PASSWORD: ${TRACCAR_ADMIN_PASSWORD}
      ENROLL_ADMIN_USER: ${ENROLL_ADMIN_USER:-rodrigo}
      ENROLL_ADMIN_PASSWORD: ${ENROLL_ADMIN_PASSWORD}
    volumes:
      - enroll-staging-data:/data
    ports:
      # Solo en la red local de la Pi: todavía no pasa por el proxy.
      - "3008:3008"

volumes:
  enroll-staging-data:
```

Las credenciales **no van en el archivo**. Se pasan por un `.env` que no se versiona (agregar `.env` al `.gitignore` de `tools/enroll/`).

- [ ] **Step 4: Escribir el `README.md`**

```markdown
# Servicio de enrolamiento de RudaTrak

Decide qué dispositivos pueden usar RudaTrak. La app pide enrolamiento, muestra
un código, Rodrigo lo aprueba desde `/admin`, y el servicio emite un token de
Traccar para ese dispositivo — sin que nadie conozca una contraseña.

Diseño completo: `traccar-web/docs/superpowers/specs/2026-10-06-enrolamiento-dispositivos-design.md`

## Desarrollo

```bash
npm install
npm test
```

## Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `TRACCAR_URL` | sí | Base de la API de Traccar, sin `/api` |
| `TRACCAR_ADMIN_EMAIL` | sí | Cuenta de admin dedicada al servicio |
| `TRACCAR_ADMIN_PASSWORD` | sí | Contraseña de esa cuenta |
| `ENROLL_ADMIN_PASSWORD` | sí | Contraseña de la página `/admin` |
| `ENROLL_ADMIN_USER` | no | Usuario de `/admin` (por defecto `admin`) |
| `PORT` | no | Por defecto `3008` |
| `DB_PATH` | no | Por defecto `./data/enroll.db` |

## Endpoints

| Método | Ruta | Autenticación |
|---|---|---|
| `POST` | `/enroll/request` | ninguna |
| `GET` | `/enroll/status` | secreto del dispositivo |
| `POST` | `/enroll/renew` | secreto del dispositivo |
| `GET` | `/admin` | Basic auth del administrador |
| `POST` | `/admin/approve` | Basic auth del administrador |
| `POST` | `/admin/rebind` | Basic auth del administrador |
| `POST` | `/admin/revoke` | Basic auth del administrador |
| `GET` | `/health` | ninguna |

## Pruebas en la Pi

```bash
cd /mnt/datos/RudaTrak-web/tools/enroll
docker compose -f docker-compose.staging.yml up -d --build
```

Apagarlo no deja rastro:

```bash
docker compose -f docker-compose.staging.yml down -v
```
```

- [ ] **Step 5: Construir la imagen y correr los tests dentro de ella**

Run:
```bash
cd traccar/traccar-web/tools/enroll
docker build -t rudatrak-enroll:latest .
docker run --rm rudatrak-enroll:latest node --version
docker run --rm -v "$PWD/test:/app/test:ro" rudatrak-enroll:latest node --test test/
```
Expected: la versión de Node es 22.13.0 o superior. Los tests pasan dentro del contenedor — esto confirma que `node:sqlite` funciona en Alpine sin dependencias nativas, que es la suposición central de la elección de stack. El `-v` es necesario porque `test/` está en `.dockerignore`; se monta de solo lectura y la imagen de producción no lo lleva.

- [ ] **Step 6: Levantar el stack de pruebas en la Pi**

Run:
```bash
ssh rodrigo@10.66.66.2
cd /mnt/datos/RudaTrak-web && git pull
cd tools/enroll && cp .env.example .env   # completar las credenciales
docker compose -f docker-compose.staging.yml up -d --build
curl -s localhost:3008/health
```
Expected: `{"status":"ok"}`. El stack de producción (`rudatrak`) sigue intacto: verificar con `docker ps` que los tres contenedores de siempre siguen arriba con el mismo uptime.

- [ ] **Step 7: Commit**

```bash
cd traccar/traccar-web
git add tools/enroll/Dockerfile tools/enroll/.dockerignore tools/enroll/docker-compose.staging.yml tools/enroll/README.md tools/enroll/.gitignore
git commit -m "Enrolamiento: imagen Docker y stack de pruebas"
```

---

## Cobertura del Review Focus

| Condición | Test | Tarea |
|---|---|---|
| Doble aprobación del mismo código | `'approve dos veces no crea un segundo usuario en Traccar'` | 6 |
| Traccar caído a mitad de la aprobación | `'si falla la emisión del token el registro NO queda aprobado'` + `'el reintento después de un fallo reutiliza el usuario ya creado'` | 6 |
| Código vencido o inventado | `'approve rechaza un código desconocido sin tocar Traccar'`, `'approve rechaza un código vencido sin tocar Traccar'` | 6 |
| Renovación de un dispositivo revocado | `'renew NO revive un dispositivo revocado'` | 7 |
| Código tipeado por una persona | `'normalizeCode tolera minúsculas, espacios y guiones'`, `'approve acepta el código tipeado por una persona'` | 2, 6 |

## Planes que siguen

Este plan entrega el servicio funcionando y probado, pero **la app todavía no lo usa**. Quedan dos planes, que se escriben cuando este esté implementado:

- **Plan 2 — Integración en la app.** Pantalla de enrolamiento, guardado del secreto en SecureStorage, `App.jsx` mandando el 401 a la pantalla de enrolamiento en vez de a `/login`, y renovación silenciosa al pasar la mitad de la vida del token.
- **Plan 3 — Cierre de `/poi/`.** Hoy `https://mh.rudatrak.com/poi/general.kml` responde 200 con 4,1 MB y unos 9.000 POIs sin pedir credenciales. Es una fuga de datos más grande que la de la APK y no depende de este servicio.

Ninguno de los dos toca producción hasta que el stack de staging esté verificado.

## Autoevaluación

**Cobertura del spec.** §5 (arquitectura) → Tarea 5 y 10. §6.1 (endpoints) → Tareas 5, 6, 7, 8, 9. §6.2 (SQLite) → Tarea 1. §6.3 (credenciales y suplantación) → Tarea 3. §7.1 (primer enrolamiento) → Tareas 4 y 6. §7.2 (renovación) → Tarea 7. §7.3 (re-enrolamiento, que en el spec figura como `/admin/rebind` con dos pasos) → Tarea 9, en un paso. §7.4 (revocación) → Tarea 8. §8 (identidad del dispositivo) → Tareas 1 y 5. §11 (no regresión) → Tarea 10. §13 (testing) → los tests de cada tarea.

**Fuera de este plan, por decisión del spec:** §9 (cierre de `/poi/`) y §10 (despliegue a producción: el plan llega hasta staging) van a los Planes 2 y 3.

**Desvíos respecto del spec, deliberados:**

1. **`approved` se evalúa antes de llamar a Traccar.** El spec no dice en qué orden aprobar; el plan guarda el `traccar_user_id` antes de emitir el token, para que un fallo a mitad de camino sea reintentable en vez de dejar usuarios huérfanos.
2. **`expired` no se escribe, se calcula.** El spec lista `expired` como estado en la tabla; el plan lo deriva al leer, así no hace falta ninguna tarea programada.
3. **`rebind` es una sola operación.** El spec lo describe con dos endpoints (`/admin/rebind`); el plan lo resuelve con uno que recibe el código nuevo y el dispositivo viejo. El segundo endpoint era redundante: el código nuevo ya llega solo, porque la app lo pide al instalarse.

**Consistencia de tipos.** `hashSecret`, `openDb`, `createEnrollService`, `EnrollError`, `createTraccarClient`, `TraccarError`, `requireDeviceSecret`, `requireAdmin`, `createServer`, `loadConfig`, `renderAdminPage` se definen una sola vez y se usan con la misma firma en todas las tareas. `effectiveStatus` y `expirationInDays` se exportan desde `enrollService.js` en la Tarea 4 y se usan en las Tareas 6 y 7.

**Punto que los tests NO cubren y hay que verificar a mano.** El mecanismo de suplantación (Tarea 3) está verificado leyendo el código del backend, pero los tests unitarios usan un `fetch` falso: prueban que mandamos las peticiones correctas, no que Traccar las acepte. El **paso 12 de la Tarea 6** es la única validación real de esta cadena, y es obligatorio antes de dar la Tarea 6 por terminada. Si esa verificación falla, el plan se detiene ahí: toda la decisión de "el usuario nunca conoce su contraseña" depende de ella.

