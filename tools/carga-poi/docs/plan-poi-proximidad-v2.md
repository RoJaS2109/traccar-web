# Plan: Detección de proximidad y actualización de POIs en carga-poi (v2)

> **Estado: ✅ IMPLEMENTADO** (julio 2026)
>
> **Diferencias con el plan original:**
> - La descripción se carga **completa** en el textarea (no se parsean entradas individuales). El usuario edita todo el historial libremente.
> - El campo **Autor** se oculta en modo actualizar.
> - El checkbox "Corregir el último comentario" fue **eliminado** — el textarea completo reemplaza la descripción al guardar.
> - `PUT /api/poi` ya no recibe `autor` ni `reemplazarUltima`, solo `comentario` con el texto completo.
>
> Ver documentación actualizada en `CLAUDE.md` del frontend.
>
> **Bugs corregidos (julio 2026):**
> - `server.js:528` — `placemarkActual` no estaba definido. El endpoint `PUT /api/poi` crasheaba con `ReferenceError` y el botón "Actualizar POI" no hacía nada.
> - `index.html:130` — El campo `Autor` tenía `required`, pero en modo actualizar se oculta con `display:none`. El navegador bloqueaba el submit con "An invalid form control is not focusable".

## Contexto

`carga-poi` (servidor Express en `tools/carga-poi/server.js` + formulario HTML en `public/index.html`) solo permite crear (POST) y eliminar (DELETE) POIs en `general.kml`. Se agrega:

1. Al ingresar coordenadas, verificar si hay un POI a ≤30m (Haversine).
2. Si existe → precargar datos en el formulario y permitir actualizar (modo actualizar).
3. Si no existe → flujo normal de creación.
4. En modo eliminar, también buscar por coordenadas (no solo por nombre exacto).
5. Backup automático de `general.kml` antes de cada escritura.

## Decisiones confirmadas

- Múltiples POIs cercanos → mostrar solo el más cercano. Opción explícita "Crear nuevo de todas formas".
- La descripción es un **log de entradas** (`fecha + autor + comentario`), no se reemplaza de raíz.
- Al actualizar: por default se **agrega una entrada nueva** al final del log (autor y comentario se piden de nuevo). Campo Autor queda **vacío**; campo Comentario se **precarga con el texto de la última entrada** para poder editarlo como punto de partida.
- Checkbox **"Corregir el último comentario"** (desmarcado por default): si se marca, en vez de agregar, **reemplaza la última entrada** del log por la versión editada. El resto del historial queda intacto en ambos casos.
- **Backup automático**: antes de cada escritura (POST/PUT/DELETE) se copia `general.kml` a `general.kml.bak-YYYYMMDD-HHMMSS`. Se retienen los últimos 30 backups (se borran los más viejos en cada escritura).
- Modo eliminar: se agrega búsqueda por coordenadas además de por nombre exacto.

## Archivos a modificar

| Archivo | Cambios |
|---|---|
| `tools/carga-poi/server.js` | +3 funciones (`haversine`, `parsearPOIs`, `backupKML`), +2 endpoints (`GET /api/poi/nearby`, `PUT /api/poi`) |
| `tools/carga-poi/public/index.html` | Refactor de estados (3 modos), banner de proximidad, modo actualización con checkbox, eliminar por coordenadas |

## Plan de implementación

**Paso 1 — `haversine()` en server.js**
Fórmula estándar, radio terrestre 6.371.000m. `haversine(lat1, lon1, lat2, lon2) → metros`.

**Paso 2 — `parsearPOIs()` en server.js**
Extrae todos los `<Placemark>` con `/<Placemark>([\s\S]*?)<\/Placemark>/g`. De cada bloque: `<name>`, `<description>` completa, `<styleUrl>`, `<coordinates>` (respetar orden **lon,lat** como están guardadas). Mapea `styleUrl` → `categoriaId`. Aísla la **última entrada** de la descripción con un split por el patrón `&lt;br&gt;&lt;br&gt;\d+ de \w+ de \d{4} por .*?&lt;br&gt;`, para poder devolver solo el último comentario (no hace falta extraer autor histórico). Retorna `{ nombreCompleto, lat, lon, styleUrl, nombre, localidad, categoriaId, ultimoComentario, descripcionCompleta }`.

**Paso 3 — `backupKML()` en server.js**
Antes de cualquier `fs.writeFileSync(KML_PATH, ...)`: copia el archivo actual a `${KML_PATH}.bak-${timestamp}` en el mismo directorio. Lista los backups existentes con ese prefijo, ordena por fecha, borra todos menos los últimos 30. Se llama al inicio del POST, PUT y DELETE existentes/nuevos.

**Paso 4 — Endpoint `GET /api/poi/nearby`**
Query params: `lat`, `lon` (requeridos), `radius` (opcional, default 30). Validación de rango igual que el POST. Llama a `parsearPOIs()`, calcula Haversine contra cada uno, filtra por radio. Response: `{ ok, pois: [...], masCercano: {...} | null }`, ordenado por distancia ascendente. `masCercano` incluye `ultimoComentario` para precargar el form.

