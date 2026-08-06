# agente-ia

Agente IA para escaladas inteligentes en emergencias GPS - Detección de vuelcos y movimiento no autorizado con notificaciones multi-canal.

## MVP Features

- ✅ Webhook receptor de eventos Traccar (EventForwarder)
- ✅ Máquina de estados para escaladas (3 niveles de prioridad)
- ✅ Timers inteligentes con fallback automático
- ✅ Monitoreo de GPS post-vuelco
- ✅ Persistencia de estado en Redis
- ✅ Notificaciones por Telegram (SMS/WhatsApp en fase 2)
- ✅ Health check endpoint

## Estructura

```
src/
├── agents/
│   └── guardian.js           # Orquestador de escaladas
├── services/
│   ├── traccar-client.js     # Cliente API Traccar
│   ├── redis-client.js       # Persistencia de estado
│   ├── notifier.js           # Dispatcher de notificaciones
│   └── geofence.js           # Query geofences
├── routes/
│   └── webhooks.js           # POST /webhook/evento
├── models/
│   └── escalation-state.js   # Máquina de estados
├── config/
│   └── logger.js             # Winston logger
└── utils/
    └── validators.js         # Validadores
```

## Instalación

### En tu PC local

```bash
cd traccar-web/tools/agente-ia
npm install
npm run dev
```

### En Pi (Docker)

```bash
cd /mnt/Datos/app/traccar/

# Agregar a docker-compose.yml (ya está en la plantilla)
docker-compose up --build agente-ia

# O solo agente-ia si ya lo tienes en compose
docker-compose up -d agente-ia
```

## Configuración

### Variables de entorno (docker-compose)

```yaml
environment:
  - TRACCAR_API_URL=http://rudatrak:8082
  - TRACCAR_USERNAME=admin
  - TRACCAR_PASSWORD=tu_password
  - REDIS_URL=redis://rudatrak-redis:6379
  - TELEGRAM_BOT_TOKEN=tu_bot_token
  - WEBHOOK_TOKEN=token_secreto_para_validar
  - LOG_PATH=/app/logs
```

### Traccar (traccar.xml)

Agregar en `/data/compose/traccar/traccar-conf/traccar.xml`:

```xml
<!-- EventForwarder -->
<entry key='eventforwarder.enable'>true</entry>
<entry key='eventforwarder.url'>http://agente-ia:3008/webhook/evento</entry>
<entry key='eventforwarder.json'>true</entry>
<entry key='eventforwarder.header.authorization'>Bearer ${WEBHOOK_TOKEN}</entry>

<!-- Telegram -->
<entry key='notificator.telegram.enabled'>true</entry>
<entry key='notificator.telegram.key'>tu_bot_token</entry>
```

## Flujo de escalada

```
Evento Rollover (Traccar)
   ↓
POST /webhook/evento
   ↓
Agente Guardián
   ├─ ¿Zona segura? → fin (low priority)
   └─ ¿Zona insegura? → escalada
      ├─ Notif #1: Conducto (Telegram) — 5min timeout
      ├─ Notif #2: Propietario (Telegram + SMS) — 10min timeout
      ├─ Notif #3: Emergencias (SMS 911) — timeout: ninguno
      └─ Polling GPS: ¿movimiento? Cancelar escalada
```

## Canales de notificación

### MVP (Habilitado)
- **Telegram**: Para conducto y propietario

### Fase 2 (Placeholder)
- **SMS**: Para propietario y emergencias (requiere Twilio)
- **WhatsApp**: Para propietario (requiere Twilio)

## Testing

```bash
# Health check
curl http://localhost:3008/health

# Simular evento rollover
curl -X POST http://localhost:3008/webhook/evento \
  -H "Content-Type: application/json" \
  -d '{
    "event": {
      "type": "alarm",
      "alarm": "rollover",
      "deviceId": 42
    },
    "position": {
      "latitude": -38.72,
      "longitude": -62.27,
      "speed": 95
    }
  }'

# User response
curl -X POST http://localhost:3008/response \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId": 42,
    "priority": 1,
    "response": "OK"
  }'
```

## Logs

```bash
# En Docker
docker logs agente-ia

# Archivos
/data/compose/traccar/agente-ia-logs/
├── error.log
└── combined.log
```

## Próximas fases

### Fase 2
- [ ] Implementar SMS/WhatsApp (Twilio)
- [ ] Integración con Ollama para análisis de contexto
- [ ] Resúmenes batch diarios (Agente Analista)
- [ ] Dashboard de estado de escaladas
- [ ] Almacenamiento histórico en BD Traccar

### Fase 3
- [ ] Machine learning para detección de falsos positivos
- [ ] Predicción de zonas de riesgo
- [ ] Análisis de comportamiento del conductor

## Notas importantes

1. **Redis**: Esencial para persistencia de estado. Sin él, se pierden escaladas si el contenedor cae.
2. **Traccar Auth**: Usar credenciales admin con permisos para leer dispositivos y posiciones.
3. **Ollama**: Deshabilitado en MVP. Se integra en fase 2 para filtrado de falsos positivos.
4. **Timeouts**: Configurables en `src/agents/guardian.js` (TIMEOUTS object).

## Support

Para issues o preguntas, revisar logs en `/data/compose/traccar/agente-ia-logs/`.
