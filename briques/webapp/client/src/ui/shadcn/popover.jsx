// Composant shadcn/ui (MIT), adapté aux jetons de l'usine : un contenu flottant (filtre, détail).
import { Popover as PopoverPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"

export const Popover = (props) => <PopoverPrimitive.Root data-slot="popover" {...props} />
export const PopoverTrigger = (props) => <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />

export function PopoverContent({ className, align = "center", sideOffset = 4, ...props }) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content data-slot="popover-content" align={align} sideOffset={sideOffset} className={cn("z-50 w-72 rounded-md border border-border bg-popover p-4 text-popover-foreground shadow-md outline-none", className)} {...props} />
    </PopoverPrimitive.Portal>
  )
}
