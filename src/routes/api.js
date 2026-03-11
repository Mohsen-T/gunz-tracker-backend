/**
 * GUNZ Node Tracker — API Routes
 *
 * All endpoints are public (no auth required).
 */

const { Router } = require('express');
const { query } = require('../db/pool');
const cache = require('../services/cache');
const nodeIndex = require('../services/nodeIndex');

const GUNZ_API = process.env.GUNZ_API_BASE || 'https://api.gunzchain.app/api/v1';
const GUNZSCAN_API = 'https://gunzscan.io/api/v2';
const GUNZSCAN_ETHERSCAN_API = 'https://gunzscan.io/api';
const HL_CONTRACT = '0xc386fc39680D76Bc8F6Eba12513CF572910BB919';
const GI_CONTRACT = '0x9ED98e159BE43a8d42b64053831FCAE5e4d7d271';
const DECODER_CONTRACT = '0x1c695462A43103116C2d806f1895a17D270B270A';

// Approximate blocks per second on GUNZ chain (~2s block time)
const BLOCKS_PER_DAY = Math.round((24 * 60 * 60) / 2);

// Cache the current block number for 60s to avoid repeated lookups
let _cachedBlock = { value: null, ts: 0 };
async function getCurrentBlock() {
  if (_cachedBlock.value && Date.now() - _cachedBlock.ts < 60000) return _cachedBlock.value;
  const ts = Math.floor(Date.now() / 1000);
  try {
    const resp = await fetch(
      `${GUNZSCAN_ETHERSCAN_API}?module=block&action=getblocknobytime&timestamp=${ts}&closest=before`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!resp.ok) return _cachedBlock.value;
    const data = await resp.json();
    // Etherscan API returns result as plain string "12345" or object {blockNumber: "12345"}
    const raw = data.result;
    const block = parseInt(typeof raw === 'object' ? raw?.blockNumber : raw) || null;
    if (block) {
      _cachedBlock = { value: block, ts: Date.now() };
      console.log(`[getCurrentBlock] block=${block}`);
    } else {
      console.warn(`[getCurrentBlock] failed to parse block from:`, raw);
    }
    return block || _cachedBlock.value;
  } catch (err) {
    console.error(`[getCurrentBlock] error:`, err.message);
    return _cachedBlock.value;
  }
}

// Helper: fetch Decoded event logs for a license, with block range for recent data
// Blockscout returns max 1000 logs per request, so we paginate via fromBlock
async function fetchDecodedEvents(licenseId, days = 30) {
  const paddedId = '0x' + parseInt(licenseId).toString(16).padStart(64, '0');

  // Calculate fromBlock based on period (with 20% buffer for block time variance)
  const currentBlock = await getCurrentBlock();
  const fromBlock = currentBlock
    ? Math.max(0, currentBlock - Math.round(BLOCKS_PER_DAY * days * 1.2))
    : 0;

  // Max pages scales with period: 3 for week, 5 for month, 10 for quarter
  const maxPages = days <= 7 ? 3 : days <= 30 ? 5 : 10;

  // Fetch logs in pages (max 1000 per request)
  let allLogs = [];
  let startBlock = fromBlock;

  for (let page = 0; page < maxPages; page++) {
    const url = `${GUNZSCAN_ETHERSCAN_API}?module=logs&action=getLogs` +
      `&address=${DECODER_CONTRACT}` +
      `&topic1=${paddedId}&topic0_1_opr=and` +
      `&fromBlock=${startBlock}&toBlock=latest`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) break;
    const data = await resp.json();
    const logs = data.result || [];
    if (!logs.length) break;
    allLogs = allLogs.concat(logs);
    if (logs.length < 1000) break;
    // Next page starts after the last block
    startBlock = parseInt(logs[logs.length - 1].blockNumber, 16) + 1;
  }

  return allLogs;
}

