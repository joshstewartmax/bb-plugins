import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const FALLBACK_PROJECT = { prefix: "JIRA", name: "Jira (no epic)" };
const DEFAULT_JQL =
  "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";
const SNAPSHOT_PREFIX = "issue:";
const FIELDS = "summary,status,priority,duedate,issuetype,parent,description";
const MAX_DESCRIPTION_CHARS = 20_000;

type TaskStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "canceled";

interface JiraIssue {
  key: string;
  fields?: {
    summary?: string;
    duedate?: string | null;
    status?: { name?: string; statusCategory?: { key?: string } };
    priority?: { name?: string };
    issuetype?: { name?: string; hierarchyLevel?: number };
    parent?: JiraIssue;
    description?: unknown;
  };
}

interface MappedIssue {
  key: string;
  title: string;
  status: TaskStatus;
  priority: string;
  due: string | null;
  description: string;
  isEpic: boolean;
  parent: MappedIssue | null;
}

interface Snapshot {
  taskKey: string;
  prefix: string;
  fingerprint: string;
  status: TaskStatus;
}

interface SyncSummary {
  at: string;
  ok: boolean;
  created: number;
  updated: number;
  failed?: number;
  total: number;
  error?: string;
}

interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  jql: string;
}

function resolveBbCommand(): { command: string; prefixArgs: string[] } {
  const fromEnv = process.env.BB_CLI;
  if (fromEnv && existsSync(fromEnv)) {
    return { command: process.execPath, prefixArgs: [fromEnv] };
  }
  const serverEntry = process.argv[1];
  if (serverEntry) {
    const derived = resolve(dirname(serverEntry), "../../host-daemon/dist/bb");
    if (existsSync(derived)) {
      return { command: process.execPath, prefixArgs: [derived] };
    }
  }
  return { command: "bb", prefixArgs: [] };
}

