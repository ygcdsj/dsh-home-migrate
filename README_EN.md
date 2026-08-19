# dsh-migrate

> **experimental** — DSH configuration migration: export/package → restore on another machine → verify + rollback.

[中文](./README.md)

Pack configuration from any DSH install, restore it into a **NEW profile** on the target machine, with verification at every step and automatic rollback on failure. No cloud, no history, no cross-brand imports.

## Why not just use X?

| Project | Purpose | Our boundary |
|---|---|---|
| dshmarket (dsh-market) Backup & Restore | In-market profile plugin-layer backup/restore | We don't touch the plugin market; dsh-migrate covers `vendor/` link dirs, `.agent-presets`, settings.yaml, credential redaction — **archive-format interop is a v2 goal** |
| [dsh-backup-sync](https://github.com/csiroqa/dsh-backup-sync) | Local snapshots + WebDAV cross-machine sync | Backup/sync ≠ migration; we do the full "package → restore" loop |
| [dsh-backup](https://github.com/xiaoyuyu6420/dsh-backup) | One-command backup + rotation | Same as above |
| [dsh-session-sync](https://www.npmjs.com/package/dsh-session-sync) | Session-library git mirror | Sessions are explicitly out of MVP scope |
| [dsh-movein](https://github.com/sjh9714/dsh-movein) / [DSH-Portable](https://github.com/WSL043/DSH-Portable) | Claude Code → DSH import / portable builds | Reverse direction or different shape |

## Features (MVP)

- **Export**: scans `~/.dsh` (profile configs, settings.yaml, `.agent-presets`, `vendor/` link dirs); hard-excludes `.credentials.yaml`, `.env*`, `.pnpm-store`, `sessions`, `storages`, `node_modules`, …; field-level **credential scanning + redaction** for settings/presets, with a `secretReport` in the manifest
- **Packaging**: single `.dshmig` (zip) with a manifest (version, platform, file list, sha256 checksums, link mapping)
- **Import**: preflight (same OS, dsh version) → backup target → **NEW profile by default** (`<name>-migrated`, auto-incremented) → `link:` path rewrite → vendor/presets/settings restore → `pnpm install` → verification chain (link resolution → `dsh --dump-config`) → automatic rollback on failure
- **Verification chain**: L1 pnpm install / L2 link resolution (junction realpath) / L3 `dsh --dump-config`
- **UI**: "Migration" section in Settings (export wizard + import wizard); host tools `dsh_migrate_export` / `dsh_migrate_import` callable by agents

### Explicitly out of MVP scope (v2 or ecosystem)

Sessions/storages migration, WebDAV/Gist sync, cross-brand imports, portability, cross-OS migration, overwriting existing profiles, unattended migration, credential management (exclude + redact + re-configure guidance only).

## Install

After npm release:

```bash
# inside the profile directory
dsh plugin --profile web add dsh-migrate
```

Local development (requires [dsh-super-injector](https://github.com/dsh-external/dsh-super-injector)):

```bash
npm install --legacy-peer-deps --no-audit --no-fund
npm run build          # falls back to the _npx official package tree when no bash/checkout exists
# inside the injector environment:
dev_inject_plugin <this directory>
```

## Full migration walkthrough (first-time users)

1. **Export on the source machine**: Settings → Migration → Export → ① Preview export → ② Run export
2. **Get the artifact**: a `.dshmig` file lands in `~/dsh-migrate-exports/dsh-migrate-<profile>-<timestamp>.dshmig` — a zip containing the manifest (checksums), profile configs, settings.yaml (redacted), `.agent-presets`, and `vendor/` link packages; **credentials are best-effort excluded/redacted** (`secretReport` includes an `unscannedFiles` list — review it before transferring)
3. **Transfer it**: USB / cloud / scp — redaction is best-effort; rely on `secretReport`
4. **Import on the target**: DSH → Settings → Migration → Import → paste the `.dshmig` path → ① Preflight (per-item ✓/✗) → confirm the step list → ② Run import
5. **Wait for verification**: `pnpm install` + verification chain run automatically (L1 install / L2 link resolution / L3 `dsh --dump-config`); the import only finishes when all pass
6. **Switch to it**: the import creates a **NEW profile** (`<name>-migrated`); switch the default profile manually after verification, then clean up `~/.dsh/.dshmig-backup/` once confirmed

> **Launching the migrated profile (important)**: `dsh web` is an alias of `dsh --profile web` and always boots the pristine `web` profile — the migration lives in the NEW `<name>-migrated` profile, so you must name it explicitly:
>
> ```bash
> dsh --profile web-migrated      # boot the migrated profile (GUI)
> ```
>
> Running `dsh web` opens the untouched native environment, so migrated plugins/skins/settings won't show up there — that is expected, not a fault. Once verified, you may retire the old profile and rename `<name>-migrated` to `web`, or set the `DSH_PROFILE` environment variable so `dsh web` points at the migrated environment.

> Import never overwrites your existing profile; any failure rolls back automatically.

## Usage

### Settings wizards (recommended)

1. **Export**: Settings → Migration → Preview export (file list/size/excluded/credential hits) → Run export → artifact in `~/dsh-migrate-exports/*.dshmig`
2. **Import**: Settings → Migration on the target → enter the `.dshmig` path → Preflight (per-item ✓/✗) → confirm the step list → Run import → review verification results and backup dir
3. Switch the default profile manually after verification; clean up `.dshmig-backup/` once confirmed

### Host tools

`dsh_migrate_export { dryRun: true }` (preview) / `{ dryRun: false, outDir }` (package); `dsh_migrate_import { archive, dryRun: true }` (preflight) / `{ archive }` (import, auto-rollback on failure).

## Security boundary

- **Credentials are best-effort excluded/redacted, not guaranteed**: `.credentials.yaml` and `.env*` are hard-excluded; suspected credential fields in settings/presets/vendor config files are redacted (`<redacted>`) and recorded in `secretReport`; an **unscanned-files list (`unscannedFiles`)** ships with the report — review it before transferring
- **Importing executes code from the archive**: import runs `pnpm install` (default `--ignore-scripts`) and parses bundle plugins, and starting the profile later executes them — **only import archives from sources you trust** (the UI confirm dialog warns about this)
- Artifacts are generated locally only; transferring them is your responsibility
- `link:` targets are asserted inside `<home>/vendor`; manifest path fields (files/links/profiles) are allow-listed + landing-path asserted (anti path-traversal writes)
- HTTP API is loopback-only (Host allow-list) + CSRF token + Origin same-origin + `Sec-Fetch-Site` checks; **exposing DSH web to a LAN means anyone can import arbitrary archives (an RCE surface)**
- A symlinked `settings.yaml` is refused for overwrite (no write-through); concurrent imports use separate staging subdirs and never clean each other's

## FAQ

**Will import overwrite my current config?** No. MVP only creates a new profile (`<name>-migrated`); settings.yaml is overwritten after backup (uncheck it before importing if unwanted).

**Why can't I see the migrated plugins with `dsh web`?** `dsh web` is just an alias of `dsh --profile web` and boots the pristine `web` profile; the migration tool **never overwrites your existing profile**, so everything lives in the NEW `<name>-migrated` profile. Boot it with `dsh --profile <name>-migrated`. Once verified, retire the old profile and rename `<name>-migrated` to `web` (or set the `DSH_PROFILE` env var) so `dsh web` points at the migrated environment.

**Cross-OS migration?** MVP is same-OS only; cross-OS is rejected at preflight.

**What about git: dependencies (skins)?** Not packaged; re-fetched by `pnpm install` on the target (network/credentials required; preflight warns).

**Is import safe?** Import executes code inside the archive (pnpm install scripts + bundle plugin parsing; starting the profile later runs the plugins), so **only import archives from sources you trust**. `--ignore-scripts` is on by default; path fields are allow-listed with landing assertions; the HTTP API is loopback-only + token-gated.

**What if import fails?** Config-level rollback is complete (remove created paths + restore snapshot); dependency-level is best-effort; `.dshmig-backup/` preserves the scene — never silent.

## Development & tests

```bash
npm test             # smoke (export → import → rewrite/restore/increment/fault injection), sandbox-safe
npm run test:install # full chain (pnpm install + dump-config, needs full permissions)
```

Spec and design decisions: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) (machine-verified baselines, ecosystem conventions, survey findings, risk register).

## Roadmap (v2)

- Sessions/storages migration (dsh-session-sync git-mirror approach)
- Archive-format interop with dshmarket backups
- WebDAV/Gist sync
- Cross-OS (implementation is already cross-OS-friendly; promises stay conservative)

## License

MIT © 2026 dsh-migrate contributors

## Credits

- [dshmarket](https://github.com/dsh-market/dsh-market) — route/HTTP patterns, pnpm compatibility layer, backup module reference
- [dsh-super-injector](https://github.com/dsh-external/dsh-super-injector) — plugin shape and build pipeline reference
- [dsh-skin-market](https://github.com/kingOfSoySauce/dsh-skin-market) — pnpm failure handling reference
- [dsh-backup-sync](https://github.com/csiroqa/dsh-backup-sync), [dsh-backup](https://github.com/xiaoyuyu6420/dsh-backup), [dsh-session-sync](https://www.npmjs.com/package/dsh-session-sync) — ecosystem positioning
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — the platform and official packages such as `@deepseek-ai/dsh-home-paths`
