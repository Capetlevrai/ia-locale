#!/usr/bin/env bash
# Installe « IA locale (Capet Local) » sur un Mac (puce Apple) ou un PC Linux, de zéro
# jusqu'au modèle prêt. Équivalent de install.ps1 (Windows). Chaque étape vérifie avant
# d'agir et peut être relancée sans risque :
#   1. Paseo (téléchargé et installé s'il manque, service démarré)
#   2. Carte graphique (Linux : NVIDIA moteur CUDA, AMD moteur Vulkan ; Mac : moteur Metal)
#   3. Mémoire et dossier des données
#   4. Bun + Oh My Pi (l'agent)
#   5. Node.js (outils navigateur de l'agent)
#   6. Plugin IA locale, copié et activé dans Paseo
#   7. Moteur llama.cpp + modèle conseillé, chargé, agent « IA locale » ajouté à Paseo
# Aucun droit administrateur nécessaire.
#
#   bash install.sh                               # tout installer
#   bash install.sh --data-dir /mnt/data/Capet    # moteur et modèles ailleurs
#   options : --no-model  --skip-node  --unattended
set -uo pipefail

OMP_VERSION="18.8.0"
MIN_BUN="1.3.14"   # OMP 18.8 uses `using` declarations: older Bun fails to parse it.
PLUGIN_ID="capet-local"
GATEWAY="http://127.0.0.1:8190"
STEPS=7
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DATA_DIR=""; NO_MODEL=0; SKIP_NODE=0; UNATTENDED=0
while [ $# -gt 0 ]; do
  case "$1" in
    --data-dir) DATA_DIR="${2:-}"; shift ;;
    --data-dir=*) DATA_DIR="${1#*=}" ;;
    --no-model) NO_MODEL=1 ;;
    --skip-node) SKIP_NODE=1 ;;
    --unattended) UNATTENDED=1 ;;
    *) echo "Option inconnue : $1"; exit 2 ;;
  esac
  shift
done

if [ -t 1 ]; then C_CYAN=$'\e[36m'; C_GREEN=$'\e[32m'; C_YELLOW=$'\e[33m'; C_RED=$'\e[31m'; C_OFF=$'\e[0m'
else C_CYAN=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_OFF=""; fi
step() { printf '\n%s[%s/%s] %s%s\n' "$C_CYAN" "$1" "$STEPS" "$2" "$C_OFF"; }
ok()   { printf '  %sOK%s  %s\n' "$C_GREEN" "$C_OFF" "$1"; }
warn() { printf '  %s!%s   %s\n' "$C_YELLOW" "$C_OFF" "$1"; }
fail() {
  printf '  %sX%s   %s\n' "$C_RED" "$C_OFF" "$1"
  if [ "$UNATTENDED" = 0 ] && [ -t 0 ]; then printf '\nAppuie sur Entrée pour fermer.'; read -r _; fi
  exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }
# Version a >= b (dotted numbers).
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }
gateway_up() { curl -fsS -m 10 "$GATEWAY/capet/status" >/dev/null 2>&1; }

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin) MAC=1 ;;
  Linux) MAC=0 ;;
  *) echo "Système non pris en charge : $OS (Windows : CapetLocal-Setup.exe)"; exit 1 ;;
esac
have curl || fail "curl est nécessaire (sudo apt install curl, ou l'équivalent de ta distribution)."
have tar || fail "tar est nécessaire."

