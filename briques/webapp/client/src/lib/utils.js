// cn() : assemble des classes Tailwind, la dernière l'emporte en cas de conflit
// (le même utilitaire que les composants shadcn/ui).
import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...entrees) {
  return twMerge(clsx(entrees))
}
