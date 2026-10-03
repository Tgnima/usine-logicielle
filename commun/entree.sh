#!/bin/sh
# Point d'entrée des ateliers et du vérificateur : les secrets montés par Docker
# (/run/secrets/<nom>, propres à ce conteneur) deviennent des variables
# d'environnement, puis le serveur de travaux démarre. Un secret vide n'est pas exporté.
for f in /run/secrets/*; do
  [ -f "$f" ] || continue
  nom=$(basename "$f" | tr 'a-z' 'A-Z')
  valeur=$(cat "$f")
  [ -n "$valeur" ] && export "$nom=$valeur"
done
exec "$@"