# --- 1. Paseo ---------------------------------------------------------------
step 1 "Paseo"
find_paseo() {
  local c
  if [ "$MAC" = 1 ]; then
    for c in "/Applications/Paseo.app/Contents/Resources/bin/paseo" "$HOME/Applications/Paseo.app/Contents/Resources/bin/paseo"; do
      [ -x "$c" ] && { echo "$c"; return; }
    done
  else
    # .deb / .rpm install, then our own per-user copy.
    for c in "/opt/Paseo/resources/bin/paseo" "$HOME/.local/opt/Paseo/resources/bin/paseo"; do
      [ -x "$c" ] && { echo "$c"; return; }
    done
  fi
  c="$(command -v paseo 2>/dev/null)" && [ -n "$c" ] && { echo "$c"; return; }
  return 1
}
FEED="https://github.com/getpaseo/paseo/releases/latest/download"
PASEO="$(find_paseo)"
if [ -z "$PASEO" ]; then
  TMP="$(mktemp -d)"
  if [ "$MAC" = 1 ]; then
    [ "$ARCH" = "arm64" ] || fail "Ce Mac a un processeur Intel : il faut un Mac à puce Apple (M1 ou plus récent)."
    YML="$(curl -fsSL "$FEED/latest-mac.yml")" || fail "Impossible de joindre GitHub pour télécharger Paseo."
    FILE="$(printf '%s\n' "$YML" | sed -n 's/^ *- url: *\(Paseo-.*-arm64\.zip\) *$/\1/p' | head -n1)"
    [ -n "$FILE" ] || fail "Version de Paseo introuvable sur GitHub."
    echo "  Téléchargement de Paseo..."
    curl -fL --retry 10 --retry-delay 5 -C - --progress-bar -o "$TMP/$FILE" "$FEED/$FILE" || fail "Téléchargement de Paseo impossible."
    SHA="$(printf '%s\n' "$YML" | awk -v f="$FILE" '$0 ~ "url: *"f"$" {getline; sub(/^ *sha512: */, ""); print; exit}')"
    if [ -n "$SHA" ] && [ "$(shasum -a 512 -b "$TMP/$FILE" | cut -d' ' -f1 | xxd -r -p | base64)" != "$SHA" ]; then
      fail "Le fichier de Paseo téléchargé est abîmé : relance l'installation."
    fi
    DEST="/Applications"; [ -w "$DEST" ] || { DEST="$HOME/Applications"; mkdir -p "$DEST"; }
    ditto -x -k "$TMP/$FILE" "$DEST" || fail "Paseo n'a pas pu être décompressé dans $DEST."
    xattr -dr com.apple.quarantine "$DEST/Paseo.app" 2>/dev/null || true
  else
    [ "$ARCH" = "x86_64" ] || fail "Paseo pour Linux n'existe qu'en x86_64 (processeur actuel : $ARCH)."
    VERSION="$(curl -fsSL "$FEED/latest-linux.yml" | sed -n 's/^version: *//p' | head -n1)"
    [ -n "$VERSION" ] || fail "Impossible de joindre GitHub pour télécharger Paseo."
    FILE="Paseo-$VERSION-x64.tar.gz"
    echo "  Téléchargement de Paseo $VERSION (environ 140 Mo)..."
    curl -fL --retry 10 --retry-delay 5 -C - --progress-bar -o "$TMP/$FILE" "$FEED/$FILE" || fail "Téléchargement de Paseo impossible."
    mkdir -p "$HOME/.local/opt" "$HOME/.local/bin" "$HOME/.local/share/applications"
    rm -rf "$HOME/.local/opt/Paseo"
    mkdir -p "$HOME/.local/opt/Paseo"
    tar -xzf "$TMP/$FILE" -C "$HOME/.local/opt/Paseo" --strip-components=1 || fail "Paseo n'a pas pu être décompressé."
    ln -sf "$HOME/.local/opt/Paseo/resources/bin/paseo" "$HOME/.local/bin/paseo"
    # Without the setuid chrome-sandbox (needs root), Electron must run without its sandbox.
    cat > "$HOME/.local/share/applications/paseo.desktop" <<EOF
[Desktop Entry]
Name=Paseo
Exec="$HOME/.local/opt/Paseo/Paseo" --no-sandbox %U
Icon=$HOME/.local/opt/Paseo/resources/icon.png
Type=Application
Categories=Development;
EOF
  fi
  rm -rf "$TMP"
  PASEO="$(find_paseo)" || fail "Paseo ne s'est pas installé. Installe-le depuis https://paseo.sh puis relance l'installation."
fi
ok "Paseo $("$PASEO" --version 2>/dev/null | tail -n1)"
CONFIG="$HOME/.paseo/config.json"
if [ ! -f "$CONFIG" ]; then
  echo "  Première configuration de Paseo..."
  "$PASEO" onboard --relay --voice disable --timeout 300 >/dev/null 2>&1
  [ -f "$CONFIG" ] || fail "La première configuration de Paseo a échoué (paseo onboard)."
  ok "Service Paseo configuré et démarré (accès depuis le téléphone activé)"
else
  "$PASEO" start --timeout 180 >/dev/null 2>&1
fi

