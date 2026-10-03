// Le vérificateur indépendant (« holdout ») : il ne voit ni les notes, ni le
// raisonnement de l'agent qui a codé. Il part d'un clone neuf de la pull request,
// remet les fichiers protégés tels qu'ils sont sur main (une PR ne peut pas
// affaiblir les règles qui la jugent), reconstruit, teste, démarre le produit,
// puis Codex (une autre famille de modèles) le teste comme un visiteur.
//
// La décision finale est prise par porte(), en code : un modèle ne fusionne jamais.
import { RESEAU, executer, ecrireFichier, lireFichier, q } from "./travaux.mjs"
import { COMPTER_TESTS } from "./creation.mjs"
import { extraireJson } from "./analyste.mjs"
import { ecrireReglage, enregistrer, usagesCodex } from "./couts.mjs"

// Les motifs du périmètre protégé, en pathspec git.
export const pathspec = (motifs) => motifs.map((m) => (m.includes("*") ? `':(glob)${m}'` : q(m))).join(" ")

function consigneVerificateur(projet, tache) {
  const criteres = JSON.parse(tache.criteres)
  return `Tu es le vérificateur indépendant d'une usine logicielle. Tu juges si une tâche est réellement faite, sans complaisance.

Le produit « ${projet.nom} » tourne en ce moment sur http://localhost:4100 (API sous /api, interface sur /). Le code est dans le dossier courant.

Tâche à vérifier : ${tache.cle} · ${tache.titre}
${tache.description}

Critères d'acceptation, à vérifier UN PAR UN sur l'application en marche :
${criteres.map((c, i) => `${i + 1}. ${c}`).join("\n")}

Méthode :
- Teste toi-même : appels HTTP avec curl, et pour l'interface un script Node avec Playwright (\`const { chromium } = require('playwright')\`, Chromium est installé). Ne te fie pas aux tests existants.
- Les tests automatisés (npm test) ont déjà été lancés par l'usine, dans un environnement propre : ne les relance pas, juge l'application en marche.
- Tu peux lire le code pour trouver les routes, mais ne le modifie pas.
- Environnement de l'application : DEMO=1, emails capturés par Mailpit (SMTP_HOST=mailpit, interface web sur http://mailpit:8025, API /api/v1/messages), aucune liste de destinataires autorisés. Si un critère dépend d'une variable d'environnement (voir le tableau d'AGENTS.md, par exemple EMAIL_DESTINATAIRES_AUTORISES), arrête l'application et relance-la toi-même avec cette variable (\`PORT=4100 DATA_DIR=… npm start\`), puis remets-la comme avant.
- Un critère est validé seulement si tu l'as observé. Dans le doute, il est refusé.
- Note aussi un défaut grave hors critères (page blanche, erreur 500, donnée incohérente).

Réponds UNIQUEMENT par ce JSON, sans rien autour :
{"decision": "approuve" | "refuse", "criteres": [{"critere": "…", "ok": true, "preuve": "ce que tu as observé"}], "problemes": ["…"], "resume": "une phrase"}`
}

