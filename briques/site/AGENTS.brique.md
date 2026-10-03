
## Spécificités de la brique « site vitrine »

- **Un site, pas une application** : peu de pages, chacune avec un but clair et une action (nous contacter, demander un devis…). Pas de tableau de bord, pas de compte.
- **Référencement** : chaque page est déclarée dans `server/contenu.js` (`chemin`, `titre` de 60 caractères au plus, `description` de 155 au plus). Le serveur s'en sert pour le titre, la description, `/sitemap.xml` et `/robots.txt`. Un seul `h1` par page, des titres hiérarchisés, un texte alternatif sur chaque image.
- **Performance** : pas de bibliothèque lourde, des images optimisées (WebP, dimensions fixées), rien qui bloque l'affichage.
- **Contenu réel** : des textes précis sur l'activité décrite dans la demande, jamais de lorem ipsum, de faux témoignages ni de faux logos clients.
- **Le formulaire de contact** passe par `POST /api/public/contact` (route publique) : validation, limitation des envois, enregistrement, puis `envoyer()` vers `EMAIL_CONTACT` s'il est défini.
- En production, un site vitrine est en général **public** (choix fait au moment de valider la mise en production) ; l'aperçu reste derrière la page de connexion de l'usine.