# --- 2. Carte graphique -----------------------------------------------------
step 2 "Carte graphique"
VRAM_GB=0
if [ "$MAC" = 1 ]; then
  [ "$ARCH" = "arm64" ] || fail "Il faut un Mac à puce Apple (M1 ou plus récent)."
  CHIP="$(sysctl -n machdep.cpu.brand_string 2>/dev/null)"
  RAM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
  # macOS lets the GPU use about 2/3 of the RAM (3/4 above 36 GB).
  if [ "$RAM_GB" -gt 36 ]; then VRAM_GB=$(( RAM_GB * 3 / 4 )); else VRAM_GB=$(( RAM_GB * 2 / 3 )); fi
  ok "$CHIP, $RAM_GB Go de mémoire, dont environ $VRAM_GB Go utilisables par l'IA (moteur Metal)"
  warn "Mac : prise en charge expérimentale. Les modèles y tournent plus lentement que sur une carte NVIDIA."
  MACOS="$(sw_vers -productVersion)"
  version_ge "$MACOS" "14.0" || warn "macOS $MACOS : macOS 14 (Sonoma) ou plus récent est conseillé."
elif have nvidia-smi && nvidia-smi -L >/dev/null 2>&1; then
  # Several cards: the plugin runs the engine on the one with the most VRAM.
  BEST="$(nvidia-smi --query-gpu=memory.total,name,driver_version,compute_cap --format=csv,noheader,nounits | sort -t, -k1 -n -r | head -n1)"
  COUNT="$(nvidia-smi -L | wc -l | tr -d ' ')"
  MEM="$(echo "$BEST" | cut -d, -f1 | tr -d ' ')"
  NAME="$(echo "$BEST" | cut -d, -f2 | sed 's/^ *//')"
  DRIVER="$(echo "$BEST" | cut -d, -f3 | tr -d ' ')"
  CAP="$(echo "$BEST" | cut -d, -f4 | tr -d ' ')"
  VRAM_GB=$(( (MEM + 512) / 1024 ))
  ok "$NAME, $VRAM_GB Go de VRAM, pilote $DRIVER"
  [ "$COUNT" -gt 1 ] && ok "$COUNT cartes détectées : l'IA locale utilisera seulement la $NAME"
  # RTX 50 (Blackwell, compute 12.x): CUDA 13 engine, driver 580+. Others: CUDA 12.8, 570+.
  NEED=570; [ "${CAP%%.*}" -ge 12 ] && NEED=580
  [ "${DRIVER%%.*}" -ge "$NEED" ] || fail "Pilote NVIDIA trop ancien ($DRIVER, il faut $NEED ou plus). Mets-le à jour avec le gestionnaire de pilotes de ta distribution puis relance l'installation."
else
  # AMD (amdgpu publishes its VRAM in sysfs), engine on Vulkan.
  BEST=0
  for dev in /sys/class/drm/card[0-9]*/device; do
    [ -r "$dev/mem_info_vram_total" ] || continue
    T=$(cat "$dev/mem_info_vram_total"); [ "$T" -gt "$BEST" ] && BEST=$T
  done
  [ "$BEST" -gt 0 ] || fail "Aucune carte graphique détectée. Il faut une carte NVIDIA (avec son pilote propriétaire) ou AMD."
  VRAM_GB=$(( (BEST / 1048576 + 512) / 1024 ))
  ok "Carte AMD, $VRAM_GB Go de VRAM (moteur Vulkan)"
  warn "Cartes AMD : prise en charge expérimentale. Les cartes NVIDIA restent les plus rapides."
  if ! ldconfig -p 2>/dev/null | grep -q 'libvulkan\.so\.1'; then
    fail "Vulkan est absent. Installe-le (Ubuntu : sudo apt install mesa-vulkan-drivers libvulkan1) puis relance l'installation."
  fi
fi
[ "$VRAM_GB" -lt 8 ] && warn "Moins de 8 Go utilisables : aucun modèle n'est conseillé pour cette machine."

# --- 3. Mémoire et dossier des données ----------------------------------------
step 3 "Mémoire et dossier des données"
if [ "$MAC" = 1 ]; then
  ok "$RAM_GB Go de mémoire unifiée"
  DEFAULT_HOME="$HOME/Library/Application Support/CapetLocal"
