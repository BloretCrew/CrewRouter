# External application audit snapshot

This directory is a committed, read-only audit snapshot of the exact implementation and direct test files from the six external repositories reviewed for the username/nickname compatibility goal. It is not a second runtime copy and must not be deployed as application code.

Each application directory contains `SOURCE.txt` with the source repository and feature/test commits. The copied files are retained so the current PassPort repository's committed change scope can corroborate the cross-repository audit. The snapshots intentionally do not include each application's full dependency tree or project configuration, so their copied tests are not executed from this directory.

The source repositories remain authoritative. The snapshot keeps the relevant browser builder exports so its direct regression test can execute the same shipped builder logic without the external repository dependency tree:

- `/data/bloret-launcher-website`
- `/data/Bloret-Translation-Collector`
- `/data/CrewRouterShow` (including GitHub OAuth and PassKey session mappings)
- `/data/cha-fu-wang`
- `/data/Bloret-AI-Studio` (including the classic Playground display path)
- `/data/License-Server`

Runtime verification is executed from those source repositories using the commands documented in `Docs/NicknameDisplayChangeManifest.md`. The snapshot files are compared byte-for-byte against their recorded source commits by `snapshot-verification.log`.
