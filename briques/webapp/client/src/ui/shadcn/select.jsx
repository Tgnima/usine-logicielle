// Composant shadcn/ui (MIT), adapté aux jetons de l'usine : une liste de choix accessible.
import { Select as SelectPrimitive } from "radix-ui"
import { CheckIcon, ChevronDownIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export const Select = (props) => <SelectPrimitive.Root data-slot="select" {...props} />
export const SelectGroup = (props) => <SelectPrimitive.Group {...props} />
export const SelectValue = (props) => <SelectPrimitive.Value data-slot="select-value" {...props} />

export function SelectTrigger({ className, children, ...props }) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn("flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-card px-3 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-destructive data-[placeholder]:text-muted-foreground [&>span]:truncate", className)}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="size-4 opacity-60" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

export function SelectContent({ className, children, position = "popper", ...props }) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        className={cn("relative z-50 max-h-72 min-w-32 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md", position === "popper" && "w-full min-w-[var(--radix-select-trigger-width)] translate-y-1", className)}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

export function SelectItem({ className, children, ...props }) {
  return (
    <SelectPrimitive.Item data-slot="select-item" className={cn("relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-2 pr-8 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted", className)} {...props}>
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}

export const SelectLabel = ({ className, ...props }) => <SelectPrimitive.Label className={cn("px-2 py-1.5 text-xs text-muted-foreground", className)} {...props} />
export const SelectSeparator = ({ className, ...props }) => <SelectPrimitive.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />
