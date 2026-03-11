# GRIDZILLA Backend

Real-time API backend for tracking all 10,000 GUNZ Hacker License NFTs. Syncs from the public GUNZ API every 2 minutes, enriches with on-chain data from GunzScan, and serves data to the frontend.

**Live:** [gridzilla.io](https://gridzilla.io)

## Architecture

```
Frontend (React)  -->  This Backend  -->  MySQL
                           |
                    In-Memory Index (O(1) lookups)
                           |
                    Redis Cache (optional, falls back to memory)
                           |
              +------------+------------+
              |            |            |
        GUNZ API     GunzScan      Metadata API
      (node data)   (on-chain)    (NFT metadata)
```

**How it works:**
1. Every 2 minutes, fetches all 10,000 nodes from the GUNZ API
2. Upserts into MySQL (tracks changes/deltas between syncs)
3. Builds an in-memory index for O(1) lookups by wallet, node ID, and search
4. Takes daily snapshots for historical charts
5. Queries on-chain Decoded event logs for earnings, decoded items, and game items
6. Serves cached responses to the frontend

## Data Sources

| Source | Base URL | Auth | Used For |
|--------|----------|------|----------|
| GUNZ API | `api.gunzchain.app/api/v1` | Public (limited) | Node list, hexes, hashpower, distribution |
| GunzScan Etherscan API | `gunzscan.io/api` | Public | Decoded event logs, block numbers |
| GunzScan Blockscout API | `gunzscan.io/api/v2` | Public | Token transfers, game item tracing |
| Metadata API | `metadata.gunzchain.io/api/v1` | Public | NFT metadata (name, image, rarity) |

### On-Chain Contracts

| Contract | Address | Purpose |
|----------|---------|---------|
| Hacker License (HL) | `0xc386fc39680D76Bc8F6Eba12513CF572910BB919` | ERC-721, 10K license NFTs |
| Game Item (GI) | `0x9ED98e159BE43a8d42b64053831FCAE5e4d7d271` | ERC-721, decoded game items |
| Decoder | `0x1c695462A43103116C2d806f1895a17D270B270A` | Emits `Decoded` events with fees |

### On-Chain Earnings (Decoded Events)

The backend fetches `Decoded` event logs from the Decoder contract to compute earnings and decoded item charts without requiring GUNZ API authentication:

```
Decoded(indexed uint256 HLTokenId, indexed address receiver, ...)
Data layout: HEXBackendTokenId(32b) | hackerFeeFromUser(32b) | platformFee(32b) | hackerFeeFromHackerLicense(32b)
```

- `HLTokenId` is indexed, enabling per-license event filtering via `topic1`
- Fees are in wei (18 decimals), converted to GUN
- Block range calculated from current block minus period (GUNZ chain ~2s block time, ~43,200 blocks/day)
- Blockscout returns max 1000 logs per request; backend paginates via `fromBlock`

### Game Item Tracing

Game items are traced through on-chain data (no auth needed):
1. Fetch Decoded events for a license
2. For each event, fetch the transaction's token transfers from Blockscout
3. Find the Game Item mint (from `0x0000...` of GI contract)
4. Extract metadata (name, image, rarity, class) from the token instance

## Quick Start

### Prerequisites
- Node.js 18+
- MySQL 8+
- Redis (optional)

### Setup

```bash
cd gunz-tracker-backend
npm install

# Create .env
cat > .env << 'EOF'
PORT=3001
DATABASE_URL=mysql://gunz:YOUR_PASSWORD@localhost:3306/gunz_tracker
REDIS_URL=redis://localhost:6379
EOF

# Note: URL-encode special characters in password
# e.g. # -> %23, ; -> %3B, @ -> %40

# Create database
mysql -u root -e "CREATE DATABASE gunz_tracker;"
mysql -u root -e "CREATE USER 'gunz'@'localhost' IDENTIFIED BY 'YOUR_PASSWORD';"
mysql -u root -e "GRANT ALL PRIVILEGES ON gunz_tracker.* TO 'gunz'@'localhost';"

# Run migration
npm run migrate

# Start (includes initial sync)
npm run dev
```

### Verify

```bash
# Health check
curl http://localhost:3001/api/health

# All 10,000 nodes
curl http://localhost:3001/api/nodes

# Single node detail + history + rank
curl http://localhost:3001/api/nodes/9015

# Node GUN earnings (on-chain, 7/30/90 day periods)
curl "http://localhost:3001/api/nodes/9015/earnings?period=week"

# Node decoded items chart (on-chain)
curl "http://localhost:3001/api/nodes/9015/decoded-items?period=month"

# Game items decoded by a license (on-chain traced)
curl "http://localhost:3001/api/nodes/9015/game-items?limit=20"

# License info
curl http://localhost:3001/api/nodes/9015/info

# Global stats + top movers
curl http://localhost:3001/api/stats

# Leaderboard (top 100 Epic nodes)
curl "http://localhost:3001/api/leaderboard?rarity=Epic&limit=100"

# Search by ID or wallet
curl "http://localhost:3001/api/search?q=901"

# Wallet lookup (O(1))
curl http://localhost:3001/api/wallet/0x27408a2f70b705c518a8ce3092c21c3cc510bc24

# All owners with aggregated stats
curl "http://localhost:3001/api/owners?limit=50"
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/nodes` | All 10,000 nodes (from in-memory index) |
| GET | `/api/nodes/:id` | Single node detail + 30-day history + rank |
| GET | `/api/nodes/:id/earnings` | GUN earnings by day (on-chain Decoded events) |
| GET | `/api/nodes/:id/decoded-items` | Decoded item count by day (on-chain events) |
| GET | `/api/nodes/:id/game-items` | Game items with metadata (on-chain traced) |
| GET | `/api/nodes/:id/info` | License info from GUNZ API |
| GET | `/api/stats` | Global stats, activity breakdown, top 20 movers |
| GET | `/api/leaderboard` | Sorted/filtered node list with pagination |
| GET | `/api/hexes` | Daily HEX decode counts |
| GET | `/api/distribution` | Earnings distribution by rarity |
| GET | `/api/hashpower` | Hashpower trend |
| GET | `/api/search?q=` | Search by node ID prefix or wallet address |
| GET | `/api/wallet/:address` | All nodes for a wallet (O(1) lookup) |
| GET | `/api/owners` | All wallet owners with aggregated stats |
| GET | `/api/health` | Health check + sync/index status |

### Query Parameters

**Earnings / Decoded Items:**
- `period` - `week` (7d), `month` (30d), `quarter` (90d)

**Game Items:**
- `limit` - Max items to return (default: 20, max: 40)

**Leaderboard:**
- `rarity` - Common, Rare, Epic, Legendary, Ancient
- `status` - Active, Inactive
- `limit` / `offset` - Pagination

**Owners:**
- `limit` - Results per page (default: 100, max: 500)
- `offset` - Pagination offset

## In-Memory Index

The `nodeIndex.js` module builds O(1) lookup structures after each sync:

| Structure | Type | Purpose |
|-----------|------|---------|
| `nodesById` | `Map<id, Node>` | Single node lookup |
| `nodesByWallet` | `Map<wallet, Node[]>` | All nodes for a wallet |
| `ownerStats` | `Map<wallet, Stats>` | Pre-computed wallet aggregates |
| `allNodes` | `Node[]` (sorted) | Full list sorted by hexesDecoded DESC |

This avoids DB queries for the most common read operations, serving responses directly from memory.

## Deployment (Linux)

```bash
# Prerequisites
sudo apt update && sudo apt install -y nodejs npm mysql-server redis-server nginx

# MySQL setup
sudo mysql_secure_installation
sudo mysql -e "CREATE DATABASE gunz_tracker;"
sudo mysql -e "CREATE USER 'gunz'@'localhost' IDENTIFIED BY 'YOUR_PASSWORD';"
sudo mysql -e "GRANT ALL PRIVILEGES ON gunz_tracker.* TO 'gunz'@'localhost';"

# Project setup
cd ~/gunz-node-tracker/gunz-tracker-backend
npm install
# Create .env with DATABASE_URL and REDIS_URL
npm run migrate

# Run with PM2
npm install -g pm2
pm2 start src/server.js --name gunz-backend
pm2 save
pm2 startup
```

### Nginx reverse proxy

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## Project Structure

```
gunz-tracker-backend/
|-- src/
|   |-- server.js              # Express app + cron scheduler
|   |-- routes/
|   |   |-- api.js             # All API endpoints + on-chain data fetching
|   |-- services/
|   |   |-- sync.js            # GUNZ API sync job (2-min interval)
|   |   |-- cache.js           # Redis/memory cache layer
|   |   |-- nodeIndex.js       # In-memory index (O(1) lookups)
|   |-- db/
|       |-- pool.js            # MySQL connection pool
|       |-- migrate.js         # Database schema migration
|-- .env.example
|-- package.json
|-- README.md
```

## Tech Stack

- **Runtime:** Node.js 18+
- **Framework:** Express 4
- **Database:** MySQL 8 (mysql2)
- **Cache:** Redis 4 (optional, falls back to in-memory)
- **Scheduler:** node-cron
- **Security:** Helmet, CORS, compression
