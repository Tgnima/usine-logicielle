// La sonde des produits : lecture de docker inspect, clés, redémarrages récents, jugement.
import { test } from "node:test"
import assert from "node:assert/strict"
import { FORMAT_INSPECT, SEUIL_BOUCLE, cleDuConteneur, conteneurActif, inspectIncomplet, jugerProduit, lireInspect, noterRedemarrages, versionDeLImage } from "../sonde.mjs"

const enMarche = (autres = {}) => ({ nom: "usine-prod-vigie-copro-blue", etat: "running", sante: "healthy", redemarrages: 0, demarre_le: "2026-11-08T22:09:00Z", code_sortie: 0, oom: false, image: "usine-produit-vigie-copro:b2ac2d85bd6b", ...autres })
const repond = { code: 200, ms: 40 }

test("docker inspect : seuls des champs d'état sont demandés, jamais l'environnement", () => {
  assert.doesNotMatch(FORMAT_INSPECT, /Env|Config\.Env|Mounts|Args/)
  assert.equal(FORMAT_INSPECT.split("\\t").length, 1) // séparateur réel : la tabulation
  assert.equal(FORMAT_INSPECT.split("\t").length, 8)
})

test("lireInspect : une ligne par conteneur, les lignes d'erreur sont ignorées", () => {
  const sortie = [
    "/usine-prod-vigie-copro-blue\trunning\thealthy\t0\t2026-11-08T22:09:00Z\t0\tfalse\tusine-produit-vigie-copro:b2ac2d85bd6b",
    "/usine-apercu-vingt-cinq\trestarting\t\t11343\t2026-11-09T19:47:00Z\t1\tfalse\tusine-produit-vingt-cinq:fca2fc044334",
    "Error: No such object: usine-apercu-parti",
    "",
  ].join("\n")
  const c = lireInspect(sortie)
  assert.equal(c.length, 2)
  assert.deepEqual(c[0], enMarche())
  assert.equal(c[1].nom, "usine-apercu-vingt-cinq")
  assert.equal(c[1].sante, null)
  assert.equal(c[1].redemarrages, 11343)
  assert.equal(c[1].code_sortie, 1)
  assert.deepEqual(lireInspect(undefined), [])
})

test("cleDuConteneur : les clés de statut.json, rien pour les conteneurs de l'usine", () => {
  assert.equal(cleDuConteneur("usine-apercu-vingt-cinq"), "apercu/vingt-cinq")
  assert.equal(cleDuConteneur("usine-prod-vigie-copro-blue"), "production/vigie-copro")
  assert.equal(cleDuConteneur("usine-prod-acte-clair-green"), "production/acte-clair")
  assert.equal(cleDuConteneur("usine-logicielle-deployeur-1"), null)
  assert.equal(cleDuConteneur("usine-prod-sans-couleur"), null)
  assert.equal(cleDuConteneur(undefined), null)
})

test("versionDeLImage : le sha de l'image, sinon rien", () => {
  assert.equal(versionDeLImage("usine-produit-vigie-copro:b2ac2d85bd6b"), "b2ac2d85bd6b")
  assert.equal(versionDeLImage("01faf7ff462e"), null)
  assert.equal(versionDeLImage(null), null)
})

test("noterRedemarrages : les redémarrages des 30 dernières minutes, et un conteneur recréé repart de zéro", () => {
  const h = new Map()
  const min = 60_000
  assert.equal(noterRedemarrages(h, "a", 100, 0), 0)
  assert.equal(noterRedemarrages(h, "a", 103, 10 * min), 3)
  assert.equal(noterRedemarrages(h, "a", 105, 25 * min), 5)
  // Au-delà de 30 min, les premiers relevés sortent de la fenêtre : à 40 min, celui de 0 min
  // est parti (le plus ancien gardé est celui de 10 min, 103) ; à 56 min, il ne reste que 40 min.
  assert.equal(noterRedemarrages(h, "a", 106, 40 * min), 3)
  assert.equal(noterRedemarrages(h, "a", 106, 56 * min), 0)
  // Recréé sous le même nom (déploiement) : le compteur repart de 0.
  assert.equal(noterRedemarrages(h, "a", 0, 46 * min), 0)
  assert.equal(noterRedemarrages(h, "a", 1, 47 * min), 1)
})

test("jugerProduit : un produit qui répond est en bonne santé", () => {
  assert.deepEqual(jugerProduit({ attendu: true, deploiement: "ok", conteneur: enMarche(), http: repond }), { etat: "ok", raison: "répond en 40 ms" })
})

test("jugerProduit : pendant un déploiement, rien n'est jugé", () => {
  assert.equal(jugerProduit({ attendu: true, deploiement: "en_cours", conteneur: null }).etat, "inconnu")
})

