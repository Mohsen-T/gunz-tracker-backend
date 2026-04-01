/**
 * GUNZ Marketplace — Database Migration (MySQL)
 * Creates marketplace tables for listings, sales, and offers.
 *
 * Run: node src/db/migrate-marketplace.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

const STATEMENTS = [
  // Active & historical marketplace listings
  `CREATE TABLE IF NOT EXISTS marketplace_listings (
    id                INT AUTO_INCREMENT PRIMARY KEY,
    listing_id        INT UNSIGNED NOT NULL UNIQUE,
    nft_contract      VARCHAR(42) NOT NULL,
    token_id          VARCHAR(10) NOT NULL,
    seller            VARCHAR(42) NOT NULL,
    price             DECIMAL(36,18) NOT NULL DEFAULT 0,
    status            ENUM('Active','Sold','Cancelled') NOT NULL DEFAULT 'Active',
    buyer             VARCHAR(42),
    created_at        TIMESTAMP NOT NULL,
    sold_at           TIMESTAMP NULL,
    tx_hash           VARCHAR(66),
    block_number      BIGINT UNSIGNED DEFAULT 0,

    -- Node snapshot at listing time (for display)
    rarity            VARCHAR(20),
    hashpower         INTEGER DEFAULT 0,
    hexes_decoded     INTEGER DEFAULT 0,

    INDEX idx_ml_status (status),
    INDEX idx_ml_contract (nft_contract),
    INDEX idx_ml_token (nft_contract, token_id),
    INDEX idx_ml_seller (seller),
    INDEX idx_ml_price (price),
    INDEX idx_ml_created (created_at DESC),
    INDEX idx_ml_rarity (rarity)
  )`,

  // Offers (bids) on listings
  `CREATE TABLE IF NOT EXISTS marketplace_offers (
    id                INT AUTO_INCREMENT PRIMARY KEY,
    offer_id          INT UNSIGNED NOT NULL UNIQUE,
    listing_id        INT UNSIGNED NOT NULL,
    bidder            VARCHAR(42) NOT NULL,
    amount            DECIMAL(36,18) NOT NULL DEFAULT 0,
    accepted          BOOLEAN NOT NULL DEFAULT FALSE,
    withdrawn         BOOLEAN NOT NULL DEFAULT FALSE,
    created_at        TIMESTAMP NOT NULL,
    tx_hash           VARCHAR(66),
    block_number      BIGINT UNSIGNED DEFAULT 0,

    INDEX idx_mo_listing (listing_id),
    INDEX idx_mo_bidder (bidder),
    INDEX idx_mo_created (created_at DESC)
  )`,

  // Completed sales (denormalized for fast stats/history)
  `CREATE TABLE IF NOT EXISTS marketplace_sales (
    id                INT AUTO_INCREMENT PRIMARY KEY,
    listing_id        INT UNSIGNED NOT NULL,
    nft_contract      VARCHAR(42) NOT NULL,
    token_id          VARCHAR(10) NOT NULL,
    seller            VARCHAR(42) NOT NULL,
    buyer             VARCHAR(42) NOT NULL,
    price             DECIMAL(36,18) NOT NULL,
    fee               DECIMAL(36,18) NOT NULL DEFAULT 0,
    sold_at           TIMESTAMP NOT NULL,
    tx_hash           VARCHAR(66),
    block_number      BIGINT UNSIGNED DEFAULT 0,

    INDEX idx_ms_token (nft_contract, token_id),
    INDEX idx_ms_seller (seller),
    INDEX idx_ms_buyer (buyer),
    INDEX idx_ms_sold (sold_at DESC),
    INDEX idx_ms_price (price)
  )`,

  // Marketplace-level stats (daily aggregates)
  `CREATE TABLE IF NOT EXISTS marketplace_stats (
    stat_date         DATE PRIMARY KEY,
    total_volume      DECIMAL(36,18) DEFAULT 0,
    total_sales       INTEGER DEFAULT 0,
    total_listings    INTEGER DEFAULT 0,
    avg_price         DECIMAL(36,18) DEFAULT 0,
    floor_price       DECIMAL(36,18) DEFAULT 0,
    created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,

  // Track sync cursor for marketplace event indexing
  `CREATE TABLE IF NOT EXISTS marketplace_sync_cursor (
    id                INT PRIMARY KEY DEFAULT 1,
    last_block        BIGINT UNSIGNED DEFAULT 0,
    updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
];

async function migrate() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);
  try {
    console.log('Running GUNZ Marketplace migration...');
    for (const sql of STATEMENTS) {
      await conn.execute(sql);
    }
    console.log('Marketplace migration complete — all tables created');

    const [rows] = await conn.execute(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name LIKE 'marketplace%'
       ORDER BY table_name`
    );
    console.log('Marketplace tables:', rows.map(r => r.TABLE_NAME).join(', '));
  } catch (err) {
    console.error('Migration failed:', err.message);
    throw err;
  } finally {
    await conn.end();
  }
}

migrate().catch(() => process.exit(1));
