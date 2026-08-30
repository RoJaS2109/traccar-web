#!/usr/bin/env bash
#
# deploy.sh — Despliega Rudatrak en la Raspberry Pi
#
# Uso en la Pi: ./deploy.sh
# Uso desde PC: ./deploy.sh pi@raspi
#
# Qué hace:
#   1. git pull origin master
#   2. docker build -t rudatrak:latest  (self-contained: frontend + backend)
#   3. Copia KMLs e íconos a /mnt/datos/servicios/rudatrak/trak-poi/
#      y traccar.xml a /mnt/datos/servicios/rudatrak/trak-conf/ (solo si no existe)
#   4. docker build -t carga-poi:latest (herramienta de POIs)
#   5. docker compose up -d (redeploy del stack)

set -euo pipefail

# ── Configuración ──────────────────────────────────────────
TARGET="${1:-}"                                  # SSH target (vacío = local)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"      # Donde está este script (traccar-web/)
COMPOSE_DIR="$SCRIPT_DIR"                          # El compose vive en traccar-web/
KML_DIR="/mnt/datos/servicios/rudatrak/trak-poi"  # Directorio de POIs montado en Traccar
CONF_DIR="/mnt/datos/servicios/rudatrak/trak-conf"  # Directorio de configuración montado en Traccar

# ── Credenciales ──────────────────────────────────────────
# POSTGRES_PASSWORD se lee del archivo .env (gitignoreado) del directorio.
# Docker compose interpola ${POSTGRES_PASSWORD} desde ese .env. No se exporta
# acá para no pisarlo con un valor vacío. Para override puntual, exportarla
# en el shell antes de correr este script (tiene prioridad sobre .env).

run_cmd() {
  if [ -n "$TARGET" ]; then
    ssh "$TARGET" "$@"
  else
    eval "$@"
  fi
}

echo "============================================"
echo "  Rudatrak — Build + Deploy"
echo "============================================"
echo ""

# ── 1. Pull del código ─────────────────────────────────────
echo "[1/5] Pull del repositorio..."
if [ -n "$TARGET" ]; then
  run_cmd "cd $SCRIPT_DIR && git pull origin master"
else
  cd "$SCRIPT_DIR"
  git pull origin master
fi

# ── 2. Construir imagen rudatrak ───────────────────────────
echo "[2/5] Construyendo imagen rudatrak:latest..."
if [ -n "$TARGET" ]; then
  run_cmd "cd $SCRIPT_DIR && docker build -t rudatrak:latest ."
else
  cd "$SCRIPT_DIR"
  docker build -t rudatrak:latest .
fi

# ── 3. Copiar KMLs e íconos ────────────────────────────────
echo "[3/5] Copiando KMLs e íconos a $KML_DIR..."
if [ -n "$TARGET" ]; then
  rsync -avz "$SCRIPT_DIR/data/"*.kml "$TARGET:$KML_DIR/"
  rsync -avz "$SCRIPT_DIR/data/iconos/" "$TARGET:$KML_DIR/icons/"
else
  sudo rsync -av "$SCRIPT_DIR/data/"*.kml "$KML_DIR/"
  sudo rsync -av "$SCRIPT_DIR/data/iconos/" "$KML_DIR/icons/"
fi

# ── 3b. Copiar traccar.xml (solo si no existe) ─────────────
echo "[3b/5] Verificando traccar.xml en $CONF_DIR..."
if [ -n "$TARGET" ]; then
  ssh "$TARGET" "test -f $CONF_DIR/traccar.xml || cp $SCRIPT_DIR/setup/traccar.xml $CONF_DIR/traccar.xml"
else
  if [ ! -f "$CONF_DIR/traccar.xml" ]; then
    sudo mkdir -p "$CONF_DIR"
    sudo cp "$SCRIPT_DIR/setup/traccar.xml" "$CONF_DIR/traccar.xml"
  fi
fi

# ── 4. Construir imagen carga-poi ──────────────────────────
echo "[4/5] Construyendo imagen carga-poi:latest..."
if [ -n "$TARGET" ]; then
  run_cmd "cd $SCRIPT_DIR/tools/carga-poi && docker build -t carga-poi:latest ."
else
  cd "$SCRIPT_DIR/tools/carga-poi"
  docker build -t carga-poi:latest .
fi

# ── 5. Redeploy del stack ──────────────────────────────────
echo "[5/5] Redeploy del stack vía docker compose..."
if [ -n "$TARGET" ]; then
  ssh "$TARGET" "cd $COMPOSE_DIR && docker compose up -d"
else
  cd "$COMPOSE_DIR"
  docker compose up -d
fi

echo ""
echo "============================================"
echo "  ✅ Deploy completado"
echo "  https://mh.rudatrak.com"
echo "============================================"
