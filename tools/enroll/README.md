# tools/enroll — servicio de enrolamiento

Servicio que decide qué dispositivos pueden conectarse a RudaTrak. Todavía **no es
parte del stack de producción**: por ahora solo existe el cliente de la API de Traccar,
la base local y las herramientas de verificación (Tareas 1 a 4 del plan).

Proyecto Node aparte del frontend: tiene su propio `package.json` y su propio runner
(`node:test`). Por eso `vitest.config.js` lo excluye — si no, el `npm test` de la raíz
lo colecta y falla con "No test suite found".

## Comandos

```bash
npm test           # node --test (descubre test/**/*.test.js)
npm run smoke      # verificación contra un Traccar descartable — ver abajo
```

`npm test` sin argumentos: en Node 22.23 `node --test test/` resuelve el directorio
como módulo y falla con `MODULE_NOT_FOUND`.

## Smoke

Verificación contra un **Traccar real y descartable**, para comprobar lo que los tests
con `fetch` falso no pueden: que Traccar acepte las peticiones que el cliente arma.

**Última corrida: 2026-10-08 — 23/23 verificaciones OK** contra `traccar/traccar:6.15.3`,
la misma versión que producción (`GET https://mh.rudatrak.com/api/server` → `6.15.3`).
El plan decía 6.14.5, pero el Dockerfile del frontend usa `traccar/traccar:latest` sin
pinear, así que la versión desplegada es otra.

El descartable corre con **`SERVER_BUFFERING_THRESHOLD=0`** y **`OSMAND_TIMEOUT=10`**
(ver `docker-compose.smoke.yml`). Las dos existen para que el smoke mida lo que dice
medir; sin ellas da falsos negativos — ver *"La ventana de revocación"*.

### Cómo se corre

```bash
cd tools/enroll
# Docker Compose v2 como plugin no está instalado en la máquina de desarrollo:
# se usa el binario /usr/local/bin/docker-compose (v2.28.1).
/usr/local/bin/docker-compose -f docker-compose.smoke.yml up -d

# La base arranca vacía. Se crean dos cuentas por la API (no por la interfaz web):
# la primera, sin autenticar, queda como administradora (UserUtil.isEmpty); la segunda
# la crea el administrador con userLimit 200 y administrator false. Las credenciales
# son aleatorias y viven en .env (gitignoreado), nunca se imprimen.

set -a && . ./.env && set +a && npm run smoke

/usr/local/bin/docker-compose -f docker-compose.smoke.yml down -v
docker volume ls | grep smoke     # no debe quedar nada
```

El script **se niega a correr contra cualquier host que no sea local**: aborta de
inmediato con `SMOKE_TRACCAR_URL debe apuntar a un Traccar descartable local, no a
mh.rudatrak.com`. Esa comprobación es la garantía de que el smoke no puede tocar
producción — y el smoke crea usuarios, emite tokens y deshabilita cuentas.

### Resultados

| # | Verificación | Resultado |
|---|--------------|-----------|
| 1 | La versión del servidor coincide con la de producción | OK — `6.15.3` |
| 2 | La cuenta de servicio NO es administradora y es manager | OK — `id 2, administrator false, userLimit 200` |
| 3 | Crear un usuario con permisos mínimos | OK — los 4 flags quedan en `true` al releerlo |
| 4 | Un manager NO puede fijar `deviceLimit` | OK — rechazado: `Administrator access required` |
| 5 | Suplantar y emitir un token para el usuario nuevo | OK — el token es del usuario nuevo (`admin false`), no de la cuenta de servicio |
| 6 | El manager suplanta a un usuario que creó y NO a uno que no creó | OK — propio: token emitido; ajeno: `User access denied` |
| 7 | Revocar el token emitido | OK — `GET /api/session?token=` pasa a 401 |
| 8 | Deshabilitar al usuario invalida todos sus tokens | OK — un token ya emitido pasa a 401 |
| 9 | Deshabilitar no borra los permisos del usuario | OK — los 4 flags siguen en `true` |
| 10 | El usuario deshabilitado puede volver a habilitarse | OK |
| 11 | ¿Un usuario con permisos mínimos puede crear un dispositivo? | **OBSERVACIÓN** — no |
| (a) | El manager crea un dispositivo con `uniqueId` aleatorio | OK |
| (b) | El manager vincula el dispositivo al usuario enrolado | OK — el usuario pasa a verlo |
| (c) | El usuario enrolado ve **exactamente** su dispositivo y ningún otro | OK — ve `[14]`, no el ajeno `15` |
| (d) | El usuario enrolado no puede modificar ni borrar su dispositivo | OK — `Write access denied` en ambos |
| (e) | El manager no ve ni modifica un dispositivo del administrador | OK — `Device access denied` |
| (f1) | El dispositivo habilitado reporta por una conexión nueva | OK — `200`, posición almacenada |
| (f2) | Deshabilitado: la conexión **ya establecida** sigue reportando | OK — **mide la ventana**, ver abajo |
| (f3) | Deshabilitado: una conexión **nueva** es rechazada | OK — conexión cerrada, posición no almacenada |
| (f4) | Un `uniqueId` desconocido no crea dispositivo | OK — `400`, no aparece en `/api/devices?all=true` |
| (g) | Compensación: qué queda creado y cómo se borra | OK — inventario + limpieza |
| (h) | La ventana se acota: a los 10 s el servidor cierra la conexión | OK — cerrada; el reporte siguiente se rechaza |
| (i) | Dos dispositivos por la **misma** conexión keep-alive | OK — cada posición cae en el dispositivo que la mandó |

