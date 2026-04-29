const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
  // Connection pool sizing suitable for Railway's shared PostgreSQL
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

/**
 * Run a single query against the pool.
 */
const query = (text, params) => pool.query(text, params);

/**
 * Verify the database connection at startup.
 * Throws if DATABASE_URL is missing or the DB is unreachable.
 */
async function testConnection() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is not set. ' +
      'Make sure the PostgreSQL service is linked in the Railway project.'
    );
  }
  const { rows } = await pool.query('SELECT NOW() AS time, current_database() AS db');
  console.log(`✓ PostgreSQL connected — db: ${rows[0].db}, time: ${rows[0].time}`);
}

module.exports = { query, pool, testConnection };
