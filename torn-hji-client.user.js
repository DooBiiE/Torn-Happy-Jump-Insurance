// ==UserScript==
// @name         Torn Happy Jump Insurance Client
// @namespace    torn-hji
// @version      0.3.2
// @description  Insured-user client for importing Happy Jump policies and preparing structured Torn Mail claims.
// @author       DooBiiE
// @match        https://www.torn.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=torn.com
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/DooBiiE/Torn-Happy-Jump-Insurance/main/torn-hji-client.user.js
// @updateURL    https://raw.githubusercontent.com/DooBiiE/Torn-Happy-Jump-Insurance/main/torn-hji-client.user.js
// ==/UserScript==

(() => {
    'use strict';

    const VERSION = '0.3.2';
    const PREFIX='torn_hji_client_v2_';
    const LEGACY_PREFIX='torn_hji_client_v1_';
    const CLAIM_PREFIX='[HJI CLAIM]';

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
    const save=()=>storage.set('state',state);

    function styles(){
        if(document.getElementById('hji-client-style'))return;
        const s=document.createElement('style');s.id='hji-client-style';s.textContent=`
        #hji-client-launch{position:fixed;left:16px;bottom:18px;z-index:999999;background:#20252b;color:#fff;border:1px solid #666;border-radius:999px;padding:10px 14px;font:600 13px Arial;box-shadow:0 3px 14px #0008;cursor:grab;user-select:none;touch-action:none}
        #hji-client-launch:active{cursor:grabbing}
        #hji-client-overlay{position:fixed;inset:0;z-index:1000000;background:transparent;pointer-events:none}
        #hji-client-app{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(700px,90vw);height:min(620px,78vh);min-width:300px;min-height:300px;max-width:97vw;max-height:92vh;overflow:hidden;background:#181b20;color:#ddd;border:1px solid #555;border-radius:10px;font:14px Arial;box-shadow:0 12px 35px #000b;pointer-events:auto;resize:both;display:flex;flex-direction:column}
        #hji-client-app.hc-compact{width:min(560px,86vw);height:min(500px,66vh)}
        .hc-head{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:12px;background:#242930;border-bottom:1px solid #444;cursor:move;user-select:none;touch-action:none}.hc-head h2{margin:0;color:#fff;font-size:18px}.hc-head-actions{display:flex;gap:6px}
        .hc-body{padding:13px;overflow:auto;flex:1}.hc-card{background:#22262c;border:1px solid #3e444d;border-radius:8px;padding:12px;margin-bottom:10px}.hc-card h3{margin:0 0 8px;color:#fff}
        .hc-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.hc-field{background:#171a1f;padding:9px;border-radius:6px}.hc-field small{display:block;color:#999;margin-bottom:3px}
        .hc-btn{background:#3a414b;color:#fff;border:1px solid #59616d;border-radius:6px;padding:9px 11px;cursor:pointer}.hc-btn.good{background:#315d3e}.hc-btn.danger{background:#653535}.hc-close,.hc-size{background:#3b414b;color:#fff;border:0;border-radius:6px;padding:7px 10px;cursor:pointer}
        .hc-form{display:grid;grid-template-columns:1fr 1fr;gap:9px}.hc-form label{display:flex;flex-direction:column;gap:5px}.hc-form .wide{grid-column:1/-1}.hc-form input,.hc-form select,.hc-form textarea{box-sizing:border-box;width:100%;background:#111419;color:#fff;border:1px solid #555;border-radius:6px;padding:9px}.hc-form textarea{min-height:90px}
        .hc-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.hc-muted{font-size:12px;color:#aaa}.hc-policy{border-left:4px solid #59616d}.hc-resize-grip{position:absolute;right:0;bottom:0;width:28px;height:28px;z-index:20;cursor:nwse-resize;touch-action:none}.hc-resize-grip:after{content:'↘';position:absolute;right:5px;bottom:3px;color:#aaa;font-size:17px;}
        .hc-help{background:#1b2229;border:1px solid #405165;border-radius:8px;padding:10px;margin-bottom:10px}.hc-help p{margin:5px 0}.hc-help details{margin-top:6px}.hc-help summary{cursor:pointer;font-weight:700}
        @media(max-width:600px){#hji-client-launch{left:9px;bottom:10px;padding:9px 12px}#hji-client-app{width:90vw;height:72vh;max-height:82vh;resize:both}#hji-client-app.hc-compact{width:84vw;height:60vh}.hc-grid,.hc-form{grid-template-columns:1fr}.hc-form .wide{grid-column:auto}.hc-head h2{font-size:15px}}
        `;document.head.appendChild(s);
    }

    let overlay=null;
    function open(){
        styles();
        try{
            if(overlay)overlay.remove();
            overlay=document.createElement('div');overlay.id='hji-client-overlay';overlay.innerHTML=`<div id="hji-client-app">
              <div class="hc-head">
                <div><h2>🛡️ My Happy Jump Insurance</h2><div class="hc-muted">v${esc(VERSION)} · drag this header · resize from the lower-right</div></div>
                <div class="hc-head-actions"><button class="hc-size" title="Toggle a smaller window">Size</button><button class="hc-close">Close</button></div>
              </div>
              <div class="hc-body">
                <div class="hc-help"><strong>How this works</strong><p>Your insurer gives you an HJI setup code. Import it here, then choose that policy when you need to prepare a claim.</p><details><summary>Can I use more than one insurer?</summary><p>Yes. You can import several policies from different providers and choose the correct one when making a claim.</p></details></div>
                <div class="hc-actions" style="margin:0 0 10px"><button class="hc-btn good" id="hc-import">Import policy setup code</button><button class="hc-btn" id="hc-claim" ${state.policies.length?'':'disabled'}>Submit claim</button><button class="hc-btn" id="hc-settings">Settings</button></div>
                <div class="hc-card"><h3>My policies</h3>
                  ${state.policies.length?state.policies.map(p=>policyHtml(p)).join(''):'<div class="hc-muted">No policies imported yet. Ask your insurer for an HJI client setup code.</div>'}
                </div>
                <div class="hc-card"><h3>My prepared claims</h3>
                  ${state.claims.length?state.claims.slice().reverse().map(c=>`<div class="hc-field" style="margin-bottom:6px"><strong>${esc(c.reference)}</strong><br><small>${esc(new Date(c.createdAt).toLocaleString('en-GB'))} · ${esc(c.providerName||'')}</small>${esc(c.summary||'')}</div>`).join(''):'<div class="hc-muted">No claims prepared yet.</div>'}
                </div>
              </div>
              <div class="hc-resize-grip" title="Drag to resize"></div>
            </div>`;
            document.body.appendChild(overlay);
            const app=overlay.querySelector('#hji-client-app');
            overlay.querySelector('.hc-close').onclick=()=>{overlay.remove();overlay=null};
            overlay.querySelector('.hc-size').onclick=()=>app.classList.toggle('hc-compact');
            makeDraggable(app,overlay.querySelector('.hc-head'),'windowPos');
            makeResizable(app,overlay.querySelector('.hc-resize-grip'),'windowSize');
            overlay.querySelector('#hc-settings').onclick=settingsModal;
            overlay.querySelector('#hc-import').onclick=importModal;
            overlay.querySelector('#hc-claim').onclick=claimModal;
            overlay.querySelectorAll('[data-remove-policy]').forEach(b=>b.onclick=()=>removePolicy(b.dataset.removePolicy));
        }catch(e){
            console.error('[HJI Client] UI error:',e);
            if(overlay)overlay.innerHTML=`<div id="hji-client-app"><div class="hc-body"><div class="hc-help"><strong>HJI Client UI error</strong><p>${esc(e?.message||e)}</p></div></div></div>`;
        }
    }

    function policyHtml(p){
        return `<div class="hc-card hc-policy">
          <div class="hc-grid">
            <div class="hc-field"><small>Provider</small>${esc(p.providerName||'')} [${esc(p.providerId||'')}]</div>
            <div class="hc-field"><small>Tier</small>${esc(p.tierName||'')}</div>
            <div class="hc-field"><small>Coverage</small>${esc(p.coverage||'—')}</div>
            <div class="hc-field"><small>${p.type==='single'?'Policy type':'Valid until'}</small>${p.type==='single'?'Single jump':dateOnly(p.endDate)}</div>
          </div>
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
        body.innerHTML=`<div class="hc-card"><h3>Client settings</h3>
          <div class="hc-help"><p>Your Torn ID is used to check that an imported policy was actually issued to you. The Client does not need the insurer's API key.</p></div>
          <div class="hc-form">
            <label>Your Torn name<input id="cs-cname" value="${esc(state.claimantName||'')}"></label>
            <label>Your Torn ID<input id="cs-cid" inputmode="numeric" value="${esc(state.claimantId||'')}"></label>
          </div>
          <div class="hc-actions"><button class="hc-btn good" id="cs-save">Save</button><button class="hc-btn" id="cs-back">Back</button></div>
        </div>`;
        body.querySelector('#cs-save').onclick=()=>{state.claimantName=body.querySelector('#cs-cname').value.trim();state.claimantId=body.querySelector('#cs-cid').value.trim();save();open();};
        body.querySelector('#cs-back').onclick=open;
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
            state.claims.push({reference,createdAt:new Date().toISOString(),providerId:p.providerId,providerName:p.providerName,policyId:p.policyId,summary:details.slice(0,120)});save();
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

    function tryFillPendingMail(){
        const p=storage.get('pending_mail',null);
        if(!p||Date.now()-p.createdAt>10*60*1000)return;
        if(!location.href.includes('messages.php'))return;
        let tries=0;
        const timer=setInterval(()=>{
            tries++;
            const inputs=[...document.querySelectorAll('input')];
            const textareas=[...document.querySelectorAll('textarea')];
            const subject=inputs.find(x=>/subject/i.test(x.placeholder||'')||/subject/i.test(x.name||'')||/subject/i.test(x.getAttribute('aria-label')||''));
            const body=textareas.find(x=>x.offsetParent!==null)||document.querySelector('[contenteditable="true"]');
            if(subject&&!subject.value)setNativeValue(subject,p.subject);
            if(body){
                if(body.tagName==='TEXTAREA'&&!body.value)setNativeValue(body,p.body);
                else if(body.isContentEditable&&!body.textContent){body.focus();document.execCommand('insertText',false,p.body);body.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:p.body}))}
            }
            if((subject&&body)||tries>20){
                clearInterval(timer);
                if(subject&&body)storage.set('pending_mail',null);
                else if(tries>20)alert('Torn Mail was opened and the complete claim was copied to your clipboard. Paste it into the composer if Torn/PDA did not allow automatic filling.');
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
