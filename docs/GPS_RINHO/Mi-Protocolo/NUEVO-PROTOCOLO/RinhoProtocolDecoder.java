/*
 * Copyright 2026 Rodrigo - CFP 401/403
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * ---------------------------------------------------------------------------
 * NOTAS DE IMPLEMENTACION (leer antes de tocar este archivo)
 * ---------------------------------------------------------------------------
 * Escrito desde cero en base a:
 *  1) "Guia de Integracion del Protocolo Rinho" v1.2 (PDF del fabricante)
 *  2) Captura real de consola del equipo Spider IoT (fw v1.09.16) via
 *     puerto serie/WiFi, incluyendo trafico UDP real hacia 190.1.9.151:5031
 *
 * HALLAZGO IMPORTANTE: los checksums de ejemplo del PDF del fabricante
 * NO son consistentes entre si (probablemente tipeados a mano, nunca
 * calculados). El algoritmo real (XOR de TODOS los bytes desde '>' hasta
 * '*' inclusive) se valido exitosamente contra 10+ mensajes reales de la
 * captura de consola, incluyendo ACKs, RCQ, RCR, RVR, RIO, RDB, RBU, RDL.
 * Se confio en la tabla ESTRUCTURAL de offsets del PDF (formato, no los
 * ejemplos narrados) y se valido campo a campo contra un RCR real:
 * lat/lon decodificados caen exactamente en Bahia Blanca, AR. OK.
 *
 * ALCANCE IMPLEMENTADO (confirmado o razonablemente inferido):
 *  - KA (keep-alive, sin ACK)
 *  - Reportes extendidos con base de 66 chars: CQ, CP, CR, CV, CT, CU,
 *    BQ, BR, BV, HQ, HR, HV, EQ, ER
 *  - Segmentos adicionales genericos AP=/PA= (parametros custom) y TXT=
 *  - ACK y deteccion de confirmacion de comando (msgNum >= 0x8000)
 *
 * NO IMPLEMENTADO A PROPOSITO (fuera del trafico real observado; agregar
 * si el equipo llega a generarlos):
 *  - CW (el PDF define offsets distintos entre si mismo y la doc web,
 *    ninguno confirmado contra captura real -> no confiable)
 *  - GP, CY (formato "standard" distinto al base de 66 chars, no visto
 *    en la captura real -- el equipo usa la familia extendida)
 *  - AD, AE, TX, TY, binarios BP/B3/B9, reportes de usuario (Ux/UC/EVAL)
 *  - RVR, RIO, RDB, RBU, RDL, RSN, RIMEI, RTAG, RCXHWI: se reconocen para
 *    no logguearlos como "desconocido" y para no romper el ACK, pero no
 *    generan Position (no traen coordenadas). Punto de extension si
 *    despues queres persistir esos atributos.
 *
 * CAVEAT DE ACK: el spec dice "ACK solo despues de persistir". Este
 * decoder ackea inmediatamente despues de un parseo exitoso (antes de que
 * Traccar confirme el guardado en base). Enganchar el ACK al commit real
 * requeriria un handler post-persistencia, fuera del alcance de un
 * decoder. Con esto ya se resuelve el problema original (ACKs que no
 * salian nunca); si mas adelante se necesita ack-after-commit avisame.
 * ---------------------------------------------------------------------------
 */
package org.traccar.protocol;

import io.netty.channel.Channel;
import org.traccar.BaseProtocolDecoder;
import org.traccar.NetworkMessage;
import org.traccar.Protocol;
import org.traccar.helper.BitUtil;
import org.traccar.session.DeviceSession;
import org.traccar.model.Position;

import java.net.SocketAddress;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.List;
import java.util.TimeZone;

public class RinhoProtocolDecoder extends BaseProtocolDecoder {

    public RinhoProtocolDecoder(Protocol protocol) {
        super(protocol);
    }

    // ------------------------------------------------------------------
    // Checksum: XOR de todos los caracteres desde '>' hasta '*' inclusive.
    // Validado contra 10+ mensajes reales de la captura de consola.
    // ------------------------------------------------------------------

    private String calculateChecksum(String data) {
        int checksum = 0;
        for (int i = 0; i < data.length(); i++) {
            checksum ^= data.charAt(i);
        }
        return String.format("%02X", checksum);
    }

