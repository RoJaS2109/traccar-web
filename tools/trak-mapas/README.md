# trak-mapas

Servicio de recorte de **zonas offline** (archivos `.pmtiles`) para RudaTrak. Dado un
`bbox` + rango de zoom, estima el tamaño con `pmtiles extract --dry-run` y lanza
extracciones asíncronas (una a la vez) sobre el archivo base de Argentina.

Es un servicio **separado de `carga-poi`** y corre en su propio contenedor. Node 22
nativo + binario `go-pmtiles` pineado (multi-arch amd64/arm64) + la librería `send`
(solo para el streaming de `GET/HEAD /maps/base`: maneja el stream de bytes y la
limpieza ante desconexión de forma probada).

## Endpoints

Todos los endpoints (salvo `/health`) requieren autenticación por token de Traccar:

```
Authorization: Bearer <token>
```

El token se valida contra `GET {TRACCAR_URL}/api/session?token=<token>` y el resultado se
cachea unos minutos. **Fallo cerrado:** solo se autoriza con `200`; `401` (inválido/revocado)
y `400` (token malformado) devuelven `401`, y si Traccar no responde, tarda o devuelve `5xx`,
se devuelve `503`. Cada job se asocia al `userId` que devuelve Traccar: `job` y `download`
de otro usuario devuelven `404`.

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST` | `/maps/zone/estimate` | Estima (síncrono) tiles + bytes vía `--dry-run`. `413` si excede el límite. |
| `POST` | `/maps/zone/extract` | Encola una extracción. `202` + `jobId`. `429` si ya hay una en curso. |
| `GET`  | `/maps/zone/job/:id` | Estado del job (`pending`/`running`/`done`/`failed`). |
| `GET`  | `/maps/zone/download/:id` | Descarga el `.pmtiles` con `Content-Length` (solo si `done`). |
| `GET`  | `/maps/base` | Sirve el archivo base `.pmtiles` por rango. Exige un único `Range: bytes=a-b` (≤ 4 MB). |
| `HEAD` | `/maps/base` | Cabeceras del archivo base, sin body. |
| `GET`  | `/health` | Healthcheck (sin auth). |

### Cuerpo de `estimate` y `extract`

```json
{
  "minLng": -70.0,
  "minLat": -40.0,
  "maxLng": -60.0,
  "maxLat": -30.0,
  "minZoom": 0,
  "maxZoom": 14
}
```

- `minLng`/`maxLng` en `[-180, 180]`, `minLat`/`maxLat` en `[-90, 90]`, con `min < max`.
- `minZoom`/`maxZoom` enteros en `[0, 14]`, con `minZoom <= maxZoom`.

### Respuestas

- `estimate` → `200 { ok, tiles, bytes, maxBytes, ... }` o `413 { ok:false, bytes, maxBytes }`.
- `extract` → `202 { ok, jobId, tiles, bytes }`, `413` (zona gigante) o `429` + `Retry-After`.
- `job` → `200 { ok, job: { id, status, tiles, bytes, error, ... } }`.
- `download` → `200` (stream binario) o `409`/`410`/`404`.

### `/maps/base` (mapa propio online)

Sirve el archivo base `BASE_PMTILES` (el mismo que usa el recorte) para que el frontend
lo consuma como PMTiles online con `Authorization: Bearer`. La ruta es **fija**
(`path.basename(BASE_PMTILES)` + `root: dirname(BASE_PMTILES)`): ningún input del cliente
entra en la ruta de archivo.

- **Auth:** el token se valida con el mismo mecanismo (caché de 5 min) que el resto de
  los endpoints; sin token o con token inválido devuelve `401`.
- **Rate limit por IP real:** `RATE_LIMIT_TILES` con `429` + `Retry-After`. La IP se
  deduce de `CF-Connecting-IP` o `X-Forwarded-For` **solo si** el socket viene de una
  red en `TRUSTED_PROXY_CIDRS`; fuera de ella se usa la IP del socket (un header
  falseado desde fuera del proxy no cambia el contador).
- **Range estricto:** `GET` exige un único `Range: bytes=a-b` dentro del archivo y de
  hasta `MAX_RANGE_BYTES`. Sin Range, multi-range, rango abierto, fuera de rango o
  mayor al tope → `416` con `Content-Range: bytes */<size>` (nunca `200` con el
  archivo completo). `HEAD` devuelve cabeceras sin body y no requiere Range.
- **Streams concurrentes:** tope `MAX_CONCURRENT_STREAMS` por IP y por usuario → `429`.
- **Streaming:** lo maneja `send` con `acceptRanges: true`, `etag: false`,
  `lastModified: false` y `dotfiles: 'deny'`. Sin ETag/Last-Modified no hay
  revalidación condicional, así que jamás se sirve el archivo completo por esa vía.
  Los errores del stream (cliente que corta, archivo inexistente) se manejan en el
  listener `error` sin dejar el socket colgado.

## Límites y seguridad

- **Tope por zona:** `MAX_ZONE_BYTES` (default 300 MB). Zonas mayores se rechazan con `413`.
- **Una extracción a la vez:** un segundo `extract` devuelve `429` + `Retry-After` corto
  (`RETRY_AFTER_SECONDS`, default 15 s).
- **Ownership:** cada job se asocia al `userId` que devuelve Traccar. `GET /job/:id` y
  `GET /download/:id` de otro usuario (o sin job) devuelven `404`.
- **Fallo cerrado en auth:** `200` = válido; `401`/`400` = token inválido/malformado →
  `401`; Traccar caído, lento o `5xx` → `503`. Nunca se autoriza salvo `200`.
- **Rate limit por usuario:** `estimate` y `extract` tienen límites independientes por
  minuto (`RATE_LIMIT_ESTIMATE`, `RATE_LIMIT_EXTRACT`) con `429` + `Retry-After`.
- **Validación estricta:** bbox/zoom numéricos y en rango; el comando se ejecuta con un
  arreglo de argumentos (`spawn`, **sin shell**); el nombre del archivo de salida es un
  `UUID` generado por el servidor (nunca datos del cliente), y los ids de job se validan
  contra el formato UUID. No hay rutas controladas por el cliente.
- **Limpieza de temporales:** al arrancar (borra huérfanos) y periódicamente
  (`CLEANUP_INTERVAL_MS`, retención `OUTPUT_RETENTION_MS`).
- **Timeout por job:** `JOB_TIMEOUT_MS` (default 30 min); al vencer se mata el proceso y
  el job queda `failed` con error `timeout`.
- **Logs sin tokens:** nunca se loguea la cabecera `Authorization` ni el token.

## Variables de entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `PORT` | `3006` | Puerto HTTP. |
| `PMTILES_BIN` | `pmtiles` | Ruta al binario `go-pmtiles`. |
| `BASE_PMTILES` | `/data/maps/base.pmtiles` | Archivo base (fuente del recorte). |
| `OUTPUT_DIR` | `/data/output` | Directorio de zonas extraídas. |
| `TRACCAR_URL` | `http://rudatrak:8082` | Base URL de Traccar para validar tokens. |
| `TOKEN_CACHE_TTL_MS` | `300000` | TTL de la caché de tokens (5 min). |
| `MAX_ZONE_BYTES` | `314572800` | Tope de tamaño por zona (300 MiB). |
| `JOB_TIMEOUT_MS` | `1800000` | Timeout por extracción (30 min). |
| `ESTIMATE_TIMEOUT_MS` | `60000` | Timeout del `--dry-run`. |
| `CLEANUP_INTERVAL_MS` | `600000` | Intervalo de limpieza (10 min). |
| `OUTPUT_RETENTION_MS` | `3600000` | Retención de zonas terminadas (1 h). |
| `AUTH_TIMEOUT_MS` | `5000` | Timeout de la validación de token contra Traccar. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Ventana del rate limit (1 min). |
| `RATE_LIMIT_ESTIMATE` | `30` | Máximo de `estimate` por usuario por minuto. |
| `RATE_LIMIT_EXTRACT` | `5` | Máximo de `extract` por usuario por minuto. |
| `RATE_LIMIT_TILES` | `1000` | Máximo de pedidos de `GET/HEAD /maps/base` por IP por minuto. |
| `MAX_RANGE_BYTES` | `4194304` | Tope de bytes por rango en `/maps/base` (4 MiB). |
| `MAX_CONCURRENT_STREAMS` | `10` | Tope de streams concurrentes por IP/usuario en `/maps/base`. |
| `TRUSTED_PROXY_CIDRS` | `10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8` | Redes desde las que se confía en `X-Forwarded-For`/`CF-Connecting-IP`. |
| `RETRY_AFTER_SECONDS` | `15` | `Retry-After` para `429` (extracción en curso). |

## Build y ejecución

```bash
# Build (multi-arch amd64/arm64, descarga go-pmtiles v1.31.2)
docker build -t trak-mapas:latest .

# Prueba local (sin Docker): node server.js con el binario y el archivo base locales
PMTILES_BIN=/ruta/pmtiles \
BASE_PMTILES=/ruta/argentina-20261002-z14.pmtiles \
OUTPUT_DIR=/tmp/trak-mapas-output \
TRACCAR_URL=https://mh.rudatrak.com \
node server.js
```

## Deploy en la Pi

1. Copiar el archivo base a `/mnt/datos/servicios/rudatrak/trak-mapas/maps/argentina-20261002-z14.pmtiles`.
2. Crear `/mnt/datos/servicios/rudatrak/trak-mapas/output/`.
3. `docker compose up -d --build` (o integrar el servicio en el stack de Portainer).
4. En Nginx Proxy Manager, ruta `mh.rudatrak.com/maps/*` (o un subdominio) → `rudatrak-trak-mapas:3006`.
