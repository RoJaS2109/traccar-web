# Protocolo Rinho — Documentación completa

> Basado en el protocolo del tracker GPS Rinho IoT (`EG915U + LC86G`).  
> Implementación en `org.traccar.protocol.RinhoProtocol*`.

---

## 1. Formato de mensajes

Todo mensaje sigue esta estructura:

```
>BODY;#NNNN;ID=XXXX;*CC<
```

| Campo | Descripción |
|-------|-------------|
| `>` | Delimitador de inicio |
| `BODY` | Tipo de reporte + datos (ver §2) |
| `;#NNNN` | Número de mensaje en hex (4 dígitos). `< 0x8000` = reporte automático, `≥ 0x8000` = respuesta a comando |
| `;ID=XXXX` | Identificador del dispositivo (ej. `KJA-169`) |
| `;*CC` | Checksum XOR en hex (2 dígitos mayúscula) |
| `<` | Delimitador de fin |

### Checksum XOR

Se calcula sobre todos los bytes ASCII entre `>` (inclusive) y `*` (inclusive):

```java
// RinhoProtocolDecoder.java:458
public static String calculateChecksum(String partial) {
    int checksum = 0;
    for (byte b : partial.getBytes(StandardCharsets.US_ASCII)) {
        checksum ^= b;
    }
    return String.format("%02X", checksum);
}
```

**Ejemplo:** para `>RCQ00080726143025-...;ID=KJA-169;*`, se calcula el XOR de cada byte y se formatea en hex.

---

## 2. Convención G-Q-R (comandos y respuestas)

La cuarta letra del prefijo indica la dirección del mensaje:

| Letra | Significado | Dirección |
|-------|------------|-----------|
| `S` | **S**et | Servidor → Dispositivo (comando) |
| `Q` | **Q**uery | Servidor → Dispositivo (consulta) |
| `G` | **G**enerate | Servidor → Dispositivo (orden de generar reporte) |
| `R` | **R**esponse | Dispositivo → Servidor (respuesta/reporte) |

### Formato de comandos G

```
Gaabbc
```

Donde:
- `aa` = tipo de reporte (`CQ`, `CY`, `GP`, etc.)
- `bb` = número de reporte/código de evento en hex (00–FF)
- `c` = prioridad (`H`=High, `M`=Medium, `L`=Low)

**Ejemplo:** `GCQ00H` → Generar reporte CQ con código 00, prioridad alta.  
El dispositivo responde con `RCQ00...` donde `00` es el `event2` (código de evento).

### Reglas del dispositivo

Una regla típica se ve así:
```
>RL00E;TRG=TD00+;ACC={GCQ00H};ID=KJA-169;*5E<
```

- `RL00E` — regla 00 habilitada
- `TRG=TD00+` — trigger: timer D00 activo
- `ACC={GCQ00H}` — acción: generar `GCQ00H`

---

## 3. Tipos de reporte del dispositivo

### 3.1. RCQ — Reporte de Condición (principal)

El reporte más completo. Incluye coordenadas, velocidad, entradas/salidas, GPS, GSM y odómetro.

```
>RCQ{event2}{MM2}{DD2}{YY2}{HH2}{MM2}{SS2}
    {±lat7}{±lon8}{speed3}{course3}
    {inputs2}{outputs2}{voltage3}{odometer8hex}
    {gpsPower1}{gpsFix1}{pdop2}{sat2}{age4hex}
    {gsmPower1}{gsmStatus1}{gsmLevel2}
    ;TXT={msg};#{num};ID={id};
```

