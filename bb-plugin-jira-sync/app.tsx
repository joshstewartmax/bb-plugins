import { useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";

interface TaskRow {
  id: string;
  key: string;
  status: string;
  title: string;
}

interface ProjectRow {
  id: string;
  prefix: string;
  name: string;
  tasks: TaskRow[];
}

function DeleteButton({
  id,
  confirming,
  setConfirming,
  busy,
  onConfirm,
}: {
  id: string;
  confirming: string | null;
  setConfirming: (id: string | null) => void;
  busy: boolean;
  onConfirm: () => void;
}) {
  if (confirming !== id) {
    return (
      <button
        className="shrink-0 rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        onClick={() => setConfirming(id)}
      >
        Delete
      </button>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1">
      <button
        disabled={busy}
        className="rounded-md bg-destructive px-2 py-0.5 text-xs font-medium text-destructive-foreground disabled:opacity-50"
        onClick={onConfirm}
      >
        Confirm
      </button>
      <button
        className="rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted"
        onClick={() => setConfirming(null)}
      >
        Cancel
      </button>
    </span>
  );
}

function AdminPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reload() {
    try {
      const { projects: next } = await rpc.call("listProjects");
      setProjects(next);
    } catch (error) {
      toast.error(`Failed to load projects: ${String(error)}`);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function runDelete(
    action: () => Promise<{ ok: boolean; error: string | null }>,
    label: string,
  ) {
    setBusy(true);
    try {
      const result = await action();
      if (result.ok) {
        toast.success(`Deleted ${label}`);
      } else {
        toast.error(result.error ?? `Failed to delete ${label}`);
      }
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
      setConfirming(null);
      await reload();
    }
  }

  async function syncNow() {
    setBusy(true);
    try {
      const { message } = await rpc.call("syncNow");
      toast.success(message);
      await reload();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Deleting a synced item also stops it from re-syncing (undo with{" "}
            <code className="rounded bg-muted px-1">bb jira unignore</code>).
          </p>
          <button
            disabled={busy}
            className="shrink-0 rounded-md border border-border px-3 py-1 text-sm hover:bg-muted disabled:opacity-50"
            onClick={() => void syncNow()}
          >
            Sync now
          </button>
        </div>

        {projects === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">No task projects.</p>
        ) : (
          projects.map((project) => (
            <div
              key={project.id}
              className="rounded-lg border border-border bg-card"
            >
              <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                <span className="truncate text-sm font-medium">
                  {project.name}
                </span>
                <DeleteButton
                  id={`project:${project.id}`}
                  confirming={confirming}
                  setConfirming={setConfirming}
                  busy={busy}
                  onConfirm={() =>
                    void runDelete(
                      () => rpc.call("deleteProject", { projectId: project.id }),
                      `${project.name} and its ${project.tasks.length} tasks`,
                    )
                  }
                />
              </div>
              {project.tasks.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">
                  No tasks.
                </p>
              ) : (
                <ul>
                  {project.tasks.map((task) => (
                    <li
                      key={task.id}
                      className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-sm last:border-b-0"
                    >
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        {task.key}
                      </span>
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                        {task.status.replace("_", " ")}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {task.title}
                      </span>
                      <DeleteButton
                        id={`task:${task.id}`}
                        confirming={confirming}
                        setConfirming={setConfirming}
                        busy={busy}
                        onConfirm={() =>
                          void runDelete(
                            () =>
                              rpc.call("deleteTask", {
                                taskId: task.id,
                                taskKey: task.key,
                              }),
                            task.key,
                          )
                        }
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "admin",
    title: "Jira Sync",
    icon: "RefreshCw",
    path: "admin",
    component: AdminPanel,
  });
});
