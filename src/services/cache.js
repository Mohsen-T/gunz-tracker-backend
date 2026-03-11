/**
 * Cache layer — Redis with in-memory fallback
 * If Redis is unavailable, uses a simple Map with TTL eviction.
 */

const { createClient } = require('redis');

const TTL = parseInt(process.env.CACHE_TTL_SECONDS) || 60;

let redisClient = null;
let useMemory = false;
const memCache = new Map();

async function initCache() {
  if (!process.env.REDIS_URL) {
    console.log('⚡ No REDIS_URL — using in-memory cache');
    useMemory = true;
    return;
  }

  try {
    redisClient = createClient({ url: process.env.REDIS_URL });
    redisClient.on('error', (err) => {
      console.warn('⚠️  Redis error, falling back to memory:', err.message);
      useMemory = true;
    });
    await redisClient.connect();
    console.log('✅ Redis connected');
  } catch (err) {
    console.warn('⚠️  Redis unavailable, using in-memory cache:', err.message);
    useMemory = true;
  }
}

async function get(key) {
  try {
    if (useMemory) {
      const entry = memCache.get(key);
      if (!entry) return null;
      if (Date.now() > entry.expiry) { memCache.delete(key); return null; }
      return entry.data;
    }
    const raw = await redisClient.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function set(key, data, ttl = TTL) {
  try {
    if (useMemory) {
      memCache.set(key, { data, expiry: Date.now() + ttl * 1000 });
      return;
    }
    await redisClient.setEx(key, ttl, JSON.stringify(data));
  } catch {
    // Silent fail — cache is optional
  }
}

async function del(key) {
  try {
    if (useMemory) { memCache.delete(key); return; }
    await redisClient.del(key);
  } catch {
    // Silent fail
  }
}

async function flush() {
  try {
    if (useMemory) { memCache.clear(); return; }
    await redisClient.flushAll();
  } catch {
    // Silent fail
  }
}

module.exports = { initCache, get, set, del, flush };
