#!/usr/bin/env node
// SessionStart hook. Injects, once per session: (1) the canonical PERSONA + operating protocols
// (full bodies); (2) an <open-items> block carrying the FULL body of the curated "Active Open
// Items" summary, so the agent can orient on what is pending; (3) recent shared memory. Seeds the
// session "already injected" set so per-turn recall stays incremental. Best-effort: any failure
// injects nothing. (Note: Claude Code cannot render a greeting before the user's first turn, so
// this hook supplies context, not an auto-greeting; see lesson on session-start behavior.)
import { readStdin, recall, read, formatHits, loadSystemBlock, injectAndExit, ENDPOINT } from "./lib/daimon.mjs";
import { clearInjected, markInjected } from "./recall-state.mjs";
import { loadPrecompact, clearPrecompact } from "./precompact-state.mjs";

const input = await readStdin();
const sessionId = input.session_id || input.sessionId || "default";
clearInjected(sessionId); // fresh session (re-fires on compaction) -> per-turn recall refreshes

const [persona, recent, openHits] = await Promise.all([
  loadSystemBlock(),
  recall("", { limit: 5 }),
  // The living "Active Open Items" summary is the curated source of truth for OPEN vs CLOSED.
  recall("active open items pending in progress", { limit: 1, kind: "resource_summary" }),
]);

// Read the FULL open-items body (recall returns ~240-char abstracts, too short for a complete
// pending list). Fall back to the abstract if the read fails.
let openBody = "", openUri = "";
if (openHits.length) {
  openUri = openHits[0].uri;
  const rec = await read(openUri);
  openBody = ((rec && rec.body) ? rec.body : (openHits[0].abstract || "")).trim();
}

const recentHits = recent.filter((h) => {
  const u = h.uri || "";
  if (u.includes("/agent/persona/") || u.includes("/agent/protocol/")) return false;
  return u !== openUri; // shown in the open-items block below; don't duplicate
});
const recentBlock = formatHits(
  recentHits,
  `<daimon-memory>\n[daimon-memory connected (${ENDPOINT}). Recent shared context across your tools:]`,
);

const openBlock = openBody
  ? "<open-items>\n[Current OPEN / in-progress items (curated Active Open Items doc). Reference when orienting; respect its STATUS markers, skip anything CLOSED.]\n\n" + openBody + "\n</open-items>"
  : "";

const parts = [];
if (persona) parts.push(persona);
if (openBlock) parts.push(openBlock);
if (recentBlock) parts.push(recentBlock + "\n</daimon-memory>");

// Compaction-only continuity: after a compaction (source=compact), re-inject the volatile
// working context the summary tends to drop (captured by precompact.mjs), then clear it.
if (input.source === "compact") {
  const snap = loadPrecompact(sessionId);
  if (snap) {
    const lines = [
      "<compaction-continuity>",
      "[Pre-compaction working context, re-anchor after the summary:]",
      `- branch: ${snap.branch}  |  cwd: ${snap.cwd}`,
    ];
    if (snap.plan) lines.push(`- active plan: ${snap.plan}`);
    if (Array.isArray(snap.dirty) && snap.dirty.length) {
      lines.push("- modified files:\n" + snap.dirty.map((d) => "  " + d).join("\n"));
    }
    lines.push("</compaction-continuity>");
    parts.unshift(lines.join("\n"));
    clearPrecompact(sessionId);
  }
}

// Seed the session set so the per-turn recall does not re-inject what we just showed.
markInjected(sessionId, [...recentHits.map((h) => h.uri), ...(openUri ? [openUri] : [])]);

injectAndExit("SessionStart", parts.join("\n\n"));
