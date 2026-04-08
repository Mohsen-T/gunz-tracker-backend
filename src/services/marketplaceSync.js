/**
 * GUNZ Marketplace v2 — On-Chain Event Sync
 *
 * Indexes all marketplace events from the GunzMarketplace contract.
 * Polls every sync interval, stores to MySQL, creates notifications.
 */

const { query } = require('../db/pool');
const cache = require('./cache');

const GUNZSCAN_ETHERSCAN_API = 'https://gunzscan.io/api';
const MARKETPLACE_CONTRACT = process.env.MARKETPLACE_CONTRACT || '0x0000000000000000000000000000000000000000';

// Event topic0 hashes (keccak256 of signatures from compiled ABI)
const TOPICS = {
  Listed:           '0x9791797c382de5e73cc7c32c32ffd8304e9b9cc1f6afd967990c1edd0729dba9',
  Sale:             '0xf64c153fb1f9152a3751f5b937536b3dc5c6205ec165e101509dc21e8b6db5be',
  ListingCancelled: '0xafd0a85a3f09cebbc7d9fcde08e8a7d0ebb0aa7d768a030915c3816a053d3c7a',
  OfferPlaced:      '0x6bd129c89856ec910fcaef69015e4511ec697e15bcbe8ee0e8461ef5da5eae7b',
  OfferAccepted:    '0x8f414bb7b1129208b5a842a85f18292a47ad72117cca38e4363cf80dc189ec16',
  OfferWithdrawn:   '0xacbc44b7f46dc350c99fc0d9e5f61ed5c588cb4cdc6b69ea0deb0c5b28e5efc4',
  OfferRefunded:    '0x0ff19d650f33b91267d83d6212cc3626e5486ee3f5ae85d7759385cb0853ac2b',
  OfferRejected:    '0x312b83f85b04b08d3a1df0a1acfd41d45c404bcdc7adaeb3c5a86479378845aa',
  PriceUpdated:     '0x15819dd2fd9f6418b142e798d08a18d0bf06ea368f4480b7b0d3f75bd966bc48',
};

// ─── Helpers ───

async function getSyncCursor() {
  const result = await query('SELECT last_block FROM marketplace_sync_cursor WHERE id = 1');
  if (result.rows.length === 0) {
    await query('INSERT INTO marketplace_sync_cursor (id, last_block) VALUES (1, 0)');
    return 0;
  }
  return parseInt(result.rows[0].last_block) || 0;
}

async function setSyncCursor(block) {
  await query('UPDATE marketplace_sync_cursor SET last_block = ?, updated_at = NOW() WHERE id = 1', [block]);
}

async function getCurrentBlock() {
  const ts = Math.floor(Date.now() / 1000);
  try {
    const resp = await fetch(
      `${GUNZSCAN_ETHERSCAN_API}?module=block&action=getblocknobytime&timestamp=${ts}&closest=before`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    const raw = data.result;
    return parseInt(typeof raw === 'object' ? raw?.blockNumber : raw) || null;
  } catch { return null; }
}

async function fetchMarketplaceLogs(fromBlock, toBlock) {
  const allLogs = [];
  let startBlock = fromBlock;
  for (let page = 0; page < 20; page++) {
    const url = `${GUNZSCAN_ETHERSCAN_API}?module=logs&action=getLogs` +
      `&address=${MARKETPLACE_CONTRACT}&fromBlock=${startBlock}&toBlock=${toBlock}`;
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) break;
      const data = await resp.json();
      const logs = data.result || [];
      if (!Array.isArray(logs) || !logs.length) break;
      allLogs.push(...logs);
      if (logs.length < 1000) break;
      startBlock = parseInt(logs[logs.length - 1].blockNumber, 16) + 1;
    } catch { break; }
  }
  return allLogs;
}

