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
import { bilanJuge, nomMoteur, relais, scriptJuge } from "./moteurs.mjs"
import { noter } from "./db.mjs"
import { RESEAU, executer, ecrireFichier, lireFichier, q } from "./travaux.mjs"
import { COMPTER_TESTS, NEUTRALISER, VERROUS, brancheDeBase, libererPort, lireProfil, proteges } from "./profil.mjs"
import { extraireJson } from "./analyste.mjs"
import { ecrireReglage, enregistrer, lireReglage, usagesClaude, usagesCodex } from "./couts.mjs"
import { grilleEnTexte } from "./design.mjs"
import { BUDGETS_JS, REFONTE_JS, chargementMax, differencesNonExpliquees, gardeMesure, incidentNonProuve, lireConnus, raisonsBudgets, reprendreMesure, resumeBudgets } from "./mesures.mjs"

// La consommation du juge qui a servi (Codex : son journal --json ; Claude : sa réponse json).
export async function enregistrerJuge(ctx, { serveur, jeton, projet, tache = null, role, moteur, journal, sortieClaude, modeleCodex = null, duree_s = 0 }) {
  if (moteur === "claude-code") {
    let sortie = null
    try {
      sortie = JSON.parse(String((await lireFichier(serveur, jeton, sortieClaude)) ?? ""))
    } catch {}
    if (sortie) enregistrer(ctx.db, { projet: projet.id, tache: tache?.id ?? null, role, moteur: "claude-code", usages: usagesClaude(sortie), duree_s })
    return
  }
  if (modeleCodex) ecrireReglage(ctx.db, "modele_codex", modeleCodex)
  enregistrer(ctx.db, { projet: projet.id, tache: tache?.id ?? null, role, moteur: "codex", usages: usagesCodex(await lireFichier(serveur, jeton, journal), modeleCodex, ctx.config), duree_s })
}

// Les critères que le vérificateur a validés, lus dans son verdict, ajoutés à la consigne du relecteur design.
// Il juge ce qu'il voit ; il ne remet pas en cause un comportement testé dans l'application en marche.
export const CRITERES_VALIDES = `const t = require("fs").readFileSync(0, "utf8")
try {
  const v = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1))
  const ok = (v.criteres || []).filter((c) => c.ok === true).map((c) => "- " + c.critere)
  if (ok.length) process.stdout.write("\\n\\nCe que le vérificateur a DÉJÀ testé dans l'application en marche, et validé. Ne le remets pas en cause à partir des captures : une capture qui semble le contredire vient d'un autre essai. Juge ce que tu vois (lisibilité, cohérence visuelle, libellés), pas ces comportements :\\n" + ok.join("\\n") + "\\n")
} catch {}`

// Les motifs de design du refus précédent de la même tâche : le relecteur vérifie d'abord qu'ils sont corrigés, au lieu de
// faire naître un défaut nouveau à chaque tentative (T19 d'Acte Clair, T81 et T82 de Vigie Copro : le défaut se déplaçait).
export function retoursDesign(tache) {
  const precedents = String(tache?.retours ?? "").split("\n").filter((l) => l.startsWith("- design : ")).map((l) => `- ${l.slice(11)}`)
  if (!precedents.length) return ""
  return `Au passage précédent sur cette tâche, tu as refusé pour ces défauts de design :
${precedents.join("\n")}
Vérifie d'abord, sur les captures, s'ils sont corrigés : un défaut corrigé ne revient pas dans ta réponse. Un NOUVEAU défaut « grave » ne vaut que s'il est flagrant (page cassée, texte illisible ou tronqué, information fausse à l'écran) ; un détail que tu n'avais pas relevé la dernière fois va dans « mineurs ».

`
}

// Les motifs du périmètre protégé, en pathspec git.
export const pathspec = (motifs) => motifs.map((m) => (m.includes("*") ? `':(glob)${m}'` : q(m))).join(" ")

// Ce que la nature d'une tâche ajoute à la consigne du vérificateur. L'usine démarre alors l'ancienne version
// (la branche de base) à côté, sur le port 4101 : une refonte lui est comparée avant le jugement (écart 5), et
// les tests d'un incident y sont rejoués après (écart 4).
export function consigneNature(tache) {
  const aCote = "- Une autre version de l'application tourne à côté, sur le port 4101 : pour relancer l'application, arrête-la par son port (`fuser -k -n tcp 4100`), jamais par son nom (pkill, killall), qui arrêterait les deux.\n"
  if (tache.nature === "refonte") {
    return aCote + `- Cette tâche est une REFONTE : rien ne doit changer à l'écran ni dans les réponses de l'API. L'usine a démarré l'ancienne version (la branche de base) sur http://localhost:4101 et l'a comparée à la nouvelle, page par page et route par route. Les différences sont dans /tmp/sorties/verif/refonte.txt, avec les images (avant, après, différence en rouge) et les réponses dans /tmp/sorties/verif/refonte/. Regarde chacune. Un changement du produit est un problème bloquant. Ce qui n'est que du bruit (une heure, un identifiant, une donnée de démo tirée au sort) va dans "differences_refonte", avec son identifiant copié de refonte.txt (« page:/contacts:bureau », « route:/api/contacts ») et l'explication. Une différence ni expliquée ni signalée part à une personne, qui regardera les images. Ne modifie rien sur le port 4101.\n`
  }
  if (tache.nature === "incident") {
    return aCote + `- Cette tâche corrige un INCIDENT de production. Écris au moins un test qui le reproduit, /tmp/sorties/verif/e2e/${tache.cle}-incident.cjs (ou ${tache.cle}-incident-<n>.cjs) : il échoue tant que l'incident existe, et passe une fois corrigé. Il lit l'adresse dans process.env.BASE, crée ses propres données, et ne dépend ni des emails déjà présents dans Mailpit, ni de données créées ailleurs. Après ton verdict, l'usine relance ces tests (et seulement eux) sur l'ancienne version, sans la correction : au moins un doit y échouer. Sinon, une personne décide, avec ce que tu as observé.\n`
  }
  return ""
}

// Un critère validé a son corrigé : un test qui passe et rejoint le cliquet (écart 3). Le test d'un critère
// porte son numéro dans la liste (T3-2.cjs, ou T3-2-xxx.cjs). Sans test, il est « non prouvé » : dit dans la PR et
// au journal, avec la raison donnée par le vérificateur (sans_test), ou sans raison.
export function criteresNonProuves({ verdict, criteres = [], cle, tests = [] }) {
  const parTexte = new Map(tableau(verdict?.criteres).map((c) => [norme(c?.critere), c]))
  const noms = new Set(nomsDeTests(tableau(tests).join(" ")))
  const nonProuves = []
  for (const [i, texte] of tableau(criteres).entries()) {
    const v = parTexte.get(norme(texte)) ?? tableau(verdict?.criteres)[i]
    if (v?.ok !== true) continue
    const motif = new RegExp(`^${String(cle).replace(/[^\w-]/g, "")}-${i + 1}(-[\\w.-]+)?\\.cjs$`)
    if ([...noms].some((n) => motif.test(n))) continue
    nonProuves.push({ critere: String(texte).slice(0, 300), raison: String(v?.sans_test ?? "").trim().slice(0, 300) })
  }
  return nonProuves
}

