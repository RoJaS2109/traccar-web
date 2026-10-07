// Ojo: este archivo NO termina en .test.js a propósito. El runner de Node ejecuta
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
