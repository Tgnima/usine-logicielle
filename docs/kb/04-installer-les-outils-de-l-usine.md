---
titre: Comment installer les outils de l'usine sur mon VPS ?
slug: comment-installer-les-outils-de-l-usine-sur-mon-vps
ordre: 4
resume: Mettre le serveur à jour, installer git et Docker, puis faire tourner Claude Code dans une image Docker connectée à votre compte.
meta_description: Préparez votre VPS Wayhost pour une usine logicielle : git et Docker sur le serveur, Claude Code dans une image Docker, connexion à votre abonnement.
---
Ces commandes se lancent **sur le VPS** (après `ssh usine`). Elles commencent par `sudo` : vous êtes connecté avec l'utilisateur de la commande SSH (souvent `ubuntu`), et `sudo` lui donne les droits d'administration. Vous pouvez aussi demander à Claude de les lancer pour vous, en lisant chaque commande avant de l'accepter.

Sur le serveur, on n'installe **que git et Docker**. Claude Code n'est pas installé sur le système : il tourne **dans une image Docker**, comme tous les rouages de l'usine. Le serveur reste propre, et chaque agent travaille dans un conteneur isolé.

## 1. Mettre le serveur à jour

```
sudo apt update && sudo apt upgrade -y
```

## 2. Installer git et Docker

```
sudo apt install -y git curl
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

Déconnectez-vous (`exit`), reconnectez-vous (`ssh usine`), puis vérifiez :

```
docker run --rm hello-world
docker compose version
```

Le message « Hello from Docker! » confirme que Docker fonctionne. Docker Compose, installé avec lui, lancera les conteneurs de l'usine ensemble.

## 3. Construire l'image de l'atelier

L'**atelier** est le conteneur où les agents codent. Dans le dossier de votre usine, créez `atelier/Dockerfile` :

```
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git curl \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code@latest
USER node
WORKDIR /travail
```

Node.js est fourni par l'image `node:24-slim` : rien à installer sur le serveur. Construisez l'image et vérifiez :

```
docker build -t atelier atelier
docker run --rm atelier claude --version
```

## 4. Connecter Claude Code à votre compte

Cette étape se fait **vous-même, dans votre terminal** : elle demande un navigateur.

```
docker run --rm -it atelier claude setup-token
```

Ouvrez le lien affiché sur votre ordinateur, connectez-vous à votre compte Claude, puis collez le code obtenu dans le terminal. Claude Code affiche alors un **jeton longue durée** : copiez-le dans votre fichier `.env`, sur la ligne `CLAUDE_CODE_OAUTH_TOKEN=` (voir *Comment ranger mes secrets dans un fichier .env ?*). Le conteneur est supprimé aussitôt : le jeton n'est gardé que dans `.env`.

## 5. Faire travailler l'agent

Le conteneur reçoit le jeton par `.env` et ne voit que le dossier du projet :

```
docker run --rm --env-file .env -v ~/projets/mon-app:/travail atelier \
  claude -p "Lis le README et dis-moi comment lancer les tests."
```

C'est le principe de l'usine : votre usine lancera ces conteneurs elle-même, une tâche à la fois. Plus tard, d'autres images s'ajoutent sur le même modèle (un vérificateur qui teste l'application, un déployeur qui la met en ligne), réunies dans un fichier `docker-compose.yml`.

> Une clé API Anthropic (`ANTHROPIC_API_KEY`) remplace le jeton si vous n'avez pas d'abonnement Claude.
