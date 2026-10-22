---
titre: Qu'est-ce qu'une usine logicielle sur un VPS ?
slug: qu-est-ce-qu-une-usine-logicielle-sur-un-vps
ordre: 1
resume: Des agents IA qui codent, testent et livrent vos applications sur votre propre serveur, et ce qu'il faut pour commencer.
meta_description: Une usine logicielle fait travailler des agents IA sur votre VPS Wayhost : le principe, les prérequis et le parcours pour monter la vôtre avec Claude Code.
---
Une **usine logicielle** est un serveur sur lequel des agents IA (ici **Claude Code**) écrivent le code d'une application, le testent et proposent leurs changements sur GitHub, pendant que vous gardez la main sur ce qui est fusionné. Le serveur travaille en continu : vous n'êtes plus obligé de rester devant votre ordinateur.

Un VPS Wayhost s'y prête bien : accès root complet, ressources réservées, et le serveur tourne même quand votre ordinateur est éteint.

## Ce qu'il vous faut

- un **compte Wayhost** : voir *Comment créer un compte Wayhost ?* ;
- un **VPS sous Linux** (Ubuntu ou Debian) : comptez au moins **4 vCPU, 8 Go de RAM et 80 Go de stockage** pour construire et tester des applications web confortablement. Voir *Comment commander un VPS ?* ;
- un **compte GitHub** : le code de l'usine et des applications y est rangé ;
- un **abonnement Claude** (Pro ou Max) ou une clé API Anthropic, pour faire travailler Claude Code ;
- un **terminal** sur votre ordinateur (macOS, Linux ou Windows 10 et plus).

Vous travaillez en groupe ? Un seul VPS suffit pour toute l'équipe : voir *Comment travailler à plusieurs sur la même usine ?*

## Le parcours

1. Préparer votre ordinateur : terminal, Claude Code et clé SSH.
2. Donner à Claude l'accès à votre VPS.
3. Installer les outils de l'usine sur le VPS.
4. Créer un token GitHub pour l'agent.
5. Ranger les secrets dans un fichier `.env`.
6. Ouvrir les ports utiles **sans perdre l'accès** au serveur.

Ensuite, c'est à vous de construire votre usine avec Claude : décrivez-lui ce qu'elle doit faire (partir d'un dépôt, d'un cahier des charges, d'un persona) et faites-la évoluer.

> Le code d'une usine complète peut servir d'exemple : demandez-le à votre formateur. Construire la vôtre reste le meilleur moyen de comprendre ce qu'elle fait.