export async function verifier(ctx, projet, tache, sha) {
  const { config } = ctx
  const serveur = config.verificateur.url
  const jeton = config.secrets.worker
  const protege = pathspec(config.perimetre_protege ?? [])

  // 1. Clone neuf de la PR (seule étape qui voit le jeton GitHub).
  const clone = await executer(serveur, jeton, [
    "set -eo pipefail",
    RESEAU,
    "rm -rf /travail/verif /tmp/sorties/verif && mkdir -p /travail/verif /tmp/sorties/verif && cd /travail/verif",
    `cloner "https://x-access-token:$JETON@github.com/${projet.depot}.git" depot 2>&1 | sed "s/$JETON/***/g"`,
    "cd depot && git remote set-url origin https://github.com/" + projet.depot + ".git",
    `git checkout -q ${q(sha)}`,
    // Les règles qui jugent la PR sont lues sur main : tout fichier protégé
    // modifié par la PR est remis tel qu'il est sur main (ou retiré s'il n'y existe pas).
    `for f in $(git diff --name-only origin/main HEAD -- ${protege}); do if git cat-file -e "origin/main:$f" 2>/dev/null; then git checkout -q origin/main -- "$f"; else rm -f "$f"; fi; done`,
    "echo '@@ CLONE_OK'",
  ].join("\n"), { env: { JETON: config.secrets.github }, minutes: 5 })
  if (!("CLONE_OK" in clone.marqueurs)) return { ok: false, infra: true, raisons: [`clone impossible : ${clone.journal.slice(-400)}`] }

  // 2. Reconstruire, tester, démarrer, puis faire juger par Codex. Sans jeton.
  const env = [
    "export PORT=4100 DATA_DIR=/tmp/verif-data DEMO=1 PUBLIC_URL=http://localhost:4100",
    `export DEMO_VITESSE_HORLOGE=${Number(config.demo?.vitesse_horloge ?? 1)}`,
    ...((config.demo?.services ?? []).includes("mailpit") ? ["export SMTP_HOST=mailpit SMTP_PORT=1025"] : []),
  ].join("\n")
  const r = await executer(serveur, jeton, [
    "set -o pipefail",
    "cd /travail/verif/depot",
    ecrireFichier("/tmp/sorties/verif/consigne.md", consigneVerificateur(projet, tache)),
    "npm ci --no-audit --no-fund > /tmp/sorties/verif/npm.log 2>&1 && echo '@@ INSTALL_OK'",
    // Failles graves (high, critical) des dépendances de production : la PR, puis main pour comparer.
    `AUDIT='const j=JSON.parse(require("fs").readFileSync(0,"utf8")||"{}");const v=(j.metadata||{}).vulnerabilities;console.log(v?(v.high||0)+(v.critical||0):"?")'`,
    "echo \"@@ VULN_GRAVES $(npm audit --omit=dev --json 2>/dev/null | node -e \"$AUDIT\")\"",
    "mkdir -p /tmp/audit-main && git show origin/main:package.json > /tmp/audit-main/package.json 2>/dev/null && git show origin/main:package-lock.json > /tmp/audit-main/package-lock.json 2>/dev/null && echo \"@@ VULN_GRAVES_MAIN $(cd /tmp/audit-main && npm audit --package-lock-only --omit=dev --json 2>/dev/null | node -e \"$AUDIT\")\"",
    // Des secrets dans les lignes ajoutées par la PR (jamais affichés : seulement les fichiers).
    "SECRETS='(xox[abprs]-[0-9A-Za-z-]{10,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{24,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY-----)'",
    "echo \"@@ SECRETS_TROUVES $(git diff origin/main...HEAD --unified=0 -- . ':(exclude)package-lock.json' | grep -E '^\\+' | grep -cE \"$SECRETS\")\"",
    "echo \"@@ SECRETS_FICHIERS $(git diff origin/main...HEAD -G\"$SECRETS\" --name-only -- . ':(exclude)package-lock.json' | tr '\\n' ' ')\"",
    "npm run build > /tmp/sorties/verif/build.log 2>&1 && echo '@@ BUILD_OK' || tail -20 /tmp/sorties/verif/build.log",
    `npm test 2>&1 | tee /tmp/sorties/verif/tests.log | tail -8; ${COMPTER_TESTS} /tmp/sorties/verif/tests.log`,
    env,
    "rm -rf $DATA_DIR",
    "(npm start > /tmp/sorties/verif/app.log 2>&1 &)",
    "for i in $(seq 1 40); do if curl -sf http://localhost:4100/api/health > /dev/null; then echo '@@ APP_STARTED'; break; fi; sleep 2; done",
    "if curl -sf http://localhost:4100/api/health > /dev/null; then",
    "  codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --output-last-message /tmp/sorties/verif/verdict.txt \"$(cat /tmp/sorties/verif/consigne.md)\" > /tmp/sorties/verif/codex.log 2>&1",
    "  echo \"@@ CODEX_CODE $?\"",
    // Le modèle réellement utilisé, lu dans la session Codex (pour le suivi des coûts).
    "  echo \"@@ CODEX_MODELE $(grep -ho '\"model\":\"[^\"]*\"' $(ls -t $(find ~/.codex/sessions -name '*.jsonl' 2>/dev/null) 2>/dev/null | head -1) 2>/dev/null | head -1 | cut -d'\"' -f4)\"",
    "else tail -30 /tmp/sorties/verif/app.log; fi",
  ].join("\n"), { minutes: 30 })

  const m = r.marqueurs
  // La consommation de Codex, même quand il refuse ou échoue.
  if ("CODEX_CODE" in m) {
    const journalCodex = await lireFichier(serveur, jeton, "/tmp/sorties/verif/codex.log")
    if (m.CODEX_MODELE) ecrireReglage(ctx.db, "modele_codex", m.CODEX_MODELE)
    enregistrer(ctx.db, { projet: projet.id, tache: tache.id, role: "verificateur", moteur: "codex", usages: usagesCodex(journalCodex, m.CODEX_MODELE, config), duree_s: r.duree_s ?? 0 })
  }
  let verdict = null
  if ("APP_STARTED" in m) {
    const texte = await lireFichier(serveur, jeton, "/tmp/sorties/verif/verdict.txt")
    try {
      verdict = extraireJson(String(texte ?? ""))
    } catch {
      verdict = null
    }
  }
  const raisons = porte({ marqueurs: m, verdict, plancher: projet.plancher_tests, journal: r.journal })
  const codexEnPanne = "APP_STARTED" in m && !verdict && m.CODEX_CODE !== "0"
  return { ok: raisons.length === 0, infra: codexEnPanne, raisons, verdict, tests: Number(m.TESTS_PASSES ?? 0) }
}

