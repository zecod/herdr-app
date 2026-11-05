// Usage card: Claude Code and Codex plan limits, per account, above Settings in the sidebar.
// Claude: <account>/.credentials.json's OAuth token -> api.anthropic.com/api/oauth/usage (what
// Claude Code's /usage shows). Codex: <account>/auth.json's ChatGPT login ->
// chatgpt.com/backend-api/wham/usage (what Codex's /status shows). <account> is ~/.claude /
// ~/.codex for the main account, else its folder under ~/.config/herdr-app/accounts (see
// accounts-core.js and Settings > Accounts). Tokens are only read, never refreshed or written,
// and only sent to the service that issued them.
//
// State (accounts-core.js): the active account per tool comes from shared "accounts.state" (the
// broadcast of accounts/state.json); limits from shared "accounts.usage". The card draws only
// from those two, keyed by account, so a switch shows the new account's own last numbers at once
// and never the previous account's.
// - One fetcher: the copy holding the lease (data/usage-card/lease.json, taken with a compare-
//   and-write, renewed every pass, 150 s) asks the services and publishes "accounts.usage"; other
//   copies only draw. A pass runs when an account is due (checked every 5 s), on a switch or a
//   command, and at least every 60 s for logins and emails (credential files, ~/.claude.json).
// - The card redraws only when what it shows changed (numbers, accounts, a countdown's minute):
//   nothing is drawn while idle. The schedule (`next`) lives in "accounts.usage" too, so it survives reloads
//   and a change of fetcher: each account is asked at most every 5 minutes (a 429 waits for its
//   Retry-After, never less); a click refreshes what's due (Codex: a minute after its last answer).
// - An account whose access token has expired (Claude: unused for hours; Codex: 10 days) isn't
//   asked: the tool renews it the next time it runs there; its last numbers stay, "not updated".
// - If an account's email changes (someone logged in to another account in that folder), its old
//   numbers are dropped before anything is drawn.
// - A switch (Settings, a click here, the automatic one) is picked up at once: setActive runs
//   `usage-card.accounts`; every 5 s the card also re-reads state.json (a few hundred bytes), so
//   an edit from outside the app shows within 5 s.
// - Automatic switching (Settings > Accounts): when the active account's binding limit (5-hour,
//   weekly, or the weekly limit of the Claude model in settings.json) crosses the threshold, or the
//   service says the limit is reached, the next logged-in account with room becomes active for new
//   agents, with a toast. Only a crossing counts: an account someone picked while it was already
//   over the threshold is left alone. setActive switches only if the account it saw is still
//   active (a pick made meanwhile wins), and never twice within 10 minutes.
// - Folded: each tool's active account (its name when the tool has several). Unfolded: the active
//   account's limits, then the other logged-in accounts on one line each (a click switches).

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { readTextFile, writeTextFile, appHome, theme, layout, run, openOverlay, shared, setShared, notify, nextCommand } from "herdr";
import * as fs from "fs/promises";
import { TOOLS, TOOL_KEYS, keyOf, cap, readState, updateState, publish, currentState, setActive, accountsOf, activeOf, homeOf, readLogin, readEmail, binding, limitName, pairRows, displayName, shortName } from "./accounts-core.js";