| Campo | Posición | Formato | Descripción |
|-------|----------|---------|-------------|
| `event2` | 1 | 2 hex | Código de evento (ver §4) |
| `MM2 DD2 YY2` | 2–4 | 2+2+2 dígitos | Fecha UTC (mes, día, año) |
| `HH2 MM2 SS2` | 5–7 | 2+2+2 dígitos | Hora UTC |
| `±lat7` | 8 | ±DD.DDDDD | Latitud en DEG_DEG (7 dígitos) |
| `±lon8` | 9 | ±DDD.DDDDD | Longitud en DEG_DEG (8 dígitos) |
| `speed3` | 10 | 3 dígitos | Velocidad en nudos |
| `course3` | 11 | 3 dígitos | Rumbo 0–360° |
| `inputs2` | 12 | 2 hex | Entradas digitales |
| `outputs2` | 13 | 2 hex | Salidas digitales |
| `voltage3` | 14 | 3 dígitos | Voltaje batería ÷ 10 |
| `odometer8` | 15 | 8 hex | Odómetro en metros |
| `gpsPower` | 16 | 1 char | `A`=ON, `0`=OFF |
| `gpsFix` | 17 | 1 char | `3`=3D, `2`=2D, `1`=no fix |
| `pdop2` | 18 | 2 dígitos | PDOP |
| `sat2` | 19 | 2 dígitos | Satélites |
| `age4` | 20 | 4 hex | Edad del fix GPS |
| `gsmPower` | 21 | 1 dígito | Módem GSM (0–4) |
| `gsmStatus` | 22 | 1 char | Estado de red |
| `gsmLevel2` | 23 | 2 dígitos | CSQ (0–31) o 99 |
| `rest` | 24 | libre | `;TXT=...;#NNNN;ID=...;...` |

### 3.2. RER — Reporte Extendido con CAN bus

Igual estructura base que RCQ, más un bloque CAN al final:

```
>RER...{base_rcq};{CAN_DATA};ID=XXXX<
```

Donde `CAN_DATA` tiene formato `PGN=valor,PGN=valor,...` o `PGN!empty,...` (sensor no disponible).

PGNs soportados (J1939 + OBD-II):

| Token | Significado | Atributo Traccar |
|-------|------------|-----------------|
| `2010`, `2` | RPM motor | `engineSpeed` |
| `5000` | Pedal acelerador % | `accelPct` |
| `1030`, `14` | Combustible usado | `fuelUsed` |
| `4201`, `15` | Nivel combustible % | `fuelPct` |
| `1020`, `B` | Odómetro total | `odometerTotal` |
| `1010`, `3` | Velocidad | `speed` (OBD) |
| `2012`, `2A` | Temp. motor | `engineTemp` |
| `2013`, `2C` | Presión aceite | `oilPress` |
| `2020` | Horas motor | `timeEngineOn` |
| `3010` | Comb. viaje | `fuelTrip` |

### 3.3. RCR — Reporte Compacto

Versión reducida del RCQ (sin GPS ni GSM). Usado para eventos que no requieren todos los datos de telemetría.

### 3.4. Otros tipos de reporte

| Prefijo | Descripción | Datos adicionales |
|---------|------------|-------------------|
| `RCW` | Compacto WiFi | Course antes de speed, odómetro decimal |
| `RCY` | Standard con Altitud | `±alt5` entre course e IGN |
| `RGP` | GPS simplificado | Lat, lon, speed, course, fix, edad, IGN+IN |
| `RAD` | Analógico (8 canales) | AIN00–05 + bat principal + backup |
| `RAE` | Analógico con signo | ±dddd para cada canal |
| `RIO` | Entradas/Salidas | IGN, IN binario, XP, voltajes |
| `REQ` | CAN bus OBD-II | PIDs OBD-II (`2=RPM,3=speed,B=odo,15=fuel,...`) |
| `RVR` | Versión firmware | String de versión |
| `RSN` | Número de serie | Hex del serial |
| `RIMEI` | IMEI | Número IMEI |
| `RTAG` | Tag | String del tag |
| `RCXHWI` | Hardware ID | ID del hardware |
| `RTX` | Texto | Mensaje de texto libre |
| `RIB` | iButton + temp | ID iButton (16 hex) + signo temp + 4 temp + 2 edad |
| `RSC` | Sensor contacto | Datos de sensores de contacto |
| `RLC` | Locator por celda | Lat/lon obtenidos por torres celulares |
| `RHT` | Link a mapas | URL de Google Maps con la posición |
| `KA` | Keep-alive | Sin datos, mantiene NAT activa |
| `ACK` | Confirmación | Respuesta a comando del servidor |

### 3.5. Variantes CQ con sufijos extendidos

El patrón base RCQ se reutiliza con sufijos que agregan datos:

