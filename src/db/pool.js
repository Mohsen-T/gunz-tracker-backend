/**
 * MySQL connection pool (mysql2/promise)
 */

const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  uri: process.env.DATABASE_URL,
  waitForConnections: true,
  connectionLimit: 20,
  idleTimeout: 30000,
  connectTimeout: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected DB pool error:', err.message);
});

// Helper for single queries — returns pg-compatible { rows } shape
async function query(text, params) {
  const [result] = await pool.execute(text, params);
  if (Array.isArray(result)) {
    return { rows: result };
  }
  // INSERT/UPDATE/DELETE returns ResultSetHeader
  return { rows: [], affectedRows: result.affectedRows, insertId: result.insertId };
}

// Helper for transactions — returns a wrapped connection
async function getClient() {
  const conn = await pool.getConnection();
  return {
    query: async (text, params) => {
      if (text === 'BEGIN') { await conn.beginTransaction(); return { rows: [] }; }
      if (text === 'COMMIT') { await conn.commit(); return { rows: [] }; }
      if (text === 'ROLLBACK') { await conn.rollback(); return { rows: [] }; }
      const [result] = await conn.execute(text, params);
      if (Array.isArray(result)) {
        return { rows: result };
      }
      return { rows: [], affectedRows: result.affectedRows, insertId: result.insertId };
    },
    release: () => conn.release(),
  };
}

module.exports = { pool, query, getClient };
