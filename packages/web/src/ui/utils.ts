import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Join class names, letting a later Tailwind utility beat an earlier one in the same group.
 *
 * The shadcn convention, and it is what makes a vendored component overridable at the call site:
 * `<Button className="h-5" />` has to win against the variant's own `h-6`, and plain string
 * concatenation would leave both in the attribute with the stylesheet's order deciding.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