| Prefijo | Sufijo | Datos extra |
|---------|--------|------------|
| `RCP` | — | RCQ sin sufijo (posición pura) |
| `RCT` | `;` + 16 hex iButton | iButton ID |
| `RCU` | `;` + driver ID | Identificación de conductor |
| `RCV` | `+` temp ×2 | Signo + 4 temp + 2 edad (×2) |
| `RBQ` | 3 dígitos batería | Voltaje batería backup |
| `RBR` | 3 bat + temp | Batería + 1 temperatura |
| `RBV` | 3 bat + temp ×2 | Batería + 2 temperaturas |
| `RHQ` | 3 bat + 8 hex horómetro | Batería + horas motor |
| `RHR` | 3 bat + 8 hora + temp | Batería + horómetro + 1 temp |
| `RHV` | 3 bat + 8 hora + temp ×2 | Batería + horómetro + 2 temps |

---

## 4. Tabla completa de códigos de evento

Basada en `listado.txt` (99 códigos documentados por el fabricante).

### 4.1. Cómo funciona

Cada reporte `RCQ`, `RER` o `RCR` incluye un código de evento en hex (campo `event2`). El decoder lo procesa en dos pasos:

1. **`decodeAlarm(eventCode)`** → mapea el código a una constante `Position.ALARM_*` de Traccar
2. **`getEventDescription(eventCode)`** → devuelve la descripción en español de `listado.txt`

Ambos valores se almacenan en la posición:
```java
String alarm = decodeAlarm(eventCode);
if (alarm != null) {
    position.addAlarm(alarm);              // → Position.KEY_ALARM
}
String desc = getEventDescription(eventCode);
if (desc != null) {
    position.set("eventDescription", desc); // → atributo eventDescription
}
```

### 4.2. Tabla completa

**Leyenda:** 🚨 = alarma real, ℹ️ = informativo (ALARM_GENERAL), · = reservado (sin procesar)

