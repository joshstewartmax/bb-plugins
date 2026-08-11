# bb-plugins

Personal [bb](https://github.com/get-bb/bb) plugins, one per directory.

## Plugins

- **bb-plugin-jira-sync** — syncs Jira issues assigned to me into the bb Tasks
  tab: one tracker project per epic, tickets as tasks with descriptions,
  statuses, priorities, and due dates kept in sync every 5 minutes. Includes a
  "Jira Sync" panel for deleting projects/tasks and a `bb jira` CLI command.
- **bb-plugin-open-terminal** — adds an "Open terminal" button to the thread
  composer that opens a terminal in the thread's project and worktree, shown
  as a tab in the thread's right panel.

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
