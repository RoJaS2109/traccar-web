import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTraccarClient, normalizeToken, TraccarError } from '../src/traccar.js';
import { jsonResponse, recordingFetch, parseForm } from './helpers.js';

const CONFIG = {
  baseUrl: 'https://traccar.test',
  email: 'servicio@rudatrak.invalid',
  password: 'contrasena-de-servicio',
};

// `assert.rejects` de node:test resuelve a undefined, no al error: hay que atraparlo.
const capture = (promise) => promise.then(() => null, (error) => error);

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
  // ISO 8601 completo, como `dayjs(...).toISOString()` en el frontend (PreferencesPage.jsx:84).
  // Con 'YYYY-MM-DD' Jersey tira ParamException$FormParamException → 400.
  assert.equal(parseForm(emitir.body).expiration, '2026-11-20T00:00:00.000Z');
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

test('whoAmI inicia sesión y devuelve el usuario autenticado', async () => {
  // No sirve GET /api/session: es @PermitAll y solo lee el atributo USER_ID de la
  // HttpSession, que con Basic Auth no existe. Responde 404 (SessionResource:104).
  // El login sí devuelve el User completo, con administrator y userLimit.
  const { fetch, calls } = recordingFetch(() => jsonResponse({ id: 7, administrator: false, userLimit: 200 }));
  const traccar = createTraccarClient({ ...CONFIG, fetchImpl: fetch });

  const me = await traccar.whoAmI();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://traccar.test/api/session');
  const body = parseForm(calls[0].body);
  assert.equal(body.email, CONFIG.email);
  assert.equal(body.password, CONFIG.password);
  assert.equal(me.userLimit, 200);
  assert.equal(me.administrator, false);
});

test('un error de Traccar se convierte en TraccarError con el estado', async () => {
  const { fetch } = recordingFetch(() => jsonResponse({ message: 'User access denied' }, { status: 403 }));
  const traccar = createTraccarClient({ ...CONFIG, fetchImpl: fetch });

  const error = await capture(traccar.getUser(42));
  assert.ok(error instanceof TraccarError, 'debe ser un TraccarError');
  assert.equal(error.status, 403);
  assert.match(error.message, /403/);
});

test('el error nunca incluye la contraseña de servicio', async () => {
  // Traccar puede devolver el cuerpo de la petición en un mensaje de error.
  const { fetch } = recordingFetch(() => jsonResponse(
    { message: `no se pudo autenticar con ${CONFIG.password}` }, { status: 401 },
  ));
  const traccar = createTraccarClient({ ...CONFIG, fetchImpl: fetch });

  const error = await capture(traccar.getUser(42));
  assert.ok(error instanceof TraccarError, 'debe ser un TraccarError');
  assert.ok(!error.message.includes(CONFIG.password), 'la contraseña no debe aparecer en el error');
  assert.ok(!error.body.includes(CONFIG.password), 'ni en el cuerpo del error');
});

test('una URL base con barra final no genera dobles barras', async () => {
  const { fetch, calls } = recordingFetch(() => jsonResponse({ version: '6.14.5' }));
  const traccar = createTraccarClient({ ...CONFIG, baseUrl: 'https://traccar.test/', fetchImpl: fetch });
  await traccar.serverInfo();
  assert.equal(calls[0].url, 'https://traccar.test/api/server');
});

test('createDevice manda el uniqueId y devuelve el id', async () => {
  const { fetch, calls } = recordingFetch(() => jsonResponse({ id: 55, uniqueId: 'rt-abc' }));
  const traccar = createTraccarClient({ ...CONFIG, fetchImpl: fetch });

  const device = await traccar.createDevice({ name: 'Teléfono de Juan', uniqueId: 'rt-abc' });

  assert.equal(device.id, 55);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://traccar.test/api/devices');
  const payload = JSON.parse(calls[0].body);
  assert.equal(payload.uniqueId, 'rt-abc');
  assert.equal(payload.name, 'Teléfono de Juan');
});

test('getDevice pega en el endpoint del dispositivo', async () => {
  const { fetch, calls } = recordingFetch(() => jsonResponse({ id: 55 }));
  const traccar = createTraccarClient({ ...CONFIG, fetchImpl: fetch });
  await traccar.getDevice(55);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, 'https://traccar.test/api/devices/55');
});

