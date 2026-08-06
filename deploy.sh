#!/usr/bin/env bash
#
# deploy.sh — Despliega Rudatrak en la Raspberry Pi
#
# Uso en la Pi: ./deploy.sh
# Uso desde PC: ./deploy.sh pi@raspi
#
# Qué hace:
#   1. git pull + npm install + npm run build
#   2. docker build -t rudatrak:latest  (Traccar + frontend nuevo)
#   3. Copia KMLs a /data/compose/rudatrak/trak-poi/
#   4. docker build -t carga-poi:latest (herramienta de POIs)
#   5. docker build -t agente-ia:latest (agente IA de escaladas)
#   6. docker compose up -d (redeploy del stack)

set -euo pipefail

# ── Configuración ──────────────────────────────────────────
TARGET="${1:-}"                                  # SSH target (vacío = local)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"      # Donde está este script (traccar-web/)
COMPOSE_DIR="$(dirname "$SCRIPT_DIR")"            # Directorio padre (traccar/)
KML_DIR="/data/compose/rudatrak/trak-poi"         # Directorio de POIs montado en Traccar

# ── Variables de entorno requeridas por docker compose ────
export TRACCAR_PASSWORD="${TRACCAR_PASSWORD:-}"
export WEBHOOK_TOKEN="${WEBHOOK_TOKEN:-}"

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

# ── 1. Pull y build del frontend ───────────────────────────
echo "[1/6] Build del frontend (Vite)..."
if [ -n "$TARGET" ]; then
  run_cmd "cd $SCRIPT_DIR && git pull origin master && npm install && npm run build"
else
  cd "$SCRIPT_DIR"
  git pull origin master
  npm install
  npm run build
fi

# ── 2. Construir imagen rudatrak ───────────────────────────
echo "[2/6] Construyendo imagen rudatrak:latest..."
if [ -n "$TARGET" ]; then
  run_cmd "cd $SCRIPT_DIR && docker build -t rudatrak:latest ."
else
  cd "$SCRIPT_DIR"
  docker build -t rudatrak:latest .
fi

# ── 3. Copiar KMLs ─────────────────────────────────────────
echo "[3/6] Copiando archivos KML a $KML_DIR..."
if [ -n "$TARGET" ]; then
  rsync -avz "$SCRIPT_DIR/data/"*.kml "$TARGET:$KML_DIR/"
else
  sudo rsync -av "$SCRIPT_DIR/data/"*.kml "$KML_DIR/"
fi

# ── 4. Construir imagen carga-poi ──────────────────────────
echo "[4/6] Construyendo imagen carga-poi:latest..."
if [ -n "$TARGET" ]; then
  run_cmd "cd $SCRIPT_DIR/tools/carga-poi && docker build -t carga-poi:latest ."
else
  cd "$SCRIPT_DIR/tools/carga-poi"
  docker build -t carga-poi:latest .
fi

# ── 5. Construir imagen agente-ia ──────────────────────────
echo "[5/6] Construyendo imagen agente-ia:latest..."
if [ -n "$TARGET" ]; then
  run_cmd "cd $SCRIPT_DIR/tools/agente-ia && docker build -t agente-ia:latest ."
else
  cd "$SCRIPT_DIR/tools/agente-ia"
  docker build -t agente-ia:latest .
fi

# ── 6. Redeploy del stack ──────────────────────────────────
echo "[6/6] Redeploy del stack vía docker compose..."
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
