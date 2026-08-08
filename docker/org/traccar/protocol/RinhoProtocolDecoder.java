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
import org.traccar.helper.UnitsConverter;
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

    // ── RCW: Reporte Compacto (odómetro decimal, campos reorganizados)
    // Ref: Rinho protocol docs — Reporte CW (G-Q-R)
    private static final Pattern RCW_PATTERN = new PatternBuilder()
            .text("RCW")
            .number("(xx)")                              //  1  report number (hex)
            .number("(dd)(dd)(dd)")                      //  2-4 day, month, year (DD/MM/YY)
            .number("(dd)(dd)(dd)")                      //  5-7 hour, minute, second
            .number("([-+]dd)(ddddd)")                   //  8-9 latitude DEG_DEG (7 dígitos)
            .number("([-+]ddd)(ddddd)")                  // 10-11 longitude DEG_DEG (8 dígitos)
            .number("(ddd)")                             // 12  course (grados)
            .number("(ddd)")                             // 13  speed (km/h)
            .expression("([\\w])")                       // 14  gps power
            .number("(dd)")                              // 15  satellites
            .number("(dddd)")                            // 16  gps age (decimal segundos)
            .expression("([\\w])")                       // 17  gps fix mode
            .number("(dd)")                              // 18  pdop
            .expression("([\\w])")                       // 19  modem power
            .expression("([\\w])")                       // 20  gsm registration
            .expression("([\\w])")                       // 21  network type (0=GSM, 1=GPRS, 2=EDGE, 3=WCDMA, 7=LTE)
            .number("(dd)")                              // 22  csq signal (0-30, 99=sin señal)
            .number("(dddddddddd)")                      // 23  odometer (decimal, metros)
            .number("(xx)")                              // 24  IGN+IN (hex)
            .expression("(.*)")                          // 25  suffix: ;ID=...
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

    // ── CQ variants: comparten estructura base con RCQ ────────────
    // RCP = sin filtro GPS, RCT = +iButton, RCU = +chofer ICL,
    // RCV = +2 temps, RBQ = +bat, RBR = +bat+temp, RBV = +bat+2temps,
    // RHQ = +bat+horometro, RHR = +bat+horometro+temp, RHV = +bat+horometro+2temps
    private static final Pattern RCP_PATTERN = new PatternBuilder()
            .text("RCP")
            .number("(xx)").number("(dd)(dd)(dd)").number("(dd)(dd)(dd)")
            .number("([-+]dd)(ddddd)").number("([-+]ddd)(ddddd)")
            .number("(ddd)").number("(ddd)").number("(xx)").number("(xx)")
            .number("(ddd)").number("(xxxxxxxx)")
            .expression("([\\w])").expression("([\\w])").number("(dd)").number("(dd)")
            .number("(xxxx)").number("(d)").expression("([\\w])").number("(dd)")
            .expression("(.*)").compile();

    private static final Pattern RCT_PATTERN = new PatternBuilder()
            .text("RCT")
            .number("(xx)").number("(dd)(dd)(dd)").number("(dd)(dd)(dd)")
            .number("([-+]dd)(ddddd)").number("([-+]ddd)(ddddd)")
            .number("(ddd)").number("(ddd)").number("(xx)").number("(xx)")
            .number("(ddd)").number("(xxxxxxxx)")
            .expression("([\\w])").expression("([\\w])").number("(dd)").number("(dd)")
            .number("(xxxx)").number("(d)").expression("([\\w])").number("(dd)")
            .expression("(.*)").compile();

    private static final Pattern RCU_PATTERN = new PatternBuilder()
            .text("RCU")
            .number("(xx)").number("(dd)(dd)(dd)").number("(dd)(dd)(dd)")
            .number("([-+]dd)(ddddd)").number("([-+]ddd)(ddddd)")
            .number("(ddd)").number("(ddd)").number("(xx)").number("(xx)")
            .number("(ddd)").number("(xxxxxxxx)")
            .expression("([\\w])").expression("([\\w])").number("(dd)").number("(dd)")
            .number("(xxxx)").number("(d)").expression("([\\w])").number("(dd)")
            .expression("(.*)").compile();

    private static final Pattern RCV_PATTERN = new PatternBuilder()
            .text("RCV")
            .number("(xx)").number("(dd)(dd)(dd)").number("(dd)(dd)(dd)")
            .number("([-+]dd)(ddddd)").number("([-+]ddd)(ddddd)")
            .number("(ddd)").number("(ddd)").number("(xx)").number("(xx)")
            .number("(ddd)").number("(xxxxxxxx)")
            .expression("([\\w])").expression("([\\w])").number("(dd)").number("(dd)")
            .number("(xxxx)").number("(d)").expression("([\\w])").number("(dd)")
            .expression("(.*)").compile();

    private static final Pattern RBQ_PATTERN = new PatternBuilder()
            .text("RBQ")
            .number("(xx)").number("(dd)(dd)(dd)").number("(dd)(dd)(dd)")
            .number("([-+]dd)(ddddd)").number("([-+]ddd)(ddddd)")
            .number("(ddd)").number("(ddd)").number("(xx)").number("(xx)")
            .number("(ddd)").number("(xxxxxxxx)")
            .expression("([\\w])").expression("([\\w])").number("(dd)").number("(dd)")
            .number("(xxxx)").number("(d)").expression("([\\w])").number("(dd)")
            .expression("(.*)").compile();

    private static final Pattern RBR_PATTERN = new PatternBuilder()
            .text("RBR")
            .number("(xx)").number("(dd)(dd)(dd)").number("(dd)(dd)(dd)")
            .number("([-+]dd)(ddddd)").number("([-+]ddd)(ddddd)")
            .number("(ddd)").number("(ddd)").number("(xx)").number("(xx)")
            .number("(ddd)").number("(xxxxxxxx)")
            .expression("([\\w])").expression("([\\w])").number("(dd)").number("(dd)")
            .number("(xxxx)").number("(d)").expression("([\\w])").number("(dd)")
            .expression("(.*)").compile();

    private static final Pattern RBV_PATTERN = new PatternBuilder()
            .text("RBV")
            .number("(xx)").number("(dd)(dd)(dd)").number("(dd)(dd)(dd)")
            .number("([-+]dd)(ddddd)").number("([-+]ddd)(ddddd)")
            .number("(ddd)").number("(ddd)").number("(xx)").number("(xx)")
            .number("(ddd)").number("(xxxxxxxx)")
            .expression("([\\w])").expression("([\\w])").number("(dd)").number("(dd)")
            .number("(xxxx)").number("(d)").expression("([\\w])").number("(dd)")
            .expression("(.*)").compile();

    private static final Pattern RHQ_PATTERN = new PatternBuilder()
            .text("RHQ")
            .number("(xx)").number("(dd)(dd)(dd)").number("(dd)(dd)(dd)")
            .number("([-+]dd)(ddddd)").number("([-+]ddd)(ddddd)")
            .number("(ddd)").number("(ddd)").number("(xx)").number("(xx)")
            .number("(ddd)").number("(xxxxxxxx)")
            .expression("([\\w])").expression("([\\w])").number("(dd)").number("(dd)")
            .number("(xxxx)").number("(d)").expression("([\\w])").number("(dd)")
            .expression("(.*)").compile();

    private static final Pattern RHR_PATTERN = new PatternBuilder()
            .text("RHR")
            .number("(xx)").number("(dd)(dd)(dd)").number("(dd)(dd)(dd)")
            .number("([-+]dd)(ddddd)").number("([-+]ddd)(ddddd)")
            .number("(ddd)").number("(ddd)").number("(xx)").number("(xx)")
            .number("(ddd)").number("(xxxxxxxx)")
            .expression("([\\w])").expression("([\\w])").number("(dd)").number("(dd)")
            .number("(xxxx)").number("(d)").expression("([\\w])").number("(dd)")
            .expression("(.*)").compile();

    private static final Pattern RHV_PATTERN = new PatternBuilder()
            .text("RHV")
            .number("(xx)").number("(dd)(dd)(dd)").number("(dd)(dd)(dd)")
            .number("([-+]dd)(ddddd)").number("([-+]ddd)(ddddd)")
            .number("(ddd)").number("(ddd)").number("(xx)").number("(xx)")
            .number("(ddd)").number("(xxxxxxxx)")
            .expression("([\\w])").expression("([\\w])").number("(dd)").number("(dd)")
            .number("(xxxx)").number("(d)").expression("([\\w])").number("(dd)")
            .expression("(.*)").compile();

    // ── RGP: General Position ───────────────────────────────────
    // RGP[AAAAAA][BBBBBB][CCCCCCCC][DDDDDDDDD][EEE][FFF][G][HH][II][JJ][KK]
    private static final Pattern RGP_PATTERN = new PatternBuilder()
            .text("RGP")
            .number("(dd)(dd)(dd)")                      //  1-3 date DDMMAA
            .number("(dd)(dd)(dd)")                      //  4-6 time HHMMSS
            .number("([-+]dd)(ddddd)")                   //  7-8 lat
            .number("([-+]ddd)(ddddd)")                  //  9-10 lon
            .number("(ddd)")                             // 11 speed (km/h)
            .number("(ddd)")                             // 12 course
            .expression("([\\w])")                       // 13 fix mode (2=2D, 3=3D)
            .number("(xx)")                              // 14 gps age (hex)
            .number("(xx)")                              // 15 inputs IGN+IN (hex)
            .number("(xx)")                              // 16 report number
            .number("(dd)")                              // 17 pdop
            .expression("(.*)")                          // 18 suffix: ;#NNNN;ID=...
            .compile();

    // ── RCY: Standard con Altitud ───────────────────────────────
    // RCY[AA][BBBBBB][CCCCCC][DDDDDDDD][EEEEEEEEE][FFF][GGG][HHHHH][I][J];D[PPPPPP];IGN[K];IN[LL];XP[MM];TXT=...
    private static final Pattern RCY_PATTERN = new PatternBuilder()
            .text("RCY")
            .number("(xx)")                              //  1  report number
            .number("(dd)(dd)(dd)")                      //  2-4 date DDMMAA
            .number("(dd)(dd)(dd)")                      //  5-7 time HHMMSS
            .number("([-+]dd)(ddddd)")                   //  8-9 lat
            .number("([-+]ddd)(ddddd)")                  // 10-11 lon
            .number("(ddd)")                             // 12 speed (km/h)
            .number("(ddd)")                             // 13 course
            .number("([-+]?d{1,5})")                     // 14 altitude (metros, con signo)
            .expression("([\\w])")                       // 15 gps status 1
            .expression("([\\w])")                       // 16 gps status 2
            .expression("(.*)")                          // 17 rest: ;DPPPPPP;IGNX;INXX;XPXX;TXT=...
            .compile();

    // ── RTX/RTY: Reportes de Texto ──────────────────────────────
    private static final Pattern RTX_PATTERN = new PatternBuilder()
            .text("RTX")
            .expression("(.*)")                          //  1  text content
            .compile();

    private static final Pattern RTY_PATTERN = new PatternBuilder()
            .text("RTY")
            .expression("(.*)")                          //  1  text content
            .compile();

    // ── RAD/RAE: Reportes Analógicos ────────────────────────────
    private static final Pattern RAD_PATTERN = new PatternBuilder()
            .text("RAD")
            .number("(xx)")                              //  1  report number
            .number("(dd)(dd)(dd)")                      //  2-4 date DDMMAA
            .number("(dd)(dd)(dd)")                      //  5-7 time HHMMSS
            .number("(dddd)")                            //  8  AIN00 (1/100 V)
            .number("(dddd)")                            //  9  AIN01
            .number("(dddd)")                            // 10  AIN02
            .number("(dddd)")                            // 11  AIN03
            .number("(dddd)")                            // 12  AIN04
            .number("(dddd)")                            // 13  AIN05
            .number("(dddd)")                            // 14  main battery
            .number("(dddd)")                            // 15  backup battery
            .expression("(.*)")                          // 16  suffix: ;#QQQQ;ID=...
            .compile();

    private static final Pattern RAE_PATTERN = new PatternBuilder()
            .text("RAE")
            .number("(xx)")                              //  1  report number
            .number("(dd)(dd)(dd)")                      //  2-4 date DDMMAA
            .number("(dd)(dd)(dd)")                      //  5-7 time HHMMSS
            .expression("([-+])").number("(dddd)")       //  8-9 AIN00 sign+value
            .expression("([-+])").number("(dddd)")       // 10-11 AIN01
            .expression("([-+])").number("(dddd)")       // 12-13 AIN02
            .expression("([-+])").number("(dddd)")       // 14-15 AIN03
            .expression("([-+])").number("(dddd)")       // 16-17 AIN04
            .expression("([-+])").number("(dddd)")       // 18-19 AIN05
            .expression("([-+])").number("(dddd)")       // 20-21 main battery
            .expression("([-+])").number("(dddd)")       // 22-23 backup battery
            .expression("(.*)")                          // 24  suffix
            .compile();

    // ── RIB: iButton + Temperatura ──────────────────────────────
    private static final Pattern RIB_PATTERN = new PatternBuilder()
            .text("RIB")
            .number("(dd)(dd)(dd)")                      //  1-3 date DDMMAA
            .number("(dd)(dd)(dd)")                      //  4-6 time HHMMSS
            .number("([-+]dd)(ddddd)")                   //  7-8 lat
            .number("([-+]ddd)(ddddd)")                  //  9-10 lon
            .number("(ddd)")                             // 11 speed (km/h)
            .number("(ddd)")                             // 12 course
            .expression("([\\w])")                       // 13 fix mode
            .number("(xx)")                              // 14 gps age (hex)
            .number("(xx)")                              // 15 inputs IGN+IN (hex)
            .number("(xx)")                              // 16 report number
            .number("(dd)")                              // 17 pdop
            .expression("(.*)")                          // 18 rest: ;iButton;sign+temp+age;...
            .compile();

    // ── RSC: Sensor de Combustible ──────────────────────────────
    private static final Pattern RSC_PATTERN = new PatternBuilder()
            .text("RSC")
            .number("(xx)")                              //  1  report number
            .number("(dd)(dd)(dd)")                      //  2-4 date DDMMAA
            .number("(dd)(dd)(dd)")                      //  5-7 time HHMMSS
            .number("(d)")                               //  8  connected (0/1)
            .number("(dddddddd)")                        //  9  total consumption (1/10 L)
            .number("(dddd)")                            // 10  flow rate (1/10 L/h)
            .number("(dddddddddd)")                      // 11  engine time (seconds)
            .number("(dddd)")                            // 12  disconnections
            .number("(ddd)")                             // 13  input temp (1/10 °C)
            .number("(ddd)")                             // 14  return temp (1/10 °C)
            .expression("(.*)")                          // 15  suffix
            .compile();

    // ── RMV: Movimiento / Accidentología ────────────────────────
    private static final Pattern RMV_PATTERN = new PatternBuilder()
            .text("RMV")
            .number("(dd)(dd)(dd)")                      //  1-3 date DDMMAA
            .number("(dd)(dd)(dd)")                      //  4-6 time HHMMSS
            .number("(d{1,3})")                          //  7  milliseconds
            .text(" X")
            .expression("([-+])(dddd)")                  //  8-9 X peak max
            .expression("([-+])(dddd)")                  // 10-11 X peak min
            .expression("([-+])(dddd)")                  // 12-13 X avg
            .text(" Y")
            .expression("([-+])(dddd)")                  // 14-15 Y peak max
            .expression("([-+])(dddd)")                  // 16-17 Y peak min
            .expression("([-+])(dddd)")                  // 18-19 Y avg
            .text(" Z")
            .expression("([-+])(dddd)")                  // 20-21 Z peak max
            .expression("([-+])(dddd)")                  // 22-23 Z peak min
            .expression("([-+])(dddd)")                  // 24-25 Z avg
            .number("(ddd)")                             // 26 course
            .number("(ddd)")                             // 27 speed (km/h)
            .number("(xx)")                              // 28 inputs
            .number("(xx)")                              // 29 event number
            .expression("(.*)")                          // 30 suffix
            .compile();

    // ── RLC: Locator (Celda) ────────────────────────────────────
    private static final Pattern RLC_PATTERN = new PatternBuilder()
            .text("LC")
            .number("(xx)")                              //  1  report number
            .number("(dd)(dd)(dd)")                      //  2-4 date DDMMAA
            .number("(dd)(dd)(dd)")                      //  5-7 time HHMMSS
            .number("([-+\\w])(dddd.dddd)")              //  8-9 lat (N/S + grados)
            .number("([-+\\w])(dddd.dddd)")              // 10-11 lon (E/W + grados)
            .number("(ddd)")                             // 12 speed (always 000)
            .number("(dd)")                              // 13 course/10
            .number("(xxxxxx)")                          // 14 I/O status
            .number("(xxxx)")                            // 15 event number
            .number("(xx)")                              // 16 seconds since query
            .number("(xxxx)")                            // 17 message number
            .expression("(.*)")                          // 18 suffix
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
                case "CU" -> { // T;HHHHHHHHHHHHHHHH session + iButton
                    if (data.length() >= 1) {
                        position.set("driverSession", data.charAt(0) == '1');
                    }
                    if (data.length() >= 18 && data.charAt(1) == ';') {
                        position.set("ibutton", data.substring(2, 18));
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

    // ── Decodificar RCW (Reporte Compacto) ──────────────────────
    private Position decodeRCW(Channel channel, SocketAddress remoteAddress,
                               String sentence, String deviceId) throws Exception {

        Parser parser = new Parser(RCW_PATTERN, sentence);
        if (!parser.matches()) {
            return null;
        }

        DeviceSession deviceSession = getDeviceSession(channel, remoteAddress, deviceId);
        if (deviceSession == null) {
            return null;
        }

        Position position = new Position(getProtocolName());
        position.setDeviceId(deviceSession.getDeviceId());

        // Report number (hex)
        position.set(Position.KEY_EVENT, parser.nextHexInt(0));

        // Fecha y hora (DD/MM/YY)
        int day = parser.nextInt(0);
        int month = parser.nextInt(0);
        int year = parser.nextInt(0);
        int hour = parser.nextInt(0);
        int minute = parser.nextInt(0);
        int second = parser.nextInt(0);

        position.setTime(new DateBuilder()
                .setDate(2000 + year, month, day)
                .setTime(hour, minute, second)
                .getDate());

        // Coordenadas
        position.setLatitude(parser.nextCoordinate(Parser.CoordinateFormat.DEG_DEG));
        position.setLongitude(parser.nextCoordinate(Parser.CoordinateFormat.DEG_DEG));

        // Course (grados) y speed (km/h → nudos)
        position.setCourse(parser.nextDouble(0));
        position.setSpeed(UnitsConverter.knotsFromKph(parser.nextDouble(0)));

        // GPS
        position.set(Position.KEY_GPS, parser.nextInt(0));
        position.set(Position.KEY_SATELLITES, parser.nextInt(0));
        position.set("gpsAge", parser.nextInt(0)); // segundos, decimal
        position.set("gpsFix", parser.nextInt(0));

        // PDOP
        position.set(Position.KEY_PDOP, parser.nextInt(0));

        // Modem / GSM
        position.set("modemPower", parser.nextInt(0));
        position.set("gsmReg", parser.nextInt(0));
        position.set("networkType", parser.nextInt(0));
        position.set(Position.KEY_RSSI, parser.nextInt(0));

        // Odómetro (metros, decimal)
        position.set(Position.KEY_ODOMETER, parser.nextLong(0));

        // IGN+IN flags (hex)
        int io = parser.nextHexInt(0);
        position.set(Position.KEY_IGNITION, BitUtil.check(io, 7));
        position.set(Position.KEY_INPUT, io);

        // Valid
        position.setValid(position.getLatitude() != 0 && position.getLongitude() != 0);

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

    // ── Decodificar RIO (Reporte de I/O) ────────────────────────
    private Position decodeRIO(Channel channel, SocketAddress remoteAddress,
                               String sentence, String deviceId) throws Exception {

        DeviceSession deviceSession = getDeviceSession(channel, remoteAddress, deviceId);
        if (deviceSession == null) {
            return null;
        }

        Position position = new Position(getProtocolName());
        position.setDeviceId(deviceSession.getDeviceId());

        // Formato: RIO;KEYVAL;KEYVAL;...;ID=XXXX
        String[] parts = sentence.split(";");
        for (String part : parts) {
            if (part.startsWith("IGN")) {
                position.set(Position.KEY_IGNITION, part.charAt(3) == '1');
            } else if (part.startsWith("IN")) {
                int inputs = 0;
                String bits = part.substring(2);
                for (int i = 0; i < bits.length(); i++) {
                    if (bits.charAt(i) == '1') {
                        inputs |= (1 << (bits.length() - 1 - i));
                    }
                }
                position.set(Position.KEY_INPUT, inputs);
            } else if (part.startsWith("XP")) {
                position.set(Position.KEY_OUTPUT, Integer.parseInt(part.substring(2)));
            } else if (part.startsWith("VBU")) {
                int vbu = Integer.parseInt(part.substring(3));
                position.set(Position.KEY_BATTERY, vbu / 100.0);
            } else if (part.startsWith("V") && !part.startsWith("VBU")) {
                double voltage = Integer.parseInt(part.substring(1)) / 10.0;
                position.set(Position.KEY_POWER, voltage);
            }
        }

        return position;
    }

    // ── Decodificar variantes CQ (RCP, RCT, RCU, RCV, RBQ, RBR, RBV, RHQ, RHR, RHV) ──
    // Todas comparten la estructura base de RCQ + campos extras en el sufijo
    private Position decodeCQVariant(Channel channel, SocketAddress remoteAddress,
                                     String sentence, String deviceId,
                                     Pattern pattern, String reportType) throws Exception {

        Parser parser = new Parser(pattern, sentence);
        if (!parser.matches()) {
            return null;
        }

        DeviceSession deviceSession = getDeviceSession(channel, remoteAddress, deviceId);
        if (deviceSession == null) {
            return null;
        }

        Position position = new Position(getProtocolName());
        position.setDeviceId(deviceSession.getDeviceId());

        int eventCode = parser.nextHexInt(0);
        position.set(Position.KEY_EVENT, eventCode);

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

        parsePositionFields(parser, position);
        parseSuffix(parser, position, reportType);

        String alarm = decodeAlarm(eventCode);
        if (alarm != null) {
            position.addAlarm(alarm);
        }

        return position;
    }

    // ── Decodificar RGP (General Position) ────────────────────
    private Position decodeRGP(Channel channel, SocketAddress remoteAddress,
                               String sentence, String deviceId) throws Exception {

        Parser parser = new Parser(RGP_PATTERN, sentence);
        if (!parser.matches()) {
            return null;
        }

        DeviceSession deviceSession = getDeviceSession(channel, remoteAddress, deviceId);
        if (deviceSession == null) {
            return null;
        }

        Position position = new Position(getProtocolName());
        position.setDeviceId(deviceSession.getDeviceId());

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

        if (parser.hasNext(4)) {
            position.setLatitude(parser.nextCoordinate(Parser.CoordinateFormat.DEG_DEG));
            position.setLongitude(parser.nextCoordinate(Parser.CoordinateFormat.DEG_DEG));
        }

        position.setSpeed(UnitsConverter.knotsFromKph(parser.nextDouble(0)));
        position.setCourse(parser.nextDouble(0));

        String fixMode = parser.next();
        position.set(Position.KEY_GPS, Integer.parseInt(parser.next(), 16)); // age hex
        int inputs = parser.nextHexInt(0);
        position.set(Position.KEY_INPUT, inputs);
        position.set(Position.KEY_IGNITION, BitUtil.check(inputs, 7));
        position.set("reportNum", parser.nextHexInt(0));
        position.set(Position.KEY_PDOP, parser.nextInt(0));

        position.setValid("2".equals(fixMode) || "3".equals(fixMode));

        // Sufijo: ;#NNNN;ID=...
        String suffix = parser.next();
        if (suffix != null) {
            String[] parts = suffix.split(";");
            for (String part : parts) {
                if (part.startsWith("#")) {
                    position.set("msgNum", part.substring(1));
                }
            }
        }

        return position;
    }

    // ── Decodificar RCY (Standard con Altitud) ────────────────
    private Position decodeRCY(Channel channel, SocketAddress remoteAddress,
                               String sentence, String deviceId) throws Exception {

        Parser parser = new Parser(RCY_PATTERN, sentence);
        if (!parser.matches()) {
            return null;
        }

        DeviceSession deviceSession = getDeviceSession(channel, remoteAddress, deviceId);
        if (deviceSession == null) {
            return null;
        }

        Position position = new Position(getProtocolName());
        position.setDeviceId(deviceSession.getDeviceId());

        position.set(Position.KEY_EVENT, parser.nextHexInt(0));

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

        if (parser.hasNext(4)) {
            position.setLatitude(parser.nextCoordinate(Parser.CoordinateFormat.DEG_DEG));
            position.setLongitude(parser.nextCoordinate(Parser.CoordinateFormat.DEG_DEG));
        }

        position.setSpeed(UnitsConverter.knotsFromKph(parser.nextDouble(0)));
        position.setCourse(parser.nextDouble(0));
        position.setAltitude(parser.nextDouble(0));

        String gpsStatus1 = parser.next();
        String gpsStatus2 = parser.next();
        position.setValid("1".equals(gpsStatus1) && "2".equals(gpsStatus2));

        // Sufijo: ;DPPPPPP;IGNX;INXX;XPXX;TXT=...;#QQQQ;ID=...
        String suffix = parser.next();
        if (suffix != null) {
            String[] parts = suffix.split(";");
            for (String part : parts) {
                if (part.startsWith("D") && part.length() >= 7) {
                    try {
                        position.set("gpsAge", Integer.parseInt(part.substring(1), 16));
                    } catch (NumberFormatException ignored) { }
                } else if (part.startsWith("IGN")) {
                    position.set(Position.KEY_IGNITION, part.length() > 3 && part.charAt(3) == '1');
                } else if (part.startsWith("IN") && part.length() >= 4) {
                    try {
                        position.set(Position.KEY_INPUT, Integer.parseInt(part.substring(2), 16));
                    } catch (NumberFormatException ignored) { }
                } else if (part.startsWith("XP") && part.length() >= 4) {
                    try {
                        position.set(Position.KEY_OUTPUT, Integer.parseInt(part.substring(2), 16));
                    } catch (NumberFormatException ignored) { }
                } else if (part.startsWith("TXT=")) {
                    position.set("txt", part.substring(4));
                } else if (part.startsWith("#")) {
                    position.set("msgNum", part.substring(1));
                }
            }
        }

        return position;
    }

    // ── Decodificar RTX/RTY (Reportes de Texto) ───────────────
    private Position decodeRTX(Channel channel, SocketAddress remoteAddress,
                               String sentence, String deviceId) throws Exception {

        DeviceSession deviceSession = getDeviceSession(channel, remoteAddress, deviceId);
        if (deviceSession == null) {
            return null;
        }

        Position position = new Position(getProtocolName());
        position.setDeviceId(deviceSession.getDeviceId());

        // RTX<texto>;#NNNN;ID=XXXX;*CC
        String[] parts = sentence.split(";");
        for (String part : parts) {
            if (part.startsWith("RTX")) {
                position.set("txt", part.substring(3));
            } else if (part.startsWith("#")) {
                position.set("msgNum", part.substring(1));
            }
        }

        return position;
    }

    private Position decodeRTY(Channel channel, SocketAddress remoteAddress,
                               String sentence, String deviceId) throws Exception {

        DeviceSession deviceSession = getDeviceSession(channel, remoteAddress, deviceId);
        if (deviceSession == null) {
            return null;
        }

        Position position = new Position(getProtocolName());
        position.setDeviceId(deviceSession.getDeviceId());

        // RTY<texto>;ID=XXXX;*CC
        String[] parts = sentence.split(";");
        for (String part : parts) {
            if (part.startsWith("RTY")) {
                // Decodificar caracteres escapados: \3E → >, \3C → <, \3B → ;, \5C → \
                String txt = part.substring(3)
                        .replace("\\3E", ">")
                        .replace("\\3C", "<")
                        .replace("\\3B", ";")
                        .replace("\\5C", "\\");
                position.set("txt", txt);
            }
        }

        return position;
    }

    // ── Decodificar RAD (Analógico) ───────────────────────────
    private Position decodeRAD(Channel channel, SocketAddress remoteAddress,
                               String sentence, String deviceId) throws Exception {

        Parser parser = new Parser(RAD_PATTERN, sentence);
        if (!parser.matches()) {
            return null;
        }

        DeviceSession deviceSession = getDeviceSession(channel, remoteAddress, deviceId);
        if (deviceSession == null) {
            return null;
        }

        Position position = new Position(getProtocolName());
        position.setDeviceId(deviceSession.getDeviceId());

        position.set("reportNum", parser.nextHexInt(0));

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

        // 8 canales analógicos (1/100 V)
        String[] analogLabels = {"ain00", "ain01", "ain02", "ain03", "ain04", "ain05", "power", "battery"};
        for (String label : analogLabels) {
            position.set(label, parser.nextDouble(0) / 100.0);
        }

        // Sufijo: ;#QQQQ;ID=...
        String suffix = parser.next();
        if (suffix != null) {
            String[] parts = suffix.split(";");
            for (String part : parts) {
                if (part.startsWith("#")) {
                    position.set("msgNum", part.substring(1));
                }
            }
        }

        return position;
    }

    // ── Decodificar RAE (Analógico con Signo) ─────────────────
    private Position decodeRAE(Channel channel, SocketAddress remoteAddress,
                               String sentence, String deviceId) throws Exception {

        Parser parser = new Parser(RAE_PATTERN, sentence);
        if (!parser.matches()) {
            return null;
        }

        DeviceSession deviceSession = getDeviceSession(channel, remoteAddress, deviceId);
        if (deviceSession == null) {
            return null;
        }

        Position position = new Position(getProtocolName());
        position.setDeviceId(deviceSession.getDeviceId());

        position.set("reportNum", parser.nextHexInt(0));

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

        // 8 canales con signo
        String[] analogLabels = {"ain00", "ain01", "ain02", "ain03", "ain04", "ain05", "power", "battery"};
        for (String label : analogLabels) {
            String sign = parser.next();
            double value = parser.nextDouble(0) / 100.0;
            position.set(label, "-".equals(sign) ? -value : value);
        }

        // Sufijo
        String suffix = parser.next();
        if (suffix != null) {
            String[] parts = suffix.split(";");
            for (String part : parts) {
                if (part.startsWith("#")) {
                    position.set("msgNum", part.substring(1));
                }
            }
        }

        return position;
    }

    // ── Decodificar RIB (iButton + Temperatura) ───────────────
    private Position decodeRIB(Channel channel, SocketAddress remoteAddress,
                               String sentence, String deviceId) throws Exception {

        Parser parser = new Parser(RIB_PATTERN, sentence);
        if (!parser.matches()) {
            return null;
        }

        DeviceSession deviceSession = getDeviceSession(channel, remoteAddress, deviceId);
        if (deviceSession == null) {
            return null;
        }

        Position position = new Position(getProtocolName());
        position.setDeviceId(deviceSession.getDeviceId());

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

        if (parser.hasNext(4)) {
            position.setLatitude(parser.nextCoordinate(Parser.CoordinateFormat.DEG_DEG));
            position.setLongitude(parser.nextCoordinate(Parser.CoordinateFormat.DEG_DEG));
        }

        position.setSpeed(UnitsConverter.knotsFromKph(parser.nextDouble(0)));
        position.setCourse(parser.nextDouble(0));

        String fixMode = parser.next();
        position.set("gpsAge", parser.nextHexInt(0));
        int inputs = parser.nextHexInt(0);
        position.set(Position.KEY_INPUT, inputs);
        position.set(Position.KEY_IGNITION, BitUtil.check(inputs, 7));
        position.set("reportNum", parser.nextHexInt(0));
        position.set(Position.KEY_PDOP, parser.nextInt(0));

        position.setValid("2".equals(fixMode) || "3".equals(fixMode));

        // Sufijo: ;iButton16chars;sign+temp4+age2
        String suffix = parser.next();
        if (suffix != null) {
            String[] parts = suffix.split(";");
            int partIdx = 0;
            if (parts.length > 0 && !parts[0].startsWith("#")
                    && !parts[0].startsWith("ID=") && parts[0].length() >= 16) {
                position.set("ibutton", parts[0].substring(0, 16));
                partIdx = 1;
            }
            for (; partIdx < parts.length; partIdx++) {
                String part = parts[partIdx];
                if (part.length() >= 7 && (part.charAt(0) == '+' || part.charAt(0) == '-')) {
                    position.set("temp1", parseSignedTemp(part.substring(0, 5)));
                    position.set("temp1Age", Integer.parseInt(part.substring(5, 7), 16));
                } else if (part.startsWith("#")) {
                    position.set("msgNum", part.substring(1));
                }
            }
        }

        return position;
    }

    // ── Decodificar RSC (Sensor Combustible) ──────────────────
    private Position decodeRSC(Channel channel, SocketAddress remoteAddress,
                               String sentence, String deviceId) throws Exception {

        Parser parser = new Parser(RSC_PATTERN, sentence);
        if (!parser.matches()) {
            return null;
        }

        DeviceSession deviceSession = getDeviceSession(channel, remoteAddress, deviceId);
        if (deviceSession == null) {
            return null;
        }

        Position position = new Position(getProtocolName());
        position.setDeviceId(deviceSession.getDeviceId());

        position.set("reportNum", parser.nextHexInt(0));

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

        position.set("sensorConnected", parser.nextInt(0) == 1);
        position.set("fuelTotal", parser.nextDouble(0) / 10.0);       // 1/10 L → L
        position.set("fuelFlow", parser.nextDouble(0) / 10.0);        // 1/10 L/h → L/h
        position.set(Position.KEY_HOURS, parser.nextLong(0) * 1000L); // seconds → ms
        position.set("disconnections", parser.nextInt(0));
        position.set("fuelTempIn", parser.nextDouble(0) / 10.0);      // 1/10 °C → °C
        position.set("fuelTempOut", parser.nextDouble(0) / 10.0);     // 1/10 °C → °C

        // Sufijo: ;#QQQQ;ID=...
        String suffix = parser.next();
        if (suffix != null) {
            String[] parts = suffix.split(";");
            for (String part : parts) {
                if (part.startsWith("#")) {
                    position.set("msgNum", part.substring(1));
                }
            }
        }

        return position;
    }

    // ── Decodificar RMV (Movimiento / Accidentología) ─────────
    private Position decodeRMV(Channel channel, SocketAddress remoteAddress,
                               String sentence, String deviceId) throws Exception {

        Parser parser = new Parser(RMV_PATTERN, sentence);
        if (!parser.matches()) {
            return null;
        }

        DeviceSession deviceSession = getDeviceSession(channel, remoteAddress, deviceId);
        if (deviceSession == null) {
            return null;
        }

        Position position = new Position(getProtocolName());
        position.setDeviceId(deviceSession.getDeviceId());

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

        position.set("milliseconds", parser.nextInt(0));

        // Acelerómetro XYZ: peak max, peak min, avg
        for (char axis : new char[]{'X', 'Y', 'Z'}) {
            position.set("accel" + axis + "Max", parseSignedVal(parser.next(), parser.nextDouble(0)));
            position.set("accel" + axis + "Min", parseSignedVal(parser.next(), parser.nextDouble(0)));
            position.set("accel" + axis + "Avg", parseSignedVal(parser.next(), parser.nextDouble(0)));
        }

        position.setCourse(parser.nextDouble(0));
        position.setSpeed(UnitsConverter.knotsFromKph(parser.nextDouble(0)));
        int inputs = parser.nextHexInt(0);
        position.set(Position.KEY_INPUT, inputs);
        position.set(Position.KEY_IGNITION, BitUtil.check(inputs, 7));
        position.set(Position.KEY_EVENT, parser.nextHexInt(0));

        // Sufijo
        String suffix = parser.next();
        if (suffix != null) {
            String[] parts = suffix.split(";");
            for (String part : parts) {
                if (part.startsWith("#")) {
                    position.set("msgNum", part.substring(1));
                }
            }
        }

        return position;
    }

    private double parseSignedVal(String sign, double value) {
        return "-".equals(sign) ? -value : value;
    }

    // ── Decodificar RLC (Locator / Celda) ─────────────────────
    private Position decodeRLC(Channel channel, SocketAddress remoteAddress,
                               String sentence, String deviceId) throws Exception {

        // RLC usa patrones de grados decimales (N/S DD.DDDD), no DEG_DEG
        Parser parser = new Parser(RLC_PATTERN, sentence);
        if (!parser.matches()) {
            return null;
        }

        DeviceSession deviceSession = getDeviceSession(channel, remoteAddress, deviceId);
        if (deviceSession == null) {
            return null;
        }

        Position position = new Position(getProtocolName());
        position.setDeviceId(deviceSession.getDeviceId());

        position.set("reportNum", parser.nextHexInt(0));

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

        // Coordenadas en formato N/S DD.DDDD, E/W FFF.FFFF
        String latHemi = parser.next();
        double lat = parser.nextDouble(0);
        String lonHemi = parser.next();
        double lon = parser.nextDouble(0);

        if ("S".equalsIgnoreCase(latHemi)) {
            lat = -lat;
        }
        if ("W".equalsIgnoreCase(lonHemi)) {
            lon = -lon;
        }
        position.setLatitude(lat);
        position.setLongitude(lon);
        position.setValid(lat != 0 || lon != 0);

        parser.nextDouble(0); // speed (siempre 0)
        parser.nextInt(0);    // course/10
        position.set("ioStatus", parser.next());
        position.set("eventNum", parser.nextInt(0));
        position.set("secondsSinceQuery", parser.nextInt(0));
        position.set("msgNum", parser.nextInt(0));

        return position;
    }

    // ── Decodificar RHT (Link a Mapas) ────────────────────────
    private Position decodeRHT(Channel channel, SocketAddress remoteAddress,
                               String sentence, String deviceId) throws Exception {

        DeviceSession deviceSession = getDeviceSession(channel, remoteAddress, deviceId);
        if (deviceSession == null) {
            return null;
        }

        Position position = new Position(getProtocolName());
        position.setDeviceId(deviceSession.getDeviceId());

        // RHT1\nhttp://... o RHT2\nhttp://...
        String type = sentence.startsWith("RHT1") ? "googleMaps" : "yahooMaps";
        String url = sentence.substring(4).trim();
        position.set("mapLink", url);
        position.set("mapType", type);

        return position;
    }
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

        // Keep-alive y ACK del dispositivo (sin posición)
        if (sentence.startsWith("KA") || sentence.startsWith("ACK")
                || sentence.startsWith("RBUOK") || sentence.startsWith("RDLOK")) {
            return null;
        }

        // Mensajes de inventario (sin posición GPS)
        if (sentence.startsWith("RVR") || sentence.startsWith("RSN")
                || sentence.startsWith("RIMEI") || sentence.startsWith("RTAG")
                || sentence.startsWith("RCXHWI")) {
            return decodeInventory(channel, remoteAddress, sentence, deviceId, msgNum, msgNumHex);
        }

        // RIO: Reporte de I/O (sin posición GPS)
        if (sentence.startsWith("RIO")) {
            return decodeRIO(channel, remoteAddress, sentence, deviceId);
        }

        // RHT: Link a mapas (sin posición GPS)
        if (sentence.startsWith("RHT")) {
            return decodeRHT(channel, remoteAddress, sentence, deviceId);
        }

        // RTX/RTY: Reportes de texto (sin posición GPS)
        if (sentence.startsWith("RTX")) {
            return decodeRTX(channel, remoteAddress, sentence, deviceId);
        }
        if (sentence.startsWith("RTY")) {
            return decodeRTY(channel, remoteAddress, sentence, deviceId);
        }

        // LC/RLC: Locator por celda
        if (sentence.startsWith("LC")) {
            return decodeRLC(channel, remoteAddress, sentence, deviceId);
        }

        // Rutear por tipo de mensaje de posición
        Position position = null;
        if (sentence.startsWith("RCQ")) {
            position = decodeRCQ(channel, remoteAddress, sentence, deviceId);
        } else if (sentence.startsWith("RCW")) {
            position = decodeRCW(channel, remoteAddress, sentence, deviceId);
        } else if (sentence.startsWith("RCP")) {
            position = decodeCQVariant(channel, remoteAddress, sentence, deviceId, RCP_PATTERN, "RCP");
        } else if (sentence.startsWith("RCT")) {
            position = decodeCQVariant(channel, remoteAddress, sentence, deviceId, RCT_PATTERN, "RCT");
        } else if (sentence.startsWith("RCU")) {
            position = decodeCQVariant(channel, remoteAddress, sentence, deviceId, RCU_PATTERN, "RCU");
        } else if (sentence.startsWith("RCV")) {
            position = decodeCQVariant(channel, remoteAddress, sentence, deviceId, RCV_PATTERN, "RCV");
        } else if (sentence.startsWith("RER")) {
            position = decodeRER(channel, remoteAddress, sentence, deviceId);
        } else if (sentence.startsWith("REQ")) {
            position = decodeREQ(channel, remoteAddress, sentence, deviceId);
        } else if (sentence.startsWith("RCR")) {
            position = decodeRCR(channel, remoteAddress, sentence, deviceId);
        } else if (sentence.startsWith("RBQ")) {
            position = decodeCQVariant(channel, remoteAddress, sentence, deviceId, RBQ_PATTERN, "RBQ");
        } else if (sentence.startsWith("RBR")) {
            position = decodeCQVariant(channel, remoteAddress, sentence, deviceId, RBR_PATTERN, "RBR");
        } else if (sentence.startsWith("RBV")) {
            position = decodeCQVariant(channel, remoteAddress, sentence, deviceId, RBV_PATTERN, "RBV");
        } else if (sentence.startsWith("RHQ")) {
            position = decodeCQVariant(channel, remoteAddress, sentence, deviceId, RHQ_PATTERN, "RHQ");
        } else if (sentence.startsWith("RHR")) {
            position = decodeCQVariant(channel, remoteAddress, sentence, deviceId, RHR_PATTERN, "RHR");
        } else if (sentence.startsWith("RHV")) {
            position = decodeCQVariant(channel, remoteAddress, sentence, deviceId, RHV_PATTERN, "RHV");
        } else if (sentence.startsWith("RGP")) {
            position = decodeRGP(channel, remoteAddress, sentence, deviceId);
        } else if (sentence.startsWith("RCY")) {
            position = decodeRCY(channel, remoteAddress, sentence, deviceId);
        } else if (sentence.startsWith("RAD")) {
            position = decodeRAD(channel, remoteAddress, sentence, deviceId);
        } else if (sentence.startsWith("RAE")) {
            position = decodeRAE(channel, remoteAddress, sentence, deviceId);
        } else if (sentence.startsWith("RIB")) {
            position = decodeRIB(channel, remoteAddress, sentence, deviceId);
        } else if (sentence.startsWith("RSC")) {
            position = decodeRSC(channel, remoteAddress, sentence, deviceId);
        } else if (sentence.startsWith("RMV")) {
            position = decodeRMV(channel, remoteAddress, sentence, deviceId);
        }

        // Enviar ACK si el mensaje fue procesado y es originado por el dispositivo
        if (position != null && msgNum >= 0 && msgNum < 0x8000) {
            sendAck(channel, remoteAddress, deviceId, msgNumHex);
        }

        return position;
    }

}
