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
