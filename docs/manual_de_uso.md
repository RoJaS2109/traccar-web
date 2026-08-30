# Manual de puesta en marcha — RudaTrak

Guía completa para levantar RudaTrak desde cero (o reconstruirlo tras un fallo de disco) en una Raspberry Pi con Docker y Portainer.

## 1. Qué es RudaTrak

Plataforma de rastreo GPS y mapa de puntos de interés (POIs) para viajeros en Argentina y países limítrofes. Es un fork privado de [Traccar](https://www.traccar.org/):

- **Backend**: Traccar Server (Java 21) con el protocolo propio **Rinho** (tracker GPS Rinho IoT por UDP) y branding "RudaTrak".
- **Frontend**: React SPA (Vite 8, Material UI 9, MapLibre GL 5) compilada dentro del mismo contenedor.
- **Base de datos**: PostgreSQL 16.
- **Herramienta de POIs**: `carga-poi` (API Express, puerto 3007) para gestionar los puntos de interés del KML.

## 2. Arquitectura

```
Internet
    │ Cloudflare (DNS + CDN)
    ▼
Raspberry Pi
    │ Nginx Proxy Manager (SSL vía Let's Encrypt)
    ▼
Stack Docker "rudatrak" (red externa npm_proxy-network)
    ├── rudatrak-traccar      ← Traccar Server + frontend (8082 interno, 5031/udp expuesto)
    ├── rudatrak-database     ← PostgreSQL 16
    ├── rudatrak-carga-poi    ← API Express de POIs (3007)
    └── rudatrak-autoheal     ← reinicio automático de contenedores unhealthy
```

| Contenedor | Imagen | Puerto | Rol |
|-----------|--------|--------|-----|
| `rudatrak-traccar` | `rudatrak:latest` | `5031/udp` (host) | Server + frontend (sirve en 8082 interno) |
| `rudatrak-database` | `postgres:16-alpine` | — | PostgreSQL (interno) |
| `rudatrak-carga-poi` | `carga-poi:latest` | `3007/tcp` | Gestión de POIs |
| `rudatrak-autoheal` | `willfarrell/autoheal:latest` | — | Reinicia contenedores unhealthy |

**Red Docker:** `npm_proxy-network` (externa, compartida con Nginx Proxy Manager).

**Volúmenes persistentes** (en la Pi):

| Ruta en la Pi | Montado en | Contenido |
|--------------|-----------|-----------|
| `/mnt/datos/servicios/rudatrak/postgres-data` | `/var/lib/postgresql/data` | Datos de PostgreSQL |
| `/mnt/datos/servicios/rudatrak/trak-conf` | `/opt/traccar/conf` | `traccar.xml` |
| `/mnt/datos/servicios/rudatrak/trak-poi` | `/opt/traccar/web/poi` y `/data/kml` | KMLs e íconos de POIs |
| `/mnt/datos/servicios/rudatrak/trak-logs` | `/opt/traccar/logs` | Logs del server |

> En la PC de desarrollo el monorepo vive en `/mnt/Datos/app/RudaTrak/traccar/`; en la Pi el repo se clona a `/mnt/datos/RudaTrak-web` (partición de datos, separada del OS).

## 3. Requisitos previos en la Pi

- **Docker** y **Docker Compose** (plugin `docker compose`).
- **Portainer** en `http://localhost:9000`.
- **Nginx Proxy Manager** en `http://localhost:81`.
- Red Docker externa `npm_proxy-network` ya creada.
- Acceso SSH al repo privado (Deploy Key con write access en GitHub).

### Crear la red Docker

```bash
docker network create npm_proxy-network
```

### Configurar la Deploy Key SSH

```bash
# En la Pi
ssh-keygen -t ed25519 -C "HP-Victus"
cat ~/.ssh/id_ed25519.pub
```

Agregar el output como Deploy Key en GitHub (con **Allow write access**):

- https://github.com/RoJaS2109/traccar/settings/keys
- https://github.com/RoJaS2109/traccar-web/settings/keys

Verificar la conexión:

```bash
ssh -T git@github.com
```

## 4. Puesta en marcha

### 4.1 Crear la estructura de volúmenes

```bash
sudo mkdir -p /mnt/datos/servicios/rudatrak/{postgres-data,trak-conf,trak-poi,trak-logs}
```

### 4.2 Clonar el repo

```bash
cd /mnt/datos
git clone git@github.com:RoJaS2109/traccar-web.git RudaTrak-web
cd RudaTrak-web
```

> Solo hace falta este repo (`traccar-web`): el `docker-compose.yml`, el `Dockerfile` y el `setup/traccar.xml` están acá. El build del contenedor es self-contained (compila frontend + backend sin Node/JDK en el host).

### 4.3 Definir la contraseña de la base

Crear el archivo `.env` en la raíz del repo (está en `.gitignore`, no se versiona):

```bash
nano .env
```

Contenido:

```
POSTGRES_PASSWORD=<contraseña-bd-nueva>
```

Docker Compose lee este `.env` para interpolar `${POSTGRES_PASSWORD}`. Se hace **una sola vez**; sobrevive a `git pull` y no hay que re-exportarla en cada terminal.

### 4.4 Desplegar

Hay dos formas equivalentes:

#### Opción A — `deploy.sh` (por SSH)

```bash
# Desde la PC de desarrollo
cd /mnt/Datos/app/RudaTrak/traccar/traccar-web
./deploy.sh pi@raspi

# O directamente en la Pi
cd /mnt/datos/RudaTrak-web && ./deploy.sh
```

El script hace: `git pull` → build de `rudatrak:latest` → copia de KMLs e íconos a `trak-poi/` → copia de `traccar.xml` a `trak-conf/` (solo si no existe) → build de `carga-poi:latest` → `docker compose up -d`.

#### Opción B — Portainer (Add stack → Repository)

Permite desplegar todo el stack desde el repo sin SSH. Los servicios con `build:` usan `pull_policy: build` para que Portainer reconstruya la imagen.

1. Portainer → **Stacks** → **Add stack** → **Repository**.
2. **Name:** `rudatrak`.
3. **Repository URL:** `https://github.com/RoJaS2109/traccar-web.git`.
4. **Repository reference:** `refs/heads/master`.
5. **Authentication:** repo privado → HTTPS + Personal Access Token (GitHub → Settings → Developer settings → Personal access tokens, scope `repo`): username `RoJaS2109`, password = el token.
6. **Compose path:** `docker-compose.yml`.
7. **Environment variables:** subir un `.env` con:
   ```
   POSTGRES_PASSWORD=<contraseña-bd>
   ```
   El `.env` está gitignoreado, así que hay que proveerlo acá. **Sin este paso, `${POSTGRES_PASSWORD}` queda vacío y Traccar no puede autenticar** (ver sección 7).
8. **Deploy the stack**.

> Portainer **no ejecuta `deploy.sh`**. Solo clona y hace `docker compose up`. En un host desde cero, copiar `traccar.xml` y los KMLs a mano primero (la Opción A ya lo hace):
> ```bash
> sudo mkdir -p /mnt/datos/servicios/rudatrak/{postgres-data,trak-conf,trak-poi,trak-logs}
> sudo cp setup/traccar.xml /mnt/datos/servicios/rudatrak/trak-conf/traccar.xml
> sudo cp -r data/*.kml data/iconos /mnt/datos/servicios/rudatrak/trak-poi/
> ```

> El primer build tarda más (descarga `node:22-alpine`, `eclipse-temurin:21-jdk` y `traccar/traccar:latest`). Los siguientes reutilizan capas cacheadas.

### 4.5 Verificar que todo esté healthy

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
docker logs rudatrak-traccar 2>&1 | grep -iE "liquibase|Update has been" | tail -5
```

Deben verse los 4 contenedores `Up`/`healthy`, y en el log de traccar el `Update has been successful` (o "Database is up to date") de Liquibase, que confirma que PostgreSQL migró el esquema.

## 5. Configurar dominios

### 5.1 Nginx Proxy Manager (http://localhost:81)

| Proxy Host | Forward a | Notas |
|-----------|-----------|-------|
| `mh.rudatrak.com` | `http://rudatrak-traccar:8082` | **WebSocket support activado** (para `/api/socket`) |
| `nuevo-poi.rudatrak.com` | `http://rudatrak-carga-poi:3007` | — |

- **SSL:** Let's Encrypt para ambos.
- El dispositivo Rinho (UDP 5031) **no pasa por NPM** — va directo al puerto de la Pi.

### 5.2 Cloudflare DNS

| Subdominio | IP | Proxy | Uso |
|-----------|----|-------|-----|
| `mh.rudatrak.com` | IP de la Pi | Proxied (naranja) | UI de Traccar + API REST + WebSocket |
| `nuevo-poi.rudatrak.com` | IP de la Pi | Proxied (naranja) | Herramienta carga-poi |
| `taip.rudatrak.com` | IP de la Pi | **DNS only (gris)** | GPS Rinho Spider (UDP 5031) |

> `taip.rudatrak.com` debe ir en **gris** porque Cloudflare no proxy UDP. El Rinho envía datagramas UDP directo al puerto 5031 de la Pi.

> Si aparece `ERR_TOO_MANY_REDIRECTS`, revisar el modo SSL de Cloudflare: usar **Full** (no "Flexible") cuando NPM ya termina SSL.

## 6. Configuración inicial post-arranque

### 6.1 Primer usuario

Al primer arranque no hay usuarios. Registrá uno desde `https://mh.rudatrak.com/register` — el primero registrado queda como **administrador**.

### 6.2 Token de Telegram (notificaciones)

En `/mnt/datos/servicios/rudatrak/trak-conf/traccar.xml` queda el placeholder:

```xml
<entry key='notificator.telegram.token'>TU_BOT_TOKEN_AQUI</entry>
```

Reemplazarlo por el token real del bot y redeployar para activar las notificaciones por Telegram.

### 6.3 Capa de POIs (mapa)

Para que los puntos de interés del KML aparezcan en el mapa, configurar la preferencia **`poiLayer`** (Settings → Server → Preferences) con el valor:

```
/poi/general.kml
```

> Debe ser la ruta absoluta. Si queda vacía, la capa falla silenciosamente y no se ve ningún POI.

### 6.4 Dispositivos

- **Tracker GPS Rinho Spider**: habla el protocolo Rinho por UDP al puerto 5031. Crear el dispositivo en la UI y apuntar el tracker a `taip.rudatrak.com:5031` (o la IP directa de la Pi).
- **Traccar Client (app Android/iOS)**: usa el protocolo OsmAnd (TCP 5055). Se conecta vía `https://mh.rudatrak.com` (NPM forwardea a `traccar:5055`).

### 6.5 Puntos de interés (carga-poi)

La herramienta `https://nuevo-poi.rudatrak.com` permite agregar/actualizar/eliminar POIs sobre `general.kml` (con backup automático antes de cada escritura). Detecta POIs cercanos a ≤30 m al ingresar coordenadas.

## 7. Solución de problemas rápidos

| Síntoma | Causa probable | Fix |
|---------|---------------|-----|
| `rudatrak-traccar` queda `restarting` (ExitCode=1) y el log solo muestra warnings de Guice | `DATABASE_PASSWORD` vacío (el `.env` no llegó al stack de Portainer) | Agregar `POSTGRES_PASSWORD` en Environment variables y Update the stack |
| `Bind for 0.0.0.0:5031 failed: port is already allocated` | Un stack viejo (`traccar_app` MySQL) u otro contenedor tiene el 5031/udp | `docker ps -a` para ubicarlo y `docker rm -f <nombre>` |
| `ERR_TOO_MANY_REDIRECTS` | SSL de Cloudflare en "Flexible" + NPM "Force SSL" | Cambiar Cloudflare a **Full** |
| El branding muestra "Traccar" | Caché del service worker o de Cloudflare | Limpiar datos del sitio / Purge Everything |
| El mapa no muestra POIs | Preferencia `poiLayer` vacía | Setearla en `/poi/general.kml` |

Para diagnóstico detallado, ver [`deploy.md`](deploy.md).

## 8. Despliegues posteriores

```bash
# En la Pi
cd /mnt/datos/RudaTrak-web && ./deploy.sh

# O desde la PC
cd /mnt/Datos/app/RudaTrak/traccar/traccar-web
git add . && git commit -m "cambios" && git push
ssh pi@raspi "cd /mnt/datos/RudaTrak-web && ./deploy.sh"
```

En Portainer, usar **Update the stack** (re-pull + rebuild) sobre el stack `rudatrak`.
