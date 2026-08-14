# bb-plugin-claude-skills

Closes the gap between the slash commands Claude Code offers in its terminal and
the ones bb offers in its `/` menu.

## Why

bb builds its `/` menu by scanning the filesystem — `~/.claude/skills`,
`~/.claude/commands`, project `.claude/` directories, Claude Code plugin caches,
and bb's own skill roots. Claude Code's *built-in* commands are not files: they
are compiled into the CLI binary and their prompts are generated at runtime. bb
has nothing to scan, so `/simplify`, `/code-review`, `/run` and friends never
appear.

On this machine that was 22 commands in bb against 60 in a live Claude Code
session.

## How

Two mechanisms, neither of which requires patching bb:

**Discovery.** Claude Code's stream-json `system/init` message carries an
authoritative `slash_commands` array. The plugin spawns
`claude -p x --output-format stream-json --verbose --bare`, reads the init line,
and kills the process. `--bare` skips hooks, MCP, and plugin sync, so the probe
takes under a second and has no side effects. No API call is made.

**Delivery.** bb rescans a plugin's `skills/` directory live, with no reload. The
plugin generates one shim `SKILL.md` per mirrored command into its own `skills/`
directory, and they appear in bb's menu immediately, unprefixed, alongside
everything else.

Each shim is a few lines telling the agent to invoke the real built-in through
the Skill tool and to forward the user's arguments. bb stages plugin skills into
a Claude Code plugin named `bb-global-skills`, so the shim lands as
`bb-global-skills:simplify` and coexists with the real `simplify` rather than
shadowing it. Reimplementing the built-ins' prompts was never an option — Claude
Code generates them dynamically — so delegating is the only way to get the real
behaviour.

## What gets mirrored

Built-ins that produce work for the agent. `CURATED_DESCRIPTIONS` in `server.ts`
holds the ones with hand-checked descriptions (taken from Claude Code's own menu
text); `TERMINAL_ONLY_COMMANDS` excludes the terminal-UI and internal commands
(`/clear`, `/model`, `/config`, `/compact`, `/usage`, `__remote-workflow`, …)
that do nothing useful when sent to an agent as a prompt.

Anything the probe finds that is in neither list is mirrored with a generic
description and logged, so a Claude Code upgrade that adds a command surfaces it
in bb straight away and tells you to write a real description for it. A curated
command the probe stops seeing is logged as possibly stale.

The probe runs on load and hourly.

## Known limitations

- **Non-Claude-Code threads still see the entries.** bb's plugin skills are
  provider-agnostic, so the mirrored commands also appear in a codex thread's
  menu. Each shim ends by telling the agent to say the command is Claude
  Code-only and stop, so picking one degrades to a clear message rather than a
  wrong answer.
- **Single machine.** Discovery probes the `claude` on the bb server's PATH. A
  thread running on a different enrolled machine with a different Claude Code
  version is not accounted for. If the probe fails the plugin falls back to the
  curated list and logs a warning.
- **`--bare` hides auth-gated commands.** `/schedule` (cloud routines) is absent
  from a bare probe, so it is listed in `HIDDEN_FROM_BARE_PROBE` to suppress a
  false staleness warning.
- **Fresh environments only.** A busy environment keeps its staged skill catalog
  until a safe relaunch, so newly mirrored commands reach existing threads on
  their next relaunch rather than immediately.
