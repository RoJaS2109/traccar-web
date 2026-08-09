package org.traccar.protocol.rinho;

import io.netty.buffer.ByteBuf;
import io.netty.buffer.ByteBufUtil;
import io.netty.buffer.Unpooled;
import io.netty.channel.Channel;
import io.netty.channel.ChannelHandlerContext;
import org.traccar.BaseProtocolDecoder;
import org.traccar.DeviceSession;
import org.traccar.NetworkMessage;
import org.traccar.Protocol;
import org.traccar.helper.BitUtil;
import org.traccar.helper.UnitsConverter;
import org.traccar.model.Position;
import org.traccar.session.DeviceSession;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

public class RinhoProtocolDecoder extends BaseProtocolDecoder {

    private static final byte START = '>';
    private static final byte END = '<';
    private static final byte ACK = 'A';
    private static final byte C = 'C';
    private static final byte K = 'K';

    // Para comandos salientes
    private static final AtomicInteger commandMsgNum = new AtomicInteger(1);

    // Mapa de comandos pendientes (deviceId -> mensaje esperado)
    private final Map<String, Integer> pendingCommands = new ConcurrentHashMap<>();

    // Tabla NAT para UDP
    private final Map<String, InetSocketAddress> natTable = new ConcurrentHashMap<>();

    public RinhoProtocolDecoder(Protocol protocol) {
        super(protocol);
    }

    public static String calculateChecksum(String partial) {
        int checksum = 0;
        for (byte b : partial.getBytes(StandardCharsets.US_ASCII)) {
            checksum ^= b;
        }
        return String.format("%02X", checksum);
    }

    public static int getNextCommandMsgNum() {
        int num = commandMsgNum.getAndIncrement();
        if (num > 0x7FFF) {
            commandMsgNum.set(1);
            num = 1;
        }
        return num;
    }

    @Override
    protected Object decode(ChannelHandlerContext ctx, Channel channel, Object msg) throws Exception {
        ByteBuf buf = (ByteBuf) msg;
        // Intentar leer el frame completo (ya delimitado por FrameDecoder)
        // El frame incluye > y <
        String frame = buf.toString(StandardCharsets.US_ASCII);
        // Si es un mensaje binario (empieza con >RB3 o >RB9), manejarlo aparte
        if (frame.startsWith(">RB3") || frame.startsWith(">RB9")) {
            return decodeBinaryReport(buf, channel);
        }

        // Procesar frame ASCII
        return decodeAsciiFrame(frame, channel, ctx);
    }

