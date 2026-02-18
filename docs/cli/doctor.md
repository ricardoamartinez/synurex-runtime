---
summary: "CLI reference for `Synurex doctor` (health checks + guided repairs)"
read_when:
  - You have connectivity/auth issues and want guided fixes
  - You updated and want a sanity check
title: "doctor"
---

# `Synurex doctor`

Health checks + quick fixes for the gateway and channels.

Related:

- Troubleshooting: [Troubleshooting](/gateway/troubleshooting)
- Security audit: [Security](/gateway/security)

## Examples

```bash
Synurex doctor
Synurex doctor --repair
Synurex doctor --deep
```

Notes:

- Interactive prompts (like keychain/OAuth fixes) only run when stdin is a TTY and `--non-interactive` is **not** set. Headless runs (cron, Telegram, no terminal) will skip prompts.
- `--fix` (alias for `--repair`) writes a backup to `~/.synurex/synurex.json.bak` and drops unknown config keys, listing each removal.

## macOS: `launchctl` env overrides

If you previously ran `launchctl setenv SYNUREX_GATEWAY_TOKEN ...` (or `...PASSWORD`), that value overrides your config file and can cause persistent “unauthorized” errors.

```bash
launchctl getenv SYNUREX_GATEWAY_TOKEN
launchctl getenv SYNUREX_GATEWAY_PASSWORD

launchctl unsetenv SYNUREX_GATEWAY_TOKEN
launchctl unsetenv SYNUREX_GATEWAY_PASSWORD
```
