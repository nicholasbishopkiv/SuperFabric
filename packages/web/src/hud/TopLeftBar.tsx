import { CircleHelpIcon } from "lucide-react";
import { useHudInsets } from "../store";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { AccountSwitcher } from "./AccountSwitcher";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { QuickGuide } from "./QuickGuide";

/**
 * The two controls in the top-left strip: which factory this tab is looking at, and whose
 * subscriptions it can spend.
 *
 * They are neighbours because they answer neighbouring questions, and because the account surface
 * had to go *somewhere* — a fourth edge panel for a list that is usually three rows long would cost
 * a permanent hole in the floor. This wrapper owns the placing so neither control has to: the room
 * panel measures itself into `hudInsets.left`, and sitting past it is what keeps this row out of the
 * panel's way when it is open and hard against the edge when it is collapsed.
 */
export function TopLeftBar() {
  const insets = useHudInsets();
  return (
    <div className="fixed top-3 z-40 flex items-center gap-2" style={{ left: insets.left + 12 }}>
      <ProjectSwitcher />
      <AccountSwitcher />
      {/* The same six lines the first-run screen opens with. A guide you can only read before you
          have a factory is a guide nobody can re-read, and this is the one row always on screen. */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="bg-panel/80 backdrop-blur-xl"
            title="How SuperFabric works"
            aria-label="How SuperFabric works"
          >
            <CircleHelpIcon className="text-fg-faint" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="max-h-[70vh] w-[min(460px,90vw)] overflow-y-auto">
          <QuickGuide />
        </PopoverContent>
      </Popover>
    </div>
  );
}
