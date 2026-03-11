# GRIDZILLA Backend

Real-time API backend for tracking all 10,000 GUNZ Validator NFTs. Syncs from the public GUNZ API every 2 minutes and serves data to the frontend.

## Architecture

```
Frontend (React)  ->  This Backend  ->  PostgreSQL
                          |
                   In-Memory Index (O(1) lookups)
                          |
                   api.gunzchain.app (public)
                          |
                   Redis Cache (optional)
```

**How it works:**
1. Every 2 minutes, fetches all 10,000 nodes in a single API call
2. Upserts into PostgreSQL (tracks changes/deltas)
3. Builds an in-memory index for O(1) lookups by wallet, node ID, and search
4. Takes daily snapshots for historical charts
5. Serves cached responses to the frontend

## Quick Start

### Prerequisites
- Node.js 18+
- PostgreSQL 14+
- Redis (optional - falls back to in-memory cache)

### Setup

```bash
# 1. Clone and install
cd gunz-tracker-backend
npm install

# 2. Create .env from template
cp .env.example .env
# Edit .env with your database URL

# 3. Create the database
createdb gunz_tracker
# Or: psql -c "CREATE DATABASE gunz_tracker;"

# 4. Run migration
npm run migrate

# 5. Start the server (includes initial sync)
npm run dev
```

### Verify it's working

```bash
# Health check
curl http://localhost:3001/api/health

# All 10,000 nodes
curl http://localhost:3001/api/nodes

# Single node
curl http://localhost:3001/api/nodes/9015

# Global stats
curl http://localhost:3001/api/stats

# Leaderboard (top 100 Epic nodes)
curl "http://localhost:3001/api/leaderboard?rarity=Epic&limit=100"

# Search by ID
curl "http://localhost:3001/api/search?q=901"

# All nodes owned by a wallet
curl http://localhost:3001/api/wallet/0x27408a2f70b705c518a8ce3092c21c3cc510bc24

# All owners with aggregated stats
curl "http://localhost:3001/api/owners?limit=50"

# Node earnings (proxied from GUNZ API)
curl "http://localhost:3001/api/nodes/50/earnings?period=month"

# Node decoded items (proxied from GUNZ API)
curl "http://localhost:3001/api/nodes/50/items?period=month"
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/nodes` | All 10,000 nodes (from in-memory index) |
| GET | `/api/nodes/:id` | Single node detail + 30-day history |
| GET | `/api/nodes/:id/earnings` | Node earnings (proxied from GUNZ API) |
| GET | `/api/nodes/:id/items` | Node decoded items (proxied from GUNZ API) |
| GET | `/api/stats` | Global ecosystem stats |
| GET | `/api/leaderboard` | Top nodes (filterable by rarity, status) |
| GET | `/api/hexes` | Daily HEX decode counts |
| GET | `/api/distribution` | Earnings distribution by rarity |
| GET | `/api/hashpower` | Hashpower trend |
| GET | `/api/search?q=` | Search by node ID or wallet prefix |
| GET | `/api/wallet/:address` | All nodes for a wallet (O(1) index lookup) |
| GET | `/api/owners` | All wallet owners with aggregated stats |
| GET | `/api/health` | Health check + sync/index status |

### Query Parameters

**Leaderboard:**
- `rarity` - Filter: Common, Rare, Epic, Legendary, Ancient
- `status` - Filter: Active, Inactive
- `limit` - Results per page (default: 100)
- `offset` - Pagination offset

**Hexes/Distribution/Hashpower:**
- `period` - Time range: month, week, year

**Owners:**
- `limit` - Results per page (default: 100)
- `offset` - Pagination offset

## In-Memory Index

The `nodeIndex.js` module builds O(1) lookup structures after each sync:

| Structure | Type | Purpose |
|-----------|------|---------|
| `nodesById` | `Map<id, Node>` | Single node lookup |
| `nodesByWallet` | `Map<wallet, Node[]>` | All nodes for a wallet |
| `ownerStats` | `Map<wallet, Stats>` | Pre-computed wallet aggregates |
| `allNodes` | `Node[]` (sorted) | Full list sorted by hexesDecoded DESC |

This avoids DB queries for the most common read operations (all-nodes, wallet lookup, search), serving responses directly from memory.

## Deployment

### Option A: Railway (Easiest)

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login and deploy
railway login
railway init
railway add --database postgres
railway add --database redis
railway up
```

### Option B: DigitalOcean

```bash
# Create a $6/mo droplet (Ubuntu 24)
# SSH in and run:

sudo apt update && sudo apt install -y nodejs npm postgresql redis-server

# Create DB
sudo -u postgres createdb gunz_tracker
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'yourpassword';"

# Clone, install, configure
git clone <your-repo> && cd gunz-tracker-backend
npm install
cp .env.example .env
# Edit .env with your DATABASE_URL

# Migrate and start
npm run migrate
npm start

# Use PM2 for process management
npm install -g pm2
pm2 start src/server.js --name gunz-tracker
pm2 save
pm2 startup
```

### Option C: Docker

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 3001
CMD ["node", "src/server.js"]
```

```yaml
# docker-compose.yml
services:
  api:
    build: .
    ports: ["3001:3001"]
    env_file: .env
    depends_on: [db, redis]
  db:
    image: postgres:16
    environment:
      POSTGRES_DB: gunz_tracker
      POSTGRES_PASSWORD: password
    volumes: [pgdata:/var/lib/postgresql/data]
  redis:
    image: redis:7-alpine
volumes:
  pgdata:
```

## Data Source

All data comes from the **public** GUNZ API (no authentication required):

```
Base URL: https://api.gunzchain.app/api/v1

GET /licenses?offset=0&page_size=10000&period=month  -> All 10K nodes
GET /licenses/activity                                 -> Active/Inactive counts
GET /hexes?period=month                                -> Daily HEX counts
GET /licenses/distribution?period=month                -> Earnings by rarity
GET /licenses/hashpower?period=month                   -> Total hashpower trend
```

## Project Structure

```
gunz-tracker-backend/
|-- src/
|   |-- server.js           # Express app + cron scheduler
|   |-- routes/
|   |   |-- api.js          # All API endpoints
|   |-- services/
|   |   |-- sync.js         # GUNZ API sync job
|   |   |-- cache.js        # Redis/memory cache layer
|   |   |-- nodeIndex.js    # In-memory index (O(1) lookups)
|   |-- db/
|       |-- pool.js         # PostgreSQL connection pool
|       |-- migrate.js      # Database schema migration
|-- .env.example
|-- .gitignore
|-- package.json
|-- README.md
```
