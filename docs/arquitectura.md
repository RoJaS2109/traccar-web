# Arquitectura

## Stack tecnológico

### Frontend (React SPA)

| Tecnología | Versión | Uso |
|------------|---------|-----|
| React | 19 | UI |
| Vite | 8 | Bundler y dev server |
| Material UI | 9 | Componentes |
| MapLibre GL | 5 | Mapa principal |
| Redux Toolkit | 2 | Estado global |
| React Router | 7 | Enrutamiento |
| dayjs | 1 | Fechas |
| tss-react | 4 | Estilos (makeStyles) |
| Recharts | 3 | Gráficos de reportes |

### Backend (Java)

| Tecnología | Uso |
|------------|-----|
| Traccar Server | API REST + WebSocket |
| H2 Database | Base de datos embebida |
| Jetty | Servidor HTTP |

### Infraestructura

| Componente | Descripción |
|------------|-------------|
| Raspberry Pi | Servidor físico |
| Docker | Contenedores |
| Portainer | Gestión de stacks |
| Nginx Proxy Manager | Proxy inverso, SSL vía Let's Encrypt |
| Cloudflare | DNS, CDN, caché |
| GitHub | Repositorio privado de código |

---

## Componentes del sistema

```
┌─────────────────────────────────────────────────┐
│                   Internet                       │
│  mh.rudatrak.com ──► Cloudflare ──► Pi (puerto 80) │
└─────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────┐
│              Nginx Proxy Manager                 │
│  mh.rudatrak.com → rudatrak-traccar:8082        │
│  API: /api/*, /poi/*     Static: /icons/*       │
└─────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────┐
│           Stack: rudatrak (Portainer)            │
│                                                  │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐     │
│  │ rudatrak-traccar │  │rudatrak-agente-ia│  │rudatrak-carga-poi│  │ rudatrak-redis   │  │ rudatrak-ollama  │    │
│  │                  │  │                  │  │                  │  │                  │  │                  │     │
│  │ Traccar +        │  │ Agente IA        │  │ Node.js/Express  │  │ Redis 7 Alpine   │  │ Ollama           │     │
│  │ Frontend         │  │ Escaladas        │  │ API REST         │  │ Cache/Estado     │  │ Modelos LLM      │     │
│  │ Puerto: 8082     │  │ Puerto: 3008     │  │ Puerto: 3007     │  │ Puerto: 6379     │  │ Puerto: 11434    │     │
│  └──────┬───────────┘  └──────┬───────────┘  └──────┬───────────┘  └──────┬───────────┘  └──────┬───────────┘     │
│         │                     │                     │                     │                     │                  │
│         ▼                     ▼                     ▼                     ▼                     ▼                  │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐     │
│  │ /data/compose/   │  │ agente-ia-logs/  │  │ general.kml      │  │ redis-data/      │  │ ollama/          │     │
│  │  rudatrak/       │  │                  │  │ (bind mount)     │  │                  │  │                  │     │
│  │  trak-data/      │  │                  │  │                  │  │                  │  │                  │     │
│  │  trak-poi/       │  │                  │  │                  │  │                  │  │                  │     │
│  │  trak-logs/      │  │                  │  │                  │  │                  │  │                  │     │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘  └──────────────────┘  └──────────────────┘     │
└─────────────────────────────────────────────────┘
```

## Datos persistentes en la Pi

| Ruta | Contenido | Montado en |
|------|-----------|------------|
| `/data/compose/rudatrak/trak-data/` | Base de datos H2 | `/opt/traccar/data` |
| `/data/compose/rudatrak/trak-poi/` | Archivos KML | `/opt/traccar/web/poi` |
| `/data/compose/rudatrak/trak-logs/` | Logs del servidor | `/opt/traccar/logs` |

## Imágenes Docker

| Imagen | Origen | Actualización |
|--------|--------|---------------|
| `rudatrak:latest` | Build local (`Dockerfile` multi-stage) | `./deploy.sh` |
| `agente-ia:latest` | Build local (`tools/agente-ia/Dockerfile`) | `./deploy.sh` |
| `carga-poi:latest` | Build local (`tools/carga-poi/Dockerfile`) | `./deploy.sh` |
| `traccar/traccar:latest` | Docker Hub (base de `rudatrak`) | `docker pull` |
| `eclipse-temurin:21-jdk` | Docker Hub (solo stage builder) | Una sola vez |

## Redes Docker

