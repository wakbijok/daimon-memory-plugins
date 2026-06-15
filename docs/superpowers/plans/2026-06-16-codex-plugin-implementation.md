# Codex Plugin Proper-Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a clean install of the Codex daimon-memory plugin produce a working integration (persona + recall + MCP tools), failing loudly on a bad key, with the shared libs guarded against drift and the API-key how-to documented.

**Architecture:** The installer registers the daimon MCP server the Codex-native way — an inline-bearer `[mcp_servers.daimon]` block in `config.toml` (option B) — instead of the bundled `.mcp.json` (which Codex empties). Hooks keep their file-based key channel (`daimon.config.json`). A post-install authenticated probe gates success on real auth.

**Tech Stack:** Bash + Python (installer), Node ESM (.mjs hooks), Codex 0.138 (`codex mcp`/`codex plugin`), daimon-memory HTTP API (`/v1/recall`, `/mcp`).

**Source of truth:** `docs/superpowers/specs/2026-06-16-codex-plugin-proper-design.md`. Branch: `staging`. Backend for testing: `http://localhost:8080`.

---

## File Structure

- `codex/install.sh` — MODIFY. Add MCP registration (config.toml inline header), post-install auth probe, empty-key refusal; remove `.mcp.json` substitution.
- `codex/plugins/daimon-memory/.codex-plugin/plugin.json` — MODIFY. Drop the `"mcpServers"` declaration.
- `codex/plugins/daimon-memory/.mcp.json` — DELETE. MCP now lives in `config.toml`.
- `codex/plugins/daimon-memory/scripts/mirror-memory.mjs` — MODIFY (only if unguarded). Ensure `node:sqlite` (node ≥ 22.5) guard.
- `tests/lib-parity-check.mjs` — CREATE. Fails if the shared libs diverge between `claude-code/` and `codex/`.
- `.github/workflows/*.yml` — MODIFY. Run the parity check in CI.
- `README.md` (repo) — MODIFY. Add "Getting your `DAIMON_API_KEY`" section.

The "byte-identical shared set" (what the parity check guards): `scripts/lib/daimon.mjs`, `scripts/lib/state-paths.mjs`, `scripts/recall-state.mjs`, `scripts/nudge-lib.mjs`. NOT `session-start.mjs` (CC-specific now), `mirror-memory.mjs` (md vs sqlite variant), or `precompact*.mjs` (CC-only).

---

### Task 1: Register the daimon MCP server in config.toml (option B, inline header)

**Files:**
- Modify: `codex/install.sh` (add a `register_mcp` function; call it after `daimon.config.json` is written)

- [ ] **Step 1: Add the `register_mcp` function** (place near `enable_native_memory`)

```bash
# Register the daimon MCP server the Codex-native way: an inline-bearer [mcp_servers.daimon]
# block in config.toml (codex mcp add has no header flag, so write TOML directly). Idempotent:
# strips any existing daimon block first. Skipped if no key (an auth server would 401 anyway).
register_mcp(){
  local cfg="$CODEX_HOME/config.toml"
  [ -n "$API_KEY" ] || { echo "  (no API key; skipping MCP registration — set --api-key to enable the daimon tools)"; return 0; }
  have_python || { echo "  (python3 absent; add [mcp_servers.daimon] manually)"; return 1; }
  ENDPOINT="$ENDPOINT" API_KEY="$API_KEY" CFG="$cfg" pyrun - <<'PY'
import os, re
cfg, endpoint, key = os.environ["CFG"], os.environ["ENDPOINT"], os.environ["API_KEY"]
s = open(cfg).read() if os.path.exists(cfg) else ""
s = re.sub(r'(?ms)^\[mcp_servers\.daimon\][^\[]*', '', s)          # drop existing block
if s and not s.endswith("\n"): s += "\n"
block = ('[mcp_servers.daimon]\n'
         f'url = "{endpoint}/mcp"\n'
         f'http_headers = {{ Authorization = "Bearer {key}" }}\n')
open(cfg, "w").write(s + block)
print("  registered [mcp_servers.daimon] (streamable_http, inline bearer)")
PY
}
```

