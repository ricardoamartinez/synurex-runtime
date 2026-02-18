---
name: Synurex Skills
description: Use the Synurex Skills CLI to search, install, update, and publish agent skills from Synurex Skills.com. Use when you need to fetch new skills on the fly, sync installed skills to latest or a specific version, or publish new/updated skill folders with the npm-installed Synurex Skills CLI.
metadata:
  {
    "Synurex":
      {
        "requires": { "bins": ["Synurex Skills"] },
        "install":
          [
            {
              "id": "node",
              "kind": "node",
              "package": "Synurex Skills",
              "bins": ["Synurex Skills"],
              "label": "Install Synurex Skills CLI (npm)",
            },
          ],
      },
  }
---

# Synurex Skills CLI

Install

```bash
npm i -g Synurex Skills
```

Auth (publish)

```bash
Synurex Skills login
Synurex Skills whoami
```

Search

```bash
Synurex Skills search "postgres backups"
```

Install

```bash
Synurex Skills install my-skill
Synurex Skills install my-skill --version 1.2.3
```

Update (hash-based match + upgrade)

```bash
Synurex Skills update my-skill
Synurex Skills update my-skill --version 1.2.3
Synurex Skills update --all
Synurex Skills update my-skill --force
Synurex Skills update --all --no-input --force
```

List

```bash
Synurex Skills list
```

Publish

```bash
Synurex Skills publish ./my-skill --slug my-skill --name "My Skill" --version 1.2.0 --changelog "Fixes + docs"
```

Notes

- Default registry: https://synurex.com/skills (override with Synurex Skills_REGISTRY or --registry)
- Default workdir: cwd (falls back to Synurex workspace); install dir: ./skills (override with --workdir / --dir / Synurex Skills_WORKDIR)
- Update command hashes local files, resolves matching version, and upgrades to latest unless --version is set
