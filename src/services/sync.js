/**
 * GUNZ Node Tracker — Sync Service
 *
 * Fetches all 10,000 validator nodes from the public GUNZ API
 * in a single call and upserts them into MySQL.
 *
 * Runs every 2 minutes via cron, or once via: node src/services/sync.js --once
 */

const { query, getClient } = require('../db/pool');
const { flush } = require('./cache');
const nodeIndex = require('./nodeIndex');

const API_BASE = process.env.GUNZ_API_BASE || 'https://api.gunzchain.app/api/v1';
const PAGE_SIZE = parseInt(process.env.GUNZ_API_PAGE_SIZE) || 10000;

// Rarity → static fields mapping
const RARITY_MAP = {
  'Common':    { hashpower: 40,    resale_rate: 0.01 },
  'Rare':      { hashpower: 120,   resale_rate: 0.02 },
  'Epic':      { hashpower: 600,   resale_rate: 0.03 },
  'Legendary': { hashpower: 3000,  resale_rate: 0.04 },
  'Ancient':   { hashpower: 20000, resale_rate: 0.05 },
};

/**
 * Fetch all nodes from the GUNZ API (single call)
 */
async function fetchAllNodes() {
  const url = `${API_BASE}/licenses?offset=0&page_size=${PAGE_SIZE}&period=month`;
  const resp = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(30000), // 30s timeout
  });

  if (!resp.ok) {
    throw new Error(`GUNZ API returned ${resp.status}: ${resp.statusText}`);
  }

  const data = await resp.json();
  return data.licenses || [];
}

/**
 * Fetch global stats (hexes, hashpower, distribution, activity)
 */
async function fetchGlobalStats() {
  const [hexesResp, hashpowerResp, distributionResp, activityResp] = await Promise.all([
    fetch(`${API_BASE}/hexes?period=month`, { signal: AbortSignal.timeout(10000) }),
    fetch(`${API_BASE}/licenses/hashpower?period=month`, { signal: AbortSignal.timeout(10000) }),
    fetch(`${API_BASE}/licenses/distribution?period=month`, { signal: AbortSignal.timeout(10000) }),
    fetch(`${API_BASE}/licenses/activity`, { signal: AbortSignal.timeout(10000) }),
  ]);

  return {
    hexes: hexesResp.ok ? await hexesResp.json() : null,
    hashpower: hashpowerResp.ok ? await hashpowerResp.json() : null,
    distribution: distributionResp.ok ? await distributionResp.json() : null,
    activity: activityResp.ok ? await activityResp.json() : null,
  };
}

/**
 * Upsert all nodes into the database
 */
