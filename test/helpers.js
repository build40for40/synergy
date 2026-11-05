import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';

// Real SQLite with D1's prepare/bind/batch shape, rather than mocked results.
export function database() {
  const sqlite = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  const db = {
    prepare(sql) {
      let values = [];
      const statement = {
        bind(...bindings) { values = bindings; return statement; },
        async all() { return { success: true, results: sqlite.prepare(sql).all(...values) }; },
        async first() { return sqlite.prepare(sql).get(...values) ?? null; },
        async run() {
          const meta = sqlite.prepare(sql).run(...values);
          return { success: true, meta: { ...meta, last_row_id: Number(meta.lastInsertRowid) } };
        }
      };
      return statement;
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  };
  return db;
}

export function company(n, overrides = {}) {
  return {
    uuid: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
    name: `Company ${n}`,
    domain: `company${n}.example`,
    links: { website: `https://company${n}.example` },
    locations: [{ role: 'hq', city: { name: 'London' }, country: { name: 'United Kingdom' } }],
    launch_date: '2012-03',
    employees_count: 40 + n,
    employee_count_1y_growth: n,
    funding: { total: null, rounds_count: 0 },
    status: 'operational',
    founders: { total: 1, items: [{ person: { uuid: `p${n}`, name: `Founder ${n}` } }] },
    ...overrides
  };
}

// Signed-in requests in tests: a local RS256 key pair stands in for WorkOS's JWKS.
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
const { publicKey, privateKey } = await generateKeyPair('RS256');
export const issuer = 'https://api.workos.com/user_management/client_test';
export const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' }] });

export function signToken(userId, { iss = issuer, exp = '5m' } = {}) {
  return new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setSubject(userId).setIssuer(iss).setIssuedAt().setExpirationTime(exp).sign(privateKey);
}