// La porte de fusion : des faits vérifiables, pas un avis. Chaque raison
// renvoyée est un motif de refus. Aucune raison = la tâche peut être fusionnée.
export function porte({ marqueurs: m, verdict, plancher = 0, journal = "" }) {
  const raisons = []
  if (!("INSTALL_OK" in m)) return ["l'installation des dépendances (npm ci) échoue"]
  // La sécurité d'abord : un secret dans le code, ou une faille grave ajoutée.
  if (Number(m.SECRETS_TROUVES ?? 0) > 0) raisons.push(`un secret (clé, jeton ou clé privée) est écrit dans le code : ${m.SECRETS_FICHIERS || "voir le diff"}. Retire-le et lis-le depuis une variable d'environnement.`)
  const vuln = Number(m.VULN_GRAVES)
  const vulnMain = Number(m.VULN_GRAVES_MAIN ?? 0)
  if (Number.isFinite(vuln) && vuln > (Number.isFinite(vulnMain) ? vulnMain : 0)) raisons.push(`la PR ajoute ${vuln - (Number.isFinite(vulnMain) ? vulnMain : 0)} faille(s) grave(s) dans les dépendances de production (npm audit) : choisis une autre dépendance ou une version corrigée`)
  if (!("BUILD_OK" in m)) raisons.push(`le build échoue :\n${journal.split("\n").slice(-20).join("\n")}`)
  const passes = Number(m.TESTS_PASSES ?? 0)
  const echecs = Number(m.TESTS_ECHECS ?? 0)
  if (echecs > 0) raisons.push(`${echecs} test(s) échouent`)
  if (passes === 0) raisons.push("aucun test n'est passé : « zéro test » n'est jamais un succès")
  else if (passes < plancher) raisons.push(`le nombre de tests a baissé (${passes} au lieu d'au moins ${plancher}) : un test ne se supprime pas`)
  if (!("APP_STARTED" in m)) {
    raisons.push("l'application ne démarre pas (le contrôle de santé /api/health ne répond pas)")
    return raisons
  }
  if (!verdict) {
    raisons.push("le vérificateur n'a pas rendu de verdict lisible")
    return raisons
  }
  for (const c of verdict.criteres ?? []) if (c.ok !== true) raisons.push(`critère non validé : ${c.critere}${c.preuve ? ` (observé : ${c.preuve})` : ""}`)
  for (const p of verdict.problemes ?? []) raisons.push(`problème : ${p}`)
  if (verdict.decision !== "approuve" && raisons.length === 0) raisons.push(`le vérificateur refuse : ${verdict.resume ?? "sans motif"}`)
  if (!(verdict.criteres ?? []).length) raisons.push("le vérificateur n'a jugé aucun critère")
  return raisons
}