function consigneVerificateur(projet, tache, profil, autres = {}) {
  const criteres = JSON.parse(tache.criteres)
  const sautes = Object.entries(autres).filter(([, cs]) => cs.length)
  const aideSautes = sautes.length
    ? `- Ces tests n'avaient pas été rejoués aux vérifications précédentes (plafond de temps). S'ils échouent, un critère d'une tâche fusionnée entre-temps peut aussi expliquer le changement ; cite-le alors mot pour mot :\n${sautes.map(([t, cs]) => `  - ${t} : ${cs.map((c) => `« ${String(c).slice(0, 300)} »`).join(" ; ")}`).join("\n")}\n`
    : ""
  return `Tu es le vérificateur indépendant d'une usine logicielle. Tu juges si une tâche est réellement faite, sans complaisance.

Le produit « ${projet.nom} » tourne en ce moment sur http://localhost:4100 (API sous /api, interface sur /). Le code est dans le dossier courant.

Tâche à vérifier : ${tache.cle} · ${tache.titre}
${tache.description}

Critères d'acceptation, à vérifier UN PAR UN sur l'application en marche :
${criteres.map((c, i) => `${i + 1}. ${c}`).join("\n")}

Méthode :
- Teste toi-même : appels HTTP avec curl, et pour l'interface un script Node avec Playwright (\`const { chromium } = require('playwright')\`, Chromium est installé). Ne te fie pas aux tests existants.
- Les tests automatisés (${profil.tester}) ont déjà été lancés par l'usine, dans un environnement propre : ne les relance pas, juge l'application en marche.
- Tu peux lire le code pour trouver les routes, mais ne le modifie pas.
- Adresse publique : ici PUBLIC_URL=http://localhost:4100. Des liens absolus en http://localhost:4100 (dans les emails, par exemple) sont donc NORMAUX pendant la vérification : en ligne, l'usine fixe PUBLIC_URL à la vraie adresse. Pour juger une exigence d'URL absolues, relance l'application avec PUBLIC_URL=https://exemple.test et vérifie que les nouveaux liens l'utilisent.
- Environnement de l'application : DEMO=1, emails capturés par Mailpit (SMTP_HOST=mailpit, interface web sur http://mailpit:8025, API /api/v1/messages), aucune liste de destinataires autorisés. Si un critère dépend d'une variable d'environnement (voir le tableau d'AGENTS.md, par exemple EMAIL_DESTINATAIRES_AUTORISES), arrête l'application et relance-la toi-même avec cette variable (\`PORT=4100 DATA_DIR=… ${profil.demarrer}\`), puis remets-la comme avant.
- Navigateur : ouvre-le en français, comme les utilisateurs (Playwright : locale "fr-FR", timezoneId "Europe/Paris"). Un champ date natif affiché en mm/jj/aaaa vient d'un navigateur en anglais, pas du produit.
- Un critère est validé seulement si tu l'as observé. Dans le doute, il est refusé.
- Note aussi un défaut grave hors critères (page blanche, erreur 500, donnée incohérente).
- Ne modifie pas les données de démonstration existantes : pour tester une action (diffuser, clore, corriger, supprimer), crée tes propres données, avec un nom unique. Sinon les captures et le relecteur design jugeraient un état que tu as fabriqué.
- "problemes" ne contient que des défauts BLOQUANTS du produit : chacun refuse la tâche. Ce que tu as fait pour vérifier, et une remarque non bloquante, vont dans "resume".
- Cohérence entre écrans : pour chaque donnée que cette tâche crée ou affiche (un nombre, une date, un délai, un état, un nom), compare sa valeur partout où elle apparaît : liste, carte, fiche, réglages, registre et API. Une même donnée qui diffère d'un écran à l'autre, à la même taille ou entre ordinateur et téléphone, est un problème bloquant : nomme les deux écrans et les deux valeurs. Ne parcours pas tout le produit : seulement les écrans où figure une donnée touchée par la tâche. Exception : la page /kit est un catalogue de composants, dont les exemples sont des échantillons indépendants et non des données du produit. La cohérence entre écrans ne s'y applique pas, même entre deux exemples de la même page : juges-y l'apparence, les états, la lisibilité et l'accès au clavier.
- Un critère impossible à tenir tel qu'il est écrit, ou qui contredit un autre critère, une décision ou le brief, se conteste au lieu de se refuser sans fin : mets-le aussi dans "criteres_contestes" avec la raison précise, et laisse-le à ok: false. Tu ne contestes pas un critère parce qu'il est difficile ou que le produit ne le tient pas encore : seulement si aucune version correcte du produit ne pourrait le tenir. Une personne tranchera.

Non-régression :
- Lis /tmp/sorties/verif/e2e-echecs.txt : ce sont des tests de critères DÉJÀ validés par le passé (dossier .usine/e2e/) qui échouent maintenant. Ce sont des corrigés : on ne les réécrit pas pour coller à l'application. Pour chacun, décide :
  - ce qui marchait est cassé → c'est une régression : mets-le dans "regressions" ;
  - un critère de CETTE tâche change exprès ce comportement → réécris ce test sous le même nom dans /tmp/sorties/verif/e2e/ ET déclare-le dans "tests_remplaces", avec le texte EXACT de ce critère, copié de la liste ci-dessus, et la raison. L'usine vérifie que ce critère existe : sans lui, une personne tranchera. Ton test réécrit doit passer sur l'application telle qu'elle est.
${aideSautes}- Ne réécris jamais un test qui passe, et ne relâche jamais une vérification pour qu'elle passe.
- Pour chaque critère que tu valides et qui s'observe par HTTP ou dans le navigateur, écris un test autonome /tmp/sorties/verif/e2e/${tache.cle}-<n>.cjs, où <n> est le numéro du critère dans la liste ci-dessus : un script Node CommonJS qui lit process.env.BASE (ex. http://localhost:4100), utilise fetch ou require('playwright') (Chromium), vérifie le critère et termine par process.exit(1) s'il n'est plus tenu (process.exit(0) sinon). Il doit être robuste : données de démo seulement en lecture, ou ses propres données avec un nom unique ; pas de dépendance à l'heure exacte ; 60 secondes au plus. Ce test est le corrigé du critère : il doit échouer sur une version du produit qui ne tient pas le critère.
- Un critère validé sans test est « non prouvé » : l'usine le dit dans la PR et au journal. S'il ne peut vraiment pas devenir un test (un jugement visuel, par exemple), écris pourquoi dans "sans_test" de ce critère.
${consigneNature(tache)}
Captures d'écran (pour le relecteur design) :
- Si le produit a une interface web, enregistre de 2 à 6 captures PNG des écrans touchés par la tâche, en largeur 1440 (ordinateur) ET 390 (mobile), page entière, dans /tmp/sorties/verif/captures/ (noms parlants : contacts-bureau.png, contacts-mobile.png…). Les étapes d'un même parcours (la saisie, puis son résultat) viennent du MÊME essai, et le nom dit le scénario (appel-rattacher-saisie-bureau.png, appel-rattacher-resultat-bureau.png, appel-nouvelle-resultat-bureau.png) : sinon le relecteur design comparerait deux essais différents. Une API sans interface : pas de capture, mais vérifie que chaque route de la tâche est décrite dans docs/API.md.

Réponds UNIQUEMENT par ce JSON, sans rien autour :
{"decision": "approuve" | "refuse", "criteres": [{"critere": "…", "ok": true, "preuve": "ce que tu as observé", "sans_test": "seulement si ce critère validé n'a pas de test : pourquoi"}], "regressions": ["test : ce qui est cassé"],${tache.nature === "refonte" ? ` "differences_refonte": [{"difference": "son identifiant dans refonte.txt", "explication": "pourquoi ce n'est pas un changement du produit"}],` : ""} "tests_remplaces": [{"test": "T3-2.cjs", "critere": "texte exact du critère de cette tâche", "raison": "ce qui a changé exprès"}], "problemes": ["…"], "criteres_contestes": [{"critere": "…", "raison": "pourquoi il est impossible ou contradictoire"}], "resume": "une phrase"}`
}

