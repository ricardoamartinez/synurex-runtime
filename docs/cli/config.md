---
summary: "CLI reference for `Synurex config` (get/set/unset config values)"
read_when:
  - You want to read or edit config non-interactively
title: "config"
---

# `Synurex config`

Config helpers: get/set/unset values by path. Run without a subcommand to open
the configure wizard (same as `Synurex configure`).

## Examples

```bash
Synurex config get browser.executablePath
Synurex config set browser.executablePath "/usr/bin/google-chrome"
Synurex config set agents.defaults.heartbeat.every "2h"
Synurex config set agents.list[0].tools.exec.node "node-id-or-name"
Synurex config unset tools.web.search.apiKey
```

## Paths

Paths use dot or bracket notation:

```bash
Synurex config get agents.defaults.workspace
Synurex config get agents.list[0].id
```

Use the agent list index to target a specific agent:

```bash
Synurex config get agents.list
Synurex config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Values

Values are parsed as JSON5 when possible; otherwise they are treated as strings.
Use `--json` to require JSON5 parsing.

```bash
Synurex config set agents.defaults.heartbeat.every "0m"
Synurex config set gateway.port 19001 --json
Synurex config set channels.whatsapp.groups '["*"]' --json
```

Restart the gateway after edits.
