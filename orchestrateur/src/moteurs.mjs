// Les moteurs des agents (Claude Code, Codex) et leurs limites d'usage.
//
// Chaque moteur peut tourner de trois façons, essayées dans cet ordre :
//   abonnement  l'abonnement (Claude Pro/Max, ChatGPT) : sans coût à l'usage, mais limité ;
//   cle         la clé API du fournisseur (ANTHROPIC_API_KEY, OPENAI_API_KEY), si elle est posée ;
//   passerelle  Vercel AI Gateway (AI_GATEWAY_API_KEY), qui sert les modèles de tous les fournisseurs.
//
// Quand une façon répond « limite atteinte », le script passe AUSSITÔT à la suivante pour le
// même travail, et l'usine retient jusqu'à quand cette façon est épuisée (heure de
// réinitialisation lue dans le message, sinon 30 min) : les travaux suivants ne la tentent
// plus d'ici là. Si toutes sont épuisées, la fabrication se met en pause, sans consommer de
// tentative, et reprend seule. Les coûts sont mesurés quelle que soit la façon.
//
// Un refus de facturation (crédit épuisé, paiement requis : 402) est traité comme une limite :
// la façon est écartée pendant une heure, puis retentée (le crédit a pu être ajouté), et
// l'usine le signale dans Slack. Sans cela, l'agent rendait un travail vide et la tentative
// était consommée.
const FACTURATION_PAUSE = 60 * 60_000
import { ecrireReglage, lireReglage } from "./couts.mjs"
import { q } from "./travaux.mjs"
import { ordreModes } from "./fournisseurs.mjs"
import { optionsClaude, optionsCodex } from "./connecteurs.mjs"

export const MODES = ["abonnement", "cle", "passerelle"]
export const PASSERELLE = "https://ai-gateway.vercel.sh"
const NOMS = { abonnement: "abonnement", cle: "clé API", passerelle: "passerelle" }
export const nomMode = (m) => NOMS[m] ?? m

const cleLimite = (moteur, mode) => `limite_${moteur}_${mode}`
const prefixe = (moteur) => (moteur === "codex" ? "CODEX_" : "CLAUDE_")
const cleFacturation = (moteur, mode) => `facturation_${moteur}_${mode}`

// L'heure de reprise annoncée (« resets 12:40pm (UTC) », « try again at 3pm », « in 2 hours »…).
export function heureDeReprise(texte, maintenant = new Date()) {
  const t = String(texte ?? "")
  const dans = /in (\d+) (minute|hour|heure)s?/i.exec(t)
  if (dans) return new Date(maintenant.getTime() + Number(dans[1]) * (/min/i.test(dans[2]) ? 60_000 : 3_600_000) + 2 * 60_000)
  const m = /(?:resets?|again|réinitialis\w*)(?: at| à)? (\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(?UTC\)?/i.exec(t)
  if (!m) return new Date(maintenant.getTime() + 30 * 60_000)
  let h = Number(m[1]) % 12
  if (m[3]?.toLowerCase() === "pm") h += 12
  if (!m[3] && Number(m[1]) === 12) h = 12
  if (!m[3] && Number(m[1]) > 12) h = Number(m[1])
  const d = new Date(Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth(), maintenant.getUTCDate(), h, Number(m[2] ?? 0)))
  if (d <= maintenant) d.setUTCDate(d.getUTCDate() + 1)
  return new Date(d.getTime() + 2 * 60_000)
}

// Les façons encore utilisables pour un moteur (dans l'ordre du contrat).
// L'ordre vient de la console (Réglages, fournisseurs d'IA), sinon du contrat (secours.ordre).
export function modesDisponibles(ctx, moteur) {
  const ordre = ordreModes(ctx, moteur)
  return ordre.filter((m) => {
    const jusqua = lireReglage(ctx.db, cleLimite(moteur, m), "")
    return !jusqua || new Date(jusqua) <= new Date()
  })
}

// Les limites en cours, pour la santé et la console.
export function limitesEnCours(db) {
  const maintenant = new Date()
  return db.prepare("SELECT cle, valeur FROM reglages WHERE cle LIKE 'limite_%'").all()
    .map((r) => ({ moteur: r.cle.split("_")[1], mode: r.cle.split("_").slice(2).join("_"), jusqua: r.valeur }))
    .filter((l) => new Date(l.jusqua) > maintenant)
}