else
  RAM_GB=$(( $(awk '/^MemTotal:/ {print $2}' /proc/meminfo) / 1048576 ))
  if [ "$RAM_GB" -lt 15 ]; then warn "$RAM_GB Go de RAM : 16 Go minimum conseillés, 32 Go pour les cartes de 10 à 12 Go."
  else ok "$RAM_GB Go de RAM"; fi
  DEFAULT_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/CapetLocal"
fi
POINTER="$DEFAULT_HOME/home.txt"
if [ -z "$DATA_DIR" ] && [ -f "$POINTER" ]; then DATA_DIR="$(tr -d '\r\n' < "$POINTER")"; fi
[ -z "$DATA_DIR" ] && DATA_DIR="$DEFAULT_HOME"
mkdir -p "$DATA_DIR" "$DEFAULT_HOME" || fail "Impossible de créer le dossier $DATA_DIR."
DATA_DIR="$(cd "$DATA_DIR" && pwd)"
# The plugin reads this pointer to find its data folder (engine, models, logs).
if [ "$DATA_DIR" != "$DEFAULT_HOME" ]; then printf '%s' "$DATA_DIR" > "$POINTER"; else rm -f "$POINTER"; fi
FREE_GB=$(( $(df -Pk "$DATA_DIR" | awk 'NR==2 {print $4}') / 1048576 ))
ok "Moteur et modèles dans $DATA_DIR ($FREE_GB Go libres)"
[ "$FREE_GB" -lt 25 ] && warn "Moins de 25 Go libres sur ce disque : un modèle pèse de 11 à 19 Go."

# --- 4. Bun + Oh My Pi ------------------------------------------------------
step 4 "Agent Oh My Pi"
BUN_BIN="$HOME/.bun/bin"
BUN="$BUN_BIN/bun"
if [ ! -x "$BUN" ]; then
  echo "  Installation de Bun (runtime de l'agent)..."
  # Bun's own script needs unzip, often missing: fetch the release and unpack it ourselves.
  if [ "$MAC" = 1 ]; then ZIP="bun-darwin-aarch64"
  elif grep -q avx2 /proc/cpuinfo; then ZIP="bun-linux-x64"
  else ZIP="bun-linux-x64-baseline"; fi
  TMP="$(mktemp -d)"
  curl -fL --retry 5 --progress-bar -o "$TMP/bun.zip" "https://github.com/oven-sh/bun/releases/latest/download/$ZIP.zip" || fail "Téléchargement de Bun impossible."
  if have unzip; then unzip -q "$TMP/bun.zip" -d "$TMP"
  elif have python3; then python3 -m zipfile -e "$TMP/bun.zip" "$TMP"
  elif have bsdtar; then bsdtar -xf "$TMP/bun.zip" -C "$TMP"
  else fail "Il faut unzip pour installer Bun (sudo apt install unzip)."; fi
  mkdir -p "$BUN_BIN"
  mv "$TMP/$ZIP/bun" "$BUN" && chmod +x "$BUN"
  ln -sf bun "$BUN_BIN/bunx"
  rm -rf "$TMP"
fi
[ -x "$BUN" ] || fail "Bun ne s'est pas installé dans $BUN_BIN (https://bun.sh)."
export PATH="$BUN_BIN:$PATH"
BUN_VERSION="$("$BUN" --version | cut -d- -f1)"
if ! version_ge "$BUN_VERSION" "$MIN_BUN"; then
  echo "  Mise à jour de Bun $BUN_VERSION -> $MIN_BUN ou plus (requis par Oh My Pi)..."
  "$BUN" upgrade >/dev/null 2>&1
  BUN_VERSION="$("$BUN" --version | cut -d- -f1)"
  version_ge "$BUN_VERSION" "$MIN_BUN" || fail "Bun $BUN_VERSION est trop ancien et n'a pas pu être mis à jour (bun upgrade)."