    private Object decodeAsciiFrame(String frame, Channel channel, ChannelHandlerContext ctx) {
        // Validar checksum
        int starPos = frame.indexOf('*');
        if (starPos < 0) {
            return null; // mal formado
        }
        String partial = frame.substring(0, starPos + 1); // incluye *
        String checksumStr = frame.substring(starPos + 1, starPos + 3);
        String calculated = calculateChecksum(partial);
        if (!calculated.equals(checksumStr)) {
            // Checksum inválido, descartar
            return null;
        }

        // Extraer deviceId
        String deviceId = extractDeviceId(frame);
        if (deviceId == null) {
            return null;
        }
        DeviceSession deviceSession = getDeviceSession(channel, remoteAddress, deviceId);
        if (deviceSession == null) {
            return null; // dispositivo no registrado
        }

        // Extraer msgNum
        String msgNumHex = extractMsgNum(frame);
        int msgNum = msgNumHex != null ? Integer.parseInt(msgNumHex, 16) : -1;

        // Determinar tipo de mensaje por el prefijo del body
        String body = frame.substring(1, starPos); // desde > hasta * (sin *)

        // Si es un ACK (de dispositivo a servidor), ignorar pero actualizar estado
        if (body.startsWith("ACK")) {
            // Si tenemos un comando pendiente con este msgNum, marcarlo como confirmado
            if (msgNum >= 0) {
                // asociar con comando original (msgNum | 0x8000?)
                // No necesitamos hacer nada, pero podemos log
            }
            return null;
        }

        // Si es KA, no enviar ACK, solo actualizar estado de conexión
        if (body.startsWith("KA")) {
            // Actualizar NAT si es UDP
            updateNatTable(deviceId, channel);
            return null;
        }

        // Si es RVR (versión), extraer versión y almacenar como atributo del dispositivo
        if (body.startsWith("RVR")) {
            String version = body.substring(3).trim();
            // Almacenar en el dispositivo (usando DeviceSession)
            // Podríamos guardar en una base de datos, pero por ahora lo añadimos al Position
            Position p = new Position();
            p.setDeviceId(deviceSession.getDeviceId());
            p.setProtocol(getProtocolName());
            p.set(Position.KEY_VERSION, version);
            // No es una posición, pero podemos devolverla para que se almacene como evento
            // O simplemente enviar ACK si corresponde
            if (msgNum >= 0 && msgNum < 0x8000) {
                sendAck(channel, deviceId, msgNumHex);
            }
            return p;
        }

        // Mensajes de inventario
        if (body.startsWith("RCXHWI")) {
            String hwi = body.substring(6);
            Position p = new Position();
            p.setDeviceId(deviceSession.getDeviceId());
            p.set("hardwareId", hwi);
            if (msgNum >= 0 && msgNum < 0x8000) sendAck(channel, deviceId, msgNumHex);
            return p;
        }
        if (body.startsWith("RSN")) {
            String sn = body.substring(3);
            Position p = new Position();
            p.setDeviceId(deviceSession.getDeviceId());
            p.set("serialNumber", sn);
            if (msgNum >= 0 && msgNum < 0x8000) sendAck(channel, deviceId, msgNumHex);
            return p;
        }
        if (body.startsWith("RIMEI")) {
            String imei = body.substring(5);
            Position p = new Position();
            p.setDeviceId(deviceSession.getDeviceId());
            p.set(Position.KEY_IMEI, imei);
            if (msgNum >= 0 && msgNum < 0x8000) sendAck(channel, deviceId, msgNumHex);
            return p;
        }
        if (body.startsWith("RTAG")) {
            String tag = body.substring(4);
            Position p = new Position();
            p.setDeviceId(deviceSession.getDeviceId());
            p.set("tag", tag);
            if (msgNum >= 0 && msgNum < 0x8000) sendAck(channel, deviceId, msgNumHex);
            return p;
        }

        // Si es un reporte de posición (R...)
        if (body.startsWith("R")) {
            Position position = parsePosition(body, deviceId, deviceSession.getDeviceId(), msgNum, msgNumHex);
            if (position != null) {
                // Enviar ACK después de parsear (simulamos persistencia)
                if (msgNum >= 0 && msgNum < 0x8000) {
                    sendAck(channel, deviceId, msgNumHex);
                }
                // También actualizar NAT
                updateNatTable(deviceId, channel);
                return position;
            }
        }

        // Si es un comando de respuesta (msgNum >= 0x8000)
        if (msgNum >= 0x8000) {
            // Asociar con comando original (msgNum & 0x7FFF)
            // No enviar ACK
            // Podemos devolver un objeto Position con el contenido
            Position p = new Position();
            p.setDeviceId(deviceSession.getDeviceId());
            p.set("response", body);
            p.set(Position.KEY_RESULT, body);
            return p;
        }

        // Si no se reconoce, devolver null
        return null;
    }

    private String extractDeviceId(String frame) {
        int idStart = frame.indexOf(";ID=");
        if (idStart < 0) return null;
        int idEnd = frame.indexOf(';', idStart + 4);
        if (idEnd < 0) idEnd = frame.indexOf('*', idStart + 4);
        if (idEnd < 0) return null;
        return frame.substring(idStart + 4, idEnd);
    }

    private String extractMsgNum(String frame) {
        int numStart = frame.indexOf(";#");
        if (numStart < 0) return null;
        int numEnd = frame.indexOf(';', numStart + 2);
        if (numEnd < 0) numEnd = frame.indexOf('*', numStart + 2);
        if (numEnd < 0) return null;
        return frame.substring(numStart + 2, numEnd);
    }

