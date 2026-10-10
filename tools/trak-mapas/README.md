# trak-mapas

Servicio de recorte de **zonas offline** (archivos `.pmtiles`) para RudaTrak. Dado un
`bbox` + rango de zoom, estima el tamaño con `pmtiles extract --dry-run` y lanza
extracciones asíncronas (una a la vez) sobre el archivo base de Sudamérica continental.

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
| `GET`  | `/maps/version` | `200 { ok, baseVersion }`: identidad del base en servicio. La app la usa para marcar "Base anterior" en zonas descargadas de un base viejo. |
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
  "maxZoom": 15
}
```

- `minLng`/`maxLng` en `[-180, 180]`, `minLat`/`maxLat` en `[-90, 90]`, con `min < max`.
- `minZoom`/`maxZoom` enteros en `[0, 15]`, con `minZoom <= maxZoom`.

### Respuestas

- `estimate` → `200 { ok, tiles, bytes, maxBytes, baseVersion, ... }` o `413 { ok:false, bytes, maxBytes, baseVersion }`.
- `extract` → `202 { ok, jobId, tiles, bytes, baseVersion }`, `413` (zona gigante) o `429` + `Retry-After`.
- `job` → `200 { ok, job: { id, status, tiles, bytes, baseVersion, error, ... } }`.
- `download` → `200` (stream binario) o `409`/`410`/`404`.
- `version` → `200 { ok, baseVersion }`.

### `baseVersion` (identidad del base)

`baseVersion` es `BASE_VERSION`: por defecto `<archivo>:<tamaño>` calculado al arrancar
(p. ej. `sudamerica-20261003-z15-v2.pmtiles:8647255196`). La app lo guarda al descargar
una zona (`buildVersion`) y lo compara contra `GET /maps/version` para marcar
"Base anterior" cuando la zona salió de otro base, aunque su zoom ya sea el vigente.

No se usa el `mtime` a propósito: cambiaría con cualquier copia o `rsync` del mismo
contenido y marcaría todas las zonas como desactualizadas. Tampoco sirve el metadato
`planetiler:osm:osmosisreplicationtime` del PMTiles: se copia del build original y no
cambia al recortar la misma región con otro bbox.

`BASE_VERSION` es un override **excepcional** (ver `.env.example`): fijarlo a mano y
olvidar actualizarlo al cambiar de base deja todas las zonas mal etiquetadas. El
`docker-compose.yml` no le da valor por defecto.

### `/maps/base` (mapa propio online)

Sirve el archivo base `BASE_PMTILES` (el mismo que usa el recorte) para que el frontend
lo consuma como PMTiles online con `Authorization: Bearer`. La ruta es **fija**
(`path.basename(BASE_PMTILES)` + `root: dirname(BASE_PMTILES)`): ningún input del cliente
entra en la ruta de archivo.

- **Auth:** el token se valida con el mismo mecanismo (caché de 5 min) que el resto de
  los endpoints; sin token o con token inválido devuelve `401`.
- **Rate limit por IP real:** `RATE_LIMIT_TILES` con `429` + `Retry-After`. La IP se
  deduce de `CF-Connecting-IP` (preferido) o de `X-Forwarded-For` **solo si** el socket
  viene de una red en `TRUSTED_PROXY_CIDRS`; fuera de ella se usa la IP del socket. Del
  `X-Forwarded-For` se toma la entrada **más a la derecha que no sea un proxy de
  confianza** (nunca la de más a la izquierda), para que un valor falso antepuesto no
  cambie el contador.
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
- **Logs sin tokens:** nunca se loguea la cabecera `Authorization` ni el token. Cada
  `429` se loguea con su clave (IP o usuario, nunca el token) para diagnóstico.

## Variables de entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `PORT` | `3006` | Puerto HTTP. |
| `PMTILES_BIN` | `pmtiles` | Ruta al binario `go-pmtiles`. |
| `BASE_PMTILES` | `/data/maps/base.pmtiles` | Archivo base (fuente del recorte). |
| `BASE_VERSION` | `<archivo>:<tamaño>` del base, calculado al arrancar | Identidad del base, publicada en `GET /maps/version`. Override excepcional: si se fija a mano y se olvida actualizarla, las zonas quedan mal etiquetadas. |
| `OUTPUT_DIR` | `/data/output` | Directorio de zonas extraídas. |
| `TRACCAR_URL` | `http://rudatrak:8082` | Base URL de Traccar para validar tokens. |
| `TOKEN_CACHE_TTL_MS` | `300000` | TTL de la caché de tokens (5 min). |
| `MAX_ZONE_BYTES` | `314572800` | Tope de tamaño por zona (300 MiB). |
| `MAX_ZOOM` | `15` | Tope de zoom de las extracciones (`[0, MAX_ZOOM]`). Bajar a `14` para volver al base z14 sin tocar el código. |
| `JOB_TIMEOUT_MS` | `1800000` | Timeout por extracción (30 min). |
| `ESTIMATE_TIMEOUT_MS` | `60000` | Timeout del `--dry-run`. |
| `CLEANUP_INTERVAL_MS` | `600000` | Intervalo de limpieza (10 min). |
| `OUTPUT_RETENTION_MS` | `3600000` | Retención de zonas terminadas (1 h). |
| `AUTH_TIMEOUT_MS` | `5000` | Timeout de la validación de token contra Traccar. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Ventana del rate limit (1 min). |
| `RATE_LIMIT_ESTIMATE` | `30` | Máximo de `estimate` por usuario por minuto. |
| `RATE_LIMIT_EXTRACT` | `5` | Máximo de `extract` por usuario por minuto. |
| `RATE_LIMIT_TILES` | `3000` | Máximo de pedidos de `GET/HEAD /maps/base` por IP real por minuto. |
| `MAX_RANGE_BYTES` | `4194304` | Tope de bytes por rango en `/maps/base` (4 MiB). |
| `MAX_CONCURRENT_STREAMS` | `32` | Tope de streams concurrentes por IP y por usuario en `/maps/base`. |
| `TRUSTED_PROXY_CIDRS` | `10.0.0.0/8,172.16.0.0/12,192.168.0.0/16` (en Docker, desde `.env`) | Redes desde las que se confía en `X-Forwarded-For`/`CF-Connecting-IP`. |
| `RETRY_AFTER_SECONDS` | `15` | `Retry-After` para `429` (extracción en curso). |

