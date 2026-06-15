#!/usr/bin/env node
// SessionStart hook. Injects, once per session: (1) the canonical PERSONA + operating
// protocols from agent/persona + agent/protocol (full bodies); (2) a HEARTBEAT greeting block
// carrying the FULL body of the curated "Active Open Items" summary and instructing the first
// reply to greet with the open/pending items (a missing or empty greeting is the visible tell
// the hook did not fire); (3) recent high-signal shared memory (empty-query recall, minus the
// system layer + the open-items doc already shown). Seeds the "already injected" set so per-turn
// recall stays incremental. Best-effort: any failure injects nothing.
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
  return u !== openUri; // shown in the pending-items greeting below; don't duplicate
});
const recentBlock = formatHits(
  recentHits,
  `<daimon-memory>\n[daimon-memory connected (${ENDPOINT}). Recent shared context across your tools:]`,
);

// HEARTBEAT: every session surfaces persona (above) + the open/pending items, and instructs the
// FIRST reply to greet with them. A missing or empty greeting is the visible signal the
// SessionStart/recall hook did not fire -- the silent failure mode that hid the Codex outage.
const greetingBlock = openBody
  ? "<session-greeting>\n[Open your FIRST reply with a SHORT greeting: confirm daimon-memory is live, then summarize the current OPEN / in-progress items from the list below. Respect its STATUS markers (skip anything CLOSED). Keep it brief -- a greeting, not a report.]\n\n" + openBody + "\n</session-greeting>"
  : "<session-greeting>\n[Open your FIRST reply with a SHORT greeting confirming daimon-memory is live. No \"Active Open Items\" summary was returned -- say so plainly; it may signal incomplete recall.]\n</session-greeting>";

const parts = [];
if (persona) parts.push(persona);
parts.push(greetingBlock);
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
