#!/usr/bin/env bash
# Installer (ou mettre à jour) l'usine logicielle sur un serveur avec Docker.
#   bash install.sh                  installe, construit, démarre
#   bash install.sh --reprendre-de ../usine-contenu
#                                    réutilise la connexion Claude et le volume Codex
#                                    d'une usine à contenu déjà installée
#   bash install.sh --admin prenom@exemple.fr
#                                    crée le premier administrateur et affiche son lien
#                                    d'invitation (tout le reste se règle dans la console)
# Aucun secret n'est jamais affiché, ni gardé en clair : secrets.sh les chiffre.
set -euo pipefail
cd "$(dirname "$0")"

SOURCE=""
ADMIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --reprendre-de) SOURCE="$2"; shift 2 ;;
    --admin) ADMIN="$2"; shift 2 ;;
    *) echo "Option inconnue : $1"; exit 1 ;;
  esac
done

command -v docker >/dev/null || { echo "Docker est requis : https://docs.docker.com/engine/install/"; exit 1; }
docker compose version >/dev/null || { echo "Docker Compose (plugin) est requis."; exit 1; }

# Lire / écrire une variable de .env sans jamais l'afficher.
valeur() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- || true; }
poser() {
  if grep -qE "^$1=" .env; then
    awk -v k="$1" -v v="$2" 'BEGIN{FS=OFS="="} $1==k{print k "=" v; next} {print}' .env > .env.tmp && mv .env.tmp .env
  else
    echo "$1=$2" >> .env
  fi
}

[ -f .env ] || { cp .env.example .env; chmod 600 .env; echo "• .env créé depuis .env.example"; }
[ -f usine.config.yml ] || { cp usine.config.example.yml usine.config.yml; echo "• usine.config.yml créé (le contrat : à relire)"; }
[ -f caddy/Caddyfile ] || printf ':80 {\n\trespond "Usine logicielle" 200\n}\n' > caddy/Caddyfile

# Le domaine des adresses (connexion, aperçus) : celui du contrat.
if [ -z "$(valeur DOMAINE_BASE)" ]; then
  base=$(grep -E '^\s*base:' usine.config.yml | head -1 | sed -E 's/^\s*base:\s*([^ #]+).*/\1/')
  [ -n "$base" ] && poser DOMAINE_BASE "$base" && echo "• DOMAINE_BASE : $base"
fi

if [ -n "$SOURCE" ] && [ -f "$SOURCE/.env" ]; then
  for nom in CLAUDE_CODE_OAUTH_TOKEN AI_GATEWAY_API_KEY; do
    if [ -z "$(valeur $nom)" ]; then
      v=$(grep -E "^$nom=" "$SOURCE/.env" | head -1 | cut -d= -f2- || true)
      [ -n "$v" ] && poser "$nom" "$v" && echo "• $nom repris de $SOURCE"
    fi
  done
  vol=$(docker volume ls --format '{{.Name}}' | grep -E 'codex$' | head -1 || true)
  if [ -n "$vol" ] && [ "$(valeur CODEX_VOLUME)" = "usine-logicielle-codex" ]; then poser CODEX_VOLUME "$vol"; echo "• Volume Codex réutilisé : $vol"; fi
fi

# La mise à jour depuis Slack : le dossier de l'usine et son dépôt GitHub.
[ -n "$(valeur USINE_DIR)" ] || poser USINE_DIR "$(pwd)"
if [ -z "$(valeur DEPOT_USINE)" ]; then
  depot=$(git remote get-url origin 2>/dev/null | sed -E 's#^https://github.com/##; s#^git@github.com:##; s#\.git$##')
  [ -n "$depot" ] && poser DEPOT_USINE "$depot"
fi

# Les secrets : chiffrés (SOPS + age), retirés de .env, déchiffrés en mémoire au démarrage.
bash secrets.sh installer
bash secrets.sh migrer

manque=()
etat=$(bash secrets.sh verifier)
for v in GITHUB_TOKEN WORKER_TOKEN; do echo "$etat" | grep -qE "^$v +rempli" || manque+=("$v"); done
[ -n "$(valeur DEPOT_ETAT)" ] || manque+=("DEPOT_ETAT")
if [ ${#manque[@]} -gt 0 ]; then
  echo
  echo "Il manque : ${manque[*]}"
  echo "Colle les valeurs dans .env (nano .env), puis relance : bash install.sh"
  echo "(Elles y seront chiffrées puis effacées : .env ne garde jamais un secret.)"
  exit 1
fi
# Les fournisseurs d'IA ne sont plus obligatoires ici : ils se posent aussi dans la console.
echo "$etat" | grep -qE "^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|AI_GATEWAY_API_KEY) +rempli" || echo "• Aucun accès à Claude sur le serveur : pose-le dans la console (Réglages, Fournisseurs d'IA)."
echo "$etat" | grep -qE "^SLACK_BOT_TOKEN +rempli" || echo "• Pas de jetons Slack : l'usine se pilotera par la CLI (voir README)."

docker volume create "$(valeur CODEX_VOLUME)" >/dev/null  # existe déjà s'il est réutilisé
echo "• Construction des images (Claude Code, Codex et Playwright en dernière version)…"
docker compose build --pull
docker compose up -d --remove-orphans
echo
docker compose ps --format "table {{.Service}}\t{{.Status}}"
echo
if ! docker compose run --rm --no-deps verificateur codex login status >/dev/null 2>&1; then
  echo "Codex n'est pas connecté : console, Réglages, Fournisseurs d'IA, « Connecter un compte ChatGPT »."
  echo "  (ou ici : docker compose run --rm verificateur codex login --device-auth)"
fi
# Le premier administrateur : son lien d'invitation (personnel, 72 h). Il ouvre la console,
# où l'assistant « Premiers pas » guide le reste (fournisseur d'IA, GitHub, premier projet).
if [ -n "$ADMIN" ]; then
  echo "• Attente de l'orchestrateur…"
  for i in $(seq 1 30); do docker compose exec -T orchestrateur node src/cli.mjs statut >/dev/null 2>&1 && break; sleep 4; done
  r=$(docker compose exec -T orchestrateur node src/cli.mjs admin "$ADMIN")
  lien=$(echo "$r" | grep -oE '"lien": *"[^"]+"' | cut -d'"' -f4)
  adresse=$(echo "$r" | grep -oE '"console": *"[^"]+"' | cut -d'"' -f4)
  if [ -n "$lien" ]; then
    echo
    echo "Administrateur : $ADMIN"
    echo "  1. Ouvre ce lien pour choisir ton mot de passe (personnel, valable 72 h) :"
    echo "     $lien"
    echo "  2. Puis la console : $adresse"
  else
    echo "Le premier administrateur n'a pas pu être créé : $r"
  fi
fi
echo "Usine prête. Journal : docker compose logs -f orchestrateur"