### Red del proxy (IP real del cliente)

Para deducir la IP real, el servicio confía en `CF-Connecting-IP` o `X-Forwarded-For`
**solo si** el socket viene de una red en `TRUSTED_PROXY_CIDRS`. En Docker esa variable
se toma de `.env` (copiá `.env.example` a `.env`; `.env` está ignorado por git).

Para averiguar la subred exacta de la red Docker de NPM:

```bash
docker network inspect npm_proxy-network \
  --format '{{range .IPAM.Config}}{{.Subnet}}{{println}}{{end}}'
```

Usar esa subred concreta (p. ej. `172.18.0.0/16`) en `.env` es más estricto que las
redes privadas por defecto. **Nunca usar `0.0.0.0/0`**: confiaría en cualquier header
falseado. Fuera de la red de confianza se usa la IP del socket, y del
`X-Forwarded-For` se toma la entrada más a la derecha que no sea de confianza.

## Build y ejecución

```bash
# Build (multi-arch amd64/arm64, descarga go-pmtiles v1.31.2)
docker build -t trak-mapas:latest .

# Prueba local (sin Docker): node server.js con el binario y el archivo base locales
PMTILES_BIN=/ruta/pmtiles \
BASE_PMTILES=/ruta/sudamerica-20261003-z15-v2.pmtiles \
OUTPUT_DIR=/tmp/trak-mapas-output \
TRACCAR_URL=https://mh.rudatrak.com \
node server.js
```

## Archivo base y regeneración

