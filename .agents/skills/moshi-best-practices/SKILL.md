---
name: moshi-best-practices
description: Use when preparing or verifying a host for Moshi remote coding. Trigger this for SSH or preferably Mosh readiness, non-interactive shell PATH issues, tmux defaults, creating a tmux project session rooted at a chosen directory, adapting shell or tmux behavior with the `MOSHI_CLIENT` env signal, installing Moshi agent hooks for Claude Code or Codex CLI, or offering the optional `moshi DIR` shell helper.
---

# Moshi Best Practices

Use this skill to make any host feel easy to use from Moshi.

Use it for either:

- fresh setup
- verification of an existing setup

## Rules

- Inspect before editing.
- Prefer direct config edits over platform-specific setup scripts.
- Verify every outcome after changing it.
- For `moshi DIR`, use a shell function named `moshi`, not a literal alias. Aliases cannot take arguments safely.

## 1. Host Readiness

Target outcome:

- preferred transport is Mosh plus tmux; fallback is SSH plus tmux
- the host has a working SSH entry point
- `tmux` is installed
- `mosh-server` is installed when the user wants Mosh, otherwise SSH plus tmux is acceptable
- both resolve in the current shell and in the login shell's non-interactive mode
- at least one tmux session exists so the Moshi selector can appear.

Inspect with a small set of real checks. Keep OS-specific mechanics minimal, but do not skip verification.

Useful checks:

```bash
command -v tmux || true
command -v mosh-server || true
tmux list-sessions 2>/dev/null || true
LOGIN_SHELL="${SHELL:-/bin/sh}"
"$LOGIN_SHELL" -c 'command -v tmux'
"$LOGIN_SHELL" -c 'command -v mosh-server'
```

Useful macOS-specific checks when relevant:

```bash
dscl . -read "/Users/$USER" UserShell
systemsetup -getremotelogin || true
```

Verify after changes:

```bash
command -v tmux
tmux list-sessions
"$LOGIN_SHELL" -c 'command -v tmux'
"$LOGIN_SHELL" -c 'command -v mosh-server' || true
```

Then ask the user to reconnect from Moshi. Expected result: the tmux selector appears, and the transport can use Mosh instead of plain SSH when configured.

## 2. tmux Environment

Use these defaults unless the user wants something different:

```tmux
set -g history-limit 100000
set -g mouse on
set -g set-titles on
set -g set-titles-string "#I: #W"
set -g base-index 1
setw -g pane-base-index 1
set -g renumber-windows on
```

Workflow:

- inspect the existing tmux config
- update overlapping settings instead of appending duplicates
- reload tmux after editing

## 3. MOSHI_CLIENT Signal

`MOSHI_CLIENT=1` is an opt-in environment variable the Moshi iOS client exports
into the remote shell so rc files, prompts, and tmux configs can detect a
Moshi-launched session and adapt. The user enables it in the app under
**Settings → Integrations → Export ENV** (off by default). When on, it is set
identically on both the Mosh path (via `mosh-server -l MOSHI_CLIENT=1`) and the
SSH fallback (via an injected `export` at shell start).

The main use case is protecting Moshi's swipe-to-change-window gesture, which
relies on reading the tmux status bar. A populated `status-left` /
`status-right` from a custom theme can break detection. Conditionally clearing
them when `MOSHI_CLIENT` is set keeps local themes intact while keeping Moshi
detection reliable. Other uses: narrower prompts, dropping nerd-font glyphs,
different key bindings.

