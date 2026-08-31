(function () {
    'use strict';

    // ========== Конфіг Firebase ==========
    const DB_URL = 'https://script-poi-default-rtdb.europe-west1.firebasedatabase.app/rooms/falcon-route-default/points.json';
    const FLIGHTS_URL = 'https://script-poi-default-rtdb.europe-west1.firebasedatabase.app/rooms/falcon-route-default/flights.json';
    const FIREBASE_ENABLED = !DB_URL.includes('ВАШ_ПРОЄКТ');
    const STORAGE_KEY = 'cesium_falcon_route_points_v1';
    const SETTINGS_KEY = 'cesium_falcon_route_settings_v1';
    const CORRIDOR_KEY = 'cesium_falcon_route_corridor_v1';
    const CLIENT_KEY = 'falcon_route_client_id_v1';
    const MAX_BOOT_ATTEMPTS = 40;

    function getClientId() {
        try {
            let id = localStorage.getItem(CLIENT_KEY);
            if (!id) {
                id = 'c_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
                localStorage.setItem(CLIENT_KEY, id);
            }
            return id;
        } catch (_) {
            return 'c_' + Math.random().toString(36).slice(2, 11);
        }
    }

    const CLIENT_ID = getClientId();

    // Збиття — з кольорами (раніше «засіб»)
    const DEFAULT_ZBYTTYA = [
        { id: 'mvg', name: 'МВГ', color: '#ef4444' },
        { id: 'drone', name: 'Дрон', color: '#f59e0b' },
        { id: 'other', name: 'Інше', color: '#9ca3af' }
    ];
    // Засіб — без кольорів (раніше вільний «коментар»)
    const DEFAULT_ZASIB = [
        { id: 'b2', name: 'Б2' },
        { id: 'anubis', name: 'Анубіс' },
        { id: 'other', name: 'Інше' }
    ];
    const DEFAULT_SETTINGS = {
        means: DEFAULT_ZBYTTYA.map(m => ({ ...m })), // збиття (ключ means для сумісності)
        zasibs: DEFAULT_ZASIB.map(m => ({ ...m })),
        showPoints: true,
        coordFormat: 'dd',
        timeFilter: 'all',
        meansFilter: 'all',
        zasibFilter: 'all',
        defaultAlt: 100,
        defaultRadius: 300,
        corridorWidth: 2000,
        rulerSpeedKmh: 5,
        callsign: 'Falcon',
        flightColor: '#22d3ee'
    };

    function formatDistanceKm(meters) {
        const km = meters / 1000;
        if (km < 1) return `${Math.round(meters)} м`;
        if (km < 10) return `${km.toFixed(2)} км`;
        return `${km.toFixed(1)} км`;
    }

    function formatTravelTime(meters, speedKmh) {
        const speed = Number(speedKmh);
        if (!Number.isFinite(speed) || speed <= 0) return '—';
        const hours = (meters / 1000) / speed;
        if (!Number.isFinite(hours) || hours < 0) return '—';
        const totalMin = Math.round(hours * 60);
        if (totalMin < 1) return '<1 хв';
        if (totalMin < 60) return `${totalMin} хв`;
        const d = Math.floor(totalMin / (60 * 24));
        const h = Math.floor((totalMin % (60 * 24)) / 60);
        const m = totalMin % 60;
        if (d > 0) return `${d} д ${h} год ${m} хв`;
        if (m === 0) return `${h} год`;
        return `${h} год ${m} хв`;
    }

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

    function bearingDeg(a, b) {
        const φ1 = toRad(a.lat);
        const φ2 = toRad(b.lat);
        const Δλ = toRad(b.lon - a.lon);
        const y = Math.sin(Δλ) * Math.cos(φ2);
        const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
        return (toDeg(Math.atan2(y, x)) + 360) % 360;
    }

    function positionAlongPath(path, speedKmh, startedAt, now = Date.now()) {
        if (!path || path.length < 2) return null;
        const speed = Number(speedKmh);
        if (!Number.isFinite(speed) || speed <= 0) return null;
        const metersPerMs = (speed * 1000) / 3600 / 1000;
        let traveled = Math.max(0, (now - startedAt) * metersPerMs);
        let remaining = traveled;
        let total = 0;
        for (let i = 0; i < path.length - 1; i++) {
            total += haversineM(path[i].lat, path[i].lon, path[i + 1].lat, path[i + 1].lon);
        }
        for (let i = 0; i < path.length - 1; i++) {
            const a = path[i];
            const b = path[i + 1];
            const seg = haversineM(a.lat, a.lon, b.lat, b.lon);
            if (seg <= 0) continue;
            if (remaining <= seg) {
                const t = remaining / seg;
                return {
                    lat: a.lat + (b.lat - a.lat) * t,
                    lon: a.lon + (b.lon - a.lon) * t,
                    heading: bearingDeg(a, b),
                    done: false,
                    traveledM: traveled,
                    totalM: total
                };
            }
            remaining -= seg;
        }
        const last = path[path.length - 1];
        const prev = path[path.length - 2] || last;
        return {
            lat: last.lat,
            lon: last.lon,
            heading: bearingDeg(prev, last),
            done: true,
            traveledM: total,
            totalM: total
        };
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
        const blank = () => ({
            ...DEFAULT_SETTINGS,
            means: DEFAULT_ZBYTTYA.map(m => ({ ...m })),
            zasibs: DEFAULT_ZASIB.map(m => ({ ...m }))
        });
        try {
            const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
            if (!raw) return blank();
            return {
                ...DEFAULT_SETTINGS,
                ...raw,
                means: Array.isArray(raw.means) && raw.means.length
                    ? raw.means
                    : DEFAULT_ZBYTTYA.map(m => ({ ...m })),
                zasibs: Array.isArray(raw.zasibs) && raw.zasibs.length
                    ? raw.zasibs
                    : DEFAULT_ZASIB.map(m => ({ ...m }))
            };
        } catch (_) {
            return blank();
        }
    }

    function ensureNamedOption(list, name) {
        const n = (name || '').trim();
        if (!n) return list;
        if (list.some(x => x.name === n)) return list;
        return [...list, { id: 'auto_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), name: n }];
    }

    function resolveCreatedAt(p) {
        const candidates = [];
        if (p?.createdAt != null && p.createdAt !== '') {
            const n = Number(p.createdAt);
            if (Number.isFinite(n) && n > 1e11) candidates.push(n);
            else {
                const parsed = Date.parse(p.createdAt);
                if (Number.isFinite(parsed)) candidates.push(parsed);
            }
        }
        const idNum = typeof p?.id === 'number' ? p.id : Number(p?.id);
        if (Number.isFinite(idNum) && idNum > 1e11) candidates.push(Math.floor(idNum));
        // Найраніша мітка = реальний час додавання (після міграції createdAt міг стати «зараз»)
        if (candidates.length) return Math.min(...candidates);
        return Date.now();
    }

    function normalizePoint(p) {
        const id = p.id || (Date.now() + Math.random());
        // means = збиття; zasib = засіб (міграція зі старого comment)
        const means = p.means || 'Інше';
        const zasib = p.zasib || p.comment || p.weapon || 'Інше';
        return {
            id,
            lat: Number(p.lat),
            lon: Number(p.lon),
            radius: Number(p.radius) || 300,
            alt: Number(p.alt ?? p.height ?? p.altitude) || 0,
            comment: p.comment || '',
            means,
            zasib,
            color: p.color || '#ef4444',
            createdAt: resolveCreatedAt({ ...p, id })
        };
    }

    function initApp(engine) {
        const mapType = engine.type;
        const map = engine.map;

        let settings = loadSettings();
        let poiStore = (JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') || []).map(normalizePoint);
        let timestampsRepaired = false;
        // Полагодити createdAt після міграції (щоб часовий фільтр і лічильник працювали)
        poiStore = poiStore.map(p => {
            const fixed = resolveCreatedAt(p);
            if (p.createdAt !== fixed) {
                timestampsRepaired = true;
                return { ...p, createdAt: fixed };
            }
            return p;
        });
        if (timestampsRepaired) localStorage.setItem(STORAGE_KEY, JSON.stringify(poiStore));
        // Коридор лише на цей запуск скрипта — не відновлюємо з минулого разу
        try { localStorage.removeItem(CORRIDOR_KEY); } catch (_) { /* ignore */ }
        let corridor = [];
        let rulerPoints = []; // лише на цей запуск
        let overlayObjects = [];
        let labelOverlays = [];
        let corridorOverlays = [];
        let rulerOverlays = [];
        let isPickMode = false;
        let isCorridorMode = false;
        let isRulerMode = false;
        let showRuler = true;
        let myFlight = null;
        let remoteFlights = {};
        let flightMarkers = {}; // id -> { marker, labelOv, entity }
        let flightRaf = 0;
        let flightPushTimer = 0;
        let applyRemote = false;
        let pickListener = null;
        let corridorListener = null;
        let rulerListener = null;
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
                #falcon-route-ui .fr-body { padding: 10px; flex: 1 1 auto; min-height: 0; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
                #falcon-route-ui .fr-body.hidden { display: none; }
                #falcon-route-ui.fr-collapsed { height: auto !important; max-height: none; }
                #falcon-route-ui .fr-body > * { width: 100%; box-sizing: border-box; margin: 0 0 8px 0; flex: none !important; flex-shrink: 0 !important; }
                #falcon-route-ui .fr-body > *:not(.fr-list) { max-height: none !important; }
                #falcon-route-ui .fr-body > *:last-child { margin-bottom: 0; }
                #falcon-route-ui input:not([type="checkbox"]):not([type="color"]),
                #falcon-route-ui select, #falcon-route-ui textarea, #falcon-route-ui button {
                    -webkit-appearance: none !important; appearance: none !important;
                    box-sizing: border-box !important; max-height: none !important; flex-shrink: 0 !important;
                    font-size: 12px !important; line-height: 1.35 !important;
                }
                #falcon-route-ui textarea { width: 100% !important; height: 96px !important; min-height: 96px !important; background: #0f1015; color: #00ffcc; border: 1px solid #333; border-radius: 4px; padding: 8px !important; font-family: monospace; resize: vertical; }
                #falcon-route-ui .fr-row { display: flex !important; justify-content: space-between; align-items: center; gap: 8px; min-height: 32px; }
                #falcon-route-ui .fr-row > label { flex: 0 0 auto; }
                #falcon-route-ui input:not([type="checkbox"]):not([type="color"]) { background: #0f1015; color: #fff; border: 1px solid #333; border-radius: 4px; padding: 6px 8px !important; min-height: 32px !important; height: 32px !important; }
                #falcon-route-ui select { background: #0f1015; color: #fff; border: 1px solid #333; border-radius: 4px; padding: 6px 8px !important; min-height: 32px !important; height: 32px !important; cursor: pointer; pointer-events: auto !important; }
                #falcon-route-ui input[type="number"] { width: 78px; text-align: center; }
                #falcon-route-ui input[type="text"] { flex: 1 1 auto; min-width: 0; width: auto; }
                #falcon-route-ui input[type="color"] { width: 36px !important; height: 32px !important; min-height: 32px !important; padding: 0 !important; border: none; background: none; cursor: pointer; }
                #falcon-route-ui input[type="checkbox"] {
                    -webkit-appearance: auto !important; appearance: auto !important;
                    width: 18px !important; height: 18px !important; min-width: 18px !important; min-height: 18px !important;
                    margin: 0 8px 0 0 !important; padding: 0 !important; flex: 0 0 18px !important;
                    accent-color: #3b82f6; cursor: pointer; pointer-events: auto !important;
                    background: none !important; border: none !important; position: relative; z-index: 2;
                }
                #falcon-route-ui .fr-check { display: flex !important; align-items: center; gap: 6px; color: #d1d5db; cursor: pointer; user-select: none; pointer-events: auto !important; }
                #falcon-route-ui .fr-row select, #falcon-route-ui select { flex: 1 1 auto; min-width: 0; width: auto; }
                #falcon-route-ui .fr-grid { display: grid !important; grid-template-columns: 1fr 1fr; gap: 6px; }
                #falcon-route-ui .fr-btn { background: #2a2d3d; color: #fff; border: none; padding: 8px 10px !important; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 11px !important; min-height: 34px !important; height: auto !important; }
                #falcon-route-ui .fr-btn:hover { background: #3b82f6; }
                #falcon-route-ui .fr-btn-pick { background: #1e3a8a; color: #60a5fa; border: 1px solid #2563eb; width: 100%; }
                #falcon-route-ui .fr-btn-pick.active { background: #d97706; color: #fff; }
                #falcon-route-ui .fr-btn-danger { background: #451a1a; color: #f87171; }
                #falcon-route-ui .fr-btn-danger:hover { background: #dc2626; color: #fff; }
                #falcon-route-ui .fr-btn-wide { width: 100%; }
                #falcon-route-ui .fr-btn-ok { background: #14532d; color: #86efac; }
                #falcon-route-ui .fr-count { color: #93c5fd; font-size: 11px; font-weight: bold; margin: 0 0 4px 0; }
                #falcon-route-ui .fr-list { max-height: 110px !important; height: 110px !important; overflow-x: hidden; overflow-y: auto !important; background: #0f1015; border: 1px solid #252836; border-radius: 4px; padding: 4px; flex-shrink: 0 !important; }
                #falcon-route-ui .fr-item { display: flex; justify-content: space-between; align-items: flex-start; gap: 6px; padding: 4px; border-bottom: 1px solid #1a1c26; font-family: monospace; font-size: 10px; }
                #falcon-route-ui .fr-item-main { flex: 1; min-width: 0; word-break: break-all; }
                #falcon-route-ui .fr-item-actions { display: flex; gap: 6px; flex-shrink: 0; }
                #falcon-route-ui .fr-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
                #falcon-route-ui .fr-section { border-top: 1px solid #2a2d3d; padding-top: 8px; display: flex !important; flex-direction: column; gap: 6px; }
                #falcon-route-ui .fr-label { color: #9ca3af; font-size: 11px; }
                #falcon-route-ui .fr-sync { font-size: 10px; color: #6b7280; min-height: 14px; }
                #falcon-route-ui .fr-sync.on { color: #4ade80; }
                #falcon-route-ui .fr-sync.err { color: #f87171; }
                #falcon-route-ui .fr-legend { display: flex; flex-wrap: wrap; gap: 6px; }
                #falcon-route-ui .fr-legend span { display: inline-flex; align-items: center; gap: 4px; background: #0f1015; border: 1px solid #252836; border-radius: 4px; padding: 2px 6px; font-size: 10px; }
                #falcon-route-ui .fr-means-row { display: flex; gap: 4px; align-items: center; }
                #falcon-route-ui .fr-means-list { display: flex; flex-direction: column; gap: 4px; max-height: 110px; overflow-y: auto; }
                #falcon-route-ui details.fr-details > summary { cursor: pointer; color: #93c5fd; font-weight: bold; list-style: none; }
                #falcon-route-ui details.fr-details > summary::-webkit-details-marker { display: none; }
                .fr-map-label { position: absolute; transform: translate(-50%, calc(-100% - 14px)); pointer-events: none; white-space: nowrap; text-align: center; z-index: 1; }
                .fr-map-label .fr-means-tag { background: rgba(15,16,21,.92); color: #fde68a; font: bold 10px/1.2 system-ui; padding: 2px 5px; border-radius: 3px; border: 1px solid rgba(253,230,138,.45); max-width: 160px; overflow: hidden; text-overflow: ellipsis; }
                .fr-ruler-label { position: absolute; transform: translate(-50%, -50%); pointer-events: none; white-space: nowrap; z-index: 2; }
                .fr-ruler-label .fr-ruler-chip { background: rgba(8,47,73,.92); color: #e0f2fe; font: bold 10px/1.25 system-ui; padding: 3px 6px; border-radius: 4px; border: 1px solid #38bdf8; box-shadow: 0 2px 8px rgba(0,0,0,.45); }
                #falcon-route-ui .fr-ruler-total { color: #7dd3fc; font-size: 11px; font-weight: bold; line-height: 1.35; }
            </style>
            <div class="fr-head" id="fr-drag">
                <span>🦅 FALCONROUTE v2 (Збиття)</span>
                <span id="fr-toggle" style="cursor:pointer">─</span>
            </div>
            <div class="fr-body" id="fr-main">
                <button class="fr-btn fr-btn-pick" id="fr-pick">🎯 Клацнути на карті</button>

                <div class="fr-row">
                    <label>Збиття:</label>
                    <select id="fr-means"></select>
                </div>
                <div class="fr-row">
                    <label>Засіб:</label>
                    <select id="fr-zasib"></select>
                </div>
                <div class="fr-row">
                    <label>Висота збиття (м):</label>
                    <input type="number" id="fr-alt" value="${settings.defaultAlt}" step="50" min="0">
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
                        <label>Фільтр збиття:</label>
                        <select id="fr-means-filter"></select>
                    </div>
                    <div class="fr-row">
                        <label>Фільтр засобу:</label>
                        <select id="fr-zasib-filter"></select>
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
                    <span class="fr-label" id="fr-corridor-status">Коридор не задано (лише на цей запуск)</span>
                </div>

                <div class="fr-section">
                    <span class="fr-label">Лінійка (відстань / час)</span>
                    <label class="fr-check"><input type="checkbox" id="fr-ruler-show" checked> Показувати лінійку на карті</label>
                    <div class="fr-row">
                        <label>Швидкість (км/год):</label>
                        <input type="number" id="fr-ruler-speed" value="${settings.rulerSpeedKmh || 5}" step="0.5" min="0.1">
                    </div>
                    <div class="fr-grid">
                        <button class="fr-btn fr-btn-pick" id="fr-ruler">📏 Малювати</button>
                        <button class="fr-btn" id="fr-ruler-toggle">👁 Сховати</button>
                    </div>
                    <button class="fr-btn fr-btn-danger fr-btn-wide" id="fr-ruler-clear">Скинути лінійку</button>
                    <div class="fr-ruler-total" id="fr-ruler-status">Лінійка не задана (лише на цей запуск)</div>
                    <div class="fr-row" style="margin-top:6px">
                        <label>Позивний:</label>
                        <input type="text" id="fr-callsign" value="${settings.callsign || 'Falcon'}" maxlength="16" placeholder="Falcon">
                    </div>
                    <div class="fr-row">
                        <label>Колір борта:</label>
                        <input type="color" id="fr-flight-color" value="${settings.flightColor || '#22d3ee'}">
                    </div>
                    <div class="fr-grid">
                        <button class="fr-btn fr-btn-ok" id="fr-flight-start">✈ Старт політ</button>
                        <button class="fr-btn fr-btn-danger" id="fr-flight-stop">⏹ Стоп</button>
                    </div>
                    <div class="fr-label" id="fr-flight-status">Політ: вимкнено (синхрон з іншими через Firebase)</div>
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
                    <summary>⚙ Збиття / кольори</summary>
                    <div class="fr-means-list" id="fr-means-edit"></div>
                    <div class="fr-means-row">
                        <input type="text" id="fr-means-new-name" placeholder="Нове збиття">
                        <input type="color" id="fr-means-new-color" value="#22c55e">
                        <button class="fr-btn" id="fr-means-add">＋</button>
                    </div>
                </details>

                <details class="fr-details fr-section">
                    <summary>⚙ Засоби (без кольорів)</summary>
                    <div class="fr-means-list" id="fr-zasib-edit"></div>
                    <div class="fr-means-row">
                        <input type="text" id="fr-zasib-new-name" placeholder="Новий засіб">
                        <button class="fr-btn" id="fr-zasib-add">＋</button>
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

                <div class="fr-count" id="fr-count">Точок: 0</div>
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
            settings.rulerSpeedKmh = parseFloat(document.getElementById('fr-ruler-speed').value) || 5;
            settings.callsign = (document.getElementById('fr-callsign')?.value || 'Falcon').trim().slice(0, 16) || 'Falcon';
            settings.flightColor = document.getElementById('fr-flight-color')?.value || '#22d3ee';
            settings.showPoints = document.getElementById('fr-show-points').checked;
            settings.coordFormat = document.getElementById('fr-coord-format').value;
            settings.timeFilter = document.getElementById('fr-time-filter').value;
            settings.meansFilter = document.getElementById('fr-means-filter').value;
            settings.zasibFilter = document.getElementById('fr-zasib-filter').value;
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        }

        function getZbyttyaByName(name) {
            return settings.means.find(m => m.name === name)
                || settings.means[settings.means.length - 1]
                || DEFAULT_ZBYTTYA[DEFAULT_ZBYTTYA.length - 1];
        }

        function fillSelect(sel, items, current, fallback) {
            sel.innerHTML = '';
            items.forEach(m => {
                const o = document.createElement('option');
                o.value = m.name;
                o.textContent = m.name;
                sel.appendChild(o);
            });
            if ([...sel.options].some(o => o.value === current)) sel.value = current;
            else if (items[0]) sel.value = items[0].name;
            else if (fallback) sel.value = fallback;
        }

        function fillFilterSelect(sel, items, current, allLabel) {
            sel.innerHTML = '';
            const all = document.createElement('option');
            all.value = 'all';
            all.textContent = allLabel;
            sel.appendChild(all);
            items.forEach(m => {
                const o = document.createElement('option');
                o.value = m.name;
                o.textContent = m.name;
                sel.appendChild(o);
            });
            if ([...sel.options].some(o => o.value === current)) sel.value = current;
            else sel.value = 'all';
        }

        function renderNameListEditor(opts) {
            const {
                editId, listKey, pointKey, minLabel, withColor, onRefresh
            } = opts;
            const edit = document.getElementById(editId);
            edit.innerHTML = '';
            settings[listKey].forEach((m, idx) => {
                const row = document.createElement('div');
                row.className = 'fr-means-row';
                const name = document.createElement('input');
                name.type = 'text';
                name.value = m.name;
                const del = document.createElement('button');
                del.className = 'fr-btn fr-btn-danger';
                del.textContent = '✕';
                const apply = () => {
                    const oldName = m.name;
                    m.name = name.value.trim() || m.name;
                    if (withColor) m.color = color.value;
                    poiStore = poiStore.map(p => {
                        if (p[pointKey] === oldName) {
                            const next = { ...p, [pointKey]: m.name };
                            if (withColor) next.color = m.color;
                            return next;
                        }
                        if (withColor && p[pointKey] === m.name) {
                            return { ...p, color: m.color };
                        }
                        return p;
                    });
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(poiStore));
                    pushToFirebase(poiStore);
                    saveSettings();
                    onRefresh();
                };
                name.onchange = apply;
                let color = null;
                if (withColor) {
                    color = document.createElement('input');
                    color.type = 'color';
                    color.value = m.color || '#9ca3af';
                    color.onchange = apply;
                }
                del.onclick = () => {
                    if (settings[listKey].length <= 1) {
                        alert(minLabel);
                        return;
                    }
                    settings[listKey].splice(idx, 1);
                    saveSettings();
                    onRefresh();
                };
                row.appendChild(name);
                if (color) row.appendChild(color);
                row.appendChild(del);
                edit.appendChild(row);
            });
        }

        function fillCatalogSelects() {
            // Підтягнути значення з точок у списки (міграція comment → засіб тощо)
            poiStore.forEach(p => {
                settings.means = ensureNamedOption(settings.means, p.means);
                settings.zasibs = ensureNamedOption(settings.zasibs, p.zasib);
            });

            fillSelect(document.getElementById('fr-means'), settings.means, document.getElementById('fr-means').value);
            fillSelect(document.getElementById('fr-zasib'), settings.zasibs, document.getElementById('fr-zasib').value);

            fillFilterSelect(document.getElementById('fr-means-filter'), settings.means, settings.meansFilter, 'Усі збиття');
            fillFilterSelect(document.getElementById('fr-zasib-filter'), settings.zasibs, settings.zasibFilter, 'Усі засоби');

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

            renderNameListEditor({
                editId: 'fr-means-edit',
                listKey: 'means',
                pointKey: 'means',
                minLabel: 'Має залишитись хоча б одне збиття.',
                withColor: true,
                onRefresh: () => { fillCatalogSelects(); refreshUI(); }
            });
            renderNameListEditor({
                editId: 'fr-zasib-edit',
                listKey: 'zasibs',
                pointKey: 'zasib',
                minLabel: 'Має залишитись хоча б один засіб.',
                withColor: false,
                onRefresh: () => { fillCatalogSelects(); refreshUI(); }
            });

            saveSettings();
        }

        document.getElementById('fr-coord-format').value = settings.coordFormat;
        document.getElementById('fr-time-filter').value = settings.timeFilter;
        fillCatalogSelects();

        function getTimeMode() {
            return document.getElementById('fr-time-filter')?.value || 'all';
        }

        function passesTimeFilter(pt, mode = getTimeMode()) {
            if (mode === 'all') return true;
            const created = resolveCreatedAt(pt);
            if (!Number.isFinite(created) || created <= 0) return false;
            const age = Date.now() - created;
            if (age < 0) return false;
            if (mode === 'day') return age <= 86400000;
            if (mode === 'week') return age <= 7 * 86400000;
            if (mode === 'month') return age <= 30 * 86400000;
            return true;
        }

        function countByTimeFilter(mode = getTimeMode()) {
            return poiStore.reduce((n, pt) => n + (passesTimeFilter(pt, mode) ? 1 : 0), 0);
        }

        function getVisiblePoints() {
            const meansFilter = document.getElementById('fr-means-filter').value;
            const zasibFilter = document.getElementById('fr-zasib-filter').value;
            const width = parseFloat(document.getElementById('fr-corridor-w').value) || 2000;
            const timeMode = getTimeMode();
            return poiStore.filter(pt => {
                if (!passesTimeFilter(pt, timeMode)) return false;
                if (meansFilter !== 'all' && pt.means !== meansFilter) return false;
                if (zasibFilter !== 'all' && pt.zasib !== zasibFilter) return false;
                if (!pointInCorridor(pt, corridor, width)) return false;
                return true;
            });
        }

        function formatTxt(points, coordFormat) {
            const fmt = coordFormat || document.getElementById('fr-coord-format').value;
            return points.map(p => {
                const c = formatCoord(p.lat, p.lon, fmt);
                return `${c} | H${p.alt || 0}м | збиття:${p.means} | засіб:${p.zasib || ''}`;
            }).join('\n');
        }

        function formatJson(points) {
            return JSON.stringify({
                type: 'FalconRoutePoints',
                version: 2,
                exportedAt: new Date().toISOString(),
                points: points.map(p => ({
                    id: p.id, lat: p.lat, lon: p.lon, radius: p.radius,
                    alt: p.alt, means: p.means, zasib: p.zasib,
                    color: p.color, createdAt: p.createdAt
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
                        means: p.means, zasib: p.zasib,
                        color: p.color, createdAt: p.createdAt
                    }
                }))
            }, null, 2);
        }

        function currentCatalogSelection() {
            const zbyttya = getZbyttyaByName(document.getElementById('fr-means').value);
            return {
                means: zbyttya.name,
                color: zbyttya.color,
                zasib: document.getElementById('fr-zasib').value || 'Інше'
            };
        }

        function parseTxt(text) {
            const defaultRad = parseFloat(document.getElementById('fr-default-rad').value) || 300;
            const defaultAlt = parseFloat(document.getElementById('fr-alt').value) || 0;
            const sel = currentCatalogSelection();
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
                    let alt = defaultAlt;
                    let radius = defaultRad;
                    if (!isNaN(third)) {
                        if (third <= 10000) alt = third;
                        else radius = third;
                    }
                    if (!isNaN(lat) && !isNaN(lon)) {
                        points.push(normalizePoint({
                            id: Date.now() + Math.random(),
                            lat, lon, radius, alt,
                            means: sel.means, zasib: sel.zasib,
                            color: sel.color, createdAt: Date.now()
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
                    zasib: f.properties?.zasib,
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

        function clearRulerOverlays() {
            if (mapType === 'google') {
                rulerOverlays.forEach(obj => {
                    try { obj.setMap(null); } catch (_) { /* ignore */ }
                });
            } else {
                rulerOverlays.forEach(ent => {
                    try { map.entities.remove(ent); } catch (_) { /* ignore */ }
                });
            }
            rulerOverlays = [];
        }

        function getRulerSpeed() {
            const v = parseFloat(document.getElementById('fr-ruler-speed')?.value);
            return Number.isFinite(v) && v > 0 ? v : (settings.rulerSpeedKmh || 5);
        }

        function rulerTotals(points) {
            let totalM = 0;
            for (let i = 0; i < points.length - 1; i++) {
                totalM += haversineM(points[i].lat, points[i].lon, points[i + 1].lat, points[i + 1].lon);
            }
            return totalM;
        }

        function createGoogleRulerLabel(position, text) {
            class FrRulerLabel extends google.maps.OverlayView {
                constructor() {
                    super();
                    this.position = position;
                    this.div = null;
                }
                onAdd() {
                    this.div = document.createElement('div');
                    this.div.className = 'fr-ruler-label';
                    const chip = document.createElement('div');
                    chip.className = 'fr-ruler-chip';
                    chip.textContent = text;
                    this.div.appendChild(chip);
                    this.getPanes().floatPane.appendChild(this.div);
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
            const ov = new FrRulerLabel();
            ov.setMap(map);
            return ov;
        }

        function updateRulerToggleUi() {
            const cb = document.getElementById('fr-ruler-show');
            const btn = document.getElementById('fr-ruler-toggle');
            if (cb) cb.checked = showRuler;
            if (btn) btn.textContent = showRuler ? '👁 Сховати' : '👁 Показати';
        }

        function setShowRuler(on) {
            showRuler = !!on;
            updateRulerToggleUi();
            renderRuler();
        }

        function renderRuler() {
            clearRulerOverlays();
            const status = document.getElementById('fr-ruler-status');
            const speed = getRulerSpeed();
            const pts = rulerPoints;
            updateRulerToggleUi();

            if (!pts.length) {
                status.textContent = isRulerMode
                    ? 'Лінійка: клацай точки на карті…'
                    : 'Лінійка не задана (лише на цей запуск)';
                return;
            }

            const totalM = rulerTotals(pts);
            const base = pts.length < 2
                ? `Точок: ${pts.length} · додай ще точку`
                : `Разом: <b>${formatDistanceKm(totalM)}</b> · ${formatTravelTime(totalM, speed)} при ${speed} км/год · точок: ${pts.length}`;
            status.innerHTML = showRuler ? base : `${base} · <span style="color:#fbbf24">приховано</span>`;

            if (!showRuler) return;

            if (mapType === 'google') {
                if (pts.length >= 2) {
                    const poly = new google.maps.Polyline({
                        path: pts.map(p => ({ lat: p.lat, lng: p.lon })),
                        geodesic: true,
                        strokeColor: '#22d3ee',
                        strokeOpacity: 0.95,
                        strokeWeight: 3,
                        map,
                        zIndex: 160
                    });
                    rulerOverlays.push(poly);
                }

                pts.forEach((p, idx) => {
                    const m = new google.maps.Marker({
                        position: { lat: p.lat, lng: p.lon },
                        map,
                        label: {
                            text: String(idx + 1),
                            color: '#082f49',
                            fontSize: '10px',
                            fontWeight: 'bold'
                        },
                        icon: {
                            path: google.maps.SymbolPath.CIRCLE,
                            scale: 8,
                            fillColor: '#22d3ee',
                            fillOpacity: 1,
                            strokeColor: '#fff',
                            strokeWeight: 1.5,
                            labelOrigin: new google.maps.Point(0, 0)
                        },
                        zIndex: 161
                    });
                    rulerOverlays.push(m);
                });

                for (let i = 0; i < pts.length - 1; i++) {
                    const a = pts[i];
                    const b = pts[i + 1];
                    const segM = haversineM(a.lat, a.lon, b.lat, b.lon);
                    const mid = new google.maps.LatLng((a.lat + b.lat) / 2, (a.lon + b.lon) / 2);
                    const text = `${formatDistanceKm(segM)} · ${formatTravelTime(segM, speed)}`;
                    rulerOverlays.push(createGoogleRulerLabel(mid, text));
                }
                return;
            }

            if (!Cartesian3) return;
            if (pts.length >= 2) {
                const positions = pts.map(p => Cartesian3.fromDegrees(p.lon, p.lat));
                const entity = map.entities.add({
                    polyline: {
                        positions,
                        width: 3,
                        material: { red: 0.13, green: 0.83, blue: 0.93, alpha: 1 }
                    }
                });
                rulerOverlays.push(entity);
            }

            pts.forEach((p, idx) => {
                const ent = map.entities.add({
                    position: Cartesian3.fromDegrees(p.lon, p.lat),
                    point: {
                        pixelSize: 12,
                        color: { red: 0.13, green: 0.83, blue: 0.93, alpha: 1 },
                        outlineColor: { red: 1, green: 1, blue: 1, alpha: 1 },
                        outlineWidth: 2
                    },
                    label: {
                        text: String(idx + 1),
                        font: 'bold 11px sans-serif',
                        fillColor: { red: 1, green: 1, blue: 1, alpha: 1 },
                        outlineColor: { red: 0, green: 0, blue: 0, alpha: 1 },
                        outlineWidth: 2,
                        verticalOrigin: window.Cesium?.VerticalOrigin?.CENTER,
                        disableDepthTestDistance: Number.POSITIVE_INFINITY
                    }
                });
                rulerOverlays.push(ent);
            });

            for (let i = 0; i < pts.length - 1; i++) {
                const a = pts[i];
                const b = pts[i + 1];
                const segM = haversineM(a.lat, a.lon, b.lat, b.lon);
                const text = `${formatDistanceKm(segM)}\n${formatTravelTime(segM, speed)}`;
                const midEnt = map.entities.add({
                    position: Cartesian3.fromDegrees((a.lon + b.lon) / 2, (a.lat + b.lat) / 2),
                    label: {
                        text,
                        font: 'bold 11px sans-serif',
                        fillColor: { red: 0.88, green: 0.95, blue: 0.99, alpha: 1 },
                        outlineColor: { red: 0, green: 0, blue: 0, alpha: 1 },
                        outlineWidth: 3,
                        showBackground: true,
                        backgroundColor: { red: 0.03, green: 0.18, blue: 0.28, alpha: 0.9 },
                        disableDepthTestDistance: Number.POSITIVE_INFINITY
                    }
                });
                rulerOverlays.push(midEnt);
            }
            map.scene?.requestRender?.();
        }

        function createGoogleMeansOverlay(position, meansName) {
            if (!meansName) return null;
            class FrMeansLabel extends google.maps.OverlayView {
                constructor() {
                    super();
                    this.position = position;
                    this.div = null;
                }
                onAdd() {
                    this.div = document.createElement('div');
                    this.div.className = 'fr-map-label';
                    const tag = document.createElement('div');
                    tag.className = 'fr-means-tag';
                    tag.textContent = meansName;
                    this.div.appendChild(tag);
                    this.getPanes().floatPane.appendChild(this.div);
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
            const ov = new FrMeansLabel();
            ov.setMap(map);
            return ov;
        }

        function renderCorridor() {
            clearCorridorOverlays();
            const path = isCorridorMode ? draftCorridor : corridor;
            const status = document.getElementById('fr-corridor-status');
            if (!path.length) {
                status.textContent = 'Коридор не задано (лише на цей запуск)';
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
                    const color = pt.color || getZbyttyaByName(pt.means).color;
                    const altLabel = `${pt.alt || 0}`;

                    const marker = new google.maps.Marker({
                        position,
                        map,
                        label: {
                            text: altLabel,
                            color: '#ffffff',
                            fontSize: altLabel.length > 3 ? '9px' : '10px',
                            fontWeight: 'bold'
                        },
                        icon: {
                            path: google.maps.SymbolPath.CIRCLE,
                            scale: altLabel.length > 3 ? 14 : 12,
                            fillColor: color,
                            fillOpacity: 1,
                            strokeColor: '#fff',
                            strokeWeight: 1.5,
                            labelOrigin: new google.maps.Point(0, 0)
                        },
                        title: `Збиття: ${pt.means} · Засіб: ${pt.zasib || '-'} · ${pt.alt || 0}м`,
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

                    overlayObjects.push(marker, circle);

                    // Над точкою — назва збиття (кольорова категорія)
                    const meansOv = createGoogleMeansOverlay(
                        new google.maps.LatLng(pt.lat, pt.lon),
                        pt.means || ''
                    );
                    if (meansOv) labelOverlays.push(meansOv);
                });
                return;
            }

            visible.forEach(pt => {
                const color = pt.color || getZbyttyaByName(pt.means).color;
                const rgba = hexToRgbA(color, 1);
                const fill = hexToRgbA(color, 0.25);
                const white = { red: 1, green: 1, blue: 1, alpha: 1 };
                const black = { red: 0, green: 0, blue: 0, alpha: 1 };
                const pos = Cartesian3.fromDegrees(pt.lon, pt.lat);

                const entity = map.entities.add({
                    position: pos,
                    point: { pixelSize: 22, color: rgba, outlineColor: white, outlineWidth: 2 },
                    ellipse: {
                        semiMinorAxis: pt.radius,
                        semiMajorAxis: pt.radius,
                        material: fill,
                        outline: true,
                        outlineColor: rgba,
                        outlineWidth: 2
                    },
                    label: {
                        text: `${pt.alt || 0}`,
                        font: 'bold 11px sans-serif',
                        fillColor: white,
                        outlineColor: black,
                        outlineWidth: 3,
                        style: window.Cesium?.LabelStyle?.FILL_AND_OUTLINE,
                        verticalOrigin: window.Cesium?.VerticalOrigin?.CENTER,
                        horizontalOrigin: window.Cesium?.HorizontalOrigin?.CENTER,
                        pixelOffset: window.Cesium?.Cartesian2
                            ? new window.Cesium.Cartesian2(0, 0)
                            : undefined,
                        disableDepthTestDistance: Number.POSITIVE_INFINITY
                    }
                });
                overlayObjects.push(entity);

                if (pt.means) {
                    const meansEnt = map.entities.add({
                        position: pos,
                        label: {
                            text: pt.means,
                            font: 'bold 10px sans-serif',
                            fillColor: { red: 0.99, green: 0.9, blue: 0.54, alpha: 1 },
                            outlineColor: black,
                            outlineWidth: 2,
                            style: window.Cesium?.LabelStyle?.FILL_AND_OUTLINE,
                            verticalOrigin: window.Cesium?.VerticalOrigin?.BOTTOM,
                            horizontalOrigin: window.Cesium?.HorizontalOrigin?.CENTER,
                            pixelOffset: window.Cesium?.Cartesian2
                                ? new window.Cesium.Cartesian2(0, -18)
                                : undefined,
                            showBackground: true,
                            backgroundColor: { red: 0.06, green: 0.06, blue: 0.08, alpha: 0.9 },
                            disableDepthTestDistance: Number.POSITIVE_INFINITY
                        }
                    });
                    overlayObjects.push(meansEnt);
                }
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
            // Не зберігаємо в localStorage — коридор лише на цей запуск скрипта
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
            const countEl = document.getElementById('fr-count');
            if (countEl) {
                const time = getTimeMode();
                const timeLabel = ({ all: 'усі', day: '24 год', week: 'тиждень', month: 'місяць' })[time] || time;
                const timed = countByTimeFilter(time);
                countEl.textContent = time === 'all'
                    ? `Показано: ${visible.length} з ${poiStore.length} · період: усі`
                    : `За період (${timeLabel}): ${timed} з ${poiStore.length} · показано: ${visible.length}`;
            }

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
                const meta = document.createElement('span');
                meta.style.color = '#fde68a';
                meta.textContent = `засіб: ${pt.zasib || '-'}`;
                main.appendChild(meta);
                main.appendChild(document.createElement('br'));
                main.appendChild(document.createTextNode(coord));

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
            renderRuler();
        }

        function stopRulerMode() {
            isRulerMode = false;
            const btn = document.getElementById('fr-ruler');
            if (btn) {
                btn.classList.remove('active');
                btn.textContent = '📏 Малювати';
            }
            if (rulerListener) {
                if (mapType === 'google') {
                    google.maps.event.removeListener(rulerListener);
                } else if (map.canvas) {
                    map.canvas.removeEventListener('click', rulerListener);
                }
                rulerListener = null;
            }
            renderRuler();
        }

        function addRulerPoint(lat, lon) {
            rulerPoints.push({ lat, lon });
            renderRuler();
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
            const sel = currentCatalogSelection();
            saveData([...poiStore, normalizePoint({
                id: Date.now() + Math.random(),
                lat, lon, radius: rad, alt,
                means: sel.means, zasib: sel.zasib,
                color: sel.color, createdAt: Date.now()
            })]);
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

        function onFilterChange() {
            saveSettings();
            refreshUI();
        }

        const showPointsEl = document.getElementById('fr-show-points');
        showPointsEl.addEventListener('change', onFilterChange);
        showPointsEl.addEventListener('input', onFilterChange);

        ['fr-time-filter', 'fr-means-filter', 'fr-zasib-filter'].forEach(id => {
            const el = document.getElementById(id);
            el.addEventListener('change', onFilterChange);
            el.addEventListener('input', onFilterChange);
        });

        document.getElementById('fr-coord-format').addEventListener('change', () => {
            saveSettings();
            renderList();
        });
        document.getElementById('fr-corridor-w').addEventListener('change', onFilterChange);
        document.getElementById('fr-alt').addEventListener('change', () => saveSettings());
        document.getElementById('fr-default-rad').addEventListener('change', () => saveSettings());

        function addNamedItem(listKey, inputId, selectId, emptyMsg, existsMsg) {
            const name = document.getElementById(inputId).value.trim();
            if (!name) {
                alert(emptyMsg);
                return;
            }
            if (settings[listKey].some(m => m.name.toLowerCase() === name.toLowerCase())) {
                alert(existsMsg);
                return;
            }
            const item = { id: listKey[0] + '_' + Date.now(), name };
            if (listKey === 'means') {
                item.color = document.getElementById('fr-means-new-color').value;
            }
            settings[listKey].push(item);
            document.getElementById(inputId).value = '';
            saveSettings();
            fillCatalogSelects();
            document.getElementById(selectId).value = name;
        }

        document.getElementById('fr-means-add').onclick = () => {
            addNamedItem('means', 'fr-means-new-name', 'fr-means', 'Вкажіть назву збиття.', 'Таке збиття уже є.');
        };
        document.getElementById('fr-zasib-add').onclick = () => {
            addNamedItem('zasibs', 'fr-zasib-new-name', 'fr-zasib', 'Вкажіть назву засобу.', 'Такий засіб уже є.');
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
            if (isRulerMode) stopRulerMode();
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
            if (isRulerMode) stopRulerMode();

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

        const rulerBtn = document.getElementById('fr-ruler');
        rulerBtn.onclick = () => {
            if (isPickMode) stopPickMode();
            if (isCorridorMode) stopCorridorMode(false);

            if (isRulerMode) {
                stopRulerMode();
                return;
            }

            isRulerMode = true;
            showRuler = true;
            updateRulerToggleUi();
            rulerBtn.classList.add('active');
            rulerBtn.textContent = '✓ Стоп малювання';
            renderRuler();

            if (mapType === 'google') {
                rulerListener = map.addListener('click', (e) => {
                    if (!e?.latLng) return;
                    addRulerPoint(e.latLng.lat(), e.latLng.lng());
                });
            } else {
                rulerListener = (e) => {
                    const rect = map.canvas.getBoundingClientRect();
                    const clickPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
                    const cartesian = map.camera.pickEllipsoid(clickPos, map.scene.globe.ellipsoid);
                    if (cartesian) {
                        const cartographic = map.scene.globe.ellipsoid.cartesianToCartographic(cartesian);
                        addRulerPoint(
                            cartographic.latitude * 57.29577951308232,
                            cartographic.longitude * 57.29577951308232
                        );
                    }
                };
                map.canvas.addEventListener('click', rulerListener);
            }
        };

        document.getElementById('fr-ruler-clear').onclick = () => {
            if (isRulerMode) stopRulerMode();
            if (myFlight) stopFlight(false);
            rulerPoints = [];
            renderRuler();
        };

        document.getElementById('fr-ruler-toggle').onclick = () => {
            setShowRuler(!showRuler);
        };

        document.getElementById('fr-ruler-show').addEventListener('change', (e) => {
            setShowRuler(e.target.checked);
        });
        document.getElementById('fr-ruler-show').addEventListener('input', (e) => {
            setShowRuler(e.target.checked);
        });

        document.getElementById('fr-ruler-speed').addEventListener('change', () => {
            saveSettings();
            renderRuler();
        });
        document.getElementById('fr-ruler-speed').addEventListener('input', () => {
            renderRuler();
        });

        function myFlightUrl() {
            return FLIGHTS_URL.replace(/flights\.json$/, 'flights/' + CLIENT_ID + '.json');
        }

        function clearFlightMarker(id) {
            const slot = flightMarkers[id];
            if (!slot) return;
            try {
                if (mapType === 'google') {
                    slot.marker?.setMap(null);
                    slot.labelOv?.setMap(null);
                } else {
                    if (slot.entity) map.entities.remove(slot.entity);
                    if (slot.labelEnt) map.entities.remove(slot.labelEnt);
                }
            } catch (_) { /* ignore */ }
            delete flightMarkers[id];
        }

        function clearAllFlightMarkers() {
            Object.keys(flightMarkers).forEach(clearFlightMarker);
        }

        function createFlightCallsignOverlay(position, text, color) {
            class FrFlightLabel extends google.maps.OverlayView {
                constructor() {
                    super();
                    this.position = position;
                    this.div = null;
                    this.text = text;
                    this.color = color;
                }
                onAdd() {
                    this.div = document.createElement('div');
                    this.div.className = 'fr-ruler-label';
                    const chip = document.createElement('div');
                    chip.className = 'fr-ruler-chip';
                    chip.style.borderColor = this.color || '#22d3ee';
                    chip.textContent = this.text;
                    this.div.appendChild(chip);
                    this.getPanes().floatPane.appendChild(this.div);
                }
                draw() {
                    const proj = this.getProjection();
                    if (!proj || !this.div) return;
                    const p = proj.fromLatLngToDivPixel(this.position);
                    if (!p) return;
                    this.div.style.left = p.x + 'px';
                    this.div.style.top = (p.y - 22) + 'px';
                }
                onRemove() {
                    if (this.div?.parentNode) this.div.parentNode.removeChild(this.div);
                    this.div = null;
                }
                setPos(latLng) {
                    this.position = latLng;
                    this.draw();
                }
            }
            const ov = new FrFlightLabel();
            ov.setMap(map);
            return ov;
        }

        function upsertFlightMarker(id, flight, pos) {
            if (!pos) return;
            const color = flight.color || '#22d3ee';
            const callsign = flight.callsign || id.slice(0, 8);
            const isMe = id === CLIENT_ID;

            if (mapType === 'google') {
                let slot = flightMarkers[id];
                if (!slot) {
                    const marker = new google.maps.Marker({
                        position: { lat: pos.lat, lng: pos.lon },
                        map,
                        icon: {
                            path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
                            scale: isMe ? 7 : 6,
                            fillColor: color,
                            fillOpacity: 1,
                            strokeColor: '#fff',
                            strokeWeight: 1.5,
                            rotation: pos.heading || 0
                        },
                        zIndex: 200,
                        title: callsign
                    });
                    const labelOv = createFlightCallsignOverlay(
                        new google.maps.LatLng(pos.lat, pos.lon),
                        (isMe ? '● ' : '') + callsign,
                        color
                    );
                    flightMarkers[id] = { marker, labelOv };
                    slot = flightMarkers[id];
                } else {
                    slot.marker.setPosition({ lat: pos.lat, lng: pos.lon });
                    slot.marker.setIcon({
                        path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
                        scale: isMe ? 7 : 6,
                        fillColor: color,
                        fillOpacity: 1,
                        strokeColor: '#fff',
                        strokeWeight: 1.5,
                        rotation: pos.heading || 0
                    });
                    slot.labelOv?.setPos(new google.maps.LatLng(pos.lat, pos.lon));
                }
                return;
            }

            if (!Cartesian3) return;
            let slot = flightMarkers[id];
            const rgba = hexToRgbA(color, 1);
            if (!slot) {
                const entity = map.entities.add({
                    position: Cartesian3.fromDegrees(pos.lon, pos.lat),
                    point: {
                        pixelSize: isMe ? 16 : 14,
                        color: rgba,
                        outlineColor: { red: 1, green: 1, blue: 1, alpha: 1 },
                        outlineWidth: 2
                    }
                });
                const labelEnt = map.entities.add({
                    position: Cartesian3.fromDegrees(pos.lon, pos.lat),
                    label: {
                        text: (isMe ? '● ' : '') + callsign,
                        font: 'bold 11px sans-serif',
                        fillColor: { red: 1, green: 1, blue: 1, alpha: 1 },
                        outlineColor: { red: 0, green: 0, blue: 0, alpha: 1 },
                        outlineWidth: 3,
                        pixelOffset: window.Cesium?.Cartesian2
                            ? new window.Cesium.Cartesian2(0, -18)
                            : undefined,
                        showBackground: true,
                        backgroundColor: { red: 0.03, green: 0.18, blue: 0.28, alpha: 0.85 },
                        disableDepthTestDistance: Number.POSITIVE_INFINITY
                    }
                });
                flightMarkers[id] = { entity, labelEnt };
            } else {
                slot.entity.position = Cartesian3.fromDegrees(pos.lon, pos.lat);
                slot.labelEnt.position = Cartesian3.fromDegrees(pos.lon, pos.lat);
            }
            map.scene?.requestRender?.();
        }

        function setFlightStatus(text) {
            const el = document.getElementById('fr-flight-status');
            if (el) el.textContent = text;
        }

        async function pushMyFlight() {
            if (!FIREBASE_ENABLED || !myFlight) return;
            myFlight.updatedAt = Date.now();
            try {
                await fetch(myFlightUrl(), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(myFlight)
                });
            } catch (err) {
                console.warn('[FALCONROUTE] flight PUT failed:', err);
            }
        }

        async function clearMyFlightRemote() {
            if (!FIREBASE_ENABLED) return;
            try {
                await fetch(myFlightUrl(), { method: 'DELETE' });
            } catch (err) {
                console.warn('[FALCONROUTE] flight DELETE failed:', err);
            }
        }

        function stopFlightLoop() {
            if (flightRaf) {
                cancelAnimationFrame(flightRaf);
                flightRaf = 0;
            }
            if (flightPushTimer) {
                clearInterval(flightPushTimer);
                flightPushTimer = 0;
            }
        }

        function tickFlights() {
            const now = Date.now();
            const activeIds = new Set();

            if (myFlight?.active) {
                const pos = positionAlongPath(myFlight.path, myFlight.speedKmh, myFlight.startedAt, now);
                if (!pos) {
                    stopFlight(false);
                } else {
                    upsertFlightMarker(CLIENT_ID, myFlight, pos);
                    activeIds.add(CLIENT_ID);
                    const left = Math.max(0, (pos.totalM || 0) - (pos.traveledM || 0));
                    setFlightStatus(
                        pos.done
                            ? `Політ завершено · ${myFlight.callsign}`
                            : `В польоті: ${myFlight.callsign} · ${formatDistanceKm(pos.traveledM || 0)} / ${formatDistanceKm(pos.totalM || 0)} · лишилось ${formatTravelTime(left, myFlight.speedKmh)}`
                    );
                    if (pos.done) stopFlight(true);
                }
            }

            Object.keys(remoteFlights).forEach(id => {
                if (id === CLIENT_ID) return;
                const f = remoteFlights[id];
                if (!f?.active || !f.path || f.path.length < 2) return;
                if (now - (f.updatedAt || f.startedAt || 0) > 120000) return;
                const pos = positionAlongPath(f.path, f.speedKmh, f.startedAt, now);
                if (!pos || pos.done) return;
                upsertFlightMarker(id, f, pos);
                activeIds.add(id);
            });

            Object.keys(flightMarkers).forEach(id => {
                if (!activeIds.has(id)) clearFlightMarker(id);
            });

            flightRaf = requestAnimationFrame(tickFlights);
        }

        function startFlightLoop() {
            if (flightRaf) return;
            flightRaf = requestAnimationFrame(tickFlights);
        }

        function stopFlight(completed) {
            const was = myFlight;
            myFlight = null;
            stopFlightLoop();
            // keep loop if remotes still flying
            if (Object.keys(remoteFlights).some(id => id !== CLIENT_ID && remoteFlights[id]?.active)) {
                startFlightLoop();
            }
            clearFlightMarker(CLIENT_ID);
            clearMyFlightRemote();
            const btn = document.getElementById('fr-flight-start');
            if (btn) {
                btn.disabled = false;
                btn.textContent = '✈ Старт політ';
            }
            setFlightStatus(completed
                ? `Політ завершено${was ? ' · ' + was.callsign : ''}`
                : 'Політ: вимкнено (синхрон з іншими через Firebase)');
        }

        function startFlight() {
            if (rulerPoints.length < 2) {
                alert('Спочатку намалюй лінійку мінімум з 2 точок.');
                return;
            }
            saveSettings();
            if (isRulerMode) stopRulerMode();

            const path = rulerPoints.map(p => ({ lat: p.lat, lon: p.lon }));
            const speed = getRulerSpeed();
            const callsign = (document.getElementById('fr-callsign').value || 'Falcon').trim().slice(0, 16) || 'Falcon';
            const color = document.getElementById('fr-flight-color').value || '#22d3ee';

            myFlight = {
                id: CLIENT_ID,
                callsign,
                color,
                path,
                speedKmh: speed,
                startedAt: Date.now(),
                updatedAt: Date.now(),
                active: true
            };

            showRuler = true;
            updateRulerToggleUi();
            document.getElementById('fr-flight-start').textContent = '✈ В польоті…';
            document.getElementById('fr-flight-start').disabled = true;
            setFlightStatus(`Старт: ${callsign} · ${speed} км/год`);

            pushMyFlight();
            if (flightPushTimer) clearInterval(flightPushTimer);
            flightPushTimer = setInterval(pushMyFlight, 4000);
            startFlightLoop();
        }

        function listenToFlights() {
            if (!FIREBASE_ENABLED) return;
            try {
                const es = new EventSource(FLIGHTS_URL);
                es.addEventListener('put', (e) => {
                    try {
                        const res = JSON.parse(e.data);
                        if (res.path === '/') {
                            remoteFlights = (res.data && typeof res.data === 'object') ? res.data : {};
                        } else {
                            const key = String(res.path || '').replace(/^\//, '');
                            if (!key) return;
                            if (res.data === null) delete remoteFlights[key];
                            else remoteFlights[key] = res.data;
                        }
                        // не затирати свій активний політ з remote
                        if (myFlight) remoteFlights[CLIENT_ID] = myFlight;
                        startFlightLoop();
                    } catch (err) {
                        console.warn('[FALCONROUTE] flights sync parse error', err);
                    }
                });
                es.addEventListener('patch', (e) => {
                    try {
                        const res = JSON.parse(e.data);
                        if (res.path === '/' && res.data && typeof res.data === 'object') {
                            remoteFlights = { ...remoteFlights, ...res.data };
                            if (myFlight) remoteFlights[CLIENT_ID] = myFlight;
                            startFlightLoop();
                        }
                    } catch (_) { /* ignore */ }
                });
                es.onerror = () => {
                    /* auto-reconnect by EventSource */
                };
            } catch (err) {
                console.warn('[FALCONROUTE] flights EventSource failed', err);
            }
        }

        document.getElementById('fr-flight-start').onclick = () => startFlight();
        document.getElementById('fr-flight-stop').onclick = () => stopFlight(false);
        document.getElementById('fr-callsign').addEventListener('change', () => saveSettings());
        document.getElementById('fr-flight-color').addEventListener('change', () => saveSettings());

        window.addEventListener('beforeunload', () => {
            if (!myFlight) return;
            myFlight = null;
            try {
                fetch(myFlightUrl(), { method: 'DELETE', keepalive: true });
            } catch (_) { /* ignore */ }
        });

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
                        const normalized = raw.map(normalizePoint);
                        const needRepair = normalized.some((p, i) => {
                            const rawTs = Number(raw[i]?.createdAt);
                            return !Number.isFinite(rawTs) || Math.abs(rawTs - p.createdAt) > 1000;
                        });
                        poiStore = normalized;
                        localStorage.setItem(STORAGE_KEY, JSON.stringify(poiStore));
                        refreshUI();
                        applyRemote = false;
                        if (needRepair) pushToFirebase(poiStore);
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
        listenToFlights();
        if (timestampsRepaired) pushToFirebase(poiStore);
        console.log(`🦅 FALCONROUTE v2 завантажено! (${mapType === 'google' ? 'Google Maps / R2D2' : 'Cesium'}) — лінійка/політ/синхрон`);
    }

    document.getElementById('falcon-route-ui')?.remove();
    document.getElementById('falcon-route-tip')?.remove();
    boot(0);
})();
