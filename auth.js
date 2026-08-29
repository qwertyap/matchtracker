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
export async function logout() {
  localStorage.removeItem(ME);
  await db.adminLogout();
}
