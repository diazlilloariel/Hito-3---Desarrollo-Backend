const PRODUCTS_CACHE_TTL_MS = 1500; // 1.5s
const productsCache = new Map(); // key -> { at, data }

export function buildProductsCacheKey(req) {
  const q = req.query ?? {};
  const keys = Object.keys(q).sort();
  const parts = keys.map((k) => `${k}=${String(q[k])}`);
  return `/api/products?${parts.join("&")}`;
}

export function setShortCacheHeaders(res) {
  res.setHeader("Cache-Control", "public, max-age=2");
}

export function invalidateProductsCache() {
  productsCache.clear();
}

export function getCachedProducts(cacheKey) {
  const cached = productsCache.get(cacheKey);
  if (!cached) return null;

  const now = Date.now();
  if (now - cached.at >= PRODUCTS_CACHE_TTL_MS) {
    productsCache.delete(cacheKey);
    return null;
  }
  return cached.data;
}

export function setCachedProducts(cacheKey, data) {
  productsCache.set(cacheKey, { at: Date.now(), data });
}