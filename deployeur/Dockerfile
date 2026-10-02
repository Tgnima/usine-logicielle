# Le déployeur : le seul conteneur qui a accès à Docker. Il tire l'état souhaité
# depuis GitHub ; il n'a aucun port ouvert.
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git curl gnupg \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && echo "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list \
  && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY deployeur/server.mjs ./
CMD ["node", "server.mjs"]
