import net from 'node:net';
import { createTraccarClient, TraccarError } from './traccar.js';

const SERVICE_EMAIL = process.env.SMOKE_SERVICE_EMAIL;
const SERVICE_PASSWORD = process.env.SMOKE_SERVICE_PASSWORD;
// La cuenta administradora del contenedor descartable. Solo se usa para crear un
// usuario que el manager NO creó: sin ella no se puede verificar la frontera entre
// "mis usuarios" y "los demás", que es la que sostiene la suplantación.
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.SMOKE_ADMIN_PASSWORD;
const BASE_URL = process.env.SMOKE_TRACCAR_URL || 'http://127.0.0.1:18082';
// El puerto OsmAnd (5055) del descartable. Por este puerto se reportan posiciones con
// GET /?id=<uniqueId>&lat=..&lon=.. para verificar el camino de protocolo de punta a punta.
const OSMAND_URL = process.env.SMOKE_OSMAND_URL || 'http://127.0.0.1:15055';
const EXPECTED_VERSION = process.env.SMOKE_EXPECTED_VERSION || '6.15.3';
const TOKEN_DAYS = 45;
// `osmand.timeout` del descartable (docker-compose.smoke.yml), en segundos. El smoke lo
// usa para esperar de más y comprobar que la conexión inactiva se cierra de verdad.
const OSMAND_TIMEOUT_S = Number(process.env.SMOKE_OSMAND_TIMEOUT || 10);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

/** `assert.rejects` de node:test resuelve a undefined; acá hace falta el error. */
const capture = (promise) => promise.then(() => null, (error) => error);

const expiration = () => new Date(Date.now() + TOKEN_DAYS * 24 * 60 * 60 * 1000);

/**
 * El smoke nunca debe apuntar a un servidor real: crea usuarios, emite tokens y
 * deshabilita cuentas. Se exige que el host sea local.
 */
function assertLocalHost(url, variable) {
  const { hostname } = new URL(url);
  const local = ['127.0.0.1', 'localhost', '::1', '0.0.0.0'];
  assert(
    local.includes(hostname),
    `${variable} debe apuntar a un Traccar descartable local, no a ${hostname}`,
  );
}

/**
 * Traccar responde los errores con el stack trace entero como cuerpo. La primera línea
 * trae la excepción y su mensaje, que es toda la evidencia útil; el resto son 5 KB de
 * frames que no dicen nada.
 */
function primeraLinea(body) {
  return String(body ?? '').split('\n')[0].slice(0, 160);
}

/** Del token se informa la forma, nunca el valor: alcanza para saber que sirve. */
function describeToken(token) {
  return `${token.length} caracteres, sin comillas, solo [A-Za-z0-9._-], termina en …${token.slice(-4)}`;
}

const { hostname: OSMAND_HOST, port: OSMAND_PORT } = new URL(OSMAND_URL);

/** Parámetros de un reporte OsmAnd. El resto van fijos: no son el objeto de la verificación. */
function osmAndParams(uniqueId, { lat, lon, timestamp = Date.now() }) {
  return {
    id: uniqueId, lat, lon, timestamp,
    speed: 0, bearing: 0, accuracy: 0, altitude: 0, batt: 100,
  };
}

/**
 * Conexión TCP cruda al puerto OsmAnd.
 *
 * Node no deja controlar la reutilización desde `fetch`: su pool recicla la conexión sin
 * avisar, y ese fue el camino que produjo el falso negativo del smoke original — el reporte
 * del dispositivo deshabilitado viajó por una conexión con la sesión ya cacheada, que es
 * justo donde el gate de `disabled` no se evalúa (ConnectionManager.getDeviceSession
 * retorna temprano desde `sessionsByEndpoint`). Con un socket propio, "reutilizada" y
 * "nueva" son decisiones explícitas, y el cierre por inactividad del servidor se observa
 * en el evento `close`.
 */
