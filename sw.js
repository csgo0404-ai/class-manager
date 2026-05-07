// 우리반 매니저 Service Worker — 트래픽 절감 캐시
// 전략: stale-while-revalidate (캐시 우선 즉시 응답 + 백그라운드 갱신)

const CACHE_VERSION = 'v30';
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
            // CDN(cross-origin) 자원은 no-cors로 요청해야 opaque response를 받아 캐시 가능
            Promise.all(PRECACHE.map(u => {
                const req = /^https?:\/\//.test(u) ? new Request(u, { mode: 'no-cors' }) : u;
                return cache.add(req).catch(() => {});
            }))
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
            // 알림만 보내고 reload는 안 함 — c.navigate()로 강제 reload 시 첫 로드 직후 더블 리로드가 생겨
            // 진행 중인 저장(특히 칠판 디바운스)이 날아감. HTML은 networkFirst라 다음 새로고침에서 자동 갱신됨.
            clients.forEach((c) => {
                try { c.postMessage({ type: 'SW_UPDATED', version: CACHE_VERSION }); } catch(_){}
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

    // Firebase Storage 이미지 캐시 (아바타·뱃지·펫 등)
    if (url.hostname === 'firebasestorage.googleapis.com' || url.hostname.endsWith('.firebasestorage.app')) {
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
// fetch 옵션 미지정 → 브라우저 HTTP 캐시(Cache-Control max-age) 정상 활용
// max-age 안: 네트워크 요청 0 (트래픽 100% 절감)
// max-age 후: ETag 검증, 304면 본문 미전송 (트래픽 ~수백 바이트만)
// 서버에서 Cache-Control 헤더 설정 시 효과 극대화 (Cloudflare Pages의 _headers 파일 활용)
async function networkFirst(req) {
    const cache = await caches.open(CACHE_NAME);
    try {
        const res = await fetch(req);
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
