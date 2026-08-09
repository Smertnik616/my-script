// Вставте цей код у консоль на сторінці карти (Phoenix / R2D2):
const script = document.createElement('script');
script.src = 'https://cdn.jsdelivr.net/gh/Smertnik616/my-script@main/falcon-route.js';
script.onload = () => console.log('🦅 FalconRoute loader: OK');
script.onerror = () => {
    // fallback на raw.githubusercontent.com
    const s2 = document.createElement('script');
    s2.src = 'https://raw.githubusercontent.com/Smertnik616/my-script/main/falcon-route.js';
    document.body.appendChild(s2);
};
document.body.appendChild(script);
