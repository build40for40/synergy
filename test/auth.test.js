import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticate, requireUser, workosIssuer } from '../worker/auth.js';
import { issuer, keys, signToken } from './helpers.js';

const withToken = token => new Request('https://api.test/leads/today', { headers: token ? { Authorization: `Bearer ${token}` } : {} });

test('accepts a valid WorkOS access token and returns its user id', async () => {
  assert.equal(await authenticate(withToken(await signToken('user_abc123')), keys, issuer), 'user_abc123');
});

test('rejects missing, malformed, foreign, expired and odd-subject tokens', async () => {
  assert.equal(await authenticate(withToken(), keys, issuer), null);
  assert.equal(await authenticate(withToken('not-a-jwt'), keys, issuer), null);
  assert.equal(await authenticate(withToken(await signToken('user_abc', { iss: workosIssuer('client_other') })), keys, issuer), null);
  assert.equal(await authenticate(withToken(await signToken('user_abc', { exp: '1 minute ago' })), keys, issuer), null);
  assert.equal(await authenticate(withToken(await signToken('admin')), keys, issuer), null);
});

test('rejects a token signed with a different key', async () => {
  const { generateKeyPair, SignJWT } = await import('jose');
  const { privateKey } = await generateKeyPair('RS256');
  const forged = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setSubject('user_abc')
    .setIssuer(issuer).setIssuedAt().setExpirationTime('5m').sign(privateKey);
  assert.equal(await authenticate(withToken(forged), keys, issuer), null);
});

test('requireUser explains what is wrong', async () => {
  assert.deepEqual(await requireUser(withToken(), {}), { error: 'auth_unavailable', message: 'Sign-in is not configured on this server.', status: 503 });
  const missing = await requireUser(withToken(), {}, { keys, issuer });
  assert.equal(missing.status, 401);
  assert.equal(missing.error, 'sign_in_required');
  assert.deepEqual(await requireUser(withToken(await signToken('user_abc')), {}, { keys, issuer }), { userId: 'user_abc' });
});
