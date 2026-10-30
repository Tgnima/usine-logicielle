// Le profil d'un projet : comment installer, construire, tester et démarrer SON code.
//
// Un produit né dans l'usine suit sa brique (Node, npm). Un dépôt repris (« /usine reprendre »)
// garde sa propre pile : l'inventaire lit le dépôt, trouve ses commandes, les éprouve, et le
// profil est écrit dans .usine/profil.json (protégé : une tâche ne peut pas changer la façon
// dont on la juge). Tout ce qui lance le code d'un produit passe par ici.
//
// Le contrat d'hébergement est le même pour tous (le déployeur n'a qu'une façon de servir) :
// un Dockerfile à la racine, l'application écoute sur $PORT, répond 200 sur GET /api/health,
// écrit seulement dans $DATA_DIR.

// Strict (le verrou fait foi) : le vérificateur refuse une PR dont le verrou ne suit pas.
const INSTALLER_NPM = "npm ci --no-audit --no-fund"

// Le profil des briques de l'usine (webapp, site, api, pwa).
export const PROFIL_BRIQUE = {
  pile: "node",
  installer: INSTALLER_NPM,
  construire: "npm run build",
  tester: "npm test",
  demarrer: "npm start",
}

// Les fichiers qui jugent un dépôt repris : l'usine les remet tels qu'ils sont sur la branche
// de base avant chaque contrôle. (Ceux d'une brique sont dans usine.config.yml.)
export const PROTEGES_REPRIS = ["Dockerfile", "MISSION.md", "ICP.md", "docs/PLAN.md", "docs/DESIGN.md", ".usine/**"]
// Le cadre du produit, protégé partout : l'usine ne réécrit jamais sa propre mission.
export const PROTEGES_TOUJOURS = ["MISSION.md", "ICP.md"]

export const PILES = ["node", "python"]

export const estRepris = (projet) => Boolean(projet?.origine)

export function lireProfil(projet) {
  if (!projet?.profil) return { ...PROFIL_BRIQUE }
  try {
    return { ...PROFIL_BRIQUE, ...JSON.parse(projet.profil) }
  } catch {
    return { ...PROFIL_BRIQUE }
  }
}

// La branche sur laquelle l'usine intègre le travail (main pour ses propres dépôts).
export const brancheDeBase = (projet) => projet?.branche || "main"

// Le nom des branches de tâches : usine/t3 dans un dépôt de l'usine ; usine/<slug>/t3 dans un
// dépôt repris (plusieurs projets, plusieurs personas, peuvent travailler sur le même dépôt).
export const brancheDeTache = (projet, cle) => (estRepris(projet) ? `usine/${projet.slug}/${cle.toLowerCase()}` : `usine/${cle.toLowerCase()}`)

export function proteges(config, projet) {
  const base = estRepris(projet) ? PROTEGES_REPRIS : (config?.perimetre_protege?.length ? config.perimetre_protege : [])
  return [...new Set([...base, ...PROTEGES_TOUJOURS])]
}

// Une commande du profil : une ligne, sans caractère de contrôle, de taille raisonnable.
// (Elle tourne dans le bac à sable de l'atelier ou du vérificateur, comme le code du produit.)
const commandeValide = (c) => typeof c === "string" && c.trim().length > 0 && c.length <= 400 && !/[\n\r\0]/.test(c)

// Vérifie un profil proposé par l'inventaire. Renvoie la liste des problèmes.
export function verifierProfil(p) {
  const problemes = []
  if (!p || typeof p !== "object") return ["le profil n'est pas un objet"]
  if (!PILES.includes(p.pile)) problemes.push(`pile non prise en charge : « ${p.pile} » (au choix : ${PILES.join(", ")})`)
  for (const k of ["installer", "construire", "tester", "demarrer"]) if (!commandeValide(p[k])) problemes.push(`commande « ${k} » manquante ou invalide (une ligne, 400 caractères au plus)`)
  return problemes
}

export const nettoyerProfil = (p) => ({ pile: p.pile, installer: p.installer.trim(), construire: p.construire.trim(), tester: p.tester.trim(), demarrer: p.demarrer.trim() })

// Les fichiers de verrouillage des dépendances : écartés des diffs relus et de la taille d'une PR.
export const VERROUS = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "poetry.lock", "uv.lock", "Pipfile.lock"].map((f) => `':(exclude)${f}'`).join(" ")

