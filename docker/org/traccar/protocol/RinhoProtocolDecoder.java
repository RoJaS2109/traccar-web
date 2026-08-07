/*
 * Copyright 2024 RudaTrak
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package org.traccar.protocol;

import io.netty.channel.Channel;
import org.traccar.BaseProtocolDecoder;
import org.traccar.NetworkMessage;
import org.traccar.helper.BitUtil;
import org.traccar.helper.DateBuilder;
import org.traccar.helper.Parser;
import org.traccar.helper.PatternBuilder;
import org.traccar.model.Position;
import org.traccar.session.DeviceSession;

import org.traccar.Protocol;

import java.net.SocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class RinhoProtocolDecoder extends BaseProtocolDecoder {

    // ── CAN bus token mapping (J1939 PGNs + OBD-II PIDs) ──────
    private static final Map<String, String> CAN_TOKENS = new HashMap<>();

    static {
        // J1939 (4-digit PGNs)
        CAN_TOKENS.put("2010", "engineSpeed");
        CAN_TOKENS.put("5000", "accelPct");
        CAN_TOKENS.put("1030", "fuelUsed");
        CAN_TOKENS.put("4201", "fuelPct");
        CAN_TOKENS.put("1020", "odometerTotal");
        CAN_TOKENS.put("1010", "speed");
        CAN_TOKENS.put("2012", "engineTemp");
        CAN_TOKENS.put("2013", "oilPress");
        CAN_TOKENS.put("2020", "timeEngineOn");
        CAN_TOKENS.put("3010", "fuelTrip");
        // OBD-II (short hex PIDs)
        CAN_TOKENS.put("2", "engineSpeed");
        CAN_TOKENS.put("3", "speed");
        CAN_TOKENS.put("B", "odometerTotal");
        CAN_TOKENS.put("14", "fuelUsed");
        CAN_TOKENS.put("15", "fuelPct");
        CAN_TOKENS.put("2A", "engineTemp");
        CAN_TOKENS.put("2C", "oilPress");
    }

    // ── Regex para extraer ID del dispositivo ────────────────────
    private static final Pattern DEVICE_ID_PATTERN =
            Pattern.compile(";ID=([\\w-]+)");

    // ── RCQ: Reporte de Condición ────────────────────────────────
    // >RCQ{event2}{MM2}{DD2}{YY2}{HH2}{MM2}{SS2}
    //     {±lat7}{±lon8}{speed3}{course3}
    //     {inputs2}{outputs2}{voltage3}{odometer8hex}
    //     {gpsPower1}{gpsFix1}{pdop2}{sat2}{age4hex}
    //     {gsmPower1}{gsmStatus1}{gsmLevel2}
    //     ;TXT={msg};#{num};ID={id};
    // Ref: Rinho protocol.js parserCQ()
    private static final Pattern RCQ_PATTERN = new PatternBuilder()
            .text("RCQ")
            .number("(xx)")                              //  1  event code (hex)
            .number("(dd)(dd)(dd)")                      //  2-4 month, day, year
            .number("(dd)(dd)(dd)")                      //  5-7 hour, minute, second
            .number("([-+]dd)(ddddd)")                   //  8-9 latitude DEG_DEG (7 dígitos)
            .number("([-+]ddd)(ddddd)")                  // 10-11 longitude DEG_DEG (8 dígitos)
            .number("(ddd)")                             // 12  speed
            .number("(ddd)")                             // 13  course
            .number("(xx)")                              // 14  inputs (hex)
            .number("(xx)")                              // 15  outputs (hex)
            .number("(ddd)")                             // 16  voltage (÷10)
            .number("(xxxxxxxx)")                        // 17  odometer (hex)
            .expression("([\\w])")                       // 18  gps power
            .expression("([\\w])")                       // 19  gps fix mode
            .number("(dd)")                              // 20  pdop
            .number("(dd)")                              // 21  satellites
            .number("(xxxx)")                            // 22  gps age (hex)
            .number("(d)")                               // 23  gsm power
            .expression("([\\w])")                       // 24  gsm status
            .number("(dd)")                              // 25  gsm level
            .expression("(.*)")                          // 26  rest: ;TXT=... ;#... ;ID=...
            .compile();

    // ── RER: Reporte Extendido (con CAN bus) ────────────────────
    // Igual estructura base que RCQ pero con ;{canData}; en lugar de ;TXT=
    // Ref: Rinho protocol.js parserER()
    private static final Pattern RER_PATTERN = new PatternBuilder()
            .text("RER")
            .number("(xx)")                              //  1  event code (hex)
            .number("(dd)(dd)(dd)")                      //  2-4 month, day, year
            .number("(dd)(dd)(dd)")                      //  5-7 hour, minute, second
            .number("([-+]dd)(ddddd)")                   //  8-9 latitude DEG_DEG
            .number("([-+]ddd)(ddddd)")                  // 10-11 longitude DEG_DEG
            .number("(ddd)")                             // 12  speed
            .number("(ddd)")                             // 13  course
            .number("(xx)")                              // 14  inputs (hex)
            .number("(xx)")                              // 15  outputs (hex)
            .number("(ddd)")                             // 16  voltage (÷10)
            .number("(xxxxxxxx)")                        // 17  odometer (hex)
            .expression("([\\w])")                       // 18  gps power
            .expression("([\\w])")                       // 19  gps fix mode
            .number("(dd)")                              // 20  pdop
            .number("(dd)")                              // 21  satellites
            .number("(xxxx)")                            // 22  gps age (hex)
            .number("(d)")                               // 23  gsm power
            .expression("([\\w])")                       // 24  gsm status
            .number("(dd)")                              // 25  gsm level
            .expression("(.*)")                          // 26  rest: ;{canData};#...;ID=...
            .compile();

    // ── RCR: Reporte de Evento Discreto ─────────────────────────
    // >RCReventMMDDYYHHMMSS±lat±lonspeedcourseIOflags;#index;ID=xxx;*checksum<
    // RCR es un reporte mínimo sin GPS/GSM — solo evento, posición, velocidad,
    // curso e IO flags. Los signos de coordenadas van PEGADOS (sin separador).
    // Ref: tcpdump + Rinho firmware documentation
    private static final Pattern RCR_PATTERN = new PatternBuilder()
            .text("RCR")
            .number("(xx)")                              //  1  event code (hex)
            .number("(dd)(dd)(dd)")                      //  2-4 month, day, year
            .number("(dd)(dd)(dd)")                      //  5-7 hour, minute, second
            .number("([-+]dd)(ddddd)")                   //  8-9 latitude DEG_DEG (7 dígitos)
            .number("([-+]ddd)(ddddd)")                  // 10-11 longitude DEG_DEG (8 dígitos)
            .number("(ddd)")                             // 12  speed
            .number("(ddd)")                             // 13  course
            .number("(xx)")                              // 14  IO flags (hex)
            .expression("(.*)")                          // 15  rest: ;#index;ID=xxx;*XX
            .compile();

    // ── REQ: Reporte Extendido OBD-II ───────────────────────────
    // Misma estructura base que RCQ/RER pero con CAN bus OBD-II
    // (PIDs cortos: 2=RPM, 15=fuelLevel, B=odometer, etc.)
    private static final Pattern REQ_PATTERN = new PatternBuilder()
            .text("REQ")
            .number("(xx)")                              //  1  event code (hex)
            .number("(dd)(dd)(dd)")                      //  2-4 month, day, year
            .number("(dd)(dd)(dd)")                      //  5-7 hour, minute, second
            .number("([-+]dd)(ddddd)")                   //  8-9 latitude DEG_DEG
            .number("([-+]ddd)(ddddd)")                  // 10-11 longitude DEG_DEG
            .number("(ddd)")                             // 12  speed
            .number("(ddd)")                             // 13  course
            .number("(xx)")                              // 14  inputs (hex)
            .number("(xx)")                              // 15  outputs (hex)
            .number("(ddd)")                             // 16  voltage (÷10)
            .number("(xxxxxxxx)")                        // 17  odometer (hex)
            .expression("([\\w])")                       // 18  gps power
            .expression("([\\w])")                       // 19  gps fix mode
            .number("(dd)")                              // 20  pdop
            .number("(dd)")                              // 21  satellites
            .number("(xxxx)")                            // 22  gps age (hex)
            .number("(d)")                               // 23  gsm power
            .expression("([\\w])")                       // 24  gsm status
            .number("(dd)")                              // 25  gsm level
            .expression("(.*)")                          // 26  rest: ;{canData};#...;ID=...
            .compile();

    public RinhoProtocolDecoder(Protocol protocol) {
        super(protocol);
    }

    // ── Checksum XOR (compartido con encoder) ───────────────────
    public static String calculateChecksum(String partial) {
        int checksum = 0;
        for (byte b : partial.getBytes(StandardCharsets.US_ASCII)) {
            checksum ^= b;
        }
        return String.format("%02X", checksum);
    }

    // ── Extraer número de mensaje del sufijo ───────────────────
    private String extractMsgNum(String sentence) {
        int numStart = sentence.indexOf(";#");
        if (numStart < 0) {
            return null;
        }
        int numEnd = sentence.indexOf(';', numStart + 2);
        if (numEnd < 0) {
            numEnd = sentence.indexOf('*', numStart + 2);
        }
        if (numEnd < 0) {
            return null;
        }
        return sentence.substring(numStart + 2, numEnd);
    }

    // ── Enviar ACK al dispositivo ──────────────────────────────
    private void sendAck(Channel channel, SocketAddress remoteAddress,
                         String deviceId, String msgNumHex) {
        if (channel != null && msgNumHex != null) {
            String ack = ">ACK;#" + msgNumHex + ";ID=" + deviceId + ";*";
            String checksum = calculateChecksum(ack);
            String full = ack + checksum + "<";
            channel.writeAndFlush(new NetworkMessage(full, remoteAddress));
        }
    }

    // ── Alarma Rinho → Traccar ─────────────────────────────────
    private String decodeAlarm(int eventCode) {
        return switch (eventCode) {
            case 0x03 -> Position.ALARM_LOW_BATTERY;
            case 0x04 -> Position.ALARM_SOS;
            case 0x13 -> Position.ALARM_DOOR;
            case 0x19 -> Position.ALARM_TAMPERING;
            case 0x78 -> Position.ALARM_TOW;
            default   -> null;
        };
    }

    // ── Extraer ID de dispositivo del mensaje ──────────────────
    private String extractDeviceId(String sentence) {
        Matcher matcher = DEVICE_ID_PATTERN.matcher(sentence);
        if (matcher.find()) {
            return matcher.group(1);
        }
        return null;
    }

    // ── Parseo CAN bus: "2010=1850,5000!empty,..." o "2=850,15=72,..." ──
    private void parseCanData(Position position, String canData) {
        if (canData == null || canData.isEmpty()) {
            return;
        }
        Matcher matcher = Pattern.compile("([0-9A-Fa-f]{1,4})([=!])(.*?)(?:,|$)").matcher(canData);
        while (matcher.find()) {
            String tokenId = matcher.group(1).toUpperCase();
            String operator = matcher.group(2);
            String value = matcher.group(3);
            String key = CAN_TOKENS.get(tokenId);
            if (key != null && "=".equals(operator) && !value.isEmpty()) {
                try {
                    double numericValue = Double.parseDouble(value);
                    // OBD-II odometer (PID B) viene en km, convertir a metros
                    if ("B".equalsIgnoreCase(matcher.group(1)) && "odometerTotal".equals(key)) {
                        numericValue *= 1000;
                    }
                    position.set(key, numericValue);
                } catch (NumberFormatException e) {
                    position.set(key, value);
                }
            }
        }
    }

    // ── Parseo de campos de posición comunes a RCQ/RER ────────
    private void parsePositionFields(Parser parser, Position position) {
        // Coordenadas DEG_DEG
        if (parser.hasNext(4)) {
            position.setLatitude(parser.nextCoordinate(Parser.CoordinateFormat.DEG_DEG));
            position.setLongitude(parser.nextCoordinate(Parser.CoordinateFormat.DEG_DEG));
        }

        // Velocidad y curso
        position.setSpeed(parser.nextDouble(0));
        position.setCourse(parser.nextDouble(0));

        // IO flags
        int inputs = parser.nextHexInt(0);
        int outputs = parser.nextHexInt(0);

        position.set(Position.KEY_IGNITION, BitUtil.check(inputs, 7));
        position.set(Position.KEY_INPUT, inputs);
        position.set(Position.KEY_OUTPUT, outputs);

        // Voltaje (÷10)
        position.set(Position.KEY_POWER, parser.nextDouble(0) / 10.0);

        // Odómetro (hex)
        Long odometer = parser.nextHexLong();
        if (odometer != null && odometer > 0) {
            position.set(Position.KEY_ODOMETER, odometer);
        }

        // GPS power y fix mode
        String gpsPower = parser.next();
        String gpsFix = parser.next();
        position.set(Position.KEY_GPS, "1".equals(gpsPower) ? 1 : 0);

        int pdop = parser.nextInt(0);
        int satellites = parser.nextInt(0);
        position.set(Position.KEY_PDOP, pdop);
        position.set(Position.KEY_SATELLITES, satellites);

        // GPS age (hex) — skip
        parser.nextHexInt(0);

        // GSM
        parser.nextInt(0);  // gsm power
        parser.next();      // gsm status (skip)
        int gsmLevel = parser.nextInt(0);
        position.set(Position.KEY_RSSI, gsmLevel);

        // Fix mode: '2'=2D, '3'=3D
        position.setValid("2".equals(gpsFix) || "3".equals(gpsFix));
    }

    // ── Parseo del sufijo (TXT, CAN, msgNum, atributos extra) ──
    private void parseSuffix(Parser parser, Position position, String reportType) {
        String suffix = parser.next(); // everything after the fixed fields

        if (suffix == null || suffix.isEmpty()) {
            return;
        }

        String[] parts = suffix.split(";");
        int partIdx = 0;

        // ── Sufijo extendido (temperatura, batería, horómetro, iButton) ──
        // Viene ANTES del primer ';' como parte del primer segmento
        if (parts.length > 0 && !parts[0].startsWith("#")
                && !parts[0].startsWith("TXT=")
                && !parts[0].startsWith("ID=")) {
            parseExtendedSuffix(reportType, parts[0], position);
            partIdx = 1; // saltar el primer segmento (ya procesado)
        }

        // ── Segmentos estándar: TXT, #msgNum, CAN data ──
        for (; partIdx < parts.length; partIdx++) {
            String part = parts[partIdx];
            if (part.isEmpty()) {
                continue;
            }

            if (part.startsWith("TXT=")) {
                String txt = part.substring(4);
                if (!txt.isEmpty()) {
                    position.set("txt", txt);
                }
            } else if (part.startsWith("#")) {
                position.set("msgNum", part.substring(1));
            } else if (part.startsWith("ID=")) {
                // ya procesado
            } else if (part.startsWith("*")) {
                // checksum, ignorar
            } else if (!part.isEmpty() && (reportType.equals("RER") || reportType.equals("REQ"))) {
                // En RER/REQ, lo que no es TXT/#/ID/* es el bloque CAN bus
                parseCanData(position, part);
            }
        }
    }

    // ── Parseo de sufijo extendido ──────────────────────────────
    private void parseExtendedSuffix(String reportType, String data, Position position) {
        if (data == null || data.isEmpty()) {
            return;
        }

        String type2 = reportType.length() >= 3 ? reportType.substring(1) : "";
        int offset = 0;

        try {
            switch (type2) {
                case "CR" -> { // +SXXXXAA: signo + 4 temp + 2 age hex
                    if (data.length() >= 7) {
                        double temp = parseSignedTemp(data.substring(0, 5));
                        position.set("temp1", temp);
                        position.set("temp1Age", Integer.parseInt(data.substring(5, 7), 16));
                    }
                }
                case "CV" -> { // 2× temp sensors
                    if (data.length() >= 14) {
                        position.set("temp1", parseSignedTemp(data.substring(0, 5)));
                        position.set("temp1Age", Integer.parseInt(data.substring(5, 7), 16));
                        position.set("temp2", parseSignedTemp(data.substring(7, 12)));
                        position.set("temp2Age", Integer.parseInt(data.substring(12, 14), 16));
                    }
                }
                case "CT" -> { // ;HHHHHHHHHHHHHHHH iButton
                    if (data.startsWith(";") && data.length() >= 17) {
                        position.set("ibutton", data.substring(1, 17));
                    }
                }
                case "BQ" -> { // VVV battery backup
                    if (data.length() >= 3) {
                        position.set("batteryBackup", Integer.parseInt(data.substring(0, 3)) / 100.0);
                    }
                }
                case "BR" -> { // VVV + temp1
                    if (data.length() >= 10) {
                        position.set("batteryBackup", Integer.parseInt(data.substring(0, 3)) / 100.0);
                        position.set("temp1", parseSignedTemp(data.substring(3, 8)));
                        position.set("temp1Age", Integer.parseInt(data.substring(8, 10), 16));
                    }
                }
                case "BV" -> { // VVV + 2× temp
                    if (data.length() >= 17) {
                        position.set("batteryBackup", Integer.parseInt(data.substring(0, 3)) / 100.0);
                        position.set("temp1", parseSignedTemp(data.substring(3, 8)));
                        position.set("temp1Age", Integer.parseInt(data.substring(8, 10), 16));
                        position.set("temp2", parseSignedTemp(data.substring(10, 15)));
                        position.set("temp2Age", Integer.parseInt(data.substring(15, 17), 16));
                    }
                }
                case "HQ" -> { // VVV + hourmeter (8 hex)
                    if (data.length() >= 11) {
                        position.set("batteryBackup", Integer.parseInt(data.substring(0, 3)) / 100.0);
                        long engineSeconds = Long.parseLong(data.substring(3, 11), 16);
                        position.set("engineSeconds", engineSeconds);
                        position.set(Position.KEY_HOURS, engineSeconds * 1000L); // ms
                    }
                }
                case "HR" -> { // VVV + hourmeter + temp1
                    if (data.length() >= 18) {
                        position.set("batteryBackup", Integer.parseInt(data.substring(0, 3)) / 100.0);
                        long engineSeconds = Long.parseLong(data.substring(3, 11), 16);
                        position.set("engineSeconds", engineSeconds);
                        position.set(Position.KEY_HOURS, engineSeconds * 1000L);
                        position.set("temp1", parseSignedTemp(data.substring(11, 16)));
                        position.set("temp1Age", Integer.parseInt(data.substring(16, 18), 16));
                    }
                }
                case "HV" -> { // VVV + hourmeter + 2× temp
                    if (data.length() >= 25) {
                        position.set("batteryBackup", Integer.parseInt(data.substring(0, 3)) / 100.0);
                        long engineSeconds = Long.parseLong(data.substring(3, 11), 16);
                        position.set("engineSeconds", engineSeconds);
                        position.set(Position.KEY_HOURS, engineSeconds * 1000L);
                        position.set("temp1", parseSignedTemp(data.substring(11, 16)));
                        position.set("temp1Age", Integer.parseInt(data.substring(16, 18), 16));
                        position.set("temp2", parseSignedTemp(data.substring(18, 23)));
                        position.set("temp2Age", Integer.parseInt(data.substring(23, 25), 16));
                    }
                }
                // RCQ, RCP, RER, REQ, RCU — sin sufijo extendido (o formato diferente)
            }
        } catch (NumberFormatException | IndexOutOfBoundsException e) {
            // Sufijo malformado, ignorar campos individuales
        }
    }

    // ── Parsear temperatura con signo: +0285 → 28.5, -0050 → -5.0 ──
    private static double parseSignedTemp(String tempStr) {
        char sign = tempStr.charAt(0);
        double value = Integer.parseInt(tempStr.substring(1)) / 10.0;
        return sign == '-' ? -value : value;
    }

    // ── Decodificar RCQ ────────────────────────────────────────
    private Position decodeRCQ(Channel channel, SocketAddress remoteAddress,
                               String sentence, String deviceId) throws Exception {

        Parser parser = new Parser(RCQ_PATTERN, sentence);
        if (!parser.matches()) {
            return null;
        }

        DeviceSession deviceSession = getDeviceSession(channel, remoteAddress, deviceId);
        if (deviceSession == null) {
            return null;
        }

        Position position = new Position(getProtocolName());
        position.setDeviceId(deviceSession.getDeviceId());

        // Event code (hex)
        int eventCode = parser.nextHexInt(0);
        position.set(Position.KEY_EVENT, eventCode);

        // Fecha y hora (DD/MM/YY)
        int day = parser.nextInt(0);
        int month = parser.nextInt(0);
        int year = parser.nextInt(0);
        int hour = parser.nextInt(0);
        int minute = parser.nextInt(0);
        int second = parser.nextInt(0);

        position.setTime(new DateBuilder()
                .setDate(2000 + year, month - 1, day)
                .setTime(hour, minute, second)
                .getDate());

        // Campos de posición
        parsePositionFields(parser, position);

        // Sufijo (TXT, msgNum, etc.)
        parseSuffix(parser, position, "RCQ");

        // Alarma
        String alarm = decodeAlarm(eventCode);
        if (alarm != null) {
            position.addAlarm(alarm);
        }

        return position;
    }

    // ── Decodificar RER ────────────────────────────────────────
    private Position decodeRER(Channel channel, SocketAddress remoteAddress,
                               String sentence, String deviceId) throws Exception {

        Parser parser = new Parser(RER_PATTERN, sentence);
        if (!parser.matches()) {
            return null;
        }

        DeviceSession deviceSession = getDeviceSession(channel, remoteAddress, deviceId);
        if (deviceSession == null) {
            return null;
        }

        Position position = new Position(getProtocolName());
        position.setDeviceId(deviceSession.getDeviceId());

        // Event code (hex)
        int eventCode = parser.nextHexInt(0);
        position.set(Position.KEY_EVENT, eventCode);

        // Fecha y hora (DD/MM/YY)
        int day = parser.nextInt(0);
        int month = parser.nextInt(0);
        int year = parser.nextInt(0);
        int hour = parser.nextInt(0);
        int minute = parser.nextInt(0);
        int second = parser.nextInt(0);

        position.setTime(new DateBuilder()
                .setDate(2000 + year, month - 1, day)
                .setTime(hour, minute, second)
                .getDate());

        // Campos de posición
        parsePositionFields(parser, position);

        // Sufijo (CAN bus, msgNum, etc.)
        parseSuffix(parser, position, "RER");

        // Alarma
        String alarm = decodeAlarm(eventCode);
        if (alarm != null) {
            position.addAlarm(alarm);
        }

        return position;
    }

    // ── Decodificar REQ ────────────────────────────────────────
    private Position decodeREQ(Channel channel, SocketAddress remoteAddress,
                               String sentence, String deviceId) throws Exception {

        Parser parser = new Parser(REQ_PATTERN, sentence);
        if (!parser.matches()) {
            return null;
        }

        DeviceSession deviceSession = getDeviceSession(channel, remoteAddress, deviceId);
        if (deviceSession == null) {
            return null;
        }

        Position position = new Position(getProtocolName());
        position.setDeviceId(deviceSession.getDeviceId());

        // Event code (hex)
        int eventCode = parser.nextHexInt(0);
        position.set(Position.KEY_EVENT, eventCode);

        // Fecha y hora (DD/MM/YY)
        int day = parser.nextInt(0);
        int month = parser.nextInt(0);
        int year = parser.nextInt(0);
        int hour = parser.nextInt(0);
        int minute = parser.nextInt(0);
        int second = parser.nextInt(0);

        position.setTime(new DateBuilder()
                .setDate(2000 + year, month - 1, day)
                .setTime(hour, minute, second)
                .getDate());

        // Campos de posición
        parsePositionFields(parser, position);

        // Sufijo (CAN bus OBD-II, msgNum, etc.)
        parseSuffix(parser, position, "REQ");

        // Alarma
        String alarm = decodeAlarm(eventCode);
        if (alarm != null) {
            position.addAlarm(alarm);
        }

        return position;
    }

    // ── Decodificar RCR ────────────────────────────────────────
    private Position decodeRCR(Channel channel, SocketAddress remoteAddress,
                               String sentence, String deviceId) throws Exception {

        Parser parser = new Parser(RCR_PATTERN, sentence);
        if (!parser.matches()) {
            return null;
        }

        DeviceSession deviceSession = getDeviceSession(channel, remoteAddress, deviceId);
        if (deviceSession == null) {
            return null;
        }

        Position position = new Position(getProtocolName());
        position.setDeviceId(deviceSession.getDeviceId());

        // Event code (hex)
        int eventCode = parser.nextHexInt(0);
        position.set(Position.KEY_EVENT, eventCode);

        // Fecha y hora (DD/MM/YY)
        int day = parser.nextInt(0);
        int month = parser.nextInt(0);
        int year = parser.nextInt(0);
        int hour = parser.nextInt(0);
        int minute = parser.nextInt(0);
        int second = parser.nextInt(0);

        position.setTime(new DateBuilder()
                .setDate(2000 + year, month - 1, day)
                .setTime(hour, minute, second)
                .getDate());

        // Coordenadas DEG_DEG
        if (parser.hasNext(4)) {
            position.setLatitude(parser.nextCoordinate(Parser.CoordinateFormat.DEG_DEG));
            position.setLongitude(parser.nextCoordinate(Parser.CoordinateFormat.DEG_DEG));
        }

        // Velocidad y curso
        position.setSpeed(parser.nextDouble(0));
        position.setCourse(parser.nextDouble(0));

        // IO flags (hex)
        int ioFlags = parser.nextHexInt(0);
        position.set(Position.KEY_IGNITION, BitUtil.check(ioFlags, 7));
        position.set(Position.KEY_INPUT, ioFlags);

        // Valid si las coordenadas no son cero
        position.setValid(position.getLatitude() != 0 && position.getLongitude() != 0);

        // Sufijo: extra data, #index, ID, checksum
        String suffix = parser.next();
        if (suffix != null) {
            String[] parts = suffix.split(";");
            for (String part : parts) {
                if (part.startsWith("#")) {
                    try {
                        position.set("index", Integer.parseInt(part.substring(1)));
                    } catch (NumberFormatException ignored) {
                    }
                }
            }
        }

        // Alarma
        String alarm = decodeAlarm(eventCode);
        if (alarm != null) {
            position.addAlarm(alarm);
        }

        return position;
    }

    // ── Decodificar mensajes de inventario ──────────────────────
    private Position decodeInventory(Channel channel, SocketAddress remoteAddress,
                                     String sentence, String deviceId,
                                     int msgNum, String msgNumHex) throws Exception {

        DeviceSession deviceSession = getDeviceSession(channel, remoteAddress, deviceId);
        if (deviceSession == null) {
            return null;
        }

        Position position = new Position(getProtocolName());
        position.setDeviceId(deviceSession.getDeviceId());

        // Extraer payload: desde después del prefijo hasta el primer ';'
        int separator = sentence.indexOf(';');
        String body = separator > 0 ? sentence.substring(0, separator) : sentence;

        if (body.startsWith("RVR")) {
            position.set(Position.KEY_VERSION_FW, body.substring(3));
        } else if (body.startsWith("RCXHWI")) {
            position.set(Position.KEY_VERSION_HW, body.substring(6));
        } else if (body.startsWith("RIMEI")) {
            position.set("imei", body.substring(5));
        } else if (body.startsWith("RTAG")) {
            position.set("tag", body.substring(4));
        } else if (body.startsWith("RSN")) {
            position.set("serialNumber", body.substring(3));
        }

        return position;
    }

    // ── Punto de entrada principal ─────────────────────────────
    @Override
    protected Object decode(Channel channel, SocketAddress remoteAddress, Object msg)
            throws Exception {

        String sentence = (String) msg;

        // Buscar delimitador '>'. El '<' es opcional (UDP puede no tenerlo)
        int start = sentence.indexOf('>');
        if (start < 0) {
            return null;
        }
        int endIdx = sentence.lastIndexOf('<');
        if (endIdx <= start) {
            endIdx = sentence.length(); // no hay '<', usar fin del string
        }

        // Validar checksum ANTES de quitar '>' (el checksum lo incluye)
        int checksumIdx = sentence.lastIndexOf('*');
        if (checksumIdx > start && checksumIdx < endIdx) {
            String expectedChecksum = sentence.substring(checksumIdx + 1, endIdx);
            String partial = sentence.substring(start, checksumIdx + 1); // '>' hasta '*' inclusive
            String computed = calculateChecksum(partial);
            if (!computed.equalsIgnoreCase(expectedChecksum)) {
                return null; // checksum mismatch, descartar
            }
        }

        // Extraer contenido limpio (sin '>', '<', ni '*XX')
        if (checksumIdx > start) {
            sentence = sentence.substring(start + 1, checksumIdx);
        } else {
            sentence = sentence.substring(start + 1, endIdx);
        }

        // Extraer device ID
        String deviceId = extractDeviceId(sentence);
        if (deviceId == null || deviceId.isEmpty()) {
            return null;
        }

        // Extraer número de mensaje (para ACK)
        String msgNumHex = extractMsgNum(sentence);
        int msgNum = -1;
        if (msgNumHex != null) {
            try {
                msgNum = Integer.parseInt(msgNumHex, 16);
            } catch (NumberFormatException ignored) {
            }
        }

        // Keep-alive y ACK del dispositivo
        if (sentence.startsWith("KA") || sentence.startsWith("ACK")) {
            return null;
        }

        // Mensajes de inventario (sin posición GPS)
        if (sentence.startsWith("RVR") || sentence.startsWith("RSN")
                || sentence.startsWith("RIMEI") || sentence.startsWith("RTAG")
                || sentence.startsWith("RCXHWI")) {
            return decodeInventory(channel, remoteAddress, sentence, deviceId, msgNum, msgNumHex);
        }

        // Rutear por tipo de mensaje de posición
        Position position = null;
        if (sentence.startsWith("RCQ")) {
            position = decodeRCQ(channel, remoteAddress, sentence, deviceId);
        } else if (sentence.startsWith("RER")) {
            position = decodeRER(channel, remoteAddress, sentence, deviceId);
        } else if (sentence.startsWith("REQ")) {
            position = decodeREQ(channel, remoteAddress, sentence, deviceId);
        } else if (sentence.startsWith("RCR")) {
            position = decodeRCR(channel, remoteAddress, sentence, deviceId);
        }

        // Enviar ACK si el mensaje fue procesado y es originado por el dispositivo
        if (position != null && msgNum >= 0 && msgNum < 0x8000) {
            sendAck(channel, remoteAddress, deviceId, msgNumHex);
        }

        return position;
    }

}
