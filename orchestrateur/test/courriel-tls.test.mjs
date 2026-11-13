// L'envoi d'emails de l'usine est toujours chiffré (courriel.mjs) : TLS direct, ou STARTTLS exigé.
// Un serveur qui n'annonce pas STARTTLS (ou un intermédiaire qui retire l'annonce) fait échouer la
// connexion avant l'identification : le mot de passe ne part jamais en clair. Un faux serveur
// local, sans réseau.
import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:net"
import { optionsTransport, reglerCourriel, verifierCourriel } from "../src/courriel.mjs"
import { traduireEchecSmtp } from "../src/services.mjs"

test("STARTTLS exigé dès que la sécurité n'est pas « TLS direct »", () => {
  assert.equal(optionsTransport({ hote: "smtp.exemple.fr", securite: "0" }).requireTLS, true)
  assert.equal(optionsTransport({ hote: "smtp.exemple.fr", securite: "" }).requireTLS, true, "un ancien .env (sécurité vide) veut dire STARTTLS")
  assert.deepEqual([optionsTransport({ hote: "smtp.exemple.fr", securite: "1" }).secure, optionsTransport({ hote: "smtp.exemple.fr", securite: "1" }).requireTLS], [true, false])
  assert.equal(optionsTransport({ hote: "smtp.exemple.fr" }).port, 587)
})

test("un serveur sans STARTTLS : la vérification échoue, et aucune identification ne part", async () => {
  const lignes = []
  const serveur = createServer((s) => {
    s.write("220 faux ESMTP\r\n")
    s.on("data", (d) => {
      for (const l of String(d).split("\r\n").filter(Boolean)) {
        lignes.push(l)
        if (/^EHLO/i.test(l)) s.write("250-faux\r\n250 AUTH PLAIN LOGIN\r\n")
        else if (/^STARTTLS/i.test(l)) s.write("502 5.5.1 commande inconnue\r\n")
        else if (/^AUTH/i.test(l)) s.write("235 ok\r\n")
        else if (/^QUIT/i.test(l)) s.end("221 au revoir\r\n")
        else s.write("250 ok\r\n")
      }
    })
    s.on("error", () => {})
  })
  await new Promise((r) => serveur.listen(0, "127.0.0.1", r))
  try {
    reglerCourriel({ hote: "127.0.0.1", port: String(serveur.address().port), securite: "0", expediteur: "usine@exemple.fr", utilisateur: "compte@exemple.fr", motDePasse: "mot-de-passe-de-test" })
    const e = await verifierCourriel().then(() => null, (x) => x)
    assert.ok(e, "la vérification doit échouer")
    assert.ok(!lignes.some((l) => /^AUTH/i.test(l)), `aucune identification en clair : ${lignes.join(" | ")}`)
    assert.match(traduireEchecSmtp(e), /chiffr/)
  } finally {
    reglerCourriel(null)
    serveur.close()
  }
})
