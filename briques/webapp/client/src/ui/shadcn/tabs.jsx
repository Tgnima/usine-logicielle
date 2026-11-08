// Composant shadcn/ui (MIT), adapté aux jetons de l'usine : des onglets (flèches au clavier).
import { Tabs as TabsPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"

export const Tabs = ({ className, ...props }) => <TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col gap-3", className)} {...props} />
export const TabsList = ({ className, ...props }) => <TabsPrimitive.List data-slot="tabs-list" className={cn("inline-flex h-9 w-fit max-w-full items-center overflow-x-auto rounded-lg bg-muted p-1 text-muted-foreground", className)} {...props} />
export const TabsTrigger = ({ className, ...props }) => (
  <TabsPrimitive.Trigger
    data-slot="tabs-trigger"
    className={cn("inline-flex h-full items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-sm", className)}
    {...props}
  />
)
export const TabsContent = ({ className, ...props }) => <TabsPrimitive.Content data-slot="tabs-content" className={cn("outline-none", className)} {...props} />
