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

import org.traccar.BaseProtocolEncoder;
import org.traccar.Protocol;
import org.traccar.model.Command;

import java.util.concurrent.atomic.AtomicInteger;

public class RinhoProtocolEncoder extends BaseProtocolEncoder {

    public RinhoProtocolEncoder(Protocol protocol) {
        super(protocol);
    }

    // ── Contador de mensajes para comandos (rango 0x8000-0xFFFF) ──
    private static final AtomicInteger COMMAND_MSG_NUM = new AtomicInteger(0x8000);

    public static int getNextCommandMsgNum() {
        int num = COMMAND_MSG_NUM.getAndIncrement();
        if (num > 0xFFFF) {
            COMMAND_MSG_NUM.set(0x8000);
            num = 0x8000;
        }
        return num;
    }

    // ── Mapeo de comandos Traccar → cuerpo Rinho ─────────────────
    private String getCommandBody(Command command) {
        return switch (command.getType()) {
            case Command.TYPE_POSITION_SINGLE -> "QGP";
            case Command.TYPE_ENGINE_STOP      -> "SXP00,1";
            case Command.TYPE_ENGINE_RESUME    -> "SXP00,0";
            case Command.TYPE_CUSTOM           -> command.getString(Command.KEY_DATA);
            default                            -> "QVR";
        };
    }

    @Override
    protected Object encodeCommand(Command command) {
        String deviceId = getUniqueId(command.getDeviceId());
        String body = getCommandBody(command);
        if (body == null || body.isEmpty()) {
            return null;
        }

        int msgNum = getNextCommandMsgNum();
        String msgNumHex = String.format("%04X", msgNum);

        // Construir mensaje: >BODY;#NNNN;ID=XXXX;*CC<
        String partial = ">" + body + ";#" + msgNumHex + ";ID=" + deviceId + ";*";
        String checksum = RinhoProtocolDecoder.calculateChecksum(partial);
        String full = partial + checksum + "<";

        return full;
    }

}
