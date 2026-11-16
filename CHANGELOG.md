# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.4 — 2026-11-16

### Added

- Windows support. Herdr's API socket is a named pipe there, so the reporter
  now adds the `\\.\pipe\` prefix when the platform needs it.
- `script/install-dev.mjs`, a cross-platform dev installer that uses directory
  junctions on Windows and plain symlinks elsewhere. `script/install-dev.sh`
  stays as a three-line wrapper.
- `LICENSE` (MIT), which the README already claimed.
- CI matrix running the build and the unit tests on macOS, Linux, and Windows.

### Changed

- Hook commands use CodeBuddy's load-time `${CODEBUDDY_PLUGIN_ROOT}`
  substitution instead of POSIX `$CODEBUDDY_PLUGIN_ROOT` plus `|| true`, so one
  identical command works under `sh`, `cmd.exe`, and PowerShell. The reporter
  already exits 0 on every error.
- Docs list all seven wired hook events, including `PostToolUse`.

### Fixed

- Reports were silently dropped on macOS: the `seq` guard called the `flock`
  utility, which macOS does not ship. It is now an `O_EXCL` lock file.
- The dev installer compared symlinks with `readlink -f`, which BSD `readlink`
  does not support.
- Notification mapping was a substring guess, so `elicitation_dialog` and
  `agent_needs_input` never reported `blocked` and `agent_completed` never
  reported `idle`. It is now an explicit table, compared without regard to case
  or separators.
- `npm ci` failed with `EALLOWREMOTE` on npm 12 because the lockfile resolved
  tarballs through an `http://mirrors.tencent.com` mirror. It now points at
  `registry.npmjs.org`.

## 0.1.3 — 2026-10-28

### Changed

- Report under the stable custom source `codebuddy` instead of the reserved
  `herdr:` prefix, which is for integrations shipped by Herdr itself.

## 0.1.2 — 2026-10-24

### Fixed

- `idle_prompt` notifications report `idle` instead of `blocked`; the substring
  match on "prompt" made a finished turn stick as blocked.

## 0.1.1 — 2026-10-24

### Fixed

- `PostToolUse` re-asserts `working`, clearing a stale `blocked` state left by a
  notification the user already answered.

## 0.1.0 — 2026-10-24

### Added

- Initial release: a TypeScript reporter that maps CodeBuddy hook events
  (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`,
  `Notification`, `SessionEnd`) to Herdr's `pane.report_agent` /
  `pane.release_agent` socket calls, stores `codebuddy --resume <session_id>`,
  and no-ops outside Herdr.
- `/codebuddy-herdr:herdr-status` command and the bundled `herdr` skill.
- Dev install script that links the plugin source into CodeBuddy for live
  editing.

