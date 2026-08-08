(function () {
    'use strict';

    // 1. Пошук об'єкта Cesium Viewer (підтримка SPA/React/Vue/Fiber)
    function getViewer() {
        if (window.viewer?.entities) return window.viewer;
        if (window.cesiumViewer?.entities) return window.cesiumViewer;

        const allElements = document.querySelectorAll('*');
        for (let el of allElements) {
            if (el.cesiumViewer?.entities) return el.cesiumViewer;
            if (el._cesiumViewer?.entities) return el._cesiumViewer;

            const reactKeys = Object.keys(el).filter(k => k.startsWith('__reactFiber$') || k.startsWith('__reactProps$'));
            for (let rKey of reactKeys) {
                let node = el[rKey];
                let depth = 0;
                while (node && depth < 15) {
                    if (node.memoizedProps?.viewer?.entities) return node.memoizedProps.viewer;
                    if (node.stateNode?.viewer?.entities) return node.stateNode.viewer;
                    node = node.return;
                    depth++;
                }
            }
        }
        return null;
    }

    const viewer = getViewer();
    if (!viewer) {
        alert('❌ Помилка: Обʼєкт Cesium не знайдено на сторінці. Спробуйте клацнути по карті мишкою та запустити скрипт знову.');
        return;
    }

    // 2. Ініціалізація даних та класів Cesium
    const STORAGE_KEY = 'cesium_falcon_route_points_v1';
    let poiStore = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    let addedEntities = [];
    let isPickMode = false;

    const Cartesian3 = viewer.camera.position.constructor;
    const Color = viewer.scene.backgroundColor?.constructor || function(r, g, b, a) {
        return { red: r, green: g, blue: b, alpha: a };
    };

    // 3. Безпечне створення UI (Обхід TrustedHTML)
    document.getElementById('falcon-route-ui')?.remove();

    const panel = document.createElement('div');
    panel.id = 'falcon-route-ui';
    panel.style.cssText = `
        position: fixed; top: 30px; right: 30px; width: 310px;
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
            .fr-row { display: flex; justify-content: space-between; align-items: center; }
            .fr-row input { width: 80px; background: #0f1015; color: #fff; border: 1px solid #333; border-radius: 4px; padding: 4px; text-align: center; }
            .fr-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
            .fr-btn { background: #2a2d3d; color: #fff; border: none; padding: 7px; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 11px; }
            .fr-btn:hover { background: #3b82f6; }
            .fr-btn-pick { background: #1e3a8a; color: #60a5fa; border: 1px solid #2563eb; width: 100%; }
            .fr-btn-pick.active { background: #d97706; color: #fff; }
            .fr-btn-danger { background: #451a1a; color: #f87171; }
            .fr-btn-danger:hover { background: #dc2626; color: #fff; }
            .fr-list { max-height: 110px; overflow-y: auto; background: #0f1015; border: 1px solid #252836; border-radius: 4px; padding: 4px; }
            .fr-item { display: flex; justify-content: space-between; padding: 3px 4px; border-bottom: 1px solid #1a1c26; font-family: monospace; font-size: 11px; }
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
            <div class="fr-grid">
                <button class="fr-btn" id="fr-export">Зберегти файл</button>
                <button class="fr-btn" id="fr-import">Завантажити</button>
                <input type="file" id="fr-file" accept=".json,.geojson" style="display:none">
            </div>
            <div class="fr-list" id="fr-container"></div>
        </div>
    `;

    // Використання createContextualFragment для обходу TrustedHTML
    const range = document.createRange();
    range.selectNodeContents(panel);
    panel.appendChild(range.createContextualFragment(htmlLayout));
    document.body.appendChild(panel);

    // 4. Логіка перетягування панелі та згортання
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
    document.onmouseup = () => isDragging = false;

    // 5. Відмальовування об'єктів у Cesium
    function renderCesium() {
        addedEntities.forEach(ent => viewer.entities.remove(ent));
        addedEntities = [];

        poiStore.forEach(pt => {
            const redColor = { red: 1, green: 0, blue: 0, alpha: 1 };
            const redFill = { red: 1, green: 0, blue: 0, alpha: 0.25 };
            const whiteColor = { red: 1, green: 1, blue: 1, alpha: 1 };

            const entity = viewer.entities.add({
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
            addedEntities.push(entity);
        });
        viewer.scene.requestRender?.();
    }

    // 6. Управління стан-даними
    function saveData(data) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        poiStore = data;
        renderList();
        renderCesium();
    }

    function renderList() {
        const container = document.getElementById('fr-container');
        container.innerHTML = '';
        poiStore.forEach((pt, i) => {
            const item = document.createElement('div');
            item.className = 'fr-item';
            item.innerHTML = `<span>#${i + 1}: ${pt.lat.toFixed(4)}, ${pt.lon.toFixed(4)} (${pt.radius}м)</span>
                              <span style="color:#f87171;cursor:pointer;font-weight:bold">✕</span>`;
            item.querySelector('span:last-child').onclick = () => saveData(poiStore.filter(p => p.id !== pt.id));
            container.appendChild(item);
        });
    }

    // 7. Події кнопок та введення
    document.getElementById('fr-add').onclick = () => {
        const text = document.getElementById('fr-input').value;
        const defaultRad = parseFloat(document.getElementById('fr-default-rad').value) || 300;
        const lines = text.split('\n');
        const newPoints = [];

        lines.forEach(line => {
            let clean = line.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ' ').trim();
            clean = clean.replace(/(\d+),(\d+)/g, '$1.$2').replace(/[,;/]/g, ' ');
            const m = clean.match(/-?\d+(?:\.\d+)?/g);
            if (m && m.length >= 2) {
                const lat = parseFloat(m[0]);
                const lon = parseFloat(m[1]);
                const radius = m[2] ? parseFloat(m[2]) : defaultRad;
                if (!isNaN(lat) && !isNaN(lon)) {
                    newPoints.push({ id: Date.now() + Math.random(), lat, lon, radius });
                }
            }
        });

        if (newPoints.length) {
            saveData([...poiStore, ...newPoints]);
            document.getElementById('fr-input').value = '';
        }
    };

    document.getElementById('fr-clear').onclick = () => {
        if (confirm('Видалити всі точки?')) saveData([]);
    };

    // Інтерактивний вибір кліком
    const pickBtn = document.getElementById('fr-pick');
    pickBtn.onclick = () => {
        isPickMode = !isPickMode;
        if (isPickMode) {
            pickBtn.classList.add('active');
            pickBtn.textContent = '👆 Клацніть у будь-якій точці карты...';

            const onMapClick = (e) => {
                const rect = viewer.canvas.getBoundingClientRect();
                const clickPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
                const cartesian = viewer.camera.pickEllipsoid(clickPos, viewer.scene.globe.ellipsoid);
                
                if (cartesian) {
                    const cartographic = viewer.scene.globe.ellipsoid.cartesianToCartographic(cartesian);
                    const lat = cartographic.latitude * 57.29577951308232; // RAD to DEG
                    const lon = cartographic.longitude * 57.29577951308232;
                    const rad = parseFloat(document.getElementById('fr-default-rad').value) || 300;

                    saveData([...poiStore, { id: Date.now() + Math.random(), lat, lon, radius: rad }]);
                }
                
                isPickMode = false;
                pickBtn.classList.remove('active');
                pickBtn.textContent = '🎯 Клацнути на карті';
            };

            viewer.canvas.addEventListener('click', onMapClick, { once: true });
        } else {
            pickBtn.classList.remove('active');
            pickBtn.textContent = '🎯 Клацнути на карті';
        }
    };

    // Експорт / Імпорт у GeoJSON
    document.getElementById('fr-export').onclick = () => {
        const geojson = {
            type: "FeatureCollection",
            features: poiStore.map(p => ({
                type: "Feature",
                geometry: { type: "Point", coordinates: [p.lon, p.lat] },
                properties: { radius: p.radius }
            }))
        };
        const blob = new Blob([JSON.stringify(geojson, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `falcon_route_poi_${new Date().toISOString().slice(0,10)}.geojson`;
        a.click();
    };

    const fileInput = document.getElementById('fr-file');
    document.getElementById('fr-import').onclick = () => fileInput.click();
    fileInput.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (evt) => {
            try {
                const json = JSON.parse(evt.target.result);
                if (json.type === "FeatureCollection") {
                    const imported = json.features.map(f => ({
                        id: Date.now() + Math.random(),
                        lat: f.geometry.coordinates[1],
                        lon: f.geometry.coordinates[0],
                        radius: f.properties?.radius || 300
                    }));
                    saveData([...poiStore, ...imported]);
                }
            } catch (err) {
                alert('Помилка зчитування GeoJSON файлу');
            }
        };
        reader.readAsText(file);
    };

    // Запуск первинного відображення
    renderList();
    renderCesium();
    console.log('🦅 FALCONROUTE завантажено успішно!');
})();