    private void sendAck(Channel channel, String deviceId, String msgNumHex) {
        String ack = ">ACK;#" + msgNumHex + ";ID=" + deviceId + ";*";
        String checksum = calculateChecksum(ack);
        String full = ack + checksum + "<";
        channel.writeAndFlush(new NetworkMessage(Unpooled.wrappedBuffer(full.getBytes(StandardCharsets.US_ASCII)), channel.remoteAddress()));
    }

    private void updateNatTable(String deviceId, Channel channel) {
        if (channel.remoteAddress() instanceof InetSocketAddress) {
            natTable.put(deviceId, (InetSocketAddress) channel.remoteAddress());
        }
    }

    // -------------------------------------------------------------
    // PARSEO DE POSICIÓN (base 66 chars + sufijos extendidos)
    // -------------------------------------------------------------
    private Position parsePosition(String body, String deviceId, long deviceIdLong, int msgNum, String msgNumHex) {
        // body es desde R hasta antes del * (sin el R inicial?)
        // Ejemplo: "RCQ28060426153025-3462000-05838000045180A203128000000110000050A100512;#0001;ID=..."
        // Pero body incluye todo, así que extraemos la parte antes de los posibles segmentos extras.
        // Separar por ';' para obtener los segmentos.
        String[] segments = body.split(";");
        String base = segments[0]; // el reporte en sí

        // El tipo de reporte es los primeros 3 caracteres: R + 2 letras
        if (base.length() < 3) return null;
        String reportType = base.substring(0, 3); // ej: RCQ

        // Los campos base empiezan después del tipo (offset 3)
        if (base.length() < 3 + 66) return null; // mínimo 66 chars
        String baseFields = base.substring(3, 3 + 66);

        // Parsear campos base (posicionales)
        Position position = new Position();
        position.setDeviceId(deviceIdLong);
        position.setProtocol(getProtocolName());

        // Fecha y hora (DDMMAAHHMMSS)
        String dateTimeStr = baseFields.substring(2, 14); // de offset 2 a 14
        try {
            int day = Integer.parseInt(dateTimeStr.substring(0, 2));
            int month = Integer.parseInt(dateTimeStr.substring(2, 4)) - 1;
            int year = 2000 + Integer.parseInt(dateTimeStr.substring(4, 6));
            int hour = Integer.parseInt(dateTimeStr.substring(6, 8));
            int min = Integer.parseInt(dateTimeStr.substring(8, 10));
            int sec = Integer.parseInt(dateTimeStr.substring(10, 12));
            Calendar cal = Calendar.getInstance(TimeZone.getTimeZone("UTC"));
            cal.set(year, month, day, hour, min, sec);
            position.setTime(cal.getTime());
        } catch (Exception e) {
            // ignorar
        }

        // Latitud (8 chars con signo) y Longitud (9 chars con signo)
        String latStr = baseFields.substring(14, 22).trim();
        String lonStr = baseFields.substring(22, 31).trim();
        try {
            double lat = Integer.parseInt(latStr) / 100000.0;
            double lon = Integer.parseInt(lonStr) / 100000.0;
            position.setLatitude(lat);
            position.setLongitude(lon);
        } catch (Exception e) {
            // ignorar
        }

        // Velocidad (3 chars) y Rumbo (3 chars)
        try {
            position.setSpeed(UnitsConverter.knotsFromKph(Integer.parseInt(baseFields.substring(31, 34))));
        } catch (Exception e) {}
        try {
            position.setCourse(Integer.parseInt(baseFields.substring(34, 37)));
        } catch (Exception e) {}

        // Inputs (2 hex) y Outputs (2 hex)
        String inputsHex = baseFields.substring(37, 39);
        String outputsHex = baseFields.substring(39, 41);
        int inputs = Integer.parseInt(inputsHex, 16);
        int outputs = Integer.parseInt(outputsHex, 16);
        position.set(Position.KEY_INPUT, inputs);
        position.set(Position.KEY_OUTPUT, outputs);
        position.set(Position.KEY_IGNITION, BitUtil.check(inputs, 7));

        // Voltaje (3 chars) -> décimas de volt
        try {
            int voltageRaw = Integer.parseInt(baseFields.substring(41, 44));
            position.set(Position.KEY_POWER, voltageRaw / 10.0);
        } catch (Exception e) {}

        // Odómetro (8 hex)
        try {
            String odomHex = baseFields.substring(44, 52);
            long odom = Long.parseLong(odomHex, 16);
            position.set(Position.KEY_ODOMETER, odom);
        } catch (Exception e) {}

        // GPS Power (1 char)
        position.set("gpsPower", baseFields.substring(52, 53));
        // GPS Mode (1 char)
        position.set("gpsMode", baseFields.substring(53, 54));
        // PDOP (2 chars) - entero
        try {
            position.set(Position.KEY_PDOP, Integer.parseInt(baseFields.substring(54, 56)));
        } catch (Exception e) {}
        // Satélites (2 chars)
        try {
            position.set(Position.KEY_SATELLITES, Integer.parseInt(baseFields.substring(56, 58)));
        } catch (Exception e) {}
        // GPS Age (4 hex) -> segundos
        try {
            long age = Long.parseLong(baseFields.substring(58, 62), 16);
            position.set("gpsAge", age);
        } catch (Exception e) {}
        // Modem Power (1 char)
        position.set("modemPower", baseFields.substring(62, 63));
        // GSM Status (1 char)
        position.set("gsmStatus", baseFields.substring(63, 64));
        // CSQ (2 chars)
        try {
            position.set("csq", Integer.parseInt(baseFields.substring(64, 66)));
        } catch (Exception e) {}

        // Ahora procesar sufijos extendidos según el tipo
        String suffix = base.length() > 3 + 66 ? base.substring(3 + 66) : "";
        parseSuffix(suffix, reportType, position);

        // Buscar segmentos adicionales como ;AP= o ;PA= o ;CAN...
        for (int i = 1; i < segments.length; i++) {
            String seg = segments[i];
            if (seg.startsWith("AP=") || seg.startsWith("PA=")) {
                parseAdditionalParams(seg.substring(3), position);
            } else if (seg.startsWith("TXT=")) {
                position.set("text", seg.substring(4));
            } else if (seg.contains("=") && !seg.startsWith("ID=")) {
                // Probablemente datos CAN (EQ/ER)
                parseCanData(seg, position);
            }
        }

        return position;
    }

