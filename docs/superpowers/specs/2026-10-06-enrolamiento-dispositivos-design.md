# Diseño — Enrolamiento de dispositivos (control de distribución de la APK)

**Fecha:** 2026-10-06
**Estado:** Aprobado — listo para el plan de implementación

## 1. Contexto y objetivo

RudaTrak es una app Android (Capacitor + React) que consume el servidor Traccar en `mh.rudatrak.com`. Hoy **la app no está distribuida a nadie**: está en desarrollo, con cero usuarios reales. Eso la convierte en el momento ideal para definir el modelo de acceso, antes de que exista una base instalada que romper.

**El problema:** no hay ningún control sobre quién usa el servicio. Si la APK se filtra, cualquiera puede crear su propia cuenta y usarlo gratis, y no hay forma de saber de dónde salió la copia.

**El objetivo:** que únicamente los dispositivos que el dueño aprueba explícitamente puedan usar el servicio. Que la APK, por sí sola, no sirva para nada.

**Principio rector:** el sistema es **aditivo, no invasivo**. Se agrega un componente nuevo con almacenamiento propio; Traccar, su base de datos y su puerto no se tocan. Si el componente nuevo falla o se cae, el servicio existente sigue funcionando igual.

### Contexto de uso

Proyecto personal, sin fines comerciales. La app se reparte a un círculo de gente de confianza y a quienes colaboren con las pruebas. La monetización es una posibilidad futura, no un requisito del diseño. El sistema debe ser proporcional a esa escala: decenas de dispositivos, no miles.

---

## 2. Hallazgos del código actual

Todo lo siguiente fue verificado en el repositorio, no asumido.

| Hallazgo | Ubicación | Consecuencia |
|---|---|---|
| El frontend compilado viaja dentro del APK | `capacitor.config.ts:6` (`webDir: 'build'`) | Cualquiera puede desarmar la APK y leer el bundle |
| Sin ofuscación ni R8 | `android/app/build.gradle:58` (`minifyEnabled false`) | El JS queda legible tras un `unzip` |
| Server por defecto fijo pero cambiable | `src/offline/nativeBootstrap.js:4`, `src/login/ChangeServerPage.jsx:23` | La app se puede repuntar a otro servidor |
| Token nativo de 365 días en SecureStorage | `src/login/LoginPage.jsx:126`, `src/offline/tokenStore.js` | Es el mecanismo de sesión que ya existe y hay que reutilizar |
| La app funciona sin red con token guardado | `src/App.jsx` → `OfflineScreen` | Restricción dura: no se puede exigir validación online permanente |
| **Auto-registro habilitado por defecto** | `traccar/.../MemoryStorage.java:52` (`server.setRegistration(true)`) | **Confirmado en producción el 2026-10-06: `tc_servers.registration = t`.** Hoy cualquiera con la APK se crea una cuenta |
| **La revocación de tokens ya existe** | `traccar/.../signature/TokenManager.java:93` y `:100`, `SessionResource.java:164` | No hay que inventar la revocación: se reutiliza |
| **`/poi/general.kml` es público** | Verificado: `HTTP 200`, 4.141.133 bytes sin autenticación | Los ~9.000 POIs se scrapean hoy sin cuenta |
| El Dockerfile ya parchea el JAR | `traccar-web/Dockerfile` (stage 2) | Tocar Java es viable, aunque este diseño no lo necesita |

**El hallazgo más importante:** verificado contra producción el 2026-10-06, `tc_servers.registration = t`. El auto-registro está activo. Hoy el control de acceso es inexistente.

---

## 3. Modelo de amenaza

Se acordó con el dueño que las preocupaciones reales son tres.

### 3.1 Cubierto por completo

**(a) Se registran solos.** El enrolamiento elimina el auto-registro. Ningún dispositivo entra sin una aprobación manual del dueño. Es el objetivo central del diseño.

### 3.2 Cubierto en gran medida