async function runBbJson(args: string[]): Promise<any> {
  const { command, prefixArgs } = resolveBbCommand();
  const { stdout } = await execFileAsync(
    command,
    [...prefixArgs, ...args, "--json"],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

async function searchJira(config: JiraConfig, jql: string): Promise<JiraIssue[]> {
  const auth = Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");
  const issues: JiraIssue[] = [];
  let nextPageToken: string | undefined;
  do {
    const url = new URL("/rest/api/3/search/jql", config.baseUrl);
    url.searchParams.set("jql", jql);
    url.searchParams.set("fields", FIELDS);
    url.searchParams.set("maxResults", "100");
    if (nextPageToken) url.searchParams.set("nextPageToken", nextPageToken);
    const response = await fetch(url, {
      headers: { authorization: `Basic ${auth}`, accept: "application/json" },
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 300);
      throw new Error(`Jira search failed (${response.status}): ${body}`);
    }
    const page = (await response.json()) as {
      issues?: JiraIssue[];
      nextPageToken?: string;
    };
    issues.push(...(page.issues ?? []));
    nextPageToken = page.nextPageToken;
  } while (nextPageToken);
  return issues;
}

function isEpicIssue(issue: JiraIssue): boolean {
  const type = issue.fields?.issuetype;
  if (type?.hierarchyLevel != null) return type.hierarchyLevel === 1;
  return type?.name === "Epic";
}

function mapStatus(status: NonNullable<JiraIssue["fields"]>["status"]): TaskStatus {
  if (/cancel/i.test(status?.name ?? "")) return "canceled";
  const category = status?.statusCategory?.key;
  if (category === "done") return "done";
  if (category === "new") return "todo";
  return /review/i.test(status?.name ?? "") ? "in_review" : "in_progress";
}

const PRIORITY_MAP: Record<string, string> = {
  Highest: "urgent",
  High: "high",
  Medium: "medium",
  Low: "low",
  Lowest: "low",
};

function mapIssue(issue: JiraIssue): MappedIssue {
  const fields = issue.fields ?? {};
  return {
    key: issue.key,
    title: `${issue.key}: ${fields.summary ?? "(no summary)"}`,
    status: mapStatus(fields.status),
    priority: PRIORITY_MAP[fields.priority?.name ?? ""] ?? "none",
    due: fields.duedate ?? null,
    description: adfToMarkdown(fields.description),
    isEpic: isEpicIssue(issue),
    parent:
      fields.parent && isEpicIssue(fields.parent) ? mapIssue(fields.parent) : null,
  };
}

function projectPrefixFor(jiraKey: string): string {
  const compact = jiraKey.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (compact.length <= 10) return compact;
  const parts = compact.match(/^([A-Z]+)(\d+)$/);
  if (parts && parts[2].length < 10) {
    return parts[1].slice(0, 10 - parts[2].length) + parts[2];
  }
  return compact.slice(0, 10);
}

function fingerprint(issue: MappedIssue, prefix: string): string {
  return createHash("sha1")
    .update(
      JSON.stringify([
        issue.title,
        issue.status,
        issue.priority,
        issue.due,
        issue.description,
        prefix,
      ]),
    )
    .digest("hex");
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function adfToMarkdown(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  return renderBlocks((value as any).content, "").trim();
}

function renderBlocks(nodes: unknown, indent: string): string {
  if (!Array.isArray(nodes)) return "";
  return nodes
    .map((node) => renderBlock(node, indent))
    .filter(Boolean)
    .join("\n\n");
}

function renderBlock(node: any, indent: string): string {
  switch (node?.type) {
    case "paragraph":
      return indent + renderInline(node.content);
    case "heading": {
      const level = Math.min(Math.max(node.attrs?.level ?? 1, 1), 6);
      return indent + "#".repeat(level) + " " + renderInline(node.content);
    }
    case "bulletList":
      return renderList(node.content, indent, () => "- ");
    case "orderedList":
      return renderList(node.content, indent, (_item, i) => `${i + 1}. `);
    case "taskList":
      return renderList(node.content, indent, (item) =>
        item?.attrs?.state === "DONE" ? "- [x] " : "- [ ] ",
      );
    case "codeBlock":
      return (
        indent +
        "```" +
        (node.attrs?.language ?? "") +
        "\n" +
        renderInline(node.content) +
        "\n" +
        indent +
        "```"
      );
    case "blockquote":
      return renderBlocks(node.content, indent)
        .split("\n")
        .map((line) => indent + "> " + line.slice(indent.length))
        .join("\n");
    case "rule":
      return indent + "---";
    case "mediaSingle":
    case "mediaGroup":
      return indent + "_(attachment)_";
    case "table":
      return renderTable(node, indent);
    default:
      if (Array.isArray(node?.content)) return renderBlocks(node.content, indent);
      return node ? indent + renderInline([node]) : "";
  }
}

function renderList(
  items: unknown,
  indent: string,
  bullet: (item: any, index: number) => string,
): string {
  if (!Array.isArray(items)) return "";
  return items
    .map((item, index) => {
      const marker = bullet(item, index);
      const body = renderBlocks(item?.content, "");
      const [first, ...rest] = body.split("\n");
      const continuation = rest
        .map((line) => "\n" + indent + " ".repeat(marker.length) + line)
        .join("");
      return indent + marker + (first ?? "") + continuation;
    })
    .join("\n");
}

function renderTable(node: any, indent: string): string {
  const rows: string[] = [];
  for (const [rowIndex, row] of (node.content ?? []).entries()) {
    const cells = (row?.content ?? []).map((cell: any) =>
      renderBlocks(cell?.content, "").replace(/\n+/g, " ").trim(),
    );
    rows.push(indent + "| " + cells.join(" | ") + " |");
    if (rowIndex === 0) {
      rows.push(indent + "|" + cells.map(() => " --- ").join("|") + "|");
    }
  }
  return rows.join("\n");
}

function renderInline(nodes: unknown): string {
  if (!Array.isArray(nodes)) return "";
  return nodes
    .map((node: any) => {
      switch (node?.type) {
        case "text": {
          let text: string = node.text ?? "";
          const marks: any[] = node.marks ?? [];
          const link = marks.find((mark) => mark.type === "link");
          if (marks.some((mark) => mark.type === "code")) text = "`" + text + "`";
          if (marks.some((mark) => mark.type === "strong")) text = `**${text}**`;
          if (marks.some((mark) => mark.type === "em")) text = `*${text}*`;
          if (marks.some((mark) => mark.type === "strike")) text = `~~${text}~~`;
          if (link?.attrs?.href) text = `[${text}](${link.attrs.href})`;
          return text;
        }
        case "hardBreak":
          return "\n";
        case "mention":
          return node.attrs?.text ?? "@unknown";
        case "emoji":
          return node.attrs?.text ?? node.attrs?.shortName ?? "";
        case "inlineCard":
          return node.attrs?.url ? `<${node.attrs.url}>` : "";
        case "status":
          return node.attrs?.text ?? "";
        case "date": {
          const timestamp = Number(node.attrs?.timestamp);
          return Number.isFinite(timestamp)
            ? new Date(timestamp).toISOString().slice(0, 10)
            : "";
        }
        default:
          return Array.isArray(node?.content) ? renderInline(node.content) : "";
      }
    })
    .join("");
}

const IGNORE_PREFIX = "ignore:";

const deleteResult = z.object({ ok: z.boolean(), error: z.string().nullable() });

export const rpcContract = defineRpcContract({
  listProjects: {
    input: z.null(),
    output: z.object({
      projects: z.array(
        z.object({
          id: z.string(),
          prefix: z.string(),
          name: z.string(),
          tasks: z.array(
            z.object({
              id: z.string(),
              key: z.string(),
              status: z.string(),
              title: z.string(),
            }),
          ),
        }),
      ),
    }),
  },
  deleteTask: {
    input: z.object({ taskId: z.string(), taskKey: z.string() }).strict(),
    output: deleteResult,
  },
  deleteProject: {
    input: z.object({ projectId: z.string() }).strict(),
    output: deleteResult,
  },
  syncNow: {
    input: z.null(),
    output: z.object({ message: z.string() }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    baseUrl: {
      type: "string",
      label: "Jira base URL (e.g. https://yourorg.atlassian.net)",
      default: "",
    },
    email: { type: "string", label: "Jira account email", default: "" },
    apiToken: { type: "string", label: "Jira API token", secret: true },
    jql: { type: "string", label: "JQL filter", default: DEFAULT_JQL },
  });

  async function getConfig(): Promise<JiraConfig | null> {
    const { baseUrl, email, apiToken, jql } = await settings.get();
    if (!baseUrl || !email || !apiToken) return null;
    return { baseUrl, email, apiToken, jql: jql || DEFAULT_JQL };
  }

  function buildDescription(config: JiraConfig, issue: MappedIssue): string {
    const link = `Synced from Jira: [${issue.key}](${config.baseUrl.replace(/\/$/, "")}/browse/${issue.key})`;
    let body = issue.description;
    if (body.length > MAX_DESCRIPTION_CHARS) {
      body = body.slice(0, MAX_DESCRIPTION_CHARS) + "\n\n_(truncated)_";
    }
    return body ? `${link}\n\n---\n\n${body}` : link;
  }

  async function loadSnapshots(): Promise<Map<string, Snapshot>> {
    const snapshots = new Map<string, Snapshot>();
    for (const kvKey of await bb.storage.kv.list(SNAPSHOT_PREFIX)) {
      const snapshot = await bb.storage.kv.get<Snapshot>(kvKey);
      if (snapshot) snapshots.set(kvKey.slice(SNAPSHOT_PREFIX.length), snapshot);
    }
    return snapshots;
  }

  async function loadIgnoredKeys(): Promise<Set<string>> {
    const keys = await bb.storage.kv.list(IGNORE_PREFIX);
    return new Set(keys.map((key) => key.slice(IGNORE_PREFIX.length)));
  }

  async function ignoreAndForget(jiraKey: string): Promise<void> {
    await bb.storage.kv.delete(SNAPSHOT_PREFIX + jiraKey);
    await bb.storage.kv.set(IGNORE_PREFIX + jiraKey, true);
  }

  async function tasksRpc(
    method: string,
    payload: unknown,
  ): Promise<{ ok: boolean; error: string | null }> {
    const response = await fetch(
      `${bb.server.loopbackBaseUrl}/api/v1/plugins/tasks/rpc/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    const envelope = (await response.json().catch(() => null)) as any;
    if (!envelope?.ok) {
      return {
        ok: false,
        error:
          envelope?.error?.message ??
          `tasks ${method} failed (HTTP ${response.status})`,
      };
    }
    if (envelope.result && envelope.result.ok === false) {
      return {
        ok: false,
        error: envelope.result.error?.message ?? `tasks ${method} refused`,
      };
    }
    return { ok: true, error: null };
  }

  let syncing = false;

  async function runSync(): Promise<SyncSummary> {
    if (syncing) throw new Error("sync already in progress");
    syncing = true;
    const at = new Date().toISOString();
    try {
      const config = await getConfig();
      if (!config) {
        throw Object.assign(
          new Error(
            "Set baseUrl, email, and apiToken with `bb plugin config jira-sync`, then reload.",
          ),
          { name: "NeedsConfigurationError" },
        );
      }

      const projects = new Map<string, { name: string }>();
      const listed = (await runBbJson(["tasks", "project", "list"])) as {
        projects: Array<{ prefix: string; name: string }>;
      };
      for (const project of listed.projects) {
        projects.set(project.prefix, { name: project.name });
      }

      async function ensureProject(prefix: string, name: string): Promise<void> {
        const existing = projects.get(prefix);
        if (!existing) {
          await runBbJson([
            "tasks",
            "project",
            "create",
            "--name",
            name,
            "--prefix",
            prefix,
          ]);
          projects.set(prefix, { name });
        } else if (existing.name !== name) {
          await runBbJson(["tasks", "project", "update", prefix, "--name", name]);
          projects.set(prefix, { name });
        }
      }

      const snapshots = await loadSnapshots();
      const ignoredKeys = await loadIgnoredKeys();

      const counters = { created: 0, updated: 0, failed: 0 };
      const touched = new Set<string>();

      async function upsertIssue(issue: MappedIssue, prefix: string): Promise<void> {
        touched.add(issue.key);
        if (ignoredKeys.has(issue.key)) return;
        let snapshot = snapshots.get(issue.key);
        const isTerminal = issue.status === "done" || issue.status === "canceled";
        if (!snapshot && isTerminal) return;
        if (snapshot && isTerminal) prefix = snapshot.prefix;
        const nextFingerprint = fingerprint(issue, prefix);
        if (snapshot && snapshot.fingerprint === nextFingerprint) return;

        if (snapshot && snapshot.prefix !== prefix) {
          await runBbJson([
            "tasks",
            "update",
            snapshot.taskKey,
            "--status",
            "canceled",
            "--title",
            `${issue.title} (moved to ${prefix})`,
          ]);
          snapshot = undefined;
        }

        let taskKey: string;
        if (!snapshot) {
          const created = (await runBbJson([
            "tasks",
            "create",
            "--project",
            prefix,
            "--title",
            issue.title,
            "--description",
            buildDescription(config!, issue),
            "--priority",
            issue.priority,
            ...(issue.due ? ["--due", issue.due] : []),
          ])) as { task: { key: string } };
          taskKey = created.task.key;
          if (issue.status !== "backlog") {
            await runBbJson(["tasks", "update", taskKey, "--status", issue.status]);
          }
          counters.created++;
        } else {
          taskKey = snapshot.taskKey;
          await runBbJson([
            "tasks",
            "update",
            taskKey,
            "--title",
            issue.title,
            "--status",
            issue.status,
            "--priority",
            issue.priority,
            "--description",
            buildDescription(config!, issue),
            ...(issue.due ? ["--due", issue.due] : ["--no-due"]),
          ]);
          counters.updated++;
        }

        const next: Snapshot = {
          taskKey,
          prefix,
          fingerprint: nextFingerprint,
          status: issue.status,
        };
        snapshots.set(issue.key, next);
        await bb.storage.kv.set(SNAPSHOT_PREFIX + issue.key, next);
      }

      async function processIssue(issue: MappedIssue): Promise<void> {
        try {
          if (issue.isEpic) {
            const prefix = projectPrefixFor(issue.key);
            await ensureProject(prefix, issue.title);
            await upsertIssue(issue, prefix);
            return;
          }
          let prefix = FALLBACK_PROJECT.prefix;
          if (issue.parent) {
            prefix = projectPrefixFor(issue.parent.key);
            await ensureProject(prefix, issue.parent.title);
            if (!snapshots.has(issue.parent.key)) {
              await upsertIssue(issue.parent, prefix);
            }
          } else {
            await ensureProject(FALLBACK_PROJECT.prefix, FALLBACK_PROJECT.name);
          }
          await upsertIssue(issue, prefix);
        } catch (error) {
          counters.failed++;
          bb.log.warn(`upsert failed for ${issue.key}: ${String(error)}`);
        }
      }

      const assigned = (await searchJira(config, config.jql)).map(mapIssue);

      const epics = new Map<string, MappedIssue>();
      for (const issue of assigned) {
        if (issue.isEpic) epics.set(issue.key, issue);
      }
      const embedOnlyEpicKeys = [
        ...new Set(
          assigned
            .map((issue) => issue.parent?.key)
            .filter((key): key is string => !!key && !epics.has(key)),
        ),
      ];
      for (const keys of chunk(embedOnlyEpicKeys, 100)) {
        try {
          const fullEpics = await searchJira(config, `issuekey in (${keys.join(",")})`);
          for (const epic of fullEpics.map(mapIssue)) epics.set(epic.key, epic);
        } catch (error) {
          bb.log.warn(`epic lookup failed: ${String(error)}`);
        }
      }

      for (const epic of epics.values()) await processIssue(epic);
      for (const issue of assigned) {
        if (!issue.isEpic) await processIssue(issue);
      }

      const staleKeys = [...snapshots.keys()].filter((jiraKey) => {
        const snapshot = snapshots.get(jiraKey)!;
        return (
          !touched.has(jiraKey) &&
          snapshot.status !== "done" &&
          snapshot.status !== "canceled"
        );
      });
      for (const keys of chunk(staleKeys, 100)) {
        let staleIssues: JiraIssue[];
        try {
          staleIssues = await searchJira(config, `issuekey in (${keys.join(",")})`);
        } catch (error) {
          bb.log.warn(`stale-issue lookup failed: ${String(error)}`);
          continue;
        }
        for (const staleIssue of staleIssues.map(mapIssue)) {
          await processIssue(staleIssue);
        }
      }

      const summary: SyncSummary = {
        at,
        ok: true,
        created: counters.created,
        updated: counters.updated,
        failed: counters.failed,
        total: assigned.length,
      };
      await bb.storage.kv.set("lastSync", summary);
      bb.log.info(
        `synced ${summary.total} assigned issues (${summary.created} created, ${summary.updated} updated)`,
      );
      return summary;
    } catch (error) {
      const summary: SyncSummary = {
        at,
        ok: false,
        created: 0,
        updated: 0,
        total: 0,
        error: String(error),
      };
      await bb.storage.kv.set("lastSync", summary);
      throw error;
    } finally {
      syncing = false;
    }
  }

  if (!(await getConfig())) {
    bb.status.needsConfiguration(
      "Set baseUrl, email, and apiToken with `bb plugin config jira-sync set <key> <value>`, then reload.",
    );
  }

  bb.background.schedule("sync", "*/5 * * * *", async () => {
    await runSync();
  });

  bb.rpc.register(rpcContract, {
    async listProjects() {
      const { projects } = (await runBbJson(["tasks", "project", "list"])) as {
        projects: Array<{ id: string; prefix: string; name: string }>;
      };
      const detailed = [];
      for (const project of projects) {
        const { tasks } = (await runBbJson([
          "tasks",
          "list",
          "--project",
          project.prefix,
          "--limit",
          "500",
        ])) as {
          tasks: Array<{ id: string; key: string; status: string; title: string }>;
        };
        detailed.push({
          id: project.id,
          prefix: project.prefix,
          name: project.name,
          tasks: tasks.map((task) => ({
            id: task.id,
            key: task.key,
            status: task.status,
            title: task.title,
          })),
        });
      }
      return { projects: detailed };
    },
    async deleteTask({ taskId, taskKey }) {
      const result = await tasksRpc("deleteTask", { taskId });
      if (result.ok) {
        for (const [jiraKey, snapshot] of await loadSnapshots()) {
          if (snapshot.taskKey === taskKey) await ignoreAndForget(jiraKey);
        }
      }
      return result;
    },
    async deleteProject({ projectId }) {
      const { projects } = (await runBbJson(["tasks", "project", "list"])) as {
        projects: Array<{ id: string; prefix: string }>;
      };
      const project = projects.find((candidate) => candidate.id === projectId);
      const result = await tasksRpc("deleteProject", { projectId, force: true });
      if (result.ok && project) {
        for (const [jiraKey, snapshot] of await loadSnapshots()) {
          if (snapshot.prefix === project.prefix) await ignoreAndForget(jiraKey);
        }
      }
      return result;
    },
    async syncNow() {
      const summary = await runSync();
      return {
        message: `Synced ${summary.total} issues: ${summary.created} created, ${summary.updated} updated${summary.failed ? `, ${summary.failed} failed` : ""}.`,
      };
    },
  });

  bb.cli.register({
    name: "jira",
    summary: "Sync Jira issues assigned to you into the Tasks tab",
    commands: [
      {
        name: "sync",
        summary: "Fetch assigned Jira issues and upsert them as tasks now",
        usage: "bb jira sync",
      },
      {
        name: "status",
        summary: "Show sync configuration state and last sync result",
        usage: "bb jira status",
      },
      {
        name: "unignore",
        summary: "Resume syncing issues that were excluded by a UI deletion",
        usage: "bb jira unignore <JIRA-KEY|--all>",
      },
    ],
    async run(argv) {
      const command = argv[0];
      if (command === "sync") {
        try {
          const summary = await runSync();
          return {
            exitCode: 0,
            stdout: `Synced ${summary.total} assigned issues: ${summary.created} created, ${summary.updated} updated${summary.failed ? `, ${summary.failed} failed (see bb plugin logs jira-sync)` : ""}.`,
          };
        } catch (error) {
          return { exitCode: 1, stderr: String(error) };
        }
      }
      if (command === "status") {
        const configured = (await getConfig()) !== null;
        const lastSync = await bb.storage.kv.get<SyncSummary>("lastSync");
        const trackedCount = (await bb.storage.kv.list(SNAPSHOT_PREFIX)).length;
        const ignored = [...(await loadIgnoredKeys())];
        const lines = [
          `Configured: ${configured ? "yes" : "no (set baseUrl, email, apiToken via bb plugin config jira-sync)"}`,
          `Tracked issues: ${trackedCount}`,
          `Ignored issues: ${ignored.length ? ignored.join(", ") : "none"}`,
          lastSync
            ? `Last sync: ${lastSync.at} — ${lastSync.ok ? `ok (${lastSync.total} issues, ${lastSync.created} created, ${lastSync.updated} updated)` : `failed: ${lastSync.error}`}`
            : "Last sync: never",
        ];
        return { exitCode: 0, stdout: lines.join("\n") };
      }
      if (command === "unignore") {
        const target = argv[1];
        if (!target) {
          return { exitCode: 1, stderr: "Usage: bb jira unignore <JIRA-KEY|--all>" };
        }
        const ignored = await loadIgnoredKeys();
        const keys = target === "--all" ? [...ignored] : [target.toUpperCase()];
        const removed: string[] = [];
        for (const key of keys) {
          if (!ignored.has(key)) continue;
          await bb.storage.kv.delete(IGNORE_PREFIX + key);
          removed.push(key);
        }
        return {
          exitCode: 0,
          stdout: removed.length
            ? `Resumed syncing: ${removed.join(", ")} (tasks will be recreated on the next sync)`
            : "Nothing to unignore.",
        };
      }
      return {
        exitCode: 1,
        stderr: "Usage: bb jira <sync|status|unignore>",
      };
    },
  });
}
