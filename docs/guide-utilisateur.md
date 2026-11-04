# L'usine logicielle, sans jargon

Ce guide s'adresse à celles et ceux qui utilisent l'usine sans être techniciens. Pour l'installer sur un serveur, voir les guides de `docs/kb`.

## En une phrase

Vous décrivez une application. L'usine la planifie, la construit, la teste et la met en ligne en aperçu, étape par étape. Elle vous demande votre avis à deux moments : pour valider le plan, puis pour valider le produit fini.

## Les mots à connaître

| Mot | Ce que ça veut dire |
|---|---|
| **Projet** | Une application que l'usine construit. |
| **Public** (ou persona) | La personne à qui l'application s'adresse : ses problèmes, ses outils, ses objections. |
| **Plan** | Ce que l'usine propose de construire, découpé en lots et en tâches. |
| **Lot** | Une étape visible du projet. À la fin de chaque lot, un aperçu est mis en ligne. |
| **Tâche** | Un petit morceau de travail, avec des critères à tenir. |
| **Aperçu** | La version en cours, en ligne, derrière la page de connexion de l'usine. |
| **Vérificateur** | Une autre IA, qui teste chaque tâche comme un visiteur, sans voir le raisonnement de celle qui a codé. |
| **Recette** | L'examen final : l'usine joue des scénarios tenus secrets, dans la peau de votre public. |
| **Production** | La version définitive, mise en ligne seulement avec votre accord. |

## Construire une application, étape par étape

1. **Décrivez votre public** (facultatif, mais conseillé). Dans la console, onglet *Publics*, *Nouveau public* : deux phrases, des documents, un dépôt GitHub ou un dossier Google Drive. Relisez la fiche, corrigez-la, validez-la.
2. **Décrivez l'application.** Dans la console, *Nouveau projet*, ou dans Slack : `/usine ce que je veux construire`.
3. **Répondez aux questions** si l'usine en pose.
4. **Lisez le plan.** Validez-le, ou demandez des changements. Rien n'est construit avant votre validation.
5. **Laissez fabriquer.** L'usine travaille seule. Vous pouvez suivre chaque tâche, et ouvrir l'aperçu à la fin de chaque lot.
6. **Lisez le rapport final** et la recette, puis choisissez : mettre en production, ou demander des corrections (un lot de plus).

## Quand l'usine vous demande une décision

Si une tâche n'aboutit pas après plusieurs essais, l'usine s'arrête sur cette tâche et vous demande quoi faire, dans Slack et sur GitHub :

- **A · Réessayer** : vous pouvez ajouter une consigne. C'est le choix le plus courant. Une consigne précise (« le bouton doit dire Rattacher ») aide beaucoup plus qu'une consigne générale.
- **B · Accepter en l'état** : la tâche est gardée malgré le refus. À réserver à un défaut que vous acceptez en connaissance de cause.
- **C · Abandonner** : la tâche est retirée, et les tâches qui en dépendent continuent sans elle.

Le vérificateur peut aussi dire qu'un critère est impossible à tenir ou qu'il en contredit un autre. La tâche s'arrête alors sans perdre d'essai, et c'est à vous de trancher : le plus souvent, il faut corriger le critère.

L'escalade « budget » signifie seulement que le projet a dépassé la durée prévue au contrat : l'usine demande si elle continue.

## Lire le résultat d'une recette

La recette donne deux choses :

- **Les scénarios tenus** (par exemple 5 sur 5) : les parcours importants vont-ils au bout ?
- **La pyramide de l'expérience**, chaque étage noté sur 10. Un étage est tenu à partir de 7 :
  1. **Fonctionnel** : ça marche.
  2. **Fiable** : ça marche à chaque fois, et les écrans disent la même chose.
  3. **Utilisable** : on comprend sans aide.
  4. **Pratique** : ça fait gagner du temps.
  5. **Agréable** : on a plaisir à s'en servir.
  6. **Qui a du sens** : ça compte vraiment pour cette personne.

Beaucoup de produits s'arrêtent après les trois premiers étages : c'est le « gouffre ». Un produit peut tenir tous ses scénarios et rester sous le gouffre : les parcours aboutissent, mais on ne lui fait pas encore confiance.

## Ce que l'usine ne fait jamais seule

- Mettre en production.
- Envoyer de vrais emails : en aperçu, ils sont capturés et rien ne sort.
- Modifier la branche principale d'un dépôt repris (elle propose une demande de fusion).

## Si quelque chose semble bloqué

| Ce que vous voyez | Ce que ça veut dire | Quoi faire |
|---|---|---|
| Une décision à prendre | L'usine attend votre réponse. | Répondez A, B ou C. |
| « En pause », limite d'usage | Les IA disponibles ont atteint leur limite ou n'ont plus de crédit. L'usine reprend seule, sans perdre d'essai. | Attendez, ajoutez du crédit, ou branchez une autre IA (*Intégrations*, *Qui prend le relais*). |
| Un service « en panne » dans *Réglages* | Un composant du serveur ne répond pas. | Prévenez la personne qui s'occupe du serveur. |
| L'usine « à l'arrêt » | Quelqu'un l'a arrêtée pour un entretien. | `/usine reprendre`, si l'entretien est fini. |

## Les réglages utiles

- **Intégrations** : Claude, ChatGPT, GitHub, Slack, Google Drive. Ce que vous y collez est chiffré et ne s'affiche plus jamais.
- **Qui prend le relais** (dans *Intégrations*) : pour chaque contrôle, l'ordre des IA. Si la première est indisponible, la suivante fait le même travail.
- **Inviter des utilisateurs** : donner accès à la console et aux applications.

Une clé d'accès ne s'envoie jamais par message, même à une IA : collez-la vous-même dans la console.