    // ------------------------------------------------------------------
    // Base de 66 caracteres, comun a toda la familia CQ/CP/CR/CV/CT/CU/
    // BQ/BR/BV/HQ/HR/HV/EQ/ER. Offsets validados contra RCR real.
    // ------------------------------------------------------------------

    private static final class Base {
        String reportId;
        Date time;
        double latitude;
        double longitude;
        int speed;
        int course;
        int inputs;
        int outputs;
        double voltage;
        long odometer;
        boolean gpsPower;
        int gpsMode;
        int pdop;
        int satellites;
        long gpsAge;
        boolean modemPower;
        int gsmStatus;
        int csq;
    }

    private Base parseBase(String data) {
        Base b = new Base();

        b.reportId = data.substring(0, 2);

        int day = Integer.parseInt(data.substring(2, 4));
        int month = Integer.parseInt(data.substring(4, 6));
        int year = 2000 + Integer.parseInt(data.substring(6, 8));
        int hour = Integer.parseInt(data.substring(8, 10));
        int minute = Integer.parseInt(data.substring(10, 12));
        int second = Integer.parseInt(data.substring(12, 14));

        Calendar calendar = Calendar.getInstance(TimeZone.getTimeZone("UTC"));
        calendar.clear();
        calendar.set(year, month - 1, day, hour, minute, second);
        b.time = calendar.getTime();

        b.latitude = Long.parseLong(data.substring(14, 22)) / 100000.0;
        b.longitude = Long.parseLong(data.substring(22, 31)) / 100000.0;
        b.speed = Integer.parseInt(data.substring(31, 34));
        b.course = Integer.parseInt(data.substring(34, 37));
        b.inputs = Integer.parseInt(data.substring(37, 39), 16);
        b.outputs = Integer.parseInt(data.substring(39, 41), 16);
        b.voltage = Integer.parseInt(data.substring(41, 44)) / 10.0;
        b.odometer = Long.parseLong(data.substring(44, 52), 16);
        b.gpsPower = data.charAt(52) == '1';
        b.gpsMode = Character.getNumericValue(data.charAt(53));
        b.pdop = Integer.parseInt(data.substring(54, 56));
        b.satellites = Integer.parseInt(data.substring(56, 58));
        b.gpsAge = Long.parseLong(data.substring(58, 62), 16);
        b.modemPower = data.charAt(62) == '1';
        b.gsmStatus = Character.getNumericValue(data.charAt(63));
        b.csq = Integer.parseInt(data.substring(64, 66));

        return b;
    }

    private void fillPosition(Position position, Base b) {
        position.setTime(b.time);
        position.setLatitude(b.latitude);
        position.setLongitude(b.longitude);
        position.setSpeed(convertSpeed(b.speed, "kmh"));
        position.setCourse(b.course);
        position.setValid(b.gpsMode == 2 || b.gpsMode == 3);

        position.set(Position.KEY_EVENT, Integer.parseInt(b.reportId, 16));
        position.set(Position.KEY_IGNITION, BitUtil.check(b.inputs, 7));
        position.set(Position.KEY_INPUT, b.inputs);
        position.set(Position.KEY_OUTPUT, b.outputs);
        position.set(Position.KEY_POWER, b.voltage);
        position.set(Position.KEY_ODOMETER, b.odometer);
        position.set("gpsPower", b.gpsPower);
        position.set(Position.KEY_PDOP, b.pdop);
        position.set(Position.KEY_SATELLITES, b.satellites);
        position.set("gpsAge", b.gpsAge);
        position.set("modemPower", b.modemPower);
        position.set("gsmStatus", b.gsmStatus);
        position.set(Position.KEY_RSSI, b.csq);
    }

    // ------------------------------------------------------------------
    // Sufijos extendidos
    // ------------------------------------------------------------------

    // raw = signo(1) + 4 digitos + edad hex(2) = 7 chars. Conversion: valor/10 = Celsius.
    private void parseTemp(Position position, String raw, int index) {
        char sign = raw.charAt(0);
        int value = Integer.parseInt(raw.substring(1, 5));
        double celsius = (sign == '-' ? -1 : 1) * value / 10.0;
        long age = Long.parseLong(raw.substring(5, 7), 16);
        position.set(Position.PREFIX_TEMP + index, celsius);
        position.set(Position.PREFIX_TEMP + index + "Age", age);
    }

