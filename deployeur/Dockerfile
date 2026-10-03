# Le déployeur : le seul conteneur qui a accès à Docker. Il tire l'état souhaité
# depuis GitHub ; il n'a aucun port ouvert.
FROM docker:cli AS docker

FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*
# Le client Docker et buildx, pris de l'image officielle (dernière version).
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins
WORKDIR /app
COPY deployeur/server.mjs deployeur/chemins.mjs ./
CMD ["node", "server.mjs"]