// Helper: parse Decoded event log into structured data
function parseDecodedEvent(log) {
  const timestamp = parseInt(log.timeStamp, 16) * 1000;
  const date = new Date(timestamp);
  const dateStr = date.toISOString().slice(0, 10);
  // data: HEXBackendTokenId (32b) | hackerFeeFromUser (32b) | platformFee (32b) | hackerFeeFromHackerLicense (32b)
  const d = log.data.slice(2); // remove 0x
  const hackerFee = BigInt('0x' + d.slice(64, 128));
  const platformFee = BigInt('0x' + d.slice(128, 192));
  const licenseFee = BigInt('0x' + d.slice(192, 256));
  // Convert from wei (18 decimals) to GUN
  const totalFeeGun = Number(hackerFee + platformFee + licenseFee) / 1e18;
  const earningsGun = Number(licenseFee) / 1e18;
  return { timestamp, date: dateStr, totalFee: totalFeeGun, earnings: earningsGun };
}

const router = Router();

// =============================================
// GET /api/nodes — All 10,000 nodes (bubble map data)
// =============================================
router.get('/nodes', async (req, res) => {
  try {
    // Use in-memory index if available (O(1), no DB query)
    if (nodeIndex.isReady()) {
      const nodes = nodeIndex.getAll();
      return res.json({
        nodes,
        total: nodes.length,
        updatedAt: new Date().toISOString(),
      });
    }

    // Fallback to DB + cache
    const cached = await cache.get('all-nodes');
    if (cached) return res.json(cached);

    const result = await query(`
      SELECT
        id, rarity, activity,
        activity_period_pct AS "activityPeriodPercent",
        total_hashpower_pct AS "totalHashpowerPercent",
        wallet_address AS "hackerWalletAddress",
        hexes_decoded AS "hexesDecoded",
        hex_distribution_rate AS "hexesDistributionRate",
        hashpower,
        resale_rate AS "resaleRate",
        (hexes_decoded - prev_hexes_decoded) AS "hexesDelta",
        CASE WHEN prev_activity != activity THEN true ELSE false END AS "statusChanged",
        updated_at AS "updatedAt"
      FROM nodes
      ORDER BY hexes_decoded DESC
    `);

    const response = {
      nodes: result.rows,
      total: result.rows.length,
      updatedAt: result.rows[0]?.updatedAt || new Date().toISOString(),
    };

    await cache.set('all-nodes', response, 60);
    res.json(response);
  } catch (err) {
    console.error('GET /api/nodes error:', err.message);
    res.status(500).json({ error: 'Failed to fetch nodes' });
  }
});

// =============================================
// GET /api/nodes/:id — Single node detail
// =============================================
router.get('/nodes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const cacheKey = `node-${id}`;
    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    // Node data
    const nodeResult = await query(`
      SELECT
        id, rarity, activity,
        activity_period_pct AS "activityPeriodPercent",
        total_hashpower_pct AS "totalHashpowerPercent",
        wallet_address AS "hackerWalletAddress",
        hexes_decoded AS "hexesDecoded",
        hex_distribution_rate AS "hexesDistributionRate",
        hashpower,
        resale_rate AS "resaleRate",
        first_seen_at AS "firstSeenAt",
        updated_at AS "updatedAt"
      FROM nodes WHERE id = ?
    `, [id]);

    if (nodeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Node not found' });
    }

    // Historical snapshots (last 30 days)
    const snapshotsResult = await query(`
      SELECT
        snapshot_date AS "date",
        hexes_decoded AS "hexesDecoded",
        hex_distribution_rate AS "hexDistRate",
        activity,
        activity_period_pct AS "activityPct"
      FROM node_snapshots
      WHERE node_id = ?
      ORDER BY snapshot_date DESC
      LIMIT 30
    `, [id]);

    // Rank among all nodes
    const rankResult = await query(`
      SELECT COUNT(*) + 1 AS \`rank\`
      FROM nodes
      WHERE hexes_decoded > (SELECT hexes_decoded FROM nodes WHERE id = ?)
    `, [id]);

    const response = {
      ...nodeResult.rows[0],
      rank: parseInt(rankResult.rows[0]?.rank) || 0,
      history: snapshotsResult.rows.reverse(),
    };

    await cache.set(cacheKey, response, 60);
    res.json(response);
  } catch (err) {
    console.error(`GET /api/nodes/${req.params.id} error:`, err.message);
    res.status(500).json({ error: 'Failed to fetch node' });
  }
});

