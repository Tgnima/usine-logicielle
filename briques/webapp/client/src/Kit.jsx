// Le kit d'interface (/kit) : chaque composant du produit, aux couleurs de son brief, sur une
// seule page. La première tâche l'adapte au brief (docs/DESIGN.md) et le relecteur design le
// juge sur captures ; ensuite, les écrans s'appuient sur ces composants, sans en inventer d'autres.
// Les textes sont des exemples : remplace-les par des textes du métier du produit.
import { useState } from "react"
import { Inbox, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react"
import { Badge, Bouton, Carte, Champ, Chargement, Coque, Erreur, EtatVide, Page, Statistique, Tableau, euros, toast } from "./ui/index.jsx"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./ui/shadcn/dialog.jsx"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/shadcn/dropdown-menu.jsx"
import { Checkbox, Label, Switch } from "./ui/shadcn/elements.jsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/shadcn/select.jsx"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "./ui/shadcn/sheet.jsx"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/shadcn/tabs.jsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/shadcn/tooltip.jsx"

const LIGNES = [
  { id: 1, nom: "Exemple A", statut: "actif", montant: 1234.5 },
  { id: 2, nom: "Exemple B", statut: "en attente", montant: 89 },
  { id: 3, nom: "Exemple C", statut: "clos", montant: 0 },
]
const TON = { actif: "succes", "en attente": "alerte", clos: "neutre" }

const Section = ({ titre, children }) => (
  <section className="space-y-3">
    <h2 className="text-sm font-medium text-muted-foreground">{titre}</h2>
    {children}
  </section>
)

export default function Kit() {
  const [actif, setActif] = useState(true)
  return (
    <Coque nom={"{{NOM}}"} liens={[{ href: "/", libelle: "Accueil" }, { href: "/kit", libelle: "Kit d'interface" }]} actif="/kit">
      <Page titre="Kit d'interface" description="Les composants du produit, aux couleurs de son brief." actions={<Bouton onClick={() => toast.success("Action confirmée")}><Plus /> Action principale</Bouton>}>
        <Section titre="Couleurs et texte">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {["primaire", "accent", "succes", "alerte", "danger", "fond", "surface", "doux"].map((c) => (
              <div key={c} className="rounded-lg border border-border bg-card p-3 text-sm">
                <div className="mb-2 h-8 rounded-md border border-border" style={{ background: `var(--color-${c})` }} />
                {c}
              </div>
            ))}
          </div>
          <Carte>
            <h1 className="text-2xl font-semibold tracking-tight">Titre de page</h1>
            <h2 className="mt-2 text-base font-semibold">Titre de bloc</h2>
            <p className="mt-1 text-sm">Un texte courant, lisible, avec un <a className="text-primary underline underline-offset-4" href="/kit">lien</a>.</p>
            <p className="mt-1 text-sm text-muted-foreground">Un texte secondaire, plus discret.</p>
          </Carte>
        </Section>

        <Section titre="Boutons">
          <div className="flex flex-wrap items-center gap-2">
            <Bouton>Principal</Bouton>
            <Bouton variante="secondaire">Secondaire</Bouton>
            <Bouton variante="discret">Discret</Bouton>
            <Bouton variante="danger"><Trash2 /> Supprimer</Bouton>
            <Bouton chargement>Enregistrement…</Bouton>
            <Bouton disabled>Indisponible</Bouton>
            <Tooltip>
              <TooltipTrigger asChild>
                <Bouton variante="secondaire" taille="icon" aria-label="Modifier"><Pencil /></Bouton>
              </TooltipTrigger>
              <TooltipContent>Modifier</TooltipContent>
            </Tooltip>
          </div>
        </Section>

        <Section titre="Chiffres clés et statuts">
          <div className="grid gap-3 sm:grid-cols-3">
            <Statistique libelle="Chiffre clé" valeur={euros(12840)} variation={12.5} />
            <Statistique libelle="En baisse" valeur="42" variation={-3} />
            <Statistique libelle="Stable" valeur="7" variation={0} aide="Une aide courte" />
          </div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(TON).map(([s, t]) => <Badge key={s} ton={t}>{s}</Badge>)}
            <Badge ton="info">info</Badge>
            <Badge ton="danger">en retard</Badge>
          </div>
        </Section>

        <Section titre="Formulaire">
          <Carte titre="Un formulaire" description="Libellés au-dessus, aide sous le champ, erreur claire.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Champ label="Nom" placeholder="Ex. : Exemple A" aide="Une aide courte" />
              <Champ label="Email" type="email" defaultValue="pas-un-email" erreur="Saisis une adresse email valide." />
              <div className="space-y-1.5">
                <Label htmlFor="kit-statut">Statut</Label>
                <Select defaultValue="actif">
                  <SelectTrigger id="kit-statut"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.keys(TON).map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <Champ label="Note" as="textarea" placeholder="Quelques mots" />
              <div className="flex items-center gap-2">
                <Checkbox id="kit-case" defaultChecked />
                <Label htmlFor="kit-case">Une case à cocher</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch id="kit-inter" checked={actif} onCheckedChange={setActif} />
                <Label htmlFor="kit-inter">Un interrupteur ({actif ? "activé" : "désactivé"})</Label>
              </div>
            </div>
          </Carte>
        </Section>

        <Section titre="Tableau et menu d'actions">
          <Tableau
            colonnes={[
              { cle: "nom", libelle: "Nom" },
              { cle: "statut", libelle: "Statut", rendu: (l) => <Badge ton={TON[l.statut]}>{l.statut}</Badge> },
              { cle: "montant", libelle: "Montant", numerique: true, rendu: (l) => euros(l.montant) },
              {
                cle: "actions", libelle: <span className="sr-only">Actions</span>, numerique: true,
                rendu: () => (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Bouton variante="discret" taille="icon" aria-label="Actions"><MoreHorizontal /></Bouton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem><Pencil /> Modifier</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive"><Trash2 /> Supprimer</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ),
              },
            ]}
            lignes={LIGNES}
          />
        </Section>

        <Section titre="Onglets, fenêtre et panneau">
          <Tabs defaultValue="un">
            <TabsList>
              <TabsTrigger value="un">Premier</TabsTrigger>
              <TabsTrigger value="deux">Second</TabsTrigger>
            </TabsList>
            <TabsContent value="un">
              <div className="flex flex-wrap gap-2">
                <Dialog>
                  <DialogTrigger asChild><Bouton variante="secondaire">Ouvrir une fenêtre</Bouton></DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Confirmer l'action</DialogTitle>
                      <DialogDescription>Dis ce qui va se passer, et si c'est réversible.</DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                      <Bouton variante="secondaire">Annuler</Bouton>
                      <Bouton>Confirmer</Bouton>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
                <Sheet>
                  <SheetTrigger asChild><Bouton variante="secondaire">Ouvrir un panneau</Bouton></SheetTrigger>
                  <SheetContent>
                    <SheetHeader>
                      <SheetTitle>Détail</SheetTitle>
                      <SheetDescription>Le détail d'une ligne, sans quitter la liste.</SheetDescription>
                    </SheetHeader>
                  </SheetContent>
                </Sheet>
              </div>
            </TabsContent>
            <TabsContent value="deux"><p className="text-sm text-muted-foreground">Le contenu du second onglet.</p></TabsContent>
          </Tabs>
        </Section>

        <Section titre="États">
          <div className="grid gap-3 lg:grid-cols-2">
            <EtatVide icone={Inbox} titre="Rien ici pour l'instant" texte="Dis ce qu'on peut faire ici, et donne le bouton pour le faire." action={<Bouton><Plus /> Créer le premier</Bouton>} />
            <div className="space-y-3">
              <Chargement lignes={3} />
              <Chargement />
              <Erreur message="Le chargement n'a pas abouti." reessayer={() => {}} />
            </div>
          </div>
        </Section>
      </Page>
    </Coque>
  )
}
