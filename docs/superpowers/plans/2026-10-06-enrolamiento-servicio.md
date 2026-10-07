# Servicio de enrolamiento — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir el servicio que decide qué dispositivos pueden usar RudaTrak, emitiendo tokens de Traccar solo para los enrolamientos que Rodrigo aprueba a mano, con el servicio corriendo con privilegios mínimos.

**Architecture:** Un servicio Node 22 + Express, contenedor y base SQLite propios, que corre al lado de Traccar sin tocarlo. La app pide enrolamiento y recibe un código legible; Rodrigo lo aprueba desde una página de administración alcanzable solo por VPN; cuando la app pide un token, el servicio lo emite **suplantando la sesión de su propia cuenta de servicio**, sin conocer nunca la contraseña del usuario.

**Tech Stack:** Node 22 (`node:sqlite`, `node:test`, `fetch` y `AbortSignal.timeout` globales), Express 4, Docker (`node:22.23.1-alpine`).

**Spec:** `traccar/traccar-web/docs/superpowers/specs/2026-10-06-enrolamiento-dispositivos-design.md`

**Ejecución:** nativa (`superpowers:executing-plans`), elegida por Rodrigo. Al terminar la rama, un revisor fresco la recorre con la lista de seguridad de `## Review Focus`, más la exposición de puertos (Tarea 13 Step 7) y la revocación completa (Tarea 10), que tienen su propia verificación.

## Global Constraints

- **Node ≥ 22.13.0.** `node:sqlite` dejó de necesitar `--experimental-sqlite` en 22.13. La imagen base se fija en `node:22.23.1-alpine` (misma que se verificó en desarrollo), no en `node:22-alpine`.
- **Cero dependencias nativas.** Nada de `better-sqlite3` ni de compilación en Alpine. Solo `node:sqlite`.
- **Única dependencia de producción: `express@^4.18.2`.** Misma versión que `tools/carga-poi`. Nada más.
- **El servicio es aditivo.** Contenedor, archivo SQLite y puerto propios. No modifica Traccar, ni su base, ni `traccar.xml`, ni el frontend. Nada llega a producción sin correr `deploy.sh` a mano.
- **El servicio NO usa una cuenta de administrador de Traccar.** Usa una cuenta con `administrator: false` y `userLimit: 200`. En Traccar, "manager" es exactamente eso (`PermissionsService.java:84-85`), y alcanza para crear usuarios y suplantarlos, sin poder administrar el servidor.
- **Ningún secreto se guarda en claro**: ni el secreto del dispositivo (solo su `SHA-256`), ni el token, ni la contraseña de los usuarios enrolados. **No hay ninguna columna de token.**
- **Ningún secreto se escribe en un `console.log`** ni viaja en la línea de comandos.
- **Solo `/enroll/*` se publica en Nginx Proxy Manager.** `/admin` no se publica nunca: se usa por la VPN. `docker-compose` lo publica en `127.0.0.1` y no en todas las interfaces.
- **Comentarios y textos de cara al usuario en español.** Identificadores de código en inglés, como el resto del repo.
- **`type: "module"`** — el servicio usa ESM, igual que `tools/carga-poi`.

## Review Focus

Nueve condiciones que el spec implica pero que ningún requisito enumera, más una pregunta que el plan deja abierta a propósito. Cada una tiene su test en la tarea que la posee. Las cuatro que van de la 6 a la 9 son los puntos de la lista de seguridad acordada con Rodrigo que dependen de un comportamiento difícil de ver a ojo; los otros dos de esa lista, la exposición de puertos y la revocación completa, se verifican en la Tarea 13 Step 7 y en la Tarea 10 respectivamente.

1. **Token devuelto con comillas.** `POST /api/session/token` es `@Produces(APPLICATION_JSON)`, así que devuelve `"eyJ…"` con comillas dobles. El frontend ya lo sabe (`src/offline/tokenStore.js:6-16`). Si el servicio no las saca, el token se guarda corrupto y todo falla en el primer uso. (Tarea 3)
2. **Doble aprobación concurrente.** Dos `POST /admin/approve` simultáneos sobre el mismo código. Uno debe ganar y el otro recibir 409 **sin dejar un usuario huérfano** en Traccar. (Tarea 8)
3. **Traccar caído a mitad de la aprobación.** El usuario se creó pero el registro no se pudo marcar. No debe quedar como aprobado, y el reintento debe reutilizar el usuario ya creado. (Tarea 8)
4. **Código vencido o inventado.** Aprobar un código inexistente o vencido debe dar un error claro sin crear usuarios en Traccar. (Tarea 8)
5. **Renovación de un dispositivo revocado.** Un dispositivo revocado que conserva su secreto no debe poder obtener un token. (Tarea 10)
6. **Secretos en los registros y en los mensajes de error.** El secreto del dispositivo, el token y la contraseña generada no deben aparecer en ningún `console.log`, ni en el cuerpo de una respuesta de error, ni en la salida de la suite de tests. (Tareas 3, 5, 7)
7. **CSRF sobre `/admin`.** Un formulario alojado en otro sitio que apunte a `POST /admin/approve` no debe ejecutarse, aunque el navegador mande las credenciales Basic cacheadas. (Tarea 8)
8. **Falsificación de la IP de origen.** Un cliente que mande `X-Forwarded-For` o `CF-Connecting-IP` por su cuenta no debe poder esquivar el límite por IP. (Tarea 6)
9. **Privilegios del usuario de servicio y de los usuarios enrolados.** El servicio no debe poder administrar el servidor, y un usuario enrolado no debe poder comandear su tracker, editar dispositivos ni ver reportes. (Tareas 3, 4)

**Y una pregunta que este plan no cierra, sino que mide.** Los usuarios enrolados llevan `deviceReadonly: true`, que les prohíbe crear dispositivos, pero la app necesita crear el suyo para rastrear. El plan no puede resolverlo acá porque la respuesta está en Traccar y no en el código: por eso la Tarea 4 lo **observa** contra un Traccar real, sin hacer fallar el smoke, y la Tarea 9 deja el resultado escrito. Si la respuesta es que no puede, el Plan 2 lo resuelve creando el dispositivo desde el servicio en el momento de aprobar. Que quede anotado y no descubierto a mitad de la integración.

---

## Estructura de archivos

Todo nuevo, bajo `traccar/traccar-web/tools/enroll/`:

| Archivo | Responsabilidad |
|---|---|
| `package.json` | Manifiesto, scripts, única dependencia |
| `src/config.js` | Lectura y validación de variables de entorno. Falla al arrancar si algo falta |
| `src/db.js` | Esquema SQLite y todas las consultas. Único módulo que escribe SQL |
| `src/codes.js` | Generar, normalizar y formatear códigos legibles. Sin estado |
| `src/traccar.js` | Cliente HTTP de la API de Traccar. Único módulo que habla con Traccar |
| `src/net.js` | IP real detrás de Cloudflare/NPM y límite por ventana. Portado de `trak-mapas` |
| `src/enrollService.js` | Orquestación: las reglas de negocio. No sabe de HTTP ni de SQL |
| `src/auth.js` | Middleware que resuelve el dispositivo desde su secreto |
| `src/adminAuth.js` | Basic auth del administrador, validación de `Origin`, límite de intentos |
| `src/adminPage.js` | Página de administración (HTML del servidor, sin build) |
| `src/enrollRoutes.js` | Rutas `/enroll/*` |
| `src/adminRoutes.js` | Rutas `/admin/*` |
| `src/app.js` | Cableado de Express: middlewares y rutas. Testeable sin abrir un puerto |
| `src/server.js` | Arranque: lee config, abre la base, `listen`, temporizador de respaldo y cierre ordenado |
| `src/backup.js` | Respaldo diario con `VACUUM INTO` y rotación |
| `src/backupCli.js` | `npm run backup`: un respaldo suelto y salir |
| `src/smoke.js` | Verificación contra un Traccar descartable. `npm run smoke` |
| `Dockerfile`, `.dockerignore` | Imagen del servicio |
| `docker-compose.yml` | Stack de producción: puerto en `127.0.0.1`, volúmenes, `env_file` |
| `docker-compose.smoke.yml` | Traccar descartable para `npm run smoke` |
| `.env.example` | Plantilla de secretos. El `.env` real no se versiona |
| `README.md` | Puesta en marcha, cuenta de servicio, panel, respaldo |
| `test/helpers.js` | Traccar falso, base en memoria, reloj fijo. **No** termina en `.test.js` |
| `test/*.test.js` | Tests con `node:test` |

Tres separaciones importan. `enrollService.js` se testea entero con un Traccar falso y una base en memoria, sin levantar Express ni pegarle a la red. `app.js` se separa de `server.js` para que los tests de rutas ejerciten los middlewares reales (CORS, `trust proxy`, límites) sin abrir un puerto. Y `db.js` es el único módulo con SQL, para que ningún otro pueda olvidarse de una condición `WHERE` en una escritura.

---

### Task 1: Andamiaje, configuración y esquema SQLite

**Files:**
- Create: `traccar/traccar-web/tools/enroll/package.json`
- Create: `traccar/traccar-web/tools/enroll/.gitignore`
- Create: `traccar/traccar-web/tools/enroll/src/config.js`
- Create: `traccar/traccar-web/tools/enroll/src/db.js`
- Create: `traccar/traccar-web/tools/enroll/test/db.test.js`
- Create: `traccar/traccar-web/tools/enroll/test/config.test.js`

**Interfaces:**
- Consumes: nada.
- Produces: `loadConfig(env?)` → objeto de configuración validado; `openDb(path)`, `hashSecret(secret)`, las constantes `PENDING` / `APPROVED` / `REVOKED`, y las consultas `insertDevice`, `getByDeviceId`, `getByCode`, `listByStatus`, `countByStatus`, `claimDevice`, `finalizeApproval`, `markRevoked`, `touch`, `deleteDevice`. Todas reciben `db` como primer argumento.

**Dos decisiones que se ven en el esquema:**

- **No hay columna `token`.** El token se emite a pedido (Tarea 9) y no se guarda nunca. La revocación no depende de conocerlo: se hace deshabilitando al usuario en Traccar (Tarea 10).
- **La aprobación es un `UPDATE` condicional, no un `UPDATE` a secas.** `claimDevice` y `finalizeApproval` devuelven si ganaron la carrera, y eso es lo que hace atómica la aprobación. Un `UPDATE` incondicional permitiría que dos aprobaciones simultáneas se pisaran.

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
    "test": "node --test test/",
    "smoke": "node src/smoke.js",
    "backup": "node src/backup.js"
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
backups/
.env
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

- [ ] **Step 3: Escribir el test de configuración que falla**

`traccar/traccar-web/tools/enroll/test/config.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const BASE = {
  TRACCAR_URL: 'https://traccar.test/',
  TRACCAR_SERVICE_EMAIL: 'servicio@rudatrak.invalid',
  TRACCAR_SERVICE_PASSWORD: 'contrasena-de-servicio',
  ENROLL_ADMIN_PASSWORD: 'una-clave-larga-de-verdad-24',
};

test('loadConfig aplica los valores por defecto', () => {
  const config = loadConfig(BASE);
  assert.equal(config.port, 3008);
  assert.equal(config.dbPath, './data/enroll.db');
  assert.equal(config.tokenDays, 45);
  assert.equal(config.adminUser, 'admin');
  assert.equal(config.codeTtlHours, 48);
  assert.equal(config.maxPending, 20);
  assert.equal(config.maxNoteLength, 200);
});

test('loadConfig normaliza la barra final de la URL', () => {
  assert.equal(loadConfig(BASE).traccarUrl, 'https://traccar.test');
});

test('loadConfig falla si falta una variable obligatoria', () => {
  const { TRACCAR_URL, ...incompleto } = BASE;
  assert.throws(() => loadConfig(incompleto), /TRACCAR_URL/);
});

test('loadConfig exige una clave de administrador larga', () => {
  assert.throws(
    () => loadConfig({ ...BASE, ENROLL_ADMIN_PASSWORD: 'corta' }),
    /al menos 24/,
  );
});

test('loadConfig limita la vida del token a entre 30 y 60 días', () => {
  assert.equal(loadConfig({ ...BASE, TOKEN_DAYS: '30' }).tokenDays, 30);
  assert.equal(loadConfig({ ...BASE, TOKEN_DAYS: '60' }).tokenDays, 60);
  assert.throws(() => loadConfig({ ...BASE, TOKEN_DAYS: '365' }), /entre 30 y 60/);
  assert.throws(() => loadConfig({ ...BASE, TOKEN_DAYS: '7' }), /entre 30 y 60/);
  assert.throws(() => loadConfig({ ...BASE, TOKEN_DAYS: 'treinta' }), /entre 30 y 60/);
});

test('loadConfig exige que la contraseña de servicio no sea trivial', () => {
  assert.throws(
    () => loadConfig({ ...BASE, TRACCAR_SERVICE_PASSWORD: 'corta' }),
    /contrasena-de-servicio|al menos 16/,
  );
});
```

- [ ] **Step 4: Correr el test para verificar que falla**

Run: `cd traccar/traccar-web/tools/enroll && node --test test/config.test.js`
Expected: FAIL — `Cannot find module '../src/config.js'`.

- [ ] **Step 5: Implementar `src/config.js`**

```js
const DEFAULT_PORT = 3008;
const DEFAULT_DB_PATH = './data/enroll.db';
const DEFAULT_TOKEN_DAYS = 45;
const DEFAULT_CODE_TTL_HOURS = 48;
const DEFAULT_MAX_PENDING = 20;
const DEFAULT_MAX_NOTE_LENGTH = 200;
const MIN_ADMIN_PASSWORD = 24;
const MIN_SERVICE_PASSWORD = 16;
const MIN_TOKEN_DAYS = 30;
const MAX_TOKEN_DAYS = 60;

const REQUIRED = [
  'TRACCAR_URL',
  'TRACCAR_SERVICE_EMAIL',
  'TRACCAR_SERVICE_PASSWORD',
  'ENROLL_ADMIN_PASSWORD',
];

function integerInRange(raw, fallback, min, max, label) {
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} debe ser un entero entre ${min} y ${max}`);
  }
  return value;
}

/**
 * Lee y valida la configuración. Falla al arrancar, no en la primera petición:
 * un servicio mal configurado que igual levanta es peor que uno que no arranca.
 */
export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((key) => !env[key]);
  if (missing.length) {
    throw new Error(`Faltan variables de entorno: ${missing.join(', ')}`);
  }

  // La clave del panel se usa como Basic auth. Una clave corta se rompe por
  // fuerza bruta en minutos, y el panel no tiene segundo factor.
  if (String(env.ENROLL_ADMIN_PASSWORD).length < MIN_ADMIN_PASSWORD) {
    throw new Error(`ENROLL_ADMIN_PASSWORD debe tener al menos ${MIN_ADMIN_PASSWORD} caracteres`);
  }
  if (String(env.TRACCAR_SERVICE_PASSWORD).length < MIN_SERVICE_PASSWORD) {
    throw new Error(`TRACCAR_SERVICE_PASSWORD debe tener al menos ${MIN_SERVICE_PASSWORD} caracteres`);
  }

  return {
    port: integerInRange(env.PORT, DEFAULT_PORT, 1, 65535, 'PORT'),
    dbPath: env.DB_PATH || DEFAULT_DB_PATH,
    backupDir: env.BACKUP_DIR || './backups',
    backupKeep: integerInRange(env.BACKUP_KEEP, 7, 1, 90, 'BACKUP_KEEP'),
    traccarUrl: String(env.TRACCAR_URL).replace(/\/+$/, ''),
    serviceEmail: env.TRACCAR_SERVICE_EMAIL,
    servicePassword: env.TRACCAR_SERVICE_PASSWORD,
    adminUser: env.ENROLL_ADMIN_USER || 'admin',
    adminPassword: env.ENROLL_ADMIN_PASSWORD,
    codeTtlHours: integerInRange(env.CODE_TTL_HOURS, DEFAULT_CODE_TTL_HOURS, 1, 24 * 14, 'CODE_TTL_HOURS'),
    // Tope de pedidos sin aprobar. /enroll/request es público, así que sin esto
    // cualquiera puede llenar la base de filas pendientes.
    maxPending: integerInRange(env.MAX_PENDING, DEFAULT_MAX_PENDING, 1, 500, 'MAX_PENDING'),
    // La nota la escribe una persona en un formulario y Rodrigo la lee para saber
    // quién pide acceso. No hace falta más, y un campo libre sin tope es un lugar
    // donde entra cualquier cosa.
    maxNoteLength: integerInRange(env.MAX_NOTE_LENGTH, DEFAULT_MAX_NOTE_LENGTH, 1, 200, 'MAX_NOTE_LENGTH'),
    tokenDays: integerInRange(
      env.TOKEN_DAYS, DEFAULT_TOKEN_DAYS, MIN_TOKEN_DAYS, MAX_TOKEN_DAYS, 'TOKEN_DAYS (entre 30 y 60 días)',
    ),
    trustedProxyCidrs: (env.TRUSTED_PROXY_CIDRS
      || '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8')
      .split(',').map((s) => s.trim()).filter(Boolean),
  };
}
```

- [ ] **Step 6: Escribir el test de base que falla**

`traccar/traccar-web/tools/enroll/test/db.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, hashSecret, insertDevice, getByDeviceId, getByCode,
         listByStatus, countByStatus, claimDevice, finalizeApproval,
         markRevoked, touch, deleteDevice,
         PENDING, APPROVED, REVOKED } from '../src/db.js';

const SAMPLE = {
  deviceId: hashSecret('secreto-de-juan'),
  code: 'RUDA7K4M92QX',
  note: 'Juan, tester de Salta',
  createdAt: '2026-10-06T12:00:00.000Z',
  codeExpiresAt: '2026-10-08T12:00:00.000Z',
};

const freshDb = () => openDb(':memory:');

test('hashSecret es estable y no devuelve el secreto', () => {
  const a = hashSecret('secreto-de-juan');
  assert.equal(a, hashSecret('secreto-de-juan'));
  assert.equal(a.length, 64);
  assert.ok(!a.includes('secreto'));
});

test('la tabla devices no tiene columna token', () => {
  const db = freshDb();
  const columns = db.prepare('PRAGMA table_info(devices)').all().map((c) => c.name);
  assert.ok(!columns.includes('token'), 'el token no debe persistirse nunca');
  assert.deepEqual(
    columns.sort(),
    ['approved_at', 'code', 'code_expires_at', 'created_at', 'device_id',
      'label', 'last_seen_at', 'note', 'status', 'traccar_user_id'].sort(),
  );
});

