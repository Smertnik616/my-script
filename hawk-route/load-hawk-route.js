// Короткий лоадер HAWKROUTE v2 — встав УСЕ в консоль
(async () => {
    const urls = [
        'https://raw.githubusercontent.com/Smertnik616/my-script/a458718/hawk-route/hawk-route.js?t=' + Date.now(),
        'https://cdn.jsdelivr.net/gh/Smertnik616/my-script@a458718/hawk-route/hawk-route.js?t=' + Date.now()
    ];
    document.getElementById('hawk-route-ui')?.remove();
    let code = '';
    for (const url of urls) {
        try {
            const res = await fetch(url, { cache: 'no-store' });
            if (!res.ok) continue;
            const text = await res.text();
            if (text.includes('HAWKROUTE v2') && text.includes('fr-flight-place') && text.includes('fr-ruler')) {
                code = text;
                break;
            }
        } catch (_) {}
    }
    if (!code) {
        alert('Не вдалося завантажити HAWKROUTE v2');
        return;
    }
    const s = document.createElement('script');
    s.textContent = code + '\n//# sourceURL=hawk-route-v2.js';
    document.documentElement.appendChild(s);
    console.log('🪶 HawkRoute v2 OK');
})();
