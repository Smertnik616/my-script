// Вставте ЦЕЙ код у консоль на сторінці карти (обхід кешу CDN):
(async () => {
    const url = 'https://raw.githubusercontent.com/Smertnik616/my-script/main/falcon-route.js?t=' + Date.now();
    const code = await (await fetch(url)).text();
    if (!code || code.includes('Обʼєкт Cesium не знайдено')) {
        alert('Завантажилась стара версія скрипта. Оновіть сторінку GitHub / спробуйте ще раз.');
        return;
    }
    const s = document.createElement('script');
    s.textContent = code;
    document.documentElement.appendChild(s);
    console.log('🦅 FalconRoute loader: injected fresh build');
})();