test("jugerProduit : les pannes", () => {
  assert.deepEqual(jugerProduit({ attendu: true, conteneur: null }), { etat: "panne", raison: "conteneur absent" })
  assert.equal(jugerProduit({ attendu: false, conteneur: null }), null)
  // Premier déploiement en échec, rien n'a jamais été servi : une alerte, la livraison l'a déjà annoncé.
  assert.deepEqual(jugerProduit({ deploiement: "echec", conteneur: null }), { etat: "alerte", raison: "pas en ligne : dernier déploiement en échec, aucun conteneur" })
  // L'aperçu de Vingt-Cinq le 9 nov. : 11 343 redémarrages, « restarting ».
  const boucle = jugerProduit({ deploiement: "echec", conteneur: enMarche({ etat: "restarting", redemarrages: 11343 }), recents: 0 })
  assert.equal(boucle.etat, "panne")
  assert.match(boucle.raison, /redémarre en boucle.*11343 au total.*dernier déploiement en échec/)
  // Un produit « running » entre deux redémarrages : le compteur le trahit.
  assert.equal(jugerProduit({ conteneur: enMarche(), http: repond, recents: SEUIL_BOUCLE }).etat, "panne")
  assert.match(jugerProduit({ conteneur: enMarche({ etat: "exited", code_sortie: 137, oom: true }) }).raison, /arrêté \(exited, code de sortie 137, mémoire dépassée\)/)
  assert.deepEqual(jugerProduit({ conteneur: enMarche(), http: { code: null, ms: 10000 } }), { etat: "panne", raison: "ne répond pas à /api/health" })
  assert.deepEqual(jugerProduit({ conteneur: enMarche(), http: null }), { etat: "panne", raison: "ne répond pas à /api/health" })
  assert.deepEqual(jugerProduit({ conteneur: enMarche(), http: { code: 503, ms: 30 } }), { etat: "panne", raison: "/api/health répond 503" })
})

test("jugerProduit : les alertes", () => {
  // Production en échec : la nouvelle couleur est supprimée, celle qui répond est la précédente (même au même sha).
  assert.match(jugerProduit({ environnement: "production", attendu: true, deploiement: "echec", conteneur: enMarche({ demarre_apres_demande: false }), http: repond }).raison, /version précédente reste en ligne/)
  // Aperçu en échec, recréé sous le même nom après la demande : c'est la version en échec qui tourne.
  assert.match(jugerProduit({ environnement: "apercu", attendu: true, deploiement: "echec", conteneur: enMarche({ demarre_apres_demande: true }), http: repond }).raison, /cette version a démarré trop lentement/)
  // Aperçu en échec pendant la construction : l'ancien conteneur n'a pas été touché.
  assert.match(jugerProduit({ environnement: "apercu", attendu: true, deploiement: "echec", conteneur: enMarche({ demarre_apres_demande: false }), http: repond }).raison, /version précédente reste en ligne/)
  assert.equal(jugerProduit({ conteneur: enMarche({ sante: "unhealthy" }), http: repond }).etat, "alerte")
  assert.deepEqual(jugerProduit({ conteneur: enMarche(), http: repond, recents: 1 }), { etat: "alerte", raison: "a redémarré 1 fois en 30 min" })
  assert.deepEqual(jugerProduit({ conteneur: enMarche(), http: { code: 200, ms: 4200 } }), { etat: "alerte", raison: "lent : /api/health en 4200 ms" })
  assert.deepEqual(jugerProduit({ conteneur: enMarche(), http: { code: 302, ms: 20 } }), { etat: "alerte", raison: "/api/health redirige (302)" })
})

test("jugerProduit : un aperçu en échec que Caddy ne sert pas est en panne, même s'il répond", () => {
  const j = jugerProduit({ environnement: "apercu", attendu: false, deploiement: "echec", conteneur: enMarche({ nom: "usine-apercu-x" }), http: repond })
  assert.equal(j.etat, "panne")
  assert.match(j.raison, /pas en ligne/)
})

