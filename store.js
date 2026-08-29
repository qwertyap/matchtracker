// ---------------------------------------------------------------------------
// Cloud data layer (Supabase). Same function names the app already used, so
// the UI code did not have to change.
//   - players + matches are read by everyone
//   - anyone can record a match (it starts as "pending")
//   - every admin action goes through a SECURITY DEFINER function guarded by
//     a session token, so the public key alone can change nothing.
// ---------------------------------------------------------------------------
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
const REST = SUPABASE_URL + "/rest/v1";
const HEAD = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: "Bearer " + SUPABASE_ANON_KEY,
  "Content-Type": "application/json"
};
const TOKEN_KEY = "matchtracker.token";
export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY);
async function api(path, options = {}) {
  const res = await fetch(REST + path, { ...options, headers: { ...HEAD, ...(options.headers || {}) } });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const m = (body && (body.message || body.hint || body.error)) || ("Request failed (" + res.status + ")");
    throw new Error(String(m).replace(/^.*?:\s*/, ""));
  }
  return body;
}
const rpc = (fn, args) =>
  api("/rpc/" + fn, { method: "POST", body: JSON.stringify(args || {}) });
export async function init() { return true; }
/* --------------------------------- auth ---------------------------------- */
export async function adminLogin(username, password) {
  const out = await rpc("mt_login", { p_username: username, p_password: password });
  setToken(out.token);
  return { id: out.id, name: out.name, username: out.username, role: "admin" };
}
export async function adminLogout() {
  const t = getToken();
  setToken(null);
  if (t) { try { await rpc("mt_logout", { p_token: t }); } catch (e) {} }
}
// Confirms a stored token is still valid (used on app start)
export async function whoAmI() {
  const t = getToken();
  if (!t) return null;
  try {
    const admins = await rpc("mt_list_admins", { p_token: t });
    const me = JSON.parse(localStorage.getItem("matchtracker.me") || "null");
    if (me && admins.some((a) => a.id === me.id)) return me;
    return me;
  } catch (e) {
    setToken(null);
    return null;
  }
}
/* -------------------------------- admins --------------------------------- */
export async function listUsers() {
  const t = getToken();
  if (!t) return [];
  const rows = await rpc("mt_list_admins", { p_token: t });
  return rows.map((r) => ({ ...r, role: "admin" }));
}
export async function createUser({ name, username, password }) {
  const out = await rpc("mt_create_admin", {
    p_token: getToken(), p_name: name, p_username: username, p_password: password
  });
  return { ...out, role: "admin" };
}
export async function resetPassword(id, password) {
  return rpc("mt_reset_password", { p_token: getToken(), p_id: id, p_password: password });
}
export async function deleteUser(id) {
  return rpc("mt_delete_admin", { p_token: getToken(), p_id: id });
}
/* -------------------------------- players -------------------------------- */
export async function listPlayers() {
  return api("/mt_players?select=id,name&order=name.asc");
}
export async function createPlayer(name) {
  const n = String(name || "").trim();
  if (n.length < 2) throw new Error("Player name must be at least 2 characters.");
  return rpc("mt_add_player", { p_token: getToken(), p_name: n });
}
export async function renamePlayer(id, name) {
  const n = String(name || "").trim();
  if (n.length < 2) throw new Error("Player name must be at least 2 characters.");
  return rpc("mt_rename_player", { p_token: getToken(), p_id: id, p_name: n });
}
export async function deletePlayer(id) {
  return rpc("mt_delete_player", { p_token: getToken(), p_id: id });
}
/* -------------------------------- matches -------------------------------- */
const fromRow = (r) => ({
  id: r.id,
  type: r.type,
  teams: r.teams,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  durationMs: Number(r.duration_ms),
  pausedMs: Number(r.paused_ms || 0),
  scores: { A: r.score_a, B: r.score_b },
  winner: r.winner,
  decidedManually: r.decided_manually,
  status: r.status
});
export async function saveMatch(m) {
  const row = {
    type: m.type,
    teams: m.teams,
    started_at: m.startedAt,
    ended_at: m.endedAt,
    duration_ms: Math.round(m.durationMs),
    paused_ms: Math.round(m.pausedMs || 0),
    score_a: m.scores.A,
    score_b: m.scores.B,
    winner: m.winner,
    decided_manually: !!m.decidedManually,
    status: "pending"
  };
  const out = await api("/mt_matches", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(row)
  });
  return fromRow(out[0]);
}
export async function listMatches() {
  const rows = await api("/mt_matches?select=*&order=started_at.desc&limit=2000");
  return rows.map(fromRow);
}
export async function setMatchStatus(id, status) {
  return rpc("mt_set_match_status", { p_token: getToken(), p_id: id, p_status: status });
}
export async function deleteMatch(id) {
  return rpc("mt_delete_match", { p_token: getToken(), p_id: id });
}
