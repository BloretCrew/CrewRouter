---
name: play-developer-console
description: Use when managing Google Play Developer Console metadata, graphics, tracks, app bundles, reviews, subscriptions, or in-app products with the local `play` CLI. Trigger this for Moshi Android Play Store work, especially when editing `/Users/jyo/projects/ai/moshi/marketing/play` assets or debugging `/Users/jyo/projects/tools/play-cli`.
---

# Play Developer Console

Use the local Bun TypeScript CLI at:

```bash
/Users/jyo/projects/tools/play-cli
```

The CLI is linked locally with Bun and exposes:

```bash
play --help
```

For Moshi Android, run commands from:

```bash
/Users/jyo/projects/ai/moshi/marketing
```

The Play assets live in:

```bash
play/
  .env
  metadata/
  images/
  release-notes/
```

## Workflow

- Inspect `play/CLAUDE.md` and relevant local files before changing store assets.
- Run one Play edit-backed command at a time. Do not parallelize `play metadata`, `play app-info`, `play images`, `play bundle`, or `play tracks` commands.
- Validate local listing text before upload:

```bash
play metadata validate
```

- Use read-only checks before and after changes:

```bash
play metadata list
play app-info show
play tracks list --json
play tracks show production --json
play reviews list --limit 5
```

## Release Workflow

Use the built-in track commands for release operations. Do not write ad hoc scripts against `src/api.ts` for normal release tasks.

Attach or update a release already uploaded to Play:

```bash
play tracks release internal \
  --version-code 6 \
  --status completed \
  --name "Moshi 2.8.2" \
  --notes en-US=play/release-notes/en-US.txt
```

Prepare a production draft with release notes:

```bash
play tracks release production \
  --version-code 6 \
  --status draft \
  --name "Moshi 2.8.2" \
  --notes en-US=play/release-notes/en-US.txt
```

If a draft app has stale releases that block validation, clear the track first, then create the intended release:

```bash
play tracks clear internal
play tracks release internal --version-code 6 --status draft --name "Moshi 2.8.2"
```

When no `--notes` flag is provided, `play tracks release` reads all files in `play/release-notes/` as localized release notes. Use `--no-notes` only when intentionally omitting notes.

- For bugs or missing Play API behavior, patch `/Users/jyo/projects/tools/play-cli`, then run:

```bash
cd /Users/jyo/projects/tools/play-cli
bun run typecheck
bun test
```

Retry from `/Users/jyo/projects/ai/moshi/marketing` after the fix.

## Auth

Moshi uses keyless local auth via `gcloud` ADC and a quota project in `play/.env`.
Do not create or require service account JSON keys unless the user explicitly asks.

Expected env keys:

```bash
PLAY_AUTH_MODE=gcloud
PLAY_QUOTA_PROJECT=play-cli-moshi-260429103059
PLAY_PACKAGE_NAME=app.getmoshi.android
```
