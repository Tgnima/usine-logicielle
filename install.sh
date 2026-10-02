#!/usr/bin/env bash
# Installer (ou mettre à jour) l'usine logicielle sur un serveur avec Docker.
#   bash install.sh                  installe, construit, démarre
#   bash install.sh --reprendre-de ../usine-contenu
#                                    réutilise la connexion Claude et le volume Codex
#                                    d'une usine à contenu déjà installée
# Aucun secret n'est jamais affiché.
set -euo pipefail
cd "$(dirname "$0")"

SOURCE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --reprendre-de) SOURCE="$2"; shift 2 ;;
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

if [ -z "$(valeur WORKER_TOKEN)" ]; then poser WORKER_TOKEN "$(openssl rand -hex 32)"; echo "• WORKER_TOKEN généré"; fi

if [ -n "$SOURCE" ]; then
  if [ -z "$(valeur CLAUDE_CODE_OAUTH_TOKEN)" ] && [ -f "$SOURCE/.env" ]; then
    jeton=$(grep -E "^CLAUDE_CODE_OAUTH_TOKEN=" "$SOURCE/.env" | head -1 | cut -d= -f2- || true)
    [ -n "$jeton" ] && poser CLAUDE_CODE_OAUTH_TOKEN "$jeton" && echo "• Connexion Claude reprise de $SOURCE"
  fi
  if [ -z "$(valeur AI_GATEWAY_API_KEY)" ] && [ -f "$SOURCE/.env" ]; then
    cle=$(grep -E "^AI_GATEWAY_API_KEY=" "$SOURCE/.env" | head -1 | cut -d= -f2- || true)
    [ -n "$cle" ] && poser AI_GATEWAY_API_KEY "$cle" && echo "• Clé Vercel AI Gateway reprise de $SOURCE"
  fi
  vol=$(docker volume ls --format '{{.Name}}' | grep -E 'codex$' | head -1 || true)
  if [ -n "$vol" ] && [ "$(valeur CODEX_VOLUME)" = "usine-logicielle-codex" ]; then poser CODEX_VOLUME "$vol"; echo "• Volume Codex réutilisé : $vol"; fi
fi

manque=()
for v in GITHUB_TOKEN WORKER_TOKEN DEPOT_ETAT; do [ -n "$(valeur $v)" ] || manque+=("$v"); done
[ -n "$(valeur CLAUDE_CODE_OAUTH_TOKEN)$(valeur ANTHROPIC_API_KEY)" ] || manque+=("CLAUDE_CODE_OAUTH_TOKEN ou ANTHROPIC_API_KEY")
if [ ${#manque[@]} -gt 0 ]; then
  echo
  echo "Il manque dans .env : ${manque[*]}"
  echo "Ouvre .env (nano .env), colle les valeurs, puis relance : bash install.sh"
  exit 1
fi
[ -n "$(valeur SLACK_BOT_TOKEN)" ] || echo "• Pas de jetons Slack : l'usine se pilotera par la CLI (voir README)."

echo "• Construction des images (Claude Code, Codex et Playwright en dernière version)…"
docker compose build --pull
docker compose up -d --remove-orphans
echo
docker compose ps --format "table {{.Service}}\t{{.Status}}"
echo
if ! docker compose run --rm --no-deps verificateur codex login status >/dev/null 2>&1; then
  echo "Codex n'est pas connecté. Pour le connecter à ChatGPT (navigateur requis) :"
  echo "  docker compose run --rm verificateur codex login --device-auth"
fi
echo "Usine prête. Journal : docker compose logs -f orchestrateur"
