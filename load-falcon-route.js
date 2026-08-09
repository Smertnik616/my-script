// Вставте ЦЕЙ код у консоль на сторінці карти:
(async () => {
    // Закріплений коміт — без старого кешу CDN
    const urls = [
        'https://cdn.jsdelivr.net/gh/Smertnik616/my-script@aef39be/falcon-route.js',
        'https://cdn.jsdelivr.net/gh/Smertnik616/my-script@main/falcon-route.js?v=' + Date.now()
    ];

    let code = '';
    for (const url of urls) {
        try {
            const res = await fetch(url, { cache: 'no-store' });
            if (!res.ok) continue;
            code = await res.text();
            if (code.includes('getGoogleMap') && !code.includes('Обʼєкт Cesium не знайдено')) break;
            code = '';
        } catch (_) { /* try next */ }
    }

    if (!code) {
        alert('Не вдалося завантажити свіжий falcon-route.js');
        return;
    }

    const s = document.createElement('script');
    s.textContent = code + '\n//# sourceURL=falcon-route.js';
    document.documentElement.appendChild(s);
    console.log('🦅 FalconRoute loader: OK (fresh)');
})();