**(b) Prestan credenciales.** La propiedad clave: **el usuario nunca conoce una contraseña.** El servicio de enrolamiento crea la cuenta en Traccar con una contraseña aleatoria que jamás sale del servidor, y le entrega a la app únicamente un token de sesión. Sin contraseña no hay credencial que prestar.

Riesgo residual, declarado honestamente:
- El token sí es extraíble de un teléfono rooteado. Es bastante más difícil que pasar una contraseña, y es revocable desde el servidor con efecto inmediato en la próxima conexión.
- La revocación **no llega a un dispositivo sin conexión** hasta que vuelva a tener señal. Ver §7.4 y §12.
- **Contrapartida de diseño:** si el usuario nunca conoce su contraseña, tampoco puede entrar a la interfaz web en `mh.rudatrak.com`. Para un viajero que usa la app eso no es un problema, pero es una limitación real y conviene decidirla a conciencia. La cuenta del dueño no se ve afectada: sigue siendo una cuenta normal con contraseña.

### 3.3 Cubierto parcialmente

**(c) Repackage o reventa.** El enrolamiento no lo impide: alguien puede desarmar la APK y apuntarla a otro servidor. Pero el daño mayor no es la APK — es el activo de datos. Los ~9.000 POIs son el resultado de trabajo real y hoy están abiertos al público. Se cierran en §9.

Lo que **no** se resuelve y se asume: si alguien re-empaqueta la APK con su propio servidor Traccar, no hay forma de impedirlo desde acá. El diseño hace que eso no le sirva para mucho, porque los POIs y las posiciones no viajan en la APK.

### 3.4 Fuera del alcance

**(d) Trazabilidad de filtraciones.** El dueño descartó explícitamente esta preocupación. No se implementa watermarking por destinatario.

---

## 4. Decisiones

| Decisión | Valor | Motivo |
|---|---|---|
| Componente | Servicio Node/Express nuevo y separado | Aislado de `carga-poi`; si se rompe, no arrastra nada |
| Almacenamiento | **SQLite propio en un volumen propio** | Aislamiento máximo; no toca la base de Traccar ni su contenedor |
| Integración con Traccar | API REST con cuenta de admin dedicada | Evita parchear Java por completo |
| Identidad del dispositivo | Secreto aleatorio de 32 bytes en SecureStorage | Ya está la dependencia; sobrevive reinstalaciones de la app |
| El usuario no conoce contraseña | El servicio emite el token, no las credenciales | Elimina (b) sin tocar el backend |
| Entrega del token | Se reutiliza el flujo de token existente de la app | Cambio mínimo: `tokenStore.saveToken()` ya existe |
| Revocación | `POST /api/session/token/revoke` por dispositivo | Ya soportado por el backend |
| Auto-registro | Se desactiva a nivel servidor | Cierra el agujero principal |
| Duración del token | **365 días, sin cambios** | Irrelevante mientras exista la renovación silenciosa: el secreto del dispositivo puede emitir tokens nuevos. No hay motivo para tocarlo |
| Renovación | **Silenciosa, con el secreto del dispositivo** | Es lo que hace viable "el usuario nunca conoce su contraseña" en el largo plazo |
| Al vencer el token | Pantalla de enrolamiento, **nunca `/login`** | No hay contraseña que tipear; el login es un callejón sin salida |
| `/poi/*` | Detrás de token de sesión | Cierra la fuga del activo más valioso |
| Despliegue a producción | Fuera de la v1 | Se desarrolla y prueba local primero |

---

## 5. Arquitectura