| Red | Contenedores | Propósito |
|-----|-------------|-----------|
| `npm_proxy-network` | NPM, rudatrak-traccar, rudatrak-agente-ia, rudatrak-carga-poi, rudatrak-redis, rudatrak-ollama | Comunicación interna |

## Repositorios

```
/mnt/Datos/app/RudaTrak/
└── traccar/                      # Traccar Server (Java 21, Gradle) — fork privado
    ├── src/                      # Código Java del backend
    │   └── .../OverrideTextFilter.java  # Branding: defaults RudaTrak
    └── traccar-web/              # React SPA (submódulo git)
        ├── src/                  # Frontend React
        │   ├── map/main/PoiMap.js    # Capa de POIs (5 subcapas, ver abajo)
        │   ├── map/core/MapView.jsx  # Singleton del mapa (localIdeographFontFamily)
        │   ├── UpdateController.jsx  # Service Worker updates (PWA)
        │   ├── login/            # Páginas de login
        │   ├── common/theme/     # Tema MUI (paleta, colores)
        │   └── ...
        ├── docker/               # Fuentes Java para build multi-stage
        │   └── org/traccar/web/OverrideTextFilter.java
        ├── public/icons/         # Íconos de categorías (31 archivos)
        ├── public/pwa-*.png      # Íconos PWA (64, 192, 512 px)
        ├── data/                 # Archivos KML fuente
        ├── tools/                # Herramientas auxiliares
        │   ├── carga-poi/        # Servidor Node.js para gestión de POIs
        │   └── agente-ia/        # Agente IA para escaladas inteligentes
        ├── Dockerfile            # Multi-stage: compila + parchea backend
        ├── deploy.sh             # Script de build y deploy (Portainer API)
        ├── vite.config.js        # Vite + PWA plugin (manifest, workbox)
        └── docs/                 # Documentación
```

**URLs SSH:**
- Backend: `git@github.com:RoJaS2109/traccar` (fork privado de traccar/traccar)
- Frontend: `git@github.com:RoJaS2109/traccar-web` (submódulo)

Ambos usan Deploy Key `HP-Victus` configurada en GitHub con write access.

## PWA (Progressive Web App)

La app es instalable como PWA. Al visitar el sitio desde un navegador móvil, muestra el prompt nativo "Instalar" / "Agregar a pantalla de inicio".

| Componente | Archivo |
|-----------|---------|
| Service Worker | Generado por `vite-plugin-pwa` en `vite.config.js` |
| Manifest | `vite.config.js` → `manifest: { short_name: '${title}', ... }` |
| Actualización | `src/UpdateController.jsx` — verifica cada 1h si hay nueva versión |
| Íconos | `public/pwa-*.png` + `public/apple-touch-icon-180x180.png` |

### Branding (RudaTrak)

El frontend usa placeholders `${title}`, `${description}`, `${colorPrimary}` en `index.html` y `vite.config.js`. El backend los reemplaza al servir los archivos mediante `OverrideTextFilter.java`:

```java
String title = server.getString("title", "RudaTrak");
String description = server.getString("description", "RudaTrak GPS Tracking");
String colorPrimary = server.getString("colorPrimary", "#1976d2");
```

Los defaults se cambiaron de "Traccar" a "RudaTrak". Si se configuran atributos en la UI (Settings → Server), esos tienen prioridad.

El parche del backend se aplica durante `docker build` vía Dockerfile multi-stage (stage builder compila `OverrideTextFilter.java` con JDK 21 y parchea el JAR).

## PoiMap — Capas del mapa

`src/map/main/PoiMap.js` renderiza puntos de interés desde KML en 5 capas:

| Capa | Tipo | Filtro | Click |
|------|------|--------|-------|
| `poi-fill` | fill | Polygons | ✅ |
| `poi-point` | symbol | Points + icono | ✅ (async) |
| `poi-circle` | circle | Points sin icono | ✅ |
| `poi-line` | line | LineStrings | ✅ |
| `poi-title` | symbol | Todos (texto) | ✅ |

**Importante:** `poi-point` se agrega asincrónicamente (carga iconos remotos). Todas las capas tienen click handler que abre un popup HTML con nombre + descripción.

**Problema conocido:** En Android, los glyphs de `cdn.traccar.com/map/fonts/` a veces no cargan → el texto no se renderiza en las capas symbol. El popup HTML es el mecanismo confiable para ver la información.
