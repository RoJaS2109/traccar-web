# Imagen Rudatrak = Traccar + frontend + backend personalizados
# Multi-stage self-contained: compila frontend (Node) y parchea backend (JDK)
# sin requerir JDK/Node en el host ni build/ pre-existente.

# ── Stage 1: Build del frontend (Vite) ──
FROM node:22-alpine AS frontend
WORKDIR /app
# Copiar manifests primero para cachear npm ci
COPY package.json package-lock.json .npmrc ./
RUN npm ci
# Copiar el resto del código y compilar
COPY . .
RUN npm run build

# ── Stage 2: Compilar clases Java personalizadas ──
FROM eclipse-temurin:21-jdk AS builder
WORKDIR /build
# Copiar el JAR original y las dependencias de la imagen base
COPY --from=traccar/traccar:latest /opt/traccar/tracker-server.jar /build/original.jar
COPY --from=traccar/traccar:latest /opt/traccar/lib /build/lib
# Copiar los fuentes personalizados (branding + protocolo Rinho)
COPY docker/ /build/src/
# Compilar todas las clases custom y parchear el JAR
RUN javac -cp "original.jar:lib/*" -d /build/classes \
        /build/src/org/traccar/web/OverrideTextFilter.java \
        /build/src/org/traccar/protocol/RinhoProtocol.java \
        /build/src/org/traccar/protocol/RinhoProtocolDecoder.java \
        /build/src/org/traccar/protocol/RinhoProtocolEncoder.java \
        /build/src/org/traccar/handler/events/AlarmEventHandler.java \
        /build/src/org/traccar/notification/NotificationFormatter.java && \
    cp original.jar patched.jar && \
    jar uf patched.jar -C /build/classes org/ && \
    jar uf patched.jar -C /build/src META-INF/ && \
    jar uf patched.jar -C /build/src templates/

# ── Stage 3: Imagen final ──
FROM traccar/traccar:latest

# Reemplazar el backend con nuestra versión (branding RudaTrak)
COPY --from=builder /build/patched.jar /opt/traccar/tracker-server.jar

# Reemplazar el frontend por defecto con el nuestro (compilado en el Stage 1)
COPY --from=frontend /app/build/ /opt/traccar/web/

# Quitar el POI por defecto si existe (nosotros montamos el nuestro)
RUN rm -f /opt/traccar/web/poi/general.kml 2>/dev/null || true