function hexToAddr(hex) { return '0x' + hex.slice(26).toLowerCase(); }
function hexToUint(hex) { return parseInt(hex, 16); }
function hexToBigGun(hex) { return Number(BigInt('0x' + hex)) / 1e18; }
function logTs(log) { return parseInt(log.timeStamp, 16) * 1000; }
function logBlock(log) { return parseInt(log.blockNumber, 16); }

// ─── Event Parsers (v2 contract) ───

// Listed(uint256 indexed listingId, address indexed nftContract, uint256 indexed tokenId, address seller, uint256 price)
function parseListed(log) {
  const d = log.data.slice(2);
  return {
    listingId: hexToUint(log.topics[1]),
    nftContract: hexToAddr(log.topics[2]),
    tokenId: String(hexToUint(log.topics[3])),
    seller: '0x' + d.slice(24, 64).toLowerCase(),
    price: hexToBigGun(d.slice(64, 128)),
    timestamp: logTs(log), txHash: log.transactionHash, blockNumber: logBlock(log),
  };
}

// Sale(uint256 indexed listingId, address indexed buyer, uint256 price, uint256 fee)
function parseSale(log) {
  const d = log.data.slice(2);
  return {
    listingId: hexToUint(log.topics[1]),
    buyer: hexToAddr(log.topics[2]),
    price: hexToBigGun(d.slice(0, 64)),
    fee: hexToBigGun(d.slice(64, 128)),
    timestamp: logTs(log), txHash: log.transactionHash, blockNumber: logBlock(log),
  };
}

// ListingCancelled(uint256 indexed listingId, uint256 penalty)
function parseCancelled(log) {
  const d = log.data.slice(2);
  return {
    listingId: hexToUint(log.topics[1]),
    penalty: hexToBigGun(d.slice(0, 64)),
    timestamp: logTs(log), txHash: log.transactionHash, blockNumber: logBlock(log),
  };
}

// PriceUpdated(uint256 indexed listingId, uint256 oldPrice, uint256 newPrice)
function parsePriceUpdated(log) {
  const d = log.data.slice(2);
  return {
    listingId: hexToUint(log.topics[1]),
    oldPrice: hexToBigGun(d.slice(0, 64)),
    newPrice: hexToBigGun(d.slice(64, 128)),
    timestamp: logTs(log), txHash: log.transactionHash, blockNumber: logBlock(log),
  };
}

// OfferPlaced(uint256 indexed offerId, uint256 indexed listingId, address indexed bidder, uint256 amount, uint256 expiresAt)
function parseOfferPlaced(log) {
  const d = log.data.slice(2);
  return {
    offerId: hexToUint(log.topics[1]),
    listingId: hexToUint(log.topics[2]),
    bidder: hexToAddr(log.topics[3]),
    amount: hexToBigGun(d.slice(0, 64)),
    expiresAt: hexToUint('0x' + d.slice(64, 128)) * 1000,
    timestamp: logTs(log), txHash: log.transactionHash, blockNumber: logBlock(log),
  };
}

// OfferAccepted(uint256 indexed offerId, uint256 indexed listingId, address indexed bidder, uint256 amount, uint256 fee)
function parseOfferAccepted(log) {
  const d = log.data.slice(2);
  return {
    offerId: hexToUint(log.topics[1]),
    listingId: hexToUint(log.topics[2]),
    bidder: hexToAddr(log.topics[3]),
    amount: hexToBigGun(d.slice(0, 64)),
    fee: hexToBigGun(d.slice(64, 128)),
    timestamp: logTs(log), txHash: log.transactionHash, blockNumber: logBlock(log),
  };
}

// OfferWithdrawn(uint256 indexed offerId)
function parseOfferWithdrawn(log) {
  return {
    offerId: hexToUint(log.topics[1]),
    timestamp: logTs(log), txHash: log.transactionHash, blockNumber: logBlock(log),
  };
}