    // raw = 3 digitos decimales, valor/100 = Volts (bateria interna/respaldo)
    private void parseBackupVoltage(Position position, String raw) {
        position.set(Position.KEY_BATTERY, Integer.parseInt(raw) / 100.0);
    }

    // raw = 8 hex, segundos de marcha acumulados
    private void parseHorometer(Position position, String hex) {
        position.set("hourmeter", Long.parseLong(hex, 16));
    }

    private void parseCanData(Position position, String type, List<String> extra) {
        for (String seg : extra) {
            if (seg.startsWith("AP=") || seg.startsWith("PA=") || seg.startsWith("TXT=")) {
                continue;
            }
            if (seg.contains("=")) {
                position.set("canProtocol", "EQ".equals(type) ? "OBD-II" : "J1939");
                position.set("canData", seg);
                return;
            }
        }
    }

    private void applyTypedParam(Position position, String name, String type, String value) {
        try {
            switch (type) {
                case "1":
                    position.set(name, Long.parseLong(value));
                    break;
                case "2":
                    position.set(name, Double.parseDouble(value));
                    break;
                default:
                    position.set(name, value);
            }
        } catch (NumberFormatException e) {
            position.set(name, value);
        }
    }

    // Segmentos ;AP=... o ;PA=... con parametros custom nombre:tipo:valor (o legacy nombre:valor)
    // y segmentos ;TXT=... con texto libre.
    private void parseAdditionalParams(Position position, List<String> extra) {
        for (String seg : extra) {
            String params = null;
            if (seg.startsWith("AP=") || seg.startsWith("PA=")) {
                params = seg.substring(3);
            } else if (seg.startsWith("TXT=")) {
                position.set("textMessage", seg.substring(4));
                continue;
            }
            if (params == null) {
                continue;
            }
            for (String param : params.split(",")) {
                String[] parts = param.split(":");
                if (parts.length >= 3) {
                    applyTypedParam(position, parts[0], parts[1], parts[2]);
                } else if (parts.length == 2) {
                    position.set(parts[0], parts[1]); // formato legacy sin tipo
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Dispatch por tipo de reporte
    // ------------------------------------------------------------------

    private Position decodeBody(DeviceSession deviceSession, String body, List<String> extra) {

        if (body.equals("KA")
                || body.startsWith("RVR") || body.startsWith("RIO") || body.startsWith("RDB")
                || body.startsWith("RBU") || body.startsWith("RDL") || body.startsWith("RSN")
                || body.startsWith("RIMEI") || body.startsWith("RTAG") || body.startsWith("RCXHWI")) {
            // heartbeat / eco de comando local / inventario / version: sin coordenadas GPS.
            // No generan Position. Punto de extension si se necesita persistir estos atributos.
            return null;
        }

        if (body.length() < 3 || body.charAt(0) != 'R') {
            return null; // tipo no reconocido
        }

        String type = body.substring(1, 3);
        String data = body.substring(3);

        if (data.length() < 66) {
            return null; // base incompleta / mensaje truncado
        }

        Base base = parseBase(data);

        Position position = new Position(getProtocolName());
        position.setDeviceId(deviceSession.getDeviceId());
        fillPosition(position, base);

        String suffix = data.substring(66);

        switch (type) {
            case "CQ":
            case "CP":
                break; // sin sufijo

            case "CR":
                if (suffix.length() >= 7) {
                    parseTemp(position, suffix.substring(0, 7), 1);
                }
                break;

            case "CV":
                if (suffix.length() >= 14) {
                    parseTemp(position, suffix.substring(0, 7), 1);
                    parseTemp(position, suffix.substring(7, 14), 2);
                }
                break;

            case "CT":
                if (!extra.isEmpty() && extra.get(0).matches("[0-9A-Fa-f]{16}")) {
                    position.set("iButton", extra.get(0));
                }
                break;

            case "CU":
                if (!suffix.isEmpty()) {
                    position.set("driverSession", suffix.charAt(0) == '1');
                }
                if (!extra.isEmpty()) {
                    position.set(Position.KEY_DRIVER_UNIQUE_ID, extra.get(0));
                }
                break;

            case "BQ":
                if (suffix.length() >= 3) {
                    parseBackupVoltage(position, suffix.substring(0, 3));
                }
                break;

            case "BR":
                if (suffix.length() >= 10) {
                    parseBackupVoltage(position, suffix.substring(0, 3));
                    parseTemp(position, suffix.substring(3, 10), 1);
                }
                break;

            case "BV":
                if (suffix.length() >= 17) {
                    parseBackupVoltage(position, suffix.substring(0, 3));
                    parseTemp(position, suffix.substring(3, 10), 1);
                    parseTemp(position, suffix.substring(10, 17), 2);
                }
                break;

            case "HQ":
                if (suffix.length() >= 11) {
                    parseBackupVoltage(position, suffix.substring(0, 3));
                    parseHorometer(position, suffix.substring(3, 11));
                }
                break;

            case "HR":
                if (suffix.length() >= 18) {
                    parseBackupVoltage(position, suffix.substring(0, 3));
                    parseHorometer(position, suffix.substring(3, 11));
                    parseTemp(position, suffix.substring(11, 18), 1);
                }
                break;

            case "HV":
                if (suffix.length() >= 25) {
                    parseBackupVoltage(position, suffix.substring(0, 3));
                    parseHorometer(position, suffix.substring(3, 11));
                    parseTemp(position, suffix.substring(11, 18), 1);
                    parseTemp(position, suffix.substring(18, 25), 2);
                }
                break;

            case "EQ":
            case "ER":
                parseCanData(position, type, extra);
                break;

            default:
                // CW y otros tipos no confirmados contra captura real todavia.
                break;
        }

        parseAdditionalParams(position, extra);

        return position;
    }

    // ------------------------------------------------------------------
    // ACK
    // ------------------------------------------------------------------

    private void sendAck(Channel channel, SocketAddress remoteAddress, String msgNumHex, String uniqueId) {
        if (channel == null) {
            return;
        }
        String partial = ">ACK;#" + msgNumHex + ";ID=" + uniqueId + ";*";
        String checksum = calculateChecksum(partial);
        String response = partial + checksum + "<";
        channel.writeAndFlush(new NetworkMessage(response, remoteAddress));
    }

    // ------------------------------------------------------------------
    // Entrada principal
    // ------------------------------------------------------------------

    @Override
    protected Object decode(Channel channel, SocketAddress remoteAddress, Object msg) throws Exception {

        String sentence = (String) msg;

        if (sentence.length() < 4 || sentence.charAt(0) != '>' || sentence.charAt(sentence.length() - 1) != '<') {
            return null;
        }

        int starIndex = sentence.lastIndexOf('*');
        if (starIndex < 0) {
            return null; // malformado -> descartar en silencio, sin ACK
        }

        String checksumPart = sentence.substring(0, starIndex + 1); // '>' .. '*' inclusive
        String expectedChecksum = sentence.substring(starIndex + 1, sentence.length() - 1);
        if (!calculateChecksum(checksumPart).equalsIgnoreCase(expectedChecksum)) {
            return null; // checksum invalido -> descartar en silencio, sin ACK
        }

        String core = sentence.substring(1, starIndex); // contenido entre '>' y '*'
        String[] segments = core.split(";", -1);
        String body = segments[0];

        String msgNumHex = null;
        String uniqueId = null;
        List<String> extra = new ArrayList<>();
        for (int i = 1; i < segments.length; i++) {
            String seg = segments[i];
            if (seg.isEmpty()) {
                continue;
            }
            if (seg.startsWith("#")) {
                msgNumHex = seg.substring(1);
            } else if (seg.startsWith("ID=")) {
                uniqueId = seg.substring(3);
            } else {
                extra.add(seg);
            }
        }

        if (uniqueId == null) {
            return null; // sin ID no se puede asociar el mensaje a un dispositivo
        }

        DeviceSession deviceSession = getDeviceSession(channel, remoteAddress, uniqueId);
        if (deviceSession == null) {
            return null;
        }

        Position position = decodeBody(deviceSession, body, extra);

        // ACK solo si trae #MSGNUM, es < 0x8000 (reporte, no confirmacion de comando) y no es KA.
        if (msgNumHex != null && !"KA".equals(body)) {
            int msgNum = Integer.parseInt(msgNumHex, 16);
            if (msgNum < 0x8000) {
                sendAck(channel, remoteAddress, msgNumHex, uniqueId);
            }
        }

        return position;
    }

}
