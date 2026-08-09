package org.traccar.protocol.rinho;

import org.traccar.BaseProtocol;
import org.traccar.PipelineBuilder;
import org.traccar.TrackerServer;
import org.traccar.config.Config;
import org.traccar.model.Command;

import javax.inject.Inject;
import java.nio.ByteOrder;

public class RinhoProtocol extends BaseProtocol {

    @Inject
    public RinhoProtocol(Config config) {
        super("rinho");
        setSupportedDataCommands(
                Command.TYPE_POSITION_SINGLE,
                Command.TYPE_ENGINE_STOP,
                Command.TYPE_ENGINE_RESUME,
                Command.TYPE_CUSTOM
        );
        addServer(new TrackerServer(config, getName(), false) {
            @Override
            protected void addProtocolHandlers(PipelineBuilder pipeline, Config config) {
                pipeline.addLast(new RinhoFrameDecoder());
                pipeline.addLast(new RinhoProtocolEncoder());
                pipeline.addLast(new RinhoProtocolDecoder(RinhoProtocol.this));
            }
        });
        // También soportamos TCP si se configura
        addServer(new TrackerServer(config, getName(), true) {
            @Override
            protected void addProtocolHandlers(PipelineBuilder pipeline, Config config) {
                pipeline.addLast(new RinhoFrameDecoder());
                pipeline.addLast(new RinhoProtocolEncoder());
                pipeline.addLast(new RinhoProtocolDecoder(RinhoProtocol.this));
            }
        });
    }
}
