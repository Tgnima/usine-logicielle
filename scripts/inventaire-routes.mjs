// L'inventaire des routes, pour l'agent auditeur-backend : pour chaque route, ses parties fixes et
// ses variables (chemin, requête, corps), et les appels de la console qui ne trouvent aucune route.
// Lecture seule : le code est lu comme du texte, jamais importé ni exécuté.
// Usage : node scripts/inventaire-routes.mjs [--json]
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const racine = join(dirname(fileURLToPath(import.meta.url)), "..")
const lire = (f) => readFileSync(join(racine, f), "utf8")

// Une variable du chemin est « contrainte » si son motif limite ce qu'elle accepte.
function natureVariable(motif) {
  if (/^\\d\+$/.test(motif)) return "nombre"
  if (/^[\w-]+(\|[\w-]+)+$/.test(motif)) return `liste fermée (${motif.split("|").join(", ")})`
  if (/^\[[^\]]+\]\+$/.test(motif)) return motif.includes("^") ? "libre" : `caractères limités ${motif}`
  return "libre"
}

// Les routes de la console : le tableau ROUTES de orchestrateur/src/console.mjs.
function routesConsole() {
  const fichier = "orchestrateur/src/console.mjs"
  const lignes = lire(fichier).split("\n")
  const debuts = []
  lignes.forEach((l, i) => {
    const m = l.match(/^\s*\["(GET|POST|PUT|PATCH|DELETE)", \/(.+?)\/, /)
    if (m) debuts.push({ i, methode: m[1], source: m[2] })
  })
  return debuts.map((d, n) => {
    // La dernière route s'arrête à la fermeture du tableau.
    const fin = n + 1 < debuts.length ? debuts[n + 1].i : lignes.findIndex((l, j) => j > d.i && /^\]/.test(l))
    const corpsHandler = lignes.slice(d.i, fin).join("\n")
    const variables = [...d.source.matchAll(/\(([^()]+)\)/g)].map((m) => ({ motif: m[1], nature: natureVariable(m[1]) }))
    const fixe = d.source.replace(/^\^|\$$/g, "").replace(/\\\//g, "/").replace(/\([^()]+\)/g, "{var}")
    // Les champs du corps : le troisième paramètre du handler (absent ou préfixé de « _ » : le corps n'est pas lu).
    const params = corpsHandler.match(/\/, (?:async )?\(([^)]*)\) =>/)?.[1].split(",").map((x) => x.trim())
    const lit = params?.[2] && !params[2].startsWith("_") ? params[2] : null
    const champs = (motif) => (lit ? [...new Set([...corpsHandler.matchAll(new RegExp(motif.replace("CORPS", lit), "g"))].map((m) => m[1]))] : [])
    const corps = champs("\\bCORPS\\.([a-z_]+)")
    const requete = [...new Set([...corpsHandler.matchAll(/searchParams\.get\("([\w-]+)"\)/g)].map((m) => m[1]))]
    // « brut » : le champ part tel quel, sans String(), Number(), ni comparaison sur place. À suivre dans la fonction appelée.
    const brutsTransmis = champs("(?<!String\\(|Number\\(|Boolean\\(|Array\\.isArray\\()\\bCORPS\\.([a-z_]+)\\b(?!\\s*\\?\\?|\\s*===|\\s*!==|\\s*\\?)")
    return {
      fichier, ligne: d.i + 1, methode: d.methode, chemin: fixe, regex: new RegExp(d.source),
      variables_chemin: variables, variables_requete: requete, variables_corps: corps,
      corps_transmis_sans_conversion: brutsTransmis,
      litteraux: litteraux(corpsHandler),
    }
  })
}

