# Rudatrak — Documentación

Plataforma de rastreo GPS y mapa de puntos de interés para viajeros en Argentina y países limítrofes.

Basado en [Traccar](https://www.traccar.org/), personalizado con branding, íconos, capa de POIs y herramienta de carga colaborativa.

---

## Tabla de contenidos

| Documento | Descripción |
|-----------|-------------|
| [Arquitectura](arquitectura.md) | Stack tecnológico, infraestructura, componentes |
| [Guía de uso](guia-uso.md) | Cómo usar la app: mapa, POIs, dispositivos |
| [Comandos útiles](comandos.md) | Comandos frecuentes y solución de problemas |
| [Deploy](deploy.md) | Cómo desplegar en producción (Raspberry Pi) |

---

## Vista rápida

```
mh.rudatrak.com (Cloudflare)
    │
    ▼
Raspberry Pi (Docker)
    ├── rudatrak-traccar   ← Traccar + frontend + backend personalizados
    ├── rudatrak-agente-ia ← Agente IA para escaladas inteligentes
    ├── rudatrak-carga-poi ← API para agregar/eliminar POIs
    └── npm-www-1          ← Nginx (otros sitios)
```

**Repositorios:**
- Backend: `git@github.com:RoJaS2109/traccar` (fork privado de Traccar)
- Frontend: `git@github.com:RoJaS2109/traccar-web` (submódulo)
- Deploy Key: `HP-Victus` con write access en ambos
