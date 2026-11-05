// Sign-in, reusing the WorkOS AuthKit pattern from Joyo (Day 1) and the Naughty List (Day 3).
// The extension signs in through WorkOS's hosted page and sends `Authorization: Bearer <access token>`.
// The Worker checks the token's RS256 signature against WorkOS's public keys for our client and its
// issuer, and uses the signed `sub` (a WorkOS user id) as the user. A request body can never pick
// the user, and the email is never stored.
import { createRemoteJWKSet, jwtVerify } from 'jose';

const keySets = new Map();

export const workosIssuer = clientId => `https://api.workos.com/user_management/${clientId}`;

export function workosKeys(clientId) {
  if (!keySets.has(clientId)) keySets.set(clientId, createRemoteJWKSet(new URL(`https://api.workos.com/sso/jwks/${clientId}`)));
  return keySets.get(clientId);
}

/** The signed-in user's WorkOS id, or null when the request has no valid access token. */
export async function authenticate(request, keys, issuer) {
  const token = request.headers.get('Authorization')?.match(/^Bearer (\S+)$/)?.[1];
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, keys, { issuer, algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat'] });
    return typeof payload.sub === 'string' && /^user_[a-zA-Z0-9]+$/.test(payload.sub) ? payload.sub : null;
  } catch {
    return null;
  }
}

/**
 * The user for an API request: { userId } or { error, status }.
 * `keys` and `issuer` are injectable so tests can sign their own tokens.
 */
export async function requireUser(request, env, { keys, issuer } = {}) {
  if (!env.WORKOS_CLIENT_ID && !keys) return { error: 'auth_unavailable', message: 'Sign-in is not configured on this server.', status: 503 };
  const userId = await authenticate(
    request,
    keys ?? workosKeys(env.WORKOS_CLIENT_ID),
    issuer ?? (env.WORKOS_ISSUER || workosIssuer(env.WORKOS_CLIENT_ID))
  );
  return userId ? { userId } : { error: 'sign_in_required', message: 'Sign in to see your leads.', status: 401 };
}
