// La santé des applications : une ligne par produit avec la sonde du déployeur, l'ancien constat
// sans elle ; et la surveillance qui en tire les alertes.
import { test } from "node:test"
import assert from "node:assert/strict"
import { MAX_LIGNES_ALERTE, SONDE_PERIMEE_S, composantsApplications, examinerSante, texteAlerte } from "../src/sante.mjs"

const maintenant = Date.parse("2026-11-09T20:00:00Z")
const sonde = (produits, il_y_a_s = 30) => ({ le: new Date(maintenant - il_y_a_s * 1000).toISOString(), produits })
const conteneurs = [
  { nom: "usine-prod-vigie-copro-blue", etat: "running", statut: "Up 22 hours (healthy)" },
  { nom: "usine-apercu-vingt-cinq", etat: "restarting", statut: "Restarting (1) 7 seconds ago" },
]

test("avec la sonde : une ligne par produit et par environnement, nommée, avec sa version, sa clé et sa mesure", () => {
  const s = {
    conteneurs,
    applications: sonde({
      "production/vigie-copro": { etat: "ok", raison: "répond en 40 ms", version: "b2ac2d85bd6b" },
      "apercu/vingt-cinq": { etat: "panne", raison: "redémarre en boucle (0 redémarrage(s) en 30 min, 11343 au total)", version: "fca2fc044334" },
    }),
  }
  const lignes = composantsApplications(s, { noms: { "vigie-copro": "Vigie Copro", "vingt-cinq": "Vingt-Cinq" }, maintenant })
  assert.deepEqual(lignes.map((x) => x.nom), ["applications", "Vingt-Cinq · aperçu", "Vigie Copro · production"])
  // etat_constat : l'ancien constat (Vingt-Cinq n'est pas « running »), gardé pour un éventuel repli.
  assert.deepEqual(lignes[0], { nom: "applications", etat: "panne", detail: "1 en ligne · 1 en panne", resume: true, sonde: true, etat_constat: "alerte" })
  assert.equal(lignes[1].etat, "panne")
  assert.match(lignes[1].detail, /redémarre en boucle.* · version fca2fc0$/)
  assert.deepEqual(lignes[2], { nom: "Vigie Copro · production", etat: "ok", detail: "répond en 40 ms · version b2ac2d8", produit: "vigie-copro", environnement: "production", cle: "production/vigie-copro", mesure_le: s.applications.le })
})

test("deux produits du même nom : le slug les distingue", () => {
  const s = { conteneurs, applications: sonde({ "apercu/vigie-copro": { etat: "ok" }, "apercu/vigie-copro-12": { etat: "panne" } }) }
  const noms = composantsApplications(s, { noms: { "vigie-copro": "Vigie Copro", "vigie-copro-12": "Vigie Copro" }, maintenant }).slice(1).map((x) => x.nom)
  assert.deepEqual(noms, ["Vigie Copro (vigie-copro) · aperçu", "Vigie Copro (vigie-copro-12) · aperçu"])
})

test("un produit sans nom connu garde son identifiant ; un déploiement en cours est « inconnu »", () => {
  const s = { conteneurs, applications: sonde({ "apercu/pret-asso": { etat: "inconnu", raison: "déploiement en cours", version: null } }) }
  const [resume, ligne] = composantsApplications(s, { maintenant })
  assert.equal(ligne.nom, "pret-asso · aperçu")
  assert.equal(ligne.etat, "inconnu")
  assert.equal(ligne.detail, "déploiement en cours")
  assert.equal(resume.etat, "ok")
  assert.equal(resume.detail, "0 en ligne")
})

test("sonde trop ancienne ou absente : l'ancien constat, une seule ligne", () => {
  const ancienne = { conteneurs, applications: sonde({ "production/vigie-copro": { etat: "ok" } }, SONDE_PERIMEE_S + 1) }
  assert.deepEqual(composantsApplications(ancienne, { maintenant }), [{ nom: "applications", etat: "alerte", detail: "arrêtée(s) : apercu-vingt-cinq" }])
  assert.deepEqual(composantsApplications({ conteneurs: [conteneurs[0]] }, { maintenant }), [{ nom: "applications", etat: "ok", detail: "1 en ligne" }])
  // Docker injoignable côté sonde : produits null.
  assert.equal(composantsApplications({ conteneurs, applications: sonde(null) }, { maintenant }).length, 1)
})

test("bilan du serveur périmé ou liste illisible : inconnu", () => {
  const s = { conteneurs: null, applications: sonde({ "production/vigie-copro": { etat: "ok" } }) }
  assert.deepEqual(composantsApplications(s, { perime: true, listeConnue: false, maintenant }), [{ nom: "applications", etat: "inconnu", detail: "état inconnu pour l'instant" }])
})

// La surveillance ------------------------------------------------------------------
const resume = (etat = "ok", etat_constat = "ok") => ({ nom: "applications", etat, detail: "", resume: true, sonde: true, etat_constat })
const produit = (cle, etat, mesure_le, nom = cle) => ({ nom, etat, detail: "d", cle, mesure_le })

