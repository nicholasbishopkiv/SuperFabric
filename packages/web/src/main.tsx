import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { installHudTokens } from "./hud/tokens";
import { TooltipProvider } from "./ui/tooltip";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

// Before the first paint: the stylesheet's semantic colours are `var(--sf-…)` references to the
// floor's own palette, and an unset variable is an invalid colour rather than a subtly wrong one.
installHudTokens();

createRoot(root).render(
  <StrictMode>
    {/* One provider for the whole HUD: Radix requires an ancestor, and sharing it is what makes the
        delay group work — moving between two adjacent controls shows the second tooltip at once
        instead of waiting out the delay again. */}
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </StrictMode>,
);
