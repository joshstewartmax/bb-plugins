# bb-plugin-path-mention

Adds a **Filepath** `@`-mention provider to the composer. Type a unix filepath
after `@` and it completes files and folders one directory level at a time,
resolved relative to the thread's worktree. The picked item's content rides
along with the message as agent-only context.

The agent's tools are normally confined to the thread's worktree, so anything
outside it — a sibling repo, a shared config, a file in your home directory —
is otherwise invisible to it. This mention is the bridge.

## How it works

- The query after `@` is treated as a path relative to the worktree cwd.
  Supports `../` to walk up (e.g. `@../abc/` tags a sibling repo `abc`),
  absolute paths (`@/etc/hosts`), and `~` for your home directory.
- Completion is one level at a time: as you type each `/`, the next directory's
  entries appear under **Filepath**, folders first.
- At send time the picked item is resolved:
  - **File** → its UTF-8 contents (capped at 200k chars; binaries are noted,
    not inlined).
  - **Folder** → a `.gitignore`-aware listing of its contents (capped at 200
    entries).

## Install

```
bb plugin install .
```

After editing sources, reload:

```
bb plugin reload path-mention
```

## Notes

- Backend-only: the mention menu is host-rendered, so there is no frontend
  bundle.
- Each `search` is time-boxed to 2s; a single-level directory read stays well
  inside that.