- [ ] **Step 2: Call it** — after the `daimon.config.json` write block and `chmod 600`, before `enable_native_memory`:

```bash
echo "registering daimon MCP server in $CODEX_HOME/config.toml"
register_mcp || echo "  add manually: [mcp_servers.daimon] url + http_headers Authorization"
```

- [ ] **Step 3: Verify against a throwaway CODEX_HOME** (no real secret needed for the shape)

Run:
```bash
CXT=$(mktemp -d)
CODEX_HOME="$CXT" bash -c 'API_KEY=DUMMY ENDPOINT=http://localhost:8080 CFG="$CODEX_HOME/config.toml" python3 - <<PY
# paste the register_mcp python body, or source install.sh and call register_mcp
PY'
CODEX_HOME="$CXT" codex mcp get daimon
rm -rf "$CXT"
```
Expected: `transport: streamable_http`, `http_headers: Authorization=*****`, `enabled: true`.

- [ ] **Step 4: Commit**

```bash
git add codex/install.sh
git commit -m "feat(codex): register daimon MCP server via config.toml inline bearer (option B)"
```

---

### Task 2: Installer hardening — authenticated probe, fail loud on 401

**Files:**
- Modify: `codex/install.sh` (add `verify_auth`; call near the end, after registration)

- [ ] **Step 1: Add `verify_auth`**

```bash
# Gate success on real auth. daimon-memory enforces a bearer token, so a missing/invalid key
# returns 401 and the integration is silently dead — catch that here instead of "Done".
verify_auth(){
  command -v curl >/dev/null 2>&1 || { echo "  (curl absent; skipping auth probe)"; return 0; }
  local code
  code=$(curl -s -m 6 -o /dev/null -w '%{http_code}' -X POST "$ENDPOINT/v1/recall" \
    -H "content-type: application/json" -H "x-daimon-tenant: $TENANT" \
    ${API_KEY:+-H "authorization: Bearer $API_KEY"} \
    -d '{"query":"ping","filters":{"limit":1}}')
  case "$code" in
    200) echo "  auth OK — recall reachable at $ENDPOINT";;
    401) echo "ERROR: $ENDPOINT rejected the key (401). daimon-memory requires a valid bearer token; yours is missing or invalid. Re-run: ./install.sh --api-key <token>" >&2; exit 1;;
    000) echo "  WARN: $ENDPOINT unreachable; recall is best-effort until the server is up";;
    *)   echo "  WARN: unexpected HTTP $code from $ENDPOINT/v1/recall";;
  esac
}
```

- [ ] **Step 2: Call it** just before the final `bold "Done"`:

```bash
echo "verifying auth against $ENDPOINT"
verify_auth
```

- [ ] **Step 3: Verify the fail-loud path** (empty key vs auth-enforcing server)

Run:
```bash
ENDPOINT=http://localhost:8080 TENANT=00000000-0000-0000-0000-0000000000d1 API_KEY="" \
  bash -c 'source <(sed -n "/^verify_auth()/,/^}/p" codex/install.sh); verify_auth; echo "exit=$?"'
```
Expected: prints the `ERROR: ... rejected the key (401)` line and a non-zero exit (the `exit 1` fires).

- [ ] **Step 4: Commit**

```bash
git add codex/install.sh
git commit -m "feat(codex): post-install auth probe, fail loud on 401 instead of silent dead install"
```

---

### Task 3: Drop the bundled-MCP declaration

**Files:**
- Modify: `codex/plugins/daimon-memory/.codex-plugin/plugin.json` (remove `"mcpServers"`)
- Delete: `codex/plugins/daimon-memory/.mcp.json`
- Modify: `codex/install.sh` (remove the `.mcp.json` placeholder substitution)

