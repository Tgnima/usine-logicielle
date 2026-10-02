# L'atelier : là où les agents codent. Claude Code (dernière version, choix
# assumé), git, et ce qu'il faut pour installer et construire un produit Node.
# Construit depuis la racine du dépôt (contexte : .).
FROM node:24-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git curl jq procps \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code@latest && npm cache clean --force

ENV DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 ROLE=atelier

COPY commun/serveur-travaux.mjs /opt/usine/serveur-travaux.mjs
# Les briques de départ des produits, copiées à la création d'un dépôt.
COPY briques /opt/usine/briques

RUN mkdir -p /travail /tmp/sorties && chown -R node:node /travail /tmp/sorties
USER node
RUN git config --global user.name "Usine logicielle" && git config --global user.email "usine@wayhost.local" && git config --global init.defaultBranch main
WORKDIR /travail
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/sante').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "/opt/usine/serveur-travaux.mjs"]
