---
summary: "CLI reference for `Synurex plugins` (list, install, enable/disable, doctor)"
read_when:
  - You want to install or manage in-process Gateway plugins
  - You want to debug plugin load failures
title: "plugins"
---

# `Synurex plugins`

Manage Gateway plugins/extensions (loaded in-process).

Related:

- Plugin system: [Plugins](/tools/plugin)
- Plugin manifest + schema: [Plugin manifest](/plugins/manifest)
- Security hardening: [Security](/gateway/security)

## Commands

```bash
Synurex plugins list
Synurex plugins info <id>
Synurex plugins enable <id>
Synurex plugins disable <id>
Synurex plugins doctor
Synurex plugins update <id>
Synurex plugins update --all
```

Bundled plugins ship with Synurex but start disabled. Use `plugins enable` to
activate them.

All plugins must ship a `Synurex.plugin.json` file with an inline JSON Schema
(`configSchema`, even if empty). Missing/invalid manifests or schemas prevent
the plugin from loading and fail config validation.

### Install

```bash
Synurex plugins install <path-or-spec>
```

Security note: treat plugin installs like running code. Prefer pinned versions.

Supported archives: `.zip`, `.tgz`, `.tar.gz`, `.tar`.

Use `--link` to avoid copying a local directory (adds to `plugins.load.paths`):

```bash
Synurex plugins install -l ./my-plugin
```

### Update

```bash
Synurex plugins update <id>
Synurex plugins update --all
Synurex plugins update <id> --dry-run
```

Updates only apply to plugins installed from npm (tracked in `plugins.installs`).
