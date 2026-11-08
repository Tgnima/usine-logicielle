// Les confirmations d'action (« Contact enregistré ») : la notification de shadcn/ui (Sonner),
// aux couleurs du produit. Place <Notifications /> une fois dans la coque, puis appelle
// toast.success("…") ou toast.error("…") après chaque action.
import { Toaster } from "sonner"

export { toast } from "sonner"

export function Notifications(props) {
  return (
    <Toaster
      position="bottom-right"
      toastOptions={{ classNames: { toast: "!rounded-md !border-border !bg-card !text-card-foreground !shadow-md", description: "!text-muted-foreground" } }}
      {...props}
    />
  )
}
