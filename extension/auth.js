// Sign-in for the side panel, with WorkOS AuthKit (the same WorkOS environments as Joyo and the Naughty List).
//
// Joyo's browser library can't run inside an extension, so this does the same flow by hand:
// Chrome's own sign-in window (chrome.identity.launchWebAuthFlow) opens WorkOS's hosted sign-in,
// which returns to https://<extension id>.chromiumapp.org/ with a code. The code is swapped for
// tokens with PKCE, so there is no secret in the extension. Tokens stay in chrome.storage.local,
// which only this extension can read. The access token is refreshed shortly before it expires.
//
// The store build swaps this staging client for production (scripts/package-extension.mjs).
const CLIENT_ID = 'client_01M6E5ZDCH31RFHPJTD8N5JQZY';
const WORKOS = 'https://api.workos.com/user_management';
const SESSION_KEY = 'session';
const REFRESH_MARGIN_MS = 60_000;

const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomString = length => b64url(crypto.getRandomValues(new Uint8Array(length)));

export async function pkcePair() {
  const verifier = randomString(48);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

/** Seconds-since-epoch expiry from a JWT, or 0 when it can't be read. */
export function tokenExpiry(token) {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(part)).exp ?? 0;
  } catch {
    return 0;
  }
}

async function exchange(body) {
  const response = await fetch(`${WORKOS}/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, ...body })
  });
  if (!response.ok) throw new Error(`WorkOS sign-in failed (${response.status})`);
  const { access_token, refresh_token, user } = await response.json();
  // Only what the panel shows. The Worker never sees or stores the email.
  const session = { access_token, refresh_token, user: { id: user.id, email: user.email, first_name: user.first_name ?? null } };
  await chrome.storage.local.set({ [SESSION_KEY]: session });
  return session;
}

async function readSession() {
  return (await chrome.storage.local.get(SESSION_KEY))[SESSION_KEY] ?? null;
}

export async function currentUser() {
  return (await readSession())?.user ?? null;
}

/** Opens WorkOS's hosted sign-in in Chrome's sign-in window. Resolves with the user, or throws. */
export async function signIn() {
  const { verifier, challenge } = await pkcePair();
  const state = randomString(16);
  const url = new URL(`${WORKOS}/authorize`);
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: chrome.identity.getRedirectURL(),
    response_type: 'code',
    provider: 'authkit',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state
  });
  const returned = new URL(await chrome.identity.launchWebAuthFlow({ url: url.href, interactive: true }));
  if (returned.searchParams.get('state') !== state) throw new Error('Sign-in was interrupted. Try again.');
  const code = returned.searchParams.get('code');
  if (!code) throw new Error(returned.searchParams.get('error_description') || 'Sign-in was cancelled.');
  return (await exchange({ grant_type: 'authorization_code', code, code_verifier: verifier })).user;
}

let refreshing = null;

/** A current access token, refreshed if it's about to expire. Null when signed out. */
export async function accessToken() {
  const session = await readSession();
  if (!session) return null;
  if (tokenExpiry(session.access_token) * 1000 - Date.now() > REFRESH_MARGIN_MS) return session.access_token;
  refreshing ??= exchange({ grant_type: 'refresh_token', refresh_token: session.refresh_token })
    .then(fresh => fresh.access_token)
    .catch(async () => { await signOut(); return null; })
    .finally(() => { refreshing = null; });
  return refreshing;
}

/** Forgets the tokens on this device. The next sign-in may skip the password if WorkOS still has a session. */
export async function signOut() {
  await chrome.storage.local.remove(SESSION_KEY);
}
