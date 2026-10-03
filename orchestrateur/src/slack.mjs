// Slack : la seule interface humaine de l'usine. `/usine <demande>` lance un
// projet ; tout le reste se passe dans le fil de la demande (plan, aperçus,
// escalades, rapport final), avec des boutons pour les deux portes humaines
// et pour les décisions. Sans jetons Slack, un notificateur console prend le relais.
import { App } from "@slack/bolt"
import { obtenir } from "./db.mjs"
import * as actions from "./pipeline.mjs"
import { resoudre } from "./escalade.mjs"
import { aiguiller } from "./aiguillage.mjs"
import { choixProduction, demanderCorrections, mettreEnProduction } from "./livraison.mjs"
import { adresses } from "./config.mjs"

const tronquer = (t, n = 2900) => (t.length > n ? `${t.slice(0, n - 1)}…` : t)
const section = (texte) => ({ type: "section", text: { type: "mrkdwn", text: tronquer(texte) } })
const bouton = (texte, action_id, value, style) => ({ type: "button", text: { type: "plain_text", text: texte }, action_id, value: String(value), ...(style ? { style } : {}) })
const STATUTS = {
  analyse: ":brain: analyse", questions: ":question: questions", plan_a_valider: ":clipboard: plan à valider", creation: ":building_construction: création",
  fabrication: ":hammer_and_wrench: fabrication", bloque: ":octagonal_sign: bloqué", livre: ":package: livré", corrections: ":memo: corrections",
  mise_en_production: ":rocket: mise en production", abandonne: ":wastebasket: abandonné", en_production: ":large_green_circle: en production", echec: ":x: échec", arrete: ":black_square_for_stop: arrêté",
}

// --- Le notificateur console (sans Slack) ------------------------------------
export function notificateurConsole() {
  const dire = (projet, texte) => console.log(`\n[${projet?.nom ?? `projet ${projet?.id}`}] ${texte}\n`)
  return {
    etape: async (projet, texte) => dire(projet, texte),
    questions: async (projet, questions) => dire(projet, `Questions de l'analyste :\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n→ node src/cli.mjs repondre ${projet.id} "…"`),
    plan: async (projet, plan) => dire(projet, `Plan à valider : ${plan.nom} (${plan.lots.length} lots, ${plan.lots.reduce((n, l) => n + l.taches.length, 0)} tâches)\n→ node src/cli.mjs plan ${projet.id} · valider ${projet.id} · corriger ${projet.id} "…"`),
    escalade: async (projet, e) => dire(projet, `ESCALADE ${e.id} : ${e.sujet} — ${e.raison}\n${e.options.map((o) => `${o.cle} · ${o.libelle}`).join("  ")}\n→ node src/cli.mjs decider ${e.id} A "consigne"   (ou ${e.issue})`),
    escaladeResolue: async (projet, _e, texte) => dire(projet, texte),
    rapportFinal: async (projet, r) => dire(projet, `LIVRÉ : ${r.apercu} · ${r.tests} tests · ${r.refus} refus · ${r.escalades} escalade(s)\n→ node src/cli.mjs production ${projet.id}  ou  corriger ${projet.id} "…"`),
  }
}