**Paso 5 — Endpoint `PUT /api/poi`**
Body: `{ nombreActual, nombre, localidad, coordenadas, categoria, autor, comentario, reemplazarUltima }`. Busca el Placemark por `nombreActual` exacto (misma técnica que DELETE). Llama a `backupKML()`. Regenera `<name>` completo con los datos nuevos. Para la descripción:
- Si `reemplazarUltima` es `false`/ausente → agrega `&lt;br&gt;&lt;br&gt;{fecha} por {autor}&lt;br&gt;{comentario}` al final de la descripción existente.
- Si `reemplazarUltima` es `true` → localiza el último bloque de entrada (mismo split del Paso 2) y lo reemplaza por el nuevo, dejando todo lo anterior intacto.

Reemplaza el Placemark completo en el KML. Errores: 400 (validación), 404 (no encontrado), 409 (duplicado de nombre).

**Paso 6 — Frontend: refactor de estados**
Reemplazar el booleano `modoEliminar` por enum `formMode = { AGREGAR, ACTUALIZAR, ELIMINAR }`. Nuevas variables: `poiActualizar` (nombreActual para el PUT), `ignorarProximidad`. Adaptar el handler de `#modoEliminar` para usar `formMode`. **Probar a fondo el flujo existente de eliminar-por-nombre después del refactor** — es la lógica de mayor riesgo de regresión.

**Paso 7 — Frontend: banner + detección en blur**
HTML: `#nearbyBanner` con texto + link "Crear nuevo de todas formas". CSS: `.modo-actualizar` (borde naranja), análogo a `.modo-eliminar` ya existente. Evento `blur` en `#coordenadas` → parsea coordenadas → `GET /api/poi/nearby?lat=X&lon=Y&radius=30`. Si `masCercano` → `entrarModoActualizar(poi)`. Error → silencioso. `entrarModoActualizar(poi)`: precarga nombre/localidad/categoría/coordenadas; **Autor queda vacío**; **Comentario se precarga con `ultimoComentario`**; muestra checkbox "Corregir el último comentario" (desmarcado); cambia título y muestra banner con el historial completo como referencia de solo lectura.

**Paso 8 — Frontend: submit en modo actualizar**
`if (formMode === MODE.ACTUALIZAR)`: envía `PUT /api/poi` con `nombreActual` + datos del form + `reemplazarUltima` (estado del checkbox). Éxito → `salirModoActualizar(false)`, limpiar, enfocar nombre. Error → mostrar mensaje.

**Paso 9 — Frontend: link "Crear nuevo igual"**
`salirModoActualizar(mantenerDatos)`: `false` limpia todo y vuelve a `MODE.AGREGAR`; `true` mantiene datos y pone `ignorarProximidad = true`. Click en `#nearbyCreateNew` → `salirModoActualizar(true)`.

**Paso 10 — Frontend: eliminar por coordenadas**
`#deleteSearchMethod` con radios (nombre vs coordenadas). En modo eliminar, `#coordenadas` ya no se deshabilita si se elige buscar por coordenadas. Submit con `searchBy === 'coords'`: `GET /api/poi/nearby` → preview → confirmar "ELIMINAR" → `DELETE /api/poi`.

**Paso 11 — Prueba integral**
- `node server.js`, verificar que arranca y crea la carpeta de backups si hace falta.
- `curl` nearby con coordenadas conocidas.
- `curl PUT` con `reemplazarUltima: false` → verificar que se agregó una entrada nueva.
- `curl PUT` con `reemplazarUltima: true` → verificar que se reemplazó solo la última entrada.
- Verificar que se generó el archivo `.bak-*` antes de cada escritura.
- En navegador: crear POI → mismo lugar → detección → actualizar sin checkbox (agrega) → actualizar con checkbox (reemplaza) → verificar KML en cada caso.
- Probar "Crear nuevo igual" → debe crear duplicado.
- Probar eliminar por coordenadas y por nombre (regresión).
- Con más de 30 backups acumulados, verificar que se borran los más viejos.

## Edge cases cubiertos

- KML sin Placemarks: nearby retorna array vacío.
- POI sin coordenadas en el nombre (legacy): parseo devuelve `nombre = nombreCompleto`.
- Descripción legacy con una sola entrada (sin el patrón de log): el split la trata como única entrada, se comporta igual (agregar o reemplazar esa única entrada).
- Servidor caído durante blur: error silencioso, sigue en modo agregar.
- `nombreActual` no encontrado en PUT: 404 con mensaje descriptivo.
- Múltiples coincidencias de nombre: 409, contactar administrador.
- Toggle eliminar estando en modo actualizar: sale limpiamente de actualizar primero.
- Falla el backup (disco lleno, permisos): abortar la escritura y devolver 500 antes de tocar el KML — nunca escribir sin backup exitoso.
- Backups acumulados > 30: se borran los más viejos en cada escritura exitosa.

## Verificación

1. `curl "http://localhost:3007/api/poi/nearby?lat=-31.805&lon=-65.022&radius=30"` → POIs cercanos + `ultimoComentario`.
2. `curl -X PUT .../api/poi -d '{"reemplazarUltima": false, ...}'` → agrega entrada.
3. `curl -X PUT .../api/poi -d '{"reemplazarUltima": true, ...}'` → reemplaza última entrada.
4. Confirmar aparición de `general.kml.bak-*` tras cada escritura.
5. En navegador: los 3 modos (agregar, actualizar, eliminar) en desktop y mobile.
6. Confirmar que el KML resultante abre sin errores en Google Earth / Traccar tras cada operación.
