// Ce que le déployeur dit de chaque produit à PostHog et Sentry : états, incidents, déploiements, journaux.
import { test } from "node:test"
import assert from "node:assert/strict"
import { PERIODE_ETAT_MS, lignesNouvelles, niveauDe, niveauxDe, proprietesDeploiement, proprietesEtat, suivreEtats } from "../observation.mjs"

const produit = (etat, autres = {}) => ({ etat, raison: etat === "ok" ? "répond en 40 ms" : "ne répond pas à /api/health", version: "b2ac2d85bd6b", deploiement: "ok", http: etat === "ok" ? { code: 200, ms: 40 } : { code: null, ms: 10_000 }, docker: { etat: "running", redemarrages_30_min: 0, oom: false, demarre_le: "x", code_sortie: 0, sante: null, redemarrages: 0 }, conteneur: "usine-prod-vigie-copro-blue", ...autres })

test("proprietesEtat : les mesures de la sonde, rien de plus", () => {
  assert.deepEqual(proprietesEtat("production/vigie-copro", produit("ok")), { produit: "vigie-copro", environnement: "production", etat: "ok", raison: "répond en 40 ms", version: "b2ac2d85bd6b", deploiement: "ok", http_code: 200, http_ms: 40, docker_etat: "running", redemarrages_30_min: 0, oom: false })
  assert.equal(proprietesEtat("apercu/acte-clair", { etat: "inconnu", raison: "déploiement en cours" }).http_code, null)
})

test("suivreEtats : un événement à chaque changement, et toutes les 5 min pour chacun", () => {
  const m = new Map()
  let t = 1_000_000
  const premier = suivreEtats(m, { "production/vigie-copro": produit("ok"), "apercu/acte-clair": produit("ok") }, t)
  assert.equal(premier.evenements.length, 2) // le premier relevé : chacun est un changement
  assert.deepEqual([premier.evenements[0].changement, premier.evenements[0].precedent], [true, null])
  t += 60_000
  assert.equal(suivreEtats(m, { "production/vigie-copro": produit("ok"), "apercu/acte-clair": produit("ok") }, t).evenements.length, 0)
  t += 60_000
  const change = suivreEtats(m, { "production/vigie-copro": produit("alerte"), "apercu/acte-clair": produit("ok") }, t)
  assert.equal(change.evenements.length, 1)
  assert.deepEqual([change.evenements[0].produit, change.evenements[0].changement, change.evenements[0].precedent, change.evenements[0].etat], ["vigie-copro", true, "ok", "alerte"])
  t = 1_000_000 + PERIODE_ETAT_MS
  const periodique = suivreEtats(m, { "production/vigie-copro": produit("alerte"), "apercu/acte-clair": produit("ok") }, t)
  assert.deepEqual(periodique.evenements.map((e) => [e.produit, e.changement]), [["acte-clair", false]]) // vigie-copro a changé il y a 3 min
})

test("suivreEtats : un incident quand la panne est confirmée (deux sondes de suite), une seule fois", () => {
  const m = new Map()
  const cle = "production/vigie-copro"
  let t = 0
  const sonder = (etat) => suivreEtats(m, { [cle]: produit(etat) }, (t += 60_000)).incidents
  assert.equal(sonder("ok").length, 0)
  assert.equal(sonder("ok").length, 0)
  assert.equal(sonder("panne").length, 0) // une minute de silence passagère ne réveille personne
  assert.equal(sonder("ok").length, 0)
  assert.equal(sonder("panne").length, 0)
  const incidents = sonder("panne")
  assert.equal(incidents.length, 1)
  assert.deepEqual([incidents[0].produit, incidents[0].environnement, incidents[0].raison], ["vigie-copro", "production", "ne répond pas à /api/health"])
  assert.equal(sonder("panne").length, 0) // toujours en panne : pas de nouvel incident
  assert.equal(sonder("inconnu").length, 0)
  assert.equal(sonder("panne").length, 0) // un relevé « inconnu » au milieu ne recompte pas la panne confirmée
  sonder("ok")
  sonder("ok")
  sonder("panne")
  assert.equal(sonder("panne").length, 1) // rétabli puis de nouveau en panne : un nouvel incident
})

