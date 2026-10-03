// Assemble le socle d'un produit à partir d'une brique (dans l'atelier, à la création du dépôt).
//
//   node assembler.mjs <brique> <dossier> [jetons.css]
//
// Une brique est soit complète (webapp), soit une surcouche d'une autre (« base » dans
// son brique.json) : on copie la base, puis la surcouche par-dessus. Ensuite :
//   - « retirer » : les fichiers de la base dont la brique n'a pas besoin ;
//   - « scripts » : les scripts npm propres à la brique ;
//   - AGENTS.brique.md : ajouté à la fin de AGENTS.md ;
//   - {{NOM}} et {{RESUME}} (variables NOM et RESUME) : remplacés, échappés selon le fichier ;
//   - jetons.css : les couleurs et polices du brief, à la place de « /* JETONS */ ».
// Affiche les dépendances à installer : « @@ DEPENDANCES … » et « @@ DEV … ».
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, extname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ICI = dirname(fileURLToPath(import.meta.url))
const META = ["brique.json", "AGENTS.brique.md"]

export function lireBrique(nom, racine = ICI) {
  if (!/^[a-z0-9-]+$/.test(nom) || !existsSync(join(racine, nom, "brique.json"))) throw new Error(`Brique inconnue : ${nom}`)
  return JSON.parse(readFileSync(join(racine, nom, "brique.json"), "utf8"))
}

// Les briques disponibles, pour l'analyste : nom et description.
export function briques(racine = ICI) {
  return readdirSync(racine)
    .filter((d) => existsSync(join(racine, d, "brique.json")))
    .map((d) => {
      const b = lireBrique(d, racine)
      return { nom: b.nom, description: b.description }
    })
}

const echappements = {
  ".html": (v) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]),
  ".json": (v) => JSON.stringify(v).slice(1, -1),
  ".webmanifest": (v) => JSON.stringify(v).slice(1, -1),
  ".js": (v) => JSON.stringify(v).slice(1, -1),
  ".jsx": (v) => JSON.stringify(v).slice(1, -1),
  ".md": (v) => v,
}

function fichiers(dossier) {
  return readdirSync(dossier).flatMap((f) => {
    if (f === "node_modules" || f === ".git") return []
    const p = join(dossier, f)
    return statSync(p).isDirectory() ? fichiers(p) : [p]
  })
}

export function assembler(nom, cible, { racine = ICI, nomProduit = "", resume = "", jetons = null } = {}) {
  const brique = lireBrique(nom, racine)
  if (existsSync(cible)) throw new Error(`${cible} existe déjà`)
  if (brique.base) {
    const base = lireBrique(brique.base, racine)
    if (base.base) throw new Error("Une surcouche ne peut pas reposer sur une autre surcouche.")
    cpSync(join(racine, brique.base), cible, { recursive: true })
  }
  cpSync(join(racine, nom), cible, { recursive: true, force: true })
  for (const f of brique.retirer ?? []) {
    if (f.includes("..") || f.startsWith("/")) throw new Error(`Chemin refusé : ${f}`)
    rmSync(join(cible, f), { recursive: true, force: true })
  }
  if (brique.scripts) {
    const p = join(cible, "package.json")
    const pkg = JSON.parse(readFileSync(p, "utf8"))
    pkg.scripts = { ...pkg.scripts, ...brique.scripts }
    writeFileSync(p, `${JSON.stringify(pkg, null, 2)}\n`)
  }
  const ajout = join(cible, "AGENTS.brique.md")
  if (existsSync(ajout)) writeFileSync(join(cible, "AGENTS.md"), readFileSync(join(cible, "AGENTS.md"), "utf8").trimEnd() + "\n" + readFileSync(ajout, "utf8"))
  for (const m of META) rmSync(join(cible, m), { force: true })

  for (const f of fichiers(cible)) {
    const echapper = echappements[extname(f)]
    if (!echapper) continue
    const contenu = readFileSync(f, "utf8")
    if (!contenu.includes("{{NOM}}") && !contenu.includes("{{RESUME}}")) continue
    writeFileSync(f, contenu.replaceAll("{{NOM}}", echapper(nomProduit)).replaceAll("{{RESUME}}", echapper(resume)))
  }
  const styles = join(cible, "client", "src", "styles.css")
  if (jetons !== null && existsSync(styles)) writeFileSync(styles, readFileSync(styles, "utf8").replace("/* JETONS */", jetons))
  return { dependances: brique.dependances ?? [], dev: brique.dev ?? [] }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [nom, cible, fichierJetons] = process.argv.slice(2)
  const r = assembler(nom, cible, {
    nomProduit: process.env.NOM ?? "",
    resume: process.env.RESUME ?? "",
    jetons: fichierJetons && existsSync(fichierJetons) ? readFileSync(fichierJetons, "utf8") : null,
  })
  // Des noms de paquets npm seulement : ils partent dans une ligne de commande.
  const surs = (l) => l.filter((d) => /^(@[a-z0-9-]+\/)?[a-z0-9.-]+$/.test(d)).join(" ")
  console.log(`@@ DEPENDANCES ${surs(r.dependances)}`)
  console.log(`@@ DEV ${surs(r.dev)}`)
}
