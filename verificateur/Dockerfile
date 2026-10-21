# Le vérificateur indépendant : il ne voit jamais les notes ni le raisonnement
# de l'agent qui a codé. Il reconstruit le produit à partir de la pull request,
# le démarre et le teste comme un visiteur (curl, Playwright + Chromium), puis
# Codex (une autre famille de modèles que l'atelier) rend son verdict.
# Python : pour un dépôt repris dans cette pile. psmisc : fuser, pour libérer un port.
FROM node:24-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git curl jq procps psmisc ffmpeg python3 python3-venv python3-pip \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g @openai/codex@latest playwright@latest && npm cache clean --force
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright NODE_PATH=/usr/local/lib/node_modules
RUN npx playwright install --with-deps chromium && chmod -R a+rx /ms-playwright

ENV ROLE=verificateur
COPY commun/serveur-travaux.mjs /opt/usine/serveur-travaux.mjs
COPY --chmod=755 commun/entree.sh /opt/usine/entree.sh
RUN mkdir -p /travail /tmp/sorties /home/node/.codex && chown -R node:node /travail /tmp/sorties /home/node/.codex
USER node
RUN git config --global user.name "Usine logicielle (vérificateur)" && git config --global user.email "usine@wayhost.local"
WORKDIR /travail
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/sante').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/opt/usine/entree.sh"]
CMD ["node", "/opt/usine/serveur-travaux.mjs"]
