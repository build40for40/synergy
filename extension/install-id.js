// No sign-in for now (see worker/user.js): each install makes a random id, kept in
// chrome.storage.local, and sends it with every API call so its leads and notes stay its own.
const KEY = 'install_id';

export async function installId() {
  if (globalThis.chrome?.storage?.local) {
    const stored = (await chrome.storage.local.get(KEY))[KEY];
    if (stored) return stored;
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ [KEY]: id });
    return id;
  }
  // Opened as a plain page (e.g. while designing): fall back to localStorage.
  try {
    let id = localStorage.getItem(KEY);
    if (!id) { id = crypto.randomUUID(); localStorage.setItem(KEY, id); }
    return id;
  } catch { return crypto.randomUUID(); }
}
