// La mise à jour de l'usine : elle ne reprend qu'une fois le déployeur sorti de la mise à jour,
// pas dès que le nouveau code est posé (la reconstruction et le redémarrage suivent).
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { finMiseAJour } from "../src/cycle.mjs"

test("la fin d'une mise à jour attend que le déployeur ait fini, même si la version a déjà changé", async () => {
  const dossier = mkdtempSync(join(tmpdir(), "mise-a-jour-"))
  const alertes = []
  const ctx = { config: { dataDir: dossier, etatDir: dossier }, notifier: { alerte: async (t) => alertes.push(t) } }
  const le = new Date(Date.now() - 5 * 60_000).toISOString()
  writeFileSync(join(dossier, "mise-a-jour.json"), JSON.stringify({ par: "essai", le, version_avant: "aaaaaaa", commits: [] }))
  writeFileSync(join(dossier, "STOP"), "mise à jour")
  const sante = (mise_a_jour) => writeFileSync(join(dossier, "sante.json"), JSON.stringify({ mise_a_jour }))

  // Le nouveau code est posé (version changée), la reconstruction tourne encore : on attend.
  sante({ version: "bbbbbbb", en_cours: le, derniere: null })
  await finMiseAJour(ctx)
  assert.ok(existsSync(join(dossier, "STOP")))
  assert.ok(existsSync(join(dossier, "mise-a-jour.json")))
  assert.equal(alertes.length, 0)

  // Le déployeur constate la fin : l'usine reprend et l'annonce.
  sante({ version: "bbbbbbb", en_cours: null, derniere: { terminee_le: new Date().toISOString(), reussie: true } })
  await finMiseAJour(ctx)
  assert.ok(!existsSync(join(dossier, "STOP")))
  assert.ok(!existsSync(join(dossier, "mise-a-jour.json")))
  assert.match(alertes[0], /Usine mise à jour/)
})
