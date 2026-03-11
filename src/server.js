/**
 * GUNZ Node Tracker — Express Server
 * 
 * Serves the API and runs the sync job on a cron schedule.
 * 
 * Start:
 *   npm run dev      (development with auto-reload)
 *   npm start        (production)
 * 
 * The server will:
 *   1. Connect to MySQL
 *   2. Initialize Redis cache (or fall back to memory)
 *   3. Run an initial sync of all 10,000 nodes
 *   4. Start the API server
 *   5. Schedule syncs every 2 minutes
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const cron = require('node-cron');

const apiRoutes = require('./routes/api');
const { initCache } = require('./services/cache');
const { syncAll } = require('./services/sync');
const { query } = require('./db/pool');

const app = express();
const PORT = process.env.PORT || 3001;
const SYNC_INTERVAL = parseInt(process.env.SYNC_INTERVAL_MINUTES) || 2;

// =============================================
// Middleware
// =============================================
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(compression());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET'],
}));
app.use(morgan('short'));
app.use(express.json());

// =============================================
// Rate limiting (simple in-memory)
// =============================================
const rateLimit = new Map();
const RATE_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000;
const RATE_MAX = parseInt(process.env.RATE_LIMIT_MAX) || 100;

app.use('/api', (req, res, next) => {
  const ip = req.ip;
  const now = Date.now();
  const entry = rateLimit.get(ip);
  
  if (!entry || now - entry.start > RATE_WINDOW) {
    rateLimit.set(ip, { start: now, count: 1 });
    return next();
  }
  
  entry.count++;
  if (entry.count > RATE_MAX) {
    return res.status(429).json({ 
      error: 'Rate limit exceeded', 
      retryAfter: Math.ceil((entry.start + RATE_WINDOW - now) / 1000) 
    });
  }
  
  next();
});

// Clean up rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimit) {
    if (now - entry.start > RATE_WINDOW * 2) rateLimit.delete(ip);
  }
}, 300000);

// =============================================
// Routes
// =============================================
app.use('/api', apiRoutes);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'GUNZ Node Tracker API',
    version: '1.0.0',
    endpoints: {
      nodes: '/api/nodes',
      nodeDetail: '/api/nodes/:id',
      stats: '/api/stats',
      leaderboard: '/api/leaderboard',
      hexes: '/api/hexes',
      distribution: '/api/distribution',
      hashpower: '/api/hashpower',
      search: '/api/search?q=',
      wallet: '/api/wallet/:address',
      health: '/api/health',
    },
    source: 'api.gunzchain.app (public)',
    syncInterval: `${SYNC_INTERVAL} minutes`,
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// =============================================
// Startup
// =============================================
async function start() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║     GUNZ NODE TRACKER — Backend v1       ║');
  console.log('╚══════════════════════════════════════════╝\n');

  // 1. Check database connection
  try {
    await query('SELECT 1');
    console.log('✅ MySQL connected');
  } catch (err) {
    console.error('❌ MySQL connection failed:', err.message);
    console.error('   Run: npm run migrate');
    process.exit(1);
  }

  // 2. Check if tables exist
  try {
    const tables = await query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'nodes'`
    );
    if (tables.rows.length === 0) {
      console.error('❌ Tables not found. Run: npm run migrate');
      process.exit(1);
    }
    const nodeCount = await query('SELECT COUNT(*) AS count FROM nodes');
    console.log(`✅ Database ready (${nodeCount.rows[0].count} nodes in DB)`);
  } catch (err) {
    console.error('❌ Database check failed:', err.message);
    process.exit(1);
  }

  // 3. Initialize cache
  await initCache();

  // 4. Initial sync
  console.log('\n🚀 Running initial sync...');
  await syncAll();

  // 5. Start server
  app.listen(PORT, () => {
    console.log(`\n🌐 API server running on http://localhost:${PORT}`);
    console.log(`   GET http://localhost:${PORT}/api/nodes`);
    console.log(`   GET http://localhost:${PORT}/api/stats`);
    console.log(`   GET http://localhost:${PORT}/api/health\n`);
  });

  // 6. Schedule sync every N minutes
  const cronExpr = `*/${SYNC_INTERVAL} * * * *`;
  cron.schedule(cronExpr, () => {
    syncAll().catch(err => console.error('Cron sync failed:', err.message));
  });
  console.log(`⏰ Sync scheduled every ${SYNC_INTERVAL} minutes (${cronExpr})`);
}

start().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

module.exports = app;