// Les valeurs fixes écrites en dur : adresses, ports, IP, durées et limites chiffrées.
function litteraux(texte) {
  const trouves = []
  for (const m of texte.matchAll(/["'`](https?:\/\/[^"'`\s]+)["'`]/g)) trouves.push(`adresse ${m[1]}`)
  for (const m of texte.matchAll(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g)) trouves.push(`IP ${m[1]}`)
  for (const m of texte.matchAll(/(?<![\w.$[]|\d )(\d[\d_]{2,})(?![\w\]])/g)) if (!/^(200|201|204|301|302|400|401|403|404|405|409|413|422|500|502|503)$/.test(m[1])) trouves.push(`nombre ${m[1]}`)
  return [...new Set(trouves)]
}

// Les routes écrites à la main dans les autres serveurs (comparaisons de chemin).
function routesManuelles() {
  const r = []
  for (const fichier of ["portier/server.mjs", "commun/serveur-travaux.mjs", "deployeur/server.mjs", "orchestrateur/src/index.mjs"]) {
    let texte
    try { texte = lire(fichier) } catch { continue }
    texte.split("\n").forEach((l, i) => {
      const methode = l.match(/req\.method === "(\w+)"/)?.[1] ?? null
      for (const m of l.matchAll(/pathname === "([^"]+)"/g)) r.push({ fichier, ligne: i + 1, methode, chemin: m[1], variables_chemin: [] })
      for (const m of l.matchAll(/\/\^(\\\/[^/]*?(?:\\\/[^/]*?)*)\$\/(?:\.exec|\s*\))/g)) {
        const source = m[1]
        r.push({ fichier, ligne: i + 1, methode, chemin: source.replace(/\\\//g, "/").replace(/\([^()]+\)/g, "{var}"), variables_chemin: [...source.matchAll(/\(([^()]+)\)/g)].map((x) => ({ motif: x[1], nature: natureVariable(x[1]) })) })
      }
      if (l.includes("url.pathname.split(\"/\")")) r.push({ fichier, ligne: i + 1, methode: "*", chemin: "découpage du chemin à la main", variables_chemin: [{ motif: "split('/')", nature: "libre : à vérifier dans le code qui suit" }] })
    })
  }
  return r
}

// Les appels de l'interface : api("MÉTHODE", "chemin" ou `chemin/${x}`).
function appelsConsole(routes) {
  const fichier = "orchestrateur/console/console.js"
  const essais = ["1", "ABC_DEF", "claude-code", "prolonger", "stop", "exemple.fr", "abc"]
  const appels = []
  lire(fichier).split("\n").forEach((l, i) => {
    // api("MÉTHODE", "chemin"), et charge("chemin", …) qui fait un GET.
    const vus = [...l.matchAll(/api\("(GET|POST|PUT|PATCH|DELETE)", (["`])(.+?)\2/g)].map((m) => [m[1], m[3]])
      .concat([...l.matchAll(/\bcharge\((["`])(.+?)\1/g)].map((m) => ["GET", m[2]]))
    for (const [methode, brut] of vus) {
      const morceaux = brut.split("?")[0].split(/\$\{[^}]+\}/)
      // Chaque variable essaie chaque valeur type, indépendamment des autres.
      let candidats = [morceaux[0]]
      for (const m of morceaux.slice(1)) candidats = candidats.flatMap((c) => essais.map((v) => c + v + m))
      const trouve = routes.find((r) => r.methode === methode && candidats.some((c) => r.regex.test(`/api/${c}`)))
      appels.push({ fichier, ligne: i + 1, methode, chemin: brut, route: trouve ? `${trouve.fichier}:${trouve.ligne}` : null })
    }
  })
  return appels
}

const routes = routesConsole()
const appels = appelsConsole(routes)
const sansRoute = appels.filter((a) => !a.route)
const nonAppelees = routes.filter((r) => !appels.some((a) => a.route === `${r.fichier}:${r.ligne}`))
const resultat = { routes_console: routes.map(({ regex, ...r }) => r), routes_manuelles: routesManuelles(), appels_sans_route: sansRoute, routes_jamais_appelees_par_la_console: nonAppelees.map((r) => `${r.methode} ${r.chemin} (${r.fichier}:${r.ligne})`) }

if (process.argv.includes("--json")) console.log(JSON.stringify(resultat, null, 2))
else {
  console.log(`# Routes de la console (${routes.length})\n`)
  for (const r of resultat.routes_console) {
    const v = [
      ...r.variables_chemin.map((x) => `chemin:${x.nature}`),
      ...r.variables_requete.map((x) => `requête:${x}`),
      ...r.variables_corps.map((x) => `corps:${x}${r.corps_transmis_sans_conversion.includes(x) ? "(brut)" : ""}`),
    ]
    console.log(`- ${r.methode} ${r.chemin}  [${r.fichier}:${r.ligne}]${v.length ? `\n    variables : ${v.join(", ")}` : "\n    variables : aucune"}${r.litteraux.length ? `\n    valeurs fixes : ${r.litteraux.join(", ")}` : ""}`)
  }
  console.log(`\n# Routes écrites à la main (${resultat.routes_manuelles.length})\n`)
  for (const r of resultat.routes_manuelles) console.log(`- ${r.methode ?? "?"} ${r.chemin}  [${r.fichier}:${r.ligne}]${r.variables_chemin.length ? `  variables : ${r.variables_chemin.map((x) => x.nature).join(", ")}` : ""}`)
  console.log(`\n# Appels de la console sans route côté serveur (${sansRoute.length})\n`)
  for (const a of sansRoute) console.log(`- ${a.methode} /api/${a.chemin}  [${a.fichier}:${a.ligne}]`)
  console.log(`\n# Routes jamais appelées par la console (${nonAppelees.length})\n`)
  for (const x of resultat.routes_jamais_appelees_par_la_console) console.log(`- ${x}`)
}