// =============================================
// GET /api/nodes/:id/earnings — Node GUN earnings from on-chain Decoded events
// =============================================
router.get('/nodes/:id/earnings', async (req, res) => {
  try {
    const { id } = req.params;
    const period = req.query.period || 'month';
    const cacheKey = `earnings-onchain-${id}-${period}`;
    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    const periodDays = { week: 7, month: 30, quarter: 90 };
    const days = periodDays[period] || 30;
    const logs = await fetchDecodedEvents(id, days);
    if (!logs.length) return res.json([]);

    const events = logs.map(parseDecodedEvent);

    // Filter by period (in case block range returned slightly more)
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const filtered = events.filter(e => e.timestamp >= cutoff);

    // Aggregate by day
    const dailyMap = {};
    for (const e of filtered) {
      if (!dailyMap[e.date]) dailyMap[e.date] = 0;
      dailyMap[e.date] += e.earnings;
    }

    // Convert to sorted array [{date, value}]
    const data = Object.entries(dailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, value]) => ({ date, value: Math.round(value * 1000) / 1000 }));

    await cache.set(cacheKey, data, 300);
    res.json(data);
  } catch (err) {
    console.error(`GET /api/nodes/${req.params.id}/earnings error:`, err.message);
    res.status(500).json({ error: 'Failed to fetch earnings' });
  }
});

// =============================================
// GET /api/nodes/:id/decoded-items — Decoded items count from on-chain events
// =============================================
router.get('/nodes/:id/decoded-items', async (req, res) => {
  try {
    const { id } = req.params;
    const period = req.query.period || 'month';
    const cacheKey = `decoded-onchain-${id}-${period}`;
    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    const periodDays = { week: 7, month: 30, quarter: 90 };
    const days = periodDays[period] || 30;
    const logs = await fetchDecodedEvents(id, days);
    if (!logs.length) return res.json([]);

    const events = logs.map(parseDecodedEvent);

    // Filter by period (in case block range returned slightly more)
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const filtered = events.filter(e => e.timestamp >= cutoff);

    // Aggregate decode count by day
    const dailyMap = {};
    for (const e of filtered) {
      if (!dailyMap[e.date]) dailyMap[e.date] = 0;
      dailyMap[e.date] += 1;
    }

    // Convert to sorted array [{date, value}]
    const data = Object.entries(dailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, value]) => ({ date, value }));

    await cache.set(cacheKey, data, 300);
    res.json(data);
  } catch (err) {
    console.error(`GET /api/nodes/${req.params.id}/decoded-items error:`, err.message);
    res.status(500).json({ error: 'Failed to fetch decoded items' });
  }
});

// =============================================
// GET /api/nodes/:id/items — Actual NFT items decoded by this node
// =============================================
router.get('/nodes/:id/items', async (req, res) => {
  try {
    const { id } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;
    const cacheKey = `items-${id}-${limit}-${offset}`;
    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    const resp = await fetch(
      `${GUNZ_API}/hacker/items?license_id=${id}&offset=${offset}&page_size=${limit}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!resp.ok) return res.status(resp.status).json({ error: 'Upstream error' });
    const data = await resp.json();

    await cache.set(cacheKey, data, 120);
    res.json(data);
  } catch (err) {
    console.error(`GET /api/nodes/${req.params.id}/items error:`, err.message);
    res.status(500).json({ error: 'Failed to fetch items' });
  }
});

// =============================================
// GET /api/nodes/:id/info — Detailed license info from GUNZ API
// =============================================
router.get('/nodes/:id/info', async (req, res) => {
  try {
    const { id } = req.params;
    const cacheKey = `license-info-${id}`;
    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    const resp = await fetch(
      `${GUNZ_API}/license/info?license=${id}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!resp.ok) return res.status(resp.status).json({ error: 'Upstream error' });
    const data = await resp.json();

    await cache.set(cacheKey, data, 120);
    res.json(data);
  } catch (err) {
    console.error(`GET /api/nodes/${req.params.id}/info error:`, err.message);
    res.status(500).json({ error: 'Failed to fetch license info' });
  }
});

