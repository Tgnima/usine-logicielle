// Composant shadcn/ui (MIT), adapté aux jetons de l'usine : une bulle d'aide (survol et focus).
// Une bulle complète un libellé, elle ne le remplace jamais : un bouton icône garde son aria-label.
import { Tooltip as TooltipPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"

export const TooltipProvider = ({ delayDuration = 200, ...props }) => <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />
export const Tooltip = (props) => (
  <TooltipProvider>
    <TooltipPrimitive.Root data-slot="tooltip" {...props} />
  </TooltipProvider>
)
export const TooltipTrigger = (props) => <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />

export function TooltipContent({ className, sideOffset = 4, ...props }) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content data-slot="tooltip-content" sideOffset={sideOffset} className={cn("z-50 max-w-xs rounded-md bg-foreground px-3 py-1.5 text-xs text-background", className)} {...props} />
    </TooltipPrimitive.Portal>
  )
}
