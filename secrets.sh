#!/usr/bin/env bash
# Les secrets de l'usine, chiffrés avec SOPS + age.
#
#   secrets.sops.env      les secrets chiffrés (jamais en clair sur le disque)
#   /etc/usine/age.key    la clé de déchiffrement (root, 600) : à sauvegarder hors du serveur
#   /run/usine-secrets/   les secrets déchiffrés, en mémoire vive, un fichier par secret ;
#                         chaque conteneur ne reçoit que les siens (secrets Docker)
#
#   bash secrets.sh installer   installe sops et age, crée la clé, le service de démarrage
#   bash secrets.sh migrer      chiffre les secrets trouvés dans .env, puis les retire de .env
#   bash secrets.sh dechiffrer  déchiffre vers /run/usine-secrets (au démarrage du serveur)
#   bash secrets.sh editer      modifie les secrets (éditeur), puis redéchiffre
#   bash secrets.sh verifier    liste les secrets remplis ou vides, sans jamais les afficher
#
# Pour changer une clé sans éditeur : la coller dans .env, puis « bash secrets.sh migrer ».
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

# Tous les secrets connus. Ajouter un secret : ici, puis dans docker-compose.yml.
SECRETS=(GITHUB_TOKEN DEPLOY_TOKEN WORKER_TOKEN CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY OPENAI_API_KEY AI_GATEWAY_API_KEY SLACK_BOT_TOKEN SLACK_APP_TOKEN SMTP_USER SMTP_PASS PORTIER_SECRET PORTIER_API_TOKEN)
CLE=/etc/usine/age.key
CHIFFRE=secrets.sops.env
SORTIE=/run/usine-secrets
GID_CONTENEURS=1000 # l'utilisateur « node » des conteneurs

sudo_si_besoin() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }
dechiffrer_flux() { sudo_si_besoin env SOPS_AGE_KEY_FILE="$CLE" sops --decrypt --input-type dotenv --output-type dotenv "$CHIFFRE"; }