| Hex | Dec | Código G | Descripción | Tipo Traccar | Clase |
|-----|-----|----------|-------------|-------------|-------|
| `0x00` | 0 | `GCQ00H` | _(posición periódica, sin evento)_ | — | · |
| `0x01` | 1 | `GCQ01H` | Vibración | `ALARM_VIBRATION` | 🚨 |
| `0x02` | 2 | `GCQ02H` | Capó Abierto | `ALARM_BONNET` | 🚨 |
| `0x03` | 3 | `GCQ03H` | Capó Cerrado | `ALARM_GENERAL` | ℹ️ |
| `0x04` | 4 | `GCQ04H` | Puerta Del. Izq. Abierta | `ALARM_DOOR` | 🚨 |
| `0x05` | 5 | `GCQ05H` | Puerta Del. Izq. Cerrada | `ALARM_GENERAL` | ℹ️ |
| `0x06` | 6 | `GCQ06H` | Puerta Del. Der. Abierta | `ALARM_DOOR` | 🚨 |
| `0x07` | 7 | `GCQ07H` | Puerta Del. Der. Cerrada | `ALARM_GENERAL` | ℹ️ |
| `0x08` | 8 | `GCQ08H` | Puerta Tras. Izq. Abierta | `ALARM_DOOR` | 🚨 |
| `0x09` | 9 | `GCQ09H` | Puerta Tras. Izq. Cerrada | `ALARM_GENERAL` | ℹ️ |
| `0x10` | 16 | `GCQ10H` | Puerta Tras. Der. Abierta | `ALARM_DOOR` | 🚨 |
| `0x11` | 17 | `GCQ11H` | Puerta Tras. Der. Cerrada | `ALARM_GENERAL` | ℹ️ |
| `0x12`–`0x19` | 18–25 | — | RES. | — | · |
| `0x20` | 32 | `GCQ20H` | Reconexión GPS | `ALARM_GENERAL` | ℹ️ |
| `0x21` | 33 | `GCQ21H` | Reconexión GPRS | `ALARM_GENERAL` | ℹ️ |
| `0x22` | 34 | `GCQ22H` | Pérdida Conec. WiFi | `ALARM_GENERAL` | ℹ️ |
| `0x23` | 35 | `GCQ23H` | Reconexión WiFi | `ALARM_GENERAL` | ℹ️ |
| `0x24` | 36 | `GCQ24H` | Batería Tracker – Baja | `ALARM_LOW_BATTERY` | 🚨 |
| `0x25` | 37 | `GCQ25H` | Corte Antena GPS | `ALARM_GPS_ANTENNA_CUT` | 🚨 |
| `0x26` | 38 | `GCQ26H` | Tracker Offline | `ALARM_GENERAL` | ℹ️ |
| `0x27` | 39 | `GCQ27H` | Pérdida Conec. GPS | `ALARM_GENERAL` | ℹ️ |
| `0x28` | 40 | `GCQ28H` | Pérdida Conec. GPRS | `ALARM_GENERAL` | ℹ️ |
| `0x29`–`0x34` | 41–52 | — | RES. | — | · |
| `0x35` | 53 | `GCQ35H` | Entrada Geocerca | `ALARM_GEOFENCE_ENTER` | 🚨 |
| `0x36` | 54 | `GCQ36H` | Salida Geocerca | `ALARM_GEOFENCE_EXIT` | 🚨 |
| `0x37` | 55 | `GCQ37H` | Entrada Zona Restricta | `ALARM_GEOFENCE` | 🚨 |
| `0x38`–`0x39` | 56–57 | — | RES. | — | · |
| `0x40` | 64 | `GCQ40H` | Consumo Anómalo | `ALARM_FAULT` | 🚨 |
| `0x41` | 65 | `GCQ41H` | SERVICE – Motor | `ALARM_FAULT` | 🚨 |
| `0x42` | 66 | `GCQ42H` | SERVICE – Transmisión | `ALARM_FAULT` | 🚨 |
| `0x43` | 67 | `GCQ43H` | Horas Motor – Crítico | `ALARM_GENERAL` | ℹ️ |
| `0x44` | 68 | `GCQ44H` | Temp. Motor – Baja | `ALARM_TEMPERATURE` | 🚨 |
| `0x45` | 69 | `GCQ45H` | Ralentí | `ALARM_IDLE` | 🚨 |
| `0x46` | 70 | `GCQ46H` | Fuga Combustible | `ALARM_FUEL_LEAK` | 🚨 |
| `0x47` | 71 | `GCQ47H` | Temp. Motor – Alta | `ALARM_TEMPERATURE` | 🚨 |
| `0x48` | 72 | `GCQ48H` | Presión de Aceite – Baja | `ALARM_FAULT` | 🚨 |
| `0x49` | 73 | `GCQ49H` | RPM – Altas | `ALARM_HIGH_RPM` | 🚨 |
| `0x50` | 80 | `GCQ50H` | Fuga Refrigerante | `ALARM_FAULT` | 🚨 |
| `0x51`–`0x59` | 81–89 | — | RES. | — | · |
| `0x60` | 96 | `GCQ60H` | Desbloqueo | `ALARM_UNLOCK` | 🚨 |
| `0x61` | 97 | `GCQ61H` | Bloqueo | `ALARM_LOCK` | 🚨 |
| `0x62` | 98 | `GCQ62H` | Inhibidor Señal | `ALARM_JAMMING` | 🚨 |
| `0x63` | 99 | `GCQ63H` | Manipulación / Sabotaje | `ALARM_TAMPERING` | 🚨 |
| `0x64` | 100 | `GCQ64H` | Remoción | `ALARM_REMOVING` | 🚨 |
| `0x65` | 101 | `GCQ65H` | Grúa / Remolque / Robo | `ALARM_TOW` | 🚨 |
| `0x66`–`0x69` | 102–105 | — | RES. | — | · |
| `0x70` | 112 | `GCQ70H` | Baja Velocidad | `ALARM_LOW_SPEED` | 🚨 |
| `0x71` | 113 | `GCQ71H` | Cambio Carril | `ALARM_LANE_CHANGE` | 🚨 |
| `0x72` | 114 | `GCQ72H` | Posible Accidente | `ALARM_ACCIDENT` | 🚨 |
| `0x73` | 115 | `GCQ73H` | Vuelco | `ALARM_ACCIDENT` | 🚨 |
| `0x74` | 116 | `GCQ74H` | Velocidad Anómala Agrícola | `ALARM_OVERSPEED` | 🚨 |
| `0x75` | 117 | `GCQ75H` | Desplazamiento Nocturno | `ALARM_GENERAL` | 🚨 |
| `0x76` | 118 | `GCQ76H` | Aceleración Brusca | `ALARM_ACCELERATION` | 🚨 |
| `0x77` | 119 | `GCQ77H` | Exceso Velocidad | `ALARM_OVERSPEED` | 🚨 |
| `0x78` | 120 | `GCQ78H` | Frenada Brusca | `ALARM_BRAKING` | 🚨 |
| `0x79` | 121 | `GCQ79H` | Curva Brusca | `ALARM_CORNERING` | 🚨 |
| `0x80` | 128 | `GCQ80H` | Tiempo Conducción – Crítico | `ALARM_FATIGUE_DRIVING` | 🚨 |
| `0x81` | 129 | `GCQ81H` | Fatiga Conductor | `ALARM_FATIGUE_DRIVING` | 🚨 |
| `0x82` | 130 | `GCQ82H` | Conducción Nocturna | `ALARM_GENERAL` | 🚨 |
| `0x83` | 131 | `GCQ83H` | Caída | `ALARM_FALL_DOWN` | 🚨 |
| `0x84`–`0x89` | 132–137 | — | RES. | — | · |
| `0x90` | 144 | `GCQ90H` | Presión de Aire – Baja | `ALARM_FAULT` | 🚨 |
| `0x91` | 145 | `GCQ91H` | Freno de Pie | `ALARM_FOOT_BRAKE` | 🚨 |
| `0x92`–`0x98` | 146–152 | — | RES. | — | · |
| `0x99` | 153 | `GCQ99H` | SOS | `ALARM_SOS` | 🚨 |

