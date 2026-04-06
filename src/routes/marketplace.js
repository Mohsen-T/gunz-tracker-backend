/**
 * GUNZ Marketplace — API Routes
 *
 * Serves marketplace listings, sales history, stats, and offers.
 */

const { Router } = require('express');
const { query } = require('../db/pool');
const cache = require('../services/cache');

const HL_CONTRACT = '0xc386fc39680D76Bc8F6Eba12513CF572910BB919';
const GI_CONTRACT = '0x9ED98e159BE43a8d42b64053831FCAE5e4d7d271';

const router = Router();

// Sanitize integer for safe inline usage in SQL (LIMIT/OFFSET)
const safeInt = (val, fallback = 0) => {
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

// =============================================
// GET /api/marketplace/listings — Browse active listings
// =============================================
router.get('/listings', async (req, res) => {
  try {
    const {
      rarity,
      status = 'Active',
      sort = 'newest',
      minPrice,
      maxPrice,
      tokenId,
      contract,
      seller,
      limit = 24,
      offset = 0,
    } = req.query;

    const cacheKey = `mp-listings-${rarity || 'all'}-${status}-${sort}-${minPrice || 0}-${maxPrice || 'max'}-${tokenId || 'all'}-${contract || 'all'}-${seller || 'all'}-${limit}-${offset}`;
    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    const where = [];
    const params = [];

    if (status) {
      where.push('ml.status = ?');
      params.push(String(status));
    }
    // Multi-rarity: "Epic,Legendary" → IN clause
    if (rarity) {
      const rarities = String(rarity).split(',').map(r => r.trim()).filter(Boolean);
      if (rarities.length === 1) {
        where.push('ml.rarity = ?');
        params.push(rarities[0]);
      } else if (rarities.length > 1) {
        const placeholders = rarities.map(() => '?').join(',');
        where.push(`ml.rarity IN (${placeholders})`);
        params.push(...rarities);
      }
    }
    // Token ID prefix search
    if (tokenId) {
      const id = String(tokenId).replace(/\D/g, '');
      if (id) {
        where.push('ml.token_id LIKE ?');
        params.push(`${id}%`);
      }
    }
    if (minPrice) {
      where.push('ml.price >= ?');
      params.push(String(parseFloat(minPrice)));
    }
    if (maxPrice) {
      where.push('ml.price <= ?');
      params.push(String(parseFloat(maxPrice)));
    }
    if (contract) {
      where.push('ml.nft_contract = ?');
      params.push(String(contract));
    }
    if (seller) {
      where.push('LOWER(ml.seller) = LOWER(?)');
      params.push(String(seller));
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const orderMap = {
      newest: 'ml.created_at DESC',
      oldest: 'ml.created_at ASC',
      price_asc: 'ml.price ASC',
      price_desc: 'ml.price DESC',
      hp_desc: 'ml.hashpower DESC',
      hexes_desc: 'ml.hexes_decoded DESC',
      id_asc: 'CAST(ml.token_id AS UNSIGNED) ASC',
      id_desc: 'CAST(ml.token_id AS UNSIGNED) DESC',
    };
    const orderBy = orderMap[sort] || 'ml.created_at DESC';

    const lim = Math.min(safeInt(limit, 24), 100);
    const off = safeInt(offset, 0);

    const result = await query(`
      SELECT
        ml.listing_id AS listingId,
        ml.nft_contract AS nftContract,
        ml.token_id AS tokenId,
        ml.seller,
        ml.price,
        ml.status,
        ml.buyer,
        ml.created_at AS createdAt,
        ml.sold_at AS soldAt,
        ml.rarity,
        ml.hashpower,
        ml.hexes_decoded AS hexesDecoded,
        ml.tx_hash AS txHash,
        (SELECT COUNT(*) FROM marketplace_offers mo WHERE mo.listing_id = ml.listing_id AND mo.accepted = 0 AND mo.withdrawn = 0) AS offerCount
      FROM marketplace_listings ml
      ${whereClause}
      ORDER BY ${orderBy}
      LIMIT ${lim} OFFSET ${off}
    `, params);

    const countResult = await query(
      `SELECT COUNT(*) AS count FROM marketplace_listings ml ${whereClause}`,
      params
    );

    const response = {
      listings: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: lim,
      offset: off,
    };

    await cache.set(cacheKey, response, 30);
    res.json(response);
  } catch (err) {
    console.error('GET /api/marketplace/listings error:', err.message);
    res.status(500).json({ error: 'Failed to fetch listings' });
  }
});

// =============================================
// GET /api/marketplace/listings/:id — Single listing detail
// =============================================
router.get('/listings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const cacheKey = `mp-listing-${id}`;
    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    const result = await query(`
      SELECT
        ml.listing_id AS listingId,
        ml.nft_contract AS nftContract,
        ml.token_id AS tokenId,
        ml.seller,
        ml.price,
        ml.status,
        ml.buyer,
        ml.created_at AS createdAt,
        ml.sold_at AS soldAt,
        ml.rarity,
        ml.hashpower,
        ml.hexes_decoded AS hexesDecoded,
        ml.tx_hash AS txHash
      FROM marketplace_listings ml
      WHERE ml.listing_id = ?
    `, [String(id)]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    // Get offers for this listing
    const offersResult = await query(`
      SELECT
        offer_id AS offerId,
        bidder,
        amount,
        accepted,
        withdrawn,
        created_at AS createdAt
      FROM marketplace_offers
      WHERE listing_id = ?
      ORDER BY amount DESC
    `, [String(id)]);

    // Get node details from tracker
    const listing = result.rows[0];
    let nodeData = null;
    const nodeResult = await query(`
      SELECT
        id, rarity, activity,
        hexes_decoded AS hexesDecoded,
        hashpower,
        hex_distribution_rate AS hexesDistributionRate,
        wallet_address AS hackerWalletAddress
      FROM nodes WHERE id = ?
    `, [String(listing.tokenId)]);
    if (nodeResult.rows.length > 0) {
      nodeData = nodeResult.rows[0];
    }

    // Price history for this token
    const historyResult = await query(`
      SELECT price, sold_at AS soldAt, buyer
      FROM marketplace_sales
      WHERE nft_contract = ? AND token_id = ?
      ORDER BY sold_at DESC
      LIMIT 20
    `, [String(listing.nftContract), String(listing.tokenId)]);

    const response = {
      ...listing,
      offers: offersResult.rows,
      node: nodeData,
      priceHistory: historyResult.rows,
    };

    await cache.set(cacheKey, response, 30);
    res.json(response);
  } catch (err) {
    console.error(`GET /api/marketplace/listings/${req.params.id} error:`, err.message);
    res.status(500).json({ error: 'Failed to fetch listing' });
  }
});

// =============================================
// GET /api/marketplace/sales — Recent sales
// =============================================
router.get('/sales', async (req, res) => {
  try {
    const { limit = 50, offset = 0, contract } = req.query;
    const cacheKey = `mp-sales-${contract || 'all'}-${limit}-${offset}`;
    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    const where = [];
    const params = [];
    if (contract) {
      where.push('ms.nft_contract = ?');
      params.push(String(contract));
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const lim = Math.min(safeInt(limit, 50), 100);
    const off = safeInt(offset, 0);

    const result = await query(`
      SELECT
        ms.listing_id AS listingId,
        ms.nft_contract AS nftContract,
        ms.token_id AS tokenId,
        ms.seller,
        ms.buyer,
        ms.price,
        ms.fee,
        ms.sold_at AS soldAt,
        ms.tx_hash AS txHash,
        ml.rarity,
        ml.hashpower
      FROM marketplace_sales ms
      LEFT JOIN marketplace_listings ml ON ml.listing_id = ms.listing_id
      ${whereClause}
      ORDER BY ms.sold_at DESC
      LIMIT ${lim} OFFSET ${off}
    `, params);

    const countResult = await query(
      `SELECT COUNT(*) AS count FROM marketplace_sales ms ${whereClause}`,
      params
    );

    const response = {
      sales: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: lim,
      offset: off,
    };

    await cache.set(cacheKey, response, 30);
    res.json(response);
  } catch (err) {
    console.error('GET /api/marketplace/sales error:', err.message);
    res.status(500).json({ error: 'Failed to fetch sales' });
  }
});

// =============================================
// GET /api/marketplace/stats — Marketplace-wide stats
// =============================================
router.get('/stats', async (req, res) => {
  try {
    const cached = await cache.get('mp-stats');
    if (cached) return res.json(cached);

    // Active listings count & floor
    const activeResult = await query(`
      SELECT
        COUNT(*) AS totalActive,
        MIN(price) AS floorPrice,
        AVG(price) AS avgPrice
      FROM marketplace_listings
      WHERE status = 'Active'
    `);

    // Floor by rarity
    const floorByRarity = await query(`
      SELECT rarity, MIN(price) AS floorPrice, COUNT(*) AS count
      FROM marketplace_listings
      WHERE status = 'Active' AND rarity IS NOT NULL
      GROUP BY rarity
    `);

    // Total volume (all time)
    const volumeResult = await query(`
      SELECT
        COUNT(*) AS totalSales,
        COALESCE(SUM(price), 0) AS totalVolume,
        COALESCE(AVG(price), 0) AS avgSalePrice
      FROM marketplace_sales
    `);

    // 24h volume
    const volume24h = await query(`
      SELECT
        COUNT(*) AS sales,
        COALESCE(SUM(price), 0) AS volume
      FROM marketplace_sales
      WHERE sold_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
    `);

    // 7d volume
    const volume7d = await query(`
      SELECT
        COUNT(*) AS sales,
        COALESCE(SUM(price), 0) AS volume
      FROM marketplace_sales
      WHERE sold_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
    `);

    // Daily volume for chart (last 30 days)
    const dailyVolume = await query(`
      SELECT
        DATE(sold_at) AS date,
        COUNT(*) AS sales,
        SUM(price) AS volume,
        AVG(price) AS avgPrice
      FROM marketplace_sales
      WHERE sold_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY DATE(sold_at)
      ORDER BY date ASC
    `);

    const active = activeResult.rows[0];
    const vol = volumeResult.rows[0];

    const response = {
      activeListings: parseInt(active.totalActive) || 0,
      floorPrice: parseFloat(active.floorPrice) || 0,
      avgListingPrice: parseFloat(active.avgPrice) || 0,
      totalSales: parseInt(vol.totalSales) || 0,
      totalVolume: parseFloat(vol.totalVolume) || 0,
      avgSalePrice: parseFloat(vol.avgSalePrice) || 0,
      volume24h: parseFloat(volume24h.rows[0].volume) || 0,
      sales24h: parseInt(volume24h.rows[0].sales) || 0,
      volume7d: parseFloat(volume7d.rows[0].volume) || 0,
      sales7d: parseInt(volume7d.rows[0].sales) || 0,
      floorByRarity: floorByRarity.rows.reduce((acc, r) => {
        acc[r.rarity] = { floor: parseFloat(r.floorPrice), count: parseInt(r.count) };
        return acc;
      }, {}),
      dailyVolume: dailyVolume.rows,
    };

    await cache.set('mp-stats', response, 60);
    res.json(response);
  } catch (err) {
    console.error('GET /api/marketplace/stats error:', err.message);
    res.status(500).json({ error: 'Failed to fetch marketplace stats' });
  }
});

// =============================================
// GET /api/marketplace/activity — Recent marketplace activity feed
// =============================================
router.get('/activity', async (req, res) => {
  try {
    const { limit = 30 } = req.query;
    const cacheKey = `mp-activity-${limit}`;
    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    const lim = Math.min(safeInt(limit, 30), 100);
    const cancelLim = Math.min(lim, 20);

    // Combine recent listings and sales into activity feed
    // Inline LIMIT to avoid mysql2 prepared statement issues
    const listings = await query(`
      SELECT
        'listing' AS type,
        listing_id AS id,
        token_id AS tokenId,
        seller AS actor,
        price,
        rarity,
        created_at AS timestamp
      FROM marketplace_listings
      ORDER BY created_at DESC
      LIMIT ${lim}
    `);

    const sales = await query(`
      SELECT
        'sale' AS type,
        ms.listing_id AS id,
        ms.token_id AS tokenId,
        ms.buyer AS actor,
        ms.price,
        ml.rarity,
        ms.sold_at AS timestamp
      FROM marketplace_sales ms
      LEFT JOIN marketplace_listings ml ON ml.listing_id = ms.listing_id
      ORDER BY ms.sold_at DESC
      LIMIT ${lim}
    `);

    const cancellations = await query(`
      SELECT
        'cancel' AS type,
        listing_id AS id,
        token_id AS tokenId,
        seller AS actor,
        price,
        rarity,
        created_at AS timestamp
      FROM marketplace_listings
      WHERE status = 'Cancelled'
      ORDER BY created_at DESC
      LIMIT ${cancelLim}
    `);

    // Merge and sort by timestamp desc
    const activity = [...listings.rows, ...sales.rows, ...cancellations.rows]
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, lim);

    await cache.set(cacheKey, activity, 30);
    res.json(activity);
  } catch (err) {
    console.error('GET /api/marketplace/activity error:', err.message);
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

// =============================================
// GET /api/marketplace/token/:contract/:tokenId — Listing history for a specific token
// =============================================
router.get('/token/:contract/:tokenId', async (req, res) => {
  try {
    const { contract, tokenId } = req.params;
    const cacheKey = `mp-token-${contract}-${tokenId}`;
    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    const activeResult = await query(`
      SELECT listing_id AS listingId, seller, price, status, created_at AS createdAt
      FROM marketplace_listings
      WHERE nft_contract = ? AND token_id = ? AND status = 'Active'
      ORDER BY created_at DESC
      LIMIT 1
    `, [String(contract), String(tokenId)]);

    const salesResult = await query(`
      SELECT price, seller, buyer, sold_at AS soldAt, tx_hash AS txHash
      FROM marketplace_sales
      WHERE nft_contract = ? AND token_id = ?
      ORDER BY sold_at DESC
      LIMIT 20
    `, [String(contract), String(tokenId)]);

    const response = {
      activeListing: activeResult.rows[0] || null,
      salesHistory: salesResult.rows,
    };

    await cache.set(cacheKey, response, 30);
    res.json(response);
  } catch (err) {
    console.error(`GET /api/marketplace/token error:`, err.message);
    res.status(500).json({ error: 'Failed to fetch token marketplace data' });
  }
});

// =============================================
// GET /api/marketplace/config — Marketplace contract configuration
// =============================================
router.get('/config', async (req, res) => {
  try {
    const cached = await cache.get('mp-config');
    if (cached) return res.json(cached);

    const response = {
      sellerFeeBps: 300,          // 3%
      cancelPenalty: 100,         // 100 GUN
      minOfferAmount: 0.01,       // 0.01 GUN
      offerDurationDays: 7,       // 7 days
      contractAddress: process.env.MARKETPLACE_CONTRACT || null,
    };

    await cache.set('mp-config', response, 300);
    res.json(response);
  } catch (err) {
    console.error('GET /api/marketplace/config error:', err.message);
    res.status(500).json({ error: 'Failed to fetch config' });
  }
});

// =============================================
// GET /api/marketplace/notifications/:address — User notifications
// =============================================
router.get('/notifications/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const { limit = 30, unreadOnly } = req.query;
    const lim = Math.min(safeInt(limit, 30), 100);
    const addr = String(address).toLowerCase();

    const cacheKey = `mp-notif-${addr}-${unreadOnly || 'all'}-${lim}`;
    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    let whereExtra = '';
    if (unreadOnly === 'true') whereExtra = ' AND is_read = FALSE';

    const result = await query(`
      SELECT id, type, message, token_id AS tokenId, tx_hash AS txHash,
        is_read AS isRead, created_at AS createdAt
      FROM marketplace_notifications
      WHERE wallet_address = ?${whereExtra}
      ORDER BY created_at DESC
      LIMIT ${lim}
    `, [addr]);

    const unreadResult = await query(
      'SELECT COUNT(*) AS count FROM marketplace_notifications WHERE wallet_address = ? AND is_read = FALSE',
      [addr]
    );

    const response = {
      notifications: result.rows,
      unreadCount: parseInt(unreadResult.rows[0].count) || 0,
    };

    await cache.set(cacheKey, response, 15);
    res.json(response);
  } catch (err) {
    console.error('GET /api/marketplace/notifications error:', err.message);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// =============================================
// POST /api/marketplace/notifications/read — Mark notifications as read
// =============================================
router.post('/notifications/read', async (req, res) => {
  try {
    const { address, ids } = req.body;
    if (!address) return res.status(400).json({ error: 'address required' });
    const addr = String(address).toLowerCase();

    if (ids && Array.isArray(ids) && ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      await query(
        `UPDATE marketplace_notifications SET is_read = TRUE WHERE wallet_address = ? AND id IN (${placeholders})`,
        [addr, ...ids.map(id => safeInt(id))]
      );
    } else {
      await query('UPDATE marketplace_notifications SET is_read = TRUE WHERE wallet_address = ?', [addr]);
    }

    await cache.del(`mp-notif-${addr}-all-30`);
    await cache.del(`mp-notif-${addr}-true-30`);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/marketplace/notifications/read error:', err.message);
    res.status(500).json({ error: 'Failed to mark read' });
  }
});

// =============================================
// GET /api/marketplace/wallet/:address — Wallet marketplace summary
// =============================================
router.get('/wallet/:address', async (req, res) => {
  try {
    const addr = String(req.params.address).toLowerCase();
    const cacheKey = `mp-wallet-${addr}`;
    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    // Active listings by this wallet
    const listingsResult = await query(`
      SELECT listing_id AS listingId, token_id AS tokenId, price, rarity, created_at AS createdAt
      FROM marketplace_listings WHERE LOWER(seller) = ? AND status = 'Active'
      ORDER BY created_at DESC
    `, [addr]);

    // Active offers made by this wallet
    const offersResult = await query(`
      SELECT mo.offer_id AS offerId, mo.listing_id AS listingId, mo.amount,
        mo.expires_at AS expiresAt, mo.created_at AS createdAt,
        ml.token_id AS tokenId, ml.rarity
      FROM marketplace_offers mo
      LEFT JOIN marketplace_listings ml ON ml.listing_id = mo.listing_id
      WHERE LOWER(mo.bidder) = ? AND mo.accepted = FALSE AND mo.withdrawn = FALSE
      ORDER BY mo.created_at DESC
    `, [addr]);

    // Sales history (as seller or buyer)
    const salesResult = await query(`
      SELECT token_id AS tokenId, price, fee, seller, buyer, sold_at AS soldAt
      FROM marketplace_sales
      WHERE LOWER(seller) = ? OR LOWER(buyer) = ?
      ORDER BY sold_at DESC LIMIT 50
    `, [addr, addr]);

    // Total stats
    const soldResult = await query(
      'SELECT COUNT(*) AS count, COALESCE(SUM(price), 0) AS volume FROM marketplace_sales WHERE LOWER(seller) = ?',
      [addr]
    );
    const boughtResult = await query(
      'SELECT COUNT(*) AS count, COALESCE(SUM(price), 0) AS volume FROM marketplace_sales WHERE LOWER(buyer) = ?',
      [addr]
    );

    const response = {
      address: addr,
      activeListings: listingsResult.rows,
      activeOffers: offersResult.rows,
      salesHistory: salesResult.rows,
      stats: {
        totalSold: parseInt(soldResult.rows[0].count) || 0,
        soldVolume: parseFloat(soldResult.rows[0].volume) || 0,
        totalBought: parseInt(boughtResult.rows[0].count) || 0,
        boughtVolume: parseFloat(boughtResult.rows[0].volume) || 0,
      },
    };

    await cache.set(cacheKey, response, 30);
    res.json(response);
  } catch (err) {
    console.error('GET /api/marketplace/wallet error:', err.message);
    res.status(500).json({ error: 'Failed to fetch wallet data' });
  }
});

module.exports = router;
