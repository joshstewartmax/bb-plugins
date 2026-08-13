import type { BbPluginApi } from "@bb/plugin-sdk";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";

const RESULT_LIMIT = 25;
const DIRECTORY_TREE_LIMIT = 200;
const MAX_FILE_CHARS = 200_000;

type ItemKind = "file" | "directory";

interface ItemPayload {
  kind: ItemKind;
  hostId: string;
  path: string;
}

function encodeItemId(payload: ItemPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeItemId(itemId: string): ItemPayload {
  return JSON.parse(Buffer.from(itemId, "base64url").toString("utf8"));
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return `${homedir()}/${path.slice(2)}`;
  return path;
}

export default async function plugin(bb: BbPluginApi) {
  async function resolveWorktree(threadId: string | null) {
    if (!threadId) return null;
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) return null;
    const environment = await bb.sdk.environments.get({
      environmentId: thread.environmentId,
    });
    if (!environment.path) return null;
    return { hostId: environment.hostId, path: environment.path };
  }

  bb.ui.registerMentionProvider({
    id: "path",
    label: "Filepath",
    async search({ query, threadId }) {
      const worktree = await resolveWorktree(threadId);
      if (!worktree) return [];

      const slash = query.lastIndexOf("/");
      const dirPart = slash >= 0 ? query.slice(0, slash + 1) : "";
      const lastSegment = slash >= 0 ? query.slice(slash + 1) : query;
      const isDirNav = lastSegment === "." || lastSegment === "..";
      const dirToList = isDirNav ? query : dirPart;
      const fragment = (isDirNav ? "" : lastSegment).toLowerCase();

      const targetDir = resolvePath(worktree.path, expandHome(dirToList));

      let entries;
      try {
        ({ entries } = await bb.sdk.hosts.directory({
          hostId: worktree.hostId,
          path: targetDir,
        }));
      } catch {
        return [];
      }

      return entries
        .filter((entry) => entry.name.toLowerCase().includes(fragment))
        .sort((a, b) => {
          const aStarts = a.name.toLowerCase().startsWith(fragment);
          const bStarts = b.name.toLowerCase().startsWith(fragment);
          if (aStarts !== bStarts) return aStarts ? -1 : 1;
          if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .slice(0, RESULT_LIMIT)
        .map((entry) => {
          const suffix = entry.kind === "directory" ? "/" : "";
          return {
            id: encodeItemId({
              kind: entry.kind,
              hostId: worktree.hostId,
              path: entry.path,
            }),
            title: `${dirPart}${entry.name}${suffix}`,
            subtitle: entry.kind === "directory" ? "Folder" : "File",
          };
        });
    },
    async resolve(itemId) {
      const { kind, hostId, path } = decodeItemId(itemId);

      if (kind === "directory") {
        const listing = await bb.sdk.files.listPaths({
          hostId,
          path,
          limit: DIRECTORY_TREE_LIMIT,
          includeFiles: true,
          includeDirectories: true,
        });
        const tree = listing.paths
          .map((entry) => entry.path)
          .sort()
          .join("\n");
        const suffix = listing.truncated
          ? `\n… (listing truncated at ${DIRECTORY_TREE_LIMIT} entries)`
          : "";
        return {
          context: `Contents of folder \`${path}\`:\n\n${tree}${suffix}`,
        };
      }

      const file = await bb.sdk.files.read({ hostId, path });
      if (file.contentEncoding !== "utf8") {
        return {
          context: `\`${path}\` is a binary file (${file.sizeBytes} bytes) and was not inlined.`,
        };
      }
      const truncated = file.content.length > MAX_FILE_CHARS;
      const content = truncated
        ? file.content.slice(0, MAX_FILE_CHARS)
        : file.content;
      const suffix = truncated
        ? `\n… (file truncated at ${MAX_FILE_CHARS} characters)`
        : "";
      return {
        context: `Contents of \`${path}\`:\n\n\`\`\`\n${content}${suffix}\n\`\`\``,
      };
    },
  });
}