test("suivreEtats : Docker injoignable ne conclut rien ; un produit retiré n'est plus suivi", () => {
  const m = new Map()
  suivreEtats(m, { "production/vigie-copro": produit("ok"), "apercu/vieux": produit("ok") }, 0)
  assert.deepEqual(suivreEtats(m, null, 60_000), { evenements: [], incidents: [] })
  assert.equal(m.size, 2)
  suivreEtats(m, { "production/vigie-copro": produit("ok") }, 120_000)
  assert.deepEqual([...m.keys()], ["production/vigie-copro"])
})

test("proprietesDeploiement : résultat, durée, reprise ; seule la première ligne d'un échec", () => {
  const s = { produit: "acte-clair", environnement: "production", sha: "a".repeat(40), acces: "public", donnees: "vide", emails: "reels" }
  assert.deepEqual(proprietesDeploiement(s, "ok", { debut: 0, fin: 83_456, couleur: "green" }), { produit: "acte-clair", environnement: "production", resultat: "ok", version: "aaaaaaaaaaaa", duree_s: 83.5, reprise: false, couleur: "green", acces: "public", donnees: "vide", emails: "reels", raison: null })
  const echec = proprietesDeploiement({ ...s, environnement: "apercu", acces: undefined }, "echec", { debut: 0, fin: 1000, reprise: true, erreur: new Error("l'aperçu ne répond pas à /api/health :\nconnexion de paul@exemple.fr") })
  assert.equal(echec.raison, "l'aperçu ne répond pas à /api/health :")
  assert.deepEqual([echec.environnement, echec.acces, echec.reprise], ["apercu", "protege", true])
})

test("lignesNouvelles : les lignes après la dernière envoyée, une ligne coupée en tête ignorée", () => {
  const sortie = [
    "ers de ligne coupée par la troncature",
    "2026-11-10T10:00:00.000000001Z Serveur prêt sur le port 3000",
    "2026-11-10T10:00:01.500000000Z Error: connexion SMTP refusée",
    "2026-11-10T10:00:01.500000000Z ",
    "2026-11-10T10:00:02.250000000Z Warning: lent",
    "",
  ].join("\r\n")
  const toutes = lignesNouvelles(sortie)
  assert.deepEqual(toutes.map((l) => [l.texte, l.niveau]), [["Serveur prêt sur le port 3000", "info"], ["Error: connexion SMTP refusée", "error"], ["Warning: lent", "warn"]])
  assert.equal(toutes[0].horodatage, "2026-11-10T10:00:00.000000001Z")
  // À la nanoseconde près : la ligne déjà envoyée ne repart pas.
  assert.deepEqual(lignesNouvelles(sortie, "2026-11-10T10:00:01.500000000Z").map((l) => l.texte), ["Warning: lent"])
  assert.deepEqual(lignesNouvelles(sortie, "2026-11-10T10:00:00Z").map((l) => l.texte), ["Serveur prêt sur le port 3000", "Error: connexion SMTP refusée", "Warning: lent"])
  assert.deepEqual(lignesNouvelles(""), [])
})

test("niveauDe : le texte de la ligne dit son niveau", () => {
  assert.equal(niveauDe("Échec de l'envoi"), "error")
  assert.equal(niveauDe("Uncaught exception"), "error")
  assert.equal(niveauDe("ERROR:root:connexion perdue"), "error")
  assert.equal(niveauDe("[2026-11-18 10:00:00 +0000] [7] [ERROR] Exception in worker process"), "error")
  assert.equal(niveauDe("(node:1) [DEP0040] DeprecationWarning: The `punycode` module is deprecated."), "warn")
  assert.equal(niveauDe("(node:1) DeprecationWarning"), "warn")
  assert.equal(niveauDe("[DEP0040] deprecated"), "warn")
  assert.equal(niveauDe("/app/main.py:3: UserWarning: format obsolète"), "warn")
  assert.equal(niveauDe("GET /api/health 200"), "info")
})

