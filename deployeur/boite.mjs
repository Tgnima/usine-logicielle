// La boîte : les clés posées dans la console, que l'orchestrateur dépose pour le déployeur.
// Un volume en mémoire vive (tmpfs, docker-compose.yml) : rien n'est écrit sur le disque, comme
// /run/usine-secrets. L'orchestrateur l'écrit, le déployeur ne fait que le lire ; l'atelier et le
// vérificateur (où tourne le code des agents) ne le montent pas.
//
//   /boite/deployeur.json   { version, le, cles: { NOM: "valeur" } }
//
// Trois cas par clé :
//   - absente de la boîte (ou boîte absente) : la valeur du serveur sert, comme avant ;
//   - présente et vide : l'envoi est coupé dans la console, rien ne part (même avec le serveur) ;
//   - présente : la valeur de la console sert.
// Seules les clés de CLES_BOITE sont lues ; tout le reste du fichier est ignoré.
import { readFileSync } from "node:fs"
import { join } from "node:path"

export const CLES_BOITE = ["SENTRY_DSN", "POSTHOG_TOKEN", "POSTHOG_HOTE"]

export function lireBoite(dossier = process.env.BOITE_DIR ?? "/boite") {
  let brut
  try {
    brut = JSON.parse(readFileSync(join(dossier, "deployeur.json"), "utf8"))
  } catch {
    return null
  }
  if (!brut || typeof brut !== "object" || !Number.isInteger(brut.version) || !brut.cles || typeof brut.cles !== "object") return null
  const cles = {}
  for (const nom of CLES_BOITE) {
    const v = brut.cles[nom]
    // Une valeur sur une seule ligne, bornée : elle finit dans un fichier d'environnement.
    if (typeof v === "string" && v.length <= 4000 && !/[\r\n\0]/.test(v)) cles[nom] = v
  }
  return { version: brut.version, le: typeof brut.le === "string" ? brut.le : null, cles }
}

// La valeur qui sert : celle de la boîte si la clé y est (même vide), sinon celle du serveur.
export const valeurBoite = (boite, nom, serveur) => (boite && Object.hasOwn(boite.cles, nom) ? boite.cles[nom] : serveur)