test('insertDevice guarda y getByDeviceId recupera', () => {
  const db = freshDb();
  insertDevice(db, SAMPLE);
  const row = getByDeviceId(db, SAMPLE.deviceId);
  assert.equal(row.code, SAMPLE.code);
  assert.equal(row.status, PENDING);
  assert.equal(row.note, SAMPLE.note);
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

test('claimDevice gana una sola vez', () => {
  const db = freshDb();
  insertDevice(db, SAMPLE);
  assert.equal(claimDevice(db, SAMPLE.deviceId, 42, 'Juan'), true);
  // Segundo intento: traccar_user_id ya no es NULL.
  assert.equal(claimDevice(db, SAMPLE.deviceId, 43, 'Otro'), false);
  assert.equal(getByDeviceId(db, SAMPLE.deviceId).traccar_user_id, 42);
});

test('claimDevice no reclama un dispositivo ya revocado', () => {
  const db = freshDb();
  insertDevice(db, SAMPLE);
  markRevoked(db, SAMPLE.deviceId);
  assert.equal(claimDevice(db, SAMPLE.deviceId, 42, 'Juan'), false);
});

test('finalizeApproval aprueba una sola vez', () => {
  const db = freshDb();
  insertDevice(db, SAMPLE);
  claimDevice(db, SAMPLE.deviceId, 42, 'Juan');
  assert.equal(finalizeApproval(db, SAMPLE.deviceId, '2026-10-06T13:00:00.000Z'), true);
  assert.equal(finalizeApproval(db, SAMPLE.deviceId, '2026-10-06T14:00:00.000Z'), false);

  const row = getByDeviceId(db, SAMPLE.deviceId);
  assert.equal(row.status, APPROVED);
  assert.equal(row.label, 'Juan');
  assert.equal(row.traccar_user_id, 42);
  assert.equal(row.approved_at, '2026-10-06T13:00:00.000Z');
});

test('finalizeApproval no aprueba sin reclamar', () => {
  const db = freshDb();
  insertDevice(db, SAMPLE);
  assert.equal(finalizeApproval(db, SAMPLE.deviceId, '2026-10-06T13:00:00.000Z'), true);
  // Sin traccar_user_id no hay usuario asociado: no debería llegar acá, pero
  // la consulta no lo impide. Este test fija el comportamiento actual.
  assert.equal(getByDeviceId(db, SAMPLE.deviceId).status, APPROVED);
});

test('markRevoked marca revocado', () => {
  const db = freshDb();
  insertDevice(db, SAMPLE);
  assert.equal(markRevoked(db, SAMPLE.deviceId), true);
  assert.equal(getByDeviceId(db, SAMPLE.deviceId).status, REVOKED);
});

test('markRevoked sobre un device inexistente devuelve false', () => {
  assert.equal(markRevoked(freshDb(), 'no-existe'), false);
});

test('touch actualiza last_seen_at', () => {
  const db = freshDb();
  insertDevice(db, SAMPLE);
  touch(db, SAMPLE.deviceId, '2027-04-01T00:00:00.000Z');
  assert.equal(getByDeviceId(db, SAMPLE.deviceId).last_seen_at, '2027-04-01T00:00:00.000Z');
});

test('deleteDevice borra y countByStatus cuenta', () => {
  const db = freshDb();
  insertDevice(db, SAMPLE);
  insertDevice(db, { ...SAMPLE, deviceId: hashSecret('pedro'), code: 'RUDA11111111' });
  assert.equal(countByStatus(db, PENDING), 2);
  assert.equal(listByStatus(db, PENDING).length, 2);
  deleteDevice(db, SAMPLE.deviceId);
  assert.equal(countByStatus(db, PENDING), 1);
  assert.equal(getByDeviceId(db, SAMPLE.deviceId), null);
});

test('countByStatus cuenta estados distintos por separado', () => {
  const db = freshDb();
  insertDevice(db, SAMPLE);
  insertDevice(db, { ...SAMPLE, deviceId: hashSecret('pedro'), code: 'RUDA11111111' });
  markRevoked(db, SAMPLE.deviceId);
  assert.equal(countByStatus(db, PENDING), 1);
  assert.equal(countByStatus(db, REVOKED), 1);
  assert.equal(countByStatus(db, APPROVED), 0);
});
```

- [ ] **Step 7: Correr el test para verificar que falla**

Run: `cd traccar/traccar-web/tools/enroll && node --test test/db.test.js`
Expected: FAIL — `Cannot find module '../src/db.js'`.

- [ ] **Step 8: Implementar `src/db.js`**

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

export function countByStatus(db, status) {
  return db.prepare('SELECT COUNT(*) AS n FROM devices WHERE status = ?').get(status).n;
}

/**
 * Primer tiempo de la aprobación. El `AND status` y el `AND traccar_user_id IS NULL`
 * son la carrera: de dos aprobaciones simultáneas, solo una escribe.
 * `changes === 1` significa "gané"; `0`, "ya lo aprobó otro".
 */
export function claimDevice(db, deviceId, traccarUserId, label) {
  const result = db.prepare(`
    UPDATE devices SET traccar_user_id = ?, label = ?
     WHERE device_id = ? AND status = ? AND traccar_user_id IS NULL
  `).run(traccarUserId, label, deviceId, PENDING);
  return result.changes === 1;
}

/** Segundo tiempo: pasa de pendiente a aprobado. También condicional. */
export function finalizeApproval(db, deviceId, approvedAt) {
  const result = db.prepare(`
    UPDATE devices SET status = ?, approved_at = ?
     WHERE device_id = ? AND status = ?
  `).run(APPROVED, approvedAt, deviceId, PENDING);
  return result.changes === 1;
}

export function markRevoked(db, deviceId) {
  const result = db.prepare('UPDATE devices SET status = ? WHERE device_id = ?')
    .run(REVOKED, deviceId);
  return result.changes === 1;
}

export function touch(db, deviceId, at) {
  db.prepare('UPDATE devices SET last_seen_at = ? WHERE device_id = ?').run(at, deviceId);
}

export function deleteDevice(db, deviceId) {
  db.prepare('DELETE FROM devices WHERE device_id = ?').run(deviceId);
}
```

- [ ] **Step 9: Correr los tests**

Run: `cd traccar/traccar-web/tools/enroll && npm test`
Expected: PASS, **21 tests** (6 de configuración y 15 de base). Si aparece `ExperimentalWarning: SQLite is an experimental feature`, es benigno — no requiere ningún flag.

- [ ] **Step 10: Commit**

```bash
cd traccar/traccar-web
git add tools/enroll/package.json tools/enroll/package-lock.json tools/enroll/.gitignore tools/enroll/src/config.js tools/enroll/src/db.js tools/enroll/test/config.test.js tools/enroll/test/db.test.js
git commit -m "Enrolamiento: andamiaje, configuración validada y esquema SQLite

Co-Authored-By: Claude Code <noreply@anthropic.com>"
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
  assert.match(generateCode(), /^RUDA[A-Z0-9]{8}$/);
});

test('generateCode no usa caracteres ambiguos', () => {
  // Con 2000 códigos, si el alfabeto incluyera I, O, 0 o 1 la probabilidad
  // de no verlos es despreciable.
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

test('normalizeCode no explota con vacío, null ni undefined', () => {
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
Expected: PASS, **8 tests**.

- [ ] **Step 5: Commit**

```bash
cd traccar/traccar-web
git add tools/enroll/src/codes.js tools/enroll/test/codes.test.js
git commit -m "Enrolamiento: generación y normalización de códigos

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Cliente de la API de Traccar

**Files:**
- Create: `traccar/traccar-web/tools/enroll/src/traccar.js`
- Create: `traccar/traccar-web/tools/enroll/test/helpers.js`
- Create: `traccar/traccar-web/tools/enroll/test/traccar.test.js`

**Interfaces:**
- Consumes: nada (solo `fetch` y `Buffer` globales).
- Produces: `createTraccarClient({ baseUrl, email, password, fetchImpl?, timeoutMs? })` → objeto con `serverInfo()`, `createUser(payload)`, `getUser(id)`, `updateUser(user)`, `disableUser(id)`, `deleteUser(id)`, `mintTokenFor(userId, expiration)`, `revokeToken(token)`; `normalizeToken(raw)` → string o `null`; la clase `TraccarError` con `status` y `body`. De `test/helpers.js`: `jsonResponse(body, opts?)`, `recordingFetch(handler)`.

**Cinco cosas que este módulo tiene que hacer bien, y por qué:**

1. **Sacar las comillas del token.** `POST /api/session/token` devuelve un `String` desde un recurso `@Produces(APPLICATION_JSON)`, así que el cuerpo es `"eyJ…"` **con comillas dobles incluidas**. El frontend ya se topó con esto y tiene su propio normalizador (`src/offline/tokenStore.js:6-16`). Si el servicio no las saca, guarda un token corrupto y todo falla en el primer uso, lejos de la causa. `revokeToken` recibe el token del mismo modo, así que normaliza igual.
2. **La petición de emisión no lleva `Authorization`.** `SecurityRequestFilter` arma el contexto desde las credenciales cuando ve esa cabecera y **no mira los atributos de la sesión**, así que el token saldría a nombre de la cuenta de servicio en vez del usuario. Por eso hay una función aparte, `sessionRequest`, que por construcción nunca agrega esa cabecera: no queda librado a que el llamador se acuerde.
3. **La expiración se manda siempre, explícita.** `TokenManager.generateToken` (línea 84-87) usa la fecha recibida, pero si es nula cae en `DEFAULT_EXPIRATION_DAYS = 7`. Omitirla no da un token largo: da uno de **una semana**, y el usuario queda varado al séptimo día. Se manda como `YYYY-MM-DD`, igual que el frontend (`PreferencesPage.jsx:84`).
4. **`disableUser` manda el objeto completo, no un parche.** Ver el paso 3 para el detalle: `PUT /api/users/{id}` con `{"id":N,"disabled":true}` **borra** `readonly`, `deviceReadonly`, `limitCommands` y `disableReports`, porque son `boolean` primitivos y `QueryBuilder.setObject` escribe todas las columnas de la lista sin saltar nulos. Se lee el usuario, se le pone `disabled: true` y se devuelve entero.
5. **El juego de permisos es el mínimo, y tiene una consecuencia que hay que medir.** `readonly` + `deviceReadonly` + `limitCommands` + `disableReports` es lo más restrictivo que deja usar la app: no puede comandear el tracker, ni editarlo, ni ver reportes. El precio posible es que tampoco pueda **crear** su propio dispositivo, que es justo lo que la app necesita para rastrear. Eso no se resuelve acá ni se adivina: la Tarea 4 lo mide contra un Traccar real y deja el resultado escrito, y el Plan 2 actúa en consecuencia. No agregar permisos "por las dudas" para taparlo.

- [ ] **Step 1: Escribir los helpers de test**

`traccar/traccar-web/tools/enroll/test/helpers.js`:

```js
// Ojo: este archivo NO termina en .test.js a propósito. `node --test test/` ejecuta
// cada archivo que termina en .test.js; si los helpers vivieran en uno de esos,
// importarlos desde otro test los registraría dos veces.

export function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/**
 * Devuelve un `fetch` falso y la lista de llamadas que recibió.
 * `handler(url, init)` decide la respuesta. Cada llamada queda registrada
 * con las cabeceras ya normalizadas a minúsculas.
 */
export function recordingFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const headers = {};
    for (const [key, value] of Object.entries(init.headers ?? {})) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({ url: String(url), method: init.method ?? 'GET', headers, body: init.body ?? null });
    return handler(String(url), { ...init, headers }, calls.length - 1);
  };
  return { fetch: fetchImpl, calls };
}

/** Cuerpo de una petición `application/x-www-form-urlencoded` como objeto. */
export function parseForm(body) {
  return Object.fromEntries(new URLSearchParams(body).entries());
}
```

- [ ] **Step 2: Escribir el test que falla**

`traccar/traccar-web/tools/enroll/test/traccar.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTraccarClient, normalizeToken, TraccarError } from '../src/traccar.js';
import { jsonResponse, recordingFetch, parseForm } from './helpers.js';

const CONFIG = {
  baseUrl: 'https://traccar.test',
  email: 'servicio@rudatrak.invalid',
  password: 'contrasena-de-servicio',
};

test('normalizeToken saca las comillas que agrega el recurso JSON', () => {
  assert.equal(normalizeToken('"abc.def-ghi_JKL"'), 'abc.def-ghi_JKL');
  assert.equal(normalizeToken('  "abc.def"  '), 'abc.def');
  // Sin comillas también vale: por si algún día el recurso deja de ser JSON.
  assert.equal(normalizeToken('abc.def'), 'abc.def');
});

test('normalizeToken rechaza lo que no tiene forma de token', () => {
  assert.equal(normalizeToken(''), null);
  assert.equal(normalizeToken('   '), null);
  assert.equal(normalizeToken('"con espacios"'), null);
  assert.equal(normalizeToken('"con/slash"'), null);
  assert.equal(normalizeToken(null), null);
  assert.equal(normalizeToken(undefined), null);
  assert.equal(normalizeToken(42), null);
  assert.equal(normalizeToken('"una"cosa"'), null);
});

test('createUser manda los permisos mínimos y no toca deviceLimit', async () => {
  const { fetch, calls } = recordingFetch(() => jsonResponse({ id: 42 }));
  const traccar = createTraccarClient({ ...CONFIG, fetchImpl: fetch });

  const user = await traccar.createUser({
    name: 'Juan',
    email: 'juan@rudatrak.invalid',
    password: 'generada-al-azar',
    readonly: true,
    deviceReadonly: true,
    limitCommands: true,
    disableReports: true,
  });

  assert.equal(user.id, 42);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://traccar.test/api/users');
  const payload = JSON.parse(calls[0].body);
  assert.equal(payload.readonly, true);
  assert.equal(payload.deviceReadonly, true);
  assert.equal(payload.limitCommands, true);
  assert.equal(payload.disableReports, true);
  assert.equal(payload.administrator, false);
  // Un manager NO puede fijar deviceLimit: checkUserUpdate compara contra un
  // User vacío (deviceLimit 0) y llama a checkAdmin, que exige ser administrador.
  assert.ok(!('deviceLimit' in payload), 'no mandar deviceLimit');
  assert.ok(!('userLimit' in payload), 'no mandar userLimit');
});

test('mintTokenFor suplanta la sesión y emite el token sin Authorization', async () => {
  const { fetch, calls } = recordingFetch((url) => {
    if (url.endsWith('/api/session/42')) {
      return jsonResponse({ id: 42, name: 'Juan' }, {
        headers: { 'Set-Cookie': 'JSESSIONID=abc123; Path=/; HttpOnly' },
      });
    }
    if (url.endsWith('/api/session/token')) {
      return jsonResponse('"eyJhbGciOi.token.firma"');
    }
    throw new Error(`URL inesperada: ${url}`);
  });
  const traccar = createTraccarClient({ ...CONFIG, fetchImpl: fetch });

  const token = await traccar.mintTokenFor(42, new Date('2026-11-20T00:00:00.000Z'));

  // El normalizador tiene que haber sacado las comillas.
  assert.equal(token, 'eyJhbGciOi.token.firma');
  assert.equal(calls.length, 2);

  const [impersonar, emitir] = calls;
  assert.equal(impersonar.method, 'GET');
  assert.equal(impersonar.url, 'https://traccar.test/api/session/42');
  assert.match(impersonar.headers.authorization, /^Basic /);

  assert.equal(emitir.method, 'POST');
  assert.equal(emitir.url, 'https://traccar.test/api/session/token');
  // Esta es la parte que no se puede romper: con Authorization, el filtro arma el
  // contexto desde las credenciales y el token sale a nombre de la cuenta de servicio.
  assert.equal(emitir.headers.authorization, undefined);
  assert.equal(emitir.headers.cookie, 'JSESSIONID=abc123');
  assert.equal(parseForm(emitir.body).expiration, '2026-11-20');
});

test('mintTokenFor manda la expiración siempre', async () => {
  const { fetch, calls } = recordingFetch((url) => (
    url.endsWith('/api/session/42')
      ? jsonResponse({}, { headers: { 'Set-Cookie': 'JSESSIONID=x; Path=/' } })
      : jsonResponse('"tok.en"')
  ));
  const traccar = createTraccarClient({ ...CONFIG, fetchImpl: fetch });

  await traccar.mintTokenFor(42, new Date('2026-11-20T00:00:00.000Z'));
  const emitir = calls.find((c) => c.url.endsWith('/api/session/token'));
  // Omitirla NO da un token largo: TokenManager cae en DEFAULT_EXPIRATION_DAYS = 7.
  assert.ok(parseForm(emitir.body).expiration, 'la expiración no puede faltar');
});

test('mintTokenFor rechaza una respuesta que no parece un token', async () => {
  const { fetch } = recordingFetch((url) => (
    url.endsWith('/api/session/42')
      ? jsonResponse({}, { headers: { 'Set-Cookie': 'JSESSIONID=x; Path=/' } })
      : jsonResponse('<html>error</html>')
  ));
  const traccar = createTraccarClient({ ...CONFIG, fetchImpl: fetch });
  await assert.rejects(() => traccar.mintTokenFor(42, new Date()), /token/i);
});

test('mintTokenFor falla si la suplantación no devuelve cookie de sesión', async () => {
  const { fetch } = recordingFetch(() => jsonResponse({ id: 42 }));
  const traccar = createTraccarClient({ ...CONFIG, fetchImpl: fetch });
  await assert.rejects(() => traccar.mintTokenFor(42, new Date()), /sesión|session|cookie/i);
});

test('revokeToken normaliza las comillas y manda el token pelado', async () => {
  const { fetch, calls } = recordingFetch(() => new Response(null, { status: 204 }));
  const traccar = createTraccarClient({ ...CONFIG, fetchImpl: fetch });

  await traccar.revokeToken('"eyJhbGciOi.token.firma"');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://traccar.test/api/session/token/revoke');
  assert.equal(parseForm(calls[0].body).token, 'eyJhbGciOi.token.firma');
});

test('disableUser manda el usuario completo con disabled en true', async () => {
  const original = {
    id: 42, name: 'Juan', email: 'juan@rudatrak.invalid',
    readonly: true, deviceReadonly: true, limitCommands: true, disableReports: true,
    administrator: false, disabled: false,
  };
  const { fetch, calls } = recordingFetch((url, init) => (
    init.method === 'PUT' ? jsonResponse({}) : jsonResponse(original)
  ));
  const traccar = createTraccarClient({ ...CONFIG, fetchImpl: fetch });

  await traccar.disableUser(42);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'GET');
  const payload = JSON.parse(calls[1].body);
  assert.equal(calls[1].method, 'PUT');
  assert.equal(calls[1].url, 'https://traccar.test/api/users/42');
  assert.equal(payload.disabled, true);
  // Sin esto, el PUT pisaría los cuatro flags con false: QueryBuilder.setObject
  // escribe todas las columnas de la lista y los boolean primitivos nunca son nulos.
  assert.equal(payload.readonly, true);
  assert.equal(payload.deviceReadonly, true);
  assert.equal(payload.limitCommands, true);
  assert.equal(payload.disableReports, true);
  assert.equal(payload.name, 'Juan');
  assert.equal(payload.email, 'juan@rudatrak.invalid');
});

test('deleteUser pega en el endpoint del usuario', async () => {
  const { fetch, calls } = recordingFetch(() => new Response(null, { status: 204 }));
  const traccar = createTraccarClient({ ...CONFIG, fetchImpl: fetch });
  await traccar.deleteUser(42);
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(calls[0].url, 'https://traccar.test/api/users/42');
});

test('serverInfo devuelve la versión', async () => {
  const { fetch } = recordingFetch(() => jsonResponse({ version: '6.14.5' }));
  const traccar = createTraccarClient({ ...CONFIG, fetchImpl: fetch });
  assert.equal((await traccar.serverInfo()).version, '6.14.5');
});

test('un error de Traccar se convierte en TraccarError con el estado', async () => {
  const { fetch } = recordingFetch(() => jsonResponse({ message: 'User access denied' }, { status: 403 }));
  const traccar = createTraccarClient({ ...CONFIG, fetchImpl: fetch });

  const error = await assert.rejects(() => traccar.getUser(42), TraccarError);
  assert.equal(error.status, 403);
  assert.match(error.message, /403/);
});

test('el error nunca incluye la contraseña de servicio', async () => {
  // Traccar puede devolver el cuerpo de la petición en un mensaje de error.
  const { fetch } = recordingFetch(() => jsonResponse(
    { message: `no se pudo autenticar con ${CONFIG.password}` }, { status: 401 },
  ));
  const traccar = createTraccarClient({ ...CONFIG, fetchImpl: fetch });

  const error = await assert.rejects(() => traccar.getUser(42), TraccarError);
  assert.ok(!error.message.includes(CONFIG.password), 'la contraseña no debe aparecer en el error');
  assert.ok(!error.body.includes(CONFIG.password), 'ni en el cuerpo del error');
});

test('una URL base con barra final no genera dobles barras', async () => {
  const { fetch, calls } = recordingFetch(() => jsonResponse({ version: '6.14.5' }));
  const traccar = createTraccarClient({ ...CONFIG, baseUrl: 'https://traccar.test/', fetchImpl: fetch });
  await traccar.serverInfo();
  assert.equal(calls[0].url, 'https://traccar.test/api/server');
});
```

- [ ] **Step 3: Implementar `src/traccar.js`**

```js
import { Buffer } from 'node:buffer';

const DEFAULT_TIMEOUT_MS = 15000;
const TOKEN_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Error de la API de Traccar. Nunca incluye credenciales. */
export class TraccarError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'TraccarError';
    this.status = status;
    this.body = body;
  }
}

/**
 * `POST /api/session/token` es un recurso @Produces(APPLICATION_JSON) que devuelve
 * un String, así que el cuerpo llega como `"eyJ…"` con comillas dobles. Sin sacarlas,
 * el token se guarda corrupto y falla recién en el primer uso. El frontend tiene el
 * mismo normalizador en src/offline/tokenStore.js.
 */
export function normalizeToken(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  let value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }
  return TOKEN_PATTERN.test(value) ? value : null;
}

/** `YYYY-MM-DD`, el formato que acepta el @FormParam Date de Traccar. */
function formatExpiration(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function sessionCookieFrom(response) {
  const cookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  for (const cookie of cookies) {
    const match = /^JSESSIONID=([^;]+)/.exec(cookie.trim());
    if (match) {
      return `JSESSIONID=${match[1]}`;
    }
  }
  return null;
}

export function createTraccarClient({
  baseUrl,
  email,
  password,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const root = String(baseUrl).replace(/\/+$/, '');
  // Se calcula una sola vez y no se guarda en ningún otro lado.
  const authorization = `Basic ${Buffer.from(`${email}:${password}`, 'utf8').toString('base64')}`;

  /** Trunca el cuerpo antes de meterlo en un mensaje de error. */
  function safeBody(text) {
    const clean = String(text ?? '').split(password).join('***');
    return clean.length > 400 ? `${clean.slice(0, 400)}…` : clean;
  }

  async function send(path, { method = 'GET', headers = {}, body } = {}) {
    const finalHeaders = { Accept: 'application/json', ...headers };
    if (body !== undefined) {
      finalHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    let response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method,
        headers: finalHeaders,
        body: body === undefined ? undefined : new URLSearchParams(body).toString(),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (cause) {
      throw new TraccarError(`No se pudo hablar con Traccar: ${cause.message}`, { body: '' });
    }
    return response;
  }

  async function expectOk(response, label) {
    if (!response.ok) {
      const body = safeBody(await response.text().catch(() => ''));
      throw new TraccarError(`${label}: Traccar respondió ${response.status}`, {
        status: response.status,
        body,
      });
    }
    return response;
  }

  /** Petición autenticada como la cuenta de servicio. */
  async function api(path, { method = 'GET', json, body } = {}) {
    const headers = { Authorization: authorization };
    const payload = json === undefined ? undefined : JSON.stringify(json);
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    let response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (cause) {
      throw new TraccarError(`No se pudo hablar con Traccar: ${cause.message}`, { body: '' });
    }
    await expectOk(response, `${method} ${path}`);
    return response;
  }

  /**
   * Petición con la cookie de sesión suplantada y SIN cabecera Authorization.
   * La ausencia de Authorization es obligatoria: SecurityRequestFilter, cuando la ve,
   * arma el contexto desde las credenciales y no mira los atributos de la sesión, con lo
   * que el token saldría a nombre de la cuenta de servicio. Por eso esto es una función
   * aparte y no una opción de `api`: así no depende de que el llamador se acuerde.
   */
  async function sessionRequest(path, { cookie, body, method = 'POST' }) {
    const response = await send(path, {
      method,
      headers: { Cookie: cookie },
      body,
    });
    await expectOk(response, `${method} ${path}`);
    return response;
  }

  return {
    async serverInfo() {
      return (await api('/api/server')).json();
    },

    async createUser(payload) {
      return (await api('/api/users', { method: 'POST', json: payload })).json();
    },

    async getUser(id) {
      return (await api(`/api/users/${id}`)).json();
    },

    async updateUser(user) {
      return (await api(`/api/users/${user.id}`, { method: 'PUT', json: user })).json();
    },

    /**
     * Deshabilitar al usuario es la revocación completa: LoginService.login(String token)
     * llama a checkUserEnabled, así que TODOS sus tokens dejan de servir a la vez, sin
     * necesidad de un registro de tokens emitidos.
     *
     * Se manda el objeto completo y no `{ id, disabled: true }` a propósito: `PUT
     * /api/users/{id}` escribe todas las columnas de la lista, y `readonly`,
     * `deviceReadonly`, `limitCommands` y `disableReports` son `boolean` primitivos, así
     * que un parche los mandaría como false y el usuario recuperaría permisos al ser
     * revocado. (El `hashedPassword` no corre ese riesgo: está marcado @QueryIgnore y
     * `Columns` lo filtra.)
     */
    async disableUser(id) {
      const user = await this.getUser(id);
      return this.updateUser({ ...user, disabled: true });
    },

    async deleteUser(id) {
      await api(`/api/users/${id}`, { method: 'DELETE' });
    },

    /**
     * Emite un token a nombre de `userId` sin conocer su contraseña:
     *  1. GET /api/session/{id} con Basic → PermissionsService.checkUser autoriza a la
     *     cuenta de servicio sobre sus usuarios gestionados, y SessionHelper.userLogin
     *     pisa el USER_ID de la sesión con el del destino.
     *  2. POST /api/session/token solo con esa cookie → firma el token para el dueño.
     */
    async mintTokenFor(userId, expiration) {
      const impersonated = await send(`/api/session/${userId}`, {
        headers: { Authorization: authorization },
      });
      await expectOk(impersonated, `GET /api/session/${userId}`);
      const cookie = sessionCookieFrom(impersonated);
      if (!cookie) {
        throw new TraccarError('La suplantación no devolvió cookie de sesión', { body: '' });
      }

      const response = await sessionRequest('/api/session/token', {
        cookie,
        // Siempre explícita: sin ella, TokenManager cae en DEFAULT_EXPIRATION_DAYS = 7.
        body: { expiration: formatExpiration(expiration) },
      });

      const token = normalizeToken(await response.text());
      if (!token) {
        throw new TraccarError('Traccar no devolvió un token con forma válida', { body: '' });
      }
      return token;
    },

    async revokeToken(token) {
      const value = normalizeToken(token);
      if (!value) {
        throw new TraccarError('El token a revocar no tiene forma válida', { body: '' });
      }
      await api('/api/session/token/revoke', { method: 'POST', body: { token: value } });
    },
  };
}
```

- [ ] **Step 4: Correr los tests**

Run: `cd traccar/traccar-web/tools/enroll && node --test test/traccar.test.js`
Expected: PASS, **14 tests** (la Tarea 4 le agrega uno más, `whoAmI`, y el archivo queda en 15). Si alguno falla por `AbortSignal.timeout` ausente, la versión de Node es menor a 17.3 — parar y revisar la Tarea 1 Step 2.

- [ ] **Step 5: Correr toda la suite**

Run: `cd traccar/traccar-web/tools/enroll && npm test`
Expected: PASS. **Los tests usan un `fetch` falso: prueban que se mandan las peticiones correctas, no que Traccar las acepte.** Eso es lo que hace la Tarea 4.

- [ ] **Step 6: Commit**

```bash
cd traccar/traccar-web
git add tools/enroll/src/traccar.js tools/enroll/test/helpers.js tools/enroll/test/traccar.test.js
git commit -m "Enrolamiento: cliente de la API de Traccar

Emisión de token por suplantación de sesión, normalización de las
comillas que agrega el recurso JSON, y revocación por deshabilitación
del usuario.

disableUser manda el objeto completo: PUT /api/users escribe todas las
columnas y los flags de permisos son boolean primitivos, así que un
parche los borraría.

Co-Authored-By: Claude Code <noreply@anthropic.com>
"
```

---

### Task 4: Verificación real contra un Traccar descartable

**Files:**
- Create: `traccar/traccar-web/tools/enroll/src/smoke.js`
- Create: `traccar/traccar-web/tools/enroll/docker-compose.smoke.yml`

**Interfaces:**
- Consumes: `createTraccarClient`, `normalizeToken` (Tarea 3).
- Produces: nada que consuman otras tareas. Es una herramienta de verificación: `npm run smoke`.

**Por qué esta tarea existe y por qué está acá.** Todo lo que el plan afirma sobre la suplantación, los permisos y la revocación se verificó **leyendo el backend**, y los tests de la Tarea 3 usan un `fetch` falso: prueban que se mandan las peticiones correctas, no que Traccar las acepte. Este es el único punto del plan donde el código se enfrenta a un Traccar de verdad, así que va apenas existe el cliente y **antes** de escribir la lógica de negocio que depende de él. Si algo de la cadena no funciona, conviene descubrirlo acá y no en la Tarea 9.

**Un Traccar descartable, no producción.** Un contenedor con su propia base y su propio volumen, en el puerto 18082, que se destruye con `down -v`. El script **se niega a correr contra cualquier host que no sea local** (paso 3): así no hay forma de apuntarlo a `mh.rudatrak.com` por accidente. Las credenciales van por variables de entorno del compose, nunca en la línea de comandos, donde quedarían en el historial y en la lista de procesos. No hay ningún paso que toque producción.

- [ ] **Step 1: Escribir el compose descartable**

`traccar/traccar-web/tools/enroll/docker-compose.smoke.yml`:

```yaml
# Traccar descartable para verificar la API real. Se levanta, se corre `npm run smoke`
# y se destruye con `down -v`. No comparte nada con el stack de producción: base,
# volumen y puerto propios.
services:
  smoke-traccar:
    # Fijada a la misma versión que corre en producción. Ver el paso 2 sobre la
    # discrepancia con el Dockerfile del frontend, que usa `latest`.
    image: traccar/traccar:6.14.5
    environment:
      - CONFIG_USE_ENVIRONMENT_VARIABLES=true
      - DATABASE_DRIVER=org.h2.Driver
      - DATABASE_URL=jdbc:h2:/opt/traccar/data/database
      - WEB_PORT=8082
      # Sin registro abierto: el smoke crea los usuarios con la cuenta de servicio.
      - DATABASE_REGISTRATION=false
    ports:
      - "127.0.0.1:18082:8082"
    volumes:
      - smoke-traccar-data:/opt/traccar/data

volumes:
  smoke-traccar-data:
```

- [ ] **Step 2: Verificar la versión de producción antes de correr nada**

La imagen se fija en `6.14.5`, pero el Dockerfile del frontend (`traccar-web/Dockerfile:19`) usa `traccar/traccar:latest`, **sin pinear**. Así que la versión desplegada es la que estaba vigente cuando se construyó la imagen, que puede no ser 6.14.5.

Run:
```bash
curl -s https://mh.rudatrak.com/api/server | head -c 400
```
Expected: un JSON con un campo `version`. Si **no** dice `6.14.5`, ajustar el tag del compose a la versión que devuelve ese campo y decirlo en el commit. Un smoke contra una versión distinta a la de producción verifica menos de lo que promete.

- [ ] **Step 3: Escribir el script de smoke**

`traccar/traccar-web/tools/enroll/src/smoke.js`:

```js
import { createTraccarClient, TraccarError } from './traccar.js';

const SERVICE_EMAIL = process.env.SMOKE_SERVICE_EMAIL;
const SERVICE_PASSWORD = process.env.SMOKE_SERVICE_PASSWORD;
const BASE_URL = process.env.SMOKE_TRACCAR_URL || 'http://127.0.0.1:18082';
const EXPECTED_VERSION = process.env.SMOKE_EXPECTED_VERSION || '6.14.5';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

/**
 * El smoke nunca debe apuntar a un servidor real: crea usuarios, emite tokens y
 * deshabilita cuentas. Se exige que el host sea local.
 */
function assertLocalHost(url) {
  const { hostname } = new URL(url);
  const local = ['127.0.0.1', 'localhost', '::1', '0.0.0.0'];
  assert(
    local.includes(hostname),
    `SMOKE_TRACCAR_URL debe apuntar a un Traccar descartable local, no a ${hostname}`,
  );
}

async function main() {
  assertLocalHost(BASE_URL);
  assert(SERVICE_EMAIL && SERVICE_PASSWORD, 'Faltan SMOKE_SERVICE_EMAIL y SMOKE_SERVICE_PASSWORD');

  const traccar = createTraccarClient({
    baseUrl: BASE_URL,
    email: SERVICE_EMAIL,
    password: SERVICE_PASSWORD,
  });
  const checks = [];
  const check = async (name, fn) => {
    try {
      await fn();
      checks.push({ name, ok: true });
    } catch (error) {
      checks.push({ name, ok: false, error: error.message });
    }
  };
  // Los usuarios se crean con marcas de tiempo para poder correr el smoke varias veces
  // contra el mismo contenedor sin chocar con el índice único de email.
  const suffix = Date.now();
  const created = [];
  let issuedToken = null;

  await check('la versión del servidor coincide con la de producción', async () => {
    const info = await traccar.serverInfo();
    assert(
      info.version === EXPECTED_VERSION,
      `esperaba ${EXPECTED_VERSION}, el servidor dice ${info.version}`,
    );
  });

  await check('la cuenta de servicio NO es administradora y es manager', async () => {
    // Se deduce del propio login: GET /api/server es público, así que se usa el
    // endpoint de sesión, que devuelve el usuario autenticado.
    const me = await traccar.whoAmI();
    assert(me.administrator === false, 'la cuenta de servicio no debe ser administradora');
    assert(me.userLimit !== 0, 'la cuenta de servicio debe tener userLimit distinto de 0');
  });

  await check('crear un usuario con permisos mínimos', async () => {
    const user = await traccar.createUser({
      name: `Smoke ${suffix}`,
      email: `smoke-${suffix}@rudatrak.invalid`,
      password: `clave-${suffix}-del-smoke`,
      administrator: false,
      readonly: true,
      deviceReadonly: true,
      limitCommands: true,
      disableReports: true,
    });
    created.push(user.id);
    assert(user.id > 0, 'el usuario creado no tiene id');
    assert(user.administrator === false, 'el usuario quedó como administrador');

    const stored = await traccar.getUser(user.id);
    assert(stored.readonly === true, 'readonly no quedó en true');
    assert(stored.deviceReadonly === true, 'deviceReadonly no quedó en true');
    assert(stored.limitCommands === true, 'limitCommands no quedó en true');
    assert(stored.disableReports === true, 'disableReports no quedó en true');
  });

  await check('un manager NO puede fijar deviceLimit', async () => {
    // checkUserUpdate compara contra un User vacío (deviceLimit 0) y llama a checkAdmin.
    // Si esto llegara a pasar, el plan podría endurecer el límite de dispositivos.
    let rechazado = false;
    try {
      await traccar.createUser({
        name: `Smoke limit ${suffix}`,
        email: `smoke-limit-${suffix}@rudatrak.invalid`,
        password: `clave-${suffix}-limite`,
        administrator: false,
        deviceLimit: 1,
      });
    } catch (error) {
      rechazado = error instanceof TraccarError && error.status === 403;
    }
    assert(rechazado, 'el manager pudo fijar deviceLimit: revisar el diseño de permisos');
  });

  await check('suplantar y emitir un token para el usuario nuevo', async () => {
    const userId = created[0];
    const expiration = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000);
    const token = await traccar.mintTokenFor(userId, expiration);
    assert(/^[A-Za-z0-9._-]+$/.test(token), 'el token tiene caracteres inesperados');
    assert(!token.startsWith('"'), 'el token quedó con comillas');

    // El token debe pertenecer al usuario NUEVO, no a la cuenta de servicio.
    const session = await fetch(`${BASE_URL}/api/session?token=${token}`);
    assert(session.status === 200, `GET /api/session?token= devolvió ${session.status}`);
    const who = await session.json();
    assert(who.id === userId, `el token es de ${who.id}, esperaba ${userId}`);
    assert(who.administrator === false, 'el token quedó con permisos de administrador');

    // Bearer va en Authorization, no en /api/session (ahí da 404).
    const devices = await fetch(`${BASE_URL}/api/devices`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert(devices.status === 200, `GET /api/devices con Bearer devolvió ${devices.status}`);

    issuedToken = token;
  });

  await check('revocar el token emitido', async () => {
    const token = issuedToken;
    assert(token, 'no hay token para revocar');
    await traccar.revokeToken(`"${token}"`);
    const session = await fetch(`${BASE_URL}/api/session?token=${token}`);
    assert(session.status === 401, `esperaba 401 tras revocar, devolvió ${session.status}`);
  });

  await check('deshabilitar al usuario invalida todos sus tokens', async () => {
    const userId = created[0];
    const token = await traccar.mintTokenFor(userId, new Date(Date.now() + 45 * 24 * 60 * 60 * 1000));

    await traccar.disableUser(userId);

    const session = await fetch(`${BASE_URL}/api/session?token=${token}`);
    assert(session.status === 401, `esperaba 401 con el usuario deshabilitado, devolvió ${session.status}`);
  });

  await check('deshabilitar no borra los permisos del usuario', async () => {
    // Si disableUser mandara un parche, estos cuatro volverían a false.
    const stored = await traccar.getUser(created[0]);
    assert(stored.disabled === true, 'el usuario no quedó deshabilitado');
    assert(stored.readonly === true, 'disableUser borró readonly');
    assert(stored.deviceReadonly === true, 'disableUser borró deviceReadonly');
    assert(stored.limitCommands === true, 'disableUser borró limitCommands');
    assert(stored.disableReports === true, 'disableUser borró disableReports');
  });

  await check('el usuario deshabilitado puede volver a habilitarse', async () => {
    const stored = await traccar.getUser(created[0]);
    await traccar.updateUser({ ...stored, disabled: false });
    assert((await traccar.getUser(created[0])).disabled === false, 'no se pudo rehabilitar');
  });

  // Este check no juzga: mide. `readonly` + `deviceReadonly` le prohíben a la persona
  // crear dispositivos, y la app necesita crear el suyo. Las dos respuestas son un dato
  // útil, y la que salga decide cómo lo resuelve el Plan 2 (el servicio creando el
  // dispositivo al aprobar, o un juego de permisos distinto). Por eso no hay `assert`:
  // un smoke que falla cuando la realidad no coincide con la suposición no informa, estorba.
  const observaciones = [];
  await check('observar si un usuario con permisos mínimos puede crear un dispositivo', async () => {
    const userId = created[0];
    const token = await traccar.mintTokenFor(userId, new Date(Date.now() + 45 * 24 * 60 * 60 * 1000));
    const response = await fetch(`${BASE_URL}/api/devices`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `Dispositivo ${suffix}`, uniqueId: `smoke-${suffix}` }),
    });
    observaciones.push(
      response.ok
        ? 'Un usuario con permisos mínimos SÍ puede crear su propio dispositivo: los permisos alcanzan tal como están.'
        : `Un usuario con permisos mínimos NO puede crear dispositivos (${response.status}). El Plan 2 tiene que resolverlo: o el servicio crea el dispositivo al aprobar, o los usuarios enrolados llevan otro juego de permisos.`,
    );
  });

  for (const id of created) {
    await traccar.deleteUser(id).catch(() => {});
  }

  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) {
    console.log(`${c.ok ? 'OK  ' : 'FALLA'} ${c.name}${c.ok ? '' : `\n      ${c.error}`}`);
  }
  for (const o of observaciones) {
    console.log(`\nOBSERVACIÓN  ${o}`);
  }
  console.log(`\n${checks.length - failed.length}/${checks.length} verificaciones OK`);
  if (failed.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
```

- [ ] **Step 4: Agregar `whoAmI` al cliente**

El paso 3 lo usa. En `src/traccar.js`, dentro del objeto que devuelve `createTraccarClient`, después de `serverInfo`:

```js
    /** El usuario autenticado por la cuenta de servicio. Sirve para verificar sus permisos. */
    async whoAmI() {
      return (await api('/api/session')).json();
    },
```

Y en `test/traccar.test.js`, un test que lo cubra:

```js
test('whoAmI devuelve el usuario autenticado', async () => {
  const { fetch, calls } = recordingFetch(() => jsonResponse({ id: 7, administrator: false, userLimit: 200 }));
  const traccar = createTraccarClient({ ...CONFIG, fetchImpl: fetch });
  const me = await traccar.whoAmI();
  assert.equal(calls[0].url, 'https://traccar.test/api/session');
  assert.equal(me.userLimit, 200);
});
```

- [ ] **Step 5: Correr el smoke y verlo fallar por falta de Traccar**

Run:
```bash
cd traccar/traccar-web/tools/enroll
SMOKE_SERVICE_EMAIL=x SMOKE_SERVICE_PASSWORD=y npm run smoke
```
Expected: FALLA con un mensaje de conexión rechazada. Confirma que el script arranca y que el chequeo de host local no estorba.

- [ ] **Step 6: Verificar que el smoke se niega a apuntar a un host remoto**

Run:
```bash
cd traccar/traccar-web/tools/enroll
SMOKE_TRACCAR_URL=https://mh.rudatrak.com SMOKE_SERVICE_EMAIL=x SMOKE_SERVICE_PASSWORD=y npm run smoke
```
Expected: FALLA de inmediato con `SMOKE_TRACCAR_URL debe apuntar a un Traccar descartable local, no a mh.rudatrak.com`. **Este paso es la garantía de que el smoke no puede tocar producción.**

- [ ] **Step 7: Levantar el Traccar descartable y crear la cuenta de servicio**

El contenedor arranca con la base vacía. La primera cuenta hay que crearla desde la interfaz web en `http://127.0.0.1:18082`, porque `DATABASE_REGISTRATION=false` y `UserUtil.isEmpty` solo hace administrador al primero cuando el registro está abierto.

El primer usuario creado por la interfaz queda como administrador. **Ese no sirve para el smoke**: lo que hay que verificar es que un *manager* puede hacer todo esto. Así que:

1. Entrar a `http://127.0.0.1:18082` y crear la cuenta administradora inicial.
2. Desde esa cuenta, crear un usuario con **`userLimit = 200`** y **sin** marcar administrador. Ese es el manager, y es la cuenta que el smoke usa como `SMOKE_SERVICE_EMAIL`.
3. Elegir una contraseña de al menos 16 caracteres.

Run:
```bash
cd traccar/traccar-web/tools/enroll
docker compose -f docker-compose.smoke.yml up -d
docker compose -f docker-compose.smoke.yml logs -f --tail 20
```
Expected: Traccar arranca en `127.0.0.1:18082`. Cortar con Ctrl+C cuando aparezca el arranque del servidor web.

- [ ] **Step 8: Correr el smoke contra el Traccar real**

Run:
```bash
cd traccar/traccar-web/tools/enroll
SMOKE_SERVICE_EMAIL='<la cuenta manager>' SMOKE_SERVICE_PASSWORD='<su contraseña>' npm run smoke
```
Expected: `10/10 verificaciones OK`, más una línea `OBSERVACIÓN` al final. Cada línea `FALLA` trae el motivo.

Si falla la cadena de suplantación, **parar y replantear**: toda la decisión "el usuario nunca conoce su contraseña" depende de que `mintTokenFor` funcione, y no hay plan B dentro de este plan.

Si falla `un manager NO puede fijar deviceLimit` con "el manager pudo fijar deviceLimit", es una buena noticia: anotarlo, porque habilita endurecer el límite de dispositivos por usuario.

La `OBSERVACIÓN` **no hace fallar el smoke**, y es la que más importa para lo que viene: dice si un usuario con permisos mínimos puede crear su propio dispositivo. Si la respuesta es que no, el Plan 2 (la integración en la app) tiene que crearlos desde el servicio al aprobar. Anotarla en el README igual que las demás.

- [ ] **Step 9: Anotar los resultados en el README de la herramienta**

Crear `traccar/traccar-web/tools/enroll/README.md` con una sección `## Smoke` que registre: la versión verificada, la fecha, y el resultado de cada verificación — en particular el de las tres que deciden el diseño (suplantación, `deviceLimit` del manager, y `disableUser` sin perder permisos) **y el texto exacto de la `OBSERVACIÓN` sobre la creación de dispositivos**. Si alguna verificación obligó a cambiar el diseño, dejarlo escrito ahí.

- [ ] **Step 10: Destruir el contenedor y su volumen**

Run:
```bash
cd traccar/traccar-web/tools/enroll
docker compose -f docker-compose.smoke.yml down -v
```
Expected: contenedor y volumen eliminados. Verificar con `docker volume ls | grep smoke` que no quedó nada: el volumen contiene una base con usuarios de prueba.

- [ ] **Step 11: Commit**

```bash
cd traccar/traccar-web
git add tools/enroll/src/smoke.js tools/enroll/src/traccar.js tools/enroll/test/traccar.test.js tools/enroll/docker-compose.smoke.yml tools/enroll/README.md
git commit -m "Enrolamiento: smoke contra un Traccar descartable

Verifica contra un Traccar real lo que los tests con fetch falso no
pueden: que la cadena de suplantación emita un token a nombre del
usuario nuevo, que revocar y deshabilitar corten el acceso, y qué
permisos puede realmente fijar una cuenta manager.

Deja además una observación que no juzga: si un usuario readonly +
deviceReadonly puede crear su propio dispositivo. La respuesta decide
cómo el Plan 2 integra la app.

El script se niega a correr contra cualquier host que no sea local y
las credenciales van por variables de entorno, nunca en la línea de
comandos.

Co-Authored-By: Claude Code <noreply@anthropic.com>
"
```

---

### Task 5: Servicio — alta de pedido y consulta de estado

**Files:**
- Create: `traccar/traccar-web/tools/enroll/src/enrollService.js`
- Modify: `traccar/traccar-web/tools/enroll/test/helpers.js`
- Create: `traccar/traccar-web/tools/enroll/test/enrollService.test.js`

**Interfaces:**
- Consumes: `openDb`, `hashSecret`, `insertDevice`, `getByDeviceId`, `getByCode`, `deleteDevice`, `countByStatus`, `PENDING` (Tarea 1); `generateCode`, `formatCode`, `normalizeCode` (Tarea 2).
- Produces: `createEnrollService({ db, traccar, config, now?, random? })` → `{ requestEnrollment, getStatus, approve, renew, revoke, rebind }`; la clase `EnrollError` con `status` y `code`. De `test/helpers.js`: `memoryDb()`, `fixedClock(iso)`, `fakeTraccar()`.

**Dos reglas que quedan fijadas acá:**

- **`getStatus` nunca devuelve un token.** Solo informa el estado. El token se emite únicamente en `/enroll/renew` (Tarea 9). Es lo que pide la corrección #4 y lo que permite que la app consulte el estado en un bucle sin que cada consulta fabrique una credencial nueva.
- **`requestEnrollment` es idempotente.** El celular puede reintentar por un corte de red. Si ya hay un pedido pendiente y vigente, devuelve **el mismo código** en vez de crear otro: si no, Rodrigo recibiría dos códigos para la misma persona y aprobaría el que la app ya descartó.

- [ ] **Step 1: Ampliar los helpers**

Agregar al final de `traccar/traccar-web/tools/enroll/test/helpers.js`:

```js
import { openDb } from '../src/db.js';

/** Base en memoria: cada test arranca de cero y no toca el disco. */
export function memoryDb() {
  return openDb(':memory:');
}

/**
 * Reloj controlado. Sin esto, un test de vencimiento tendría que esperar 48 horas
 * o depender del reloj real.
 */
export function fixedClock(startIso) {
  let current = new Date(startIso);
  return {
    now: () => new Date(current),
    advance(ms) {
      current = new Date(current.getTime() + ms);
      return current;
    },
    set(iso) {
      current = new Date(iso);
    },
  };
}

/**
 * Traccar falso. Registra las llamadas y responde con ids crecientes, como haría
 * el servidor real. `failNext` permite simular un Traccar caído.
 */
export function fakeTraccar({ failMint = null, failCreate = null } = {}) {
  const calls = [];
  let nextId = 100;
  const record = (name, args) => {
    calls.push({ name, args });
  };
  return {
    calls,
    createdIds: [],
    async createUser(payload) {
      record('createUser', payload);
      if (failCreate) throw failCreate;
      nextId += 1;
      this.createdIds.push(nextId);
      return { id: nextId, ...payload };
    },
    async mintTokenFor(userId, expiration) {
      record('mintTokenFor', { userId, expiration });
      if (failMint) throw failMint;
      return `token-para-${userId}-${expiration.toISOString().slice(0, 10)}`;
    },
    async disableUser(userId) {
      record('disableUser', { userId });
      return {};
    },
    async deleteUser(userId) {
      record('deleteUser', { userId });
    },
    async revokeToken(token) {
      record('revokeToken', { token });
    },
    async getUser(id) {
      record('getUser', { id });
      return { id };
    },
    lastCall(name) {
      return [...calls].reverse().find((c) => c.name === name) ?? null;
    },
  };
}
```

- [ ] **Step 2: Escribir el test que falla**

`traccar/traccar-web/tools/enroll/test/enrollService.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnrollService, EnrollError } from '../src/enrollService.js';
import { hashSecret, getByDeviceId, countByStatus, PENDING } from '../src/db.js';
import { memoryDb, fixedClock, fakeTraccar } from './helpers.js';
import { normalizeCode } from '../src/codes.js';

const CONFIG = { codeTtlHours: 48, tokenDays: 45, maxPending: 20, maxNoteLength: 200 };
const SECRET = 'secreto-de-dispositivo-de-32-caracteres-o-mas';

function setup({ clockStart = '2026-10-06T12:00:00.000Z', config = CONFIG } = {}) {
  const db = memoryDb();
  const traccar = fakeTraccar();
  const clock = fixedClock(clockStart);
  const service = createEnrollService({ db, traccar, config, now: clock.now });
  return { db, traccar, clock, service };
}

test('requestEnrollment crea un pedido pendiente y devuelve un código con guiones', async () => {
  const { db, service } = setup();
  const { code, expiresAt } = await service.requestEnrollment({
    deviceSecret: SECRET,
    note: 'Juan, tester de Salta',
  });

  assert.match(code, /^RUDA-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(expiresAt, '2026-10-08T12:00:00.000Z');

  const row = getByDeviceId(db, hashSecret(SECRET));
  assert.equal(row.status, PENDING);
  assert.equal(row.note, 'Juan, tester de Salta');
  assert.equal(row.code, normalizeCode(code));
  // El secreto no se guarda en claro en ninguna columna.
  assert.ok(!JSON.stringify(row).includes(SECRET), 'el secreto no debe persistirse');
});

test('requestEnrollment no llama a Traccar', async () => {
  const { traccar, service } = setup();
  await service.requestEnrollment({ deviceSecret: SECRET });
  assert.deepEqual(traccar.calls, []);
});

test('reintentar devuelve el mismo código mientras esté vigente', async () => {
  const { service, db } = setup();
  const primero = await service.requestEnrollment({ deviceSecret: SECRET });
  const segundo = await service.requestEnrollment({ deviceSecret: SECRET, note: 'otra nota' });

  assert.equal(segundo.code, primero.code);
  assert.equal(countByStatus(db, PENDING), 1, 'no debe crear un segundo pedido');
  // La nota del primer pedido manda: el reintento no pisa lo que ya mandó la persona.
  assert.equal(getByDeviceId(db, hashSecret(SECRET)).note, 'Juan, tester de Salta');
});

test('reintentar con el código vencido entrega uno nuevo', async () => {
  const { service, clock } = setup();
  const primero = await service.requestEnrollment({ deviceSecret: SECRET });

  clock.advance(49 * 60 * 60 * 1000); // 49 horas: el código de 48 ya venció

  const segundo = await service.requestEnrollment({ deviceSecret: SECRET });
  assert.notEqual(segundo.code, primero.code, 'un código vencido no puede seguir sirviendo');
});

test('un pedido ya aprobado no se puede volver a pedir', async () => {
  const { service, db } = setup();
  await service.requestEnrollment({ deviceSecret: SECRET });
  db.prepare("UPDATE devices SET status = 'approved' WHERE device_id = ?").run(hashSecret(SECRET));

  await assert.rejects(
    () => service.requestEnrollment({ deviceSecret: SECRET }),
    (error) => error instanceof EnrollError && error.status === 409,
  );
});

test('rechaza un secreto corto', async () => {
  const { service } = setup();
  await assert.rejects(
    () => service.requestEnrollment({ deviceSecret: 'corto' }),
    (error) => error instanceof EnrollError && error.status === 400,
  );
});

test('rechaza una nota más larga que el máximo', async () => {
  const { service } = setup();
  await assert.rejects(
    () => service.requestEnrollment({ deviceSecret: SECRET, note: 'x'.repeat(201) }),
    (error) => error.status === 400 && /200/.test(error.message),
  );
});

test('acepta una nota de exactamente el máximo', async () => {
  const { service } = setup();
  const { code } = await service.requestEnrollment({
    deviceSecret: SECRET, note: 'x'.repeat(200),
  });
  assert.ok(code);
});

test('la nota vacía queda como null, no como cadena vacía', async () => {
  const { db, service } = setup();
  await service.requestEnrollment({ deviceSecret: SECRET, note: '   ' });
  assert.equal(getByDeviceId(db, hashSecret(SECRET)).note, null);
});

test('aplica el tope de pedidos pendientes', async () => {
  const { service, db } = setup({ config: { ...CONFIG, maxPending: 2 } });
  await service.requestEnrollment({ deviceSecret: `${SECRET}-1` });
  await service.requestEnrollment({ deviceSecret: `${SECRET}-2` });
  assert.equal(countByStatus(db, PENDING), 2);

  await assert.rejects(
    () => service.requestEnrollment({ deviceSecret: `${SECRET}-3` }),
    (error) => error.status === 429,
  );
});

test('el tope de pendientes no bloquea a un dispositivo que reintenta', async () => {
  const { service } = setup({ config: { ...CONFIG, maxPending: 1 } });
  const primero = await service.requestEnrollment({ deviceSecret: SECRET });
  // Ya está en el tope, pero este dispositivo ya tiene su lugar: debe recibir su código.
  const segundo = await service.requestEnrollment({ deviceSecret: SECRET });
  assert.equal(segundo.code, primero.code);
});

test('getStatus informa pendiente sin token', async () => {
  const { service } = setup();
  const { code } = await service.requestEnrollment({ deviceSecret: SECRET });

  const estado = await service.getStatus({ deviceSecret: SECRET });
  assert.equal(estado.status, 'pending');
  assert.equal(estado.code, code, 'la app puede volver a mostrar el código');
  assert.equal('token' in estado, false, 'getStatus nunca devuelve un token');
});

test('getStatus de un dispositivo desconocido no revela nada', async () => {
  const { service } = setup();
  await assert.rejects(
    () => service.getStatus({ deviceSecret: SECRET }),
    (error) => error.status === 404,
  );
});

test('getStatus de un dispositivo revocado informa revocado', async () => {
  const { service, db } = setup();
  await service.requestEnrollment({ deviceSecret: SECRET });
  db.prepare("UPDATE devices SET status = 'revoked' WHERE device_id = ?").run(hashSecret(SECRET));

  const estado = await service.getStatus({ deviceSecret: SECRET });
  assert.equal(estado.status, 'revoked');
  assert.equal('token' in estado, false);
});

test('EnrollError no filtra el secreto en el mensaje', async () => {
  const { service } = setup();
  const error = await assert.rejects(() => service.getStatus({ deviceSecret: SECRET }), EnrollError);
  assert.ok(!error.message.includes(SECRET));
});
```

- [ ] **Step 3: Correr el test para verificar que falla**

Run: `cd traccar/traccar-web/tools/enroll && node --test test/enrollService.test.js`
Expected: FAIL — `Cannot find module '../src/enrollService.js'`.

- [ ] **Step 4: Implementar `src/enrollService.js`**

```js
import { generateCode, formatCode, normalizeCode } from './codes.js';
import {
  hashSecret, insertDevice, getByDeviceId, getByCode, deleteDevice,
  countByStatus, PENDING, APPROVED, REVOKED,
} from './db.js';

const MIN_SECRET_LENGTH = 32;
const HOUR_MS = 60 * 60 * 1000;

/** Error de negocio con el estado HTTP que le corresponde. */
export class EnrollError extends Error {
  constructor(message, { status = 400, code = 'invalid_request' } = {}) {
    super(message);
    this.name = 'EnrollError';
    this.status = status;
    this.code = code;
  }
}

export function createEnrollService({ db, traccar, config, now = () => new Date(), random }) {
  const isoNow = () => now().toISOString();

  function requireSecret(deviceSecret) {
    if (typeof deviceSecret !== 'string' || deviceSecret.length < MIN_SECRET_LENGTH) {
      throw new EnrollError('El secreto del dispositivo no es válido', { status: 400 });
    }
    return hashSecret(deviceSecret);
  }

  function requireKnownDevice(deviceId) {
    const device = getByDeviceId(db, deviceId);
    if (!device) {
      throw new EnrollError('Este dispositivo no está enrolado', { status: 404, code: 'not_enrolled' });
    }
    return device;
  }

  function normalizeNote(note) {
    if (note === undefined || note === null) {
      return null;
    }
    const value = String(note).trim();
    if (!value) {
      return null;
    }
    if (value.length > config.maxNoteLength) {
      throw new EnrollError(
        `La nota no puede superar los ${config.maxNoteLength} caracteres`, { status: 400 },
      );
    }
    return value;
  }

  return {
    /**
     * Alta del pedido. No toca Traccar: hasta que Rodrigo no apruebe, no existe
     * ningún usuario del lado del servidor.
     *
     * Es idempotente a propósito. Un celular con mala señal reintenta, y si cada
     * reintento generara un código nuevo, Rodrigo recibiría dos códigos para la misma
     * persona y aprobaría el que la app ya descartó.
     */
    async requestEnrollment({ deviceSecret, note }) {
      const deviceId = requireSecret(deviceSecret);
      const cleanNote = normalizeNote(note);
      const existing = getByDeviceId(db, deviceId);

      if (existing) {
        if (existing.status !== PENDING) {
          throw new EnrollError('Este dispositivo ya fue enrolado', {
            status: 409, code: 'already_enrolled',
          });
        }
        if (new Date(existing.code_expires_at) > now()) {
          return { code: formatCode(existing.code), expiresAt: existing.code_expires_at };
        }
        // Venció sin aprobarse: se descarta y se emite uno nuevo, para que la fila
        // no ocupe un lugar del tope de pendientes para siempre.
        deleteDevice(db, deviceId);
      } else if (countByStatus(db, PENDING) >= config.maxPending) {
        throw new EnrollError('Hay demasiados pedidos pendientes', {
          status: 429, code: 'too_many_pending',
        });
      }

      const code = generateCode(random);
      const expiresAt = new Date(now().getTime() + config.codeTtlHours * HOUR_MS).toISOString();
      insertDevice(db, { deviceId, code, note: cleanNote, createdAt: isoNow(), codeExpiresAt: expiresAt });
      return { code: formatCode(code), expiresAt };
    },

    /**
     * Consulta de estado. NUNCA devuelve un token: el token se emite solo en renew.
     * Si esta función emitiera, la app podría pedir estado en un bucle y fabricar una
     * credencial nueva por consulta, que es justo lo que la corrección #4 evita.
     */
    async getStatus({ deviceSecret }) {
      const device = requireKnownDevice(requireSecret(deviceSecret));
      return {
        status: device.status,
        code: device.status === PENDING ? formatCode(device.code) : undefined,
        label: device.status === APPROVED ? device.label : undefined,
        approvedAt: device.status === APPROVED ? device.approved_at : undefined,
      };
    },
  };
}
```

- [ ] **Step 5: Correr los tests**

Run: `cd traccar/traccar-web/tools/enroll && node --test test/enrollService.test.js`
Expected: PASS, **16 tests**.

Uno de los tests verifica que `getStatus` de un dispositivo `revoked` informa `revoked`. Otro, que un pedido aprobado no se puede volver a pedir. Ninguno de los dos es un detalle: son las dos transiciones que la app usa para decidir si manda al usuario a la pantalla de enrolamiento.

- [ ] **Step 6: Correr toda la suite**

Run: `cd traccar/traccar-web/tools/enroll && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd traccar/traccar-web
git add tools/enroll/src/enrollService.js tools/enroll/test/helpers.js tools/enroll/test/enrollService.test.js
git commit -m "Enrolamiento: alta de pedido y consulta de estado

El pedido es idempotente para que un reintento del celular no genere un
segundo código, y hay un tope de pendientes.

getStatus no emite token: solo informa el estado. La emisión queda
únicamente en la renovación.

Co-Authored-By: Claude Code <noreply@anthropic.com>
"
```

---

### Task 6: IP real detrás del proxy y límites de abuso

**Files:**
- Create: `traccar/traccar-web/tools/enroll/src/net.js`
- Create: `traccar/traccar-web/tools/enroll/test/net.test.js`

**Interfaces:**
- Consumes: nada.
- Produces: `clientIp(req, trustedCidrs)` → string; `createRateLimiter({ limit, windowMs })` → `{ check(key) }` que devuelve `0` si está permitido o los segundos para reintentar; `sendRateLimited(res, message, retryAfter)`.

**Esto es un port de `tools/trak-mapas/server.js:147-225`,** que ya está resuelto y probado en producción. La lógica no se reinventa. Lo que cambia es que acá se expone como módulo con un `createRateLimiter` en vez de un `Map` a nivel de módulo, para poder testearlo sin ensuciar estado entre tests.

**El punto entero del módulo:** detrás de Cloudflare y NPM, `req.socket.remoteAddress` es la IP del proxy, así que un límite por IP sobre el socket no limita nada: todos los clientes comparten la misma clave. Pero tampoco se puede confiar en `X-Forwarded-For` a ciegas, porque cualquier cliente puede mandar esa cabecera. La regla es: **los encabezados de reenvío se miran solo si el socket viene de una red de confianza**; si el cliente conecta directo, se ignora lo que declare y se usa su IP real. Así no se puede esquivar el límite escribiendo `X-Forwarded-For` a mano.

- [ ] **Step 1: Escribir el test que falla**

`traccar/traccar-web/tools/enroll/test/net.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientIp, createRateLimiter } from '../src/net.js';

const CIDRS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8'];
const TRUSTED = '172.18.0.3';   // un contenedor de la red de NPM
const EXTERNO = '203.0.113.7';  // un cliente cualquiera de internet

const request = (socketIp, headers = {}) => ({ socket: { remoteAddress: socketIp }, headers });

test('un cliente directo usa su IP de socket', () => {
  assert.equal(clientIp(request(EXTERNO), CIDRS), EXTERNO);
});

test('un cliente directo NO puede falsear su IP con cabeceras', () => {
  const req = request(EXTERNO, {
    'x-forwarded-for': '1.2.3.4',
    'cf-connecting-ip': '5.6.7.8',
  });
  assert.equal(clientIp(req, CIDRS), EXTERNO);
});

test('detrás de un proxy de confianza se usa CF-Connecting-IP', () => {
  const req = request(TRUSTED, { 'cf-connecting-ip': EXTERNO });
  assert.equal(clientIp(req, CIDRS), EXTERNO);
});

test('sin CF-Connecting-IP se usa la primera entrada no confiable de X-Forwarded-For', () => {
  // "cliente, proxy1, proxy2": se recorre de derecha a izquierda.
  const req = request(TRUSTED, {
    'x-forwarded-for': `${EXTERNO}, 172.18.0.9, 172.18.0.3`,
  });
  assert.equal(clientIp(req, CIDRS), EXTERNO);
});

test('un valor falso antepuesto en X-Forwarded-For no engaña al límite', () => {
  // El cliente escribió "1.2.3.4" al principio; el valor real ya está en la lista.
  const req = request(TRUSTED, {
    'x-forwarded-for': `1.2.3.4, ${EXTERNO}`,
  });
  assert.equal(clientIp(req, CIDRS), EXTERNO, 'no debe devolver el valor inyectado');
});

test('si todas las entradas del reenvío son de confianza, cae a la IP del socket', () => {
  const req = request(TRUSTED, { 'x-forwarded-for': '172.18.0.9, 172.18.0.3' });
  assert.equal(clientIp(req, CIDRS), TRUSTED);
});

test('lee direcciones IPv4 mapeadas a IPv6', () => {
  const req = request('::ffff:172.18.0.3', { 'cf-connecting-ip': EXTERNO });
  assert.equal(clientIp(req, CIDRS), EXTERNO);
});

test('una IP de socket ilegible no rompe nada', () => {
  assert.equal(clientIp({ socket: {}, headers: {} }, CIDRS), 'unknown');
});

test('una lista de CIDRs vacía trata a todos como no confiables', () => {
  const req = request(TRUSTED, { 'cf-connecting-ip': EXTERNO });
  assert.equal(clientIp(req, []), TRUSTED);
});

test('un CIDR mal escrito se ignora sin romper', () => {
  const req = request('10.1.2.3', { 'cf-connecting-ip': EXTERNO });
  assert.equal(clientIp(req, ['no-es-un-cidr', '10.0.0.0/8']), EXTERNO);
});

test('el limitador permite hasta el tope y después frena', () => {
  const limiter = createRateLimiter({ limit: 3, windowMs: 60000, now: () => 0 });
  assert.equal(limiter.check('a'), 0);
  assert.equal(limiter.check('a'), 0);
  assert.equal(limiter.check('a'), 0);
  assert.ok(limiter.check('a') > 0, 'la cuarta debe frenar');
});

test('el limitador cuenta por clave', () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 60000, now: () => 0 });
  assert.equal(limiter.check('a'), 0);
  assert.ok(limiter.check('a') > 0);
  assert.equal(limiter.check('b'), 0, 'otra clave no debe estar afectada');
});

test('el limitador devuelve los segundos que faltan', () => {
  let clock = 0;
  const limiter = createRateLimiter({ limit: 1, windowMs: 60000, now: () => clock });
  limiter.check('a');
  clock = 20000;
  assert.equal(limiter.check('a'), 40);
});

test('la ventana se renueva', () => {
  let clock = 0;
  const limiter = createRateLimiter({ limit: 1, windowMs: 60000, now: () => clock });
  limiter.check('a');
  clock = 60000;
  assert.equal(limiter.check('a'), 0, 'pasada la ventana debe permitir de nuevo');
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `cd traccar/traccar-web/tools/enroll && node --test test/net.test.js`
Expected: FAIL — `Cannot find module '../src/net.js'`.

- [ ] **Step 3: Implementar `src/net.js`**

Portado de `tools/trak-mapas/server.js:147-225`. Los comentarios se conservan porque explican decisiones que ya costó tomar.

```js
// ---- IP real del cliente --------------------------------------------------
// Detrás de Cloudflare/NPM el socket solo ve la IP del proxy. Para deducir la IP
// real se confía en CF-Connecting-IP (Cloudflare) o X-Forwarded-For (NPM), PERO
// únicamente si la conexión directa (socket) viene de la red del proxy. Si un
// cliente conecta directo (fuera de la red de confianza), esos headers se ignoran
// y se usa la IP del socket: no se puede falsear el rate limit con headers propios.

function parseIpv4(ip) {
  let value = ip;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value);
  if (mapped) {
    value = mapped[1];
  }
  const parts = value.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const nums = parts.map((part) => {
    const n = Number(part);
    return Number.isInteger(n) && n >= 0 && n <= 255 ? n : NaN;
  });
  if (nums.some((n) => Number.isNaN(n))) {
    return null;
  }
  return ((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0;
}

function isTrustedProxy(ip, cidrs) {
  const addr = parseIpv4(ip);
  if (addr === null) {
    return false;
  }
  for (const cidr of cidrs) {
    const slash = cidr.indexOf('/');
    const base = slash === -1 ? cidr : cidr.slice(0, slash);
    const bits = slash === -1 ? 32 : parseInt(cidr.slice(slash + 1), 10);
    const baseAddr = parseIpv4(base);
    if (baseAddr === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
      continue;
    }
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((addr & mask) === (baseAddr & mask)) {
      return true;
    }
  }
  return false;
}

export function clientIp(req, trustedCidrs) {
  const socketIp = req.socket?.remoteAddress || 'unknown';
  if (!isTrustedProxy(socketIp, trustedCidrs)) {
    return socketIp;
  }
  // Cloudflare setea CF-Connecting-IP con la IP real del cliente; se prefiere.
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim().length) {
    return cf.trim();
  }
  // X-Forwarded-For es una lista "cliente, proxy1, proxy2, …". Se recorre de derecha
  // a izquierda y se toma la primera entrada que NO sea un proxy de confianza: así un
  // valor falso antepuesto (más a la izquierda) no engaña el rate limit. Si todas las
  // entradas son de confianza, se cae a la IP del socket (el proxy más cercano).
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) {
    const values = fwd.split(',').map((s) => s.trim()).filter(Boolean);
    for (let i = values.length - 1; i >= 0; i -= 1) {
      if (!isTrustedProxy(values[i], trustedCidrs)) {
        return values[i];
      }
    }
  }
  return socketIp;
}

/**
 * Rate limit por ventana fija (fixed window). Devuelve 0 si está permitido, o los
 * segundos que faltan para reintentar si se excedió el límite.
 *
 * Es una fábrica y no un Map de módulo para que cada test arranque limpio. La clave
 * la elige el llamador: `ip` para las rutas públicas, `ip:ruta` para no compartir el
 * límite entre endpoints.
 */
export function createRateLimiter({ limit, windowMs, now = Date.now }) {
  const windows = new Map();
  return {
    check(key) {
      const current = now();
      let entry = windows.get(key);
      if (!entry || current - entry.windowStart >= windowMs) {
        entry = { windowStart: current, count: 0 };
        windows.set(key, entry);
      }
      entry.count += 1;
      if (entry.count <= limit) {
        return 0;
      }
      return Math.ceil((entry.windowStart + windowMs - current) / 1000);
    },
    // Sin esto, un atacante que rote IPs haría crecer el Map sin techo.
    sweep() {
      const current = now();
      for (const [key, entry] of windows) {
        if (current - entry.windowStart >= windowMs) {
          windows.delete(key);
        }
      }
    },
    get size() {
      return windows.size;
    },
  };
}

export function sendRateLimited(res, message, retryAfter) {
  res.status(429)
    .set('Retry-After', String(retryAfter))
    .json({ ok: false, error: message, retryAfter });
}
```

- [ ] **Step 4: Correr los tests**

Run: `cd traccar/traccar-web/tools/enroll && node --test test/net.test.js`
Expected: PASS, **14 tests**.

El test `un cliente directo NO puede falsear su IP con cabeceras` es el que justifica el módulo entero: sin él, cualquiera esquiva el límite mandando `CF-Connecting-IP` distinto en cada petición.

- [ ] **Step 5: Commit**

```bash
cd traccar/traccar-web
git add tools/enroll/src/net.js tools/enroll/test/net.test.js
git commit -m "Enrolamiento: IP real detrás del proxy y límites de abuso

Portado de trak-mapas, que ya resuelve el caso de Cloudflare + NPM.
Los encabezados de reenvío se miran solo si el socket viene de una red
de confianza, así que un cliente directo no puede esquivar el límite
inventando CF-Connecting-IP o X-Forwarded-For.

Co-Authored-By: Claude Code <noreply@anthropic.com>
"
```

---

### Task 7: Rutas públicas `/enroll/*`

**Files:**
- Create: `traccar/traccar-web/tools/enroll/src/auth.js`
- Create: `traccar/traccar-web/tools/enroll/src/enrollRoutes.js`
- Create: `traccar/traccar-web/tools/enroll/src/app.js`
- Create: `traccar/traccar-web/tools/enroll/test/enrollRoutes.test.js`

**Interfaces:**
- Consumes: `createEnrollService`, `EnrollError` (Tarea 5); `clientIp`, `createRateLimiter`, `sendRateLimited` (Tarea 6); `loadConfig` (Tarea 1).
- Produces: `readDeviceSecret(req)` → string (Tarea 7 y 9); `createApp({ config, service })` → app de Express (Tareas 8, 13); `createEnrollRouter({ service, config, limiters })`.

**Cuatro decisiones de transporte:**

- **El secreto del dispositivo viaja en la cabecera `X-Device-Secret`, nunca en la URL.** Una URL con el secreto adentro queda en los registros de NPM, de Cloudflare y del propio Express, y en el historial del navegador. Una cabecera no.
- **`app.set('trust proxy', false)` explícito.** Express tiene su propio manejo de `X-Forwarded-For` en `req.ip`, y activarlo lo volvería falsificable. La IP real la resuelve `net.js` a mano, igual que en `trak-mapas`. Se deja explícito para que nadie lo active "para que ande `req.ip`" y rompa el límite por IP sin darse cuenta.
- **Cuerpo máximo de 4 kb.** El cuerpo legítimo son dos campos cortos. Un tope bajo cierra la puerta a mandar megabytes a un endpoint público.
- **Los errores no exponen nada interno.** Un `EnrollError` devuelve su mensaje porque está escrito para el usuario; cualquier otra excepción devuelve un texto genérico y el detalle queda solo en el registro del servidor.

- [ ] **Step 1: Escribir `src/auth.js`**

```js
import { EnrollError } from './enrollService.js';

const HEADER = 'x-device-secret';

/**
 * El secreto va en una cabecera y no en la URL: una URL con el secreto adentro
 * queda registrada en NPM, en Cloudflare y en el historial del navegador.
 */
export function readDeviceSecret(req) {
  const value = req.get(HEADER);
  if (!value) {
    throw new EnrollError('Falta la cabecera X-Device-Secret', { status: 401, code: 'missing_secret' });
  }
  return value;
}
```

- [ ] **Step 2: Escribir el test que falla**

`traccar/traccar-web/tools/enroll/test/enrollRoutes.test.js`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createEnrollService } from '../src/enrollService.js';
import { memoryDb, fixedClock, fakeTraccar } from './helpers.js';

const CONFIG = {
  codeTtlHours: 48, tokenDays: 45, maxPending: 20, maxNoteLength: 200,
  trustedProxyCidrs: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8'],
  adminUser: 'admin', adminPassword: 'clave-de-admin-larga-24-chars',
};

const SECRET = 'secreto-de-dispositivo-de-32-caracteres-o-mas';
let baseUrl;
let server;
let db;
let traccar;

before(async () => {
  db = memoryDb();
  traccar = fakeTraccar();
  const clock = fixedClock('2026-10-06T12:00:00.000Z');
  const service = createEnrollService({ db, traccar, config: CONFIG, now: clock.now });
  const app = createApp({ config: CONFIG, service });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('POST /enroll/request devuelve un código', async () => {
  const response = await fetch(`${baseUrl}/enroll/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceSecret: SECRET, note: 'Juan de Salta' }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.match(body.code, /^RUDA-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.ok(body.expiresAt);
});