// =============================================
// GET /api/nodes/:id/game-items — Items decoded by this license (from on-chain events)
// Traces: Decoded events → transaction token transfers → Game Item metadata
// =============================================
router.get('/nodes/:id/game-items', async (req, res) => {
  try {
    const { id } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 20, 40);
    const cacheKey = `game-items-v2-${id}-${limit}`;
    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    // 1. Get recent Decoded events for this license (last 90 days, most recent first)
    const logs = await fetchDecodedEvents(id, 90);
    if (!logs.length) return res.json({ items: [], total: 0 });

    // Take the most recent N events (logs are sorted ascending by block, reverse for most recent)
    const recentLogs = logs.slice(-limit).reverse();
    const txHashes = recentLogs.map(l => l.transactionHash);

    // 2. Fetch token transfers from each transaction in parallel batches
    const BATCH_SIZE = 5;
    const items = [];
    for (let i = 0; i < txHashes.length; i += BATCH_SIZE) {
      const batch = txHashes.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (txHash) => {
          const resp = await fetch(
            `${GUNZSCAN_API}/transactions/${txHash}/token-transfers`,
            { signal: AbortSignal.timeout(10000) }
          );
          if (!resp.ok) return null;
          const data = await resp.json();
          // Find the Game Item mint (from 0x0000, token = GI contract)
          const mint = (data.items || []).find(t =>
            t.from?.hash === '0x0000000000000000000000000000000000000000' &&
            t.token?.address_hash?.toLowerCase() === GI_CONTRACT.toLowerCase()
          );
          if (!mint) return null;
          const inst = mint.total?.token_instance;
          const meta = inst?.metadata || {};
          const attrs = meta.attributes || [];
          const getAttr = (type) => attrs.find(a => a.trait_type === type)?.value || null;
          return {
            id: mint.total?.token_id || inst?.id,
            name: meta.name || 'Unknown Item',
            image: meta.image || inst?.image_url || null,
            rarity: getAttr('Rarity') || 'Uncommon',
            class: getAttr('Class') || 'Unknown',
            itemType: getAttr('Item Type') || null,
            owner: mint.to?.hash || null,
          };
        })
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) items.push(r.value);
      }
    }

    const response = { items, total: logs.length };
    await cache.set(cacheKey, response, 600); // cache 10 min
    res.json(response);
  } catch (err) {
    console.error(`GET /api/nodes/${req.params.id}/game-items error:`, err.message);
    res.status(500).json({ error: 'Failed to fetch game items' });
  }
});

