// Le tour de déploiement : reprise d'un déploiement interrompu, santé sans redirection ; la mise à
// jour de l'usine ne part pas sans les secrets que la nouvelle version attend.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { REPRISES_MAX, attendreSante, decisionDeploiement, scriptVerifierSecrets } from "../deploiement.mjs"

// Le script de vérification des secrets, avec un faux git (le nouveau docker-compose.yml) et un
// faux docker (il joue le conteneur de vérification sur un dossier local à la place de /s).
const posix = (p) => (process.platform === "win32" ? p.replace(/^([A-Za-z]):/, (_, l) => `/${l.toLowerCase()}`).replaceAll("\\", "/") : p)
function verifierSecrets({ presents, attendus = ["github_token", "sentry_dsn", "posthog_token"], dockerEnPanne = false, gitEnPanne = false }) {
  const d = mkdtempSync(join(tmpdir(), "secrets-"))
  const secrets = join(d, "secrets")
  mkdirSync(secrets)
  for (const f of presents) writeFileSync(join(secrets, f), "")
  const compose = `secrets:\n${attendus.map((a) => `  ${a}: { file: /run/usine-secrets/${a} }`).join("\n")}\n`
  writeFileSync(join(d, "compose.yml"), compose)
  writeFileSync(join(d, "git"), `#!/usr/bin/env bash\n${gitEnPanne ? "exit 128" : `cat "${posix(join(d, "compose.yml"))}"`}\n`)
  writeFileSync(join(d, "docker"), `#!/usr/bin/env bash\n${dockerEnPanne ? "exit 1" : ""}\nwhile [ "$1" != "-c" ]; do shift; done\nshift; script="$1"; shift\nscript="\${script//\\/s\\//${posix(secrets)}/}"\nexec sh -c "$script" "$@"\n`)
  chmodSync(join(d, "git"), 0o755)
  chmodSync(join(d, "docker"), 0o755)
  writeFileSync(join(d, "script.sh"), `set -eo pipefail\nexport PATH="${posix(d)}:$PATH"\n${scriptVerifierSecrets("/home/ubuntu/usine-logicielle", "usine-logicielle-deployeur").join("\n")}\necho "@@ SUITE"\n`)
  const r = spawnSync("bash", [posix(join(d, "script.sh"))], { encoding: "utf8" })
  return { code: r.status, sortie: `${r.stdout}${r.stderr}` }
}

test("mise à jour : tous les secrets attendus existent, elle continue", () => {
  const r = verifierSecrets({ presents: ["github_token", "sentry_dsn", "posthog_token"] })
  assert.equal(r.code, 0, r.sortie)
  assert.match(r.sortie, /@@ SUITE/)
})

test("mise à jour : un secret nouveau absent du serveur l'arrête avant toute modification, avec la commande à lancer", () => {
  const r = verifierSecrets({ presents: ["github_token"] })
  assert.equal(r.code, 3, r.sortie)
  assert.doesNotMatch(r.sortie, /@@ SUITE/)
  assert.match(r.sortie, /Secrets absents du serveur : posthog_token sentry_dsn \./)
  assert.match(r.sortie, /sudo bash secrets\.sh dechiffrer/)
})

test("mise à jour : une vérification impossible (Docker, git) ne bloque pas", () => {
  assert.match(verifierSecrets({ presents: [], dockerEnPanne: true }).sortie, /@@ SUITE/)
  assert.match(verifierSecrets({ presents: [], gitEnPanne: true }).sortie, /@@ SUITE/)
})

const SHA = "a".repeat(40)
const AUTRE = "b".repeat(40)
const souhait = { produit: "vigie-copro", sha: SHA, demande_le: "2026-11-10T10:00:00Z" }

test("une demande déjà appliquée n'est pas refaite, qu'elle ait réussi ou échoué", () => {
  assert.equal(decisionDeploiement({ etat: "ok", sha: SHA, demande_le: souhait.demande_le }, souhait), null)
  assert.equal(decisionDeploiement({ etat: "echec", sha: SHA, demande_le: souhait.demande_le }, souhait), null)
})

test("une demande nouvelle est déployée : premier déploiement, autre version, même version redemandée", () => {
  assert.equal(decisionDeploiement(undefined, souhait), "deployer")
  assert.equal(decisionDeploiement({ etat: "ok", sha: AUTRE, demande_le: "2026-11-09T10:00:00Z" }, souhait), "deployer")
  assert.equal(decisionDeploiement({ etat: "ok", sha: SHA, demande_le: "2026-11-09T10:00:00Z" }, souhait), "deployer")
})