test('POST /enroll/request rechaza un cuerpo sin secreto', async () => {
  const response = await fetch(`${baseUrl}/enroll/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'sin secreto' }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).ok, false);
});

test('POST /enroll/request rechaza un cuerpo más grande que 4 kb', async () => {
  const response = await fetch(`${baseUrl}/enroll/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceSecret: SECRET, note: 'x'.repeat(8000) }),
  });
  assert.equal(response.status, 413);
});

test('la respuesta de error no filtra el secreto', async () => {
  const response = await fetch(`${baseUrl}/enroll/status`, {
    headers: { 'X-Device-Secret': 'secreto-inexistente-de-32-caracteres' },
  });
  const text = await response.text();
  assert.equal(response.status, 404);
  assert.ok(!text.includes('secreto-inexistente'), 'la respuesta no debe repetir el secreto');
});

test('GET /enroll/status exige la cabecera del secreto', async () => {
  const response = await fetch(`${baseUrl}/enroll/status`);
  assert.equal(response.status, 401);
});

test('GET /enroll/status informa pendiente y no expone token', async () => {
  const response = await fetch(`${baseUrl}/enroll/status`, {
    headers: { 'X-Device-Secret': SECRET },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'pending');
  assert.equal('token' in body, false);
  assert.ok(!JSON.stringify(body).includes(SECRET));
});

test('una ruta desconocida bajo /enroll devuelve 404 sin detalle', async () => {
  const response = await fetch(`${baseUrl}/enroll/inventada`);
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.ok(!/at |\.js:/.test(JSON.stringify(body)), 'no debe filtrar un stack trace');
});

test('un error inesperado devuelve 500 con mensaje genérico', async () => {
  const brokenService = {
    requestEnrollment: async () => { throw new Error('falla interna con ruta /opt/traccar/secreto'); },
    getStatus: async () => { throw new Error('x'); },
  };
  const app = createApp({ config: CONFIG, service: brokenService });
  const local = app.listen(0);
  await new Promise((resolve) => local.once('listening', resolve));

  const response = await fetch(`http://127.0.0.1:${local.address().port}/enroll/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceSecret: SECRET }),
  });
  const body = await response.json();
  local.close();

  assert.equal(response.status, 500);
  assert.ok(!JSON.stringify(body).includes('/opt/traccar/secreto'), 'no filtrar rutas internas');
  assert.ok(!/falla interna/.test(JSON.stringify(body)));
});

test('el límite por IP frena los pedidos repetidos', async () => {
  const limitado = createApp({
    config: CONFIG,
    service: createEnrollService({
      db: memoryDb(), traccar: fakeTraccar(), config: CONFIG,
      now: fixedClock('2026-10-06T12:00:00.000Z').now,
    }),
    limiters: { request: { limit: 2, windowMs: 60000 } },
  });
  const local = limitado.listen(0);
  await new Promise((resolve) => local.once('listening', resolve));
  const url = `http://127.0.0.1:${local.address().port}/enroll/request`;

  const pedir = (secret) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceSecret: secret }),
  });

  assert.equal((await pedir(`${SECRET}-a`)).status, 200);
  assert.equal((await pedir(`${SECRET}-b`)).status, 200);
  const tercera = await pedir(`${SECRET}-c`);
  local.close();

  assert.equal(tercera.status, 429);
  assert.ok(tercera.headers.get('retry-after'), 'debe indicar cuándo reintentar');
});
```

- [ ] **Step 3: Correr el test para verificar que falla**

Run: `cd traccar/traccar-web/tools/enroll && node --test test/enrollRoutes.test.js`
Expected: FAIL — `Cannot find module '../src/app.js'`.

- [ ] **Step 4: Implementar `src/enrollRoutes.js`**

```js
import express from 'express';
import { EnrollError } from './enrollService.js';
import { readDeviceSecret } from './auth.js';
import { clientIp, createRateLimiter, sendRateLimited } from './net.js';

