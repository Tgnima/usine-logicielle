---
titre: Comment installer les outils de l'usine sur mon VPS ?
slug: comment-installer-les-outils-de-l-usine-sur-mon-vps
ordre: 4
resume: Mettre le serveur à jour, installer git, Docker, Node.js et Claude Code, puis connecter Claude Code à votre compte.
meta_description: Préparez votre VPS Wayhost pour une usine logicielle : mises à jour, git, Docker, Node.js et Claude Code, puis connexion à votre abonnement Claude.
---
Ces commandes se lancent **sur le VPS** (après `ssh usine`). Elles commencent par `sudo` : vous êtes connecté avec l'utilisateur de la commande SSH (souvent `ubuntu`), et `sudo` lui donne les droits d'administration. Vous pouvez aussi demander à Claude de les lancer pour vous, en lisant chaque commande avant de l'accepter.

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
```

Le message « Hello from Docker! » confirme que Docker fonctionne. Les applications de votre usine tourneront dans des conteneurs Docker.

## 3. Installer Node.js

```
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node --version
```

## 4. Installer Claude Code sur le serveur

Pour que l'usine travaille **même quand votre ordinateur est éteint**, Claude Code doit aussi être installé sur le VPS :

```
curl -fsSL https://claude.ai/install.sh | bash
```

## 5. Connecter Claude Code à votre compte

Cette étape se fait **vous-même, dans votre terminal** : elle demande un navigateur.

```
claude
```

Ouvrez le lien affiché sur votre ordinateur, connectez-vous à votre compte Claude, puis collez le code obtenu dans le terminal du serveur.

> Pour qu'un programme lance Claude Code sans vous (une usine qui tourne la nuit), générez un jeton longue durée avec `claude setup-token` et rangez-le dans votre fichier `.env` : voir *Comment ranger mes secrets dans un fichier .env ?*