Shell (in the user's rc file):

```sh
if [ -n "$MOSHI_CLIENT" ]; then
  # running under Moshi — trim prompts, skip heavy glyphs, etc.
fi
```

tmux (in `~/.tmux.conf`):

```tmux
# propagate the variable into tmux sessions attached by this shell
set-option -ga update-environment " MOSHI_CLIENT"

# clear status regions for Moshi clients so swipe detection stays clean
if-shell '[ -n "$MOSHI_CLIENT" ]' {
  set -g status-left ''
  set -g status-right ''
}
```

After editing, reload tmux (`tmux source-file ~/.tmux.conf`).

Verify, after the user toggles the setting on and reconnects from Moshi:

```bash
echo "$MOSHI_CLIENT"                       # expect: 1
tmux show-environment | grep MOSHI_CLIENT  # expect a value in new sessions
```

If `echo` prints nothing, the toggle is off in the app — confirm with the user
before editing host configs. The variable only appears in sessions opened
after the toggle was flipped.

## 4. tmux Project Session

When creating a new session:

- read the current working directory
- ask one concise question: should the session start from here?
- if the answer is no, ask for the directory
- default the session name to the directory basename
- create the session detached
- use the chosen directory for every initial window with `tmux ... -c <dir>`

Recommended windows:

1. `agent`
2. `review`
3. `tests`
4. `servers`
5. `misc`

Create the session detached and root every initial window at the chosen directory.

Then ask the user to reconnect in Moshi. Expected result: the session is visible in the tmux selector.

## 5. Optional `moshi DIR` Helper

Do not install this silently. Ask the user first if they want it.

If yes:

- install a shell function named `moshi` in the correct startup file for the active shell
- make it accept a directory argument, defaulting to `$PWD`
- name the tmux session from the directory basename
- create the standard detached session layout only if the session does not already exist
- attach to the session afterward

Use the exact function from `references/moshi-shell-function.md`.

## 6. Agent Hooks

Moshi has switched to a new hook system: `moshi-hook` (singular), a portable
Go daemon. Unlike the old fire-and-forget `moshi-hooks` CLI, the daemon holds a
persistent WebSocket to Moshi, so approvals are **bidirectional** — users can
approve or deny tool calls directly from the iOS Live Activity or the Apple
Watch, and the answer round-trips back to the agent without leaving the
terminal. It also covers Claude Code, Codex CLI, and OpenCode from a single
install.

Use `moshi-hook`, not hand-written config, unless the user explicitly wants
manual edits.

Install via the Homebrew tap, then pair and install hooks:

```bash
brew tap rjyo/moshi
brew install moshi-hook
moshi-hook pair --token <YOUR_TOKEN>   # token comes from the Moshi mobile app
moshi-hook install                     # writes hook configs for installed agents
brew services start moshi-hook         # keeps the daemon alive across reboots
```

On macOS, `moshi-hook pair` uses Keychain by default. If pairing over SSH fails
because Keychain is locked or unavailable, prefer one of these explicit paths:

```bash
security unlock-keychain ~/Library/Keychains/login.keychain-db
moshi-hook pair --token <YOUR_TOKEN>
```

For headless hosts where Keychain access is undesirable or unreliable:

```bash
moshi-hook pair --token <YOUR_TOKEN> --store file
```

`--store file` writes the host secrets to `~/.config/moshi/secrets.json` with
`0600` permissions and remembers the store choice for future `serve`, `status`,
`usage --sync`, and `pair` commands. Do not use it silently; call out that this
stores secrets outside Keychain.

`moshi-hook install` is non-destructive — it writes Moshi entries into
`~/.claude/settings.json`, `~/.codex/config.toml`, and
`.opencode/plugins/moshi-hooks.ts`, leaving any user-owned hooks alone.

Verify:

```bash
moshi-hook status         # pairing state, socket path, WS connection
moshi-hook logs -f        # tail the daemon log
```

Then run a short real agent task and confirm Moshi receives a push
notification or Live Activity update, and that approving from the Live
Activity / Watch unblocks the agent.

For full CLI reference (every subcommand, flag, env var, and path), see
`app-hook/docs/usage.md` in the monorepo, or the mirrored copy in the
[`rjyo/homebrew-moshi`](https://github.com/rjyo/homebrew-moshi) tap.

### Legacy: `moshi-hooks` (Bun CLI)

The previous Bun-based CLI still works for older agent versions and for
environments where Homebrew is unavailable. It is fire-and-forget — no
bidirectional approvals, no Live Activity / Watch round-trip — but it remains
a valid fallback. Do not mix the two on the same host: if `moshi-hook` is
installed and paired, prefer it.

```bash
bunx moshi-hooks setup
bunx moshi-hooks token <YOUR_TOKEN>
```

Optional integrations:

```bash
bunx moshi-hooks setup --local
bunx moshi-hooks setup .
bunx moshi-hooks setup --codex
bunx moshi-hooks setup --opencode
```