function openOsmAndConnection() {
  const socket = net.connect({ host: OSMAND_HOST, port: OSMAND_PORT });
  socket.setEncoding('utf8');

  let buffer = '';
  let closed = false;
  let wake = null;

  const despertar = () => {
    if (wake) {
      const continuar = wake;
      wake = null;
      continuar();
    }
  };
  socket.on('data', (chunk) => { buffer += chunk; despertar(); });
  socket.on('close', () => { closed = true; despertar(); });
  socket.on('error', () => { closed = true; despertar(); });

  const listo = new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  return {
    listo,
    get cerrada() { return closed; },

    /**
     * GET /?id=..&lat=..&lon=.. sobre ESTA conexión (keep-alive).
     * Devuelve `{ status }`, o `{ cerrada: true }` si el servidor cerró el socket: con un
     * dispositivo deshabilitado sobre una conexión nueva, el decoder lanza antes de
     * responder y Netty cierra sin escribir, así que no hay status que leer.
     */
    async reportar(uniqueId, coords) {
      buffer = '';
      const query = new URLSearchParams(
        Object.entries(osmAndParams(uniqueId, coords)).map(([k, v]) => [k, String(v)]),
      );
      socket.write(
        `GET /?${query} HTTP/1.1\r\nHost: ${OSMAND_HOST}:${OSMAND_PORT}\r\nConnection: keep-alive\r\n\r\n`,
      );
      const deadline = Date.now() + 8000;
      while (!buffer.includes('\r\n\r\n') && !closed && Date.now() < deadline) {
        await new Promise((resolve) => {
          wake = resolve;
          setTimeout(resolve, 200);
        });
      }
      if (closed) {
        return { cerrada: true };
      }
      const match = /^HTTP\/1\.1 (\d+)/.exec(buffer);
      return { status: match ? Number(match[1]) : null };
    },

    cerrar() { socket.destroy(); },
  };
}

/** Reporte por una conexión NUEVA, cerrada al terminar: el camino de un cliente frío. */
async function osmAndReport(uniqueId, coords) {
  const conexion = openOsmAndConnection();
  await conexion.listo;
  const resultado = await conexion.reportar(uniqueId, coords);
  conexion.cerrar();
  return resultado;
}

/** Describe el resultado de un reporte OsmAnd sin ambigüedad. */
const describirReporte = (r) => (r.cerrada ? 'conexión cerrada por el servidor' : `HTTP ${r.status}`);

