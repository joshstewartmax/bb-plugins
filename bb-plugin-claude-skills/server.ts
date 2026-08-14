import type { BbPluginApi } from "@bb/plugin-sdk";
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROBE_TIMEOUT_MS = 20_000;

const moduleDir = dirname(fileURLToPath(import.meta.url));
const packageRoot =
  basename(moduleDir) === "dist" ? dirname(moduleDir) : moduleDir;
const skillsDir = join(packageRoot, "skills");

const CURATED_DESCRIPTIONS: Record<string, string> = {
  batch: "Plan a large change; background agents each open a PR",
  "claude-api": "Build and debug apps that use the Claude API",
  "code-review": "Review the current diff or a PR for bugs and cleanups",
  dataviz: "Chart and dashboard design guidance",
  debug: "Turn on debug logging and investigate problems",
  "fewer-permission-prompts":
    "Pre-approve safe read-only commands based on your usage",
  init: "Initialize a new CLAUDE.md file with codebase documentation",
  loop: "Repeat a prompt or command on an interval (e.g. /loop 5m /foo)",
  run: "Launch this project's app to see your change working",
  schedule: "Create and manage routines: cloud agents on a schedule",
  "security-review":
    "Complete a security review of the pending changes on the current branch",
  simplify: "Clean up the changed code without changing behavior",
  "update-config": "Change settings: hooks, permissions, environment variables",
};

const HIDDEN_FROM_BARE_PROBE = new Set(["schedule"]);

const TERMINAL_ONLY_COMMANDS = new Set([
  "__remote-workflow",
  "agents",
  "autocompact",
  "clear",
  "color",
  "compact",
  "config",
  "context",
  "design",
  "design-consent",
  "design-revoke",
  "design-sync",
  "doctor",
  "effort",
  "extra-usage",
  "fast",
  "goal",
  "heapdump",
  "import",
  "insights",
  "list-agents",
  "mcp",
  "model",
  "recap",
  "reload-skills",
  "rename",
  "run-skill-generator",
  "team-onboarding",
  "usage",
  "usage-credits",
  "workflow-launch-exec",
]);

function shimContent(name: string, description: string): string {
  return `---
name: ${name}
description: ${JSON.stringify(description)}
---

# /${name}

Claude Code ships \`${name}\` as a built-in command. bb surfaces it here so it
appears in the skill menu; this file only forwards to the real thing.

Invoke it with the Skill tool, passing along whatever the user typed after the
command:

    Skill(skill: "${name}", args: "<the user's arguments, or empty>")

The built-in builds its own prompt and owns the whole workflow. Do not
summarise it, substitute your own version, or start the work directly.

If the Skill tool reports no \`${name}\` skill, this thread is not running
Claude Code. Say the command is Claude Code-only and stop.
`;
}

function probeBuiltinCommands(): Promise<string[] | null> {
  return new Promise((resolve) => {
    const child = spawn(
      "claude",
      ["-p", "x", "--output-format", "stream-json", "--verbose", "--bare"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );

    let settled = false;
    const finish = (commands: string[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(commands);
    };

    const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    child.on("error", () => finish(null));
    child.on("exit", () => finish(null));

    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message?.subtype === "init" && Array.isArray(message.slash_commands))
          finish(message.slash_commands);
      }
    });
  });
}

function resolveMirroredCommands(
  bb: BbPluginApi,
  probed: string[] | null,
): Map<string, string> {
  const mirrored = new Map(Object.entries(CURATED_DESCRIPTIONS));
  if (!probed) {
    bb.log.warn(
      "Could not read the claude CLI's command list; mirroring the curated set only.",
    );
    return mirrored;
  }

  const builtins = new Set(probed);
  for (const name of Object.keys(CURATED_DESCRIPTIONS)) {
    if (!builtins.has(name) && !HIDDEN_FROM_BARE_PROBE.has(name))
      bb.log.warn(
        `Claude Code no longer advertises /${name}; its bb entry may be stale.`,
      );
  }
  for (const name of probed) {
    if (mirrored.has(name) || TERMINAL_ONLY_COMMANDS.has(name)) continue;
    mirrored.set(name, `Claude Code built-in command /${name}.`);
    bb.log.info(
      `Mirroring newly discovered /${name} with a generic description — add it to CURATED_DESCRIPTIONS for a real one.`,
    );
  }
  return mirrored;
}

async function writeShims(mirrored: Map<string, string>): Promise<void> {
  await mkdir(skillsDir, { recursive: true });

  const existing = await readdir(skillsDir, { withFileTypes: true });
  for (const entry of existing) {
    if (entry.isDirectory() && !mirrored.has(entry.name))
      await rm(join(skillsDir, entry.name), { recursive: true, force: true });
  }

  for (const [name, description] of mirrored) {
    const file = join(skillsDir, name, "SKILL.md");
    const content = shimContent(name, description);
    if ((await readFile(file, "utf8").catch(() => null)) === content) continue;
    await mkdir(join(skillsDir, name), { recursive: true });
    await writeFile(file, content, "utf8");
  }
}

export default async function plugin(bb: BbPluginApi) {
  async function sync() {
    const mirrored = resolveMirroredCommands(bb, await probeBuiltinCommands());
    await writeShims(mirrored);
    bb.log.info(
      `Mirrored ${mirrored.size} Claude Code built-in commands into bb's skill menu.`,
    );
  }

  bb.background.service("initial-sync", { start: sync });
  bb.background.schedule("refresh", "37 * * * *", sync);
}