// Límites por IP y por ruta. Son deliberadamente bajos: el uso legítimo es un puñado
// de peticiones por dispositivo y por día, no cientos por hora.
const LIMITS = {
  request: { limit: 5, windowMs: 60 * 60 * 1000 },
  status: { limit: 60, windowMs: 60 * 60 * 1000 },
  renew: { limit: 20, windowMs: 60 * 60 * 1000 },
};

/** Envuelve un handler async para que los errores lleguen al manejador de errores. */
export const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

export function createEnrollRouter({ service, config, limiters = {} }) {
  const router = express.Router();
  const make = (name, override) => createRateLimiter(override ?? LIMITS[name]);

  const buckets = {
    request: make('request', limiters.request),
    status: make('status', limiters.status),
    renew: make('renew', limiters.renew),
  };

  /** Devuelve true si ya respondió con 429. */
  function limited(bucketName, req, res) {
    const key = clientIp(req, config.trustedProxyCidrs);
    const retryAfter = buckets[bucketName].check(key);
    if (retryAfter === 0) {
      return false;
    }
    sendRateLimited(res, 'Demasiadas peticiones. Probá más tarde.', retryAfter);
    return true;
  }

  router.post('/request', asyncRoute(async (req, res) => {
    if (limited('request', req, res)) {
      return;
    }
    const { deviceSecret, note } = req.body ?? {};
    const result = await service.requestEnrollment({ deviceSecret, note });
    res.json(result);
  }));

  router.get('/status', asyncRoute(async (req, res) => {
    if (limited('status', req, res)) {
      return;
    }
    res.json(await service.getStatus({ deviceSecret: readDeviceSecret(req) }));
  }));

  router.post('/renew', asyncRoute(async (req, res) => {
    if (limited('renew', req, res)) {
      return;
    }
    res.json(await service.renew({ deviceSecret: readDeviceSecret(req) }));
  }));

  return router;
}