Salida de las tres que deciden el diseño:

```
OK     suplantar y emitir un token para el usuario nuevo
      → token: 187 caracteres, sin comillas, solo [A-Za-z0-9._-], termina en …wIn0
      → GET /api/session?token= → 200, id 12 (el usuario nuevo, no la cuenta de servicio), administrator false
      → GET /api/devices con Bearer → 200
OK     el manager suplanta a un usuario que creó y NO a uno que no creó
      → usuario propio (id 12, creado por el manager) → token emitido (188 caracteres, sin comillas, solo [A-Za-z0-9._-], termina en …MCJ9)
      → usuario ajeno (id 13, creado por el administrador) → 400, java.lang.SecurityException: User access denied
OK     deshabilitar no borra los permisos del usuario
      → PUT /api/users/12 con el objeto completo → disabled true, readonly true, deviceReadonly true, limitCommands true, disableReports true
```

### La observación que decide el Plan 2

Texto exacto de la salida:

```
OBSERVACIÓN (no hace fallar el smoke)
  Un usuario con permisos mínimos NO puede crear dispositivos (400). El Plan 2 tiene que
  resolverlo: o el servicio crea el dispositivo al aprobar, o los usuarios enrolados
  llevan otro juego de permisos.
```

Evidencia cruda: `POST /api/devices` con el token del usuario devuelve
`400 java.lang.SecurityException: Write access denied`, lanzado en
`PermissionsService.checkEdit`. Es lo que el código dice: `checkEdit` evalúa
`server.deviceReadonly || user.deviceReadonly || (addition && deviceLimit == 0)` antes de
mirar `deviceLimit`, así que `readonly` + `deviceReadonly` alcanzan para prohibirlo.

**Consecuencia:** si los usuarios enrolados llevan `readonly` + `deviceReadonly`, el
servicio tiene que crear el dispositivo al aprobar. El Plan 2 no puede dejarlo en manos
de la app.

### La ventana de revocación

**Deshabilitar un dispositivo NO corta una conexión ya establecida.** Las verificaciones
(f1)–(f3) y (h) lo miden: la (f2) comprueba que sigue reportando, la (h) que la ventana se
cierra sola.

El mecanismo, en el código de 6.15.3:

- `ConnectionManager.getDeviceSession` busca primero en `sessionsByEndpoint`
  (`Map<ConnectionKey, Map<uniqueId, DeviceSession>>`, con `ConnectionKey(channel,
  remoteAddress)`). Si hay **acierto de caché, vuelve enseguida** — y
  `device.checkDisabled()` solo se ejecuta en el camino de sesión nueva
  (`ConnectionManager.java:119-155`). El gate de `disabled` no se consulta en cada mensaje.
- `ConnectionManager` **no** implementa `CacheManager.CacheListener`: deshabilitar un
  dispositivo no invalida la sesión viva. La sesión solo se limpia en `deviceDisconnected`,
  que se llama desde `MainEventHandler.channelInactive`.
- No hay endpoint para desconectar un dispositivo: `DeviceResource` solo expone
  `{id}/accumulators` y `{id}/image`.

**Lo que sí acota la ventana es el timeout de inactividad.** `BasePipelineFactory` resuelve
`<protocolo>.timeout` (`Keys.PROTOCOL_TIMEOUT`, sufijo `.timeout`) y, si vale `0`, cae en
`server.timeout` — **por defecto 1800 s** (`Keys.java:360`). Para OsmAnd la clave es
`osmand.timeout`, en segundos. Con un valor > 0 y un transporte no-datagrama, agrega
`IdleStateHandler(timeout, 0, 0)`; al expirar, `MainEventHandler.userEventTriggered` hace
`closeChannel` → `channelInactive` → `deviceDisconnected` → la sesión cacheada se borra y el
siguiente reporte vuelve a pasar por `checkDisabled()`.