### 4.3. Códigos informativos vs. alarmas reales

**13 códigos son informativos** — usan `ALARM_GENERAL` para aparecer en la UI de Traccar sin disparar notificaciones de alarma crítica:

| Códigos | Evento |
|---------|--------|
| `0x03` | Capó Cerrado |
| `0x05, 0x07, 0x09, 0x11` | Puertas cerradas (4) |
| `0x20–0x23` | Reconexiones GPS, GPRS, WiFi (4) |
| `0x26–0x28` | Pérdidas de conexión (3) |
| `0x43` | Horas Motor – Crítico |

**25 códigos son RES.** (reservados, sin uso) — devuelven `null` y no generan ningún evento.

**44 códigos son alarmas reales** — mapean a constantes `Position.ALARM_*` de Traccar. Algunas alarmas comparten la misma constante:

| Constante Traccar | Códigos Rinho |
|-------------------|---------------|
| `ALARM_DOOR` | `0x04, 0x06, 0x08, 0x10` |
| `ALARM_FAULT` | `0x40, 0x41, 0x42, 0x48, 0x50, 0x90` |
| `ALARM_TEMPERATURE` | `0x44, 0x47` |
| `ALARM_OVERSPEED` | `0x74, 0x77` |
| `ALARM_ACCIDENT` | `0x72, 0x73` |
| `ALARM_FATIGUE_DRIVING` | `0x80, 0x81` |
| `ALARM_GENERAL` | `0x75, 0x82` (+ 13 informativos) |

---

## 5. ACK y confirmación

El decoder envía un ACK automático al dispositivo por cada mensaje recibido cuyo `msgNum < 0x8000` (mensajes automáticos, no respuestas a comandos):

```java
// RinhoProtocolDecoder.java:483
private void sendAck(Channel channel, SocketAddress remoteAddress,
                     String deviceId, String msgNumHex) {
    if (channel != null && msgNumHex != null) {
        String ack = ">ACK;#" + msgNumHex + ";ID=" + deviceId + ";*";
        String checksum = calculateChecksum(ack);
        String full = ack + checksum + "<";
        channel.writeAndFlush(new NetworkMessage(full, remoteAddress));
    }
}
```

El ACK resultante tiene este formato:
```
>ACK;#0001;ID=KJA-169;*CC<
```

---

## 6. Comandos del servidor al dispositivo

Implementado en `RinhoProtocolEncoder.java`. Traccar expone estos comandos en la UI (botón de comando en el panel del dispositivo):