// =============================================
// GET /api/stats — Global ecosystem stats
// =============================================
router.get('/stats', async (req, res) => {
  try {
    const cached = await cache.get('global-stats');
    if (cached) return res.json(cached);

    // Activity breakdown
    const activityResult = await query(`
      SELECT rarity, activity, COUNT(*) AS count
      FROM nodes
      GROUP BY rarity, activity
      ORDER BY rarity, activity
    `);

    // Build activity map
    const activity = {};
    for (const row of activityResult.rows) {
      if (!activity[row.rarity]) activity[row.rarity] = {};
      activity[row.rarity][row.activity] = parseInt(row.count);
    }

    // Totals — MySQL doesn't support FILTER, use SUM(CASE WHEN ...) instead
    const totalsResult = await query(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN activity = 'Active' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN activity != 'Active' THEN 1 ELSE 0 END) AS inactive,
        SUM(hexes_decoded) AS total_hexes,
        SUM(CASE WHEN activity = 'Active' THEN hashpower ELSE 0 END) AS active_hashpower
      FROM nodes
    `);

    // Last 30 days global stats
    const dailyResult = await query(`
      SELECT stat_date, total_hexes, total_hashpower, distribution, activity_breakdown
      FROM global_stats
      ORDER BY stat_date DESC
      LIMIT 30
    `);

    // Top movers (most hexes gained since last sync)
    const moversResult = await query(`
      SELECT id, rarity, hexes_decoded AS "hexesDecoded",
        (hexes_decoded - prev_hexes_decoded) AS delta
      FROM nodes
      WHERE hexes_decoded > prev_hexes_decoded
      ORDER BY (hexes_decoded - prev_hexes_decoded) DESC
      LIMIT 20
    `);

    const totals = totalsResult.rows[0];
    const response = {
      totals: {
        total: parseInt(totals.total),
        active: parseInt(totals.active),
        inactive: parseInt(totals.inactive),
        totalHexes: parseInt(totals.total_hexes) || 0,
        activeHashpower: parseInt(totals.active_hashpower) || 0,
      },
      activity,
      daily: dailyResult.rows.reverse(),
      topMovers: moversResult.rows,
    };

    await cache.set('global-stats', response, 60);
    res.json(response);
  } catch (err) {
    console.error('GET /api/stats error:', err.message);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// =============================================
// GET /api/leaderboard — Top nodes
// =============================================
router.get('/leaderboard', async (req, res) => {
  try {
    const { rarity, status, limit = 100, offset = 0 } = req.query;
    const cacheKey = `lb-${rarity || 'all'}-${status || 'all'}-${limit}-${offset}`;
    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    let where = [];
    let params = [];

    if (rarity) {
      where.push(`rarity = ?`);
      params.push(rarity);
    }
    if (status) {
      where.push(`activity = ?`);
      params.push(status);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const result = await query(`
      SELECT
        id, rarity, activity,
        hexes_decoded AS "hexesDecoded",
        hex_distribution_rate AS "hexesDistributionRate",
        total_hashpower_pct AS "totalHashpowerPercent",
        hashpower,
        wallet_address AS "hackerWalletAddress",
        (hexes_decoded - prev_hexes_decoded) AS "hexesDelta"
      FROM nodes
      ${whereClause}
      ORDER BY hexes_decoded DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), parseInt(offset)]);

    const countResult = await query(
      `SELECT COUNT(*) AS count FROM nodes ${whereClause}`,
      params
    );

    const response = {
      nodes: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset),
    };

    await cache.set(cacheKey, response, 60);
    res.json(response);
  } catch (err) {
    console.error('GET /api/leaderboard error:', err.message);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// =============================================
// GET /api/hexes — Daily HEX decode data (proxied from GUNZ API)
// =============================================
router.get('/hexes', async (req, res) => {
  try {
    const cached = await cache.get('hexes-daily');
    if (cached) return res.json(cached);

    const period = req.query.period || 'month';
    const resp = await fetch(
      `${GUNZ_API}/hexes?period=${period}`,
      { signal: AbortSignal.timeout(10000) }
    );
    const data = await resp.json();

    await cache.set('hexes-daily', data, 120);
    res.json(data);
  } catch (err) {
    console.error('GET /api/hexes error:', err.message);
    res.status(500).json({ error: 'Failed to fetch hexes data' });
  }
});

// =============================================
// GET /api/distribution — Earnings distribution by rarity
// =============================================
router.get('/distribution', async (req, res) => {
  try {
    const cached = await cache.get('distribution-daily');
    if (cached) return res.json(cached);

    const period = req.query.period || 'month';
    const resp = await fetch(
      `${GUNZ_API}/licenses/distribution?period=${period}`,
      { signal: AbortSignal.timeout(10000) }
    );
    const data = await resp.json();

    await cache.set('distribution-daily', data, 120);
    res.json(data);
  } catch (err) {
    console.error('GET /api/distribution error:', err.message);
    res.status(500).json({ error: 'Failed to fetch distribution data' });
  }
});

// =============================================
// GET /api/hashpower — Hashpower trend
// =============================================
router.get('/hashpower', async (req, res) => {
  try {
    const cached = await cache.get('hashpower-daily');
    if (cached) return res.json(cached);

    const period = req.query.period || 'month';
    const resp = await fetch(
      `${GUNZ_API}/licenses/hashpower?period=${period}`,
      { signal: AbortSignal.timeout(10000) }
    );
    const data = await resp.json();

    await cache.set('hashpower-daily', data, 120);
    res.json(data);
  } catch (err) {
    console.error('GET /api/hashpower error:', err.message);
    res.status(500).json({ error: 'Failed to fetch hashpower data' });
  }
});

// =============================================
// GET /api/search?q=123 — Search nodes by ID or wallet
// =============================================
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 1) return res.json({ nodes: [] });

    // Use in-memory index — fast prefix search on 10k nodes
    if (nodeIndex.isReady()) {
      const results = nodeIndex.search(q, 50);
      return res.json({ nodes: results });
    }

    // Fallback to DB
    let result;
    if (q.startsWith('0x')) {
      result = await query(`
        SELECT id, rarity, activity, hexes_decoded AS "hexesDecoded",
          wallet_address AS "hackerWalletAddress", hashpower
        FROM nodes
        WHERE LOWER(wallet_address) LIKE LOWER(?)
        ORDER BY hexes_decoded DESC
        LIMIT 50
      `, [`${q}%`]);
    } else {
      result = await query(`
        SELECT id, rarity, activity, hexes_decoded AS "hexesDecoded",
          wallet_address AS "hackerWalletAddress", hashpower
        FROM nodes
        WHERE id LIKE ?
        ORDER BY hexes_decoded DESC
        LIMIT 50
      `, [`${q}%`]);
    }

    res.json({ nodes: result.rows });
  } catch (err) {
    console.error('GET /api/search error:', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// =============================================
// GET /api/wallet/:address — All nodes owned by wallet
// =============================================
router.get('/wallet/:address', async (req, res) => {
  try {
    const { address } = req.params;

    // Use in-memory index — O(1) lookup, no DB query
    if (nodeIndex.isReady()) {
      const nodes = nodeIndex.getByWallet(address);
      const stats = nodeIndex.getOwnerStats(address);
      return res.json({
        address: address.toLowerCase(),
        nodeCount: nodes.length,
        nodes,
        totalHexes: stats?.totalHexes || 0,
        totalHashpower: stats?.totalHP || 0,
        activeCount: stats?.active || 0,
        rarities: stats?.rarities || {},
      });
    }

    // Fallback to DB
    const cacheKey = `wallet-${address.toLowerCase()}`;
    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    const result = await query(`
      SELECT
        id, rarity, activity,
        hexes_decoded AS "hexesDecoded",
        hex_distribution_rate AS "hexesDistributionRate",
        hashpower,
        activity_period_pct AS "activityPeriodPercent"
      FROM nodes
      WHERE LOWER(wallet_address) = LOWER(?)
      ORDER BY hexes_decoded DESC
    `, [address]);

    const response = {
      address: address.toLowerCase(),
      nodeCount: result.rows.length,
      nodes: result.rows,
      totalHexes: result.rows.reduce((s, n) => s + parseInt(n.hexesDecoded), 0),
    };

    await cache.set(cacheKey, response, 60);
    res.json(response);
  } catch (err) {
    console.error(`GET /api/wallet/${req.params.address} error:`, err.message);
    res.status(500).json({ error: 'Failed to fetch wallet data' });
  }
});

// =============================================
// GET /api/owners — All wallet owners with aggregated stats
// =============================================
router.get('/owners', async (req, res) => {
  try {
    if (!nodeIndex.isReady()) {
      return res.status(503).json({ error: 'Index not ready' });
    }

    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const offset = parseInt(req.query.offset) || 0;
    const owners = nodeIndex.getAllOwners();

    res.json({
      owners: owners.slice(offset, offset + limit),
      total: owners.length,
      limit,
      offset,
    });
  } catch (err) {
    console.error('GET /api/owners error:', err.message);
    res.status(500).json({ error: 'Failed to fetch owners' });
  }
});

// =============================================
// GET /api/health — Health check
// =============================================
router.get('/health', async (req, res) => {
  try {
    const dbCheck = await query('SELECT COUNT(*) AS count FROM nodes');
    const lastSync = await query('SELECT synced_at, duration_ms, error FROM sync_log ORDER BY synced_at DESC LIMIT 1');

    res.json({
      status: 'ok',
      nodesInDb: parseInt(dbCheck.rows[0].count),
      lastSync: lastSync.rows[0] || null,
      index: nodeIndex.getInfo(),
      uptime: process.uptime(),
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

module.exports = router;