El recorte parte de un único archivo base `BASE_PMTILES`. El base en servicio es
**`sudamerica-20261003-z15-v2.pmtiles`**: Sudamérica continental (z0–15) recortada del build
diario de Protomaps (Planetiler).

`pmtiles extract` acepta la zona de dos formas: `--bbox=minLon,minLat,maxLon,maxLat`
(rectángulo) o `--region archivo.geojson` (polígonos). **La región recomendada y en uso es
el rectángulo** (ver "Por qué un bbox y no un polígono"); los geojson de las dos variantes
quedan archivados en `regiones/` por si hay que auditar o volver atrás.

### Cómo se construye la región

**Región histórica (bases z14 y z15 en servicio).** Se armó con
`regiones/sudamerica-continental_50m_buffer25km.geojson`, generado por
`estimate_variants.mjs` (variante C): los polígonos de **Natural Earth 50m**
(`admin_0_countries`) de los 12 países continentales (AR/CL/UY/PY/BO/BR/PE/EC/CO/VE/GY/SR),
cada anillo densificado a 2 km y desplazado ~25 km con un *offset* por bisectriz
("miter") en EPSG:3857. **Sin unión previa:** cada anillo se desplaza por separado y el
resultado no se repara (no hay eliminación de auto-intersecciones ni `unary_union`).

Ese geojson **tiene un defecto medido** (no es la simplificación ni el sistema de unidades:
el desplazamiento sí era métrico en 3857 — la verificación da ~25 km de mar incluidos y
nada a 50 km):

- Donde la costa es intrincada (desembocaduras, deltas, lagunas, golfos, fiordos) el anillo
  desplazado se pliega sobre sí mismo. El extractor rellena el interior con el criterio
  par-impar (`planar.MultiPolygonContains`, paridad por anillo), así que **los lóbulos
  plegados se cancelan y quedan huecos**.
- Medición geométrica (¿cae la tesela entera dentro de la región?): de 19 puntos costeros y
  de fiordos de referencia, **2 quedan afuera** (Puerto Natales y la bahía de Natales); de
  604 teselas z12–z15 del build público tomadas sobre costas de 10 países, **42 (7,0 %)
  quedan afuera** — todas en el seno Otway, el seno Última Esperanza, las bocas del
  Amazonas, Lagoa dos Patos, el golfo de Urabá, el delta del Magdalena, el lago de
  Maracaibo, el golfo de Paria, el golfo de Cariaco, los estuarios del Demerara y del
  Surinam. En la tierra, sobre 48.000 puntos aleatorios (4.000 por país), queda afuera el
  **0,31 %** (Chile 90, Venezuela 20, Guyana 19, Ecuador 13).
- Medición sobre el archivo (¿está la tesela en el `.pmtiles`?): de las **596** teselas
  z12–z15 que existen en el build público (se consultan 604; 8 no existen), el base en
  servicio contiene **574 (96,3 %)** y le faltan **22**: seno Última Esperanza (4, una por
  zoom), golfo de Urabá (3), lago de Maracaibo (2), golfo de Cariaco (2), golfo de Paria
  (4), estuarios del Demerara (4) y del Surinam (2), y una en el Orinoco. El criterio
  geométrico sobreestima el hueco: una tesela que sólo roza la región igual entra al
  archivo. En la ventana de Puerto Natales y el seno Última Esperanza
  (`[-73,2 -52,3 -72,0 -51,3]`) el base en servicio tiene 11.939 de las 16.280 teselas z15
  (**falta el 26,7 %**), 3.192 de 4.200 en z14, 853 de 1.064 en z13 y 229 de 266 en z12.
- Consecuencia visible: el hueco gris de Puerto Natales y de los fiordos al navegar sin
  conexión.

**Región recomendada (base nuevo).** Rectángulo continental con margen:

```
--bbox=-82,-56.5,-34,13
```

