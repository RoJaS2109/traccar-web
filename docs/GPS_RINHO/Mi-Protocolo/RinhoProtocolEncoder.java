package org.traccar.protocol.rinho;

import io.netty.buffer.ByteBuf;
import io.netty.buffer.Unpooled;
import io.netty.channel.ChannelHandlerContext;
import io.netty.handler.codec.MessageToByteEncoder;
import org.traccar.model.Command;

import java.nio.charset.StandardCharsets;

public class RinhoProtocolEncoder extends MessageToByteEncoder<Command> {

    private static final byte START = '>';
    private static final byte END = '<';

    @Override
    protected void encode(ChannelHandlerContext ctx, Command command, ByteBuf out) throws Exception {
        String deviceId = command.getDeviceId().toString();
        String body = command.getString(Command.KEY_DATA);
        if (body == null) {
            // Si no se proporciona cuerpo, usar comandos predefinidos según el tipo
            body = getDefaultCommandBody(command);
        }
        // Generar un número de mensaje único (0x0001-0x7FFF)
        int msgNum = getNextMessageNumber();
        String msgNumHex = String.format("%04X", msgNum);
        // Construir el mensaje parcial: >BODY;#MSGNUM;ID=DEVICEID;*
        String partial = START + body + ";#" + msgNumHex + ";ID=" + deviceId + ";*";
        // Calcular checksum
        String checksum = RinhoProtocolDecoder.calculateChecksum(partial);
        String fullMessage = partial + checksum + END;
        out.writeBytes(fullMessage.getBytes(StandardCharsets.US_ASCII));
        // Guardar el mensaje pendiente para asociar con la confirmación
        // (se podría usar un mapa en el decoder)
    }

    private String getDefaultCommandBody(Command command) {
        // Mapear comandos de Traccar a comandos Rinho
        switch (command.getType()) {
            case Command.TYPE_POSITION_SINGLE:
                return "QGP"; // Consulta de posición general
            case Command.TYPE_ENGINE_STOP:
                return "SXP00,1"; // Ejemplo: apagar salida XP0
            case Command.TYPE_ENGINE_RESUME:
                return "SXP00,0";
            default:
                return "QVR"; // Por defecto consultar versión
        }
    }

    private int getNextMessageNumber() {
        // Incrementar un contador global o por dispositivo
        // Aquí se puede usar un AtomicInteger
        return RinhoProtocolDecoder.getNextCommandMsgNum();
    }
}
