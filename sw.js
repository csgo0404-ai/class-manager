// 우리반 매니저 Service Worker — 트래픽 절감 캐시
// 전략: stale-while-revalidate (캐시 우선 즉시 응답 + 백그라운드 갱신)

const CACHE_VERSION = 'v8';
const CACHE_NAME = `wclass-${CACHE_VERSION}`;

// 미리 캐시할 자원 (로컬 우선, CDN은 폴백 시 후처리됨)
const PRECACHE = [
    './libs/vue.global.prod.js',
    './libs/vue.esm-browser.prod.js',
    './libs/lunar.js',
    'https://cdn.tailwindcss.com',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css',
];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) =>
            // 일부 CORS 실패해도 무시
            Promise.all(PRECACHE.map(u => cache.add(u).catch(() => {})))
        )
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
        .then(() => self.clients.matchAll({ type: 'window' }))
        .then((clients) => {
            // 새 버전 활성화 직후 모든 열린 클라이언트에 reload 메시지 + 직접 navigate (구버전 HTML이 자동 갱신되도록)
            clients.forEach((c) => {
                try { c.postMessage({ type: 'SW_UPDATED', version: CACHE_VERSION }); } catch(_){}
                try { if(c.url && c.navigate) c.navigate(c.url); } catch(_){}
            });
        })
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    // Firebase 실시간 통신은 절대 캐시하지 않음
    if (url.hostname.endsWith('firebaseio.com')) return;
    if (url.hostname.endsWith('firebasedatabase.app')) return;
    if (url.hostname.includes('googleapis.com') && !url.hostname.startsWith('fonts')) return;
    // Firebase JS SDK는 캐시 OK
    if (url.hostname === 'www.gstatic.com' && url.pathname.includes('/firebasejs/')) {
        event.respondWith(staleWhileRevalidate(req));
        return;
    }

    // GitHub raw 이미지(이모지 등) 캐시
    if (url.hostname === 'raw.githubusercontent.com') {
        event.respondWith(staleWhileRevalidate(req));
        return;
    }

    // Google Fonts CSS/WOFF 캐시
    if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
        event.respondWith(staleWhileRevalidate(req));
        return;
    }

    // CDN 캐시
    if (
        url.hostname === 'cdn.tailwindcss.com' ||
        url.hostname === 'unpkg.com' ||
        url.hostname === 'cdn.jsdelivr.net' ||
        url.hostname === 'cdnjs.cloudflare.com'
    ) {
        event.respondWith(staleWhileRevalidate(req));
        return;
    }

    // 같은 origin
    if (url.origin === self.location.origin) {
        // HTML 본체 / 네비게이션 요청은 네트워크 우선 (옛 버전이 박히는 문제 방지)
        const isHtml = req.mode === 'navigate'
            || url.pathname.endsWith('.html')
            || url.pathname.endsWith('/')
            || (req.headers.get('accept') || '').includes('text/html');
        if (isHtml) {
            event.respondWith(networkFirst(req));
            return;
        }
        // 그 외 (JS/CSS/이미지 등) — stale-while-revalidate
        event.respondWith(staleWhileRevalidate(req));
        return;
    }
});

// 네트워크 우선 + 캐시 폴백 (HTML 전용)
async function networkFirst(req) {
    const cache = await caches.open(CACHE_NAME);
    try {
        const res = await fetch(req, { cache: 'no-store' });
        if (res && res.status === 200) cache.put(req, res.clone()).catch(()=>{});
        return res;
    } catch (e) {
        const cached = await cache.match(req);
        return cached || Response.error();
    }
}

// 캐시 우선 + 백그라운드 갱신
async function staleWhileRevalidate(req) {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    const fetchPromise = fetch(req).then((res) => {
        if (res && (res.status === 200 || res.type === 'opaque')) {
            cache.put(req, res.clone()).catch(() => {});
        }
        return res;
    }).catch(() => cached);
    return cached || fetchPromise;
}

// 메시지 받아 캐시 즉시 비우기 (강제 갱신용)
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'CLEAR_CACHE') {
        caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))));
    }
});
