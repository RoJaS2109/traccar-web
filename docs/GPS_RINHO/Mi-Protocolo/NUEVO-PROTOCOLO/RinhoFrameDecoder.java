/*
 * Copyright 2026 Rodrigo - CFP 401/403
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */
package org.traccar.protocol;

import io.netty.buffer.ByteBuf;
import io.netty.channel.ChannelHandlerContext;
import io.netty.handler.codec.ByteToMessageDecoder;

import java.util.List;

/**
 * Extrae frames delimitados por '&gt;' ... '&lt;' del protocolo Rinho (familia TAIP).
 *
 * Confirmado contra capturas reales del equipo (Spider IoT, fw v1.09.16):
 * pueden llegar varios frames completos en un mismo datagrama UDP (el equipo
 * mantiene una ventana de hasta 9 mensajes pendientes de ACK y retransmite
 * en bloque). Este decoder escanea TODOS los frames disponibles en el buffer,
 * no solo el primero.
 *
 * Comportamiento:
 * - Descarta silenciosamente cualquier basura antes del primer '&gt;'.
 * - Si un frame está incompleto (falta el '&lt;'), lo deja bufferizado y
 *   espera al próximo paquete/segmento (relevante sobre todo para TCP,
 *   donde un mensaje puede llegar partido entre dos segmentos).
 */
public class RinhoFrameDecoder extends ByteToMessageDecoder {

    @Override
    protected void decode(ChannelHandlerContext ctx, ByteBuf buf, List<Object> out) {
        while (buf.isReadable()) {
            int startIndex = buf.indexOf(buf.readerIndex(), buf.writerIndex(), (byte) '>');
            if (startIndex < 0) {
                buf.readerIndex(buf.writerIndex());
                return;
            }

            int endIndex = buf.indexOf(startIndex + 1, buf.writerIndex(), (byte) '<');
            if (endIndex < 0) {
                if (startIndex > buf.readerIndex()) {
                    buf.readerIndex(startIndex);
                }
                return;
            }

            ByteBuf frame = buf.retainedSlice(startIndex, endIndex - startIndex + 1);
            out.add(frame);
            buf.readerIndex(endIndex + 1);
        }
    }

}