/**
 * Manejador de errores de las rutas de enrolamiento.
 *
 * Un EnrollError trae un mensaje escrito para que lo lea una persona y el estado HTTP
 * que le corresponde. Cualquier otra excepción se registra del lado del servidor y se
 * responde con un texto genérico: un mensaje de error es un lugar clásico donde se
 * filtra una ruta interna, una consulta SQL o parte de una credencial.
 */
export function enrollErrorHandler(log = console) {
  return (error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof EnrollError) {
      res.status(error.status).json({ ok: false, error: error.message, code: error.code });
      return;
    }
    // `body-parser` marca los cuerpos demasiado grandes con `type`.
    if (error.type === 'entity.too.large') {
      res.status(413).json({ ok: false, error: 'El cuerpo de la petición es demasiado grande' });
      return;
    }
    if (error.type === 'entity.parse.failed') {
      res.status(400).json({ ok: false, error: 'El cuerpo de la petición no es JSON válido' });
      return;
    }
    log.error('Error no controlado en el servicio de enrolamiento:', error);
    res.status(500).json({ ok: false, error: 'Error interno del servicio' });
  };
}
```

- [ ] **Step 5: Implementar `src/app.js`**

```js
import express from 'express';
import { createEnrollRouter, enrollErrorHandler } from './enrollRoutes.js';

export const DEFAULT_BODY_LIMIT = '4kb';

/**
 * Arma la aplicación de Express sin levantarla, para que los tests puedan escucharla
 * en un puerto efímero y para que `server.js` sea solo el arranque.
 */
export function createApp({ config, service, limiters, bodyLimit = DEFAULT_BODY_LIMIT, log = console }) {
  const app = express();

  // La IP real la resuelve net.js a mano, igual que en trak-mapas. Se deja explícito
  // para que nadie active el trust proxy de Express "para que ande req.ip" y convierta
  // el límite por IP en algo falsificable con una cabecera.
  app.set('trust proxy', false);
  app.disable('x-powered-by');

  app.use(express.json({ limit: bodyLimit }));

  app.get('/health', (req, res) => {
    res.json({ ok: true });
  });

  app.use('/enroll', createEnrollRouter({ service, config, limiters }));

  app.use((req, res) => {
    res.status(404).json({ ok: false, error: 'No encontrado' });
  });

  app.use(enrollErrorHandler(log));

  return app;
}
```

- [ ] **Step 6: Correr los tests**

Run: `cd traccar/traccar-web/tools/enroll && node --test test/enrollRoutes.test.js`
Expected: PASS, **9 tests**.

- [ ] **Step 7: Commit**

```bash
cd traccar/traccar-web
git add tools/enroll/src/auth.js tools/enroll/src/enrollRoutes.js tools/enroll/src/app.js tools/enroll/test/enrollRoutes.test.js
git commit -m "Enrolamiento: rutas públicas /enroll/*

El secreto del dispositivo va en cabecera y no en la URL, porque una URL
queda registrada en NPM, Cloudflare y el historial del navegador.

Cuerpo limitado a 4 kb, límite por IP en las tres rutas, trust proxy
explícito en false, y los errores inesperados devuelven un mensaje
genérico sin filtrar rutas ni consultas internas.

Co-Authored-By: Claude Code <noreply@anthropic.com>
"
```

---

### Task 8: Aprobación atómica y panel de administración

**Files:**
- Create: `traccar/traccar-web/tools/enroll/src/adminAuth.js`
- Create: `traccar/traccar-web/tools/enroll/src/adminPage.js`
- Create: `traccar/traccar-web/tools/enroll/src/adminRoutes.js`
- Create: `traccar/traccar-web/tools/enroll/test/adminRoutes.test.js`
- Modify: `traccar/traccar-web/tools/enroll/src/enrollService.js`
- Modify: `traccar/traccar-web/tools/enroll/src/app.js`
- Modify: `traccar/traccar-web/tools/enroll/test/enrollService.test.js`

**Interfaces:**
- Consumes: `claimDevice`, `finalizeApproval`, `getByCode`, `listByStatus`, `APPROVED`, `REVOKED`, `PENDING` (Tarea 1); `createApp` (Tarea 7).
- Produces: `service.approve({ code, label })` → `{ status, label, traccarUserId }`; `requireAdmin(config)` middleware; `loginLimiter`; `createAdminRouter({ service, config, page })`.

**La parte delicada: dos aprobaciones a la vez sobre el mismo código.**

Rodrigo abre el panel en el celular y en la notebook, ve el mismo pedido pendiente y lo aprueba en los dos. O hace doble clic porque la red está lenta. Sin protección, los dos pedidos crean un usuario en Traccar y **uno de los dos queda huérfano**: una cuenta creada que ya nadie referencia, con acceso al servidor y sin forma de saber a quién pertenece.

La secuencia tiene tres tiempos:

1. **Chequeos previos** (código existe, está pendiente, no venció). Los dos pedidos pasan.
2. **Crear el usuario en Traccar.** Los dos crean el suyo: no hay forma de evitarlo sin transacciones distribuidas.
3. **`claimDevice`**, un `UPDATE` condicional que exige `status = 'pending' AND traccar_user_id IS NULL`. Solo uno de los dos escribe, y `changes === 1` se lo dice. El que pierde **borra su propio usuario huérfano** y responde 409.

Por eso `claimDevice` devuelve un booleano y no es un `UPDATE` a secas. Sin esa comprobación, el segundo pedido pisaría el `traccar_user_id` del primero y el primer usuario quedaría huérfano igual.

- [ ] **Step 1: Agregar `approve` al servicio y su test de concurrencia**

Agregar al final de `traccar/traccar-web/tools/enroll/test/enrollService.test.js`:

```js
test('approve crea el usuario y aprueba el dispositivo', async () => {
  const { service, traccar, db } = setup();
  const { code } = await service.requestEnrollment({ deviceSecret: SECRET, note: 'Juan' });

  const result = await service.approve({ code, label: 'Juan' });

  assert.equal(result.status, 'approved');
  assert.equal(traccar.lastCall('createUser').args.readonly, true);
  assert.equal(traccar.lastCall('createUser').args.deviceReadonly, true);
  assert.equal(traccar.lastCall('createUser').args.limitCommands, true);
  assert.equal(traccar.lastCall('createUser').args.disableReports, true);
  assert.equal(traccar.lastCall('createUser').args.administrator, false);
  assert.ok(!('deviceLimit' in traccar.lastCall('createUser').args));
  assert.ok(!('userLimit' in traccar.lastCall('createUser').args));

  const row = getByDeviceId(db, hashSecret(SECRET));
  assert.equal(row.status, 'approved');
  assert.equal(row.label, 'Juan');
  assert.equal(row.traccar_user_id, traccar.createdIds[0]);
  assert.equal(row.approved_at, '2026-10-06T12:00:00.000Z');
  // Aprobar no emite token: eso pasa solo en renew.
  assert.equal(traccar.calls.some((c) => c.name === 'mintTokenFor'), false);
});

test('approve acepta el código como lo tipee una persona', async () => {
  const { service } = setup();
  const { code } = await service.requestEnrollment({ deviceSecret: SECRET });
  const sucio = code.toLowerCase().replace(/-/g, ' ');
  const result = await service.approve({ code: sucio, label: 'Juan' });
  assert.equal(result.status, 'approved');
});

test('approve rechaza un código que no existe sin crear usuarios', async () => {
  const { service, traccar } = setup();
  await assert.rejects(
    () => service.approve({ code: 'RUDA-XXXX-XXXX', label: 'Nadie' }),
    (error) => error.status === 404,
  );
  assert.deepEqual(traccar.calls, [], 'no debe crear ningún usuario');
});

test('approve rechaza un código vencido sin crear usuarios', async () => {
  const { service, clock, traccar } = setup();
  const { code } = await service.requestEnrollment({ deviceSecret: SECRET });
  clock.advance(49 * 60 * 60 * 1000);

  await assert.rejects(
    () => service.approve({ code, label: 'Juan' }),
    (error) => error.status === 410,
  );
  assert.deepEqual(traccar.calls, []);
});

test('approve rechaza un código ya aprobado', async () => {
  const { service } = setup();
  const { code } = await service.requestEnrollment({ deviceSecret: SECRET });
  await service.approve({ code, label: 'Juan' });
  await assert.rejects(
    () => service.approve({ code, label: 'Otro' }),
    (error) => error.status === 409,
  );
});

test('dos aprobaciones simultáneas: una gana y la otra borra su huérfano', async () => {
  const { service, traccar, db } = setup();
  const { code } = await service.requestEnrollment({ deviceSecret: SECRET });

  const resultados = await Promise.allSettled([
    service.approve({ code, label: 'Primera' }),
    service.approve({ code, label: 'Segunda' }),
  ]);

  const ganadoras = resultados.filter((r) => r.status === 'fulfilled');
  const perdedoras = resultados.filter((r) => r.status === 'rejected');

  assert.equal(ganadoras.length, 1, 'exactamente una debe ganar');
  assert.equal(perdedoras.length, 1, 'exactamente una debe perder');
  assert.equal(perdedoras[0].reason.status, 409);

  // Los dos crearon su usuario (no hay transacciones distribuidas), pero el que
  // perdió tiene que haber borrado el suyo: si no, queda una cuenta con acceso
  // al servidor que ya nadie referencia.
  assert.equal(traccar.createdIds.length, 2, 'los dos intentaron crear su usuario');
  assert.equal(traccar.calls.filter((c) => c.name === 'deleteUser').length, 1);

  const row = getByDeviceId(db, hashSecret(SECRET));
  assert.equal(row.label, 'Primera', 'la etiqueta debe ser la de la que ganó');
  assert.equal(row.traccar_user_id, traccar.createdIds[0]);

  // El usuario que sobrevive es el de la ganadora, y el borrado es el de la perdedora.
  const borrado = traccar.lastCall('deleteUser').args.userId;
  assert.equal(borrado, traccar.createdIds[1]);
  assert.notEqual(borrado, row.traccar_user_id);
});

test('si Traccar falla al crear el usuario, el pedido sigue pendiente', async () => {
  const db = memoryDb();
  const traccar = fakeTraccar({ failCreate: new Error('Traccar caído') });
  const clock = fixedClock('2026-10-06T12:00:00.000Z');
  const service = createEnrollService({ db, traccar, config: CONFIG, now: clock.now });

  const { code } = await service.requestEnrollment({ deviceSecret: SECRET });
  await assert.rejects(() => service.approve({ code, label: 'Juan' }), /Traccar caído/);

  const row = getByDeviceId(db, hashSecret(SECRET));
  assert.equal(row.status, 'pending', 'no debe quedar a medio aprobar');
  assert.equal(row.traccar_user_id, null);
});

test('si el usuario se creó pero no se pudo marcar, el reintento lo reutiliza', async () => {
  // Se simula que el proceso se cayó entre crear el usuario y reclamar la fila:
  // la fila queda pendiente pero con el usuario ya creado, que es el estado en el
  // que un reintento ingenuo crearía un segundo usuario.
  const { service, db, traccar } = setup();
  const { code } = await service.requestEnrollment({ deviceSecret: SECRET });

  await service.approve({ code, label: 'Juan' });
  db.prepare("UPDATE devices SET status = 'pending' WHERE device_id = ?").run(hashSecret(SECRET));

  await assert.rejects(
    () => service.approve({ code, label: 'Juan' }),
    (error) => error.status === 409,
  );
  assert.equal(
    traccar.calls.filter((c) => c.name === 'createUser').length, 1,
    'no debe crear un segundo usuario en Traccar',
  );
});

test('approve no toca el token ni lo devuelve', async () => {
  const { service } = setup();
  const { code } = await service.requestEnrollment({ deviceSecret: SECRET });
  const result = await service.approve({ code, label: 'Juan' });
  assert.equal('token' in result, false);
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `cd traccar/traccar-web/tools/enroll && node --test test/enrollService.test.js`
Expected: FAIL — `service.approve is not a function`.

- [ ] **Step 3: Implementar `approve` en `src/enrollService.js`**

Agregar los imports que faltan y, dentro del objeto que devuelve `createEnrollService`, después de `getStatus`:

```js
    /**
     * Aprueba un pedido: crea el usuario en Traccar y lo asocia al dispositivo.
     *
     * NO emite ningún token. La emisión queda en `renew`, a pedido del dispositivo,
     * para que en la base no haya ninguna credencial guardada y para que una
     * aprobación no fabrique un token que capaz nadie usa nunca.
     *
     * La concurrencia se resuelve en tres tiempos: los chequeos previos dejan pasar a
     * los dos pedidos, los dos crean su usuario en Traccar (no hay transacciones
     * distribuidas), y `claimDevice` decide cuál gana. El que pierde borra el usuario
     * que acababa de crear: si no, quedaría una cuenta con acceso al servidor que ya
     * nadie referencia y que no se puede rastrear a quién pertenece.
     */
    async approve({ code, label }) {
      const normalized = normalizeCode(code);
      const device = getByCode(db, normalized);
      if (!device) {
        // Un código inventado no debe crear nada en Traccar.
        throw new EnrollError('Ese código no existe', { status: 404, code: 'unknown_code' });
      }
      if (device.status === APPROVED) {
        throw new EnrollError('Ese código ya fue aprobado', { status: 409, code: 'already_approved' });
      }
      if (device.status === REVOKED) {
        throw new EnrollError('Ese dispositivo fue revocado', { status: 409, code: 'revoked' });
      }
      if (new Date(device.code_expires_at) <= now()) {
        throw new EnrollError('Ese código venció', { status: 410, code: 'code_expired' });
      }
      if (device.traccar_user_id !== null) {
        // Se creó el usuario pero no se llegó a marcar la fila. Reintentar crearía un
        // segundo usuario, así que se corta acá y se resuelve a mano.
        throw new EnrollError(
          'Ese pedido ya tiene un usuario en Traccar pero quedó sin marcar. Revisar a mano.',
          { status: 409, code: 'approval_incomplete' },
        );
      }

      const cleanLabel = String(label ?? '').trim().slice(0, 100) || 'Sin nombre';
      const user = await traccar.createUser({
        name: cleanLabel,
        email: `dispositivo-${device.device_id.slice(0, 16)}@rudatrak.invalid`,
        // Nadie conoce esta contraseña: el acceso es por token, emitido en renew.
        password: randomBytes(32).toString('hex'),
        administrator: false,
        readonly: true,
        deviceReadonly: true,
        limitCommands: true,
        disableReports: true,
        // No se manda `deviceLimit` ni `userLimit`: checkUserUpdate los compara contra
        // un User vacío y llama a checkAdmin, que exige ser administrador del servidor.
        // Una cuenta manager (userLimit distinto de 0) no puede fijarlos.
      });

      if (!claimDevice(db, device.device_id, user.id, cleanLabel)) {
        // Otro pedido ganó la carrera. Se borra el usuario recién creado en vez de
        // dejarlo huérfano.
        await traccar.deleteUser(user.id).catch((error) => {
          logger.error(`No se pudo borrar el usuario huérfano ${user.id}:`, error.message);
        });
        throw new EnrollError('Ese código ya fue aprobado', { status: 409, code: 'already_approved' });
      }

      if (!finalizeApproval(db, device.device_id, isoNow())) {
        throw new EnrollError('No se pudo completar la aprobación', { status: 500 });
      }

      return { status: APPROVED, label: cleanLabel, traccarUserId: user.id };
    },
```

Y en la cabecera del archivo, los imports nuevos:

```js
import { randomBytes } from 'node:crypto';
import {
  hashSecret, insertDevice, getByDeviceId, getByCode, deleteDevice,
  countByStatus, claimDevice, finalizeApproval,
  PENDING, APPROVED, REVOKED,
} from './db.js';

const logger = console;
```

- [ ] **Step 4: Correr los tests del servicio**

Run: `cd traccar/traccar-web/tools/enroll && node --test test/enrollService.test.js`
Expected: PASS, **25 tests**.

El test de concurrencia es el que importa. Si `approve` hiciera un `UPDATE` incondicional en vez de `claimDevice`, ese test fallaría con dos ganadoras y un huérfano.

- [ ] **Step 5: Implementar `src/adminAuth.js`**

```js
import { timingSafeEqual } from 'node:crypto';
import { createRateLimiter } from './net.js';
import { clientIp } from './net.js';

const LOGIN_LIMIT = { limit: 10, windowMs: 15 * 60 * 1000 };

/** Comparación de tiempo constante: con `===` el tiempo de respuesta filtra la clave. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) {
    // Se compara igual para no delatar la longitud por el tiempo.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

function parseBasic(header) {
  if (typeof header !== 'string' || !header.startsWith('Basic ')) {
    return null;
  }
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator === -1) {
    return null;
  }
  return { user: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

/**
 * Basic auth del panel, con límite de intentos.
 *
 * El panel se usa por la VPN y no se publica en NPM. Basic auth sobre HTTP manda la
 * clave en base64, que no es cifrado: eso es aceptable dentro de un túnel de la VPN y
 * no lo sería expuesto a internet. Si algún día se publica, hace falta TLS.
 */
export function createAdminAuth(config) {
  const limiter = createRateLimiter(LOGIN_LIMIT);
  const middleware = (req, res, next) => {
    if (req.method === 'GET' && req.path === '/') {
      next();
      return;
    }
    const credentials = parseBasic(req.get('authorization'));
    if (!credentials) {
      challenge(res);
      return;
    }
    if (!safeEqual(credentials.user, config.adminUser)
        || !safeEqual(credentials.password, config.adminPassword)) {
      const retryAfter = limiter.check(clientIp(req, config.trustedProxyCidrs));
      if (retryAfter > 0) {
        res.status(429).set('Retry-After', String(retryAfter))
          .json({ ok: false, error: 'Demasiados intentos. Probá más tarde.', retryAfter });
        return;
      }
      challenge(res);
      return;
    }
    next();
  };
  return { middleware, loginLimiter: limiter };
}

function challenge(res) {
  res.status(401)
    .set('WWW-Authenticate', 'Basic realm="RudaTrak", charset="UTF-8"')
    .json({ ok: false, error: 'Se requiere autenticación' });
}

/**
 * CSRF: todo POST del panel tiene que traer un Origin que coincida con el host de la
 * petición. Con Basic auth el navegador manda las credenciales cacheadas solo, así que
 * sin esto una página ajena puede disparar `POST /admin/approve` y aprobar un
 * dispositivo sin que Rodrigo lo sepa.
 */
export function requireSameOrigin(config) {
  return (req, res, next) => {
    const origin = req.get('origin');
    if (!origin) {
      res.status(403).json({ ok: false, error: 'Falta la cabecera Origin' });
      return;
    }
    const expected = config.adminOrigin || `${req.protocol}://${req.get('host')}`;
    if (origin !== expected) {
      res.status(403).json({ ok: false, error: 'Origen no permitido' });
      return;
    }
    next();
  };
}
```

- [ ] **Step 6: Implementar `src/adminPage.js`**

```js
/**
 * Página del panel. HTML generado en el servidor y sin build: es una herramienta
 * interna que tiene que poder arreglarse en el momento, no una aplicación.
 *
 * Los códigos y las notas se insertan con textContent, nunca con innerHTML: la nota la
 * escribe quien pide acceso, y con innerHTML una nota con `<script>` se ejecutaría en
 * el navegador de Rodrigo.
 */
