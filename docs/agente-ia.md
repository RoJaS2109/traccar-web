# RudaTrak IA - Documentación Completa

**Agente de escaladas inteligentes para emergencias GPS**

Versión: 1.0.0 (MVP)  
Última actualización: Agosto 2026

---

## Tabla de Contenidos

1. [Introducción](#introducción)
2. [Arquitectura](#arquitectura)
3. [Requisitos](#requisitos)
4. [Instalación](#instalación)
5. [Configuración](#configuración)
6. [Uso](#uso)
7. [Flujo de Escalada](#flujo-de-escalada)
8. [Canales de Notificación](#canales-de-notificación)
9. [API Endpoints](#api-endpoints)
10. [Testing](#testing)
11. [Troubleshooting](#troubleshooting)
12. [Roadmap](#roadmap)
13. [FAQ](#faq)

---

## Introducción

### ¿Qué es agente-ia?

Servicio Node.js que orquesta escaladas inteligentes para emergencias GPS. Recibe eventos de Traccar (vuelcos, movimientos no autorizados) y dispara notificaciones multi-canal con lógica de escalada:

- **Nivel 1 (Conducto)**: Telegram — 5 minutos de timeout
- **Nivel 2 (Propietario)**: Telegram + SMS — 10 minutos de timeout
- **Nivel 3 (Emergencias)**: SMS 911 — timeout: ninguno

### ¿Por qué?

Traccar notifica eventos, pero **no escala**. Si el conductor no responde en 5 minutos, sigue esperando. Nosotros:

1. Enviamos notificación
2. Si no hay confirmación → escalamos a siguiente nivel
3. Si tampoco → alertamos a emergencias
4. Monitoreamos GPS paralelo → si se mueve, cancelamos

---

## Arquitectura

### Stack

```
┌─────────────────────────────────────────────────────────┐
│                      RudaTrak Stack                      │
├─────────────────────────────────────────────────────────┤
│  Traccar (Java) ──EventForwarder──> agente-ia (Node)  │
│                                          │               │
│                                    ┌─────┴─────┐         │
│                                    ▼           ▼         │
│                              Redis        Ollama(Fase2)  │
│                            (estado)                      │
└─────────────────────────────────────────────────────────┘
```

### Componentes

#### 1. **Guardian Agent** (`src/agents/guardian.js`)

Orquestador principal. Responsable de:
- Procesar eventos de vuelco
- Gestionar máquina de estados
- Iniciar timers de escalada
- Monitorear GPS

#### 2. **Services**

- **traccar-client.js**: Cliente HTTP para API Traccar
  - Obtener posiciones
  - Consultar dispositivos
  - Query geofences

- **redis-client.js**: Persistencia de estado
  - Guardar/recuperar escalación
  - Registrar respuestas de usuario
  - TTL configurable

- **notifier.js**: Dispatcher de canales
  - Telegram (MVP)
  - SMS (Fase 2)
  - WhatsApp (Fase 2)
  - Email (Fase 2)

- **ollama-client.js**: (Placeholder para Fase 2)
  - Análisis de contexto
  - Filtrado de falsos positivos

#### 3. **Models**

- **escalation-state.js**: Estados y transiciones
  - Estados posibles
  - Métodos para actualizar estado
  - Máquina de estados

#### 4. **Routes**

- **webhooks.js**: Endpoints HTTP
  - `POST /webhook/evento` — Recibe eventos Traccar
  - `POST /response` — Respuestas del usuario

---

## Requisitos

### Hardware (Pi5)

- Pi 5 con 8GB RAM ✓
- SSD 1TB ✓
- Conexión de red estable

### Software

- Node.js 20+
- Docker 24+
- Redis 7
- Traccar con EventForwarder configurado

### Credenciales

- **Telegram**: Bot token de @BotFather
- **Traccar**: Usuario admin con permisos de lectura

---

## Instalación

### 1. Clonar/Descargar agente-ia

#### Opción A: Desde tar.gz

```bash
cd /app/RudaTrak/traccar-web/tools/

# Descargar
wget https://mh.rudatrak.com/outputs/agente-ia.tar.gz

# Extraer
tar -xzf agente-ia.tar.gz

# Limpiar
rm agente-ia.tar.gz
```

#### Opción B: Git clone

```bash
cd /app/RudaTrak/

# Si ya está en git (después de hacer commit)
git pull origin main
```

### 2. Instalar dependencias (local en PC)

```bash
cd traccar-web/tools/agente-ia/

npm install
```

### 3. Levantar en Pi (Docker)

```bash
cd /app/RudaTrak/

# Build image
docker build -t agente-ia:latest ./traccar-web/tools/agente-ia/

# O si está en docker-compose
docker-compose up --build agente-ia

# Ver logs
docker logs rudatrak-agente-ia
```

### 4. Verificar que funciona

```bash
# Health check
curl http://localhost:3008/health

# Debe responder:
# {
#   "status": "ok",
#   "service": "agente-ia",
#   "redis": "connected",
#   "uptime": 15.234
# }
```

---

## Configuración

### A. docker-compose.yml

Los servicios `agente-ia`, `redis` y `ollama` ya están configurados en el `docker-compose.yml` del proyecto (`/app/RudaTrak/docker-compose.yml`). No se requiere configuración adicional. Ver el archivo para los detalles completos.

### B. traccar.xml

Agregar a `/data/compose/rudatrak/trak-conf/traccar.xml`:

```xml
<!-- EventForwarder para agente-ia -->
<entry key='eventforwarder.enable'>true</entry>
<entry key='eventforwarder.url'>http://agente-ia:3008/webhook/evento</entry>
<entry key='eventforwarder.json'>true</entry>
<entry key='eventforwarder.header.authorization'>Bearer ${WEBHOOK_TOKEN}</entry>

<!-- Telegram Notificador -->
<entry key='notificator.telegram.enabled'>true</entry>
<entry key='notificator.telegram.key'>TU_BOT_TOKEN</entry>
```

### C. Variables de entorno

```bash
# En Pi (Portainer o .env)
TRACCAR_PASSWORD=tu_password_admin
WEBHOOK_TOKEN=tu_token_secreto_aqui
TELEGRAM_BOT_TOKEN=123456789:ABCDEfghijklmnopqrstuvwxyz
```

### D. Tabla de Base de Datos (Traccar)

Crear archivo: `traccar/245-escalation-channels.xml` (changelog de Liquibase)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<databaseChangeLog
  xmlns="http://www.liquibase.org/xml/ns/dbchangelog"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.liquibase.org/xml/ns/dbchangelog
                      http://www.liquibase.org/xml/ns/dbchangelog/dbchangelog-3.8.xsd">

  <changeSet author="agente-ia" id="245-escalation-channels">
    <createTable tableName="tc_escalation_channels">
      <column name="id" type="BIGINT" autoIncrement="true">
        <constraints primaryKey="true"/>
      </column>
      <column name="device_id" type="BIGINT">
        <constraints nullable="false"/>
      </column>
      <column name="user_id" type="BIGINT">
        <constraints nullable="false"/>
      </column>
      <column name="channel_type" type="VARCHAR(20)">
        <constraints nullable="false"/>
      </column>
      <column name="value" type="VARCHAR(255)">
        <constraints nullable="false"/>
      </column>
      <column name="priority" type="INT">
        <constraints nullable="false"/>
      </column>
      <column name="active" type="BOOLEAN" defaultValue="true">
        <constraints nullable="false"/>
      </column>
      <column name="created_at" type="TIMESTAMP" defaultValueDate="CURRENT_TIMESTAMP">
        <constraints nullable="false"/>
      </column>
    </createTable>
    
    <addForeignKeyConstraint 
      baseTableName="tc_escalation_channels" 
      baseColumnNames="device_id"
      referencedTableName="tc_devices" 
      referencedColumnNames="id"/>
      
    <addForeignKeyConstraint 
      baseTableName="tc_escalation_channels" 
      baseColumnNames="user_id"
      referencedTableName="tc_users" 
      referencedColumnNames="id"/>
      
    <createIndex tableName="tc_escalation_channels" indexName="idx_device_escalation">
      <column name="device_id"/>
    </createIndex>
  </changeSet>

</databaseChangeLog>
```

---

## Uso

### Flujo manual (testing)

```bash
# Terminal 1: Ver logs
docker logs -f rudatrak-agente-ia

# Terminal 2: Simular evento de vuelco
curl -X POST http://localhost:3008/webhook/evento \
  -H "Content-Type: application/json" \
  -d '{
    "event": {
      "type": "alarm",
      "alarm": "rollover",
      "deviceId": 42
    },
    "position": {
      "latitude": -38.7245,
      "longitude": -62.2719,
      "speed": 95,
      "timestamp": 1722873456000
    }
  }'

# Terminal 3: Simular respuesta del usuario (conducto confirma en 2 minutos)
sleep 120 && curl -X POST http://localhost:3008/response \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId": 42,
    "priority": 1,
    "response": "OK"
  }'
```

### En producción (automático)

1. Traccar detecta vuelco (acelerómetro del dispositivo)
2. Traccar envía evento a agente-ia vía EventForwarder
3. agente-ia procesa automáticamente
4. Usuario responde a notificación Telegram
5. Escalada se cancela o continúa según respuesta

---

## Flujo de Escalada

### Estados posibles

```
IDLE
  ↓ [evento vuelco]
ROLLOVER_DETECTED
  ├─ ¿zona segura?
  │  └─ Sí → IDLE (fin, notif baja prioridad)
  └─ ¿zona insegura?
     └─ Sí → UNSAFE_ZONE
        ├─ Enviar notif priority 1 (conducto)
        ├─ timeout 5min
        ├─ ¿confirmó?
        │  ├─ Sí → MANAGED (fin)
        │  └─ No → DRIVER_NO_RESPONSE
        │     ├─ Enviar notif priority 2 (propietario)
        │     ├─ timeout 10min
        │     ├─ ¿confirmó?
        │     │  ├─ Sí → MANAGED (fin)
        │     │  └─ No → OWNER_NO_RESPONSE
        │     │     ├─ Enviar notif priority 3 (emergencias)
        │     │     └─ ESCALATED_EMERGENCY
        │
        └─ [Polling GPS paralelo]
           ├─ ¿movimiento? → MOBILE_POST_ROLLOVER (cancelar escalada)
           └─ ¿60min sin movimiento? → IMMOBILE_60MIN (crítico)
```

### Timeouts

```javascript
DRIVER_TIMEOUT: 5 * 60 * 1000,      // 5 minutos
OWNER_TIMEOUT: 10 * 60 * 1000,      // 10 minutos
GPS_CHECK_INTERVAL: 10 * 1000,      // Revisar GPS cada 10 segundos
IMMOBILE_THRESHOLD: 60 * 60 * 1000, // 60 minutos sin movimiento
```

Configurables en `src/agents/guardian.js`.

---

## Canales de Notificación

### MVP (Habilitado)

#### Telegram

**Habilitado en:** Traccar + agente-ia
**Pasos:**

1. Crear bot con @BotFather en Telegram
2. Obtener token (ej: `123456789:ABCDEfg...`)
3. Configurar en traccar.xml:
   ```xml
   <entry key='notificator.telegram.enabled'>true</entry>
   <entry key='notificator.telegram.key'>TU_BOT_TOKEN</entry>
   ```
4. En agente-ia, la config ya está lista

**Formato de mensajes:**

```
🚨 ALERTA DE VUELCO - Dispositivo 42

Tipo de evento: rollover
Ubicación: -38.7245, -62.2719
Velocidad previa: 95 km/h
Hora: 05/08/2026 23:30:45

Por favor CONFIRMA que estás bien escribiendo "OK" o llamando.
```

### Fase 2 (Placeholder)

#### SMS (Twilio)

Estado: **No implementado en MVP**

```xml
<entry key='notificator.sms.enabled'>true</entry>
<entry key='notificator.sms.provider'>twilio</entry>
<entry key='notificator.sms.twilio.account'>ACxxxxx</entry>
<entry key='notificator.sms.twilio.authtoken'>xxxxx</entry>
<entry key='notificator.sms.twilio.from'>+1234567890</entry>
```

#### WhatsApp (Twilio)

Estado: **No implementado en MVP**

Similar a SMS, usando números WhatsApp.

---

## API Endpoints

### POST /webhook/evento

**Descripción:** Recibe eventos de Traccar EventForwarder

**Headers:**
```
Authorization: Bearer ${WEBHOOK_TOKEN}
Content-Type: application/json
```

**Body:**
```json
{
  "event": {
    "type": "alarm",
    "alarm": "rollover",
    "deviceId": 42,
    "serverTime": 1722873456000
  },
  "position": {
    "latitude": -38.7245,
    "longitude": -62.2719,
    "speed": 95,
    "deviceTime": 1722873456000
  }
}
```

**Response:**
```json
{
  "success": true,
  "escalationId": 42
}
```

### POST /response

**Descripción:** Procesar respuesta del usuario a notificación

**Body:**
```json
{
  "deviceId": 42,
  "priority": 1,
  "response": "OK"
}
```

**Response:**
```json
{
  "success": true
}
```

### GET /health

**Descripción:** Health check

**Response:**
```json
{
  "status": "ok",
  "service": "agente-ia",
  "environment": "production",
  "uptime": 15234,
  "redis": "connected"
}
```

---

## Testing

### 1. Unit Tests (placeholder)

```bash
npm test
```

### 2. Integration Test (local)

```bash
# Terminal 1: Dev server
npm run dev

# Terminal 2: Test eventos
bash scripts/test-rollover.sh
```

### 3. E2E Test (Pi)

```bash
# Health check
curl http://localhost:3008/health

# Simular vuelco
curl -X POST http://localhost:3008/webhook/evento \
  -H "Content-Type: application/json" \
  -d '{
    "event": {"type": "alarm", "alarm": "rollover", "deviceId": 42},
    "position": {"latitude": -38.72, "longitude": -62.27, "speed": 95}
  }'

# Ver logs
docker logs rudatrak-agente-ia

# Verificar Redis
docker exec rudatrak-redis redis-cli
> keys escalation:*
> get escalation:device:42
```

### 4. Telegram Test

```bash
# Obtener chat_id de tu bot
# Enviar mensaje a tu bot (@tu_bot_username)
# Ejecutar curl contra la API de Telegram

curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates"
```

---

## Troubleshooting

### Problema: Redis no conecta

**Síntoma:** `Redis client error: connect ECONNREFUSED`

**Solución:**
```bash
# Verificar que Redis está corriendo
docker ps | grep redis

# Reiniciar Redis
docker restart rudatrak-redis

# Verificar conexión
docker exec rudatrak-redis redis-cli ping
# Debe responder: PONG
```

### Problema: Traccar no envía eventos

**Síntoma:** Ningún evento llega a agente-ia

**Solución:**
```bash
# 1. Verificar EventForwarder en traccar.xml
docker exec rudatrak-traccar cat /opt/traccar/conf/traccar.xml | grep eventforwarder

# 2. Verificar que agente-ia está corriendo
curl http://localhost:3008/health

# 3. Revisar logs de Traccar
docker logs rudatrak-traccar | grep -i forward

# 4. Probar conectividad
docker exec rudatrak-traccar ping agente-ia
```

### Problema: Notificaciones no llegan

**Síntoma:** Evento se procesa pero no hay Telegram

**Solución:**
```bash
# 1. Verificar token
docker logs rudatrak-agente-ia | grep -i telegram

# 2. Verificar que chat_id es correcto
# En src/services/notifier.js, línea donde se configura chat_id

# 3. Probar manualmente
curl -X POST https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage \
  -d "chat_id=12345678&text=Test"

# 4. Ver logs detallados
docker logs rudatrak-agente-ia
```

### Problema: Redis lleno (memory)

**Síntoma:** `NOSCRIPT` errors o Redis no responde

**Solución:**
```bash
# Conectar a Redis
docker exec rudatrak-redis redis-cli

# Ver memoria
INFO memory

# Limpiar escalaciones viejas
KEYS escalation:*
DEL escalation:device:*

# O configurar maxmemory policy
CONFIG SET maxmemory-policy allkeys-lru
CONFIG REWRITE
```

---

## Roadmap

### ✅ MVP (Actual)

- [x] Webhook receptor de eventos
- [x] Máquina de estados
- [x] Notificaciones Telegram
- [x] Timers de escalada
- [x] Persistencia en Redis
- [x] Monitoreo de GPS

### 📋 Fase 2 (Q3 2026)

- [ ] SMS y WhatsApp (Twilio)
- [ ] Integración Ollama
- [ ] Filtrado de falsos positivos
- [ ] Resúmenes batch diarios
- [ ] Dashboard de escaladas
- [ ] Tabla `tc_escalation_channels` en UI Traccar

### 🎯 Fase 3 (Q4 2026)

- [ ] Machine learning para patrones
- [ ] Predicción de zonas de riesgo
- [ ] Análisis de comportamiento del conductor
- [ ] Integración con sistemas de emergencia (SAME)
- [ ] Reportes históricos

---

## FAQ

**P: ¿Qué pasa si agente-ia cae?**

R: Redis mantiene el estado. Al reiniciar, recupera escaladas en progreso. Si está en un timer (ej: esperando 10min), lo continuará desde donde paró.

**P: ¿Puedo cambiar los timeouts?**

R: Sí. En `src/agents/guardian.js`, objeto `TIMEOUTS`. Pero requiere rebuild del contenedor.

**P: ¿Cómo agrego otro canal de notificación?**

R: 
1. Agregar case en `src/services/notifier.js`
2. Implementar función `sendMyChannel()`
3. Crear tabla en `tc_escalation_channels`
4. Testear

**P: ¿Dónde ver el historial de escaladas?**

R: 
- Logs: `/data/compose/rudatrak/agente-ia-logs/`
- Redis: `docker exec rudatrak-redis redis-cli KEYS escalation:*`
- Fase 2: DB de Traccar (tabla nueva)

**P: ¿Puedo tener varios dispositivos escalando en paralelo?**

R: Sí. Cada dispositivo es una key en Redis (`escalation:device:{deviceId}`). Soporta múltiples escaladas concurrentes.

**P: ¿Cómo cancelo una escalada manualmente?**

R: 
```bash
docker exec rudatrak-redis redis-cli
> DEL escalation:device:42
```

O desde API (Fase 2):
```bash
POST /escalation/42/cancel
```

---

## Support

### Logs

```bash
# Tiempo real
docker logs -f rudatrak-agente-ia

# Últimas 100 líneas
docker logs --tail 100 agente-ia

# Archivos
cat /data/compose/rudatrak/agente-ia-logs/combined.log
cat /data/compose/rudatrak/agente-ia-logs/error.log
```

### Contacto

Para issues o preguntas:
1. Revisar logs (`docker logs rudatrak-agente-ia`)
2. Verificar configuración (traccar.xml, docker-compose.yml)
3. Testear endpoints (`curl http://localhost:3008/health`)
4. Revisar FAQ arriba

---

## Licencia

MIT

## Autor

RudaTrak Team

---

**Última actualización:** Agosto 6, 2026
