#!/usr/bin/env bash
#
# deploy.sh — Despliega Rudatrak en la Raspberry Pi
#
# Uso en la Pi: ./deploy.sh
# Uso desde PC: ./deploy.sh pi@raspi
#
# Requisitos en la Pi:
#   git clone git@github.com:RoJaS2109/rudatrak-web.git ~/rudatrak-web
#
# Qué hace:
#   1. git pull + npm install + npm run build
#   2. docker build -t rudatrak:latest  (Traccar + frontend nuevo)
#   3. Copia KMLs a /data/compose/63/traccar-poi/
#   4. docker build -t carga-poi:latest (herramienta de POIs)
#   5. Redeploy del stack vía Portainer API

set -euo pipefail

# ── Configuración ──────────────────────────────────────────
TARGET="${1:-}"                         # SSH target (vacío = local)
KML_DIR="/data/compose/63/traccar-poi" # Directorio de POIs montado en Traccar
REPO_DIR="${HOME}/rudatrak-web"        # Donde está clonado el repo en la Pi

# Portainer
PORTAINER_URL="http://localhost:9000"
PORTAINER_USER="rodrigo"
STACK_NAME="rudatrak"

run_cmd() {
  if [ -n "$TARGET" ]; then
    ssh "$TARGET" "$@"
  else
    eval "$@"
  fi
}

# ── Leer contraseña de Portainer ───────────────────────────
PASS_FILE="${REPO_DIR}/.portainer_pass"
if [ -f "$PASS_FILE" ]; then
  PORTAINER_PASSWORD=$(cat "$PASS_FILE")
elif [ -n "${PORTAINER_PASSWORD:-}" ]; then
  : # usar variable de entorno
else
  echo "ERROR: No se encontró la contraseña de Portainer."
  echo ""
  echo "Opciones:"
  echo "  1. Crear archivo: echo 'tu-password' > ~/rudatrak-web/.portainer_pass && chmod 600 ~/rudatrak-web/.portainer_pass"
  echo "  2. Variable de entorno: export PORTAINER_PASSWORD='tu-password'"
  exit 1
fi

# ── Función de redeploy vía Portainer API ──────────────────
portainer_deploy() {
  # 1. Autenticar
  echo "  → Autenticando con Portainer..."
  TOKEN=$(python3 -c '
import json
from urllib.request import Request, urlopen
password = open("'"$PASS_FILE"'").read().strip()
payload = json.dumps({"username": "'"$PORTAINER_USER"'", "password": password}).encode()
req = Request("'"$PORTAINER_URL"'/api/auth", data=payload, headers={"Content-Type": "application/json"})
resp = json.loads(urlopen(req).read())
print(resp.get("jwt", ""))
')

  if [ -z "$TOKEN" ]; then
    echo "  ✗ Error de autenticación con Portainer"
    return 1
  fi
  echo "  ✓ Autenticado"

  # 2. Buscar stack por nombre
  echo "  → Buscando stack '${STACK_NAME}'..."
  STACK_INFO=$(curl -s -X GET "${PORTAINER_URL}/api/stacks" \
    -H "Authorization: Bearer ${TOKEN}" | python3 -c "
import sys, json
stacks = json.load(sys.stdin)
match = next((s for s in stacks if s.get('Name') == '${STACK_NAME}'), None)
if match:
    print(f\"{match['Id']}|{match['EndpointId']}\")
else:
    print('NOT_FOUND')
")

  if [ "$STACK_INFO" = "NOT_FOUND" ]; then
    echo "  ✗ Stack '${STACK_NAME}' no encontrado en Portainer"
    return 1
  fi

  STACK_ID=$(echo "$STACK_INFO" | cut -d'|' -f1)
  ENDPOINT_ID=$(echo "$STACK_INFO" | cut -d'|' -f2)
  echo "  → Stack ID: ${STACK_ID}"

  # 3. Leer compose file y escapar para JSON
  COMPOSE_FILE="${REPO_DIR}/docker-compose.yml"
  COMPOSE_CONTENT=$(python3 -c "import json; print(json.dumps(open('${COMPOSE_FILE}').read()))")

  # 4. Ejecutar redeploy
  echo "  → Ejecutando redeploy..."
  RESULT=$(curl -s -X PUT "${PORTAINER_URL}/api/stacks/${STACK_ID}?endpointId=${ENDPOINT_ID}" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"StackFileContent\":${COMPOSE_CONTENT},\"Env\":[],\"Prune\":false,\"PullImage\":false}")

  STACK_NAME_RESULT=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('Name','ERROR'))" 2>/dev/null || echo "ERROR")

  if [ "$STACK_NAME_RESULT" != "ERROR" ]; then
    echo "  ✅ Stack '${STACK_NAME_RESULT}' redeployed correctamente"
  else
    echo "  ✗ Error en redeploy: $RESULT"
    return 1
  fi
}

echo "============================================"
echo "  Rudatrak — Build + Deploy"
echo "============================================"
echo ""

# ── 1. Pull y build del frontend ───────────────────────────
echo "[1/5] Build del frontend (Vite)..."
if [ -n "$TARGET" ]; then
  run_cmd "cd $REPO_DIR && git pull origin master && npm install && npm run build"
else
  cd "$(dirname "$0")"
  git pull origin master
  npm install
  npm run build
fi

# ── 2. Construir imagen rudatrak ───────────────────────────
echo "[2/5] Construyendo imagen rudatrak:latest..."
if [ -n "$TARGET" ]; then
  run_cmd "cd $REPO_DIR && docker build -t rudatrak:latest ."
else
  cd "$(dirname "$0")"
  docker build -t rudatrak:latest .
fi

# ── 3. Copiar KMLs ─────────────────────────────────────────
echo "[3/5] Copiando archivos KML a $KML_DIR..."
if [ -n "$TARGET" ]; then
  rsync -avz data/*.kml "$TARGET:$KML_DIR/"
else
  sudo rsync -av data/*.kml "$KML_DIR/"
fi

# ── 4. Construir imagen carga-poi ──────────────────────────
echo "[4/5] Construyendo imagen carga-poi:latest..."
if [ -n "$TARGET" ]; then
  run_cmd "cd $REPO_DIR/tools/carga-poi && docker build -t carga-poi:latest ."
else
  cd "$(dirname "$0")/tools/carga-poi"
  docker build -t carga-poi:latest .
fi

# ── 5. Redeploy vía Portainer API ─────────────────────────
echo "[5/5] Redeploy del stack '${STACK_NAME}' vía Portainer API..."
if [ -n "$TARGET" ]; then
  # Remote: enviar función + variables via SSH
  ssh "$TARGET" "
    $(declare -f portainer_deploy)
    PORTAINER_URL='${PORTAINER_URL}'
    PORTAINER_USER='${PORTAINER_USER}'
    PORTAINER_PASSWORD='${PORTAINER_PASSWORD}'
    STACK_NAME='${STACK_NAME}'
    REPO_DIR='${REPO_DIR}'
    portainer_deploy
  "
else
  portainer_deploy
fi

echo ""
echo "============================================"
echo "  ✅ Deploy completado"
echo "  https://rudatrak.com"
echo "============================================"
