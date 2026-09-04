(function () {
    'use strict';

    // ========== Конфіг Firebase ==========
    const FIREBASE_ROOT = 'https://script-poi-default-rtdb.europe-west1.firebasedatabase.app';
    const DEFAULT_ROOM = 'falcon-route-default';
    const LICENSE_KEY_STORAGE = 'falcon_route_license_v1';
    const LICENSE_META_STORAGE = 'falcon_route_license_meta_v1';
    const LICENSE_RECHECK_MS = 60000;

    let activeLicenseKey = '';
    let activeLicenseMeta = null;
    let licenseWatchTimer = 0;
    let accessRevoked = false;

    function roomPointsUrl(room) {
        return `${FIREBASE_ROOT}/rooms/${encodeURIComponent(room)}/points.json`;
    }
    function roomFlightsUrl(room) {
        return `${FIREBASE_ROOT}/rooms/${encodeURIComponent(room)}/flights.json`;
    }
    function licenseRecordUrl(key) {
        return `${FIREBASE_ROOT}/licenses/${encodeURIComponent(key)}.json`;
    }

    let DB_URL = roomPointsUrl(DEFAULT_ROOM);
    let FLIGHTS_URL = roomFlightsUrl(DEFAULT_ROOM);
    const FIREBASE_ENABLED = !FIREBASE_ROOT.includes('ВАШ_ПРОЄКТ');
    const STORAGE_KEY = 'cesium_falcon_route_points_v1';
    const SETTINGS_KEY = 'cesium_falcon_route_settings_v1';
    const CORRIDOR_KEY = 'cesium_falcon_route_corridor_v1';
    const CLIENT_KEY = 'falcon_route_client_id_v1';
    const MAX_BOOT_ATTEMPTS = 40;

    function normalizeLicenseKey(raw) {
        return String(raw || '')
            .trim()
            .toUpperCase()
            .replace(/\s+/g, '')
            .replace(/[^A-Z0-9_-]/g, '');
    }

    function getSavedLicenseKey() {
        try { return normalizeLicenseKey(localStorage.getItem(LICENSE_KEY_STORAGE) || ''); }
        catch (_) { return ''; }
    }

    function saveLicenseKey(key) {
        try { localStorage.setItem(LICENSE_KEY_STORAGE, key); } catch (_) { /* ignore */ }
    }

    function clearLicenseKey() {
        try {
            localStorage.removeItem(LICENSE_KEY_STORAGE);
            localStorage.removeItem(LICENSE_META_STORAGE);
        } catch (_) { /* ignore */ }
        activeLicenseKey = '';
        activeLicenseMeta = null;
    }

    function applyLicenseRoom(meta) {
        const room = String(meta?.room || DEFAULT_ROOM).trim() || DEFAULT_ROOM;
        DB_URL = roomPointsUrl(room);
        FLIGHTS_URL = roomFlightsUrl(room);
        activeLicenseMeta = { ...(meta || {}), room };
        try { localStorage.setItem(LICENSE_META_STORAGE, JSON.stringify(activeLicenseMeta)); } catch (_) { /* ignore */ }
    }

    function isLicensePayloadValid(data) {
        if (!data || typeof data !== 'object') return { ok: false, reason: 'Ключ не знайдено' };
        if (data.allowed === false || data.banned === true) {
            return { ok: false, reason: 'Доступ заборонено (бан)' };
        }
        if (data.allowed !== true) {
            return { ok: false, reason: 'Ключ не активовано' };
        }
        if (data.expiresAt) {
            const exp = Date.parse(data.expiresAt) || Number(data.expiresAt);
            if (Number.isFinite(exp) && Date.now() > exp) {
                return { ok: false, reason: 'Термін дії ключа закінчився' };
            }
        }
        return { ok: true, reason: '' };
    }

    async function fetchLicense(key) {
        const url = licenseRecordUrl(key);
        const res = await fetch(url, { cache: 'no-store' });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return data;
    }

    function showAccessBlocked(message) {
        accessRevoked = true;
        try {
            if (licenseWatchTimer) clearInterval(licenseWatchTimer);
            licenseWatchTimer = 0;
        } catch (_) { /* ignore */ }
        document.getElementById('falcon-route-ui')?.remove();
        document.getElementById('falcon-route-tip')?.remove();
        document.getElementById('falcon-route-license')?.remove();
        document.getElementById('falcon-route-blocked')?.remove();
        const box = document.createElement('div');
        box.id = 'falcon-route-blocked';
        box.style.cssText = 'position:fixed;inset:0;z-index:99999999;background:rgba(8,10,16,.72);display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif';
        box.innerHTML = `
            <div style="width:min(420px,92vw);background:#151925;border:1px solid #334155;border-radius:14px;padding:18px 16px;color:#e2e8f0;box-shadow:0 20px 50px rgba(0,0,0,.55)">
                <div style="font-weight:750;font-size:16px;margin-bottom:8px;color:#fca5a5">⛔ Доступ закрито</div>
                <div id="fr-blocked-msg" style="font-size:13px;line-height:1.45;color:#cbd5e1;margin-bottom:14px"></div>
                <button id="fr-license-retry" style="width:100%;height:38px;border:0;border-radius:10px;background:#0ea5e9;color:#082f49;font-weight:750;cursor:pointer">Ввести інший ключ</button>
            </div>`;
        document.body.appendChild(box);
        box.querySelector('#fr-blocked-msg').textContent = message || 'Немає дозволу на використання FalconRoute.';
        box.querySelector('#fr-license-retry').onclick = () => {
            clearLicenseKey();
            box.remove();
            ensureLicensed().then((ok) => { if (ok) boot(0); });
        };
    }

    function promptLicenseKey(prefill, errorText) {
        return new Promise((resolve) => {
            document.getElementById('falcon-route-license')?.remove();
            const wrap = document.createElement('div');
            wrap.id = 'falcon-route-license';
            wrap.style.cssText = 'position:fixed;inset:0;z-index:99999999;background:rgba(8,10,16,.72);display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif';
            wrap.innerHTML = `
                <div style="width:min(420px,92vw);background:#151925;border:1px solid #334155;border-radius:14px;padding:18px 16px;color:#e2e8f0;box-shadow:0 20px 50px rgba(0,0,0,.55)">
                    <div style="font-weight:750;font-size:16px;margin-bottom:6px;color:#7dd3fc">🦅 FalconRoute — доступ</div>
                    <div style="font-size:12px;line-height:1.45;color:#94a3b8;margin-bottom:12px">Введи ключ доступу, який тобі видали. Без валідного ключа скрипт не запуститься.</div>
                    <label style="display:block;font-size:11px;color:#94a3b8;margin-bottom:4px">Ключ</label>
                    <input id="fr-license-input" type="text" autocomplete="off" spellcheck="false"
                        placeholder="Наприклад FR-7K2M"
                        style="width:100%;height:38px;border-radius:10px;border:1px solid #334155;background:#0b0e14;color:#fff;padding:0 10px;margin-bottom:8px;box-sizing:border-box;font-size:14px;letter-spacing:.04em" />
                    <div id="fr-license-err" style="min-height:18px;font-size:12px;color:#f87171;margin-bottom:10px"></div>
                    <button id="fr-license-ok" style="width:100%;height:38px;border:0;border-radius:10px;background:#0ea5e9;color:#082f49;font-weight:750;cursor:pointer">Увійти</button>
                </div>`;
            document.body.appendChild(wrap);
            const input = wrap.querySelector('#fr-license-input');
            const err = wrap.querySelector('#fr-license-err');
            const btn = wrap.querySelector('#fr-license-ok');
            if (prefill) input.value = prefill;
            if (errorText) err.textContent = errorText;
            const submit = () => {
                const key = normalizeLicenseKey(input.value);
                if (!key) {
                    err.textContent = 'Введи ключ';
                    return;
                }
                wrap.remove();
                resolve(key);
            };
            btn.onclick = submit;
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') submit();
            });
            setTimeout(() => input.focus(), 50);
        });
    }

    async function validateAndActivateLicense(key) {
        const data = await fetchLicense(key);
        const check = isLicensePayloadValid(data);
        if (!check.ok) {
            return { ok: false, reason: check.reason };
        }
        activeLicenseKey = key;
        saveLicenseKey(key);
        applyLicenseRoom(data);
        accessRevoked = false;
        return { ok: true, data };
    }

    async function ensureLicensed() {
        if (!FIREBASE_ENABLED) return true;
        let key = getSavedLicenseKey();
        let lastError = '';
        for (;;) {
            if (!key) {
                key = await promptLicenseKey('', lastError);
            }
            try {
                const res = await validateAndActivateLicense(key);
                if (res.ok) {
                    console.log('[FALCONROUTE] license ok:', key, activeLicenseMeta?.name || '');
                    startLicenseWatch();
                    return true;
                }
                lastError = res.reason || 'Невалідний ключ';
                clearLicenseKey();
                key = '';
            } catch (err) {
                lastError = 'Не вдалося перевірити ключ (мережа / Firebase). Спробуй ще.';
                console.warn('[FALCONROUTE] license check failed', err);
                key = await promptLicenseKey(key, lastError);
            }
        }
    }

    async function recheckLicense() {
        if (!FIREBASE_ENABLED || accessRevoked || !activeLicenseKey) return;
        try {
            const data = await fetchLicense(activeLicenseKey);
            const check = isLicensePayloadValid(data);
            if (!check.ok) {
                clearLicenseKey();
                showAccessBlocked(check.reason);
                return;
            }
            applyLicenseRoom(data);
            const el = document.getElementById('fr-license-status');
            if (el) {
                const who = data.name ? ` · ${data.name}` : '';
                el.textContent = `Ключ: ${activeLicenseKey}${who}`;
            }
        } catch (err) {
            console.warn('[FALCONROUTE] license recheck failed', err);
        }
    }

    function startLicenseWatch() {
        if (licenseWatchTimer) clearInterval(licenseWatchTimer);
        licenseWatchTimer = setInterval(recheckLicense, LICENSE_RECHECK_MS);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') recheckLicense();
        });
    }

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
        rulerColor: '#22d3ee',
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

    function destinationPoint(lat, lon, bearing, distM) {
        const R = 6371000;
        const δ = Math.max(0, distM) / R;
        const θ = toRad(bearing);
        const φ1 = toRad(lat);
        const λ1 = toRad(lon);
        const sinφ1 = Math.sin(φ1);
        const cosφ1 = Math.cos(φ1);
        const sinδ = Math.sin(δ);
        const cosδ = Math.cos(δ);
        const φ2 = Math.asin(sinφ1 * cosδ + cosφ1 * sinδ * Math.cos(θ));
        const λ2 = λ1 + Math.atan2(
            Math.sin(θ) * sinδ * cosφ1,
            cosδ - sinφ1 * Math.sin(φ2)
        );
        return {
            lat: toDeg(φ2),
            lon: ((toDeg(λ2) + 540) % 360) - 180
        };
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

    const FR_BUILD = 'aim-target-22';

    // Реєстр маркерів карти-хоста (треки/стрілки не з FalconRoute)
    const hostMarkerRegistry = new Set();
    const hostAdvancedRegistry = new Set();

    function markOwnOverlay(obj) {
        try {
            if (obj) obj.__frOwn = true;
        } catch (_) { /* ignore */ }
    }

    function isOwnOverlay(obj) {
        try {
            return !!(obj && obj.__frOwn);
        } catch (_) {
            return false;
        }
    }

    function wrapProtoMethod(proto, name, onCall) {
        if (!proto) return;
        const orig = proto[name];
        if (typeof orig !== 'function' || orig.__frWrapped) return;
        function wrapped(...args) {
            try { onCall(this, args); } catch (_) { /* ignore */ }
            return orig.apply(this, args);
        }
        wrapped.__frWrapped = true;
        proto[name] = wrapped;
    }

    function installHostTrackSpy() {
        if (!window.google?.maps?.Marker) return false;
        if (window.__frHostTrackSpyInstalled) return true;
        window.__frHostTrackSpyInstalled = true;

        wrapProtoMethod(google.maps.Marker.prototype, 'setMap', (m) => {
            if (m && !isOwnOverlay(m)) hostMarkerRegistry.add(m);
        });
        wrapProtoMethod(google.maps.Marker.prototype, 'setPosition', (m) => {
            if (m && !isOwnOverlay(m)) hostMarkerRegistry.add(m);
        });
        wrapProtoMethod(google.maps.Marker.prototype, 'setIcon', (m) => {
            if (m && !isOwnOverlay(m)) hostMarkerRegistry.add(m);
        });

        const AME = google.maps.marker?.AdvancedMarkerElement;
        if (AME) {
            const desc = Object.getOwnPropertyDescriptor(AME.prototype, 'position');
            if (desc?.set && !desc.set.__frWrapped) {
                const origSet = desc.set;
                const wrappedSet = function (v) {
                    try {
                        if (this && !isOwnOverlay(this)) hostAdvancedRegistry.add(this);
                    } catch (_) { /* ignore */ }
                    return origSet.call(this, v);
                };
                wrappedSet.__frWrapped = true;
                Object.defineProperty(AME.prototype, 'position', {
                    ...desc,
                    set: wrappedSet
                });
            }
            wrapProtoMethod(AME.prototype, 'remove', (m) => {
                try { hostAdvancedRegistry.delete(m); } catch (_) { /* ignore */ }
            });
        }

        console.log('[FALCONROUTE] host-track spy: markers will be tracked for attach');
        return true;
    }

    // Спроба рано, поки карта вже крутить треки
    installHostTrackSpy();
    const _spyTimer = setInterval(() => {
        if (installHostTrackSpy()) clearInterval(_spyTimer);
    }, 500);
    setTimeout(() => clearInterval(_spyTimer), 60000);

    function latLonFromGooglePos(pos) {
        if (!pos) return null;
        try {
            if (typeof pos.lat === 'function') {
                return { lat: pos.lat(), lon: pos.lng() };
            }
            if (Number.isFinite(pos.lat) && Number.isFinite(pos.lng)) {
                return { lat: pos.lat, lon: pos.lng };
            }
            if (Number.isFinite(pos.latitude) && Number.isFinite(pos.longitude)) {
                return { lat: pos.latitude, lon: pos.longitude };
            }
        } catch (_) { /* ignore */ }
        return null;
    }

    function headingFromGoogleIcon(icon) {
        if (!icon || typeof icon !== 'object') return null;
        if (Number.isFinite(icon.rotation)) return ((icon.rotation % 360) + 360) % 360;
        return null;
    }

    function looksLikeTrackArrow(marker) {
        try {
            const icon = marker.getIcon?.();
            if (!icon) return true; // невідомо — дозволяємо обрати кліком
            if (typeof icon === 'string') return true;
            const path = icon.path;
            if (path === google.maps.SymbolPath.FORWARD_CLOSED_ARROW) return true;
            if (path === google.maps.SymbolPath.FORWARD_OPEN_ARROW) return true;
            if (Number.isFinite(icon.rotation)) return true;
            if (typeof path === 'string' && path.length > 8) return true;
            return true;
        } catch (_) {
            return true;
        }
    }

    function readMarkerPose(marker) {
        try {
            if (!marker || isOwnOverlay(marker)) return null;
            if (typeof marker.getMap === 'function' && marker.getMap() == null) return null;
            const ll = latLonFromGooglePos(marker.getPosition?.());
            if (!ll) return null;
            const heading = headingFromGoogleIcon(marker.getIcon?.());
            return { lat: ll.lat, lon: ll.lon, heading };
        } catch (_) {
            return null;
        }
    }

    function readAdvancedPose(el) {
        try {
            if (!el || isOwnOverlay(el)) return null;
            if (el.map == null) return null;
            const ll = latLonFromGooglePos(el.position);
            if (!ll) return null;
            return { lat: ll.lat, lon: ll.lon, heading: null };
        } catch (_) {
            return null;
        }
    }

    function collectHostTrackCandidates(mapInstance) {
        const list = [];
        hostMarkerRegistry.forEach((m) => {
            if (isOwnOverlay(m)) return;
            try {
                if (mapInstance && typeof m.getMap === 'function' && m.getMap() !== mapInstance) return;
            } catch (_) { return; }
            const pose = readMarkerPose(m);
            if (!pose) return;
            if (!looksLikeTrackArrow(m)) return;
            list.push({ kind: 'marker', obj: m, pose });
        });
        hostAdvancedRegistry.forEach((el) => {
            if (isOwnOverlay(el)) return;
            try {
                if (mapInstance && el.map && el.map !== mapInstance) return;
            } catch (_) { return; }
            const pose = readAdvancedPose(el);
            if (!pose) return;
            list.push({ kind: 'advanced', obj: el, pose });
        });
        return list;
    }

    function findNearestHostTrack(mapInstance, lat, lon, maxM) {
        const limit = Number.isFinite(maxM) ? maxM : 2500;
        let best = null;
        let bestD = limit;
        collectHostTrackCandidates(mapInstance).forEach((c) => {
            const d = haversineM(lat, lon, c.pose.lat, c.pose.lon);
            if (d < bestD) {
                bestD = d;
                best = { ...c, distM: d };
            }
        });
        return best;
    }

    function readHostTrackPose(track) {
        if (!track) return null;
        if (track.kind === 'marker') return readMarkerPose(track.obj);
        if (track.kind === 'advanced') return readAdvancedPose(track.obj);
        if (track.kind === 'cesium') {
            try {
                const Cesium = window.Cesium;
                const entity = track.obj;
                if (!entity || entity.__frOwn) return null;
                const time = track.clock?.currentTime || Cesium?.JulianDate?.now?.();
                let cartesian = null;
                if (entity.position?.getValue && time) cartesian = entity.position.getValue(time);
                else if (entity.position) cartesian = entity.position;
                if (!cartesian || !Cesium) return null;
                const carto = Cesium.Cartographic.fromCartesian(cartesian);
                if (!carto) return null;
                let heading = null;
                const orient = entity.orientation?.getValue?.(time) || entity.orientation;
                if (orient && Cesium.HeadingPitchRoll) {
                    try {
                        const hpr = Cesium.HeadingPitchRoll.fromQuaternion(orient);
                        if (hpr) heading = (Cesium.Math.toDegrees(hpr.heading) + 360) % 360;
                    } catch (_) { /* ignore */ }
                }
                const rot = entity.billboard?.rotation?.getValue?.(time) ?? entity.billboard?.rotation;
                if (heading == null && Number.isFinite(rot)) {
                    heading = ((90 - (rot * 180 / Math.PI)) + 360) % 360;
                }
                return {
                    lat: carto.latitude * 57.29577951308232,
                    lon: carto.longitude * 57.29577951308232,
                    heading
                };
            } catch (_) {
                return null;
            }
        }
        if (track.kind === 'getter' && typeof track.getPose === 'function') {
            try { return track.getPose(); } catch (_) { return null; }
        }
        return null;
    }

    // Силует літака (ніс вгору / на північ), для Google Symbol path
    const PLANE_SYMBOL_PATH =
        'M 0,-22 L 4,-5 L 17,-1.5 L 17,2 L 4.2,3.2 L 2.5,14 L 7.5,17 L 7.5,19.5 L 0,16.2 L -7.5,19.5 L -7.5,17 L -2.5,14 L -4.2,3.2 L -17,2 L -17,-1.5 L -4,-5 Z';

    const planeBillboardCache = Object.create(null);

    function toCesiumColor(hexOrObj, alpha) {
        const Cesium = window.Cesium;
        const o = typeof hexOrObj === 'string'
            ? hexToRgbA(hexOrObj, alpha ?? 1)
            : {
                red: hexOrObj.red,
                green: hexOrObj.green,
                blue: hexOrObj.blue,
                alpha: alpha ?? hexOrObj.alpha ?? 1
            };
        if (Cesium?.Color) return new Cesium.Color(o.red, o.green, o.blue, o.alpha);
        return o;
    }

    function planeBillboardImage(color) {
        const key = String(color || '#22d3ee').toLowerCase() + '|v6sm70';
        if (planeBillboardCache[key]) return planeBillboardCache[key];
        const fill = String(color || '#22d3ee').toLowerCase();
        // Менший силует + ~70% непрозорості (на 30% прозоріший)
        const svg =
            `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">` +
            `<g transform="translate(36 36)" opacity="0.7">` +
            `<line x1="0" y1="-8" x2="0" y2="-20" stroke="#fbbf24" stroke-width="2" stroke-linecap="round"/>` +
            `<g transform="scale(0.78)">` +
            `<path d="${PLANE_SYMBOL_PATH}" fill="${fill}" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/>` +
            `</g></g></svg>`;
        planeBillboardCache[key] = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
        return planeBillboardCache[key];
    }

    function rulerVertexDataUrl(index, fill) {
        const n = String(index);
        const svg =
            `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">` +
            `<circle cx="36" cy="36" r="24" fill="rgba(8,47,73,0.55)"/>` +
            `<circle cx="36" cy="36" r="18" fill="${fill}" stroke="#ffffff" stroke-width="3.5"/>` +
            `<text x="36" y="37" text-anchor="middle" dominant-baseline="middle" ` +
            `font-family="system-ui,-apple-system,sans-serif" font-weight="700" font-size="${n.length > 1 ? 18 : 20}" fill="#082f49">${n}</text>` +
            `</svg>`;
        return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
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
        console.log('[FALCONROUTE] init', FR_BUILD, mapType);

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
        let aimTarget = null; // { lat, lon } — ціль на карті
        let aimOverlays = [];
        let aimTrack = null;
        let isAimPlaceMode = false;
        let aimPlaceListener = null;
        let isPickMode = false;
        let isCoordPickMode = false;
        let isCorridorMode = false;
        let isRulerMode = false;
        let showRuler = true;
        let myFlight = null;
        let remoteFlights = {};
        let flightMarkers = {};
        let flightRaf = 0;
        let flightPushTimer = 0;
        let isPlaceAircraftMode = false;
        let isFlyToMode = false;
        let isPlaneAttached = false;
        let isAttachPickMode = false;
        let attachedHostTrack = null;
        let isDraggingHeading = false;
        let isDraggingPlane = false;
        let headingDragTip = null;
        let planeDragPos = null;
        let attachLastPos = null;
        let ignoreHeadingInputUntil = 0;
        let headingDocUpHandler = null;
        let rangeTargetId = '';
        let rangeLineOverlays = [];
        let rangeTrack = null;
        let placeAircraftListener = null;
        let flyToListener = null;
        let attachPickListener = null;
        let cesiumHeadingHandler = null;
        let applyRemote = false;
        let pickListener = null;
        let coordPickListener = null;
        let corridorListener = null;
        let rulerListener = null;
        let draftCorridor = [];

        installHostTrackSpy();
        window.__FR_hostTracks = () => {
            try {
                if (mapType === 'google') {
                    return collectHostTrackCandidates(map).map((c) => ({
                        kind: c.kind,
                        lat: c.pose.lat,
                        lon: c.pose.lon,
                        heading: c.pose.heading,
                        title: c.obj?.getTitle?.() || c.obj?.title || null
                    }));
                }
                return (map.entities?.values || [])
                    .filter((e) => e && !e.__frOwn)
                    .map((e) => {
                        const pose = readHostTrackPose({ kind: 'cesium', obj: e, clock: map.clock });
                        return pose ? { kind: 'cesium', ...pose } : null;
                    })
                    .filter(Boolean);
            } catch (err) {
                return { error: String(err) };
            }
        };

        const Cartesian3 = mapType === 'cesium'
            ? map.camera.position.constructor
            : null;

        document.getElementById('falcon-route-ui')?.remove();

        const panel = document.createElement('div');
        panel.id = 'falcon-route-ui';
        panel.style.cssText = `
            position: fixed; top: 24px; right: 24px; width: 380px;
            height: min(92vh, calc(100vh - 36px)); max-height: calc(100vh - 36px);
            background: #12141c; color: #e8eaef; border: 1px solid #2c3140;
            border-radius: 14px; box-shadow: 0 18px 48px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.03) inset;
            font-family: "Segoe UI", system-ui, -apple-system, sans-serif; font-size: 12px;
            z-index: 9999999; user-select: none; display: flex; flex-direction: column;
            overflow: hidden;
        `;

        const htmlLayout = `
            <style>
                #falcon-route-ui * { box-sizing: border-box; }
                #falcon-route-ui .fr-head {
                    background: linear-gradient(180deg, #1c2230 0%, #171b26 100%);
                    padding: 12px 14px; color: #7dd3fc;
                    display: flex; justify-content: space-between; align-items: center;
                    cursor: move; flex-shrink: 0; border-bottom: 1px solid #2a3142;
                }
                #falcon-route-ui .fr-head-title { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
                #falcon-route-ui .fr-head-name { font-weight: 750; font-size: 13px; letter-spacing: .02em; color: #e0f2fe; }
                #falcon-route-ui .fr-head-meta { font-size: 10px; color: #94a3b8; font-weight: 500; }
                #falcon-route-ui .fr-head-actions { display: flex; align-items: center; gap: 6px; }
                #falcon-route-ui .fr-icon-btn {
                    width: 28px; height: 28px; border-radius: 8px; border: 1px solid #334155;
                    background: #0f172a; color: #cbd5e1; cursor: pointer; font-size: 14px; line-height: 1;
                    display: inline-flex; align-items: center; justify-content: center;
                }
                #falcon-route-ui .fr-icon-btn:hover { background: #1e293b; color: #fff; border-color: #475569; }
                #falcon-route-ui .fr-body {
                    padding: 10px 10px 12px; flex: 1 1 auto; min-height: 0;
                    overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain;
                    -webkit-overflow-scrolling: touch; display: flex; flex-direction: column; gap: 8px;
                }
                #falcon-route-ui .fr-body.hidden { display: none; }
                #falcon-route-ui.fr-collapsed { height: auto !important; max-height: none; }
                #falcon-route-ui .fr-body > * { width: 100%; margin: 0; flex: none !important; flex-shrink: 0 !important; }
                #falcon-route-ui .fr-body > *:not(.fr-list) { max-height: none !important; }

                #falcon-route-ui input:not([type="checkbox"]):not([type="color"]),
                #falcon-route-ui select, #falcon-route-ui textarea, #falcon-route-ui button {
                    -webkit-appearance: none !important; appearance: none !important;
                    box-sizing: border-box !important; max-height: none !important; flex-shrink: 0 !important;
                    font-size: 12px !important; line-height: 1.35 !important; font-family: inherit !important;
                }
                #falcon-route-ui textarea {
                    width: 100% !important; height: 84px !important; min-height: 84px !important;
                    background: #0b0e14; color: #67e8f9; border: 1px solid #2a3142; border-radius: 8px;
                    padding: 8px 10px !important; font-family: ui-monospace, SFMono-Regular, Menlo, monospace !important;
                    resize: vertical;
                }
                #falcon-route-ui textarea:focus,
                #falcon-route-ui input:not([type="checkbox"]):not([type="color"]):focus,
                #falcon-route-ui select:focus {
                    outline: none; border-color: #38bdf8 !important; box-shadow: 0 0 0 2px rgba(56,189,248,.18);
                }
                #falcon-route-ui .fr-row { display: flex !important; justify-content: space-between; align-items: center; gap: 8px; min-height: 32px; }
                #falcon-route-ui .fr-row > label { flex: 0 0 auto; color: #94a3b8; font-size: 11px; }
                #falcon-route-ui input:not([type="checkbox"]):not([type="color"]) {
                    background: #0b0e14; color: #fff; border: 1px solid #2a3142; border-radius: 8px;
                    padding: 6px 8px !important; min-height: 32px !important; height: 32px !important;
                }
                #falcon-route-ui select {
                    background: #0b0e14; color: #fff; border: 1px solid #2a3142; border-radius: 8px;
                    padding: 6px 28px 6px 8px !important; min-height: 32px !important; height: 32px !important;
                    cursor: pointer; pointer-events: auto !important;
                    background-image: linear-gradient(45deg, transparent 50%, #94a3b8 50%), linear-gradient(135deg, #94a3b8 50%, transparent 50%);
                    background-position: calc(100% - 14px) 13px, calc(100% - 9px) 13px;
                    background-size: 5px 5px, 5px 5px; background-repeat: no-repeat;
                }
                #falcon-route-ui input[type="number"] { width: 84px; text-align: center; }
                #falcon-route-ui input[type="text"] { flex: 1 1 auto; min-width: 0; width: auto; }
                #falcon-route-ui input[type="color"] {
                    width: 36px !important; height: 32px !important; min-height: 32px !important;
                    padding: 0 !important; border: 1px solid #2a3142; border-radius: 8px; background: #0b0e14; cursor: pointer;
                }
                #falcon-route-ui input[type="checkbox"] {
                    -webkit-appearance: auto !important; appearance: auto !important;
                    width: 16px !important; height: 16px !important; min-width: 16px !important; min-height: 16px !important;
                    margin: 0 8px 0 0 !important; padding: 0 !important; flex: 0 0 16px !important;
                    accent-color: #38bdf8; cursor: pointer; pointer-events: auto !important;
                    background: none !important; border: none !important; position: relative; z-index: 2;
                }
                #falcon-route-ui .fr-check {
                    display: flex !important; align-items: center; gap: 6px; color: #cbd5e1;
                    cursor: pointer; user-select: none; pointer-events: auto !important; font-size: 12px;
                }
                #falcon-route-ui .fr-row select, #falcon-route-ui select { flex: 1 1 auto; min-width: 0; width: auto; }
                #falcon-route-ui .fr-grid { display: grid !important; grid-template-columns: 1fr 1fr; gap: 6px; }
                #falcon-route-ui .fr-grid-3 { display: grid !important; grid-template-columns: 1fr 1fr 1fr; gap: 6px; }

                #falcon-route-ui .fr-btn {
                    background: #1e2433; color: #e2e8f0; border: 1px solid #323849;
                    padding: 8px 10px !important; border-radius: 9px; cursor: pointer;
                    font-weight: 650; font-size: 11px !important; min-height: 34px !important; height: auto !important;
                    transition: background .12s ease, border-color .12s ease, color .12s ease;
                }
                #falcon-route-ui .fr-btn:hover { background: #273044; border-color: #3b82f6; color: #fff; }
                #falcon-route-ui .fr-btn-pick { background: #13233f; color: #7dd3fc; border: 1px solid #1d4ed8; width: 100%; }
                #falcon-route-ui .fr-btn-pick:hover { background: #1e3a5f; }
                #falcon-route-ui .fr-btn-pick.active { background: #b45309; color: #fff; border-color: #f59e0b; }
                #falcon-route-ui .fr-btn-danger { background: #2a1518; color: #fca5a5; border-color: #7f1d1d; }
                #falcon-route-ui .fr-btn-danger:hover { background: #dc2626; color: #fff; border-color: #ef4444; }
                #falcon-route-ui .fr-btn-wide { width: 100%; }
                #falcon-route-ui .fr-btn-ok { background: #10291c; color: #86efac; border-color: #166534; }
                #falcon-route-ui .fr-btn-ok:hover { background: #166534; color: #fff; }
                #falcon-route-ui .fr-btn-ok.active { background: #854d0e; color: #fef3c7; border-color: #eab308; }
                #falcon-route-ui .fr-btn-primary { background: #0ea5e9; color: #082f49; border-color: #38bdf8; font-weight: 750; }
                #falcon-route-ui .fr-btn-primary:hover { background: #38bdf8; color: #082f49; }

                #falcon-route-ui .fr-quick {
                    display: flex; flex-direction: column; gap: 6px;
                    padding: 8px; background: #171b26; border: 1px solid #2a3142; border-radius: 12px;
                }
                #falcon-route-ui .fr-qbar {
                    display: grid; grid-template-columns: repeat(5, 1fr); gap: 5px;
                }
                #falcon-route-ui .fr-qbtn {
                    min-height: 36px !important; height: 36px !important; padding: 0 !important;
                    border-radius: 10px; border: 1px solid #323849; background: #121826;
                    color: #e2e8f0; cursor: pointer; font-size: 15px !important; line-height: 1;
                    display: inline-flex; align-items: center; justify-content: center;
                    transition: background .12s ease, border-color .12s ease, color .12s ease, transform .08s ease;
                }
                #falcon-route-ui .fr-qbtn:hover {
                    background: #1e293b; border-color: #38bdf8; color: #fff; transform: translateY(-1px);
                }
                #falcon-route-ui .fr-qbtn.active {
                    background: #b45309; border-color: #f59e0b; color: #fff;
                    box-shadow: 0 0 0 1px rgba(245,158,11,.35);
                }
                #falcon-route-ui .fr-qbtn.fr-q-ok.active {
                    background: #854d0e; border-color: #eab308; color: #fef3c7;
                }
                #falcon-route-ui .fr-qbtn.fr-q-go.active {
                    background: #166534; border-color: #4ade80; color: #fff;
                }
                #falcon-route-ui .fr-qbtn.fr-q-danger:hover {
                    background: #7f1d1d; border-color: #ef4444;
                }
                #falcon-route-ui .fr-qlabel {
                    font-size: 10px; color: #64748b; font-weight: 650; letter-spacing: .04em;
                    text-transform: uppercase; padding: 0 2px;
                }
                #falcon-route-ui .fr-quick-row {
                    display: grid; grid-template-columns: 1fr 1fr; gap: 6px;
                }
                #falcon-route-ui .fr-card {
                    background: #171b26; border: 1px solid #2a3142; border-radius: 12px;
                    padding: 0; overflow: hidden;
                }
                #falcon-route-ui .fr-card > .fr-card-body {
                    display: flex; flex-direction: column; gap: 8px; padding: 10px;
                }
                #falcon-route-ui details.fr-acc { background: #171b26; border: 1px solid #2a3142; border-radius: 12px; overflow: hidden; }
                #falcon-route-ui details.fr-acc > summary {
                    cursor: pointer; list-style: none; user-select: none;
                    display: flex; align-items: center; justify-content: space-between; gap: 8px;
                    padding: 10px 12px; background: #1a2030; color: #e2e8f0; font-weight: 700; font-size: 12px;
                }
                #falcon-route-ui details.fr-acc > summary::-webkit-details-marker { display: none; }
                #falcon-route-ui details.fr-acc > summary::after {
                    content: "▾"; color: #64748b; font-size: 11px; transition: transform .15s ease;
                }
                #falcon-route-ui details.fr-acc[open] > summary::after { transform: rotate(180deg); }
                #falcon-route-ui details.fr-acc > summary:hover { background: #20283a; }
                #falcon-route-ui details.fr-acc .fr-acc-body {
                    display: flex; flex-direction: column; gap: 8px; padding: 10px 12px 12px;
                    border-top: 1px solid #2a3142;
                }
                #falcon-route-ui .fr-acc-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
                #falcon-route-ui .fr-acc-ico {
                    width: 22px; height: 22px; border-radius: 7px; display: inline-flex; align-items: center; justify-content: center;
                    background: #0f172a; border: 1px solid #334155; font-size: 12px; flex: 0 0 auto;
                }
                #falcon-route-ui .fr-hint { color: #94a3b8; font-size: 10px; line-height: 1.4; }
                #falcon-route-ui .fr-status {
                    background: #0b0e14; border: 1px solid #2a3142; border-radius: 8px;
                    padding: 8px 10px; color: #bae6fd; font-size: 11px; font-weight: 650; line-height: 1.35;
                    min-height: 34px;
                }
                #falcon-route-ui .fr-status.muted { color: #94a3b8; font-weight: 500; }
                #falcon-route-ui .fr-section { border-top: none; padding-top: 0; display: flex !important; flex-direction: column; gap: 8px; }
                #falcon-route-ui .fr-label { color: #94a3b8; font-size: 11px; }
                #falcon-route-ui .fr-count {
                    color: #93c5fd; font-size: 11px; font-weight: 700;
                    display: flex; justify-content: space-between; align-items: center;
                }
                #falcon-route-ui .fr-list {
                    max-height: 120px !important; height: 120px !important;
                    overflow-x: hidden; overflow-y: auto !important;
                    background: #0b0e14; border: 1px solid #2a3142; border-radius: 8px; padding: 4px;
                    flex-shrink: 0 !important;
                }
                #falcon-route-ui .fr-item {
                    display: flex; justify-content: space-between; align-items: flex-start; gap: 6px;
                    padding: 6px; border-bottom: 1px solid #1a1c26; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px;
                }
                #falcon-route-ui .fr-item:last-child { border-bottom: none; }
                #falcon-route-ui .fr-item-main { flex: 1; min-width: 0; word-break: break-all; color: #cbd5e1; }
                #falcon-route-ui .fr-item-actions { display: flex; gap: 6px; flex-shrink: 0; }
                #falcon-route-ui .fr-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
                #falcon-route-ui .fr-sync {
                    font-size: 10px; color: #64748b; min-height: 14px; padding: 2px 2px 0;
                    display: flex; align-items: center; gap: 6px;
                }
                #falcon-route-ui .fr-sync::before {
                    content: ""; width: 7px; height: 7px; border-radius: 50%; background: #64748b; flex: 0 0 auto;
                }
                #falcon-route-ui .fr-sync.on { color: #4ade80; }
                #falcon-route-ui .fr-sync.on::before { background: #4ade80; box-shadow: 0 0 8px rgba(74,222,128,.55); }
                #falcon-route-ui .fr-sync.err { color: #f87171; }
                #falcon-route-ui .fr-sync.err::before { background: #f87171; }
                #falcon-route-ui .fr-legend { display: flex; flex-wrap: wrap; gap: 6px; }
                #falcon-route-ui .fr-legend span {
                    display: inline-flex; align-items: center; gap: 4px;
                    background: #0b0e14; border: 1px solid #2a3142; border-radius: 999px;
                    padding: 3px 8px; font-size: 10px; color: #cbd5e1;
                }
                #falcon-route-ui .fr-means-row { display: flex; gap: 4px; align-items: center; }
                #falcon-route-ui .fr-means-list { display: flex; flex-direction: column; gap: 4px; max-height: 110px; overflow-y: auto; }
                #falcon-route-ui details.fr-details > summary { cursor: pointer; color: #93c5fd; font-weight: bold; list-style: none; }
                #falcon-route-ui details.fr-details > summary::-webkit-details-marker { display: none; }
                #falcon-route-ui .fr-field-grid {
                    display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
                }
                #falcon-route-ui .fr-field { display: flex; flex-direction: column; gap: 4px; }
                #falcon-route-ui .fr-field > label { color: #94a3b8; font-size: 10px; font-weight: 650; text-transform: uppercase; letter-spacing: .04em; }
                #falcon-route-ui .fr-field select,
                #falcon-route-ui .fr-field input:not([type="checkbox"]):not([type="color"]) { width: 100%; }
                #falcon-route-ui .fr-ruler-total { color: #7dd3fc; font-size: 11px; font-weight: bold; line-height: 1.35; }
                #falcon-route-ui .fr-footer {
                    flex-shrink: 0; border-top: 1px solid #2a3142; background: #141822;
                    padding: 8px 12px; display: flex; flex-direction: column; gap: 4px;
                }
                .fr-map-label { position: absolute; transform: translate(-50%, calc(-100% - 14px)); pointer-events: none; white-space: nowrap; text-align: center; z-index: 1; }
                .fr-map-label .fr-means-tag { background: rgba(15,16,21,.92); color: #fde68a; font: bold 10px/1.2 system-ui; padding: 2px 5px; border-radius: 3px; border: 1px solid rgba(253,230,138,.45); max-width: 160px; overflow: hidden; text-overflow: ellipsis; }
                .fr-ruler-label { position: absolute; transform: translate(-50%, -50%); pointer-events: none; white-space: nowrap; z-index: 2; }
                .fr-ruler-label .fr-ruler-chip {
                    background: transparent; color: #ecfeff;
                    font: 700 12px/1.15 system-ui, -apple-system, sans-serif;
                    padding: 0; border: none; border-radius: 0; box-shadow: none;
                    -webkit-font-smoothing: antialiased; text-rendering: geometricPrecision;
                    text-shadow:
                        0 0 4px rgba(8,47,73,.95),
                        -1px -1px 0 #0c4a6e, 1px -1px 0 #0c4a6e,
                        -1px 1px 0 #0c4a6e, 1px 1px 0 #0c4a6e,
                        0 1px 3px rgba(0,0,0,.65);
                }
                .fr-flight-label .fr-ruler-chip {
                    font-size: 11px; padding: 3px 7px; border-radius: 6px;
                    background: rgba(8,47,73,.92); border: 1px solid rgba(125,211,252,.85);
                    box-shadow: 0 2px 8px rgba(0,0,0,.45); text-shadow: none;
                }
                .fr-aim-label .fr-ruler-chip {
                    font-size: 12px; padding: 0; border-radius: 0;
                    background: transparent; color: #ffedd5;
                    border: none; box-shadow: none; font-weight: 700;
                    text-shadow:
                        0 0 4px rgba(124,45,18,.95),
                        -1px -1px 0 #7c2d12, 1px -1px 0 #7c2d12,
                        -1px 1px 0 #7c2d12, 1px 1px 0 #7c2d12,
                        0 1px 3px rgba(0,0,0,.65);
                }
            </style>
            <div class="fr-head" id="fr-drag">
                <div class="fr-head-title">
                    <span class="fr-head-name">🦅 FalconRoute</span>
                    <span class="fr-head-meta">v2 · ${FR_BUILD}</span>
                </div>
                <div class="fr-head-actions">
                    <button type="button" class="fr-icon-btn" id="fr-toggle" title="Згорнути / розгорнути">─</button>
                </div>
            </div>
            <div class="fr-body" id="fr-main">
                <div class="fr-quick">
                    <div class="fr-qlabel">Швидкі команди</div>
                    <div class="fr-qbar" id="fr-qbar">
                        <button type="button" class="fr-qbtn" id="fr-q-pick" title="Додати точку кліком на карті" data-fr-click="fr-pick" data-fr-acc="points">🎯</button>
                        <button type="button" class="fr-qbtn" id="fr-q-mgrs" title="Скопіювати MGRS з карти" data-fr-click="fr-coord-pick" data-fr-acc="coords">📋</button>
                        <button type="button" class="fr-qbtn" id="fr-q-ruler" title="Малювати лінійку" data-fr-click="fr-ruler" data-fr-acc="ruler">📏</button>
                        <button type="button" class="fr-qbtn" id="fr-q-aim" title="Поставити ціль (лінія від борта)" data-fr-click="fr-aim-place" data-fr-acc="ruler">◎</button>
                        <button type="button" class="fr-qbtn" id="fr-q-corridor" title="Малювати коридор" data-fr-click="fr-corridor" data-fr-acc="corridor">🛤</button>
                        <button type="button" class="fr-qbtn" id="fr-q-copy" title="Скопіювати видимі координати" data-fr-click="fr-copy" data-fr-acc="coords">📤</button>
                        <button type="button" class="fr-qbtn" id="fr-q-place" title="Поставити борт" data-fr-click="fr-flight-place" data-fr-acc="flight">📍</button>
                        <button type="button" class="fr-qbtn fr-q-go" id="fr-q-fly" title="Летіти / стоп" data-fr-click="fr-flight-goto" data-fr-acc="flight">✈</button>
                        <button type="button" class="fr-qbtn" id="fr-q-attach" title="Прикріпити до треку карти" data-fr-click="fr-flight-attach" data-fr-acc="flight">🔗</button>
                        <button type="button" class="fr-qbtn" id="fr-q-points" title="Показати / сховати точки" data-fr-cmd="toggle-points" data-fr-acc="filters">👁</button>
                        <button type="button" class="fr-qbtn fr-q-danger" id="fr-q-remove" title="Прибрати борт" data-fr-click="fr-flight-stop" data-fr-acc="flight">⏹</button>
                    </div>
                    <div class="fr-quick-row">
                        <button class="fr-btn fr-btn-pick" id="fr-pick">🎯 Точка на карті</button>
                        <button class="fr-btn fr-btn-pick" id="fr-coord-pick">📋 MGRS</button>
                    </div>
                </div>

                <details class="fr-acc" open data-fr-acc="points">
                    <summary><span class="fr-acc-title"><span class="fr-acc-ico">📍</span>Точки збиття</span></summary>
                    <div class="fr-acc-body">
                        <div class="fr-field-grid">
                            <div class="fr-field">
                                <label for="fr-means">Збиття</label>
                                <select id="fr-means"></select>
                            </div>
                            <div class="fr-field">
                                <label for="fr-zasib">Засіб</label>
                                <select id="fr-zasib"></select>
                            </div>
                            <div class="fr-field">
                                <label for="fr-alt">Висота, м</label>
                                <input type="number" id="fr-alt" value="${settings.defaultAlt}" step="50" min="0">
                            </div>
                            <div class="fr-field">
                                <label for="fr-default-rad">Радіус, м</label>
                                <input type="number" id="fr-default-rad" value="${settings.defaultRadius}" step="50">
                            </div>
                        </div>
                        <textarea id="fr-input" placeholder="Встав координати:&#10;48.4501, 34.9802&#10;або з висотою: 48.45, 34.98, 150"></textarea>
                        <button class="fr-btn fr-btn-wide fr-btn-primary" id="fr-add">＋ Побудувати точки</button>
                        <div class="fr-count" id="fr-count"><span>Точок: 0</span></div>
                        <div class="fr-list" id="fr-container"></div>
                    </div>
                </details>

                <details class="fr-acc" data-fr-acc="filters">
                    <summary><span class="fr-acc-title"><span class="fr-acc-ico">🎛</span>Фільтри карти</span></summary>
                    <div class="fr-acc-body">
                        <label class="fr-check"><input type="checkbox" id="fr-show-points" ${settings.showPoints ? 'checked' : ''}> Показувати точки на карті</label>
                        <div class="fr-field">
                            <label for="fr-time-filter">Період</label>
                            <select id="fr-time-filter">
                                <option value="all">Усі</option>
                                <option value="day">Останні 24 год</option>
                                <option value="week">Останній тиждень</option>
                                <option value="month">Останній місяць</option>
                            </select>
                        </div>
                        <div class="fr-field-grid">
                            <div class="fr-field">
                                <label for="fr-means-filter">Фільтр збиття</label>
                                <select id="fr-means-filter"></select>
                            </div>
                            <div class="fr-field">
                                <label for="fr-zasib-filter">Фільтр засобу</label>
                                <select id="fr-zasib-filter"></select>
                            </div>
                        </div>
                        <div class="fr-legend" id="fr-legend"></div>
                    </div>
                </details>

                <details class="fr-acc" data-fr-acc="corridor">
                    <summary><span class="fr-acc-title"><span class="fr-acc-ico">🛤</span>Коридор</span></summary>
                    <div class="fr-acc-body">
                        <div class="fr-hint">Обмежує видимі точки смугою на карті (лише на цей запуск).</div>
                        <div class="fr-row">
                            <label>Ширина, м</label>
                            <input type="number" id="fr-corridor-w" value="${settings.corridorWidth}" step="100" min="100">
                        </div>
                        <div class="fr-grid">
                            <button class="fr-btn fr-btn-pick" id="fr-corridor">📐 Малювати</button>
                            <button class="fr-btn fr-btn-danger" id="fr-corridor-clear">Скинути</button>
                        </div>
                        <div class="fr-status muted" id="fr-corridor-status">Коридор не задано</div>
                    </div>
                </details>

                <details class="fr-acc" data-fr-acc="ruler">
                    <summary><span class="fr-acc-title"><span class="fr-acc-ico">📏</span>Лінійка</span></summary>
                    <div class="fr-acc-body">
                        <label class="fr-check"><input type="checkbox" id="fr-ruler-show" checked> Показувати лінійку</label>
                        <div class="fr-field-grid">
                            <div class="fr-field">
                                <label for="fr-ruler-speed">Швидкість, км/год</label>
                                <input type="number" id="fr-ruler-speed" value="${settings.rulerSpeedKmh || 5}" step="0.5" min="0.1">
                            </div>
                            <div class="fr-field">
                                <label for="fr-ruler-color">Колір</label>
                                <input type="color" id="fr-ruler-color" value="${settings.rulerColor || '#22d3ee'}">
                            </div>
                        </div>
                        <div class="fr-grid">
                            <button class="fr-btn fr-btn-pick" id="fr-ruler">📏 Малювати</button>
                            <button class="fr-btn" id="fr-ruler-toggle">👁 Сховати</button>
                        </div>
                        <div class="fr-grid">
                            <button class="fr-btn fr-btn-pick" id="fr-aim-place">🎯 Ціль</button>
                            <button class="fr-btn fr-btn-danger" id="fr-aim-clear">Скинути ціль</button>
                        </div>
                        <div class="fr-hint">«Ціль» — постав точку на карті; від твого борта піде лінія з відстанню та часом (за швидкістю лінійки).</div>
                        <div class="fr-status muted" id="fr-aim-status">Ціль не задана</div>
                        <button class="fr-btn fr-btn-danger fr-btn-wide" id="fr-ruler-clear">Скинути лінійку</button>
                        <div class="fr-status muted" id="fr-ruler-status">Лінійка не задана</div>
                    </div>
                </details>

                <details class="fr-acc" open data-fr-acc="flight">
                    <summary><span class="fr-acc-title"><span class="fr-acc-ico">✈</span>Борт</span></summary>
                    <div class="fr-acc-body">
                        <div class="fr-hint">«Летіти» — рух за курсом. «Прикріпити до треку» — слідувати за стрілкою на карті-хості. Швидкість спільна з лінійкою.</div>
                        <div class="fr-field-grid">
                            <div class="fr-field">
                                <label for="fr-callsign">Позивний</label>
                                <input type="text" id="fr-callsign" value="${settings.callsign || 'Falcon'}" maxlength="16" placeholder="Falcon">
                            </div>
                            <div class="fr-field">
                                <label for="fr-flight-color">Колір</label>
                                <input type="color" id="fr-flight-color" value="${settings.flightColor || '#22d3ee'}">
                            </div>
                        </div>
                        <div class="fr-grid">
                            <button class="fr-btn fr-btn-pick" id="fr-flight-place">📍 Поставити</button>
                            <button class="fr-btn fr-btn-ok" id="fr-flight-goto">✈ Летіти</button>
                        </div>
                        <button class="fr-btn fr-btn-wide" id="fr-flight-attach">🔗 Прикріпити до треку</button>
                        <button class="fr-btn fr-btn-danger fr-btn-wide" id="fr-flight-stop">⏹ Прибрати борт</button>
                        <div class="fr-status muted" id="fr-flight-status">Борт не виставлено</div>
                        <div class="fr-field">
                            <label for="fr-range-target">Дистанція до борта</label>
                            <select id="fr-range-target">
                                <option value="">— не вимірювати —</option>
                            </select>
                        </div>
                        <div class="fr-ruler-total" id="fr-flight-range">Обери борт для вимірювання</div>
                        <div class="fr-label" id="fr-flight-distances" style="white-space:pre-line;opacity:.85">Немає інших бортів онлайн</div>
                    </div>
                </details>

                <details class="fr-acc" data-fr-acc="coords">
                    <summary><span class="fr-acc-title"><span class="fr-acc-ico">🗺</span>Координати</span></summary>
                    <div class="fr-acc-body">
                        <div class="fr-field">
                            <label for="fr-coord-format">Формат</label>
                            <select id="fr-coord-format">
                                <option value="dd">DD (десяткові)</option>
                                <option value="dm">DM</option>
                                <option value="dms">DMS</option>
                                <option value="mgrs">MGRS</option>
                            </select>
                        </div>
                        <button class="fr-btn fr-btn-wide" id="fr-copy">📋 Скопіювати видимі</button>
                    </div>
                </details>

                <details class="fr-acc" data-fr-acc="catalog">
                    <summary><span class="fr-acc-title"><span class="fr-acc-ico">⚙</span>Каталоги</span></summary>
                    <div class="fr-acc-body">
                        <details class="fr-details">
                            <summary>Збиття / кольори</summary>
                            <div class="fr-means-list" id="fr-means-edit"></div>
                            <div class="fr-means-row">
                                <input type="text" id="fr-means-new-name" placeholder="Нове збиття">
                                <input type="color" id="fr-means-new-color" value="#22c55e">
                                <button class="fr-btn" id="fr-means-add">＋</button>
                            </div>
                        </details>
                        <details class="fr-details">
                            <summary>Засоби (без кольорів)</summary>
                            <div class="fr-means-list" id="fr-zasib-edit"></div>
                            <div class="fr-means-row">
                                <input type="text" id="fr-zasib-new-name" placeholder="Новий засіб">
                                <button class="fr-btn" id="fr-zasib-add">＋</button>
                            </div>
                        </details>
                    </div>
                </details>

                <details class="fr-acc" data-fr-acc="io">
                    <summary><span class="fr-acc-title"><span class="fr-acc-ico">💾</span>Експорт / імпорт</span></summary>
                    <div class="fr-acc-body">
                        <div class="fr-field">
                            <label for="fr-format">Формат файлу</label>
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
                </details>
            </div>
            <div class="fr-footer">
                <div class="fr-sync" id="fr-sync">${FIREBASE_ENABLED ? 'Firebase: підключення…' : 'Локальний режим (без Firebase)'}</div>
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:4px">
                    <div class="fr-label" id="fr-license-status" style="margin:0;opacity:.9">Ключ: ${activeLicenseKey || '—'}${activeLicenseMeta?.name ? ' · ' + activeLicenseMeta.name : ''}</div>
                    <button type="button" class="fr-btn" id="fr-license-logout" style="min-height:28px !important;padding:4px 8px !important;font-size:10px !important">Змінити ключ</button>
                </div>
            </div>
        `;

        const range = document.createRange();
        range.selectNodeContents(panel);
        panel.appendChild(range.createContextualFragment(htmlLayout));
        document.body.appendChild(panel);

        const syncEl = document.getElementById('fr-sync');
        const mainBody = document.getElementById('fr-main');
        const footerEl = panel.querySelector('.fr-footer');
        const toggleBtn = document.getElementById('fr-toggle');
        document.getElementById('fr-license-logout')?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!confirm('Змінити ключ доступу? Скрипт перезапустить перевірку.')) return;
            clearLicenseKey();
            panel.remove();
            try { if (licenseWatchTimer) clearInterval(licenseWatchTimer); } catch (_) { /* ignore */ }
            ensureLicensed().then((ok) => { if (ok) location.reload(); });
        });
        toggleBtn.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            const closed = mainBody.classList.toggle('hidden');
            panel.classList.toggle('fr-collapsed', closed);
            if (footerEl) footerEl.style.display = closed ? 'none' : '';
            toggleBtn.textContent = closed ? '□' : '─';
            toggleBtn.title = closed ? 'Розгорнути' : 'Згорнути';
        };

        // Памʼять відкритих секцій
        const ACC_KEY = 'falcon_route_ui_acc_v1';
        try {
            const savedAcc = JSON.parse(localStorage.getItem(ACC_KEY) || 'null');
            if (savedAcc && typeof savedAcc === 'object') {
                panel.querySelectorAll('details.fr-acc[data-fr-acc]').forEach((d) => {
                    const key = d.getAttribute('data-fr-acc');
                    if (key in savedAcc) d.open = !!savedAcc[key];
                });
            }
        } catch (_) { /* ignore */ }
        panel.querySelectorAll('details.fr-acc[data-fr-acc]').forEach((d) => {
            d.addEventListener('toggle', () => {
                try {
                    const next = {};
                    panel.querySelectorAll('details.fr-acc[data-fr-acc]').forEach((el) => {
                        next[el.getAttribute('data-fr-acc')] = el.open;
                    });
                    localStorage.setItem(ACC_KEY, JSON.stringify(next));
                } catch (_) { /* ignore */ }
            });
        });

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
            settings.rulerColor = document.getElementById('fr-ruler-color')?.value || '#22d3ee';
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

        function clearAimOverlays() {
            try {
                if (mapType === 'google') {
                    aimOverlays.forEach(o => {
                        try { o.setMap(null); } catch (_) { /* ignore */ }
                    });
                } else {
                    aimOverlays.forEach(ent => {
                        try { map.entities.remove(ent); } catch (_) { /* ignore */ }
                    });
                }
            } catch (_) { /* ignore */ }
            aimOverlays = [];
            aimTrack = null;
        }

        function setAimStatus(text, muted = true) {
            const el = document.getElementById('fr-aim-status');
            if (!el) return;
            el.textContent = text || '';
            el.classList.toggle('muted', !!muted);
        }

        function stopAimPlaceMode() {
            isAimPlaceMode = false;
            const btn = document.getElementById('fr-aim-place');
            if (btn) {
                btn.classList.remove('active');
                btn.textContent = '🎯 Ціль';
            }
            if (aimPlaceListener) {
                if (mapType === 'google') google.maps.event.removeListener(aimPlaceListener);
                else if (map.canvas) map.canvas.removeEventListener('click', aimPlaceListener);
                aimPlaceListener = null;
            }
            syncQuickBar();
        }

        function clearAimTarget() {
            stopAimPlaceMode();
            aimTarget = null;
            clearAimOverlays();
            setAimStatus('Ціль не задана', true);
        }

        function createGoogleAimLabel(position, text, bearingDegVal) {
            let rot = Number.isFinite(bearingDegVal) ? bearingDegVal : 0;
            if (rot > 90 && rot < 270) rot = (rot + 180) % 360;
            class FrAimLabel extends google.maps.OverlayView {
                constructor() {
                    super();
                    this.position = position;
                    this.div = null;
                    this.rot = rot;
                    this.text = text || '';
                }
                onAdd() {
                    this.div = document.createElement('div');
                    this.div.className = 'fr-ruler-label fr-aim-label';
                    const chip = document.createElement('div');
                    chip.className = 'fr-ruler-chip';
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
                    this.div.style.top = p.y + 'px';
                    this.div.style.transform =
                        `translate(-50%, -50%) rotate(${this.rot}deg) translate(0, -12px)`;
                }
                onRemove() {
                    if (this.div?.parentNode) this.div.parentNode.removeChild(this.div);
                    this.div = null;
                }
                setPose(latLng, bearing) {
                    this.position = latLng;
                    let r = Number.isFinite(bearing) ? bearing : this.rot;
                    if (r > 90 && r < 270) r = (r + 180) % 360;
                    this.rot = r;
                    this.draw();
                }
                setLabel(t) {
                    this.text = t || '';
                    const chip = this.div?.querySelector('.fr-ruler-chip');
                    if (chip) chip.textContent = this.text;
                }
            }
            const ov = new FrAimLabel();
            ov.setMap(map);
            return ov;
        }

        function updateAimLine(fromPos) {
            if (!aimTarget) {
                clearAimOverlays();
                return;
            }
            const speed = getRulerSpeed();
            const statusElReady = true;

            if (!fromPos) {
                // Показуємо лише маркер цілі без лінії
                if (mapType === 'google') {
                    if (!aimOverlays.length) {
                        aimOverlays.push(new google.maps.Marker({
                            position: { lat: aimTarget.lat, lng: aimTarget.lon },
                            map,
                            title: 'Ціль',
                            zIndex: 195,
                            icon: {
                                path: google.maps.SymbolPath.CIRCLE,
                                scale: 7,
                                fillColor: '#f97316',
                                fillOpacity: 0.95,
                                strokeColor: '#fff7ed',
                                strokeWeight: 2
                            }
                        }));
                    } else if (aimOverlays[0]?.setPosition) {
                        aimOverlays[0].setPosition({ lat: aimTarget.lat, lng: aimTarget.lon });
                        // прибрати лінію/лейбл якщо були
                        while (aimOverlays.length > 1) {
                            try { aimOverlays.pop().setMap(null); } catch (_) { /* ignore */ }
                        }
                    }
                } else if (Cartesian3) {
                    const Cesium = window.Cesium;
                    const tip = Cartesian3.fromDegrees(aimTarget.lon, aimTarget.lat);
                    if (!aimTrack) {
                        aimTrack = { from: tip, to: tip, mid: tip, text: '' };
                        aimOverlays.push(map.entities.add({
                            position: tip,
                            point: {
                                pixelSize: 12,
                                color: toCesiumColor('#f97316'),
                                outlineColor: toCesiumColor('#fff7ed'),
                                outlineWidth: 2,
                                disableDepthTestDistance: Number.POSITIVE_INFINITY
                            }
                        }));
                    } else {
                        aimTrack.to = tip;
                        if (aimOverlays[0]) aimOverlays[0].position = tip;
                    }
                    map.scene?.requestRender?.();
                }
                if (statusElReady) {
                    setAimStatus('Ціль стоїть · постав борт, щоб бачити лінію / відстань', true);
                }
                return;
            }

            const distM = haversineM(fromPos.lat, fromPos.lon, aimTarget.lat, aimTarget.lon);
            const eta = formatTravelTime(distM, speed);
            const labelText = `${formatDistanceKm(distM)} · ${eta}`;
            const mid = {
                lat: (fromPos.lat + aimTarget.lat) / 2,
                lon: (fromPos.lon + aimTarget.lon) / 2
            };
            const brg = bearingDeg(fromPos, aimTarget);
            setAimStatus(`До цілі: ${formatDistanceKm(distM)} · ETA ${eta} · ${speed} км/год`, false);

            if (mapType === 'google') {
                const path = [
                    { lat: fromPos.lat, lng: fromPos.lon },
                    { lat: aimTarget.lat, lng: aimTarget.lon }
                ];
                const midLL = new google.maps.LatLng(mid.lat, mid.lon);
                if (aimOverlays.length < 3) {
                    clearAimOverlays();
                    aimOverlays.push(new google.maps.Marker({
                        position: { lat: aimTarget.lat, lng: aimTarget.lon },
                        map,
                        title: 'Ціль',
                        zIndex: 195,
                        icon: {
                            path: google.maps.SymbolPath.CIRCLE,
                            scale: 7,
                            fillColor: '#f97316',
                            fillOpacity: 0.95,
                            strokeColor: '#fff7ed',
                            strokeWeight: 2
                        }
                    }));
                    aimOverlays.push(new google.maps.Polyline({
                        path,
                        geodesic: true,
                        strokeColor: '#f97316',
                        strokeOpacity: 0.9,
                        strokeWeight: 2,
                        map,
                        zIndex: 194,
                        clickable: false,
                        icons: [{
                            icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.9, scale: 2 },
                            offset: '0',
                            repeat: '10px'
                        }]
                    }));
                    aimOverlays.push(createGoogleAimLabel(midLL, labelText, brg));
                } else {
                    aimOverlays[0].setPosition({ lat: aimTarget.lat, lng: aimTarget.lon });
                    aimOverlays[1].setPath(path);
                    if (aimOverlays[2]?.setPose) {
                        aimOverlays[2].setPose(midLL, brg);
                        aimOverlays[2].setLabel(labelText);
                    }
                }
                return;
            }

            if (!Cartesian3) return;
            const Cesium = window.Cesium;
            if (!aimTrack || aimOverlays.length < 3) {
                clearAimOverlays();
                aimTrack = {
                    from: Cartesian3.fromDegrees(fromPos.lon, fromPos.lat),
                    to: Cartesian3.fromDegrees(aimTarget.lon, aimTarget.lat),
                    mid: Cartesian3.fromDegrees(mid.lon, mid.lat),
                    text: labelText
                };
                aimOverlays.push(map.entities.add({
                    position: Cesium?.CallbackProperty
                        ? new Cesium.CallbackProperty(() => aimTrack.to, false)
                        : aimTrack.to,
                    point: {
                        pixelSize: 12,
                        color: toCesiumColor('#f97316'),
                        outlineColor: toCesiumColor('#fff7ed'),
                        outlineWidth: 2,
                        disableDepthTestDistance: Number.POSITIVE_INFINITY
                    }
                }));
                aimOverlays.push(map.entities.add({
                    polyline: {
                        positions: Cesium?.CallbackProperty
                            ? new Cesium.CallbackProperty(() => [aimTrack.from, aimTrack.to], false)
                            : [aimTrack.from, aimTrack.to],
                        width: 2,
                        material: toCesiumColor({ red: 0.98, green: 0.45, blue: 0.09, alpha: 0.9 })
                    }
                }));
                aimOverlays.push(map.entities.add({
                    position: Cesium?.CallbackProperty
                        ? new Cesium.CallbackProperty(() => aimTrack.mid, false)
                        : aimTrack.mid,
                    label: {
                        text: Cesium?.CallbackProperty
                            ? new Cesium.CallbackProperty(() => aimTrack.text, false)
                            : labelText,
                        font: 'bold 12px sans-serif',
                        fillColor: toCesiumColor('#ffedd5'),
                        outlineColor: toCesiumColor('#7c2d12'),
                        outlineWidth: 4,
                        style: Cesium?.LabelStyle?.FILL_AND_OUTLINE,
                        showBackground: false,
                        pixelOffset: Cesium?.Cartesian2
                            ? new Cesium.Cartesian2(0, -14)
                            : undefined,
                        disableDepthTestDistance: Number.POSITIVE_INFINITY
                    }
                }));
            } else {
                aimTrack.from = Cartesian3.fromDegrees(fromPos.lon, fromPos.lat);
                aimTrack.to = Cartesian3.fromDegrees(aimTarget.lon, aimTarget.lat);
                aimTrack.mid = Cartesian3.fromDegrees(mid.lon, mid.lat);
                aimTrack.text = labelText;
            }
            map.scene?.requestRender?.();
        }

        function beginAimPlace() {
            if (isPickMode) stopPickMode();
            if (isCoordPickMode) stopCoordPickMode();
            if (isCorridorMode) stopCorridorMode(false);
            if (isRulerMode) stopRulerMode();
            stopAircraftModes();
            if (isAttachPickMode) {
                clearAttachPickListener();
                updateAttachBtn();
            }

            if (isAimPlaceMode) {
                stopAimPlaceMode();
                setAimStatus(aimTarget ? 'Ціль стоїть на карті' : 'Ціль не задана', !aimTarget);
                return;
            }

            isAimPlaceMode = true;
            const btn = document.getElementById('fr-aim-place');
            if (btn) {
                btn.classList.add('active');
                btn.textContent = '👆 Клацни ціль…';
            }
            setAimStatus('Клацни на карті, куди ставити ціль', false);
            syncQuickBar();

            const onPick = (lat, lon) => {
                aimTarget = { lat, lon };
                stopAimPlaceMode();
                const from = myFlight?.active
                    ? (resolveFlightPos(myFlight) || { lat: myFlight.lat, lon: myFlight.lon })
                    : null;
                updateAimLine(from ? { lat: from.lat, lon: from.lon } : null);
                startFlightLoop();
            };

            if (mapType === 'google') {
                aimPlaceListener = map.addListener('click', (e) => {
                    const ll = mapClickLatLon(e);
                    if (!ll) return;
                    onPick(ll.lat, ll.lon);
                });
            } else if (map.canvas) {
                aimPlaceListener = (e) => {
                    const ll = mapClickLatLon(e);
                    if (!ll) return;
                    onPick(ll.lat, ll.lon);
                };
                map.canvas.addEventListener('click', aimPlaceListener);
            }
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

        function getRulerColor() {
            const el = document.getElementById('fr-ruler-color');
            const v = (el?.value || settings.rulerColor || '#22d3ee').trim();
            return /^#[0-9a-fA-F]{6}$/.test(v) ? v : '#22d3ee';
        }

        function rulerUnderlayColor(hex) {
            const o = hexToRgbA(hex, 0.35);
            return {
                css: `rgba(${Math.round(o.red * 70)}, ${Math.round(o.green * 70)}, ${Math.round(o.blue * 70)}, 0.35)`,
                rgba: { red: o.red * 0.28, green: o.green * 0.28, blue: o.blue * 0.28, alpha: 0.35 }
            };
        }

        function rulerTotals(points) {
            let totalM = 0;
            for (let i = 0; i < points.length - 1; i++) {
                totalM += haversineM(points[i].lat, points[i].lon, points[i + 1].lat, points[i + 1].lon);
            }
            return totalM;
        }

        function createGoogleRulerLabel(position, text, bearingDegVal) {
            let rot = Number.isFinite(bearingDegVal) ? bearingDegVal : 0;
            // Текст читабельний (не догори ногами)
            if (rot > 90 && rot < 270) rot = (rot + 180) % 360;
            class FrRulerLabel extends google.maps.OverlayView {
                constructor() {
                    super();
                    this.position = position;
                    this.div = null;
                    this.rot = rot;
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
                    // Зсув перпендикулярно лінії + поворот вздовж сегмента
                    this.div.style.transform =
                        `translate(-50%, -50%) rotate(${this.rot}deg) translate(0, -10px)`;
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
                const path = pts.map(p => ({ lat: p.lat, lng: p.lon }));
                const color = getRulerColor();
                const under = rulerUnderlayColor(color);
                if (pts.length >= 2) {
                    rulerOverlays.push(new google.maps.Polyline({
                        path,
                        geodesic: true,
                        strokeColor: under.css,
                        strokeOpacity: 0.35,
                        strokeWeight: 4,
                        map,
                        zIndex: 158
                    }));
                    rulerOverlays.push(new google.maps.Polyline({
                        path,
                        geodesic: true,
                        strokeColor: color,
                        strokeOpacity: 0.55,
                        strokeWeight: 1.75,
                        map,
                        zIndex: 159
                    }));
                }

                pts.forEach((p, idx) => {
                    const size = 26;
                    const m = new google.maps.Marker({
                        position: { lat: p.lat, lng: p.lon },
                        map,
                        icon: {
                            url: rulerVertexDataUrl(idx + 1, color),
                            scaledSize: new google.maps.Size(size, size),
                            anchor: new google.maps.Point(size / 2, size / 2)
                        },
                        zIndex: 161,
                        optimized: false
                    });
                    rulerOverlays.push(m);
                });

                for (let i = 0; i < pts.length - 1; i++) {
                    const a = pts[i];
                    const b = pts[i + 1];
                    const segM = haversineM(a.lat, a.lon, b.lat, b.lon);
                    const mid = new google.maps.LatLng((a.lat + b.lat) / 2, (a.lon + b.lon) / 2);
                    const text = `${formatDistanceKm(segM)} · ${formatTravelTime(segM, speed)}`;
                    rulerOverlays.push(createGoogleRulerLabel(mid, text, bearingDeg(a, b)));
                }
                return;
            }

            if (!Cartesian3) return;
            const Cesium = window.Cesium;
            const color = getRulerColor();
            const under = rulerUnderlayColor(color);
            const mainRgba = hexToRgbA(color, 0.55);
            if (pts.length >= 2) {
                const positions = pts.map(p => Cartesian3.fromDegrees(p.lon, p.lat));
                rulerOverlays.push(map.entities.add({
                    polyline: {
                        positions,
                        width: 4,
                        material: toCesiumColor(under.rgba)
                    }
                }));
                rulerOverlays.push(map.entities.add({
                    polyline: {
                        positions,
                        width: 1.75,
                        material: toCesiumColor(mainRgba)
                    }
                }));
            }

            pts.forEach((p, idx) => {
                const ent = map.entities.add({
                    position: Cartesian3.fromDegrees(p.lon, p.lat),
                    billboard: {
                        image: rulerVertexDataUrl(idx + 1, color),
                        width: 24,
                        height: 24,
                        disableDepthTestDistance: Number.POSITIVE_INFINITY
                    }
                });
                rulerOverlays.push(ent);
            });

            for (let i = 0; i < pts.length - 1; i++) {
                const a = pts[i];
                const b = pts[i + 1];
                const segM = haversineM(a.lat, a.lon, b.lat, b.lon);
                const text = `${formatDistanceKm(segM)} · ${formatTravelTime(segM, speed)}`;
                let rot = bearingDeg(a, b);
                if (rot > 90 && rot < 270) rot = (rot + 180) % 360;
                const midEnt = map.entities.add({
                    position: Cartesian3.fromDegrees((a.lon + b.lon) / 2, (a.lat + b.lat) / 2),
                    label: {
                        text,
                        font: 'bold 12px sans-serif',
                        fillColor: toCesiumColor({ red: 0.94, green: 0.98, blue: 1, alpha: 1 }),
                        outlineColor: toCesiumColor({ red: 0.05, green: 0.29, blue: 0.43, alpha: 1 }),
                        outlineWidth: 4,
                        showBackground: false,
                        style: Cesium?.LabelStyle?.FILL_AND_OUTLINE,
                        pixelOffset: Cesium?.Cartesian2
                            ? new Cesium.Cartesian2(0, -12)
                            : undefined,
                        rotation: Cesium?.Math
                            ? -Cesium.Math.toRadians(rot)
                            : undefined,
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
                        material: toCesiumColor({ red: 0.22, green: 0.74, blue: 0.97, alpha: 1 })
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
                const rgba = toCesiumColor(color, 1);
                const fill = toCesiumColor(color, 0.25);
                const white = toCesiumColor({ red: 1, green: 1, blue: 1, alpha: 1 });
                const black = toCesiumColor({ red: 0, green: 0, blue: 0, alpha: 1 });
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
                            fillColor: toCesiumColor({ red: 0.99, green: 0.9, blue: 0.54, alpha: 1 }),
                            outlineColor: black,
                            outlineWidth: 2,
                            style: window.Cesium?.LabelStyle?.FILL_AND_OUTLINE,
                            verticalOrigin: window.Cesium?.VerticalOrigin?.BOTTOM,
                            horizontalOrigin: window.Cesium?.HorizontalOrigin?.CENTER,
                            pixelOffset: window.Cesium?.Cartesian2
                                ? new window.Cesium.Cartesian2(0, -18)
                                : undefined,
                            showBackground: true,
                            backgroundColor: toCesiumColor({ red: 0.06, green: 0.06, blue: 0.08, alpha: 0.9 }),
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
            syncQuickBar();
        }

        function addRulerPoint(lat, lon) {
            rulerPoints.push({ lat, lon });
            renderRuler();
        }

        function stopPickMode() {
            isPickMode = false;
            pickBtn.classList.remove('active');
            pickBtn.textContent = '🎯 Точка на карті';

            if (pickListener) {
                if (mapType === 'google') {
                    google.maps.event.removeListener(pickListener);
                } else if (map.canvas) {
                    map.canvas.removeEventListener('click', pickListener);
                }
                pickListener = null;
            }
            syncQuickBar();
        }

        function stopCoordPickMode() {
            isCoordPickMode = false;
            const btn = document.getElementById('fr-coord-pick');
            if (btn) {
                btn.classList.remove('active');
                btn.textContent = '📋 MGRS';
            }
            if (coordPickListener) {
                if (mapType === 'google') {
                    google.maps.event.removeListener(coordPickListener);
                } else if (map.canvas) {
                    map.canvas.removeEventListener('click', coordPickListener);
                }
                coordPickListener = null;
            }
            syncQuickBar();
        }

        async function copyMgrsAt(lat, lon, btn) {
            const mgrs = latLonToMgrs(lat, lon, 5);
            const dd = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
            const text = mgrs;
            await copyText(text, btn, `✅ ${mgrs}`);
            console.log('[FALCONROUTE] MGRS copied:', mgrs, '| DD:', dd);
            try {
                const tip = document.createElement('div');
                tip.textContent = `📋 ${mgrs}`;
                tip.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:99999999;background:#14532d;color:#bbf7d0;padding:10px 14px;border-radius:8px;font:12px/1.3 system-ui;box-shadow:0 4px 16px rgba(0,0,0,.5)';
                document.body.appendChild(tip);
                setTimeout(() => tip.remove(), 2200);
            } catch (_) { /* ignore */ }
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
            syncQuickBar();
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
            syncQuickBar();
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
            if (isCoordPickMode) stopCoordPickMode();
            if (isAimPlaceMode) stopAimPlaceMode();
            stopAircraftModes();
            if (isPickMode) {
                stopPickMode();
                return;
            }

            isPickMode = true;
            pickBtn.classList.add('active');
            pickBtn.textContent = '👆 Клацніть у точці збиття...';
            syncQuickBar();

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

        const coordPickBtn = document.getElementById('fr-coord-pick');
        coordPickBtn.onclick = () => {
            if (isCorridorMode) stopCorridorMode(false);
            if (isRulerMode) stopRulerMode();
            if (isPickMode) stopPickMode();
            if (isAimPlaceMode) stopAimPlaceMode();
            stopAircraftModes();
            if (isCoordPickMode) {
                stopCoordPickMode();
                return;
            }

            isCoordPickMode = true;
            coordPickBtn.classList.add('active');
            coordPickBtn.textContent = '👆 Клацни точку → MGRS';
            syncQuickBar();

            if (mapType === 'google') {
                coordPickListener = map.addListener('click', (e) => {
                    if (!e?.latLng) return;
                    copyMgrsAt(e.latLng.lat(), e.latLng.lng(), coordPickBtn);
                    stopCoordPickMode();
                });
            } else {
                coordPickListener = (e) => {
                    const ll = mapClickLatLon(e);
                    if (!ll) return;
                    copyMgrsAt(ll.lat, ll.lon, coordPickBtn);
                    stopCoordPickMode();
                };
                map.canvas.addEventListener('click', coordPickListener, { once: true });
            }
        };

        const corridorBtn = document.getElementById('fr-corridor');
        corridorBtn.onclick = () => {
            if (isPickMode) stopPickMode();
            if (isCoordPickMode) stopCoordPickMode();
            if (isRulerMode) stopRulerMode();
            if (isAimPlaceMode) stopAimPlaceMode();
            stopAircraftModes();

            if (isCorridorMode) {
                stopCorridorMode(true);
                return;
            }

            isCorridorMode = true;
            draftCorridor = [];
            corridorBtn.classList.add('active');
            corridorBtn.textContent = '✓ Завершити коридор';
            renderCorridor();
            syncQuickBar();

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
            if (isCoordPickMode) stopCoordPickMode();
            if (isCorridorMode) stopCorridorMode(false);
            if (isAimPlaceMode) stopAimPlaceMode();
            stopAircraftModes();

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
            syncQuickBar();

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

        document.getElementById('fr-aim-place').onclick = () => beginAimPlace();
        document.getElementById('fr-aim-clear').onclick = () => clearAimTarget();

        document.getElementById('fr-ruler-clear').onclick = () => {
            if (isRulerMode) stopRulerMode();
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
            if (myFlight) {
                myFlight.speedKmh = getRulerSpeed();
                if (myFlight.cruise || myFlight.to) {
                    const cur = resolveFlightPos(myFlight);
                    if (cur) {
                        myFlight.from = { lat: cur.lat, lon: cur.lon };
                        myFlight.lat = cur.lat;
                        myFlight.lon = cur.lon;
                        myFlight.startedAt = Date.now();
                    }
                }
                pushMyFlight();
            }
        });
        document.getElementById('fr-ruler-speed').addEventListener('input', () => {
            renderRuler();
            if (aimTarget) {
                const from = myFlight?.active
                    ? (resolveFlightPos(myFlight) || { lat: myFlight.lat, lon: myFlight.lon })
                    : null;
                updateAimLine(from ? { lat: from.lat, lon: from.lon } : null);
            }
        });
        document.getElementById('fr-ruler-color').addEventListener('input', () => {
            saveSettings();
            renderRuler();
        });
        document.getElementById('fr-ruler-color').addEventListener('change', () => {
            saveSettings();
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
                    slot.headingLine?.setMap(null);
                    slot.headingHit?.setMap(null);
                    slot.courseLine?.setMap(null);
                    slot.headingHandle?.setMap(null);
                    (slot.handleListeners || []).forEach(l => {
                        try { google.maps.event.removeListener(l); } catch (_) { /* ignore */ }
                    });
                    (slot.planeListeners || []).forEach(l => {
                        try { google.maps.event.removeListener(l); } catch (_) { /* ignore */ }
                    });
                } else {
                    if (slot.entity) map.entities.remove(slot.entity);
                    if (slot.labelEnt) map.entities.remove(slot.labelEnt);
                    if (slot.headingLine) map.entities.remove(slot.headingLine);
                    if (slot.headingHit) map.entities.remove(slot.headingHit);
                    if (slot.courseLine) map.entities.remove(slot.courseLine);
                    if (slot.headingHandle) map.entities.remove(slot.headingHandle);
                }
            } catch (_) { /* ignore */ }
            if (id === CLIENT_ID) {
                cancelHeadingDrag(false);
                isDraggingPlane = false;
                planeDragPos = null;
                destroyCesiumHeadingDrag();
            }
            delete flightMarkers[id];
        }

        function clearAllFlightMarkers() {
            Object.keys(flightMarkers).forEach(clearFlightMarker);
        }

        function headingLengthMeters(lat) {
            if (mapType === 'google') {
                const zoom = typeof map.getZoom === 'function' ? (map.getZoom() || 10) : 10;
                const mPerPx = 156543.03392 * Math.cos(toRad(lat)) / Math.pow(2, zoom);
                // ~320 px на екрані — довга видима лінія курсу
                return Math.max(800, Math.min(80000, mPerPx * 320));
            }
            try {
                const carto = map.camera?.positionCartographic;
                const h = carto ? carto.height : 50000;
                return Math.max(1500, Math.min(100000, h * 0.14));
            } catch (_) {
                return 12000;
            }
        }

        function headingTipFrom(pos, heading, flightId) {
            // Tip миші лише для СВОГО борту — інакше чужі компаси «їдуть» за курсором
            if (flightId === CLIENT_ID && isDraggingHeading && headingDragTip) {
                return headingDragTip;
            }
            const hdg = Number.isFinite(heading) ? heading : 0;
            return destinationPoint(pos.lat, pos.lon, hdg, headingLengthMeters(pos.lat));
        }

        function applyCourseFromTip(tip) {
            if (!myFlight?.active || !tip) return;
            const cur = resolveFlightPos(myFlight) || {
                lat: myFlight.lat,
                lon: myFlight.lon
            };
            const heading = bearingDeg(
                { lat: cur.lat, lon: cur.lon },
                { lat: tip.lat, lon: tip.lon }
            );
            myFlight.heading = heading;
            myFlight.lat = cur.lat;
            myFlight.lon = cur.lon;
            myFlight.from = { lat: cur.lat, lon: cur.lon };
            myFlight.to = null;
            myFlight.speedKmh = getRulerSpeed();

            if (myFlight.cruise) {
                myFlight.startedAt = Date.now();
                setFlightStatus(
                    `${myFlight.callsign}: новий курс ${Math.round(heading)}° · летить далі`
                );
                updateCruiseBtn();
            } else {
                myFlight.startedAt = null;
                setFlightStatus(
                    `${myFlight.callsign}: курс ${Math.round(heading)}° · натисни «Летіти»`
                );
            }
            myFlight.updatedAt = Date.now();
            pushMyFlight();
            ensurePushTimer();
            startFlightLoop();
        }

        function applyPlaneMove(lat, lon) {
            if (!myFlight?.active) return;
            const keepCruise = !!myFlight.cruise;
            myFlight.lat = lat;
            myFlight.lon = lon;
            myFlight.from = { lat, lon };
            myFlight.to = null;
            myFlight.updatedAt = Date.now();
            myFlight.speedKmh = getRulerSpeed();
            if (keepCruise) {
                myFlight.cruise = true;
                myFlight.startedAt = Date.now();
                setFlightStatus(
                    `${myFlight.callsign}: переміщено · летить далі · курс ${Math.round(myFlight.heading || 0)}°`
                );
            } else {
                myFlight.cruise = false;
                myFlight.startedAt = null;
                setFlightStatus(`${myFlight.callsign}: переміщено на нову позицію`);
            }
            updateCruiseBtn();
            pushMyFlight();
            ensurePushTimer();
            startFlightLoop();
        }

        function updateCruiseBtn() {
            const btn = document.getElementById('fr-flight-goto');
            if (!btn) return;
            if (myFlight?.cruise) {
                btn.classList.add('active');
                btn.textContent = '⏸ Стоп';
            } else {
                btn.classList.remove('active');
                btn.textContent = '✈ Летіти';
            }
            syncQuickBar();
        }

        function updateAttachBtn() {
            const btn = document.getElementById('fr-flight-attach');
            if (!btn) return;
            if (isPlaneAttached) {
                btn.classList.add('active');
                btn.textContent = '🔓 Відкріпити від треку';
            } else if (isAttachPickMode) {
                btn.classList.add('active');
                btn.textContent = '👆 Клацни стрілку треку…';
            } else {
                btn.classList.remove('active');
                btn.textContent = '🔗 Прикріпити до треку';
            }
            syncQuickBar();
        }

        function openAccSection(name) {
            if (!name) return;
            const d = panel.querySelector(`details.fr-acc[data-fr-acc="${name}"]`);
            if (!d) return;
            d.open = true;
            try { d.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) { /* ignore */ }
        }

        function syncQuickBar() {
            const pairs = [
                ['fr-q-pick', 'fr-pick'],
                ['fr-q-mgrs', 'fr-coord-pick'],
                ['fr-q-ruler', 'fr-ruler'],
                ['fr-q-aim', 'fr-aim-place'],
                ['fr-q-corridor', 'fr-corridor'],
                ['fr-q-place', 'fr-flight-place'],
                ['fr-q-fly', 'fr-flight-goto'],
                ['fr-q-attach', 'fr-flight-attach']
            ];
            pairs.forEach(([qid, sid]) => {
                const q = document.getElementById(qid);
                const s = document.getElementById(sid);
                if (!q || !s) return;
                q.classList.toggle('active', s.classList.contains('active'));
            });
            const pointsBtn = document.getElementById('fr-q-points');
            const showCb = document.getElementById('fr-show-points');
            if (pointsBtn && showCb) {
                pointsBtn.classList.toggle('active', !showCb.checked);
                pointsBtn.title = showCb.checked ? 'Сховати точки' : 'Показати точки';
            }
            const fly = document.getElementById('fr-q-fly');
            if (fly) fly.title = myFlight?.cruise ? 'Стоп польоту' : 'Летіти за курсом';
            const attach = document.getElementById('fr-q-attach');
            if (attach) {
                attach.title = isPlaneAttached
                    ? 'Відкріпити від треку'
                    : (isAttachPickMode ? 'Скасувати вибір треку' : 'Прикріпити до треку карти');
            }
        }

        function wireQuickBar() {
            const bar = document.getElementById('fr-qbar');
            if (!bar || bar.__frWired) return;
            bar.__frWired = true;
            bar.addEventListener('click', (e) => {
                const btn = e.target?.closest?.('.fr-qbtn');
                if (!btn || !bar.contains(btn)) return;
                e.preventDefault();
                e.stopPropagation();
                openAccSection(btn.getAttribute('data-fr-acc'));
                const cmd = btn.getAttribute('data-fr-cmd');
                if (cmd === 'toggle-points') {
                    const cb = document.getElementById('fr-show-points');
                    if (cb) {
                        cb.checked = !cb.checked;
                        cb.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    syncQuickBar();
                    return;
                }
                const targetId = btn.getAttribute('data-fr-click');
                if (targetId) document.getElementById(targetId)?.click();
                syncQuickBar();
            });
            syncQuickBar();
        }

        function clearAttachPickListener() {
            if (attachPickListener) {
                if (mapType === 'google') {
                    google.maps.event.removeListener(attachPickListener);
                } else if (map.canvas) {
                    map.canvas.removeEventListener('click', attachPickListener);
                }
                attachPickListener = null;
            }
            isAttachPickMode = false;
        }

        function detachFromHostTrack(silent) {
            clearAttachPickListener();
            const was = isPlaneAttached;
            isPlaneAttached = false;
            attachedHostTrack = null;
            attachLastPos = null;
            updateAttachBtn();
            if (!was) return;
            if (!silent && myFlight?.active) {
                const cur = resolveFlightPos(myFlight) || myFlight;
                myFlight.lat = cur.lat;
                myFlight.lon = cur.lon;
                myFlight.from = { lat: cur.lat, lon: cur.lon };
                myFlight.to = null;
                myFlight.updatedAt = Date.now();
                setFlightStatus(
                    `${myFlight.callsign}: відкріплено від треку · курс ${Math.round(myFlight.heading || 0)}°`
                );
                pushMyFlight();
            }
        }

        function applyHostTrackPose(pose) {
            if (!myFlight?.active || !isPlaneAttached || !pose) return;
            if (!Number.isFinite(pose.lat) || !Number.isFinite(pose.lon)) return;
            if (isDraggingHeading || isDraggingPlane) return;

            const prev = attachLastPos;
            let heading = Number.isFinite(pose.heading) ? pose.heading : null;
            if (heading == null && prev) {
                const moved = haversineM(prev.lat, prev.lon, pose.lat, pose.lon);
                if (moved >= 5) heading = bearingDeg(prev, pose);
            }
            if (heading == null) heading = myFlight.heading || 0;

            attachLastPos = { lat: pose.lat, lon: pose.lon };
            myFlight.lat = pose.lat;
            myFlight.lon = pose.lon;
            myFlight.heading = heading;
            myFlight.from = { lat: pose.lat, lon: pose.lon };
            myFlight.to = null;
            myFlight.cruise = false;
            myFlight.startedAt = null;
            myFlight.updatedAt = Date.now();
            myFlight.speedKmh = getRulerSpeed();
            updateCruiseBtn();
            upsertFlightMarker(CLIENT_ID, myFlight, {
                lat: pose.lat,
                lon: pose.lon,
                heading
            });
            setFlightStatus(
                `${myFlight.callsign}: на треку карти · курс ${Math.round(heading)}°`
            );
        }

        function syncAttachedHostTrack() {
            if (!isPlaneAttached || !attachedHostTrack) return;
            const pose = readHostTrackPose(attachedHostTrack);
            if (!pose) {
                setFlightStatus(`${myFlight?.callsign || 'Борт'}: трек зник з карти — відкріплено`);
                detachFromHostTrack(true);
                return;
            }
            applyHostTrackPose(pose);
        }

        function bindToHostTrack(track) {
            if (!track || !myFlight?.active) return false;
            clearAttachPickListener();
            isPlaneAttached = true;
            attachedHostTrack = track;
            myFlight.cruise = false;
            myFlight.to = null;
            myFlight.startedAt = null;
            updateAttachBtn();
            updateCruiseBtn();
            const pose = readHostTrackPose(track);
            if (pose) applyHostTrackPose(pose);
            else {
                setFlightStatus(`${myFlight.callsign}: прикріплено, чекаю оновлення треку…`);
            }
            pushMyFlight();
            ensurePushTimer();
            startFlightLoop();
            return true;
        }

        function pickHostTrackAt(lat, lon) {
            installHostTrackSpy();
            if (mapType === 'google') {
                const hit = findNearestHostTrack(map, lat, lon, 3000);
                if (hit) return hit;
                // Якщо spy ще не зловив — підкажемо
                const n = collectHostTrackCandidates(map).length;
                console.warn('[FALCONROUTE] host tracks visible to spy:', n);
                return null;
            }
            // Cesium: pick entity under click
            try {
                const Cesium = window.Cesium;
                if (!Cesium || !map?.scene) return null;
                // lat/lon already from click — find nearest moving-looking entity
                let best = null;
                let bestD = 3000;
                const entities = map.entities?.values || [];
                for (const ent of entities) {
                    if (!ent || ent.__frOwn) continue;
                    const track = { kind: 'cesium', obj: ent, clock: map.clock };
                    const pose = readHostTrackPose(track);
                    if (!pose) continue;
                    const d = haversineM(lat, lon, pose.lat, pose.lon);
                    if (d < bestD) {
                        bestD = d;
                        best = track;
                    }
                }
                return best;
            } catch (_) {
                return null;
            }
        }

        function beginAttachToHostTrack() {
            if (isPickMode) stopPickMode();
            if (isCoordPickMode) stopCoordPickMode();
            if (isCorridorMode) stopCorridorMode(false);
            if (isRulerMode) stopRulerMode();
            stopAircraftModes();

            if (isPlaneAttached) {
                detachFromHostTrack(false);
                return;
            }
            if (isAttachPickMode) {
                clearAttachPickListener();
                updateAttachBtn();
                setFlightStatus(myFlight?.active ? `${myFlight.callsign}: на позиції` : 'Борт не виставлено');
                return;
            }

            if (!myFlight?.active) {
                alert('Спочатку постав борт («Поставити»), потім прикріпи до треку на карті.');
                return;
            }

            installHostTrackSpy();
            isAttachPickMode = true;
            updateAttachBtn();
            setFlightStatus('Клацни стрілку/трек на карті (рухомий обʼєкт самої карти)');

            const onPick = (lat, lon, directTrack) => {
                const track = directTrack || pickHostTrackAt(lat, lon);
                if (!track) {
                    setFlightStatus(
                        'Трек не знайдено поруч. Клацни ближче до стрілки, коли вона рухається на карті.'
                    );
                    alert(
                        'Не знайшов стрілку треку карти поруч із кліком.\n\n' +
                        'Підказка: стрілка має бути маркером Google Maps / Cesium entity.\n' +
                        'Клацни прямо по ній (коли вона вже зʼявилась і рухається).\n' +
                        'Діагностика: у консолі __FR_hostTracks()'
                    );
                    return;
                }
                bindToHostTrack(track);
            };

            // Прямий клік по маркеру хоста (map click часто не стріляє, якщо влучив у Marker)
            const wired = new WeakSet();
            const wireHostClicks = () => {
                if (!isAttachPickMode) return;
                collectHostTrackCandidates(map).forEach((c) => {
                    if (c.kind !== 'marker' || wired.has(c.obj)) return;
                    wired.add(c.obj);
                    try {
                        c.obj.addListener('click', () => {
                            if (!isAttachPickMode) return;
                            const pose = readMarkerPose(c.obj);
                            if (pose) onPick(pose.lat, pose.lon, { kind: 'marker', obj: c.obj });
                        });
                    } catch (_) { /* ignore */ }
                });
            };
            wireHostClicks();
            const wireTimer = setInterval(() => {
                if (!isAttachPickMode) {
                    clearInterval(wireTimer);
                    return;
                }
                wireHostClicks();
            }, 500);

            if (mapType === 'google') {
                attachPickListener = map.addListener('click', (e) => {
                    const ll = mapClickLatLon(e);
                    if (!ll) return;
                    onPick(ll.lat, ll.lon);
                });
            } else if (map.canvas) {
                attachPickListener = (e) => {
                    const ll = mapClickLatLon(e);
                    if (!ll) return;
                    onPick(ll.lat, ll.lon);
                };
                map.canvas.addEventListener('click', attachPickListener);
            }
        }

        function togglePlaneAttach() {
            beginAttachToHostTrack();
        }

        function destroyCesiumHeadingDrag() {
            if (cesiumHeadingHandler) {
                try { cesiumHeadingHandler.destroy(); } catch (_) { /* ignore */ }
                cesiumHeadingHandler = null;
            }
        }

        function setCesiumCamDrag(enabled) {
            const c = map.scene?.screenSpaceCameraController;
            if (!c) return;
            c.enableRotate = enabled;
            c.enableTranslate = enabled;
            c.enableZoom = enabled;
            c.enableTilt = enabled;
        }

        function ensureCesiumHeadingDrag() {
            const Cesium = window.Cesium;
            if (!Cesium || cesiumHeadingHandler) return;
            const handler = new Cesium.ScreenSpaceEventHandler(map.scene.canvas);
            cesiumHeadingHandler = handler;

            handler.setInputAction((movement) => {
                if (Date.now() < ignoreHeadingInputUntil) return;
                const slot = flightMarkers[CLIENT_ID];
                if (!slot || !myFlight?.active) return;
                const picked = map.scene.pick(movement.position);
                if (!picked?.id) return;
                if (slot.headingLine && picked.id === slot.headingLine) {
                    isDraggingHeading = true;
                    setCesiumCamDrag(false);
                    armHeadingDocRelease();
                    return;
                }
                if (slot.headingHit && picked.id === slot.headingHit) {
                    isDraggingHeading = true;
                    setCesiumCamDrag(false);
                    armHeadingDocRelease();
                    return;
                }
                if (slot.entity && picked.id === slot.entity) {
                    isDraggingPlane = true;
                    planeDragPos = { lat: myFlight.lat, lon: myFlight.lon };
                    setCesiumCamDrag(false);
                }
            }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

            handler.setInputAction((movement) => {
                if (!myFlight?.active) return;
                const cartesian = map.camera.pickEllipsoid(movement.endPosition, map.scene.globe.ellipsoid);
                if (!cartesian) return;
                const carto = map.scene.globe.ellipsoid.cartesianToCartographic(cartesian);
                const tip = {
                    lat: carto.latitude * 57.29577951308232,
                    lon: carto.longitude * 57.29577951308232
                };
                if (isDraggingHeading) {
                    headingDragTip = tip;
                    const cur = resolveFlightPos(myFlight) || myFlight;
                    myFlight.heading = bearingDeg(cur, headingDragTip);
                    upsertFlightMarker(CLIENT_ID, myFlight, {
                        lat: cur.lat,
                        lon: cur.lon,
                        heading: myFlight.heading
                    });
                } else if (isDraggingPlane) {
                    planeDragPos = tip;
                    myFlight.lat = tip.lat;
                    myFlight.lon = tip.lon;
                    upsertFlightMarker(CLIENT_ID, myFlight, {
                        lat: tip.lat,
                        lon: tip.lon,
                        heading: myFlight.heading || 0
                    });
                }
            }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

            const endDrag = () => {
                if (isDraggingHeading) {
                    cancelHeadingDrag(true);
                    return;
                }
                if (isDraggingPlane) {
                    const pos = planeDragPos;
                    isDraggingPlane = false;
                    planeDragPos = null;
                    setCesiumCamDrag(true);
                    if (pos) applyPlaneMove(pos.lat, pos.lon);
                }
            };
            handler.setInputAction(endDrag, Cesium.ScreenSpaceEventType.LEFT_UP);
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
                    this.div.className = 'fr-ruler-label fr-flight-label';
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
                    this.div.style.top = (p.y - 34) + 'px';
                }
                onRemove() {
                    if (this.div?.parentNode) this.div.parentNode.removeChild(this.div);
                    this.div = null;
                }
                setPos(latLng) {
                    this.position = latLng;
                    this.draw();
                }
                setText(text, color) {
                    this.text = text;
                    if (color) this.color = color;
                    const chip = this.div?.querySelector('.fr-ruler-chip');
                    if (chip) {
                        chip.textContent = text;
                        if (color) chip.style.borderColor = color;
                    }
                }
            }
            const ov = new FrFlightLabel();
            ov.setMap(map);
            return ov;
        }

        function googlePlaneIcon(color, heading, isMe) {
            return {
                path: PLANE_SYMBOL_PATH,
                fillColor: color || '#22d3ee',
                fillOpacity: 0.7,
                strokeColor: '#ffffff',
                strokeWeight: 1.2,
                strokeOpacity: 0.7,
                scale: isMe ? 0.95 : 0.8,
                // Google: clockwise from north — як bearingDeg
                rotation: Number.isFinite(heading) ? heading : 0,
                anchor: new google.maps.Point(0, 0)
            };
        }

        function cancelHeadingDrag(applyTip) {
            if (!isDraggingHeading && !headingDocUpHandler) {
                headingDragTip = null;
                return;
            }
            const tip = applyTip ? (headingDragTip || null) : null;
            isDraggingHeading = false;
            headingDragTip = null;
            if (mapType === 'google' && map.setOptions) {
                try { map.setOptions({ draggable: true }); } catch (_) { /* ignore */ }
            }
            if (mapType === 'cesium') setCesiumCamDrag(true);
            if (headingDocUpHandler) {
                document.removeEventListener('mouseup', headingDocUpHandler, true);
                document.removeEventListener('pointerup', headingDocUpHandler, true);
                headingDocUpHandler = null;
            }
            if (tip) applyCourseFromTip(tip);
        }

        function armHeadingDocRelease() {
            if (headingDocUpHandler) {
                document.removeEventListener('mouseup', headingDocUpHandler, true);
                document.removeEventListener('pointerup', headingDocUpHandler, true);
            }
            headingDocUpHandler = () => {
                cancelHeadingDrag(true);
            };
            document.addEventListener('mouseup', headingDocUpHandler, true);
            document.addEventListener('pointerup', headingDocUpHandler, true);
        }

        function wireGoogleHeadingLine(hitLine) {
            const listeners = [];
            listeners.push(hitLine.addListener('mousedown', (e) => {
                if (Date.now() < ignoreHeadingInputUntil) return;
                if (!myFlight?.active || !e?.latLng) return;
                if (isDraggingPlane) return;
                e?.domEvent?.preventDefault?.();
                e?.domEvent?.stopPropagation?.();
                isDraggingHeading = true;
                headingDragTip = { lat: e.latLng.lat(), lon: e.latLng.lng() };
                if (map.setOptions) map.setOptions({ draggable: false });
                armHeadingDocRelease();
                const cur = resolveFlightPos(myFlight) || myFlight;
                myFlight.heading = bearingDeg(cur, headingDragTip);
                upsertFlightMarker(CLIENT_ID, myFlight, {
                    lat: cur.lat,
                    lon: cur.lon,
                    heading: myFlight.heading
                });
            }));
            listeners.push(map.addListener('mousemove', (e) => {
                if (!isDraggingHeading || !myFlight?.active || !e?.latLng) return;
                headingDragTip = { lat: e.latLng.lat(), lon: e.latLng.lng() };
                const cur = resolveFlightPos(myFlight) || myFlight;
                myFlight.heading = bearingDeg(cur, headingDragTip);
                upsertFlightMarker(CLIENT_ID, myFlight, {
                    lat: cur.lat,
                    lon: cur.lon,
                    heading: myFlight.heading
                });
            }));
            listeners.push(map.addListener('mouseup', (e) => {
                if (!isDraggingHeading) return;
                if (e?.latLng) {
                    headingDragTip = { lat: e.latLng.lat(), lon: e.latLng.lng() };
                }
                cancelHeadingDrag(true);
            }));
            return listeners;
        }

        function wireGooglePlaneDrag(marker) {
            const listeners = [];
            listeners.push(marker.addListener('mousedown', (e) => {
                e?.stop?.();
                e?.domEvent?.stopPropagation?.();
            }));
            listeners.push(marker.addListener('dragstart', () => {
                isDraggingPlane = true;
                if (map.setOptions) map.setOptions({ draggable: false });
            }));
            listeners.push(marker.addListener('drag', (e) => {
                if (!e?.latLng || !myFlight?.active) return;
                planeDragPos = { lat: e.latLng.lat(), lon: e.latLng.lng() };
                myFlight.lat = planeDragPos.lat;
                myFlight.lon = planeDragPos.lon;
                upsertFlightMarker(CLIENT_ID, myFlight, {
                    lat: planeDragPos.lat,
                    lon: planeDragPos.lon,
                    heading: myFlight.heading || 0
                });
            }));
            listeners.push(marker.addListener('dragend', (e) => {
                const pos = e?.latLng
                    ? { lat: e.latLng.lat(), lon: e.latLng.lng() }
                    : planeDragPos;
                isDraggingPlane = false;
                planeDragPos = null;
                if (map.setOptions) map.setOptions({ draggable: true });
                if (pos) applyPlaneMove(pos.lat, pos.lon);
            }));
            return listeners;
        }

        function upsertFlightMarker(id, flight, pos) {
            if (!pos) return;
            const color = flight.color || '#22d3ee';
            const callsign = flight.callsign || id.slice(0, 8);
            const isMe = id === CLIENT_ID;
            const heading = Number.isFinite(pos.heading) ? pos.heading : (flight.heading || 0);
            const labelText = (isMe ? '● ' : '') + callsign;
            const tip = headingTipFrom(pos, heading, id);
            const hasCourse = !!(flight.to && Number.isFinite(flight.to.lat) && Number.isFinite(flight.to.lon)
                && !(isDraggingHeading && isMe) && !(isDraggingPlane && isMe));

            if (mapType === 'google') {
                let slot = flightMarkers[id];
                const tipLatLng = { lat: tip.lat, lng: tip.lon };
                const planeLatLng = { lat: pos.lat, lng: pos.lon };

                if (!slot) {
                    const marker = new google.maps.Marker({
                        position: planeLatLng,
                        map,
                        icon: googlePlaneIcon(color, heading, isMe),
                        zIndex: 200,
                        title: isMe ? 'Перетягни борт · тягни жовту лінію курсу' : callsign,
                        optimized: false,
                        clickable: isMe,
                        draggable: isMe,
                        cursor: isMe ? 'grab' : undefined
                    });
                    markOwnOverlay(marker);
                    try { hostMarkerRegistry.delete(marker); } catch (_) { /* ignore */ }
                    const labelOv = createFlightCallsignOverlay(
                        new google.maps.LatLng(pos.lat, pos.lon),
                        labelText,
                        color
                    );
                    const headingLine = new google.maps.Polyline({
                        path: [planeLatLng, tipLatLng],
                        geodesic: true,
                        strokeColor: '#fbbf24',
                        strokeOpacity: 0.95,
                        strokeWeight: 3,
                        map,
                        zIndex: 198,
                        clickable: false
                    });
                    // Вузька зона кліку курсу (широка зона ловила клік постановки й «липла» до миші)
                    const headingHit = new google.maps.Polyline({
                        path: [planeLatLng, tipLatLng],
                        geodesic: true,
                        strokeColor: '#fbbf24',
                        strokeOpacity: 0.01,
                        strokeWeight: 10,
                        map,
                        zIndex: 199,
                        clickable: isMe,
                        cursor: isMe ? 'grab' : undefined
                    });
                    const courseLine = new google.maps.Polyline({
                        path: hasCourse
                            ? [planeLatLng, { lat: flight.to.lat, lng: flight.to.lon }]
                            : [planeLatLng, planeLatLng],
                        geodesic: true,
                        strokeColor: color,
                        strokeOpacity: hasCourse ? 0.55 : 0,
                        strokeWeight: 2,
                        map,
                        zIndex: 197,
                        clickable: false
                    });
                    let handleListeners = [];
                    let planeListeners = [];
                    if (isMe) {
                        handleListeners = wireGoogleHeadingLine(headingHit);
                        planeListeners = wireGooglePlaneDrag(marker);
                    }
                    flightMarkers[id] = {
                        marker, labelOv, headingLine, headingHit, courseLine,
                        headingHandle: null, handleListeners, planeListeners, color
                    };
                } else {
                    if (!(isDraggingPlane && isMe)) {
                        slot.marker.setPosition(planeLatLng);
                    }
                    slot.marker.setIcon(googlePlaneIcon(color, heading, isMe));
                    slot.labelOv?.setPos(new google.maps.LatLng(pos.lat, pos.lon));
                    slot.labelOv?.setText?.(labelText, color);
                    slot.headingLine.setPath([planeLatLng, tipLatLng]);
                    slot.headingHit?.setPath([planeLatLng, tipLatLng]);
                    if (hasCourse) {
                        slot.courseLine.setOptions({ strokeOpacity: 0.55, strokeColor: color });
                        slot.courseLine.setPath([
                            planeLatLng,
                            { lat: flight.to.lat, lng: flight.to.lon }
                        ]);
                    } else {
                        slot.courseLine.setOptions({ strokeOpacity: 0 });
                        slot.courseLine.setPath([planeLatLng, planeLatLng]);
                    }
                    if (slot.color !== color) slot.color = color;
                }
                return;
            }

            if (!Cartesian3) return;
            const Cesium = window.Cesium;
            let slot = flightMarkers[id];
            // Cesium billboard.rotation з alignedAxis=UNIT_Z — проти годинника від півночі,
            // а bearingDeg — за годинником, тому інвертуємо знак (інакше ніс/компас ідуть реверсно).
            const rotation = -(Cesium?.Math
                ? Cesium.Math.toRadians(heading)
                : (heading * Math.PI / 180));
            const planePos = Cartesian3.fromDegrees(pos.lon, pos.lat);
            const tipPos = Cartesian3.fromDegrees(tip.lon, tip.lat);

            if (!slot) {
                const track = { plane: planePos, tip: tipPos };
                const entity = map.entities.add({
                    position: planePos,
                    billboard: {
                        image: planeBillboardImage(color),
                        width: isMe ? 36 : 30,
                        height: isMe ? 36 : 30,
                        rotation,
                        alignedAxis: Cesium?.Cartesian3?.UNIT_Z,
                        color: toCesiumColor({ red: 1, green: 1, blue: 1, alpha: 0.7 }),
                        disableDepthTestDistance: Number.POSITIVE_INFINITY
                    }
                });
                markOwnOverlay(entity);
                const labelEnt = map.entities.add({
                    position: planePos,
                    label: {
                        text: labelText,
                        font: 'bold 12px sans-serif',
                        fillColor: toCesiumColor({ red: 1, green: 1, blue: 1, alpha: 1 }),
                        outlineColor: toCesiumColor({ red: 0, green: 0, blue: 0, alpha: 1 }),
                        outlineWidth: 3,
                        pixelOffset: Cesium?.Cartesian2
                            ? new Cesium.Cartesian2(0, -34)
                            : undefined,
                        showBackground: true,
                        backgroundColor: toCesiumColor({ red: 0.03, green: 0.18, blue: 0.28, alpha: 0.88 }),
                        disableDepthTestDistance: Number.POSITIVE_INFINITY
                    }
                });
                markOwnOverlay(labelEnt);
                // Довга лінія курсу на карті (не в SVG) — CallbackProperty, без перезапису material
                const headingLine = map.entities.add({
                    polyline: {
                        positions: Cesium?.CallbackProperty
                            ? new Cesium.CallbackProperty(() => [track.plane, track.tip], false)
                            : [planePos, tipPos],
                        width: 3,
                        material: toCesiumColor('#fbbf24')
                    }
                });
                markOwnOverlay(headingLine);
                let headingHit = null;
                if (isMe) {
                    headingHit = map.entities.add({
                        polyline: {
                            positions: Cesium?.CallbackProperty
                                ? new Cesium.CallbackProperty(() => [track.plane, track.tip], false)
                                : [planePos, tipPos],
                            width: 16,
                            material: toCesiumColor({ red: 0.98, green: 0.75, blue: 0.14, alpha: 0.08 })
                        }
                    });
                    markOwnOverlay(headingHit);
                    ensureCesiumHeadingDrag();
                }
                flightMarkers[id] = {
                    entity, labelEnt, headingLine, headingHit, courseLine: null,
                    headingHandle: null, color, track
                };
            } else {
                if (slot.track) {
                    slot.track.plane = planePos;
                    slot.track.tip = tipPos;
                }
                slot.entity.position = planePos;
                if (slot.entity.billboard) {
                    if (typeof slot.entity.billboard.rotation === 'object' && slot.entity.billboard.rotation?.setValue) {
                        slot.entity.billboard.rotation.setValue(rotation);
                    } else {
                        slot.entity.billboard.rotation = rotation;
                    }
                    if (slot.color !== color) {
                        slot.entity.billboard.image = planeBillboardImage(color);
                        slot.color = color;
                    }
                }
                slot.labelEnt.position = planePos;
                if (slot.labelEnt.label) {
                    if (slot.labelEnt.label.text?.setValue) slot.labelEnt.label.text.setValue(labelText);
                    else slot.labelEnt.label.text = labelText;
                }
            }
            map.scene?.requestRender?.();
        }

        function setFlightStatus(text) {
            const el = document.getElementById('fr-flight-status');
            if (!el) return;
            el.textContent = text || '';
            const idle = !text || /не виставлено/i.test(text);
            el.classList.toggle('muted', idle);
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

        function resolveFlightPos(flight, now = Date.now()) {
            if (!flight) return null;
            if (flight.cruise && flight.from && flight.startedAt && Number.isFinite(flight.heading)) {
                const speed = Number(flight.speedKmh) || getRulerSpeed();
                if (!(speed > 0)) {
                    return {
                        lat: flight.from.lat,
                        lon: flight.from.lon,
                        heading: flight.heading || 0,
                        done: false,
                        cruise: true,
                        traveledM: 0
                    };
                }
                const metersPerMs = (speed * 1000) / 3600 / 1000;
                const traveled = Math.max(0, (now - flight.startedAt) * metersPerMs);
                const pos = destinationPoint(
                    flight.from.lat,
                    flight.from.lon,
                    flight.heading,
                    traveled
                );
                return {
                    lat: pos.lat,
                    lon: pos.lon,
                    heading: flight.heading,
                    done: false,
                    cruise: true,
                    traveledM: traveled
                };
            }
            if (flight.to && flight.from && flight.startedAt) {
                const pos = positionAlongPath(
                    [flight.from, flight.to],
                    flight.speedKmh || getRulerSpeed(),
                    flight.startedAt,
                    now
                );
                if (!pos) return { lat: flight.lat, lon: flight.lon, heading: flight.heading || 0, done: false };
                if (pos.done) {
                    return {
                        lat: flight.to.lat,
                        lon: flight.to.lon,
                        heading: pos.heading,
                        done: true,
                        traveledM: pos.traveledM,
                        totalM: pos.totalM
                    };
                }
                return pos;
            }
            if (Number.isFinite(flight.lat) && Number.isFinite(flight.lon)) {
                return {
                    lat: flight.lat,
                    lon: flight.lon,
                    heading: flight.heading || 0,
                    done: false,
                    stationary: true
                };
            }
            return null;
        }

        function clearRangeLine() {
            try {
                if (mapType === 'google') {
                    rangeLineOverlays.forEach(o => {
                        try { o.setMap(null); } catch (_) { /* ignore */ }
                    });
                } else {
                    rangeLineOverlays.forEach(ent => {
                        try { map.entities.remove(ent); } catch (_) { /* ignore */ }
                    });
                }
            } catch (_) { /* ignore */ }
            rangeLineOverlays = [];
            rangeTrack = null;
        }

        function createGoogleRangeLabel(position, text, bearingDegVal) {
            let rot = Number.isFinite(bearingDegVal) ? bearingDegVal : 0;
            if (rot > 90 && rot < 270) rot = (rot + 180) % 360;
            class FrRangeLabel extends google.maps.OverlayView {
                constructor() {
                    super();
                    this.position = position;
                    this.div = null;
                    this.rot = rot;
                    this.text = text || '';
                }
                onAdd() {
                    this.div = document.createElement('div');
                    this.div.className = 'fr-ruler-label fr-range-label';
                    const chip = document.createElement('div');
                    chip.className = 'fr-ruler-chip';
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
                    this.div.style.top = p.y + 'px';
                    this.div.style.transform =
                        `translate(-50%, -50%) rotate(${this.rot}deg) translate(0, -12px)`;
                }
                onRemove() {
                    if (this.div?.parentNode) this.div.parentNode.removeChild(this.div);
                    this.div = null;
                }
                setPose(latLng, bearing) {
                    this.position = latLng;
                    let r = Number.isFinite(bearing) ? bearing : this.rot;
                    if (r > 90 && r < 270) r = (r + 180) % 360;
                    this.rot = r;
                    this.draw();
                }
                setLabel(t) {
                    this.text = t || '';
                    const chip = this.div?.querySelector('.fr-ruler-chip');
                    if (chip) chip.textContent = this.text;
                }
            }
            const ov = new FrRangeLabel();
            ov.setMap(map);
            return ov;
        }

        function updateRangeLine(myPos, targetPos, meta) {
            if (!myPos || !targetPos) {
                clearRangeLine();
                return;
            }
            const distM = Number.isFinite(meta?.dist)
                ? meta.dist
                : haversineM(myPos.lat, myPos.lon, targetPos.lat, targetPos.lon);
            const eta = meta?.eta || formatTravelTime(distM, getRulerSpeed());
            const name = meta?.name ? `${meta.name} · ` : '';
            const labelText = `${name}${formatDistanceKm(distM)} · ETA ${eta}`;
            const mid = {
                lat: (myPos.lat + targetPos.lat) / 2,
                lon: (myPos.lon + targetPos.lon) / 2
            };
            const brg = bearingDeg(
                { lat: myPos.lat, lon: myPos.lon },
                { lat: targetPos.lat, lon: targetPos.lon }
            );

            if (mapType === 'google') {
                const path = [
                    { lat: myPos.lat, lng: myPos.lon },
                    { lat: targetPos.lat, lng: targetPos.lon }
                ];
                const midLatLng = new google.maps.LatLng(mid.lat, mid.lon);
                if (!rangeLineOverlays.length) {
                    rangeLineOverlays.push(new google.maps.Polyline({
                        path,
                        geodesic: true,
                        strokeColor: '#a78bfa',
                        strokeOpacity: 0.85,
                        strokeWeight: 2,
                        map,
                        zIndex: 190,
                        clickable: false,
                        icons: [{
                            icon: {
                                path: 'M 0,-1 0,1',
                                strokeOpacity: 0.85,
                                scale: 2
                            },
                            offset: '0',
                            repeat: '12px'
                        }]
                    }));
                    rangeLineOverlays.push(createGoogleRangeLabel(midLatLng, labelText, brg));
                } else {
                    rangeLineOverlays[0].setPath(path);
                    const label = rangeLineOverlays[1];
                    if (label?.setPose) {
                        label.setPose(midLatLng, brg);
                        label.setLabel(labelText);
                    } else {
                        try { label?.setMap?.(null); } catch (_) { /* ignore */ }
                        rangeLineOverlays[1] = createGoogleRangeLabel(midLatLng, labelText, brg);
                    }
                }
                return;
            }
            if (!Cartesian3) return;
            const Cesium = window.Cesium;
            if (!rangeTrack) {
                rangeTrack = {
                    a: Cartesian3.fromDegrees(myPos.lon, myPos.lat),
                    b: Cartesian3.fromDegrees(targetPos.lon, targetPos.lat),
                    mid: Cartesian3.fromDegrees(mid.lon, mid.lat),
                    text: labelText
                };
                rangeLineOverlays.push(map.entities.add({
                    polyline: {
                        positions: Cesium?.CallbackProperty
                            ? new Cesium.CallbackProperty(() => [rangeTrack.a, rangeTrack.b], false)
                            : [rangeTrack.a, rangeTrack.b],
                        width: 2,
                        material: toCesiumColor({ red: 0.65, green: 0.55, blue: 0.98, alpha: 0.85 })
                    }
                }));
                rangeLineOverlays.push(map.entities.add({
                    position: Cesium?.CallbackProperty
                        ? new Cesium.CallbackProperty(() => rangeTrack.mid, false)
                        : rangeTrack.mid,
                    label: {
                        text: Cesium?.CallbackProperty
                            ? new Cesium.CallbackProperty(() => rangeTrack.text, false)
                            : labelText,
                        font: 'bold 12px sans-serif',
                        fillColor: toCesiumColor({ red: 0.96, green: 0.95, blue: 1, alpha: 1 }),
                        outlineColor: toCesiumColor({ red: 0.18, green: 0.06, blue: 0.4, alpha: 1 }),
                        outlineWidth: 4,
                        style: Cesium?.LabelStyle?.FILL_AND_OUTLINE,
                        pixelOffset: Cesium?.Cartesian2
                            ? new Cesium.Cartesian2(0, -14)
                            : undefined,
                        showBackground: false,
                        disableDepthTestDistance: Number.POSITIVE_INFINITY
                    }
                }));
            } else {
                rangeTrack.a = Cartesian3.fromDegrees(myPos.lon, myPos.lat);
                rangeTrack.b = Cartesian3.fromDegrees(targetPos.lon, targetPos.lat);
                rangeTrack.mid = Cartesian3.fromDegrees(mid.lon, mid.lat);
                rangeTrack.text = labelText;
            }
            map.scene?.requestRender?.();
        }

        function listOnlinePeers(myPos) {
            const speed = getRulerSpeed();
            const now = Date.now();
            const rows = [];
            Object.keys(remoteFlights).forEach(id => {
                if (id === CLIENT_ID) return;
                const f = remoteFlights[id];
                if (!f?.active) return;
                if (now - (f.updatedAt || f.startedAt || 0) > 120000) return;
                const pos = resolveFlightPos(f, now);
                if (!pos) return;
                const dist = myPos
                    ? haversineM(myPos.lat, myPos.lon, pos.lat, pos.lon)
                    : null;
                rows.push({
                    id,
                    name: f.callsign || id.slice(0, 8),
                    color: f.color || '#94a3b8',
                    pos: { lat: pos.lat, lon: pos.lon },
                    dist,
                    eta: dist != null ? formatTravelTime(dist, speed) : '—',
                    text: dist != null
                        ? `${f.callsign || id.slice(0, 8)}: ${formatDistanceKm(dist)} · ${formatTravelTime(dist, speed)}`
                        : (f.callsign || id.slice(0, 8))
                });
            });
            rows.sort((a, b) => (a.dist ?? 1e18) - (b.dist ?? 1e18));
            return rows;
        }

        function syncRangeTargetSelect(peers) {
            const sel = document.getElementById('fr-range-target');
            if (!sel) return;
            const idsKey = peers.map(p => p.id).join('|');
            if (sel.dataset.frIds !== idsKey) {
                const keep = rangeTargetId || sel.value || '';
                sel.innerHTML = ['<option value="">— не вимірювати —</option>']
                    .concat(peers.map(p => `<option value="${p.id}">${p.name}</option>`))
                    .join('');
                sel.dataset.frIds = idsKey;
                sel.value = peers.some(p => p.id === keep) ? keep : '';
                rangeTargetId = sel.value || '';
            } else if (rangeTargetId && !peers.some(p => p.id === rangeTargetId)) {
                rangeTargetId = '';
                sel.value = '';
            } else if (sel.value !== rangeTargetId) {
                sel.value = rangeTargetId || '';
            }
        }

        function updateDistancesPanel(myPos) {
            const box = document.getElementById('fr-flight-distances');
            const rangeEl = document.getElementById('fr-flight-range');
            const peers = listOnlinePeers(myPos);
            syncRangeTargetSelect(peers);

            if (box) {
                box.textContent = peers.length
                    ? peers.map(r => r.text).join('\n')
                    : 'Немає інших бортів онлайн';
                box.style.whiteSpace = 'pre-line';
            }

            const target = peers.find(p => p.id === rangeTargetId);
            if (!myPos) {
                if (rangeEl) rangeEl.textContent = 'Спочатку постав свій борт';
                clearRangeLine();
                return;
            }
            if (!target) {
                if (rangeEl) {
                    rangeEl.textContent = peers.length
                        ? 'Обери борт у списку «Дистанція до»'
                        : 'Немає інших бортів для вимірювання';
                }
                clearRangeLine();
                return;
            }
            if (rangeEl) {
                rangeEl.innerHTML =
                    `<b>${target.name}</b>: ${formatDistanceKm(target.dist)} · ETA ${target.eta}` +
                    ` · ${getRulerSpeed()} км/год`;
            }
            updateRangeLine(myPos, target.pos, {
                name: target.name,
                dist: target.dist,
                eta: target.eta
            });
        }

        function tickFlights() {
            const now = Date.now();
            const activeIds = new Set();
            let myPos = null;

            if (myFlight?.active) {
                if (isPlaneAttached) {
                    syncAttachedHostTrack();
                    myPos = myFlight?.active
                        ? { lat: myFlight.lat, lon: myFlight.lon }
                        : null;
                    if (myFlight?.active) {
                        upsertFlightMarker(CLIENT_ID, myFlight, {
                            lat: myFlight.lat,
                            lon: myFlight.lon,
                            heading: myFlight.heading || 0
                        });
                        activeIds.add(CLIENT_ID);
                    }
                } else if (isDraggingPlane && planeDragPos) {
                    myPos = { lat: planeDragPos.lat, lon: planeDragPos.lon };
                    upsertFlightMarker(CLIENT_ID, myFlight, {
                        lat: planeDragPos.lat,
                        lon: planeDragPos.lon,
                        heading: myFlight.heading || 0
                    });
                    activeIds.add(CLIENT_ID);
                } else {
                const pos = resolveFlightPos(myFlight, now);
                if (!pos) {
                    removeMyAircraft();
                } else {
                    if (pos.done && myFlight.to) {
                        myFlight.lat = myFlight.to.lat;
                        myFlight.lon = myFlight.to.lon;
                        myFlight.heading = pos.heading;
                        myFlight.from = { lat: myFlight.lat, lon: myFlight.lon };
                        myFlight.to = null;
                        myFlight.startedAt = null;
                        myFlight.cruise = false;
                        pushMyFlight();
                        updateCruiseBtn();
                        setFlightStatus(`${myFlight.callsign}: прибув · натисни «Летіти»`);
                    } else if (pos.cruise || (myFlight.cruise && !pos.stationary)) {
                        myFlight.lat = pos.lat;
                        myFlight.lon = pos.lon;
                        myFlight.heading = pos.heading;
                        setFlightStatus(
                            `${myFlight.callsign}: летить · курс ${Math.round(myFlight.heading || 0)}° · ${formatDistanceKm(pos.traveledM || 0)} · ${myFlight.speedKmh || getRulerSpeed()} км/год`
                        );
                    } else if (!pos.stationary && myFlight.to) {
                        myFlight.lat = pos.lat;
                        myFlight.lon = pos.lon;
                        myFlight.heading = pos.heading;
                        const left = Math.max(0, (pos.totalM || 0) - (pos.traveledM || 0));
                        setFlightStatus(
                            `${myFlight.callsign}: в польоті · ${formatDistanceKm(pos.traveledM || 0)} / ${formatDistanceKm(pos.totalM || 0)} · лишилось ${formatTravelTime(left, myFlight.speedKmh)}`
                        );
                    } else if (!isDraggingHeading) {
                        setFlightStatus(`${myFlight.callsign}: на позиції · ${getRulerSpeed()} км/год`);
                    }
                    myPos = { lat: myFlight.lat, lon: myFlight.lon };
                    upsertFlightMarker(CLIENT_ID, myFlight, {
                        lat: myFlight.lat,
                        lon: myFlight.lon,
                        heading: myFlight.heading || 0
                    });
                    activeIds.add(CLIENT_ID);
                }
                }
            }

            Object.keys(remoteFlights).forEach(id => {
                if (id === CLIENT_ID) return;
                const f = remoteFlights[id];
                if (!f?.active) return;
                if (now - (f.updatedAt || f.startedAt || 0) > 120000) return;
                const pos = resolveFlightPos(f, now);
                if (!pos) return;
                const live = pos.done && f.to
                    ? { lat: f.to.lat, lon: f.to.lon, heading: pos.heading }
                    : { lat: pos.lat, lon: pos.lon, heading: pos.heading || f.heading || 0 };
                upsertFlightMarker(id, f, live);
                activeIds.add(id);
            });

            Object.keys(flightMarkers).forEach(id => {
                if (!activeIds.has(id)) clearFlightMarker(id);
            });

            updateDistancesPanel(myPos);
            if (aimTarget) {
                updateAimLine(myPos || null);
            }
            flightRaf = requestAnimationFrame(tickFlights);
        }

        function startFlightLoop() {
            if (flightRaf) return;
            flightRaf = requestAnimationFrame(tickFlights);
        }

        function ensurePushTimer() {
            if (flightPushTimer) return;
            flightPushTimer = setInterval(() => {
                if (myFlight?.active) {
                    myFlight.speedKmh = getRulerSpeed();
                    pushMyFlight();
                }
            }, 3000);
        }

        function stopAircraftModes() {
            isPlaceAircraftMode = false;
            isFlyToMode = false;
            const placeBtn = document.getElementById('fr-flight-place');
            if (placeBtn) {
                placeBtn.classList.remove('active');
                placeBtn.textContent = '📍 Поставити';
            }
            updateCruiseBtn();
            if (placeAircraftListener) {
                if (mapType === 'google') google.maps.event.removeListener(placeAircraftListener);
                else if (map.canvas) map.canvas.removeEventListener('click', placeAircraftListener);
                placeAircraftListener = null;
            }
            if (flyToListener) {
                if (mapType === 'google') google.maps.event.removeListener(flyToListener);
                else if (map.canvas) map.canvas.removeEventListener('click', flyToListener);
                flyToListener = null;
            }
            syncQuickBar();
        }

        function spawnOrMoveAircraft(lat, lon) {
            saveSettings();
            const callsign = (document.getElementById('fr-callsign').value || 'Falcon').trim().slice(0, 16) || 'Falcon';
            const color = document.getElementById('fr-flight-color').value || '#22d3ee';
            const speed = getRulerSpeed();
            const prev = myFlight;
            myFlight = {
                id: CLIENT_ID,
                callsign,
                color,
                speedKmh: speed,
                lat,
                lon,
                heading: prev?.heading || 0,
                from: { lat, lon },
                to: null,
                cruise: false,
                startedAt: null,
                updatedAt: Date.now(),
                active: true
            };
            setFlightStatus(`${callsign}: виставлено на карту`);
            updateCruiseBtn();
            // Не ловити mouseup/клік постановки як старт тягання курсу
            cancelHeadingDrag(false);
            ignoreHeadingInputUntil = Date.now() + 600;
            pushMyFlight();
            ensurePushTimer();
            startFlightLoop();
        }

        function toggleCruise() {
            if (!myFlight?.active) {
                alert('Спочатку постав борт кнопкою «Поставити».');
                return;
            }
            if (isPlaneAttached) {
                detachFromHostTrack(true);
                setFlightStatus(`${myFlight.callsign}: відкріплено для польоту`);
            }
            const cur = resolveFlightPos(myFlight) || myFlight;
            myFlight.lat = cur.lat;
            myFlight.lon = cur.lon;
            myFlight.from = { lat: cur.lat, lon: cur.lon };
            myFlight.to = null;
            myFlight.speedKmh = getRulerSpeed();
            myFlight.updatedAt = Date.now();

            if (myFlight.cruise) {
                myFlight.cruise = false;
                myFlight.startedAt = null;
                setFlightStatus(
                    `${myFlight.callsign}: стоп · курс ${Math.round(myFlight.heading || 0)}°`
                );
            } else {
                if (!Number.isFinite(myFlight.heading)) myFlight.heading = 0;
                myFlight.cruise = true;
                myFlight.startedAt = Date.now();
                setFlightStatus(
                    `${myFlight.callsign}: летить · курс ${Math.round(myFlight.heading || 0)}° · ${myFlight.speedKmh} км/год`
                );
            }
            updateCruiseBtn();
            pushMyFlight();
            ensurePushTimer();
            startFlightLoop();
        }

        function removeMyAircraft() {
            detachFromHostTrack(true);
            stopAircraftModes();
            myFlight = null;
            if (flightPushTimer) {
                clearInterval(flightPushTimer);
                flightPushTimer = 0;
            }
            clearFlightMarker(CLIENT_ID);
            clearMyFlightRemote();
            if (!Object.keys(remoteFlights).some(id => id !== CLIENT_ID && remoteFlights[id]?.active)) {
                stopFlightLoop();
            } else {
                startFlightLoop();
            }
            setFlightStatus('Борт не виставлено');
            updateCruiseBtn();
            clearRangeLine();
            updateDistancesPanel(null);
        }

        function mapClickLatLon(e) {
            if (mapType === 'google') {
                if (!e?.latLng) return null;
                return { lat: e.latLng.lat(), lon: e.latLng.lng() };
            }
            const rect = map.canvas.getBoundingClientRect();
            const clickPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
            const cartesian = map.camera.pickEllipsoid(clickPos, map.scene.globe.ellipsoid);
            if (!cartesian) return null;
            const cartographic = map.scene.globe.ellipsoid.cartesianToCartographic(cartesian);
            return {
                lat: cartographic.latitude * 57.29577951308232,
                lon: cartographic.longitude * 57.29577951308232
            };
        }

        function beginPlaceAircraft() {
            if (isPickMode) stopPickMode();
            if (isCoordPickMode) stopCoordPickMode();
            if (isCorridorMode) stopCorridorMode(false);
            if (isRulerMode) stopRulerMode();
            if (isPlaneAttached) detachFromHostTrack(true);
            if (isAttachPickMode) {
                clearAttachPickListener();
                updateAttachBtn();
            }
            if (isPlaceAircraftMode) {
                stopAircraftModes();
                setFlightStatus(myFlight?.active ? `${myFlight.callsign}: на позиції` : 'Борт не виставлено');
                return;
            }
            stopAircraftModes();
            isPlaceAircraftMode = true;
            const btn = document.getElementById('fr-flight-place');
            btn.classList.add('active');
            btn.textContent = '👆 Клацни на карті…';
            setFlightStatus('Клацни карту, щоб поставити борт');
            syncQuickBar();

            if (mapType === 'google') {
                placeAircraftListener = map.addListener('click', (e) => {
                    const ll = mapClickLatLon(e);
                    if (!ll) return;
                    spawnOrMoveAircraft(ll.lat, ll.lon);
                    stopAircraftModes();
                });
            } else {
                placeAircraftListener = (e) => {
                    const ll = mapClickLatLon(e);
                    if (!ll) return;
                    spawnOrMoveAircraft(ll.lat, ll.lon);
                    stopAircraftModes();
                };
                map.canvas.addEventListener('click', placeAircraftListener);
            }
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
            } catch (err) {
                console.warn('[FALCONROUTE] flights EventSource failed', err);
            }
        }

        document.getElementById('fr-flight-place').onclick = () => beginPlaceAircraft();
        document.getElementById('fr-flight-goto').onclick = () => toggleCruise();
        document.getElementById('fr-flight-attach').onclick = () => togglePlaneAttach();
        document.getElementById('fr-flight-stop').onclick = () => removeMyAircraft();
        updateAttachBtn();
        wireQuickBar();
        syncQuickBar();
        document.getElementById('fr-range-target').addEventListener('change', (e) => {
            rangeTargetId = e.target.value || '';
        });
        document.getElementById('fr-callsign').addEventListener('change', () => {
            saveSettings();
            if (myFlight) {
                myFlight.callsign = settings.callsign;
                pushMyFlight();
            }
        });
        document.getElementById('fr-flight-color').addEventListener('change', () => {
            saveSettings();
            if (myFlight) {
                myFlight.color = settings.flightColor;
                pushMyFlight();
            }
        });

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
    document.getElementById('falcon-route-license')?.remove();
    document.getElementById('falcon-route-blocked')?.remove();
    ensureLicensed().then((ok) => {
        if (ok) boot(0);
    });
})();