| Comando Traccar | Cuerpo Rinho | Descripción |
|-----------------|-------------|-------------|
| `TYPE_POSITION_SINGLE` | `QGP` | Solicitar posición inmediata |
| `TYPE_ENGINE_STOP` | `SXP00,1` | Cortar motor |
| `TYPE_ENGINE_RESUME` | `SXP00,0` | Restaurar motor |
| `TYPE_CUSTOM` | (texto libre) | Enviar comando arbitrario |
| _(default)_ | `QVR` | Solicitar versión de firmware |

Los comandos usan `msgNum ≥ 0x8000` y esperan confirmación `ACK` del dispositivo.

**Formato de comando enviado:**
```
>BODY;#8000;ID=KJA-169;*CC<
```

---

## 7. Flujo de build y deploy

### 7.1. ¿Por qué hay dos copias del decoder?

El decoder existe en **dos ubicaciones**:

| Ubicación | Repo | Propósito |
|-----------|------|-----------|
| `traccar/src/main/java/.../RinhoProtocolDecoder.java` | `RoJaS2109/traccar` | Fuente canónico, compilado por Gradle, usado en tests |
| `traccar-web/docker/org/traccar/protocol/RinhoProtocolDecoder.java` | `RoJaS2109/traccar-web` | Copia usada por el Dockerfile multi-stage para parchear el JAR |

**IMPORTANTE:** Cada vez que se modifica el decoder en `traccar/`, hay que sincronizar la copia en `traccar-web/docker/`. Si no se hace, el deploy usará el decoder antiguo.

```bash
# Sincronizar después de editar el decoder:
cp traccar/src/main/java/org/traccar/protocol/RinhoProtocolDecoder.java \
   traccar/traccar-web/docker/org/traccar/protocol/RinhoProtocolDecoder.java
```

### 7.2. Dockerfile multi-stage

El build Docker (`traccar-web/Dockerfile`) compila y parchea el JAR en dos etapas:

**Stage 1 (builder):**
```dockerfile
FROM eclipse-temurin:21-jdk AS builder
COPY --from=traccar/traccar:latest /opt/traccar/tracker-server.jar /build/original.jar
COPY --from=traccar/traccar:latest /opt/traccar/lib /build/lib
COPY docker/ /build/src/
RUN javac -cp "original.jar:lib/*" -d /build/classes \
        /build/src/org/traccar/web/OverrideTextFilter.java && \
    cp original.jar patched.jar && \
    jar uf patched.jar -C /build/classes org/traccar/web/OverrideTextFilter.class
```

**Stage 2 (final):**
```dockerfile
FROM traccar/traccar:latest
COPY --from=builder /build/patched.jar /opt/traccar/tracker-server.jar
COPY build/ /opt/traccar/web/
```

### 7.3. Script de deploy (`deploy.sh`)

6 pasos secuenciales:

| Paso | Acción |
|------|--------|
| 1 | `git pull && npm install && npm run build` — compila el frontend |
| 2 | `docker build -t rudatrak:latest .` — construye imagen con JAR parcheado + frontend |
| 3 | `rsync` de KMLs a `/data/compose/rudatrak/trak-poi/` |
| 4 | `docker build -t carga-poi:latest tools/carga-poi/` |
| 5 | `docker build -t agente-ia:latest tools/agente-ia/` |
| 6 | `docker compose up -d` — redeploy del stack |

---

## 8. Tests

### 8.1. Estructura de tests

Archivo: `traccar/src/test/java/org/traccar/protocol/RinhoProtocolDecoderTest.java`

- **Framework:** JUnit 5
- **Clase base:** `ProtocolTest` (proporciona `inject()` y `text()`)
- **Dependencias:** `assertNotNull`, `assertEquals`, `assertTrue`

Patrón de test:
```java
@Test
public void testDecodeAlarmMapping() throws Exception {
    var decoder = inject(new RinhoProtocolDecoder(null));

    var pos04 = (Position) decoder.decode(null, null, text(
            ">RCQ04080726153015-..."));
    assertNotNull(pos04);
    String alarms04 = (String) pos04.getAttributes().get(Position.KEY_ALARM);
    assertTrue(alarms04 != null && alarms04.contains("door"),
            "Evento 04 debería generar alarma door: " + alarms04);
}
```