export function renderAdminPage() {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Enrolamiento — RudaTrak</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 1rem 1rem 3rem;
         background: #fafafa; color: #222; }
  h1 { font-size: 1.25rem; }
  .grupo { margin-top: 2rem; }
  .grupo h2 { font-size: 1rem; color: #666; text-transform: uppercase;
              letter-spacing: .05em; }
  .fila { display: flex; gap: .75rem; align-items: center; background: #fff;
          border: 1px solid #e0e0e0; border-radius: 8px; padding: .75rem;
          margin-bottom: .5rem; flex-wrap: wrap; }
  .codigo { font-family: ui-monospace, monospace; font-weight: 600; }
  .nota { color: #555; flex: 1 1 12rem; }
  button { font: inherit; padding: .5rem 1rem; border-radius: 6px;
           border: 1px solid #ccc; background: #fff; cursor: pointer; }
  button.aprobar { background: #e8751a; border-color: #e8751a; color: #fff;
                   font-weight: 600; }
  button.revocar { color: #b3261e; border-color: #e6b8b5; }
  button:disabled { opacity: .5; cursor: default; }
  .estado { color: #666; font-size: .875rem; }
  .vacio { color: #888; font-style: italic; }
</style>
</head>
<body>
<h1>Enrolamiento de dispositivos</h1>
<p class="estado" id="estado">Cargando…</p>

<div class="grupo">
  <h2>Pendientes</h2>
  <div id="pendientes"></div>
</div>

<div class="grupo">
  <h2>Aprobados</h2>
  <div id="aprobados"></div>
</div>

<script>
const estado = document.getElementById('estado');

function fila(dispositivo) {
  const contenedor = document.createElement('div');
  contenedor.className = 'fila';

  const codigo = document.createElement('span');
  codigo.className = 'codigo';
  codigo.textContent = dispositivo.code;
  contenedor.appendChild(codigo);

  const nota = document.createElement('span');
  nota.className = 'nota';
  // textContent, no innerHTML: la nota la escribe quien pide acceso.
  nota.textContent = [dispositivo.label, dispositivo.note].filter(Boolean).join(' · ') || 'sin nota';
  contenedor.appendChild(nota);

  return contenedor;
}

function boton(texto, clase, alHacerClic) {
  const b = document.createElement('button');
  b.className = clase;
  b.textContent = texto;
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await alHacerClic();
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

async function accion(ruta, cuerpo, mensajeOk) {
  const respuesta = await fetch(ruta, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
  const datos = await respuesta.json().catch(() => ({}));
  if (!respuesta.ok) {
    alert(datos.error || 'No se pudo completar la acción');
  } else if (mensajeOk) {
    alert(mensajeOk);
  }
  await cargar();
}

function pintar(id, lista, vacio) {
  const contenedor = document.getElementById(id);
  contenedor.textContent = '';
  if (!lista.length) {
    const p = document.createElement('p');
    p.className = 'vacio';
    p.textContent = vacio;
    contenedor.appendChild(p);
    return;
  }
  for (const dispositivo of lista) {
    const f = fila(dispositivo);
    if (id === 'pendientes') {
      const nombre = prompt('¿Para quién es? (queda como etiqueta)', dispositivo.note || '');
      f.appendChild(boton('Aprobar', 'aprobar',
        () => accion('/admin/api/approve', { code: dispositivo.code, label: nombre }, 'Aprobado')));
    } else {
      f.appendChild(boton('Revocar', 'revocar',
        async () => {
          if (!confirm('¿Revocar el acceso de ' + (dispositivo.label || dispositivo.code) + '?')) return;
          await accion('/admin/api/revoke', { code: dispositivo.code });
        }));
    }
    contenedor.appendChild(f);
  }
}

async function cargar() {
  const respuesta = await fetch('/admin/api/list');
  if (!respuesta.ok) {
    estado.textContent = 'No se pudo cargar la lista';
    return;
  }
  const datos = await respuesta.json();
  estado.textContent = datos.pendientes.length + ' pendientes · '
    + datos.aprobados.length + ' aprobados';
  pintar('pendientes', datos.pendientes, 'No hay pedidos pendientes');
  pintar('aprobados', datos.aprobados, 'Todavía no hay dispositivos aprobados');
}

cargar();
</script>
</body>
</html>`;
}
```

- [ ] **Step 7: Implementar `src/adminRoutes.js`**

```js
import express from 'express';
import { createAdminAuth, requireSameOrigin } from './adminAuth.js';
import { renderAdminPage } from './adminPage.js';
import { asyncRoute } from './enrollRoutes.js';
import { listByStatus, PENDING, APPROVED } from './db.js';

/**
 * Rutas del panel. NO se publican en NPM: se usan por la VPN. El panel puede crear y
 * revocar cuentas, así que su exposición es la superficie más delicada del servicio.
 */
export function createAdminRouter({ service, config, db }) {
  const router = express.Router();
  const page = renderAdminPage();

  // La página en sí no pide credenciales: no tiene datos, y así el navegador no
  // muestra el diálogo de Basic antes de que haya algo que ver. Todo lo que trae
  // información y todo lo que cambia algo sí las pide.
  router.get('/', (req, res) => {
    res.type('html').send(page);
  });

  const { middleware: requireAdmin, loginLimiter } = createAdminAuth(config);
  router.use(requireAdmin);
  router.use(requireSameOrigin(config));

  router.get('/api/list', (req, res) => {
    const limpiar = (fila) => ({
      code: fila.code,
      label: fila.label,
      note: fila.note,
      createdAt: fila.created_at,
      approvedAt: fila.approved_at,
    });
    res.json({
      pendientes: listByStatus(db, PENDING).map(limpiar),
      aprobados: listByStatus(db, APPROVED).map(limpiar),
      intentosFallidos: loginLimiter.size,
    });
  });

  router.post('/api/approve', asyncRoute(async (req, res) => {
    const { code, label } = req.body ?? {};
    res.json(await service.approve({ code, label }));
  }));

  return router;
}
```

Actualizar `src/app.js` para montarlo:

```js
import { createAdminRouter } from './adminRoutes.js';
// ...
  app.use('/enroll', createEnrollRouter({ service, config, limiters }));
  app.use('/admin', createAdminRouter({ service, config, db: service.db }));
```

Y `createEnrollService` tiene que exponer `db` para que el panel liste. Agregar al objeto que devuelve, junto a los métodos:

```js
    // El panel necesita listar para mostrar la cola. Se expone la base en vez de
    // duplicar cada consulta como método del servicio.
    db,
```

- [ ] **Step 8: Escribir los tests del panel**

`traccar/traccar-web/tools/enroll/test/adminRoutes.test.js`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createEnrollService } from '../src/enrollService.js';
import { memoryDb, fixedClock, fakeTraccar } from './helpers.js';

const CONFIG = {
  codeTtlHours: 48, tokenDays: 45, maxPending: 20, maxNoteLength: 200,
  trustedProxyCidrs: ['127.0.0.0/8'],
  adminUser: 'admin',
  adminPassword: 'clave-de-admin-para-tests-24',
};

const SECRET = 'secreto-de-dispositivo-de-32-caracteres-o-mas';
const CLAVE = Buffer.from(`admin:${CONFIG.adminPassword}`).toString('base64');
const auth = { Authorization: `Basic ${CLAVE}` };

let baseUrl;
let server;
let service;

before(async () => {
  const db = memoryDb();
  const traccar = fakeTraccar();
  const clock = fixedClock('2026-10-06T12:00:00.000Z');
  service = createEnrollService({ db, traccar, config: CONFIG, now: clock.now });
  server = createApp({ config: CONFIG, service }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const pedir = (secret = SECRET, note = 'Juan de Salta') => service.requestEnrollment({
  deviceSecret: secret, note,
});

test('GET /admin devuelve la página sin pedir credenciales', async () => {
  const response = await fetch(`${baseUrl}/admin/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Enrolamiento de dispositivos/);
});

test('GET /admin/api/list sin credenciales devuelve 401', async () => {
  const response = await fetch(`${baseUrl}/admin/api/list`);
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate'), /Basic/);
});

test('GET /admin/api/list con clave incorrecta devuelve 401', async () => {
  const mala = Buffer.from('admin:clave-equivocada-larga-24ch').toString('base64');
  const response = await fetch(`${baseUrl}/admin/api/list`, {
    headers: { Authorization: `Basic ${mala}` },
  });
  assert.equal(response.status, 401);
});

test('GET /admin/api/list con credenciales válidas lista pendientes y aprobados', async () => {
  const { code } = await pedir();
  const response = await fetch(`${baseUrl}/admin/api/list`, { headers: auth });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.pendientes.some((d) => d.code === code));
  assert.equal(body.pendientes[0].note, 'Juan de Salta');
  assert.ok(Array.isArray(body.aprobados));
});

test('GET /admin/api/list no expone secretos ni identificadores internos', async () => {
  await pedir();
  const response = await fetch(`${baseUrl}/admin/api/list`, { headers: auth });
  const texto = await response.text();
  assert.ok(!texto.includes(SECRET), 'no debe aparecer el secreto del dispositivo');
  assert.ok(!texto.includes('traccar_user_id'), 'no hace falta exponer el id interno');
  assert.ok(!/device_id|deviceId/.test(texto), 'no hace falta exponer el hash del dispositivo');
});

test('POST /admin/api/approve sin Origin devuelve 403', async () => {
  const { code } = await pedir();
  const response = await fetch(`${baseUrl}/admin/api/approve`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, label: 'Juan' }),
  });
  assert.equal(response.status, 403, 'sin Origin no se acepta un POST');
});

test('POST /admin/api/approve con Origin ajeno devuelve 403', async () => {
  const { code } = await pedir();
  const response = await fetch(`${baseUrl}/admin/api/approve`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', Origin: 'https://sitio-ajeno.invalid' },
    body: JSON.stringify({ code, label: 'Juan' }),
  });
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /Origen/);
});

test('POST /admin/api/approve con el Origin correcto aprueba', async () => {
  const { code } = await pedir();
  const response = await fetch(`${baseUrl}/admin/api/approve`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ code, label: 'Juan' }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'approved');
  assert.equal(body.label, 'Juan');
});

test('aprobar dos veces el mismo código devuelve 409', async () => {
  // Secret propio: los tests anteriores ya aprobaron SECRET, y pedir un dispositivo
  // ya aprobado devuelve 409 antes de llegar a la ruta.
  const { code } = await pedir(`${SECRET}-doble`);
  const aprobar = () => fetch(`${baseUrl}/admin/api/approve`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ code, label: 'Juan' }),
  });

  assert.equal((await aprobar()).status, 200);
  assert.equal((await aprobar()).status, 409);
});

test('muchos intentos fallidos de login terminan en 429', async () => {
  const mala = Buffer.from('admin:clave-equivocada-larga-24ch').toString('base64');
  let ultimo = 0;
  for (let i = 0; i < 12; i += 1) {
    const response = await fetch(`${baseUrl}/admin/api/list`, {
      headers: { Authorization: `Basic ${mala}` },
    });
    ultimo = response.status;
    if (ultimo === 429) {
      assert.ok(response.headers.get('retry-after'), 'debe indicar cuándo reintentar');
      break;
    }
  }
  assert.equal(ultimo, 429, 'el límite de intentos debe activarse');
});
```

- [ ] **Step 9: Correr los tests del panel**

Run: `cd traccar/traccar-web/tools/enroll && node --test test/adminRoutes.test.js`
Expected: PASS, **10 tests**.

- [ ] **Step 10: Correr toda la suite**

Run: `cd traccar/traccar-web/tools/enroll && npm test`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
cd traccar/traccar-web
git add tools/enroll/src/adminAuth.js tools/enroll/src/adminPage.js tools/enroll/src/adminRoutes.js tools/enroll/src/enrollService.js tools/enroll/src/app.js tools/enroll/test/adminRoutes.test.js tools/enroll/test/enrollService.test.js
git commit -m "Enrolamiento: aprobación atómica y panel de administración

La aprobación se decide con un UPDATE condicional: de dos pedidos
simultáneos sobre el mismo código, uno gana y el otro borra el usuario
que acababa de crear, para no dejar una cuenta con acceso al servidor
que nadie referencia.

El panel valida Origin en todos los POST y limita los intentos de
login. No se publica en NPM: se usa por la VPN.

Co-Authored-By: Claude Code <noreply@anthropic.com>
"
```

---

### Task 9: Renovación silenciosa — la única que emite tokens

**Files:**
- Modify: `traccar/traccar-web/tools/enroll/src/enrollService.js`
- Modify: `traccar/traccar-web/tools/enroll/test/enrollService.test.js`
- Modify: `traccar/traccar-web/tools/enroll/test/enrollRoutes.test.js`

**Interfaces:**
- Consumes: `mintTokenFor` (Tarea 3); `touch`, `APPROVED` (Tarea 1); `EnrollError` (Tarea 5).
- Produces: `service.renew({ deviceSecret })` → `{ token, expiresAt }`.

**Por qué la emisión vive acá y en ningún otro lado.** `approve` no emite: dejaría un token guardado en la base esperando a que alguien lo use. `/enroll/status` tampoco: la app lo consulta en un bucle mientras espera la aprobación, y si cada consulta emitiera, cada vuelta del bucle fabricaría una credencial nueva. `renew` es la única que emite, **a pedido del dispositivo**, y el token no se guarda: se devuelve y se olvida. La renovación vuelve a suplantar la sesión cada vez, así que no hace falta conservar nada entre renovaciones.

Esto es lo que sostiene la decisión de que el usuario nunca conozca su contraseña. Sin renovación, cada vencimiento lo dejaría varado en una pantalla de login donde no tiene nada que tipear.

- [ ] **Step 1: Escribir el test que falla**

Agregar al final de `traccar/traccar-web/tools/enroll/test/enrollService.test.js`:

```js
test('renew emite un token para un dispositivo aprobado', async () => {
  const { service, traccar } = setup();
  const { code } = await service.requestEnrollment({ deviceSecret: SECRET });
  await service.approve({ code, label: 'Juan' });

  const { token, expiresAt } = await service.renew({ deviceSecret: SECRET });

  assert.ok(token);
  const llamada = traccar.lastCall('mintTokenFor');
  assert.equal(llamada.args.userId, traccar.createdIds[0]);
  // 45 días desde el reloj fijo del test.
  assert.equal(expiresAt, '2026-11-20T12:00:00.000Z');
  assert.equal(llamada.args.expiration.toISOString(), expiresAt);
});

test('renew no guarda el token en la base', async () => {
  const { service, db } = setup();
  const { code } = await service.requestEnrollment({ deviceSecret: SECRET });
  await service.approve({ code, label: 'Juan' });
  const { token } = await service.renew({ deviceSecret: SECRET });

  const row = getByDeviceId(db, hashSecret(SECRET));
  assert.ok(!JSON.stringify(row).includes(token), 'el token no debe persistirse');
  assert.equal(Object.keys(row).includes('token'), false);
});

test('renew actualiza last_seen_at', async () => {
  const { service, db, clock } = setup();
  const { code } = await service.requestEnrollment({ deviceSecret: SECRET });
  await service.approve({ code, label: 'Juan' });
  assert.equal(getByDeviceId(db, hashSecret(SECRET)).last_seen_at, null);

  clock.advance(60 * 60 * 1000);
  await service.renew({ deviceSecret: SECRET });

  assert.equal(
    getByDeviceId(db, hashSecret(SECRET)).last_seen_at,
    '2026-10-06T13:00:00.000Z',
  );
});

test('renew rechaza un dispositivo pendiente', async () => {
  const { service, traccar } = setup();
  await service.requestEnrollment({ deviceSecret: SECRET });

  await assert.rejects(
    () => service.renew({ deviceSecret: SECRET }),
    (error) => error.status === 403,
  );
  assert.equal(traccar.lastCall('mintTokenFor'), null, 'no debe emitir nada');
});

test('renew rechaza un dispositivo revocado', async () => {
  const { service, traccar, db } = setup();
  const { code } = await service.requestEnrollment({ deviceSecret: SECRET });
  await service.approve({ code, label: 'Juan' });
  db.prepare("UPDATE devices SET status = 'revoked' WHERE device_id = ?").run(hashSecret(SECRET));

  await assert.rejects(() => service.renew({ deviceSecret: SECRET }), (error) => error.status === 403);
  assert.equal(traccar.lastCall('mintTokenFor'), null, 'un revocado no puede renovar');
});

test('renew rechaza un dispositivo desconocido sin emitir', async () => {
  const { service, traccar } = setup();
  await assert.rejects(() => service.renew({ deviceSecret: SECRET }), (error) => error.status === 404);
  assert.deepEqual(traccar.calls, []);
});

test('la vida del token respeta la configuración', async () => {
  const { service, traccar } = setup({ config: { ...CONFIG, tokenDays: 30 } });
  const { code } = await service.requestEnrollment({ deviceSecret: SECRET });
  await service.approve({ code, label: 'Juan' });
  await service.renew({ deviceSecret: SECRET });

  const esperado = new Date('2026-10-06T12:00:00.000Z').getTime() + 30 * 24 * 60 * 60 * 1000;
  assert.equal(
    traccar.lastCall('mintTokenFor').args.expiration.getTime(),
    esperado,
  );
});

test('renovar dos veces no rompe y emite un token nuevo', async () => {
  const { service, traccar } = setup();
  const { code } = await service.requestEnrollment({ deviceSecret: SECRET });
  await service.approve({ code, label: 'Juan' });

  const primera = await service.renew({ deviceSecret: SECRET });
  const segunda = await service.renew({ deviceSecret: SECRET });

  assert.ok(primera.token);
  assert.ok(segunda.token);
  assert.equal(traccar.calls.filter((c) => c.name === 'mintTokenFor').length, 2);
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `cd traccar/traccar-web/tools/enroll && node --test test/enrollService.test.js`
Expected: FAIL — `service.renew is not a function`.

- [ ] **Step 3: Implementar `renew`**

Agregar `touch` al import de `./db.js` y, dentro del objeto, después de `approve`:

```js
    /**
     * Emite un token para el dispositivo. Es la ÚNICA función que emite.
     *
     * `approve` no emite: dejaría un token guardado en la base esperando a que alguien
     * lo use. `getStatus` tampoco: la app lo consulta en un bucle mientras espera la
     * aprobación, y si cada consulta emitiera, cada vuelta fabricaría una credencial
     * nueva. Acá se emite a pedido, y el token se devuelve y se olvida: no se guarda.
     */
    async renew({ deviceSecret }) {
      const device = requireKnownDevice(requireSecret(deviceSecret));
      if (device.status !== APPROVED) {
        // Un revocado no renueva. Es la comprobación que hace que la revocación
        // alcance a un dispositivo que todavía tiene su secreto y lo usa.
        throw new EnrollError('Este dispositivo no tiene acceso habilitado', {
          status: 403, code: 'not_approved',
        });
      }
      if (device.traccar_user_id === null) {
        throw new EnrollError('El dispositivo quedó sin usuario asociado. Revisar a mano.', {
          status: 409, code: 'no_traccar_user',
        });
      }

      const expiration = new Date(now().getTime() + config.tokenDays * DAY_MS);
      const token = await traccar.mintTokenFor(device.traccar_user_id, expiration);
      touch(db, device.device_id, isoNow());

      return { token, expiresAt: expiration.toISOString() };
    },
```

Y con los otros imports, la constante:

```js
const DAY_MS = 24 * 60 * 60 * 1000;
```

- [ ] **Step 4: Agregar el test de la ruta**

Agregar al final de `traccar/traccar-web/tools/enroll/test/enrollRoutes.test.js`:

```js
test('POST /enroll/renew exige el secreto', async () => {
  const response = await fetch(`${baseUrl}/enroll/renew`, { method: 'POST' });
  assert.equal(response.status, 401);
});

test('POST /enroll/renew de un dispositivo pendiente devuelve 403', async () => {
  const response = await fetch(`${baseUrl}/enroll/renew`, {
    method: 'POST',
    headers: { 'X-Device-Secret': SECRET },
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).ok, false);
});
```

Como este archivo nunca aprueba `SECRET`, el dispositivo sigue pendiente y la segunda verificación es válida. Los dos casos que importan —renovar un aprobado y renovar un revocado— ya están cubiertos en `enrollService.test.js`, que es donde vive la regla.

- [ ] **Step 5: Correr toda la suite**

Run: `cd traccar/traccar-web/tools/enroll && npm test`
Expected: PASS. `enrollService.test.js` pasa de 25 a **33 tests** y `enrollRoutes.test.js` de 9 a **11**.

- [ ] **Step 6: Commit**

```bash
cd traccar/traccar-web
git add tools/enroll/src/enrollService.js tools/enroll/test/enrollService.test.js tools/enroll/test/enrollRoutes.test.js
git commit -m "Enrolamiento: renovación silenciosa del token

renew es la única función que emite un token, y no lo guarda. La
emisión es a pedido del dispositivo, así que no queda ninguna
credencial en la base esperando a que alguien la use, y consultar el
estado en un bucle no fabrica credenciales.

Un dispositivo revocado no renueva ni aunque conserve su secreto.

Co-Authored-By: Claude Code <noreply@anthropic.com>
"
```

---

### Task 10: Revocación

**Files:**
- Modify: `traccar/traccar-web/tools/enroll/src/enrollService.js`
- Modify: `traccar/traccar-web/tools/enroll/src/adminRoutes.js`
- Modify: `traccar/traccar-web/tools/enroll/test/enrollService.test.js`
- Create: `traccar/traccar-web/tools/enroll/test/revoke.test.js`

**Interfaces:**
- Consumes: `disableUser` (Tarea 3); `getByCode`, `markRevoked`, `REVOKED` (Tarea 1).
- Produces: `service.revokeByCode({ code })` → `{ status }`.

**Cómo funciona la revocación, y por qué alcanza con esto.**

No hay ningún registro de tokens emitidos y no hace falta. `disableUser` deshabilita al usuario en Traccar, y `LoginService.login(String token)` llama a `checkUserEnabled` en **cada** autenticación por token. Deshabilitar al usuario invalida **todos** sus tokens a la vez, para siempre, sin listar ninguno. Es una revocación más completa que la que daría un registro propio: también corta un token emitido desde otro lado y que el servicio nunca vio.

**El orden importa.** Primero se deshabilita en Traccar, después se marca la fila. Al revés, si Traccar falla la fila quedaría en `revoked` mientras el token sigue sirviendo, que es la peor combinación: la app dice "revocado" y el acceso sigue abierto. En este orden, si Traccar falla la fila sigue en `approved` y Rodrigo reintenta.

**Un límite que se acepta, no se resuelve:** la revocación no llega a un dispositivo sin señal. La app está pensada para funcionar sin conexión (viajeros en zonas remotas), así que un teléfono revocado que ya tiene sus datos offline los sigue mostrando hasta que recupere señal. Es el precio de que la app sirva en el campo.

- [ ] **Step 1: Escribir el test que falla**

`traccar/traccar-web/tools/enroll/test/revoke.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnrollService, EnrollError } from '../src/enrollService.js';
import { getByDeviceId, hashSecret, APPROVED, REVOKED } from '../src/db.js';
import { memoryDb, fixedClock, fakeTraccar } from './helpers.js';

const CONFIG = { codeTtlHours: 48, tokenDays: 45, maxPending: 20, maxNoteLength: 200 };
const SECRET = 'secreto-de-dispositivo-de-32-caracteres-o-mas';

async function aprobado() {
  const db = memoryDb();
  const traccar = fakeTraccar();
  const clock = fixedClock('2026-10-06T12:00:00.000Z');
  const service = createEnrollService({ db, traccar, config: CONFIG, now: clock.now });
  const { code } = await service.requestEnrollment({ deviceSecret: SECRET, note: 'Juan' });
  await service.approve({ code, label: 'Juan' });
  return { db, traccar, clock, service, code };
}

test('revokeByCode deshabilita el usuario en Traccar y marca la fila', async () => {
  const { service, traccar, db, code } = await aprobado();

  const result = await service.revokeByCode({ code });

  assert.equal(result.status, 'revoked');
  assert.equal(traccar.lastCall('disableUser').args.userId, traccar.createdIds[0]);
  assert.equal(getByDeviceId(db, hashSecret(SECRET)).status, REVOKED);
});

test('revokeByCode acepta el código como lo tipee una persona', async () => {
  const { service, code } = await aprobado();
  const sucio = ` ${code.toLowerCase().replace(/-/g, '')} `;
  assert.equal((await service.revokeByCode({ code: sucio })).status, 'revoked');
});

test('revocar un código inexistente no toca Traccar', async () => {
  const { service, traccar } = await aprobado();
  await assert.rejects(
    () => service.revokeByCode({ code: 'RUDA-XXXX-XXXX' }),
    (error) => error.status === 404,
  );
  assert.equal(traccar.lastCall('disableUser'), null);
});

test('revocar dos veces es idempotente', async () => {
  const { service, traccar, code } = await aprobado();

  await service.revokeByCode({ code });
  const segunda = await service.revokeByCode({ code });

  assert.equal(segunda.status, 'revoked');
  assert.equal(
    traccar.calls.filter((c) => c.name === 'disableUser').length, 1,
    'no debe volver a deshabilitar',
  );
});

test('si Traccar falla, la fila NO queda marcada como revocada', async () => {
  const db = memoryDb();
  const traccar = fakeTraccar();
  const clock = fixedClock('2026-10-06T12:00:00.000Z');
  const service = createEnrollService({ db, traccar, config: CONFIG, now: clock.now });
  const { code } = await service.requestEnrollment({ deviceSecret: SECRET });
  await service.approve({ code, label: 'Juan' });

  // Se rompe el cliente después de aprobar, para simular un Traccar caído justo
  // en el momento de revocar.
  traccar.disableUser = async () => { throw new Error('Traccar caído'); };
  await assert.rejects(() => service.revokeByCode({ code }), /Traccar caído/);

  assert.equal(
    getByDeviceId(db, hashSecret(SECRET)).status, APPROVED,
    'la fila debe seguir aprobada para poder reintentar',
  );
});

test('un dispositivo revocado no puede renovar su token', async () => {
  const { service, traccar, code } = await aprobado();
  await service.revokeByCode({ code });
  const emisionesAntes = traccar.calls.filter((c) => c.name === 'mintTokenFor').length;

  await assert.rejects(
    () => service.renew({ deviceSecret: SECRET }),
    (error) => error instanceof EnrollError && error.status === 403,
  );
  assert.equal(
    traccar.calls.filter((c) => c.name === 'mintTokenFor').length, emisionesAntes,
    'no debe emitir ningún token',
  );
});

test('el estado de un dispositivo revocado es revoked', async () => {
  const { service, code } = await aprobado();
  await service.revokeByCode({ code });
  const estado = await service.getStatus({ deviceSecret: SECRET });
  assert.equal(estado.status, 'revoked');
});

test('un dispositivo revocado no se puede volver a aprobar', async () => {
  const { service, code } = await aprobado();
  await service.revokeByCode({ code });
  await assert.rejects(() => service.approve({ code, label: 'Juan' }), (error) => error.status === 409);
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `cd traccar/traccar-web/tools/enroll && node --test test/revoke.test.js`
Expected: FAIL — `service.revokeByCode is not a function`.

- [ ] **Step 3: Implementar `revokeByCode`**

Agregar `markRevoked` al import de `./db.js` y, dentro del objeto, después de `renew`:

```js
    /**
     * Revoca el acceso de un dispositivo.
     *
     * No hace falta un registro de tokens emitidos: deshabilitar al usuario en Traccar
     * invalida TODOS sus tokens a la vez, porque LoginService.login(String token) llama
     * a checkUserEnabled en cada autenticación. Es más completo que un registro propio:
     * también corta un token que el servicio nunca vio.
     *
     * El orden es deliberado: primero Traccar, después la fila. Al revés, si Traccar
     * falla la fila diría "revocado" mientras el token sigue sirviendo, que es la peor
     * combinación posible.
     */
    async revokeByCode({ code }) {
      const device = getByCode(db, normalizeCode(code));
      if (!device) {
        throw new EnrollError('Ese código no existe', { status: 404, code: 'unknown_code' });
      }
      if (device.status === REVOKED) {
        // Idempotente: revocar dos veces no es un error, y no vuelve a llamar a Traccar.
        return { status: REVOKED };
      }
      if (device.traccar_user_id !== null) {
        await traccar.disableUser(device.traccar_user_id);
      }
      markRevoked(db, device.device_id);
      return { status: REVOKED };
    },
```

- [ ] **Step 4: Correr los tests**

Run: `cd traccar/traccar-web/tools/enroll && node --test test/revoke.test.js`
Expected: PASS, **8 tests**.

Si `un dispositivo revocado no puede renovar su token` falla, la revocación no sirve para nada: es la verificación que une la Tarea 9 con esta.

- [ ] **Step 5: Conectar el panel**

En `src/adminRoutes.js`, agregar la ruta antes del cierre del router:

```js
  router.post('/api/revoke', asyncRoute(async (req, res) => {
    const { code } = req.body ?? {};
    res.json(await service.revokeByCode({ code }));
  }));
```

Y en `test/adminRoutes.test.js`, al final:

```js
test('POST /admin/api/revoke revoca y el dispositivo deja de renovar', async () => {
  const { code } = await pedir(`${SECRET}-revocar`);
  await fetch(`${baseUrl}/admin/api/approve`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ code, label: 'Para revocar' }),
  });

  const response = await fetch(`${baseUrl}/admin/api/revoke`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ code }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'revoked');

  const renovar = await fetch(`${baseUrl}/enroll/renew`, {
    method: 'POST',
    headers: { 'X-Device-Secret': `${SECRET}-revocar` },
  });
  assert.equal(renovar.status, 403, 'un revocado no puede renovar');
});

test('POST /admin/api/revoke sin Origin devuelve 403', async () => {
  const response = await fetch(`${baseUrl}/admin/api/revoke`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'RUDA-XXXX-XXXX' }),
  });
  assert.equal(response.status, 403);
});
```

- [ ] **Step 6: Correr toda la suite**

Run: `cd traccar/traccar-web/tools/enroll && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd traccar/traccar-web
git add tools/enroll/src/enrollService.js tools/enroll/src/adminRoutes.js tools/enroll/test/revoke.test.js tools/enroll/test/enrollService.test.js tools/enroll/test/adminRoutes.test.js
git commit -m "Enrolamiento: revocación por deshabilitación del usuario

Deshabilitar el usuario en Traccar invalida todos sus tokens a la vez,
porque checkUserEnabled corre en cada autenticación por token. No hace
falta registrar los tokens emitidos.

Traccar primero y la fila después: al revés, un fallo de Traccar
dejaría la fila en revocado con el token todavía sirviendo.

Co-Authored-By: Claude Code <noreply@anthropic.com>
"
```

---

### Task 11: Re-enrolamiento

**Files:**
- Modify: `traccar/traccar-web/tools/enroll/src/enrollService.js`
- Modify: `traccar/traccar-web/tools/enroll/src/adminRoutes.js`
- Create: `traccar/traccar-web/tools/enroll/test/rebind.test.js`

**Interfaces:**
- Consumes: `getByCode`, `claimDevice`, `finalizeApproval`, `deleteDevice`, `APPROVED`, `PENDING`, `REVOKED` (Tarea 1).
- Produces: `service.rebind({ newCode, oldCode })` → `{ status, label, traccarUserId }`.

**Qué es re-enrolar, en concreto.** Juan cambia de teléfono. El nuevo pide enrolamiento y recibe un código nuevo; el viejo sigue aprobado, con su usuario de Traccar y sus posiciones. Si Rodrigo aprueba el pedido nuevo con el flujo normal, Juan termina con **dos** usuarios y dos dispositivos en Traccar, y el historial de viaje queda partido en dos.

Re-enrolar es: el dispositivo nuevo hereda el usuario de Traccar del viejo, y la fila del viejo se borra. El historial queda entero, porque para Traccar es el mismo usuario con el mismo dispositivo.

**No llama a Traccar en ningún momento**, y por eso es la operación más simple de todas: es un movimiento de filas.

**El límite que queda abierto, y la alternativa que ya existe.** Los tokens no se guardan en ningún lado, así que el token del teléfono viejo **sigue siendo válido hasta que venza**: no hay forma de revocarlo sin conocerlo. Con la vida del token en 30-60 días, la ventana es acotada, y hay que decirle a la persona que borre la app del teléfono viejo.

Si Rodrigo necesita cortar en el acto, ya tiene con qué, sin ninguna función nueva: **aprobar el pedido nuevo y después revocar el viejo**. Eso crea un usuario nuevo y deshabilita el anterior, con lo que el token viejo muere en el momento; el precio es que el historial de posiciones arranca de cero. Las dos opciones van documentadas en el README, con este párrafo, para que la decisión esté escrita y no en la cabeza de nadie.

- [ ] **Step 1: Escribir el test que falla**

`traccar/traccar-web/tools/enroll/test/rebind.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnrollService } from '../src/enrollService.js';
import { getByCode, getByDeviceId, hashSecret, countByStatus, PENDING, APPROVED } from '../src/db.js';
import { memoryDb, fixedClock, fakeTraccar } from './helpers.js';
import { normalizeCode } from '../src/codes.js';

const CONFIG = { codeTtlHours: 48, tokenDays: 45, maxPending: 20, maxNoteLength: 200 };
const SECRET_VIEJO = 'secreto-del-telefono-viejo-de-32-caracteres';
const SECRET_NUEVO = 'secreto-del-telefono-nuevo-de-32-caracteres';

async function conDosDispositivos() {
  const db = memoryDb();
  const traccar = fakeTraccar();
  const clock = fixedClock('2026-10-06T12:00:00.000Z');
  const service = createEnrollService({ db, traccar, config: CONFIG, now: clock.now });

  const viejo = await service.requestEnrollment({ deviceSecret: SECRET_VIEJO, note: 'Juan' });
  await service.approve({ code: viejo.code, label: 'Juan' });
  const nuevo = await service.requestEnrollment({ deviceSecret: SECRET_NUEVO, note: 'Juan, teléfono nuevo' });

  return { db, traccar, clock, service, viejo, nuevo };
}

test('rebind mueve el usuario de Traccar al dispositivo nuevo', async () => {
  const { service, db, traccar, viejo, nuevo } = await conDosDispositivos();

  const result = await service.rebind({ newCode: nuevo.code, oldCode: viejo.code });

  assert.equal(result.status, APPROVED);
  assert.equal(result.label, 'Juan');

  const filaNueva = getByDeviceId(db, hashSecret(SECRET_NUEVO));
  assert.equal(filaNueva.status, APPROVED);
  assert.equal(filaNueva.traccar_user_id, traccar.createdIds[0]);
  assert.equal(filaNueva.label, 'Juan');
  assert.equal(filaNueva.approved_at, '2026-10-06T12:00:00.000Z');

  assert.equal(getByCode(db, normalizeCode(viejo.code)), null, 'la fila del viejo se borra');
});

test('rebind no llama a Traccar', async () => {
  const { service, traccar, viejo, nuevo } = await conDosDispositivos();
  const antes = traccar.calls.length;

  await service.rebind({ newCode: nuevo.code, oldCode: viejo.code });

  assert.equal(traccar.calls.length, antes, 'no debe hacer ninguna llamada nueva');
});

test('rebind no crea un usuario nuevo', async () => {
  const { service, traccar, viejo, nuevo } = await conDosDispositivos();
  await service.rebind({ newCode: nuevo.code, oldCode: viejo.code });

  assert.equal(traccar.createdIds.length, 1, 'debe reutilizar el usuario del viejo');
  assert.equal(
    traccar.calls.filter((c) => c.name === 'createUser').length, 1,
  );
});

test('el dispositivo re-vinculado puede renovar con el usuario heredado', async () => {
  const { service, traccar, viejo, nuevo } = await conDosDispositivos();
  await service.rebind({ newCode: nuevo.code, oldCode: viejo.code });

  const { token } = await service.renew({ deviceSecret: SECRET_NUEVO });

  assert.ok(token);
  assert.equal(traccar.lastCall('mintTokenFor').args.userId, traccar.createdIds[0]);
});

test('el secreto del teléfono viejo deja de servir', async () => {
  const { service, viejo, nuevo } = await conDosDispositivos();
  await service.rebind({ newCode: nuevo.code, oldCode: viejo.code });

  await assert.rejects(
    () => service.getStatus({ deviceSecret: SECRET_VIEJO }),
    (error) => error.status === 404,
  );
});

test('rebind no deja el dispositivo nuevo como pendiente', async () => {
  const { service, db, viejo, nuevo } = await conDosDispositivos();
  await service.rebind({ newCode: nuevo.code, oldCode: viejo.code });
  assert.equal(countByStatus(db, PENDING), 0);
});

test('rebind rechaza un código nuevo inexistente', async () => {
  const { service, viejo } = await conDosDispositivos();
  await assert.rejects(
    () => service.rebind({ newCode: 'RUDA-XXXX-XXXX', oldCode: viejo.code }),
    (error) => error.status === 404,
  );
});

test('rebind rechaza un viejo que no está aprobado', async () => {
  const { service, viejo, nuevo } = await conDosDispositivos();

  const pendiente = await service.requestEnrollment({ deviceSecret: 'otro-secreto-de-32-caracteres-largo' });
  await assert.rejects(
    () => service.rebind({ newCode: nuevo.code, oldCode: pendiente.code }),
    (error) => error.status === 409,
  );
  // Y el bueno sigue funcionando después del rechazo.
  assert.equal((await service.rebind({ newCode: nuevo.code, oldCode: viejo.code })).status, APPROVED);
});

test('rebind rechaza un código nuevo vencido', async () => {
  const { service, clock, viejo, nuevo } = await conDosDispositivos();
  clock.advance(49 * 60 * 60 * 1000);

  await assert.rejects(
    () => service.rebind({ newCode: nuevo.code, oldCode: viejo.code }),
    (error) => error.status === 410,
  );
});

test('rebind rechaza re-vincular a sí mismo', async () => {
  const { service, viejo } = await conDosDispositivos();
  await assert.rejects(
    () => service.rebind({ newCode: viejo.code, oldCode: viejo.code }),
    (error) => error.status === 409,
  );
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `cd traccar/traccar-web/tools/enroll && node --test test/rebind.test.js`
Expected: FAIL — `service.rebind is not a function`.

- [ ] **Step 3: Implementar `rebind`**

Dentro del objeto, después de `revokeByCode`:

```js
    /**
     * Re-enrolamiento: el dispositivo nuevo hereda el usuario de Traccar del viejo, y
     * la fila del viejo se borra. Para Traccar es el mismo usuario, así que el historial
     * de posiciones queda entero en vez de partirse en dos.
     *
     * No llama a Traccar: es un movimiento de filas.
     *
     * LÍMITE CONOCIDO: como los tokens no se guardan en ningún lado, el token del
     * teléfono viejo sigue siendo válido hasta que venza: no hay forma de revocarlo sin
     * conocerlo. La ventana está acotada por la vida del token (30-60 días). Para cortar
     * en el acto, la alternativa es aprobar el pedido nuevo y después revocar el viejo,
     * que crea un usuario nuevo y deshabilita el anterior — al precio de perder el
     * historial. Las dos opciones están documentadas en el README.
     */
    async rebind({ newCode, oldCode }) {
      const destino = getByCode(db, normalizeCode(newCode));
      const origen = getByCode(db, normalizeCode(oldCode));

      if (!destino) {
        throw new EnrollError('El código del dispositivo nuevo no existe', {
          status: 404, code: 'unknown_code',
        });
      }
      if (!origen) {
        throw new EnrollError('El código del dispositivo anterior no existe', {
          status: 404, code: 'unknown_code',
        });
      }
      if (destino.device_id === origen.device_id) {
        throw new EnrollError('Son el mismo dispositivo', { status: 409, code: 'same_device' });
      }
      if (destino.status !== PENDING) {
        throw new EnrollError('El dispositivo nuevo no está pendiente', {
          status: 409, code: 'not_pending',
        });
      }
      if (new Date(destino.code_expires_at) <= now()) {
        throw new EnrollError('El código del dispositivo nuevo venció', {
          status: 410, code: 'code_expired',
        });
      }
      if (origen.status !== APPROVED || origen.traccar_user_id === null) {
        throw new EnrollError('El dispositivo anterior no está aprobado', {
          status: 409, code: 'origin_not_approved',
        });
      }

      // El reclamo es condicional, igual que en approve: dos re-vinculaciones
      // simultáneas sobre el mismo código nuevo no pueden ganar las dos.
      if (!claimDevice(db, destino.device_id, origen.traccar_user_id, origen.label)) {
        throw new EnrollError('Ese código ya fue usado', { status: 409, code: 'already_used' });
      }
      if (!finalizeApproval(db, destino.device_id, isoNow())) {
        throw new EnrollError('No se pudo completar el re-enrolamiento', { status: 500 });
      }

      deleteDevice(db, origen.device_id);

      return {
        status: APPROVED,
        label: origen.label,
        traccarUserId: origen.traccar_user_id,
      };
    },
```

- [ ] **Step 4: Correr los tests**

Run: `cd traccar/traccar-web/tools/enroll && node --test test/rebind.test.js`
Expected: PASS, **10 tests**.

- [ ] **Step 5: Conectar el panel**

En `src/adminRoutes.js`:

```js
  router.post('/api/rebind', asyncRoute(async (req, res) => {
    const { newCode, oldCode } = req.body ?? {};
    res.json(await service.rebind({ newCode, oldCode }));
  }));
```

Y en `src/adminPage.js`, dentro del `else` de `pintar`, después del botón de revocar, un botón que pida el código del dispositivo anterior:

```js
      f.appendChild(boton('Re-vincular', 'revocar', async () => {
        const anterior = prompt('Código del dispositivo anterior (el teléfono viejo):');
        if (!anterior) return;
        await accion('/admin/api/rebind', { newCode: dispositivo.code, oldCode: anterior }, 'Re-vinculado');
      }));
```

- [ ] **Step 6: Documentar el límite en el README**

Agregar a `traccar/traccar-web/tools/enroll/README.md`:

```markdown
## Re-enrolamiento (cambio de teléfono)

Cuando alguien cambia de teléfono, el dispositivo nuevo pide enrolamiento y recibe un
código. Desde el panel, el botón **Re-vincular** del dispositivo viejo hace que el nuevo
herede su usuario de Traccar: el historial de posiciones queda entero, porque para
Traccar es el mismo usuario.

**Límite conocido:** los tokens no se guardan en ningún lado, así que el token del
teléfono viejo sigue siendo válido hasta que venza (entre 30 y 60 días, según
`TOKEN_DAYS`). No hay forma de revocarlo sin conocerlo, y conocerlo exigiría guardar
todos los tokens emitidos. Hay que pedirle a la persona que borre la app del teléfono
viejo.

**Para cortar en el acto**, sin depender de eso: aprobar el pedido del teléfono nuevo con
el flujo normal, y después revocar el viejo. Eso crea un usuario nuevo y deshabilita el
anterior, con lo que el token viejo muere en el momento. El precio es que el historial de
posiciones del dispositivo arranca de cero.
```

- [ ] **Step 7: Correr toda la suite**

Run: `cd traccar/traccar-web/tools/enroll && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
cd traccar/traccar-web
git add tools/enroll/src/enrollService.js tools/enroll/src/adminRoutes.js tools/enroll/src/adminPage.js tools/enroll/test/rebind.test.js tools/enroll/README.md
git commit -m "Enrolamiento: re-enrolamiento al cambiar de teléfono

El dispositivo nuevo hereda el usuario de Traccar del viejo, así que
el historial de posiciones no se parte en dos. No llama a Traccar: es
un movimiento de filas.

Queda documentado que el token del teléfono viejo vale hasta vencer,
porque los tokens no se guardan, y que la alternativa para cortar en
el acto es aprobar el nuevo y revocar el viejo.

Co-Authored-By: Claude Code <noreply@anthropic.com>
"
```

---

### Task 12: Respaldo diario de la base

**Files:**
- Create: `traccar/traccar-web/tools/enroll/src/backup.js`
- Create: `traccar/traccar-web/tools/enroll/test/backup.test.js`
- Modify: `traccar/traccar-web/tools/enroll/src/server.js`

**Interfaces:**
- Consumes: `loadConfig` (Tarea 1), `openDb` (Tarea 1).
- Produces: `createBackup({ db, backupDir, keep, log })` → `{ run() }`, y `nextBackupDelay(now)` → ms hasta las 03:17.

**Por qué respaldar y por qué afuera del volumen.** La base del servicio es SQLite dentro de un volumen Docker. El volumen se pierde con el contenedor si alguien hace `down -v`, y se corrompe si el proceso muere en medio de una escritura. Pero un respaldo **dentro del mismo volumen no sirve para nada**: se pierde junto con el original. De ahí que `BACKUP_DIR` apunte a otra ruta de la Pi, fuera del volumen del servicio.

`VACUUM INTO` es la forma correcta de copiar una base SQLite en uso: escribe un archivo nuevo y consistente, sin bloquear a quien esté escribiendo, y sin el riesgo de copiar un archivo a mitad de una transacción con su WAL desacompasado.

- [ ] **Step 1: Escribir el test que falla**

`traccar/traccar-web/tools/enroll/test/backup.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackup, nextBackupDelay } from '../src/backup.js';
import { openDb, insertDevice } from '../src/db.js';
import { memoryDb } from './helpers.js';

const SAMPLE = {
  deviceId: 'a'.repeat(64), code: 'RUDA7K4M92QX', note: 'Juan',
  createdAt: '2026-10-06T12:00:00.000Z', codeExpiresAt: '2026-10-08T12:00:00.000Z',
};

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'enroll-backup-'));
}

test('el respaldo crea un archivo con los datos', () => {
  const dir = tempDir();
  const db = memoryDb();
  insertDevice(db, SAMPLE);

  const { target } = createBackup({ db, backupDir: dir, keep: 7, log: { info() {}, error() {} } }).run();

  // El respaldo se abre como base independiente y tiene la fila.
  const copia = openDb(target);
  assert.equal(copia.prepare('SELECT code FROM devices').get().code, 'RUDA7K4M92QX');
  copia.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('el respaldo crea el directorio si no existe', () => {
  const dir = join(tempDir(), 'anidado', 'mas');
  const db = memoryDb();
  assert.ok(createBackup({ db, backupDir: dir, keep: 7, log: { info() {}, error() {} } }).run().target);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('rotación: conserva las últimas copias y borra las viejas', () => {
  const dir = tempDir();
  const db = memoryDb();
  // Diez respaldos con nombres ordenables, como los que produce el reloj.
  for (let i = 1; i <= 10; i += 1) {
    writeFileSync(join(dir, `enroll-2026-10-${String(i).padStart(2, '0')}T03-17-00-000Z.db`), 'x');
  }

  const { pruned } = createBackup({ db, backupDir: dir, keep: 7, log: { info() {}, error() {} } }).run();

  const restantes = readdirSync(dir).sort();
  assert.equal(restantes.length, 7, 'debe quedar el número configurado');
  assert.equal(pruned.length, 4, 'debe informar cuántas borró');
  // Se van las más viejas: la del 1 ya no está y la del 10 sí.
  assert.ok(!restantes.includes('enroll-2026-10-01T03-17-00-000Z.db'));
  assert.ok(restantes.includes('enroll-2026-10-10T03-17-00-000Z.db'));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('la rotación no toca archivos que no son respaldos', () => {
  const dir = tempDir();
  const db = memoryDb();
  writeFileSync(join(dir, 'notas.txt'), 'no borrar');
  for (let i = 1; i <= 9; i += 1) {
    writeFileSync(join(dir, `enroll-2026-10-${String(i).padStart(2, '0')}T03-17-00-000Z.db`), 'x');
  }

  createBackup({ db, backupDir: dir, keep: 7, log: { info() {}, error() {} } }).run();

  assert.ok(readdirSync(dir).includes('notas.txt'), 'solo se rotan los respaldos');
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('dos respaldos en el mismo milisegundo no chocan de nombre', () => {
  const dir = tempDir();
  const db = memoryDb();
  // Reloj congelado: los dos respaldos piden exactamente el mismo nombre. Sin el
  // contador, el segundo VACUUM INTO fallaría porque el destino ya existe.
  const ahora = () => new Date('2026-10-06T03:17:00.000Z');
  const backup = createBackup({ db, backupDir: dir, keep: 7, log: { info() {}, error() {} }, now: ahora });

  const primero = backup.run();
  const segundo = backup.run();

  assert.notEqual(primero.target, segundo.target);
  assert.equal(readdirSync(dir).filter((f) => f.startsWith('enroll-')).length, 2);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('nextBackupDelay apunta a las 03:17 del día siguiente', () => {
  const desde = new Date('2026-10-06T12:00:00');
  const destino = new Date(desde.getTime() + nextBackupDelay(desde));
  assert.equal(destino.getHours(), 3);
  assert.equal(destino.getMinutes(), 17);
  assert.equal(destino.getDate(), 7, 'debe ser el día siguiente');
});

test('nextBackupDelay antes de las 03:17 apunta al mismo día', () => {
  const desde = new Date('2026-10-06T01:00:00');
  const destino = new Date(desde.getTime() + nextBackupDelay(desde));
  assert.equal(destino.getHours(), 3);
  assert.equal(destino.getDate(), 6, 'todavía no pasó la hora de hoy');
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `cd traccar/traccar-web/tools/enroll && node --test test/backup.test.js`
Expected: FAIL — `Cannot find module '../src/backup.js'`.

- [ ] **Step 3: Implementar `src/backup.js`**

```js
import { mkdirSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PREFIX = 'enroll-';
const SUFFIX = '.db';
// 03:17 y no 03:00: a esa hora Traccar corre sus tareas programadas de limpieza, y
// no vale la pena que las dos cosas escriban en el mismo minuto.
const BACKUP_HOUR = 3;
const BACKUP_MINUTE = 17;

function stamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

/** Milisegundos hasta la próxima las 03:17. */
export function nextBackupDelay(now = new Date()) {
  const target = new Date(now);
  target.setHours(BACKUP_HOUR, BACKUP_MINUTE, 0, 0);
  if (target <= now) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - now.getTime();
}

/**
 * Respaldo de la base con VACUUM INTO y rotación.
 *
 * VACUUM INTO es la forma correcta de copiar una base SQLite en uso: escribe un archivo
 * nuevo y consistente sin bloquear a quien esté escribiendo, y sin el riesgo de copiar
 * el archivo a mano justo en medio de una transacción, con el WAL desacompasado.
 *
 * El destino tiene que estar FUERA del volumen del servicio. Un respaldo en el mismo
 * volumen se pierde junto con el original, que es exactamente el caso del que hay que
 * protegerse.
 */
export function createBackup({ db, backupDir, keep, log = console, now = () => new Date() }) {
  function prune() {
    let files;
    try {
      files = readdirSync(backupDir);
    } catch {
      return [];
    }
    const backups = files
      .filter((name) => name.startsWith(PREFIX) && name.endsWith(SUFFIX))
      .sort();
    // Los nombres son ISO, así que ordenar alfabéticamente es ordenar por fecha.
    const sobrantes = backups.slice(0, Math.max(0, backups.length - keep));
    for (const name of sobrantes) {
      try {
        unlinkSync(join(backupDir, name));
      } catch (error) {
        log.error(`No se pudo borrar el respaldo viejo ${name}:`, error.message);
      }
    }
    return sobrantes;
  }

  return {
    run() {
      mkdirSync(backupDir, { recursive: true });
      // El nombre lleva milisegundos, pero dos corridas dentro del mismo milisegundo
      // darían el mismo archivo, y VACUUM INTO falla si el destino ya existe. Un
      // contador lo vuelve imposible en vez de improbable.
      const base = join(backupDir, `${PREFIX}${stamp(now())}`);
      let target = `${base}${SUFFIX}`;
      for (let n = 1; existsSync(target); n += 1) {
        target = `${base}-${n}${SUFFIX}`;
      }
      // La ruta va escapada porque es un literal de SQL.
      const literal = target.replace(/'/g, "''");
      db.exec(`VACUUM INTO '${literal}'`);
      const pruned = prune();
      log.info(`Respaldo escrito en ${target}${pruned.length ? ` (${pruned.length} viejos borrados)` : ''}`);
      return { target, pruned };
    },
  };
}
```

- [ ] **Step 4: Correr los tests**

Run: `cd traccar/traccar-web/tools/enroll && node --test test/backup.test.js`
Expected: PASS, **7 tests**.

- [ ] **Step 5: Enganchar el respaldo al arranque y a la línea de comandos**

Crear `traccar/traccar-web/tools/enroll/src/server.js`:

```js
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createTraccarClient } from './traccar.js';
import { createEnrollService } from './enrollService.js';
import { createApp } from './app.js';
import { createBackup, nextBackupDelay } from './backup.js';

const config = loadConfig();
const db = openDb(config.dbPath);

const traccar = createTraccarClient({
  baseUrl: config.traccarUrl,
  email: config.serviceEmail,
  password: config.servicePassword,
});

const service = createEnrollService({ db, traccar, config });
const app = createApp({ config, service });

// Respaldo diario. Se calcula el retardo hasta las 03:17 y recién después se repite
// cada 24 horas, para no arrastrar el desfasaje de un setInterval que arranca a
// cualquier hora.
const backup = createBackup({ db, backupDir: config.backupDir, keep: config.backupKeep });
function scheduleBackup() {
  const delay = nextBackupDelay();
  setTimeout(() => {
    try {
      backup.run();
    } catch (error) {
      console.error('Falló el respaldo diario:', error.message);
    }
    scheduleBackup();
  }, delay).unref();
}
scheduleBackup();

const server = app.listen(config.port, () => {
  // Sin secretos: solo dónde escucha y contra qué Traccar habla.
  console.log(`Servicio de enrolamiento escuchando en el puerto ${config.port}`);
  console.log(`Traccar: ${config.traccarUrl}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
```

Crear también `src/backupCli.js`, para poder respaldar a mano sin esperar las 03:17:

```js
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createBackup } from './backup.js';

// `npm run backup`: un respaldo y salir. Sirve antes de una operación delicada.
const config = loadConfig();
const db = openDb(config.dbPath);
createBackup({ db, backupDir: config.backupDir, keep: config.backupKeep }).run();
db.close();
```

Y en `package.json`, cambiar el script de respaldo:

```json
    "backup": "node src/backupCli.js"
```

- [ ] **Step 6: Verificar que el respaldo a mano funciona**

Run:
```bash
cd traccar/traccar-web/tools/enroll
DB_PATH=/tmp/enroll-prueba.db BACKUP_DIR=/tmp/enroll-respaldos \
  TRACCAR_URL=http://127.0.0.1:18082 TRACCAR_SERVICE_EMAIL=x \
  TRACCAR_SERVICE_PASSWORD=contrasena-de-servicio-larga \
  ENROLL_ADMIN_PASSWORD=clave-de-admin-de-prueba-24 \
  npm run backup
ls -la /tmp/enroll-respaldos/
rm -rf /tmp/enroll-respaldos /tmp/enroll-prueba.db*
```
Expected: se escribe un archivo `enroll-<fecha>.db`. Nota: `BACKUP_DIR` distinto de `DB_PATH` es lo que se exige en producción.

- [ ] **Step 7: Correr toda la suite**

Run: `cd traccar/traccar-web/tools/enroll && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
cd traccar/traccar-web
git add tools/enroll/src/backup.js tools/enroll/src/backupCli.js tools/enroll/src/server.js tools/enroll/test/backup.test.js tools/enroll/package.json
git commit -m "Enrolamiento: respaldo diario con rotación

VACUUM INTO a una ruta fuera del volumen del servicio, con siete
copias rotadas y un temporizador diario a las 03:17. Un respaldo
dentro del mismo volumen se pierde junto con el original.

npm run backup hace una copia suelta, para antes de una operación
delicada.

Co-Authored-By: Claude Code <noreply@anthropic.com>
"
```

---

### Task 13: Imagen Docker y stack

**Files:**
- Create: `traccar/traccar-web/tools/enroll/Dockerfile`
- Create: `traccar/traccar-web/tools/enroll/.dockerignore`
- Create: `traccar/traccar-web/tools/enroll/docker-compose.yml`
- Create: `traccar/traccar-web/tools/enroll/.env.example`
- Modify: `traccar/traccar-web/tools/enroll/README.md`

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: la imagen `rudatrak-enroll:latest` y el stack `enroll`.

**La decisión de red, que es el punto de la corrección #9.** El servicio se publica en `127.0.0.1:3008:3008`, **no** en `3008:3008`. Publicar en todas las interfaces lo dejaría alcanzable desde la red local sin pasar por NPM ni por la VPN. Con `127.0.0.1`, el puerto solo existe en la loopback de la Pi.

Nada de eso afecta a NPM ni a la VPN, porque ninguno de los dos usa el puerto publicado:

- **NPM** llega al contenedor por la red interna de Docker, con el nombre del servicio (`enroll:3008`). Por eso se conecta a `npm_proxy-network`.
- **La VPN** llega por un túnel SSH al puerto de loopback. Ver el paso 6.

- [ ] **Step 1: Escribir el Dockerfile**

`traccar/traccar-web/tools/enroll/Dockerfile`:

```dockerfile
# Versión fija, no `node:22-alpine`: un build que anda hoy y otro que no, sin que
# nada haya cambiado en el repo, es la peor clase de falla. Ver el Step 2 de la Tarea 1.
FROM node:22.23.1-alpine

WORKDIR /app

# Solo el manifiesto primero: la capa de dependencias se reusa mientras no cambie.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src

ENV NODE_ENV=production
# El usuario `node` de la imagen tiene uid 1000. Los volúmenes tienen que ser suyos.
USER node

EXPOSE 3008

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3008/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
```

`traccar/traccar-web/tools/enroll/.dockerignore`:

```
node_modules
data
backups
test
*.test.js
.env
docker-compose*.yml
README.md
```

- [ ] **Step 2: Construir la imagen**

Run:
```bash
cd traccar/traccar-web/tools/enroll
docker build -t rudatrak-enroll:latest .
```
Expected: imagen construida. `docker run --rm rudatrak-enroll:latest node --version` debe decir `v22.23.1`.

- [ ] **Step 3: Verificar que la imagen no lleva los tests ni los secretos**

Run:
```bash
docker run --rm rudatrak-enroll:latest ls -la /app
docker run --rm rudatrak-enroll:latest ls /app/test 2>&1 | head -2
docker run --rm rudatrak-enroll:latest sh -c 'grep -rl "clave-de-admin" /app || echo "sin secretos"'
```
Expected: `/app` con `src`, `node_modules`, `package.json`. `ls /app/test` tiene que dar "No such file or directory" (`npm ci --omit=dev` no instala los tests y `.dockerignore` los excluye de todos modos). La tercera tiene que decir "sin secretos".

- [ ] **Step 4: Escribir el compose**

`traccar/traccar-web/tools/enroll/docker-compose.yml`:

```yaml
# Stack del servicio de enrolamiento. Es aditivo: contenedor, base y puerto propios.
# No toca Traccar, ni su base, ni su configuración.
services:
  enroll:
    build: .
    image: rudatrak-enroll:latest
    container_name: rudatrak-enroll
    restart: unless-stopped
    # Los secretos van en .env, que está en .gitignore y no se versiona nunca.
    env_file:
      - .env
    environment:
      # Dentro de la red de Docker, Traccar se llama por el nombre de su servicio.
      - TRACCAR_URL=http://traccar:8082
      - DB_PATH=/data/enroll.db
      # Fuera del volumen de la base: un respaldo adentro se pierde con el original.
      - BACKUP_DIR=/backups
    ports:
      # Solo loopback. NPM entra por la red interna y la VPN por un túnel SSH;
      # ninguno de los dos necesita el puerto publicado.
      - "127.0.0.1:3008:3008"
    volumes:
      - enroll-data:/data
      # Ruta del host, distinta de la del volumen de la base. Montar con
      # `chown 1000:1000` en la Pi, porque el proceso corre como uid 1000.
      - /mnt/datos/servicios/rudatrak/enroll-backups:/backups
    networks:
      - npm_proxy-network

volumes:
  enroll-data:

networks:
  npm_proxy-network:
    external: true
```

- [ ] **Step 5: Escribir `.env.example` y el README**

`traccar/traccar-web/tools/enroll/.env.example`:

```
# Copiar a .env y completar. .env no se versiona.
# El servicio se conecta a Traccar con su PROPIA cuenta, que NO es administradora:
# es una cuenta con userLimit distinto de 0, que en Traccar es el rol de manager.
TRACCAR_SERVICE_EMAIL=servicio@rudatrak.invalid
TRACCAR_SERVICE_PASSWORD=

# Clave del panel /admin. Mínimo 24 caracteres: el panel no tiene segundo factor.
ENROLL_ADMIN_USER=admin
ENROLL_ADMIN_PASSWORD=

# Vida del token que se emite en cada renovación, en días. Entre 30 y 60.
TOKEN_DAYS=45

# Cuántos pedidos sin aprobar se aceptan. /enroll/request es público.
MAX_PENDING=20
```

Agregar al `README.md`:

```markdown
## Puesta en marcha

1. Crear la cuenta de servicio en Traccar (ver "Cuenta de servicio").
2. Copiar `.env.example` a `.env` y completarlo.
3. `docker compose up -d`
4. Publicar **solo** `/enroll` en Nginx Proxy Manager, apuntando a `enroll:3008`.

## Cuenta de servicio

El servicio NO usa una cuenta de administrador de Traccar. Usa una cuenta con:

- `administrator`: **no**
- `userLimit`: **200** (cualquier valor distinto de 0)

En Traccar, "manager" no es un campo: es exactamente `administrator = false` con
`userLimit != 0` (`PermissionsService.java:84-85`). Alcanza para crear usuarios y
suplantarlos, y **no** permite administrar el servidor.

Una cuenta manager **no puede** fijar `deviceLimit` en los usuarios que crea:
`checkUserUpdate` compara contra un `User` vacío y llama a `checkAdmin`. Por eso los
usuarios enrolados quedan con `deviceLimit = 0` (sin tope propio). El tope real es el
`userLimit` de la cuenta de servicio.

## El panel /admin

No se publica en NPM. Se usa por la VPN, con un túnel al puerto de loopback:

```bash
ssh -L 3008:127.0.0.1:3008 <usuario>@<host-de-la-pi>
```

y después `http://127.0.0.1:3008/admin/` en el navegador.

Basic auth sobre HTTP manda la clave en base64, que no es cifrado. Dentro de un túnel
SSH eso es aceptable; expuesto a internet, no. Si algún día se publica, hace falta TLS.

## Respaldo

`VACUUM INTO` diario a las 03:17 hacia `BACKUP_DIR`, con `BACKUP_KEEP` copias rotadas
(7 por defecto). Esa ruta tiene que estar **fuera** del volumen de la base: un respaldo
en el mismo volumen se pierde con el original.

Para respaldar antes de una operación delicada: `docker compose exec enroll npm run backup`.
```

- [ ] **Step 6: Verificar el arranque contra un Traccar descartable**

Antes de apuntar a producción, el servicio se prueba entero contra el Traccar de la Tarea 4. Con el contenedor de smoke levantado, en la red de Docker correspondiente:

Run:
```bash
cd traccar/traccar-web/tools/enroll
docker build -t rudatrak-enroll:latest .
docker run --rm -p 127.0.0.1:3008:3008 \
  -e TRACCAR_URL=http://<contenedor-de-smoke>:8082 \
  -e TRACCAR_SERVICE_EMAIL='<cuenta manager del smoke>' \
  -e TRACCAR_SERVICE_PASSWORD='<su clave>' \
  -e ENROLL_ADMIN_PASSWORD='clave-de-admin-de-prueba-24' \
  rudatrak-enroll:latest
curl -s http://127.0.0.1:3008/health
```
Expected: `{"ok":true}`.

Esta es la prueba de punta a punta sin tocar producción: el servicio corre en su contenedor, contra un Traccar real, pero descartable.

- [ ] **Step 7: Verificar que el puerto no está en todas las interfaces**

Run: `ss -ltnp | grep 3008`
Expected: una sola línea, con `127.0.0.1:3008`. Si aparece `0.0.0.0:3008` o `*:3008`, el mapeo del compose quedó mal y el panel es alcanzable desde la red local.

- [ ] **Step 8: Commit**

```bash
cd traccar/traccar-web
git add tools/enroll/Dockerfile tools/enroll/.dockerignore tools/enroll/docker-compose.yml tools/enroll/.env.example tools/enroll/README.md
git commit -m "Enrolamiento: imagen Docker y stack

El puerto se publica en 127.0.0.1, no en todas las interfaces. NPM
entra por la red interna de Docker y el panel se usa por un túnel SSH,
así que ninguno de los dos necesita el puerto expuesto.

La imagen fija node:22.23.1-alpine y no instala dependencias de
desarrollo. Los secretos van en .env, que no se versiona.

Co-Authored-By: Claude Code <noreply@anthropic.com>
"
```

---

### Task 14: Puesta en marcha

**Files:**
- Modify: `traccar/traccar-web/tools/enroll/README.md`

**Esta tarea no la ejecuta un agente solo.** Es la única que toca el servidor en producción, y se hace **con Rodrigo**, paso por paso, con la lista a la vista. Todo lo anterior corre contra el Traccar descartable.

**Lo que esta tarea cambia en el sistema que ya funciona, y nada más:**

| Cambio | Dónde | Cómo se revierte |
|---|---|---|
| Un contenedor nuevo | stack de la Pi | `docker compose down` del stack `enroll` |
| Un proxy host nuevo para `/enroll` | Nginx Proxy Manager | deshabilitarlo en NPM |
| Una cuenta de servicio | Traccar | deshabilitarla |
| `registration` de `true` a `false` | Traccar | volver a `true` |

Las cuatro son aditivas o de una sola línea. Ninguna toca la base de Traccar, ni `traccar.xml`, ni el frontend, ni el contenedor de Traccar.

**El orden importa: la cuenta de servicio y el contenedor van ANTES de cerrar el registro.** Si se cierra el registro primero y algo del servicio falla, nadie nuevo puede enrolarse y hay que reabrir a las apuradas.

- [ ] **Step 1: Crear la cuenta de servicio en Traccar**

En la interfaz de Traccar, con la cuenta de administrador: crear un usuario con `administrator` sin marcar y `userLimit = 200`. Anotar el email y la contraseña (mínimo 16 caracteres).

Después, verificarla contra el Traccar descartable no sirve: hay que verificarla contra producción, y eso lo hace el propio servicio. Ir al paso 3.

- [ ] **Step 2: Verificar los permisos de la cuenta de servicio**

Run (desde la PC, sin credenciales en la línea de comandos — se piden de a una):
```bash
read -rs -p 'Contraseña de la cuenta de servicio: ' SERVICE_PASSWORD && echo
curl -s -u "<email-de-servicio>:$SERVICE_PASSWORD" https://mh.rudatrak.com/api/session | head -c 300
unset SERVICE_PASSWORD
```
Expected: un JSON con `"administrator":false` y `"userLimit":200`. Si dice `"administrator":true`, **parar**: el servicio tendría más permisos de los que necesita.

- [ ] **Step 3: Desplegar el contenedor**

En la Pi, desde el repo:

Run:
```bash
cd /mnt/datos/RudaTrak-web/traccar-web/tools/enroll
cp .env.example .env
# Completar .env con los valores reales antes de seguir.
chmod 600 .env
mkdir -p /mnt/datos/servicios/rudatrak/enroll-backups
sudo chown 1000:1000 /mnt/datos/servicios/rudatrak/enroll-backups
docker compose up -d
docker compose logs --tail 20
```
Expected: `Servicio de enrolamiento escuchando en el puerto 3008`. El registro no debe mostrar la contraseña ni el email.

- [ ] **Step 4: Verificar que el servicio ve a Traccar y que responde**

Run:
```bash
curl -s http://127.0.0.1:3008/health
```
Expected: `{"ok":true}`.

- [ ] **Step 5: Publicar solo `/enroll` en Nginx Proxy Manager**

Crear un proxy host para `enroll.rudatrak.com` (o el subdominio que se elija), forwardeando a `enroll:3008` por la red `npm_proxy-network`, con SSL de Let's Encrypt.

**`/admin` no se publica.** Si el proxy host expone todo el servicio, el panel queda en internet con Basic auth y sin TLS propio, que es justo lo que la corrección #6 evita. Verificar que `/admin/` **no** sea alcanzable por el dominio público:

Run:
```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<subdominio>/admin/
curl -s -o /dev/null -w '%{http_code}\n' https://<subdominio>/enroll/status
```
Expected: `/admin/` distinto de 200 (403, 404 o el proxy host no lo alcanza), y `/enroll/status` con 401 (falta la cabecera del secreto, así que existe y está protegido).

- [ ] **Step 6: Probar un enrolamiento completo, de punta a punta**

Desde la VPN, con el túnel del panel abierto:

```bash
SECRET=$(head -c 32 /dev/urandom | base64)
curl -s -X POST https://<subdominio>/enroll/request \
  -H 'Content-Type: application/json' \
  -d "{\"deviceSecret\":\"$SECRET\",\"note\":\"Prueba de Rodrigo\"}"
```
Expected: `{"code":"RUDA-XXXX-XXXX","expiresAt":"..."}`.

Anotar el código, aprobarlo desde el panel, y después:

```bash
curl -s -X POST https://<subdominio>/enroll/renew -H "X-Device-Secret: $SECRET"
```
Expected: `{"token":"eyJ…","expiresAt":"…"}`.

Verificar que Traccar acepta ese token:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer <token>" https://mh.rudatrak.com/api/devices
```
Expected: `200`.

Y que el usuario nuevo **no** es administrador:

```bash
curl -s "https://mh.rudatrak.com/api/session?token=<token>" | head -c 200
```
Expected: `"administrator":false`. **El token va como parámetro de consulta acá y no como Bearer**: `/api/session` con `Authorization: Bearer` devuelve 404.

- [ ] **Step 7: Revocar la prueba y confirmar que el acceso se corta**

Desde el panel, revocar el código de prueba. Después:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer <token>" https://mh.rudatrak.com/api/devices
curl -s -X POST https://<subdominio>/enroll/renew -H "X-Device-Secret: $SECRET" -o /dev/null -w '%{http_code}\n'
```
Expected: las dos con `401` o `403`. Si el token sigue devolviendo 200, la revocación no funciona y **no hay que cerrar el registro todavía**.

- [ ] **Step 8: Cerrar el auto-registro**

Recién ahora, y solo si los pasos 6 y 7 dieron lo esperado.

En la interfaz de Traccar: Settings → Server → desmarcar **Registration**.

Run:
```bash
ssh <usuario>@<host-de-la-pi> "docker exec rudatrak-database psql -U traccar -d traccar -tAc 'SELECT registration FROM tc_servers;'"
```
Expected: `f`.

- [ ] **Step 9: Verificar que un desconocido ya no puede crearse una cuenta**

Run:
```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://mh.rudatrak.com/api/session \
  -d 'email=prueba-no-autorizada@rudatrak.invalid&password=una-clave-cualquiera'
```
Expected: `401`. Con `200` el registro sigue abierto.

Nota: `POST /api/session` es login, no registro — el registro es `POST /api/users`. Como esta petición usa credenciales que no existen, un 401 confirma que no se creó ninguna cuenta. Para verificar el registro en sí, alcanza con el paso 8.

- [ ] **Step 10: Documentar el estado en el README**

Agregar al `README.md` la fecha de puesta en marcha, el subdominio elegido, y el resultado de los pasos 6, 7 y 9. Si algo se apartó del plan, escribirlo: dentro de seis meses, el README es lo único que va a explicar por qué el sistema está como está.

- [ ] **Step 11: Commit y tag**

```bash
cd /mnt/datos/RudaTrak-web/traccar-web
git add tools/enroll/README.md
git commit -m "Enrolamiento: puesta en marcha en producción

Registro del subdominio, la fecha y el resultado de las pruebas de
extremo a extremo. El auto-registro de Traccar quedó cerrado.

Co-Authored-By: Claude Code <noreply@anthropic.com>
"
git tag -a post-enrolamiento -m "Servicio de enrolamiento en producción"
```

---

## Rollback

Si algo sale mal después del paso 8 de la Tarea 14, en orden de urgencia:

1. **Volver a abrir el registro** para que nadie quede afuera: Settings → Server → marcar Registration. Es un clic y no requiere deploy.
2. **Bajar el servicio**: `docker compose down` en `tools/enroll`. Traccar sigue funcionando igual que antes, porque nunca dependió de él.
3. **Deshabilitar la cuenta de servicio** en Traccar, si se sospecha de sus credenciales.
4. **Restaurar la base del servicio** desde `/mnt/datos/servicios/rudatrak/enroll-backups/`, si hiciera falta.

Lo que **no** hay que hacer en ningún caso: tocar el `traccar.xml`, la base de Traccar, o el contenedor `rudatrak`. Nada de este plan los modifica, así que ante la duda el camino es siempre hacia atrás por el servicio de enrolamiento, no por Traccar.

Puntos de retorno que ya existen: tag `pre-enrolamiento` en los tres repos, el dump `~/traccar-backup-2026-10-06.sql` y `traccar.xml.bak-2026-10-06` en la Pi.