async function main() {
  assertLocalHost(BASE_URL, 'SMOKE_TRACCAR_URL');
  assertLocalHost(OSMAND_URL, 'SMOKE_OSMAND_URL');
  assert(SERVICE_EMAIL && SERVICE_PASSWORD, 'Faltan SMOKE_SERVICE_EMAIL y SMOKE_SERVICE_PASSWORD');

  const traccar = createTraccarClient({
    baseUrl: BASE_URL,
    email: SERVICE_EMAIL,
    password: SERVICE_PASSWORD,
  });
  // El administrador del descartable, reutilizado en varias verificaciones (crea el
  // usuario ajeno, crea el dispositivo ajeno y lista todos los dispositivos para
  // confirmar que un uniqueId desconocido no creó nada).
  const admin = ADMIN_EMAIL && ADMIN_PASSWORD
    ? createTraccarClient({ baseUrl: BASE_URL, email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
    : null;
  const checks = [];
  const check = async (name, fn) => {
    const state = { detail: null };
    try {
      await fn(state);
      checks.push({ name, ok: true, detail: state.detail });
    } catch (error) {
      checks.push({ name, ok: false, error: error.message, detail: state.detail });
    }
  };
  // Los usuarios se crean con marcas de tiempo para poder correr el smoke varias veces
  // contra el mismo contenedor sin chocar con el índice único de email.
  const suffix = Date.now();
  const created = [];
  const createdByAdmin = [];
  const createdDevices = [];
  const createdDevicesByAdmin = [];
  let issuedToken = null;
  let enrolledDeviceId = null;
  let enrolledUniqueId = null;
  let adminDeviceId = null;
  // La conexión keep-alive que (f1) abre y (f2) reutiliza después de deshabilitar. Es el
  // objeto de la medición: mientras siga viva, la sesión cacheada saltea el gate.
  let conexionEnrolada = null;

  // Historial de la última hora. Sin `from`/`to`, /api/positions devuelve una sola
  // posición (la última), que sirve para "¿llegó la última?" pero no para "¿llegaron las
  // dos?" — y con dos reportes del mismo dispositivo la comparación mentiría.
  const historial = (deviceId) => traccar.getPositions(deviceId, {
    from: new Date(Date.now() - 3600e3),
    to: new Date(Date.now() + 60e3),
  });
  const contiene = (positions, lat, lon) => positions.some(
    (p) => Math.abs(p.latitude - lat) < 0.0001 && Math.abs(p.longitude - lon) < 0.0001,
  );

  // Devuelve true cuando la posición (lat, lon) aparece en el historial; espera hasta
  // `waitMs` muestreando cada 250 ms. La posición se guarda en el pipeline de forma
  // asíncrona, así que un GET inmediato puede llegar antes.
  const hasPosition = async (deviceId, lat, lon, waitMs) => {
    const deadline = Date.now() + (waitMs ?? 0);
    for (;;) {
      if (contiene(await historial(deviceId), lat, lon)) {
        return true;
      }
      if (Date.now() >= deadline) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };

  await check('la versión del servidor coincide con la de producción', async (state) => {
    const info = await traccar.serverInfo();
    state.detail = `GET /api/server → version ${info.version}`;
    assert(
      info.version === EXPECTED_VERSION,
      `esperaba ${EXPECTED_VERSION}, el servidor dice ${info.version}`,
    );
  });

  await check('la cuenta de servicio NO es administradora y es manager', async (state) => {
    const me = await traccar.whoAmI();
    state.detail = `POST /api/session (login) → id ${me.id}, administrator ${me.administrator}, userLimit ${me.userLimit}, deviceLimit ${me.deviceLimit}`;
    assert(me.administrator === false, 'la cuenta de servicio no debe ser administradora');
    assert(me.userLimit !== 0, 'la cuenta de servicio debe tener userLimit distinto de 0');
    assert(me.deviceLimit !== 0, 'la cuenta de servicio debe tener deviceLimit distinto de 0 para crear dispositivos');
  });

  await check('crear un usuario con permisos mínimos', async (state) => {
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

    state.detail = `POST /api/users → id ${user.id}; releído: readonly ${stored.readonly}, deviceReadonly ${stored.deviceReadonly}, limitCommands ${stored.limitCommands}, disableReports ${stored.disableReports}, administrator ${stored.administrator}`;
  });

  await check('un manager NO puede fijar deviceLimit', async (state) => {
    // checkUserUpdate compara contra un User vacío (deviceLimit 0) y llama a checkAdmin.
    // Si esto llegara a pasar, el plan podría endurecer el límite de dispositivos.
    let rechazado = null;
    try {
      await traccar.createUser({
        name: `Smoke limit ${suffix}`,
        email: `smoke-limit-${suffix}@rudatrak.invalid`,
        password: `clave-${suffix}-limite`,
        administrator: false,
        deviceLimit: 1,
      });
    } catch (error) {
      rechazado = error instanceof TraccarError ? error : null;
    }
    // El estado es 400, no 403: ResourceErrorHandler mapea cualquier SecurityException a
    // BAD_REQUEST con el stack trace como cuerpo. Por eso lo que se afirma es el mensaje
    // de checkAdmin, que es la evidencia real de la denegación.
    const motivo = rechazado && rechazado.body.includes('Administrator access required');
    state.detail = rechazado
      ? `POST /api/users con deviceLimit:1 → ${rechazado.status}, ${primeraLinea(rechazado.body)}`
      : 'POST /api/users con deviceLimit:1 → aceptado';
    assert(motivo, 'el manager pudo fijar deviceLimit: revisar el diseño de permisos');
  });

  await check('suplantar y emitir un token para el usuario nuevo', async (state) => {
    const userId = created[0];
    const token = await traccar.mintTokenFor(userId, expiration());
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

    state.detail = [
      `token: ${describeToken(token)}`,
      `GET /api/session?token= → 200, id ${who.id} (el usuario nuevo, no la cuenta de servicio), administrator ${who.administrator}`,
      `GET /api/devices con Bearer → ${devices.status}`,
    ].join('\n      → ');
    issuedToken = token;
  });

  await check('el manager suplanta a un usuario que creó y NO a uno que no creó', async (state) => {
    assert(
      admin,
      'faltan SMOKE_ADMIN_EMAIL y SMOKE_ADMIN_PASSWORD: sin la cuenta administradora no se puede crear un usuario ajeno al manager',
    );

    // Creado por el administrador: Traccar no le anota vínculo ManagedUser con el
    // manager, así que checkUser tiene que negarle el acceso.
    const ajeno = await admin.createUser({
      name: `Ajeno ${suffix}`,
      email: `ajeno-${suffix}@rudatrak.invalid`,
      password: `clave-${suffix}-ajena`,
    });
    createdByAdmin.push(ajeno.id);
    assert(ajeno.administrator === false, 'el usuario ajeno quedó como administrador');

    const negado = await capture(traccar.mintTokenFor(ajeno.id, expiration()));
    assert(negado instanceof TraccarError, `se esperaba un TraccarError, llegó ${negado}`);
    // 400 y no 403, por ResourceErrorHandler (SecurityException → BAD_REQUEST); lo que
    // identifica la denegación de checkUser es el mensaje, no el estado.
    const denegado = negado.status === 400 && negado.body.includes('User access denied');

    const propio = await traccar.mintTokenFor(created[0], expiration());
    assert(/^[A-Za-z0-9._-]+$/.test(propio), 'el token del usuario propio no tiene forma válida');

    state.detail = [
      `usuario propio (id ${created[0]}, creado por el manager) → token emitido (${describeToken(propio)})`,
      `usuario ajeno (id ${ajeno.id}, creado por el administrador) → ${negado.status}, ${primeraLinea(negado.body)}`,
    ].join('\n      → ');
    assert(denegado, 'el manager pudo suplantar a un usuario que no creó: la frontera no existe');
  });

  await check('revocar el token emitido', async (state) => {
    const token = issuedToken;
    assert(token, 'no hay token para revocar');
    // Entrecomillado a propósito (aunque 6.15.3 lo devuelva pelado): así se prueba
    // también la normalización de `revokeToken`, que es lo que hoy no cubre nada más.
    await traccar.revokeToken(`"${token}"`);
    const session = await fetch(`${BASE_URL}/api/session?token=${token}`);
    assert(session.status === 401, `esperaba 401 tras revocar, devolvió ${session.status}`);
    state.detail = `POST /api/session/token/revoke (token entrecomillado a propósito, para probar la normalización) → GET /api/session?token= devuelve ${session.status}`;
  });

  await check('deshabilitar al usuario invalida todos sus tokens', async (state) => {
    const userId = created[0];
    const token = await traccar.mintTokenFor(userId, expiration());

    await traccar.disableUser(userId);

    const session = await fetch(`${BASE_URL}/api/session?token=${token}`);
    assert(session.status === 401, `esperaba 401 con el usuario deshabilitado, devolvió ${session.status}`);
    state.detail = `token emitido ANTES de deshabilitar → GET /api/session?token= devuelve ${session.status} (el token ya estaba en la mano del usuario)`;
  });

  await check('deshabilitar no borra los permisos del usuario', async (state) => {
    // Si disableUser mandara un parche, estos cuatro volverían a false.
    const stored = await traccar.getUser(created[0]);
    assert(stored.disabled === true, 'el usuario no quedó deshabilitado');
    assert(stored.readonly === true, 'disableUser borró readonly');
    assert(stored.deviceReadonly === true, 'disableUser borró deviceReadonly');
    assert(stored.limitCommands === true, 'disableUser borró limitCommands');
    assert(stored.disableReports === true, 'disableUser borró disableReports');
    state.detail = `PUT /api/users/${created[0]} con el objeto completo → disabled ${stored.disabled}, readonly ${stored.readonly}, deviceReadonly ${stored.deviceReadonly}, limitCommands ${stored.limitCommands}, disableReports ${stored.disableReports}`;
  });

  await check('el usuario deshabilitado puede volver a habilitarse', async (state) => {
    const stored = await traccar.getUser(created[0]);
    await traccar.updateUser({ ...stored, disabled: false });
    const relectura = await traccar.getUser(created[0]);
    assert(relectura.disabled === false, 'no se pudo rehabilitar');
    state.detail = `PUT con disabled:false → releído disabled ${relectura.disabled}`;
  });

  // Este check no juzga: mide. `readonly` + `deviceReadonly` le prohíben a la persona
  // crear dispositivos (PermissionsService.checkEdit los evalúa antes que deviceLimit),
  // y la app necesita crear el suyo. Las dos respuestas son un dato útil, y la que salga
  // decide cómo lo resuelve el Plan 2 (el servicio creando el dispositivo al aprobar, o
  // un juego de permisos distinto). Por eso no hay `assert`: un smoke que falla cuando
  // la realidad no coincide con la suposición no informa, estorba.
  const observaciones = [];
  await check('observar si un usuario con permisos mínimos puede crear un dispositivo', async (state) => {
    const userId = created[0];
    const token = await traccar.mintTokenFor(userId, expiration());
    const response = await fetch(`${BASE_URL}/api/devices`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `Dispositivo ${suffix}`, uniqueId: `smoke-${suffix}` }),
    });
    const cuerpo = await response.text();
    state.detail = `POST /api/devices con el token del usuario → ${response.status} ${cuerpo.slice(0, 120)}`;
    observaciones.push(
      response.ok
        ? 'Un usuario con permisos mínimos SÍ puede crear su propio dispositivo: los permisos alcanzan tal como están.'
        : `Un usuario con permisos mínimos NO puede crear dispositivos (${response.status}). El Plan 2 tiene que resolverlo: o el servicio crea el dispositivo al aprobar, o los usuarios enrolados llevan otro juego de permisos.`,
    );
  });

  // --- Verificaciones de dispositivos (decisión de Rodrigo, "Ampliá el smoke") ---------
  // (a) a (g). El usuario enrolado es `created[0]` (readonly + deviceReadonly), que ya
  // quedó habilitado tras la verificación 10.

  await check('(a) el manager crea un dispositivo con uniqueId aleatorio', async (state) => {
    const uniqueId = `rt-${suffix}-${Math.random().toString(16).slice(2)}`;
    const device = await traccar.createDevice({ name: `Teléfono ${suffix}`, uniqueId });
    createdDevices.push(device.id);
    enrolledDeviceId = device.id;
    enrolledUniqueId = uniqueId;
    assert(device.id > 0, 'el dispositivo no tiene id');
    assert(device.uniqueId === uniqueId, 'el uniqueId no quedó como se pidió');
    state.detail = `POST /api/devices → id ${device.id}, uniqueId ${uniqueId}`;
  });

  await check('(b) el manager vincula el dispositivo al usuario enrolado', async (state) => {
    const userId = created[0];
    await traccar.linkDevice(userId, enrolledDeviceId);
    // Evidencia del efecto: el usuario, vía token, ya ve el dispositivo en su listado.
    const token = await traccar.mintTokenFor(userId, expiration());
    const devices = await (await fetch(`${BASE_URL}/api/devices`, {
      headers: { Authorization: `Bearer ${token}` },
    })).json();
    const ids = devices.map((d) => d.id);
    assert(ids.includes(enrolledDeviceId), `el vínculo no hizo visible el dispositivo: el usuario ve ${JSON.stringify(ids)}`);
    state.detail = `POST /api/permissions {userId:${userId}, deviceId:${enrolledDeviceId}} → 204; el usuario ve ${JSON.stringify(ids)}`;
  });

  await check('(c) el usuario enrolado ve EXACTAMENTE su dispositivo y ningún otro', async (state) => {
    assert(admin, 'falta la cuenta administradora (SMOKE_ADMIN_*) para crear un dispositivo ajeno');
    const ajeno = await admin.createDevice({
      name: `Ajeno ${suffix}`,
      uniqueId: `rt-ajeno-${suffix}-${Math.random().toString(16).slice(2)}`,
    });
    createdDevicesByAdmin.push(ajeno.id);
    adminDeviceId = ajeno.id;

    const userId = created[0];
    const token = await traccar.mintTokenFor(userId, expiration());
    const devices = await (await fetch(`${BASE_URL}/api/devices`, {
      headers: { Authorization: `Bearer ${token}` },
    })).json();
    const ids = devices.map((d) => d.id);

    assert(ids.includes(enrolledDeviceId), `el usuario no ve su dispositivo ${enrolledDeviceId}: ve ${JSON.stringify(ids)}`);
    assert(!ids.includes(ajeno.id), `el usuario ve el dispositivo ajeno ${ajeno.id}: ve ${JSON.stringify(ids)}`);
    assert(ids.length === 1, `el usuario debería ver exactamente 1 dispositivo, ve ${ids.length}: ${JSON.stringify(ids)}`);

    state.detail = `GET /api/devices (token del usuario, readonly) → ${JSON.stringify(ids)} (solo el propio ${enrolledDeviceId}, no el ajeno ${ajeno.id})`;
  });

  await check('(d) el usuario enrolado NO puede modificar ni borrar su dispositivo', async (state) => {
    const userId = created[0];
    const token = await traccar.mintTokenFor(userId, expiration());
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const update = await fetch(`${BASE_URL}/api/devices/${enrolledDeviceId}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ id: enrolledDeviceId, name: 'hack', uniqueId: enrolledUniqueId }),
    });
    const updateBody = await update.text();

    const del = await fetch(`${BASE_URL}/api/devices/${enrolledDeviceId}`, {
      method: 'DELETE',
      headers,
    });
    const delBody = await del.text();

    // readonly es la frontera: checkEdit evalúa server.readonly || user.readonly antes
    // que nada, y lanza "Write access denied" (que ResourceErrorHandler manda como 400).
    const updateDenegado = update.status === 400 && updateBody.includes('Write access denied');
    const deleteDenegado = del.status === 400 && delBody.includes('Write access denied');

    state.detail = [
      `PUT /api/devices/${enrolledDeviceId} → ${update.status} ${primeraLinea(updateBody)}`,
      `DELETE /api/devices/${enrolledDeviceId} → ${del.status} ${primeraLinea(delBody)}`,
    ].join('\n      → ');
    assert(updateDenegado, 'el usuario pudo modificar su dispositivo');
    assert(deleteDenegado, 'el usuario pudo borrar su dispositivo');
  });

  await check('(e) el manager NO puede ver ni modificar un dispositivo del administrador', async (state) => {
    assert(adminDeviceId, 'falta el dispositivo ajeno creado en (c)');

    const ver = await capture(traccar.getDevice(adminDeviceId));
    const verDenegado = ver instanceof TraccarError && ver.status === 400 && ver.body.includes('Device access denied');

    const mod = await capture(traccar.updateDevice({ id: adminDeviceId, name: 'hack', uniqueId: `rt-hack-${suffix}` }));
    const modDenegado = mod instanceof TraccarError && mod.status === 400 && mod.body.includes('Device access denied');

    const list = await traccar.getDevices();
    const ids = list.map((d) => d.id);
    assert(!ids.includes(adminDeviceId), `el manager ve el dispositivo ajeno ${adminDeviceId} en su listado`);

    state.detail = [
      `GET /api/devices/${adminDeviceId} → ${ver.status} ${primeraLinea(ver.body)}`,
      `PUT /api/devices/${adminDeviceId} → ${mod.status} ${primeraLinea(mod.body)}`,
      `GET /api/devices (manager) → ${JSON.stringify(ids)} (no incluye ${adminDeviceId})`,
    ].join('\n      → ');
    assert(verDenegado, 'el manager pudo ver el dispositivo ajeno');
    assert(modDenegado, 'el manager pudo modificar el dispositivo ajeno');
  });

  // (f) desglosada. El smoke original la tenía en una sola verificación que esperaba
  // 2000 ms cuando el pipeline retenía la posición 3000 ms, y además reportaba el caso
  // deshabilitado por una conexión reutilizada sin saberlo: un falso negativo con dos
  // causas. Los cuatro casos van separados para que cada uno afirme solo lo que mide.

  await check('(f1) el dispositivo habilitado reporta por una conexión nueva y la posición llega', async (state) => {
    // Esta conexión sobrevive a propósito: (f2) la reutiliza.
    conexionEnrolada = openOsmAndConnection();
    await conexionEnrolada.listo;

    const lat = -34.6037;
    const lon = -58.3816;
    const reporte = await conexionEnrolada.reportar(enrolledUniqueId, { lat, lon });
    const llego = await hasPosition(enrolledDeviceId, lat, lon, 5000);

    state.detail = `GET /?id=${enrolledUniqueId} por conexión NUEVA → ${describirReporte(reporte)}; GET /api/positions → ${llego ? 'LLEGA' : 'NO llega'} (${lat},${lon})`;
    assert(reporte.status === 200, `esperaba 200, llegó ${describirReporte(reporte)}`);
    assert(llego, 'la posición del dispositivo habilitado no llegó');
  });

  await check('(f2) deshabilitado: la conexión YA ESTABLECIDA sigue reportando (esto MIDE la ventana)', async (state) => {
    assert(
      conexionEnrolada && !conexionEnrolada.cerrada,
      'la conexión de (f1) se cerró antes de poder medir la ventana: subir OSMAND_TIMEOUT del descartable',
    );

    await traccar.disableDevice(enrolledDeviceId);

    const lat = -31.4201;
    const lon = -64.1888;
    const reporte = await conexionEnrolada.reportar(enrolledUniqueId, { lat, lon });
    const llego = await hasPosition(enrolledDeviceId, lat, lon, 5000);

    state.detail = [
      `PUT /api/devices/${enrolledDeviceId} con disabled:true`,
      `mismo id=${enrolledUniqueId} por la MISMA conexión (sesión cacheada) → ${describirReporte(reporte)}`,
      `GET /api/positions → ${llego ? 'LLEGA' : 'no llega'} (${lat},${lon})`,
    ].join('\n      → ');

    // Lo que se afirma es que la conexión viva NO se corta. Que la posición llegue es la
    // ventana: se mide y se documenta, no se celebra. Si algún día deja de llegar, la
    // ventana se cerró y el reporte lo dirá — no hay que fallar por una mejora.
    assert(reporte.status === 200, `la conexión ya establecida devolvió ${describirReporte(reporte)}, esperaba 200`);
    if (llego) {
      observaciones.push(
        `Ventana de revocación: un dispositivo deshabilitado SIGUE almacenando posiciones mientras `
        + 'mantenga viva su conexión. La sesión cacheada (ConnectionManager.sessionsByEndpoint) '
        + 'saltea Disableable.checkDisabled, que solo se evalúa al crear la sesión. La ventana se '
        + `acota con el timeout de inactividad del protocolo — ver la verificación (h).`,
      );
    }
  });

  await check('(f3) deshabilitado: una conexión NUEVA es rechazada y la posición no se almacena', async (state) => {
    const lat = -30.4201;
    const lon = -63.1888;
    const reporte = await osmAndReport(enrolledUniqueId, { lat, lon });
    const llego = await hasPosition(enrolledDeviceId, lat, lon, 3000);

    state.detail = `GET /?id=${enrolledUniqueId} por conexión NUEVA → ${describirReporte(reporte)}; GET /api/positions → ${llego ? 'LLEGA (mal)' : 'no llega'} (${lat},${lon})`;
    assert(reporte.cerrada, `una conexión nueva debía ser rechazada, devolvió ${describirReporte(reporte)}`);
    assert(!llego, 'la posición del dispositivo deshabilitado se almacenó por una conexión nueva');
  });

  await check('(f4) un uniqueId desconocido no crea dispositivo', async (state) => {
    const unknownId = `rt-unknown-${suffix}-${Math.random().toString(16).slice(2)}`;
    const reporte = await osmAndReport(unknownId, { lat: -32.8895, lon: -68.8458 });
    const todos = await admin.getDevices({ all: true });
    const creado = todos.some((d) => d.uniqueId === unknownId);

    state.detail = `GET /?id=${unknownId} (inexistente) → ${describirReporte(reporte)}; GET /api/devices?all=true → ${creado ? 'CREÓ dispositivo (mal)' : 'no creó'}`;
    assert(reporte.status === 400, `unknownId devolvió ${describirReporte(reporte)}, esperaba 400`);
    assert(!creado, 'el unknownId creó un dispositivo: DATABASE_REGISTER_UNKNOWN no está en false');
  });

  await check('(g) compensación: qué queda creado y cómo se borra', async (state) => {
    // No es una operación contra el servidor: es la auditoría de lo que dejó el smoke y
    // de cómo se compensa cada paso fallido. El bloque de limpieza de abajo borra todo
    // (dispositivos y usuarios), y el README detalla la compensación paso por paso.
    const inventario = [
      `dispositivos del manager: ${JSON.stringify(createdDevices)}`,
      `dispositivos del administrador: ${JSON.stringify(createdDevicesByAdmin)}`,
      `usuarios del manager: ${JSON.stringify(created)}`,
      `usuarios del administrador: ${JSON.stringify(createdByAdmin)}`,
    ].join('; ');
    state.detail = `inventario → ${inventario} — todo se borra en el bloque de limpieza (DELETE dispositivo → DELETE usuario, con CASCADE en tc_user_device)`;
  });

  await check(`(h) la ventana se acota: a los ${OSMAND_TIMEOUT_S} s de inactividad el servidor cierra la conexión`, async (state) => {
    // Dispositivo propio: el de (f) quedó deshabilitado y ya no puede abrir sesión nueva.
    const uniqueId = `rt-ventana-${suffix}-${Math.random().toString(16).slice(2)}`;
    const device = await traccar.createDevice({ name: `Ventana ${suffix}`, uniqueId });
    createdDevices.push(device.id);

    const conexion = openOsmAndConnection();
    await conexion.listo;

    // 1. Habilitado por esta conexión: se crea la sesión cacheada.
    const abierta = await conexion.reportar(uniqueId, { lat: -33.1000, lon: -60.1000 });

    // 2. Deshabilitar. La conexión sigue viva: el reporte entra (la ventana de (f2)).
    await traccar.disableDevice(device.id);
    const enVentana = await conexion.reportar(uniqueId, { lat: -33.2000, lon: -60.2000 });
    const llegoEnVentana = await hasPosition(device.id, -33.2000, -60.2000, 5000);

    // 3. Esperar más que el timeout de inactividad. IdleStateHandler dispara, MainEventHandler
    //    cierra el canal y deviceDisconnected borra la sesión cacheada.
    await new Promise((resolve) => setTimeout(resolve, (OSMAND_TIMEOUT_S + 3) * 1000));
    const cerroSola = conexion.cerrada;
    const trasTimeout = await conexion.reportar(uniqueId, { lat: -33.3000, lon: -60.3000 });

    // 4. Conexión nueva tras el cierre: el gate de `disabled` vuelve a aplicarse.
    const lat = -33.4000;
    const lon = -60.4000;
    const nueva = await osmAndReport(uniqueId, { lat, lon });
    const llegoTrasCierre = await hasPosition(device.id, lat, lon, 3000);

    conexion.cerrar();

    state.detail = [
      `conexión NUEVA con el dispositivo habilitado → ${describirReporte(abierta)}`,
      `deshabilitado, misma conexión → ${describirReporte(enVentana)}; posición ${llegoEnVentana ? 'ALMACENADA (ventana abierta)' : 'no almacenada'}`,
      `tras esperar ${OSMAND_TIMEOUT_S + 3} s (> osmand.timeout = ${OSMAND_TIMEOUT_S} s) → conexión ${cerroSola ? 'CERRADA por el servidor' : 'todavía abierta'}; reporte por ella → ${describirReporte(trasTimeout)}`,
      `conexión NUEVA tras el cierre → ${describirReporte(nueva)}; GET /api/positions → ${llegoTrasCierre ? 'LLEGA (mal)' : 'no llega'} (${lat},${lon})`,
    ].join('\n      → ');

    assert(abierta.status === 200, `la conexión habilitada devolvió ${describirReporte(abierta)}`);
    assert(cerroSola || trasTimeout.cerrada, 'la conexión no se cerró al expirar osmand.timeout: la ventana no está acotada');
    assert(nueva.cerrada, `tras el cierre, una conexión nueva debía ser rechazada: devolvió ${describirReporte(nueva)}`);
    assert(!llegoTrasCierre, 'la posición se almacenó después de expirado el timeout');
  });

  await check('(i) experimento: dos dispositivos distintos por la MISMA conexión keep-alive', async (state) => {
    // No afirma nada sobre el diseño: documenta a qué dispositivo se atribuye cada
    // posición cuando dos uniqueIds comparten conexión. Lo decide el mapa
    // ConnectionManager.sessionsByEndpoint (ConnectionKey → uniqueId → DeviceSession),
    // y el Plan 2 necesita saber si un cliente puede "prestar" su conexión a otro.
    const uidA = `rt-multi-a-${suffix}-${Math.random().toString(16).slice(2)}`;
    const uidB = `rt-multi-b-${suffix}-${Math.random().toString(16).slice(2)}`;
    const devA = await traccar.createDevice({ name: `Multi A ${suffix}`, uniqueId: uidA });
    const devB = await traccar.createDevice({ name: `Multi B ${suffix}`, uniqueId: uidB });
    createdDevices.push(devA.id, devB.id);

    const conexion = openOsmAndConnection();
    await conexion.listo;
    const rA = await conexion.reportar(uidA, { lat: -40.1000, lon: -65.1000 });
    const rB = await conexion.reportar(uidB, { lat: -41.2000, lon: -66.2000 });
    const rA2 = await conexion.reportar(uidA, { lat: -40.3000, lon: -65.3000 });
    conexion.cerrar();

    const enA = await historial(devA.id);
    const enB = await historial(devB.id);
    const resumen = (posiciones) => JSON.stringify(posiciones.map((p) => [p.latitude, p.longitude]));

    state.detail = [
      `una sola conexión keep-alive reporta ${uidA}, después ${uidB}, después ${uidA} otra vez`,
      `reportes → A ${describirReporte(rA)}, B ${describirReporte(rB)}, A ${describirReporte(rA2)}`,
      `dispositivo A (id ${devA.id}) → ${resumen(enA)}`,
      `dispositivo B (id ${devB.id}) → ${resumen(enB)}`,
    ].join('\n      → ');

    assert(rA.status === 200 && rB.status === 200 && rA2.status === 200, 'algún reporte de la conexión compartida fue rechazado');
    // Lo que sí se puede afirmar: cada posición cae en el dispositivo cuyo `id` la mandó.
    assert(
      contiene(enA, -40.10, -65.10) && contiene(enA, -40.30, -65.30),
      `la atribución a A falló: ${resumen(enA)}`,
    );
    assert(contiene(enB, -41.20, -66.20), `la atribución a B falló: ${resumen(enB)}`);
    assert(
      !contiene(enA, -41.20, -66.20) && !contiene(enB, -40.10, -65.10),
      'una posición se atribuyó al dispositivo equivocado',
    );
    observaciones.push(
      'Atribución por conexión compartida: con dos uniqueIds sobre una misma conexión TCP, cada posición '
      + 'se atribuye por el `id` del reporte, no por la conexión (ConnectionManager.sessionsByEndpoint indexa '
      + 'ConnectionKey → uniqueId → DeviceSession). Consecuencia para el Plan 2: un cliente puede reportar por '
      + 'un único canal en nombre de varios dispositivos; la conexión no identifica al dispositivo, el uniqueId sí.',
    );
  });

  // --- Limpieza -----------------------------------------------------------------------
  conexionEnrolada?.cerrar();
  // Orden: primero dispositivos, después usuarios. La FK de tc_user_device es ON DELETE
  // CASCADE, así que borrar el dispositivo ya desvincula a los usuarios; se borra el
  // dispositivo antes que el usuario por claridad (el vínculo cae con cualquiera de los dos).
  for (const id of createdDevices) {
    await traccar.deleteDevice(id).catch(() => {});
  }
  if (admin) {
    for (const id of createdDevicesByAdmin) {
      await admin.deleteDevice(id).catch(() => {});
    }
  }
  for (const id of created) {
    await traccar.deleteUser(id).catch(() => {});
  }
  if (admin) {
    for (const id of createdByAdmin) {
      await admin.deleteUser(id).catch(() => {});
    }
  }

  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) {
    console.log(`${c.ok ? 'OK   ' : 'FALLA'}  ${c.name}`);
    if (c.detail) {
      console.log(`      → ${c.detail}`);
    }
    if (!c.ok) {
      console.log(`      motivo: ${c.error}`);
    }
  }
  for (const o of observaciones) {
    console.log(`\nOBSERVACIÓN (no hace fallar el smoke)\n  ${o}`);
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