// Constat du 18 nov. 2026 : ces lignes, écrites par un vrai plantage, donnaient « info ».
test("niveauDe : les exceptions de Python et de Node sont des erreurs", () => {
  for (const ligne of [
    "Traceback (most recent call last):",
    '  File "/app/main.py", line 10, in <module>',
    "ZeroDivisionError: division by zero",
    "KeyError: 'plan'",
    "TypeError: Cannot read properties of undefined (reading 'plan')",
    "TypeError [ERR_INVALID_ARG_TYPE]: The \"path\" argument must be of type string",
    "sqlite3.OperationalError: no such table: prets",
    "requests.exceptions.ConnectionError: HTTPSConnectionPool(host='api', port=443)",
    "RangeError: Maximum call stack size exceeded",
    "CRITICAL:root:base de données introuvable",
    "[2026-11-18 10:00:00 +0000] [1] [CRITICAL] WORKER TIMEOUT (pid:8)",
  ]) assert.equal(niveauDe(ligne), "error", ligne)
})

test("niveauDe : une ligne ordinaire ne passe pas en erreur", () => {
  for (const ligne of [
    "Serveur prêt sur le port 3000",
    "GET /api/errors 200 12 ms",
    "INFO:     Uvicorn running on http://0.0.0.0:3000 (Press CTRL+C to quit)",
    "INFO:     127.0.0.1:52000 - \"GET /api/health HTTP/1.1\" 200 OK",
    "KeyError handling enabled", // le nom d'une classe sans les deux-points
    "ErrorBoundary: rendu", // ne finit pas par Error
    "Envoi impossible (TypeError: fetch failed)", // au milieu d'une phrase
    "3 erreurs corrigées, 0 errors, error_count=0",
    "Critical path : 120 ms",
    "  - Local: http://localhost:3000", // en retrait, après une ligne ordinaire
    "Node.js v24.11.0",
  ]) assert.equal(niveauDe(ligne, "info"), "info", ligne)
})

test("niveauxDe : une trace Python est une erreur de bout en bout, une pile Node aussi", () => {
  const python = [
    "INFO:     Started server process [1]",
    "Traceback (most recent call last):",
    '  File "/app/main.py", line 10, in <module>',
    "    main()",
    '  File "/app/main.py", line 7, in main',
    "    total = 1 / 0",
    "            ~~^~~",
    "ZeroDivisionError: division by zero",
    "INFO:     Shutting down",
  ]
  assert.deepEqual(niveauxDe(python), ["info", "error", "error", "error", "error", "error", "error", "error", "info"])
  // Le nom de l'exception ne finit pas toujours par Error : c'est la fin de la trace qui compte.
  assert.deepEqual(niveauxDe(["Traceback (most recent call last):", '  File "/app/m.py", line 1, in <module>', "django.core.exceptions.ImproperlyConfigured: SECRET_KEY manquant", "Démarrage"]), ["error", "error", "error", "info"])
  const node = [
    "Serveur prêt sur le port 3000",
    "TypeError: Cannot read properties of undefined (reading 'plan')",
    "    at calculer (/app/server/actions/prets.js:12:20)",
    "    at async /app/server/routes/index.js:40:5",
    "Node.js v24.11.0",
    "Serveur prêt sur le port 3000",
  ]
  assert.deepEqual(niveauxDe(node), ["info", "error", "error", "error", "info", "info"])
})

test("lignesNouvelles : une trace commencée avant la dernière ligne envoyée reste une erreur", () => {
  const sortie = [
    "2026-11-18T10:00:00.000000000Z Traceback (most recent call last):",
    '2026-11-18T10:00:00.000000001Z   File "/app/main.py", line 3, in <module>',
    "2026-11-18T10:00:00.000000002Z     plan = regles['plan']",
    "2026-11-18T10:00:00.000000003Z KeyError: 'plan'",
  ].join("\n")
  assert.deepEqual(lignesNouvelles(sortie, "2026-11-18T10:00:00.000000001Z").map((l) => [l.texte, l.niveau]), [["    plan = regles['plan']", "error"], ["KeyError: 'plan'", "error"]])
})
