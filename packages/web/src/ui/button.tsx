import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { Hint } from "./tooltip";
import { cn } from "./utils";

/**
 * The HUD's button. shadcn's shape (cva variants, `asChild`), sized for an instrument panel rather
 * than for a web page: the largest button here is 28px tall, which is two steps under shadcn's own
 * default. Density is the whole reason the panels can show three sections at once.
 *
 * `variant` is a *meaning*, not a colour:
 *
 * | variant | what it is for |
 * |---|---|
 * | `outline` | the default — an action that changes something, on a visible surface |
 * | `accent` | the primary action of a form, in the one colour the HUD points with |
 * | `ghost` | chrome: toggles, dismissals, anything that is not itself a change |
 * | `danger` | destructive or refusing (`Deny`) |
 * | `chip` | a selectable item in a strip (session tabs, room links) |
 */
const buttonVariants = cva(
  "inline-flex select-none items-center justify-center whitespace-nowrap rounded-[3px] font-medium " +
    "transition-colors outline-none focus-visible:ring-1 focus-visible:ring-accent " +
    "disabled:pointer-events-none disabled:opacity-40 " +
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        outline:
          "border border-line bg-panel-raised/80 text-fg hover:border-line-strong hover:bg-panel-raised",
        accent:
          "border border-accent/50 bg-accent/15 text-accent hover:border-accent hover:bg-accent/25",
        ghost: "text-fg-muted hover:bg-fg/8 hover:text-fg",
        danger:
          "border border-status-error/50 bg-status-error/12 text-status-error hover:bg-status-error/22",
        chip: "border border-line bg-transparent text-fg-muted hover:border-line-strong hover:text-fg " +
          "data-[active=true]:border-accent/70 data-[active=true]:bg-accent/12 data-[active=true]:text-accent",
      },
      size: {
        xs: "h-5.5 gap-1 px-1.5 text-2xs [&_svg]:size-3",
        sm: "h-6.5 gap-1.5 px-2 text-xs [&_svg]:size-3.5",
        md: "h-7 gap-1.5 px-2.5 text-sm [&_svg]:size-3.5",
        icon: "size-6 [&_svg]:size-3.5",
        "icon-xs": "size-4.5 [&_svg]:size-3",
      },
    },
    defaultVariants: { variant: "outline", size: "sm" },
  },
);

export type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean };

/**
 * `title` is not passed through to the DOM: it becomes a real tooltip.
 *
 * The wrapping happens **inside** the button rather than at the call site, and that is what makes
 * `<PopoverTrigger asChild><Button title="…"/></PopoverTrigger>` keep working — Radix still clones
 * the `Button` element and its injected props still land on the real `<button>`, because `Hint` sits
 * under them rather than between them. Wrapping the other way round would have put a plain function
 * component in the middle of that chain and quietly dropped the trigger's handlers and ref.
 */
export function Button({ className, variant, size, asChild = false, title, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  const button = (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
  return <Hint text={title}>{button}</Hint>;
}

export { buttonVariants };
