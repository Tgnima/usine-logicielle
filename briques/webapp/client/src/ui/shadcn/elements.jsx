// Composants shadcn/ui (MIT) sans comportement, adaptés aux jetons de l'usine : champ, zone de
// texte, libellé, séparateur, squelette de chargement, table, interrupteur, case à cocher.
import { Checkbox as CheckboxPrimitive, Label as LabelPrimitive, Separator as SeparatorPrimitive, Switch as SwitchPrimitive } from "radix-ui"
import { CheckIcon } from "lucide-react"
import { cn } from "@/lib/utils"

const CHAMP = "w-full rounded-md border border-input bg-card px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-destructive"

export const Input = ({ className, type = "text", ...props }) => <input type={type} data-slot="input" className={cn(CHAMP, "h-9 py-1", className)} {...props} />
export const Textarea = ({ className, ...props }) => <textarea data-slot="textarea" className={cn(CHAMP, "min-h-20 py-2", className)} {...props} />
export const Label = ({ className, ...props }) => <LabelPrimitive.Root data-slot="label" className={cn("text-sm font-medium leading-none peer-disabled:opacity-50", className)} {...props} />

export const Separator = ({ className, orientation = "horizontal", decorative = true, ...props }) => (
  <SeparatorPrimitive.Root decorative={decorative} orientation={orientation} className={cn("shrink-0 bg-border", orientation === "horizontal" ? "h-px w-full" : "h-full w-px", className)} {...props} />
)

// Le squelette remplace le contenu pendant le chargement, à la même taille : la page ne saute pas.
export const Skeleton = ({ className, ...props }) => <div data-slot="skeleton" aria-hidden="true" className={cn("animate-pulse rounded-md bg-muted motion-reduce:animate-none", className)} {...props} />

export const Checkbox = ({ className, ...props }) => (
  <CheckboxPrimitive.Root data-slot="checkbox" className={cn("peer size-4 shrink-0 rounded-sm border border-input bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground", className)} {...props}>
    <CheckboxPrimitive.Indicator className="flex items-center justify-center">
      <CheckIcon className="size-3.5" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
)

export const Switch = ({ className, ...props }) => (
  <SwitchPrimitive.Root data-slot="switch" className={cn("peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input", className)} {...props}>
    <SwitchPrimitive.Thumb className="pointer-events-none block size-4 rounded-full bg-card shadow-sm transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0" />
  </SwitchPrimitive.Root>
)

export const Table = ({ className, ...props }) => (
  <div data-slot="table-container" className="relative w-full overflow-x-auto">
    <table data-slot="table" className={cn("w-full caption-bottom text-sm", className)} {...props} />
  </div>
)
export const TableHeader = ({ className, ...props }) => <thead className={cn("[&_tr]:border-b", className)} {...props} />
export const TableBody = ({ className, ...props }) => <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />
export const TableRow = ({ className, ...props }) => <tr className={cn("border-b border-border transition-colors data-[state=selected]:bg-muted", className)} {...props} />
export const TableHead = ({ className, ...props }) => <th scope="col" className={cn("h-10 whitespace-nowrap px-4 text-left align-middle text-xs font-medium text-muted-foreground", className)} {...props} />
export const TableCell = ({ className, ...props }) => <td className={cn("px-4 py-3 align-middle", className)} {...props} />
export const TableCaption = ({ className, ...props }) => <caption className={cn("mt-4 text-sm text-muted-foreground", className)} {...props} />
