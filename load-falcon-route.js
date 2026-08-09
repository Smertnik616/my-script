// Вставте ЦЕЙ код у консоль на сторінці карти:
(async () => {
    // Спочатку свіжий main (без кешу), потім запасний URL
    const urls = [
        'https://cdn.jsdelivr.net/gh/Smertnik616/my-script@main/falcon-route.js?v=' + Date.now(),
        'https://raw.githubusercontent.com/Smertnik616/my-script/main/falcon-route.js?v=' + Date.now()
    ];

    let code = '';
    for (const url of urls) {
        try {
            const res = await fetch(url, { cache: 'no-store' });
            if (!res.ok) continue;
            code = await res.text();
            if (code.includes('getGoogleMap') && code.includes('FALCONROUTE')) break;
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
