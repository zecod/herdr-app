// Claude Code's own subagents (its Agent/Task tool), for the mini rows under their agent.
//
// Claude keeps each one beside its session: ~/.claude/projects/<cwd slug>/<sessionId>/subagents/
// agent-<id>.jsonl (the transcript) and agent-<id>.meta.json ({ description, agentType,
// requestShape: "background" | ..., toolUseId }). speed.js finds an agent's session folder;
// subagents-helper.cjs reads the end of the transcripts (state, what it's doing, when it started),
// because the mod runtime's fs can't stat or read part of a file.
//
// Shown: only the running ones; one that finishes (or stops) leaves the sidebar at once. A running
// one whose transcript hasn't moved for STALE_MS is taken as dead (the CLI crashed or was killed).
//
// Cost: nothing runs while no subagent is busy. main.js watches each subagents/ folder
// (watchFolder) and calls refresh() with the changed transcripts; the helper runs then, at most
// once every 2 s, and only for transcripts that changed.

import { exec, appHome } from "herdr";
import * as fs from "fs/promises";
import { b64 } from "./speed.js";

const HELPER = `${appHome().replace(/\\/g, "/")}/mods/my-spaces/subagents-helper.cjs`;
export const STALE_MS = 12 * 60 * 1000;

const dirs = new Map(); // session dir -> { subs: Map(id -> sub), listed: 0 }
// sub: { id, description, type, background, file, size, birthMs, lastAt, state, activity, result }

export const norm = (p) => String(p ?? "").replace(/\\/g, "/").toLowerCase();
const base = (p) => String(p ?? "").replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";

/** Reads the folder's list of subagents (cheap) and adds new ones. Returns the new ones' files. */
export async function list(dir) {
  let e = dirs.get(dir);
  if (!e) { e = { subs: new Map(), listed: 0 }; dirs.set(dir, e); }
  let names;
  try { names = await fs.readdir(`${dir}/subagents`); } catch { e.listed = Date.now(); return { exists: false, fresh: [] }; }
  const fresh = [];
  for (const n of names) {
    const m = /^agent-([\w-]+)\.meta\.json$/.exec(n);
    if (!m || e.subs.has(m[1])) continue;
    let meta = {};
    try { meta = JSON.parse(await fs.readFile(`${dir}/subagents/${n}`, "utf8")); } catch {}
    const file = `${dir}/subagents/agent-${m[1]}.jsonl`;
    e.subs.set(m[1], {
      id: m[1], file, size: undefined, birthMs: null, lastAt: 0, state: "unknown", activity: null, result: null,
      description: String(meta.description ?? "").trim() || "Subagent", type: meta.agentType ?? null,
      background: meta.requestShape === "background",
    });
    fresh.push(file);
  }
  e.listed = Date.now();
  return { exists: true, fresh };
}

/** Re-reads these transcripts (all not yet read when `files` is null). True when anything shown changed. */
export async function refresh(dir, files = null) {
  const e = dirs.get(dir);
  if (!e) return false;
  const want = new Set((files ?? []).map(norm));
  const subs = [...e.subs.values()].filter((s) => s.state === "unknown" || want.has(norm(s.file)) || (!files && s.state === "running"));
  if (!subs.length) return false;
  let r;
  try {
    r = await exec("node", [HELPER, b64(JSON.stringify({ files: subs.map((s) => ({ path: s.file, size: s.size })) }))]);
  } catch { return false; }
  if (r.code !== 0) return false;
  let out;
  try { out = JSON.parse(r.stdout); } catch { return false; }
  const before = signature(dir);
  for (const f of out.files ?? []) {
    const s = subs.find((x) => x.file === f.path);
    if (!s || f.error) continue;
    if (f.same) continue;
    // Run start: the latest prompt; else the file's birth when recent (an old resumed one: unknown).
    const startAt = f.promptAt ?? (Date.now() - f.birthMs < 6 * 3600 * 1000 ? f.birthMs : null);
    Object.assign(s, { size: f.size, birthMs: f.birthMs, startAt, lastAt: f.lastAt, state: f.state, activity: f.activity, result: f.result });
  }
  return signature(dir) !== before;
}

/** The subagents to show under this session's agent, oldest first. */
export function shown(dir, now = Date.now()) {
  const e = dirs.get(dir);
  if (!e) return [];
  return [...e.subs.values()]
    .map((s) => (s.state === "running" && now - s.lastAt > STALE_MS ? { ...s, state: "stopped" } : s))
    .filter((s) => s.state === "running")
    .sort((a, b) => (a.birthMs ?? 0) - (b.birthMs ?? 0));
}

export function runningCount(dir, now = Date.now()) {
  return shown(dir, now).filter((s) => s.state === "running").length;
}

export function hasRunning(dir) {
  const e = dirs.get(dir);
  return !!e && [...e.subs.values()].some((s) => s.state === "running" || s.state === "unknown");
}

/** What it's doing, in a few words: the tool call's description, else the tool and its file. */
export function activityText(s) {
  const a = s.activity;
  if (!a) return s.state === "running" ? "Thinking" : null;
  if (typeof a === "string") return a;
  const f = base(a.path);
  switch (a.tool) {
    case "Read": return f ? `Reading ${f}` : "Reading";
    case "Edit": case "Write": case "NotebookEdit": return f ? `Editing ${f}` : "Editing";
    case "Grep": case "Glob": return "Searching";
    case "WebFetch": case "WebSearch": return "Browsing";
    case "Bash": case "PowerShell": return "Running a command";
    case "Agent": case "Task": return "Starting a subagent";
    default: return a.tool ?? null;
  }
}

/** How long this run has been going ("12m"), or null when its start isn't known. */
export function runningFor(s, now = Date.now()) {
  return s.state === "running" && s.startAt ? ago(now - s.startAt) : null;
}

/** "45s", "12m", "1h 5m". */
export function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function signature(dir) {
  return JSON.stringify(shown(dir).map((s) => [s.id, s.state, s.activity, s.result ? 1 : 0]));
}
