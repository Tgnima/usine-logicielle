// Les pièces jointes d'une demande : images et PDF vérifiés à leurs premiers octets,
// Markdown et texte reconnus à l'extension puis vérifiés (UTF-8, pas un binaire renommé).
import { test } from "node:test"
import assert from "node:assert/strict"
import { verifierPieces } from "../src/pieces.mjs"

const b64 = (x) => Buffer.from(x).toString("base64")

test("un cahier des charges en Markdown est accepté, même sans type annoncé (Windows)", () => {
  const [f] = verifierPieces([{ nom: "Cahier des charges.md", type: "", base64: b64("# Besoin\n\nUne appli de réservation, accentuée : éàç.\n") }])
  assert.equal(f.nom, "1-Cahier-des-charges.md")
  const [t] = verifierPieces([{ nom: "notes.TXT", type: "text/plain", base64: b64("des notes") }])
  assert.equal(t.nom, "1-notes.txt")
  assert.equal(verifierPieces([{ nom: "spec.markdown", type: "text/markdown", base64: b64("# x") }])[0].nom, "1-spec.md")
})

test("un binaire renommé en .md, ou un texte qui n'est pas de l'UTF-8, est refusé", () => {
  assert.throws(() => verifierPieces([{ nom: "piege.md", type: "", base64: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 1]).toString("base64") }]), /pas un fichier texte/)
  assert.throws(() => verifierPieces([{ nom: "latin1.txt", type: "", base64: Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString("base64") }]), /pas un fichier texte/)
  assert.throws(() => verifierPieces([{ nom: "script.sh", type: "", base64: b64("echo") }]), /formats acceptés/)
})

test("les images restent vérifiées à leurs premiers octets", () => {
  assert.throws(() => verifierPieces([{ nom: "x.png", type: "image/png", base64: b64("pas une image") }]), /vrai fichier PNG/)
})
