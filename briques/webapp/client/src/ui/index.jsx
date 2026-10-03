// Les composants de base de chaque produit : sobres, cohérents, accessibles.
// Les couleurs viennent des jetons du brief (bg-primaire, text-doux…), jamais de
// couleurs écrites en dur. Utilise-les plutôt que de réinventer boutons et tableaux.
export * from "./format.js"

const cx = (...c) => c.filter(Boolean).join(" ")

// La coque de l'application : navigation latérale sur ordinateur, barre en haut sur mobile.
export function Coque({ nom, liens = [], actif, children, pied }) {
  return (
    <div className="min-h-screen bg-fond text-texte lg:flex">
      <aside className="border-b border-black/5 bg-surface lg:sticky lg:top-0 lg:h-screen lg:w-60 lg:shrink-0 lg:border-b-0 lg:border-r">
        <div className="flex items-center gap-2 px-5 py-4 font-titres text-base font-semibold">{nom}</div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:overflow-visible" aria-label="Navigation principale">
          {liens.map((l) => (
            <a
              key={l.href}
              href={l.href}
              aria-current={actif === l.href ? "page" : undefined}
              className={cx(
                "whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors",
                actif === l.href ? "bg-primaire/10 font-medium text-primaire" : "text-doux hover:bg-black/5 hover:text-texte",
              )}
            >
              {l.libelle}
            </a>
          ))}
        </nav>
        {pied && <div className="hidden px-5 py-4 text-xs text-doux lg:block">{pied}</div>}
      </aside>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  )
}

// Une page : un titre, une description courte, l'action principale à droite.
export function Page({ titre, description, actions, children }) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{titre}</h1>
          {description && <p className="mt-1 max-w-2xl text-sm text-doux">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
      </header>
      <div className="space-y-6">{children}</div>
    </div>
  )
}

const VARIANTES = {
  principal: "bg-primaire text-white hover:opacity-90",
  secondaire: "border border-black/10 bg-surface text-texte hover:bg-black/5",
  discret: "text-doux hover:bg-black/5 hover:text-texte",
  danger: "bg-danger text-white hover:opacity-90",
}
export function Bouton({ variante = "principal", className, chargement, children, ...props }) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || chargement}
      className={cx("inline-flex min-h-9 items-center justify-center gap-2 rounded-md px-3.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50", VARIANTES[variante], className)}
    >
      {chargement && <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />}
      {children}
    </button>
  )
}

export function Carte({ titre, description, actions, children, className }) {
  return (
    <section className={cx("rounded-lg border border-black/5 bg-surface p-5 shadow-sm", className)}>
      {(titre || actions) && (
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            {titre && <h2 className="text-base font-semibold">{titre}</h2>}
            {description && <p className="mt-0.5 text-sm text-doux">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  )
}

const TONS = {
  neutre: "bg-black/5 text-texte",
  info: "bg-accent/10 text-accent",
  succes: "bg-succes/10 text-succes",
  alerte: "bg-alerte/10 text-alerte",
  danger: "bg-danger/10 text-danger",
}
export const Badge = ({ ton = "neutre", children }) => <span className={cx("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", TONS[ton])}>{children}</span>

// Un chiffre clé : libellé, valeur, et sa variation (positive, négative ou nulle).
export function Statistique({ libelle, valeur, variation, aide }) {
  const sens = variation === undefined || variation === null ? null : variation > 0 ? "succes" : variation < 0 ? "danger" : "neutre"
  return (
    <div className="rounded-lg border border-black/5 bg-surface p-4">
      <p className="text-sm text-doux">{libelle}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{valeur}</p>
      {sens && <p className={cx("mt-1 text-xs tabular-nums", sens === "succes" ? "text-succes" : sens === "danger" ? "text-danger" : "text-doux")}>{variation > 0 ? "+" : ""}{variation.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} % sur la période précédente</p>}
      {aide && <p className="mt-1 text-xs text-doux">{aide}</p>}
    </div>
  )
}

export function Champ({ label, aide, erreur, id, as: Element = "input", className, ...props }) {
  const ident = id ?? `champ-${String(label).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
  return (
    <div className="space-y-1.5">
      <label htmlFor={ident} className="block text-sm font-medium">{label}</label>
      <Element
        id={ident}
        aria-invalid={erreur ? "true" : undefined}
        aria-describedby={erreur || aide ? `${ident}-aide` : undefined}
        {...props}
        className={cx("block w-full rounded-md border bg-surface px-3 py-2 text-sm outline-none transition focus:border-accent", erreur ? "border-danger" : "border-black/15", className)}
      />
      {(erreur || aide) && <p id={`${ident}-aide`} className={cx("text-xs", erreur ? "text-danger" : "text-doux")}>{erreur ?? aide}</p>}
    </div>
  )
}

// L'état vide : ce qu'on peut faire ici, et le bouton pour le faire.
export function EtatVide({ titre, texte, action }) {
  return (
    <div className="rounded-lg border border-dashed border-black/15 bg-surface px-6 py-12 text-center">
      <p className="font-medium">{titre}</p>
      {texte && <p className="mx-auto mt-1 max-w-md text-sm text-doux">{texte}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function Chargement({ texte = "Chargement…" }) {
  return (
    <div className="flex items-center gap-3 py-10 text-sm text-doux" role="status">
      <span className="size-4 animate-spin rounded-full border-2 border-doux/40 border-t-doux" aria-hidden="true" />
      {texte}
    </div>
  )
}

export function Erreur({ message = "Une erreur est survenue.", reessayer }) {
  return (
    <div className="rounded-lg border border-danger/20 bg-danger/5 px-4 py-3 text-sm text-danger" role="alert">
      {message}
      {reessayer && <button type="button" onClick={reessayer} className="ml-3 font-medium underline">Réessayer</button>}
    </div>
  )
}

// Un tableau lisible : en-têtes discrets, nombres à droite, ligne cliquable si besoin.
// colonnes : [{ cle, libelle, numerique?, rendu?(ligne) }]
export function Tableau({ colonnes, lignes, cle = "id", surClic, vide }) {
  if (!lignes?.length) return vide ?? <EtatVide titre="Rien à afficher pour l'instant." />
  return (
    <div className="overflow-x-auto rounded-lg border border-black/5 bg-surface">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-black/5 text-left text-xs font-medium uppercase tracking-wide text-doux">
            {colonnes.map((c) => <th key={c.cle} scope="col" className={cx("px-4 py-3", c.numerique && "text-right")}>{c.libelle}</th>)}
          </tr>
        </thead>
        <tbody>
          {lignes.map((l) => (
            <tr key={l[cle]} onClick={surClic ? () => surClic(l) : undefined} className={cx("border-b border-black/5 last:border-0", surClic && "cursor-pointer hover:bg-black/[0.02]")}>
              {colonnes.map((c) => <td key={c.cle} className={cx("px-4 py-3", c.numerique && "text-right tabular-nums")}>{c.rendu ? c.rendu(l) : l[c.cle]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
