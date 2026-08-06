/*
 * Copyright 2025 RudaTrak
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
import org.traccar.session.DeviceSession;
import org.traccar.NetworkMessage;
import org.traccar.Protocol;
import org.traccar.helper.Checksum;
import org.traccar.helper.Parser;
import org.traccar.helper.PatternBuilder;
import org.traccar.model.Position;

import java.net.SocketAddress;
import java.util.Date;
import java.util.Locale;
import java.util.regex.Pattern;

public class RinhoProtocolDecoder extends BaseProtocolDecoder {

    public RinhoProtocolDecoder(Protocol protocol) {
        super(protocol);
    }

    // Pattern to extract coordinates in DEG_DEG format from the RCR body.
    // The message format is: >RCR<header><lat><lon><telemetry>;ID=<id>;*<checksum><
    // Coordinates use the same encoding as TAIP: sign + degrees + decimal-minutes.
    private static final Pattern COORD_PATTERN = new PatternBuilder()
            .number("([-+]dd)(d{5})")            // latitude:  sign + 2-degree + 5-minutes
            .number("([-+]ddd)(d{5})")           // longitude: sign + 3-degree + 5-minutes
            .compile();

    @Override
    protected Object decode(
            Channel channel, SocketAddress remoteAddress, Object msg) throws Exception {

        String sentence = (String) msg;

        // Strip leading '>' if present
        int beginIndex = sentence.indexOf('>');
        if (beginIndex != -1) {
            sentence = sentence.substring(beginIndex + 1);
        }

        // Must be an RCR message
        if (!sentence.startsWith("RCR")) {
            return null;
        }

        // Extract the body between "RCR" and the first ';' (attribute section)
        int attrStart = sentence.indexOf(';');
        String body;
        if (attrStart != -1) {
            body = sentence.substring(3, attrStart); // skip "RCR"
        } else {
            body = sentence.substring(3);
        }

        // Find and parse coordinates within the body using the pattern
        Parser parser = new Parser(COORD_PATTERN, body);
        if (!parser.find()) {
            return null;
        }

        Position position = new Position(getProtocolName());
        position.setTime(new Date());

        if (parser.hasNext(4)) {
            position.setLatitude(parser.nextCoordinate(Parser.CoordinateFormat.DEG_DEG));
            position.setLongitude(parser.nextCoordinate(Parser.CoordinateFormat.DEG_DEG));
            position.setValid(true);
        }

        // Parse attributes section (; separated key=value pairs)
        String[] attributes = null;
        if (attrStart != -1) {
            int attrEnd = sentence.indexOf('<', attrStart);
            if (attrEnd == -1) {
                attrEnd = sentence.length();
            }
            attributes = sentence.substring(attrStart, attrEnd).split(";");
        }

        DeviceSession deviceSession = null;
        String uniqueId = null;

        if (attributes != null) {
            for (String attribute : attributes) {
                int idx = attribute.indexOf('=');
                if (idx != -1) {
                    String key = attribute.substring(0, idx).toLowerCase(Locale.ROOT);
                    String value = attribute.substring(idx + 1);
                    if (key.equals("id")) {
                        uniqueId = value;
                        deviceSession = getDeviceSession(channel, remoteAddress, value);
                        if (deviceSession != null) {
                            position.setDeviceId(deviceSession.getDeviceId());
                        }
                    }
                }
            }
        }

        if (deviceSession == null) {
            return null;
        }

        // Send ACK response (same pattern as TAIP)
        if (channel != null && uniqueId != null) {
            String response = ">ACK;ID=" + uniqueId + ";";
            int checksum = Checksum.xor(response + "*");
            response += String.format("*%02X", checksum) + "<";
            channel.writeAndFlush(new NetworkMessage(response, remoteAddress));
        }

        return position;
    }

}
