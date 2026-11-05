// Personal copy of the shipped `spaces` mod (cloned from 0.1.12). Changes:
// - each space shows a folder icon instead of its colored letter avatar;
// - the "+" buttons open the `add-project` dialog (browse, clone, create)
//   instead of starting an empty space in the home folder.
// - each space's agents are listed under it with tree lines (sub-agents a level
//   deeper), titled by their session title; a spinner while working, a dot
//   otherwise (red pulsing: needs you, green: just finished, grey: idle).
//   Clicking the folder icon folds them. This replaces the separate agents list,
//   so this mod also sets the agent.next/prev order.
// Space colors are still assigned below because the picker mod reads them.
//
// Cost (2026-11-04): no 250 ms poll. What could make git due is looked at after each redraw
// (live data changed) and every 5 s for time-based fallbacks; a place's repo is asked once
// (rev-parse), then only `git status`; `hc machine ls` runs when the app's machines change,
// on coming back to the window, and every 60 s (15 s with other machines); redraws only
// when git, machines or tok/s actually changed; the needs-you pulse runs only while the
// window is in front (a `loop` rebuilds the whole list ~30x/s).
//
// Workspace spaces: worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, machines, panes, agents, terminals, setAgentOrder, run, openOverlay, exec, hc, theme, shared, setShared, watchFolder, window, layout } from "herdr";
import { smartPress, smartMove, smartRelease } from "./smart-split.js"; // smart split: drag an agent onto the shown tab
import { lastTurnSpeed, peekSpeed, speedNeedsRefresh, formatSpeed, claudeSessionDir } from "./speed.js"; // tokens/s of each finished turn
import * as SA from "./subagents.js"; // Claude Code subagents: mini rows under their agent

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
const isPath = (s) => /^[~/]|^[A-Za-z]:\\/.test(s) || s.includes("@");

// What an agent's session is about: the title it set (Claude Code and others name
// their sessions), else a tab someone named, else the program.
function agentTitle(a) {
  const live = clean(a.title);
  const prog = a.program?.name;
  if (live && live !== prog && live.toLowerCase() !== a.program?.key && !isPath(live)) return live;
  const tab = a.tab_name;
  if (tab && !/^\d+$/.test(tab) && tab !== prog) return tab;
  return prog || a.address;
}

// A terminal's status word and what it says it's doing; terminals() may carry
// either the word or the core's { state, msg }.
const stateOf = (term) => (typeof term?.status === "string" ? term.status : term?.status?.state ?? null);
const msgOf = (term) => term?.report?.msg ?? (typeof term?.status === "object" ? term?.status?.msg : term?.msg) ?? null;

function programIcon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
const AGENT_ROW = 26; // px
const LEVEL = 24; // px between tree levels: a child line drops from the centre of its parent's icon

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

// The add-project dialog, for this computer (machine null) or another machine.
export function addProject(machine) {
  openOverlay({ mod: "add-project", kind: "dialog", width: 520, props: { machine: machine ?? null } });
}

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

