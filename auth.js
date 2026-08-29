import * as db from "./store.js";
const ME = "matchtracker.me";
export function currentUser() {
  try { return JSON.parse(localStorage.getItem(ME) || "null"); } catch (e) { return null; }
}
export async function login(username, password) {
  const me = await db.adminLogin(username, password);
  localStorage.setItem(ME, JSON.stringify(me));
  return me;
}
// Re-checks the stored session against the server on start-up, so the role
// comes from the database and cannot be faked by editing localStorage.
export async function refreshUser() {
  const me = await db.whoAmI();
  if (me) localStorage.setItem(ME, JSON.stringify(me));
  else localStorage.removeItem(ME);
  return me;
}
export function isSuper(u = currentUser()) {
  return !!u && u.role === "super";
}
export async function logout() {
  localStorage.removeItem(ME);
  await db.adminLogout();
}
