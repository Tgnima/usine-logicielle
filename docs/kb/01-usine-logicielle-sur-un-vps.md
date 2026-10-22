---
titre: Qu'est-ce qu'une usine logicielle sur un VPS ?
slug: qu-est-ce-qu-une-usine-logicielle-sur-un-vps
ordre: 1
resume: Des agents IA qui planifient, codent, testent et mettent en ligne vos applications depuis votre VPS, chacun dans son conteneur Docker.
meta_description: Une usine logicielle sur un VPS Wayhost : des agents IA dans des conteneurs Docker planifient, codent, testent et déploient. Principe et prérequis.
---
Une **usine logicielle** transforme une demande écrite dans Slack en application en ligne. Elle planifie, code, teste, déploie un aperçu à chaque étape, et ne revient vers vous que deux fois : pour **valider le plan**, puis pour **valider le produit fini**.

Tout tourne sur un VPS, **dans des conteneurs Docker**. Sur le serveur lui-même, on n'installe que Docker et git : Claude Code et Codex sont dans les images des conteneurs, pas sur le système.

## Les rouages

| Conteneur | Rôle |
|---|---|
| `orchestrateur` | l'état des projets, le contrat, GitHub et Slack |
| `atelier-1` | les agents codent, avec **Claude Code** |
| `verificateur` | reconstruit, démarre et teste l'application, avec **Codex** |
| `deployeur` | construit et met en ligne ; le seul à avoir accès à Docker |
| `portier` | la page de connexion devant chaque application |
| `caddy` | le HTTPS automatique ; le seul à ouvrir des ports (80 et 443) |
| `mailpit` | capture les emails envoyés par les applications en démo |

## Ce qu'il vous faut

- un **VPS Wayhost sous Ubuntu**. L'usine de démonstration tourne sur **1 vCPU, 4 Go de RAM et 48 Go de disque, avec 4 Go de swap** : une tâche à la fois. Pour une équipe, prévoyez plutôt **4 vCPU, 8 Go et 120 Go** ;
- un **compte GitHub** : il reçoit le code des applications ;
- un **abonnement Claude** (ou une clé API Anthropic) : il fait travailler les agents de l'atelier ;
- un **abonnement ChatGPT** (ou une clé API OpenAI) : il fait travailler le vérificateur ;
- **Slack**, facultatif : sans Slack, l'usine se pilote en ligne de commande ;
- **Claude Code sur votre ordinateur** : c'est avec lui que vous installez et entretenez l'usine sur le serveur.

## Le parcours

1. Préparer votre ordinateur : Claude Code et une clé SSH.
2. Donner à Claude l'accès au VPS.
3. Installer l'usine sur le VPS : Docker, swap, code de l'usine, connexion de Claude et de Codex.
4. Créer le token GitHub de l'usine.
5. Ranger les secrets : ils sont chiffrés sur le serveur.
6. Ouvrir les ports 80 et 443 dans le pare-feu Wayhost.
7. Donner l'accès à votre équipe.