### 8.2. Tests existentes (20 tests)

| Test | Qué verifica |
|------|-------------|
| `testDecodeRCQ` | 4 variantes RCQ: periódica, Capó Cerrado, Puerta Abierta, Frenada |
| `testDecodeRER` | CAN bus: datos completos, sensores vacíos (`!empty`) |
| `testDecodeRCR` | Reporte compacto (eventos RES.) |
| `testDecodeAlarmMapping` | 10 asserts de mapeo de alarmas: 00→null, 03→general, 04→door, 13→null, 19→null, 63→tampering, 65→tow, 78→hardBraking, 99→sos |
| `testDecodeRCW` | Compacto WiFi: course/speed invertidos, odómetro decimal |
| `testDecodeRGP` | GPS simplificado: lat, lon, fix, edad |
| `testDecodeRCY` | Standard con altitud |
| `testDecodeRCRExtended` | RCR con campos GPS/GSM |
| `testDecodeRAD` | Analógico 8 canales |
| `testDecodeRAE` | Analógico con signo |
| `testDecodeInventory` | RVR, RSN, RIMEI, RTAG, RCXHWI |
| `testDecodeRIO` | Entradas/Salidas (IGN, IN binario, XP, VBU) |
| `testDecodeCQVariants` | 10 variantes: RCP, RCT, RCU, RCV, RBQ, RBR, RBV, RHQ, RHR, RHV |
| `testDecodeREQ` | CAN bus OBD-II |
| `testDecodeRTX` | Texto libre |
| `testDecodeRIB` | iButton + temperatura |
| `testDecodeRSC` | Sensor de contacto |
| `testDecodeRLC` | Locator por celda |
| `testDecodeRHT` | Link a Google Maps |
| `testDecodeEmptyFrame` | Frame sin tipo (retorna null) |

### 8.3. Ejecutar tests

```bash
cd traccar
./gradlew test --tests "org.traccar.protocol.RinhoProtocolDecoderTest"
```

---

## 9. Cómo agregar un nuevo código de evento

Cuando el fabricante documente un nuevo código en `listado.txt` o se quiera cambiar el mapeo de uno existente:

### Paso 1: Agregar a `decodeAlarm()`

En `RinhoProtocolDecoder.java`, dentro del switch de `decodeAlarm()`:

```java
case 0xNN -> Position.ALARM_XXX;  // Descripción
```

O si es informativo:
```java
case 0xNN -> Position.ALARM_GENERAL;  // Descripción (informativo)
```

### Paso 2: Agregar a `getEventDescription()`

En el switch de `getEventDescription()`:

```java
case 0xNN -> "Descripción en español";
```

### Paso 3: Agregar test en `testDecodeAlarmMapping`

```java
var posNN = (Position) decoder.decode(null, null, text(
        ">RCQNN080726153015-3460500-0583835000000080000980001A35013050001002115;#9999;ID=KJA-169<"));
assertNotNull(posNN);
String alarmsNN = (String) posNN.getAttributes().get(Position.KEY_ALARM);
assertTrue(alarmsNN != null && alarmsNN.contains("xxx"),
        "Evento NN debería generar alarma xxx: " + alarmsNN);
```

### Paso 4: Sincronizar y testear

```bash
# 1. Compilar y testear
cd traccar && ./gradlew test --tests "org.traccar.protocol.RinhoProtocolDecoderTest"

# 2. Sincronizar al docker folder
cp traccar/src/main/java/org/traccar/protocol/RinhoProtocolDecoder.java \
   traccar/traccar-web/docker/org/traccar/protocol/RinhoProtocolDecoder.java

# 3. Commit en ambos repos
cd traccar && git add -A && git commit -m "..." && git push
cd traccar-web && git add docker/ && git commit -m "..." && git push

# 4. Deploy en la Pi
ssh rodrigo@192.168.100.100 'cd /app/RudaTrak/traccar/traccar-web && git pull && ./deploy.sh'
```

---

## 10. Constantes Traccar usadas

Las 38 constantes `Position.ALARM_*` disponibles en Traccar. Las usadas por el protocolo Rinho están marcadas con ✅:

