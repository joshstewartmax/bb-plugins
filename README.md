# bb-plugins

Personal [bb](https://github.com/get-bb/bb) plugins, one per directory.

## Plugins

- **bb-plugin-claude-skills** — brings bb's `/` menu up to parity with the
  Claude Code terminal by mirroring Claude Code's built-in slash commands
  (`/simplify`, `/code-review`, `/run`, …), which bb can't otherwise see because
  they're compiled into the CLI rather than stored as files. Discovers them from
  the CLI itself and generates shim skills that delegate to the real built-ins.
- **bb-plugin-jira-sync** — syncs Jira issues assigned to me into the bb Tasks
  tab: one tracker project per epic, tickets as tasks with descriptions,
  statuses, priorities, and due dates kept in sync every 5 minutes. Includes a
  "Jira Sync" panel for deleting projects/tasks and a `bb jira` CLI command.
- **bb-plugin-open-terminal** — adds an "Open terminal" button to the thread
  composer that opens a terminal in the thread's project and worktree, shown
  as a tab in the thread's right panel.
- **bb-plugin-path-mention** — adds a "Filepath" `@`-mention provider that
  completes any file or folder by unix path relative to the thread's worktree
  (`../`, absolute, or `~`) — e.g. `@../abc/` tags a sibling repo — and injects
  its content as agent context.

## Installing

```sh
bb plugin install ./bb-plugin-jira-sync
```

After changing a plugin's source, rebuild and reload:

```sh
cd bb-plugin-jira-sync
npm install
bb plugin build
bb plugin reload jira-sync
```
