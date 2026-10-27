# Deploy

## Requisitos en la Raspberry Pi

- Docker
- Portainer (http://localhost:9000)
- Deploy Key SSH configurada en GitHub (write access)

### Configuración inicial de SSH

```bash
# 1. Generar clave SSH en la Pi
ssh-keygen -t ed25519 -C "HP-Victus"
cat ~/.ssh/id_ed25519.pub

# 2. Agregar el output como Deploy Key en GitHub:
#    https://github.com/RoJaS2109/traccar/settings/keys      ✅ Allow write access
#    https://github.com/RoJaS2109/traccar-web/settings/keys   ✅ Allow write access

# 3. Probar conexión
ssh -T git@github.com
```

## Primer despliegue

### 1. Crear la estructura de volúmenes

```bash
sudo mkdir -p /mnt/datos/servicios/rudatrak/{postgres-data,trak-conf,trak-poi,trak-logs}
```

### 2. Clonar el repo

```bash
cd /mnt/datos
git clone git@github.com:RoJaS2109/traccar-web.git RudaTrak-web
cd RudaTrak-web
```

> El repo vive en `/mnt/datos/RudaTrak-web` (partición de datos, no la del OS). El `docker-compose.yml`, el `Dockerfile` y el `setup/traccar.xml` están todos en `traccar-web/`, así que basta con clonar este repo (no hace falta `traccar/`).

### 3. Definir las credenciales

Creá el archivo `.env` en la raíz del repo (está en `.gitignore`, así que **no se versiona** y sobrevive a `git pull`):

```bash
cd /mnt/datos/RudaTrak-web
nano .env
```

Con este contenido:

```
POSTGRES_PASSWORD=<contraseña-bd-nueva>
```

Docker compose lee este `.env` para interpolar `${POSTGRES_PASSWORD}`. Se hace una sola vez; no hace falta re-exportar la contraseña en cada terminal ni en cada deploy.

### 4. Build + deploy inicial

```bash
./deploy.sh
```

Esto ejecuta:
1. `git pull origin master`
2. `docker build -t rudatrak:latest .` (Dockerfile multi-stage self-contained: compila el frontend y parchea el backend)
3. Copia de KMLs a `/mnt/datos/servicios/rudatrak/trak-poi/` (`general.kml` solo si no existe: en la Pi lo edita carga-poi) y de `traccar.xml` a `/mnt/datos/servicios/rudatrak/trak-conf/` (solo si no existe)
4. `docker build -t carga-poi:latest ./tools/carga-poi`
5. `docker compose up -d` (redeploy del stack)

> **PostgreSQL:** el stack levanta un servicio `database` (PostgreSQL 16) y Traccar se conecta a él por env vars. La DB se crea sola con las migraciones de Liquibase al primer arranque. No hay que configurar H2 ni copiar ninguna DB.

### 5. Configurar Nginx Proxy Manager

En `http://localhost:81`:

- **Proxy Host:** `mh.rudatrak.com` → `http://rudatrak-traccar:8082`
- **Proxy Host:** `mh.rudatrak.com` → `http://rudatrak-traccar:8082`
- **Proxy Host:** `nuevo-poi.rudatrak.com` → `http://rudatrak-carga-poi:3007`
- **SSL:** Let's Encrypt (para todos)
- **WebSocket support:** Activado para `mh.rudatrak.com` (para `/api/socket`)

### 6. Configurar DNS en Cloudflare

| Subdominio | IP | Proxy | Uso |
|-----------|----|-------|-----|
| `mh.rudatrak.com` | IP de la Pi | Proxied (naranja) | UI de Traccar |
| `mh.rudatrak.com` | IP de la Pi | Proxied (naranja) | API REST + WebSocket |
| `nuevo-poi.rudatrak.com` | IP de la Pi | Proxied (naranja) | Herramienta carga-poi |
| `taip.rudatrak.com` | IP de la Pi | **DNS only (gris)** | GPS Rinho Spider (UDP 5031) |

> **Importante:** `taip.rudatrak.com` debe estar en **gris** (DNS only) porque Cloudflare no proxy UDP. El dispositivo Rinho envía datagramas UDP directamente al puerto 5031 de la Pi.

## Despliegues posteriores

```bash
# En la Pi
cd /mnt/datos/RudaTrak-web && ./deploy.sh
```

O desde la PC:

```bash
cd /mnt/Datos/app/RudaTrak/traccar/traccar-web
git add . && git commit -m "cambios" && git push
ssh pi@raspi "cd /mnt/datos/RudaTrak-web && ./deploy.sh"
```

## Despliegue con Portainer (Add stack → Repository)

Como el `docker-compose.yml` vive en `traccar-web/` y usa `build:` con contextos relativos, se puede desplegar todo el stack desde Portainer sin build manual. Los servicios con `build:` usan `pull_policy: build` para que Portainer reconstruya la imagen aunque ya exista localmente.

1. Portainer → **Stacks** → **Add stack** → **Repository**
2. **Name:** `rudatrak`
3. **Repository URL:** `https://github.com/RoJaS2109/traccar-web.git`
4. **Repository reference:** `refs/heads/master`
5. **Repository authentication:** el repo es privado, así que hace falta autenticación. Lo más simple es HTTPS + Personal Access Token (GitHub → Settings → Developer settings → Personal access tokens, scope `repo`): username `RoJaS2109`, password = el token. (Alternativa: cargar la clave privada de la Deploy Key en Portainer y usar `git@github.com:...`.)
6. **Compose path:** `docker-compose.yml`
7. **Environment variables:** subí un archivo `.env` con:
   ```
   POSTGRES_PASSWORD=<contraseña-bd>
   ```
   El `.env` está gitignoreado, así que no viaja en el repo; hay que proveerlo acá (subiéndolo en Portainer).
8. **Deploy the stack**

Portainer clona el repo, reconstruye las 2 imágenes custom (`rudatrak`, `carga-poi`) y levanta el stack (que incluye `database` PostgreSQL y `autoheal`). La red externa `npm_proxy-network` debe existir previamente en el host.

> **Nota:** Portainer "Add stack → Repository" **no ejecuta `deploy.sh`**. Solo clona y hace `docker compose up`, así que no copia el `traccar.xml` ni los KMLs (eso lo hace `deploy.sh`). En un host ya desplegado, los volúmenes `trak-conf/` y `trak-poi/` ya están poblados y no es problema. Para un host desde cero, copiarlos a mano primero:
> ```bash
> sudo mkdir -p /mnt/datos/servicios/rudatrak/{postgres-data,trak-conf,trak-poi,trak-logs}
> sudo cp setup/traccar.xml /mnt/datos/servicios/rudatrak/trak-conf/traccar.xml
> sudo cp -r data/*.kml data/iconos /mnt/datos/servicios/rudatrak/trak-poi/
> ```

> **Nota:** el primer deploy tarda más porque descarga `node:22-alpine`, `eclipse-temurin:21-jdk` y `traccar/traccar:latest`. Despliegues posteriores reutilizan las capas cacheadas.

## Actualizar solo el frontend

Si solo cambió código del frontend (sin cambios en Docker):

```bash
cd /mnt/datos/RudaTrak-web
git pull
docker build -t rudatrak:latest .
./deploy.sh   # usa Portainer API para redeploy
```

## Actualizar solo los KMLs

```bash
cd /mnt/datos/RudaTrak-web
git pull
sudo cp data/*.kml /mnt/datos/servicios/rudatrak/trak-poi/
```

## Rollback

```bash
# Volver a la imagen oficial de Traccar
docker tag traccar/traccar:latest rudatrak:latest
./deploy.sh   # redeploya el stack con la imagen oficial

# O restaurar un commit anterior
git log --oneline   # encontrar el hash
git checkout <hash>
./deploy.sh
```

> **Ojo con el rollback de base de datos:** PostgreSQL migra el esquema con Liquibase. Si bajás a una versión anterior del backend que espera un esquema más viejo, puede haber incompatibilidad. Para un rollback simple del frontend no hay problema; para rollback del backend, respaldá `postgres-data/` antes.

## Solución de problemas de deploy

### El contenedor no se actualiza después del build

**Causa:** `docker compose up -d` sin `--force-recreate` no recrea contenedores si el compose file no cambió, aunque la imagen haya cambiado.

**Solución:** El `deploy.sh` usa la API de Portainer (`PUT /api/stacks/{id}`) que fuerza el redeploy completo del stack.

### El branding sigue mostrando "Traccar" después del deploy

**Causa:** Service Worker cache o Cloudflare cache.

```bash
# 1. Verificar que el manifest devuelva RudaTrak
curl -s https://mh.rudatrak.com/manifest.webmanifest | grep RudaTrak

# 2. Si el curl muestra Traccar, verificar el build Docker
docker run --rm --entrypoint cat rudatrak:latest /opt/traccar/tracker-server.jar > /tmp/test.jar
jar xf /tmp/test.jar org/traccar/web/OverrideTextFilter.class
javap -c org/traccar/web/OverrideTextFilter.class | grep "RudaTrak\|Traccar"
rm -rf org/ /tmp/test.jar

# 3. En el navegador: limpiar datos del sitio (service worker)
# Chrome → candado en barra → Cookies y datos → Eliminar

# 4. Limpiar caché de Cloudflare
# Dashboard → Caching → Purge Everything
```

### Error "port is already allocated" (puertos 5031 o 3007)

**Causa:** Otro contenedor (típicamente un stack viejo o un contenedor huérfano de un `docker compose` previo, fuera de Portainer) ya tiene el puerto mapeado. El `rudatrak-traccar` usa `5031/udp` (Rinho) y `rudatrak-carga-poi` usa `3007/tcp`.

**Diagnóstico:**

```bash
# Qué contenedores hay y qué puertos mapean
docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

# Quién escucha en el puerto a nivel host
sudo ss -ulnp | grep 5031   # UDP (traccar)
sudo ss -tlnp | grep 3007   # TCP (carga-poi)

# El error real del contenedor
docker inspect rudatrak-traccar --format '{{.State.Error}}'
```

Si `State.Error` dice `Bind for 0.0.0.0:5031 failed: port is already allocated`, hay un stack viejo (ej. `traccar_app`/`traccar_db`, MySQL) u otro contenedor suelto con ese puerto. Eliminarlo libera el puerto:

```bash
docker rm -f <nombre-del-contenedor-que-lo-ocupa>
```

Para contenedores huérfanos de `docker compose` (puerto 3007):

```bash
docker stop carga-poi rudatrak-carga-poi 2>/dev/null
docker rm carga-poi rudatrak-carga-poi 2>/dev/null
docker network rm carga-poi_default 2>/dev/null
./deploy.sh
```

### El contenedor traccar queda "restarting" (ExitCode=1) sin stack trace

**Síntoma:** `rudatrak-traccar` aparece en estado `restarting` con `RestartCount` subiendo, y `docker logs` solo muestra los warnings de Guice (`sun.misc.Unsafe`) repetidos, sin ninguna excepción Java.

**Diagnóstico:**

```bash
# El error real (filtra el spam de Guice):
docker logs rudatrak-traccar 2>&1 | grep -viE "sun.misc.Unsafe|HiddenClassDefiner|terminally deprecated|reporting this to the maintainers|will be removed" | tail -60

# Estado y variables de entorno del contenedor:
docker inspect rudatrak-traccar --format 'ExitCode={{.State.ExitCode}}  Error={{.State.Error}}'
docker inspect rudatrak-traccar --format '{{range .Config.Env}}{{println .}}{{end}}' | grep DATABASE
```

**Causas (en orden de probabilidad):**

1. **`DATABASE_PASSWORD` vacío.** Si en el array `Env` aparece `DATABASE_PASSWORD=` (vacío), el `${POSTGRES_PASSWORD}` no se interpoló: el stack de Portainer no recibió el `.env`. Traccar arranca, intenta autenticar contra PostgreSQL con password vacía y muere con `password authentication failed` (la base ya se inicializó con la contraseña real del `deploy.sh`, y no se re-inicializa sobre un volumen existente). **Fix:** en Portainer → stack → Environment variables, agregar `POSTGRES_PASSWORD=<la misma de /mnt/datos/RudaTrak-web/.env>`, y Update the stack.

2. **Puerto `5031/udp` ya ocupado.** Ver la sección anterior ("port is already allocated").

### Los contenedores aparecen sueltos en vez de en el stack

**Causa:** Se ejecutó `docker compose up -d` manualmente desde la terminal en vez de usar Portainer.

**Solución:** Usar siempre `./deploy.sh` (Portainer API) o redeploy desde la UI de Portainer. Si ya hay contenedores sueltos:

```bash
docker stop rudatrak-traccar rudatrak-carga-poi carga-poi 2>/dev/null
docker rm rudatrak-traccar rudatrak-carga-poi carga-poi 2>/dev/null
# Luego redeploy desde Portainer o ./deploy.sh
```

### El frontend se ve desactualizado

```bash
# 1. Verificar que el build sea reciente
ls -la /mnt/datos/RudaTrak-web/build/index.html

# 2. Verificar que la imagen se reconstruyó
docker images rudatrak --format '{{.CreatedAt}}'

# 3. Limpiar Service Worker en el navegador
# Chrome → candado en barra → Cookies y datos → Eliminar
# O usar modo incógnito para test

# 4. Limpiar caché de Cloudflare
# Dashboard → Caching → Purge Everything
```
