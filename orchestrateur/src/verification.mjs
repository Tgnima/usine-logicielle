// Le vérificateur indépendant (« holdout ») : il ne voit ni les notes, ni le
// raisonnement de l'agent qui a codé. Il part d'un clone neuf de la pull request,
// remet les fichiers protégés tels qu'ils sont sur main (une PR ne peut pas
// affaiblir les règles qui la jugent), reconstruit, teste, démarre le produit,
// puis Codex (une autre famille de modèles) le teste comme un visiteur.
//
// Puis, si les critères sont tenus, un second passage juge le design sur captures
// d'écran (brief + grille anti-IA-slop). Et un cliquet : chaque critère validé devient
// un test de non-régression (.usine/e2e/), rejoué à chaque tâche suivante.
//
// La décision finale est prise par porte(), en code : un modèle ne fusionne jamais.
import { RESEAU, executer, ecrireFichier, lireFichier, q } from "./travaux.mjs"
import { COMPTER_TESTS } from "./creation.mjs"
import { extraireJson } from "./analyste.mjs"
import { ecrireReglage, enregistrer, usagesCodex } from "./couts.mjs"
import { grilleEnTexte } from "./design.mjs"

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

Non-régression :
- Lis /tmp/sorties/verif/e2e-echecs.txt : ce sont des tests de critères DÉJÀ validés par le passé (dossier .usine/e2e/) qui échouent maintenant. Pour chacun, décide : régression (ce qui marchait est cassé) → mets-le dans "regressions" ; changement voulu par CETTE tâche (l'écran ou la route a légitimement changé) → réécris ce test sous le même nom dans /tmp/sorties/verif/e2e/.
- Pour chaque critère que tu valides et qui s'observe par HTTP ou dans le navigateur, écris un test autonome /tmp/sorties/verif/e2e/${tache.cle}-<n>.cjs : un script Node CommonJS qui lit process.env.BASE (ex. http://localhost:4100), utilise fetch ou require('playwright') (Chromium), vérifie le critère et termine par process.exit(1) s'il n'est plus tenu (process.exit(0) sinon). Il doit être robuste : données de démo seulement en lecture, ou ses propres données avec un nom unique ; pas de dépendance à l'heure exacte ; 60 secondes au plus.

Captures d'écran (pour le relecteur design) :
- Enregistre de 2 à 6 captures PNG des écrans touchés par la tâche, en largeur 1440 (ordinateur) ET 390 (mobile), page entière, dans /tmp/sorties/verif/captures/ (noms parlants : contacts-bureau.png, contacts-mobile.png…).

Réponds UNIQUEMENT par ce JSON, sans rien autour :
{"decision": "approuve" | "refuse", "criteres": [{"critere": "…", "ok": true, "preuve": "ce que tu as observé"}], "regressions": ["test : ce qui est cassé"], "problemes": ["…"], "resume": "une phrase"}`
}

function consigneDesign(projet, tache) {
  return `Tu es directeur artistique et designer produit senior. Tu juges des captures d'écran d'une application, AVANT qu'elle soit livrée. Exigeant et concret, pas de compliments.

Produit : « ${projet.nom} ». Tâche : ${tache.cle} · ${tache.titre}.
Les images jointes sont des captures en largeur 1440 (ordinateur) et 390 (mobile).

La grille de l'usine (un produit doit avoir l'air pensé par une équipe, pas généré) :
${grilleEnTexte()}

Le brief de design du produit (docs/DESIGN.md) suit en fin de consigne.

Classe ce que tu VOIS sur les captures :
- « grave » : nuit à la crédibilité ou à l'usage (débordement ou page cassée sur mobile, texte illisible ou tronqué, contraste insuffisant, lorem ipsum ou texte générique visible, emojis en guise d'icônes, dégradés ou effets criards, écran vide sans explication, incohérence flagrante avec le brief) ;
- « mineur » : à polir (espacements, alignements, hiérarchie, libellés, états vides perfectibles).
N'invente rien de ce que tu ne vois pas. Une remarque = un écran + le défaut + la correction précise.

Réponds UNIQUEMENT par ce JSON :
{"graves": [{"ecran": "…", "defaut": "…", "correction": "…"}], "mineurs": [{"ecran": "…", "defaut": "…", "correction": "…"}], "note": 0, "resume": "une phrase"}
(note : de 0 à 10, la qualité perçue de ces écrans)