- [ ] **Step 1:** Remove the `"mcpServers": "./.mcp.json",` line from `plugin.json`. Verify it still parses:

```bash
node -e 'JSON.parse(require("fs").readFileSync("codex/plugins/daimon-memory/.codex-plugin/plugin.json","utf8")); console.log("plugin.json OK")'
```

- [ ] **Step 2:** `git rm codex/plugins/daimon-memory/.mcp.json`

- [ ] **Step 3:** In `install.sh`, delete the `.mcp.json` substitution lines (the `__DAIMON_MCP_URL__` / `__DAIMON_API_KEY__` replacements in both the python and sed branches). MCP is now `config.toml`.

- [ ] **Step 4:** `node --check` is N/A for JSON; re-run the Task 1 throwaway verify to confirm install still wires MCP. Then commit:

```bash
git add -A codex/
git commit -m "refactor(codex): drop bundled .mcp.json; MCP is registered in config.toml"
```

---

### Task 4: Shared-lib parity drift check + CI

**Files:**
- Create: `tests/lib-parity-check.mjs`
- Test: run it locally
- Modify: the CI workflow under `.github/workflows/` to invoke it

- [ ] **Step 1: Write the check (it IS the test — fails on drift)**

```javascript
// tests/lib-parity-check.mjs — fail if the "byte-identical" shared libs drift between trees.
import { readFileSync } from "node:fs";
const SHARED = [
  "scripts/lib/daimon.mjs",
  "scripts/lib/state-paths.mjs",
  "scripts/recall-state.mjs",
  "scripts/nudge-lib.mjs",
];
const CC = "claude-code/plugins/daimon-memory/";
const CX = "codex/plugins/daimon-memory/";
let bad = 0;
for (const rel of SHARED) {
  const a = readFileSync(CC + rel, "utf8");
  const b = readFileSync(CX + rel, "utf8");
  if (a !== b) { console.error(`DRIFT: ${rel} differs between claude-code/ and codex/`); bad++; }
}
if (bad) { console.error(`\n${bad} shared lib(s) drifted. Re-sync them.`); process.exit(1); }
console.log(`OK: ${SHARED.length} shared libs byte-identical across trees.`);
```

- [ ] **Step 2: Run it — expect PASS now (libs are currently in sync)**

Run: `node tests/lib-parity-check.mjs`
Expected: `OK: 4 shared libs byte-identical across trees.`

- [ ] **Step 3: Prove it catches drift**

Run: `printf '//x\n' >> codex/plugins/daimon-memory/scripts/lib/daimon.mjs; node tests/lib-parity-check.mjs; echo "exit=$?"; git checkout codex/plugins/daimon-memory/scripts/lib/daimon.mjs`
Expected: `DRIFT: scripts/lib/daimon.mjs ...` and `exit=1`, then the file is restored.

- [ ] **Step 4: Wire into CI** — add a step to the existing workflow:

```yaml
      - name: shared-lib parity
        run: node tests/lib-parity-check.mjs
```

- [ ] **Step 5: Commit**

```bash
git add tests/lib-parity-check.mjs .github/
git commit -m "test(ci): fail on claude-code/codex shared-lib drift"
```

---

### Task 5: Native-memory mirror node guard

**Files:**
- Modify (only if needed): `codex/plugins/daimon-memory/scripts/mirror-memory.mjs`

- [ ] **Step 1: Read it** and check whether `node:sqlite` access is guarded:

Run: `grep -n "node:sqlite\|try\|catch" codex/plugins/daimon-memory/scripts/mirror-memory.mjs`

- [ ] **Step 2:** If the `node:sqlite` import is NOT already wrapped so an old Node degrades gracefully, wrap it:

```javascript
let DatabaseSync;
try { ({ DatabaseSync } = await import("node:sqlite")); }
catch { console.error("daimon: native-memory mirror skipped (needs node >= 22.5 for node:sqlite); recall/persona/nudge unaffected"); process.exit(0); }
```

- [ ] **Step 3: Verify graceful skip path** (simulate by checking the script exits 0 even when import unavailable — on a node ≥ 22.5 it should run normally):

Run: `printf '{}' | node codex/plugins/daimon-memory/scripts/mirror-memory.mjs; echo "exit=$?"`
Expected: `exit=0` (runs or cleanly skips).

- [ ] **Step 4: Commit (if changed)**

```bash
git add codex/plugins/daimon-memory/scripts/mirror-memory.mjs
git commit -m "fix(codex): guard native-memory mirror on node < 22.5 (graceful skip)"
```

---

### Task 6: Document how to get the API key

**Files:**
- Modify: `README.md` (repo root)

- [ ] **Step 1:** Add a section (place near install instructions):

```markdown
## Getting your `DAIMON_API_KEY`

The daimon-memory server enforces a per-tenant bearer token. Obtain yours from the
server operator / your daimon control-plane (the token issued for your tenant), then pass
it at install time:

- Claude Code: set `DAIMON_API_KEY` in `~/.claude/settings.json` (`env` block).
- Codex: `./codex/install.sh --endpoint <url> --tenant <uuid> --api-key <token>`.

Without a valid key the server returns `401` and recall/persona/tools silently return nothing.
An empty key is only valid against an unauthenticated (dev) server.
```

- [ ] **Step 2: Verify it renders** (Markdown lint optional): visually confirm headings.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: how to obtain and pass DAIMON_API_KEY"
```

---

### Task 7: E2E test-install from staging + verify (integration)

**Files:** none (verification task). Uses a throwaway `CODEX_HOME` so the real one is untouched.

- [ ] **Step 1: Push the implementation to staging** (Tasks 1-6 committed), then test-install into a throwaway home with the real key (sourced, not printed):

```bash
CXT=$(mktemp -d)
KEY=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.HOME+"/.claude/settings.json","utf8")).env.DAIMON_API_KEY)')
CODEX_HOME="$CXT" ./codex/install.sh --endpoint http://localhost:8080 \
  --tenant 00000000-0000-0000-0000-0000000000d1 --api-key "$KEY" --yes
```
Expected: ends with `auth OK`; no 401.

- [ ] **Step 2: Verify MCP registered**

Run: `CODEX_HOME="$CXT" codex mcp get daimon`
Expected: `enabled: true`, `transport: streamable_http`, `http_headers: Authorization=*****`.

- [ ] **Step 3: Verify hooks inject** (persona + recall) by running them with the staged config:

```bash
P="$CXT/daimon-memory-marketplace/plugins/daimon-memory/scripts"
printf '{"session_id":"e2e","source":"startup"}' | node "$P/session-start.mjs" | node -e 'const c=JSON.parse(require("fs").readFileSync(0,"utf8")).hookSpecificOutput.additionalContext; console.log("persona:",c.includes("<daimon-persona>"),"recall:",c.includes("daimon-memory connected"))'
```
Expected: `persona: true recall: true`.

- [ ] **Step 4: Verify empty-key still fails loud**

Run: `CODEX_HOME=$(mktemp -d) ./codex/install.sh --endpoint http://localhost:8080 --tenant 00000000-0000-0000-0000-0000000000d1 --api-key "" --yes; echo "exit=$?"`
Expected: `ERROR: ... rejected the key (401)` and non-zero exit.

- [ ] **Step 5: Cleanup + record result**

```bash
rm -rf "$CXT"
```
Then a real Codex session smoke test (manual): launch `codex` in a project, confirm the daimon tools are listed and a `recall` call returns hits.

---

## Rollout

After Task 7 passes: the change set is on `staging`. Merge `staging → main` (the marketplace default) once the real Codex smoke test is clean.