// --- Slack -------------------------------------------------------------------
export async function demarrerSlack(ctx) {
  const { config, db } = ctx
  const app = new App({ token: config.secrets.slackBot, appToken: config.secrets.slackApp, socketMode: true })
  const estAdmin = (user) => config.slack.admins.length === 0 || config.slack.admins.includes(user)
  const refus = ":lock: Seuls les administrateurs de l'usine peuvent faire cela (ADMIN_USER_IDS)."

  // Poste dans le fil du projet (le premier message devient le fil).
  async function poster(projet, contenu) {
    const canal = projet.canal || config.slack.canal
    if (!canal) return console.log(`[sans canal] ${contenu.text}`)
    const r = await app.client.chat.postMessage({ channel: canal, ...(projet.fil ? { thread_ts: projet.fil } : {}), unfurl_links: false, ...contenu })
    if (!projet.fil) {
      db.prepare("UPDATE projets SET fil = ?, canal = ? WHERE id = ?").run(r.ts, r.channel, projet.id)
      Object.assign(projet, { fil: r.ts, canal: r.channel })
    }
    return r.ts
  }

  const notifier = {
    // boutons (facultatif) : [{ texte, action, valeur }]
    etape: (projet, texte, boutons) => poster(projet, boutons?.length ? { text: texte, blocks: [section(texte), { type: "actions", elements: boutons.map((b) => bouton(b.texte, b.action, b.valeur)) }] } : { text: texte }),
    questions: (projet, questions) => poster(projet, {
      text: "L'analyste a besoin de précisions",
      blocks: [section(`:question: *L'analyste a besoin de précisions avant de planifier :*\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`), { type: "actions", elements: [bouton("Répondre", "questions_repondre", projet.id, "primary")] }],
    }),
    plan: (projet, plan) => {
      const nb = plan.lots.reduce((n, l) => n + l.taches.length, 0)
      const blocs = [
        { type: "header", text: { type: "plain_text", text: tronquer(`Plan : ${plan.nom}`, 150) } },
        section(`${plan.resume}\n_${plan.lots.length} lots, ${nb} tâches. Chaque tâche est codée par un agent, testée par un vérificateur indépendant sur l'application en marche, et fusionnée seulement si tous ses critères passent._`),
        ...plan.lots.slice(0, 8).map((l, i) => section(`*Lot ${i + 1} : ${l.nom}*\n_${l.objectif}_\n${l.taches.map((t) => `• *${t.cle}* ${t.titre}\n${t.criteres.map((c) => `      ◦ ${c}`).join("\n")}`).join("\n")}`)),
        ...(plan.hors_perimetre?.length ? [{ type: "context", elements: [{ type: "mrkdwn", text: tronquer(`*Hors périmètre :* ${plan.hors_perimetre.join(" · ")}`) }] }] : []),
        ...(plan.risques?.length ? [{ type: "context", elements: [{ type: "mrkdwn", text: tronquer(`*Risques :* ${plan.risques.join(" · ")}`) }] }] : []),
        { type: "actions", elements: [bouton("Valider et fabriquer", "plan_valider", projet.id, "primary"), bouton("Corriger le plan", "plan_corriger", projet.id), bouton("Abandonner", "plan_abandonner", projet.id, "danger")] },
      ]
      return poster(projet, { text: `Plan à valider : ${plan.nom}`, blocks: blocs })
    },
    escalade: (projet, e) => poster(projet, {
      text: `Décision requise : ${e.sujet}`,
      blocks: [
        section(`:rotating_light: *Décision requise : ${e.sujet}*\n${e.raison}.${e.issue ? `\n<${e.issue}|Issue GitHub assignée>` : ""}`),
        section(`\`\`\`${tronquer(e.details, 1800)}\`\`\``),
        section(e.options.map((o) => `*${o.cle}* · ${o.libelle} : ${o.detail}`).join("\n")),
        { type: "actions", elements: [...e.options.map((o) => bouton(`${o.cle} · ${o.libelle}`, `esc_${o.cle}`, `${e.id}:${o.cle}`, o.cle === "A" ? "primary" : o.cle === "C" ? "danger" : undefined)), ...(e.options.some((o) => o.cle === "A") ? [bouton("A avec une consigne…", "esc_consigne", e.id)] : [])] },
      ],
    }),
    escaladeResolue: async (projet, esc, texte) => {
      const canal = projet.canal || config.slack.canal
      if (esc.message_ts && canal) await app.client.chat.update({ channel: canal, ts: esc.message_ts, text: texte, blocks: [section(texte)] }).catch(() => {})
      else await poster(projet, { text: texte })
    },
    rapportFinal: (projet, r) => poster(projet, {
      text: `${r.nom} est livré`,
      blocks: [
        { type: "header", text: { type: "plain_text", text: tronquer(`Livré : ${r.nom}`, 150) } },
        section(`${r.resume}\n\n:globe_with_meridians: *Essayer :* ${r.apercu}${r.mails ? `\n:email: *Emails envoyés (capturés) :* ${r.mails}` : ""}\n:octocat: *Code :* <${r.depot}|${r.depot.replace("https://github.com/", "")}> (${r.sha.slice(0, 7)})`),
        section(r.lots.map((l, i) => `*Lot ${i + 1} : ${l.nom}*\n${l.taches.map((t) => `${t.statut === "fusionnee" ? ":white_check_mark:" : ":heavy_minus_sign:"} ${t.cle} ${t.titre}${t.pr ? ` <${r.depot}/pull/${t.pr}|#${t.pr}>` : ""}${t.statut === "abandonnee" ? " _(abandonnée)_" : ""}`).join("\n")}`).join("\n")),
        { type: "context", elements: [{ type: "mrkdwn", text: `${r.tests} tests automatisés · ${r.refus} refus du vérificateur corrigés en autonomie · ${r.escalades} escalade(s) · ${r.decisions} décision(s) humaine(s)${r.duree_min ? ` · ${Math.floor(r.duree_min / 60)} h ${r.duree_min % 60} min de fabrication` : ""}` }] },
        { type: "actions", elements: [bouton("Valider : mettre en production", "livraison_valider", projet.id, "primary"), bouton("Corriger", "livraison_corriger", projet.id)] },
      ],
    }),
  }
  ctx.notifier = notifier

  const modale = (callback_id, projetId, titre, label, placeholder, bloc = "texte") => ({
    type: "modal", callback_id, private_metadata: String(projetId),
    title: { type: "plain_text", text: titre }, submit: { type: "plain_text", text: "Envoyer" }, close: { type: "plain_text", text: "Annuler" },
    blocks: [{ type: "input", block_id: bloc, label: { type: "plain_text", text: label }, element: { type: "plain_text_input", action_id: "v", multiline: true, placeholder: { type: "plain_text", text: placeholder } } }],
  })
  const lire = (view, bloc = "texte") => view.state.values[bloc].v.value?.trim() ?? ""

  // /usine <demande> | statut | stop | reprendre | relancer <id> | production <id>
  app.command("/usine", async ({ command, ack, respond }) => {
    await ack()
    const texte = command.text.trim()
    const [mot, arg] = texte.split(/\s+/)
    const repondre = (t) => respond({ response_type: "ephemeral", text: t })
    if (!texte || mot === "aide") {
      return repondre("*Usine logicielle*\n`/usine <ce que tu veux construire>` : du prompt au produit en ligne.\n`/usine corriger <n°> <ce qui ne va pas>` : l'usine enquête sur un produit livré et le corrige.\n`/usine statut` · `/usine stop` · `/usine reprendre` · `/usine relancer <n°>` · `/usine production <n°>` (ouvre les réglages de production)")
    }
    if (mot === "statut") {
      const lignes = actions.statut(ctx).map((p) => `*${p.id}. ${p.nom}* · ${STATUTS[p.statut] ?? p.statut} · ${p.fusionnees}/${p.taches} tâches${p.en_cours ? ` · en cours : ${p.en_cours}` : ""}${p.escalades.length ? ` · :rotating_light: ${p.escalades.length} décision(s) attendue(s)` : ""}${p.apercu && p.lot_livre ? ` · ${p.apercu}` : ""}`)
      return repondre(lignes.join("\n") || "Aucun projet pour l'instant.")
    }
    if (!estAdmin(command.user_id)) return repondre(refus)
    if (mot === "stop") return repondre(actions.arreter(ctx, command.user_name).message)
    if (mot === "reprendre") return repondre(actions.reprendre(ctx).message)
    if (mot === "relancer" && /^\d+$/.test(arg ?? "")) {
      actions.lancerAnalyse(ctx, Number(arg)).catch((e) => console.error(e))
      return repondre("Analyse relancée.")
    }
    if (mot === "production" && /^\d+$/.test(arg ?? "")) {
      const p = obtenir(db, "projets", Number(arg))
      if (!["livre", "en_production"].includes(p?.statut)) return repondre(p ? `Le projet ${arg} est « ${p.statut} » : il n'est pas encore livré.` : `Pas de projet ${arg}.`)
      return ouvrirProduction(command.trigger_id, p.id)
    }
    if (mot === "corriger" && /^\d+$/.test(arg ?? "")) {
      const consigne = texte.replace(/^corriger\s+\d+\s*/, "")
      if (!consigne) return repondre("Écris le problème après le numéro : `/usine corriger 2 les emails ne partent pas`.")
      demanderCorrections(ctx, Number(arg), consigne, command.user_name).then((r) => !r.ok && repondre(r.message)).catch((e) => console.error(e))
      return repondre("Demande transmise : l'analyste enquête, la réponse arrive dans le fil du produit.")
    }
    const canal = config.slack.canal || command.channel_id
    // Nouveau produit, ou correction d'un produit livré ? On ne lance rien sur une supposition.
    const a = await aiguiller(db, texte)
    if (a.type === "nouveau") return lancerNouveau(texte, command.user_id, canal)
    const id = String(++compteurAttentes)
    attentes.set(id, { texte, user: command.user_id, canal })
    const candidats = a.type === "correction" ? [obtenir(db, "projets", a.projetId)] : a.candidats.slice(0, 4)
    return respond({
      response_type: "ephemeral",
      text: "Cette demande concerne-t-elle un produit existant ?",
      blocks: [
        section(a.type === "correction" ? `:thinking_face: Ta demande semble concerner *${candidats[0].nom}*. Je la traite comme une correction de ce produit ?` : ":thinking_face: Ta demande concerne-t-elle un produit déjà livré, ou un nouveau produit ?"),
        { type: "actions", elements: [
          ...candidats.map((p, i) => bouton(`Corriger « ${p.nom} »`, `aig_corriger_${i}`, `${id}:${p.id}`, i === 0 ? "primary" : undefined)),
          bouton("Nouveau produit", "aig_nouveau", id),
          bouton("Annuler", "aig_annuler", id),
        ] },
      ],
    })
  })

  // L'aiguillage : les demandes en attente de la réponse de la personne.
  const attentes = new Map() // id -> { texte, user, canal }
  let compteurAttentes = 0
  async function lancerNouveau(texte, user, canal) {
    const r = await app.client.chat.postMessage({ channel: canal, text: `:factory: *Nouvelle demande* de <@${user}> :\n>${texte.replace(/\n/g, "\n>")}` })
    await actions.nouveauProjet(ctx, { prompt: texte, demandeur: user, canal, fil: r.ts })
  }
  for (let i = 0; i < 4; i++) {
    app.action(`aig_corriger_${i}`, async (args) => {
      if (!(await garde(args))) return
      const [id, projetId] = args.body.actions[0].value.split(":")
      const d = attentes.get(id)
      attentes.delete(id)
      if (!d) return args.respond({ replace_original: true, text: "Cette demande a expiré : relance la commande." })
      const p = obtenir(db, "projets", Number(projetId))
      await args.respond({ replace_original: true, text: `:mag: Correction de *${p.nom}* : l'analyste enquête, la réponse arrive dans le fil du produit.` })
      demanderCorrections(ctx, p.id, d.texte, args.body.user.name ?? args.body.user.id).catch((e) => console.error(e))
    })
  }
  app.action("aig_nouveau", async (args) => {
    if (!(await garde(args))) return
    const id = args.body.actions[0].value
    const d = attentes.get(id)
    attentes.delete(id)
    if (!d) return args.respond({ replace_original: true, text: "Cette demande a expiré : relance la commande." })
    await args.respond({ replace_original: true, text: ":factory: Nouveau produit : l'analyste prépare le plan." })
    await lancerNouveau(d.texte, d.user, d.canal)
  })
  app.action("aig_annuler", async (args) => {
    await args.ack()
    attentes.delete(args.body.actions[0].value)
    await args.respond({ replace_original: true, text: "Demande annulée." })
  })
  app.action("plan_abandonner", async (args) => {
    if (!(await garde(args))) return
    const r = actions.abandonnerPlan(ctx, Number(args.body.actions[0].value), args.body.user.name ?? args.body.user.id)
    if (r.ok) await retirerBoutons(args.body, `:wastebasket: Plan abandonné par <@${args.body.user.id}>`)
    else await args.respond({ response_type: "ephemeral", replace_original: false, text: r.message })
  })

  // Les boutons.
  const garde = async ({ ack, body, respond }) => {
    await ack()
    if (estAdmin(body.user.id)) return true
    await respond({ response_type: "ephemeral", replace_original: false, text: refus })
    return false
  }
  const retirerBoutons = async (body, texte) => {
    const blocs = (body.message?.blocks ?? []).filter((b) => b.type !== "actions")
    await app.client.chat.update({ channel: body.channel.id, ts: body.message.ts, text: texte, blocks: [...blocs, { type: "context", elements: [{ type: "mrkdwn", text: texte }] }] }).catch(() => {})
  }

  app.action("plan_valider", async (args) => {
    if (!(await garde(args))) return
    const { body } = args
    const r = await actions.validerPlan(ctx, Number(body.actions[0].value), body.user.name ?? body.user.id)
    if (r.ok) await retirerBoutons(body, `:white_check_mark: Validé par <@${body.user.id}>`)
    else await args.respond({ response_type: "ephemeral", replace_original: false, text: r.message })
  })
  app.action("plan_corriger", async (args) => {
    if (!(await garde(args))) return
    await app.client.views.open({ trigger_id: args.body.trigger_id, view: modale("modal_plan_corriger", args.body.actions[0].value, "Corriger le plan", "Ce qu'il faut changer", "Ajoute un lot pour…, retire…, le critère T3 doit…") })
  })
  app.view("modal_plan_corriger", async ({ ack, view, body }) => {
    await ack()
    await actions.corrigerPlan(ctx, Number(view.private_metadata), lire(view), body.user.name ?? body.user.id)
  })
  app.action("questions_repondre", async (args) => {
    if (!(await garde(args))) return
    const projet = obtenir(db, "projets", Number(args.body.actions[0].value))
    const questions = JSON.parse(projet.plan ?? "{}").questions ?? []
    await app.client.views.open({
      trigger_id: args.body.trigger_id,
      view: {
        type: "modal", callback_id: "modal_questions", private_metadata: String(projet.id),
        title: { type: "plain_text", text: "Répondre à l'analyste" }, submit: { type: "plain_text", text: "Envoyer" },
        blocks: questions.map((q, i) => ({ type: "input", block_id: `q${i}`, label: { type: "plain_text", text: tronquer(q, 1900) }, element: { type: "plain_text_input", action_id: "v", multiline: true } })),
      },
    })
  })
  app.view("modal_questions", async ({ ack, view, body }) => {
    await ack()
    const reponses = Object.keys(view.state.values).sort().map((k) => view.state.values[k].v.value ?? "")
    await actions.repondreQuestions(ctx, Number(view.private_metadata), reponses, body.user.name ?? body.user.id)
  })
  for (const cle of ["A", "B", "C"]) {
    app.action(`esc_${cle}`, async (args) => {
      if (!(await garde(args))) return
      const [id, choix] = args.body.actions[0].value.split(":")
      const r = await resoudre(ctx, Number(id), { choix, par: args.body.user.name ?? args.body.user.id })
      if (!r.ok) await args.respond({ response_type: "ephemeral", replace_original: false, text: r.message })
    })
  }
  app.action("esc_consigne", async (args) => {
    if (!(await garde(args))) return
    await app.client.views.open({ trigger_id: args.body.trigger_id, view: modale("modal_esc_consigne", args.body.actions[0].value, "Réessayer", "Consigne pour l'agent", "Utilise une table séparée pour…, ne touche pas à…") })
  })
  app.view("modal_esc_consigne", async ({ ack, view, body }) => {
    await ack()
    await resoudre(ctx, Number(view.private_metadata), { choix: "A", texte: lire(view), par: body.user.name ?? body.user.id })
  })
  // Valider : une fenêtre pour choisir comment ce produit tourne en production.
  // Les choix sont pré-remplis (ceux du produit, sinon ceux du contrat).
  async function ouvrirProduction(trigger_id, projetId) {
    const projet = obtenir(db, "projets", projetId)
    const c = choixProduction(config, projet.production ? JSON.parse(projet.production) : null)
    const radio = (bloc, label, options, valeur, aide) => ({
      type: "input", block_id: bloc, label: { type: "plain_text", text: label }, ...(aide ? { hint: { type: "plain_text", text: aide } } : {}),
      element: {
        type: "radio_buttons", action_id: "v",
        options: options.map(([v, t]) => ({ value: v, text: { type: "plain_text", text: t } })),
        initial_option: { value: valeur, text: { type: "plain_text", text: options.find(([v]) => v === valeur)[1] } },
      },
    })
    await app.client.views.open({
      trigger_id,
      view: {
        type: "modal", callback_id: "modal_production", private_metadata: String(projet.id),
        title: { type: "plain_text", text: "Mettre en production" }, submit: { type: "plain_text", text: "Mettre en production" }, close: { type: "plain_text", text: "Annuler" },
        blocks: [
          section(`*${projet.nom}* → ${adresses(config, projet.slug).production}\nBascule sans coupure ; les données de production sont sauvegardées avant.`),
          radio("donnees", "Données", [["demo", "Données de démo (remplies au premier démarrage)"], ["vide", "Base vide : vraie utilisation, avec tes contacts de test"]], c.donnees, "Changer ce choix démarre sur une autre base ; l'ancienne est gardée."),
          radio("emails", "Emails", [["captures", "Capturés par Mailpit : rien ne sort"], ["reels", "Réellement envoyés (service d'envoi du .env)"]], c.emails),
          { type: "input", block_id: "autorises", optional: true, label: { type: "plain_text", text: "Destinataires autorisés (emails réels)" },
            hint: { type: "plain_text", text: "Adresses ou domaines séparés par des virgules (ex. moi@exemple.fr, @mon-equipe.fr). Vide = tout le monde." },
            element: { type: "plain_text_input", action_id: "v", ...(c.destinataires_autorises.length ? { initial_value: c.destinataires_autorises.join(", ") } : {}) } },
          radio("horloge", "Horloge", [["acceleree", "Accélérée (un jour = une minute)"], ["reelle", "Réelle"]], c.horloge),
        ],
      },
    })
  }
  // Le bouton du rapport final, et celui du message « en production ».
  for (const id of ["livraison_valider", "production_reglages"]) {
    app.action(id, async (args) => {
      if (!(await garde(args))) return
      await ouvrirProduction(args.body.trigger_id, Number(args.body.actions[0].value))
    })
  }
  app.view("modal_production", async ({ ack, view, body }) => {
    const v = view.state.values
    const demande = {
      donnees: v.donnees.v.selected_option.value,
      emails: v.emails.v.selected_option.value,
      horloge: v.horloge.v.selected_option.value,
      destinataires_autorises: v.autorises.v.value ?? "",
    }
    if (demande.emails === "reels" && !process.env.SMTP_HOST) {
      return ack({ response_action: "errors", errors: { emails: "Aucun service d'envoi configuré (SMTP_HOST dans .env) : choisis « Capturés » ou configure l'envoi." } })
    }
    const invalides = String(demande.destinataires_autorises).split(/[,;\s]+/).filter((x) => x && !/^[^\s@]*@[^\s@]+$/.test(x))
    if (invalides.length) return ack({ response_action: "errors", errors: { autorises: `Non reconnu : ${invalides.join(", ")}` } })
    await ack()
    mettreEnProduction(ctx, Number(view.private_metadata), body.user.name ?? body.user.id, demande).then((r) => {
      if (!r.ok) notifier.etape(obtenir(db, "projets", Number(view.private_metadata)), `:x: ${r.message}`)
    }).catch((e) => console.error(e))
  })
  app.action("livraison_corriger", async (args) => {
    if (!(await garde(args))) return
    await app.client.views.open({ trigger_id: args.body.trigger_id, view: modale("modal_livraison_corriger", args.body.actions[0].value, "Demander des corrections", "Ce qui ne va pas", "Sur la page campagnes, le bouton… ; il manque…") })
  })
  app.view("modal_livraison_corriger", async ({ ack, view, body }) => {
    await ack()
    demanderCorrections(ctx, Number(view.private_metadata), lire(view), body.user.name ?? body.user.id).catch((e) => console.error(e))
  })

  // L'onglet Accueil : l'état de l'usine d'un coup d'œil.
  app.event("app_home_opened", async ({ event }) => {
    const projets = actions.statut(ctx)
    await app.client.views.publish({
      user_id: event.user,
      view: {
        type: "home",
        blocks: [
          { type: "header", text: { type: "plain_text", text: "Usine logicielle" } },
          section("Du prompt au produit en ligne. `/usine <ce que tu veux construire>` dans un canal où je suis invité."),
          { type: "divider" },
          ...(projets.length ? projets.slice(0, 15).map((p) => section(`*${p.id}. ${p.nom}* · ${STATUTS[p.statut] ?? p.statut}\n${p.fusionnees}/${p.taches} tâches fusionnées${p.abandonnees ? `, ${p.abandonnees} abandonnée(s)` : ""}${p.en_cours ? `\nEn cours : ${p.en_cours}` : ""}${p.escalades.length ? `\n:rotating_light: ${p.escalades.length} décision(s) attendue(s)` : ""}${p.depot ? `\n<https://github.com/${p.depot}|${p.depot}>` : ""}${p.apercu && p.lot_livre ? ` · ${p.apercu}` : ""}`)) : [section("_Aucun projet pour l'instant._")]),
        ],
      },
    }).catch((e) => console.error("Accueil :", e.data?.error ?? e.message))
  })

  await app.start()
  console.log("Slack connecté (Socket Mode).")
  return notifier
}
