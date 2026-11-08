// Composant shadcn/ui (MIT), adapté aux jetons de l'usine : un menu d'actions secondaires,
// navigable au clavier (flèches, Entrée, Échap).
import { DropdownMenu as MenuPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"

export const DropdownMenu = (props) => <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />
export const DropdownMenuTrigger = (props) => <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
export const DropdownMenuGroup = (props) => <MenuPrimitive.Group {...props} />

export function DropdownMenuContent({ className, sideOffset = 4, ...props }) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content data-slot="dropdown-menu-content" sideOffset={sideOffset} className={cn("z-50 min-w-40 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md", className)} {...props} />
    </MenuPrimitive.Portal>
  )
}

export function DropdownMenuItem({ className, variant = "default", ...props }) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      className={cn(
        "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
        variant === "destructive" && "text-destructive data-[highlighted]:bg-destructive/10 [&_svg]:text-destructive",
        className,
      )}
      {...props}
    />
  )
}

export const DropdownMenuLabel = ({ className, ...props }) => <MenuPrimitive.Label className={cn("px-2 py-1.5 text-xs font-medium text-muted-foreground", className)} {...props} />
export const DropdownMenuSeparator = ({ className, ...props }) => <MenuPrimitive.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />
