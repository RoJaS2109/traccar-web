# Deploy

## Requisitos en la Raspberry Pi

- Docker
- Portainer (http://localhost:9000)
- Node.js 20+ (para build del frontend)
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

### 1. Clonar el repo

```bash
cd ~
git clone --recurse-submodules git@github.com:RoJaS2109/traccar.git RudaTrak
cd ~/RudaTrak/traccar-web
```

### 2. Configurar contraseña de Portainer

```bash
echo "tu-password" > ~/RudaTrak/traccar-web/.portainer_pass
chmod 600 ~/RudaTrak/traccar-web/.portainer_pass
```

### 3. Build inicial

```bash
./deploy.sh
```

Esto ejecuta:
1. `git pull` + `npm install` + `npm run build`
2. `docker build -t rudatrak:latest .` (Dockerfile multi-stage: compila y parchea el backend)
3. Copia de KMLs a `/data/compose/traccar/traccar-poi/`
4. `docker build -t agente-ia:latest ./tools/agente-ia`
5. `docker build -t carga-poi:latest ./tools/carga-poi`
6. **Portainer API** → autentica, busca el stack `rudatrak` y lo redeploya

### 4. Crear stack en Portainer

1. Entrar a `http://localhost:9000`
2. **Stacks → Add Stack**
3. Nombre: `rudatrak`
4. Build method: **Web Editor**
5. Pegar el contenido de `docker-compose.yml`
6. **Deploy the stack**

> **Importante:** El stack DEBE llamarse `rudatrak`. El deploy.sh lo busca por ese nombre.

### 5. Configurar Nginx Proxy Manager

En `http://localhost:81`:

- **Proxy Host:** `gps.rudatrak.com` → `http://rudatrak-traccar:8082`
- **SSL:** Let's Encrypt
- **WebSocket support:** Activado (para `/api/socket`)

### 6. Configurar DNS en Cloudflare

- `gps.rudatrak.com` → IP de la Raspberry Pi
- Proxy status: DNS only o Proxied

## Despliegues posteriores

```bash
# En la Pi
cd ~/RudaTrak/traccar-web && ./deploy.sh
```

O desde la PC:

```bash
cd /mnt/Datos/app/RudaTrak/traccar/traccar-web
git add . && git commit -m "cambios" && git push
ssh pi@raspi "cd ~/RudaTrak/traccar-web && ./deploy.sh"
```

## Actualizar solo el frontend

Si solo cambió código del frontend (sin cambios en Docker):

```bash
cd ~/RudaTrak/traccar-web
git pull && npm install && npm run build
docker build -t rudatrak:latest .
./deploy.sh   # usa Portainer API para redeploy
```

## Actualizar solo los KMLs

```bash
cd ~/RudaTrak/traccar-web
git pull
sudo cp data/*.kml /data/compose/traccar/traccar-poi/
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

## Solución de problemas de deploy

### El contenedor no se actualiza después del build

**Causa:** `docker compose up -d` sin `--force-recreate` no recrea contenedores si el compose file no cambió, aunque la imagen haya cambiado.

**Solución:** El `deploy.sh` usa la API de Portainer (`PUT /api/stacks/{id}`) que fuerza el redeploy completo del stack.

### El branding sigue mostrando "Traccar" después del deploy

**Causa:** Service Worker cache o Cloudflare cache.

```bash
# 1. Verificar que el manifest devuelva RudaTrak
curl -s https://gps.rudatrak.com/manifest.webmanifest | grep RudaTrak

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

### Error "port is already allocated" (puerto 3007)

**Causa:** Contenedores huérfanos de un `docker compose` previo (fuera de Portainer) bloquean el puerto.

```bash
docker stop carga-poi rudatrak-carga-poi 2>/dev/null
docker rm carga-poi rudatrak-carga-poi 2>/dev/null
docker network rm carga-poi_default 2>/dev/null
./deploy.sh
```

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
ls -la ~/RudaTrak/traccar-web/build/index.html

# 2. Verificar que la imagen se reconstruyó
docker images rudatrak --format '{{.CreatedAt}}'

# 3. Limpiar Service Worker en el navegador
# Chrome → candado en barra → Cookies y datos → Eliminar
# O usar modo incógnito para test

# 4. Limpiar caché de Cloudflare
# Dashboard → Caching → Purge Everything
```