async function upsertNodes(nodes) {
  const client = await getClient();
  let changed = 0;

  try {
    await client.query('BEGIN');

    for (const node of nodes) {
      const rarity = RARITY_MAP[node.rarity] || RARITY_MAP['Common'];

      const result = await client.query(`
        INSERT INTO nodes (
          id, rarity, activity, activity_period_pct, total_hashpower_pct,
          wallet_address, hexes_decoded, hex_distribution_rate,
          hashpower, resale_rate, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          prev_hexes_decoded = hexes_decoded,
          prev_activity = activity,
          activity = VALUES(activity),
          activity_period_pct = VALUES(activity_period_pct),
          total_hashpower_pct = VALUES(total_hashpower_pct),
          wallet_address = VALUES(wallet_address),
          hexes_decoded = VALUES(hexes_decoded),
          hex_distribution_rate = VALUES(hex_distribution_rate),
          updated_at = NOW()
      `, [
        node.id,
        node.rarity,
        node.activity === 'Hold' ? 'Inactive' : node.activity,
        node.activityPeriodPercent || 0,
        node.totalHashpowerPercent || 0,
        node.hackerWalletAddress,
        node.hexesDecoded || 0,
        node.hexesDistributionRate || 0,
        rarity.hashpower,
        rarity.resale_rate,
      ]);

      // MySQL affectedRows: 1 = insert, 2 = update with changes, 0 = no change
      if (result.affectedRows > 0) {
        changed++;
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return changed;
}

/**
 * Save global stats for today
 */
async function saveGlobalStats(stats) {
  const today = new Date().toISOString().split('T')[0];

  // Get today's values
  const todayHexes = stats.hexes?.[today] || 0;
  const todayHashpower = stats.hashpower?.[today] || 0;

  await query(`
    INSERT INTO global_stats (stat_date, total_hexes, total_hashpower, distribution, activity_breakdown)
    VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      total_hexes = VALUES(total_hexes),
      total_hashpower = VALUES(total_hashpower),
      distribution = VALUES(distribution),
      activity_breakdown = VALUES(activity_breakdown)
  `, [
    today,
    todayHexes,
    todayHashpower,
    JSON.stringify(stats.distribution),
    JSON.stringify(stats.activity),
  ]);
}

/**
 * Take daily snapshot (run once per day, idempotent)
 */
async function takeDailySnapshot() {
  const today = new Date().toISOString().split('T')[0];

  await query(`
    INSERT INTO node_snapshots (node_id, snapshot_date, hexes_decoded, hex_distribution_rate, activity, activity_period_pct)
    SELECT id, ?, hexes_decoded, hex_distribution_rate, activity, activity_period_pct
    FROM nodes
    ON DUPLICATE KEY UPDATE
      hexes_decoded = VALUES(hexes_decoded),
      hex_distribution_rate = VALUES(hex_distribution_rate),
      activity = VALUES(activity),
      activity_period_pct = VALUES(activity_period_pct)
  `, [today]);
}

/**
 * Main sync function
 */
async function syncAll() {
  const start = Date.now();
  let nodesCount = 0;
  let changedCount = 0;
  let error = null;

  try {
    console.log(`\n[${new Date().toISOString()}] Starting sync...`);

    // 1. Fetch all nodes
    console.log('  Fetching 10,000 nodes from GUNZ API...');
    const nodes = await fetchAllNodes();
    nodesCount = nodes.length;
    console.log(`  Received ${nodesCount} nodes`);

    // 2. Upsert to database
    console.log('  Upserting to database...');
    changedCount = await upsertNodes(nodes);
    console.log(`  ${changedCount} nodes changed`);

    // 3. Fetch and save global stats
    console.log('  Fetching global stats...');
    const stats = await fetchGlobalStats();
    await saveGlobalStats(stats);
    console.log('  Global stats saved');

    // 4. Daily snapshot (idempotent)
    await takeDailySnapshot();

    // 5. Build in-memory index for O(1) lookups
    const indexNodes = nodes.map(n => {
      const rm = RARITY_MAP[n.rarity] || RARITY_MAP['Common'];
      return {
        id: String(n.id),
        rarity: n.rarity,
        activity: n.activity === 'Hold' ? 'Inactive' : n.activity,
        activityPeriodPercent: n.activityPeriodPercent || 0,
        totalHashpowerPercent: n.totalHashpowerPercent || 0,
        hackerWalletAddress: n.hackerWalletAddress,
        hexesDecoded: n.hexesDecoded || 0,
        hexesDistributionRate: n.hexesDistributionRate || 0,
        hashpower: rm.hashpower,
        resaleRate: rm.resale_rate,
      };
    });
    nodeIndex.build(indexNodes);

    // 6. Flush cache so next API request gets fresh data
    await flush();
    console.log('  Cache flushed');

  } catch (err) {
    error = err.message;
    console.error(`  Sync error: ${err.message}`);
  }

  const duration = Date.now() - start;

  // Log sync result
  try {
    await query(`
      INSERT INTO sync_log (sync_type, nodes_synced, nodes_changed, duration_ms, error)
      VALUES ('full', ?, ?, ?, ?)
    `, [nodesCount, changedCount, duration, error]);
  } catch {
    // Don't fail sync if logging fails
  }

  console.log(`  Sync completed in ${duration}ms (${nodesCount} nodes, ${changedCount} changed)\n`);
  return { nodesCount, changedCount, duration, error };
}

// Run once if called directly: node src/services/sync.js --once
if (require.main === module) {
  require('dotenv').config();
  syncAll().then(() => process.exit(0)).catch(() => process.exit(1));
}

module.exports = { syncAll, fetchAllNodes, fetchGlobalStats };