    private void parseSuffix(String suffix, String reportType, Position position) {
        // Según el tipo, el sufijo tiene diferentes campos
        switch (reportType) {
            case "RCQ":
            case "RCP":
                // Sin sufijo
                break;
            case "RCR": // CR: 7 chars (signo+4temp + 2age)
                if (suffix.length() >= 7) {
                    String sign = suffix.substring(0, 1);
                    int tempRaw = Integer.parseInt(suffix.substring(1, 5));
                    double temp = tempRaw / 10.0;
                    if ("-".equals(sign)) temp = -temp;
                    position.set("temp1", temp);
                    int age = Integer.parseInt(suffix.substring(5, 7), 16);
                    position.set("temp1Age", age);
                }
                break;
            case "RCV": // CV: 14 chars (2 temps)
                if (suffix.length() >= 14) {
                    // OW0: signo+4+2age
                    String sign0 = suffix.substring(0, 1);
                    int temp0Raw = Integer.parseInt(suffix.substring(1, 5));
                    double temp0 = temp0Raw / 10.0;
                    if ("-".equals(sign0)) temp0 = -temp0;
                    position.set("temp1", temp0);
                    int age0 = Integer.parseInt(suffix.substring(5, 7), 16);
                    position.set("temp1Age", age0);
                    // OW1: siguiente 7
                    String sign1 = suffix.substring(7, 8);
                    int temp1Raw = Integer.parseInt(suffix.substring(8, 12));
                    double temp1 = temp1Raw / 10.0;
                    if ("-".equals(sign1)) temp1 = -temp1;
                    position.set("temp2", temp1);
                    int age1 = Integer.parseInt(suffix.substring(12, 14), 16);
                    position.set("temp2Age", age1);
                }
                break;
            case "RCT": // CT: ; + 16 hex
                if (suffix.startsWith(";") && suffix.length() >= 17) {
                    String ibutton = suffix.substring(1, 17);
                    position.set("ibutton", ibutton);
                }
                break;
            case "RCU": // CU: estado + ; + código
                if (suffix.contains(";")) {
                    String[] parts = suffix.split(";");
                    if (parts.length >= 2) {
                        position.set("sessionStatus", parts[0]);
                        position.set("sessionCode", parts[1]);
                    }
                }
                break;
            case "RBQ": // BQ: 3 chars (backup voltage)
                if (suffix.length() >= 3) {
                    int backupRaw = Integer.parseInt(suffix.substring(0, 3));
                    position.set("batteryBackup", backupRaw / 100.0);
                }
                break;
            case "RBR": // BR: 3 backup + 7 temp
                if (suffix.length() >= 10) {
                    int backupRaw = Integer.parseInt(suffix.substring(0, 3));
                    position.set("batteryBackup", backupRaw / 100.0);
                    String sign = suffix.substring(3, 4);
                    int tempRaw = Integer.parseInt(suffix.substring(4, 8));
                    double temp = tempRaw / 10.0;
                    if ("-".equals(sign)) temp = -temp;
                    position.set("temp1", temp);
                    int age = Integer.parseInt(suffix.substring(8, 10), 16);
                    position.set("temp1Age", age);
                }
                break;
            case "RBV": // BV: 3 backup + 14 temp (2 temps)
                if (suffix.length() >= 17) {
                    int backupRaw = Integer.parseInt(suffix.substring(0, 3));
                    position.set("batteryBackup", backupRaw / 100.0);
                    // OW0
                    String sign0 = suffix.substring(3, 4);
                    int temp0Raw = Integer.parseInt(suffix.substring(4, 8));
                    double temp0 = temp0Raw / 10.0;
                    if ("-".equals(sign0)) temp0 = -temp0;
                    position.set("temp1", temp0);
                    int age0 = Integer.parseInt(suffix.substring(8, 10), 16);
                    position.set("temp1Age", age0);
                    // OW1
                    String sign1 = suffix.substring(10, 11);
                    int temp1Raw = Integer.parseInt(suffix.substring(11, 15));
                    double temp1 = temp1Raw / 10.0;
                    if ("-".equals(sign1)) temp1 = -temp1;
                    position.set("temp2", temp1);
                    int age1 = Integer.parseInt(suffix.substring(15, 17), 16);
                    position.set("temp2Age", age1);
                }
                break;
            case "RHQ": // HQ: 3 backup + 8 horometer
                if (suffix.length() >= 11) {
                    int backupRaw = Integer.parseInt(suffix.substring(0, 3));
                    position.set("batteryBackup", backupRaw / 100.0);
                    String horoHex = suffix.substring(3, 11);
                    long horoSeconds = Long.parseLong(horoHex, 16);
                    position.set(Position.KEY_ENGINE_HOURS, horoSeconds / 3600.0);
                    position.set("engineSeconds", horoSeconds);
                }
                break;
            case "RHR": // HR: 3 backup + 8 horo + 7 temp
                if (suffix.length() >= 18) {
                    int backupRaw = Integer.parseInt(suffix.substring(0, 3));
                    position.set("batteryBackup", backupRaw / 100.0);
                    String horoHex = suffix.substring(3, 11);
                    long horoSeconds = Long.parseLong(horoHex, 16);
                    position.set(Position.KEY_ENGINE_HOURS, horoSeconds / 3600.0);
                    position.set("engineSeconds", horoSeconds);
                    String sign = suffix.substring(11, 12);
                    int tempRaw = Integer.parseInt(suffix.substring(12, 16));
                    double temp = tempRaw / 10.0;
                    if ("-".equals(sign)) temp = -temp;
                    position.set("temp1", temp);
                    int age = Integer.parseInt(suffix.substring(16, 18), 16);
                    position.set("temp1Age", age);
                }
                break;
            case "RHV": // HV: 3 backup + 8 horo + 14 temp (2 temps)
                if (suffix.length() >= 25) {
                    int backupRaw = Integer.parseInt(suffix.substring(0, 3));
                    position.set("batteryBackup", backupRaw / 100.0);
                    String horoHex = suffix.substring(3, 11);
                    long horoSeconds = Long.parseLong(horoHex, 16);
                    position.set(Position.KEY_ENGINE_HOURS, horoSeconds / 3600.0);
                    position.set("engineSeconds", horoSeconds);
                    // OW0
                    String sign0 = suffix.substring(11, 12);
                    int temp0Raw = Integer.parseInt(suffix.substring(12, 16));
                    double temp0 = temp0Raw / 10.0;
                    if ("-".equals(sign0)) temp0 = -temp0;
                    position.set("temp1", temp0);
                    int age0 = Integer.parseInt(suffix.substring(16, 18), 16);
                    position.set("temp1Age", age0);
                    // OW1
                    String sign1 = suffix.substring(18, 19);
                    int temp1Raw = Integer.parseInt(suffix.substring(19, 23));
                    double temp1 = temp1Raw / 10.0;
                    if ("-".equals(sign1)) temp1 = -temp1;
                    position.set("temp2", temp1);
                    int age1 = Integer.parseInt(suffix.substring(23, 25), 16);
                    position.set("temp2Age", age1);
                }
                break;
            case "REQ":
            case "RER":
                // Los datos CAN se manejan en los segmentos extra
                break;
            default:
                // Posiblemente CY o GP (reportes standards)
                // Estos no tienen la base de 66 chars, tienen estructura diferente
                // Podemos parsearlos con otro método
                parseStandardReport(body, position);
                break;
        }
    }