const I = (name) => `mods/usage-card/${name}.svg`;
const EVERY = 5 * 60000; // per account
const SOON = 60000; // offline, or a token to look at again
const PASS = 60000; // logins and emails are looked at again this often (numbers: when due)
const LEASE_MS = 150000; // the fetch lease outlives the time between passes
const FRESH = 15 * 60000; // numbers older than this don't trigger a switch
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");
const clock = (ms) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`;
const slash = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
const DATA = () => `${slash(appHome())}/data/usage-card`;
const LEASE = () => `${DATA()}/lease.json`;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// "4h 12m" within a day, else "Fri 23:00" (local time).
function resetText(ms) {
  if (!ms) return "";
  const left = ms - Date.now();
  if (left <= 0) return "now";
  const m = Math.round(left / 60000);
  if (m < 60) return `${m}m`;
  if (m < 24 * 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  const d = new Date(ms);
  return `${DAYS[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// "Sun 9 Nov, 00:00 (in 2d)" for tooltips.
function resetWhen(ms) {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}, ${pad(d.getHours())}:${pad(d.getMinutes())} (in ${resetText(ms)})`;
}

function windowLabel(seconds) {
  if (seconds === 604800) return "Week";
  if (seconds <= 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

const retryAfter = (r) => {
  const s = Number(r.headers?.get?.("retry-after"));
  return Number.isFinite(s) && s > 0 ? s * 1000 : 0;
};

// -> { rows, plan?, blocked? } or { http, error, retry? }
async function fetchClaude(o) {
  const r = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: { Authorization: `Bearer ${o.accessToken}`, "anthropic-beta": "oauth-2025-04-20", "Content-Type": "application/json", "User-Agent": "herdr-usage-card" },
  });
  if (r.status === 401) return { http: 401, error: "Login expired" };
  if (r.status === 429) return { http: 429, error: "Rate limited · retrying in a few minutes", retry: Math.max(EVERY, retryAfter(r)) };
  if (!r.ok) return { http: r.status, error: `Usage unavailable (${r.status})` };
  const d = await r.json();
  const at = (s) => (s ? Date.parse(s) : null);
  const rows = [];
  // The 5-hour session only exists while one is running; without it the card shows week + models.
  if (d.five_hour) rows.push({ kind: "session", label: "5h", short: "5h", pct: d.five_hour.utilization ?? 0, resets: at(d.five_hour.resets_at) });
  if (d.seven_day) rows.push({ kind: "week", label: "Week", short: "W", pct: d.seven_day.utilization, resets: at(d.seven_day.resets_at) });
  // Per-model weekly limits (Fable, ...): always listed, even before they're in force.
  for (const l of d.limits ?? []) {
    if (l.kind !== "weekly_scoped") continue;
    rows.push({ kind: "model", label: l.scope?.model?.display_name ?? "Model", short: (l.scope?.model?.display_name ?? "M")[0], pct: l.percent ?? 0, resets: at(l.resets_at) });
  }
  return { rows };
}

async function fetchCodex(tokens) {
  const r = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    headers: { Authorization: `Bearer ${tokens.access_token}`, "ChatGPT-Account-Id": tokens.account_id ?? "", Accept: "application/json", "User-Agent": "herdr-usage-card" },
  });
  if (r.status === 401) return { http: 401, error: "Login expired" };
  if (r.status === 429) return { http: 429, error: "Rate limited · retrying in a few minutes", retry: Math.max(SOON * 4, retryAfter(r)) };
  if (!r.ok) return { http: r.status, error: `Usage unavailable (${r.status})` };
  const d = await r.json();
  const rows = [d.rate_limit?.primary_window, d.rate_limit?.secondary_window].filter(Boolean).map((w) => {
    const label = windowLabel(w.limit_window_seconds);
    return { kind: label === "Week" ? "week" : "session", label, short: label === "Week" ? "W" : label, pct: w.used_percent ?? 0, resets: w.reset_at ? w.reset_at * 1000 : null };
  });
  return { rows, plan: cap(d.plan_type ?? ""), blocked: Boolean(d.rate_limit?.limit_reached) };
}

const LOGIN_TEXT = { out: "Not logged in", expired: "Login expired", apikey: "API key: no plan limits" };

export default class UsageCard extends View {
  init(_props, cx) {
    // This copy's name for the fetch lease; kept across reloads so a reload keeps the lease.
    this.copy = localStorage.getItem("copy") || `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    try { localStorage.setItem("copy", this.copy); } catch {}
    this.collapsed = localStorage.getItem("collapsed") === "1";
    try { this.seen = JSON.parse(localStorage.getItem("acct-seen") ?? "{}") ?? {}; } catch { this.seen = {}; }
    this.loading = false;
    this.again = null;
    this.models = {};
    this.lastActive = JSON.stringify(currentState().active);
    this.drawn = null;
    this.passAt = 0;
    this.adopt();
    this.pass(cx, {});
    cx.timer.every(5000, (cx) => {
      cx.spawn(async (cx) => {
        // The file is the truth: an edit from outside the app shows within 5 s too.
        // (A change is broadcast as shared state, which redraws every mod by itself.)
        if (!this.loading) publish((await readState()).st);
        const active = JSON.stringify(currentState().active);
        if (active !== this.lastActive) {
          this.lastActive = active;
          this.fit();
          this.pass(cx, {});
        } else {
          const since = Date.now() - this.passAt;
          if ((this.due() && since >= 15000) || since >= PASS) this.pass(cx, {});
        }
        this.redraw(cx); // a countdown's minute turned ("4h 12m")
      });
    });
    // `usage-card.accounts` (setActive, Settings after a login) and `usage-card.refresh`.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = String(await nextCommand());
        if (c === "accounts" || c === "refresh") this.pass(cx, { manual: c === "refresh" });
      }
    });
  }

  // An account's numbers are due (its `next` has passed), or one has none yet.
  due() {
    const usage = shared("accounts.usage") ?? {};
    const now = Date.now();
    return currentState().accounts.some((a) => !a.pending && (!usage[keyOf(a)] || (usage[keyOf(a)].login === "in" && now >= (usage[keyOf(a)].next ?? 0))));
  }

  // What the card shows, minute texts included; it redraws only when that changed.
  shows() {
    const usage = shared("accounts.usage") ?? {};
    const clocks = Object.values(usage).map((u) => [this.freshness(u), ...(u.rows ?? []).map((r) => resetText(r.resets))]);
    return JSON.stringify([shared("accounts.state"), usage, clocks, this.loading, this.collapsed]);
  }

  redraw(cx) {
    if (this.shows() !== this.drawn) cx.notify();
  }

  async close() {
    // Hand the lease on at once.
    try {
      const raw = await readTextFile(LEASE());
      if (JSON.parse(raw ?? "null")?.copy === this.copy) await writeTextFile(LEASE(), JSON.stringify({ copy: null, until: 0 }), raw);
    } catch {}
  }

  // The schedule kept by the card before it was shared (its own localStorage): entries without a
  // `next` take it from there, so a reload never asks early.
  adopt() {
    try {
      const now = shared("accounts.usage") ?? JSON.parse(localStorage.getItem("acct-usage") ?? "null");
      const tried = JSON.parse(localStorage.getItem("acct-tried") ?? "null") ?? {};
      if (!now) return;
      const out = {};
      for (const [k, u] of Object.entries(now)) {
        out[k] = u.next ? { ...u, fetching: false } : { ...u, http: tried[k]?.http ?? null, next: tried[k]?.next ?? Date.now() + EVERY, fetching: false };
      }
      this.publishUsage(out);
    } catch {}
  }

  // The fetch lease: true if this copy may ask the services now.
  async lead() {
    await fs.mkdir(DATA(), { recursive: true }).catch(() => {});
    const raw = await readTextFile(LEASE()).catch(() => null);
    let l = null;
    try { l = JSON.parse(raw ?? "null"); } catch {}
    const now = Date.now();
    if (l && l.copy && l.copy !== this.copy && l.until > now) return false;
    try {
      await writeTextFile(LEASE(), JSON.stringify({ copy: this.copy, until: now + LEASE_MS }), raw);
      return true;
    } catch {
      return false;
    }
  }

  publishUsage(usage) {
    if (JSON.stringify(shared("accounts.usage")) !== JSON.stringify(usage)) setShared("accounts.usage", { ...usage });
  }

  // Looks at every account; asks the services for those that are due (lease holder only).
  pass(cx, opts) {
    if (this.loading) {
      this.again = { manual: Boolean(opts?.manual || this.again?.manual) };
      return;
    }
    this.loading = true;
    this.passAt = Date.now();
    const manual = Boolean(opts?.manual);
    cx.spawn(async (cx) => {
      try {
        const { st } = await readState();
        publish(st);
        if (!(await this.lead())) return;
        for (const tool of TOOL_KEYS) {
          const text = tool === "claude" ? await readTextFile(`${homeOf(activeOf(st, "claude"))}/settings.json`).catch(() => null) : null;
          try { this.models[tool] = text ? JSON.parse(text).model ?? null : null; } catch {}
        }
        const usage = { ...(shared("accounts.usage") ?? {}) };
        const emails = {};
        for (const a of st.accounts) {
          const key = keyOf(a);
          if (a.pending) { delete usage[key]; continue; } // a first login still running: Settings shows it
          const login = await readLogin(a).catch(() => ({ state: "out" }));
          const who = await readEmail(a).catch(() => null);
          if (who && who !== a.email) emails[key] = who;
          let entry = { ...(usage[key] ?? {}) };
          // Another identity in that folder: its numbers aren't this one's.
          if (who && entry.who && entry.who !== who) entry = {};
          entry = { ...entry, login: login.state, plan: login.plan || entry.plan || "", who: who ?? entry.who ?? null, fetching: false };
          if (login.state !== "in") {
            usage[key] = { ...entry, rows: [], error: LOGIN_TEXT[login.state] ?? "Not logged in", note: null, stale: null };
            continue;
          }
          const now = Date.now();
          const due = manual && a.tool === "codex" ? now - (entry.http ?? 0) >= SOON : now >= (entry.next ?? 0);
          if (!due) { usage[key] = entry; continue; }
          if (!login.fresh) {
            usage[key] = { ...entry, rows: entry.rows ?? [], error: null, stale: entry.rows?.length ? "not updated" : null, note: `Updates when ${TOOLS[a.tool].name} next runs on it`, next: now + SOON };
            continue;
          }
          usage[key] = { ...entry, fetching: true };
          this.publishUsage(usage);
          let r;
          try {
            r = a.tool === "claude" ? await fetchClaude(login.creds) : await fetchCodex(login.creds);
          } catch (e) {
            r = { offline: true, error: String(e?.message ?? e) };
          }
          const t = Date.now();
          if (r.rows) {
            usage[key] = { ...entry, plan: r.plan || entry.plan, rows: r.rows, blocked: Boolean(r.blocked), at: t, error: null, stale: null, note: null, http: t, next: t + EVERY, fetching: false };
          } else {
            // A passing failure (offline, rate limited, server error) keeps the last good numbers.
            const keep = entry.rows?.length && (r.offline || r.http === 429 || r.http >= 500);
            const next = r.offline ? t + SOON : t + (r.retry ?? (a.tool === "claude" ? EVERY : SOON));
            usage[key] = keep
              ? { ...entry, stale: "not updated", http: r.offline ? entry.http : t, next, fetching: false }
              : { ...entry, rows: [], at: null, error: r.error, note: null, http: r.offline ? entry.http : t, next, fetching: false };
          }
          this.publishUsage(usage);
        }
        for (const k of Object.keys(usage)) if (!st.accounts.some((a) => keyOf(a) === k)) delete usage[k];
        this.publishUsage(usage);
        if (Object.keys(emails).length) {
          await updateState((s) => {
            let changed = false;
            for (const a of s.accounts) if (emails[keyOf(a)] && a.email !== emails[keyOf(a)]) { a.email = emails[keyOf(a)]; changed = true; }
            return changed;
          });
        }
        await this.autoSwitch(currentState(), usage);
      } finally {
        this.loading = false;
        this.fit();
        this.redraw(cx);
        if (this.again) {
          const again = this.again;
          this.again = null;
          this.pass(cx, again);
        }
      }
    });
  }

  // Only a crossing switches: `seen` remembers, per account, whether its binding limit was over the
  // threshold the last time fresh numbers came in (while switching was on). An account picked while
  // already over it stays until it drops below and crosses again.
  async autoSwitch(st, usage) {
    const th = st.auto.threshold;
    const before = this.seen;
    if (!st.auto.enabled) {
      this.seen = {};
      try { localStorage.setItem("acct-seen", "{}"); } catch {}
      return;
    }
    const seen = { ...before };
    const now = Date.now();
    const over = (a, u) => { const b = binding(a.tool, u, this.models[a.tool]); return { b, over: b.reached || b.pct >= th }; };
    for (const a of st.accounts) {
      const u = usage[keyOf(a)];
      if (u?.login === "in" && u.rows?.length && u.at && now - u.at < FRESH) seen[keyOf(a)] = { over: over(a, u).over, at: u.at };
    }
    this.seen = seen;
    try { localStorage.setItem("acct-seen", JSON.stringify(seen)); } catch {}
    for (const tool of TOOL_KEYS) {
      const accs = accountsOf(st, tool).filter((a) => !a.pending && usage[keyOf(a)]?.login === "in");
      if (accs.length < 2) continue;
      const cur = activeOf(st, tool);
      const cu = usage[keyOf(cur)];
      if (cu?.login !== "in" || !cu.rows?.length || !cu.at || now - cu.at > FRESH) continue;
      const { b, over: isOver } = over(cur, cu);
      if (!isOver || before[keyOf(cur)]?.over) continue;
      const last = st.picked?.[tool];
      if (last?.by === "auto" && now - (last.at ?? 0) < 10 * 60000) continue;
      const i = accs.findIndex((a) => a.id === cur.id);
      const order = [...accs.slice(i + 1), ...accs.slice(0, Math.max(0, i))].filter((a) => a.id !== cur.id);
      let pick = null, unknown = null;
      for (const a of order) {
        const u = usage[keyOf(a)];
        if (u?.rows?.length) {
          if (!over(a, u).over) { pick = a; break; }
        } else unknown ??= a;
      }
      pick ??= unknown;
      const curName = displayName(cur, cu.who);
      const why = b.reached && b.pct < 100 ? "hit its limit" : `reached ${Math.round(b.pct)}% of its ${limitName(b)} limit`;
      if (!pick) {
        notify({ title: `${TOOLS[tool].name}: every account is near its limit`, body: `${curName} ${why}, and no other account has room.`, level: "warning", timeout: 12000, action: { name: "mod.open", args: { name: "accounts" } } });
        continue;
      }
      const next = await setActive(tool, pick.id, "auto", cur.id);
      if (!next) continue; // someone picked another account meanwhile: theirs stands
      const pickName = displayName(pick, usage[keyOf(pick)]?.who);
      notify({
        title: `${TOOLS[tool].name}: switched to ${pickName}`,
        body: `${curName} ${why}. New agents start on ${pickName}; running ones keep ${curName}.`,
        level: "warning",
        timeout: 15000,
        icon: TOOLS[tool].icon,
        action: { name: "mod.open", args: { name: "accounts" } },
      });
    }
  }

  // A click on another account's line: new agents start on it.
  use(a, cx) {
    cx.spawn(async (cx) => {
      const next = await setActive(a.tool, a.id, "user");
      if (next) notify({ title: `${TOOLS[a.tool].name}: using ${displayName(a)}`, body: "New agents start on this account; running ones keep theirs.", level: "info", timeout: 6000, icon: TOOLS[a.tool].icon });
      this.lastActive = JSON.stringify(currentState().active);
      this.fit();
      this.pass(cx, {});
      cx.notify();
    });
  }

  // What shows per tool: the active account, and the other logged-in ones.
  groups() {
    const st = currentState();
    const usage = shared("accounts.usage") ?? {};
    return TOOL_KEYS.map((tool) => {
      const all = accountsOf(st, tool).filter((a) => !a.pending);
      const active = activeOf(st, tool);
      const au = usage[keyOf(active)];
      const others = all.filter((a) => a.id !== active.id && usage[keyOf(a)]?.login === "in");
      if (au?.login !== "in" && !others.length && active.id === "default") return null; // not logged in: left out
      return { tool, active, au: au ?? { rows: [] }, others, multi: all.length > 1, usage };
    }).filter(Boolean);
  }

  // The block's height for what's shown, kept in sync with the drawing below.
  needed(narrow) {
    const gs = this.groups();
    if (narrow) return gs.length ? 12 + gs.length * 34 + 4 * (gs.length - 1) : 0;
    const frame = 12 + 2 + 20 + 20 + 10; // outer padding, border, card padding, header + gap
    if (!gs.length) return frame + 16;
    if (this.collapsed) return frame + gs.length * 18 + 6 * (gs.length - 1);
    const body = (u) => (u.rows?.length ? u.rows.length * 16 + (u.rows.length - 1) * 4 : 16);
    return frame + gs.reduce((s, g) => s + 18 + 6 + body(g.au), 0) + 10 * (gs.length - 1);
  }

  // Commands don't run from render(): called after a refresh, a fold, and when the block's size changes.
  fit() {
    const narrow = (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
    const want = this.needed(narrow);
    const node = find(layout(), "usage");
    if (!node || Math.round(node.size?.px ?? 0) === want) return;
    run("layout.resize", { id: "usage", px: want });
  }

  toggle(cx) {
    this.collapsed = !this.collapsed;
    localStorage.setItem("collapsed", this.collapsed ? "1" : "");
    this.fit();
    cx.notify();
  }

  color(t, pct) {
    return pct >= 90 ? t.blocked : pct >= 70 ? t.ansi3 : t.accent;
  }

  // One limit: label | bar | percent | when it resets. Fixed columns, so every
  // bar is the same width and the numbers line up across both tools.
  bar(t, row) {
    const pct = row.pct == null ? null : Math.max(0, Math.min(100, row.pct));
    return h_flex().id(`row-${row.key}`).h(16).gap(8).items_center().text_size(11.5)
      .tooltip(row.resets ? `${row.label}: resets ${resetWhen(row.resets)}` : `${row.label}: no limit window right now`)
      .child(div().w(46).flex_none().truncate().text_color(t.muted).child(row.label))
      .child(div().flex_1().min_w(20).h(5).rounded(3).bg(t.border)
        .when(pct != null && pct > 0, (el) => el.child(div().h_full().w(`${Math.max(pct, 2)}%`).rounded(3).bg(this.color(t, pct)))))
      .child(div().w(32).flex_none().text_right().font_medium().text_color(pct == null ? t.dim : t.foreground).child(pct == null ? "—" : `${Math.round(pct)}%`))
      .child(div().w(58).flex_none().text_right().text_size(10.5).text_color(t.dim).child(row.resets ? resetText(row.resets) : ""));
  }

  // `one`: room for a single limit (a name shares the line): the higher of the pair.
  bars(t, tool, u, one) {
    let rows = pairRows(tool, u.rows);
    if (one && rows.length > 1) rows = [rows.reduce((m, r) => ((r.pct ?? 0) > (m.pct ?? 0) ? r : m))];
    return rows.map((r) => {
      const pct = Math.max(0, Math.min(100, r.pct ?? 0));
      return h_flex().flex_1().min_w(0).gap(5).items_center()
        .child(div().w(16).flex_none().text_color(t.dim).child(r.short ?? r.label))
        .child(div().flex_1().min_w(12).h(4).rounded(2).bg(t.border)
          .when(pct > 0, (el) => el.child(div().h_full().w(`${Math.max(pct, 3)}%`).rounded(2).bg(this.color(t, pct)))))
        .child(div().w(28).flex_none().text_right().font_medium().text_color(pct >= 70 ? this.color(t, pct) : t.foreground).child(`${Math.round(pct)}%`));
    });
  }

  // "updating…" while its numbers are being read, "not updated" when they're old and can't be.
  freshness(u) {
    if (u?.fetching) return "updating…";
    if (u?.stale) return "not updated";
    if (u?.rows?.length && u.at && Date.now() - u.at > EVERY + 60000) return "updating…";
    return null;
  }

  summary(g, a, u) {
    const name = g.multi ? ` · ${displayName(a, u?.who)}` : "";
    if (!u?.rows?.length) return `${TOOLS[g.tool].short}${name}: ${u?.error ?? u?.note ?? "reading usage…"}`;
    const f = this.freshness(u);
    return `${TOOLS[g.tool].short}${name}${u.plan ? ` · ${u.plan}` : ""}: ${u.rows.map((r) => `${r.label} ${r.pct == null ? "—" : `${Math.round(r.pct)}%`}`).join(", ")}${f ? ` (${f})` : ""}`;
  }

  // The tool's icon and its pair of limits (the active account's; its name is in the tooltip).
  compactRow(t, g) {
    const u = g.au;
    const text = u.rows?.length ? null : u.fetching ? "Updating…" : u.error ?? u.note ?? "Reading…";
    return h_flex().id(`compact-${g.tool}`).h(18).gap(8).items_center().text_size(11.5)
      .tooltip(this.summary(g, g.active, u))
      .child(image(TOOLS[g.tool].icon).w(14).h(14).flex_none())
      .when(Boolean(text), (el) => el.child(div().flex_1().min_w(0).truncate().text_color(u.error ? t.blocked : t.dim).child(text)))
      .when(!text, (el) => el.children(this.bars(t, g.tool, u, false)));
  }

  section(t, g) {
    const u = g.au;
    const rows = u.rows ?? [];
    const text = rows.length ? null : u.fetching ? "Updating…" : u.error ?? u.note ?? "Reading usage…";
    const fresh = this.freshness(u);
    return v_flex().gap(6)
      .child(h_flex().h(18).gap(7).items_center()
        .child(image(TOOLS[g.tool].icon).w(14).h(14).flex_none())
        .child(div().flex_none().text_size(12.5).font_semibold().text_color(t.foreground).child(TOOLS[g.tool].short))
        .when(Boolean(u.plan), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(u.plan)))
        .child(div().flex_1())
        .when(Boolean(fresh), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(fresh))))
      .child(text
        ? div().h(16).text_size(11.5).text_color(u.error ? t.blocked : t.dim).truncate().child(text)
        : v_flex().gap(4).children(rows.map((r, n) => this.bar(t, { ...r, key: `${g.tool}-${n}` }))));
  }

  iconButton(id, icon, tip, t, action, spin) {
    return div().id(id).size(20).flex_none().flex().items_center().justify_center().rounded(5)
      .text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip).on_click(action)
      .child(spin ? svg(I(icon)).size(12).spin(900) : svg(I(icon)).size(12));
  }

  render() {
    const t = theme();
    this.drawn = this.shows();
    const narrow = (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
    const gs = this.groups();
    const sized = (el) => el.on_size_change((_size, _cx) => this.fit());
    const last = Math.max(0, ...gs.map((g) => g.au.at ?? 0));
    const updated = last ? clock(last) : "";
    const busy = gs.some((g) => g.au.fetching || g.others.some((a) => g.usage[keyOf(a)]?.fetching));
    if (narrow) {
      // The rail: each tool's icon and the active account's most-used limit.
      return sized(v_flex().id("usage")).size_full().bg(t.chrome).pt(4).pb(8).gap(4).items_center().cursor_pointer()
        .tooltip("Refresh usage").on_click((_e, cx) => this.pass(cx, { manual: true }))
        .children(gs.map((g) => {
          // A ring around the logo filled to the limit that matters now: Claude's 5-hour session
          // while one runs, else its week; Codex's 5 hours, else its week (pairRows' first).
          const r = pairRows(g.tool, g.au.rows)[0] ?? null;
          const pct = r?.pct == null ? null : Math.max(0, Math.min(100, Math.round(r.pct)));
          const color = pct == null ? t.dim : pct >= 90 ? t.blocked : pct >= 70 ? t.ansi3 : t.ansi2;
          // The tool's logo inside a ring filled to the limit that matters now; the number is in the tooltip.
          return h_flex().id(`rail-usage-${g.tool}`).h(34).justify_center().items_center()
            .tooltip(r ? `${TOOLS[g.tool].name} · ${r.label} ${pct}%` : `${TOOLS[g.tool].name} · no usage yet`)
            .child(div().relative().size(30).flex_none()
              .child(svg("mods/usage-card/rings/track.svg").absolute().left(0).top(0).size(30).text_color(t.border))
              .when(pct != null, (el) => el.child(svg(`mods/usage-card/rings/p${pct}.svg`).absolute().left(0).top(0).size(30).text_color(color)))
              .child(image(TOOLS[g.tool].icon).absolute().left(8).top(8).w(14).h(14)));
        }));
    }
    return sized(v_flex().id("usage")).size_full().bg(t.chrome).px(8).pt(4).pb(8)
      .child(v_flex().id("usage-card").flex_1().p(10).gap(10).rounded(10).border_1().border_color(t.border).bg(t.raised)
        .child(h_flex().h(20).gap(2).items_center()
          .child(this.iconButton("usage-refresh", "rotate-cw", busy ? "Updating…" : "Refresh (each Claude account at most every 5 minutes)", t, (_e, cx) => this.pass(cx, { manual: true }), busy))
          .child(this.iconButton("usage-fold", this.collapsed ? "chevron-right" : "chevron-down", this.collapsed ? "Expand" : "Collapse", t, (_e, cx) => this.toggle(cx)))
          .child(div().id("usage-open").pl(4).flex_1().text_size(11.5).font_medium().text_color(t.dim).cursor_pointer()
            .hover((s) => s.text_color(t.foreground)).tooltip("Open Usage & activity")
            .on_click(() => openOverlay({ mod: "my-settings", kind: "dialog", width: 960, height: 660, props: { section: "usage" } }))
            .child("Usage"))
          .when(Boolean(updated), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(updated))))
        .when(!gs.length, (el) => el.child(div().h(16).text_size(11.5).text_color(t.dim).child(this.loading ? "Reading usage…" : "No Claude Code or Codex login found")))
        .when(this.collapsed, (el) => el.child(v_flex().gap(6).children(gs.map((g) => this.compactRow(t, g)))))
        .when(!this.collapsed, (el) => el.children(gs.map((g) => this.section(t, g)))));
  }
}
