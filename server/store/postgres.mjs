// Postgres store (used when DATABASE_URL is set, as in compose.yaml). Same
// contract as memory.mjs. Migrations in server/migrations/*.sql are applied
// in order on start, each once, inside a transaction.
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { findAccountMatch } from './matching.mjs';

const MIGRATIONS = new URL('../migrations/', import.meta.url);

async function migrate(pool) {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const applied = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((row) => row.name));
  for (const name of (await readdir(MIGRATIONS)).filter((file) => file.endsWith('.sql')).sort()) {
    if (applied.has(name)) continue;
    await transaction(pool, async (client) => {
      await client.query(await readFile(new URL(name, MIGRATIONS), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    });
  }
}

async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const ACCOUNT_COLUMNS = 'a.id, a.marketplace, a.domain, a.customer_id AS "customerId", a.name, a.email';
const toAccount = (row) => ({ ...row, id: Number(row.id) });

async function upsertAccount(client, summary) {
  // Serializes reports for one marketplace, so two profiles reporting the same
  // account at once can't create it twice.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${summary.marketplace}${summary.domain}`]);
  const candidates = (await client.query(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts a WHERE a.marketplace = $1 AND a.domain = $2`,
    [summary.marketplace, summary.domain],
  )).rows.map(toAccount);
  const existing = findAccountMatch(candidates, summary);
  if (existing) {
    await client.query(
      `UPDATE accounts SET customer_id = COALESCE(customer_id, $2), name = COALESCE($3, name),
         email = COALESCE($4, email), updated_at = now() WHERE id = $1`,
      [existing.id, summary.customerId, summary.name, summary.email],
    );
    return existing.id;
  }
  const { rows } = await client.query(
    'INSERT INTO accounts (marketplace, domain, customer_id, name, email) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [summary.marketplace, summary.domain, summary.customerId, summary.name, summary.email],
  );
  return Number(rows[0].id);
}

const HOLDERS = `COALESCE((SELECT json_agg(json_build_object('profileId', pa.profile_id, 'status', pa.status) ORDER BY pa.profile_id)
  FROM profile_accounts pa WHERE pa.account_id = a.id), '[]') AS holders`;

export async function createPostgresStore(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 5 });
  await migrate(pool);

  return {
    async touchProfile(profileId) {
      await pool.query(
        `INSERT INTO profiles (id) VALUES ($1)
         ON CONFLICT (id) DO UPDATE SET last_seen_at = now()`,
        [profileId],
      );
    },
    async replaceProfileAccounts(profileId, summaries) {
      await transaction(pool, async (client) => {
        await client.query('INSERT INTO profiles (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET last_seen_at = now()', [profileId]);
        const held = [];
        for (const summary of summaries) {
          const accountId = await upsertAccount(client, summary);
          held.push(accountId);
          await client.query(
            `INSERT INTO profile_accounts (profile_id, account_id, status) VALUES ($1, $2, $3)
             ON CONFLICT (profile_id, account_id) DO UPDATE SET status = EXCLUDED.status, reported_at = now()`,
            [profileId, accountId, summary.status],
          );
        }
        await client.query('DELETE FROM profile_accounts WHERE profile_id = $1 AND NOT (account_id = ANY($2::bigint[]))', [profileId, held]);
      });
    },
    async listAccounts() {
      const { rows } = await pool.query(
        `SELECT ${ACCOUNT_COLUMNS}, ${HOLDERS} FROM accounts a
         WHERE EXISTS (SELECT 1 FROM profile_accounts pa WHERE pa.account_id = a.id) ORDER BY a.id`,
      );
      return rows.map(toAccount);
    },
    async getAccount(id) {
      const { rows } = await pool.query(
        `SELECT ${ACCOUNT_COLUMNS}, ${HOLDERS} FROM accounts a WHERE a.id = $1`,
        [id],
      );
      return rows[0] ? toAccount(rows[0]) : null;
    },
    close: () => pool.end(),
  };
}