test('updateDevice manda PUT con el dispositivo completo', async () => {
  const { fetch, calls } = recordingFetch(() => jsonResponse({}));
  const traccar = createTraccarClient({ ...CONFIG, fetchImpl: fetch });
  await traccar.updateDevice({ id: 55, name: 'x', uniqueId: 'rt-abc' });
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].url, 'https://traccar.test/api/devices/55');
  assert.equal(JSON.parse(calls[0].body).uniqueId, 'rt-abc');
});

test('disableDevice manda el dispositivo completo con disabled en true', async () => {
  const original = { id: 55, name: 'x', uniqueId: 'rt-abc', disabled: false };
  const { fetch, calls } = recordingFetch((url, init) => (
    init.method === 'PUT' ? jsonResponse({}) : jsonResponse(original)
  ));
  const traccar = createTraccarClient({ ...CONFIG, fetchImpl: fetch });

  await traccar.disableDevice(55);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[1].method, 'PUT');
  const payload = JSON.parse(calls[1].body);
  assert.equal(payload.disabled, true);
  assert.equal(payload.uniqueId, 'rt-abc');
});

test('deleteDevice pega en DELETE del dispositivo', async () => {
  const { fetch, calls } = recordingFetch(() => new Response(null, { status: 204 }));
  const traccar = createTraccarClient({ ...CONFIG, fetchImpl: fetch });
  await traccar.deleteDevice(55);
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(calls[0].url, 'https://traccar.test/api/devices/55');
});

test('linkDevice vincula usuario y dispositivo como JSON', async () => {
  const { fetch, calls } = recordingFetch(() => new Response(null, { status: 204 }));
  const traccar = createTraccarClient({ ...CONFIG, fetchImpl: fetch });
  await traccar.linkDevice(7, 55);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://traccar.test/api/permissions');
  const payload = JSON.parse(calls[0].body);
  assert.equal(payload.userId, 7);
  assert.equal(payload.deviceId, 55);
});

test('unlinkDevice borra el vínculo usuario-dispositivo', async () => {
  const { fetch, calls } = recordingFetch(() => new Response(null, { status: 204 }));
  const traccar = createTraccarClient({ ...CONFIG, fetchImpl: fetch });
  await traccar.unlinkDevice(7, 55);
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(calls[0].url, 'https://traccar.test/api/permissions');
  assert.equal(JSON.parse(calls[0].body).deviceId, 55);
});

test('getDevices lista dispositivos y con all=true los de todos', async () => {
  const { fetch, calls } = recordingFetch(() => jsonResponse([]));
  const traccar = createTraccarClient({ ...CONFIG, fetchImpl: fetch });
  await traccar.getDevices();
  assert.equal(calls[0].url, 'https://traccar.test/api/devices');
  await traccar.getDevices({ all: true });
  assert.equal(calls[1].url, 'https://traccar.test/api/devices?all=true');
});

test('getPositions pide las posiciones del dispositivo', async () => {
  const { fetch, calls } = recordingFetch(() => jsonResponse([]));
  const traccar = createTraccarClient({ ...CONFIG, fetchImpl: fetch });
  await traccar.getPositions(55);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, 'https://traccar.test/api/positions?deviceId=55');
});

test('getPositions con rango pide el historial, no solo la última posición', async () => {
  // Sin `from`/`to`, /api/positions devuelve una sola posición: la última conocida del
  // dispositivo. Alcanza para "¿llegó?", no para "¿llegaron las dos?" — verificado contra
  // 6.15.3, donde tres reportes consecutivos devolvían un único elemento.
  const { fetch, calls } = recordingFetch(() => jsonResponse([]));
  const traccar = createTraccarClient({ ...CONFIG, fetchImpl: fetch });

  await traccar.getPositions(55, {
    from: '2026-10-08T00:00:00.000Z',
    to: '2026-10-08T01:00:00.000Z',
  });

  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/positions');
  assert.equal(url.searchParams.get('deviceId'), '55');
  assert.equal(url.searchParams.get('from'), '2026-10-08T00:00:00.000Z');
  assert.equal(url.searchParams.get('to'), '2026-10-08T01:00:00.000Z');
});

test('getPositions sin rango no agrega parámetros vacíos', async () => {
  const { fetch, calls } = recordingFetch(() => jsonResponse([]));
  const traccar = createTraccarClient({ ...CONFIG, fetchImpl: fetch });
  await traccar.getPositions(55, {});
  assert.ok(!calls[0].url.includes('from='), `from no debe aparecer: ${calls[0].url}`);
  assert.ok(!calls[0].url.includes('to='), `to no debe aparecer: ${calls[0].url}`);
});
