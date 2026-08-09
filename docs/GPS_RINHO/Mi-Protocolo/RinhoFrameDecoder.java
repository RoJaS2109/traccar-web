package org.traccar.protocol.rinho;

import io.netty.buffer.ByteBuf;
import io.netty.buffer.Unpooled;
import io.netty.channel.ChannelHandlerContext;
import io.netty.handler.codec.ByteToMessageDecoder;
import org.traccar.helper.Log;

import java.util.List;

public class RinhoFrameDecoder extends ByteToMessageDecoder {

    private static final byte START = '>';
    private static final byte END = '<';

    @Override
    protected void decode(ChannelHandlerContext ctx, ByteBuf in, List<Object> out) throws Exception {
        // Buscar el inicio de un frame
        int startIndex = in.indexOf(in.readerIndex(), in.writerIndex(), START);
        while (startIndex >= 0) {
            int endIndex = in.indexOf(startIndex + 1, in.writerIndex(), END);
            if (endIndex < 0) {
                // No se encontró el fin, esperar más datos (solo para TCP)
                break;
            }
            // Extraer el frame incluyendo > y <
            int length = endIndex - startIndex + 1;
            ByteBuf frame = in.slice(startIndex, length);
            out.add(frame.retain());
            // Avanzar el readerIndex
            in.readerIndex(endIndex + 1);
            // Buscar el siguiente inicio
            startIndex = in.indexOf(in.readerIndex(), in.writerIndex(), START);
        }
        // Si no hay más frames y hay datos sobrantes (para UDP no debería)
        if (in.readableBytes() > 0 && !ctx.channel().isActive()) {
            Log.warning("Discarding incomplete frame: " + in.toString(io.netty.util.CharsetUtil.US_ASCII));
        }
    }
}
