import { Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { cn } from "../ui/utils";

/**
 * A delete that has to be asked twice, and that says what it is about to destroy in between.
 *
 * Every removal in this product is irreversible and some of them take history with them, so the
 * pattern is the same everywhere: one click **arms** the control and replaces it with the
 * consequence in words plus a confirm; the second click sends. There is no modal dialog — the HUD
 * has none anywhere, and a dialog over a 3D floor is a hole in the view — and no "type the name to
 * confirm", which reads as ceremony rather than as information.
 *
 * The two things that make this honest rather than decorative:
 *
 * - **`what` is the consequence, not the object.** "Removes it and 3 agents, with everything they
 *   said. The folder stays." — not "Are you sure?". The caller computes it from state it already
 *   holds, so the count is this factory's, now.
 * - **Armed is a state you can leave.** Escape and clicking away disarm it, so the dangerous button
 *   is never the one left under the pointer.
 */
export function ConfirmDelete({
  what,
  title,
  confirmLabel = "Delete",
  label,
  onConfirm,
  disabled = false,
  size = "icon-xs",
  className,
}: {
  /** One sentence naming what will be destroyed and what will survive. Shown only while armed. */
  what: string;
  /** Tooltip on the resting control. */
  title: string;
  /** Text of the armed button. */
  confirmLabel?: string;
  /** Text beside the icon at rest. Omitted => an icon-only control, for a dense row. */
  label?: string;
  onConfirm: () => void;
  disabled?: boolean;
  size?: "xs" | "icon-xs";
  className?: string;
}) {
  const [armed, setArmed] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Escape and a click outside both disarm. Bound only while armed, so a panel full of these costs
  // nothing at rest.
  useEffect(() => {
    if (!armed) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") setArmed(false);
    }
    function onDown(e: MouseEvent): void {
      if (box.current !== null && !box.current.contains(e.target as Node)) setArmed(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [armed]);

  // A control that goes disabled (the socket dropped) must not stay armed: the confirm would sit
  // there looking clickable and do nothing.
  useEffect(() => {
    if (disabled) setArmed(false);
  }, [disabled]);

  if (!armed) {
    return (
      <Button
        size={size}
        variant="ghost"
        className={cn("text-fg-faint hover:text-status-error", className)}
        onClick={() => setArmed(true)}
        disabled={disabled}
        title={title}
        aria-label={label ?? title}
      >
        <Trash2Icon />
        {label}
      </Button>
    );
  }

  return (
    <div
      ref={box}
      className={cn(
        "flex flex-wrap items-center gap-1.5 rounded-[3px] border border-status-error/40",
        "bg-status-error/8 px-1.5 py-1",
        className,
      )}
    >
      <span className="min-w-0 text-2xs text-status-error">{what}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <Button
          size="xs"
          variant="danger"
          onClick={() => {
            setArmed(false);
            onConfirm();
          }}
          disabled={disabled}
        >
          {confirmLabel}
        </Button>
        <Button size="xs" variant="ghost" onClick={() => setArmed(false)}>
          Cancel
        </Button>
      </span>
    </div>
  );
}