// Les refus de facturation en cours : [{ moteur, mode, message, jusqua }].
export function facturationsEnCours(db) {
  const maintenant = new Date()
  return db.prepare("SELECT cle, valeur FROM reglages WHERE cle LIKE 'facturation_%'").all()
    .map((r) => {
      try {
        return { moteur: r.cle.split("_")[1], mode: r.cle.split("_").slice(2).join("_"), ...JSON.parse(r.valeur) }
      } catch {
        return null
      }
    })
    .filter((f) => f && new Date(f.jusqua) > maintenant)
}

// Après un travail : les façons épuisées (marqueurs @@ LIMITE_<MODE> … et @@ FACTURATION_<MODE> …)
// sont retenues. Renvoie { mode : la façon qui a servi, epuise : toutes étaient épuisées,
// reprise : la plus proche, facturation : les refus de facturation APPARUS à ce travail }.
export function noterLimites(ctx, moteur, marqueurs = {}) {
  const facturation = []
  const enCours = new Set(facturationsEnCours(ctx.db).filter((f) => f.moteur === moteur).map((f) => f.mode))
  // Dans un relais, les marqueurs portent le nom du moteur (LIMITE_CODEX_PASSERELLE) : deux
  // moteurs essayés dans le même travail ne se mélangent pas.
  const p = prefixe(moteur)
  for (const mode of MODES) {
    const M = mode.toUpperCase()
    const texte = marqueurs[`LIMITE_${p}${M}`] ?? marqueurs[`LIMITE_${M}`]
    if (texte !== undefined) ecrireReglage(ctx.db, cleLimite(moteur, mode), heureDeReprise(texte).toISOString())
    const refus = marqueurs[`FACTURATION_${p}${M}`] ?? marqueurs[`FACTURATION_${M}`]
    if (refus !== undefined) {
      const jusqua = new Date(Date.now() + FACTURATION_PAUSE).toISOString()
      ecrireReglage(ctx.db, cleLimite(moteur, mode), jusqua)
      ecrireReglage(ctx.db, cleFacturation(moteur, mode), JSON.stringify({ message: refus.slice(0, 300), jusqua }))
      if (!enCours.has(mode)) facturation.push({ mode, message: refus.slice(0, 300) })
    }
  }
  const mode = marqueurs[`MODE_${moteur === "codex" ? "CODEX" : "CLAUDE"}`] ?? null
  // Une façon qui a de nouveau servi a retrouvé son crédit.
  if (mode) ctx.db.prepare("DELETE FROM reglages WHERE cle = ?").run(cleFacturation(moteur, mode))
  const epuise = `EPUISE_${moteur === "codex" ? "CODEX" : "CLAUDE"}` in marqueurs
  const reprises = MODES.map((m) => lireReglage(ctx.db, cleLimite(moteur, m), "")).filter(Boolean).map((x) => new Date(x)).filter((d) => d > new Date())
  return { mode, epuise, reprise: reprises.length ? new Date(Math.min(...reprises)) : null, facturation }
}

// Le signal dans Slack d'un refus de facturation, une fois par façon (pas à chaque travail).
export async function signalerFacturation(ctx, moteur, acces) {
  for (const f of acces.facturation ?? []) {
    const qui = moteur === "codex" ? "Codex (vérificateur)" : "Claude (agents)"
    const ou = { passerelle: "le compte Vercel AI Gateway", cle: moteur === "codex" ? "le compte OpenAI de la clé API" : "le compte Anthropic de la clé API", abonnement: "l'abonnement" }[f.mode]
    const suite = acces.epuise
      ? "Aucune autre façon n'est disponible : la fabrication se met en pause, sans consommer de tentative, et reprend seule."
      : "L'usine passe à la façon suivante, sans consommer de tentative."
    await ctx.notifier?.alerte?.(`:credit_card: *${qui} : la ${nomMode(f.mode)} refuse les appels, faute de crédit.* ${suite} Ajoute du crédit sur ${ou} : l'usine la retente toute seule dans une heure.\n> ${f.message}`)?.catch?.(() => {})
  }
}

