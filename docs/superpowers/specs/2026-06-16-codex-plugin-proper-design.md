# Codex plugin — proper build, staging release, verified install

- **Date:** 2026-06-16
- **Repo / branch:** `daimon-memory-plugins`, `codex/` tree, branch `staging`
- **Status:** Design — approved. Token delivery = **option B (inline header)**.

## 1. Problem

A real install of the daimon-memory Codex plugin does not work. Root cause, established
by probing the live backend (`http://localhost:8080`) and the local install:

- The daimon server **enforces the bearer token**: `/v1/recall` and `/mcp` return `401`
  on a missing, empty, or wrong key (verified). Only a valid key returns `200`.
- The local Codex install has an **empty API key**: `daimon.config.json` `apiKey=""`
  (SHA-256 `e3b0…` = the empty string). The hook client (`lib/daimon.mjs`) only sends
  `Authorization` when the key is non-empty, so Codex hooks call the server with **no
  auth → 401 → recall returns `[]`**. Every hook is fail-soft (`exit 0`), so this fails
  **silently**: no persona at session start, no per-prompt recall.
- The plugin's bundled `.mcp.json` is **empty** (`{"mcpServers":{}}`) in the install, so
  the daimon MCP tools (`recall`/`remember`/`read`) are not registered at all.
- The local Codex install is also **stale** — staged 2026-06-08 from the old server-repo
  `integrations/` tree, before the plugins were extracted to this repo. The current repo
  source is consistent (see §3.4); the divergence was the stale install, not the source.
- The installer **accepts an empty key silently** and never validates auth, so the whole
  failure is invisible to the operator.
- Doc gap: no instructions for obtaining `DAIMON_API_KEY`.

## 2. Goals / non-goals

**Goals**

- A clean install from `staging` produces a **working** Codex integration: persona
  injected, per-prompt recall, daimon MCP tools available + callable, save-nudges, and the
  native-memory mirror.
- The installer **fails loudly** when the key is missing/invalid against an
  auth-enforcing server — never reports success on a dead integration.
- Prevent future Claude Code ↔ Codex shared-lib divergence.
- Document API-key acquisition.

**Non-goals**

- Changing the daimon server or its auth model.
- Changing the Claude Code plugin, except enforcing shared-lib parity.
- OAuth for the MCP server — bearer is sufficient.

## 3. Design

### 3.1 MCP server registration — Codex-native, not bundled

Codex 0.138 manages MCP servers in `config.toml` (`codex mcp …`, transport
`streamable_http`). The plugin's bundled `.mcp.json` is not a reliable channel (it ends up
empty after `plugin add`). The installer registers the daimon MCP server directly.

**Token delivery: option B — inline header (chosen).** The installer writes:

```toml
[mcp_servers.daimon]
url = "http://<endpoint>/mcp"
http_headers = { Authorization = "Bearer <KEY>" }
```

Rationale: works in **every** launch context (terminal + desktop app); no dependency on
`$DAIMON_API_KEY` being exported. The secret already sits at rest in `daimon.config.json`
(hooks channel), so this adds no new exposure class. `config.toml` is `chmod 600`; Codex
masks the header value in its own `codex mcp get` output (verified: `Authorization=*****`).

`codex mcp add` has no header flag, so the installer writes/updates this block via an
**idempotent TOML edit** (Python preferred, `sed` fallback — same pattern already in
`install.sh`). No tenant header is needed: the server resolves the tenant from the key
(verified — recall succeeds without `X-Daimon-Tenant`).

### 3.2 Key delivery — two channels

- **Hooks** (`session-start`, `auto-recall`, `nudge`): read `scripts/lib/daimon.config.json`
  (Codex does not pass env to hook subprocesses). Installer writes the real key here.
  → fixes persona + recall.
- **MCP tools**: inline `http_headers` in `config.toml` (§3.1). → fixes
  `recall`/`remember`/`read`.

### 3.3 Installer hardening

After writing config + registering the server, run an **authenticated probe**:
`POST /v1/recall` with the provided key.

- `200` → print "auth OK".
- `401` → **stop with a clear error**: key missing/invalid against an auth-enforcing
  server; do not report success.
- unreachable → warn (best-effort; recall degrades until the server is up).

If the server is reachable and returns `401` for the provided (empty) key, refuse to finish
with an empty key rather than silently installing a dead integration.

### 3.4 Shared-lib parity

Repo source is **already byte-identical** for the shared set — `lib/daimon.mjs`,
`lib/state-paths.mjs`, `recall-state.mjs`, `nudge-lib.mjs` (verified). Add a `tests/`
**drift-check** that diffs this set between `claude-code/` and `codex/` and fails on
divergence, enforcing the "maintained byte-identical" contract. `mirror-memory.mjs` is
intentionally different (md vs sqlite) and is excluded.

### 3.5 Native-memory mirror

`codex/…/mirror-memory.mjs` reads Codex native memory (`~/.codex/memories_*.sqlite`) via
`node:sqlite` and mirrors into daimon at session start. Requires node ≥ 22.5. Guard: if
`node:sqlite` is unavailable, log a clear skip ("mirror skipped until node ≥ 22.5;
recall/persona/nudge unaffected") and continue. Verify during test that it runs or cleanly
skips.

### 3.6 Docs

Add a "Getting your `DAIMON_API_KEY`" section to the Codex install guide / README: where
the key comes from (server-issued bearer for the tenant), how to pass it (`--api-key` or
the prompt), and that an auth-enforcing server rejects an empty key.

## 4. File-level changes (`codex/` tree)

- `install.sh`: add the `[mcp_servers.daimon]` inline-header write (idempotent); add the
  post-install authenticated probe with loud `401`; refuse silent empty-key; keep
  `daimon.config.json` + native-memory enable.
- `plugins/daimon-memory/.mcp.json` + `.codex-plugin/plugin.json`: drop the bundled-MCP
  declaration (don't advertise a channel Codex won't honor) — MCP lives in `config.toml`.
- `tests/`: shared-lib drift check.
- `README.md` / install guide: API-key how-to.

## 5. Verification (the test-install goal)

Fresh install from `staging`:

1. `codex plugin marketplace add <git-url @ staging>` + `codex plugin add
   daimon-memory@daimon-memory` (or run `install.sh`).
2. Scripted checks against the live server with the real key:
   - SessionStart injects persona (Izu).
   - UserPromptSubmit injects recall.
   - `codex mcp get daimon` enabled; a `recall` + `remember` round-trip via the MCP tool.
   - Save-nudge fires on a signal turn.
   - Native mirror runs or cleanly skips.
3. Hardening: run the installer with an empty key → must **fail loudly**, not succeed.

## 6. Rollout

Develop on `staging` → push `origin staging` → test-install from staging → once green,
promote to `main` (the marketplace default that Claude Code's `settings.json` auto-updates
from).

## 7. Risks / open

- Live MCP auth round-trip via the inline header is not yet end-to-end tested (config parse
  is verified); covered by §5.
- Whether `codex plugin add` re-empties `.mcp.json` is moot once we stop relying on it.
- Hooks use the file channel, so desktop-app launch contexts are unaffected by the
  env-vs-inline choice.
