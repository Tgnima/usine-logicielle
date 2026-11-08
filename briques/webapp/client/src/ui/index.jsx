// Les composants de base de chaque produit : sobres, cohérents, accessibles.
// Ils reposent sur shadcn/ui (client/src/ui/shadcn, Radix + Tailwind) et sur les jetons du
// brief (bg-primaire, text-doux… et leurs équivalents bg-primary, text-muted-foreground…),
// jamais sur des couleurs écrites en dur. Utilise-les plutôt que de réinventer boutons et
// tableaux ; la page /kit les montre tous aux couleurs du produit.
//
// Les composants interactifs de shadcn s'importent depuis leur fichier, pour que chaque écran
// n'embarque que ce qu'il utilise : import { Dialog, DialogContent } from "@/ui/shadcn/dialog.jsx".
import { Button } from "./shadcn/button.jsx"
import { Input, Label, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea } from "./shadcn/elements.jsx"
import { Notifications } from "./shadcn/sonner.jsx"
import { cn } from "../lib/utils.js"

export * from "./format.js"
export { cn }
export { toast } from "./shadcn/sonner.jsx"

// La coque de l'application : navigation latérale sur ordinateur, barre en haut sur mobile.
// liens : [{ href, libelle, icone? }] (icone : un composant de lucide-react).
export function Coque({ nom, liens = [], actif, children, pied }) {
  return (
    <div className="min-h-screen bg-background text-foreground lg:flex">
      <aside className="border-b border-border bg-card lg:sticky lg:top-0 lg:h-screen lg:w-60 lg:shrink-0 lg:border-b-0 lg:border-r">
        <div className="flex items-center gap-2 px-5 py-4 font-titres text-base font-semibold">{nom}</div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:overflow-visible" aria-label="Navigation principale">
          {liens.map(({ href, libelle, icone: Icone }) => (
            <a
              key={href}
              href={href}
              aria-current={actif === href ? "page" : undefined}
              className={cn(
                "flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors [&_svg]:size-4",
                actif === href ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {Icone && <Icone aria-hidden="true" />}
              {libelle}
            </a>
          ))}
        </nav>
        {pied && <div className="hidden px-5 py-4 text-xs text-muted-foreground lg:block">{pied}</div>}
      </aside>
      <main className="min-w-0 flex-1">{children}</main>
      <Notifications />
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
          {description && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
      </header>
      <div className="space-y-6">{children}</div>
    </div>
  )
}

// Les variantes en français, au-dessus de celles de shadcn (default, outline, ghost, destructive).
const VARIANTES = { principal: "default", secondaire: "outline", discret: "ghost", danger: "destructive" }
export function Bouton({ variante = "principal", taille, chargement, children, ...props }) {
  return (
    <Button type="button" {...props} variant={VARIANTES[variante] ?? variante} size={taille} disabled={props.disabled || chargement} aria-busy={chargement || undefined}>
      {chargement && <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none" aria-hidden="true" />}
      {children}
    </Button>
  )
}

// Une carte : un bloc, une idée. Ne mets pas de carte dans une carte.
export function Carte({ titre, description, actions, children, className }) {
  return (
    <section className={cn("rounded-lg border border-border bg-card p-5 text-card-foreground", className)}>
      {(titre || actions) && (
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            {titre && <h2 className="text-base font-semibold">{titre}</h2>}
            {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  )
}

// Un badge porte un statut qui change une décision ; pas un badge sur chaque information.
const TONS = {
  neutre: "bg-muted text-foreground",
  info: "bg-accent/10 text-accent",
  succes: "bg-succes/10 text-succes",
  alerte: "bg-alerte/10 text-alerte",
  danger: "bg-danger/10 text-danger",
}
export const Badge = ({ ton = "neutre", children }) => <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", TONS[ton])}>{children}</span>

// Un chiffre clé : libellé, valeur, et sa variation (positive, négative ou nulle).
export function Statistique({ libelle, valeur, variation, aide }) {
  const sens = variation === undefined || variation === null ? null : variation > 0 ? "succes" : variation < 0 ? "danger" : "neutre"
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-sm text-muted-foreground">{libelle}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{valeur}</p>
      {sens && <p className={cn("mt-1 text-xs tabular-nums", sens === "succes" ? "text-succes" : sens === "danger" ? "text-danger" : "text-muted-foreground")}>{variation > 0 ? "+" : ""}{variation.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} % sur la période précédente</p>}
      {aide && <p className="mt-1 text-xs text-muted-foreground">{aide}</p>}
    </div>
  )
}

// Un champ de formulaire : libellé, aide ou erreur reliés au champ (lus par un lecteur d'écran).
export function Champ({ label, aide, erreur, id, as = "input", className, ...props }) {
  const ident = id ?? `champ-${String(label).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
  const Element = as === "textarea" ? Textarea : as === "input" ? Input : as
  return (
    <div className="space-y-1.5">
      <Label htmlFor={ident}>{label}</Label>
      <Element id={ident} aria-invalid={erreur ? "true" : undefined} aria-describedby={erreur || aide ? `${ident}-aide` : undefined} {...props} className={className} />
      {(erreur || aide) && <p id={`${ident}-aide`} className={cn("text-xs", erreur ? "text-destructive" : "text-muted-foreground")}>{erreur ?? aide}</p>}
    </div>
  )
}

// L'état vide : ce qu'on peut faire ici, et le bouton pour le faire.
export function EtatVide({ titre, texte, action, icone: Icone }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card px-6 py-12 text-center">
      {Icone && <Icone className="mx-auto mb-3 size-6 text-muted-foreground" aria-hidden="true" />}
      <p className="font-medium">{titre}</p>
      {texte && <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{texte}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

// Le chargement : des squelettes à la forme du contenu (lignes), ou un indicateur court.
export function Chargement({ texte = "Chargement…", lignes = 0 }) {
  if (lignes > 0)
    return (
      <div className="space-y-3" role="status" aria-label={texte}>
        {Array.from({ length: lignes }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}
      </div>
    )
  return (
    <div className="flex items-center gap-3 py-10 text-sm text-muted-foreground" role="status">
      <span className="size-4 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-muted-foreground motion-reduce:animate-none" aria-hidden="true" />
      {texte}
    </div>
  )
}

export function Erreur({ message = "Une erreur est survenue.", reessayer }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive" role="alert">
      {message}
      {reessayer && <Bouton variante="discret" taille="sm" onClick={reessayer}>Réessayer</Bouton>}
    </div>
  )
}

// Un tableau lisible : en-têtes discrets, nombres à droite, ligne cliquable si besoin.
// colonnes : [{ cle, libelle, numerique?, rendu?(ligne) }]
export function Tableau({ colonnes, lignes, cle = "id", surClic, vide }) {
  if (!lignes?.length) return vide ?? <EtatVide titre="Rien à afficher pour l'instant." />
  return (
    <div className="rounded-lg border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            {colonnes.map((c) => <TableHead key={c.cle} className={cn(c.numerique && "text-right")}>{c.libelle}</TableHead>)}
          </TableRow>
        </TableHeader>
        <TableBody>
          {lignes.map((l) => (
            <TableRow
              key={l[cle]}
              onClick={surClic ? () => surClic(l) : undefined}
              onKeyDown={surClic ? (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), surClic(l)) : undefined}
              tabIndex={surClic ? 0 : undefined}
              className={cn(surClic && "cursor-pointer hover:bg-muted/60 focus-visible:bg-muted focus-visible:outline-none")}
            >
              {colonnes.map((c) => <TableCell key={c.cle} className={cn(c.numerique && "text-right tabular-nums")}>{c.rendu ? c.rendu(l) : l[c.cle]}</TableCell>)}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