// Le nom du modèle pour Claude Code via la passerelle : le même nom qu'avec l'abonnement
// (vérifié sur Vercel AI Gateway ; Claude Code refuse « anthropic/… »). Surchargeable.
export const modelePasserelle = (config, modele) => config.secours?.modeles_passerelle?.[modele] ?? modele.replace(/^anthropic\//, "")

// Les refus de facturation, tels que les renvoient Anthropic, la passerelle et OpenAI
// (« API Error: 402 A positive credit balance is required… », « insufficient_quota »…).
const FACTURATION_CLAUDE = `"api_error_status":402|API Error: 402|credit balance|insufficient (credit|funds|balance)|out of credits|payment required|billing`
const FACTURATION_CODEX = `[^0-9]402[^0-9]|insufficient_quota|credit balance|insufficient (credit|funds|balance)|payment required|billing`

// Ce qu'il faut pour qu'une façon soit tentée (une façon non configurée est sautée, sans alerte).
const PREALABLE = { abonnement: "true", cle: null, passerelle: '[ -n "$AI_GATEWAY_API_KEY" ]' }

// Le morceau de script bash qui lance Claude Code en essayant chaque façon disponible.
//   args : les options de claude (sans le modèle) ; sortie : le fichier de résultat (json ou stream-json) ;
//   entree : le fichier de la consigne, lu sur l'entrée standard. Jamais en argument : Linux refuse
//   un argument de plus de 128 Ko (« Argument list too long »), ce qu'atteint un gros projet.
//   role : plan, construction ou verification ; les connecteurs actifs de ce rôle sont ajoutés.
export function scriptClaude(ctx, options) {
  const { prelude, essais } = essaisClaude(ctx, options)
  return [
    ...(prelude ? [prelude] : []),
    "FAIT=",
    ...essais,
    `[ -n "$FAIT" ] || echo "@@ EPUISE_CLAUDE"`,
    `echo "@@ AGENT_CODE \${CODE:-1}"`,
  ].join("\n")
}

// Les essais de Claude Code, un bloc par façon disponible, gardés par $FAIT (le premier qui
// répond l'emporte). p : le préfixe des marqueurs de limite ("" seul, "CLAUDE_" dans un relais).
function essaisClaude(ctx, { args: options, modele, sortie, erreurs = "/dev/null", entree = "/dev/null", role = null, p = "" }) {
  const mcp = optionsClaude(ctx, role)
  const args = mcp.args ? `${options} ${mcp.args}` : options
  const modes = modesDisponibles(ctx, "claude-code")
  const essais = modes.map((mode) => {
    // L'abonnement Claude n'existe dans l'atelier que par son jeton (console ou serveur).
    const prealable = { ...PREALABLE, abonnement: '[ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]', cle: '[ -n "$ANTHROPIC_API_KEY" ]' }[mode]
    const lancer = {
      abonnement: `env -u ANTHROPIC_API_KEY -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN claude ${args} --model ${q(modele)}`,
      cle: `env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN claude ${args} --model ${q(modele)}`,
      passerelle: `env -u CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY= ANTHROPIC_BASE_URL=${PASSERELLE} ANTHROPIC_AUTH_TOKEN="$AI_GATEWAY_API_KEY" claude ${args} --model ${q(modelePasserelle(ctx.config, modele))}`,
    }[mode]
    return `if [ -z "$FAIT" ] && ${prealable}; then
  : > ${q(sortie)}
  # < fichier : le script arrive par l'entrée standard de bash ; sans cela, Claude la lirait
  # et avalerait toutes les lignes qui suivent (elles ne s'exécuteraient jamais).
  if ${lancer} < ${q(entree)} > ${q(sortie)} 2> ${q(erreurs)}; then CODE=0; else CODE=$?; fi
  # Seul le résultat final compte (le travail de l'agent peut parler de « rate limit »).
  R=$(grep '"type":"result"' ${q(sortie)} 2>/dev/null | tail -1)
  if echo "$R" | grep -q '"is_error":true' && echo "$R" | grep -qiE '${FACTURATION_CLAUDE}'; then echo "@@ FACTURATION_${p}${mode.toUpperCase()} $(echo "$R" | grep -oE '"result":"[^"]{0,200}' | cut -c11-)"
  elif echo "$R" | grep -q '"is_error":true' && echo "$R" | grep -qiE '"api_error_status":429|(session|usage|rate) limit|limite d.usage'; then echo "@@ LIMITE_${p}${mode.toUpperCase()} $(echo "$R" | grep -oiE 'resets? [^"\\\\]{0,30}|try again [^"\\\\]{0,30}' | head -1)"
  elif [ -s ${q(sortie)} ]; then FAIT=1; echo "@@ MODE_CLAUDE ${mode}"; fi
fi`
  })
  return { prelude: mcp.script ?? "", essais }
}

// La même chose pour Codex (le vérificateur et le relecteur design).
//   args : les options après « codex exec » (« - » : la consigne est lue dans entree, comme pour Claude).
//   journal : le fichier où va la sortie --json.
export function scriptCodex(ctx, options) {
  const { marqueur = "CODEX_CODE" } = options
  return ["FAIT=", ...essaisCodex(ctx, options), `[ -n "$FAIT" ] || echo "@@ EPUISE_CODEX"`, `echo "@@ ${marqueur} \${CODE:-1}"`].join("\n")
}

function essaisCodex(ctx, { args: options, journal, entree = "/dev/null", role = null, p = "" }) {
  // Les options -c des connecteurs vont avant celles du travail (dont « - », la consigne).
  const mcp = optionsCodex(ctx, role)
  const args = mcp ? `${mcp} ${options}` : options
  const modes = modesDisponibles(ctx, "codex")
  return modes.map((mode) => {
    const prealable = { ...PREALABLE, cle: '[ -n "$OPENAI_API_KEY" ]' }[mode]
    const lancer = {
      abonnement: `env -u OPENAI_API_KEY codex exec ${args}`,
      cle: `codex exec -c preferred_auth_method='"apikey"' ${args}`,
      passerelle: `codex exec -c model_provider='"passerelle"' -c model_providers.passerelle.name='"Passerelle"' -c model_providers.passerelle.base_url='"${PASSERELLE}/v1"' -c model_providers.passerelle.env_key='"AI_GATEWAY_API_KEY"' -c model_providers.passerelle.wire_api='"responses"' -c model='"${ctx.config.secours?.modele_codex_passerelle ?? "openai/gpt-5.5"}"' ${args}`,
    }[mode]
    return `if [ -z "$FAIT" ] && ${prealable}; then
  : > ${q(journal)}
  if ${lancer} < ${q(entree)} > ${q(journal)} 2>&1; then CODE=0; else CODE=$?; fi
  # Seules les erreurs du moteur comptent (le vérificateur peut tester une limite de requêtes).
  E=$(grep -E '"type":"(error|turn.failed)"' ${q(journal)} 2>/dev/null | tail -3)
  if [ -n "$E" ] && echo "$E" | grep -qiE '${FACTURATION_CODEX}'; then echo "@@ FACTURATION_${p}${mode.toUpperCase()} $(echo "$E" | grep -oE '"message":"[^"]{0,200}' | head -1 | cut -c12-)"
  elif [ -n "$E" ] && echo "$E" | grep -qiE '(usage|rate) limit|429|quota'; then echo "@@ LIMITE_${p}${mode.toUpperCase()} $(echo "$E" | grep -oiE '(try again|resets?) [^"\\\\]{0,30}' | head -1)"
  elif [ -s ${q(journal)} ]; then FAIT=1; echo "@@ MODE_CODEX ${mode}"; fi
fi`
  })
}

// --- Le relais entre moteurs --------------------------------------------------------------
// Chaque rôle a sa liste de moteurs, dans l'ordre. Quand toutes les façons d'un moteur sont
// épuisées (limite d'usage, crédit), le MÊME travail passe aussitôt au moteur suivant, sans
// consommer de tentative. La pause n'arrive que si tous les moteurs du rôle sont épuisés.
// L'ordre se règle dans la console (Réglages, fournisseurs d'IA), sinon dans le contrat (relais).
// Par défaut, Codex juge d'abord : une autre famille de modèles que l'atelier, plus indépendante.
export const ROLES_RELAIS = { verification: "Vérificateur", design: "Relecteur design", recette: "Recette du persona" }
export const MOTEURS_RELAIS = ["codex", "claude-code"]
const RELAIS_DEFAUT = { verification: ["codex", "claude-code"], design: ["codex", "claude-code"], recette: ["codex", "claude-code"] }

export function relais(ctx, role) {
  const valide = (o) => (Array.isArray(o) ? [...new Set(o.map(String))].filter((m) => MOTEURS_RELAIS.includes(m)) : [])
  let o = []
  try {
    o = valide(JSON.parse(lireReglage(ctx.db, `relais_${role}`, "null")))
  } catch {}
  if (!o.length) o = valide(ctx.config.relais?.[role])
  return o.length ? o : RELAIS_DEFAUT[role] ?? ["claude-code"]
}

// Le modèle de Claude quand il juge à la place de Codex : le renfort (le plus exigeant).
export const modeleJuge = (config) => config.modeles?.renfort?.modele ?? config.modeles?.atelier?.modele ?? "claude-opus-5-5"

// Le script d'un travail de jugement (vérification, design, recette) confié au relais du rôle.
//   texte : le fichier où le moteur qui a servi laisse son dernier message (le verdict, en JSON) ;
//   entree : la consigne ; images : pour Codex, des options --image=… (variable bash permise) ;
//   dossier : où ranger les journaux (codex.log, claude.json) ; marqueur : le code de sortie.
// Marqueurs : @@ <marqueur> code, @@ <marqueur>_MOTEUR codex|claude-code, @@ <marqueur>_EPUISE.
export function scriptJuge(ctx, role, { texte, entree, journal, sortieClaude, images = "", marqueur, connecteurs = null }) {
  const blocs = []
  for (const moteur of relais(ctx, role)) {
    if (moteur === "codex") {
      blocs.push(...essaisCodex(ctx, { args: `--json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox ${images} --output-last-message ${q(texte)} -`, journal, entree, role: connecteurs, p: "CODEX_" }))
      blocs.push(`if [ -n "$FAIT" ] && [ -z "$MOTEUR" ]; then MOTEUR=codex; fi`)
    } else {
      // Claude ouvre lui-même les captures (outil Read) : leurs chemins sont dans la consigne.
      const { prelude, essais } = essaisClaude(ctx, { args: "-p --output-format json --dangerously-skip-permissions --max-turns 80", modele: modeleJuge(ctx.config), sortie: sortieClaude, entree, role: connecteurs, p: "CLAUDE_" })
      if (prelude) blocs.push(`if [ -z "$FAIT" ]; then\n${prelude}\nfi`)
      blocs.push(...essais)
      // Son dernier message va au même endroit que celui de Codex : la suite ne voit pas la différence.
      blocs.push(`if [ -n "$FAIT" ] && [ -z "$MOTEUR" ]; then MOTEUR=claude-code; node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).result??""))}catch{}' < ${q(sortieClaude)} > ${q(texte)}; fi`)
    }
  }
  return [
    "FAIT=; MOTEUR=",
    ...blocs,
    `if [ -n "$MOTEUR" ]; then echo "@@ ${marqueur}_MOTEUR $MOTEUR"; else echo "@@ ${marqueur}_EPUISE"; fi`,
    `echo "@@ ${marqueur} \${CODE:-1}"`,
  ].join("\n")
}

// Après un travail de jugement : les limites de chaque moteur du relais sont notées, les refus de
// facturation signalés. Renvoie { moteur : celui qui a servi (ou null), epuise, reprise }.
export async function bilanJuge(ctx, role, marqueurs, marqueur) {
  let reprise = null
  for (const moteur of relais(ctx, role)) {
    const acces = noterLimites(ctx, moteur, marqueurs)
    await signalerFacturation(ctx, moteur, { ...acces, epuise: `${marqueur}_EPUISE` in marqueurs })
    if (acces.reprise && (!reprise || acces.reprise < reprise)) reprise = acces.reprise
  }
  const moteur = marqueurs[`${marqueur}_MOTEUR`] ?? null
  return { moteur, epuise: `${marqueur}_EPUISE` in marqueurs, reprise }
}

export const nomMoteur = (m) => (m === "codex" ? "Codex" : "Claude")
