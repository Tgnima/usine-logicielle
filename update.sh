#!/usr/bin/env bash
# Mettre l'usine à jour sur ce serveur, sans couper une tâche en cours.
#   bash update.sh             la cible du canal (CANAL_USINE dans .env ; stable par défaut)
#   bash update.sh v1.2.0      une version précise (y compris pour revenir en arrière)
#   bash update.sh main        la dernière fusion, pas encore publiée
#   bash update.sh --liste     les versions publiées
#
# Dans l'ordre : l'usine s'arrête après sa tâche en cours ; le code passe à la version voulue ;
# les secrets que cette version attend sont créés s'ils manquent ; tout est reconstruit et
# redémarré ; l'usine reprend. Le bouton « Mettre à jour l'usine » (console, Slack) fait la même
# chose depuis le déployeur. Les données, les secrets et les réglages ne bougent pas.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

valeur() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- || true; }
cli() { docker compose exec -T orchestrateur node src/cli.mjs "$@" < /dev/null; }
VERSION='^v[0-9]+\.[0-9]+\.[0-9]+$'
versions() { git tag -l 'v*' --sort=-v:refname | grep -E "$VERSION" || true; }

# Si la suite échoue après l'arrêt, l'usine repart dans sa version actuelle.
reprendre=0
relancer() { if [ "$reprendre" = 1 ] && cli reprendre > /dev/null 2>&1; then echo "• L'usine reprend dans sa version actuelle."; fi; }

# Tout est dans une fonction, lue en entier avant de commencer : « git reset » remplace ce fichier
# pendant qu'il s'exécute.
principal() {
  [ -f .env ] || { echo "Pas de .env : c'est une première installation, lance « bash install.sh »."; exit 1; }
  canal=$(valeur CANAL_USINE)
  demande=${1:-${canal:-stable}}

  echo "• Lecture des versions sur GitHub…"
  # Sans --prune : avec, la lecture échouait sur un serveur en Git 2.34 (Ubuntu 22.04).
  git fetch -q origin "+main:refs/remotes/origin/main" "+refs/tags/v*:refs/tags/v*"

  if [ "$demande" = "--liste" ]; then
    versions | head -15
    exit 0
  fi
  case "$demande" in
    stable)
      ref=$(versions | head -1)
      [ -n "$ref" ] || { echo "Aucune version publiée pour l'instant : « bash update.sh main » prend la dernière fusion."; exit 1; } ;;
    main) ref=origin/main ;;
    v*)
      [[ "$demande" =~ $VERSION ]] && git rev-parse -q --verify "refs/tags/$demande" >/dev/null || { echo "Version inconnue : $demande (« bash update.sh --liste »)."; exit 1; }
      ref=$demande ;;
    *) echo "Cible inconnue : $demande (stable, main, vX.Y.Z ou --liste)."; exit 1 ;;
  esac

  avant=$(git rev-parse --short HEAD)
  apres=$(git rev-parse --short "$ref^{commit}")
  if [ "$avant" = "$apres" ]; then echo "Déjà à jour ($ref, $apres)."; exit 0; fi
  # Sans version précise, jamais de retour en arrière (le serveur peut être en avance sur stable).
  if [ "${1:-}" != "$ref" ] && git merge-base --is-ancestor "$ref" HEAD; then
    echo "Ce serveur est déjà au-delà de $ref ($avant). Rien à faire."; exit 0
  fi
  # Un fichier suivi par Git modifié à la main serait écrasé : on s'arrête avant.
  if ! git diff --quiet HEAD; then
    echo "Des fichiers suivis par Git ont été modifiés sur ce serveur (ils seraient écrasés) :"
    git status --short --untracked-files=no
    exit 1
  fi

  echo "• $avant → $ref ($apres) :"
  git log --format='    %s' "HEAD..$ref" | head -25
  [ -f CHANGELOG.md ] && echo "  (le détail et les gestes à faire : CHANGELOG.md, après la mise à jour)"

  # 1. L'usine finit sa tâche en cours, puis s'arrête. Un arrêt déjà demandé par quelqu'un est gardé.
  if docker compose ps --status running --services 2>/dev/null | grep -qx orchestrateur; then
    if ! docker compose exec -T orchestrateur test -f /app/data/STOP < /dev/null; then
      cli stop > /dev/null
      reprendre=1
      trap relancer EXIT
    fi
    echo "• Attente de la fin de la tâche en cours (30 min au plus)…"
    for i in $(seq 1 180); do
      cli statut | grep -qE '"en_cours": "' || break
      [ "$i" = 180 ] && { echo "Une tâche tourne encore au bout de 30 min : mise à jour abandonnée, rien n'a changé."; exit 1; }
      sleep 10
    done
  fi

  # 2. Le code.
  git reset -q --hard "$ref"

  # 3. Les secrets que cette version attend (un fichier vide pour une clé facultative pas encore posée).
  manquants=""
  for s in $(grep -oE '/run/usine-secrets/[a-z0-9_]+' docker-compose.yml | sed 's#.*/##' | sort -u); do
    [ -e "/run/usine-secrets/$s" ] || manquants="$manquants $s"
  done
  if [ -n "$manquants" ]; then
    echo "• Secrets à créer :$manquants"
    bash secrets.sh dechiffrer
  fi
  # Les réglages ajoutés à .env.example depuis l'installation (facultatifs : rien n'est écrit).
  # Les secrets n'en sont pas : secrets.sh les retire de .env une fois chiffrés.
  secrets=" $(grep -E '^SECRETS=' secrets.sh | grep -oE '[A-Z_]+' | tail -n +2 | tr '\n' ' ') "
  nouveaux=$(grep -oE '^[A-Z_]+=' .env.example | tr -d = | while read -r k; do [[ "$secrets" == *" $k "* ]] || grep -qE "^$k=" .env || echo "$k"; done | tr '\n' ' ')
  [ -n "$nouveaux" ] && echo "• Réglages nouveaux, facultatifs (voir .env.example) : $nouveaux"

  # 4. Reconstruire et redémarrer (le réseau de l'hébergeur a des coupures : 3 essais).
  echo "• Construction des images…"
  for essai in 1 2 3; do
    if docker compose build --pull > /tmp/usine-construction.log 2>&1; then break; fi
    tail -5 /tmp/usine-construction.log
    [ "$essai" = 3 ] && { echo "La construction échoue : les conteneurs actuels tournent toujours. Le code est sur $ref ; « git reset --hard $avant » y revient (journal : /tmp/usine-construction.log)."; exit 1; }
    sleep 30
  done
  rm -f /tmp/usine-construction.log
  docker compose up -d --remove-orphans

  # 5. L'usine reprend (le nouvel orchestrateur met quelques secondes à répondre).
  if [ "$reprendre" = 1 ]; then
    for i in $(seq 1 30); do cli statut > /dev/null 2>&1 && break; sleep 4; done
    cli reprendre > /dev/null && reprendre=0
  fi
  trap - EXIT
  echo
  docker compose ps --format "table {{.Service}}\t{{.Status}}"
  echo "Usine à jour : $ref ($apres)."
}
principal "$@"
