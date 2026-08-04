import { FieldNote } from "../ui/input";

/**
 * What this thing is and what to do with it, in the six lines it actually takes.
 *
 * Written once and shown in two places — the first-run screen, where it is the whole point, and the
 * help popover, where it is the answer to "wait, how does this work again?". A guide that only
 * appears before you have a factory is a guide nobody can re-read.
 *
 * Deliberately about *this* product's few real ideas rather than about Claude Code: a room is a
 * folder, an agent is a session standing in one, the bus is how they talk, limits pause them. Anyone
 * who has to be told what an LLM is is not the person opening a self-hosted orchestrator.
 */

/** One step: a number, a claim, and the sentence that makes the claim usable. */
function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <span
        className="mt-px flex size-4 shrink-0 items-center justify-center rounded-full border
          border-accent/50 bg-accent/12 text-[9px] font-semibold text-accent tabular-nums"
      >
        {n}
      </span>
      <span className="min-w-0">
        <span className="text-2xs font-semibold text-fg">{title}</span>
        <FieldNote className="mt-0.5">{children}</FieldNote>
      </span>
    </li>
  );
}

export function QuickGuide() {
  return (
    <ol className="space-y-2">
      <Step n={1} title="A factory is a folder">
        You point SuperFabric at a project you already have. It adds nothing to it except what you
        ask for — take SuperFabric away and it is still an ordinary repository.
      </Step>
      <Step n={2} title="An interview writes the project down">
        If the folder has no <code className="font-mono">CLAUDE.md</code>, an onboarding agent asks
        you one question at a time in the console on the right, then writes{" "}
        <code className="font-mono">CLAUDE.md</code> and <code className="font-mono">README.md</code>{" "}
        and proposes the first rooms. You approve them; it creates nothing on its own.
      </Step>
      <Step n={3} title="A room is a subfolder, an agent stands in one">
        Each room is a department with its own charter (its folder's{" "}
        <code className="font-mono">CLAUDE.md</code>). Agents you add there are Claude Code sessions
        working in that folder — pick what one arrives as with the role picker, and how much rope it
        has with the autonomy picker.
      </Step>
      <Step n={4} title="Rooms talk to each other on the belt">
        An agent sends another department a request with its{" "}
        <code className="font-mono">factory_*</code> tools; the message is stored, then delivered at
        the recipient's next turn boundary — never mid-thought. That is what the crates on the
        conveyors are.
      </Step>
      <Step n={5} title="The board is the work, the orchestrator routes it">
        Add a task with no room and the factory's senior agent decides where it belongs and says why.
        Nothing guesses on its behalf: a task nobody has routed stays visibly unassigned.
      </Step>
      <Step n={6} title="Accounts and limits">
        Add each Claude subscription in the accounts switcher — one folder per account, logged in
        from here. The monitor warns at 80 %, pauses agents at 95 % *at a turn boundary*, and brings
        them back when the window rolls. Nothing is ever moved between accounts.
      </Step>
    </ol>
  );
}