// OfferRefunded(uint256 indexed offerId, address indexed bidder, uint256 amount)
function parseOfferRefunded(log) {
  const d = log.data.slice(2);
  return {
    offerId: hexToUint(log.topics[1]),
    bidder: hexToAddr(log.topics[2]),
    amount: hexToBigGun(d.slice(0, 64)),
    timestamp: logTs(log), txHash: log.transactionHash, blockNumber: logBlock(log),
  };
}

// ─── DB Writers ───

async function upsertListing(evt) {
  const nodeResult = await query('SELECT rarity, hashpower, hexes_decoded FROM nodes WHERE id = ?', [evt.tokenId]);
  const node = nodeResult.rows[0] || {};
  await query(`
    INSERT INTO marketplace_listings
      (listing_id, nft_contract, token_id, seller, price, status, created_at, tx_hash, block_number, rarity, hashpower, hexes_decoded)
    VALUES (?, ?, ?, ?, ?, 'Active', FROM_UNIXTIME(? / 1000), ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE price = VALUES(price), status = 'Active', tx_hash = VALUES(tx_hash)
  `, [evt.listingId, evt.nftContract, evt.tokenId, evt.seller, evt.price,
      evt.timestamp, evt.txHash, evt.blockNumber, node.rarity || null, node.hashpower || 0, node.hexes_decoded || 0]);

  await createNotification(evt.seller, 'listing', `Listed Node #${evt.tokenId} for ${evt.price.toFixed(2)} GUN`, evt.tokenId, evt.txHash);
}

async function processSale(evt) {
  const lr = await query('SELECT nft_contract, token_id, seller, price FROM marketplace_listings WHERE listing_id = ?', [evt.listingId]);
  const listing = lr.rows[0];
  if (!listing) return;

  await query('UPDATE marketplace_listings SET status = ?, buyer = ?, sold_at = FROM_UNIXTIME(? / 1000) WHERE listing_id = ?',
    ['Sold', evt.buyer, evt.timestamp, evt.listingId]);

  await query(`
    INSERT INTO marketplace_sales (listing_id, nft_contract, token_id, seller, buyer, price, fee, sold_at, tx_hash, block_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(? / 1000), ?, ?)
  `, [evt.listingId, listing.nft_contract, listing.token_id, listing.seller, evt.buyer, evt.price, evt.fee,
      evt.timestamp, evt.txHash, evt.blockNumber]);

  await createNotification(listing.seller, 'sale', `Node #${listing.token_id} sold for ${evt.price.toFixed(2)} GUN`, listing.token_id, evt.txHash);
  await createNotification(evt.buyer, 'purchase', `Purchased Node #${listing.token_id} for ${evt.price.toFixed(2)} GUN`, listing.token_id, evt.txHash);
}

async function processCancellation(evt) {
  await query('UPDATE marketplace_listings SET status = ?, cancelled_at = FROM_UNIXTIME(? / 1000), penalty_paid = ? WHERE listing_id = ?',
    ['Cancelled', evt.timestamp, evt.penalty, evt.listingId]);
}

async function processPriceUpdate(evt) {
  await query('UPDATE marketplace_listings SET price = ? WHERE listing_id = ?', [evt.newPrice, evt.listingId]);
}

async function processOfferPlaced(evt) {
  await query(`
    INSERT INTO marketplace_offers (offer_id, listing_id, bidder, amount, created_at, expires_at, tx_hash, block_number)
    VALUES (?, ?, ?, ?, FROM_UNIXTIME(? / 1000), FROM_UNIXTIME(? / 1000), ?, ?)
    ON DUPLICATE KEY UPDATE amount = VALUES(amount)
  `, [evt.offerId, evt.listingId, evt.bidder, evt.amount,
      evt.timestamp, evt.expiresAt, evt.txHash, evt.blockNumber]);

  const lr = await query('SELECT seller, token_id FROM marketplace_listings WHERE listing_id = ?', [evt.listingId]);
  if (lr.rows[0]) {
    await createNotification(lr.rows[0].seller, 'offer', `New offer of ${evt.amount.toFixed(2)} GUN on Node #${lr.rows[0].token_id}`, lr.rows[0].token_id, evt.txHash);
  }
}

