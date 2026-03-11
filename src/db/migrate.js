/**
 * GUNZ Node Tracker — Database Migration (MySQL)
 * Creates all tables for the tracker backend.
 *
 * Run: node src/db/migrate.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

const STATEMENTS = [
  // Main nodes table: 10,000 rows, one per validator NFT
  // Synced every 2 minutes from api.gunzchain.app
  `CREATE TABLE IF NOT EXISTS nodes (
    id                    VARCHAR(10) PRIMARY KEY,
    rarity                VARCHAR(20) NOT NULL,
    activity              VARCHAR(10) NOT NULL DEFAULT 'Inactive',
    activity_period_pct   DECIMAL(8,4) DEFAULT 0,
    total_hashpower_pct   DECIMAL(12,7) DEFAULT 0,
    wallet_address        VARCHAR(42),
    hexes_decoded         INTEGER DEFAULT 0,
    hex_distribution_rate DECIMAL(12,7) DEFAULT 0,

    -- Static fields derived from rarity
    hashpower             INTEGER NOT NULL DEFAULT 0,
    resale_rate           DECIMAL(3,2) NOT NULL DEFAULT 0,

    -- Delta tracking (previous sync values for change detection)
    prev_hexes_decoded    INTEGER DEFAULT 0,
    prev_activity         VARCHAR(10),

    -- Timestamps
    first_seen_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_nodes_rarity (rarity),
    INDEX idx_nodes_activity (activity),
    INDEX idx_nodes_hexes (hexes_decoded DESC),
    INDEX idx_nodes_wallet (wallet_address),
    INDEX idx_nodes_distribution (hex_distribution_rate DESC)
  )`,

  // Daily snapshots for historical charts
  // One row per node per day
  `CREATE TABLE IF NOT EXISTS node_snapshots (
    id                    INT AUTO_INCREMENT PRIMARY KEY,
    node_id               VARCHAR(10) NOT NULL,
    snapshot_date         DATE NOT NULL,
    hexes_decoded         INTEGER DEFAULT 0,
    hex_distribution_rate DECIMAL(12,7) DEFAULT 0,
    activity              VARCHAR(10),
    activity_period_pct   DECIMAL(8,4) DEFAULT 0,
    UNIQUE KEY uk_node_date (node_id, snapshot_date),
    INDEX idx_snapshots_date (snapshot_date DESC),
    INDEX idx_snapshots_node (node_id),
    FOREIGN KEY (node_id) REFERENCES nodes(id)
  )`,

  // Global daily stats from aggregate endpoints
  `CREATE TABLE IF NOT EXISTS global_stats (
    stat_date             DATE PRIMARY KEY,
    total_hexes           INTEGER DEFAULT 0,
    total_hashpower       BIGINT DEFAULT 0,
    distribution          JSON,
    activity_breakdown    JSON,
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,

  // Sync metadata (tracks sync state)
  `CREATE TABLE IF NOT EXISTS sync_log (
    id                    INT AUTO_INCREMENT PRIMARY KEY,
    sync_type             VARCHAR(50) NOT NULL,
    nodes_synced          INTEGER DEFAULT 0,
    nodes_changed         INTEGER DEFAULT 0,
    duration_ms           INTEGER DEFAULT 0,
    error                 TEXT,
    synced_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_sync_log_time (synced_at DESC)
  )`,
];

async function migrate() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);
  try {
    console.log('Running GUNZ Node Tracker migration...');
    for (const sql of STATEMENTS) {
      await conn.execute(sql);
    }
    console.log('Migration complete — all tables created');

    // Verify tables
    const [rows] = await conn.execute(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = DATABASE()
       ORDER BY table_name`
    );
    console.log('Tables:', rows.map(r => r.TABLE_NAME).join(', '));
  } catch (err) {
    console.error('Migration failed:', err.message);
    throw err;
  } finally {
    await conn.end();
  }
}

migrate().catch(() => process.exit(1));
