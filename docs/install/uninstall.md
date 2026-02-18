---
summary: "Uninstall Synurex completely (CLI, service, state, workspace)"
read_when:
  - You want to remove Synurex from a machine
  - The gateway service is still running after uninstall
title: "Uninstall"
---

# Uninstall

Two paths:

- **Easy path** if `Synurex` is still installed.
- **Manual service removal** if the CLI is gone but the service is still running.

## Easy path (CLI still installed)

Recommended: use the built-in uninstaller:

```bash
Synurex uninstall
```

Non-interactive (automation / npx):

```bash
Synurex uninstall --all --yes --non-interactive
npx -y Synurex uninstall --all --yes --non-interactive
```

Manual steps (same result):

1. Stop the gateway service:

```bash
synurex gateway stop
```

2. Uninstall the gateway service (launchd/systemd/schtasks):

```bash
synurex gateway uninstall
```

3. Delete state + config:

```bash
rm -rf "${Synurex_STATE_DIR:-$HOME/.Synurex}"
```

If you set `Synurex_CONFIG_PATH` to a custom location outside the state dir, delete that file too.

4. Delete your workspace (optional, removes agent files):

```bash
rm -rf ~/.synurex/workspace
```

5. Remove the CLI install (pick the one you used):

```bash
npm rm -g Synurex
pnpm remove -g Synurex
bun remove -g Synurex
```

6. If you installed the macOS app:

```bash
rm -rf /Applications/Synurex.app
```

Notes:

- If you used profiles (`--profile` / `Synurex_PROFILE`), repeat step 3 for each state dir (defaults are `~/.Synurex-<profile>`).
- In remote mode, the state dir lives on the **gateway host**, so run steps 1-4 there too.

## Manual service removal (CLI not installed)

Use this if the gateway service keeps running but `Synurex` is missing.

### macOS (launchd)

Default label is `bot.molt.gateway` (or `bot.molt.<profile>`; legacy `com.Synurex.*` may still exist):

```bash
launchctl bootout gui/$UID/bot.molt.gateway
rm -f ~/Library/LaunchAgents/bot.molt.gateway.plist
```

If you used a profile, replace the label and plist name with `bot.molt.<profile>`. Remove any legacy `com.Synurex.*` plists if present.

### Linux (systemd user unit)

Default unit name is `Synurex-gateway.service` (or `Synurex-gateway-<profile>.service`):

```bash
systemctl --user disable --now Synurex-gateway.service
rm -f ~/.config/systemd/user/Synurex-gateway.service
systemctl --user daemon-reload
```

### Windows (Scheduled Task)

Default task name is `synurex Gateway` (or `synurex Gateway (<profile>)`).
The task script lives under your state dir.

```powershell
schtasks /Delete /F /TN "synurex gateway"
Remove-Item -Force "$env:USERPROFILE\.Synurex\gateway.cmd"
```

If you used a profile, delete the matching task name and `~\.Synurex-<profile>\gateway.cmd`.

## Normal install vs source checkout

### Normal install (install.sh / npm / pnpm / bun)

If you used `https://synurex.com/install.sh` or `install.ps1`, the CLI was installed with `npm install -g Synurex@latest`.
Remove it with `npm rm -g Synurex` (or `pnpm remove -g` / `bun remove -g` if you installed that way).

### Source checkout (git clone)

If you run from a repo checkout (`git clone` + `synurex ...` / `bun run Synurex ...`):

1. Uninstall the gateway service **before** deleting the repo (use the easy path above or manual service removal).
2. Delete the repo directory.
3. Remove state + workspace as shown above.