| Constante | Usada | Códigos Rinho |
|-----------|-------|---------------|
| `ALARM_GENERAL` | ✅ | 13 informativos + `0x75`, `0x82` |
| `ALARM_SOS` | ✅ | `0x99` |
| `ALARM_VIBRATION` | ✅ | `0x01` |
| `ALARM_MOVEMENT` | — | — |
| `ALARM_LOW_SPEED` | ✅ | `0x70` |
| `ALARM_OVERSPEED` | ✅ | `0x74`, `0x77` |
| `ALARM_FALL_DOWN` | ✅ | `0x83` |
| `ALARM_LOW_POWER` | — | — |
| `ALARM_LOW_BATTERY` | ✅ | `0x24` |
| `ALARM_FAULT` | ✅ | `0x40`, `0x41`, `0x42`, `0x48`, `0x50`, `0x90` |
| `ALARM_POWER_OFF` | — | — |
| `ALARM_POWER_ON` | — | — |
| `ALARM_DOOR` | ✅ | `0x04`, `0x06`, `0x08`, `0x10` |
| `ALARM_LOCK` | ✅ | `0x61` |
| `ALARM_UNLOCK` | ✅ | `0x60` |
| `ALARM_GEOFENCE` | ✅ | `0x37` |
| `ALARM_GEOFENCE_ENTER` | ✅ | `0x35` |
| `ALARM_GEOFENCE_EXIT` | ✅ | `0x36` |
| `ALARM_GPS_ANTENNA_CUT` | ✅ | `0x25` |
| `ALARM_ACCIDENT` | ✅ | `0x72`, `0x73` |
| `ALARM_TOW` | ✅ | `0x65` |
| `ALARM_IDLE` | ✅ | `0x45` |
| `ALARM_HIGH_RPM` | ✅ | `0x49` |
| `ALARM_ACCELERATION` | ✅ | `0x76` |
| `ALARM_BRAKING` | ✅ | `0x78` |
| `ALARM_CORNERING` | ✅ | `0x79` |
| `ALARM_LANE_CHANGE` | ✅ | `0x71` |
| `ALARM_FATIGUE_DRIVING` | ✅ | `0x80`, `0x81` |
| `ALARM_POWER_CUT` | — | — |
| `ALARM_POWER_RESTORED` | — | — |
| `ALARM_JAMMING` | ✅ | `0x62` |
| `ALARM_TEMPERATURE` | ✅ | `0x44`, `0x47` |
| `ALARM_PARKING` | — | — |
| `ALARM_BONNET` | ✅ | `0x02` |
| `ALARM_FOOT_BRAKE` | ✅ | `0x91` |
| `ALARM_FUEL_LEAK` | ✅ | `0x46` |
| `ALARM_TAMPERING` | ✅ | `0x63` |
| `ALARM_REMOVING` | ✅ | `0x64` |

**23 de 38 constantes usadas.** Las 15 restantes están disponibles para futuros códigos.

---

## 11. Referencia rápida: comandos G para testing

Para probar alarmas desde la consola del dispositivo, enviar una regla con el código G correspondiente:

```
>RL00E;TRG=TD00+;ACC={GCQbbH};ID=KJA-169;*CC<
```

Donde `bb` es el código de evento en hex:

| Para probar... | Usar |
|----------------|------|
| SOS | `GCQ99H` |
| Puerta abierta | `GCQ04H` |
| Frenada brusca | `GCQ78H` |
| Aceleración brusca | `GCQ76H` |
| Capó cerrado (informativo) | `GCQ03H` |
| Batería baja | `GCQ24H` |
| Grúa/Remolque | `GCQ65H` |
| Exceso velocidad | `GCQ77H` |
| Posición periódica | `GCQ00H` |

---

## Archivos relacionados

| Archivo | Descripción |
|---------|-------------|
| `listado.txt` | Lista oficial de 99 códigos de evento del fabricante |
| `reportes_que_maneja_rinho.txt` | Documentación completa del protocolo (3376 líneas) |
| `RinhoProtocolDecoder.java` | Implementación del decoder (∼2900 líneas) |
| `RinhoProtocolEncoder.java` | Implementación del encoder para comandos |
| `RinhoProtocol.java` | Registro del protocolo en Netty |
| `RinhoProtocolDecoderTest.java` | 20 tests JUnit 5 |
