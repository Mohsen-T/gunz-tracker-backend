/**
 * Seed the backend database with test marketplace listings.
 *
 * Usage: node scripts/seed-db.js <MockNFT_ADDRESS>
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

const MOCK_NFT_ADDRESS = process.argv[2] || '';

async function seed() {
  if (!MOCK_NFT_ADDRESS) {
    console.log('Usage: node scripts/seed-db.js <MockNFT_ADDRESS>');
    process.exit(1);
  }

  const conn = await mysql.createConnection(process.env.DATABASE_URL);
  console.log('Connected to DB');

  // Wipe ALL stale marketplace data from previous Hardhat sessions.
  // The contract addresses change every redeploy, so old rows are useless.
  console.log('Clearing stale marketplace data...');
  await conn.execute('DELETE FROM marketplace_sales');
  await conn.execute('DELETE FROM marketplace_offers');
  await conn.execute('DELETE FROM marketplace_listings');
  await conn.execute('DELETE FROM marketplace_notifications');
  console.log('  Cleared sales, offers, listings, notifications');

  const deployer = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  // 12 listings with varied rarities — must match reset-local.js listingPlan
  const listings = [
    { id: 1,  tokenId: '1',  price: 10,    rarity: 'Epic',      hp: 600,   hexes: 1234 },
    { id: 2,  tokenId: '2',  price: 5,     rarity: 'Rare',      hp: 120,   hexes: 567 },
    { id: 3,  tokenId: '3',  price: 25,    rarity: 'Legendary', hp: 3000,  hexes: 4521 },
    { id: 4,  tokenId: '4',  price: 15,    rarity: 'Epic',      hp: 600,   hexes: 2103 },
    { id: 5,  tokenId: '5',  price: 8,     rarity: 'Rare',      hp: 120,   hexes: 845 },
    { id: 6,  tokenId: '6',  price: 50,    rarity: 'Legendary', hp: 3000,  hexes: 6789 },
    { id: 7,  tokenId: '7',  price: 3,     rarity: 'Common',    hp: 40,    hexes: 234 },
    { id: 8,  tokenId: '8',  price: 100,   rarity: 'Ancient',   hp: 20000, hexes: 12345 },
    { id: 9,  tokenId: '9',  price: 12.5,  rarity: 'Epic',      hp: 600,   hexes: 1876 },
    { id: 10, tokenId: '10', price: 7,     rarity: 'Rare',      hp: 120,   hexes: 654 },
    { id: 11, tokenId: '11', price: 20,    rarity: 'Epic',      hp: 600,   hexes: 2987 },
    { id: 12, tokenId: '12', price: 4,     rarity: 'Common',    hp: 40,    hexes: 312 },
  ];

  for (const l of listings) {
    await conn.execute(`
      INSERT INTO marketplace_listings
        (listing_id, nft_contract, token_id, seller, price, status, created_at, rarity, hashpower, hexes_decoded)
      VALUES (?, ?, ?, ?, ?, 'Active', ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE price = VALUES(price), status = 'Active'
    `, [l.id, MOCK_NFT_ADDRESS, l.tokenId, deployer, l.price, now, l.rarity, l.hp, l.hexes]);
    console.log(`Inserted listing #${l.id}: Node #${l.tokenId} for ${l.price} ETH (${l.rarity})`);
  }

  console.log('\nDone! Restart backend and refresh marketplace.');
  await conn.end();
}

seed().catch(err => { console.error(err.message); process.exit(1); });