test("jugerProduit : pendant un déploiement, l'ancienne couleur est jugée, la nouvelle ne l'est pas", () => {
  const minute = 60_000
  // Production : l'ancienne couleur sert les visiteurs pendant la construction.
  assert.deepEqual(jugerProduit({ attendu: true, deploiement: "en_cours", depuis_ms: 5 * minute, conteneur: enMarche(), http: repond }), { etat: "ok", raison: "répond en 40 ms · déploiement en cours" })
  assert.equal(jugerProduit({ attendu: true, deploiement: "en_cours", depuis_ms: 5 * minute, conteneur: enMarche({ etat: "restarting" }) }).etat, "panne")
  // Le conteneur que le déploiement démarre : pas jugé.
  assert.equal(jugerProduit({ attendu: true, deploiement: "en_cours", depuis_ms: 5 * minute, conteneur: enMarche({ nouveau: true }), http: null }).etat, "inconnu")
  // Un aperçu arrêté pendant son déploiement (docker rm -f, ou créé mais pas encore démarré) : pas jugé.
  for (const etat of ["exited", "removing", "created"]) assert.equal(jugerProduit({ environnement: "apercu", attendu: true, deploiement: "en_cours", depuis_ms: minute, conteneur: enMarche({ etat }) }).etat, "inconnu")
  // Mais un aperçu qui redémarre en boucle pendant la construction est en panne.
  assert.equal(jugerProduit({ environnement: "apercu", attendu: true, deploiement: "en_cours", depuis_ms: minute, conteneur: enMarche({ etat: "restarting" }) }).etat, "panne")
  // Un déploiement bloqué depuis plus de 45 min ne masque plus rien.
  const bloque = jugerProduit({ attendu: true, deploiement: "en_cours", depuis_ms: 50 * minute, conteneur: null })
  assert.equal(bloque.etat, "panne")
  assert.match(bloque.raison, /conteneur absent · déploiement bloqué depuis 50 min/)
  assert.equal(jugerProduit({ attendu: true, deploiement: "en_cours", depuis_ms: 50 * minute, conteneur: enMarche(), http: repond }).etat, "alerte")
})

test("jugerProduit : pendant une construction, la lenteur ne sonne pas, le silence n'est qu'une alerte", () => {
  assert.equal(jugerProduit({ conteneur: enMarche(), http: { code: 200, ms: 4200 }, construction: true }).etat, "ok")
  assert.equal(jugerProduit({ conteneur: enMarche(), http: { code: null, ms: 10000 }, construction: true }).etat, "alerte")
  // Les pannes sûres restent des pannes.
  assert.equal(jugerProduit({ conteneur: enMarche({ etat: "restarting" }), construction: true }).etat, "panne")
})

test("jugerProduit : une boucle de redémarrages reste une panne tant que le produit redémarre encore", () => {
  // Un plantage toutes les 12 min : la fenêtre de 30 min oscille entre 2 et 3.
  assert.equal(jugerProduit({ conteneur: enMarche(), http: repond, recents: 3 }).boucle, true)
  assert.equal(jugerProduit({ conteneur: enMarche(), http: repond, recents: 2, en_boucle: true }).etat, "panne")
  assert.equal(jugerProduit({ conteneur: enMarche(), http: repond, recents: 2, en_boucle: false }).etat, "alerte")
  assert.equal(jugerProduit({ conteneur: enMarche(), http: repond, recents: 0, en_boucle: true }).etat, "ok")
})

test("conteneurActif : celui de statut.json, aucun s'il a disparu, sinon celui qui tourne", () => {
  const blue = enMarche()
  const green = enMarche({ nom: "usine-prod-vigie-copro-green", etat: "created" })
  assert.equal(conteneurActif([green, blue], "usine-prod-vigie-copro-green"), green)
  // statut.json nomme blue, blue a disparu : l'autre couleur restée là ne sert pas les visiteurs.
  assert.equal(conteneurActif([green], "usine-prod-vigie-copro-blue"), null)
  assert.equal(conteneurActif([green, blue], undefined), blue)
  assert.equal(conteneurActif([green], undefined), green)
  assert.equal(conteneurActif([], undefined), null)
})

test("inspectIncomplet : un conteneur parti est nommé dans l'erreur ; un inspect coupé ne dit rien", () => {
  const noms = ["usine-prod-a-blue", "usine-apercu-b"]
  const a = [enMarche({ nom: "usine-prod-a-blue" })]
  assert.equal(inspectIncomplet(noms, a, "...\nError: No such object: usine-apercu-b"), false)
  assert.equal(inspectIncomplet(noms, [], ""), true)
  assert.equal(inspectIncomplet(noms, [], "Cannot connect to the Docker daemon at unix:///var/run/docker.sock"), true)
  assert.equal(inspectIncomplet(noms, [...a, enMarche({ nom: "usine-apercu-b" })], ""), false)
  // Un slug préfixe d'un autre : le nom décrit ne vaut pas pour le second, resté sans réponse.
  const prefixes = ["usine-apercu-vigie-copro-12", "usine-apercu-vigie-copro"]
  assert.equal(inspectIncomplet(prefixes, [enMarche({ nom: "usine-apercu-vigie-copro-12" })], "/usine-apercu-vigie-copro-12\trunning\t\t0\tx\t0\tfalse\ti\nCannot connect to the Docker daemon"), true)
  assert.equal(inspectIncomplet(prefixes, [enMarche({ nom: "usine-apercu-vigie-copro-12" })], "Error: No such object: usine-apercu-vigie-copro"), false)
})
