(function () {
    'use strict';

    // ========== Конфіг Firebase ==========
    const DB_URL = 'https://script-poi-default-rtdb.europe-west1.firebasedatabase.app/rooms/falcon-route-default/points.json';
    const FIREBASE_ENABLED = !DB_URL.includes('ВАШ_ПРОЄКТ');
    const STORAGE_KEY = 'cesium_falcon_route_points_v1';
    const SETTINGS_KEY = 'cesium_falcon_route_settings_v1';
    const CORRIDOR_KEY = 'cesium_falcon_route_corridor_v1';
    const MAX_BOOT_ATTEMPTS = 40;

    const DEFAULT_MEANS = [
        { id: 'mvg', name: 'МВГ', color: '#ef4444' },
        { id: 'drone', name: 'Дрон', color: '#f59e0b' },
        { id: 'b2', name: 'Б2', color: '#3b82f6' },
        { id: 'anubis', name: 'Анубіс', color: '#a855f7' },
        { id: 'other', name: 'Інше', color: '#9ca3af' }
    ];

    const DEFAULT_SETTINGS = {
        means: DEFAULT_MEANS.map(m => ({ ...m })),
        showPoints: true,
        coordFormat: 'dd',
        timeFilter: 'all',
        meansFilter: 'all',
        defaultAlt: 100,
        defaultRadius: 300,
        corridorWidth: 2000
    };

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

        const globals = [
            window.map, window.googleMap, window.r2d2Map, window.gMap,
            window.__map, window.mapInstance, window.MAP
        ];
        for (const g of globals) {
            if (isGoogleMap(g)) return g;
        }

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

        const gm = document.querySelector('.gm-style');
        if (gm) {
            const found = findGoogleMapFromDomNode(gm);
            if (found) return found;
        }

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

    // ---------- Координати: DD / DM / DMS / MGRS ----------
    function toRad(d) { return d * Math.PI / 180; }
    function toDeg(r) { return r * 180 / Math.PI; }

    function pad(n, w) {
        const s = String(Math.abs(Math.trunc(n)));
        return s.length >= w ? s : '0'.repeat(w - s.length) + s;
    }

    function formatDM(lat, lon) {
        const fmt = (v, pos, neg) => {
            const hemi = v >= 0 ? pos : neg;
            const a = Math.abs(v);
            const d = Math.floor(a);
            const m = (a - d) * 60;
            return `${d}° ${m.toFixed(3)}' ${hemi}`;
        };
        return `${fmt(lat, 'N', 'S')} ${fmt(lon, 'E', 'W')}`;
    }

    function formatDMS(lat, lon) {
        const fmt = (v, pos, neg) => {
            const hemi = v >= 0 ? pos : neg;
            const a = Math.abs(v);
            const d = Math.floor(a);
            const mFloat = (a - d) * 60;
            const m = Math.floor(mFloat);
            const s = (mFloat - m) * 60;
            return `${d}° ${m}' ${s.toFixed(1)}" ${hemi}`;
        };
        return `${fmt(lat, 'N', 'S')} ${fmt(lon, 'E', 'W')}`;
    }

    // Компактний LLtoUTM / UTMtoMGRS (WGS84)
    function latLonToUtm(lat, lon) {
        const a = 6378137;
        const f = 1 / 298.257223563;
        const k0 = 0.9996;
        const e = Math.sqrt(f * (2 - f));
        const e2 = e * e;
        const ep2 = e2 / (1 - e2);

        let zone = Math.floor((lon + 180) / 6) + 1;
        if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) zone = 32;
        if (lat >= 72 && lat < 84) {
            if (lon >= 0 && lon < 9) zone = 31;
            else if (lon >= 9 && lon < 21) zone = 33;
            else if (lon >= 21 && lon < 33) zone = 35;
            else if (lon >= 33 && lon < 42) zone = 37;
        }

        const lonOrigin = ((zone - 1) * 6 - 180 + 3) * Math.PI / 180;
        const latRad = toRad(lat);
        const lonRad = toRad(lon);
        const N = a / Math.sqrt(1 - e2 * Math.sin(latRad) ** 2);
        const T = Math.tan(latRad) ** 2;
        const C = ep2 * Math.cos(latRad) ** 2;
        const A = Math.cos(latRad) * (lonRad - lonOrigin);
        const M = a * ((1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256) * latRad
            - (3 * e2 / 8 + 3 * e2 * e2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * latRad)
            + (15 * e2 * e2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * latRad)
            - (35 * e2 ** 3 / 3072) * Math.sin(6 * latRad));

        let easting = k0 * N * (A + (1 - T + C) * A ** 3 / 6
            + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120) + 500000;
        let northing = k0 * (M + N * Math.tan(latRad) * (A * A / 2
            + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24
            + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
        if (lat < 0) northing += 10000000;

        return { zone, easting, northing, north: lat >= 0 };
    }

    function latLonToMgrs(lat, lon, precision = 5) {
        if (lat < -80 || lat > 84) return 'N/A';
        const { zone, easting, northing } = latLonToUtm(lat, lon);
        const bandLetters = 'CDEFGHJKLMNPQRSTUVWX';
        const band = bandLetters[Math.floor((lat + 80) / 8)];

        const set = ((zone - 1) % 6);
        const e100kLetters = [
            'ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ',
            'ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'
        ];
        const n100kLetters = [
            'ABCDEFGHJKLMNPQRSTUV',
            'FGHJKLMNPQRSTUVABCDE'
        ];

        const e100k = Math.floor(easting / 100000);
        const n100k = Math.floor((northing % 2000000) / 100000);
        const eLetter = e100kLetters[set][e100k - 1];
        const nLetter = n100kLetters[zone % 2 === 0 ? 1 : 0][n100k];

        const divisor = 10 ** (5 - precision);
        const e = Math.floor((easting % 100000) / divisor);
        const n = Math.floor((northing % 100000) / divisor);

        return `${zone}${band}${eLetter}${nLetter}${pad(e, precision)}${pad(n, precision)}`;
    }

    function formatCoord(lat, lon, format) {
        switch (format) {
            case 'dm': return formatDM(lat, lon);
            case 'dms': return formatDMS(lat, lon);
            case 'mgrs': return latLonToMgrs(lat, lon, 5);
            default: return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
        }
    }

    // ---------- Геометрія коридору ----------
    function haversineM(lat1, lon1, lat2, lon2) {
        const R = 6371000;
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat / 2) ** 2
            + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(a));
    }

    function distToSegmentM(lat, lon, aLat, aLon, bLat, bLon) {
        const toXY = (la, lo) => {
            const x = toRad(lo - aLon) * Math.cos(toRad((la + aLat) / 2)) * 6371000;
            const y = toRad(la - aLat) * 6371000;
            return { x, y };
        };
        const p = toXY(lat, lon);
        const b = toXY(bLat, bLon);
        const len2 = b.x * b.x + b.y * b.y;
        if (len2 === 0) return haversineM(lat, lon, aLat, aLon);
        let t = (p.x * b.x + p.y * b.y) / len2;
        t = Math.max(0, Math.min(1, t));
        const projLat = aLat + t * (bLat - aLat);
        const projLon = aLon + t * (bLon - aLon);
        return haversineM(lat, lon, projLat, projLon);
    }

    function pointInCorridor(pt, corridor, widthM) {
        if (!corridor || corridor.length < 2) return true;
        const half = (widthM || 2000) / 2;
        for (let i = 0; i < corridor.length - 1; i++) {
            const a = corridor[i];
            const b = corridor[i + 1];
            if (distToSegmentM(pt.lat, pt.lon, a.lat, a.lon, b.lat, b.lon) <= half) return true;
        }
        return false;
    }

    function hexToRgbA(hex, alpha) {
        const h = (hex || '#ef4444').replace('#', '');
        const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
        const n = parseInt(full, 16);
        return {
            red: ((n >> 16) & 255) / 255,
            green: ((n >> 8) & 255) / 255,
            blue: (n & 255) / 255,
            alpha
        };
    }

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

            if (!found) return;
            document.removeEventListener('click', onClick, true);
            tip.remove();
            initApp(found);
        };
        document.addEventListener('click', onClick, true);
    }

    function loadSettings() {
        try {
            const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
            if (!raw) return { ...DEFAULT_SETTINGS, means: DEFAULT_MEANS.map(m => ({ ...m })) };
            return {
                ...DEFAULT_SETTINGS,
                ...raw,
                means: Array.isArray(raw.means) && raw.means.length
                    ? raw.means
                    : DEFAULT_MEANS.map(m => ({ ...m }))
            };
        } catch (_) {
            return { ...DEFAULT_SETTINGS, means: DEFAULT_MEANS.map(m => ({ ...m })) };
        }
    }

    function normalizePoint(p) {
        return {
            id: p.id || (Date.now() + Math.random()),
            lat: Number(p.lat),
            lon: Number(p.lon),
            radius: Number(p.radius) || 300,
            alt: Number(p.alt ?? p.height ?? p.altitude) || 0,
            comment: p.comment || '',
            means: p.means || p.weapon || 'Інше',
            color: p.color || '#ef4444',
            createdAt: p.createdAt || Date.now()
        };
    }

    function initApp(engine) {
        const mapType = engine.type;
        const map = engine.map;

        let settings = loadSettings();
        let poiStore = (JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') || []).map(normalizePoint);
        let corridor = JSON.parse(localStorage.getItem(CORRIDOR_KEY) || '[]') || [];
        let overlayObjects = [];
        let labelOverlays = [];
        let corridorOverlays = [];
        let isPickMode = false;
        let isCorridorMode = false;
        let applyRemote = false;
        let pickListener = null;
        let corridorListener = null;
        let draftCorridor = [];

        const Cartesian3 = mapType === 'cesium'
            ? map.camera.position.constructor
            : null;

        document.getElementById('falcon-route-ui')?.remove();

        const panel = document.createElement('div');
        panel.id = 'falcon-route-ui';
        panel.style.cssText = `
            position: fixed; top: 30px; right: 30px; width: 360px;
            height: min(92vh, calc(100vh - 40px)); max-height: calc(100vh - 40px);
            background: #181920; color: #e0e0e0; border: 1px solid #383a48;
            border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.7);
            font-family: system-ui, -apple-system, sans-serif; font-size: 12px;
            z-index: 9999999; user-select: none; display: flex; flex-direction: column;
            overflow: hidden;
        `;

        const htmlLayout = `
            <style>
                #falcon-route-ui .fr-head { background: #222430; padding: 10px 12px; font-weight: bold; color: #4da6ff; display: flex; justify-content: space-between; align-items: center; cursor: move; border-top-left-radius: 8px; border-top-right-radius: 8px; flex-shrink: 0; }
                #falcon-route-ui .fr-body { padding: 10px; display: flex; flex-direction: column; gap: 8px; flex: 1 1 auto; min-height: 0; overflow-x: hidden; overflow-y: scroll; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
                #falcon-route-ui .fr-body.hidden { display: none; }
                #falcon-route-ui.fr-collapsed { height: auto !important; max-height: none; }
                #falcon-route-ui textarea { width: 100%; height: 90px; min-height: 90px; flex-shrink: 0; background: #0f1015; color: #00ffcc; border: 1px solid #333; border-radius: 4px; padding: 6px; font-family: monospace; box-sizing: border-box; resize: vertical; }
                #falcon-route-ui .fr-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
                #falcon-route-ui input, #falcon-route-ui select { background: #0f1015; color: #fff; border: 1px solid #333; border-radius: 4px; padding: 4px; }
                #falcon-route-ui input[type="number"] { width: 78px; text-align: center; }
                #falcon-route-ui input[type="text"] { flex: 1; min-width: 0; }
                #falcon-route-ui input[type="color"] { width: 36px; height: 26px; padding: 0; border: none; background: none; cursor: pointer; }
                #falcon-route-ui select { flex: 1; min-width: 0; }
                #falcon-route-ui .fr-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
                #falcon-route-ui .fr-btn { background: #2a2d3d; color: #fff; border: none; padding: 7px; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 11px; }
                #falcon-route-ui .fr-btn:hover { background: #3b82f6; }
                #falcon-route-ui .fr-btn-pick { background: #1e3a8a; color: #60a5fa; border: 1px solid #2563eb; width: 100%; }
                #falcon-route-ui .fr-btn-pick.active { background: #d97706; color: #fff; }
                #falcon-route-ui .fr-btn-danger { background: #451a1a; color: #f87171; }
                #falcon-route-ui .fr-btn-danger:hover { background: #dc2626; color: #fff; }
                #falcon-route-ui .fr-btn-wide { width: 100%; }
                #falcon-route-ui .fr-btn-ok { background: #14532d; color: #86efac; }
                #falcon-route-ui .fr-list { max-height: 140px; overflow-y: auto; background: #0f1015; border: 1px solid #252836; border-radius: 4px; padding: 4px; }
                #falcon-route-ui .fr-item { display: flex; justify-content: space-between; align-items: flex-start; gap: 6px; padding: 4px; border-bottom: 1px solid #1a1c26; font-family: monospace; font-size: 10px; }
                #falcon-route-ui .fr-item-main { flex: 1; min-width: 0; word-break: break-all; }
                #falcon-route-ui .fr-item-actions { display: flex; gap: 6px; flex-shrink: 0; }
                #falcon-route-ui .fr-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
                #falcon-route-ui .fr-section { border-top: 1px solid #2a2d3d; padding-top: 8px; display: flex; flex-direction: column; gap: 6px; }
                #falcon-route-ui .fr-label { color: #9ca3af; font-size: 11px; }
                #falcon-route-ui .fr-sync { font-size: 10px; color: #6b7280; min-height: 14px; }
                #falcon-route-ui .fr-sync.on { color: #4ade80; }
                #falcon-route-ui .fr-sync.err { color: #f87171; }
                #falcon-route-ui .fr-legend { display: flex; flex-wrap: wrap; gap: 6px; }
                #falcon-route-ui .fr-legend span { display: inline-flex; align-items: center; gap: 4px; background: #0f1015; border: 1px solid #252836; border-radius: 4px; padding: 2px 6px; font-size: 10px; }
                #falcon-route-ui .fr-check { display: flex; align-items: center; gap: 6px; color: #d1d5db; }
                #falcon-route-ui .fr-means-row { display: flex; gap: 4px; align-items: center; }
                #falcon-route-ui .fr-means-list { display: flex; flex-direction: column; gap: 4px; max-height: 110px; overflow-y: auto; }
                #falcon-route-ui details.fr-details > summary { cursor: pointer; color: #93c5fd; font-weight: bold; list-style: none; }
                #falcon-route-ui details.fr-details > summary::-webkit-details-marker { display: none; }
                .fr-map-label { position: absolute; transform: translate(-50%, -120%); pointer-events: none; white-space: nowrap; text-align: center; z-index: 1; }
                .fr-map-label .fr-alt { background: rgba(0,0,0,.75); color: #fff; font: bold 11px/1.2 system-ui; padding: 2px 5px; border-radius: 3px; border: 1px solid #fff; }
                .fr-map-label .fr-cmt { margin-top: 2px; background: rgba(15,16,21,.9); color: #fde68a; font: 10px/1.2 system-ui; padding: 1px 4px; border-radius: 3px; max-width: 140px; overflow: hidden; text-overflow: ellipsis; }
            </style>
            <div class="fr-head" id="fr-drag">
                <span>🦅 FALCONROUTE v2 (Збиття)</span>
                <span id="fr-toggle" style="cursor:pointer">─</span>
            </div>
            <div class="fr-body" id="fr-main">
                <button class="fr-btn fr-btn-pick" id="fr-pick">🎯 Клацнути на карті</button>

                <div class="fr-row">
                    <label>Засіб:</label>
                    <select id="fr-means"></select>
                </div>
                <div class="fr-row">
                    <label>Висота збиття (м):</label>
                    <input type="number" id="fr-alt" value="${settings.defaultAlt}" step="50" min="0">
                </div>
                <div class="fr-row">
                    <label>Коментар:</label>
                    <input type="text" id="fr-comment" placeholder="короткий коментар" maxlength="80">
                </div>
                <div class="fr-row">
                    <label>Радіус (м):</label>
                    <input type="number" id="fr-default-rad" value="${settings.defaultRadius}" step="50">
                </div>

                <textarea id="fr-input" placeholder="Координати:&#10;48.4501, 34.9802&#10;або з висотою: 48.45, 34.98, 150"></textarea>
                <button class="fr-btn fr-btn-wide" id="fr-add">Побудувати</button>

                <div class="fr-section">
                    <label class="fr-check"><input type="checkbox" id="fr-show-points" ${settings.showPoints ? 'checked' : ''}> Показувати точки</label>
                    <div class="fr-row">
                        <label>Період:</label>
                        <select id="fr-time-filter">
                            <option value="all">Усі</option>
                            <option value="day">Останні 24 год</option>
                            <option value="week">Останній тиждень</option>
                            <option value="month">Останній місяць</option>
                        </select>
                    </div>
                    <div class="fr-row">
                        <label>Фільтр засобу:</label>
                        <select id="fr-means-filter"></select>
                    </div>
                    <div class="fr-legend" id="fr-legend"></div>
                </div>

                <div class="fr-section">
                    <span class="fr-label">Коридор відображення</span>
                    <div class="fr-row">
                        <label>Ширина (м):</label>
                        <input type="number" id="fr-corridor-w" value="${settings.corridorWidth}" step="100" min="100">
                    </div>
                    <div class="fr-grid">
                        <button class="fr-btn fr-btn-pick" id="fr-corridor">📐 Коридор</button>
                        <button class="fr-btn fr-btn-danger" id="fr-corridor-clear">Скинути коридор</button>
                    </div>
                    <span class="fr-label" id="fr-corridor-status">Коридор не задано (показуються всі точки)</span>
                </div>

                <div class="fr-section">
                    <div class="fr-row">
                        <label>Формат координат:</label>
                        <select id="fr-coord-format">
                            <option value="dd">DD (десяткові)</option>
                            <option value="dm">DM</option>
                            <option value="dms">DMS</option>
                            <option value="mgrs">MGRS</option>
                        </select>
                    </div>
                    <button class="fr-btn fr-btn-wide" id="fr-copy">📋 Скопіювати видимі координати</button>
                </div>

                <details class="fr-details fr-section">
                    <summary>⚙ Налаштування засобів / кольорів</summary>
                    <div class="fr-means-list" id="fr-means-edit"></div>
                    <div class="fr-means-row">
                        <input type="text" id="fr-means-new-name" placeholder="Новий засіб">
                        <input type="color" id="fr-means-new-color" value="#22c55e">
                        <button class="fr-btn" id="fr-means-add">＋</button>
                    </div>
                </details>

                <div class="fr-section">
                    <span class="fr-label">Експорт / імпорт</span>
                    <div class="fr-row">
                        <label for="fr-format">Формат:</label>
                        <select id="fr-format">
                            <option value="txt">.TXT</option>
                            <option value="json">.JSON</option>
                            <option value="geojson" selected>.GEOJSON</option>
                        </select>
                    </div>
                    <div class="fr-grid">
                        <button class="fr-btn" id="fr-export">⬇ Завантажити</button>
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
        const toggleBtn = document.getElementById('fr-toggle');
        toggleBtn.onclick = (e) => {
            e.stopPropagation();
            const closed = mainBody.classList.toggle('hidden');
            panel.classList.toggle('fr-collapsed', closed);
            toggleBtn.textContent = closed ? '□' : '─';
        };

        // Скрол лише в панелі — не віддавати колесо карті / не «згортати» огляд
        const stopScrollBubble = (e) => e.stopPropagation();
        panel.addEventListener('wheel', stopScrollBubble, { passive: true });
        panel.addEventListener('touchmove', stopScrollBubble, { passive: true });
        mainBody.addEventListener('wheel', stopScrollBubble, { passive: true });

        let isDragging = false, ox = 0, oy = 0;
        document.getElementById('fr-drag').onmousedown = (e) => {
            if (e.target === toggleBtn || toggleBtn.contains(e.target)) return;
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

        function saveSettings() {
            settings.defaultAlt = parseFloat(document.getElementById('fr-alt').value) || 0;
            settings.defaultRadius = parseFloat(document.getElementById('fr-default-rad').value) || 300;
            settings.corridorWidth = parseFloat(document.getElementById('fr-corridor-w').value) || 2000;
            settings.showPoints = document.getElementById('fr-show-points').checked;
            settings.coordFormat = document.getElementById('fr-coord-format').value;
            settings.timeFilter = document.getElementById('fr-time-filter').value;
            settings.meansFilter = document.getElementById('fr-means-filter').value;
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        }

        function getMeansByName(name) {
            return settings.means.find(m => m.name === name) || settings.means[settings.means.length - 1] || DEFAULT_MEANS[DEFAULT_MEANS.length - 1];
        }

        function fillMeansSelects() {
            const meansSel = document.getElementById('fr-means');
            const filterSel = document.getElementById('fr-means-filter');
            const curMeans = meansSel.value;
            const curFilter = filterSel.value || settings.meansFilter;

            meansSel.innerHTML = '';
            filterSel.innerHTML = '<option value="all">Усі засоби</option>';

            settings.means.forEach(m => {
                const o1 = document.createElement('option');
                o1.value = m.name;
                o1.textContent = m.name;
                meansSel.appendChild(o1);

                const o2 = document.createElement('option');
                o2.value = m.name;
                o2.textContent = m.name;
                filterSel.appendChild(o2);
            });

            if ([...meansSel.options].some(o => o.value === curMeans)) meansSel.value = curMeans;
            else if (settings.means[0]) meansSel.value = settings.means[0].name;

            if ([...filterSel.options].some(o => o.value === curFilter)) filterSel.value = curFilter;
            else filterSel.value = 'all';

            const legend = document.getElementById('fr-legend');
            legend.innerHTML = '';
            settings.means.forEach(m => {
                const span = document.createElement('span');
                const dot = document.createElement('i');
                dot.className = 'fr-dot';
                dot.style.background = m.color;
                span.appendChild(dot);
                span.appendChild(document.createTextNode(m.name));
                legend.appendChild(span);
            });

            const edit = document.getElementById('fr-means-edit');
            edit.innerHTML = '';
            settings.means.forEach((m, idx) => {
                const row = document.createElement('div');
                row.className = 'fr-means-row';
                const name = document.createElement('input');
                name.type = 'text';
                name.value = m.name;
                const color = document.createElement('input');
                color.type = 'color';
                color.value = m.color;
                const del = document.createElement('button');
                del.className = 'fr-btn fr-btn-danger';
                del.textContent = '✕';
                del.title = 'Прибрати засіб';
                const apply = () => {
                    const oldName = m.name;
                    m.name = name.value.trim() || m.name;
                    m.color = color.value;
                    if (oldName !== m.name) {
                        poiStore = poiStore.map(p => p.means === oldName ? { ...p, means: m.name, color: m.color } : p);
                        localStorage.setItem(STORAGE_KEY, JSON.stringify(poiStore));
                    } else {
                        poiStore = poiStore.map(p => p.means === m.name ? { ...p, color: m.color } : p);
                        localStorage.setItem(STORAGE_KEY, JSON.stringify(poiStore));
                    }
                    saveSettings();
                    fillMeansSelects();
                    refreshUI();
                    pushToFirebase(poiStore);
                };
                name.onchange = apply;
                color.onchange = apply;
                del.onclick = () => {
                    if (settings.means.length <= 1) {
                        alert('Має залишитись хоча б один засіб.');
                        return;
                    }
                    settings.means.splice(idx, 1);
                    saveSettings();
                    fillMeansSelects();
                    refreshUI();
                };
                row.appendChild(name);
                row.appendChild(color);
                row.appendChild(del);
                edit.appendChild(row);
            });
        }

        document.getElementById('fr-coord-format').value = settings.coordFormat;
        document.getElementById('fr-time-filter').value = settings.timeFilter;
        fillMeansSelects();

        function passesTimeFilter(pt) {
            const mode = document.getElementById('fr-time-filter').value;
            if (mode === 'all') return true;
            const age = Date.now() - (pt.createdAt || 0);
            if (mode === 'day') return age <= 86400000;
            if (mode === 'week') return age <= 7 * 86400000;
            if (mode === 'month') return age <= 30 * 86400000;
            return true;
        }

        function getVisiblePoints() {
            const meansFilter = document.getElementById('fr-means-filter').value;
            const width = parseFloat(document.getElementById('fr-corridor-w').value) || 2000;
            return poiStore.filter(pt => {
                if (!passesTimeFilter(pt)) return false;
                if (meansFilter !== 'all' && pt.means !== meansFilter) return false;
                if (!pointInCorridor(pt, corridor, width)) return false;
                return true;
            });
        }

        function formatTxt(points, coordFormat) {
            const fmt = coordFormat || document.getElementById('fr-coord-format').value;
            return points.map(p => {
                const c = formatCoord(p.lat, p.lon, fmt);
                return `${c} | H${p.alt || 0}м | ${p.means}${p.comment ? ' | ' + p.comment : ''}`;
            }).join('\n');
        }

        function formatJson(points) {
            return JSON.stringify({
                type: 'FalconRoutePoints',
                version: 2,
                exportedAt: new Date().toISOString(),
                points: points.map(p => ({
                    id: p.id, lat: p.lat, lon: p.lon, radius: p.radius,
                    alt: p.alt, comment: p.comment, means: p.means, color: p.color, createdAt: p.createdAt
                }))
            }, null, 2);
        }

        function formatGeoJson(points) {
            return JSON.stringify({
                type: 'FeatureCollection',
                features: points.map(p => ({
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
                    properties: {
                        id: p.id, radius: p.radius, alt: p.alt,
                        comment: p.comment, means: p.means, color: p.color, createdAt: p.createdAt
                    }
                }))
            }, null, 2);
        }

        function parseTxt(text) {
            const defaultRad = parseFloat(document.getElementById('fr-default-rad').value) || 300;
            const defaultAlt = parseFloat(document.getElementById('fr-alt').value) || 0;
            const meansName = document.getElementById('fr-means').value;
            const means = getMeansByName(meansName);
            const comment = document.getElementById('fr-comment').value.trim();
            const points = [];
            text.split('\n').forEach(line => {
                let clean = line.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ' ').trim();
                if (!clean || clean.startsWith('#')) return;
                clean = clean.replace(/(\d+),(\d+)/g, '$1.$2').replace(/[,;/]/g, ' ');
                const m = clean.match(/-?\d+(?:\.\d+)?/g);
                if (m && m.length >= 2) {
                    const lat = parseFloat(m[0]);
                    const lon = parseFloat(m[1]);
                    const third = m[2] ? parseFloat(m[2]) : NaN;
                    // третє число: якщо схоже на висоту (<10000 і не радіус за замовч.), беремо як alt
                    let alt = defaultAlt;
                    let radius = defaultRad;
                    if (!isNaN(third)) {
                        if (third <= 10000) alt = third;
                        else radius = third;
                    }
                    if (!isNaN(lat) && !isNaN(lon)) {
                        points.push(normalizePoint({
                            id: Date.now() + Math.random(),
                            lat, lon, radius, alt, comment,
                            means: means.name, color: means.color, createdAt: Date.now()
                        }));
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
                return json.features.map(f => normalizePoint({
                    id: f.properties?.id || (Date.now() + Math.random()),
                    lat: f.geometry.coordinates[1],
                    lon: f.geometry.coordinates[0],
                    radius: f.properties?.radius || 300,
                    alt: f.properties?.alt,
                    comment: f.properties?.comment,
                    means: f.properties?.means,
                    color: f.properties?.color,
                    createdAt: f.properties?.createdAt
                }));
            }

            if (json.type === 'FalconRoutePoints' && Array.isArray(json.points)) {
                return json.points.map(normalizePoint);
            }

            if (Array.isArray(json)) {
                return json.map(normalizePoint);
            }

            throw new Error('Невідомий формат файлу');
        }

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

        function clearOverlays() {
            if (mapType === 'google') {
                overlayObjects.forEach(obj => {
                    try { obj.setMap(null); } catch (_) { /* ignore */ }
                });
                labelOverlays.forEach(ov => {
                    try { ov.setMap(null); } catch (_) { /* ignore */ }
                });
            } else {
                overlayObjects.forEach(ent => {
                    try { map.entities.remove(ent); } catch (_) { /* ignore */ }
                });
            }
            overlayObjects = [];
            labelOverlays = [];
        }

        function clearCorridorOverlays() {
            if (mapType === 'google') {
                corridorOverlays.forEach(obj => {
                    try { obj.setMap(null); } catch (_) { /* ignore */ }
                });
            } else {
                corridorOverlays.forEach(ent => {
                    try { map.entities.remove(ent); } catch (_) { /* ignore */ }
                });
            }
            corridorOverlays = [];
        }

        function createGoogleLabelOverlay(position, altText, comment) {
            class FrLabel extends google.maps.OverlayView {
                constructor() {
                    super();
                    this.position = position;
                    this.div = null;
                }
                onAdd() {
                    this.div = document.createElement('div');
                    this.div.className = 'fr-map-label';
                    const alt = document.createElement('div');
                    alt.className = 'fr-alt';
                    alt.textContent = altText;
                    this.div.appendChild(alt);
                    if (comment) {
                        const cmt = document.createElement('div');
                        cmt.className = 'fr-cmt';
                        cmt.textContent = comment;
                        this.div.appendChild(cmt);
                    }
                    this.getPanes().overlayMouseTarget.appendChild(this.div);
                }
                draw() {
                    const proj = this.getProjection();
                    if (!proj || !this.div) return;
                    const p = proj.fromLatLngToDivPixel(this.position);
                    if (!p) return;
                    this.div.style.left = p.x + 'px';
                    this.div.style.top = p.y + 'px';
                }
                onRemove() {
                    if (this.div?.parentNode) this.div.parentNode.removeChild(this.div);
                    this.div = null;
                }
            }
            const ov = new FrLabel();
            ov.setMap(map);
            return ov;
        }

        function renderCorridor() {
            clearCorridorOverlays();
            const path = isCorridorMode ? draftCorridor : corridor;
            const status = document.getElementById('fr-corridor-status');
            if (!path.length) {
                status.textContent = 'Коридор не задано (показуються всі точки)';
                return;
            }
            status.textContent = isCorridorMode
                ? `Малювання: ${path.length} т. (подвійний клік або «Завершити»)`
                : `Коридор: ${path.length} точок, ширина ${document.getElementById('fr-corridor-w').value} м`;

            if (mapType === 'google') {
                const poly = new google.maps.Polyline({
                    path: path.map(p => ({ lat: p.lat, lng: p.lon })),
                    geodesic: true,
                    strokeColor: '#38bdf8',
                    strokeOpacity: 0.95,
                    strokeWeight: 3,
                    map,
                    zIndex: 130
                });
                corridorOverlays.push(poly);
                path.forEach(p => {
                    const m = new google.maps.Marker({
                        position: { lat: p.lat, lng: p.lon },
                        map,
                        icon: {
                            path: google.maps.SymbolPath.CIRCLE,
                            scale: 4,
                            fillColor: '#38bdf8',
                            fillOpacity: 1,
                            strokeColor: '#fff',
                            strokeWeight: 1
                        },
                        zIndex: 131
                    });
                    corridorOverlays.push(m);
                });
            } else if (Cartesian3) {
                const positions = path.map(p => Cartesian3.fromDegrees(p.lon, p.lat));
                const entity = map.entities.add({
                    polyline: {
                        positions,
                        width: 3,
                        material: { red: 0.22, green: 0.74, blue: 0.97, alpha: 1 }
                    }
                });
                corridorOverlays.push(entity);
                map.scene?.requestRender?.();
            }
        }

        function renderMap() {
            clearOverlays();
            renderCorridor();

            if (!document.getElementById('fr-show-points').checked) return;

            const visible = getVisiblePoints();

            if (mapType === 'google') {
                visible.forEach(pt => {
                    const position = { lat: pt.lat, lng: pt.lon };
                    const color = pt.color || getMeansByName(pt.means).color;

                    const marker = new google.maps.Marker({
                        position,
                        map,
                        icon: {
                            path: google.maps.SymbolPath.CIRCLE,
                            scale: 9,
                            fillColor: color,
                            fillOpacity: 1,
                            strokeColor: '#fff',
                            strokeWeight: 1.5
                        },
                        title: `${pt.means} · ${pt.alt || 0}м${pt.comment ? ' · ' + pt.comment : ''}`,
                        zIndex: 150
                    });

                    const circle = new google.maps.Circle({
                        map,
                        center: position,
                        radius: Number(pt.radius) || 300,
                        strokeColor: color,
                        strokeOpacity: 0.9,
                        strokeWeight: 2,
                        fillColor: color,
                        fillOpacity: 0.18,
                        clickable: false,
                        zIndex: 140
                    });

                    const label = createGoogleLabelOverlay(
                        new google.maps.LatLng(pt.lat, pt.lon),
                        `${pt.alt || 0}м`,
                        pt.comment || ''
                    );

                    overlayObjects.push(marker, circle);
                    labelOverlays.push(label);
                });
                return;
            }

            visible.forEach(pt => {
                const color = pt.color || getMeansByName(pt.means).color;
                const rgba = hexToRgbA(color, 1);
                const fill = hexToRgbA(color, 0.25);
                const white = { red: 1, green: 1, blue: 1, alpha: 1 };
                const labelText = pt.comment
                    ? `${pt.alt || 0}м\n${pt.comment}`
                    : `${pt.alt || 0}м`;

                const entity = map.entities.add({
                    position: Cartesian3.fromDegrees(pt.lon, pt.lat),
                    point: { pixelSize: 10, color: rgba, outlineColor: white, outlineWidth: 2 },
                    ellipse: {
                        semiMinorAxis: pt.radius,
                        semiMajorAxis: pt.radius,
                        material: fill,
                        outline: true,
                        outlineColor: rgba,
                        outlineWidth: 2
                    },
                    label: {
                        text: labelText,
                        font: 'bold 12px sans-serif',
                        fillColor: white,
                        outlineColor: { red: 0, green: 0, blue: 0, alpha: 1 },
                        outlineWidth: 3,
                        style: window.Cesium?.LabelStyle?.FILL_AND_OUTLINE,
                        verticalOrigin: window.Cesium?.VerticalOrigin?.BOTTOM,
                        pixelOffset: window.Cesium?.Cartesian2
                            ? new window.Cesium.Cartesian2(0, -14)
                            : undefined,
                        showBackground: true,
                        backgroundColor: { red: 0, green: 0, blue: 0, alpha: 0.65 }
                    }
                });
                overlayObjects.push(entity);
            });
            map.scene?.requestRender?.();
        }

        function saveData(data) {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
            poiStore = data;
            refreshUI();
            pushToFirebase(data);
        }

        function saveCorridor(data) {
            corridor = data;
            localStorage.setItem(CORRIDOR_KEY, JSON.stringify(corridor));
            refreshUI();
        }

        async function copyText(text, btn, okLabel) {
            const prev = btn.textContent;
            try {
                await navigator.clipboard.writeText(text);
                btn.textContent = okLabel || '✅ Скопійовано!';
                btn.classList.add('fr-btn-ok');
                setTimeout(() => {
                    btn.textContent = prev;
                    btn.classList.remove('fr-btn-ok');
                }, 1600);
            } catch (_) {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.cssText = 'position:fixed;left:-9999px';
                document.body.appendChild(ta);
                ta.select();
                try {
                    document.execCommand('copy');
                    btn.textContent = okLabel || '✅ Скопійовано!';
                    btn.classList.add('fr-btn-ok');
                    setTimeout(() => {
                        btn.textContent = prev;
                        btn.classList.remove('fr-btn-ok');
                    }, 1600);
                } catch (e2) {
                    alert('Не вдалося скопіювати.');
                }
                document.body.removeChild(ta);
            }
        }

        function renderList() {
            const container = document.getElementById('fr-container');
            while (container.firstChild) container.removeChild(container.firstChild);
            const fmt = document.getElementById('fr-coord-format').value;
            const visible = getVisiblePoints();

            if (!visible.length) {
                const empty = document.createElement('div');
                empty.className = 'fr-label';
                empty.textContent = poiStore.length
                    ? 'Немає точок за поточними фільтрами'
                    : 'Немає точок';
                container.appendChild(empty);
                return;
            }

            visible.forEach(pt => {
                const item = document.createElement('div');
                item.className = 'fr-item';

                const main = document.createElement('div');
                main.className = 'fr-item-main';
                const coord = formatCoord(pt.lat, pt.lon, fmt);
                const dot = document.createElement('span');
                dot.className = 'fr-dot';
                dot.style.background = pt.color || '#ef4444';
                const line1 = document.createElement('span');
                const b = document.createElement('b');
                b.textContent = `${pt.alt || 0}м`;
                line1.appendChild(dot);
                line1.appendChild(b);
                line1.appendChild(document.createTextNode(` · ${pt.means}`));
                main.appendChild(line1);
                main.appendChild(document.createElement('br'));
                main.appendChild(document.createTextNode(coord));
                if (pt.comment) {
                    main.appendChild(document.createElement('br'));
                    const cmt = document.createElement('span');
                    cmt.style.color = '#fde68a';
                    cmt.textContent = pt.comment;
                    main.appendChild(cmt);
                }

                const actions = document.createElement('div');
                actions.className = 'fr-item-actions';

                const copy = document.createElement('span');
                copy.textContent = '⧉';
                copy.title = 'Копіювати координати';
                copy.style.cssText = 'color:#93c5fd;cursor:pointer;font-weight:bold';
                copy.onclick = () => copyText(formatCoord(pt.lat, pt.lon, fmt), copy, '✓');

                const del = document.createElement('span');
                del.textContent = '✕';
                del.style.cssText = 'color:#f87171;cursor:pointer;font-weight:bold';
                del.onclick = () => saveData(poiStore.filter(p => p.id !== pt.id));

                actions.appendChild(copy);
                actions.appendChild(del);
                item.appendChild(main);
                item.appendChild(actions);
                container.appendChild(item);
            });
        }

        function refreshUI() {
            renderList();
            renderMap();
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

        function stopCorridorMode(commit) {
            if (corridorListener) {
                if (mapType === 'google') {
                    google.maps.event.removeListener(corridorListener);
                    if (corridorDbl) google.maps.event.removeListener(corridorDbl);
                } else if (map.canvas) {
                    map.canvas.removeEventListener('click', corridorListener);
                }
                corridorListener = null;
                corridorDbl = null;
            }
            isCorridorMode = false;
            corridorBtn.classList.remove('active');
            corridorBtn.textContent = '📐 Коридор';

            if (commit && draftCorridor.length >= 2) {
                saveCorridor(draftCorridor.slice());
            } else if (commit) {
                alert('Для коридору потрібно мінімум 2 точки.');
                draftCorridor = corridor.slice();
                refreshUI();
            } else {
                draftCorridor = [];
                refreshUI();
            }
        }

        let corridorDbl = null;

        function addPointAt(lat, lon) {
            const rad = parseFloat(document.getElementById('fr-default-rad').value) || 300;
            const alt = parseFloat(document.getElementById('fr-alt').value) || 0;
            const comment = document.getElementById('fr-comment').value.trim();
            const means = getMeansByName(document.getElementById('fr-means').value);
            saveData([...poiStore, normalizePoint({
                id: Date.now() + Math.random(),
                lat, lon, radius: rad, alt, comment,
                means: means.name, color: means.color, createdAt: Date.now()
            })]);
            document.getElementById('fr-comment').value = '';
        }

        // ----- Події UI -----
        document.getElementById('fr-add').onclick = () => {
            const text = document.getElementById('fr-input').value;
            const newPoints = parseTxt(text);
            if (newPoints.length) {
                saveData([...poiStore, ...newPoints]);
                document.getElementById('fr-input').value = '';
                document.getElementById('fr-comment').value = '';
            }
        };

        document.getElementById('fr-show-points').onchange = () => { saveSettings(); refreshUI(); };
        document.getElementById('fr-time-filter').onchange = () => { saveSettings(); refreshUI(); };
        document.getElementById('fr-means-filter').onchange = () => { saveSettings(); refreshUI(); };
        document.getElementById('fr-coord-format').onchange = () => { saveSettings(); renderList(); };
        document.getElementById('fr-corridor-w').onchange = () => { saveSettings(); refreshUI(); };
        document.getElementById('fr-alt').onchange = () => saveSettings();
        document.getElementById('fr-default-rad').onchange = () => saveSettings();

        document.getElementById('fr-means-add').onclick = () => {
            const name = document.getElementById('fr-means-new-name').value.trim();
            const color = document.getElementById('fr-means-new-color').value;
            if (!name) {
                alert('Вкажіть назву засобу.');
                return;
            }
            if (settings.means.some(m => m.name.toLowerCase() === name.toLowerCase())) {
                alert('Такий засіб уже є.');
                return;
            }
            settings.means.push({
                id: 'm_' + Date.now(),
                name,
                color
            });
            document.getElementById('fr-means-new-name').value = '';
            saveSettings();
            fillMeansSelects();
            document.getElementById('fr-means').value = name;
        };

        const copyBtn = document.getElementById('fr-copy');
        copyBtn.onclick = () => {
            const visible = getVisiblePoints();
            if (!visible.length) {
                alert('Немає видимих точок для копіювання.');
                return;
            }
            copyText(formatTxt(visible), copyBtn);
        };

        const pickBtn = document.getElementById('fr-pick');
        pickBtn.onclick = () => {
            if (isCorridorMode) stopCorridorMode(false);
            if (isPickMode) {
                stopPickMode();
                return;
            }

            isPickMode = true;
            pickBtn.classList.add('active');
            pickBtn.textContent = '👆 Клацніть у точці збиття...';

            if (mapType === 'google') {
                pickListener = map.addListener('click', (e) => {
                    if (!e?.latLng) return;
                    addPointAt(e.latLng.lat(), e.latLng.lng());
                    stopPickMode();
                });
            } else {
                pickListener = (e) => {
                    const rect = map.canvas.getBoundingClientRect();
                    const clickPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
                    const cartesian = map.camera.pickEllipsoid(clickPos, map.scene.globe.ellipsoid);
                    if (cartesian) {
                        const cartographic = map.scene.globe.ellipsoid.cartesianToCartographic(cartesian);
                        addPointAt(
                            cartographic.latitude * 57.29577951308232,
                            cartographic.longitude * 57.29577951308232
                        );
                    }
                    stopPickMode();
                };
                map.canvas.addEventListener('click', pickListener, { once: true });
            }
        };

        const corridorBtn = document.getElementById('fr-corridor');
        corridorBtn.onclick = () => {
            if (isPickMode) stopPickMode();

            if (isCorridorMode) {
                stopCorridorMode(true);
                return;
            }

            isCorridorMode = true;
            draftCorridor = [];
            corridorBtn.classList.add('active');
            corridorBtn.textContent = '✓ Завершити коридор';
            renderCorridor();

            if (mapType === 'google') {
                corridorListener = map.addListener('click', (e) => {
                    if (!e?.latLng) return;
                    draftCorridor.push({ lat: e.latLng.lat(), lon: e.latLng.lng() });
                    renderCorridor();
                });
                corridorDbl = map.addListener('dblclick', (e) => {
                    e?.stop?.();
                    if (e?.latLng) {
                        draftCorridor.push({ lat: e.latLng.lat(), lon: e.latLng.lng() });
                    }
                    stopCorridorMode(true);
                });
            } else {
                corridorListener = (e) => {
                    const rect = map.canvas.getBoundingClientRect();
                    const clickPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
                    const cartesian = map.camera.pickEllipsoid(clickPos, map.scene.globe.ellipsoid);
                    if (cartesian) {
                        const cartographic = map.scene.globe.ellipsoid.cartesianToCartographic(cartesian);
                        draftCorridor.push({
                            lat: cartographic.latitude * 57.29577951308232,
                            lon: cartographic.longitude * 57.29577951308232
                        });
                        renderCorridor();
                    }
                };
                map.canvas.addEventListener('click', corridorListener);
            }
        };

        document.getElementById('fr-corridor-clear').onclick = () => {
            if (isCorridorMode) stopCorridorMode(false);
            draftCorridor = [];
            saveCorridor([]);
        };

        document.getElementById('fr-export').onclick = () => {
            const points = getVisiblePoints();
            if (!points.length) {
                alert('Немає точок для експорту.');
                return;
            }

            const format = document.getElementById('fr-format').value;
            const date = new Date().toISOString().slice(0, 10);
            let content = '';
            let mime = 'text/plain';
            let ext = 'txt';

            if (format === 'json') {
                content = formatJson(points);
                mime = 'application/json';
                ext = 'json';
            } else if (format === 'geojson') {
                content = formatGeoJson(points);
                mime = 'application/geo+json';
                ext = 'geojson';
            } else {
                content = formatTxt(points);
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
                        const raw = Array.isArray(res.data) ? res.data : Object.values(res.data);
                        poiStore = raw.map(normalizePoint);
                        localStorage.setItem(STORAGE_KEY, JSON.stringify(poiStore));
                        refreshUI();
                        applyRemote = false;
                        syncEl.textContent = 'Firebase: онлайн';
                        syncEl.className = 'fr-sync on';
                    } else if (res && res.data === null) {
                        applyRemote = true;
                        poiStore = [];
                        localStorage.setItem(STORAGE_KEY, JSON.stringify(poiStore));
                        refreshUI();
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

        refreshUI();
        listenToCloudUpdates();
        console.log(`🦅 FALCONROUTE v2 завантажено! (${mapType === 'google' ? 'Google Maps / R2D2' : 'Cesium'}) — коридор/засоби/фільтри`);
    }

    document.getElementById('falcon-route-ui')?.remove();
    document.getElementById('falcon-route-tip')?.remove();
    boot(0);
})();
