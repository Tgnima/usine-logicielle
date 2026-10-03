
## Spécificités de la brique « application mobile (PWA) »

- **Le téléphone d'abord** : chaque écran est conçu à 390 px de large, puis élargi. Zones tactiles de 44 px au moins, navigation par la barre du bas (`BarreBas` dans `client/src/App.jsx`), saisie courte (bons types de champs : `inputmode`, `type="tel"`, `type="date"`…), pas de survol indispensable.
- **Installable** : `client/public/manifest.webmanifest` (nom, couleurs, icône) et `client/public/sw.js` (service worker) sont déjà en place. Mets à jour le nom, `theme_color` et `background_color` d'après le brief de design ; ne retire pas l'enregistrement du service worker dans `client/src/main.jsx`.
- **Hors ligne, prudemment** : le service worker garde les fichiers de l'interface et la dernière page, pour s'ouvrir sans réseau. Il ne met **jamais** en cache les réponses de `/api` (données privées) ni les redirections. Hors ligne, l'interface le dit clairement (`navigator.onLine`, évènements `online`/`offline`) au lieu d'échouer en silence.
- Si tu modifies `sw.js`, change sa constante `VERSION` pour que les téléphones prennent la nouvelle version.
