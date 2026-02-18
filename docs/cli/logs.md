---
summary: "CLI reference for `Synurex logs` (tail gateway logs via RPC)"
read_when:
  - You need to tail Gateway logs remotely (without SSH)
  - You want JSON log lines for tooling
title: "logs"
---

# `Synurex logs`

Tail Gateway file logs over RPC (works in remote mode).

Related:

- Logging overview: [Logging](/logging)

## Examples

```bash
Synurex logs
Synurex logs --follow
Synurex logs --json
Synurex logs --limit 500
```
