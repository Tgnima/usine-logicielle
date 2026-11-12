# L'orchestrateur : l'état, le contrat, GitHub et Slack. Pas d'accès à Docker.
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY orchestrateur/package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY orchestrateur/src ./src
# Le module d'envoi vers Sentry et PostHog, au même endroit relatif que dans le dépôt (src/../../commun).
COPY commun/observabilite.mjs /commun/observabilite.mjs
COPY orchestrateur/console ./console
COPY orchestrateur/video ./video
RUN mkdir -p /app/data /app/etat /app/jetons && chown -R node:node /app
USER node
CMD ["node", "src/index.mjs"]