Cubre los 12 países continentales más el margen de ~25 km de mar, las Malvinas, Georgias del
Sur y el archipiélago de Tierra del Fuego. Deja afuera las islas de ultramar (Pascua,
Galápagos, Juan Fernández, Fernando de Noronha). Costo sobre el base actual: **+1,2 %**
(8,6 GB vs 8,5 GB) y ~+5–6 % por zona de teléfono; en el build público **19.698.878 vs
43.454.894 teselas de región, pero 12.920.472 vs 13.479.113 entradas con datos** (el océano
vacío no cuesta bytes).

**Alternativa con forma de polígono.** Si en el futuro se quiere una región que no sea un
rectángulo, `region_v2.mjs` la construye sin dependencias: **tierra ∪ cinturón de 25 km**,
donde la tierra son los anillos de **Natural Earth 10m** copiados tal cual (sin simplificar,
sin desplazar, con sus huecos) y el cinturón es la unión de un rectángulo por arista más un
cuadrado por vértice, con el semiancho corregido por latitud (`sec φ`) para que los 25 km
sean distancia real sobre el terreno. La unión la hace el extractor (los solapes se suman,
no se cancelan). Garantía: la región ⊇ la tierra (el cinturón **nunca** reduce superficie)
y ⊇ todo punto a ≤ 25 km del borde. Resultado: 95.594 polígonos, 22,7 MB de geojson,
`regiones/sudamerica-continental_10m_cinturon25km_v2.geojson`. Verificado: **0 de 48.000
puntos de tierra afuera y 0 de 604 teselas públicas afuera**. Contra: 12 min 42 s de CPU en
el recorte (por los 95.594 polígonos que tiene que evaluar el relleno del interior) contra
1 min 5 s del bbox, y un archivo construido y mantenido a mano.

### Base del bbox ya generado (2026-10-04)

```
sudamerica-20261003-z15-v2.pmtiles    8.647.255.196 bytes (8,6 GB; 8,05 GiB)
sha256  99d6949ab13fe379403852bd8fe4cd500dad16cc5084ecc06b141cb68f80eca8
minzoom 0 / maxzoom 15 — bounds (-82, -56.5) (-34, 13) — clustered, mvt, gzip
addressed tiles 43.454.894 — tile entries 13.479.113 — tile contents 11.198.847
build público 20261003 (planetiler 0.10.2, osmosisreplicationtime 2026-10-03T04:00:00Z)
```

`pmtiles verify` → `Completed verify in 1.387s`, sin errores. Extracción: 14 min 20 s con
8 hilos de descarga, 66 requests, 9,0 GB transferidos (overfetch 0,05).

Verificado **sobre el archivo generado**: las 16 ciudades de referencia (Buenos Aires,
Santiago, Montevideo, Asunción, La Paz, Brasilia, Manaus, Río de Janeiro, Lima, Quito,
Bogotá, Caracas, Georgetown, Paramaribo, Punta Arenas, Ushuaia) **más Puerto Natales**
tienen teselas con datos en z12, z13, z14 y z15 (6–8 capas vectoriales cada una), los 20
puntos costeros y de fiordos son `ok` en los cuatro zooms, y las 596 teselas del muestreo
público están **las 596** (el base viejo tenía 574).

Scripts de verificación sobre el archivo (en `/mnt/Datos/tmp-pmtiles/`):

```bash
node verificar-base.mjs     # 16 ciudades + Puerto Natales + 20 puntos costeros + 596 teselas
                            # contra el archivo generado, y comparación con el base viejo
node agujero-viejo.mjs      # ventana de Puerto Natales/Seno Última Esperanza: qué teselas
                            # tiene el nuevo y no el viejo
```

### Verificación de la región

Con el build público del día (`https://build.protomaps.com/YYYYMMDD.pmtiles`, que soporta
HTTP Range) y la librería `pmtiles` del frontend. Scripts en `/mnt/Datos/tmp-pmtiles/`:

```bash
node validar-regiones.mjs    # 19 puntos costeros + 4 transectas + 604 teselas z12-z15
                             # repartidas por las costas de 10 países (existentes en el
                             # build público) contra las 3 regiones
node validar-superficie.mjs  # 48.000 puntos aleatorios dentro de la tierra (4.000 por
                             # país) contra las 3 regiones
```