```
┌─────────────────────────────────────────────────────────────┐
│  App Android (Capacitor)                                     │
│                                                              │
│  ┌────────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │ Pantalla de    │  │ Identidad de │  │ Token de sesión │  │
│  │ enrolamiento   │  │ dispositivo  │  │ (SecureStorage) │  │
│  └────────┬───────┘  └──────┬───────┘  └────────┬────────┘  │
└───────────┼─────────────────┼───────────────────┼───────────┘
            │                 │                   │
            │ código + polling│ secreto           │ token
            ▼                 ▼                   ▼
   ┌─────────────────────────────┐      ┌──────────────────────┐
   │  SERVICIO DE ENROLAMIENTO   │      │  TRACCAR (sin tocar) │
   │  contenedor nuevo           │      │  mh.rudatrak.com     │
   │                             │      │                      │
   │  · SQLite propio (volumen)  │─────▶│  /api/users          │
   │  · página de admin          │ REST │  /api/session        │
   │  · emite tokens             │ admin│  /api/session/token  │
   │  · RENUEVA tokens           │      │  /api/session/token/ │
   │  · revoca tokens            │      │       revoke         │
   └─────────────────────────────┘      └──────────────────────┘
```

**Frontera de aislamiento:** el servicio de enrolamiento es el único componente nuevo. No comparte base de datos con Traccar, no comparte contenedor, no comparte puerto. La comunicación es REST sobre la red de Docker, con una cuenta de admin dedicada.

---

## 6. El servicio de enrolamiento

### 6.1 Endpoints

| Método | Ruta | Autenticación | Descripción |
|---|---|---|---|
| `POST` | `/enroll/request` | Ninguna | La app se presenta. Devuelve el código legible |
| `GET` | `/enroll/status` | Secreto del dispositivo | La app consulta si ya fue aprobada |
| `POST` | `/enroll/renew` | Secreto del dispositivo | **Renovación silenciosa**: emite un token nuevo si el enrolamiento sigue aprobado |
| `POST` | `/enroll/revoke` | Secreto del dispositivo | La app se da de baja a sí misma |
| `GET` | `/admin` | Contraseña de admin | Página de aprobación |
| `POST` | `/admin/approve` | Contraseña de admin | Aprueba y emite el token |
| `POST` | `/admin/revoke` | Contraseña de admin | Revoca un dispositivo |
| `POST` | `/admin/rebind` | Contraseña de admin | Re-vincula a una persona con un teléfono nuevo |

Todo detrás de HTTPS (Nginx Proxy Manager), con límite de tasa en `/enroll/*`.

### 6.2 Almacenamiento (SQLite propio)

Tabla `devices`:

| Campo | Tipo | Notas |
|---|---|---|
| `device_id` | TEXT PK | `SHA-256` del secreto. **El secreto nunca se guarda** |
| `code` | TEXT UNIQUE | Código legible, alfabeto sin caracteres ambiguos |
| `status` | TEXT | `pending` / `approved` / `revoked` / `expired` |
| `label` | TEXT | Nombre que el dueño asigna al aprobar ("Juan") |
| `traccar_user_id` | INTEGER | Usuario de Traccar asociado |
| `token` | TEXT | Token emitido a ese dispositivo. **Se guarda porque `POST /api/session/token/revoke` lo exige como parámetro**, no solo su id |
| `created_at`, `approved_at`, `last_seen_at` | TEXT | Fechas ISO 8601 |
| `code_expires_at` | TEXT | Vencimiento del código pendiente (48 h) |

El secreto del dispositivo se transmite como `Authorization: Bearer <secreto>`. El servidor hashea y compara contra `device_id`. Nunca se almacena en claro, ni siquiera en los registros.

El campo `token` es la excepción: se guarda en claro porque el endpoint de revocación lo requiere. Es un secreto en reposo dentro del archivo SQLite, que vive en un volumen al que solo accede el servicio. Es una concesión consciente: sin el token guardado no hay revocación por dispositivo.

**No hay columna de contraseña, y es deliberado**: el token se emite por suplantación desde la sesión de admin (§6.3), no iniciando sesión como el usuario. La contraseña aleatoria se descarta apenas se crea la cuenta.

### 6.3 Credenciales

El servicio necesita una cuenta de **admin dedicada en Traccar**, distinta de la del dueño, con credenciales en variables de entorno. Es el componente más sensible del sistema y se documenta como tal: quien lea esas credenciales puede administrar el servidor.

La contraseña aleatoria que el servicio genera para cada cuenta de Traccar **nunca sale del servicio**. La app solo recibe el token.

