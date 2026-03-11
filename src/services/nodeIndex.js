/**
 * In-memory node index — O(1) lookups for wallet, node ID, and search.
 *
 * Built from the 10k nodes fetched during sync. Avoids DB queries for
 * read-heavy endpoints (wallet, search, all-nodes).
 *
 * Data structures:
 *   - nodesById:    Map<nodeId, Node>           — O(1) by ID
 *   - nodesByWallet: Map<walletLower, Node[]>   — O(1) by wallet
 *   - allNodes:     Node[] sorted by hexesDecoded DESC
 *   - ownerStats:   Map<walletLower, { count, totalHexes, totalHP, active, rarities }>
 */

let allNodes = [];
let nodesById = new Map();
let nodesByWallet = new Map();
let ownerStats = new Map();
let lastBuilt = null;

/**
 * Rebuild index from raw node rows (called after each sync or DB read).
 * @param {Array} nodes - Array of node objects with camelCase keys
 */
function build(nodes) {
  const byId = new Map();
  const byWallet = new Map();
  const stats = new Map();

  for (const n of nodes) {
    byId.set(String(n.id), n);

    const wallet = (n.hackerWalletAddress || '').toLowerCase();
    if (wallet) {
      if (!byWallet.has(wallet)) byWallet.set(wallet, []);
      byWallet.get(wallet).push(n);

      if (!stats.has(wallet)) {
        stats.set(wallet, { count: 0, totalHexes: 0, totalHP: 0, active: 0, rarities: {} });
      }
      const s = stats.get(wallet);
      s.count++;
      s.totalHexes += Number(n.hexesDecoded) || 0;
      s.totalHP += Number(n.hashpower) || 0;
      if (n.activity === 'Active') s.active++;
      const r = n.rarity || 'Common';
      s.rarities[r] = (s.rarities[r] || 0) + 1;
    }
  }

  // Sort all nodes by hexesDecoded DESC
  const sorted = [...nodes].sort((a, b) =>
    (Number(b.hexesDecoded) || 0) - (Number(a.hexesDecoded) || 0)
  );

  // Sort each wallet's nodes by hexesDecoded DESC
  for (const [, arr] of byWallet) {
    arr.sort((a, b) => (Number(b.hexesDecoded) || 0) - (Number(a.hexesDecoded) || 0));
  }

  allNodes = sorted;
  nodesById = byId;
  nodesByWallet = byWallet;
  ownerStats = stats;
  lastBuilt = new Date();

  console.log(`  Node index built: ${nodes.length} nodes, ${byWallet.size} wallets`);
}

/** Get all nodes sorted by hexesDecoded DESC */
function getAll() {
  return allNodes;
}

/** Get single node by ID — O(1) */
function getById(id) {
  return nodesById.get(String(id)) || null;
}

/** Get all nodes for a wallet — O(1) */
function getByWallet(address) {
  return nodesByWallet.get(address.toLowerCase()) || [];
}

/** Get aggregated owner stats for a wallet — O(1) */
function getOwnerStats(address) {
  return ownerStats.get(address.toLowerCase()) || null;
}

/** Get all owners with stats, sorted by totalHexes DESC */
function getAllOwners() {
  const owners = [];
  for (const [address, s] of ownerStats) {
    owners.push({ address, ...s });
  }
  owners.sort((a, b) => b.totalHexes - a.totalHexes);
  return owners;
}

/** Search nodes by ID prefix or wallet prefix — O(n) scan but fast on 10k */
function search(query, limit = 50) {
  const q = query.toLowerCase();
  const results = [];

  if (q.startsWith('0x')) {
    // Wallet search
    for (const [wallet, nodes] of nodesByWallet) {
      if (wallet.startsWith(q)) {
        for (const n of nodes) {
          results.push(n);
          if (results.length >= limit) return results;
        }
      }
    }
  } else {
    // ID search
    for (const n of allNodes) {
      if (String(n.id).startsWith(q)) {
        results.push(n);
        if (results.length >= limit) return results;
      }
    }
  }

  return results;
}

/** Check if index is populated */
function isReady() {
  return allNodes.length > 0;
}

/** Get index metadata */
function getInfo() {
  return {
    nodeCount: allNodes.length,
    walletCount: nodesByWallet.size,
    lastBuilt,
  };
}

module.exports = {
  build,
  getAll,
  getById,
  getByWallet,
  getOwnerStats,
  getAllOwners,
  search,
  isReady,
  getInfo,
};
