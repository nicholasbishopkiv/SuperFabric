# Roles

A **role** is what an agent arrives as: a charter appended to its system prompt, the skills copied
into its room, and — where the operator has not said otherwise — a model and an autonomy mode.

A role is a **file**, not a database row, because it is content: something to read, diff, fork and
keep in your own repository. This directory holds the ten SuperFabric ships. Yours go in
`<data dir>/roles/*.yaml` (by default `.fabrica/roles/`) and **override these by `id`** — same id,
your file wins; new id, a new entry in the picker. An edited file is picked up without restarting the
server.

## The format

```yaml
id: architect                 # required · lowercase letters, digits and dashes
name: Architect               # required · what the picker shows
summary: Shape, not code.     # required · one line, beside the name
promptAppend: |               # required · the charter (see "Writing one" below)
  You are the **architect** in this room.
  …

model: claude-opus-5          # optional · a *suggestion*; a model the operator pinned always wins
autonomy: attended            # optional · applied only when the agent is created, never after
skills:                       # optional · directory names, resolved against this machine
  - test-driven-development
mcpServers:                   # optional · stdio / http / sse only
  playwright:
    type: stdio
    command: npx
    args: ["-y", "@playwright/mcp@latest"]
allowedTools:                 # optional · an AUTO-ALLOW list, i.e. a privilege grant
  - mcp__playwright__browser_navigate
```

**Unknown fields are an error, not a shrug.** `skill:` where you meant `skills:` fails the file and
is reported by name, rather than silently shipping a role whose whole point never arrives. So is a
file that is not valid YAML, and so are two files in one directory claiming the same `id`.

## Writing one

- **A charter, not a manual.** Say what the role owns, what it must not do, and how it hands off.
  Every turn that agent ever takes pays for this text. The ten here are 500–750 characters; the
  orchestrator's own prompt (`packages/server/src/orchestrator.ts`) is the worked example.
- **Say the boundary out loud.** "Not yours: …" is the half that stops two rooms doing one job twice.
- **Do not invent skill names.** `skills` entries are directory names resolved against the skill
  directories on the machine — `~/.claude/skills/`, and installed plugin packs under
  `~/.claude/plugins/cache/…/skills/` (override the search path with `SUPERFABRIC_SKILL_PATH`). A name
  nothing resolves is reported in the agent's own log, but a role that promises a skill it cannot
  deliver is still worse than one that promises none. If no real skill fits, ship without.
- **Reserve the capable model for judgement.** Two of the ten pin Opus (architect, security); one
  pins nothing at all and runs on whatever your CLI is set to.

## What applying one does

- The charter is appended to the system prompt. An orchestrator keeps *its* charter as well — the
  two are joined, seat first.
- The model applies only if the operator pinned none. Pinning one later always wins; clearing the pin
  hands the decision back to the role.
- `mcpServers` are merged with the factory's own in-process bus, **which is never removed** — a role
  that names a server `factory` loses the collision. Everything a role brings is outside-facing and
  stays gated by the operator's approval flow; `allowedTools` is how you opt a specific tool out of
  that, and it is the one field here that hands out a privilege.
- Skills are copied into `<room>/.claude/skills/<name>/`, so a plain `claude` session in that folder
  gets them too. **A directory already there is never touched** — delete it if you want a fresh copy.
- `autonomy` applies when the agent is created and never afterwards: changing an agent's role from a
  dropdown must not change what it is allowed to do.
