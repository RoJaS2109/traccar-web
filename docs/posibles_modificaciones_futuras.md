# Posibles Modificaciones Futuras

Registro de hallazgos, limitaciones y mejoras identificadas que quedan pendientes para el futuro.

---

## 1. Límite de 4000 filas en tabla de posiciones

**Archivo:** `src/reports/PositionsReportPage.jsx` línea 187

```javascript
items.slice(0, 4000).map((item) => ...
```

**Problema:** A ~600 posiciones/hora, 4000 filas cubren solo ~6.7 horas. Si se consulta un día completo, las posiciones más recientes quedan fuera de la tabla aunque la API las devuelve correctamente. La API (`REPORT_MAX_POSITIONS`) permite hasta 50000.

**Efecto observado:** Las posiciones parecen "congelarse" después de ~06:40 AM cuando se consulta el día completo, porque el array está en orden ascendente y `slice(0, 4000)` solo renderiza las primeras 4000 (las más antiguas).

**Solución propuesta:** Subir el límite a 50000 para igualar `REPORT_MAX_POSITIONS`, o implementar paginación/virtualización en la tabla.

**Workaround actual:** Usar rangos de fecha más cortos en el filtro del Reporte de Posiciones.

---

## 2. Migración de H2 a PostgreSQL

**Motivo:** H2 es una base de datos embebida. Para producción, Traccar recomienda PostgreSQL (o MySQL/MariaDB). Mejor rendimiento, backups, y soporte para múltiples conexiones concurrentes.

**Archivos involucrados:**
- `traccar.xml` (configuración de base de datos)
- `docker-compose.yml` (agregar servicio PostgreSQL)
- Volúmenes persistentes para datos de PostgreSQL

**Ver:** [`CLAUDE.md`](../../CLAUDE.md) sección "Base de datos" y documentación oficial de Traccar.

---

## 3. Descripción de eventos en la UI

**Problema:** Después del deploy con 44+ códigos de alarma y `getEventDescription()` en el decoder Rinho, las descripciones de eventos no se muestran como se esperaba en la interfaz.

**Posibles causas:**
- `eventDescription` no se está mostrando en la columna/tarjeta de eventos
- El texto no coincide con lo esperado
- Eventos informativos (`ALARM_GENERAL`) no se renderizan como "avisos"

**Ver:** [`../../CLAUDE.md`](../../CLAUDE.md) sección "Protocolo Rinho" y archivos de memoria.

---

## 4. Dominio `taip.rudatrak.com` sin entrada en NPM

**Problema:** `taip.rudatrak.com` (ex `gps.rudatrak.com`) está configurado en Cloudflare (nube gris, DNS only) pero no tiene entrada en Nginx Proxy Manager. Las peticiones a ese dominio no tienen destino si alguna vez se reactiva.

**Solución:** Agregar proxy host en NPM para `taip.rudatrak.com` → `traccar:8082`, con headers WebSocket.

---

*Última actualización: 9 de agosto de 2026*
