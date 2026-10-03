# trak-mapas — recorte de zonas .pmtiles (multi-arch amd64 + arm64)
# Sin dependencias npm: copia server.js y descarga el binario pmtiles pineado.
FROM node:22-alpine

ARG TARGETARCH
ARG PMTILES_VERSION=1.31.2

# Descarga el binario go-pmtiles para la arquitectura destino (BuildKit provee TARGETARCH).
RUN apk add --no-cache curl tar && \
    ARCH="${TARGETARCH:-$(uname -m)}" && \
    case "${ARCH}" in \
      amd64|x86_64) PMTILES_ARCH="x86_64" ;; \
      arm64|aarch64) PMTILES_ARCH="arm64" ;; \
      *) echo "Arquitectura no soportada: ${ARCH}" >&2; exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/go-pmtiles_${PMTILES_VERSION}_Linux_${PMTILES_ARCH}.tar.gz" \
      -o /tmp/pmtiles.tar.gz && \
    tar -xzf /tmp/pmtiles.tar.gz -C /tmp && \
    install -m 0755 /tmp/pmtiles /usr/local/bin/pmtiles && \
    rm -f /tmp/pmtiles.tar.gz /tmp/pmtiles /tmp/LICENSE /tmp/README.md && \
    apk del curl tar

WORKDIR /app
COPY server.js ./

ENV NODE_ENV=production \
    PORT=3006

EXPOSE 3006
CMD ["node", "server.js"]
