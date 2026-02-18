---
summary: "CLI reference for `Synurex cron` (schedule and run background jobs)"
read_when:
  - You want scheduled jobs and wakeups
  - You’re debugging cron execution and logs
title: "cron"
---

# `Synurex cron`

Manage cron jobs for the Gateway scheduler.

Related:

- Cron jobs: [Cron jobs](/automation/cron-jobs)

Tip: run `Synurex cron --help` for the full command surface.

Note: isolated `cron add` jobs default to `--announce` delivery. Use `--no-deliver` to keep
output internal. `--deliver` remains as a deprecated alias for `--announce`.

Note: one-shot (`--at`) jobs delete after success by default. Use `--keep-after-run` to keep them.

## Common edits

Update delivery settings without changing the message:

```bash
Synurex cron edit <job-id> --announce --channel telegram --to "123456789"
```

Disable delivery for an isolated job:

```bash
Synurex cron edit <job-id> --no-deliver
```

Announce to a specific channel:

```bash
Synurex cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```
