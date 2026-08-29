import * as db from "./store.js";
import { currentUser, login, logout, refreshUser } from "./auth.js";
import * as stats from "./stats.js";
/* ------------------------------- helpers -------------------------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const IST = "Asia/Kolkata";
const istDateTime = (iso) =>
  new Intl.DateTimeFormat("en-IN", {
    timeZone: IST, day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true
  }).format(new Date(iso));
const istTime = (iso) =>
  new Intl.DateTimeFormat("en-IN", {
    timeZone: IST, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true
  }).format(new Date(iso));
function hms(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(t / 3600)).padStart(2, "0");
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
  const s = String(t % 60).padStart(2, "0");
  return h + ":" + m + ":" + s;
}
function durationWords(ms) {
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const parts = [];
  if (h) parts.push(h + " hr");
  if (m) parts.push(m + " min");
  parts.push(s + " sec");
  return parts.join(" ");
}
function msg(el, text, cls) {
  el.textContent = text;
  el.className = "msg " + (cls || "");
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
/* -------------------------------- state --------------------------------- */
let admin = null;
let players = [];
let matchType = "1v1";
let live = null;
let timerId = null;
let pending = null;
function showView(name) {
  $("#view-login").classList.toggle("active", name === "login");
  $("#view-app").classList.toggle("active", name === "app");
}
/* ============================= ADMIN LOGIN =============================== */
$("#admin-btn").addEventListener("click", () => {
  msg($("#login-msg"), "");
  $("#login-form").reset();
  showView("login");
});
$("#back-btn").addEventListener("click", () => showView("app"));
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    admin = await login($("#login-username").value, $("#login-password").value, "admin");
    $("#login-form").reset();
    msg($("#login-msg"), "");
    applyRole();
    await renderPlayersAdmin();
    if (isSuper()) await renderUsers();
    showView("app");
    const t = $('#tabbar .tab[data-tab="admin"]');
    if (t) t.click();
  } catch (err) {
    msg($("#login-msg"), err.message, "err");
  }
});
$("#logout-btn").addEventListener("click", async () => {
  await logout();
  admin = null;
  applyRole();
  const t = $('#tabbar .tab[data-tab="new"]');
  if (t) t.click();
});
// 'super'   -> ayushp: every privilege
// 'limited' -> admin: may only add players, which then need super approval
const isSuper = () => !!admin && admin.role === "super";
function applyRole() {
  const isAdmin = !!admin;
  const sup = isSuper();
  $("#admin-chip").hidden = !isAdmin;
  $("#admin-chip").textContent = sup ? "main admin" : "limited admin";
  $("#admin-btn").hidden = isAdmin;
  $("#logout-btn").hidden = !isAdmin;
  // Everything marked super-only is hidden from limited admins.
  $$(".super-only").forEach((el) => { el.hidden = !sup; });
  const hint = $("#player-hint");
  hint.hidden = !isAdmin || sup;
  hint.textContent = "Players you add wait for the main admin to approve them " +
    "before they can be picked for a match.";
  buildTabs();
}
/* ================================= TABS ================================== */
const TABS = {
  new:     { label: "New match", icon: "M12 5v14M5 12h14" },
  history: { label: "History",   icon: "M4 6h16M4 12h16M4 18h16" },
  board:   { label: "Ranks",     icon: "M6 20V10M12 20V4M18 20v-7" },
  players: { label: "Players",   icon: "M16 20v-2a4 4 0 00-8 0v2M12 11a4 4 0 100-8 4 4 0 000 8z" },
  admin:   { label: "Admin",     icon: "M12 3l8 4v6c0 4-3.4 7-8 8-4.6-1-8-4-8-8V7z" }
};
function buildTabs() {
  const keys = admin ? Object.keys(TABS) : ["new", "history", "board", "players"];
  const cur = $(".tab-panel.active");
  const activeNow = cur ? cur.id.replace("tab-", "") : "new";
  const active = keys.indexOf(activeNow) >= 0 ? activeNow : keys[0];
  $("#tabbar").innerHTML = keys.map((k) =>
    '<button class="tab ' + (k === active ? "active" : "") + '" data-tab="' + k + '">' +
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + TABS[k].icon + '"/></svg>' +
    "<span>" + TABS[k].label + "</span></button>").join("");
  $$("#tabbar .tab").forEach((b) =>
    b.addEventListener("click", async () => {
      $$("#tabbar .tab").forEach((x) => x.classList.toggle("active", x === b));
      $$(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + b.dataset.tab));
      if (b.dataset.tab === "history") await renderHistory();
      if (b.dataset.tab === "board") await renderBoard();
      if (b.dataset.tab === "players") await renderDash();
      if (b.dataset.tab === "admin") { await renderPlayersAdmin(); if (isSuper()) await renderUsers(); }
    })
  );
  $$(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + active));
}
/* ================================ PLAYERS ================================ */
// Only approved players can be chosen for a match.
const selectablePlayers = () => players.filter((p) => p.status === "approved");
async function refreshPlayers() {
  players = await db.listPlayers();
  fillSelects();
  const ok = selectablePlayers();
  const hint = $("#no-players-hint");
  hint.hidden = ok.length > 0;
  hint.textContent = players.length
    ? "Players have been added but none are approved yet - the main admin needs to approve them."
    : "No players yet - an admin needs to add players first.";
}
function fillSelects() {
  const list = selectablePlayers();
  const opts = ['<option value="">- select player -</option>']
    .concat(list.map((p) => '<option value="' + p.id + '">' + esc(p.name) + "</option>"))
    .join("");
  $$(".player-select").forEach((sel) => {
    const keep = sel.value;
    sel.innerHTML = opts;
    if (list.some((p) => p.id === keep)) sel.value = keep;
  });
}
$("#add-player-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const p = await db.createPlayer($("#np-name").value);
    e.target.reset();
    msg($("#player-msg"), p.status === "approved"
      ? "Added " + p.name + "."
      : "Added " + p.name + " - waiting for the main admin to approve.", "ok");
    await renderPlayersAdmin();
  } catch (err) {
    msg($("#player-msg"), err.message, "err");
  }
});
async function renderPlayersAdmin() {
  await refreshPlayers();
  const sup = isSuper();
  const waiting = players.filter((p) => p.status !== "approved");
  // Approval queue - only the main admin sees this.
  $("#card-pending").hidden = !sup;
  $("#pending-count").textContent = waiting.length;
  $("#pending-list").innerHTML = waiting.length
    ? waiting.map((p) =>
        "<li><span><strong>" + esc(p.name) + "</strong>" +
        '<span class="chip chip-warn">pending</span></span><span class="actions">' +
        '<button class="mini ok" data-approve="' + p.id + '">Approve</button>' +
        '<button class="mini bad" data-decline="' + p.id + '" data-name="' + esc(p.name) + '">Decline</button>' +
        "</span></li>").join("")
    : '<li class="muted">Nothing waiting for approval.</li>';
  $("#player-count").textContent = players.length;
  $("#player-list").innerHTML = players.length
    ? players.map((p) => {
        const badge = p.status === "approved" ? "" : '<span class="chip chip-warn">pending</span>';
        return "<li><span>" + esc(p.name) + badge + "</span><span class=\"actions\">" +
          (sup
            ? '<button class="link" data-rename="' + p.id + '" data-name="' + esc(p.name) + '">rename</button>' +
              '<button class="link danger-text" data-del-player="' + p.id + '">delete</button>'
            : '<small class="muted">' + (p.status === "approved" ? "approved" : "awaiting approval") + "</small>") +
          "</span></li>";
      }).join("")
    : '<li class="muted">No players yet.</li>';
  $$("[data-approve]").forEach((b) =>
    b.addEventListener("click", async () => {
      try { await db.approvePlayer(b.dataset.approve); await renderPlayersAdmin(); }
      catch (err) { msg($("#player-msg"), err.message, "err"); }
    })
  );
  $$("[data-decline]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Decline " + b.dataset.name + "?\n\nThis permanently removes this player AND every " +
                   "match they played in. Those matches also disappear from their opponents' records.")) return;
      try {
        const out = await db.declinePlayer(b.dataset.decline);
        msg($("#player-msg"),
            "Declined " + out.player + " - removed " + out.matches_removed + " match(es).", "ok");
        await renderPlayersAdmin();
        await renderHistory();
      } catch (err) { msg($("#player-msg"), err.message, "err"); }
    })
  );
  $$("[data-rename]").forEach((b) =>
    b.addEventListener("click", async () => {
      const name = prompt("New name:", b.dataset.name);
      if (!name) return;
      try { await db.renamePlayer(b.dataset.rename, name); await renderPlayersAdmin(); }
      catch (err) { msg($("#player-msg"), err.message, "err"); }
    })
  );
  $$("[data-del-player]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Delete this player? Past matches keep their names.")) return;
      await db.deletePlayer(b.dataset.delPlayer);
      await renderPlayersAdmin();
    })
  );
}
/* ============================== MATCH SETUP ============================== */
$$("#match-type .seg-btn").forEach((b) =>
  b.addEventListener("click", () => {
    $$("#match-type .seg-btn").forEach((x) => x.classList.toggle("active", x === b));
    matchType = b.dataset.type;
    document.body.classList.toggle("is-2v2", matchType === "2v2");
    msg($("#setup-msg"), "");
  })
);
function selectedSlots() {
  const need = matchType === "1v1" ? ["a1", "b1"] : ["a1", "a2", "b1", "b2"];
  return need.map((slot) => $('.player-select[data-slot="' + slot + '"]').value);
}
function playerName(id) {
  const p = players.find((x) => x.id === id);
  return p ? p.name : "Unknown";
}
function showStep(name) {
  $$(".step").forEach((s) => s.classList.toggle("active", s.id === "step-" + name));
}
$("#start-btn").addEventListener("click", () => {
  const ids = selectedSlots();
  if (ids.some((x) => !x)) return msg($("#setup-msg"), "Please select all players.", "err");
  if (new Set(ids).size !== ids.length) {
    return msg($("#setup-msg"), "The same player cannot be selected twice.", "err");
  }
  const teams = matchType === "1v1"
    ? [{ side: "A", playerIds: [ids[0]] }, { side: "B", playerIds: [ids[1]] }]
    : [{ side: "A", playerIds: [ids[0], ids[1]] }, { side: "B", playerIds: [ids[2], ids[3]] }];
  teams.forEach((t) => { t.names = t.playerIds.map(playerName); });
  live = { type: matchType, teams: teams, startedAt: new Date().toISOString(), pausedMs: 0, pausedAt: null };
  saveLive();
  $("#live-matchup").innerHTML =
    "<span>" + esc(teams[0].names.join(" & ")) + "</span><em>vs</em><span>" +
    esc(teams[1].names.join(" & ")) + "</span>";
  $("#started-at").textContent = "Started at " + istDateTime(live.startedAt) + " IST";
  msg($("#setup-msg"), "");
  startTimer();
  showStep("running");
});
/* ================================ TIMER ================================== */
// The clock is derived from wall-clock timestamps, never from tick counting,
// so locking the screen / backgrounding the PWA cannot slow or stop it.
// The live match is mirrored to localStorage, so closing the app and coming
// back keeps the same running match and the correct elapsed time.
const LIVE_KEY = "matchtracker.live";
const MAX_MS = 30 * 60 * 1000;          // hard 30 minute limit
let wakeLock = null;
function saveLive() {
  if (live) localStorage.setItem(LIVE_KEY, JSON.stringify(live));
  else localStorage.removeItem(LIVE_KEY);
}
// Active (unpaused) milliseconds played so far
function elapsedMs(m = live) {
  if (!m) return 0;
  const upto = m.pausedAt ? new Date(m.pausedAt).getTime() : Date.now();
  return Math.max(0, upto - new Date(m.startedAt).getTime() - (m.pausedMs || 0));
}
async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
  } catch (e) { /* not critical */ }
}
function releaseWakeLock() {
  try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (e) {}
}
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible") {
    if (live && !live.pausedAt) await requestWakeLock();
    paint();                               // instantly correct after unlock
  }
});
function paint() {
  if (!live) return;
  const ms = elapsedMs();
  if (ms >= MAX_MS) { expireMatch(); return; }
  $("#timer").textContent = hms(ms);
  $("#timer").classList.toggle("paused", !!live.pausedAt);
  const left = MAX_MS - ms;
  $("#limit-note").textContent = live.pausedAt
    ? "Paused - the clock is stopped"
    : "Auto-stops in " + hms(left) + " (30 min limit, no result saved)";
  $("#limit-note").classList.toggle("warn-text", left <= 5 * 60 * 1000);
  $("#pause-btn").innerHTML = live.pausedAt ? "&#9654; Resume timer" : "&#10073;&#10073; Pause timer";
}
function startTimer() {
  stopTimer();
  paint();
  timerId = setInterval(paint, 1000);
  requestWakeLock();
}
function stopTimer() {
  if (timerId) clearInterval(timerId);
  timerId = null;
  releaseWakeLock();
}
$("#pause-btn").addEventListener("click", () => {
  if (!live) return;
  if (live.pausedAt) {
    live.pausedMs = (live.pausedMs || 0) + (Date.now() - new Date(live.pausedAt).getTime());
    live.pausedAt = null;
    requestWakeLock();
  } else {
    live.pausedAt = new Date().toISOString();
    releaseWakeLock();
  }
  saveLive();
  paint();
});
$("#cancel-btn").addEventListener("click", () => {
  if (!confirm("Cancel this match? Nothing will be saved.")) return;
  stopTimer();
  live = null;
  saveLive();
  showStep("setup");
});
// 30 minutes reached: stop, save nothing, tell the user.
function expireMatch() {
  stopTimer();
  live = null;
  saveLive();
  showStep("setup");
  msg($("#setup-msg"), "Match hit the 30 minute limit and was stopped automatically - no result was recorded.", "err");
}
// Restore a match that was running when the app was closed / phone locked.
function restoreLive() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LIVE_KEY) || "null"); } catch (e) {}
  if (!saved || !saved.teams) return;
  if (elapsedMs(saved) >= MAX_MS) {
    localStorage.removeItem(LIVE_KEY);
    msg($("#setup-msg"), "The match you left running passed the 30 minute limit, so it was stopped with no result.", "err");
    return;
  }
  live = saved;
  matchType = live.type;
  $$("#match-type .seg-btn").forEach((x) => x.classList.toggle("active", x.dataset.type === matchType));
  document.body.classList.toggle("is-2v2", matchType === "2v2");
  $("#live-matchup").innerHTML =
    "<span>" + esc(live.teams[0].names.join(" & ")) + "</span><em>vs</em><span>" +
    esc(live.teams[1].names.join(" & ")) + "</span>";
  $("#started-at").textContent = "Started at " + istDateTime(live.startedAt) + " IST";
  startTimer();
  showStep("running");
}
/* =============================== END MATCH =============================== */
$("#end-btn").addEventListener("click", () => {
  if (!live) return;
  const played = elapsedMs();
  stopTimer();
  const endedAt = new Date().toISOString();
  pending = {
    type: live.type, teams: live.teams, startedAt: live.startedAt,
    endedAt: endedAt, durationMs: played, pausedMs: live.pausedMs || 0
  };
  live = null;
  saveLive();
  const pausedNote = pending.pausedMs > 1000
    ? '<div class="full muted">Paused for ' + durationWords(pending.pausedMs) + " (not counted)</div>"
    : "";
  $("#time-summary").innerHTML =
    '<div><span class="lbl">Start</span><strong>' + istTime(pending.startedAt) + "</strong></div>" +
    '<div><span class="lbl">End</span><strong>' + istTime(pending.endedAt) + "</strong></div>" +
    '<div><span class="lbl">Time taken</span><strong>' + durationWords(pending.durationMs) + "</strong></div>" +
    '<div class="full muted">' + istDateTime(pending.startedAt) + " IST to " +
    istDateTime(pending.endedAt) + " IST</div>" + pausedNote;
  $("#score-grid").innerHTML = pending.teams.map((t, i) =>
    '<div class="score-card"><span class="side">Side ' + t.side + "</span><strong>" +
    esc(t.names.join(" & ")) + "</strong>" +
    '<div class="stepper">' +
    '<button type="button" class="step-btn" data-delta="-1" data-i="' + i + '">-</button>' +
    '<input class="score-input" type="number" inputmode="numeric" min="0" max="21" value="0" data-i="' + i + '" />' +
    '<button type="button" class="step-btn" data-delta="1" data-i="' + i + '">+</button>' +
    '</div><small class="muted">max 21</small></div>').join("");
  $$(".step-btn").forEach((b) =>
    b.addEventListener("click", () => {
      const inp = $('.score-input[data-i="' + b.dataset.i + '"]');
      inp.value = clampScore(Number(inp.value) + Number(b.dataset.delta));
      onScoreChange();
    })
  );
  $$(".score-input").forEach((i) =>
    i.addEventListener("input", () => { i.value = clampScore(i.value); onScoreChange(); })
  );
  $("#winner-block").hidden = true;
  $("#winner-options").innerHTML = "";
  msg($("#score-msg"), "");
  showStep("score");
});const clampScore = (v) => Math.max(0, Math.min(21, Math.floor(Number(v) || 0)));
const scores = () => $$(".score-input").map((i) => clampScore(i.value));
function onScoreChange() {
  const s = scores(), a = s[0], b = s[1];
  const block = $("#winner-block");
  if (a !== b) {
    block.hidden = true;
    $("#winner-options").innerHTML = "";
    return;
  }
  $("#winner-block > h3").textContent = a === 21
    ? "Both sides reached 21 - choose the winner"
    : "Both sides are on " + a + " - choose the winner";
  if (!$("#winner-options").children.length) {
    $("#winner-options").innerHTML = pending.teams.map((t) =>
      '<button type="button" class="winner-opt" data-side="' + t.side + '">' +
      '<span class="side">Side ' + t.side + "</span><strong>" +
      esc(t.names.join(" & ")) + "</strong></button>").join("");
    $$(".winner-opt").forEach((b) =>
      b.addEventListener("click", () =>
        $$(".winner-opt").forEach((x) => x.classList.toggle("chosen", x === b)))
    );
  }
  block.hidden = false;
}
/* ================================= SAVE ================================== */
$("#save-btn").addEventListener("click", async () => {
  const s = scores(), a = s[0], b = s[1];
  let winner;
  if (a === b) {
    const chosen = $(".winner-opt.chosen");
    if (!chosen) return msg($("#score-msg"), "Scores are level - please choose the winner.", "err");
    winner = chosen.dataset.side;
  } else {
    winner = a > b ? "A" : "B";
  }
  await db.saveMatch({
    type: pending.type,
    teams: pending.teams,
    startedAt: pending.startedAt,
    endedAt: pending.endedAt,
    durationMs: pending.durationMs,
    scores: { A: a, B: b },
    winner: winner,
    decidedManually: a === b
  });
  pending = null;
  msg($("#score-msg"), "");
  showStep("setup");
  await renderHistory();
  const t = $('#tabbar .tab[data-tab="history"]');
  if (t) t.click();
});
/* ================================ HISTORY ================================ */
let hPeriod = "all", hDate = null, hStatus = "all";
$$("#period-chips .chip-btn").forEach((b) =>
  b.addEventListener("click", async () => {
    $$("#period-chips .chip-btn").forEach((x) => x.classList.toggle("active", x === b));
    hPeriod = b.dataset.period;
    const picker = $("#date-pick");
    picker.hidden = hPeriod !== "date";
    if (hPeriod === "date") {
      if (!picker.value) picker.value = stats.istKey(new Date().toISOString());
      hDate = picker.value;
      picker.focus();
    }
    await renderHistory();
  })
);
$("#date-pick").addEventListener("change", async (e) => {
  hDate = e.target.value;
  await renderHistory();
});
$$("#status-chips .chip-btn").forEach((b) =>
  b.addEventListener("click", async () => {
    $$("#status-chips .chip-btn").forEach((x) => x.classList.toggle("active", x === b));
    hStatus = b.dataset.status;
    await renderHistory();
  })
);
const STATUS_LABEL = { pending: "Pending", approved: "Approved", declined: "Declined" };
function statCard(label, value, cls) {
  return '<div class="stat ' + (cls || "") + '"><span>' + label + "</span><strong>" + value + "</strong></div>";
}
async function renderHistory() {
  const all = await db.listMatches();
  const rows = stats.filterMatches(all, { period: hPeriod, date: hDate, status: hStatus });
  const sum = stats.summary(rows);
  const range = stats.periodRange(hPeriod, new Date().toISOString(), hDate);
  $("#history-count").textContent = rows.length;
  $("#history-empty").style.display = rows.length ? "none" : "block";
  $("#history-summary").innerHTML =
    statCard("Matches", sum.total) +
    statCard("Approved", sum.approved, "ok") +
    statCard("Pending", sum.pending, "warn") +
    statCard("Declined", sum.declined, "bad") +
    '<div class="stat full"><span>Range</span><strong>' +
      (range.from ? range.from + (range.to !== range.from ? " to " + range.to : "") : "All time") +
    "</strong></div>";
  $("#history-list").innerHTML = rows.map((m) => {
    const A = m.teams[0], B = m.teams[1];
    const st = stats.statusOf(m);
    const win = (side) => (m.winner === side ? "win" : "");
    const champ = m.winner === "A" ? A : B;
    return '<li class="match">' +
      '<div class="match-head"><span><span class="badge">' + m.type + "</span>" +
        '<span class="badge st-' + st + '">' + STATUS_LABEL[st] + "</span></span>" +
        '<span class="muted">' + istDateTime(m.startedAt) + "</span></div>" +
      '<div class="match-body">' +
        '<div class="team ' + win("A") + '"><strong>' + esc(A.names.join(" & ")) +
          '</strong><span class="pts">' + m.scores.A + "</span></div>" +
        '<div class="team ' + win("B") + '"><strong>' + esc(B.names.join(" & ")) +
          '</strong><span class="pts">' + m.scores.B + "</span></div>" +
      "</div>" +
      '<div class="match-foot"><span>Winner: ' + esc(champ.names.join(" & ")) +
        (m.decidedManually ? " (chosen)" : "") + "</span><span>" + durationWords(m.durationMs) + "</span></div>" +
      '<div class="match-foot muted"><span>' + istTime(m.startedAt) + " to " + istTime(m.endedAt) + "</span></div>" +
      (isSuper()
        ? '<div class="approve-row">' +
          '<button class="mini ok' + (st === "approved" ? " on" : "") + '" data-set="approved" data-id="' + m.id + '">Approve</button>' +
          '<button class="mini bad' + (st === "declined" ? " on" : "") + '" data-set="declined" data-id="' + m.id + '">Decline</button>' +
          '<button class="mini" data-set="pending" data-id="' + m.id + '">Reset</button>' +
          '<button class="mini danger-text" data-del-match="' + m.id + '">Delete</button></div>'
        : "") +
      "</li>";
  }).join("");
  $$("[data-set]").forEach((b) =>
    b.addEventListener("click", async () => {
      await db.setMatchStatus(b.dataset.id, b.dataset.set);
      await renderHistory();
    })
  );
  $$("[data-del-match]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Delete this match record?")) return;
      await db.deleteMatch(b.dataset.delMatch);
      await renderHistory();
    })
  );
}
/* ============================== LEADERBOARD ============================== */
let bPeriod = "all", bCat = "singles";
$$("#board-period .seg-btn").forEach((b) =>
  b.addEventListener("click", async () => {
    $$("#board-period .seg-btn").forEach((x) => x.classList.toggle("active", x === b));
    bPeriod = b.dataset.bperiod;
    await renderBoard();
  })
);
$$("#board-cat .seg-btn").forEach((b) =>
  b.addEventListener("click", async () => {
    $$("#board-cat .seg-btn").forEach((x) => x.classList.toggle("active", x === b));
    bCat = b.dataset.cat;
    await renderBoard();
  })
);
const medal = (i) => (i === 0 ? "gold" : i === 1 ? "silver" : i === 2 ? "bronze" : "");
async function renderBoard() {
  const all = await db.listMatches();
  const scoped = stats.filterMatches(all, { period: bPeriod === "month" ? "month" : "all" });
  const rows = bCat === "singles" ? stats.singlesBoard(scoped)
             : bCat === "doubles" ? stats.doublesBoard(scoped)
             : stats.combinedBoard(scoped);
  const noteCat = bCat === "singles" ? "1 v 1 matches, ranked per player"
                : bCat === "doubles" ? "2 v 2 matches, ranked per player pair"
                : "Singles + doubles, ranked per player";
  $("#board-note").textContent = noteCat + " - approved matches only" +
    (bPeriod === "month" ? " - " + stats.istMonthKey(new Date().toISOString()) : "");
  $("#board-empty").style.display = rows.length ? "none" : "block";
  $("#board-list").innerHTML = rows.map((r, i) => {
    const extra = bCat === "combined"
      ? '<div class="board-extra muted">Singles ' + r.singlesWon + "/" + r.singlesPlayed +
        " &middot; Doubles " + r.doublesWon + "/" + r.doublesPlayed + "</div>"
      : "";
    return '<div class="board-row">' +
      '<span class="rank ' + medal(i) + '">' + (i + 1) + "</span>" +
      '<div class="who"><strong>' + esc(r.name) + "</strong>" + extra + "</div>" +
      '<div class="nums"><span class="wl">' + r.won + "W - " + r.lost + 'L</span>' +
        '<span class="pctbar"><i style="width:' + r.winPct + '%"></i></span>' +
        '<span class="pctnum">' + r.winPct + "%</span></div>" +
      "</div>";
  }).join("");
}
/* ============================== DASHBOARD ================================ */
let dPeriod = "all";
$$("#dash-period .seg-btn").forEach((b) =>
  b.addEventListener("click", async () => {
    $$("#dash-period .seg-btn").forEach((x) => x.classList.toggle("active", x === b));
    dPeriod = b.dataset.dperiod;
    await renderDash();
  })
);
async function renderDash() {
  const all = await db.listMatches();
  const scoped = stats.filterMatches(all, { period: dPeriod === "month" ? "month" : "all" });
  const list = await db.listApprovedPlayers();
  const rows = stats.playerStats(scoped, list.map((p) => p.name));
  const sum = stats.summary(scoped);
  $("#dash-summary").innerHTML =
    statCard("Players", list.length) +
    statCard("Approved", sum.approved, "ok") +
    statCard("Pending", sum.pending, "warn") +
    statCard("Declined", sum.declined, "bad");
  $("#dash-empty").style.display = rows.length ? "none" : "block";
  $("#dash-list").innerHTML = rows.map((r) => {
    const form = r.form.length
      ? r.form.map((f) => '<i class="dot ' + (f === "W" ? "w" : "l") + '">' + f + "</i>").join("")
      : '<span class="muted">no matches yet</span>';
    const streak = r.streak
      ? (r.streakType === "W" ? r.streak + " win streak" : r.streak + " loss streak")
      : "-";
    return '<div class="dash-card">' +
      '<div class="dash-top"><div class="avatar">' + esc(r.name.trim().charAt(0).toUpperCase()) + "</div>" +
        "<div><strong>" + esc(r.name) + "</strong>" +
        '<div class="muted">' + (r.lastPlayed ? "Last played " + istDateTime(r.lastPlayed) : "No approved matches") + "</div></div>" +
        '<div class="big-pct">' + r.winPct + '%<span class="muted">win</span></div></div>' +
      '<div class="dash-grid">' +
        statCard("Played", r.played) +
        statCard("Won", r.won, "ok") +
        statCard("Lost", r.lost, "bad") +
        statCard("Singles", r.singlesWon + "/" + r.singlesPlayed + " (" + r.singlesPct + "%)") +
        statCard("Doubles", r.doublesWon + "/" + r.doublesPlayed + " (" + r.doublesPct + "%)") +
        statCard("Streak", streak) +
        statCard("Avg match", r.avgMs ? durationWords(r.avgMs) : "-") +
        statCard("Court time", r.totalMs ? durationWords(r.totalMs) : "-") +
      "</div>" +
      '<div class="form-row"><span class="muted">Recent form</span>' + form + "</div>" +
      "</div>";
  }).join("");
}/* ================================= ADMIN ================================= */
function makePassword() {
  const words = ["ace", "smash", "drop", "rally", "serve", "court", "net", "drive"];
  return words[Math.floor(Math.random() * words.length)] + Math.floor(100 + Math.random() * 900);
}
$("#gen-pass").addEventListener("click", () => { $("#nu-password").value = makePassword(); });
$("#nu-name").addEventListener("input", () => {
  const field = $("#nu-username");
  if (field.dataset.touched === "1") return;
  field.value = $("#nu-name").value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
});
$("#nu-username").addEventListener("input", (e) => { e.target.dataset.touched = "1"; });
function showCredentials(name, username, password) {
  const box = $("#cred-box");
  box.hidden = false;
  box.innerHTML =
    "<h3>Login details for " + esc(name) + "</h3>" +
    '<div class="cred-row"><span>Username</span><code>' + esc(username) + "</code></div>" +
    '<div class="cred-row"><span>Password</span><code>' + esc(password) + "</code></div>" +
    '<p class="muted m0">Passwords are stored hashed and cannot be read back - reset it below if forgotten.</p>' +
    '<button type="button" class="ghost wide" id="copy-cred">Copy login details</button>';
  $("#copy-cred").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText("MatchTracker admin\nUsername: " + username + "\nPassword: " + password);
      $("#copy-cred").textContent = "Copied";
    } catch (e) {
      $("#copy-cred").textContent = "Copy failed - note it manually";
    }
  });
}
$("#create-user-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = $("#nu-password").value;
  try {
    const u = await db.createUser({
      name: $("#nu-name").value,
      username: $("#nu-username").value,
      password: password,
      role: $("#nu-role").value
    });
    e.target.reset();
    $("#nu-username").dataset.touched = "";
    showCredentials(u.name, u.username, password);
    msg($("#create-user-msg"),
        "Created " + (u.role === "super" ? "main" : "limited") + " admin " + u.name + ".", "ok");
    await renderUsers();
  } catch (err) {
    $("#cred-box").hidden = true;
    msg($("#create-user-msg"), err.message, "err");
  }
});
async function renderUsers() {
  const users = await db.listUsers();
  $("#user-count").textContent = users.length;
  $("#user-list").innerHTML = users.map((u) => {
    const canDelete = u.username !== "admin" && (!admin || u.id !== admin.id);
    return "<li><span><strong>" + esc(u.name) + '</strong><small class="muted"> @' +
      esc(u.username) + "</small>" +
      '<span class="chip chip-role">' + (u.role === "super" ? "main" : "limited") + "</span>" +
      (u.active ? "" : '<span class="chip chip-off">disabled</span>') +
      '</span><span class="actions">' +
      '<button class="link" data-reset="' + u.id + '" data-name="' + esc(u.name) + '">reset password</button>' +
      (canDelete ? '<button class="link danger-text" data-del-user="' + u.id + '">delete</button>' : "") +
      "</span></li>";
  }).join("");
  $$("[data-reset]").forEach((b) =>
    b.addEventListener("click", async () => {
      const pwd = prompt("New password for " + b.dataset.name + ":", makePassword());
      if (!pwd) return;
      try {
        const u = await db.resetPassword(b.dataset.reset, pwd);
        showCredentials(u.name, u.username, pwd);
        msg($("#create-user-msg"), "Password reset for " + u.name + ".", "ok");
      } catch (err) {
        msg($("#create-user-msg"), err.message, "err");
      }
    })
  );
  $$("[data-del-user]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Delete this admin?")) return;
      try { await db.deleteUser(b.dataset.delUser); await renderUsers(); }
      catch (err) { msg($("#create-user-msg"), err.message, "err"); }
    })
  );
}
/* ================================ START ================================== */
await db.init();
// Ask the server who we are, so the role is authoritative (not localStorage).
admin = currentUser();
try { admin = await refreshUser(); } catch (e) { /* offline: keep cached */ }
applyRole();
// The screen must still render if the backend is down or not set up yet,
// otherwise a failed request leaves the user staring at a blank page.
try {
  await refreshPlayers();
  await renderHistory();
  if (admin) { await renderPlayersAdmin(); if (isSuper()) await renderUsers(); }
} catch (err) {
  console.error(err);
  msg($("#setup-msg"),
      "Cannot reach the database (" + err.message + "). " +
      "If this project is new, run supabase-migrate.sql in the Supabase SQL editor.", "err");
}
showStep("setup");
restoreLive();
showView("app");
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(console.error);
  });
}




