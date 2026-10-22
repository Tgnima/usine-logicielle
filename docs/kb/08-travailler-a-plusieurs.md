---
titre: Comment travailler à plusieurs sur la même usine ?
slug: comment-travailler-a-plusieurs-sur-la-meme-usine
ordre: 8
resume: Un VPS par groupe, un compte par personne, un dépôt partagé et une branche par piste.
meta_description: Partager une usine logicielle sur un VPS Wayhost : un compte Linux par membre, un dépôt GitHub commun, une branche par piste et des pull requests.
---
Un groupe n'a besoin que **d'un VPS**. Chaque membre y a **son propre compte**, avec sa clé SSH, et tout le monde travaille sur **le même dépôt GitHub**, chacun sur sa branche.

## 1. Créer un compte par membre

Sur le VPS, pour chaque membre (ici `alice`) :

```
sudo adduser alice
sudo usermod -aG docker alice
sudo mkdir -p /home/alice/.ssh
sudo nano /home/alice/.ssh/authorized_keys
```

Collez dans ce fichier la **clé publique** d'Alice (son fichier `.pub`), puis :

```
sudo chown -R alice:alice /home/alice/.ssh
sudo chmod 700 /home/alice/.ssh && sudo chmod 600 /home/alice/.ssh/authorized_keys
```

Alice se connecte ensuite avec `ssh alice@203.0.113.10`, depuis le Claude Code de **son** ordinateur. Sur le serveur, rien à installer pour elle : les agents tournent dans l'image Docker de l'atelier, avec le jeton Claude rangé dans `.env` (voir *Comment installer les outils de l'usine sur mon VPS ?*, étape 4). Le groupe choisit l'abonnement qui fait travailler l'usine.

## 2. Partager le dépôt

1. Un membre crée le dépôt sur GitHub, puis invite les autres : **Settings** › **Collaborators** › **Add people**.
2. Chacun crée son propre token, limité à ce dépôt : voir *Comment créer un token GitHub pour mon agent ?*

## 3. Une branche par piste

Chaque membre (ou chaque agent) travaille sur sa branche :

```
git switch -c alice/recherche-mots-cles
```

Puis pousse sa branche et ouvre une **pull request**. Le groupe relit, et une seule personne fusionne dans `main`.

> Demandez à Claude d'organiser ce fonctionnement pour vous : qui travaille sur quelle branche, comment les agents se répartissent les tâches, qui relit les pull requests. C'est une bonne façon d'apprendre à travailler en équipe avec des agents.