test("examinerSante : deux mesures distinctes avant d'alerter ; la même mesure relue ne compte pas", () => {
  const m = { precedents: {}, candidats: {} }
  assert.equal(examinerSante([resume("panne"), produit("apercu/x", "panne", "t1")], m).changements.length, 0)
  // Relue à la minute suivante, la même mesure t1 : pas de second constat.
  assert.equal(examinerSante([resume("panne"), produit("apercu/x", "panne", "t1")], m).changements.length, 0)
  const { changements, modifie } = examinerSante([resume("panne"), produit("apercu/x", "panne", "t2")], m)
  assert.equal(changements.length, 1)
  assert.equal(changements[0].avant, "ok")
  assert.equal(modifie, true)
  assert.equal(m.precedents["apercu/x"], "panne")
})

test("examinerSante : le résumé n'alerte jamais ; sous sa clé, l'état de l'ancien constat", () => {
  const m = { precedents: { applications: "alerte" }, candidats: {} }
  const r = examinerSante([resume("panne", "ok")], m)
  assert.deepEqual(r.changements, [])
  assert.equal(r.modifie, true)
  assert.equal(m.precedents.applications, "ok")
})

test("examinerSante : la sonde manque, le repli ne crie pas « rétabli » pour un produit toujours en panne", () => {
  // Un aperçu en panne qui tourne encore (ne répond pas) : l'ancien constat le voit « ok ».
  const m = { precedents: {}, candidats: {} }
  const avecSonde = (t) => [resume("panne", "ok"), produit("apercu/x", "panne", t)]
  examinerSante(avecSonde("t1"), m)
  examinerSante(avecSonde("t2"), m)
  assert.equal(m.precedents.applications, "ok")
  // La sonde manque deux passages : le repli dit « ok », comme l'état gardé. Aucun changement.
  const repli = [{ nom: "applications", etat: "ok", detail: "2 en ligne" }]
  assert.deepEqual(examinerSante(repli, m).changements, [])
  assert.deepEqual(examinerSante(repli, m).changements, [])
})

test("examinerSante : « inconnu » n'efface pas la suite de constats d'un composant de l'usine", () => {
  const m = { precedents: {}, candidats: {} }
  examinerSante([{ nom: "caddy (HTTPS)", etat: "panne", detail: "conteneur absent" }], m)
  examinerSante([{ nom: "caddy (HTTPS)", etat: "inconnu", detail: "liste illisible" }], m)
  const { changements } = examinerSante([{ nom: "caddy (HTTPS)", etat: "panne", detail: "conteneur absent" }], m)
  assert.deepEqual(changements.map((x) => x.nom), ["caddy (HTTPS)"])
})

test("examinerSante : les états sont rangés par clé, pas par nom affiché", () => {
  const m = { precedents: {}, candidats: {} }
  const passage = (t) => [resume("panne"), produit("apercu/a", "ok", t, "Même nom · aperçu"), produit("apercu/b", "panne", t, "Même nom · aperçu")]
  examinerSante(passage("t1"), m)
  const { changements } = examinerSante(passage("t2"), m)
  assert.deepEqual(changements.map((x) => x.cle), ["apercu/b"])
})

test("examinerSante : un produit retiré ne garde pas son état ; « inconnu » efface un candidat", () => {
  const m = { precedents: { "apercu/vingt-cinq": "panne", disque: "alerte" }, candidats: { "apercu/vingt-cinq": { etat: "ok", mesure: "t0" } } }
  const r = examinerSante([resume("ok"), produit("production/vigie-copro", "ok", "t1")], m)
  assert.equal(r.modifie, true)
  assert.equal("apercu/vingt-cinq" in m.precedents, false)
  assert.equal("apercu/vingt-cinq" in m.candidats, false)
  // Les composants de l'usine ne sont pas touchés.
  assert.equal(m.precedents.disque, "alerte")
  const m2 = { precedents: {}, candidats: { "apercu/x": { etat: "panne", mesure: "t1" } } }
  examinerSante([resume(), produit("apercu/x", "inconnu", "t2")], m2)
  assert.equal("apercu/x" in m2.candidats, false)
})

test("examinerSante : sans sonde, rien n'est purgé ; les autres composants restent rangés par nom", () => {
  const m = { precedents: { "apercu/x": "panne" }, candidats: {} }
  examinerSante([{ nom: "applications", etat: "ok", detail: "1 en ligne" }, { nom: "disque", etat: "alerte", detail: "82 %" }], m)
  assert.equal(m.precedents["apercu/x"], "panne")
  assert.equal(m.candidats.disque.etat, "alerte")
})

test("texteAlerte : au-delà de la limite, « et N autres »", () => {
  const changements = Array.from({ length: MAX_LIGNES_ALERTE + 4 }, (_, i) => ({ nom: `p${i}`, etat: "panne", detail: "absent" }))
  const texte = texteAlerte(changements)
  assert.match(texte, /^:rotating_light: \*Santé de l'usine\*/)
  assert.equal(texte.split("\n").length, MAX_LIGNES_ALERTE + 2)
  assert.match(texte, /et 4 autre\(s\) : voir la santé$/)
  assert.match(texteAlerte([{ nom: "a", etat: "ok", detail: "répond" }]), /^:white_check_mark:.*🟢 \*a\* : rétabli — répond/s)
})