Criterio de aceptación: **ninguna tesela del build público puede quedar fuera de la región**
(aunque caiga en el agua) y **ningún punto de tierra puede quedar afuera**.

### Regenerar el base

```bash
# 1. Extraer el recorte directamente del build diario de Protomaps (go-pmtiles lee por
#    rango vía HTTP, sin descargar el archivo completo). El nombre usa la fecha del build.
pmtiles extract \
  --bbox=-82,-56.5,-34,13 \
  --maxzoom 15 \
  https://build.protomaps.com/YYYYMMDD.pmtiles \
  sudamerica-YYYYMMDD-z15.pmtiles

# 2. Verificar:
pmtiles verify sudamerica-YYYYMMDD-z15.pmtiles
pmtiles show sudamerica-YYYYMMDD-z15.pmtiles
```

Antes de activar un base nuevo, verificar `sha256sum`, que `pmtiles show` reporte
`minzoom 0 / maxzoom 15` y que haya tiles z12–z15 en las ciudades de referencia (Punta
Arenas, Ushuaia, Puerto Natales, Puerto Montt, Santiago, Lima, Bogotá, Manaus, Quito,
Recife, Salvador, Montevideo). Los scripts de verificación se corren **sobre el archivo
generado**, no solo contra el build público.

> **La extracción no se reanuda.** `pmtiles extract` no tiene `--continue`: si el enlace se
> corta hay que empezar de cero. Además **pre-asigna el archivo de salida** al tamaño final,
> así que un intento fallido deja un archivo *sparse* del tamaño correcto con datos
> incompletos y **sin el magic number** — se ve como "terminado" por tamaño y fecha, pero
> `pmtiles verify` lo rechaza (`magic number not detected`). Comprobar siempre con
> `du` (real) contra `du --apparent-size`, y **borrar el archivo antes de reintentar**. La
> corrida de 8,6 GB son ~14 min a 11 MB/s: conviene correrla dentro de un bucle de
> reintentos que borre la salida en cada vuelta (`correr-bbox.sh` en `/mnt/Datos/tmp-pmtiles/`
> hace 5 intentos), y no dejarla atada a la sesión de shell desde la que se lanzó.

### Cambiar el base activo (sin regenerar)

`BASE_PMTILES` se resuelve desde una variable de entorno con default en el
`docker-compose.yml` (`${BASE_PMTILES:-/data/maps/sudamerica-20261003-z15-v2.pmtiles}`). Para
cambiar a otro base ya construido:

1. Copiar el `.pmtiles` a `/mnt/datos/servicios/rudatrak/trak-mapas/maps/` (en la Pi).
2. En el `.env` de la Pi (junto al compose), setear `BASE_PMTILES=/data/maps/<archivo>.pmtiles`.
3. `docker compose up -d` (recrea el contenedor; no hace falta rebuild).
4. Para volver atrás, cambiar esa línea al base anterior y `docker compose up -d`.
5. `BASE_VERSION` se recalcula sola con el archivo nuevo (nombre y tamaño cambian), así
   que las zonas descargadas del base anterior quedan marcadas como "Base anterior" sin
   intervención. Verificar con `curl -H "Authorization: Bearer <token>" …/maps/version`.

> **Orden de despliegue:** el estilo online "Mapa propio" declara `maxzoom: 15`. Desplegar
> primero el base z15 (pasos 1–3) y recién después el frontend, para no servir un estilo
> que pide tiles z15 contra un base z14 (que solo haría overzoom del z14).

## Deploy en la Pi

1. Copiar el archivo base a `/mnt/datos/servicios/rudatrak/trak-mapas/maps/sudamerica-20261003-z15-v2.pmtiles`.
2. Crear `/mnt/datos/servicios/rudatrak/trak-mapas/output/`.
3. `docker compose up -d --build` (o integrar el servicio en el stack de Portainer).
4. En Nginx Proxy Manager, ruta `mh.rudatrak.com/maps/*` (o un subdominio) → `rudatrak-trak-mapas:3006`.
