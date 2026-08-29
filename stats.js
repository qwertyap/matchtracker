// ---------------------------------------------------------------------------
// Date helpers (all in IST) + leaderboard / dashboard aggregation.
// Only APPROVED matches ever reach the leaderboards and player stats.
// ---------------------------------------------------------------------------
const IST = "Asia/Kolkata";
const partsFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit"
});
// "YYYY-MM-DD" for an ISO timestamp, in IST
export function istKey(iso) {
  return partsFmt.format(new Date(iso));
}
export const istMonthKey = (iso) => istKey(iso).slice(0, 7);
// Add days to a "YYYY-MM-DD" key
function addDays(key, n) {
  const d = new Date(key + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// Monday of the week containing the given key
function weekStart(key) {
  const d = new Date(key + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7; // Mon = 0
  return addDays(key, -dow);
}
export function periodRange(period, todayIso = new Date().toISOString(), pickedDate = null) {
  const today = istKey(todayIso);
  switch (period) {
    case "today":  return { from: today, to: today, label: "Today" };
    case "week":   return { from: weekStart(today), to: addDays(weekStart(today), 6), label: "This week" };
    case "month":  return { from: today.slice(0, 7) + "-01", to: today, label: "This month" };
    case "date":   return { from: pickedDate, to: pickedDate, label: pickedDate || "Pick a date" };
    default:       return { from: null, to: null, label: "All time" };
  }
}
export function inRange(iso, range) {
  if (!range.from || !range.to) return true;
  const k = istKey(iso);
  return k >= range.from && k <= range.to;
}
export const STATUS = { PENDING: "pending", APPROVED: "approved", DECLINED: "declined" };
export const statusOf = (m) => m.status || STATUS.PENDING;
export function filterMatches(matches, { period = "all", date = null, status = "all" } = {}) {
  const range = periodRange(period, new Date().toISOString(), date);
  return matches.filter((m) =>
    inRange(m.startedAt, range) && (status === "all" || statusOf(m) === status));
}
export const approvedOnly = (matches) => matches.filter((m) => statusOf(m) === STATUS.APPROVED);
/* --------------------------- aggregation helpers ------------------------- */
const pct = (w, p) => (p ? Math.round((w / p) * 1000) / 10 : 0);
function bump(map, key, seed) {
  if (!map.has(key)) map.set(key, { key, played: 0, won: 0, lost: 0, ...seed });
  return map.get(key);
}
const sortBoard = (rows) =>
  rows.sort((a, b) => b.won - a.won || b.winPct - a.winPct || a.played - b.played ||
    a.name.localeCompare(b.name));
const finish = (map) =>
  sortBoard([...map.values()].map((r) => ({ ...r, winPct: pct(r.won, r.played) })));
/* --------------------------------- boards -------------------------------- */
// Singles: 1v1 only, per player
export function singlesBoard(matches) {
  const map = new Map();
  approvedOnly(matches).filter((m) => m.type === "1v1").forEach((m) => {
    m.teams.forEach((t) => {
      const name = t.names[0];
      const r = bump(map, name, { name });
      r.played++;
      if (m.winner === t.side) r.won++; else r.lost++;
    });
  });
  return finish(map);
}
// Doubles: 2v2 only, per pair of players
export function doublesBoard(matches) {
  const map = new Map();
  approvedOnly(matches).filter((m) => m.type === "2v2").forEach((m) => {
    m.teams.forEach((t) => {
      const name = [...t.names].sort((x, y) => x.localeCompare(y)).join(" & ");
      const r = bump(map, name, { name, members: t.names });
      r.played++;
      if (m.winner === t.side) r.won++; else r.lost++;
    });
  });
  return finish(map);
}
// Combined: every approved match, credited to each individual player
export function combinedBoard(matches) {
  const map = new Map();
  approvedOnly(matches).forEach((m) => {
    m.teams.forEach((t) => {
      t.names.forEach((name) => {
        const r = bump(map, name, { name, singlesPlayed: 0, singlesWon: 0, doublesPlayed: 0, doublesWon: 0 });
        const won = m.winner === t.side;
        r.played++;
        if (won) r.won++; else r.lost++;
        if (m.type === "1v1") { r.singlesPlayed++; if (won) r.singlesWon++; }
        else { r.doublesPlayed++; if (won) r.doublesWon++; }
      });
    });
  });
  return finish(map);
}
/* ------------------------------- dashboard ------------------------------- */
export function playerStats(matches, playerNames) {
  const approved = approvedOnly(matches);
  const byName = new Map(combinedBoard(matches).map((r) => [r.name, r]));
  return playerNames.map((name) => {
    const base = byName.get(name) || {
      name, played: 0, won: 0, lost: 0, winPct: 0,
      singlesPlayed: 0, singlesWon: 0, doublesPlayed: 0, doublesWon: 0
    };
    const mine = approved
      .filter((m) => m.teams.some((t) => t.names.includes(name)))
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
    const form = mine.slice(0, 5).map((m) => {
      const t = m.teams.find((x) => x.names.includes(name));
      return m.winner === t.side ? "W" : "L";
    });
    let streak = 0, streakType = null;
    for (const r of form.length ? mine.map((m) => {
      const t = m.teams.find((x) => x.names.includes(name));
      return m.winner === t.side ? "W" : "L";
    }) : []) {
      if (streakType === null) { streakType = r; streak = 1; }
      else if (r === streakType) streak++;
      else break;
    }
    const totalMs = mine.reduce((s, m) => s + (m.durationMs || 0), 0);
    return {
      ...base,
      singlesPct: pct(base.singlesWon, base.singlesPlayed),
      doublesPct: pct(base.doublesWon, base.doublesPlayed),
      form,
      streak, streakType,
      lastPlayed: mine[0] ? mine[0].startedAt : null,
      avgMs: mine.length ? Math.round(totalMs / mine.length) : 0,
      totalMs
    };
  }).sort((a, b) => b.played - a.played || b.won - a.won || a.name.localeCompare(b.name));
}
export function summary(matches) {
  const total = matches.length;
  const approved = matches.filter((m) => statusOf(m) === STATUS.APPROVED).length;
  const pending = matches.filter((m) => statusOf(m) === STATUS.PENDING).length;
  const declined = matches.filter((m) => statusOf(m) === STATUS.DECLINED).length;
  return { total, approved, pending, declined };
}
