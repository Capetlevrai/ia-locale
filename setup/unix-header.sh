#!/usr/bin/env bash
# CapetLocal-Setup.sh : installe « IA locale » sur un Mac (puce Apple) ou un PC Linux.
#   bash CapetLocal-Setup.sh            (options : --data-dir DOSSIER, --no-model, --unattended)
# Le reste du fichier est l'installateur et le plugin, compressés.
echo "IA locale pour Paseo : installation"
echo "Tout s'installe tout seul : Paseo, l'agent, le moteur et le modèle conseillé pour ta machine."
DIR="$(mktemp -d "${TMPDIR:-/tmp}/CapetLocal-Setup.XXXXXX")" || exit 1
LINE=$(awk '/^__CAPET_PAYLOAD__$/ { print NR + 1; exit 0 }' "$0")
tail -n +"$LINE" "$0" | tar -xzf - -C "$DIR" || { echo "Installateur abîmé : télécharge-le à nouveau."; exit 1; }
bash "$DIR/install.sh" "$@"
STATUS=$?
rm -rf "$DIR"
exit $STATUS
__CAPET_PAYLOAD__
