// Лоадер СТАРОЇ (стабільної) версії FalconRoute — встав УСЕ в консоль
(async () => {
    const urls = [
        'https://raw.githubusercontent.com/Smertnik616/my-script/0920b9f/falcon-route-stable.js?t=' + Date.now(),
        'https://cdn.jsdelivr.net/gh/Smertnik616/my-script@0920b9f/falcon-route-stable.js?t=' + Date.now()
    ];
    document.getElementById('falcon-route-ui')?.remove();
    document.getElementById('falcon-route-tip')?.remove();
    document.getElementById('falcon-route-license')?.remove();
    document.getElementById('falcon-route-blocked')?.remove();
    let code = '';
    for (const url of urls) {
        try {
            const res = await fetch(url, { cache: 'no-store' });
            if (!res.ok) continue;
            const text = await res.text();
            if (text.includes('FALCONROUTE') && text.includes('fr-flight-place') && text.includes('stable-aim-label-h-23')) {
                code = text;
                break;
            }
        } catch (_) {}
    }
    if (!code) {
        alert('Не вдалося завантажити FalconRoute STABLE');
        return;
    }
    const s = document.createElement('script');
    s.textContent = code + '\n//# sourceURL=falcon-route-stable.js';
    document.documentElement.appendChild(s);
    console.log('🦅 FalconRoute STABLE OK');
})();
