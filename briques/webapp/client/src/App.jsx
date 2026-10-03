// L'écran de départ, construit avec les composants de client/src/ui.
// Les tâches de l'usine le remplacent par le vrai produit.
import { Carte, Coque, Page } from "./ui/index.jsx"

export default function App() {
  return (
    <Coque nom={"{{NOM}}"} liens={[{ href: "/", libelle: "Accueil" }]} actif="/">
      <Page titre={"{{NOM}}"} description={"{{RESUME}}"}>
        <Carte titre="Le produit se construit">
          <p className="text-sm text-doux">Chaque lot livré ajoute ses écrans ici.</p>
        </Carte>
      </Page>
    </Coque>
  )
}