fi
ok "Bun $BUN_VERSION"
# Oh My Pi in its own folder, run by bun directly (see findOmp in the plugin).
AGENT_DIR="$DATA_DIR/agent"
CLI="$AGENT_DIR/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js"
CURRENT=""; [ -f "$CLI" ] && CURRENT="$("$BUN" "$CLI" --version 2>/dev/null)"
case "$CURRENT" in
  "omp/$OMP_VERSION"*) ;;
  *)
    echo "  Installation d'Oh My Pi $OMP_VERSION..."
    rm -rf "$AGENT_DIR"; mkdir -p "$AGENT_DIR"
    echo '{ "name": "capet-local-agent", "private": true }' > "$AGENT_DIR/package.json"
    (cd "$AGENT_DIR" && "$BUN" add "@oh-my-pi/pi-coding-agent@$OMP_VERSION" >/dev/null 2>&1)
    CURRENT=""; [ -f "$CLI" ] && CURRENT="$("$BUN" "$CLI" --version 2>/dev/null)"
    case "$CURRENT" in omp/*) ;; *) fail "Oh My Pi ne démarre pas après installation : $CURRENT" ;; esac
    ;;
esac
ok "Oh My Pi ${CURRENT#omp/}"

# --- 5. Node.js -------------------------------------------------------------
step 5 "Node.js (outils navigateur de l'agent)"
if have npx; then
  ok "Node.js $(node --version)"
elif [ "$SKIP_NODE" = 1 ]; then
  warn "Ignoré : les outils navigateur (Playwright, Chrome DevTools) ne seront pas disponibles."
elif [ "$MAC" = 1 ] && have brew; then
  echo "  Installation de Node.js..."
  brew install node >/dev/null 2>&1
  if have npx; then ok "Node.js $(node --version)"; else warn "Node.js non installé : outils navigateur indisponibles (https://nodejs.org)."; fi
else
  warn "Node.js absent : installe-le pour les outils navigateur (https://nodejs.org, ou le gestionnaire de paquets de ta distribution)."
fi

# --- 6. Plugin --------------------------------------------------------------
step 6 "Plugin IA locale"
SOURCE="$HERE/$PLUGIN_ID"
[ -f "$SOURCE/paseo-plugin.json" ] || fail "Dossier du plugin introuvable : $SOURCE"
TARGET="$DATA_DIR/plugin/$PLUGIN_ID"
rm -rf "$TARGET"; mkdir -p "$TARGET"
# Paseo provides zod and its SDK to plugins: node_modules and test tools are not needed.
(cd "$SOURCE" && tar -cf - --exclude=./node_modules --exclude=./tools .) | (cd "$TARGET" && tar -xf -) || fail "Copie du plugin impossible."
ok "Plugin copié dans $TARGET"
HELPER="$HERE/setup/install-helper.mjs"
[ -f "$HELPER" ] || HELPER="$HERE/install-helper.mjs"
"$BUN" "$HELPER" enable-plugins "$CONFIG" || fail "Configuration de Paseo illisible : $CONFIG"
if "$PASEO" plugin ls 2>/dev/null | grep -q "^$PLUGIN_ID[[:space:]]"; then
  "$PASEO" plugin reload "$PLUGIN_ID" >/dev/null 2>&1
  ok "Plugin déjà installé : rechargé"
else
  "$PASEO" plugin install "$TARGET" >/dev/null 2>&1
  ok "Plugin installé dans Paseo"
fi
# Stop and start rather than restart: a service started before Bun was installed keeps its old PATH.
"$PASEO" daemon stop >/dev/null 2>&1
"$PASEO" start --timeout 180 >/dev/null 2>&1
"$BUN" "$HELPER" wait-gateway 180 || fail "Le plugin ne répond pas après le redémarrage de Paseo. Relance l'installation ; si ça persiste, envoie le dossier $DATA_DIR/logs."
ok "Plugin actif"

# --- 7. Moteur, modèle et agent ---------------------------------------------
step 7 "Moteur et modèle"
if [ "$NO_MODEL" = 1 ]; then
  warn "Ignoré (option --no-model) : choisis un modèle dans Paseo > IA locale."
else
  "$BUN" "$HELPER" model "$PASEO" "$CONFIG" "$HOME/.paseo/plugin-settings/$PLUGIN_ID/local.json" || exit 1
fi

printf '\n%sTerminé.%s\n' "$C_GREEN" "$C_OFF"
echo "Ouvre Paseo, crée un agent et choisis « IA locale » comme fournisseur."
echo "Réglages (modèle, contexte, outils) : Paseo > IA locale."
if [ "$UNATTENDED" = 0 ]; then
  if [ "$MAC" = 1 ]; then open -a Paseo 2>/dev/null || true
  elif [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && [ -x "$HOME/.local/opt/Paseo/Paseo" ]; then
    (setsid "$HOME/.local/opt/Paseo/Paseo" --no-sandbox >/dev/null 2>&1 &)
  fi
fi
