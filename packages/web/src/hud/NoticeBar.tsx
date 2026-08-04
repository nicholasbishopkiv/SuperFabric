import { AlertTriangleIcon, CheckIcon, XIcon } from "lucide-react";
import { useFabric, useHudInsets } from "../store";
import { Button } from "../ui/button";
import { cn } from "../ui/utils";

/**
 * **The one place the server speaks.**
 *
 * Before this, `lastError` was rendered by the room panel, by the console drawer *and* by the
 * project switcher, and `lastNotice` by the console alone. Three panels showing the same string
 * meant an operator with two panels open read the same failure twice and, worse, a failure raised
 * from a collapsed panel was invisible. With three edges and a floor in the middle, "next to the
 * form that caused it" stopped being a place that exists.
 *
 * So: one line, centred in the strip the panels leave free, over the floor. It is the same strip
 * the camera frames into, so it lands on the factory rather than on a panel, and it is the first
 * thing the eye reaches for because nothing else is up there.
 *
 * Two facts, never merged and never the same colour — the protocol has two messages and they mean
 * opposite things. `error` is the floor's red, `notice` its green; the HUD does not own either
 * (see `scene/palette.ts`). An error outranks a notice, because a stale "it worked" over a fresh
 * failure is a lie.
 *
 * What stays local to a panel: a *field's* own validation ("that is not a usable folder name"),
 * which is the browser answering, not the server. Those never travelled through the store and
 * belong next to the box you typed in.
 */
export function NoticeBar() {
  const lastError = useFabric((s) => s.lastError);
  const lastNotice = useFabric((s) => s.lastNotice);
  const clearError = useFabric((s) => s.clearError);
  const clearNotice = useFabric((s) => s.clearNotice);
  const insets = useHudInsets();

  const error = lastError !== null;
  const message = lastError ?? lastNotice;
  if (message === null) return null;

  return (
    <div
      // Never intercepts the pointer as a whole: it spans the free strip, which is exactly the part
      // of the floor the operator drags. Only the pill itself takes events back.
      // A second row under the project switcher rather than beside it: the switcher is anchored to
      // the strip's left edge and grows with the factory's name, so anything sharing that row would
      // sooner or later land on top of it.
      className="pointer-events-none fixed top-14 z-40 flex justify-center px-3"
      style={{ left: insets.left, right: insets.right }}
    >
      <div
        data-testid="notice-bar"
        role={error ? "alert" : "status"}
        className={cn(
          "pointer-events-auto flex max-w-[min(640px,100%)] items-start gap-2 rounded-[4px] border",
          "bg-panel/85 py-1.5 pl-2.5 pr-1.5 text-xs shadow-[0_8px_28px_rgba(0,0,0,0.5)] backdrop-blur-xl",
          error
            ? "border-status-error/60 text-status-error"
            : "border-status-working/50 text-status-working",
        )}
      >
        {error ? (
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
        ) : (
          <CheckIcon className="mt-0.5 size-3.5 shrink-0" />
        )}
        <span className="min-w-0 break-words">{message}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0"
          aria-label="Dismiss"
          title="Dismiss"
          onClick={() => (error ? clearError() : clearNotice())}
        >
          <XIcon />
        </Button>
      </div>
    </div>
  );
}
