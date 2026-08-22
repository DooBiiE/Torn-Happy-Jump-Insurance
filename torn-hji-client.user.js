// ==UserScript==
// @name         Torn Happy Jump Insurance Client
// @namespace    torn-hji
// @version      0.3.7
// @description  Insured-user client for importing Happy Jump policies and preparing structured Torn Mail claims.
// @author       DooBiiE
// @match        https://www.torn.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=torn.com
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/DooBiiE/Torn-Happy-Jump-Insurance/main/torn-hji-client.user.js
// @updateURL    https://raw.githubusercontent.com/DooBiiE/Torn-Happy-Jump-Insurance/main/torn-hji-client.user.js
// ==/UserScript==

(() => {
    'use strict';

    const VERSION = '0.3.7';
    const PREFIX='torn_hji_client_v2_';
    const LEGACY_PREFIX='torn_hji_client_v1_';
    const CLAIM_PREFIX='[HJI CLAIM]';
    const STATUS_PREFIX='[HJI STATUS]';
    const API_BASE='https://api.torn.com/v2';

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

    function legacyGet(key, fallback) {
        const full = LEGACY_PREFIX + key;
        try {
            if (typeof GM_getValue === 'function') {
                const v = GM_getValue(full, undefined);
                if (v !== undefined && !(v && typeof v.then === 'function')) {
                    return decodeStoredValue(v, fallback);
                }
            }
        } catch {}
        try {
            const raw = localStorage.getItem(full);
            return raw == null ? fallback : decodeStoredValue(raw, fallback);
        } catch {
            return fallback;
        }
    }

    const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const claimRef=()=>`HJI-${new Date().toISOString().slice(0,10).replaceAll('-','')}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;
    const dateOnly=v=>v?new Date(v).toLocaleDateString('en-GB'):'—';

    function decodeSetup(code){
        const trimmed=String(code||'').trim();
        if(!trimmed.startsWith('HJI1.'))throw new Error('This is not an HJI v1 setup code.');
        let b64=trimmed.slice(5).replace(/-/g,'+').replace(/_/g,'/');
        while(b64.length%4)b64+='=';
        const binary=atob(b64);
        const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
        const obj=JSON.parse(new TextDecoder().decode(bytes));
        if(obj?.schema!=='torn-hji-policy'||Number(obj?.version)!==1)throw new Error('Unsupported HJI setup-code format.');
        if(!obj?.provider?.id||!obj?.insured?.id||!obj?.policy?.id)throw new Error('Setup code is missing required policy information.');
        return obj;
    }

    function loadPosition(key){
        const pos=storage.get(key,null);
        if(!pos||!Number.isFinite(pos.left)||!Number.isFinite(pos.top))return null;
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

    let state=storage.get('state',null);
    if(!state){
        state={claimantId:'',claimantName:'',policies:[],claims:[]};
        const legacy=legacyGet('state',null);
        if(legacy){
            state.claimantId=legacy.claimantId||'';
            state.claimantName=legacy.claimantName||'';
            state.claims=legacy.claims||[];
            if(legacy.providerId){
                state.policies.push({
                    localId:'legacy',
                    providerId:String(legacy.providerId),
                    providerName:legacy.providerName||'',
                    insuredId:String(legacy.claimantId||''),
                    insuredName:legacy.claimantName||'',
                    policyId:'legacy-policy',
                    tierName:legacy.policyTier||'Legacy policy',
                    type:'monthly',
                    coverage:legacy.coverage||'',
                    startDate:null,
                    endDate:legacy.validUntil||null,
                    maxDvds:0,
                    importedAt:new Date().toISOString()
                });
            }
        }
    }
    state = decodeStoredValue(state, {}) || {};
    state.claimantId = String(state.claimantId || '');
    state.claimantName = String(state.claimantName || '');

    const storedPolicies = decodeStoredValue(state.policies, []);
    const storedClaims = decodeStoredValue(state.claims, []);

    state.policies = Array.isArray(storedPolicies) ? storedPolicies : [];
    state.claims = Array.isArray(storedClaims) ? storedClaims : [];
    state.settings = state.settings && typeof state.settings==='object' && !Array.isArray(state.settings) ? state.settings : {};
    state.settings.statusApiKey = String(state.settings.statusApiKey || '');
    state.settings.lastStatusSync = state.settings.lastStatusSync || null;
    const save=()=>storage.set('state',state);


    function clientClaimStatus(c){
        return String(c?.status || 'prepared').toLowerCase();
    }

    function clientClaimStatusLabel(status){
        return ({
            prepared:'Prepared',
            submitted:'Submitted',
            reviewing:'Reviewing',
            approved:'Approved',
            rejected:'Rejected',
            paid:'Paid',
            closed:'Closed'
        })[String(status||'prepared').toLowerCase()] || String(status||'Prepared');
    }

    function clientClaimStatusClass(status){
        status=String(status||'prepared').toLowerCase();
        if(status==='approved'||status==='paid') return 'hc-status-active';
        if(status==='rejected') return 'hc-status-expired';
        if(status==='reviewing'||status==='submitted') return 'hc-status-due';
        return 'hc-status-muted';
    }

    function requestClientApi(url, apiKey){
        return new Promise((resolve,reject)=>{
            if(typeof GM_xmlhttpRequest==='function'){
                try{
                    GM_xmlhttpRequest({
                        method:'GET',
                        url,
                        headers:{'Authorization':`ApiKey ${apiKey}`,'Accept':'application/json'},
                        onload:r=>{try{resolve(JSON.parse(r.responseText))}catch(e){reject(e)}},
                        onerror:()=>reject(new Error('Torn API request failed'))
                    });
                    return;
                }catch{}
            }

            fetch(url,{
                headers:{'Authorization':`ApiKey ${apiKey}`,'Accept':'application/json'}
            }).then(r=>r.json()).then(resolve,reject);
        });
    }

    function getClientMessages(data){
        if(Array.isArray(data?.messages)) return data.messages;
        return [];
    }

    function parseStatusTopic(m){
        const topic=String(m?.topic||m?.subject||m?.title||'').trim();
        if(!topic.startsWith(STATUS_PREFIX)) return null;

        const match=topic.match(/^\[HJI STATUS\]\s+(HJI-[A-Z0-9_-]+)\s+(SUBMITTED|REVIEWING|APPROVED|REJECTED|PAID|CLOSED)\b/i);
        if(!match) return null;

        const sender=m?.sender && typeof m.sender==='object' ? m.sender : {};
        return {
            reference:match[1],
            status:match[2].toLowerCase(),
            senderId:String(sender.id ?? m?.sender_id ?? ''),
            senderName:String(sender.name ?? m?.sender_name ?? ''),
            timestamp:Number(m?.timestamp||0)
        };
    }

    async function syncClaimStatuses(){
        const key=String(state.settings.statusApiKey||'').trim();
        if(!key) return alert('Add the optional Claim Status Sync API key in Client Settings first.');

        try{
            const data=await requestClientApi(`${API_BASE}/user/messages?limit=100&sort=DESC`,key);
            if(data?.error) throw new Error(data.error.error||data.error.message||JSON.stringify(data.error));

            const updates=getClientMessages(data)
                .map(parseStatusTopic)
                .filter(Boolean)
                .sort((a,b)=>a.timestamp-b.timestamp);

            let matched=0;
            let changed=0;

            for(const update of updates){
                const claim=state.claims.find(c=>c.reference===update.reference);
                if(!claim) continue;

                // Only accept a status message from the provider attached to this claim.
                if(claim.providerId && update.senderId && String(claim.providerId)!==String(update.senderId)) continue;

                matched++;
                if(clientClaimStatus(claim)!==update.status){
                    claim.status=update.status;
                    claim.statusUpdatedAt=update.timestamp ? new Date(update.timestamp*1000).toISOString() : new Date().toISOString();
                    claim.statusSenderName=update.senderName||claim.providerName||'';
                    changed++;
                }
            }

            state.settings.lastStatusSync=new Date().toISOString();
            save();

            alert(`Claim status sync complete.\n\n${matched} status message${matched===1?'':'s'} matched\n${changed} claim${changed===1?'':'s'} updated`);
            open('claims');
        }catch(e){
            alert(`Could not sync claim statuses.\n\n${e.message}`);
        }
    }

    function styles(){
        if(document.getElementById('hji-client-style'))return;
        const s=document.createElement('style');s.id='hji-client-style';s.textContent=`
        :root{--hc-bg:#202020;--hc-panel:#2b2b2b;--hc-border:#4a4a4a;--hc-text:#e8e8e8;--hc-muted:#aaa;--hc-input:#181818}
        #hji-client-launch{position:fixed;left:16px;bottom:18px;z-index:999999;background:linear-gradient(#4a4a4a,#303030);color:#fff;border:1px solid #666;border-radius:5px;padding:9px 13px;font:600 13px Arial,sans-serif;box-shadow:0 2px 8px #0009;cursor:grab;user-select:none;touch-action:none}
        #hji-client-overlay{position:fixed;inset:0;z-index:1000000;background:transparent;pointer-events:none}
        #hji-client-app{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(700px,90vw);height:min(620px,78vh);min-width:300px;min-height:300px;max-width:97vw;max-height:92vh;overflow:hidden;background:var(--hc-bg);color:var(--hc-text);border:1px solid #555;border-radius:7px;font:14px Arial,sans-serif;box-shadow:0 12px 35px #000c;pointer-events:auto;resize:both;display:flex;flex-direction:column}
        #hji-client-app.hc-compact{width:min(560px,86vw);height:min(500px,66vh)}
        .hc-head{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 12px;background:linear-gradient(#3b3b3b,#292929);border-bottom:1px solid #555;cursor:move;user-select:none;touch-action:none}.hc-head h2{margin:0;color:#f5f5f5;font-size:18px}.hc-head-actions{display:flex;gap:6px}
        .hc-tabs{display:flex;gap:4px;padding:7px;background:#252525;border-bottom:1px solid #444;overflow:auto}.hc-tab{background:#333;color:#ddd;border:1px solid #555;border-radius:4px;padding:7px 10px;white-space:nowrap}.hc-tab.active{background:#555;color:#fff}.hc-body{padding:12px;overflow:auto;flex:1;background:var(--hc-bg);color:var(--hc-text)}
        .hc-card{background:var(--hc-panel);border:1px solid var(--hc-border);border-radius:5px;padding:11px;margin-bottom:10px;color:var(--hc-text)}.hc-card h3{margin:0 0 8px;color:#fff}
        .hc-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.hc-field{background:#252525;padding:9px;border-radius:4px;color:#eee}.hc-field small{display:block;color:#aaa;margin-bottom:3px}
        .hc-btn{background:linear-gradient(#4a4a4a,#333);color:#f5f5f5!important;border:1px solid #606060;border-radius:4px;padding:8px 10px;cursor:pointer}.hc-btn.good{background:linear-gradient(#4f7e5e,#365942);border-color:#618e6c}.hc-btn.danger{background:linear-gradient(#8f4343,#683030);border-color:#a95656}.hc-close,.hc-size{background:#444;color:#f5f5f5;border:1px solid #666;border-radius:4px;padding:6px 9px;cursor:pointer}
        .hc-form{display:grid;grid-template-columns:1fr 1fr;gap:9px}.hc-form label{display:flex;flex-direction:column;gap:5px;color:#ddd;font-weight:600}.hc-form .wide{grid-column:1/-1}
        .hc-form input,.hc-form select,.hc-form textarea{box-sizing:border-box;width:100%;background:var(--hc-input)!important;color:#f2f2f2!important;border:1px solid #5a5a5a;border-radius:4px;padding:8px;-webkit-text-fill-color:#f2f2f2!important;caret-color:#fff}.hc-form textarea{min-height:90px}.hc-form input::placeholder,.hc-form textarea::placeholder{color:#8e8e8e!important;-webkit-text-fill-color:#8e8e8e!important}.hc-form select option{background:#222;color:#f2f2f2}
        .hc-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.hc-muted{font-size:12px;color:#aaa!important}.hc-help{background:#252d33;border:1px solid #465966;border-radius:5px;padding:10px;margin-bottom:10px;color:#e1e1e1}.hc-help p{margin:5px 0}.hc-help details{margin-top:6px}.hc-help summary{cursor:pointer;font-weight:700;color:#dceaf3}
        .hc-policy-active{background:#243329;border-left:4px solid #4fa96c}.hc-policy-due{background:#403823;border-left:4px solid #d6aa43}.hc-policy-expired{background:#422828;border-left:4px solid #c94b4b}.hc-policy-cancelled{background:#303030;border-left:4px solid #777;opacity:.72}.hc-policy-used{background:#30343a;border-left:4px solid #718096;opacity:.82}
        .hc-status-active{color:#75d28d;font-weight:700}.hc-status-due{color:#f0c866;font-weight:700}.hc-status-expired{color:#f18181;font-weight:700}.hc-status-muted{color:#aaa;font-weight:700}
        .hc-resize-grip{position:absolute;right:0;bottom:0;width:30px;height:30px;z-index:20;cursor:nwse-resize;touch-action:none}.hc-resize-grip:after{content:'↘';position:absolute;right:5px;bottom:3px;color:#bbb;font-size:18px}
        @media(max-width:600px){#hji-client-launch{left:9px;bottom:10px;padding:8px 11px}#hji-client-app{width:90vw;height:72vh;max-height:82vh}#hji-client-app.hc-compact{width:84vw;height:60vh}.hc-grid,.hc-form{grid-template-columns:1fr}.hc-form .wide{grid-column:auto}.hc-head h2{font-size:15px}}
        `;document.head.appendChild(s);
    }

    function policyStatus(p){
        if (p.status === 'cancelled') return ['Cancelled','hc-policy-cancelled','hc-status-muted'];
        if (p.type === 'single') {
            if (p.used) return ['Used','hc-policy-used','hc-status-muted'];
            return ['Active','hc-policy-active','hc-status-active'];
        }
        if (!p.endDate) return ['Active','hc-policy-active','hc-status-active'];
        const diff = new Date(p.endDate).getTime() - Date.now();
        if (diff < 0) return ['Expired','hc-policy-expired','hc-status-expired'];
        if (diff <= 3 * 86400000) return ['Due soon','hc-policy-due','hc-status-due'];
        return ['Active','hc-policy-active','hc-status-active'];
    }

    function cleanDetectedUsername(value, tornId=''){
        let name=String(value||'').trim();

        if(!name) return '';

        name=name
            .replace(/\s+/g,' ')
            .replace(new RegExp(`\\s*\\[${String(tornId).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\]\\s*$`),'')
            .trim();

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

    function findUsernameForTornId(tornId){
        tornId=String(tornId||'').trim();
        if(!/^\d+$/.test(tornId)) return '';

        // Prefer explicit attributes attached to the matching profile link.
        const links=[...document.querySelectorAll(`a[href*="profiles.php?XID=${tornId}"]`)];
        for(const a of links){
            const candidates=[
                a.getAttribute('data-user-name'),
                a.getAttribute('data-name'),
                a.getAttribute('title'),
                a.getAttribute('aria-label'),
                a.textContent
            ];

            for(const candidate of candidates){
                const name=cleanDetectedUsername(candidate,tornId);
                if(name) return name;
            }

            // Torn often displays "Username [123456]" in a parent/sibling even when
            // the clickable link itself only says "View Profile".
            const nearby=[
                a.parentElement?.textContent,
                a.closest('li,div,section,header')?.textContent,
                a.previousElementSibling?.textContent,
                a.nextElementSibling?.textContent
            ];

            for(const block of nearby){
                const text=String(block||'');
                const match=text.match(new RegExp(`([A-Za-z0-9_-]{2,40})\\s*\\[${tornId}\\]`,'i'));
                const name=cleanDetectedUsername(match?.[1],tornId);
                if(name) return name;
            }
        }

        // Final fallback: search visible page text for the exact same Torn ID.
        // Tying the match to the detected ID avoids using another player's profile name.
        const pageText=String(document.body?.innerText||'');
        const match=pageText.match(new RegExp(`([A-Za-z0-9_-]{2,40})\\s*\\[${tornId}\\]`,'i'));
        return cleanDetectedUsername(match?.[1],tornId);
    }

    function detectCurrentTornUser(){
        // First locate a plausible own-profile link / ID.
        const profileLinks=[...document.querySelectorAll('a[href*="profiles.php?XID="]')];

        for(const a of profileLinks){
            const href=String(a.getAttribute('href')||'');
            const m=href.match(/XID=(\d+)/i);
            if(!m) continue;

            const id=m[1];
            const name=findUsernameForTornId(id);

            // We can safely return the ID even if name was not found; importantly,
            // never use generic UI labels such as "View Profile" as the username.
            if(name) return {id,name,source:'Torn page'};
        }

        // Torn/PDA may expose the logged-in account through data attributes instead.
        for(const n of document.querySelectorAll('[data-user-id],[data-player-id],[data-userid]')){
            const id=n.getAttribute('data-user-id') ||
                     n.getAttribute('data-player-id') ||
                     n.getAttribute('data-userid');

            if(!id || !/^\d+$/.test(id)) continue;

            const direct=
                n.getAttribute('data-user-name') ||
                n.getAttribute('data-name') ||
                '';

            const name=cleanDetectedUsername(direct,id) || findUsernameForTornId(id);

            if(name) return {id,name,source:'Torn page data'};
        }

        return null;
    }

    function autoFillCurrentUser(){
        const found = detectCurrentTornUser();
        if (!found) return null;
        if (!state.claimantId) state.claimantId = String(found.id);
        if (!state.claimantName && found.name) state.claimantName = String(found.name);
        save();
        return found;
    }

    function policyOwnerMatches(p){
        if (!state.claimantId || !p.insuredId) return null;
        return String(state.claimantId) === String(p.insuredId);
    }

    let overlay=null;
    let currentClientView='policies';

    function clientTabsHtml(){
        return `
          <div class="hc-tabs">
            <button class="hc-tab ${currentClientView==='policies'?'active':''}" data-client-tab="policies">Policies</button>
            <button class="hc-tab ${currentClientView==='claims'?'active':''}" data-client-tab="claims">Claims (${state.claims.length})</button>
          </div>`;
    }

    function claimsViewHtml(){
        const lastSync=state.settings.lastStatusSync
            ? new Date(state.settings.lastStatusSync).toLocaleString('en-GB')
            : 'Never';

        return `
          <div class="hc-help">
            <strong>My claims</strong>
            <p>Claims start as <b>Prepared</b>. When your provider sends a structured HJI status mail, the optional status-sync feature can update the status here.</p>
            <p><b>Last status sync:</b> ${esc(lastSync)}</p>
          </div>

          <div class="hc-actions" style="margin:0 0 10px">
            <button class="hc-btn good" id="hc-new-claim" ${state.policies.length?'':'disabled'}>Submit claim</button>
            <button class="hc-btn" id="hc-sync-status">Sync claim statuses</button>
          </div>

          ${state.claims.length ? state.claims.slice().reverse().map(c=>`
            <div class="hc-card">
              <div class="hc-grid">
                <div class="hc-field"><small>Reference</small><strong>${esc(c.reference)}</strong></div>
                <div class="hc-field"><small>Status</small><span class="${clientClaimStatusClass(c.status)}">${esc(clientClaimStatusLabel(c.status))}</span></div>
                <div class="hc-field"><small>Provider</small>${esc(c.providerName||'')} [${esc(c.providerId||'')}]</div>
                <div class="hc-field"><small>Created</small>${esc(new Date(c.createdAt).toLocaleString('en-GB'))}</div>
              </div>
              <div class="hc-field" style="margin-top:8px"><small>Claim summary</small>${esc(c.summary||'')}</div>
            </div>`).join('') : '<div class="hc-card"><div class="hc-muted">No claims prepared yet.</div></div>'}
        `;
    }

    function policiesViewHtml(){
        return `
          <div class="hc-help">
            <strong>How this works</strong>
            <p>Your insurer gives you an HJI setup code. Import it here, then choose that policy when you need to prepare a claim.</p>
            <p><b>Your Torn account:</b> ${esc(state.claimantName||'Unknown')} ${state.claimantId?`[${esc(state.claimantId)}]`:''}</p>
          </div>

          <div class="hc-actions" style="margin:0 0 10px">
            <button class="hc-btn good" id="hc-import">Import policy setup code</button>
            <button class="hc-btn" id="hc-settings">Settings</button>
          </div>

          <div class="hc-card"><h3>My policies</h3>
            ${state.policies.length?state.policies.map(p=>policyHtml(p)).join(''):'<div class="hc-muted">No policies imported yet. Ask your insurer for an HJI client setup code.</div>'}
          </div>`;
    }

    function renderClientView(){
        if(!overlay)return;
        const body=overlay.querySelector('.hc-body');
        if(!body)return;

        body.innerHTML=currentClientView==='claims' ? claimsViewHtml() : policiesViewHtml();

        if(currentClientView==='claims'){
            body.querySelector('#hc-new-claim')?.addEventListener('click',claimModal);
            body.querySelector('#hc-sync-status')?.addEventListener('click',syncClaimStatuses);
        }else{
            body.querySelector('#hc-settings')?.addEventListener('click',settingsModal);
            body.querySelector('#hc-import')?.addEventListener('click',importModal);
            body.querySelectorAll('[data-remove-policy]').forEach(b=>b.onclick=()=>removePolicy(b.dataset.removePolicy));
        }
    }

    function open(view=null){
        styles();
        try{
            autoFillCurrentUser();
            if(view) currentClientView=view;

            if(overlay)overlay.remove();
            overlay=document.createElement('div');
            overlay.id='hji-client-overlay';
            overlay.innerHTML=`<div id="hji-client-app">
              <div class="hc-head">
                <div><h2>🛡️ My Happy Jump Insurance</h2><div class="hc-muted">v${esc(VERSION)} · drag this header · resize from the lower-right</div></div>
                <div class="hc-head-actions"><button class="hc-size">Size</button><button class="hc-close">Close</button></div>
              </div>
              ${clientTabsHtml()}
              <div class="hc-body"></div>
              <div class="hc-resize-grip" title="Drag to resize"></div>
            </div>`;

            document.body.appendChild(overlay);

            const app=overlay.querySelector('#hji-client-app');
            overlay.querySelector('.hc-close').onclick=()=>{overlay.remove();overlay=null};
            overlay.querySelector('.hc-size').onclick=()=>app.classList.toggle('hc-compact');

            overlay.querySelectorAll('[data-client-tab]').forEach(b=>{
                b.onclick=()=>{
                    currentClientView=b.dataset.clientTab;
                    open(currentClientView);
                };
            });

            makeDraggable(app,overlay.querySelector('.hc-head'),'windowPos');
            makeResizable(app,overlay.querySelector('.hc-resize-grip'),'windowSize');
            renderClientView();
        }catch(e){
            console.error('[HJI Client] UI error:',e);
            if(overlay)overlay.innerHTML=`<div id="hji-client-app"><div class="hc-body"><div class="hc-help"><strong>HJI Client UI error</strong><p>${esc(e?.message||e)}</p></div></div></div>`;
        }
    }

    function policyHtml(p){
        const [label,rowClass,statusClass]=policyStatus(p);
        const ownerMatch=policyOwnerMatches(p);
        const ownerLine=ownerMatch===false?`<div class="hc-help" style="margin-top:8px;background:#452b2b;border-color:#7b4848"><strong>Policy-owner mismatch</strong><p>This policy was issued to ${esc(p.insuredName||'Unknown')} [${esc(p.insuredId||'')}], but this Client is set to ${esc(state.claimantName||'Unknown')} [${esc(state.claimantId||'')}].</p></div>`:'';
        return `<div class="hc-card ${rowClass}">
          <div class="hc-grid">
            <div class="hc-field"><small>Provider</small>${esc(p.providerName||'')} [${esc(p.providerId||'')}]</div>
            <div class="hc-field"><small>Tier</small>${esc(p.tierName||'')}</div>
            <div class="hc-field"><small>Coverage</small>${esc(p.coverage||'—')}</div>
            <div class="hc-field"><small>${p.type==='single'?'Policy type':'Valid until'}</small>${p.type==='single'?'Single jump':dateOnly(p.endDate)}</div>
            <div class="hc-field"><small>Status</small><span class="${statusClass}">${label}</span></div>
            <div class="hc-field"><small>Issued to</small>${esc(p.insuredName||'')} [${esc(p.insuredId||'')}]</div>
          </div>${ownerLine}
          <div class="hc-actions"><button class="hc-btn danger" data-remove-policy="${esc(p.localId)}">Remove from this device</button></div>
        </div>`;
    }

    function importModal(){
        const body=overlay.querySelector('.hc-body');
        body.innerHTML=`<div class="hc-card"><h3>Import policy</h3>
          <div class="hc-help"><p>Paste the setup code provided by your insurer. It contains policy information, not their API key.</p></div>
          <div class="hc-form"><label class="wide">Setup code<textarea id="hi-code" placeholder="HJI1...."></textarea></label></div>
          <div class="hc-actions"><button class="hc-btn good" id="hi-import">Import policy</button><button class="hc-btn" id="hi-back">Back</button></div>
        </div>`;
        body.querySelector('#hi-back').onclick=open;
        body.querySelector('#hi-import').onclick=()=>{
            try{
                const obj=decodeSetup(body.querySelector('#hi-code').value);
                if(state.claimantId&&String(state.claimantId)!==String(obj.insured.id)){
                    if(!confirm(`This policy was issued to Torn ID ${obj.insured.id}, but your client is set to ${state.claimantId}. Import it anyway?`))return;
                }
                if(!state.claimantId)state.claimantId=String(obj.insured.id);
                if(!state.claimantName)state.claimantName=obj.insured.name||'';
                const p={
                    localId:`${obj.provider.id}:${obj.policy.id}`,
                    providerId:String(obj.provider.id),providerName:obj.provider.name||'',
                    insuredId:String(obj.insured.id),insuredName:obj.insured.name||'',
                    policyId:String(obj.policy.id),tierId:String(obj.policy.tierId||''),tierName:obj.policy.tierName||'',
                    type:obj.policy.type||'monthly',coverage:obj.policy.coverage||'',maxDvds:Number(obj.policy.maxDvds||0),
                    startDate:obj.policy.startDate||null,endDate:obj.policy.endDate||null,cashPrice:Number(obj.policy.cashPrice||0),
                    itemName:obj.policy.itemName||'',itemQty:Number(obj.policy.itemQty||0),issuedAt:obj.issuedAt||null,importedAt:new Date().toISOString()
                };
                const idx=state.policies.findIndex(x=>x.localId===p.localId);
                if(idx>=0)state.policies[idx]=p;else state.policies.push(p);
                save();alert(`Imported ${p.tierName} from ${p.providerName}.`);open();
            }catch(e){alert('Could not import setup code:\n\n'+e.message)}
        };
    }

    function removePolicy(localId){
        const p=state.policies.find(x=>x.localId===localId);
        if(!p)return;
        if(!confirm(`Remove ${p.tierName} from ${p.providerName} from this device?`))return;
        state.policies=state.policies.filter(x=>x.localId!==localId);save();open();
    }

    function settingsModal(){
        const body=overlay.querySelector('.hc-body');
        const detected=detectCurrentTornUser();
        const keyUrl='https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=Happy%20Jump%20Insurance%20Client%20Status&user=messages';

        body.innerHTML=`<div class="hc-card"><h3>Client settings</h3>
          <div class="hc-help">
            <p>The Client does <b>not</b> need an API key to import policies or submit claims.</p>
            <p>An API key is optional and is used only if you want the Client to scan Torn Mail topics for claim-status updates from your provider.</p>
          </div>

          <div class="hc-form">
            <label>Your Torn name<input id="cs-cname" value="${esc(state.claimantName||'')}"></label>
            <label>Your Torn ID<input id="cs-cid" inputmode="numeric" value="${esc(state.claimantId||'')}"></label>

            <label class="wide">Optional status-sync API key
              <div style="display:flex;gap:7px">
                <input id="cs-status-key" type="password" value="${esc(state.settings.statusApiKey||'')}" placeholder="Optional">
                <button class="hc-btn" type="button" id="cs-show-key">Show</button>
              </div>
            </label>
          </div>

          <div class="hc-actions">
            <button class="hc-btn" id="cs-detect">Detect My Torn Account</button>
            <button class="hc-btn" id="cs-key-builder">Generate status-sync key</button>
            <button class="hc-btn good" id="cs-save">Save</button>
            <button class="hc-btn" id="cs-back">Back</button>
          </div>

          <div class="hc-muted" style="margin-top:8px">
            ${detected?`Detected from ${esc(detected.source)}: ${esc(detected.name||'Unknown')} [${esc(detected.id)}]`:'No account details were detected from the current Torn page yet.'}
          </div>
        </div>`;

        const keyInput=body.querySelector('#cs-status-key');

        body.querySelector('#cs-show-key').onclick=()=>{
            const showing=keyInput.type==='text';
            keyInput.type=showing?'password':'text';
            body.querySelector('#cs-show-key').textContent=showing?'Show':'Hide';
        };

        body.querySelector('#cs-detect').onclick=()=>{
            const found=detectCurrentTornUser();
            if(!found)return alert('Could not detect your Torn account from the current page. You can still enter the fields manually.');
            body.querySelector('#cs-cid').value=found.id;
            if(found.name)body.querySelector('#cs-cname').value=found.name;
            state.claimantId=found.id;
            if(found.name)state.claimantName=found.name;
            save();
            alert(`Detected ${found.name||'Torn user'} [${found.id}]`);
        };

        body.querySelector('#cs-key-builder').onclick=()=>{
            const a=document.createElement('a');
            a.href=keyUrl;
            a.target='_blank';
            a.rel='noopener noreferrer';
            document.body.appendChild(a);
            a.click();
            a.remove();
        };

        body.querySelector('#cs-save').onclick=()=>{
            state.claimantName=body.querySelector('#cs-cname').value.trim();
            state.claimantId=body.querySelector('#cs-cid').value.trim();
            state.settings.statusApiKey=keyInput.value.trim();
            save();
            open('policies');
        };

        body.querySelector('#cs-back').onclick=()=>open('policies');
    }

    function claimModal(){
        if(!state.policies.length)return alert('Import a policy first.');
        if(!/^\d+$/.test(state.claimantId))return alert('Set your Torn ID in Settings first.');
        const body=overlay.querySelector('.hc-body');
        const ref=claimRef();
        body.innerHTML=`<div class="hc-card"><h3>Submit a claim</h3>
          <div class="hc-help"><p>Select the policy/provider involved. The Client prepares Torn Mail for you; it does not press Send automatically.</p></div>
          <div class="hc-form">
            <label class="wide">Policy<select id="cc-policy">${state.policies.map(p=>`<option value="${esc(p.localId)}">${esc(p.providerName)} — ${esc(p.tierName)}</option>`).join('')}</select></label>
            <label>Claim reference<input id="cc-ref" value="${esc(ref)}" readonly></label>
            <label>Your Torn ID<input value="${esc(state.claimantId)}" readonly></label>
            <label class="wide">Claim details<textarea id="cc-details" placeholder="Add the details the provider needs to review this claim."></textarea></label>
            <label class="wide">Optional evidence / Torn link<textarea id="cc-evidence" placeholder="Paste any relevant Torn link or reference here."></textarea></label>
          </div>
          <div class="hc-actions"><button class="hc-btn good" id="cc-mail">Prepare Torn Mail</button><button class="hc-btn" id="cc-back">Cancel</button></div>
        </div>`;
        body.querySelector('#cc-back').onclick=open;
        body.querySelector('#cc-mail').onclick=()=>{
            const p=state.policies.find(x=>x.localId===body.querySelector('#cc-policy').value);
            if(!p)return alert('Select a policy.');
            if(policyOwnerMatches(p)===false){if(!confirm(`This policy was issued to ${p.insuredName||'Unknown'} [${p.insuredId}], but this Client is set to ${state.claimantName||'Unknown'} [${state.claimantId}].\n\nPrepare the claim anyway?`))return;}
            const reference=body.querySelector('#cc-ref').value.trim();
            const details=body.querySelector('#cc-details').value.trim();
            const evidence=body.querySelector('#cc-evidence').value.trim();
            if(!details)return alert('Add some claim details first.');
            const subject=`${CLAIM_PREFIX} ${reference}`;
            const msg=[
                CLAIM_PREFIX,
                `Claim Reference: ${reference}`,
                `Claimant Name: ${state.claimantName}`,
                `Claimant ID: ${state.claimantId}`,
                `Provider Name: ${p.providerName}`,
                `Provider ID: ${p.providerId}`,
                `Policy ID: ${p.policyId}`,
                `Tier: ${p.tierName}`,
                `Submitted: ${new Date().toISOString()}`,
                '',
                'Claim Details:',details,'',
                'Evidence / Link:',evidence||'None supplied','',
                `HJI Client v${VERSION}`
            ].join('\n');
            state.claims.push({reference,createdAt:new Date().toISOString(),providerId:p.providerId,providerName:p.providerName,policyId:p.policyId,summary:details.slice(0,120),status:'prepared'});save();
            storage.set('pending_mail',{providerId:p.providerId,subject,body:msg,createdAt:Date.now()});
            copyText(`${subject}\n\n${msg}`).finally(()=>{
                window.location.href=`https://www.torn.com/messages.php#/p=compose&XID=${encodeURIComponent(p.providerId)}`;
                setTimeout(()=>tryFillPendingMail(),1000);
            });
        };
    }

    async function copyText(text){
        try{await navigator.clipboard.writeText(text)}catch{
            const t=document.createElement('textarea');t.value=text;t.style.position='fixed';t.style.opacity='0';document.body.appendChild(t);t.select();try{document.execCommand('copy')}catch{}t.remove();
        }
    }

    let mailFillInProgress = false;
    let lastHandledPendingMail = null;

    function tryFillPendingMail(){
        const p=storage.get('pending_mail',null);
        if(!p || !location.href.includes('messages.php')) return;

        if(Date.now()-Number(p.createdAt||0)>10*60*1000){
            storage.set('pending_mail',null);
            return;
        }

        const pendingKey=`${p.createdAt||''}:${p.providerId||''}:${p.subject||''}`;
        if(mailFillInProgress || lastHandledPendingMail===pendingKey) return;

        mailFillInProgress=true;
        let tries=0;

        const finish=(handled=false)=>{
            mailFillInProgress=false;
            lastHandledPendingMail=pendingKey;
            storage.set('pending_mail',null);
            if(!handled){
                alert('Torn Mail was opened and the complete claim was copied to your clipboard. Paste it into the composer if Torn/PDA did not allow automatic filling.');
            }
        };

        const timer=setInterval(()=>{
            tries++;

            if(!location.href.includes('messages.php')){
                clearInterval(timer);
                mailFillInProgress=false;
                return;
            }

            const inputs=[...document.querySelectorAll('input')];
            const textareas=[...document.querySelectorAll('textarea')];
            const subject=inputs.find(x=>
                /subject/i.test(x.placeholder||'') ||
                /subject/i.test(x.name||'') ||
                /subject/i.test(x.getAttribute('aria-label')||'')
            );
            const body=textareas.find(x=>x.offsetParent!==null) ||
                       document.querySelector('[contenteditable="true"]');

            let subjectReady=false;
            let bodyReady=false;

            if(subject){
                if(!subject.value) setNativeValue(subject,p.subject);
                subjectReady=String(subject.value||'').trim().length>0;
            }

            if(body){
                if(body.tagName==='TEXTAREA'){
                    if(!body.value) setNativeValue(body,p.body);
                    bodyReady=String(body.value||'').trim().length>0;
                }else if(body.isContentEditable){
                    if(!body.textContent){
                        body.focus();
                        try{document.execCommand('insertText',false,p.body)}catch{}
                        body.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:p.body}));
                    }
                    bodyReady=String(body.textContent||'').trim().length>0;
                }
            }

            if(subjectReady && bodyReady){
                clearInterval(timer);
                finish(true);
                return;
            }

            if(tries>=20){
                clearInterval(timer);
                finish(false);
            }
        },500);
    }

    function setNativeValue(el,value){
        const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
        const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;
        if(setter)setter.call(el,value);else el.value=value;
        el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));
    }

    function launcher(){
        styles();if(document.getElementById('hji-client-launch'))return;
        const b=document.createElement('button');b.id='hji-client-launch';b.textContent='🛡 My Insurance';document.body.appendChild(b);
        makeDraggable(b,b,'launcherPos',open);
        b.title='Tap to open. Drag to move.';
    }

    function boot(){
        if (!document.body) return;
        autoFillCurrentUser();
        launcher();
        tryFillPendingMail();
    }

    function startObserver(){
        const target = document.documentElement || document.body;
        if (!target || typeof target.nodeType !== 'number') {
            setTimeout(startObserver, 250);
            return;
        }
        const observer = new MutationObserver(()=>{
            if(document.body && !document.getElementById('hji-client-launch') && !overlay) launcher();
            if(location.href.includes('messages.php')) tryFillPendingMail();
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
