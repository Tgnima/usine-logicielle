// Les personas : des documents comme sources, l'import d'une fiche prête, les jetons « depuis ma machine ».
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ouvrirDb } from "../src/db.mjs"
import { ouvrirCouts } from "../src/couts.mjs"
import { creerPersona, documentsPersona, importerPersona, lirePersona, obtenirPersona, verifierPersona } from "../src/personas.mjs"
import { creerJeton, listerJetons, retirerJeton, verifierJeton } from "../src/jetons-personas.mjs"

const ctxDe = () => {
  const dossier = mkdtempSync(join(tmpdir(), "personas-sources-"))
  // L'atelier est injoignable : la recherche échoue en arrière-plan, sans gêner le reste.
  const db = ouvrirDb(join(dossier, "usine.db"))
  ouvrirCouts(db)
  return { db, config: { atelier: { url: "http://127.0.0.1:1" }, secrets: { worker: "jeton-de-test-du-serveur" }, modeles: { analyste: { modele: "m" } }, dataDir: dossier, github: { proprietaire: "essai" } } }
}
const fiche = {
  nom: "Responsable RH de PME",
  fiche: {
    resume: "Responsable RH seule dans une PME de 80 personnes.",
    problemes: [{ probleme: "Les congés se gèrent dans un tableur", preuve: "Entretiens de mars", document: "entretiens.pdf" }, { probleme: "Relances manuelles", preuve: "…", source: "https://exemple.fr/etude" }, { probleme: "Pas de vue d'équipe", preuve: "…", document: "entretiens.pdf" }],
    besoins: ["Valider en un clic", "Voir qui est absent"],
    sources: [{ titre: "Entretiens", document: "entretiens.pdf" }, { titre: "Étude", url: "https://exemple.fr/etude" }],
  },
  hors_perimetre: ["La paie"],
  scenarios: [1, 2, 3].map((i) => ({ titre: `Situation ${i}`, situation: "…", etapes: ["…"], attendu: "…" })),
}

test("une fiche importée arrive à valider, sans recherche ; un document compte comme source", () => {
  const ctx = ctxDe()
  const r = importerPersona(ctx, fiche, "a@b")
  assert.ok(r.ok)
  assert.deepEqual(r.manque, [])
  const p = lirePersona(obtenirPersona(ctx.db, r.id))
  assert.equal(p.statut, "a_valider")
  assert.equal(p.fiche.sources[0].document, "entretiens.pdf")
  assert.equal(p.fiche.problemes[0].document, "entretiens.pdf")
  assert.deepEqual(verifierPersona(p), [])
  // Enveloppée dans « persona », incomplète, ou sans nom.
  assert.ok(importerPersona(ctx, { persona: fiche }, "a@b").ok)
  assert.match(importerPersona(ctx, { nom: "X Y", fiche: { resume: "…" } }, "a@b").message, /Avant de le valider/)
  assert.equal(importerPersona(ctx, { fiche: fiche.fiche }, "a@b").ok, false)
  assert.equal(importerPersona(ctx, [fiche], "a@b").ok, false)
})

test("créer à partir de documents : ils sont gardés et le brief peut manquer ; un dépôt mal écrit est refusé", async () => {
  const ctx = ctxDe()
  const csv = { nom: "Retours clients.csv", type: "text/csv", base64: Buffer.from("date;avis\n2026-10-01;trop long").toString("base64") }
  const r = await creerPersona(ctx, { nom: "Client pressé", brief: "", pieces: [csv], par: "a@b" })
  assert.ok(r.ok)
  assert.deepEqual(documentsPersona(ctx.config, r.id).map((d) => d.nom), ["1-Retours-clients.csv"])
  assert.equal((await creerPersona(ctx, { nom: "Sans rien", brief: "", par: "a@b" })).ok, false)
  assert.match((await creerPersona(ctx, { nom: "Dépôt", depot: "pas un dépôt !", par: "a@b" })).message, /propriétaire\/nom/)
  const faux = { nom: "faux.pdf", type: "application/pdf", base64: Buffer.from("pas un pdf").toString("base64") }
  assert.match((await creerPersona(ctx, { nom: "Faux", brief: "Un brief assez long pour passer.", pieces: [faux], par: "a@b" })).message, /pas un vrai fichier PDF/)
})

test("un jeton « depuis ma machine » : montré une fois, gardé en empreinte, retirable", () => {
  const ctx = ctxDe()
  const { jeton, id } = creerJeton(ctx, "Ordinateur de Marie", "a@b")
  assert.match(jeton, /^usp_[A-Za-z0-9_-]{40,60}$/)
  assert.ok(!JSON.stringify(ctx.db.prepare("SELECT * FROM reglages").all()).includes(jeton.slice(4)))
  assert.ok(!JSON.stringify(listerJetons(ctx)).includes(jeton.slice(9)))
  assert.equal(verifierJeton(ctx, `Bearer ${jeton}`), "Ordinateur de Marie")
  assert.ok(listerJetons(ctx)[0].utilise_le)
  assert.equal(verifierJeton(ctx, `Bearer ${jeton.slice(0, -2)}xx`), null)
  assert.equal(verifierJeton(ctx, jeton), null)
  retirerJeton(ctx, id, "a@b")
  assert.equal(verifierJeton(ctx, `Bearer ${jeton}`), null)
})
