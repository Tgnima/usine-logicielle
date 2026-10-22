---
titre: Comment installer l'usine logicielle sur mon VPS ?
slug: comment-installer-les-outils-de-l-usine-sur-mon-vps
ordre: 4
resume: Docker et du swap sur le serveur, le code de l'usine, puis Claude Code et Codex connectés à vos abonnements, dans leurs conteneurs.
meta_description: Installer l'usine logicielle sur un VPS Wayhost : Docker, swap, install.sh, puis Claude Code et Codex connectés dans leurs conteneurs Docker.
---
Ces commandes se lancent **sur le VPS** : Claude les lance pour vous par SSH, sauf les deux connexions aux abonnements (étapes 5 et 7), qui demandent un navigateur et se font **dans votre propre terminal**.

Sur le serveur, on n'installe **ni Node.js ni Claude Code** : ils sont dans les images Docker de l'usine.

## 1. Vérifier Docker

```
docker --version
docker compose version
```

Sur le VPS de démonstration, Docker et Docker Compose étaient déjà installés. S'ils manquent, suivez la [documentation officielle de Docker pour Ubuntu](https://docs.docker.com/engine/install/ubuntu/) : le script d'installation de l'usine s'arrête tant que Docker n'est pas là.

Donnez ensuite à votre utilisateur le droit de lancer Docker, puis reconnectez-vous :

```
sudo usermod -aG docker ubuntu
```

## 2. Ajouter 4 Go de swap

Sur un petit serveur, la construction des images et le navigateur de test sont les pics de mémoire. Le swap évite qu'ils fassent tomber le serveur :

```
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab
sudo sysctl -w vm.swappiness=10
echo vm.swappiness=10 | sudo tee -a /etc/sysctl.conf
```

`free -h` doit afficher `Swap: 4,0Gi`.

## 3. Récupérer le code de l'usine

```
git clone https://github.com/<compte>/usine-logicielle.git
cd usine-logicielle
```

Le dépôt est privé. Sur le VPS de démonstration, le serveur n'avait pas encore d'accès à GitHub : Claude a copié le code depuis l'ordinateur (`git bundle`, puis `scp`).

## 4. Premier lancement

```
bash install.sh
```

Au premier lancement, le script crée `.env` (les réglages et les secrets) et `usine.config.yml` (le contrat de l'usine), puis **s'arrête** en listant ce qui manque, par exemple `Il manque : GITHUB_TOKEN`. C'est normal : les secrets se remplissent aux étapes suivantes.

> Une usine à contenu tourne déjà sur le serveur ? `bash install.sh --reprendre-de ../usine-contenu` reprend sa connexion Claude et son compte Codex. C'est ce qui a été fait sur le VPS de démonstration.

## 5. Connecter Claude Code à votre abonnement (vous)

Claude Code est dans l'image de l'**atelier** (`atelier/Dockerfile` l'installe en dernière version). Construisez l'image, puis lancez la connexion **dans votre terminal**, connecté au serveur :

```
docker build -t usine-atelier -f atelier/Dockerfile .
docker run --rm -it --entrypoint claude usine-atelier setup-token
```

Ouvrez le lien affiché, connectez-vous à votre compte Claude, autorisez, puis collez le code dans le terminal. Claude Code affiche un jeton qui commence par `sk-ant-oat01-` : copiez-le dans `.env`, sur la ligne `CLAUDE_CODE_OAUTH_TOKEN=` (voir *Comment ranger les secrets de mon usine ?*). Le conteneur est supprimé aussitôt.

## 6. Construire et démarrer

Une fois dans `.env` le token GitHub, le jeton Claude et `DEPOT_ETAT` (le dépôt d'état que tire le déployeur, sous la forme `compte/nom`) :

```
bash install.sh
docker compose ps
```

Le script chiffre les secrets, construit les images (Claude Code, Codex et Playwright en dernière version) et démarre les conteneurs. Le journal se suit avec `docker compose logs -f orchestrateur`.

## 7. Connecter Codex à votre abonnement ChatGPT (vous)

Codex est dans l'image du **vérificateur** ; sa connexion est gardée dans un volume Docker. À la fin de son travail, `install.sh` affiche cette commande si Codex n'est pas encore connecté :

```
docker compose run --rm verificateur codex login --device-auth
```

Ouvrez le lien affiché, connectez-vous à ChatGPT et saisissez le code.
