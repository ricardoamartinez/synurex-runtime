---
summary: "CLI reference for `Synurex agents` (list/add/delete/set identity)"
read_when:
  - You want multiple isolated agents (workspaces + routing + auth)
title: "agents"
---

# `Synurex agents`

Manage isolated agents (workspaces + auth + routing).

Related:

- Multi-agent routing: [Multi-Agent Routing](/concepts/multi-agent)
- Agent workspace: [Agent workspace](/concepts/agent-workspace)

## Examples

```bash
Synurex agents list
Synurex agents add work --workspace ~/.synurex/workspace-work
Synurex agents set-identity --workspace ~/.synurex/workspace --from-identity
Synurex agents set-identity --agent main --avatar avatars/Synurex.png
Synurex agents delete work
```

## Identity files

Each agent workspace can include an `IDENTITY.md` at the workspace root:

- Example path: `~/.synurex/workspace/IDENTITY.md`
- `set-identity --from-identity` reads from the workspace root (or an explicit `--identity-file`)

Avatar paths resolve relative to the workspace root.

## Set identity

`set-identity` writes fields into `agents.list[].identity`:

- `name`
- `theme`
- `emoji`
- `avatar` (workspace-relative path, http(s) URL, or data URI)

Load from `IDENTITY.md`:

```bash
Synurex agents set-identity --workspace ~/.synurex/workspace --from-identity
```

Override fields explicitly:

```bash
Synurex agents set-identity --agent main --name "Synurex" --emoji "🦞" --avatar avatars/Synurex.png
```

Config sample:

```json5
{
  agents: {
    list: [
      {
        id: "main",
        identity: {
          name: "Synurex",
          theme: "space lobster",
          emoji: "🦞",
          avatar: "avatars/Synurex.png",
        },
      },
    ],
  },
}
```
