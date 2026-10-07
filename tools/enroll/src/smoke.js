import { createTraccarClient, TraccarError } from './traccar.js';

const SERVICE_EMAIL = process.env.SMOKE_SERVICE_EMAIL;
const SERVICE_PASSWORD = process.env.SMOKE_SERVICE_PASSWORD;
// La cuenta administradora del contenedor descartable. Solo se usa para crear un
// usuario que el manager NO creó: sin ella no se puede verificar la frontera entre
// "mis usuarios" y "los demás", que es la que sostiene la suplantación.
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.SMOKE_ADMIN_PASSWORD;
const BASE_URL = process.env.SMOKE_TRACCAR_URL || 'http://127.0.0.1:18082';
const EXPECTED_VERSION = process.env.SMOKE_EXPECTED_VERSION || '6.15.3';
const TOKEN_DAYS = 45;

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
function assertLocalHost(url) {
  const { hostname } = new URL(url);
  const local = ['127.0.0.1', 'localhost', '::1', '0.0.0.0'];
  assert(
    local.includes(hostname),
    `SMOKE_TRACCAR_URL debe apuntar a un Traccar descartable local, no a ${hostname}`,
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
  let issuedToken = null;

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
    state.detail = `POST /api/session (login) → id ${me.id}, administrator ${me.administrator}, userLimit ${me.userLimit}`;
    assert(me.administrator === false, 'la cuenta de servicio no debe ser administradora');
    assert(me.userLimit !== 0, 'la cuenta de servicio debe tener userLimit distinto de 0');
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
      ADMIN_EMAIL && ADMIN_PASSWORD,
      'faltan SMOKE_ADMIN_EMAIL y SMOKE_ADMIN_PASSWORD: sin la cuenta administradora no se puede crear un usuario ajeno al manager',
    );
    const admin = createTraccarClient({
      baseUrl: BASE_URL,
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });

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

  for (const id of created) {
    await traccar.deleteUser(id).catch(() => {});
  }
  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    const admin = createTraccarClient({
      baseUrl: BASE_URL,
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
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
