// ══════════════════════════════════════════════
// FALCONROUTE v2 — скопіюй ВЕСЬ цей короткий файл у консоль
// Після запуску має зʼявитись alert: «FALCONROUTE v2 OK»
// ══════════════════════════════════════════════
(async () => {
    const COMMIT = '4610e6c';
    const urls = [
        `https://raw.githubusercontent.com/Smertnik616/my-script/${COMMIT}/falcon-route.js?t=${Date.now()}`,
        `https://cdn.jsdelivr.net/gh/Smertnik616/my-script@${COMMIT}/falcon-route.js?t=${Date.now()}`
    ];

    document.getElementById('falcon-route-ui')?.remove();
    document.getElementById('falcon-route-tip')?.remove();

    let code = '';
    let from = '';
    for (const url of urls) {
        try {
            const res = await fetch(url, { cache: 'no-store', mode: 'cors' });
            if (!res.ok) continue;
            const text = await res.text();
            if (text.includes('FALCONROUTE v2') && text.includes('fr-corridor')) {
                code = text;
                from = url;
                break;
            }
        } catch (err) {
            console.warn('FalconRoute fetch fail:', url, err);
        }
    }

    if (!code) {
        alert('❌ Не вдалося завантажити FALCONROUTE v2.\nДивись помилки fetch у консолі (CSP/мережа).');
        return;
    }

    const s = document.createElement('script');
    s.textContent = code + '\n//# sourceURL=falcon-route-v2.js';
    document.documentElement.appendChild(s);

    console.log('🦅 FalconRoute v2 loader OK from', from);
    alert('✅ FALCONROUTE v2 OK\nЗаголовок панелі має бути: FALCONROUTE v2 (Збиття)');
})();
