# AGENTS.md — codebuddy-herdr

Guidance for AI agents (and humans) working on this plugin.

## What this plugin does

Makes CodeBuddy a first-class citizen inside **Herdr** (https://herdr.dev), the
terminal multiplexer that hosts coding agents. It reports CodeBuddy's state to
Herdr through CodeBuddy hook events so the Herdr sidebar, `herdr agent list`,
and `herdr agent wait` reflect CodeBuddy's real status:

| CodeBuddy event   | Herdr state  |
| ---               | ---          |
| SessionStart      | idle (+ stores resume command) |
| UserPromptSubmit  | working      |
| PreToolUse        | working      |
| PostToolUse       | working      |
| Stop              | idle         |
| Notification (permission_prompt / elicitation_dialog / agent_needs_input) | blocked |
| Notification (idle_prompt / agent_completed) | idle |
| SessionEnd        | release agent |

## Architecture (read this before changing code)

- `src/herdr-report.ts` — the reporter source. Its committed Node build output,
  `bin/herdr-report.js`, is invoked by **every** hook event (see
  `hooks/hooks.json`) with the hook JSON on stdin. It talks
  **directly to the Herdr socket API** (`HERDR_SOCKET_PATH`) using
  newline-delimited JSON — NOT the `herdr` CLI, which is slower and not meant
  for high-frequency reporting.
- `hooks/hooks.json` — wires the 6 events above to the reporter. The hook
  command is `node "${CODEBUDDY_PLUGIN_ROOT}/bin/herdr-report.js"`: CodeBuddy
  expands `${CODEBUDDY_PLUGIN_ROOT}` at load time, which keeps the command
  identical under `sh`, `cmd.exe`, and PowerShell. Never wrap it in `|| true`
  or other shell-specific chaining; the reporter already exits 0 on any error.
- `commands/herdr-status.md` — the `/codebuddy-herdr:herdr-status` command,
  a read-only helper that shows how this session appears inside Herdr.
- `skills/herdr/SKILL.md` — reference/debugging skill (loaded by the plugin).
- `script/install-dev.mjs` — dev install: installs the plugin into CodeBuddy
  and replaces the cached copy + package-sources copy with **symlinks** to this
  source dir (directory junctions on Windows), so edits apply live via
  `/reload-plugins`. `script/install-dev.sh` is a thin bash wrapper.
- `.codebuddy-plugin/plugin.json` — the manifest (the only file in that dir).

## Hard rules

1. **Use a stable custom integration source.** The reporter's source is
   `"codebuddy"`; do not use the reserved `herdr:` prefix.
2. **No-op unless `HERDR_ENV=1`.** Outside Herdr the reporter exits 0
   immediately. Do not add side effects that run outside Herdr.
3. **Never block the user's session.** The reporter swallows all errors, uses a
   0.5s socket timeout, and always exits 0. Do not add network calls, blocking
   waits, loud failures, or shell-specific error handling in the hook command.
4. **Stay cross-platform.** The reporter must run unchanged on macOS, Linux, and
   Windows: no external binaries, no POSIX-only APIs. Herdr's socket is a Unix
   domain socket on macOS/Linux and a named pipe on Windows, and
   `HERDR_SOCKET_PATH` carries the bare pipe name there.
5. **`seq` must be monotonically increasing** per pane. The reporter derives it
   from `Date.now()` nanoseconds + a persisted counter file in `$TMPDIR`
   (`herdr-codebuddy-seq-<pane>`), guarded by an `O_EXCL` `<counter>.lock` file
   (Node has no `flock`, and macOS ships no `flock(1)`). Never send a
   non-increasing seq or Herdr will ignore the update.
6. **Resume command rules** (Herdr): `resume_argv`'s first token must be a
   plain command on PATH, no apostrophes/control chars, ≤64 args, ≤8 KiB.
   We store `["codebuddy", "--resume", session_id]`.
7. **One logical change per commit.** Keep diffs small and reviewable.

## Testing inside Herdr

This plugin can only be meaningfully tested from inside a Herdr pane. The unit
tests (`npm test`) are cross-platform and need no Herdr.

```bash
# Sanity: confirm the environment
echo "HERDR_ENV=$HERDR_ENV PANE=$HERDR_PANE_ID"

# Drive a state transition manually (PowerShell: use
#   '{"hook_event_name":"PreToolUse"}' | node "$env:CODEBUDDY_PLUGIN_ROOT/bin/herdr-report.js")
echo '{"hook_event_name":"PreToolUse","session_id":"test"}' \
  | node "$CODEBUDDY_PLUGIN_ROOT/bin/herdr-report.js"
herdr pane get "$HERDR_PANE_ID"
herdr agent list
```

Verify the state changes (working / blocked / idle) appear in `herdr agent
list`. A restart of Herdr should restore the stored resume command from its
snapshot.

If a report is silently ignored, check the pane's last accepted `seq`: Herdr
drops any report whose `seq` is not higher, and keeps that high-water mark for
the life of the server.

## Local install (dev)

```bash
node script/install-dev.mjs     # symlinks source into CodeBuddy, enables plugin
# then in CodeBuddy: /reload-plugins
```

Re-run the installer if a CodeBuddy restart replaced the symlink with a copy.
