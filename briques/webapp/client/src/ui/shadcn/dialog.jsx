// Composant shadcn/ui (MIT), adapté aux jetons de l'usine. Fenêtre modale accessible :
// focus piégé, Échap ferme, le titre est annoncé.
import { Dialog as DialogPrimitive } from "radix-ui"
import { XIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export const Dialog = (props) => <DialogPrimitive.Root data-slot="dialog" {...props} />
export const DialogTrigger = (props) => <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
export const DialogClose = (props) => <DialogPrimitive.Close data-slot="dialog-close" {...props} />

export function DialogContent({ className, children, ...props }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-foreground/40" />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn("fixed left-1/2 top-1/2 z-50 grid max-h-[calc(100vh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-lg border border-border bg-card p-6 text-card-foreground shadow-lg", className)}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
          <XIcon className="size-4" />
          <span className="sr-only">Fermer</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

export const DialogHeader = ({ className, ...props }) => <div className={cn("flex flex-col gap-1.5 pr-6", className)} {...props} />
export const DialogFooter = ({ className, ...props }) => <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />
export const DialogTitle = ({ className, ...props }) => <DialogPrimitive.Title className={cn("text-lg font-semibold", className)} {...props} />
export const DialogDescription = ({ className, ...props }) => <DialogPrimitive.Description className={cn("text-sm text-muted-foreground", className)} {...props} />
