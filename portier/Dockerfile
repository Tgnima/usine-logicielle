# Le portier : la page de connexion devant les applications de l'usine.
FROM node:24-slim
WORKDIR /app
COPY portier/server.mjs ./
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/_portier/connexion').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