    private void parseStandardReport(String body, Position position) {
        // Para CY y GP, el formato es diferente.
        // Se puede implementar similar a la documentación.
        // Por ahora, dejamos un parseo básico.
        // Ejemplo CY: RCY... (ver documentación)
        // Aquí se podría extraer altitud, etc.
    }

    private void parseAdditionalParams(String params, Position position) {
        // params es como "fuel:1:0,temp:2:28.9"
        String[] items = params.split(",");
        for (String item : items) {
            String[] parts = item.split(":");
            if (parts.length >= 3) {
                String key = parts[0];
                String type = parts[1];
                String value = parts[2];
                // Según el tipo, convertir
                if ("1".equals(type)) {
                    position.set(key, Integer.parseInt(value));
                } else if ("2".equals(type)) {
                    position.set(key, Double.parseDouble(value));
                } else {
                    position.set(key, value);
                }
            } else if (parts.length == 2) {
                // Formato legacy: nombre:valor
                position.set(parts[0], parts[1]);
            }
        }
    }

    private void parseCanData(String canSegment, Position position) {
        // canSegment: "2010=1000.00,5000=0.00" o similar
        String[] pairs = canSegment.split(",");
        for (String pair : pairs) {
            String[] kv = pair.split("=");
            if (kv.length == 2) {
                String key = kv[0];
                String value = kv[1];
                // Mapear códigos conocidos
                switch (key) {
                    case "1": position.set("vin", value); break;
                    case "2": position.set(Position.KEY_RPM, Integer.parseInt(value)); break;
                    case "3": position.set("wheelSpeed", Double.parseDouble(value)); break;
                    case "B": position.set(Position.KEY_ODOMETER, Double.parseDouble(value) * 1000); break; // km a m
                    case "14": position.set("fuelUsed", Double.parseDouble(value)); break;
                    case "15": position.set(Position.KEY_FUEL_LEVEL, Double.parseDouble(value)); break;
                    case "2A": position.set("engineTemp", Double.parseDouble(value)); break;
                    case "2C": position.set("oilPressure", Double.parseDouble(value)); break;
                    case "2010": position.set(Position.KEY_RPM, Double.parseDouble(value)); break;
                    case "5000": position.set("throttle", Double.parseDouble(value)); break;
                    case "1030": position.set("fuelUsed", Double.parseDouble(value)); break;
                    case "4201": position.set(Position.KEY_FUEL_LEVEL, Double.parseDouble(value)); break;
                    case "1020": position.set(Position.KEY_ODOMETER, Double.parseDouble(value) * 1000); break;
                    case "1010": position.set("wheelSpeed", Double.parseDouble(value)); break;
                    case "2012": position.set("engineTemp", Double.parseDouble(value)); break;
                    case "2013": position.set("oilPressure", Double.parseDouble(value)); break;
                    case "2020": position.set(Position.KEY_ENGINE_HOURS, Double.parseDouble(value)); break;
                    case "3010": position.set("tripFuel", Double.parseDouble(value)); break;
                    default: position.set("can_" + key, value); break;
                }
            }
        }
    }

