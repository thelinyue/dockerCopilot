const CACHE_NAME = 'docker-copilot-v3';
const urlsToCache = [
  '/',
  '/index.html',
  '/logo.png',
  '/logo-192.png',
  '/logo-maskable.png',
  '/favicon.png',
  '/apple-touch-icon.png',
  '/manifest.json'
];

// 安装事件
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return cache.addAll(urlsToCache);
      })
      .catch(err => {
        console.log('Cache open failed:', err);
      })
  );
  self.skipWaiting();
});

// 激活事件
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName.startsWith('docker-copilot-') && cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 获取事件
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const navigation = event.request.mode === 'navigate';
  const staticAsset = url.pathname.startsWith('/assets/') || url.pathname.startsWith('/manager/assets/') || urlsToCache.includes(url.pathname);
  // 业务接口包含认证和设备信息，必须访问网络；缓存键不会按设备选择头自动隔离。
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || (!navigation && !staticAsset)) {
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    // 页面优先读取网络，避免应用更新后持续加载旧入口；离线时仍可显示已有页面。
    if (navigation) {
      try {
        const response = await fetch(event.request);
        if (response.ok) await cache.put('/index.html', response.clone());
        return response;
      } catch (error) {
        const response = await cache.match('/index.html');
        if (response) return response;
        throw error;
      }
    }
    const cached = await cache.match(event.request);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response.status === 200 && response.type === 'basic') {
      await cache.put(event.request, response.clone());
    }
    return response;
  })());
});
