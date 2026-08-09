// Вставте ЦЕЙ код у консоль на сторінці карти:
(async () => {
    // Закріплений коміт з новими фічами (збиття / коридор / фільтри)
    const COMMIT = '8d96d76';
    const bust = Date.now();
    const urls = [
        `https://cdn.jsdelivr.net/gh/Smertnik616/my-script@${COMMIT}/falcon-route.js?v=${bust}`,
        `https://raw.githubusercontent.com/Smertnik616/my-script/${COMMIT}/falcon-route.js?v=${bust}`,
        `https://cdn.jsdelivr.net/gh/Smertnik616/my-script@main/falcon-route.js?v=${bust}`,
        `https://raw.githubusercontent.com/Smertnik616/my-script/main/falcon-route.js?v=${bust}`
    ];

    // Прибрати стару панель, якщо лишилась від попереднього запуску
    document.getElementById('falcon-route-ui')?.remove();
    document.getElementById('falcon-route-tip')?.remove();

    let code = '';
    let from = '';
    for (const url of urls) {
        try {
            const res = await fetch(url, { cache: 'no-store' });
            if (!res.ok) continue;
            const text = await res.text();
            // Обовʼязкові маркери НОВОЇ версії
            if (
                text.includes('getGoogleMap')
                && text.includes('fr-corridor')
                && text.includes('FALCONROUTE (Збиття)')
            ) {
                code = text;
                from = url;
                break;
            }
        } catch (_) { /* try next */ }
    }

    if (!code) {
        alert('Не вдалося завантажити НОВИЙ falcon-route.js (з коридором/засобами).\nСпробуй ще раз або перевір мережу/CDN.');
        return;
    }

    const s = document.createElement('script');
    s.textContent = code + '\n//# sourceURL=falcon-route.js';
    document.documentElement.appendChild(s);
    console.log('🦅 FalconRoute loader: NEW OK', COMMIT, from);
})();