**Y el servicio tampoco necesita conservarla.** El token no se obtiene iniciando sesión con la contraseña del usuario, sino por **suplantación desde la sesión de admin**. Cadena verificada en el código:

| Paso | Endpoint | Qué pasa |
|---|---|---|
| 1 | `GET /api/session/{userId}` con Basic auth de admin | `SessionResource.get` llama a `permissionsService.checkUser(getUserId(), userId)`, que **pasa si el que llama es administrador** (`PermissionsService.java:171-178`). Después llama a `SessionHelper.userLogin(...)`, que **pisa el `USER_ID` de la sesión** con el del usuario destino (`SessionHelper.java:33-47`) |
| 2 | `POST /api/session/token` **sin** cabecera `Authorization`, mandando solo la cookie de sesión | Toma `getUserId()` de la sesión — que ahora es el usuario destino — y devuelve un token firmado para él (`SessionResource.java:150-162`) |

Dos consecuencias de diseño:

- **No se guarda ninguna contraseña de usuario.** La que se genera al crear la cuenta se descarta apenas termina la petición de alta. Menos secretos en reposo: solo queda el token.
- Se **emite el token sin conocer la contraseña**, así que la renovación silenciosa (§7.2) no necesita credenciales por usuario.

**Detalle de implementación que no es obvio:** en el paso 1 la sesión se *invalida y se recrea* (`userLogin` empieza con `request.getSession().invalidate()`), así que la cookie `JSESSIONID` que devuelve el paso 1 es la que hay que usar en el paso 2. Y en el paso 2 **no hay que mandar Basic auth**: el filtro de seguridad, cuando ve la cabecera `Authorization`, arma el contexto desde esas credenciales y **no toca los atributos de la sesión** (`SecurityRequestFilter.java`), con lo cual el `getUserId()` del endpoint volvería a ser el del admin y el token saldría a nombre de la cuenta equivocada.

---

## 7. Flujos

### 7.1 Primer enrolamiento

```
1. Juan instala la APK y la abre por primera vez.

2. La app genera un secreto aleatorio de 32 bytes y lo guarda
   en SecureStorage (respaldo por Keystore de Android).

3. La app hace POST /enroll/request con el hash del secreto.

4. El servicio crea un registro pendiente y devuelve un código
   legible, por ejemplo  RUDA-7K4M-92QX.

5. La app muestra:  "Pasale este código a Rodrigo"  +  el código
   + estado "esperando aprobación".

6. Juan le manda el código por WhatsApp.

7. Rodrigo abre la página de admin, ve el pedido pendiente
   (código, fecha, versión de la app, nota que Juan haya escrito)
   y lo aprueba escribiendo el nombre.

8. El servicio, al aprobar:
     a. crea el usuario en Traccar con contraseña aleatoria
        (que se descarta enseguida, no se guarda)
     b. suplanta la sesión de admin hacia ese usuario (§6.3)
     c. pide un token de 365 días
     d. guarda el token en el registro del dispositivo
     e. marca el enrolamiento como aprobado

9. En el siguiente polling, la app recibe el token, lo guarda con
   el mecanismo que ya existe (tokenStore.saveToken) y entra.
   Juan nunca vio una contraseña ni la va a ver.
```

### 7.2 Renovación silenciosa

Es lo que sostiene la decisión de que el usuario nunca conozca una contraseña. Sin esto, cada vencimiento de token dejaría a la persona varada en una pantalla de login donde no tiene nada que tipear.

```
1. La app, estando online, detecta que el token venció — o que ya
   pasó la mitad de su vida útil y conviene adelantarse.

2. Hace POST /enroll/renew con su secreto de dispositivo.

3. El servicio verifica el hash del secreto, comprueba que el
   enrolamiento siga en estado aprobado, y emite un token nuevo
   por suplantación (§6.3) — sin contraseña y sin aprobación
   manual.

4. La app reemplaza el token guardado. Fin.

   Juan no se entera. Rodrigo no se entera. No hay código nuevo
   ni aprobación manual.
```

