#!/usr/bin/env node
// Loop efficiency stats for the LAST agent turn in a workspace.
// Usage: node scripts/loop-stats.mjs [workspacePath]   (default: cwd)
//
// Counts model calls per turn and flags WASTE: re-reading a file already read or edited
// earlier in the same turn. Optimal = read each needed file once, edit, done.
import fs from "fs";
import path from "path";

const ws = process.argv[2] || process.cwd();
const logPath = path.join(ws, ".rei", "logs", "agent-flow.jsonl");
if (!fs.existsSync(logPath)) {
  console.error(`No log at ${logPath}`);
  process.exit(1);
}

const lines = fs
  .readFileSync(logPath, "utf8")
  .trim()
  .split("\n")
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

// Group by turn, keep the last one that has a USER_PROMPT.
const turns = new Map();
for (const l of lines) {
  if (!turns.has(l.turnId)) turns.set(l.turnId, []);
  turns.get(l.turnId).push(l);
}
const turnIds = [...turns.keys()];
const lastId = [...turnIds].reverse().find((id) => turns.get(id).some((l) => l.phase === "USER_PROMPT"));
if (!lastId) {
  console.error("No turn with a USER_PROMPT found.");
  process.exit(1);
}
const turn = turns.get(lastId);

const fileOf = (msg) => (msg.split(":")[1] || "").trim().split("/").pop();
const prompt = turn.find((l) => l.phase === "USER_PROMPT")?.data?.prompt || "";

let calls = 0,
  edits = 0,
  reads = 0,
  redundantReads = 0,
  search = 0;
const seen = new Set(); // files already read or edited this turn
let start = null,
  end = null;

for (const l of turn) {
  const ts = new Date(l.timestamp).getTime();
  if (start === null) start = ts;
  end = ts;
  const m = l.data?.message || "";
  if (m.includes("[tools] Response")) calls++;
  if (m.startsWith("[tools] edit_file:") || m.startsWith("[tools] rewrite_file:")) {
    edits++;
    seen.add(fileOf(m));
  } else if (m.startsWith("[tools] read_files:") || m.includes("Reading:")) {
    reads++;
    const f = m.includes("Reading:") ? m.split("Reading:")[1].trim() : fileOf(m);
    if (seen.has(f)) redundantReads++;
    else seen.add(f);
  } else if (m.startsWith("[tools] web_search:") || m.startsWith("[tools] search_tools:")) {
    search++;
  }
}

const secs = ((end - start) / 1000).toFixed(1);
console.log(`\n📊 Loop stats — last turn (${lastId})`);
console.log(`   prompt: ${prompt.slice(0, 80)}${prompt.length > 80 ? "…" : ""}`);
console.log(`   ⏱  total: ${secs}s   🔁 model calls: ${calls}`);
console.log(`   ✏️  edits: ${edits}   📖 reads: ${reads}   🔎 searches: ${search}`);
console.log(
  `   ${redundantReads === 0 ? "✅" : "⚠️ "} redundant re-reads (waste): ${redundantReads}`,
);
if (calls > 0) {
  const avg = (((end - start) / 1000) / calls).toFixed(1);
  console.log(`   ~${avg}s per model call`);
}
console.log("");