// Les critères que le vérificateur juge impossibles ou contradictoires. Ils ne valident rien : la tâche s'arrête
// sans consommer de tentative et une personne tranche, au lieu de refuser en boucle (T84 de Vigie Copro).
export const criteresContestes = (verdict) => (Array.isArray(verdict?.criteres_contestes) ? verdict.criteres_contestes : [])
  .filter((c) => c && String(c.critere ?? "").trim() && String(c.raison ?? "").trim())
  .map((c) => ({ critere: String(c.critere).slice(0, 500), raison: String(c.raison).slice(0, 800) }))

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
Les captures sont souvent prises en page entière : une barre de navigation ou un bouton fixé en bas de l'écran y apparaît alors au milieu de la page, par-dessus le contenu qui défile. C'est un effet de la capture, pas un défaut. Ne le signale que si un contenu reste masqué tout en bas de la page, là où le défilement s'arrête.
Ne conclus qu'un résultat contredit une saisie que si leurs noms de fichier désignent le même scénario (même début de nom, « -saisie » puis « -resultat ») : deux captures de scénarios différents (un rattachement, puis une nouvelle affaire) ne se comparent pas. Les données créées pendant les essais du vérificateur (une affaire de plus, par exemple) ne sont pas un défaut du produit.

${retoursDesign(tache)}Réponds UNIQUEMENT par ce JSON :
{"graves": [{"ecran": "…", "defaut": "…", "correction": "…"}], "mineurs": [{"ecran": "…", "defaut": "…", "correction": "…"}], "note": 0, "resume": "une phrase"}
(note : de 0 à 10, la qualité perçue de ces écrans)