**Por qué renovar antes del vencimiento y no cuando falla:** si se espera al 401, la persona puede estar en el medio de un viaje, sin señal o con el servicio caído, y se queda afuera sin poder hacer nada. Renovando a mitad de camino, la expiración no llega a morder nunca en el campo.

**Consecuencia sobre el plazo del token:** una vez que existe la renovación, el plazo deja de ser un mecanismo de control. El secreto del dispositivo no vence, así que la vida útil efectiva de la credencial es la del secreto, no la del token. Poner 180 días en vez de 365 no cambiaría nada. Por eso se deja en 365.

### 7.3 Re-enrolamiento (Juan cambia de teléfono)

Es el caso operativo más frecuente y el que tiene que estar resuelto desde el día uno.

```
1. Juan instala en el teléfono nuevo y pide un código nuevo.

2. En la página de admin, Rodrigo usa "re-vincular": elige a Juan
   de la lista y aprueba el dispositivo nuevo.

3. El servicio revoca el token del dispositivo viejo en el mismo
   paso, y asocia el nuevo. Un solo acto, no dos.
```

Sin esta herramienta, cada cambio de teléfono termina en edición manual de la base desde la Pi. Es exactamente lo que hay que evitar.

### 7.4 Revocación

```
1. Rodrigo abre la página de admin y revoca el dispositivo.

2. El servicio llama a POST /api/session/token/revoke con el token
   de ese dispositivo, y marca el registro como revocado. Además
   marca el enrolamiento, para que /enroll/renew lo rechace: así
   no puede emitirse un token nuevo.

3. La próxima vez que la app consulte al servidor, recibe 401.
   El código que ya existe en App.jsx limpia el token. Lo único
   que cambia es el destino: en vez de navigate('/login'), va a
   la pantalla de enrolamiento, donde puede pedir un código nuevo
   si Rodrigo decide rehabilitarlo.
```

**Qué hace cumplir la revocación, exactamente.** No es la expiración del token. Es este chequeo del backend, que corre en cada validación sin importar la edad del token:

```java
// TokenManager.java:100
var revoked = storage.getObject(RevokedToken.class, ...);
if (revoked != null) {
    throw new SecurityException("Token has been revoked");
}
```

Un dispositivo revocado queda afuera la primera vez que toque el servidor, tenga el token un día o un año. Y como `/enroll/renew` también consulta el estado del enrolamiento, no puede pedir uno nuevo.

**Límite honesto:** si el dispositivo está sin conexión, la revocación no llega hasta que vuelva a tener señal, y mientras tanto la `OfflineScreen` sigue funcionando con los mapas ya descargados. Esto es inherente al modo offline y no se puede eliminar sin romper el caso de uso central (viajeros en zonas sin cobertura). **El plazo del token no ayuda acá**: sin red, la app no valida la expiración en ningún momento (ver `App.jsx`, el `catch` conserva el token). Es un límite aceptado, no un problema a resolver.

---

## 8. Identidad del dispositivo

- **Secreto:** 32 bytes de `crypto.getRandomValues()`, guardado en SecureStorage (`@aparajita/capacitor-secure-storage`, ya en uso en `src/offline/tokenStore.js`). Respaldado por el Keystore de Android.
- **Identificador:** `SHA-256(secreto)`. Es lo único que viaja y lo único que se almacena.
- **Código legible:** lo genera el **servicio**, no la app. Alfabeto sin caracteres ambiguos (`0/O`, `1/I/L`), formato `RUDA-XXXX-XXXX`. Es una etiqueta para pasar por WhatsApp, **no una credencial**: adivinarlo no da acceso a nada, porque la aprobación se amarra al secreto.
- **Vencimiento:** los códigos pendientes vencen a las 48 h. Un código olvidado en un chat no es una llave permanente.
- **Nota:** la memoria del proyecto advierte que restaurar `sqlite_encrypted_shared_prefs.xml` rompe el plugin SQLite. La restauración de datos de la app no debe incluir SecureStorage: un dispositivo restaurado desde un respaldo es, a los ojos del servidor, un dispositivo nuevo y debe re-enrolarse. Es el comportamiento correcto.