installer() {
  if ! command -v age >/dev/null; then
    echo "• Installation de age (paquet Ubuntu)"
    sudo_si_besoin apt-get install -y -qq age >/dev/null
  fi
  if ! command -v sops >/dev/null; then
    echo "• Installation de sops (dernière version, somme de contrôle vérifiée)"
    local version tmp
    version=$(curl -fsSL https://api.github.com/repos/getsops/sops/releases/latest | grep -oE '"tag_name": *"[^"]+"' | cut -d'"' -f4)
    tmp=$(mktemp -d)
    curl -fsSL -o "$tmp/sops-$version.linux.amd64" "https://github.com/getsops/sops/releases/download/$version/sops-$version.linux.amd64"
    curl -fsSL -o "$tmp/sommes.txt" "https://github.com/getsops/sops/releases/download/$version/sops-$version.checksums.txt"
    (cd "$tmp" && grep " sops-$version.linux.amd64\$" sommes.txt | sha256sum -c --quiet -) || { echo "Somme de contrôle de sops invalide : abandon."; exit 1; }
    sudo_si_besoin install -m 0755 "$tmp/sops-$version.linux.amd64" /usr/local/bin/sops
    rm -rf "$tmp"
  fi
  if ! sudo_si_besoin test -f "$CLE"; then
    echo "• Création de la clé age ($CLE). SAUVEGARDE-LA hors du serveur : sans elle, les secrets sont perdus."
    sudo_si_besoin install -d -m 0700 /etc/usine
    sudo_si_besoin age-keygen -o "$CLE" 2>/dev/null
    sudo_si_besoin chmod 600 "$CLE"
  fi
  local publique
  publique=$(sudo_si_besoin age-keygen -y "$CLE")
  printf 'creation_rules:\n  - path_regex: secrets\\.sops\\.env$\n    age: %s\n' "$publique" > .sops.yaml
  # Le service qui déchiffre les secrets au démarrage, avant Docker.
  sudo_si_besoin tee /etc/systemd/system/usine-secrets.service >/dev/null <<EOF
[Unit]
Description=Usine logicielle : déchiffrer les secrets en mémoire
Before=docker.service
DefaultDependencies=no
After=local-fs.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/env bash $(pwd)/secrets.sh dechiffrer

[Install]
WantedBy=multi-user.target docker.service
EOF
  sudo_si_besoin systemctl daemon-reload
  sudo_si_besoin systemctl enable usine-secrets.service >/dev/null 2>&1
  echo "• Secrets prêts : sops $(sops --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+'), clé age en place, déchiffrement au démarrage activé."
}

# Lit les secrets actuels (chiffrés) dans un tableau associatif.
declare -A VALEURS
lire_chiffres() {
  [ -f "$CHIFFRE" ] || return 0
  while IFS= read -r ligne; do
    [[ "$ligne" =~ ^([A-Z_]+)=(.*)$ ]] && VALEURS["${BASH_REMATCH[1]}"]="${BASH_REMATCH[2]}"
  done < <(dechiffrer_flux)
}

migrer() {
  lire_chiffres
  local trouves=0 nom valeur
  if [ -f .env ]; then
    for nom in "${SECRETS[@]}"; do
      valeur=$(grep -E "^$nom=" .env | tail -1 | cut -d= -f2- || true)
      if [ -n "$valeur" ]; then VALEURS[$nom]="$valeur"; trouves=$((trouves + 1)); fi
    done
  fi
  # Le secret du portier (signature des sessions) et son jeton d'API : générés s'ils manquent.
  [ -n "${VALEURS[PORTIER_SECRET]:-}" ] || VALEURS[PORTIER_SECRET]=$(openssl rand -hex 32)
  [ -n "${VALEURS[PORTIER_API_TOKEN]:-}" ] || VALEURS[PORTIER_API_TOKEN]=$(openssl rand -hex 32)
  [ -n "${VALEURS[WORKER_TOKEN]:-}" ] || VALEURS[WORKER_TOKEN]=$(openssl rand -hex 32)
  # Chiffrement : le clair ne passe que par un fichier temporaire en mémoire, effacé aussitôt.
  local clair
  clair=$(mktemp -p /dev/shm usine.XXXXXX)
  chmod 600 "$clair"
  for nom in "${SECRETS[@]}"; do printf '%s=%s\n' "$nom" "${VALEURS[$nom]:-}" >> "$clair"; done
  sops --encrypt --age "$(sudo_si_besoin age-keygen -y "$CLE")" --input-type dotenv --output-type dotenv "$clair" > "$CHIFFRE.nouveau"
  # Vérifier avant de remplacer : le fichier chiffré doit redonner exactement le clair.
  if ! diff -q <(sudo_si_besoin env SOPS_AGE_KEY_FILE="$CLE" sops --decrypt --input-type dotenv --output-type dotenv "$CHIFFRE.nouveau") "$clair" >/dev/null; then
    shred -u "$clair"; rm -f "$CHIFFRE.nouveau"
    echo "Le chiffrement n'a pas pu être vérifié : rien n'a changé."; exit 1
  fi
  shred -u "$clair"
  mv "$CHIFFRE.nouveau" "$CHIFFRE"
  chmod 600 "$CHIFFRE"
  # Les secrets quittent .env (les autres réglages restent).
  if [ -f .env ] && [ "$trouves" -gt 0 ]; then
    local motif
    motif="^($(IFS='|'; echo "${SECRETS[*]}"))="
    grep -vE "$motif" .env > .env.tmp || true
    mv .env.tmp .env
    chmod 600 .env
  fi
  echo "• $trouves secret(s) chiffré(s) depuis .env ; .env ne contient plus aucun secret."
  dechiffrer
}

dechiffrer() {
  [ -f "$CHIFFRE" ] || { echo "Pas de $CHIFFRE : lance « bash secrets.sh migrer »."; exit 1; }
  sudo_si_besoin install -d -m 0750 -o root -g "$GID_CONTENEURS" "$SORTIE"
  local nom valeur
  lire_chiffres
  for nom in "${SECRETS[@]}"; do
    valeur="${VALEURS[$nom]:-}"
    local f="$SORTIE/$(echo "$nom" | tr 'A-Z' 'a-z')"
    printf '%s' "$valeur" | sudo_si_besoin tee "$f" >/dev/null
    sudo_si_besoin chown root:"$GID_CONTENEURS" "$f"
    sudo_si_besoin chmod 0440 "$f"
  done
}

verifier() {
  lire_chiffres
  local nom
  for nom in "${SECRETS[@]}"; do printf '%-26s %s\n' "$nom" "$([ -n "${VALEURS[$nom]:-}" ] && echo rempli || echo vide)"; done
  if [ -f .env ] && grep -qE "^($(IFS='|'; echo "${SECRETS[*]}"))=." .env; then echo "Attention : .env contient encore des secrets en clair (bash secrets.sh migrer)."; fi
}

editer() {
  sudo_si_besoin env SOPS_AGE_KEY_FILE="$CLE" EDITOR="${EDITOR:-nano}" sops --input-type dotenv --output-type dotenv "$CHIFFRE"
  dechiffrer
  echo "Secrets mis à jour. Pour les appliquer : docker compose up -d"
}

case "${1:-}" in
  installer) installer ;;
  migrer) migrer ;;
  dechiffrer) dechiffrer ;;
  editer) editer ;;
  verifier) verifier ;;
  *) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