Medido en el descartable con `OSMAND_TIMEOUT=10`: a los 13 s de inactividad el servidor
cerró la conexión, y un reporte posterior por ella y por una conexión nueva fueron
rechazados, sin posición almacenada. **Con el ajuste, la ventana máxima es el timeout**; sin
ajustarlo son los 1800 s por defecto, media hora de ingesta de un dispositivo ya revocado.

**La revocación, entonces, son dos actos con dos latencias distintas:**

| Acto | Qué corta | Cuándo |
|------|-----------|--------|
| Deshabilitar el **usuario** | El acceso a los datos (todos sus tokens pasan a 401) | Al instante — verificación 8 |
| Deshabilitar el **dispositivo** | La ingesta de posiciones | Al cerrarse la conexión, acotado por `<protocolo>.timeout` |

### Atribución en una conexión compartida (experimento para el Plan 2)

Verificación (i): una sola conexión keep-alive reportando `rt-multi-a-…`, después
`rt-multi-b-…`, después `rt-multi-a-…` otra vez. Las tres posiciones caen en el dispositivo
que las mandó, según el `id` del reporte — **no** según la conexión. La conexión no fija un
dueño.

Consecuencia para el Plan 2: la `ConnectionKey` no sirve como identidad de dispositivo. Si
el camino de reporte real (HTTPS con el `uniqueId` como credencial) llega a multiplexar
dispositivos sobre una conexión, el control de acceso tiene que mirar el `id` de cada
reporte, que es lo que hace el gate de `disabled` hoy.

### Tres cosas que el smoke obligó a cambiar en el diseño

Ninguna de las tres era visible con `fetch` falso. Las tres están en el ledger.

1. **`GET /api/session` no sirve para saber quién soy.** Está anotado `@PermitAll` y solo
   lee el atributo `USER_ID` de la `HttpSession`, que con Basic Auth no existe: responde
   404 desde `SessionResource:104`. `whoAmI()` hace ahora `POST /api/session` (login), que
   devuelve el `User` completo con `administrator` y `userLimit`.

2. **La expiración del token va en ISO 8601 completo, no `YYYY-MM-DD`.** Jersey convierte
   el `@FormParam Date` con un formato que no entiende la fecha pelada: manda
   `ParamException$FormParamException` y la emisión falla con 400. El frontend ya usaba
   `dayjs(...).toISOString()` (`src/settings/PreferencesPage.jsx:84`). Con `2026-11-21` la
   suplantación funcionaba y el token **no se podía emitir** — el fallo aparecía recién en
   el segundo paso.

3. **Un `SecurityException` de Traccar sale como 400, no 403.** `ResourceErrorHandler`
   mapea toda excepción que no sea `WebApplicationException` a `BAD_REQUEST` con el stack
   trace como cuerpo. Las denegaciones que el smoke verifica (manager fijando
   `deviceLimit`, manager suplantando a un usuario ajeno) son reales, pero se identifican
   por el mensaje, no por el código de estado. **El servicio no debe ramificar por 403
   esperando "acceso denegado": tiene que mirar el cuerpo.**

Además, el token de `POST /api/session/token` llega **sin comillas** en 6.15.3 (el primer
byte del cuerpo es `0x52`, el último `0x51`, con `Content-Type: application/json`), al
contrario de lo que suponía el plan. `normalizeToken` tolera las dos formas, así que no
hubo que cambiar nada; el smoke sigue mandando el token entrecomillado al revocar para
cubrir la normalización.

## Variables de entorno del smoke

| Variable | Para qué |
|----------|----------|
| `SMOKE_SERVICE_EMAIL` / `SMOKE_SERVICE_PASSWORD` | La cuenta manager del descartable |
| `SMOKE_ADMIN_EMAIL` / `SMOKE_ADMIN_PASSWORD` | El administrador del descartable: solo para crear un usuario que el manager **no** creó (verificación 6) y borrarlo después |
| `SMOKE_TRACCAR_URL` | Default `http://127.0.0.1:18082`; solo se aceptan hosts locales |
| `SMOKE_EXPECTED_VERSION` | Default `6.15.3` |
| `SMOKE_OSMAND_URL` | Default `http://127.0.0.1:15055`; el listener OsmAnd del descartable, por donde reportan los dispositivos |
| `SMOKE_OSMAND_TIMEOUT` | Default `10`; **tiene que coincidir** con `OSMAND_TIMEOUT` del `docker-compose.smoke.yml`. Es lo que la verificación (h) espera para dar por cerrada la conexión |

Las credenciales de las cuentas de servicio en producción van por variables de entorno,
nunca en la línea de comandos, donde quedarían en el historial y en la lista de procesos.
