// ==UserScript==
// @name         Torn Happy Jump Insurance Manager
// @namespace    torn-hji
// @version      0.4.21
// @description  Provider-side Happy Jump insurance policy and claims manager for Torn.
// @author       DooBiiE
// @match        https://www.torn.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=torn.com
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      api.torn.com
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/DooBiiE/Torn-Happy-Jump-Insurance/main/torn-hji-manager.user.js
// @updateURL    https://raw.githubusercontent.com/DooBiiE/Torn-Happy-Jump-Insurance/main/torn-hji-manager.user.js
// ==/UserScript==

(() => {
    'use strict';

    const APP = 'HJI Manager';
    const VERSION = '0.4.21';
    const PREFIX = 'torn_hji_manager_v1_';
    const CLAIM_PREFIX = '[HJI CLAIM]';
    const STATUS_PREFIX = '[HJI STATUS]';
    const POLICY_PREFIX = '[HJI POLICY]';
    const API_BASE = 'https://api.torn.com/v2';
    const ITEM_RECEIVE_LOG_ID = 4103;
    const ITEM_SCAN_FIRST_LOOKBACK_SECONDS = 3 * 24 * 60 * 60;
    const ITEM_SCAN_OVERLAP_SECONDS = 5 * 60;
    const ITEM_SCAN_PAGE_LIMIT = 100;
    const ITEM_SCANNER_SCHEMA_VERSION = 5;


    function decodeStoredValue(value, fallback) {
        if (value === undefined || value === null || value === '') return fallback;

        // Torn PDA/userscript engines may return JSON values as strings rather than
        // preserving the original array/object type. Decode up to two layers.
        let out = value;
        for (let i = 0; i < 2 && typeof out === 'string'; i++) {
            const s = out.trim();
            if (!s || (!s.startsWith('{') && !s.startsWith('[') && !s.startsWith('"'))) break;
            try { out = JSON.parse(s); } catch { break; }
        }

        // Some wrappers expose the actual stored value inside a `value` property.
        if (out && typeof out === 'object' && !Array.isArray(out) &&
            Object.keys(out).length === 1 && Object.prototype.hasOwnProperty.call(out, 'value')) {
            return decodeStoredValue(out.value, fallback);
        }

        return out;
    }

    function decodeStoredValue(value, fallback) {
        if (value === undefined || value === null || value === '') return fallback;

        let out = value;

        // Torn PDA may return a stored array/object as JSON text.
        for (let i = 0; i < 3 && typeof out === 'string'; i++) {
            const s = out.trim();
            if (!s) return fallback;
            if (!['{', '[', '"'].includes(s[0])) break;
            try { out = JSON.parse(s); } catch { break; }
        }

        // Be tolerant of wrappers that return { value: ... }.
        if (out && typeof out === 'object' && !Array.isArray(out) &&
            Object.keys(out).length === 1 &&
            Object.prototype.hasOwnProperty.call(out, 'value')) {
            return decodeStoredValue(out.value, fallback);
        }

        return out;
    }

    const storage = {
        get(key, fallback) {
            const full = PREFIX + key;

            try {
                if (typeof GM_getValue === 'function') {
                    const v = GM_getValue(full, undefined);
                    if (v !== undefined && !(v && typeof v.then === 'function')) {
                        return decodeStoredValue(v, fallback);
                    }
                }
            } catch (e) {
                console.warn(`[HJI] GM_getValue failed for ${key}; using localStorage.`, e);
            }

            try {
                const raw = localStorage.getItem(full);
                return raw == null ? fallback : decodeStoredValue(raw, fallback);
            } catch (e) {
                console.warn(`[HJI] localStorage read failed for ${key}.`, e);
                return fallback;
            }
        },

        set(key, value) {
            const full = PREFIX + key;

            // Always store JSON text. This is consistent between Tampermonkey and Torn PDA.
            const encoded = JSON.stringify(value);

            try {
                if (typeof GM_setValue === 'function') GM_setValue(full, encoded);
            } catch (e) {
                console.warn(`[HJI] GM_setValue failed for ${key}; localStorage still used.`, e);
            }

            try { localStorage.setItem(full, encoded); }
            catch (e) { console.warn(`[HJI] localStorage write failed for ${key}.`, e); }
        }
    };

    const uid = (prefix='id') => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
    const nowISO = () => new Date().toISOString();
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const money = n => Number(n || 0).toLocaleString('en-GB', {maximumFractionDigits: 0});
    const dateOnly = v => v ? new Date(v).toLocaleDateString('en-GB') : '—';

    function parseMoneyInput(value) {
        const cleaned = String(value ?? '')
            .replace(/,/g, '')
            .replace(/[^\d.-]/g, '');
        const n = Number(cleaned);
        return Number.isFinite(n) ? n : 0;
    }

    function formatMoneyInput(value) {
        const n = parseMoneyInput(value);
        return n.toLocaleString('en-GB', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
    }

    function bindMoneyInput(input) {
        if (!input) return;
        input.value = formatMoneyInput(input.value);
        input.addEventListener('blur', () => {
            input.value = formatMoneyInput(input.value);
        });
        input.addEventListener('focus', () => {
            // Keep separators visible while editing; parsing strips them on save.
            setTimeout(() => input.select?.(), 0);
        });
    }


    const encodeSetup = obj => {
        const bytes = new TextEncoder().encode(JSON.stringify(obj));
        let binary = '';
        bytes.forEach(b => binary += String.fromCharCode(b));
        return 'HJI1.' + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    };

    async function copyText(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {}
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch {}
        ta.remove();
        return ok;
    }

    function loadPosition(key) {
        const pos = storage.get(key, null);
        if (!pos || !Number.isFinite(pos.left) || !Number.isFinite(pos.top)) return null;
        return pos;
    }

    function makeDraggable(el, handle, storageKey, clickHandler = null) {
        const saved = loadPosition(storageKey);
        if (saved) {
            el.style.left = `${Math.max(0, Math.min(saved.left, window.innerWidth - 45))}px`;
            el.style.top = `${Math.max(0, Math.min(saved.top, window.innerHeight - 45))}px`;
            el.style.right = 'auto';
            el.style.bottom = 'auto';
            el.style.transform = 'none';
        }

        let dragging = false, moved = false;
        let startX = 0, startY = 0, startLeft = 0, startTop = 0;

        const point = e => {
            const t = e.touches?.[0] || e.changedTouches?.[0] || e;
            return { x: t.clientX, y: t.clientY };
        };

        const begin = e => {
            // Header buttons should still work; the launcher itself is intentionally draggable.
            if (handle !== el && e.target.closest?.('button,input,select,textarea,a')) return;
            if (e.type === 'mousedown' && e.button !== 0) return;

            const p = point(e);
            const r = el.getBoundingClientRect();
            dragging = true;
            moved = false;
            startX = p.x;
            startY = p.y;
            startLeft = r.left;
            startTop = r.top;

            // Remove centering transform before applying absolute drag coordinates.
            el.style.left = `${r.left}px`;
            el.style.top = `${r.top}px`;
            el.style.right = 'auto';
            el.style.bottom = 'auto';
            el.style.transform = 'none';

            if (e.cancelable) e.preventDefault();
        };

        const move = e => {
            if (!dragging) return;
            const p = point(e);
            const dx = p.x - startX;
            const dy = p.y - startY;
            if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;

            const visibleW = Math.min(el.offsetWidth || 60, 60);
            const visibleH = Math.min(el.offsetHeight || 40, 40);
            const left = Math.max(0, Math.min(startLeft + dx, window.innerWidth - visibleW));
            const top = Math.max(0, Math.min(startTop + dy, window.innerHeight - visibleH));
            el.style.left = `${left}px`;
            el.style.top = `${top}px`;

            if (e.cancelable) e.preventDefault();
        };

        const finish = e => {
            if (!dragging) return;
            dragging = false;
            const r = el.getBoundingClientRect();
            storage.set(storageKey, { left: Math.round(r.left), top: Math.round(r.top) });
            if (!moved && clickHandler) clickHandler();
            if (e?.cancelable && moved) e.preventDefault();
        };

        handle.style.touchAction = 'none';
        handle.addEventListener('mousedown', begin);
        window.addEventListener('mousemove', move, { passive: false });
        window.addEventListener('mouseup', finish);
        handle.addEventListener('touchstart', begin, { passive: false });
        window.addEventListener('touchmove', move, { passive: false });
        window.addEventListener('touchend', finish, { passive: false });
        window.addEventListener('touchcancel', finish, { passive: false });
    }

    function makeResizable(el, grip, storageKey) {
        const saved = storage.get(storageKey, null);
        if (saved?.width && saved?.height) {
            el.style.width = `${Math.min(saved.width, window.innerWidth * 0.97)}px`;
            el.style.height = `${Math.min(saved.height, window.innerHeight * 0.92)}px`;
        }

        let resizing = false, startX = 0, startY = 0, startW = 0, startH = 0;
        const point = e => {
            const t = e.touches?.[0] || e.changedTouches?.[0] || e;
            return { x: t.clientX, y: t.clientY };
        };
        const begin = e => {
            const p = point(e);
            const r = el.getBoundingClientRect();
            resizing = true;
            startX = p.x; startY = p.y; startW = r.width; startH = r.height;
            if (e.cancelable) e.preventDefault();
            e.stopPropagation?.();
        };
        const move = e => {
            if (!resizing) return;
            const p = point(e);
            const minW = 300, minH = 300;
            const maxW = Math.max(minW, window.innerWidth * 0.97);
            const maxH = Math.max(minH, window.innerHeight * 0.92);
            el.style.width = `${Math.max(minW, Math.min(startW + p.x - startX, maxW))}px`;
            el.style.height = `${Math.max(minH, Math.min(startH + p.y - startY, maxH))}px`;
            if (e.cancelable) e.preventDefault();
        };
        const finish = () => {
            if (!resizing) return;
            resizing = false;
            const r = el.getBoundingClientRect();
            storage.set(storageKey, { width: Math.round(r.width), height: Math.round(r.height) });
        };

        grip.addEventListener('mousedown', begin);
        window.addEventListener('mousemove', move, { passive: false });
        window.addEventListener('mouseup', finish);
        grip.addEventListener('touchstart', begin, { passive: false });
        window.addEventListener('touchmove', move, { passive: false });
        window.addEventListener('touchend', finish);
        window.addEventListener('touchcancel', finish);
    }

    function buildSetupCode(policy) {
        const customer = getCustomer(policy.customerId);
        const tier = getTier(policy.tierId);
        if (!customer || !tier) throw new Error('Customer or tier is missing.');
        if (!state.settings.providerId || !state.settings.providerName) {
            throw new Error('Set the provider Torn name and Torn ID in Settings first.');
        }

        return encodeSetup({
            schema: 'torn-hji-policy',
            version: 1,
            issuedAt: nowISO(),
            provider: {
                id: String(state.settings.providerId),
                name: state.settings.providerName
            },
            insured: {
                id: String(customer.tornId),
                name: customer.name
            },
            policy: {
                id: policy.id,
                tierId: tier.id,
                tierName: tier.name,
                type: tier.type,
                coverage: tier.coverage,
                maxDvds: Number(tier.maxDvds || 0),
                startDate: policy.startDate || null,
                endDate: policy.endDate || null,
                cashPrice: Number(tier.cashPrice || 0),
                itemName: tier.itemName || '',
                itemQty: Number(tier.itemQty || 0)
            }
        });
    }

    function setupCodeModal(policy) {
        let code;
        try { code = buildSetupCode(policy); }
        catch (e) { alert(e.message); return; }

        const customer = getCustomer(policy.customerId);
        const tier = getTier(policy.tierId);
        const modal = createModal('Client setup code');
        modal.content.innerHTML += `
          <div class="hji-help">
            <strong>What is this?</strong>
            <p>Send this setup code to the insured player. Their HJI Client can import it to link this policy to you.</p>
            <p>The code contains provider, insured-player and policy details only. <b>Your API key is never included.</b></p>
          </div>
          <div class="hji-card">
            <strong>${esc(customer?.name || '')} [${esc(customer?.tornId || '')}]</strong>
            <p>${esc(tier?.name || '')} · ${esc(tier?.coverage || '')}</p>
          </div>
          <label style="display:flex;flex-direction:column;gap:5px;margin-top:10px">
            Setup code
            <textarea id="hji-setup-code" readonly style="min-height:130px">${esc(code)}</textarea>
          </label>`;
        modal.el.querySelector('[data-save]').textContent = 'Copy code';
        modal.addSave(async () => {
            await copyText(code);
            alert('Client setup code copied.');
        });
    }

    const defaultTiers = [
        {
            id: uid('tier'),
            name: 'Road Leader',
            type: 'single',
            durationDays: 0,
            coverage: 'Single jump, up to 5 DVDs',
            maxDvds: 5,
            cashPrice: 800000,
            itemName: 'Xanax',
            itemQty: 1,
            active: true
        },
        {
            id: uid('tier'),
            name: 'Highway Chief',
            type: 'single',
            durationDays: 0,
            coverage: 'Single jump, up to 9 DVDs',
            maxDvds: 9,
            cashPrice: 1500000,
            itemName: 'Xanax',
            itemQty: 2,
            active: true
        },
        {
            id: uid('tier'),
            name: 'Monthly 5',
            type: 'monthly',
            durationDays: 30,
            coverage: 'Unlimited single jumps for 30 days, up to 5 DVDs',
            maxDvds: 5,
            cashPrice: 8000000,
            itemName: '',
            itemQty: 0,
            active: true
        },
        {
            id: uid('tier'),
            name: 'Monthly 9',
            type: 'monthly',
            durationDays: 30,
            coverage: 'Unlimited single jumps for 30 days, up to 9 DVDs',
            maxDvds: 9,
            cashPrice: 10000000,
            itemName: '',
            itemQty: 0,
            active: true
        }
    ];

    function normalizeCollection(value, name) {
        const decoded = decodeStoredValue(value, []);

        if (Array.isArray(decoded)) return decoded;

        // Recover an object containing numeric/indexed records rather than crashing.
        if (decoded && typeof decoded === 'object') {
            const values = Object.values(decoded);
            if (values.length && values.every(v => v && typeof v === 'object')) {
                console.warn(`[HJI Manager] Recovered ${name} from object storage format.`);
                return values;
            }
        }

        if (decoded !== undefined && decoded !== null && decoded !== '') {
            console.warn(`[HJI Manager] Invalid ${name} storage value ignored:`, decoded);
        }
        return [];
    }

    function normalizeSettings(value) {
        const defaults = {
            providerId: '',
            providerName: '',
            apiKey: '',
            dueSoonDays: 3,
            claimPollMinutes: 10,
            lastMailScan: null,
            apiAccountId: '',
            apiAccountName: '',
            lastItemLogScan: null,
            processedItemLogIds: [],
            processedItemScans: [],
            itemScannerSchemaVersion: 0
        };
        const decoded = decodeStoredValue(value, {});
        const out = decoded && typeof decoded === 'object' && !Array.isArray(decoded)
            ? { ...defaults, ...decoded }
            : defaults;

        out.processedItemLogIds = Array.isArray(out.processedItemLogIds)
            ? out.processedItemLogIds.map(String).slice(-1000)
            : [];
        out.itemScannerSchemaVersion = Number(out.itemScannerSchemaVersion || 0);
        out.processedItemScans = Array.isArray(out.processedItemScans)
            ? out.processedItemScans.slice(-500)
            : [];

        return out;
    }

    function normalizeCollection(value, name) {
        const decoded = decodeStoredValue(value, []);

        if (Array.isArray(decoded)) return decoded;

        // Some PDA storage layers turn arrays into {0:{...},1:{...}} objects.
        if (decoded && typeof decoded === 'object') {
            const entries = Object.entries(decoded);
            if (entries.length && entries.every(([k]) => /^\d+$/.test(k))) {
                console.warn(`[HJI Manager] Recovered ${name} from indexed-object storage.`);
                return entries
                    .sort((a,b) => Number(a[0]) - Number(b[0]))
                    .map(([,v]) => v);
            }
        }

        if (decoded !== undefined && decoded !== null && decoded !== '') {
            console.warn(`[HJI Manager] Invalid ${name} value was reset safely.`, decoded);
        }
        return [];
    }

    function normalizeSettings(value) {
        const defaults = {
            providerId: '',
            providerName: '',
            apiKey: '',
            dueSoonDays: 3,
            claimPollMinutes: 10,
            lastMailScan: null
        };
        const decoded = decodeStoredValue(value, {});
        return decoded && typeof decoded === 'object' && !Array.isArray(decoded)
            ? { ...defaults, ...decoded }
            : defaults;
    }

    let state = {
        tiers: normalizeCollection(storage.get('tiers', defaultTiers), 'tiers'),
        customers: normalizeCollection(storage.get('customers', []), 'customers'),
        policies: normalizeCollection(storage.get('policies', []), 'policies'),
        payments: normalizeCollection(storage.get('payments', []), 'payments'),
        claims: normalizeCollection(storage.get('claims', []), 'claims'),
        settings: normalizeSettings(storage.get('settings', {}))
    };

    if (!state.tiers.length) state.tiers = defaultTiers;

    // Rewrite startup state into the stable JSON-text format immediately.
    try {
        storage.set('tiers', state.tiers);
        storage.set('customers', state.customers);
        storage.set('policies', state.policies);
        storage.set('payments', state.payments);
        storage.set('claims', state.claims);
        storage.set('settings', state.settings);
    } catch (e) {
        console.warn('[HJI Manager] Startup normalization could not be persisted.', e);
    }

    // A truly empty/invalid tier store should still receive the built-in starter tiers.
    if (!state.tiers.length) state.tiers = defaultTiers;

    // Persist the normalized representation immediately so a PDA-specific storage
    // shape cannot break the next page load.
    function persistNormalizedState() {
        try {
            storage.set('tiers', state.tiers);
            storage.set('customers', state.customers);
            storage.set('policies', state.policies);
            storage.set('payments', state.payments);
            storage.set('claims', state.claims);
            storage.set('settings', state.settings);
        } catch (e) {
            console.warn('[HJI Manager] Could not persist normalized startup state.', e);
        }
    }
    persistNormalizedState();

    function saveAll() {
        state.tiers = normalizeCollection(state.tiers, 'tiers');
        state.customers = normalizeCollection(state.customers, 'customers');
        state.policies = normalizeCollection(state.policies, 'policies');
        state.payments = normalizeCollection(state.payments, 'payments');
        state.claims = normalizeCollection(state.claims, 'claims');
        state.settings = normalizeSettings(state.settings);

        storage.set('tiers', state.tiers);
        storage.set('customers', state.customers);
        storage.set('policies', state.policies);
        storage.set('payments', state.payments);
        storage.set('claims', state.claims);
        storage.set('settings', state.settings);
    }

    function injectStyles() {
        if (document.getElementById('hji-manager-style')) return;
        const s = document.createElement('style');
        s.id = 'hji-manager-style';
        s.textContent = `
        :root{--hji-bg:#202020;--hji-panel:#2b2b2b;--hji-border:#4a4a4a;--hji-text:#e8e8e8;--hji-input:#181818}
        #hji-launcher{position:fixed;left:16px;bottom:18px;z-index:999999;background:linear-gradient(#4a4a4a,#303030);color:#fff;border:1px solid #666;border-radius:5px;padding:9px 13px;font:600 13px Arial,sans-serif;box-shadow:0 2px 8px #0009;cursor:grab;user-select:none;touch-action:none}
        #hji-launcher:active{cursor:grabbing}
        #hji-overlay{position:fixed;inset:0;z-index:1000000;background:transparent;pointer-events:none}
        #hji-app{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(980px,92vw);height:min(700px,82vh);min-width:320px;min-height:320px;max-width:98vw;max-height:94vh;background:var(--hji-bg);color:var(--hji-text);border:1px solid #555;border-radius:7px;overflow:hidden;font:14px Arial,sans-serif;display:flex;flex-direction:column;box-shadow:0 12px 35px #000c;pointer-events:auto;resize:both}
        #hji-app.hji-compact{width:min(760px,88vw);height:min(560px,72vh)}
        .hji-head{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 12px;background:linear-gradient(#3b3b3b,#292929);border-bottom:1px solid #555;cursor:move;user-select:none;touch-action:none}
        .hji-head h2{margin:0;color:#f5f5f5;font-size:18px}.hji-head-actions{display:flex;gap:6px}.hji-close,.hji-size{background:#444;color:#f5f5f5;border:1px solid #666;border-radius:4px;padding:6px 9px;cursor:pointer}
        .hji-tabs{display:flex;gap:3px;overflow:auto;padding:7px;background:#252525;border-bottom:1px solid #444}.hji-tab{white-space:nowrap;background:#333;color:#ddd;border:1px solid #505050;border-radius:4px;padding:7px 10px;cursor:pointer}.hji-tab.active{background:#555;color:#fff;border-color:#777}
        .hji-body{padding:12px;overflow:auto;flex:1;background:var(--hji-bg);color:var(--hji-text)}.hji-grid{display:grid;grid-template-columns:repeat(4,minmax(140px,1fr));gap:10px}
        .hji-card{background:var(--hji-panel);border:1px solid var(--hji-border);border-radius:5px;padding:11px;margin-bottom:10px;color:var(--hji-text)}.hji-card strong,.hji-card b{color:#fff}.hji-card b{display:block;font-size:18px;margin-top:5px}
        .hji-toolbar{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:10px}.hji-btn{background:linear-gradient(#4a4a4a,#333);color:#f5f5f5!important;border:1px solid #606060;border-radius:4px;padding:7px 10px;cursor:pointer}.hji-btn.good{background:linear-gradient(#4f7e5e,#365942);border-color:#618e6c}.hji-btn.danger{background:linear-gradient(#8f4343,#683030);border-color:#a95656}
        .hji-table-wrap{overflow:auto;max-width:100%;border:1px solid #414141;border-radius:5px}.hji-table{width:100%;border-collapse:collapse;background:#282828;color:var(--hji-text)}.hji-table th,.hji-table td{padding:9px 8px;text-align:center;vertical-align:middle;color:var(--hji-text)}
        .hji-table thead tr{border-bottom:2px solid #666}
        .hji-table tbody tr{border-bottom:1px solid #555}
        .hji-table tbody tr:last-child{border-bottom:0}
        .hji-table td .hji-toolbar{justify-content:center}.hji-table th{background:#383838;color:#fff;position:sticky;top:0;text-align:center}.hji-table a{color:#7fb5dc!important}
        .hji-policy-row-active{background:#243329}.hji-policy-row-due{background:#403823}.hji-policy-row-expired{background:#422828}.hji-policy-row-cancelled{background:#303030;opacity:.72}.hji-policy-row-used{background:#30343a;opacity:.82}
        .hji-status{font-weight:700}.hji-active{color:#75d28d!important}.hji-due{color:#f0c866!important}.hji-expired{color:#f18181!important}.hji-cancelled{color:#aaa!important}
        .hji-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.hji-form label{display:flex;flex-direction:column;gap:5px;color:#ddd;font-weight:600}.hji-form .wide{grid-column:1/-1}
        .hji-form input,.hji-form select,.hji-form textarea,.hji-modal input,.hji-modal select,.hji-modal textarea{box-sizing:border-box;width:100%;background:var(--hji-input)!important;color:#f2f2f2!important;border:1px solid #5a5a5a;border-radius:4px;padding:8px;-webkit-text-fill-color:#f2f2f2!important;caret-color:#fff}.hji-form textarea{min-height:80px}.hji-form input::placeholder,.hji-form textarea::placeholder{color:#8e8e8e!important;-webkit-text-fill-color:#8e8e8e!important}.hji-form select option,.hji-modal select option{background:#222;color:#f2f2f2}
        .hji-modal-bg{position:absolute;inset:0;background:#000b;display:flex;align-items:center;justify-content:center;padding:12px;z-index:5}.hji-modal{width:min(620px,94%);max-height:88%;overflow:auto;background:#292929;color:var(--hji-text);border:1px solid #666;border-radius:6px;padding:14px}.hji-modal h3{margin-top:0;color:#fff}.hji-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
        .hji-muted{color:#aaa!important;font-size:12px}.hji-pill{display:inline-block;padding:3px 7px;border-radius:999px;background:#444;color:#ddd}.hji-help{background:#252d33;border:1px solid #465966;border-radius:5px;padding:10px;margin:8px 0 12px;color:#e1e1e1}.hji-help strong{color:#fff}.hji-help p{margin:5px 0}.hji-help details{margin-top:6px}.hji-help summary{cursor:pointer;font-weight:700;color:#dceaf3}.hji-info{display:inline-flex;align-items:center;justify-content:center;width:17px;height:17px;border-radius:50%;background:#59636d;color:#fff;font-size:11px;font-weight:bold;cursor:help;margin-left:4px}
        .hji-resize-grip{position:absolute;right:0;bottom:0;width:30px;height:30px;z-index:20;cursor:nwse-resize;touch-action:none}.hji-resize-grip:after{content:'↘';position:absolute;right:5px;bottom:3px;color:#bbb;font-size:18px}
        @media(max-width:700px){#hji-launcher{left:9px;bottom:10px;padding:8px 11px}#hji-app{width:92vw;height:76vh;max-height:84vh;min-height:300px}#hji-app.hji-compact{width:86vw;height:66vh}.hji-grid{grid-template-columns:repeat(2,1fr)}.hji-form{grid-template-columns:1fr}.hji-form .wide{grid-column:auto}.hji-table{font-size:12px}.hji-table th,.hji-table td{padding:6px}.hji-head h2{font-size:15px}}
        `;
        document.head.appendChild(s);
    }

    function policyStatus(p) {
        if (p.status === 'cancelled') return ['Cancelled','hji-cancelled'];
        if (p.type === 'single') return p.used ? ['Used','hji-muted'] : ['Active','hji-active'];
        if (!p.endDate) return ['Active','hji-active'];
        const end = new Date(p.endDate).getTime();
        const diff = end - Date.now();
        if (diff < 0) return ['Expired','hji-expired'];
        if (diff <= Number(state.settings.dueSoonDays || 3) * 86400000) return ['Due soon','hji-due'];
        return ['Active','hji-active'];
    }

    function policyRowClass(p) {
        const [label] = policyStatus(p);
        if (label === 'Active') return 'hji-policy-row-active';
        if (label === 'Due soon') return 'hji-policy-row-due';
        if (label === 'Expired') return 'hji-policy-row-expired';
        if (label === 'Cancelled') return 'hji-policy-row-cancelled';
        if (label === 'Paid out') return 'hji-policy-row-used';
        if (label === 'Used') return 'hji-policy-row-used';
        return '';
    }

    function renewalBaseDate(policy) {
        const currentEnd = policy.endDate ? new Date(policy.endDate).getTime() : 0;
        return new Date(Math.max(Date.now(), currentEnd));
    }

    function renewPolicyModal(policy) {
        const tier = getTier(policy.tierId);
        const customer = getCustomer(policy.customerId);
        if (!tier || tier.type !== 'monthly') return alert('Only monthly/time-based policies can be renewed.');

        const modal = createModal('Renew policy');
        const days = Number(tier.durationDays || 30);
        const baseDate = renewalBaseDate(policy);
        const proposedEnd = new Date(baseDate.getTime() + days * 86400000);

        modal.content.innerHTML += `
          <div class="hji-help">
            <strong>Monthly renewal</strong>
            <p>This extends the existing policy instead of creating another policy every month.</p>
            <p>Active policies extend from their current expiry. Expired policies renew from today.</p>
          </div>
          <div class="hji-card">
            <p><b>Customer:</b> ${esc(customer?.name || 'Unknown')} [${esc(customer?.tornId || '')}]</p>
            <p><b>Tier:</b> ${esc(tier.name)}</p>
            <p><b>Current expiry:</b> ${dateOnly(policy.endDate)}</p>
            <p><b>New expiry:</b> ${dateOnly(proposedEnd.toISOString())}</p>
          </div>
          <div class="hji-form">
            <label>Renewal length (days)<input id="renew-days" inputmode="numeric" value="${days}"></label>
            <label>Payment method<select id="renew-method"><option value="cash">Cash</option><option value="item" ${tier.itemName ? '' : 'disabled'}>Item${tier.itemName ? ` (${esc(tier.itemName)})` : ''}</option></select></label>
            <label>Cash amount<input id="renew-cash" inputmode="decimal" value="${formatMoneyInput(tier.cashPrice || 0)}"></label>
            <label>Item quantity<input id="renew-itemqty" inputmode="numeric" value="${Number(tier.itemQty || 0)}"></label>
            <label class="wide">Renewal note<textarea id="renew-note" placeholder="Optional note"></textarea></label>
          </div>`;

        modal.el.querySelector('[data-save]').textContent = 'Renew policy';
        bindMoneyInput(modal.el.querySelector('#renew-cash'));
        modal.addSave(() => {
            const renewalDays = Math.max(1, Number(modal.el.querySelector('#renew-days').value || days));
            const start = renewalBaseDate(policy);
            const newEnd = new Date(start.getTime() + renewalDays * 86400000);
            const method = modal.el.querySelector('#renew-method').value;
            const note = modal.el.querySelector('#renew-note').value.trim();

            policy.endDate = newEnd.toISOString();
            policy.status = 'active';
            policy.renewals = Array.isArray(policy.renewals) ? policy.renewals : [];
            policy.renewals.push({
                id: uid('renewal'),
                renewedAt: nowISO(),
                fromDate: start.toISOString(),
                toDate: newEnd.toISOString(),
                days: renewalDays,
                method,
                amount: method === 'cash' ? parseMoneyInput(modal.el.querySelector('#renew-cash').value) : 0,
                itemName: method === 'item' ? (tier.itemName || '') : '',
                itemQty: method === 'item' ? Number(modal.el.querySelector('#renew-itemqty').value || 0) : 0,
                note
            });

            state.payments.push({
                id: uid('payment'),
                customerId: policy.customerId,
                policyId: policy.id,
                date: nowISO(),
                method,
                amount: method === 'cash' ? parseMoneyInput(modal.el.querySelector('#renew-cash').value) : 0,
                itemName: method === 'item' ? (tier.itemName || '') : '',
                itemQty: method === 'item' ? Number(modal.el.querySelector('#renew-itemqty').value || 0) : 0,
                notes: `Policy renewal: ${tier.name}${note ? ` — ${note}` : ''}`,
                createdAt: nowISO()
            });

            saveAll();
            modal.close();
            renderTab();
        });
    }


    function getCustomer(id) { return state.customers.find(x => x.id === id); }
    function getTier(id) { return state.tiers.find(x => x.id === id); }
    function getPolicy(id) { return state.policies.find(x => x.id === id); }

    let currentTab = 'dashboard';
    let overlay = null;

    function openApp(tab='dashboard') {
        injectStyles();
        currentTab = tab;
        try {
            if (overlay) overlay.remove();
            overlay = document.createElement('div');
            overlay.id = 'hji-overlay';
            overlay.innerHTML = `<div id="hji-app">
              <div class="hji-head">
                <div><h2>🛡️ Happy Jump Insurance Manager</h2><div class="hji-muted">v${esc(VERSION)} · drag this header · resize from the lower-right corner</div></div>
                <div class="hji-head-actions"><button class="hji-size" title="Toggle a smaller window">Size</button><button class="hji-close">Close</button></div>
              </div>
              <div class="hji-tabs"></div><div class="hji-body"></div><div class="hji-resize-grip" title="Drag to resize"></div>
            </div>`;
            document.body.appendChild(overlay);
            const app = overlay.querySelector('#hji-app');
            overlay.querySelector('.hji-close').onclick = () => { overlay.remove(); overlay=null; };
            overlay.querySelector('.hji-size').onclick = () => {
                const compact = app.dataset.compact !== 'true';
                app.dataset.compact = compact ? 'true' : 'false';
                app.classList.toggle('hji-compact', compact);

                const width = compact
                    ? Math.min(window.innerWidth * 0.88, 760)
                    : Math.min(window.innerWidth * 0.92, 980);
                const height = compact
                    ? Math.min(window.innerHeight * 0.72, 560)
                    : Math.min(window.innerHeight * 0.82, 700);

                app.style.width = `${Math.max(320, width)}px`;
                app.style.height = `${Math.max(320, height)}px`;

                const r = app.getBoundingClientRect();
                storage.set('windowSize', {
                    width: Math.round(r.width),
                    height: Math.round(r.height)
                });
                storage.set('windowCompact', compact);
            };
            makeDraggable(app, overlay.querySelector('.hji-head'), 'windowPos');
            makeResizable(app, overlay.querySelector('.hji-resize-grip'), 'windowSize');

            if (storage.get('windowCompact', false) === true) {
                app.dataset.compact = 'true';
                app.classList.add('hji-compact');
                app.style.width = `${Math.max(320, Math.min(window.innerWidth * 0.88, 760))}px`;
                app.style.height = `${Math.max(320, Math.min(window.innerHeight * 0.72, 560))}px`;
            }

            renderTabs();
            renderTab();
        } catch (e) {
            console.error('[HJI Manager] UI render error:', e);
            const body = overlay?.querySelector('.hji-body');
            if (body) body.innerHTML = `<div class="hji-help"><strong>HJI UI error</strong><p>${esc(e?.message || e)}</p><p>Close and reopen the manager. If this repeats, copy the browser console error.</p></div>`;
        }
    }

    function renderTabs() {
        const tabs = [
            ['dashboard','Dashboard'],['customers','Customers'],['policies','Policies'],
            ['payments','Payments'],['claims','Claims'],['tiers','Tiers'],['settings','Settings']
        ];
        const el = overlay.querySelector('.hji-tabs');
        el.innerHTML = tabs.map(([id,label]) => `<button class="hji-tab ${id===currentTab?'active':''}" data-tab="${id}">${label}${id==='claims' ? ` (${normalizeCollection(state.claims, 'claims').filter(c=>c?.status==='submitted').length})` : ''}</button>`).join('');
        el.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { currentTab=b.dataset.tab; renderTabs(); renderTab(); });
    }

    function renderTab() {
        const body = overlay?.querySelector('.hji-body');
        if (!body) return;

        try {
            const renderer = ({
                dashboard:renderDashboard,
                customers:renderCustomers,
                policies:renderPolicies,
                payments:renderPayments,
                claims:renderClaims,
                tiers:renderTiers,
                settings:renderSettings
            }[currentTab] || renderDashboard);

            renderer(body);

            if (!body.innerHTML.trim()) {
                body.innerHTML = `<div class="hji-help"><strong>No content rendered</strong><p>The ${esc(currentTab)} section returned no content.</p></div>`;
            }
        } catch (e) {
            console.error('[HJI Manager] Tab render error:', e);
            body.innerHTML = `<div class="hji-help" style="background:#452b2b;border-color:#7b4848"><strong>HJI Manager render error</strong><p>${esc(e?.message || e)}</p></div>`;
        }
    }

    function itemPaymentTotals() {
        const totals = new Map();

        for (const p of normalizeCollection(state.payments, 'payments')) {
            if (p?.method !== 'item') continue;

            const name = String(p.itemName || '').trim() || 'Unnamed item';
            const qty = Number(p.itemQty || 0);

            totals.set(name, (totals.get(name) || 0) + qty);
        }

        return [...totals.entries()]
            .map(([name, qty]) => ({name, qty}))
            .sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name));
    }

    function itemPaymentSummaryHtml() {
        const items = itemPaymentTotals();

        if (!items.length) {
            return '<div class="hji-muted">No item payments recorded yet.</div>';
        }

        return items.map(item =>
            `<div class="hji-field" style="margin-bottom:6px"><strong>${esc(item.qty)}x ${esc(item.name)}</strong></div>`
        ).join('');
    }


    function normalizeItemName(value) {
        return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    }

    function getLogArray(data) {
        if (!data || typeof data !== 'object') return [];

        if (Array.isArray(data.log)) return data.log;

        if (data.log && typeof data.log === 'object') {
            return Object.entries(data.log).map(([id, entry]) => ({
                ...(entry && typeof entry === 'object' ? entry : {}),
                id: entry?.id ?? id
            }));
        }

        return [];
    }

    function deepEntries(obj, path='') {
        const out=[];
        if (!obj || typeof obj !== 'object') return out;

        if (Array.isArray(obj)) {
            obj.forEach((v,i)=>out.push(...deepEntries(v, `${path}[${i}]`)));
            return out;
        }

        for (const [k,v] of Object.entries(obj)) {
            const p = path ? `${path}.${k}` : k;
            out.push([p,k,v]);
            if (v && typeof v === 'object') out.push(...deepEntries(v,p));
        }
        return out;
    }

    function candidateString(entries, keyPattern) {
        for (const [,key,value] of entries) {
            if (!keyPattern.test(String(key))) continue;
            if (typeof value === 'string' && value.trim()) return value.trim();
            if (typeof value === 'number' && Number.isFinite(value)) return String(value);
        }
        return '';
    }

    function candidateNumber(entries, keyPattern) {
        for (const [,key,value] of entries) {
            if (!keyPattern.test(String(key))) continue;
            const n = Number(value);
            if (Number.isFinite(n)) return n;
        }
        return 0;
    }

    function parseIncomingItemLogs(log) {
        if (!log || typeof log !== 'object') return [];

        const logType = Number(log.log || 0);
        const title = String(log.title ?? log.details?.title ?? '').trim();
        const category = String(log.category ?? log.details?.category ?? '').trim();
        const data = log.data && typeof log.data === 'object' ? log.data : {};

        // This scanner is deliberately for Torn's direct Item receive log.
        if (logType && logType !== ITEM_RECEIVE_LOG_ID) return [];
        if (title && !/^item receive$/i.test(title) && !/sent .* to you/i.test(title)) {
            return [];
        }

        const senderId = String(
            data.sender?.id ??
            data.sender ??
            data.sender_id ??
            data.from?.id ??
            data.from ??
            ''
        ).trim();

        let senderName = String(
            data.sender?.name ??
            data.sender_name ??
            data.from?.name ??
            ''
        ).trim();

        const transferMessage = String(
            data.message ??
            log.message ??
            ''
        ).trim();

        if (senderId && String(senderId) === String(state.settings.providerId || '')) {
            return [];
        }

        const items = data.items && typeof data.items === 'object'
            ? data.items
            : {};

        const receipts = [];

        for (const [rawItemId, rawValue] of Object.entries(items)) {
            let quantity = 0;

            if (Array.isArray(rawValue)) {
                // Historical 4103 shape: { "261": [68, 0] }
                quantity = Number(rawValue[0] || 0);
            } else if (rawValue && typeof rawValue === 'object') {
                quantity = Number(
                    rawValue.quantity ??
                    rawValue.qty ??
                    rawValue.amount ??
                    rawValue.count ??
                    0
                );
            } else {
                // Current/common shape: { "175": 1 }
                quantity = Number(rawValue || 0);
            }

            if (!Number.isFinite(quantity) || quantity <= 0) continue;

            receipts.push({
                logId:String(log.id ?? ''),
                timestamp:Number(log.timestamp || 0),
                title:title || 'Item receive',
                category:category || 'Item sending',
                itemId:String(rawItemId || ''),
                itemName:'',
                quantity,
                senderId,
                senderName,
                transferMessage,
                raw:log
            });
        }

        // Fallback for unusual/legacy shapes where items was not an object map.
        if (!receipts.length) {
            const entries = deepEntries({data, params:log.params});
            const itemId = candidateString(entries, /^(item_id|itemid)$/i);
            const itemName = candidateString(entries, /^(item_name|itemname)$/i);
            const quantity = candidateNumber(entries, /^(quantity|qty|item_quantity|amount|count)$/i);
            const fallbackSenderId = senderId || candidateString(entries, /^(sender_id|senderid|from_id|fromid|player_id|user_id)$/i);
            const fallbackSenderName = senderName || candidateString(entries, /^(sender_name|sendername|from_name|fromname|player_name|username)$/i);

            if ((itemId || itemName) && quantity > 0 && (fallbackSenderId || fallbackSenderName)) {
                receipts.push({
                    logId:String(log.id ?? ''),
                    timestamp:Number(log.timestamp || 0),
                    title:title || 'Item receive',
                    category:category || 'Item sending',
                    itemId:String(itemId || ''),
                    itemName:String(itemName || ''),
                    quantity:Number(quantity),
                    senderId:String(fallbackSenderId || ''),
                    senderName:String(fallbackSenderName || ''),
                    transferMessage,
                    raw:log
                });
            }
        }

        return receipts;
    }

    function extractItemIdentity(data, wantedId='') {
        if (!data || typeof data !== 'object') return null;
        const wanted = String(wantedId || '');

        const candidates = [];

        const walk = obj => {
            if (!obj || typeof obj !== 'object') return;

            if (Array.isArray(obj)) {
                obj.forEach(walk);
                return;
            }

            const id = obj.id ?? obj.ID ?? obj.item_id ?? obj.itemId;
            const name = obj.name ?? obj.item_name ?? obj.itemName;

            if (id != null && name) {
                candidates.push({id:String(id), name:String(name)});
            }

            for (const [key,value] of Object.entries(obj)) {
                // Some Torn item responses are keyed by the item ID.
                if (value && typeof value === 'object' && value.name) {
                    candidates.push({
                        id:String(value.id ?? value.ID ?? key),
                        name:String(value.name)
                    });
                }
                walk(value);
            }
        };

        walk(data);

        return candidates.find(x => wanted && x.id === wanted) ||
               candidates[0] ||
               null;
    }

    async function resolveReceiptItem(receipt) {
        if (receipt.itemName || !receipt.itemId) return receipt;

        // First use configured tiers. This avoids an extra API request when the
        // provider has supplied the optional Torn Item ID in Tier settings.
        const configured = state.tiers.find(t =>
            String(t.itemId || '').trim() === String(receipt.itemId)
        );

        if (configured?.itemName) {
            receipt.itemName = configured.itemName;
            return receipt;
        }

        // Otherwise resolve the item ID through Torn's item endpoint.
        try {
            const data = await requestApi(
                `${API_BASE}/torn/${encodeURIComponent(receipt.itemId)}/items`,
                state.settings.apiKey
            );
            const found = extractItemIdentity(data, receipt.itemId);
            if (found?.name) receipt.itemName = found.name;
        } catch (e) {
            console.warn(`[HJI Manager] Could not resolve item ${receipt.itemId}.`, e);
        }

        return receipt;
    }

    function activeTierPaymentItems() {
        const items = [];
        const seen = new Set();

        for (const tier of normalizeCollection(state.tiers, 'tiers')) {
            if (!tier || tier.active === false || Number(tier.itemQty || 0) <= 0) continue;

            const itemId = String(tier.itemId || '').trim();
            const itemName = String(tier.itemName || '').trim();

            if (!itemId && !itemName) continue;

            const key = itemId
                ? `id:${itemId}`
                : `name:${normalizeItemName(itemName)}`;

            if (seen.has(key)) continue;
            seen.add(key);

            items.push({
                itemId,
                itemName,
                tierId:tier.id,
                tierName:tier.name
            });
        }

        return items;
    }

    function receiptMatchesConfiguredItem(receipt) {
        const configured = activeTierPaymentItems();
        if (!configured.length) return false;

        const receiptId = String(receipt?.itemId || '').trim();
        const receiptName = normalizeItemName(receipt?.itemName || '');

        return configured.some(item => {
            if (item.itemId && receiptId) {
                return String(item.itemId) === receiptId;
            }

            return Boolean(
                item.itemName &&
                receiptName &&
                normalizeItemName(item.itemName) === receiptName
            );
        });
    }

    function itemScanFilterSummaryHtml() {
        const items = activeTierPaymentItems();

        if (!items.length) {
            return '<span class="hji-expired">No active tier payment items configured</span>';
        }

        return items.map(item => {
            const label = item.itemName || `Item ID ${item.itemId}`;
            const id = item.itemId ? ` [ID ${item.itemId}]` : '';
            return `<span class="hji-pill">${esc(label)}${esc(id)}</span>`;
        }).join(' ');
    }

    function tierMatchesReceipt(tier, receipt) {
        if (!tier || tier.active === false || Number(tier.itemQty || 0) <= 0) return false;

        const tierId = String(tier.itemId || '').trim();
        const receiptId = String(receipt.itemId || '').trim();

        let itemMatches = false;

        if (tierId && receiptId) {
            itemMatches = tierId === receiptId;
        } else {
            const tierName = normalizeItemName(tier.itemName);
            const receiptName = normalizeItemName(receipt.itemName);
            itemMatches = Boolean(tierName && receiptName && tierName === receiptName);
        }

        if (!itemMatches) return false;

        const receiptQty = Number(receipt.quantity || 0);

        // Preferred: exact structured quantity match.
        if (receiptQty > 0) {
            return Number(tier.itemQty || 0) === receiptQty;
        }

        // Torn's visible log text sometimes says "sent some Xanax" without putting
        // the amount in the title. If quantity is missing from API data, only allow
        // a match when this is the sole active tier using this exact item.
        const sameItemTiers = state.tiers.filter(t => {
            if (!t || t.active === false || Number(t.itemQty || 0) <= 0) return false;

            const tId = String(t.itemId || '').trim();
            if (tierId && receiptId && tId) return tId === receiptId;

            return normalizeItemName(t.itemName) === normalizeItemName(receipt.itemName);
        });

        return sameItemTiers.length === 1 && sameItemTiers[0].id === tier.id;
    }

    async function resolveReceiptSender(receipt) {
        if (receipt.senderName || !/^\d+$/.test(receipt.senderId)) return receipt;

        try {
            const data = await requestApi(
                `${API_BASE}/user/${encodeURIComponent(receipt.senderId)}/basic`,
                state.settings.apiKey
            );
            const identity = extractProfileIdentity(data);
            if (identity?.name) receipt.senderName=identity.name;
        } catch (e) {
            console.warn(`[HJI Manager] Could not resolve sender ${receipt.senderId}.`, e);
        }

        return receipt;
    }

    function paymentForSourceLog(logId) {
        const id=String(logId || '');
        return state.payments.find(p => String(p?.sourceLogId || '') === id) || null;
    }

    function policyForPayment(payment) {
        if (!payment?.policyId) return null;
        return getPolicy(payment.policyId);
    }

    function customerForPayment(payment) {
        if (!payment?.customerId) return null;
        return getCustomer(payment.customerId);
    }

    function backfillLegacyProcessedScanRecords() {
        const processedIds = Array.isArray(state.settings.processedItemLogIds)
            ? state.settings.processedItemLogIds.map(String)
            : [];

        const auditIds = new Set(
            (state.settings.processedItemScans || []).map(r => String(r?.logId || ''))
        );

        let created = 0;
        let unresolved = 0;

        for (const logId of processedIds) {
            if (!logId || auditIds.has(logId)) continue;

            const payment = paymentForSourceLog(logId);

            if (payment) {
                const policy = policyForPayment(payment);
                const customer = customerForPayment(payment);

                state.settings.processedItemScans.push({
                    logId,
                    timestamp: payment.date ? Math.floor(new Date(payment.date).getTime()/1000) : 0,
                    senderId: String(customer?.tornId || ''),
                    senderName: String(customer?.name || ''),
                    itemId: String(payment.itemId || ''),
                    itemName: String(payment.itemName || ''),
                    quantity: Number(payment.itemQty || 0),
                    transferMessage: '',
                    action: 'created',
                    tierId: String(policy?.tierId || ''),
                    tierName: String(getTier(policy?.tierId)?.name || policy?.tierName || ''),
                    customerId: String(payment.customerId || ''),
                    policyId: String(payment.policyId || ''),
                    paymentId: String(payment.id || ''),
                    processedAt: payment.createdAt || nowISO(),
                    reopened: false,
                    migratedLegacy: true
                });

                auditIds.add(logId);
                created++;
            } else {
                // Old scanner marked this ID processed, but there is no linked payment
                // proving it was actually handled. Remove it from the skip list so the
                // new scanner can offer it again during the recovery window.
                state.settings.processedItemLogIds =
                    state.settings.processedItemLogIds
                        .map(String)
                        .filter(id => id !== logId);

                unresolved++;
            }
        }

        state.settings.processedItemScans =
            (state.settings.processedItemScans || []).slice(-500);

        if (created || unresolved) saveAll();

        return {created, unresolved};
    }

    function processedScanRecord(logId) {
        return (state.settings.processedItemScans || [])
            .find(r => String(r.logId || '') === String(logId || ''));
    }

    function saveProcessedScanRecord(receipt, action, extra={}) {
        state.settings.processedItemScans = Array.isArray(state.settings.processedItemScans)
            ? state.settings.processedItemScans
            : [];

        const record = {
            logId:String(receipt?.logId || ''),
            timestamp:Number(receipt?.timestamp || 0),
            senderId:String(receipt?.senderId || ''),
            senderName:String(receipt?.senderName || ''),
            itemId:String(receipt?.itemId || ''),
            itemName:String(receipt?.itemName || ''),
            quantity:Number(receipt?.quantity || 0),
            transferMessage:String(receipt?.transferMessage || ''),
            action:String(action || ''),
            tierId:String(extra.tierId || ''),
            tierName:String(extra.tierName || ''),
            customerId:String(extra.customerId || ''),
            policyId:String(extra.policyId || ''),
            paymentId:String(extra.paymentId || ''),
            processedAt:nowISO(),
            reopened:Boolean(extra.reopened || false)
        };

        const idx = state.settings.processedItemScans.findIndex(
            r => String(r.logId || '') === record.logId
        );

        if (idx >= 0) {
            state.settings.processedItemScans[idx] = {
                ...state.settings.processedItemScans[idx],
                ...record
            };
        } else {
            state.settings.processedItemScans.push(record);
        }

        state.settings.processedItemScans = state.settings.processedItemScans.slice(-500);
        saveAll();
    }

    function unprocessItemLog(logId) {
        const id=String(logId || '');
        state.settings.processedItemLogIds =
            (state.settings.processedItemLogIds || []).map(String).filter(x => x !== id);
        saveAll();
    }

    function receiptFromProcessedRecord(record) {
        return {
            logId:String(record.logId || ''),
            timestamp:Number(record.timestamp || 0),
            senderId:String(record.senderId || ''),
            senderName:String(record.senderName || ''),
            itemId:String(record.itemId || ''),
            itemName:String(record.itemName || ''),
            quantity:Number(record.quantity || 0),
            transferMessage:String(record.transferMessage || ''),
            title:'Recovered processed Item receive',
            raw:null
        };
    }

    function markItemLogProcessed(logId) {
        if (!logId) return;
        const ids = Array.isArray(state.settings.processedItemLogIds)
            ? state.settings.processedItemLogIds.map(String)
            : [];

        if (!ids.includes(String(logId))) ids.push(String(logId));
        state.settings.processedItemLogIds = ids.slice(-1000);
        saveAll();
    }

    function createPolicyFromItemReceipt(receipt, tier) {
        if (!receipt || !tier) {
            throw new Error('Receipt or insurance tier is missing.');
        }

        const senderId = String(receipt.senderId || '').trim();
        const senderName = String(receipt.senderName || '').trim();

        if (!senderId && !senderName) {
            throw new Error('Could not identify who sent the item.');
        }

        // 1) Find or create the customer.
        let customer = senderId
            ? state.customers.find(c => String(c.tornId || '') === senderId)
            : state.customers.find(c =>
                String(c.name || '').trim().toLowerCase() === senderName.toLowerCase()
              );

        let customerCreated = false;

        if (!customer) {
            customer = {
                id:uid('customer'),
                tornId:senderId,
                name:senderName || `Torn user ${senderId}`.trim(),
                notes:'Added automatically from an incoming insurance item payment.',
                createdAt:nowISO()
            };

            state.customers.push(customer);
            customerCreated = true;
        } else {
            // Fill missing customer details if log/API resolution gave us more info.
            if (!customer.tornId && senderId) customer.tornId = senderId;
            if ((!customer.name || /^Torn user\b/i.test(customer.name)) && senderName) {
                customer.name = senderName;
            }
        }

        // 2) Build the policy.
        const start = receipt.timestamp
            ? new Date(receipt.timestamp * 1000)
            : new Date();

        if (Number.isNaN(start.getTime())) {
            throw new Error('The incoming item log has an invalid timestamp.');
        }

        const policy = {
            id:uid('policy'),
            customerId:customer.id,
            tierId:tier.id,
            tierName:tier.name,
            type:tier.type,
            startDate:start.toISOString(),
            endDate:tier.type==='monthly'
                ? new Date(
                    start.getTime() +
                    Number(tier.durationDays || 30) * 86400000
                  ).toISOString()
                : null,
            status:'active',
            used:false,
            createdAt:nowISO(),
            sourceItemLogId:String(receipt.logId || '')
        };

        state.policies.push(policy);

        // 3) Record and link the item payment.
        const paidQty = Number(receipt.quantity || tier.itemQty || 0);

        const payment = {
            id:uid('payment'),
            customerId:customer.id,
            policyId:policy.id,
            date:start.toISOString(),
            method:'item',
            amount:0,
            itemId:String(receipt.itemId || tier.itemId || ''),
            itemName:String(receipt.itemName || tier.itemName || 'Item'),
            itemQty:paidQty,
            notes:`Detected from Torn Item receive log${receipt.logId ? ` ${receipt.logId}` : ''}${receipt.transferMessage ? ` — ${receipt.transferMessage}` : ''}.`,
            sourceLogId:String(receipt.logId || ''),
            createdAt:nowISO()
        };

        state.payments.push(payment);

        // 4) Only mark the log processed after every local record exists.
        markItemLogProcessed(receipt.logId);
        saveAll();

        return {
            customer,
            policy,
            payment,
            customerCreated
        };
    }

    function itemReceiptModal(receipt, matches, onDone) {
        const modal=createModal('Incoming item payment detected');

        const existingCustomer = state.customers.find(c =>
            receipt.senderId && String(c.tornId)===String(receipt.senderId)
        );

        modal.content.innerHTML += `
          <div class="hji-help">
            <strong>Possible insurance payment</strong>
            <p>HJI found an incoming item transfer that matches ${matches.length ? 'one or more configured tiers' : 'no tier exactly yet'}.</p>
            <p>Nothing will be created until you confirm it.</p>
          </div>

          <div class="hji-card">
            <p><b>From:</b> ${esc(receipt.senderName || 'Unknown')} ${receipt.senderId ? `[${esc(receipt.senderId)}]` : ''}</p>
            <p><b>Item:</b> ${receipt.quantity ? `${esc(receipt.quantity)} × ` : ''}${esc(receipt.itemName || 'Item')} ${receipt.itemId ? `[ID ${esc(receipt.itemId)}]` : ''}</p>
            <p><b>Log:</b> ${esc(receipt.title || 'Item receive')} ${receipt.logId ? `[${esc(receipt.logId)}]` : ''}</p>
            ${receipt.transferMessage ? `<p><b>Message:</b> ${esc(receipt.transferMessage)}</p>` : ''}
            <p><b>Customer:</b> ${existingCustomer ? 'Already exists' : 'New customer'}</p>
          </div>

          <div class="hji-form">
            <label class="wide">Insurance tier
              <select id="receipt-tier">
                ${matches.length
                    ? matches.map(t=>`<option value="${t.id}">${esc(t.name)} · ${esc(t.type==='monthly'?'Monthly':'Single jump')}</option>`).join('')
                    : `<option value="">No exact tier match</option>`}
              </select>
            </label>
          </div>`;

        modal.actions.innerHTML = `
          <button class="hji-btn" id="receipt-later">Later</button>
          <button class="hji-btn danger" id="receipt-ignore">Ignore this transfer</button>
          <button class="hji-btn good" id="receipt-create" ${matches.length?'':'disabled'}>${existingCustomer?'Create policy':'Add customer + policy'}</button>`;

        modal.el.querySelector('#receipt-later').onclick=()=>{
            saveProcessedScanRecord(receipt,'later');
            modal.close();
            onDone?.();
        };

        modal.el.querySelector('#receipt-ignore').onclick=()=>{
            markItemLogProcessed(receipt.logId);
            saveProcessedScanRecord(receipt,'ignored');
            modal.close();
            onDone?.();
        };

        modal.el.querySelector('#receipt-create').onclick=()=>{
            const createBtn=modal.el.querySelector('#receipt-create');
            const tier=getTier(modal.el.querySelector('#receipt-tier').value);

            if(!tier){
                alert('Choose a matching insurance tier first.');
                return;
            }

            createBtn.disabled=true;
            createBtn.textContent='Creating…';

            try{
                const created=createPolicyFromItemReceipt(receipt,tier);

                saveProcessedScanRecord(receipt,'created',{
                    tierId:tier.id,
                    tierName:tier.name,
                    customerId:created.customer.id,
                    policyId:created.policy.id,
                    paymentId:created.payment.id,
                    reopened:Boolean(processedScanRecord(receipt.logId))
                });

                modal.close();

                alert(
                    `${created.customerCreated ? 'Customer added and policy created.' : 'Policy created.'}\n\n` +
                    `${created.customer.name} [${created.customer.tornId || 'ID unavailable'}]\n` +
                    `${tier.name}\n` +
                    `${created.payment.itemQty}x ${created.payment.itemName}\n\n` +
                    `The payment is recorded and linked to the new policy.`
                );

                renderDashboard(overlay.querySelector('.hji-body'));
                onDone?.();

            }catch(e){
                console.error('[HJI Manager] Could not create policy from item receipt:',e);
                createBtn.disabled=false;
                createBtn.textContent=receipt.senderId || receipt.senderName
                    ? 'Add customer + policy'
                    : 'Create policy';

                alert(
                    `Could not create the customer/policy.\n\n${e.message}\n\n` +
                    `The item log has not been marked as processed, so you can try again.`
                );
            }
        };
    }

    function processedItemScanLogModal() {
        const migration=backfillLegacyProcessedScanRecords();
        const modal=createModal('Processed Item Scan Log');

        const records=[...(state.settings.processedItemScans || [])]
            .sort((a,b)=>(b.timestamp||0)-(a.timestamp||0));

        modal.content.innerHTML += `
          <div class="hji-help">
            <strong>Item scan history</strong>
            <p>This records item transfers you previously reviewed. If you accidentally ignored a valid payment, use <b>Reopen</b> to process it again.</p>
            ${migration.created || migration.unresolved ? `<p><b>Legacy migration:</b> ${migration.created} old processed transfer${migration.created===1?'':'s'} restored to the audit log · ${migration.unresolved} unresolved transfer${migration.unresolved===1?'':'s'} reopened for scanning.</p>` : ''}
          </div>

          <div class="hji-table-wrap"><table class="hji-table">
            <thead><tr><th>Date</th><th>Sender</th><th>Item</th><th>Message</th><th>Action</th><th></th></tr></thead>
            <tbody>
              ${records.map((r,i)=>`
                <tr>
                  <td>${r.timestamp ? new Date(r.timestamp*1000).toLocaleString('en-GB') : '—'}</td>
                  <td>${esc(r.senderName||'Unknown')} ${r.senderId?`[${esc(r.senderId)}]`:''}</td>
                  <td>${esc(r.quantity||0)}x ${esc(r.itemName||`Item ${r.itemId||''}`)}</td>
                  <td>${esc(r.transferMessage||'')}</td>
                  <td>${esc(r.action||'')}</td>
                  <td>
                    ${r.action==='created'
                        ? `<span class="hji-muted">Created</span>`
                        : `<button class="hji-btn" data-reopen-scan="${i}">Reopen</button>`}
                  </td>
                </tr>`).join('') || '<tr><td colspan="6">No processed item scans recorded yet.</td></tr>'}
            </tbody>
          </table></div>`;

        modal.actions.innerHTML='<button class="hji-btn" data-close>Close</button>';
        modal.el.querySelector('[data-close]').onclick=modal.close;

        modal.el.querySelectorAll('[data-reopen-scan]').forEach(btn=>{
            btn.onclick=async()=>{
                const record=records[Number(btn.dataset.reopenScan)];
                if(!record)return;

                const receipt=receiptFromProcessedRecord(record);

                // Re-open ignored items without losing their audit history.
                unprocessItemLog(receipt.logId);

                await resolveReceiptItem(receipt);
                await resolveReceiptSender(receipt);

                const matches=state.tiers.filter(t=>tierMatchesReceipt(t,receipt));

                modal.close();
                itemReceiptModal(receipt,matches,()=>{
                    renderDashboard(overlay.querySelector('.hji-body'));
                });
            };
        });
    }

    function unixNow() {
        return Math.floor(Date.now() / 1000);
    }

    function lastSuccessfulItemScanUnix() {
        const value = state.settings.lastItemLogScan;
        if (!value) return 0;

        const ms = new Date(value).getTime();
        return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
    }

    function itemScanWindow(forceLookbackDays=0) {
        const now = unixNow();

        if (forceLookbackDays > 0) {
            return {
                from: now - (Number(forceLookbackDays) * 24 * 60 * 60),
                to: now,
                firstRun: false,
                recovery: true,
                reason: `Manual ${forceLookbackDays}-day rescan`
            };
        }

        const last = lastSuccessfulItemScanUnix();
        const scannerVersion = Number(state.settings.itemScannerSchemaVersion || 0);

        // Earlier scanner builds could advance the saved checkpoint even while the
        // 4103 parser was not correctly reading Torn's response. On the first scan
        // after this fixed scanner is installed, deliberately backfill seven days.
        if (scannerVersion < ITEM_SCANNER_SCHEMA_VERSION) {
            return {
                from: now - ITEM_SCAN_FIRST_LOOKBACK_SECONDS,
                to: now,
                firstRun: false,
                recovery: true,
                reason: 'Automatic 3-day scanner recovery backfill'
            };
        }

        if (!last) {
            return {
                from: now - ITEM_SCAN_FIRST_LOOKBACK_SECONDS,
                to: now,
                firstRun: true,
                recovery: false,
                reason: 'First scan'
            };
        }

        return {
            from: Math.max(0, last - ITEM_SCAN_OVERLAP_SECONDS),
            to: now,
            firstRun: false,
            recovery: false,
            reason: 'Since last successful scan'
        };
    }

    async function fetchItemReceiveLogs(fromUnix, toUnix) {
        const all = [];
        const seen = new Set();
        let cursorTo = Number(toUnix);
        let page = 0;

        while (cursorTo >= fromUnix && page < 50) {
            page++;

            const url =
                `${API_BASE}/user/log` +
                `?log=${ITEM_RECEIVE_LOG_ID}` +
                `&from=${encodeURIComponent(fromUnix)}` +
                `&to=${encodeURIComponent(cursorTo)}` +
                `&limit=${ITEM_SCAN_PAGE_LIMIT}`;

            const data = await requestApi(url, state.settings.apiKey);

            if (data?.error) {
                throw new Error(
                    data.error.error ||
                    data.error.message ||
                    JSON.stringify(data.error)
                );
            }

            const batch = getLogArray(data)
                .filter(log => Number(log?.log ?? ITEM_RECEIVE_LOG_ID) === ITEM_RECEIVE_LOG_ID)
                .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));

            if (!batch.length) break;

            for (const log of batch) {
                const id = String(log?.id ?? '');
                const key = id || `${log?.timestamp || ''}:${JSON.stringify(log?.data || {})}`;

                if (seen.has(key)) continue;
                seen.add(key);
                all.push(log);
            }

            const oldest = Math.min(
                ...batch
                    .map(log => Number(log?.timestamp || 0))
                    .filter(ts => Number.isFinite(ts) && ts > 0)
            );

            if (!Number.isFinite(oldest)) break;
            if (oldest <= fromUnix) break;
            if (batch.length < ITEM_SCAN_PAGE_LIMIT) break;

            // Walk backwards one second so the next page cannot repeat the same boundary.
            cursorTo = oldest - 1;
        }

        return all.filter(log => {
            const ts = Number(log?.timestamp || 0);
            return ts >= fromUnix && ts <= toUnix;
        });
    }

    function formatScanWindow(fromUnix, toUnix) {
        const from = new Date(fromUnix * 1000).toLocaleString('en-GB');
        const to = new Date(toUnix * 1000).toLocaleString('en-GB');
        return `${from} → ${to}`;
    }

    async function scanItemPayments(forceLookbackDays=0) {
        const key=String(state.settings.apiKey || '').trim();
        if(!key) return alert('Add the Manager API key in Settings first.');

        const btn=overlay?.querySelector('#hji-scan-items');
        if(btn){
            btn.disabled=true;
            btn.textContent='Scanning item receipts…';
        }

        const legacyMigration=backfillLegacyProcessedScanRecords();
        const windowInfo=itemScanWindow(forceLookbackDays);

        if(!activeTierPaymentItems().length){
            if(btn){
                btn.disabled=false;
                btn.textContent='↻ Scan item payments';
            }
            return alert(
                'No active tier payment items are configured.\n\n' +
                'Add an Alternative item (and preferably its Torn Item ID) to at least one active tier before scanning.'
            );
        }

        try {
            // Query Torn's dedicated direct-item receipt log type (Item receive 4103)
            // for the complete time window, paging if more than 100 receipts exist.
            const logs=await fetchItemReceiveLogs(windowInfo.from, windowInfo.to);

            const processed=new Set(
                (state.settings.processedItemLogIds || []).map(String)
            );

            const candidates=logs
                .filter(log=>!processed.has(String(log?.id ?? '')))
                .flatMap(parseIncomingItemLogs)
                .filter(Boolean)
                .sort((a,b)=>b.timestamp-a.timestamp);

            // Only advance the checkpoint after the entire Torn API window was
            // successfully retrieved. Next scan overlaps by five minutes.
            state.settings.lastItemLogScan=
                new Date(windowInfo.to * 1000).toISOString();
            state.settings.itemScannerSchemaVersion = ITEM_SCANNER_SCHEMA_VERSION;
            saveAll();

            if(!candidates.length){
                alert(
                    `Item receipt scan complete.\n\n` +
                    `${logs.length} Item receive log${logs.length===1?'':'s'} checked\n` +
                    `0 matching tier-payment candidates found\n\n` +
                    `Window: ${formatScanWindow(windowInfo.from, windowInfo.to)}
` +
                    `Mode: ${windowInfo.reason}
` +
                    `Legacy audit migration: ${legacyMigration.created} restored · ${legacyMigration.unresolved} reopened`
                );
                renderDashboard(overlay.querySelector('.hji-body'));
                return;
            }

            const queue=[...candidates];

            const showNext=async()=>{
                const receipt=queue.shift();

                if(!receipt){
                    renderDashboard(overlay.querySelector('.hji-body'));
                    return;
                }

                await resolveReceiptItem(receipt);

                // Only consider items currently configured as valid payment items
                // on active insurance tiers. Unrelated gifts/transfers are ignored.
                if(!receiptMatchesConfiguredItem(receipt)){
                    showNext();
                    return;
                }

                await resolveReceiptSender(receipt);

                const matches=state.tiers.filter(t=>tierMatchesReceipt(t,receipt));

                // Item matches a configured payment item, but quantity may not match
                // any tier exactly. Keep the confirmation dialog so the provider can
                // review ambiguous cases rather than silently losing a payment.
                itemReceiptModal(receipt,matches,showNext);
            };

            showNext();

        } catch(e) {
            alert(
                `Could not scan item-payment logs.\n\n${e.message}\n\n` +
                `HJI scans Torn's Item receive log (4103). ` +
                `The saved last-scan checkpoint is not advanced when a scan fails.`
            );
        } finally {
            if(btn){
                btn.disabled=false;
                btn.textContent='↻ Scan item payments';
            }
        }
    }

    function claimPayoutCashTotal() {
        return normalizeCollection(state.claims, 'claims')
            .filter(c => c?.status === 'paid' && c?.payoutMethod === 'cash')
            .reduce((sum, c) => sum + Number(c.payoutAmount || 0), 0);
    }

    function claimPayoutItemTotals() {
        const totals = new Map();

        for (const c of normalizeCollection(state.claims, 'claims')) {
            if (c?.status !== 'paid' || c?.payoutMethod !== 'item') continue;
            const name = String(c.payoutItemName || '').trim() || 'Unnamed item';
            const qty = Number(c.payoutItemQty || 0);
            totals.set(name, (totals.get(name) || 0) + qty);
        }

        return [...totals.entries()]
            .map(([name, qty]) => ({name, qty}))
            .sort((a,b) => b.qty-a.qty || a.name.localeCompare(b.name));
    }

    function claimPayoutItemSummaryHtml() {
        const items=claimPayoutItemTotals();
        if(!items.length) return '<div class="hji-muted">No item claim payouts recorded yet.</div>';

        return items.map(item =>
            `<div class="hji-field" style="margin-bottom:6px"><strong>${esc(item.qty)}x ${esc(item.name)}</strong></div>`
        ).join('');
    }

    function itemNetSummaryHtml() {
        const totals=new Map();

        for(const p of normalizeCollection(state.payments,'payments')){
            if(p?.method!=='item')continue;
            const name=String(p.itemName||'').trim()||'Unnamed item';
            const row=totals.get(name)||{name,received:0,paidOut:0};
            row.received+=Number(p.itemQty||0);
            totals.set(name,row);
        }

        for(const c of normalizeCollection(state.claims,'claims')){
            if(c?.status!=='paid'||c?.payoutMethod!=='item')continue;
            const name=String(c.payoutItemName||'').trim()||'Unnamed item';
            const row=totals.get(name)||{name,received:0,paidOut:0};
            row.paidOut+=Number(c.payoutItemQty||0);
            totals.set(name,row);
        }

        const items=[...totals.values()]
            .map(row=>({...row,net:row.received-row.paidOut}))
            .sort((a,b)=>Math.abs(b.net)-Math.abs(a.net)||a.name.localeCompare(b.name));

        if(!items.length) return '<div class="hji-muted">No item income or payouts recorded yet.</div>';

        return items.map(item=>{
            const sign=item.net>0?'+':'';
            return `<div class="hji-field" style="margin-bottom:6px">
              <strong>${esc(item.name)}: ${sign}${esc(item.net)}</strong>
              <div class="hji-muted">${esc(item.received)} received · ${esc(item.paidOut)} paid out</div>
            </div>`;
        }).join('');
    }

    function renderDashboard(body) {
        backfillLegacyProcessedScanRecords();

        const activePolicies = state.policies.filter(p=>policyStatus(p)[0]==='Active').length;
        const dueSoon = state.policies.filter(p=>policyStatus(p)[0]==='Due soon').length;
        const openClaims = state.claims.filter(c=>!['rejected','closed','paid'].includes(c.status)).length;

        const cashReceived = state.payments
            .filter(p=>p.method==='cash')
            .reduce((sum,p)=>sum+Number(p.amount||0),0);

        const cashPaidOut = claimPayoutCashTotal();
        const netCash = cashReceived - cashPaidOut;

        const itemTotals = itemPaymentTotals();
        const totalItemUnits = itemTotals.reduce((sum,item)=>sum+Number(item.qty||0),0);

        const payoutItemTotals = claimPayoutItemTotals();
        const totalPayoutItemUnits = payoutItemTotals.reduce((sum,item)=>sum+Number(item.qty||0),0);

        const lastItemScan = state.settings.lastItemLogScan
            ? new Date(state.settings.lastItemLogScan).toLocaleString('en-GB')
            : 'Never';

        body.innerHTML=`
          <div class="hji-toolbar">
            <button class="hji-btn good" id="hji-scan-items">↻ Scan item payments</button>
            <button class="hji-btn" id="hji-rescan-items-3d">↺ Rescan last 3 days</button>
            <button class="hji-btn" id="hji-scan-log">Processed scan log (${(state.settings.processedItemScans||[]).length})</button>
          </div>

          <div class="hji-help">
            <strong>Incoming item-payment scan</strong>
            <p>Checks Torn's <b>Item receive</b> log (4103) for direct item transfers that match your configured tier item ID/name and quantity. You confirm every match before HJI creates a customer, policy or payment.</p>
            <p>First scan looks back <b>3 days</b>. Later scans start from the <b>last successful check</b> with a 5-minute overlap, and HJI remembers processed log IDs to prevent duplicates.</p>
            <p><b>Rescan last 3 days</b> is a recovery tool for older transfers that were missed by a previous scanner version. Already processed log IDs are still ignored, so it will not duplicate accepted payments.</p>
            <p><b>Watching for:</b> ${itemScanFilterSummaryHtml()}</p>
            <p class="hji-muted">Only incoming items configured on active tiers are considered possible insurance payments. Other incoming items are ignored.</p>
            <p><b>Last successful item scan:</b> ${esc(lastItemScan)}</p>
          </div>

          <div class="hji-grid">
            <div class="hji-card">Customers<b>${state.customers.length}</b></div>
            <div class="hji-card">Active policies<b>${activePolicies}</b></div>
            <div class="hji-card">Due soon<b>${dueSoon}</b></div>
            <div class="hji-card">Open claims<b>${openClaims}</b></div>
          </div>

          <div class="hji-help">
            <strong>Financial overview</strong>
            <p>Figures below are <b>all-time</b> from the locally recorded Manager data.</p>
            <p>Cash profit/loss can be calculated directly. Items are shown separately by item because HJI does not assume an in-game cash value for them.</p>
          </div>

          <div class="hji-grid" style="margin-top:10px">
            <div class="hji-card">
              <strong>Cash received <span class="hji-muted">(all-time)</span></strong>
              <b>$${money(cashReceived)}</b>
              <div class="hji-muted">${state.payments.filter(p=>p.method==='cash').length} cash payment${state.payments.filter(p=>p.method==='cash').length===1?'':'s'}</div>
            </div>

            <div class="hji-card">
              <strong>Cash claim payouts <span class="hji-muted">(all-time)</span></strong>
              <b>$${money(cashPaidOut)}</b>
            </div>

            <div class="hji-card">
              <strong>Net cash <span class="hji-muted">(all-time)</span></strong>
              <b class="${netCash>0?'hji-active':netCash<0?'hji-expired':'hji-due'}">${netCash<0?'−':''}$${money(Math.abs(netCash))}</b>
              <div class="hji-muted">${netCash>0?'Profit':netCash<0?'Loss':'Break even'}</div>
            </div>

            <div class="hji-card">
              <strong>Item payments received <span class="hji-muted">(all-time)</span></strong>
              <b>${totalItemUnits}</b>
              <div class="hji-muted">${state.payments.filter(p=>p.method==='item').length} item payment${state.payments.filter(p=>p.method==='item').length===1?'':'s'}</div>
            </div>

            <div class="hji-card">
              <strong>Item claim payouts <span class="hji-muted">(all-time)</span></strong>
              <b>${totalPayoutItemUnits}</b>
            </div>
          </div>

          <div class="hji-grid" style="margin-top:10px">
            <div class="hji-card">
              <strong>Item income breakdown <span class="hji-muted">(all-time)</span></strong>
              <div style="margin-top:8px">${itemPaymentSummaryHtml()}</div>
            </div>

            <div class="hji-card">
              <strong>Item payout breakdown <span class="hji-muted">(all-time)</span></strong>
              <div style="margin-top:8px">${claimPayoutItemSummaryHtml()}</div>
            </div>

            <div class="hji-card">
              <strong>Net item position <span class="hji-muted">(all-time)</span></strong>
              <div style="margin-top:8px">${itemNetSummaryHtml()}</div>
            </div>
          </div>

          <div class="hji-card">
            <strong>Provider</strong>
            <p>${esc(state.settings.providerName||'Not configured')} ${state.settings.providerId?`[${esc(state.settings.providerId)}]`:''}</p>
            <div class="hji-muted">Configure this in Settings. Client setup codes use this identity.</div>
          </div>

          <div class="hji-card">
            <strong>Quick notes</strong>
            <p>Use Policies for cover status and renewals, Payments for cash/item income, and Claims for payout handling and Torn Mail sync.</p>
          </div>`;

        body.querySelector('#hji-scan-items').onclick=()=>scanItemPayments();
        body.querySelector('#hji-rescan-items-3d').onclick=()=>{
            if(!confirm('Rescan the last 3 days of Torn Item receive logs?\n\nAlready processed transfers will be ignored.')) return;
            scanItemPayments(3);
        };
        body.querySelector('#hji-scan-log').onclick=processedItemScanLogModal;
    }

    function renderCustomers(body) {
        body.innerHTML = `<div class="hji-toolbar"><button class="hji-btn good" id="hji-add-customer">+ Add customer</button></div>
        <table class="hji-table"><thead><tr><th>Player</th><th>Torn ID</th><th>Policies</th><th>Notes</th><th></th></tr></thead><tbody>
        ${state.customers.map(c=>`<tr><td>${esc(c.name)}</td><td><a href="https://www.torn.com/profiles.php?XID=${encodeURIComponent(c.tornId)}" target="_blank">${esc(c.tornId)}</a></td><td>${state.policies.filter(p=>p.customerId===c.id).length}</td><td>${esc(c.notes||'')}</td><td><button class="hji-btn" data-edit-customer="${c.id}">Edit</button></td></tr>`).join('') || '<tr><td colspan="5">No customers yet.</td></tr>'}
        </tbody></table>`;
        body.querySelector('#hji-add-customer').onclick = () => customerModal();
        body.querySelectorAll('[data-edit-customer]').forEach(b=>b.onclick=()=>customerModal(getCustomer(b.dataset.editCustomer)));
    }

    function customerModal(existing=null) {
        const modal = createModal(existing?'Edit customer':'Add customer');
        modal.content.innerHTML += `<div class="hji-form">
            <label>Name<input id="hc-name" value="${esc(existing?.name||'')}"></label>
            <label>Torn user ID<input id="hc-id" inputmode="numeric" value="${esc(existing?.tornId||'')}"></label>
            <label class="wide">Notes<textarea id="hc-notes">${esc(existing?.notes||'')}</textarea></label>
        </div>`;
        if (existing) modal.actions.insertAdjacentHTML('afterbegin','<button class="hji-btn danger" id="hc-delete">Delete</button>');
        modal.addSave(() => {
            const name = modal.el.querySelector('#hc-name').value.trim();
            const tornId = modal.el.querySelector('#hc-id').value.trim();
            if (!name || !/^\d+$/.test(tornId)) return alert('Enter a name and numeric Torn user ID.');
            if (existing) Object.assign(existing,{name,tornId,notes:modal.el.querySelector('#hc-notes').value.trim()});
            else state.customers.push({id:uid('customer'),name,tornId,notes:modal.el.querySelector('#hc-notes').value.trim(),createdAt:nowISO()});
            saveAll(); modal.close(); renderTab();
        });
        if (existing) modal.el.querySelector('#hc-delete').onclick=()=>{
            if (!confirm('Delete this customer? Existing policies will remain but lose their customer record.')) return;
            state.customers=state.customers.filter(x=>x.id!==existing.id); saveAll(); modal.close(); renderTab();
        };
    }


    function policySyncStatus(policy) {
        const [label] = policyStatus(policy);
        return ({
            'Active':'active',
            'Due soon':'active',
            'Expired':'expired',
            'Cancelled':'cancelled',
            'Used':'used',
            'Paid out':'paid_out'
        })[label] || String(policy.status || 'active');
    }

    function buildPolicyStatusMail(policy) {
        const customer = getCustomer(policy.customerId);
        const tier = getTier(policy.tierId);
        if (!customer) throw new Error('Policy customer is missing.');

        const status = policySyncStatus(policy);
        const subject = `${POLICY_PREFIX} ${policy.id} ${status.toUpperCase()}`;
        const body = [
            POLICY_PREFIX,
            `Policy ID: ${policy.id}`,
            `Status: ${status}`,
            `Customer: ${customer.name} [${customer.tornId}]`,
            `Provider: ${state.settings.providerName || ''} [${state.settings.providerId || ''}]`,
            `Tier: ${tier?.name || policy.tierName || ''}`,
            policy.endDate ? `Valid Until: ${policy.endDate}` : '',
            policy.payoutClaimReference ? `Payout Claim: ${policy.payoutClaimReference}` : '',
            '',
            'Sync this update in the Happy Jump Insurance Client.',
            `HJI Manager v${VERSION}`
        ].filter(Boolean).join('\n');

        return {subject, body, customer};
    }

    async function preparePolicyStatusMail(policy) {
        if (!policy) return;

        let mail;
        try { mail = buildPolicyStatusMail(policy); }
        catch (e) { alert(e.message); return; }

        managerMailFillInProgress = false;
        storage.set('pendingStatusMail', null);

        await copyText(`${mail.subject}\n\n${mail.body}`);

        storage.set('pendingStatusMail', {
            claimantId: String(mail.customer.tornId || ''),
            subject: mail.subject,
            body: mail.body,
            createdAt: Date.now()
        });

        try {
            await openFreshTornMailComposer(mail.customer.tornId);
            setTimeout(tryFillManagerStatusMail, 900);
        } catch (e) {
            storage.set('pendingStatusMail', null);
            alert(`Could not open Torn Mail.\n\n${e.message}\n\nThe policy update has been copied to your clipboard.`);
        }
    }

    function renderPolicies(body) {
        body.innerHTML = `
        <div class="hji-toolbar"><button class="hji-btn good" id="hji-add-policy">+ Add policy</button></div>
        <div class="hji-help">
          <strong>Policy lifecycle</strong>
          <p>Monthly/time-based cover stays as one policy. Use <b>Renew</b> to extend it and record the renewal payment. A single-jump policy automatically becomes <b>Paid out</b> when its linked claim is marked Paid.</p>
          <p><span class="hji-active">Green = active</span> · <span class="hji-due">Amber = due soon</span> · <span class="hji-expired">Red = expired</span> · Grey = cancelled/used/paid out.</p><p>After changing a policy, use <b>Notify</b> to send a structured Torn Mail update that the Client can sync.</p>
        </div>
        <div class="hji-table-wrap"><table class="hji-table"><thead><tr><th>Customer</th><th>Tier</th><th>Started</th><th>Ends / Use</th><th>Status</th><th></th></tr></thead><tbody>
        ${state.policies.map(p=>{
            const c=getCustomer(p.customerId),t=getTier(p.tierId),st=policyStatus(p);
            const canRenew=t?.type==='monthly' && p.status!=='cancelled';
            return `<tr class="${policyRowClass(p)}">
              <td>${esc(c?.name||'Unknown')}</td>
              <td>${esc(t?.name||p.tierName||'Unknown')}</td>
              <td>${dateOnly(p.startDate)}</td>
              <td>${p.type==='single'?(p.used?'Used':'Not used'):dateOnly(p.endDate)}</td>
              <td class="hji-status ${st[1]}">${st[0]}</td>
              <td><div class="hji-toolbar" style="margin:0">
                ${canRenew?`<button class="hji-btn good" data-renew-policy="${p.id}">Renew</button>`:''}
                <button class="hji-btn" data-setup-policy="${p.id}">Client setup</button>
                <button class="hji-btn" data-notify-policy="${p.id}">Notify</button>
                <button class="hji-btn" data-edit-policy="${p.id}">Edit</button>
              </div></td>
            </tr>`;
        }).join('') || '<tr><td colspan="6">No policies yet.</td></tr>'}
        </tbody></table></div>`;

        body.querySelector('#hji-add-policy').onclick=()=>policyModal();
        body.querySelectorAll('[data-edit-policy]').forEach(b=>b.onclick=()=>policyModal(getPolicy(b.dataset.editPolicy)));
        body.querySelectorAll('[data-setup-policy]').forEach(b=>b.onclick=()=>setupCodeModal(getPolicy(b.dataset.setupPolicy)));
        body.querySelectorAll('[data-notify-policy]').forEach(b=>b.onclick=()=>preparePolicyStatusMail(getPolicy(b.dataset.notifyPolicy)));
        body.querySelectorAll('[data-renew-policy]').forEach(b=>b.onclick=()=>renewPolicyModal(getPolicy(b.dataset.renewPolicy)));
    }

    function policyModal(existing=null) {
        if (!state.customers.length) return alert('Add a customer first.');
        if (!state.tiers.length) return alert('Create a tier first.');
        const modal=createModal(existing?'Edit policy':'Add policy');
        const start = existing?.startDate?.slice(0,10) || new Date().toISOString().slice(0,10);
        modal.content.innerHTML += `<div class="hji-form">
          <label>Customer<select id="hp-customer">${state.customers.map(c=>`<option value="${c.id}" ${existing?.customerId===c.id?'selected':''}>${esc(c.name)} [${esc(c.tornId)}]</option>`).join('')}</select></label>
          <label>Tier<select id="hp-tier">${state.tiers.filter(t=>t.active || t.id===existing?.tierId).map(t=>`<option value="${t.id}" ${existing?.tierId===t.id?'selected':''}>${esc(t.name)}</option>`).join('')}</select></label>
          <label>Start date<input type="date" id="hp-start" value="${start}"></label>
          <label>Status<select id="hp-status"><option value="active">Active</option><option value="cancelled" ${existing?.status==='cancelled'?'selected':''}>Cancelled</option></select></label>
          <label id="hp-used-wrap">Single jump used?<select id="hp-used"><option value="0">No</option><option value="1" ${existing?.used?'selected':''}>Yes</option></select></label>
          <label class="wide">Notes<textarea id="hp-notes">${esc(existing?.notes||'')}</textarea></label>
        </div>`;
        function updateUsed(){const t=getTier(modal.el.querySelector('#hp-tier').value);modal.el.querySelector('#hp-used-wrap').style.display=t?.type==='single'?'flex':'none';}
        modal.el.querySelector('#hp-tier').onchange=updateUsed; updateUsed();
        modal.addSave(()=>{
            const t=getTier(modal.el.querySelector('#hp-tier').value);
            const sd=new Date(modal.el.querySelector('#hp-start').value+'T00:00:00');
            const end=t.type==='monthly'?new Date(sd.getTime()+Number(t.durationDays||30)*86400000).toISOString():null;
            const data={customerId:modal.el.querySelector('#hp-customer').value,tierId:t.id,tierName:t.name,type:t.type,startDate:sd.toISOString(),endDate:end,status:modal.el.querySelector('#hp-status').value,used:modal.el.querySelector('#hp-used').value==='1',notes:modal.el.querySelector('#hp-notes').value.trim()};
            if(existing) Object.assign(existing,data); else state.policies.push({id:uid('policy'),...data,createdAt:nowISO()});
            saveAll();modal.close();renderTab();
        });
    }

    function renderPayments(body) {
        body.innerHTML=`
        <div class="hji-toolbar"><button class="hji-btn good" id="hji-add-payment">+ Record payment</button></div>
        <div class="hji-help">
          <strong>Payment linking</strong>
          <p>Payments can be linked to a specific policy. Renewal payments are linked automatically. Saved payments can be edited later if anything was entered incorrectly.</p>
        </div>
        <div class="hji-table-wrap"><table class="hji-table">
          <thead><tr><th>Date</th><th>Customer</th><th>Policy</th><th>Method</th><th>Amount</th><th>Notes</th><th></th></tr></thead>
          <tbody>
          ${[...state.payments].sort((a,b)=>new Date(b.date)-new Date(a.date)).map(p=>{
              const c=getCustomer(p.customerId);
              const pol=p.policyId ? getPolicy(p.policyId) : null;
              const tier=pol ? getTier(pol.tierId) : null;
              const policyLabel=pol ? `${tier?.name || pol.tierName || 'Policy'}${pol.endDate ? ` · ends ${dateOnly(pol.endDate)}` : ''}` : '—';
              return `<tr>
                <td>${dateOnly(p.date)}</td>
                <td>${esc(c?.name||'Unknown')}</td>
                <td>${esc(policyLabel)}</td>
                <td>${esc(p.method)}</td>
                <td>${p.method==='cash'?'$'+money(p.amount):`${esc(p.itemQty)} × ${esc(p.itemName)}`}</td>
                <td>${esc(p.notes||'')}</td>
                <td><button class="hji-btn" data-edit-payment="${p.id}">Edit</button></td>
              </tr>`;
          }).join('')||'<tr><td colspan="7">No payments recorded.</td></tr>'}
          </tbody>
        </table></div>`;

        body.querySelector('#hji-add-payment').onclick=()=>paymentModal();
        body.querySelectorAll('[data-edit-payment]').forEach(b=>{
            b.onclick=()=>paymentModal(state.payments.find(p=>p.id===b.dataset.editPayment));
        });
    }

    function paymentModal(existing=null){
        if(!state.customers.length)return alert('Add a customer first.');

        const modal=createModal(existing ? 'Edit payment' : 'Record payment');

        const paymentDate = existing?.date
            ? new Date(existing.date).toISOString().slice(0,10)
            : new Date().toISOString().slice(0,10);

        modal.content.innerHTML+=`<div class="hji-form">
          <label>Customer
            <select id="pay-c">
              ${state.customers.map(c=>`<option value="${c.id}" ${existing?.customerId===c.id?'selected':''}>${esc(c.name)} [${esc(c.tornId)}]</option>`).join('')}
            </select>
          </label>

          <label>Policy
            <select id="pay-policy"></select>
          </label>

          <label>Date
            <input type="date" id="pay-date" value="${paymentDate}">
          </label>

          <label>Method
            <select id="pay-method">
              <option value="cash" ${existing?.method==='cash' || !existing ? 'selected' : ''}>Cash</option>
              <option value="item" ${existing?.method==='item' ? 'selected' : ''}>Item</option>
            </select>
          </label>

          <label>Cash amount
            <input id="pay-amount" inputmode="decimal" value="${formatMoneyInput(existing?.amount||0)}">
          </label>

          <label>Item name
            <input id="pay-item" value="${esc(existing?.itemName||'')}">
          </label>

          <label>Item quantity
            <input id="pay-qty" inputmode="numeric" value="${Number(existing?.itemQty||0)}">
          </label>

          <label class="wide">Notes
            <textarea id="pay-notes">${esc(existing?.notes||'')}</textarea>
          </label>
        </div>`;

        const customerSelect=modal.el.querySelector('#pay-c');
        const policySelect=modal.el.querySelector('#pay-policy');
        const methodSelect=modal.el.querySelector('#pay-method');
        const amountInput=modal.el.querySelector('#pay-amount');
        const itemInput=modal.el.querySelector('#pay-item');
        const qtyInput=modal.el.querySelector('#pay-qty');
        bindMoneyInput(amountInput);

        function refreshPolicies(useExisting=true){
            const policies=state.policies.filter(p=>p.customerId===customerSelect.value);
            policySelect.innerHTML=
                `<option value="">No policy / general payment</option>`+
                policies.map(p=>{
                    const t=getTier(p.tierId);
                    const st=policyStatus(p)[0];
                    const suffix=p.type==='monthly'&&p.endDate?` · ends ${dateOnly(p.endDate)}`:'';
                    const selected = useExisting && existing?.policyId===p.id ? 'selected' : '';
                    return `<option value="${p.id}" ${selected}>${esc(t?.name||p.tierName||'Policy')} · ${esc(st)}${esc(suffix)}</option>`;
                }).join('');

            if (!existing || !useExisting) applyPolicyDefaults();
        }

        function applyPolicyDefaults(){
            const policy=policySelect.value?getPolicy(policySelect.value):null;
            if(!policy)return;
            const tier=getTier(policy.tierId);
            if(!tier)return;

            amountInput.value=formatMoneyInput(tier.cashPrice||0);
            itemInput.value=tier.itemName||'';
            qtyInput.value=Number(tier.itemQty||0);
        }

        function updateMethodVisibility(){
            const itemMode=methodSelect.value==='item';
            amountInput.closest('label').style.opacity=itemMode?'.55':'1';
            itemInput.closest('label').style.opacity=itemMode?'1':'.55';
            qtyInput.closest('label').style.opacity=itemMode?'1':'.55';
        }

        customerSelect.onchange=()=>refreshPolicies(false);
        policySelect.onchange=applyPolicyDefaults;
        methodSelect.onchange=updateMethodVisibility;

        refreshPolicies(true);
        updateMethodVisibility();

        if(existing){
            modal.actions.insertAdjacentHTML(
                'afterbegin',
                '<button class="hji-btn danger" id="pay-delete">Delete payment</button>'
            );

            modal.el.querySelector('#pay-delete').onclick=()=>{
                if(!confirm('Delete this payment record?'))return;
                state.payments=state.payments.filter(p=>p.id!==existing.id);
                saveAll();
                modal.close();
                renderTab();
            };
        }

        modal.el.querySelector('[data-save]').textContent = existing ? 'Save changes' : 'Save';

        modal.addSave(()=>{
            const data={
                customerId:customerSelect.value,
                policyId:policySelect.value||null,
                date:new Date(modal.el.querySelector('#pay-date').value+'T00:00:00').toISOString(),
                method:methodSelect.value,
                amount:parseMoneyInput(amountInput.value),
                itemName:itemInput.value.trim(),
                itemQty:Number(qtyInput.value||0),
                notes:modal.el.querySelector('#pay-notes').value.trim(),
                updatedAt:nowISO()
            };

            if(existing){
                Object.assign(existing,data);
            }else{
                state.payments.push({
                    id:uid('payment'),
                    ...data,
                    createdAt:nowISO()
                });
            }

            saveAll();
            modal.close();
            renderTab();
        });
    }


    function openClaimMail(c) {
        if (!c) return;

        if (c.mailMessageId) {
            // Torn may show a missing/deleted message page if the mail has already
            // been removed. The HJI claim itself remains safely stored locally.
            c.mailOpenAttemptedAt = nowISO();
            saveAll();
            window.location.href = `https://www.torn.com/messages.php#/p=read&ID=${encodeURIComponent(c.mailMessageId)}&suffix=inbox`;
            return;
        }

        alert(
            'Original Torn Mail is no longer available to HJI.\n\n' +
            'The claim itself is still stored safely in the HJI Manager.'
        );
    }

    function openClaimTrade(c) {
        const id = String(c?.claimantId || '').trim();
        if (!/^\d+$/.test(id)) return alert('This claim does not have a valid claimant Torn ID.');
        window.location.href = `https://www.torn.com/trade.php#step=start&userID=${encodeURIComponent(id)}`;
    }

    function claimStatusLabel(status) {
        return ({
            submitted: 'Submitted',
            reviewing: 'Reviewing',
            approved: 'Approved',
            rejected: 'Rejected',
            paid: 'Paid',
            closed: 'Closed'
        })[status] || String(status || 'Submitted');
    }

    function buildClaimStatusMail(c, status, note='') {
        const label = claimStatusLabel(status);
        const subject = `${STATUS_PREFIX} ${c.reference} ${status.toUpperCase()}`;
        const body = [
            STATUS_PREFIX,
            `Claim Reference: ${c.reference}`,
            `Status: ${label}`,
            `Claimant: ${c.claimantName || ''} [${c.claimantId || ''}]`,
            `Provider: ${state.settings.providerName || ''} [${state.settings.providerId || ''}]`,
            note ? `Provider Note: ${note}` : '',
            '',
            'You can sync this status in the Happy Jump Insurance Client.',
            `HJI Manager v${VERSION}`
        ].filter(Boolean).join('\n');

        return {subject, body};
    }

    let managerMailFillInProgress = false;

    function setManagerNativeValue(el, value) {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, value);
        else el.value = value;
        el.dispatchEvent(new Event('input', {bubbles:true}));
        el.dispatchEvent(new Event('change', {bubbles:true}));
    }

    function tryFillManagerStatusMail() {
        const p = storage.get('pendingStatusMail', null);
        if (!p || !location.href.includes('messages.php') || managerMailFillInProgress) return;

        if (Date.now() - Number(p.createdAt || 0) > 10 * 60 * 1000) {
            storage.set('pendingStatusMail', null);
            return;
        }

        managerMailFillInProgress = true;
        let tries = 0;

        const timer = setInterval(() => {
            tries++;

            const inputs = [...document.querySelectorAll('input')];
            const textareas = [...document.querySelectorAll('textarea')];

            const subject = inputs.find(x =>
                /subject/i.test(x.placeholder || '') ||
                /subject/i.test(x.name || '') ||
                /subject/i.test(x.getAttribute('aria-label') || '')
            );

            const body = textareas.find(x => x.offsetParent !== null) ||
                         document.querySelector('[contenteditable="true"]');

            let subjectReady = false;
            let bodyReady = false;

            if (subject) {
                if (!subject.value) setManagerNativeValue(subject, p.subject);
                subjectReady = String(subject.value || '').trim().length > 0;
            }

            if (body) {
                if (body.tagName === 'TEXTAREA') {
                    if (!body.value) setManagerNativeValue(body, p.body);
                    bodyReady = String(body.value || '').trim().length > 0;
                } else if (body.isContentEditable) {
                    if (!body.textContent) {
                        body.focus();
                        try { document.execCommand('insertText', false, p.body); } catch {}
                        body.dispatchEvent(new InputEvent('input', {
                            bubbles:true,
                            inputType:'insertText',
                            data:p.body
                        }));
                    }
                    bodyReady = String(body.textContent || '').trim().length > 0;
                }
            }

            if (subjectReady && bodyReady) {
                clearInterval(timer);
                managerMailFillInProgress = false;
                storage.set('pendingStatusMail', null);
                return;
            }

            if (tries >= 20) {
                clearInterval(timer);
                managerMailFillInProgress = false;
                storage.set('pendingStatusMail', null);
                alert('Torn Mail opened, but Torn/PDA did not allow the Manager to fill the composer automatically. The status update is on your clipboard ready to paste.');
            }
        }, 500);
    }

    async function openFreshTornMailComposer(claimantId) {
        const id=String(claimantId||'').trim();
        if(!/^\d+$/.test(id)) throw new Error('Claimant Torn ID is missing or invalid.');

        const composeHash=`#/p=compose&XID=${encodeURIComponent(id)}`;

        // Torn is a SPA. If Notify is used again while already in Messages,
        // assigning the same compose URL may not create a new composer.
        // Briefly route away first, then open a fresh compose route.
        if(location.pathname.includes('messages.php')){
            if(location.hash===composeHash || /#\/p=compose/i.test(location.hash)){
                location.hash='#/p=inbox';
                await new Promise(resolve=>setTimeout(resolve,250));
            }

            location.hash=composeHash;
            return;
        }

        window.location.href=`https://www.torn.com/messages.php${composeHash}`;
    }

    async function prepareClaimStatusMail(c, status=null, note=null) {
        if (!c) return;

        const chosenStatus = status || c.status || 'submitted';
        const chosenNote = note ?? c.providerNote ?? '';
        const mail = buildClaimStatusMail(c, chosenStatus, chosenNote);

        // Reset any previous PDA fill attempt before preparing the next notification.
        managerMailFillInProgress = false;
        storage.set('pendingStatusMail', null);

        // Clipboard remains a fallback, but opening the Torn composer is the primary path.
        await copyText(`${mail.subject}\n\n${mail.body}`);

        storage.set('pendingStatusMail', {
            claimantId: String(c.claimantId || ''),
            subject: mail.subject,
            body: mail.body,
            createdAt: Date.now()
        });

        try {
            await openFreshTornMailComposer(c.claimantId);
            setTimeout(tryFillManagerStatusMail, 900);
        } catch(e) {
            storage.set('pendingStatusMail', null);
            alert(`Could not open Torn Mail.\n\n${e.message}\n\nThe status update has been copied to your clipboard.`);
        }
    }

    function renderClaims(body) {
        body.innerHTML=`<div class="hji-toolbar">
          <button class="hji-btn good" id="hji-scan-mail">↻ Scan Torn Mail</button>
          <button class="hji-btn" id="hji-add-claim">+ Manual claim</button>
        </div>

        <div class="hji-help">
          <strong>Claim workflow</strong>
          <p>Use <b>Open Mail</b> to review the original Torn message, <b>Trade</b> to open a trade with the claimant for a payout, and <b>Notify</b> to prepare a structured status update for the Client.</p><p>Once a claim has been scanned, it is stored locally in HJI and the original Torn Mail can be deleted without removing the claim from the Manager.</p>
          <p>The Manager never presses Torn's Send button automatically.</p>
        </div>

        <div class="hji-muted" style="margin-bottom:8px">
          Last scan: ${state.settings.lastMailScan?new Date(state.settings.lastMailScan).toLocaleString('en-GB'):'Never'}.
        </div>

        <div class="hji-table-wrap"><table class="hji-table">
          <thead><tr><th>Reference</th><th>Claimant</th><th>Submitted</th><th>Tier / Policy</th><th>Status</th><th>Payout</th><th>Actions</th></tr></thead>
          <tbody>
          ${[...state.claims].sort((a,b)=>new Date(b.submittedAt)-new Date(a.submittedAt)).map(c=>`
            <tr>
              <td>${esc(c.reference)}</td>
              <td>${esc(c.claimantName||'')} [${esc(c.claimantId||'')}]</td>
              <td>${dateOnly(c.submittedAt)}</td>
              <td>${esc(c.tierName||'')}</td>
              <td class="hji-status ${c.status==='submitted'?'hji-pending':c.status==='approved'||c.status==='paid'?'hji-active':c.status==='rejected'?'hji-expired':''}">
                ${esc(claimStatusLabel(c.status))}
              </td>
              <td>${
                c.payoutMethod==='cash'
                    ? '$'+money(c.payoutAmount||0)
                    : c.payoutMethod==='item'
                        ? `${esc(c.payoutItemQty||0)}x ${esc(c.payoutItemName||'')}`
                        : '—'
              }</td>
              <td>
                <div class="hji-toolbar" style="margin:0">
                  <button class="hji-btn" data-view-claim="${c.id}">View</button>
                  <button class="hji-btn" data-mail-claim="${c.id}">Open Mail</button>
                  <button class="hji-btn good" data-trade-claim="${c.id}">Trade</button>
                  <button class="hji-btn" data-notify-claim="${c.id}">Notify</button>
                </div>
              </td>
            </tr>`).join('')||'<tr><td colspan="7">No claims yet.</td></tr>'}
          </tbody>
        </table></div>`;

        body.querySelector('#hji-scan-mail').onclick=scanMail;
        body.querySelector('#hji-add-claim').onclick=()=>manualClaimModal();

        body.querySelectorAll('[data-view-claim]').forEach(b=>
            b.onclick=()=>claimModal(state.claims.find(c=>c.id===b.dataset.viewClaim))
        );
        body.querySelectorAll('[data-mail-claim]').forEach(b=>
            b.onclick=()=>openClaimMail(state.claims.find(c=>c.id===b.dataset.mailClaim))
        );
        body.querySelectorAll('[data-trade-claim]').forEach(b=>
            b.onclick=()=>openClaimTrade(state.claims.find(c=>c.id===b.dataset.tradeClaim))
        );
        body.querySelectorAll('[data-notify-claim]').forEach(b=>
            b.onclick=()=>prepareClaimStatusMail(state.claims.find(c=>c.id===b.dataset.notifyClaim))
        );
    }

    function manualClaimModal(){
        const modal=createModal('Manual claim');
        modal.content.innerHTML+=`<div class="hji-form">
          <label>Claimant name<input id="cl-name"></label><label>Torn ID<input id="cl-id" inputmode="numeric"></label>
          <label>Reference<input id="cl-ref" value="HJI-${Date.now().toString(36).toUpperCase()}"></label><label>Tier / policy<input id="cl-tier"></label>
          <label class="wide">Details<textarea id="cl-details"></textarea></label>
        </div>`;
        modal.addSave(()=>{state.claims.push({id:uid('claim'),reference:modal.el.querySelector('#cl-ref').value.trim(),claimantName:modal.el.querySelector('#cl-name').value.trim(),claimantId:modal.el.querySelector('#cl-id').value.trim(),tierName:modal.el.querySelector('#cl-tier').value.trim(),details:modal.el.querySelector('#cl-details').value.trim(),status:'submitted',submittedAt:nowISO(),source:'manual'});saveAll();modal.close();renderTab();renderTabs();});
    }

    function applyClaimPayoutToPolicy(c) {
        if (!c || c.status !== 'paid' || !c.policyId) return false;

        const policy = getPolicy(c.policyId);
        if (!policy) return false;

        const tier = getTier(policy.tierId);
        const policyType = policy.type || tier?.type || '';

        // Monthly/time-based insurance survives individual payouts.
        if (policyType !== 'single') return false;

        policy.status = 'paid_out';
        policy.used = true;
        policy.paidOutAt = policy.paidOutAt || nowISO();
        policy.payoutClaimId = c.id || policy.payoutClaimId || '';
        policy.payoutClaimReference = c.reference || policy.payoutClaimReference || '';
        policy.updatedAt = nowISO();

        return true;
    }

    function claimModal(c){
        const modal=createModal(`Claim ${c.reference}`);

        modal.content.innerHTML+=`
        <div class="hji-card">
          <b style="font-size:14px">${esc(c.claimantName||'')} [${esc(c.claimantId||'')}]</b>
          <p><strong>Tier:</strong> ${esc(c.tierName||'—')}</p>
          <p><strong>Submitted:</strong> ${esc(new Date(c.submittedAt).toLocaleString('en-GB'))}</p>
          <p><strong>Source:</strong> ${esc(c.source||'')}</p>
          <p><strong>Payout:</strong> ${
              c.payoutMethod==='cash'
                  ? '$'+money(c.payoutAmount||0)
                  : c.payoutMethod==='item'
                      ? `${esc(c.payoutItemQty||0)}x ${esc(c.payoutItemName||'')}`
                      : 'Not recorded'
          }</p>
          <p><strong>Storage:</strong> <span class="hji-active">Stored locally in HJI</span></p>
          <p><strong>Details</strong></p>
          <pre style="white-space:pre-wrap">${esc(c.details||c.rawBody||'')}</pre>
        </div>

        <div class="hji-toolbar">
          <button class="hji-btn" id="claim-open-mail">Open original mail</button>
          <button class="hji-btn good" id="claim-open-trade">Open trade</button>
        </div>

        <div class="hji-form" style="margin-top:10px">
          <label>Status
            <select id="cl-status">
              ${['submitted','reviewing','approved','rejected','paid','closed'].map(x=>`<option value="${x}" ${c.status===x?'selected':''}>${claimStatusLabel(x)}</option>`).join('')}
            </select>
          </label>
          <label>Provider note
            <input id="cl-note" value="${esc(c.providerNote||'')}">
          </label>

          <label>Payout method
            <select id="cl-payout-method">
              <option value="" ${!c.payoutMethod?'selected':''}>Not recorded</option>
              <option value="cash" ${c.payoutMethod==='cash'?'selected':''}>Cash</option>
              <option value="item" ${c.payoutMethod==='item'?'selected':''}>Item</option>
            </select>
          </label>

          <label>Cash payout
            <input id="cl-payout-amount" inputmode="decimal" value="${formatMoneyInput(c.payoutAmount||0)}">
          </label>

          <label>Item payout
            <input id="cl-payout-item" value="${esc(c.payoutItemName||'')}" placeholder="e.g. Xanax">
          </label>

          <label>Item quantity
            <input id="cl-payout-qty" inputmode="numeric" value="${Number(c.payoutItemQty||0)}">
          </label>
        </div>`;

        bindMoneyInput(modal.el.querySelector('#cl-payout-amount'));

        const payoutMethodSelect=modal.el.querySelector('#cl-payout-method');
        const payoutAmountInput=modal.el.querySelector('#cl-payout-amount');
        const payoutItemInput=modal.el.querySelector('#cl-payout-item');
        const payoutQtyInput=modal.el.querySelector('#cl-payout-qty');

        function updatePayoutInputs(){
            const method=payoutMethodSelect.value;
            payoutAmountInput.closest('label').style.opacity=method==='cash'?'1':'.55';
            payoutItemInput.closest('label').style.opacity=method==='item'?'1':'.55';
            payoutQtyInput.closest('label').style.opacity=method==='item'?'1':'.55';
        }
        payoutMethodSelect.onchange=updatePayoutInputs;
        updatePayoutInputs();

        modal.el.querySelector('#claim-open-mail').onclick=()=>openClaimMail(c);
        modal.el.querySelector('#claim-open-trade').onclick=()=>openClaimTrade(c);

        modal.actions.insertAdjacentHTML(
            'beforeend',
            '<button class="hji-btn good" id="claim-save-notify">Save & Notify</button>'
        );

        const saveClaim=()=>{
            const nextStatus=modal.el.querySelector('#cl-status').value;
            const nextPayoutMethod=payoutMethodSelect.value;

            if(nextStatus==='paid'){
                if(!nextPayoutMethod){
                    alert('Record the payout method before marking this claim Paid.');
                    return false;
                }
                if(nextPayoutMethod==='cash' && parseMoneyInput(payoutAmountInput.value)<=0){
                    alert('Enter the cash payout amount before marking this claim Paid.');
                    return false;
                }
                if(nextPayoutMethod==='item' && (!payoutItemInput.value.trim() || Number(payoutQtyInput.value||0)<=0)){
                    alert('Enter the payout item and quantity before marking this claim Paid.');
                    return false;
                }
            }

            c.status=nextStatus;
            c.providerNote=modal.el.querySelector('#cl-note').value.trim();
            c.payoutMethod=payoutMethodSelect.value;
            c.payoutAmount=c.payoutMethod==='cash' ? parseMoneyInput(payoutAmountInput.value) : 0;
            c.payoutItemName=c.payoutMethod==='item' ? payoutItemInput.value.trim() : '';
            c.payoutItemQty=c.payoutMethod==='item' ? Number(payoutQtyInput.value||0) : 0;
            c.updatedAt=nowISO();

            const policyWasPaidOut = applyClaimPayoutToPolicy(c);

            saveAll();

            if (policyWasPaidOut) {
                console.info(`[HJI Manager] Single-jump policy ${c.policyId} marked Paid out by claim ${c.reference}.`);
            }
            return true;
        };

        modal.addSave(()=>{
            if(saveClaim()===false)return;
            modal.close();
            renderTab();
            renderTabs();
        });

        modal.el.querySelector('#claim-save-notify').onclick=async()=>{
            if(saveClaim()===false)return;
            const status=c.status;
            const note=c.providerNote;
            modal.close();
            renderTab();
            renderTabs();
            await prepareClaimStatusMail(c,status,note);
        };
    }

    function renderTiers(body) {
        body.innerHTML=`
        <div class="hji-toolbar">
          <button class="hji-btn good" id="hji-add-tier">+ Add tier</button>
        </div>

        <div class="hji-help">
          <strong>Tier management</strong>
          <p>You can add or edit insurance tiers to match the provider's offering. Tier deletion is available inside Edit to reduce accidental clicks.</p>
          <p>A tier that is still linked to an existing policy cannot be deleted. This protects historical policy and payment records.</p><p>For automatic item-payment matching, set the alternative item name and quantity. Adding the Torn item ID as well makes matching more reliable.</p>
        </div>

        <div class="hji-table-wrap"><table class="hji-table">
          <thead><tr><th>Name</th><th>Type</th><th>Coverage</th><th>Cash</th><th>Alternative item</th><th>Policies</th><th></th></tr></thead>
          <tbody>
          ${state.tiers.map(t=>{
              const policyCount=state.policies.filter(p=>p.tierId===t.id).length;
              return `<tr>
                <td>${esc(t.name)} ${!t.active?'<span class="hji-pill">Disabled</span>':''}</td>
                <td>${esc(t.type)}</td>
                <td>${esc(t.coverage)}</td>
                <td>$${money(t.cashPrice)}</td>
                <td>${t.itemName?`${esc(t.itemQty)} × ${esc(t.itemName)}`:'—'}</td>
                <td>${policyCount}</td>
                <td>
                  <div class="hji-toolbar" style="margin:0">
                    <button class="hji-btn" data-edit-tier="${t.id}">Edit</button>
                  </div>
                </td>
              </tr>`;
          }).join('') || '<tr><td colspan="7">No tiers configured.</td></tr>'}
          </tbody>
        </table></div>`;

        body.querySelector('#hji-add-tier').onclick=()=>tierModal();
        body.querySelectorAll('[data-edit-tier]').forEach(b=>b.onclick=()=>tierModal(getTier(b.dataset.editTier)));
    }

    function tierModal(existing=null){
        const modal=createModal(existing?'Edit tier':'Add tier');
        modal.content.innerHTML+=`<div class="hji-form">
          <label>Tier name<input id="tier-name" value="${esc(existing?.name||'')}"></label>
          <label>Type<select id="tier-type"><option value="single">Single jump</option><option value="monthly" ${existing?.type==='monthly'?'selected':''}>Time based</option></select></label>
          <label>Duration days<input id="tier-days" inputmode="numeric" value="${esc(existing?.durationDays??30)}"></label>
          <label>Maximum DVDs<input id="tier-dvds" inputmode="numeric" value="${esc(existing?.maxDvds??0)}"></label>
          <label class="wide">What's included / coverage<textarea id="tier-cover">${esc(existing?.coverage||'')}</textarea></label>
          <label>Cash price<input id="tier-cash" inputmode="decimal" value="${formatMoneyInput(existing?.cashPrice??0)}"></label>
          <label>Enabled<select id="tier-active"><option value="1">Yes</option><option value="0" ${existing?.active===false?'selected':''}>No</option></select></label>
          <label>Alternative item<input id="tier-item" value="${esc(existing?.itemName||'')}"></label>
          <label>Alternative item ID<input id="tier-item-id" inputmode="numeric" value="${esc(existing?.itemId||'')}" placeholder="Optional, improves log matching"></label>
          <label>Item quantity<input id="tier-qty" inputmode="numeric" value="${esc(existing?.itemQty??0)}"></label>
        </div>`;
        bindMoneyInput(modal.el.querySelector('#tier-cash'));

        if(existing){
            const policyCount=state.policies.filter(p=>p.tierId===existing.id).length;

            modal.actions.insertAdjacentHTML(
                'afterbegin',
                `<button class="hji-btn danger" id="tier-delete" ${policyCount ? 'disabled' : ''}>
                    Delete Tier
                </button>`
            );

            const deleteBtn=modal.el.querySelector('#tier-delete');

            if(policyCount){
                deleteBtn.title=`This tier is linked to ${policyCount} polic${policyCount===1?'y':'ies'} and cannot be deleted.`;
            }

            deleteBtn.onclick=()=>{
                const currentPolicyCount=state.policies.filter(p=>p.tierId===existing.id).length;

                if(currentPolicyCount){
                    alert(
                        `Cannot delete "${existing.name}".\n\n` +
                        `It is still linked to ${currentPolicyCount} polic${currentPolicyCount===1?'y':'ies'}. ` +
                        `Edit or remove those policies first.`
                    );
                    return;
                }

                if(!confirm(
                    `Delete tier "${existing.name}"?\n\n` +
                    `This removes the tier from this Manager. Existing backups can still restore it.`
                )) return;

                state.tiers=state.tiers.filter(t=>t.id!==existing.id);
                saveAll();
                modal.close();
                renderTab();
            };
        }

        modal.addSave(()=>{const data={name:modal.el.querySelector('#tier-name').value.trim(),type:modal.el.querySelector('#tier-type').value,durationDays:Number(modal.el.querySelector('#tier-days').value||0),maxDvds:Number(modal.el.querySelector('#tier-dvds').value||0),coverage:modal.el.querySelector('#tier-cover').value.trim(),cashPrice:parseMoneyInput(modal.el.querySelector('#tier-cash').value),active:modal.el.querySelector('#tier-active').value==='1',itemName:modal.el.querySelector('#tier-item').value.trim(),itemId:modal.el.querySelector('#tier-item-id').value.trim(),itemQty:Number(modal.el.querySelector('#tier-qty').value||0)};if(!data.name)return alert('Tier name is required.');if(existing)Object.assign(existing,data);else state.tiers.push({id:uid('tier'),...data});saveAll();modal.close();renderTab();});
    }


    function cleanDetectedUsername(value) {
        const name=String(value||'').trim();
        if(!name) return '';

        const generic=new Set([
            'view profile',
            'profile',
            'my profile',
            'open profile',
            'view user',
            'user profile'
        ]);

        if(generic.has(name.toLowerCase())) return '';
        if(/^view\s+profile$/i.test(name)) return '';
        if(name.length<2 || name.length>40) return '';

        return name;
    }

    function extractProfileIdentity(data) {
        if (!data || typeof data !== 'object') return null;

        const candidates = [data, data.user, data.profile, data.basic, data.player].filter(Boolean);

        for (const obj of candidates) {
            if (!obj || typeof obj !== 'object') continue;

            const id = obj.player_id ?? obj.user_id ?? obj.id ?? obj.ID;
            const rawName = obj.name ?? obj.username ?? obj.player_name;
            const name = cleanDetectedUsername(rawName);

            if (id && name) return { id: String(id), name };
        }

        for (const value of Object.values(data)) {
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                const found = extractProfileIdentity(value);
                if (found) return found;
            }
        }

        return null;
    }

    async function detectApiAccount(apiKey) {
        if (!apiKey) throw new Error('Save or enter an API key first.');

        const attempts = [
            `${API_BASE}/user/basic`,
            `${API_BASE}/user/profile`,
            'https://api.torn.com/user/?selections=basic'
        ];

        let lastError = null;
        for (const url of attempts) {
            try {
                const data = await requestApi(url, apiKey);
                if (data?.error) throw new Error(data.error.error || data.error.message || JSON.stringify(data.error));
                const identity = extractProfileIdentity(data);
                if (identity) return identity;
            } catch (e) {
                lastError = e;
            }
        }
        throw lastError || new Error('Could not identify the API-key account.');
    }

    function renderProviderAccountNotice(container) {
        const providerId = String(container.querySelector('#set-id')?.value || '').trim();
        const providerName = String(container.querySelector('#set-name')?.value || '').trim();
        const apiId = String(state.settings.apiAccountId || '').trim();
        const apiName = String(state.settings.apiAccountName || '').trim();
        const notice = container.querySelector('#set-account-notice');
        if (!notice) return;

        if (!apiId) {
            notice.innerHTML = '<span class="hji-muted">API account has not been detected yet.</span>';
            return;
        }

        const same = providerId && providerId === apiId;
        if (same) {
            notice.innerHTML = `<span class="hji-active"><b>API account:</b> ${esc(apiName)} [${esc(apiId)}] · matches the configured policy provider.</span>`;
        } else {
            notice.innerHTML = `
              <div class="hji-help" style="margin:0">
                <strong>Managing on behalf of another provider</strong>
                <p><b>API account:</b> ${esc(apiName)} [${esc(apiId)}]</p>
                <p><b>Policy provider:</b> ${esc(providerName || 'Not set')} ${providerId ? `[${esc(providerId)}]` : ''}</p>
                <p>This is allowed by the Manager design, but claims/setup codes will point to the <b>Policy provider</b>, not the API account.</p>
              </div>`;
        }
    }


    function safeClone(obj) {
        return JSON.parse(JSON.stringify(obj));
    }

    function buildBackupPayload() {
        const data = {
            tiers: normalizeCollection(state.tiers, 'tiers'),
            customers: normalizeCollection(state.customers, 'customers'),
            policies: normalizeCollection(state.policies, 'policies'),
            payments: normalizeCollection(state.payments, 'payments'),
            claims: normalizeCollection(state.claims, 'claims'),
            settings: normalizeSettings(state.settings)
        };

        // Never export API credentials.
        data.settings.apiKey = '';

        return {
            app: 'Torn Happy Jump Insurance Manager',
            backupVersion: 1,
            scriptVersion: VERSION,
            exportedAt: nowISO(),
            data
        };
    }

    function downloadJson(filename, payload) {
        const blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'});
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1200);
    }

    function exportManagerBackup(prefix='HJI-Manager-Backup') {
        const payload = buildBackupPayload();
        const stamp = new Date().toISOString().slice(0,10);
        downloadJson(`${prefix}-${stamp}.json`, payload);
    }

    function normalizeBackupObject(raw) {
        if (!raw || typeof raw !== 'object') throw new Error('Backup file is not a valid JSON object.');

        // Current v1 format.
        if (raw.app === 'Torn Happy Jump Insurance Manager' && raw.data) {
            return {
                app: raw.app,
                backupVersion: Number(raw.backupVersion || 1),
                scriptVersion: String(raw.scriptVersion || 'unknown'),
                exportedAt: raw.exportedAt || null,
                data: raw.data
            };
        }

        // Backward compatibility with the older export shape {version, exportedAt, state}.
        if (raw.state && typeof raw.state === 'object') {
            return {
                app: 'Torn Happy Jump Insurance Manager',
                backupVersion: 0,
                scriptVersion: String(raw.version || 'unknown'),
                exportedAt: raw.exportedAt || null,
                data: raw.state
            };
        }

        throw new Error('This does not look like an HJI Manager backup.');
    }

    function validateBackup(raw) {
        const backup = normalizeBackupObject(raw);
        const d = backup.data || {};

        const normalized = {
            tiers: normalizeCollection(d.tiers, 'backup tiers'),
            customers: normalizeCollection(d.customers, 'backup customers'),
            policies: normalizeCollection(d.policies, 'backup policies'),
            payments: normalizeCollection(d.payments, 'backup payments'),
            claims: normalizeCollection(d.claims, 'backup claims'),
            settings: normalizeSettings(d.settings || {})
        };

        // API key should never be restored from backup files.
        normalized.settings.apiKey = '';

        return {
            ...backup,
            data: normalized,
            summary: {
                tiers: normalized.tiers.length,
                customers: normalized.customers.length,
                policies: normalized.policies.length,
                payments: normalized.payments.length,
                claims: normalized.claims.length
            }
        };
    }

    function mergeById(current, incoming, fallbackKey=null) {
        const out = [...normalizeCollection(current, 'merge current')];
        const index = new Map();

        out.forEach((item, i) => {
            if (!item || typeof item !== 'object') return;
            const key = item.id ?? (fallbackKey ? item[fallbackKey] : null);
            if (key !== undefined && key !== null && key !== '') index.set(String(key), i);
        });

        normalizeCollection(incoming, 'merge incoming').forEach(item => {
            if (!item || typeof item !== 'object') return;
            const key = item.id ?? (fallbackKey ? item[fallbackKey] : null);

            if (key !== undefined && key !== null && key !== '' && index.has(String(key))) {
                out[index.get(String(key))] = {...out[index.get(String(key))], ...item};
            } else {
                out.push(item);
                if (key !== undefined && key !== null && key !== '') index.set(String(key), out.length - 1);
            }
        });

        return out;
    }

    function applyBackupReplace(validated) {
        const currentApiKey = state.settings?.apiKey || '';

        // Safety backup before destructive replacement.
        exportManagerBackup('HJI-Manager-Safety-Backup');

        state = {
            tiers: validated.data.tiers,
            customers: validated.data.customers,
            policies: validated.data.policies,
            payments: validated.data.payments,
            claims: validated.data.claims,
            settings: normalizeSettings(validated.data.settings)
        };

        // Keep the locally stored API key on this device.
        state.settings.apiKey = currentApiKey;

        saveAll();
    }

    function applyBackupMerge(validated) {
        const currentApiKey = state.settings?.apiKey || '';

        state.tiers = mergeById(state.tiers, validated.data.tiers);
        state.customers = mergeById(state.customers, validated.data.customers, 'tornId');
        state.policies = mergeById(state.policies, validated.data.policies);
        state.payments = mergeById(state.payments, validated.data.payments);
        state.claims = mergeById(state.claims, validated.data.claims);

        state.settings = {
            ...normalizeSettings(validated.data.settings),
            ...normalizeSettings(state.settings)
        };
        state.settings.apiKey = currentApiKey;

        saveAll();
    }

    function backupImportModal(validated) {
        const modal = createModal('Import HJI backup');

        const exported = validated.exportedAt
            ? new Date(validated.exportedAt).toLocaleString('en-GB')
            : 'Unknown';

        modal.content.innerHTML += `
          <div class="hji-help">
            <strong>Backup validated</strong>
            <p><b>Created:</b> ${esc(exported)}</p>
            <p><b>Backup format:</b> v${esc(validated.backupVersion)}</p>
            <p><b>Script version:</b> ${esc(validated.scriptVersion)}</p>
          </div>

          <div class="hji-grid">
            <div class="hji-card">Customers<b>${validated.summary.customers}</b></div>
            <div class="hji-card">Policies<b>${validated.summary.policies}</b></div>
            <div class="hji-card">Tiers<b>${validated.summary.tiers}</b></div>
            <div class="hji-card">Payments<b>${validated.summary.payments}</b></div>
          </div>

          <div class="hji-card">Claims<b>${validated.summary.claims}</b></div>

          <div class="hji-help">
            <strong>Choose how to restore</strong>
            <p><b>Replace Current Database</b> is best when moving to a new device or reinstalling. A safety backup of the current database is downloaded first.</p>
            <p><b>Merge With Current Database</b> combines records by ID and keeps existing records where possible.</p>
            <p>Your locally stored Torn API key is not imported or overwritten.</p>
          </div>`;

        modal.actions.innerHTML = `
          <button class="hji-btn" id="backup-cancel">Cancel</button>
          <button class="hji-btn" id="backup-merge">Merge</button>
          <button class="hji-btn danger" id="backup-replace">Replace</button>`;

        modal.el.querySelector('#backup-cancel').onclick = modal.close;

        modal.el.querySelector('#backup-merge').onclick = () => {
            if (!confirm('Merge this backup into the current HJI Manager database?')) return;
            applyBackupMerge(validated);
            modal.close();
            renderTabs();
            renderTab();
            alert('Backup merged successfully.');
        };

        modal.el.querySelector('#backup-replace').onclick = () => {
            if (!confirm('Replace the current HJI Manager database with this backup?\n\nA safety backup will be downloaded first.')) return;
            applyBackupReplace(validated);
            modal.close();
            renderTabs();
            renderTab();
            alert('Backup restored successfully.');
        };
    }

    function chooseBackupFile() {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = '.json,application/json';

        inp.onchange = () => {
            const file = inp.files?.[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const raw = JSON.parse(String(reader.result || ''));
                    const validated = validateBackup(raw);
                    backupImportModal(validated);
                } catch (e) {
                    alert(`Backup import failed.\n\n${e.message}`);
                }
            };
            reader.onerror = () => alert('Could not read the selected backup file.');
            reader.readAsText(file);
        };

        inp.click();
    }

    function renderSettings(body){
        const customKeyUrl = 'https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=Happy%20Jump%20Insurance%20Manager&user=messages,newmessages,basic,log';
        body.innerHTML=`
        <div class="hji-help">
          <strong>Settings help</strong>
          <p><b>Provider Name / ID</b> identifies the person actually providing the insurance. These fields stay editable so you can manage policies on behalf of another Torn user.</p>
          <details><summary>What does “Detect My Torn Account” do?</summary><p>It identifies the account that owns the stored API key and can optionally fill the Provider fields. You can edit them afterward.</p></details>
          <details><summary>What if the API account and provider are different?</summary><p>The Manager will show a warning. Client setup codes and claim routing use the Provider fields, not the API-key owner.</p></details>
          <details><summary>Where is the API key stored?</summary><p>Locally by this userscript on the current browser/device. Setup codes and customer-facing data never include it.</p></details>
        </div>

        <div class="hji-card">
          <strong>Provider identity <span class="hji-info" title="The actual person providing the policy. Claims are routed to this Torn ID.">i</span></strong>
          <div class="hji-form" style="margin-top:10px">
            <label title="Editable. This is the insurer shown to the client.">Provider Torn name<input id="set-name" value="${esc(state.settings.providerName||'')}"></label>
            <label title="Editable. Claims generated by the client are addressed to this Torn ID.">Provider Torn ID<input id="set-id" inputmode="numeric" value="${esc(state.settings.providerId||'')}"></label>
          </div>
          <div class="hji-toolbar" style="margin-top:10px">
            <button class="hji-btn" id="set-detect-account">Detect My Torn Account</button>
            <button class="hji-btn" id="set-fill-provider">Use detected account as provider</button>
          </div>
          <div id="set-account-notice"></div>
        </div>

        <div class="hji-card">
          <strong>Torn API <span class="hji-info" title="Used for reading claim mail and identifying the API-key owner.">i</span></strong>
          <p class="hji-muted">The custom key requests <b>messages</b>, <b>newmessages</b>, <b>basic</b>, and <b>log</b>. Log access is used only when you press <b>Scan item payments</b>. HJI filters specifically for Torn's Item receive log (4103).</p>
          <div class="hji-help">
            <strong>Log-access note</strong>
            <p>Torn requires a full-access API key for <code>user/log</code>. HJI does not continuously scan logs; it only requests them when you press the scan button, and matching/processed data stays in this Manager's local storage.</p>
          </div>
          <div class="hji-form">
            <label class="wide">Stored API key
              <div style="display:flex;gap:7px">
                <input id="set-key" type="password" autocomplete="off" value="${esc(state.settings.apiKey||'')}" placeholder="Paste your HJI custom API key">
                <button type="button" class="hji-btn" id="set-toggle-key">Show</button>
              </div>
            </label>
          </div>
          <div class="hji-toolbar" style="margin-top:10px">
            <button class="hji-btn good" id="set-keydocs">Generate HJI custom key</button>
            <button class="hji-btn" id="set-copy-keyurl">Copy key-builder link</button>
            <button class="hji-btn" id="set-test-key">Test key</button>
          </div>
          <div class="hji-help">
            <strong>API-key disclosure</strong>
            <p>The key is sent only to Torn's official API when this Manager checks messages or detects the API-key account. It is not sent to another HJI user, included in setup codes, or included in exported backups.</p>
          </div>
        </div>

        <div class="hji-card">
          <strong>Manager options <span class="hji-info" title="These values affect reminders and the suggested scan cadence only.">i</span></strong>
          <div class="hji-form" style="margin-top:10px">
            <label title="Policies ending within this many days show as Due soon.">Due soon warning (days)<input id="set-due" inputmode="numeric" value="${esc(state.settings.dueSoonDays||3)}"></label>
            <label title="A reminder value only; the Manager does not silently scan Torn in the background.">Claim scan interval hint (minutes)<input id="set-poll" inputmode="numeric" value="${esc(state.settings.claimPollMinutes||10)}"></label>
          </div>
        </div>

        <div class="hji-card">
          <strong>Backup & Restore <span class="hji-info" title="Use this when moving devices, reinstalling, or protecting your insurance database.">i</span></strong>
          <div class="hji-help">
            <p>Backups include customers, policies, renewals, tiers, payments, claims and Manager settings.</p>
            <p><b>The Torn API key is deliberately excluded.</b></p>
          </div>
          <div class="hji-toolbar">
            <button class="hji-btn good" id="set-export">Export full backup</button>
            <button class="hji-btn" id="set-import">Import / restore backup</button>
          </div>
        </div>

        <div class="hji-toolbar">
          <button class="hji-btn good" id="set-save">Save settings</button>
        </div>`;

        const keyInput = body.querySelector('#set-key');
        const providerNameInput = body.querySelector('#set-name');
        const providerIdInput = body.querySelector('#set-id');

        renderProviderAccountNotice(body);

        providerNameInput.addEventListener('input',()=>renderProviderAccountNotice(body));
        providerIdInput.addEventListener('input',()=>renderProviderAccountNotice(body));

        body.querySelector('#set-toggle-key').onclick=()=>{
            const showing = keyInput.type === 'text';
            keyInput.type = showing ? 'password' : 'text';
            body.querySelector('#set-toggle-key').textContent = showing ? 'Show' : 'Hide';
        };

        body.querySelector('#set-save').onclick=()=>{
            Object.assign(state.settings,{
                providerName:providerNameInput.value.trim(),
                providerId:providerIdInput.value.trim(),
                apiKey:keyInput.value.trim(),
                dueSoonDays:Number(body.querySelector('#set-due').value||3),
                claimPollMinutes:Number(body.querySelector('#set-poll').value||10)
            });
            saveAll();
            renderProviderAccountNotice(body);
            alert('Settings saved locally.');
        };

        body.querySelector('#set-detect-account').onclick=async()=>{
            const key = keyInput.value.trim();
            if (!key) return alert('Enter the API key first.');

            const btn = body.querySelector('#set-detect-account');
            btn.disabled = true;
            btn.textContent = 'Detecting…';

            try {
                const identity = await detectApiAccount(key);
                state.settings.apiAccountId = identity.id;
                state.settings.apiAccountName = identity.name;

                // Save the key too, because the user has explicitly used it here.
                state.settings.apiKey = key;

                // Convenient first-time behaviour: only auto-fill empty provider fields.
                if (!providerIdInput.value.trim()) providerIdInput.value = identity.id;
                if (!providerNameInput.value.trim()) providerNameInput.value = identity.name;

                state.settings.providerId = providerIdInput.value.trim();
                state.settings.providerName = providerNameInput.value.trim();

                saveAll();
                renderProviderAccountNotice(body);
                alert(`Detected API account: ${identity.name} [${identity.id}]`);
            } catch(e) {
                alert(`Could not detect the API-key account.\n\n${e.message}`);
            } finally {
                btn.disabled = false;
                btn.textContent = 'Detect My Torn Account';
            }
        };

        body.querySelector('#set-fill-provider').onclick=()=>{
            if (!state.settings.apiAccountId) return alert('Detect the API-key account first.');
            providerIdInput.value = state.settings.apiAccountId;
            providerNameInput.value = state.settings.apiAccountName || '';
            state.settings.providerId = providerIdInput.value.trim();
            state.settings.providerName = providerNameInput.value.trim();
            saveAll();
            renderProviderAccountNotice(body);
        };

        body.querySelector('#set-keydocs').onclick=()=>{
            const a=document.createElement('a');
            a.href=customKeyUrl;
            a.target='_blank';
            a.rel='noopener noreferrer';
            document.body.appendChild(a);
            a.click();
            a.remove();
        };

        body.querySelector('#set-copy-keyurl').onclick=async()=>{
            await copyText(customKeyUrl);
            alert('Custom-key builder link copied.');
        };

        body.querySelector('#set-test-key').onclick=async()=>{
            const key = keyInput.value.trim();
            if (!key) return alert('Paste your HJI custom API key first.');
            const btn = body.querySelector('#set-test-key');
            btn.disabled = true;
            btn.textContent = 'Testing…';
            try {
                let data;
                try { data = await requestApi(`${API_BASE}/user/newmessages?limit=1`, key); }
                catch { data = await requestApi(`${API_BASE}/user/messages?limit=1`, key); }
                if (data?.error) throw new Error(data.error.error || data.error.message || JSON.stringify(data.error));
                alert('The API key worked for the HJI message check.');
            } catch(e) {
                alert(`API key test failed.\n\n${e.message}\n\nUse the HJI custom-key button and allow messages/newmessages/basic/log. Item-log scanning requires full-access log permission.`);
            } finally {
                btn.disabled = false;
                btn.textContent = 'Test key';
            }
        };

        body.querySelector('#set-export').onclick=()=>exportManagerBackup();

        body.querySelector('#set-import').onclick=()=>chooseBackupFile();
    }

    function createModal(title){
        const bg=document.createElement('div');bg.className='hji-modal-bg';bg.innerHTML=`<div class="hji-modal"><h3>${esc(title)}</h3><div class="hji-modal-content"></div><div class="hji-actions"><button class="hji-btn" data-cancel>Cancel</button><button class="hji-btn good" data-save>Save</button></div></div>`;
        overlay.querySelector('#hji-app').appendChild(bg);
        const obj={el:bg,content:bg.querySelector('.hji-modal-content'),actions:bg.querySelector('.hji-actions'),close:()=>bg.remove(),addSave(fn){bg.querySelector('[data-save]').onclick=fn;}};
        bg.querySelector('[data-cancel]').onclick=obj.close; return obj;
    }

    function requestApi(url, apiKey) {
        return new Promise((resolve,reject)=>{
            if (typeof GM_xmlhttpRequest === 'function') {
                try {
                    GM_xmlhttpRequest({
                        method:'GET', url,
                        headers:{'Authorization':`ApiKey ${apiKey}`,'Accept':'application/json'},
                        onload:r=>{try{resolve(JSON.parse(r.responseText));}catch(e){reject(e)}},
                        onerror:()=>reject(new Error('Torn API request failed'))
                    });
                    return;
                } catch {}
            }
            fetch(url,{headers:{'Authorization':`ApiKey ${apiKey}`,'Accept':'application/json'}}).then(r=>r.json()).then(resolve,reject);
        });
    }

    function getMessageArray(data) {
        if (!data || typeof data !== 'object') return [];

        // Current API v2 shape: { messages: [...] }
        if (Array.isArray(data.messages)) return data.messages;

        // Tolerate nested/legacy shapes without assuming one exact historical format.
        const found=[];
        const walk=obj=>{
            if(!obj || typeof obj!=='object')return;
            if(Array.isArray(obj)){
                obj.forEach(walk);
                return;
            }

            const looksLikeMessage =
                ('topic' in obj || 'title' in obj || 'subject' in obj) &&
                ('timestamp' in obj || 'sender' in obj || 'sender_id' in obj);

            if(looksLikeMessage) found.push(obj);

            Object.values(obj).forEach(v=>{
                if(v && typeof v==='object') walk(v);
            });
        };
        walk(data);
        return found;
    }

    function messageTopic(m) {
        return String(
            m?.topic ??
            m?.subject ??
            m?.title ??
            ''
        ).trim();
    }

    function messageSender(m) {
        const senderObj = m?.sender && typeof m.sender==='object' ? m.sender : null;

        const id =
            senderObj?.id ??
            senderObj?.player_id ??
            senderObj?.user_id ??
            m?.sender_id ??
            m?.user_id ??
            '';

        const name =
            senderObj?.name ??
            senderObj?.username ??
            m?.sender_name ??
            m?.name ??
            '';

        return {
            id: String(id ?? ''),
            name: String(name ?? '')
        };
    }

    function messageTimestamp(m) {
        const ts=Number(m?.timestamp || 0);
        return Number.isFinite(ts) && ts>0
            ? new Date(ts*1000).toISOString()
            : nowISO();
    }

    function parseClaimMessage(m) {
        const topic=messageTopic(m);

        // HJI Client puts both the marker and the unique reference in the Torn Mail topic.
        if(!topic.includes(CLAIM_PREFIX) && !/HJI-[A-Z0-9_-]+/i.test(topic)) return null;

        const reference=(topic.match(/HJI-[A-Z0-9_-]+/i)||[])[0];
        if(!reference) return null;

        const sender=messageSender(m);

        return {
            reference,
            claimantId:sender.id,
            claimantName:sender.name,
            tierName:'',
            details:'Claim detected from Torn Mail. Torn API v2 exposes the message topic and sender, but not the full mail body; open the Torn message to review the submitted claim details.',
            submittedAt:messageTimestamp(m),
            status:'submitted',
            source:'torn-mail',
            mailMessageId:String(m?.id ?? ''),
            mailTopic:topic,
            mailSeen:Boolean(m?.seen),
            mailRead:Boolean(m?.read)
        };
    }

    async function scanMail() {
        const btn=overlay?.querySelector('#hji-scan-mail');

        if (!state.settings.apiKey) {
            return alert('Add the provider Torn API key in Settings first.');
        }

        if (btn) {
            btn.disabled=true;
            btn.textContent='Scanning…';
        }

        try {
            // Always scan the full inbox. A claim may already be seen/read, in which
            // case /newmessages can legitimately return an empty list.
            const data=await requestApi(
                `${API_BASE}/user/messages?limit=100&sort=DESC`,
                state.settings.apiKey
            );

            if (data?.error) {
                throw new Error(
                    data.error.error ||
                    data.error.message ||
                    JSON.stringify(data.error)
                );
            }

            const messages=getMessageArray(data);

            let hjiFound=0;
            let added=0;
            let duplicates=0;

            for(const m of messages){
                const c=parseClaimMessage(m);
                if(!c)continue;

                hjiFound++;

                if(state.claims.some(x=>x.reference===c.reference)){
                    duplicates++;
                    continue;
                }

                c.id=uid('claim');

                const customer=state.customers.find(
                    x=>String(x.tornId)===String(c.claimantId)
                );

                if(customer){
                    c.customerId=customer.id;

                    if(!c.claimantName) c.claimantName=customer.name;

                    const activePolicies=state.policies.filter(
                        p=>p.customerId===customer.id &&
                           p.status!=='cancelled' &&
                           !['Expired','Used'].includes(policyStatus(p)[0])
                    );

                    if(activePolicies.length===1){
                        const p=activePolicies[0];
                        c.policyId=p.id;
                        c.tierName=getTier(p.tierId)?.name || p.tierName || '';
                    }
                }

                state.claims.push(c);
                added++;
            }

            state.settings.lastMailScan=nowISO();
            saveAll();

            alert(
                `Mail scan complete.\n\n` +
                `${messages.length} inbox message${messages.length===1?'':'s'} checked\n` +
                `${hjiFound} HJI claim topic${hjiFound===1?'':'s'} found\n` +
                `${added} new claim${added===1?'':'s'} imported` +
                (duplicates ? `\n${duplicates} already imported` : '')
            );

            renderTab();
            renderTabs();

        } catch(e) {
            alert(
                `Could not scan Torn Mail.\n\n${e.message}\n\n` +
                `The Manager needs access to user/messages.`
            );
        } finally {
            if(btn){
                btn.disabled=false;
                btn.textContent='↻ Scan Torn Mail';
            }
        }
    }

    function addLauncher(){
        injectStyles();
        if(document.getElementById('hji-launcher'))return;

        const b=document.createElement('div');
        b.id='hji-launcher';
        b.setAttribute('role','button');
        b.setAttribute('tabindex','0');
        b.textContent='🛡 HJI Manager';
        b.title='Tap to open. Drag to move.';
        document.body.appendChild(b);

        makeDraggable(b,b,'launcherPos',()=>openApp());

        b.addEventListener('keydown',e=>{
            if(e.key==='Enter'||e.key===' '){
                e.preventDefault();
                openApp();
            }
        });
    }

    function boot(){
        if (!document.body) return;
        addLauncher();
        tryFillManagerStatusMail();
    }

    function startObserver(){
        const target = document.documentElement || document.body;
        if (!target || typeof target.nodeType !== 'number') {
            setTimeout(startObserver, 250);
            return;
        }
        const observer = new MutationObserver(()=>{
            if(document.body && !document.getElementById('hji-launcher') && !overlay) addLauncher();
            if(location.href.includes('messages.php')) tryFillManagerStatusMail();
        });
        observer.observe(target,{childList:true,subtree:true});
    }

    if(document.readyState==='loading') {
        document.addEventListener('DOMContentLoaded',()=>{ boot(); startObserver(); },{once:true});
    } else {
        boot();
        startObserver();
    }
})();