// Le nombre de tests passés et échoués, lu dans la sortie de la commande de test.
// Formats reconnus : node --test, jest, vitest, mocha, pytest, unittest. Plusieurs suites
// (un front en vitest et un back en node --test, par exemple) s'additionnent.
export function compterTests(texte) {
  const t = String(texte ?? "").replace(/\x1b\[[0-9;]*m/g, "")
  let passes = 0
  let echecs = 0
  let trouve = false
  const ajouter = (p, e) => {
    passes += Number(p ?? 0)
    echecs += Number(e ?? 0)
    trouve = true
  }
  // node --test
  for (const m of t.matchAll(/^[ℹ#] pass (\d+)\s*$/gm)) ajouter(m[1], 0)
  for (const m of t.matchAll(/^[ℹ#] fail (\d+)\s*$/gm)) ajouter(0, m[1])
  // jest : « Tests:       1 failed, 12 passed, 13 total »
  for (const m of t.matchAll(/^Tests:\s+(.*\btotal)\s*$/gm)) ajouter(/(\d+) passed/.exec(m[1])?.[1], /(\d+) failed/.exec(m[1])?.[1])
  // vitest : « Tests  1 failed | 9 passed (10) »
  for (const m of t.matchAll(/^\s*Tests\s{2,}(.*)\(\d+\)\s*$/gm)) ajouter(/(\d+) passed/.exec(m[1])?.[1], /(\d+) failed/.exec(m[1])?.[1])
  // mocha : « 12 passing », « 1 failing »
  for (const m of t.matchAll(/^\s+(\d+) passing\b/gm)) ajouter(m[1], 0)
  for (const m of t.matchAll(/^\s+(\d+) failing\b/gm)) ajouter(0, m[1])
  // pytest : « ===== 1 failed, 10 passed in 0.52s ===== » ou « 10 passed in 0.5s »
  for (const m of t.matchAll(/^=*\s*((?:\d+ (?:passed|failed|errors?|skipped|warnings?|deselected|xfailed|xpassed)(?:, )?)+) in [\d.]+s/gm)) {
    ajouter(/(\d+) passed/.exec(m[1])?.[1], Number(/(\d+) failed/.exec(m[1])?.[1] ?? 0) + Number(/(\d+) errors?/.exec(m[1])?.[1] ?? 0))
  }
  // unittest : « Ran 10 tests in 0.01s » puis « OK » ou « FAILED (failures=2, errors=1) »
  for (const m of t.matchAll(/^Ran (\d+) tests? in [\d.]+s\s*\n+\s*(OK|FAILED[^\n]*)/gm)) {
    const e = Number(/failures=(\d+)/.exec(m[2])?.[1] ?? 0) + Number(/errors=(\d+)/.exec(m[2])?.[1] ?? 0)
    ajouter(Number(m[1]) - e, e)
  }
  return { passes, echecs, trouve }
}

// La même lecture, dans un script : `${COMPTER_TESTS} fichier.log` écrit les marqueurs
// @@ TESTS_PASSES et @@ TESTS_ECHECS (node est présent dans l'atelier et le vérificateur).
const SOURCE = `const t=require("fs").readFileSync(process.argv[1],"utf8");const r=(${compterTests.toString()})(t);console.log("@@ TESTS_PASSES "+r.passes);console.log("@@ TESTS_ECHECS "+r.echecs)`
export const COMPTER_TESTS = `node -e '${SOURCE.replace(/'/g, `'\\''`)}'`

// Ce qu'écrit le code d'un produit (build, tests, application) ne peut pas passer pour un marqueur
// de l'usine (« @@ BUILD_OK », « @@ TESTS_PASSES 99 ») : ses lignes en « @@ » sont neutralisées
// avant d'arriver au journal, où la porte de fusion lit les marqueurs.
export const NEUTRALISER = `sed -u -E 's/^([[:space:]]*)@@/\\1(@@)/'`

// Arrête un serveur d'application resté en vie sur un port, puis attend que le port se libère.
export const libererPort = (port) => `fuser -k -n tcp ${Number(port)} >/dev/null 2>&1; pkill -f 'node server/index.js' 2>/dev/null; pkill -f 'npm start' 2>/dev/null; for i in 1 2 3 4 5 6; do curl -s -o /dev/null http://localhost:${Number(port)}/ || break; fuser -k -n tcp ${Number(port)} >/dev/null 2>&1; sleep 1; done`