async function processOfferAccepted(evt) {
  await query('UPDATE marketplace_offers SET accepted = TRUE WHERE offer_id = ?', [evt.offerId]);

  const lr = await query('SELECT token_id FROM marketplace_listings WHERE listing_id = ?', [evt.listingId]);
  if (lr.rows[0]) {
    await createNotification(evt.bidder, 'offer_accepted', `Your offer on Node #${lr.rows[0].token_id} was accepted`, lr.rows[0].token_id, evt.txHash);
  }
}

async function processOfferWithdrawn(evt) {
  await query('UPDATE marketplace_offers SET withdrawn = TRUE WHERE offer_id = ?', [evt.offerId]);
}

async function processOfferRefunded(evt) {
  await query('UPDATE marketplace_offers SET withdrawn = TRUE WHERE offer_id = ?', [evt.offerId]);
}

// ─── Notifications ───

async function createNotification(walletAddress, type, message, tokenId, txHash) {
  try {
    await query(`
      INSERT INTO marketplace_notifications (wallet_address, type, message, token_id, tx_hash)
      VALUES (?, ?, ?, ?, ?)
    `, [walletAddress.toLowerCase(), type, message, tokenId || null, txHash || null]);
  } catch (err) {
    console.error('[marketplace-sync] Notification error:', err.message);
  }
}

// ─── Main Sync ───

async function syncMarketplace() {
  if (MARKETPLACE_CONTRACT === '0x0000000000000000000000000000000000000000') {
    return { synced: 0, events: 0 };
  }

  const startTime = Date.now();
  let eventsProcessed = 0;

  try {
    const lastBlock = await getSyncCursor();
    const currentBlock = await getCurrentBlock();
    if (!currentBlock || currentBlock <= lastBlock) return { synced: 0, events: 0 };

    const fromBlock = lastBlock + 1;
    const logs = await fetchMarketplaceLogs(fromBlock, currentBlock);

    for (const log of logs) {
      try {
        const topic0 = log.topics[0];

        if (topic0 === TOPICS.Listed) {
          await upsertListing(parseListed(log));
          eventsProcessed++;
        } else if (topic0 === TOPICS.Sale) {
          await processSale(parseSale(log));
          eventsProcessed++;
        } else if (topic0 === TOPICS.ListingCancelled) {
          await processCancellation(parseCancelled(log));
          eventsProcessed++;
        } else if (topic0 === TOPICS.PriceUpdated) {
          await processPriceUpdate(parsePriceUpdated(log));
          eventsProcessed++;
        } else if (topic0 === TOPICS.OfferPlaced) {
          await processOfferPlaced(parseOfferPlaced(log));
          eventsProcessed++;
        } else if (topic0 === TOPICS.OfferAccepted) {
          await processOfferAccepted(parseOfferAccepted(log));
          eventsProcessed++;
        } else if (topic0 === TOPICS.OfferWithdrawn) {
          await processOfferWithdrawn(parseOfferWithdrawn(log));
          eventsProcessed++;
        } else if (topic0 === TOPICS.OfferRefunded) {
          await processOfferRefunded(parseOfferRefunded(log));
          eventsProcessed++;
        }
      } catch (err) {
        console.error('[marketplace-sync] Error processing log:', err.message);
      }
    }

    await setSyncCursor(currentBlock);
    await cache.flush();

    const duration = Date.now() - startTime;
    if (eventsProcessed > 0) {
      console.log(`[marketplace-sync] Synced blocks ${fromBlock}-${currentBlock}, ${eventsProcessed} events in ${duration}ms`);
    }
    return { synced: currentBlock - fromBlock, events: eventsProcessed, duration };
  } catch (err) {
    console.error('[marketplace-sync] Error:', err.message);
    return { synced: 0, events: 0, error: err.message };
  }
}

module.exports = { syncMarketplace };