test("un déploiement resté « en cours » (déployeur interrompu) est repris, même pour la version déjà servie", () => {
  // Le cas qui n'était jamais relancé : la même version redemandée, interrompue en cours de route.
  const interrompu = { etat: "en_cours", sha: SHA, sha_demande: SHA, demande_le: souhait.demande_le, conteneur: "usine-prod-vigie-copro-blue", couleur: "blue" }
  assert.equal(decisionDeploiement(interrompu, souhait), "reprendre")
  // Une nouvelle version interrompue (sha de la version servie différent).
  assert.equal(decisionDeploiement({ etat: "en_cours", sha: AUTRE, sha_demande: SHA, demande_le: souhait.demande_le }, souhait), "reprendre")
  // Premier déploiement interrompu (rien n'était servi).
  assert.equal(decisionDeploiement({ etat: "en_cours", sha_demande: SHA, demande_le: souhait.demande_le }, souhait), "reprendre")
})

test("un déploiement interrompu trop souvent est abandonné, pas relancé sans fin", () => {
  const base = { etat: "en_cours", sha_demande: SHA, demande_le: souhait.demande_le }
  for (let n = 0; n < REPRISES_MAX; n++) assert.equal(decisionDeploiement({ ...base, reprises: n }, souhait), "reprendre")
  assert.equal(decisionDeploiement({ ...base, reprises: REPRISES_MAX }, souhait), "abandonner")
})

test("un souhait qui a changé pendant l'interruption est déployé tel quel", () => {
  assert.equal(decisionDeploiement({ etat: "en_cours", sha_demande: AUTRE, demande_le: souhait.demande_le, reprises: REPRISES_MAX }, souhait), "deployer")
  assert.equal(decisionDeploiement({ etat: "en_cours", sha_demande: SHA, demande_le: "2026-11-09T10:00:00Z", reprises: REPRISES_MAX }, souhait), "deployer")
})

// Un petit serveur local : chaque requête est comptée, la réponse est donnée par la fonction.
async function serveur(repondre) {
  const s = { appels: 0 }
  const http = createServer((req, res) => {
    s.appels += 1
    repondre(req, res, s.appels)
  })
  await new Promise((r) => http.listen(0, "127.0.0.1", r))
  s.url = `http://127.0.0.1:${http.address().port}`
  s.fermer = () => new Promise((r) => http.close(r))
  return s
}
const rapide = { secondes: 1, intervalleMs: 50, delaiMs: 500 }

test("attendreSante : un 200 sur /api/health suffit", async () => {
  const produit = await serveur((req, res) => res.writeHead(req.url === "/api/health" ? 200 : 404).end("ok"))
  try {
    assert.equal(await attendreSante(`${produit.url}/api/health`, rapide), true)
  } finally {
    await produit.fermer()
  }
})

test("attendreSante : attend un produit qui démarre (503, puis 200)", async () => {
  const produit = await serveur((req, res, n) => res.writeHead(n < 3 ? 503 : 200).end())
  try {
    assert.equal(await attendreSante(`${produit.url}/api/health`, rapide), true)
    assert.equal(produit.appels, 3)
  } finally {
    await produit.fermer()
  }
})

test("attendreSante : une redirection n'est pas suivie, et n'est pas une réponse saine", async () => {
  const ailleurs = await serveur((req, res) => res.writeHead(200).end("ok"))
  const produit = await serveur((req, res) => res.writeHead(302, { Location: `${ailleurs.url}/api/health` }).end())
  try {
    assert.equal(await attendreSante(`${produit.url}/api/health`, rapide), false)
    assert.ok(produit.appels >= 2)
    assert.equal(ailleurs.appels, 0) // le déployeur n'a jamais appelé l'autre adresse
  } finally {
    await produit.fermer()
    await ailleurs.fermer()
  }
})

test("attendreSante : un produit qui ne répond pas est en échec à la fin du délai", async () => {
  const produit = await serveur(() => {})
  await produit.fermer() // plus rien n'écoute sur ce port
  const debut = Date.now()
  assert.equal(await attendreSante(`${produit.url}/api/health`, rapide), false)
  assert.ok(Date.now() - debut >= 900)
})