---

## 9. Cierre de `/poi/`

Hoy `https://mh.rudatrak.com/poi/general.kml` responde `HTTP 200` con 4,1 MB sin pedir autenticación. Los POIs se sirven como archivos estáticos del web root de Traccar, que no tiene auth porque ahí vive la pantalla de login.

**Cambio:** servir los POIs desde el servicio nuevo, validando el token de sesión de Traccar contra `GET /api/session?token=...`.

**Por qué es de bajo riesgo:** la app ya hace exactamente esto para otra cosa. El descargador de mapas offline ya manda el token de sesión como header `Authorization` contra el servicio `trak-mapas` (`nativeBootstrap.js`, `getSessionToken()`). Es reutilizar un patrón que ya funciona y está probado en producción.

**Consideración:** los POIs se cachean en el dispositivo al descargar zonas offline (`poiKmlStore.js`), así que la descarga es ocasional, no un pedido por cada uso del mapa.

**Riesgo:** es el único cambio que toca una ruta que hoy funciona. Va a staging primero, sin excepción.

---

## 10. Entornos

El trabajo avanza en tres capas, de menor a mayor riesgo.

| Capa | Dónde | Para qué | Riesgo sobre producción |
|---|---|---|---|
| Desarrollo | PC local (`/mnt/Datos/app/RudaTrak`) | Construir y probar el servicio y el flujo de enrolamiento | Ninguno |
| Staging | Pi, stack aparte | Probar desde un teléfono real, con datos reales | Ninguno (contenedores y base propios) |
| Producción | Pi, stack `rudatrak` | Recién con aprobación explícita del dueño | — |

**Staging:** contenedores `rudatrak-staging-*`, **base de datos propia** (nunca la de producción), puerto propio, ruta NPM propia con certificado. Los contenedores de producción no se detienen ni se recrean en ningún momento.

Staging **tiene que ser HTTPS**, no una IP de la red local: `AndroidManifest.xml` no declara `usesCleartextTraffic` y con `targetSdk 36` Android bloquea HTTP en claro por defecto. Apuntar la app a `http://192.168.x.x` no va a funcionar.

**Costo declarado:** una segunda instancia de Traccar más Postgres consume RAM en la Pi. Staging se levanta solo cuando hace falta probar desde el teléfono y se puede bajar cuando no.

---

## 11. Garantías de no regresión

**Garantía dura, por construcción:** el código del repositorio no afecta a producción. La Pi corre la imagen `rudatrak:latest` en un contenedor; el repositorio es solo fuente. El único camino a producción es ejecutar `deploy.sh`, que es el único que corre `docker compose up -d`. Si `deploy.sh` no se ejecuta, producción es inmune.

**Aislamiento del componente nuevo:** el servicio de enrolamiento es aditivo. Contenedor propio, base propia, puerto propio, ruta propia. Si se cae, Traccar sigue sirviendo. No hay estado compartido que pueda corromper.

**Punto de retorno (ya ejecutado el 2026-10-06):** tag `pre-enrolamiento` en los tres repos, `~/traccar-backup-2026-10-06.sql` (4,3 MB, verificado) y `traccar.xml.bak-2026-10-06` en la Pi. Son los dos únicos estados que git no recupera.

**Los dos cambios que sí rozan lo existente** —desactivar el auto-registro y cerrar `/poi/`— pasan por staging antes de producción. Son ambos reversibles en minutos.

**Lo que no se puede garantizar:** que un deploy futuro salga limpio a la primera. Eso se mitiga con staging y el punto de retorno, no con confianza.

---