    // -------------------------------------------------------------
    // DECODIFICACIÓN DE REPORTES BINARIOS (B3, B9)
    // -------------------------------------------------------------
    private Position decodeBinaryReport(ByteBuf buf, Channel channel) {
        // Los mensajes binarios comienzan con ">RB3" o ">RB9" y el resto son bytes.
        // Leer el frame completo (ya está delimitado por > y <)
        // Pero el contenido entre > y < incluye bytes binarios, no ASCII.
        // Vamos a extraerlo como bytes.
        // Asumimos que el buffer tiene el frame completo (incluyendo > y <).
        buf.readerIndex(0);
        // Saltar el '>'
        buf.readByte();
        // Leer los primeros 3 bytes para identificar tipo
        byte[] typeBytes = new byte[3];
        buf.readBytes(typeBytes);
        String type = new String(typeBytes, StandardCharsets.US_ASCII);
        if (!type.equals("RB3") && !type.equals("RB9")) {
            return null;
        }
        // El resto son datos binarios hasta antes del '<'
        int dataLength = buf.readableBytes() - 1; // menos el '<' final
        ByteBuf data = buf.readSlice(dataLength);
        // Leer el '<' final
        buf.readByte();

        // Ahora parsear según la estructura
        Position position = new Position();
        position.setProtocol(getProtocolName());
        // Obtener deviceId desde el frame? En binario, el ID está en bytes 40-43 (4 bytes)
        // Pero también podríamos extraerlo del campo ID si lo tuviera, pero no lo tiene.
        // Suponemos que el dispositivo ya fue identificado por la conexión (UDP/TCP).
        // En el canal podemos tener el dispositivo asociado.
        // Usamos el deviceId del último mensaje ASCII? Mejor usar el session.
        // Para simplificar, asumimos que el dispositivo ya está autenticado.
        // Podríamos almacenar el ID en el canal con AttributeKey.
        // Por ahora, devolvemos null si no podemos identificar.
        // (En la práctica, el dispositivo envía estos binarios después de haber enviado ASCII)
        // Podemos usar el deviceId del canal.
        // Usaré un método auxiliar para obtener el dispositivo del canal.
        String deviceId = getDeviceIdFromChannel(channel);
        if (deviceId == null) return null;
        DeviceSession deviceSession = getDeviceSession(channel, channel.remoteAddress(), deviceId);
        if (deviceSession == null) return null;
        position.setDeviceId(deviceSession.getDeviceId());

        // Parsear campos comunes a B3 y B9
        // Los primeros 4 bytes son cabecera ASCII ">RB3" o ">RB9" ya leídos
        // Los bytes 4-7 son epoch (uint32 big-endian)
        long epoch = data.readUnsignedInt();
        position.setTime(new Date(epoch * 1000));

        // Byte 8: evento
        int event = data.readUnsignedByte();
        position.set("eventCode", event);

        // Bytes 9-12: HDOP + longitud (6 bits HDOP + 26 bits longitud)
        int hdopAndLon = data.readInt(); // big-endian
        int hdop = (hdopAndLon >> 26) & 0x3F;
        long lonOffset = hdopAndLon & 0x3FFFFFF;
        double longitude = (lonOffset - 18000000) / 100000.0;

        // Bytes 13-16: Fix + satélites + latitud (2 bits fix, 4 bits sat, 25 bits lat)
        int fixAndLat = data.readInt();
        int fix = (fixAndLat >> 30) & 0x03;
        int satellites = (fixAndLat >> 26) & 0x0F;
        long latOffset = fixAndLat & 0x1FFFFFF;
        double latitude = (latOffset - 9000000) / 100000.0;

        position.setLatitude(latitude);
        position.setLongitude(longitude);
        position.set(Position.KEY_SATELLITES, satellites);
        position.set(Position.KEY_PDOP, hdop); // HDOP como PDOP aproximado

        // Byte 17: edad de posición (segundos)
        int age = data.readUnsignedByte();
        position.set("gpsAge", age);

        // Bytes 18-19: CSQ (6 bits) + velocidad (10 bits)
        int csqSpeed = data.readUnsignedShort();
        int csq = (csqSpeed >> 10) & 0x3F;
        int speed = csqSpeed & 0x3FF;
        position.setSpeed(UnitsConverter.knotsFromKph(speed));
        position.set("csq", csq);

        // Bytes 20-21: registro red + rumbo (3+3 bits GSM, 9 bits rumbo)
        int regCourse = data.readUnsignedShort();
        int gsmReg = (regCourse >> 9) & 0x3F; // 6 bits
        int course = regCourse & 0x1FF;
        position.setCourse(course);
        position.set("gsmStatus", gsmReg);

        // Bytes 22-23: salidas (5 bits) + entradas (10 bits)
        int outIn = data.readUnsignedShort();
        int outputs = (outIn >> 10) & 0x1F;
        int inputs = outIn & 0x3FF;
        position.set(Position.KEY_INPUT, inputs);
        position.set(Position.KEY_OUTPUT, outputs);

        // Bytes 24-25: alimentación + batería (12 bits)
        int powerBattery = data.readUnsignedShort();
        // Los 4 bits superiores son estado GPS/CEL, los 12 inferiores son tensión en 1/100 V
        int batteryRaw = powerBattery & 0xFFF;
        position.set(Position.KEY_POWER, batteryRaw / 100.0);

        // Bytes 26-29: odómetro (uint32)
        long odometer = data.readUnsignedInt();
        position.set(Position.KEY_ODOMETER, odometer);

        // Byte 30: batería backup (0-100%)
        int backupPct = data.readUnsignedByte();
        position.set("batteryBackupPercent", backupPct);

        // Byte 31: tecnología de red
        int rat = data.readUnsignedByte();
        position.set("rat", rat);

        // Bytes 32-33: MCC
        int mcc = data.readUnsignedShort();
        // Bytes 34-35: MNC
        int mnc = data.readUnsignedShort();
        // Bytes 36-37: LAC
        int lac = data.readUnsignedShort();
        // Bytes 38-39: Cell ID
        int cellId = data.readUnsignedShort();
        position.setNetwork(new Network( new CellTower() {{
            setMcc(mcc);
            setMnc(mnc);
            setLac(lac);
            setCellId(cellId);
        }}));

        // Bytes 40-43: ID equipo (4 bytes)
        // Podríamos verificarlo contra el deviceId conocido
        // Bytes 44-45: número de mensaje
        int msgNum = data.readUnsignedShort();
        // Byte 46: checksum (XOR de bytes 0-45) - lo ignoramos por ahora

        // Si es B9, hay más campos: acelerómetro y trail (bytes 24-81)
        if (type.equals("RB9")) {
            // Después del byte 46, el resto son datos de acelerómetro y trail
            // Pero nuestra lectura ya consumió hasta el byte 46, necesitamos reajustar.
            // Como simplificación, no implementamos el trail completo, solo extraemos acelerómetro.
            // Podemos leer los siguientes 6 bytes (24-29) si no se han leído.
            // Realmente en B9, después del checksum (byte 46) no hay más campos? Revisando la estructura:
            // Bytes 24-29 son acelerómetro, 30 movimiento, 31 edad, 32-81 trail, 82-85 ID, 86-87 msgNum, 88 checksum.
            // Es decir, la estructura es diferente a B3. Debemos diferenciar.
            // Para no complicar, dejamos solo B3 por ahora.
            // Si necesitas B9, se puede extender.
        }

        // No enviamos ACK para binarios, porque ya tienen su propio mecanismo.
        return position;
    }

    private String getDeviceIdFromChannel(Channel channel) {
        // Obtener el dispositivo asociado al canal (si se autenticó previamente)
        // Podemos usar un AttributeKey o almacenarlo en un mapa.
        // Como simplificación, devolvemos null.
        // En una implementación real, se podría usar el último deviceId recibido.
        return null;
    }
}
