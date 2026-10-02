# Actions

Une action = une fonction de logique métier, exportée depuis un fichier de ce
dossier, appelée par une route de `server/routes/` et testée dans `test/`.

- Elle reçoit des données déjà validées et renvoie un résultat ou lève une
  erreur explicite (`Object.assign(new Error("…"), { status: 400 })`).
- Elle ne dépend pas d'Express : on peut l'appeler depuis un test, un script ou
  un agent.