## 12. Riesgos y límites

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Revocación no llega a un dispositivo offline | Un dispositivo revocado sigue usable sin señal, con los mapas ya descargados | Límite inherente al modo offline. **El plazo del token no lo mitiga** (sin red no se valida). Se acepta |
| El servicio es punto único de falla para enrolamientos y renovaciones | Si se cae, nadie nuevo entra y los tokens vencidos no se renuevan | La renovación proactiva a mitad de vida da margen; los usuarios con token vigente siguen hablando directo con Traccar |
| Credenciales de admin de Traccar en el servicio | Compromiso total si se filtran | Cuenta dedicada, solo variables de entorno, nunca en el repositorio |
| Un dispositivo rooteado puede extraer el token | Suplantación de ese dispositivo | Revocación por token, efectiva en la próxima conexión; el atacante necesita además root |
| Alguien re-empaqueta la APK con otro servidor | No se puede impedir | Los POIs y las posiciones no viajan en la APK |
| Segundo Traccar + Postgres consumen RAM en la Pi | Degradación de producción | Staging se levanta solo cuando hace falta |

**Límite fundamental, dicho sin adornos:** ninguna verificación que viva dentro del APK es infalible. Con `minifyEnabled false` y el bundle en JS, un atacante con tiempo saca cualquier chequeo local. Lo que este diseño logra es que la copia **no sirva para nada sin el servidor**. Para un círculo de gente de confianza, eso es suficiente.

---

## 13. Testing

- **Servicio de enrolamiento:** `node:test`. Casos: generación y unicidad de códigos, vencimiento a 48 h, hasheo del secreto, máquina de estados `pending → approved → revoked`, rechazo de secretos inválidos, límite de tasa.
- **Renovación:** que `/enroll/renew` emita un token nuevo con un secreto válido y aprobado; que lo **rechace** si el enrolamiento está revocado; que lo rechace con un secreto que no existe; que el token viejo quede invalidado.
- **Integración:** contra un contenedor Traccar local — crear usuario, emitir token, verificar el token, revocarlo y confirmar que `verifyToken` lo rechaza.
- **App:** `vitest` (ya configurado). Casos: generación del secreto, persistencia en SecureStorage, polling, renovación proactiva al pasar la mitad de la vida del token, y que un 401 lleve a la **pantalla de enrolamiento** y no a `/login`.
- **Manual, en staging:** el flujo completo desde un teléfono real, incluyendo cambio de teléfono, renovación y revocación.

---

## 14. Fuera de alcance

Descartado explícitamente para esta versión, por no ser proporcional a la escala del proyecto:

- Play Integrity API o cualquier atestación de dispositivo
- Certificate pinning
- Ofuscación R8 / `minifyEnabled true`
- Watermarking por destinatario o trazabilidad de filtraciones
- Amarre de dispositivo en el backend Java (`LoginService`)
- Cobro, suscripción o vencimiento comercial
- Verificación de firma o de integridad del bundle en runtime

Si en algún momento el proyecto se monetiza, el orden natural de incorporación es: amarre en Java → verificación de firma → atestación.

---

## 15. Pendiente de verificar

- ~~El valor actual del flag `registration` en la base de producción.~~ **VERIFICADO el 2026-10-06** contra un `pg_dump` de producción: `tc_servers.registration = t`. El auto-registro **está abierto**. Se confirma la hipótesis de §2 y el agujero de §3.1 es real y activo.
- Recursos disponibles en la Pi para sostener un segundo Traccar más Postgres sin afectar producción.

### Estado real de producción al 2026-10-06

| Dato | Valor |
|---|---|
| Usuarios | 1 (`Rodrigo Javier Schechtel`, administrador) |
| Dispositivos | 1 (`Sprinter`, `uniqueId` `KJA-169`, categoría `van`, offline desde 2026-09-02) |
| `registration` | `t` — **auto-registro abierto** |
| `poilayer` | `/poi/general.kml` |
| Tamaño del dump | 4,3 MB, 51 tablas |

El `pg_dump` de respaldo quedó en `~/traccar-backup-2026-10-06.sql`. **Contiene el hash y el salt de la contraseña del administrador**: tratarlo como material sensible, no compartirlo ni versionarlo.
