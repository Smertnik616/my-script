(function () {
    'use strict';

    // ========== Конфіг Firebase ==========
    const DB_URL = 'https://script-poi-default-rtdb.europe-west1.firebasedatabase.app/rooms/falcon-route-default/points.json';
    const FIREBASE_ENABLED = !DB_URL.includes('ВАШ_ПРОЄКТ');
    const STORAGE_KEY = 'cesium_falcon_route_points_v1';
    const MAX_BOOT_ATTEMPTS = 40; // ~20 с очікування карти (як у R2D2-аналога)

    // ---------- Детектор Google Maps (Phoenix / R2D2) ----------
    function isGoogleMap(obj) {
        return obj != null
            && typeof obj === 'object'
            && typeof obj.getZoom === 'function'
            && typeof obj.getBounds === 'function'
            && typeof obj.addListener === 'function';
    }

    function findGoogleMapInFiber(rootNode) {
        if (!rootNode) return null;
        const queue = [rootNode.current || rootNode];
        const seen = new WeakSet();

        while (queue.length) {
            const node = queue.shift();
            if (!node || seen.has(node)) continue;
            seen.add(node);

            // React hooks linked list
            if (node.memoizedState && 'next' in node.memoizedState) {
                let hook = node.memoizedState;
                while (hook) {
                    if (isGoogleMap(hook.memoizedState)) return hook.memoizedState;
                    if (hook.memoizedState && isGoogleMap(hook.memoizedState.map)) {
                        return hook.memoizedState.map;
                    }
                    hook = hook.next;
                }
            }

            // Прямий state з .map
            if (node.memoizedState && !('next' in node.memoizedState) && isGoogleMap(node.memoizedState.map)) {
                return node.memoizedState.map;
            }

            if (node.memoizedProps) {
                if (isGoogleMap(node.memoizedProps.map)) return node.memoizedProps.map;
                if (isGoogleMap(node.memoizedProps.googleMap)) return node.memoizedProps.googleMap;
            }

            if (node.stateNode) {
                if (isGoogleMap(node.stateNode.map)) return node.stateNode.map;
                if (isGoogleMap(node.stateNode)) return node.stateNode;
            }

            if (node.child) queue.push(node.child);
            if (node.sibling) queue.push(node.sibling);
        }
        return null;
    }

    function findGoogleMapFromDomNode(startEl) {
        let el = startEl;
        while (el && el !== document.body && el !== document.documentElement) {
            for (const key of Object.keys(el)) {
                try {
                    const val = el[key];
                    if (isGoogleMap(val)) return val;
                    if (val && isGoogleMap(val.map)) return val.map;
                    if (val && isGoogleMap(val.__gm?.map)) return val.__gm.map;
                } catch (_) { /* ignore */ }
            }

            const fiberKey = Object.keys(el).find(k =>
                k.startsWith('__reactFiber$') || k.startsWith('__reactContainer')
            );
            if (fiberKey) {
                const found = findGoogleMapInFiber(el[fiberKey]);
                if (found) return found;
            }
            el = el.parentElement;
        }
        return null;
    }

    function getGoogleMap() {
        if (!window.google?.maps?.Map) return null;

        // Глобальні змінні
        const globals = [
            window.map, window.googleMap, window.r2d2Map, window.gMap,
            window.__map, window.mapInstance, window.MAP
        ];
        for (const g of globals) {
            if (isGoogleMap(g)) return g;
        }

        // React root (#root / #app / #__next) — основний шлях Phoenix / R2D2
        for (const id of ['root', 'app', '__next', 'main']) {
            const root = document.getElementById(id);
            if (!root) continue;
            const key = Object.keys(root).find(k => k.startsWith('__reactContainer'))
                || Object.keys(root).find(k => k.startsWith('__reactFiber'));
            if (key) {
                const found = findGoogleMapInFiber(root[key]);
                if (found) return found;
            }
        }

        // Через DOM Google Maps (.gm-style)
        const gm = document.querySelector('.gm-style');
        if (gm) {
            const found = findGoogleMapFromDomNode(gm);
            if (found) return found;
        }

        // Додаткове сканування div з React Fiber
        const elements = document.querySelectorAll('div');
        for (const el of elements) {
            const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
            if (!fiberKey) continue;
            const found = findGoogleMapInFiber(el[fiberKey]);
            if (found) return found;
        }

        return null;
    }

    // ---------- Детектор Cesium ----------
    function getCesiumViewer() {
        if (window.viewer?.entities) return window.viewer;
        if (window.cesiumViewer?.entities) return window.cesiumViewer;
        if (window.r2d2Viewer?.entities) return window.r2d2Viewer;
        if (window.mapViewer?.entities) return window.mapViewer;
        if (window.Cesium?.Viewer?.instances?.[0]?.entities) return window.Cesium.Viewer.instances[0];

        const elements = document.querySelectorAll('div, canvas');
        for (const el of elements) {
            if (el.cesiumViewer?.entities) return el.cesiumViewer;
            if (el._cesiumViewer?.entities) return el._cesiumViewer;

            const reactKeys = Object.keys(el).filter(k =>
                k.startsWith('__reactFiber$') || k.startsWith('__reactProps$')
            );
            for (const rKey of reactKeys) {
                let node = el[rKey];
                let depth = 0;
                while (node && depth < 20) {
                    if (node.memoizedProps?.viewer?.entities) return node.memoizedProps.viewer;
                    if (node.stateNode?.viewer?.entities) return node.stateNode.viewer;
                    if (node.memoizedProps?.cesiumViewer?.entities) return node.memoizedProps.cesiumViewer;
                    node = node.return;
                    depth++;
                }
            }
        }
        return null;
    }

    function detectMapEngine() {
        const gmap = getGoogleMap();
        if (gmap) return { type: 'google', map: gmap };

        const cesium = getCesiumViewer();
        if (cesium) return { type: 'cesium', map: cesium };

        return null;
    }

    // Очікування карти (R2D2 часто ініціалізує Google Maps із затримкою)
    function boot(attempt) {
        const engine = detectMapEngine();
        if (engine) {
            initApp(engine);
            return;
        }
        if (attempt < MAX_BOOT_ATTEMPTS) {
            setTimeout(() => boot(attempt + 1), 500);
            return;
        }
        // Fallback: попросити клік по карті (як у старій інструкції), без старого Cesium-алерту
        console.warn('[FALCONROUTE] Автопошук не знайшов карту. Клацніть один раз по карті...');
        const tip = document.createElement('div');
        tip.id = 'falcon-route-tip';
        tip.textContent = '🦅 FALCONROUTE: клацніть один раз по карті для підключення';
        tip.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:99999999;background:#1e3a8a;color:#fff;padding:10px 14px;border-radius:8px;font:12px/1.3 system-ui;box-shadow:0 4px 16px rgba(0,0,0,.5)';
        document.body.appendChild(tip);

        const onClick = (e) => {
            const fromClick = findGoogleMapFromDomNode(e.target) || getGoogleMap();
            const cesium = getCesiumViewer();
            const found = fromClick
                ? { type: 'google', map: fromClick }
                : (cesium ? { type: 'cesium', map: cesium } : null);

            if (!found) return; // чекаємо наступний клік
            document.removeEventListener('click', onClick, true);
            tip.remove();
            initApp(found);
        };
        document.addEventListener('click', onClick, true);
    }

    function initApp(engine) {
        const mapType = engine.type;
        const map = engine.map;

        let poiStore = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        let overlayObjects = []; // Marker/Circle або Cesium entities
        let isPickMode = false;
        let applyRemote = false;
        let pickListener = null;

        const Cartesian3 = mapType === 'cesium'
            ? map.camera.position.constructor
            : null;

        // ----- UI (TrustedHTML bypass) -----
        document.getElementById('falcon-route-ui')?.remove();

        const panel = document.createElement('div');
        panel.id = 'falcon-route-ui';
        panel.style.cssText = `
            position: fixed; top: 30px; right: 30px; width: 320px;
            background: #181920; color: #e0e0e0; border: 1px solid #383a48;
            border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.7);
            font-family: system-ui, -apple-system, sans-serif; font-size: 12px;
            z-index: 9999999; user-select: none;
        `;

        const htmlLayout = `
            <style>
                .fr-head { background: #222430; padding: 10px 12px; font-weight: bold; color: #4da6ff; display: flex; justify-content: space-between; align-items: center; cursor: move; border-top-left-radius: 8px; border-top-right-radius: 8px; }
                .fr-body { padding: 10px; display: flex; flex-direction: column; gap: 8px; }
                .fr-body.hidden { display: none; }
                .fr-body textarea { width: 100%; height: 65px; background: #0f1015; color: #00ffcc; border: 1px solid #333; border-radius: 4px; padding: 6px; font-family: monospace; box-sizing: border-box; resize: vertical; }
                .fr-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
                .fr-row input, .fr-row select { background: #0f1015; color: #fff; border: 1px solid #333; border-radius: 4px; padding: 4px; }
                .fr-row input[type="number"] { width: 80px; text-align: center; }
                .fr-row select { flex: 1; }
                .fr-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
                .fr-btn { background: #2a2d3d; color: #fff; border: none; padding: 7px; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 11px; }
                .fr-btn:hover { background: #3b82f6; }
                .fr-btn-pick { background: #1e3a8a; color: #60a5fa; border: 1px solid #2563eb; width: 100%; }
                .fr-btn-pick.active { background: #d97706; color: #fff; }
                .fr-btn-danger { background: #451a1a; color: #f87171; }
                .fr-btn-danger:hover { background: #dc2626; color: #fff; }
                .fr-btn-wide { width: 100%; }
                .fr-btn-ok { background: #14532d; color: #86efac; }
                .fr-list { max-height: 110px; overflow-y: auto; background: #0f1015; border: 1px solid #252836; border-radius: 4px; padding: 4px; }
                .fr-item { display: flex; justify-content: space-between; padding: 3px 4px; border-bottom: 1px solid #1a1c26; font-family: monospace; font-size: 11px; }
                .fr-section { border-top: 1px solid #2a2d3d; padding-top: 8px; display: flex; flex-direction: column; gap: 6px; }
                .fr-label { color: #9ca3af; font-size: 11px; }
                .fr-sync { font-size: 10px; color: #6b7280; min-height: 14px; }
                .fr-sync.on { color: #4ade80; }
                .fr-sync.err { color: #f87171; }
            </style>
            <div class="fr-head" id="fr-drag">
                <span>🦅 FALCONROUTE (POI & Radius)</span>
                <span id="fr-toggle" style="cursor:pointer">─</span>
            </div>
            <div class="fr-body" id="fr-main">
                <button class="fr-btn fr-btn-pick" id="fr-pick">🎯 Клацнути на карті</button>
                <textarea id="fr-input" placeholder="Формат координат:&#10;48.4501, 34.9802, 500&#10;48.4612 34.9910"></textarea>
                <div class="fr-row">
                    <label>Радіус за замовчуванням (м):</label>
                    <input type="number" id="fr-default-rad" value="300" step="50">
                </div>
                <div class="fr-grid">
                    <button class="fr-btn" id="fr-add">Побудувати</button>
                    <button class="fr-btn fr-btn-danger" id="fr-clear">Очистити все</button>
                </div>

                <button class="fr-btn fr-btn-wide" id="fr-copy">📋 Скопіювати всі координати</button>

                <div class="fr-section">
                    <span class="fr-label">Експорт / імпорт файлу</span>
                    <div class="fr-row">
                        <label for="fr-format">Формат:</label>
                        <select id="fr-format">
                            <option value="txt">.TXT — список координат</option>
                            <option value="json">.JSON — структуровані дані</option>
                            <option value="geojson" selected>.GEOJSON — картографічний</option>
                        </select>
                    </div>
                    <div class="fr-grid">
                        <button class="fr-btn" id="fr-export">⬇ Завантажити файл</button>
                        <button class="fr-btn" id="fr-import">⬆ Імпортувати</button>
                        <input type="file" id="fr-file" accept=".txt,.json,.geojson" style="display:none">
                    </div>
                </div>

                <div class="fr-list" id="fr-container"></div>
                <div class="fr-sync" id="fr-sync">${FIREBASE_ENABLED ? 'Firebase: підключення…' : 'Локальний режим (без Firebase)'}</div>
            </div>
        `;

        const range = document.createRange();
        range.selectNodeContents(panel);
        panel.appendChild(range.createContextualFragment(htmlLayout));
        document.body.appendChild(panel);

        const syncEl = document.getElementById('fr-sync');
        const mainBody = document.getElementById('fr-main');
        document.getElementById('fr-toggle').onclick = () => mainBody.classList.toggle('hidden');

        let isDragging = false, ox = 0, oy = 0;
        document.getElementById('fr-drag').onmousedown = (e) => {
            isDragging = true;
            ox = e.clientX - panel.offsetLeft;
            oy = e.clientY - panel.offsetTop;
        };
        document.onmousemove = (e) => {
            if (isDragging) {
                panel.style.left = (e.clientX - ox) + 'px';
                panel.style.top = (e.clientY - oy) + 'px';
                panel.style.right = 'auto';
            }
        };
        document.onmouseup = () => { isDragging = false; };

        // ----- Формати -----
        function formatTxt(points) {
            return points.map(p => `${p.lat}, ${p.lon}, ${p.radius}`).join('\n');
        }

        function formatJson(points) {
            return JSON.stringify({
                type: 'FalconRoutePoints',
                version: 1,
                exportedAt: new Date().toISOString(),
                points: points.map(p => ({
                    id: p.id, lat: p.lat, lon: p.lon, radius: p.radius
                }))
            }, null, 2);
        }

        function formatGeoJson(points) {
            return JSON.stringify({
                type: 'FeatureCollection',
                features: points.map(p => ({
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
                    properties: { id: p.id, radius: p.radius }
                }))
            }, null, 2);
        }

        function parseTxt(text) {
            const defaultRad = parseFloat(document.getElementById('fr-default-rad').value) || 300;
            const points = [];
            text.split('\n').forEach(line => {
                let clean = line.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ' ').trim();
                if (!clean || clean.startsWith('#')) return;
                clean = clean.replace(/(\d+),(\d+)/g, '$1.$2').replace(/[,;/]/g, ' ');
                const m = clean.match(/-?\d+(?:\.\d+)?/g);
                if (m && m.length >= 2) {
                    const lat = parseFloat(m[0]);
                    const lon = parseFloat(m[1]);
                    const radius = m[2] ? parseFloat(m[2]) : defaultRad;
                    if (!isNaN(lat) && !isNaN(lon)) {
                        points.push({ id: Date.now() + Math.random(), lat, lon, radius });
                    }
                }
            });
            return points;
        }

        function parseImportedPayload(text, fileName) {
            const lower = (fileName || '').toLowerCase();
            const trimmed = text.trim();

            if (lower.endsWith('.txt') || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
                return parseTxt(text);
            }

            const json = JSON.parse(text);

            if (json.type === 'FeatureCollection' && Array.isArray(json.features)) {
                return json.features.map(f => ({
                    id: f.properties?.id || (Date.now() + Math.random()),
                    lat: f.geometry.coordinates[1],
                    lon: f.geometry.coordinates[0],
                    radius: f.properties?.radius || 300
                }));
            }

            if (json.type === 'FalconRoutePoints' && Array.isArray(json.points)) {
                return json.points.map(p => ({
                    id: p.id || (Date.now() + Math.random()),
                    lat: p.lat,
                    lon: p.lon,
                    radius: p.radius || 300
                }));
            }

            if (Array.isArray(json)) {
                return json.map(p => ({
                    id: p.id || (Date.now() + Math.random()),
                    lat: p.lat,
                    lon: p.lon,
                    radius: p.radius || 300
                }));
            }

            throw new Error('Невідомий формат файлу');
        }

        // ----- Firebase -----
        async function pushToFirebase(points) {
            if (!FIREBASE_ENABLED || applyRemote) return;
            try {
                const res = await fetch(DB_URL, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(points)
                });
                const bodyText = await res.text();
                let bodyJson = null;
                try { bodyJson = JSON.parse(bodyText); } catch (_) { /* ignore */ }

                if (!res.ok || bodyJson?.error) {
                    const errMsg = bodyJson?.error || `HTTP ${res.status}`;
                    if (String(errMsg).toLowerCase().includes('permission')) {
                        syncEl.textContent = 'Firebase: немає доступу (перевір Rules)';
                    } else {
                        syncEl.textContent = 'Firebase: помилка запису';
                    }
                    syncEl.className = 'fr-sync err';
                    console.warn('[FALCONROUTE] Firebase PUT failed:', errMsg);
                    return;
                }
                syncEl.textContent = 'Firebase: синхронізовано';
                syncEl.className = 'fr-sync on';
            } catch (err) {
                syncEl.textContent = 'Firebase: помилка мережі';
                syncEl.className = 'fr-sync err';
                console.warn('[FALCONROUTE] Firebase PUT failed:', err);
            }
        }

        // ----- Малювання на карті -----
        function clearOverlays() {
            if (mapType === 'google') {
                overlayObjects.forEach(obj => {
                    try { obj.setMap(null); } catch (_) { /* ignore */ }
                });
            } else {
                overlayObjects.forEach(ent => {
                    try { map.entities.remove(ent); } catch (_) { /* ignore */ }
                });
            }
            overlayObjects = [];
        }

        function renderMap() {
            clearOverlays();

            if (mapType === 'google') {
                poiStore.forEach((pt, idx) => {
                    const position = { lat: pt.lat, lng: pt.lon };

                    const marker = new google.maps.Marker({
                        position,
                        map,
                        label: {
                            text: String(idx + 1),
                            color: '#000',
                            fontSize: '10px',
                            fontWeight: 'bold'
                        },
                        icon: {
                            path: google.maps.SymbolPath.CIRCLE,
                            scale: 10,
                            fillColor: '#ef4444',
                            fillOpacity: 1,
                            strokeColor: '#fff',
                            strokeWeight: 1.5
                        },
                        title: `POI ${idx + 1}`,
                        zIndex: 150
                    });

                    const circle = new google.maps.Circle({
                        map,
                        center: position,
                        radius: Number(pt.radius) || 300,
                        strokeColor: '#ef4444',
                        strokeOpacity: 0.9,
                        strokeWeight: 2,
                        fillColor: '#ef4444',
                        fillOpacity: 0.2,
                        clickable: false,
                        zIndex: 140
                    });

                    overlayObjects.push(marker, circle);
                });
                return;
            }

            // Cesium
            poiStore.forEach(pt => {
                const redColor = { red: 1, green: 0, blue: 0, alpha: 1 };
                const redFill = { red: 1, green: 0, blue: 0, alpha: 0.25 };
                const whiteColor = { red: 1, green: 1, blue: 1, alpha: 1 };

                const entity = map.entities.add({
                    position: Cartesian3.fromDegrees(pt.lon, pt.lat),
                    point: { pixelSize: 8, color: redColor, outlineColor: whiteColor, outlineWidth: 2 },
                    ellipse: {
                        semiMinorAxis: pt.radius,
                        semiMajorAxis: pt.radius,
                        material: redFill,
                        outline: true,
                        outlineColor: redColor,
                        outlineWidth: 2
                    }
                });
                overlayObjects.push(entity);
            });
            map.scene?.requestRender?.();
        }

        function saveData(data) {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
            poiStore = data;
            renderList();
            renderMap();
            pushToFirebase(data);
        }

        function renderList() {
            const container = document.getElementById('fr-container');
            while (container.firstChild) container.removeChild(container.firstChild);

            poiStore.forEach((pt, i) => {
                const item = document.createElement('div');
                item.className = 'fr-item';

                const label = document.createElement('span');
                label.textContent = `#${i + 1}: ${pt.lat.toFixed(4)}, ${pt.lon.toFixed(4)} (${pt.radius}м)`;

                const del = document.createElement('span');
                del.textContent = '✕';
                del.style.cssText = 'color:#f87171;cursor:pointer;font-weight:bold';
                del.onclick = () => saveData(poiStore.filter(p => p.id !== pt.id));

                item.appendChild(label);
                item.appendChild(del);
                container.appendChild(item);
            });
        }

        function stopPickMode() {
            isPickMode = false;
            pickBtn.classList.remove('active');
            pickBtn.textContent = '🎯 Клацнути на карті';

            if (pickListener) {
                if (mapType === 'google') {
                    google.maps.event.removeListener(pickListener);
                } else if (map.canvas) {
                    map.canvas.removeEventListener('click', pickListener);
                }
                pickListener = null;
            }
        }

        function addPointAt(lat, lon) {
            const rad = parseFloat(document.getElementById('fr-default-rad').value) || 300;
            saveData([...poiStore, { id: Date.now() + Math.random(), lat, lon, radius: rad }]);
        }

        // ----- Події UI -----
        document.getElementById('fr-add').onclick = () => {
            const text = document.getElementById('fr-input').value;
            const newPoints = parseTxt(text);
            if (newPoints.length) {
                saveData([...poiStore, ...newPoints]);
                document.getElementById('fr-input').value = '';
            }
        };

        document.getElementById('fr-clear').onclick = () => {
            if (confirm('Видалити всі точки?')) saveData([]);
        };

        const copyBtn = document.getElementById('fr-copy');
        const COPY_LABEL = '📋 Скопіювати всі координати';
        copyBtn.onclick = async () => {
            if (!poiStore.length) {
                alert('Немає збережених точок для копіювання.');
                return;
            }
            const text = formatTxt(poiStore);
            try {
                await navigator.clipboard.writeText(text);
                copyBtn.textContent = '✅ Скопійовано!';
                copyBtn.classList.add('fr-btn-ok');
                setTimeout(() => {
                    copyBtn.textContent = COPY_LABEL;
                    copyBtn.classList.remove('fr-btn-ok');
                }, 2000);
            } catch (err) {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
                document.body.appendChild(ta);
                ta.select();
                try {
                    document.execCommand('copy');
                    copyBtn.textContent = '✅ Скопійовано!';
                    copyBtn.classList.add('fr-btn-ok');
                    setTimeout(() => {
                        copyBtn.textContent = COPY_LABEL;
                        copyBtn.classList.remove('fr-btn-ok');
                    }, 2000);
                } catch (e2) {
                    alert('Не вдалося скопіювати в буфер обміну.');
                }
                document.body.removeChild(ta);
            }
        };

        const pickBtn = document.getElementById('fr-pick');
        pickBtn.onclick = () => {
            if (isPickMode) {
                stopPickMode();
                return;
            }

            isPickMode = true;
            pickBtn.classList.add('active');
            pickBtn.textContent = '👆 Клацніть у будь-якій точці карти...';

            if (mapType === 'google') {
                pickListener = map.addListener('click', (e) => {
                    if (!e?.latLng) return;
                    const lat = e.latLng.lat();
                    const lon = e.latLng.lng();
                    addPointAt(lat, lon);
                    stopPickMode();
                });
            } else {
                pickListener = (e) => {
                    const rect = map.canvas.getBoundingClientRect();
                    const clickPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
                    const cartesian = map.camera.pickEllipsoid(clickPos, map.scene.globe.ellipsoid);
                    if (cartesian) {
                        const cartographic = map.scene.globe.ellipsoid.cartesianToCartographic(cartesian);
                        const lat = cartographic.latitude * 57.29577951308232;
                        const lon = cartographic.longitude * 57.29577951308232;
                        addPointAt(lat, lon);
                    }
                    stopPickMode();
                };
                map.canvas.addEventListener('click', pickListener, { once: true });
            }
        };

        document.getElementById('fr-export').onclick = () => {
            if (!poiStore.length) {
                alert('Немає точок для експорту.');
                return;
            }

            const format = document.getElementById('fr-format').value;
            const date = new Date().toISOString().slice(0, 10);
            let content = '';
            let mime = 'text/plain';
            let ext = 'txt';

            if (format === 'json') {
                content = formatJson(poiStore);
                mime = 'application/json';
                ext = 'json';
            } else if (format === 'geojson') {
                content = formatGeoJson(poiStore);
                mime = 'application/geo+json';
                ext = 'geojson';
            } else {
                content = formatTxt(poiStore);
            }

            const blob = new Blob([content], { type: mime });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `falcon_route_poi_${date}.${ext}`;
            a.click();
            URL.revokeObjectURL(a.href);
        };

        const fileInput = document.getElementById('fr-file');
        document.getElementById('fr-import').onclick = () => fileInput.click();
        fileInput.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (evt) => {
                try {
                    const imported = parseImportedPayload(evt.target.result, file.name);
                    if (!imported.length) {
                        alert('У файлі не знайдено валідних точок.');
                        return;
                    }
                    saveData([...poiStore, ...imported]);
                } catch (err) {
                    console.warn(err);
                    alert('Помилка зчитування файлу (підтримуються .txt, .json, .geojson)');
                }
                fileInput.value = '';
            };
            reader.readAsText(file);
        };

        function listenToCloudUpdates() {
            if (DB_URL.includes('ВАШ_ПРОЄКТ')) return;

            const eventSource = new EventSource(DB_URL);

            eventSource.addEventListener('put', (e) => {
                try {
                    const res = JSON.parse(e.data);
                    if (res && res.data) {
                        applyRemote = true;
                        poiStore = Array.isArray(res.data) ? res.data : Object.values(res.data);
                        localStorage.setItem(STORAGE_KEY, JSON.stringify(poiStore));
                        renderList();
                        renderMap();
                        applyRemote = false;
                        syncEl.textContent = 'Firebase: онлайн';
                        syncEl.className = 'fr-sync on';
                    } else if (res && res.data === null) {
                        applyRemote = true;
                        poiStore = [];
                        localStorage.setItem(STORAGE_KEY, JSON.stringify(poiStore));
                        renderList();
                        renderMap();
                        applyRemote = false;
                        syncEl.textContent = 'Firebase: онлайн';
                        syncEl.className = 'fr-sync on';
                    }
                } catch (err) {
                    console.error('Помилка синхронізації Firebase:', err);
                }
            });

            eventSource.onopen = () => {
                syncEl.textContent = 'Firebase: онлайн';
                syncEl.className = 'fr-sync on';
            };

            eventSource.onerror = () => {
                syncEl.textContent = 'Firebase: перепідключення…';
                syncEl.className = 'fr-sync err';
            };
        }

        renderList();
        renderMap();
        listenToCloudUpdates();
        console.log(`🦅 FALCONROUTE завантажено успішно! (${mapType === 'google' ? 'Google Maps / R2D2' : 'Cesium'})`);
    }

    boot(0);
})();
