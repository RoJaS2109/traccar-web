# Guía de uso

## Acceso

- **URL producción:** `https://mh.rudatrak.com`
- **Herramienta POIs:** `http://raspi:3007` (solo red local)

## Mapa principal

### Capa de POIs (Puntos de Interés)

Los POIs son lugares útiles para viajeros: pernoctes, campings, duchas, wifi, talleres mecánicos, etc.

- **Activar/desactivar:** Ícono de capas (esquina superior derecha) → "POI Layer"
- **Ver información:** Clic en un ícono del mapa → popup con nombre y reseñas
- **Origen de datos:** `general.kml` (~6.600 puntos) + `Talleres_mecánicos...kml` (~1.710) + `CAMPING+MASCOTAS...kml` (~830)

### Categorías de íconos

| Ícono | Categoría |
|-------|-----------|
| 🏕️ Verde | Acampe libre / Pernocte libre |
| 🏕️ Amarillo | Camping de pago |
| 💧 Celeste | Toma de agua gratis |
| 🚿 Celeste | Duchas |
| ⚡ Ámbar | Tomacorriente gratis |
| 📡 Azul | WiFi |
| 🔥 Rojo | Gas / Recarga de garrafa |
| 👮 Gris | Control Aduanero / Policial |
| 👮 Rosa | Fitosanitario |
| 👮 Verde oscuro | Control de Gendarmería |
| 🟣 Lila | Laverrap |
| 🟢 Lima | Solo uso diurno |
| 🟤 Marrón | Aguas negras |
| 🛒 Naranja | Feriar / Vender |
| ⬜ Gris claro | Misceláneos / Varios |

### Rastreo GPS

- **Dispositivos:** Panel izquierdo → lista de dispositivos
- **Posición en tiempo real:** Se actualiza vía WebSocket
- **Historial:** Clic derecho en dispositivo → ver ruta

### Reportes

Disponibles desde el menú lateral:
- **Recorrido:** Ruta de un dispositivo en un período
- **Eventos:** Alarmas, excesos de velocidad, etc.
- **Resumen:** Distancia recorrida, tiempo de motor
- **Paradas:** Lugares donde se detuvo
- **Gráficos:** Velocidad, consumo (si hay datos OBD)

## Administración

### Agregar/Eliminar POIs

Usar la herramienta `carga-poi` desde la red local: `http://raspi:3007`

**Agregar:**
1. Completá nombre, coordenadas, categoría, autor y comentario
2. Clic en "Agregar POI"
3. El KML se actualiza automáticamente
4. Los cambios se reflejan en el mapa al activar la capa

**Eliminar:**
1. Activá el toggle "Eliminar" (esquina superior derecha)
2. Ingresá el nombre exacto del punto
3. Clic en "Buscar POI"
4. Escribí "ELIMINAR" y confirmá

### Preferencias del servidor

En **Settings → Server → Preferences:**

| Clave | Descripción | Valor |
|-------|-------------|-------|
| `poiLayer` | URL del KML de POIs | `/poi/general.kml` |

### Usuarios y dispositivos

Desde **Settings** se gestionan:
- Usuarios, dispositivos, grupos
- Geocercas (zonas con alertas)
- Notificaciones (web, email, SMS)
- Calendarios
- Comandos (enviar a dispositivos)