export default class Spaces extends View {
  init(_props, cx) {
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.machines = [];
    this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
    for (const state of Object.values(this.reconnecting)) state.busy = false;
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.agentsFolded = new Set(JSON.parse(localStorage.getItem("agents.folded") ?? "[]"));
    this.agentList = [];
    this.terms = new Map();
    this.where = {}; // where() -> { top, common, at }: a place's repo, asked once (it doesn't move)
    this.machinesAt = 0;
    this.refreshMachines(cx);
    // `hc machine ls` is a process: asked when the app's machines change (see render), on
    // coming back to the window, and now and then for connection states (often only when
    // there are other machines to show).
    cx.timer.every(15000, (cx) => {
      if (window().active === false) return;
      if (this.machines.length || Date.now() - this.machinesAt >= 60000) this.refreshMachines(cx);
    });
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`). Looked at after every redraw
    // (spaces, panes and machines changing redraw this list) and every few seconds for
    // what only time changes (the fallback, places git couldn't answer for).
    cx.timer.every(5000, (cx) => this.checkNew(cx));
    // Tokens per second of each agent's last finished turn (speed.js); work only when a state changed.
    cx.timer.every(1500, (cx) => this.speeds(cx));
    // Claude Code subagents (subagents.js): sessions and new ones by folder reads; changes by watchFolder.
    this.subDirs = new Map(); // agent address -> { dir, pid, at }
    this.subWatching = new Set();
    this.subDirty = new Map(); // dir -> changed transcripts
    this.subsOpen = new Set(); // agents whose subagents are all shown
    cx.timer.every(4000, (cx) => {
      if (window().active === false && this.subAt && Date.now() - this.subAt < 20000) return; // slower in the background
      this.subAt = Date.now();
      this.subScan(cx);
    });
    this.subScan(cx);
  }

  // After a redraw (live data changed), once: what that change makes due.
  afterRender(cx) {
    if (this.checkQueued) return;
    this.checkQueued = true;
    cx.spawn(async (cx) => {
      this.checkQueued = false;
      this.checkNew(cx);
      this.speeds(cx);
    });
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    // A new space waits (at most 1.5 s) for its git to place it: draw again when that's up.
    const waiting = sp.filter((s) => !this.shown.has(s.id));
    if (waiting.length && !this.waitTimer) {
      const wait = Math.max(50, Math.min(...waiting.map((s) => this.born[s.id] + 1520)) - now);
      this.waitTimer = true;
      cx.timer.after(wait, (cx) => { this.waitTimer = false; cx.notify(); });
    }
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    if (this.machinesBusy) { this.machinesAgain = true; return; }
    this.machinesBusy = true;
    this.machinesAt = Date.now();
    cx.spawn(async cx => {
      const before = JSON.stringify(this.machines);
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      this.machinesBusy = false;
      if (JSON.stringify(this.machines) !== before) cx.notify();
      if (this.machinesAgain) { this.machinesAgain = false; this.refreshMachines(cx); }
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      const before = JSON.stringify(this.git);
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      // Redraw only when something it shows moved (branch, ahead/behind, a new repo).
      if (JSON.stringify(this.git) !== before) cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        delete this.where[key];
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it. A place's
      // repo doesn't move: asked once (one process, both answers), again after 10 minutes.
      let w = this.where[key];
      if (!w || Date.now() - w.at > 600000) {
        const rp = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], { cwd, on });
        const [common, top] = rp.stdout.split(/\r?\n/).map((s) => s.trim());
        w = this.where[key] = { common, top, at: Date.now() };
      }
      const repo = w.common;
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${w.top}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "my-menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null })).filter((r) => this.shown.has(r.w.id));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    return out;
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered();
    // Each space with its worktrees (the rows right after it marked `tree`) as one tree.
    const drawAll = (list) => {
      if (collapsed) return list.flatMap((r) => this.compact(r, t));
      const out = [];
      for (let k = 0; k < list.length; k++) {
        if (list[k].tree && k > 0) continue; // drawn under its repo's space
        const kids = [];
        for (let j = k + 1; j < list.length && list[j].tree; j++) kids.push(list[j]);
        out.push(...this.spaceTree(list[k], kids, t));
      }
      return out;
    };
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => div().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(8).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : drawAll(rows);
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const folded = this.folded.has(m);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 2 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none())
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected && !rebuilt, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
            .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .hover(s => s.text_color(t.foreground))
              .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "Connecting…" : "Connect"))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); addProject(m); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => addProject(m))
        .child(svg("mods/workspace-chrome/plus.svg").size(12)).when(!collapsed, el => el.child("Add a project there"));
      if (!collapsed && rebuilt) return [head];
      return [head, ...(folded ? [] : mine.length ? drawAll(mine) : [loading(m) ? loadingRow(m) : empty])];
    });
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  speeds(cx) {
    if (this.speedBusy) return;
    const terms = new Map(terminals().map((k) => [k.address, k]));
    const due = agents().filter((a) => !a.address.includes("/") && terms.get(a.address) && speedNeedsRefresh(a, terms.get(a.address)));
    if (!due.length) return;
    this.speedBusy = true;
    const shown = () => JSON.stringify(due.map((a) => peekSpeed(a.address) ?? null));
    const before = shown();
    cx.spawn(async (cx) => {
      try { for (const a of due) await lastTurnSpeed(a, terms.get(a.address)).catch(() => null); }
      finally {
        this.speedBusy = false;
        if (shown() !== before) { this.publishSpeeds(); cx.notify(); }
      }
    });
  }

  // shared "agents.speed": address -> last finished turn's speed, read by the status bar (my-status).
  publishSpeeds() {
    const map = {};
    for (const a of agents()) {
      const r = peekSpeed(a.address);
      if (r?.tps) map[a.address] = { tps: Math.round(r.tps), label: formatSpeed(r), outputTokens: r.outputTokens, modelMs: r.modelMs, wallMs: r.wallMs, endedAt: r.endedAt };
    }
    const sig = JSON.stringify(map);
    if (sig === this.speedSig) return;
    this.speedSig = sig;
    setShared("agents.speed", map);
  }

  // A "border beam": a bright arc running around `inner`'s edge (the active agent while it
  // works). One wedge (beam.svg) spins, centred on the element, seen only through four thin
  // strips along the edges (each clips its own copy), so it never covers the content: herdr
  // paints the animated shape above backgrounds. The strips stop short of the rounded corners.
  // Native animation: no timers, it stops when not shown.
  beam(t, inner, { id, w, h, radius, edge }) {
    const d = Math.ceil(Math.hypot(w, h)) + 6, k = 1.5, r = Math.max(2, radius - 1);
    const strip = (n, x, y, sw, sh) => div().id(`${id}-beam-${n}`).absolute().left(x).top(y).w(sw).h(sh).overflow_hidden()
      .child(svg("mods/my-spaces/beam.svg").absolute().w(d).h(d).left((w - d) / 2 - x).top((h - d) / 2 - y).text_color(t.working).spin(1700));
    return div().id(`${id}-beam`).relative().w(w).h(h).flex_none()
      .child(inner.w(w).h(h).rounded(radius).border_1().border_color(edge ?? t.border))
      .child(strip("t", r, 0, w - 2 * r, k))
      .child(strip("b", r, h - k, w - 2 * r, k))
      .child(strip("l", 0, r, k, h - 2 * r))
      .child(strip("r", w - k, r, k, h - 2 * r));
  }

  // "94 tok/s" and its tooltip line, for an agent that isn't working.
  speedOf(a) {
    if (a.status === "working") return null;
    const r = peekSpeed(a.address);
    if (!r?.tps) return null;
    const secs = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);
    return {
      label: formatSpeed(r),
      tip: `last turn: ${r.outputTokens.toLocaleString?.() ?? r.outputTokens} output tokens in ${secs(r.modelMs)} of model time (${secs(r.wallMs)} in all)${r.partial ? ", partial" : ""}`,
    };
  }

  // Right-click on an agent: copy its ids, or a note another agent can use to talk to it.
  agentMenu(address, title, program, pane, pinned) {
    const r = peekSpeed(address);
    const cwd = (pane && panes().find((p) => p.pane === pane)?.cwd) || this.terms.get(address)?.cwd || null;
    openOverlay({ mod: "agent-menu", kind: "popup", width: 236, height: 300, // smart split: was 230, room for "Move to this tab"
      props: { address, title, program, pane, pinned, cwd, sessionId: r?.sessionId ?? null, source: r?.source ?? null } });
  }

  // ---- Claude Code subagents (subagents.js): mini rows under their agent ----

  // Every few seconds (cheap: reading folders, no process): which session each Claude Code agent
  // is in, and new subagents there. A changed transcript is noticed by watchFolder (subWatch),
  // which batches into subFlush; time alone (a stale one, a finished one leaving) by the
  // signature check here.
  subScan(cx) {
    if (this.subBusy) return;
    this.subBusy = true;
    cx.spawn(async (cx) => {
      try {
        const now = Date.now();
        const live = new Set();
        for (const a of agents()) {
          const term = this.terms.get(a.address);
          if (!term || a.address.includes("/")) continue;
          live.add(a.address);
          const known = this.subDirs.get(a.address);
          const test = shared("subagents.test"); // testing only: one session folder for every agent
          if (typeof test === "string") this.subDirs.set(a.address, { dir: test, pid: term.pid, at: now });
          // Re-linked now and then: a /clear or a resumed session moves it to another folder.
          else if (!known || known.pid !== term.pid || now - known.at > 30000) {
            const dir = await claudeSessionDir(a, term).catch(() => null);
            this.subDirs.set(a.address, { dir, pid: term.pid, at: now });
          }
          const dir = this.subDirs.get(a.address)?.dir;
          if (!dir) continue;
          const { exists, fresh } = await SA.list(dir);
          if (exists) this.subWatch(dir, cx);
          if (fresh.length) await SA.refresh(dir, fresh);
        }
        for (const k of [...this.subDirs.keys()]) if (!live.has(k)) this.subDirs.delete(k);
      } finally {
        this.subBusy = false;
        const sig = this.subSignature();
        if (sig !== this.subSig) { this.subSig = sig; cx.notify(); }
      }
    });
  }

  // What the mini rows show, minute-rounded: a change means a redraw.
  subSignature() {
    const now = Date.now();
    const out = [];
    for (const [addr, { dir }] of this.subDirs) {
      if (!dir) continue;
      for (const s of SA.shown(dir, now)) out.push([addr, s.id, s.state, SA.activityText(s), s.state === "running" && s.startAt ? Math.floor((now - s.startAt) / 60000) : 0]);
    }
    return JSON.stringify(out);
  }

  // One watch per subagents/ folder; a change marks its transcripts to read again.
  subWatch(dir, cx) {
    if (this.subWatching.has(dir)) return;
    this.subWatching.add(dir);
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          const paths = await watchFolder(`${dir}/subagents`);
          if (![...this.subDirs.values()].some((d) => d.dir === dir)) break; // its agent is gone
          const set = this.subDirty.get(dir) ?? new Set();
          for (const p of paths ?? []) {
            const n = SA.norm(p);
            if (n.endsWith(".jsonl")) set.add(n);
            else if (n.endsWith(".meta.json")) set.add("*new");
            else set.add("*all"); // the folder itself: look at everything
          }
          this.subDirty.set(dir, set);
          if (!this.subFlushQueued) {
            this.subFlushQueued = true;
            cx.timer.after(2000, (cx) => this.subFlush(cx)); // at most one read every 2 s
          }
        }
      } catch {} finally {
        this.subWatching.delete(dir);
      }
    });
  }

  subFlush(cx) {
    this.subFlushQueued = false;
    const work = [...this.subDirty];
    this.subDirty.clear();
    cx.spawn(async (cx) => {
      let changed = false;
      for (const [dir, set] of work) {
        const { fresh } = await SA.list(dir);
        const files = set.has("*all") ? null : [...set].filter((f) => !f.startsWith("*")).concat(fresh);
        if (await SA.refresh(dir, files)) changed = true;
      }
      const sig = this.subSignature();
      if (changed || sig !== this.subSig) { this.subSig = sig; cx.notify(); }
    });
  }

  // A mini row: shorter and quieter than an agent's, for what works under it.
  miniRow(t, { id, lines, base, first, mark, title, right, tip, action, menu, faded, drag }) {
    const H = 20;
    const x = base + (lines.length - 1) * LEVEL;
    return h_flex().relative().id(id).h(H).flex_none().items_center().text_size(11.5)
      .children(this.connectors(lines, base, first, t, H))
      .child(h_flex().id(`${id}-body`).ml(x + 11).flex_1().min_w(0).h(H - 2).pl(6).pr(8).gap(6).items_center().rounded(6)
        .hover((s) => s.bg(t.hover)).cursor_pointer()
        .when(Boolean(tip), (el) => el.tooltip(tip))
        .when(Boolean(action), (el) => el.on_click(action))
        .when(Boolean(menu), (el) => el.on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); menu(); }))
        .when(Boolean(drag), (el) => el.on_mouse_down("left", (e) => smartPress(this, drag, e))) // smart split
        .when(Boolean(faded), (el) => el.opacity(0.6))
        .child(div().w(12).flex_none().flex().items_center().justify_center().child(mark))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(title))
        .when(Boolean(right), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(right))));
  }

  // The mark of a mini row: a small spinner, a check, or a dot.
  miniMark(t, state) {
    if (state === "working" || state === "running") return svg("mods/workspace-chrome/spinner.svg").size(10).text_color(t.working).spin(900);
    if (state === "done") return svg("mods/my-spaces/check.svg").size(10).text_color(t.done ?? t.ansi2);
    if (state === "blocked") return div().size(6).rounded(3).bg(t.blocked);
    return div().size(5).rounded(3).bg(t.dim);
  }

  // Claude Code subagents of agent `a`, as mini rows: running ones, and finished ones a little
  // while. More than three fold into "+N more" (click: show all).
  ccSubRows(t, a, lead, base, hasMore) {
    const dir = this.subDirs.get(a.address)?.dir;
    if (!dir) return [];
    const now = Date.now();
    let list = SA.shown(dir, now);
    if (!list.length) return [];
    const open = this.subsOpen.has(a.address);
    const hidden = !open && list.length > 3 ? list.length - 3 : 0;
    if (hidden) list = [...list.filter((s) => s.state === "running"), ...list.filter((s) => s.state !== "running")].slice(0, 3);
    const rows = list.map((s, j) => {
      const last = j === list.length - 1 && !hidden && !hasMore;
      const doing = SA.activityText(s);
      const tip = [
        s.description,
        [s.type, s.background ? "background" : null].filter(Boolean).join(" · ") || null,
        s.state === "running" ? `Now: ${doing ?? "working"}${SA.runningFor(s, now) ? ` · running ${SA.runningFor(s, now)}` : ""}`
          : s.state === "done" ? `Done ${SA.ago(now - s.lastAt)} ago${s.result ? `: ${s.result.split("\n")[0].slice(0, 140)}` : ""}`
          : `Stopped ${SA.ago(now - s.lastAt)} ago`,
      ].filter(Boolean).join("\n");
      return this.miniRow(t, {
        id: `cc-${a.address}-${s.id}`, lines: [...lead, last ? "└" : "├"], base, first: j === 0, tip,
        mark: this.miniMark(t, s.state), title: s.description,
        right: SA.runningFor(s, now),
        faded: s.state !== "running",
        action: () => run("pane.focus", { pane: a.pane }),
      });
    });
    if (hidden) {
      rows.push(this.miniRow(t, {
        id: `cc-more-${a.address}`, lines: [...lead, hasMore ? "├" : "└"], base, first: false,
        mark: div(), title: `+${hidden} more`, tip: "Show all subagents",
        action: (_e, cx) => { this.subsOpen.add(a.address); cx.notify(); },
      }));
    } else if (open && list.length > 3) {
      rows.push(this.miniRow(t, {
        id: `cc-less-${a.address}`, lines: [...lead, hasMore ? "├" : "└"], base, first: false,
        mark: div(), title: "Show less",
        action: (_e, cx) => { this.subsOpen.delete(a.address); cx.notify(); },
      }));
    }
    return rows;
  }

  // Working subagents of an agent (Claude Code's and herdr's), for the rail badge.
  busySubs(address) {
    const dir = this.subDirs.get(address)?.dir;
    const cc = dir ? SA.runningCount(dir) : 0;
    const hc = [...this.terms.values()].filter((k) => k.parent === address && k.state === "live").length;
    return cc + hc;
  }

  // ---- agents under their space ----

  // Where a space row's icon sits (px from the row's left): the tree lines start there.
  iconX(tree) {
    return tree ? 36.5 : 17;
  }

  // Live sub-agents of `addr`, depth first, each with its tree lines.
  subTree(addr, lead) {
    const kids = [...this.terms.values()].filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [{ k, lines: [...lead, last ? "└" : "├"] }, ...this.subTree(k.address, [...lead, last ? "" : "│"])];
    });
  }

  toggleAgents(id, cx) {
    this.agentsFolded.has(id) ? this.agentsFolded.delete(id) : this.agentsFolded.add(id);
    localStorage.setItem("agents.folded", JSON.stringify([...this.agentsFolded]));
    cx.notify();
  }

  // GitHub-style tree lines: │ runs on, ├ branches off and runs on, └ ends here.
  connectors(lines, base, first, t, h = AGENT_ROW) {
    const color = t.input;
    const top = first ? -6 : -1; // the first child reaches up to its folder icon
    return lines.flatMap((l, j) => {
      const x = base + j * LEVEL - 0.75;
      const fromTop = first && j === lines.length - 1 ? top : -1;
      if (l === "│") return [div().absolute().left(x).top(-1).w(1.5).h(h + 1).bg(color)];
      if (l === "├") return [
        div().absolute().left(x).top(fromTop).w(1.5).h(h - fromTop).bg(color),
        div().absolute().left(x).top(h / 2 - 0.75).w(9).h(1.5).bg(color),
      ];
      if (l === "└") return [div().absolute().left(x).top(fromTop).w(10).h(h / 2 + 0.75 - fromTop).border_l(1.5).border_b(1.5).border_color(color).rounded_bl(6)];
      return [];
    });
  }

  // Working: a spinner. Otherwise a dot: needs you (pulsing), just finished, idle.
  // A pulse (`loop`) rebuilds this whole list ~30 times a second (a spinner doesn't: the
  // app turns it on its own layer), so it pulses only while the window is in front.
  statusMark(t, status, id) {
    if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900);
    if (status === "blocked") return div().id(`mark-${id}`).size(8).flex_none().rounded(4).bg(t.blocked).when(this.windowActive !== false, (el) => el.loop("opacity", { from: 0.35, to: 1, period: 1100 }));
    if (status === "done") return div().size(8).flex_none().rounded(4).bg(t.done);
    return div().size(6).mx(1).flex_none().rounded(3).bg(t.idle ?? t.dim);
  }

  treeRow(t, { id, lines, base, first, on, pic, title, status, tip, muted, action, drag, speed, menu }) { // smart split: drag
    const x = base + (lines.length - 1) * LEVEL;
    const body = h_flex().id(`${id}-body`).ml(x + 11).flex_1().min_w(0).h(AGENT_ROW - 2).pl(6).pr(8).gap(7).items_center().rounded(7)
        .when(on, (el) => el.bg(t.selected))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .cursor_pointer()
        .tooltip(tip)
        .on_click(action)
        .when(Boolean(menu), (el) => el.on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); menu(); })) // agent-menu: copy ids
        .when(Boolean(drag), (el) => el.on_mouse_down("left", (e) => smartPress(this, drag, e))) // smart split
        .when(Boolean(pic), (el) => el.child(pic))
        .child(div().flex_1().min_w(0).truncate().text_color(muted ? t.muted : t.foreground).child(title))
        .when(Boolean(speed), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(speed)))
        .child(this.statusMark(t, status, id));
    return h_flex().relative().id(id).h(AGENT_ROW).flex_none().items_center().text_size(12.5)
      .children(this.connectors(lines, base, first, t))
      .child(body);
  }

  // A space and what hangs under it, one tree: its agents, then its worktrees (branch
  // icon, "worktree" tag), each worktree with its own agents a level deeper.
  // Folding the space (its folder icon, or clicking it while shown) hides all of it.
  spaceTree(r, kids, t) {
    const out = [this.row({ ...r, kids: kids.length }, t)];
    if (this.agentsFolded.has(r.w.id)) return out;
    out.push(...this.agentRows(r, t, [], kids.length > 0));
    const hasAgents = this.agentList.some((a) => a.space === r.w.id);
    kids.forEach((k, n) => {
      const last = n === kids.length - 1;
      out.push(this.row({ ...k, branch: { lines: [last ? "└" : "├"], first: n === 0 && !hasAgents } }, t));
      if (!this.agentsFolded.has(k.w.id)) out.push(...this.agentRows(k, t, [last ? "" : "│"], false));
    });
    return out;
  }

  // lead: the tree lines of the levels above; more: siblings follow the last agent (worktrees).
  agentRows({ w }, t, lead = [], more = false) {
    if (this.agentsFolded.has(w.id)) return [];
    const list = this.agentList.filter((a) => a.space === w.id);
    const base = this.iconX(false);
    return list.flatMap((a, i) => {
      const last = i === list.length - 1 && !more;
      const title = agentTitle(a);
      const msg = msgOf(this.terms.get(a.address));
      const row = this.treeRow(t, {
        id: `ag-${a.address}`, lines: [...lead, last ? "└" : "├"], base, first: i === 0, on: a.focused,
        pic: programIcon(a.program, 14, t.foreground), title, status: a.status,
        tip: [title, a.program?.name !== title ? a.program?.name : null, msg, this.speedOf(a)?.tip].filter(Boolean).join(" · "),
        muted: a.status === "idle" && !a.focused,
        action: () => run("pane.focus", { pane: a.pane }),
        menu: () => this.agentMenu(a.address, title, a.program?.name, a.pane, a.pinned),
        drag: a.address, // smart split
      });
      const under = [...lead, last ? "" : "│"];
      const hcSubs = this.subTree(a.address, under);
      const ccRows = this.ccSubRows(t, a, under, base, hcSubs.length > 0);
      const subs = hcSubs.map(({ k, lines }, j) => {
        const listed = this.agentList.find((x) => x.address === k.address);
        const raw = listed?.status ?? stateOf(k);
        const status = raw === "error" ? "blocked" : raw === "done" ? "idle" : raw;
        const name = k.name || k.template || clean(k.title) || k.program?.name || k.address;
        return this.miniRow(t, {
          id: `sub-${k.address}`, lines, base, first: j === 0 && !ccRows.length,
          mark: this.miniMark(t, status), title: name,
          tip: [name, msgOf(k), "Click: peek at it"].filter(Boolean).join("\n"),
          faded: status === "idle",
          action: () => run("terminal.peek", { terminal: k.address }),
          menu: () => this.agentMenu(k.address, name, k.program?.name, null, false),
          drag: k.address, // smart split
        });
      });
      return [row, ...ccRows, ...subs];
    });
  }

  row({ w, i, g, tree, kids = 0, branch = null }, t) {
    const on = w.active;
    const mine = this.agentList.filter((a) => a.space === w.id);
    const hasKids = mine.length > 0 || kids > 0;
    const folded = this.agentsFolded.has(w.id) && hasKids;
    const top = mine.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed === i && this.over !== i, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === i && this.pressed !== i, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(this.pressed < i, line => line.bottom(0))
          .when(this.pressed > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = i;
        this.over = i;
      })
      .on_mouse_move((_e, cx) => {
        const source = spaces()[this.pressed];
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? i : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === i && from !== i) run("space.move", { id: spaces()[from].id, index: i + 1 });
        // Clicking the space you're in folds or unfolds its agents; another one, goes there.
        else if (from === i && w.active && hasKids) this.toggleAgents(w.id, cx);
        else if (from === i) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      // A worktree under its repo: tree lines from the repo's folder icon to this branch icon.
      .when(Boolean(branch), (el) => el.children(this.connectors(branch.lines, this.iconX(false), branch.first, t, rowHeight({ tree }))))
      .child(
        h_flex()
          .gap(tree ? 7 : 9) // a worktree's name starts where agent titles do
          .items_center()
          .when(Boolean(tree), el => el.pl(branch ? 26 : 22).child(h_flex().id(`fold-${w.id}`).size(14).flex_none().items_center().justify_center().rounded(4)
            .when(mine.length > 0, el => el.cursor_pointer().hover(s => s.bg(t.hover))
              .tooltip(folded ? "Show agents" : "Hide agents")
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_click((_e, cx) => { cx.stop_propagation(); this.toggleAgents(w.id, cx); }))
            .child(svg("mods/workspace-chrome/branch.svg").size(13).text_color(on ? t.foreground : t.muted))))
          .when(!tree, el => el.child(h_flex().id(`fold-${w.id}`).size(18).flex_none().items_center().justify_center().rounded(4)
            .when(hasKids, el => el.cursor_pointer().hover(s => s.bg(t.hover))
              .tooltip(folded ? "Show what's inside" : "Hide what's inside")
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_click((_e, cx) => { cx.stop_propagation(); this.toggleAgents(w.id, cx); }))
            .child(svg(`mods/my-spaces/${hasKids && !folded ? "folder-open" : "folder"}.svg`).size(16).text_color(on ? t.foreground : t.muted))))
          .child(div().flex_shrink(0).max_w(tree ? 110 : 150).truncate().text_color(t.foreground).child(w.name))
          .when(Boolean(tree), el => el.child(div().flex_none().px(5).h(16).flex().items_center().rounded(4).border_1().border_color(t.border)
            .text_size(10).text_color(t.dim).child("worktree")))
          .child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1())
          .when(folded, el => el.child(h_flex().flex_none().gap(5).items_center().text_size(11).text_color(t.dim)
            .child(String(mine.length)).child(this.statusMark(t, top, `fold-${w.id}`)))),
      );
  }

  // The narrow rail: the space's folder, then a small tile per agent, its logo on a
  // tile tinted by its state (working breathes, needs-you pulses, done, idle dimmed).
  compact({ w, tree }, t) {
    const mine = this.agentList.filter((a) => a.space === w.id);
    const head = h_flex()
      .id(`space-${w.id}`)
      .h(28)
      .flex_none()
      .justify_center()
      .items_center()
      .rounded(6)
      .when(w.active, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .tooltip(w.name)
      .on_click(() => run("space.select", { id: w.id }))
      .child(svg(`mods/${tree ? "workspace-chrome/branch" : "my-spaces/folder"}.svg`).size(tree ? 13 : 15).text_color(w.active ? t.foreground : t.muted));
    // A small count on the tile: subagents working under it (Claude Code's and herdr's).
    const badge = (a, el) => {
      const n = this.busySubs(a.address);
      if (!n) return el;
      return div().id(`rail-subs-${a.address}`).relative().flex_none().child(el)
        .child(div().absolute().right(-5).bottom(-4).min_w(13).h(13).px(3).rounded(7).bg(t.chrome).border_1().border_color(t.working)
          .flex().items_center().justify_center().text_size(8.5).font_semibold().text_color(t.working).child(String(n)));
    };
    const tile = (a) => {
      const color = t[a.status] ?? t.dim;
      const pic = programIcon(a.program, 12, a.status === "idle" ? t.muted : color);
      // Every working agent gets the beam (the one you're on: a brighter edge). Still when the window isn't in front.
      const beaming = a.status === "working" && this.windowActive !== false;
      if (beaming) {
        return h_flex().id(`rail-${a.address}`).h(26).flex_none().justify_center().items_center()
          .tooltip(`${agentTitle(a)} · working`)
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .on_mouse_down("left", (e) => smartPress(this, a.address, e)) // smart split
          .child(badge(a, this.beam(t, h_flex().items_center().justify_center().bg(t.chrome).child(pic ?? div().size(6).rounded(3).bg(color)),
            { id: `rail-tile-${a.address}`, w: 22, h: 22, radius: 6, edge: a.focused ? t.foreground : t.border })));
      }
      return h_flex().id(`rail-${a.address}`).h(26).flex_none().justify_center().items_center()
        .tooltip(`${agentTitle(a)} · ${a.status === "blocked" ? "needs you" : a.status === "done" ? "just finished" : a.status}`)
        .on_click(() => run("pane.focus", { pane: a.pane }))
        .on_mouse_down("left", (e) => smartPress(this, a.address, e)) // smart split
        .child(badge(a, h_flex().id(`rail-tile-${a.address}`).size(22).flex_none().items_center().justify_center().rounded(6)
          .border_1()
          .border_color(a.status === "idle" ? t.border : color)
          .bg(a.status === "idle" ? t.chrome : color + "2e")
          .when(a.focused, (el) => el.border_color(t.foreground))
          .when(a.status === "idle" && !a.focused, (el) => el.opacity(0.55))
          .when(a.status === "blocked" && this.windowActive !== false, (el) => el.loop("opacity", { from: 0.35, to: 1, period: 900 }))
          .hover((s) => s.opacity(1))
          .child(pic ?? div().size(6).rounded(3).bg(color))));
    };
    return [head, ...mine.map(tile)];
  }

  render(cx) {
    const t = theme();
    const collapsed = narrow();
    this.windowActive = window()?.active !== false;
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    this.agentList = agents();
    this.terms = new Map(terminals().map((k) => [k.address, k]));
    // agent.next / agent.prev follow the order the tree shows them in.
    const order = new Map(sp.map((s, n) => [s.id, n]));
    setAgentOrder([...this.agentList].sort((a, b) => (order.get(a.space) ?? 0) - (order.get(b.space) ?? 0)).map((a) => a.address));
    // The app's machines changed, or the window is back in front: ask hc about them now.
    const msig = JSON.stringify(machines().map((m) => [m.name, m.layout]));
    const active = this.windowActive;
    const back = active && this.wasActive === false && Date.now() - this.machinesAt > 10000;
    if ((this.msig !== undefined && msig !== this.msig) || back) this.refreshMachines(cx);
    this.msig = msig;
    this.wasActive = active;
    // Git (and tok/s) for what this redraw's data made due, once the redraw is done.
    this.afterRender(cx);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      // smart split: a pressed agent becomes a drag once the pointer moves or leaves the list
      .id("smart-split").on_mouse_move((e) => smartMove(this, e)).on_mouse_up("left", () => smartRelease(this))
      .on_hover((over) => { if (!over) smartMove(this, null); })
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(collapsed, el => el.px(0).justify_center()) // the rail: "+" centred over the column
        .when(!collapsed, el => el.child("Spaces"))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Add a project")
          .on_click(() => addProject(sp.find((s) => s.active)?.machine)).child(svg("mods/workspace-chrome/plus.svg").size(14))))
      .child(v_flex().flex_1().min_h(0).px(8).pb(14).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })
        .children(this.grouped(t, collapsed)));
  }
}
