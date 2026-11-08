// Composant shadcn/ui (MIT), adapté aux jetons de l'usine. Un panneau latéral (filtres,
// détail d'une ligne, menu sur mobile), construit sur la fenêtre modale de Radix.
import { Dialog as SheetPrimitive } from "radix-ui"
import { XIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export const Sheet = (props) => <SheetPrimitive.Root data-slot="sheet" {...props} />
export const SheetTrigger = (props) => <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
export const SheetClose = (props) => <SheetPrimitive.Close data-slot="sheet-close" {...props} />

const COTES = {
  right: "inset-y-0 right-0 h-full w-3/4 border-l sm:max-w-sm",
  left: "inset-y-0 left-0 h-full w-3/4 border-r sm:max-w-sm",
  top: "inset-x-0 top-0 h-auto border-b",
  bottom: "inset-x-0 bottom-0 h-auto border-t",
}

export function SheetContent({ className, children, side = "right", ...props }) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay className="fixed inset-0 z-50 bg-foreground/40" />
      <SheetPrimitive.Content data-slot="sheet-content" className={cn("fixed z-50 flex flex-col gap-4 overflow-y-auto border-border bg-card p-6 text-card-foreground shadow-lg", COTES[side], className)} {...props}>
        {children}
        <SheetPrimitive.Close className="absolute right-4 top-4 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
          <XIcon className="size-4" />
          <span className="sr-only">Fermer</span>
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  )
}

export const SheetHeader = ({ className, ...props }) => <div className={cn("flex flex-col gap-1.5 pr-6", className)} {...props} />
export const SheetFooter = ({ className, ...props }) => <div className={cn("mt-auto flex flex-col gap-2", className)} {...props} />
export const SheetTitle = ({ className, ...props }) => <SheetPrimitive.Title className={cn("text-lg font-semibold", className)} {...props} />
export const SheetDescription = ({ className, ...props }) => <SheetPrimitive.Description className={cn("text-sm text-muted-foreground", className)} {...props} />
