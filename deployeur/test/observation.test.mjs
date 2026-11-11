// Ce que le déployeur dit de chaque produit à PostHog et Sentry : états, incidents, déploiements, journaux.
import { test } from "node:test"
import assert from "node:assert/strict"
import { PERIODE_ETAT_MS, lignesNouvelles, niveauDe, proprietesDeploiement, proprietesEtat, suivreEtats } from "../observation.mjs"

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
  assert.equal(niveauDe("TypeError: x is undefined"), "info") // seul le mot « error » isolé compte
  assert.equal(niveauDe("Uncaught exception"), "error")
  assert.equal(niveauDe("(node:1) DeprecationWarning"), "info")
  assert.equal(niveauDe("[DEP0040] deprecated"), "warn")
  assert.equal(niveauDe("GET /api/health 200"), "info")
})
