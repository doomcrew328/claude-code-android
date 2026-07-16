# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

Documentation and bash installers for running Claude Code natively on Android phones (no root). There is no application source code, no build system, and no package manager manifest — the deliverables are shell scripts (`install.sh`, `install-pinned.sh`, `migrate.sh`, `scripts/`, `examples/`) and Markdown docs (`README.md`, `docs/`).

Three documented install paths shape everything here:

- **Path A (native Termux):** `install.sh` downloads Anthropic's official linux-arm64 claude binary, verifies its checksum, patches its ELF interpreter via Termux's glibc-runner so it runs on Android's Bionic libc, and installs a wrapper at `$PREFIX/bin/claude` that auto-updates once per day. `install-pinned.sh` is the opt-in alternative that pins Claude Code 2.1.112 (the last version with a JS entry point) with no patching and no auto-update.
- **Path B (proot-Ubuntu):** Anthropic's official installer inside a proot-distro Ubuntu environment. Mostly documentation; no scripts in this repo implement it.
- **Path C (AVF Linux VM):** Android Virtualization Framework, Pixel 6+ on Android 16+. Documentation only (`docs/avf-guide.md`).

`migrate.sh` upgrades a pinned v2.x install to the Path A auto-updating architecture while preserving sessions, login, and settings.

## Commands

```bash
# Lint — mirrors CI exactly (severity=warning, this exact file list)
shellcheck --severity=warning install.sh install-pinned.sh migrate.sh \
  tests/verify-claims.sh scripts/check-termux-env.sh scripts/fix-ripgrep.sh \
  scripts/config-validator.sh scripts/check-sync.sh tests/ssrf-guard-tests.sh \
  examples/ssrf-guard.sh examples/fingerprint-gate.sh

# Verify install.sh / migrate.sh shared sections have not drifted (runs in CI)
bash scripts/check-sync.sh

# SSRF guard hook test suite (runs anywhere with bash + node + jq)
bash tests/ssrf-guard-tests.sh examples/ssrf-guard.sh

# Device claims verification — Android/Termux device only; writes tests/results/<device>-android<ver>.txt
bash tests/verify-claims.sh
```

CI (`.github/workflows/`) runs ShellCheck + `check-sync.sh` on every push/PR, and lychee link checking (`--offline` for internal links on push/PR; external links on a daily schedule only). Internal Markdown links are checked strictly — a broken relative link or missing anchor fails CI.

Most scripts (`install.sh`, `migrate.sh`, `scripts/check-termux-env.sh`, `tests/verify-claims.sh`) target Termux on Android and cannot be meaningfully executed in a Linux dev container — they check for `$PREFIX=/data/data/com.termux/files/usr`, `getprop`, `pkg`, etc. Validate them with ShellCheck and `check-sync.sh`; behavioral testing requires a real device.

## Critical Convention: SYNC Blocks

`install.sh` and `migrate.sh` independently implement the same resolve/download/checksum/patchelf logic and emit the same wrapper script — `migrate.sh` mirrors `install.sh` rather than sourcing it. The shared sections are fenced with matching `# SYNC:BEGIN <name>` / `# SYNC:END <name>` markers (`resolve-download-patch` and `wrapper-heredoc`) and must stay **byte-identical** between the two files. If you edit inside a SYNC block in one file, make the identical edit in the other, then run `bash scripts/check-sync.sh`. CI enforces this.

## Architecture Notes

- **The wrapper is a heredoc.** The auto-updating launcher that ends up at `$PREFIX/bin/claude` is generated from the `wrapper-heredoc` SYNC block inside `install.sh`/`migrate.sh`. Changes to launcher behavior (version checks, rollback/self-healing, `--update-now`, the `setdns.js` DNS preload) are edits to that heredoc, in both files.
- **Hooks and their tests are paired.** `examples/ssrf-guard.sh` is a PreToolUse hook blocking WebFetch/WebSearch to private/reserved IPs; `tests/ssrf-guard-tests.sh` asserts its block/allow behavior via exit codes (0 = allow, 2 = block). Changing the guard means keeping the test suite green. `examples/fingerprint-gate.sh` is a sourceable biometric-approval function using `termux-fingerprint`.
- **Scripts vs. skills split:** deterministic checks live as bash scripts under `scripts/` (each with a documented exit-code contract in its header comment); judgment-requiring guidance lives as skills under `.claude/skills/` (`termux-safe`, `minimum-viable`, `scope-framing`), each a `SKILL.md` with Claude Code frontmatter (`user-invocable`, `disable-model-invocation`, `argument-hint`, `allowed-tools`). `scripts/config-validator.sh` audits `.claude/` directories for frontmatter/naming/cross-reference consistency.
- **Termux constraints govern all documented commands.** No `sudo`, no systemd, no standard Linux paths (`/usr/bin`, `/etc`), no ports below 1024, `pkg` preferred over `apt`. `.claude/skills/termux-safe/SKILL.md` is the authoritative constraints list — consult it before writing or editing any command a user would run on-device. The runtime signal for "inside Termux" is `$PREFIX == /data/data/com.termux/files/usr` (not `process.platform`, which reports `linux` on Path A v2.9+ installs).

## Documentation Conventions

- **Claims must be empirically verified.** The docs state what was tested, on which device, and when. The README's Device Compatibility table carries per-device last-verified dates; `tests/verify-claims.sh` exists to back documentation claims with PASS/FAIL/SKIP evidence, and device transcripts live in `tests/results/`. Don't add capability claims you can't source to a test run or an upstream reference.
- **Troubleshooting entries are symptom-shaped:** titled by the error the user sees, followed by cause and fix (`docs/troubleshooting.md`).
- **Versioning:** the `VERSION` file holds the repo's own version (distinct from the Claude Code version it installs), and `CHANGELOG.md` follows Keep a Changelog format (`## [x.y.z] - YYYY-MM-DD`). Release-worthy changes get a changelog entry.
- **Line endings are LF, enforced by `.gitattributes`** — CRLF breaks bash on Termux.
- `docs/constitution-template.md` is a CLAUDE.md template shipped *for end users' own projects on Android*; it is not this repo's guidance file.

## Shell Script Conventions

- `install.sh` uses the Termux shebang `#!/data/data/com.termux/files/usr/bin/bash`; everything else uses `#!/usr/bin/env bash`.
- Every script opens with a header comment stating purpose, usage, and exit codes; diagnostic scripts print PASS/WARN/FAIL rows and are read-only/safe to re-run.
- `set -euo pipefail` where aborting on error is safe; the diagnostic/verification scripts deliberately use `set -uo pipefail` (no `-e`) so one failed check doesn't kill the run.
- Keep ShellCheck clean at `--severity=warning` — it's the CI gate.