Brief :
`
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
    // Le cliquet : les tests des critères déjà validés (.usine/e2e, protégé) sont rejoués.
    "mkdir -p /tmp/sorties/verif/e2e /tmp/sorties/verif/captures && : > /tmp/sorties/verif/e2e-echecs.txt",
    "E2E_T=0; E2E_E=0; for f in .usine/e2e/*.cjs; do [ -f \"$f\" ] || continue; E2E_T=$((E2E_T+1)); if ! BASE=http://localhost:4100 timeout 90 node \"$f\" > /tmp/e2e.out 2>&1; then E2E_E=$((E2E_E+1)); echo \"== $(basename $f)\" >> /tmp/sorties/verif/e2e-echecs.txt; tail -5 /tmp/e2e.out >> /tmp/sorties/verif/e2e-echecs.txt; fi; done",
    "echo \"@@ E2E_TOTAL $E2E_T\"; echo \"@@ E2E_ECHECS $E2E_E\"",
    "if curl -sf http://localhost:4100/api/health > /dev/null; then",
    "  codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --output-last-message /tmp/sorties/verif/verdict.txt \"$(cat /tmp/sorties/verif/consigne.md)\" > /tmp/sorties/verif/codex.log 2>&1",
    "  echo \"@@ CODEX_CODE $?\"",
    // Le modèle réellement utilisé, lu dans la session Codex (pour le suivi des coûts).
    "  echo \"@@ CODEX_MODELE $(grep -ho '\"model\":\"[^\"]*\"' $(ls -t $(find ~/.codex/sessions -name '*.jsonl' 2>/dev/null) 2>/dev/null | head -1) 2>/dev/null | head -1 | cut -d'\"' -f4)\"",
    "else tail -30 /tmp/sorties/verif/app.log; fi",
    "echo \"@@ CAPTURES $(ls /tmp/sorties/verif/captures/*.png 2>/dev/null | wc -l)\"",
    "echo \"@@ CAPTURES_FICHIERS $(cd /tmp/sorties/verif/captures 2>/dev/null && ls *.png 2>/dev/null | tr '\\n' ' ')\"",
    "echo \"@@ E2E_NOUVEAUX $(cd /tmp/sorties/verif/e2e && ls *.cjs 2>/dev/null | tr '\\n' ' ')\"",
    ecrireFichier("/tmp/sorties/verif/consigne-design.md", consigneDesign(projet, tache)),
    "cat docs/DESIGN.md >> /tmp/sorties/verif/consigne-design.md 2>/dev/null || echo '(pas de brief : juger avec la grille seule)' >> /tmp/sorties/verif/consigne-design.md",
    "IMAGES=$(ls /tmp/sorties/verif/captures/*.png 2>/dev/null | head -6 | sed 's/^/--image=/' | tr '\\n' ' ')",
    "if [ -n \"$IMAGES\" ] && grep -q '\"approuve\"' /tmp/sorties/verif/verdict.txt 2>/dev/null; then",
    "  codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox $IMAGES --output-last-message /tmp/sorties/verif/design.txt \"$(cat /tmp/sorties/verif/consigne-design.md)\" > /tmp/sorties/verif/design.log 2>&1",
    "  echo \"@@ DESIGN_CODE $?\"",
    "fi",
  ].join("\n"), { minutes: 40 })

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
  let design = null
  if ("DESIGN_CODE" in m) {
    const journalDesign = await lireFichier(serveur, jeton, "/tmp/sorties/verif/design.log")
    enregistrer(ctx.db, { projet: projet.id, tache: tache.id, role: "designer", moteur: "codex", usages: usagesCodex(journalDesign, m.CODEX_MODELE, config), duree_s: 0 })
    try {
      design = extraireJson(String((await lireFichier(serveur, jeton, "/tmp/sorties/verif/design.txt")) ?? ""))
    } catch {
      design = null // un relecteur design indisponible ne bloque pas la tâche
    }
  }
  const raisons = porte({ marqueurs: m, verdict, design, plancher: projet.plancher_tests, journal: r.journal })
  const codexEnPanne = "APP_STARTED" in m && !verdict && m.CODEX_CODE !== "0"
  const nouveauxTests = String(m.E2E_NOUVEAUX ?? "").split(/\s+/).filter((f) => /^[\w.-]+\.cjs$/.test(f))
  return { ok: raisons.length === 0, infra: codexEnPanne, raisons, verdict, design, tests: Number(m.TESTS_PASSES ?? 0), nouveauxTests, captures: String(m.CAPTURES_FICHIERS ?? "").split(/\s+/).filter((f) => /^[\w.-]+\.png$/.test(f)) }
}

// La porte de fusion : des faits vérifiables, pas un avis. Chaque raison
// renvoyée est un motif de refus. Aucune raison = la tâche peut être fusionnée.
export function porte({ marqueurs: m, verdict, design = null, plancher = 0, journal = "" }) {
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
  for (const g of verdict.regressions ?? []) raisons.push(`régression (un critère déjà validé ne tient plus) : ${g}`)
  for (const d of design?.graves ?? []) raisons.push(`design : ${d.ecran ? `${d.ecran} : ` : ""}${d.defaut}${d.correction ? ` → ${d.correction}` : ""}`)
  if (verdict.decision !== "approuve" && raisons.length === 0) raisons.push(`le vérificateur refuse : ${verdict.resume ?? "sans motif"}`)
  if (!(verdict.criteres ?? []).length) raisons.push("le vérificateur n'a jugé aucun critère")
  return raisons
}