Brief :
`
}

// Les pages à photographier : l'accueil et les pages citées par la tâche (pas l'API ni les fichiers).
export function pagesDeLaTache(tache) {
  let criteres = []
  try {
    criteres = JSON.parse(tache.criteres ?? "[]")
  } catch {}
  // [...slug] et [[...slug]] (Next.js, routes attrape-tout) : lus comme un paramètre simple.
  const texte = `${tache.titre ?? ""}\n${tache.description ?? ""}\n${criteres.join("\n")}`.replace(/\[{1,2}\.\.\.([a-z_]+)\]{1,2}/gi, "[$1]")
  const pages = new Set(["/"])
  // Un paramètre d'adresse s'écrit /:id (Express) ou /[id] (Next.js) : il fait partie du chemin.
  for (const m of texte.matchAll(/(?<![\w./\]-])\/[a-z][a-z0-9_\-/:[\]]*/gi)) {
    const chemin = m[0].replace(/\/:[a-z_]+/gi, "/1").replace(/\/\[{1,2}\.{0,3}[a-z_]+\]{1,2}/gi, "/1").replace(/\/+$/, "")
    if (/^\/(api|_portier|tmp|travail|public)\b/i.test(chemin) || /\.[a-z]{2,4}$/i.test(chemin) || chemin.length < 2) continue
    pages.add(chemin)
    if (pages.size >= 3) break
  }
  return [...pages]
}

const CAPTURES_JS = `// Les captures d'écran de la tâche, prises par l'usine elle-même (pas par le modèle) :
// chaque page, sur ordinateur (1440 px) puis sur mobile (390 px).
const { chromium } = require("playwright")
const BASE = process.env.BASE
const PAGES = JSON.parse(process.env.PAGES || '["/"]')
;(async () => {
  const navigateur = await chromium.launch()
  for (const [format, largeur, hauteur] of [["bureau", 1440, 900], ["mobile", 390, 844]]) {
    // Un navigateur français, comme celui des utilisateurs : les champs date natifs s'affichent en jj/mm/aaaa.
    const contexte = await navigateur.newContext({ viewport: { width: largeur, height: hauteur }, locale: "fr-FR", timezoneId: "Europe/Paris" })
    const page = await contexte.newPage()
    for (const [i, chemin] of PAGES.entries()) {
      try {
        const reponse = await page.goto(BASE + chemin, { waitUntil: "networkidle", timeout: 20000 })
        // Une page en erreur (un identifiant deviné qui n'existe pas en démo) n'est pas jugée sur capture.
        if (reponse && reponse.status() >= 400) {
          console.log(\`page non photographiée : \${chemin} (HTTP \${reponse.status()})\`)
          continue
        }
        await page.waitForTimeout(800)
        const nom = (chemin.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "accueil").slice(0, 40)
        await page.screenshot({ path: \`/tmp/sorties/verif/captures/\${i + 1}-\${nom}-\${format}.png\` })
      } catch (e) {
        console.log(\`capture impossible : \${chemin} (\${String(e.message).split("\\n")[0]})\`)
      }
    }
    await contexte.close()
  }
  await navigateur.close()
})().catch((e) => console.log(\`captures : \${e.message}\`))
`

// Un nom de test sûr : lettres ASCII, chiffres, point, tiret, souligné, puis .cjs. Les autres ne sont ni rejoués
// ni versés, mais comptés (E2E_NOMS_INVALIDES) et dits au journal : un nom de fichier ne peut pas forger un marqueur.
const NOM_SUR = /^[\w.-]+\.cjs$/
const CAS_NOM_SUR = `case "$n" in *[!A-Za-z0-9._-]*|.cjs) E2E_I=$((E2E_I+1)); continue ;; esac`
export const nomsDeTests = (v) => String(v ?? "").split(/\s+/).filter((f) => NOM_SUR.test(f))
const tableau = (v) => (Array.isArray(v) ? v : [])

// Le cliquet rejoué : les tests des critères déjà validés (.usine/e2e, protégé). Ceux qui avaient été sautés la
// fois précédente passent d'abord, les autres dans un ordre tiré au sort. Le temps est plafonné (20 min au plus,
// sous la limite de 40 min de la vérification) ; au-delà, les tests restants sont comptés et nommés comme sautés,
// jamais tus. Un test qui échoue est relancé une fois avant d'être compté : un test instable ne bloque pas une tâche.
export const minutesCliquet = (config) => Math.min(20, Math.max(1, Math.round(Number(config?.autonomie?.minutes_cliquet) || 15)))
export function rejouerCliquet({ minutes = 15, secondes = null, base = "http://localhost:4100", sorties = "/tmp/sorties/verif", prioritaires = [] } = {}) {
  // secondes : pour les tests seulement ; en service, le plafond se règle en minutes.
  const budget = Number.isFinite(secondes) ? Math.max(0, Math.round(secondes)) : minutesCliquet({ autonomie: { minutes_cliquet: minutes } }) * 60
  const avant = nomsDeTests(tableau(prioritaires).join(" ")).join(" ")
  const essai = `BASE=${base} timeout 90 node "$f" > /tmp/e2e.out 2>&1`
  return [
    `mkdir -p ${sorties}/e2e ${sorties}/captures && : > ${sorties}/e2e-echecs.txt`,
    `command -v shuf > /dev/null || shuf() { cat; }`,
    `E2E_T=0; E2E_E=0; E2E_S=0; E2E_I=0; E2E_NOMS=""; E2E_SNOMS=""; E2E_FIN=$(( $(date +%s) + ${budget} ))`,
    `E2E_AVANT=" ${avant} "; E2E_L=(); for n in $E2E_AVANT; do [ -f ".usine/e2e/$n" ] && E2E_L+=(".usine/e2e/$n"); done`,
    `while IFS= read -r f; do case "$E2E_AVANT" in *" $(basename "$f") "*) ;; *) E2E_L+=("$f") ;; esac; done < <(for f in .usine/e2e/*.cjs; do [ -f "$f" ] && printf '%s\\n' "$f"; done | shuf)`,
    `for f in "\${E2E_L[@]}"; do n=$(basename "$f"); ${CAS_NOM_SUR}; if [ "$(date +%s)" -ge "$E2E_FIN" ]; then E2E_S=$((E2E_S+1)); E2E_SNOMS="$E2E_SNOMS $n"; continue; fi; E2E_T=$((E2E_T+1)); if ! ${essai} && ! ${essai}; then E2E_E=$((E2E_E+1)); E2E_NOMS="$E2E_NOMS $n"; echo "== $n" >> ${sorties}/e2e-echecs.txt; tail -5 /tmp/e2e.out >> ${sorties}/e2e-echecs.txt; fi; done`,
    `echo "@@ E2E_TOTAL $E2E_T"; echo "@@ E2E_ECHECS $E2E_E"; echo "@@ E2E_ECHECS_NOMS $E2E_NOMS"; echo "@@ E2E_SAUTES $E2E_S"; echo "@@ E2E_SAUTES_NOMS $E2E_SNOMS"; echo "@@ E2E_NOMS_INVALIDES $E2E_I"`,
  ]
}

// Les tests écrits par le vérificateur, triés pendant que l'application tourne encore : chacun est d'abord lancé
// (avec un second essai), et seuls ceux qui passent sont gardés. Un test qui existe déjà sur la branche de base
// (ref, lue dans git et non dans le clone modifiable) est une réécriture ; les autres sont nouveaux.
export function trierTestsEcrits({ sorties = "/tmp/sorties/verif", base = "http://localhost:4100", ref = null } = {}) {
  const existe = ref ? `git cat-file -e ${ref}:".usine/e2e/$n" 2> /dev/null` : `[ -f ".usine/e2e/$n" ]`
  const essai = `BASE=${base} timeout 90 node "$f" > /tmp/e2e-ecrit.out 2>&1`
  return `E2E_NEUFS=""; E2E_REMP=""; E2E_KO=""; E2E_I=0; for f in ${sorties}/e2e/*.cjs; do [ -f "$f" ] || continue; n=$(basename "$f"); ${CAS_NOM_SUR}; if ! ${essai} && ! ${essai}; then E2E_KO="$E2E_KO $n"; continue; fi; if ${existe}; then E2E_REMP="$E2E_REMP $n"; else E2E_NEUFS="$E2E_NEUFS $n"; fi; done; echo "@@ E2E_NOUVEAUX $E2E_NEUFS"; echo "@@ E2E_REMPLACES $E2E_REMP"; echo "@@ E2E_ECRITS_KO $E2E_KO"; echo "@@ E2E_ECRITS_INVALIDES $E2E_I"`
}

// Un critère comparé à sa citation : sans numéro en tête (« 1. »), apostrophes et guillemets unifiés, sans
// point final, aux espaces et à la casse près.
const norme = (s) => String(s ?? "").replace(/[’‘`´]/g, "'").replace(/[«»“”]/g, '"').replace(/^\s*\d+\s*[.)]\s*/, "").replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "").toLowerCase()
const nomDuTest = (t) => String(t ?? "").trim().split(/[\\/]/).pop()

// Les réécritures de tests du cliquet que le vérificateur déclare, gardées seulement si le critère cité existe
// bien : dans CETTE tâche, ou dans une tâche fusionnée pendant que ce test était sauté (autres[test]).
export function testsRemplacesJustifies(verdict, criteres = [], autres = {}) {
  const permisTache = new Set(tableau(criteres).map(norme).filter(Boolean))
  const justifies = new Map()
  for (const e of tableau(verdict?.tests_remplaces)) {
    const test = nomDuTest(e?.test)
    if (!NOM_SUR.test(test)) continue
    const cite = norme(e?.critere)
    if (!cite || !(permisTache.has(cite) || tableau(autres[test]).map(norme).includes(cite))) continue
    justifies.set(test, { test, critere: String(e.critere).trim().slice(0, 500), raison: String(e.raison ?? "").trim().slice(0, 500) })
  }
  return justifies
}

// Les réécritures déclarées par le vérificateur qui ne tiennent pas, pour un test qui échoue : critère introuvable,
// ou fichier réécrit absent ou qui échoue lui-même. Ce n'est pas la faute du codeur : une personne tranche, comme
// pour un critère contesté (sans tentative consommée).
export function contestesCliquet({ verdict, marqueurs: m = {}, criteres = [], autres = {} }) {
  const echecs = nomsDeTests(m.E2E_ECHECS_NOMS)
  const remplaces = nomsDeTests(m.E2E_REMPLACES)
  const ratés = nomsDeTests(m.E2E_ECRITS_KO)
  const justifies = testsRemplacesJustifies(verdict, criteres, autres)
  const contestes = []
  for (const e of tableau(verdict?.tests_remplaces)) {
    const f = nomDuTest(e?.test)
    if (!echecs.includes(f) || (justifies.has(f) && remplaces.includes(f))) continue
    const raison = !justifies.has(f)
      ? `le vérificateur juge ce changement voulu (« ${String(e?.raison ?? "").slice(0, 300)} ») mais cite un critère qui n'est pas dans la tâche : « ${String(e?.critere ?? "").slice(0, 300)} »`
      : ratés.includes(f)
        ? "le vérificateur a réécrit ce test, mais la nouvelle version échoue elle-même sur l'application"
        : "le vérificateur déclare une réécriture sans fournir le test réécrit"
    contestes.push({ critere: `Test du cliquet ${f}`, raison: `${raison}. Faut-il garder l'ancien test (le codeur rétablit le comportement) ou accepter le changement ?` })
  }
  return contestes
}

// Les réécritures qui rejoindront le cliquet : seulement celles, justifiées, d'un test qui échouait (E2E_REMPLACES
// ne liste que des tests réécrits qui passent eux-mêmes). Celles d'un test qui n'échouait pas sont écartées.
export function reecrituresAVerser({ verdict, marqueurs: m = {}, criteres = [], autres = {} }) {
  const echecs = nomsDeTests(m.E2E_ECHECS_NOMS)
  const justifies = testsRemplacesJustifies(verdict, criteres, autres)
  const ecrits = nomsDeTests(m.E2E_REMPLACES)
  return {
    remplaces: ecrits.filter((f) => echecs.includes(f) && justifies.has(f)).map((f) => justifies.get(f)),
    ecartes: ecrits.filter((f) => !echecs.includes(f)),
  }
}

// Les tests sautés d'un projet, gardés entre deux vérifications : { "T3-2.cjs": [id des tâches vérifiées pendant
// qu'il était sauté] }. Un test qui a tourné sort de la liste.
export function lireSautes(db, cle) {
  try {
    const v = JSON.parse(lireReglage(db, cle, "{}"))
    return v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([t, ids]) => NOM_SUR.test(t) && Array.isArray(ids))) : {}
  } catch {
    return {}
  }
}
export function ecrireSautes(db, cle, avant, sautesMaintenant, tacheId) {
  const suite = {}
  for (const t of sautesMaintenant) suite[t] = [...new Set([...(avant[t] ?? []), tacheId])].slice(-50)
  ecrireReglage(db, cle, JSON.stringify(suite))
  return suite
}
// Les critères des tâches FUSIONNÉES pendant qu'un test était sauté : eux seuls peuvent, en plus de ceux de la tâche
// en cours, justifier la réécriture de ce test.
export function criteresDesTachesSautees(db, sautes) {
  const autres = {}
  for (const [test, ids] of Object.entries(sautes)) {
    const criteres = []
    for (const id of ids) {
      const t = db.prepare("SELECT criteres, statut FROM taches WHERE id = ?").get(id)
      if (t?.statut !== "fusionnee") continue
      try {
        criteres.push(...tableau(JSON.parse(t.criteres || "[]")).map(String))
      } catch {}
    }
    if (criteres.length) autres[test] = criteres
  }
  return autres
}

// Arrête tout serveur d'application encore en vie dans le vérificateur, puis attend que le port se libère.
const LIBERER_PORT = libererPort(4100)

// L'ancienne version (la branche de base), démarrée à côté sur le port 4101 pour une refonte ou un incident :
// un arbre de travail du même clone, ses dépendances, son build et ses propres données. Elle reçoit le même
// environnement que la nouvelle (DEMO, horloge, Mailpit), sauf le port, le dossier de données et l'adresse.
export const ANCIENNE = "http://localhost:4101"
// Son port se libère PAR SON NUMÉRO seulement : libererPort() tue aussi par nom (« node server/index.js »,
// « npm start »), ce qui arrêterait la nouvelle version qui tourne à côté.
export const LIBERER_ANCIENNE = `fuser -k -n tcp 4101 >/dev/null 2>&1; for i in 1 2 3 4 5 6; do curl -s -o /dev/null ${ANCIENNE}/ || break; fuser -k -n tcp 4101 >/dev/null 2>&1; sleep 1; done`
// 1. Avant que la nouvelle version démarre : l'ancienne est extraite, installée et construite. Les deux
// démarrent ensuite l'une après l'autre, avec des données de démonstration aussi fraîches.
export function preparerAncienne(B, profil) {
  return [
    LIBERER_ANCIENNE,
    "rm -rf /tmp/verif-data-base; git worktree remove --force /travail/verif/base > /dev/null 2>&1; rm -rf /travail/verif/base",
    `git worktree add -q -f --detach /travail/verif/base ${B} > /tmp/sorties/verif/base.log 2>&1 && echo '@@ BASE_EXTRAITE'`,
    "rm -f /tmp/sorties/verif/base-construite",
    `if [ -d /travail/verif/base ]; then (cd /travail/verif/base && export PORT=4101 DATA_DIR=/tmp/verif-data-base PUBLIC_URL=${ANCIENNE} && bash -c ${q(profil.installer)} >> /tmp/sorties/verif/base.log 2>&1 && bash -c ${q(profil.construire)} >> /tmp/sorties/verif/base.log 2>&1 && touch /tmp/sorties/verif/base-construite && echo '@@ BASE_CONSTRUITE'); fi`,
  ]
}
// 2. Juste après la nouvelle, l'ancienne démarre sur 4101 ; elle est relancée de même avant le rejeu d'un
// incident si elle s'est arrêtée entre-temps. Un port 4101 qui reste pris est dit (BASE_PORT_OCCUPE) : l'usine
// ne compare jamais à un serveur inconnu.
export function demarrerAncienne(profil) {
  return [
    `if ! curl -sf ${ANCIENNE}/api/health > /dev/null && [ -f /tmp/sorties/verif/base-construite ]; then`,
    LIBERER_ANCIENNE,
    `if curl -s -o /dev/null ${ANCIENNE}/; then echo '@@ BASE_PORT_OCCUPE'; else (cd /travail/verif/base && PORT=4101 DATA_DIR=/tmp/verif-data-base PUBLIC_URL=${ANCIENNE} setsid bash -c ${q(profil.demarrer)} >> /tmp/sorties/verif/base-app.log 2>&1 &); fi`,
    "fi",
    `for i in $(seq 1 40); do if curl -sf ${ANCIENNE}/api/health > /dev/null; then echo '@@ BASE_STARTED'; break; fi; sleep 2; done`,
  ]
}

// Une refonte : l'ancienne version et la nouvelle, comparées dès leur démarrage, avant le cliquet (qui crée
// ses propres données) et avant le jugement (REFONTE_JS, mesures.mjs).
export function comparerRefonte(tache) {
  let criteres = []
  try {
    criteres = JSON.parse(tache.criteres ?? "[]")
  } catch {}
  const texte = `${tache.titre ?? ""} ${tache.description ?? ""} ${criteres.join(" ")}`.slice(0, 4000)
  return [
    ecrireFichier("/tmp/sorties/verif/refonte.cjs", REFONTE_JS),
    `if curl -sf ${ANCIENNE}/api/health > /dev/null && curl -sf http://localhost:4100/api/health > /dev/null; then ANCIEN=${ANCIENNE} NOUVEAU=http://localhost:4100 PAGES=${q(JSON.stringify(pagesDeLaTache(tache)))} TEXTE=${q(texte)} timeout 600 node /tmp/sorties/verif/refonte.cjs; fi`,
  ]
}

// 3. Un incident : les tests d'incident écrits par le vérificateur (T<n>-incident*.cjs), qui passent sur la
// nouvelle version, sont relancés sur l'ancienne. Un test qui y échoue deux fois reproduit l'incident. Les autres
// tests de la tâche ne comptent pas : un critère nouveau échoue toujours sur l'ancienne version.
export function rejouerSurAncienne(cle, sorties = "/tmp/sorties/verif") {
  const c = String(cle ?? "").replace(/[^\w-]/g, "")
  return `if curl -sf ${ANCIENNE}/api/health > /dev/null; then INC_T=""; INC_R=""; for n in $E2E_NEUFS; do case "$n" in ${c}-incident*.cjs) ;; *) continue ;; esac; f=${sorties}/e2e/$n; [ -f "$f" ] || continue; INC_T="$INC_T $n"; if ! BASE=${ANCIENNE} timeout 90 node "$f" > /tmp/e2e-ancienne.out 2>&1 && ! BASE=${ANCIENNE} timeout 90 node "$f" > /tmp/e2e-ancienne.out 2>&1; then INC_R="$INC_R $n"; fi; done; echo "@@ INCIDENT_TESTES $INC_T"; echo "@@ INCIDENT_REPRODUIT $INC_R"; fi`
}

// La durée maximale d'une vérification : l'ancienne version (installation, build, démarrage, comparaison) en
// demande plus.
export const minutesVerification = (tache) => (tache?.nature ? 60 : 45)

// journal : false pour l'audit du vérificateur (audit.mjs) : rien n'est noté au journal ni gardé pour la tâche.
export async function verifier(ctx, projet, tache, sha, { journal = true } = {}) {
  const { config } = ctx
  const serveur = config.verificateur.url
  const jeton = config.secrets.worker
  const protege = pathspec(proteges(config, projet))
  const profil = lireProfil(projet)
  const B = q(`origin/${brancheDeBase(projet)}`)
  const nature = tache.nature === "refonte" || tache.nature === "incident" ? tache.nature : null
  const minutes = minutesVerification({ nature })
  // La mesure des budgets gardée pour une acceptation humaine : celle de CETTE vérification, jamais une plus ancienne.
  if (journal && tache.id) reprendreMesure(ctx.db, tache.id)
  // Les tests du cliquet sautés aux vérifications précédentes (plafond de temps) : rejoués d'abord, et, s'ils
  // échouent, un critère d'une tâche fusionnée pendant qu'ils étaient sautés peut justifier leur réécriture.
  const cleSautes = `cliquet_sautes_${projet.id}`
  const sautesAvant = lireSautes(ctx.db, cleSautes)
  const autres = criteresDesTachesSautees(ctx.db, sautesAvant)
  const plafond = minutesCliquet(config)

  // 1. Clone neuf de la PR (seule étape qui voit le jeton GitHub).
  const clone = await executer(serveur, jeton, [
    "set -eo pipefail",
    RESEAU,
    "rm -rf /travail/verif /tmp/sorties/verif && mkdir -p /travail/verif /tmp/sorties/verif && cd /travail/verif",
    `cloner "https://x-access-token:$JETON@github.com/${projet.depot}.git" depot 2>&1 | sed "s/$JETON/***/g"`,
    "cd depot && git remote set-url origin https://github.com/" + projet.depot + ".git",
    `git checkout -q ${q(sha)}`,
    // Les règles qui jugent la PR sont lues sur la branche de base : tout fichier protégé
    // modifié par la PR est remis tel qu'il y est (ou retiré s'il n'y existe pas).
    `for f in $(git diff --name-only ${B} HEAD -- ${protege}); do if git cat-file -e ${B}":$f" 2>/dev/null; then git checkout -q ${B} -- "$f"; else rm -f "$f"; fi; done`,
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
    ecrireFichier("/tmp/sorties/verif/consigne.md", consigneVerificateur(projet, { ...tache, nature }, profil, autres)),
    // Les journaux suivis en direct par la console repartent de zéro.
    "rm -f /tmp/sorties/verif/design.log; : > /tmp/sorties/verif/codex.log",
    `bash -c ${q(profil.installer)} > /tmp/sorties/verif/npm.log 2>&1 && echo '@@ INSTALL_OK'`,
    // Failles graves (high, critical) des dépendances de production (npm) : la PR, puis la base pour comparer.
    `AUDIT='const j=JSON.parse(require("fs").readFileSync(0,"utf8")||"{}");const v=(j.metadata||{}).vulnerabilities;console.log(v?(v.high||0)+(v.critical||0):"?")'`,
    "if [ -f package-lock.json ]; then echo \"@@ VULN_GRAVES $(npm audit --omit=dev --json 2>/dev/null | node -e \"$AUDIT\")\"; fi",
    `rm -rf /tmp/audit-main && mkdir -p /tmp/audit-main && git show ${B}:package.json > /tmp/audit-main/package.json 2>/dev/null && git show ${B}:package-lock.json > /tmp/audit-main/package-lock.json 2>/dev/null && echo "@@ VULN_GRAVES_MAIN $(cd /tmp/audit-main && npm audit --package-lock-only --omit=dev --json 2>/dev/null | node -e "$AUDIT")"`,
    // Des secrets dans les lignes ajoutées par la PR (jamais affichés : seulement les fichiers).
    "SECRETS='(xox[abprs]-[0-9A-Za-z-]{10,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{24,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY-----)'",
    `echo "@@ SECRETS_TROUVES $(git diff ${B}...HEAD --unified=0 -- . ${VERROUS} | grep -E '^\\+' | grep -cE "$SECRETS")"`,
    `echo "@@ SECRETS_FICHIERS $(git diff ${B}...HEAD -G"$SECRETS" --name-only -- . ${VERROUS} | tr '\\n' ' ')"`,
    `bash -c ${q(profil.construire)} > /tmp/sorties/verif/build.log 2>&1 && echo '@@ BUILD_OK' || tail -20 /tmp/sorties/verif/build.log | ${NEUTRALISER}`,
    `bash -c ${q(profil.tester)} 2>&1 | tee /tmp/sorties/verif/tests.log | tail -8 | ${NEUTRALISER}; ${COMPTER_TESTS} /tmp/sorties/verif/tests.log`,
    env,
    "rm -rf $DATA_DIR",
    // Un serveur resté d'une vérification précédente (Codex peut relancer l'application hors du
    // groupe de processus) garderait le port : l'usine jugerait l'ancien code, d'un autre projet.
    LIBERER_PORT,
    // Le port de l'ancienne version, libéré par son numéro : un reste d'une vérification coupée par son délai.
    LIBERER_ANCIENNE,
    // Une refonte ou un incident : l'ancienne version est préparée d'abord (écarts 4 et 5).
    ...(nature ? preparerAncienne(B, profil) : []),
    "if curl -s -o /dev/null http://localhost:4100/; then echo '@@ PORT_OCCUPE'; fi",
    "touch /tmp/sorties/verif/avant-demarrage; sleep 1",
    `(setsid bash -c ${q(profil.demarrer)} > /tmp/sorties/verif/app.log 2>&1 &)`,
    "for i in $(seq 1 40); do if curl -sf http://localhost:4100/api/health > /dev/null; then echo '@@ APP_STARTED'; break; fi; sleep 2; done",
    // En ligne, le code est en lecture seule : l'application n'écrit que dans DATA_DIR.
    "sleep 2; echo \"@@ ECRIT_DANS_CODE $(find . -newer /tmp/sorties/verif/avant-demarrage -type f -not -path './node_modules/*' -not -path './.git/*' -not -path './.venv/*' -not -path '*/__pycache__/*' 2>/dev/null | head -5 | tr '\\n' ' ')\"",
    // L'ancienne version démarre à son tour ; une refonte lui est comparée tout de suite, données fraîches.
    "rm -f /tmp/sorties/verif/budgets.json /tmp/sorties/verif/refonte.txt; rm -rf /tmp/sorties/verif/refonte",
    ...(nature ? demarrerAncienne(profil) : []),
    ...(nature === "refonte" ? comparerRefonte(tache) : []),
    // Le cliquet : les tests des critères déjà validés (.usine/e2e, protégé) sont rejoués, dans un temps plafonné.
    ...rejouerCliquet({ minutes: plafond, prioritaires: Object.keys(sautesAvant) }),
    // Les captures, prises par l'usine (le modèle ne les prenait pas) : pour le relecteur design, Slack, la console et la vidéo.
    "rm -f /tmp/sorties/verif/captures/*.png",
    ecrireFichier("/tmp/sorties/verif/captures.cjs", CAPTURES_JS),
    `if curl -sf http://localhost:4100/api/health > /dev/null; then BASE=http://localhost:4100 PAGES=${q(JSON.stringify(pagesDeLaTache(tache)))} timeout 180 node /tmp/sorties/verif/captures.cjs; fi`,
    // Les budgets de l'interface (écart 6), mesurés par l'usine : console, accessibilité, chargement, WebKit.
    ecrireFichier("/tmp/sorties/verif/budgets.cjs", BUDGETS_JS),
    `if curl -sf http://localhost:4100/api/health > /dev/null; then BASE=http://localhost:4100 PAGES=${q(JSON.stringify(pagesDeLaTache(tache)))} timeout 240 node /tmp/sorties/verif/budgets.cjs; fi`,
    "if curl -sf http://localhost:4100/api/health > /dev/null; then",
    // Le relais du vérificateur : Codex, sinon le moteur suivant (réglable dans la console).
    "rm -f /tmp/sorties/verif/verdict.txt /tmp/sorties/verif/claude.json",
    scriptJuge(ctx, "verification", { texte: "/tmp/sorties/verif/verdict.txt", entree: "/tmp/sorties/verif/consigne.md", journal: "/tmp/sorties/verif/codex.log", sortieClaude: "/tmp/sorties/verif/claude.json", marqueur: "CODEX_CODE", connecteurs: "verification" }),
    // Le modèle réellement utilisé, lu dans la session Codex (pour le suivi des coûts).
    "  echo \"@@ CODEX_MODELE $(grep -ho '\"model\":\"[^\"]*\"' $(ls -t $(find ~/.codex/sessions -name '*.jsonl' 2>/dev/null) 2>/dev/null | head -1) 2>/dev/null | head -1 | cut -d'\"' -f4)\"",
    `else tail -30 /tmp/sorties/verif/app.log | ${NEUTRALISER}; fi`,
    "echo \"@@ CAPTURES $(ls /tmp/sorties/verif/captures/*.png 2>/dev/null | wc -l)\"",
    "echo \"@@ CAPTURES_FICHIERS $(cd /tmp/sorties/verif/captures 2>/dev/null && ls *.png 2>/dev/null | tr '\\n' ' ')\"",
    trierTestsEcrits({ ref: B }),
    // Un incident : ses tests relancés sur l'ancienne version (relancée d'abord si le juge l'a arrêtée).
    ...(nature === "incident" ? [...demarrerAncienne(profil), rejouerSurAncienne(tache.cle)] : []),
    ecrireFichier("/tmp/sorties/verif/consigne-design.md", consigneDesign(projet, tache)),
    "cat docs/DESIGN.md >> /tmp/sorties/verif/consigne-design.md 2>/dev/null || echo '(pas de brief : juger avec la grille seule)' >> /tmp/sorties/verif/consigne-design.md",
    "IMAGES=$(ls /tmp/sorties/verif/captures/*.png 2>/dev/null | head -6 | sed 's/^/--image=/' | tr '\\n' ' ')",
    // Les mêmes captures, par leur chemin : un juge sans option --image (Claude) les ouvre lui-même.
    "if [ -n \"$IMAGES\" ]; then printf '\\n\\nLes captures à juger (ouvre chacune) :\\n' >> /tmp/sorties/verif/consigne-design.md; ls /tmp/sorties/verif/captures/*.png | head -6 | sed 's/^/- /' >> /tmp/sorties/verif/consigne-design.md; fi",
    // Ce que le vérificateur a déjà testé et validé : le relecteur design ne le contredit pas sur la foi d'une capture.
    `node -e ${q(CRITERES_VALIDES)} < /tmp/sorties/verif/verdict.txt >> /tmp/sorties/verif/consigne-design.md 2>/dev/null || true`,
    "if [ -n \"$IMAGES\" ] && grep -q '\"approuve\"' /tmp/sorties/verif/verdict.txt 2>/dev/null; then",
    scriptJuge(ctx, "design", { texte: "/tmp/sorties/verif/design.txt", entree: "/tmp/sorties/verif/consigne-design.md", journal: "/tmp/sorties/verif/design.log", sortieClaude: "/tmp/sorties/verif/claude-design.json", images: "$IMAGES", marqueur: "DESIGN_CODE" }),
    "fi",
    LIBERER_PORT,
    ...(nature ? [LIBERER_ANCIENNE, "git worktree remove --force /travail/verif/base > /dev/null 2>&1 || true"] : []),
  ].join("\n"), { minutes })

  const m = r.marqueurs
  const vide = { verdict: null, design: null, tests: Number(m.TESTS_PASSES ?? 0), nouveauxTests: [], captures: [] }
  if ("PORT_OCCUPE" in m) return { ok: false, infra: true, raisons: ["le port 4100 du vérificateur est occupé par un ancien serveur impossible à arrêter"], ...vide }
  const juge = await bilanJuge(ctx, "verification", m, "CODEX_CODE")
  if (juge.epuise) return { ok: false, infra: true, limite: true, reprise: juge.reprise, raisons: [`${relais(ctx, "verification").map(nomMoteur).join(" et ")} à leur limite d'usage (toutes les façons essayées)`], ...vide }
  // Le relais a servi : on le dit (le juge habituel était indisponible).
  if (journal && juge.moteur && juge.moteur !== relais(ctx, "verification")[0]) noter(ctx.db, { projet: projet.id, tache: tache.id, type: "remarque", message: `${tache.cle} : ${nomMoteur(relais(ctx, "verification")[0])} indisponible, ${nomMoteur(juge.moteur)} a vérifié à sa place.` })
  // La consommation du juge, même quand il refuse ou échoue.
  if ("CODEX_CODE" in m) await enregistrerJuge(ctx, { serveur, jeton, projet, tache, role: "verificateur", moteur: juge.moteur, journal: "/tmp/sorties/verif/codex.log", sortieClaude: "/tmp/sorties/verif/claude.json", modeleCodex: m.CODEX_MODELE, duree_s: r.duree_s ?? 0 })
  // Une vérification coupée par son délai n'a pas tout jugé (le rejeu d'un incident, le design…) : sans motif
  // de refus par ailleurs, elle ne conclut pas (plus bas).
  const delaiDepasse = "DELAI_DEPASSE" in m
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
    const relecteur = await bilanJuge(ctx, "design", m, "DESIGN_CODE")
    await enregistrerJuge(ctx, { serveur, jeton, projet, tache, role: "designer", moteur: relecteur.moteur, journal: "/tmp/sorties/verif/design.log", sortieClaude: "/tmp/sorties/verif/claude-design.json", modeleCodex: m.CODEX_MODELE, duree_s: 0 })
    try {
      design = extraireJson(String((await lireFichier(serveur, jeton, "/tmp/sorties/verif/design.txt")) ?? ""))
    } catch {
      design = null // un relecteur design indisponible ne bloque pas la tâche
    }
  }
  const criteres = JSON.parse(tache.criteres || "[]")
  const raisons = porte({ marqueurs: m, verdict, design, plancher: projet.plancher_tests, journal: r.journal, criteres, autres })
  const dire = journal ? (message) => noter(ctx.db, { projet: projet.id, tache: tache.id, type: "remarque", message: `${tache.cle} : ${message}` }) : () => {}
  // Les budgets de l'interface (écart 6) : aucune page n'a de nouveau problème. La mesure est gardée pour la
  // tâche : ce qu'elle a vu rejoint les problèmes connus à sa fusion (fabrique.mjs), ou si une personne
  // accepte sa PR (escalade.mjs). Jamais avant.
  let budgets = null
  if ("BUDGETS_OK" in m) {
    try {
      budgets = JSON.parse(String((await lireFichier(serveur, jeton, "/tmp/sorties/verif/budgets.json")) ?? "null"))
    } catch {
      budgets = null
    }
  }
  if (budgets && "APP_STARTED" in m && verdict) raisons.push(...raisonsBudgets(budgets, lireConnus(ctx.db, projet.id), { max: chargementMax(config) }))
  if (budgets && journal && tache.id) gardeMesure(ctx.db, tache.id, budgets)
  if ("APP_STARTED" in m && verdict && !budgets) dire("budgets de l'interface : non mesurés cette fois (script arrêté ou en panne).")
  // L'ancienne version (écarts 4 et 5) : sans elle, ou sans sa mesure, une refonte ou un incident n'a pas de
  // corrigé. Ce n'est pas la faute de l'agent qui code : la vérification ne conclut pas, une personne tranche.
  const ancienneAbsente = Boolean(nature) && "APP_STARTED" in m && (!("BASE_CONSTRUITE" in m) || !("BASE_STARTED" in m) || "BASE_PORT_OCCUPE" in m)
  const mesureAbsente = Boolean(verdict) && !ancienneAbsente && ((nature === "refonte" && (!(Number(m.REFONTE_COMPAREES) > 0) || Number(m.REFONTE_IMPOSSIBLES ?? 0) > 0)) || (nature === "incident" && !("INCIDENT_TESTES" in m)))
  // Un vrai refus (tests, critères, budgets…) passe avant : l'agent recommence. Sinon, la vérification ne conclut pas.
  const inconclusive = raisons.length === 0 && (ancienneAbsente || mesureAbsente || delaiDepasse)
  const codexEnPanne = ("APP_STARTED" in m && !verdict && m.CODEX_CODE !== "0") || inconclusive
  // Ces raisons-là ne vont à l'agent que si rien d'autre ne refuse : elles ne sont pas de son fait.
  if (inconclusive && delaiDepasse) raisons.push(`la vérification a dépassé ${minutes} min avant la fin : elle ne peut pas conclure`)
  if (inconclusive && ancienneAbsente) raisons.push(`l'ancienne version (${brancheDeBase(projet)}) n'a pas démarré à côté de la nouvelle${"BASE_PORT_OCCUPE" in m ? " : le port 4101 du vérificateur reste pris par un autre serveur" : ""} : ${nature === "refonte" ? "la refonte n'a pas pu lui être comparée" : "les tests de l'incident n'ont pas pu y être rejoués"} (base.log et base-app.log du vérificateur)`)
  if (inconclusive && mesureAbsente) raisons.push(`${nature === "refonte" ? "la comparaison avec l'ancienne version n'a pas eu lieu, ou en partie seulement (une page ou une route que l'ancienne version n'a pas donnée)" : "le rejeu des tests d'incident sur l'ancienne version n'a pas eu lieu"} (délai ou panne du script) : la vérification ne peut pas conclure`)
  const nouveauxTests = nomsDeTests(m.E2E_NOUVEAUX)
  const { remplaces, ecartes: nePasVerser } = reecrituresAVerser({ verdict, marqueurs: m, criteres, autres })
  const ratés = nomsDeTests(m.E2E_ECRITS_KO)
  // Les tests sautés cette fois-ci, avec la tâche vérifiée pendant qu'ils l'étaient (seulement si le rejeu a tourné).
  if (journal && "E2E_TOTAL" in m) ecrireSautes(ctx.db, cleSautes, sautesAvant, nomsDeTests(m.E2E_SAUTES_NOMS), tache.id)
  // Rien ne se tait : plafond atteint, tests écrits qui échouent eux-mêmes, réécritures écartées, noms illisibles.
  const sautes = Number(m.E2E_SAUTES ?? 0)
  if (sautes > 0) dire(`${sautes} test(s) du cliquet non rejoué(s) faute de temps (plafond de ${plafond} min, ${Number(m.E2E_TOTAL ?? 0)} rejoué(s)) : ${nomsDeTests(m.E2E_SAUTES_NOMS).join(" ")}. Ils passeront en premier à la vérification suivante.`)
  if (ratés.length) dire(`${ratés.length} test(s) écrit(s) par le vérificateur échouent eux-mêmes sur l'application : ils ne rejoignent pas le cliquet (${ratés.join(" ")}).`)
  if (nePasVerser.length) dire(`réécriture(s) écartée(s) de test(s) du cliquet qui n'échouaient pas : ${nePasVerser.join(" ")}. Un test qui passe ne se réécrit pas.`)
  const illisibles = Number(m.E2E_NOMS_INVALIDES ?? 0) + Number(m.E2E_ECRITS_INVALIDES ?? 0)
  if (illisibles > 0) dire(`${illisibles} fichier(s) de .usine/e2e/ ou écrit(s) par le vérificateur ont un nom que l'usine ne lit pas (lettres sans accent, chiffres, point, tiret, souligné) : ils ne sont ni rejoués ni versés.`)
  // Écart 3 : un critère validé sans test est « non prouvé ». Dit, sans bloquer.
  const nonProuves = verdict ? criteresNonProuves({ verdict, criteres, cle: tache.cle, tests: [...nouveauxTests, ...remplaces.map((x) => x.test)] }) : []
  if (nonProuves.length) dire(`${nonProuves.length} critère(s) validé(s) sans test, donc non prouvé(s) : ${nonProuves.map((x) => `« ${x.critere.slice(0, 100)} »${x.raison ? ` (${x.raison.slice(0, 120)})` : " (sans raison donnée)"}`).join(" ; ")}`)
  if (budgets && !budgets.webkit) dire(`budgets de l'interface : WebKit indisponible dans le vérificateur (${String(budgets.webkit_erreur ?? "").slice(0, 120)}) : les pages n'ont pas été essayées dans le moteur de Safari.`)
  if (budgets && !budgets.axe) dire("budgets de l'interface : axe-core absent du vérificateur : l'accessibilité n'a pas été mesurée.")
  if (nature === "refonte" && "REFONTE_COMPAREES" in m) dire(`refonte comparée à l'ancienne version : ${Number(m.REFONTE_COMPAREES)} page(s) et route(s), ${Number(m.REFONTE_DIFFERENCES ?? 0)} différence(s)${Number(m.REFONTE_IMPOSSIBLES ?? 0) ? `, ${Number(m.REFONTE_IMPOSSIBLES)} impossible(s) à comparer (l'ancienne version ne les donnait pas)` : ""}.`)
  if (nature === "incident" && "INCIDENT_TESTES" in m) dire(`incident : ${nomsDeTests(m.INCIDENT_REPRODUIT).length} test(s) d'incident sur ${nomsDeTests(m.INCIDENT_TESTES).length} échoue(nt) sur l'ancienne version (${nomsDeTests(m.INCIDENT_REPRODUIT).join(" ") || "aucun"}).`)
  // Une refonte ou un incident dont tout le reste passe : une différence ni expliquée ni signalée, ou un incident
  // non reproduit, n'est pas une faute de l'agent qui code. Une personne regarde et tranche (contestation).
  const contestesNature = []
  if (raisons.length === 0 && verdict && nature === "refonte") {
    for (const id of differencesNonExpliquees({ marqueurs: m, verdict })) contestesNature.push({ critere: `Refonte : ${id} diffère de l'ancienne version`, raison: "le vérificateur ne l'a ni expliquée ni signalée comme un problème. Regarde les images avant, après et la différence (refonte.txt du vérificateur), puis décide." })
  }
  if (raisons.length === 0 && verdict && nature === "incident") {
    const pourquoi = incidentNonProuve({ marqueurs: m })
    if (pourquoi) contestesNature.push({ critere: "Incident : un test doit échouer sur l'ancienne version et passer sur la nouvelle", raison: pourquoi })
  }
  const contestes = [...criteresContestes(verdict), ...contestesCliquet({ verdict, marqueurs: m, criteres, autres }), ...contestesNature]
  return { ok: raisons.length === 0, infra: codexEnPanne, contestes, raisons, verdict, design, tests: Number(m.TESTS_PASSES ?? 0), nouveauxTests, remplaces, e2eSautes: sautes, nonProuves, mesureBudgets: budgets, budgets: budgets ? resumeBudgets(budgets) : "", captures: String(m.CAPTURES_FICHIERS ?? "").split(/\s+/).filter((f) => /^[\w.-]+\.png$/.test(f)) }
}

// La porte de fusion : des faits vérifiables, pas un avis. Chaque raison
// renvoyée est un motif de refus. Aucune raison = la tâche peut être fusionnée.
export function porte({ marqueurs: m, verdict, design = null, plancher = 0, journal = "", criteres = [], autres = {} }) {
  const raisons = []
  if (!("INSTALL_OK" in m)) return ["l'installation des dépendances échoue"]
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
  if (String(m.ECRIT_DANS_CODE ?? "").trim()) raisons.push(`au démarrage, l'application écrit dans son propre code (${m.ECRIT_DANS_CODE.trim()}) : en ligne, ce dossier est en lecture seule et l'application ne démarre pas. N'écris que dans DATA_DIR (ou sers le contenu dynamiquement, par une route).`)
  if (!verdict) {
    raisons.push("le vérificateur n'a pas rendu de verdict lisible")
    return raisons
  }
  // Un verdict mal formé (une chaîne au lieu d'une liste) ne fait pas planter la porte.
  const regressions = tableau(verdict.regressions)
  for (const c of tableau(verdict.criteres)) if (c?.ok !== true) raisons.push(`critère non validé : ${c?.critere}${c?.preuve ? ` (observé : ${c.preuve})` : ""}`)
  for (const p of tableau(verdict.problemes)) raisons.push(`problème : ${p}`)
  for (const g of regressions) raisons.push(`régression (un critère déjà validé ne tient plus) : ${g}`)
  // Le cliquet est un corrigé : un test qui échoue est une régression du codeur, sauf s'il est réécrit avec un
  // critère qui l'explique. Quand le vérificateur déclare une réécriture qui ne tient pas, c'est un désaccord de
  // juge, pas une faute du codeur : il part en contestation (contestesCliquet), une personne tranche.
  const echecsCliquet = nomsDeTests(m.E2E_ECHECS_NOMS)
  const remplaces = nomsDeTests(m.E2E_REMPLACES)
  const justifies = testsRemplacesJustifies(verdict, criteres, autres)
  const declares = new Set(tableau(verdict.tests_remplaces).map((e) => nomDuTest(e?.test)))
  const dejaDits = regressions.map(String).join("\n")
  for (const f of echecsCliquet) {
    if ((justifies.has(f) && remplaces.includes(f)) || declares.has(f) || dejaDits.includes(f)) continue
    raisons.push(`régression : le test ${f} du cliquet échoue, et aucun critère de cette tâche n'explique ce changement. Rétablis le comportement qu'il vérifie.`)
  }
  const nonNommes = Number(m.E2E_ECHECS ?? 0) - echecsCliquet.length
  if (nonNommes > 0) raisons.push(`${nonNommes} test(s) du cliquet échouent sans que l'usine sache lesquels : la vérification ne peut pas conclure.`)
  for (const d of tableau(design?.graves)) raisons.push(`design : ${d.ecran ? `${d.ecran} : ` : ""}${d.defaut}${d.correction ? ` → ${d.correction}` : ""}`)
  if (verdict.decision !== "approuve" && raisons.length === 0) raisons.push(`le vérificateur refuse : ${verdict.resume ?? "sans motif"}`)
  if (!tableau(verdict.criteres).length) raisons.push("le vérificateur n'a jugé aucun critère")
  return raisons
}
