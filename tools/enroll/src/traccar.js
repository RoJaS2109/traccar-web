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
 * `POST /api/session/token` es un recurso @Produces(APPLICATION_JSON) que devuelve un
 * String, así que el cuerpo puede llegar entre comillas dobles (`"eyJ…"`) o pelado.
 * Verificado contra Traccar 6.15.3 en la Tarea 4: el cuerpo empieza en 0x52 y termina en
 * 0x51 (sin comillas), con Content-Type application/json. Igual se toleran ambas formas:
 * cuesta una comparación y evita un token corrupto que fallaría recién en el primer uso.
 * El frontend tiene el mismo normalizador en src/offline/tokenStore.js.
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

/**
 * ISO 8601 completo, no `YYYY-MM-DD`. Jersey convierte el @FormParam Date con un
 * SimpleDateFormat que no entiende la fecha pelada: manda ParamException$FormParamException
 * y la emisión falla con 400. Verificado contra Traccar 6.15.3 en la Tarea 4; es el mismo
 * formato que usa el frontend (`dayjs(...).toISOString()`, PreferencesPage.jsx:84).
 */
function formatExpiration(date) {
  return new Date(date).toISOString();
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
    let payload;
    if (json !== undefined) {
      payload = JSON.stringify(json);
      headers['Content-Type'] = 'application/json';
    } else if (body !== undefined) {
      // Formulario, como en `send`: algunos recursos de Traccar (@FormParam) no
      // aceptan JSON. Sin esta rama, `body` se descartaba en silencio.
      payload = new URLSearchParams(body).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
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

    /**
     * El usuario de la cuenta de servicio, para verificar sus permisos.
     *
     * Es un login, no un GET de la sesión: `GET /api/session` está anotado @PermitAll y
     * solo mira el atributo USER_ID de la HttpSession, que con Basic Auth no existe — por
     * eso responde 404 (SessionResource:104). `POST /api/session` devuelve el User con
     * Columns.All(), incluidos `administrator` y `userLimit`.
     *
     * Va sin Authorization, como el login de la app: así el filtro no arma un contexto
     * aparte y la respuesta es inequívocamente la de estas credenciales.
     */
    async whoAmI() {
      const response = await send('/api/session', {
        method: 'POST',
        body: { email, password },
      });
      await expectOk(response, 'POST /api/session');
      return response.json();
    },

    /**
     * `administrator: false` se fuerza acá y no se delega en el llamador: este
     * cliente no crea administradores, nunca. Un manager tampoco podría (Traccar
     * lo rechaza), pero así la garantía no depende de que cada llamador se acuerde.
     */
    async createUser(payload) {
      return (await api('/api/users', { method: 'POST', json: { ...payload, administrator: false } })).json();
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

    async createDevice(payload) {
      return (await api('/api/devices', { method: 'POST', json: payload })).json();
    },

    async getDevice(id) {
      return (await api(`/api/devices/${id}`)).json();
    },

    async updateDevice(device) {
      return (await api(`/api/devices/${device.id}`, { method: 'PUT', json: device })).json();
    },

    /**
     * Igual que `disableUser`: manda el objeto completo, no `{ id, disabled: true }`.
     * `PUT /api/devices/{id}` escribe todas las columnas y un parche pisaría los atributos
     * del dispositivo. La desactivación es la revocación del reporte: `Disableable.checkDisabled`
     * hace caer los mensajes de protocolo (OsmAnd incluido) del dispositivo deshabilitado.
     */
    async disableDevice(id) {
      const device = await this.getDevice(id);
      return this.updateDevice({ ...device, disabled: true });
    },

    async deleteDevice(id) {
      await api(`/api/devices/${id}`, { method: 'DELETE' });
    },

    async linkDevice(userId, deviceId) {
      await api('/api/permissions', { method: 'POST', json: { userId, deviceId } });
    },

    async unlinkDevice(userId, deviceId) {
      await api('/api/permissions', { method: 'DELETE', json: { userId, deviceId } });
    },

    async getDevices({ all = false } = {}) {
      return (await api(`/api/devices${all ? '?all=true' : ''}`)).json();
    },

    /**
     * Sin `from`/`to`, `/api/positions` devuelve una sola posición: la última conocida del
     * dispositivo (verificado contra 6.15.3 — tres reportes seguidos devuelven un único
     * elemento). Alcanza para "¿llegó la última?", no para "¿llegaron las dos?".
     */
    async getPositions(deviceId, { from, to } = {}) {
      const params = new URLSearchParams({ deviceId: String(deviceId) });
      if (from) {
        params.set('from', new Date(from).toISOString());
      }
      if (to) {
        params.set('to', new Date(to).toISOString());
      }
      return (await api(`/api/positions?${params}`)).json();
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
