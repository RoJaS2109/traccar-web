# Comandos útiles

## Desarrollo local

```bash
# Iniciar servidor de desarrollo (puerto 3001)
npm start

# Build de producción
npm run build

# Lint
npm run lint
npm run lint:fix
```

El dev server hace proxy de `/api` y `/poi` al servidor de producción (configurado en `vite.config.js`).

## Deploy en la Pi

```bash
# Conectar por SSH
ssh pi@raspi

# Pull y deploy completo
cd ~/RudaTrak/traccar-web && ./deploy.sh
```

O desde tu PC en un solo paso:

```bash
cd /mnt/Datos/app/RudaTrak/traccar/traccar-web
git add . && git commit -m "..." && git push
ssh pi@raspi "cd ~/RudaTrak/traccar-web && ./deploy.sh"
```

## Docker

```bash
# Ver contenedores del stack
docker ps --filter "name=rudatrak"

# Logs de Traccar
docker logs -f rudatrak-traccar

# Logs de carga-poi
docker logs -f rudatrak-carga-poi

# Reiniciar un servicio
docker restart rudatrak-traccar

# Reconstruir imágenes manualmente
docker build -t rudatrak:latest ~/RudaTrak/traccar-web
docker build -t agente-ia:latest ~/RudaTrak/traccar-web/tools/agente-ia
docker build -t carga-poi:latest ~/RudaTrak/traccar-web/tools/carga-poi

# Ver imágenes locales
docker images | grep -E "rudatrak|carga-poi"
```

## Portainer

- **URL:** `http://localhost:9000`
- **Usuario:** `rodrigo`
- **Stack:** `rudatrak` → gestiona `traccar` + `carga-poi`
- **Redeploy manual:** Stacks → rudatrak → Update the stack
- **Redeploy automático:** `./deploy.sh` usa la API de Portainer

### API de Portainer

```bash
# Autenticar y obtener token
curl -s -X POST "http://localhost:9000/api/auth" \
  -H "Content-Type: application/json" \
  -d '{"username":"rodrigo","password":"..."}' | python3 -c "import sys,json; print(json.load(sys.stdin)['jwt'])"

# Listar stacks
curl -s -X GET "http://localhost:9000/api/stacks" \
  -H "Authorization: Bearer TOKEN" | python3 -m json.tool

# Redeploy de stack
curl -s -X PUT "http://localhost:9000/api/stacks/ID?endpointId=ENDPOINT" \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"StackFileContent":"...","Env":[],"Prune":false,"PullImage":false}'
```

## KMLs y POIs

```bash
# Contar placemarks
grep -c '<Placemark>' data/general.kml

# Buscar por nombre
grep '<name>' data/general.kml | grep -i "busqueda"

# Rebuild y redeploy de carga-poi (en la Pi)
docker build --no-cache -t carga-poi:latest ~/RudaTrak/traccar-web/tools/carga-poi/
docker rm -f rudatrak-carga-poi
docker run -d --name rudatrak-carga-poi --network npm_proxy-network -p 3007:3007 \
  -v /data/compose/traccar/traccar-poi/general.kml:/data/kml/general.kml \
  --restart unless-stopped carga-poi:latest

# Logs de carga-poi
docker logs -f rudatrak-carga-poi

# Ver últimos cambios en el KML
tail -50 /data/compose/traccar/traccar-poi/general.kml

# Forzar actualización en el mapa
# (recargar la página con Ctrl+Shift+R)
```

## Nginx

```bash
# Ver configuración
cat /home/web/nginx-custom.conf

# Editar configuración
sudo nano /home/web/nginx-custom.conf

# Reiniciar nginx
docker restart npm-www-1

# Ver logs de nginx
docker logs npm-www-1
```

## Solución de problemas

### Los POIs se ven pero el popup aparece vacío

Este es un problema conocido en Android Chrome. Las capas de texto (`poi-title`) pueden interferir con los clicks.

**Solución aplicada:** Click handlers en las 5 capas POI (`poi-point`, `poi-circle`, `poi-title`, `poi-fill`, `poi-line`). Ver `src/map/main/PoiMap.js`.

Si vuelve a ocurrir:
1. Verificar que las 5 capas tengan `map.on('click', ...)` registrado
2. Probar en modo incógnito (descarta service worker cache)
3. Verificar que `localIdeographFontFamily: 'sans-serif'` esté en `MapView.jsx`

### Los íconos de POI se ven pero el texto no

Problema de glyphs en Android. Las fuentes del mapa se descargan de `cdn.traccar.com/map/fonts/` y a veces no son accesibles desde Android.

**Workaround:** El popup HTML (que sí funciona) muestra el nombre y descripción completos.

### Los POIs no se ven en el mapa

```bash
# 1. ¿El KML es accesible?
curl -I https://gps.rudatrak.com/poi/general.kml
# Debe devolver HTTP 200

# 2. ¿La preferencia poiLayer está configurada?
# Ir a Settings → Server → Preferences → poiLayer = /poi/general.kml

# 3. ¿La capa está activada en el mapa?
# Ícono de capas (esquina superior derecha) → POI Layer
```

### El frontend se ve desactualizado (versión vieja)

```bash
# 1. Verificar branding
curl -s https://gps.rudatrak.com/manifest.webmanifest | grep -E "RudaTrak|Traccar"

# 2. Limpiar Service Worker (en el navegador)
# Chrome → candado en barra → Cookies y datos → Eliminar
# O usar modo incógnito para test

# 3. Limpiar caché de Cloudflare
# Dashboard → Caching → Purge Everything

# 4. Verificar que el contenedor use la imagen correcta
docker inspect rudatrak-traccar --format '{{.Config.Image}}'
docker images rudatrak --format '{{.CreatedAt}}'

# 5. Reconstruir y redeploy (vía Portainer API)
cd ~/RudaTrak/traccar-web && ./deploy.sh

# 6. Si el contenedor no se recrea, forzar manualmente
docker stop rudatrak-traccar && docker rm rudatrak-traccar
# Luego redeploy desde Portainer o ./deploy.sh
```

### Error de conexión WebSocket

El error `WebSocket connection to 'wss://.../api/socket' failed: 405` es normal si NPM no tiene configurado el upgrade de WebSocket. La app usa polling como fallback, así que no afecta la funcionalidad.

### La base de datos se corrompió

```bash
# Backup de la DB H2
sudo cp /data/compose/traccar/traccar-data/database.mv.db \
        /data/compose/traccar/traccar-data/database.mv.db.bak

# Restaurar
docker stop rudatrak-traccar
sudo cp /data/compose/traccar/traccar-data/database.mv.db.bak \
        /data/compose/traccar/traccar-data/database.mv.db
docker start rudatrak-traccar
```
