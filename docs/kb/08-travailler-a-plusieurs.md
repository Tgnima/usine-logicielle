---
titre: Comment travailler à plusieurs sur la même usine ?
slug: comment-travailler-a-plusieurs-sur-la-meme-usine
ordre: 8
resume: Une personne administre le serveur ; les autres pilotent l'usine depuis Slack et la console, avec un compte donné par invitation.
meta_description: Partager une usine logicielle : comptes par invitation avec /usine acces, administrateurs dans ADMIN_USER_IDS, pilotage par Slack et la console web.
---
À plusieurs, **personne d'autre n'a besoin d'un accès SSH**. Une personne administre le serveur avec Claude ; les autres pilotent l'usine depuis **Slack** et la **console web**.

## 1. Les comptes : /usine acces

Chaque application, aperçu, console et tableau de bord est derrière la **page de connexion de l'usine** (le portier). Dans Slack, `/usine acces` crée les comptes et envoie un **lien d'invitation** : personne ne transmet de mot de passe. Le premier compte créé est le vôtre, administrateur.

## 2. Qui peut décider

Valider un plan, trancher une escalade, mettre en production : ces actions sont réservées aux administrateurs, listés dans `.env` par leur identifiant Slack (`U…`), séparés par des virgules :

```
ADMIN_USER_IDS=U0123ABCD,U0456EFGH
```

Les autres membres suivent les projets, répondent dans les fils et lancent des demandes.

## 3. Piloter ensemble

- **Dans Slack** : `/usine <ce que vous voulez construire>`, puis les boutons du fil. Répondre dans le fil d'un projet vaut réponse à l'usine.
- **Dans la console** (`console.<domaine>`) : projets, plan modifiable, fabrication en direct, personas, décisions.
- **Sur GitHub** : une pull request par tâche, et les issues `usine:bloquant` assignées à l'administrateur quand l'usine a besoin d'un humain.

> L'usine a **un seul atelier** : elle traite une tâche à la fois, quel que soit le nombre de personnes. Plusieurs demandes en même temps se mettent en file.
