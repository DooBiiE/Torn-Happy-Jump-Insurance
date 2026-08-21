// ==UserScript==
// @name         Torn Happy Jump Insurance Manager
// @namespace    torn-hji
// @version      0.3.6
// @description  Provider-side Happy Jump insurance policy and claims manager for Torn.
// @author       YourName
// @match        https://www.torn.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=torn.com
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      api.torn.com
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/YOUR_GITHUB/YOUR_REPO/main/torn-hji-manager.user.js
// @updateURL    https://raw.githubusercontent.com/YOUR_GITHUB/YOUR_REPO/main/torn-hji-manager.user.js
// ==/UserScript==

(() => {
    'use strict';

    const APP = 'HJI Manager';
    const VERSION = '0.3.6';
    const PREFIX = 'torn_hji_manager_v1_';
    const CLAIM_PREFIX = '[HJI CLAIM]';
    const API_BASE = 'https://api.torn.com/v2';

    const storage = {
        get(key, fallback) {
            const full = PREFIX + key;
            try {
                if (typeof GM_getValue === 'function') {
                    const v = GM_getValue(full, undefined);
                    if (v !== undefined) return v;
                }
            } catch {}
            try {
                const raw = localStorage.getItem(full);
                return raw == null ? fallback : JSON.parse(raw);
            } catch {
                return fallback;
            }
        },
        set(key, value) {
            const full = PREFIX + key;
            try { if (typeof GM_setValue === 'function') GM_setValue(full, value); } catch {}
            try { localStorage.setItem(full, JSON.stringify(value)); } catch {}
        }
    };

    const uid = (prefix='id') => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
    const nowISO = () => new Date().toISOString();
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const money = n => Number(n || 0).toLocaleString('en-GB', {maximumFractionDigits: 0});
    const dateOnly = v => v ? new Date(v).toLocaleDateString('en-GB') : '—';

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

    let state = {
        tiers: storage.get('tiers', null) || defaultTiers,
        customers: storage.get('customers', []),
        policies: storage.get('policies', []),
        payments: storage.get('payments', []),
        claims: storage.get('claims', []),
        settings: storage.get('settings', {
            providerId: '',
            providerName: '',
            apiKey: '',
            dueSoonDays: 3,
            claimPollMinutes: 10,
            lastMailScan: null
        })
    };

    function saveAll() {
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
        #hji-launcher{position:fixed;right:16px;bottom:18px;z-index:999999;background:#20252b;color:#fff;border:1px solid #666;border-radius:999px;padding:10px 14px;font:600 13px Arial;box-shadow:0 3px 14px #0008;cursor:pointer}
        #hji-overlay{position:fixed;inset:0;z-index:1000000;background:#0009;display:flex;align-items:center;justify-content:center;padding:10px}
        #hji-app{width:min(1150px,98vw);height:min(820px,94vh);background:#171a1f;color:#ddd;border:1px solid #555;border-radius:10px;overflow:hidden;font:14px Arial;display:flex;flex-direction:column}
        .hji-head{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:#23272e;border-bottom:1px solid #444}
        .hji-head h2{margin:0;color:#fff;font-size:18px}.hji-close{background:#3b414b;color:#fff;border:0;border-radius:6px;padding:7px 11px;cursor:pointer}
        .hji-tabs{display:flex;gap:4px;overflow:auto;padding:8px;background:#1d2025;border-bottom:1px solid #393d43}
        .hji-tab{white-space:nowrap;background:#2b3037;color:#ddd;border:1px solid #444;border-radius:6px;padding:8px 10px;cursor:pointer}.hji-tab.active{background:#555f6d;color:#fff}
        .hji-body{padding:12px;overflow:auto;flex:1}.hji-grid{display:grid;grid-template-columns:repeat(4,minmax(140px,1fr));gap:10px}
        .hji-card{background:#22262c;border:1px solid #3d424a;border-radius:8px;padding:12px}.hji-card b{display:block;color:#fff;font-size:18px;margin-top:5px}
        .hji-toolbar{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}.hji-btn{background:#3a414b;color:#fff;border:1px solid #59616d;border-radius:6px;padding:8px 10px;cursor:pointer}.hji-btn.danger{background:#653535}.hji-btn.good{background:#315d3e}
        .hji-table{width:100%;border-collapse:collapse;background:#20242a}.hji-table th,.hji-table td{padding:9px 8px;text-align:center;vertical-align:middle;color:var(--hji-text)}
        .hji-table thead tr{border-bottom:2px solid #666}
        .hji-table tbody tr{border-bottom:1px solid #555}
        .hji-table tbody tr:last-child{border-bottom:0}
        .hji-table td .hji-toolbar{justify-content:center}.hji-table th{background:#2a2f36;color:#fff;position:sticky;top:0}
        .hji-status{font-weight:700}.hji-active{color:#72d88b}.hji-due{color:#f5d06f}.hji-expired{color:#ff8585}.hji-pending{color:#f5d06f}
        .hji-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.hji-form label{display:flex;flex-direction:column;gap:5px}.hji-form .wide{grid-column:1/-1}
        .hji-form input,.hji-form select,.hji-form textarea{box-sizing:border-box;width:100%;background:#111419;color:#fff;border:1px solid #555;border-radius:6px;padding:9px}.hji-form textarea{min-height:80px}
        .hji-modal-bg{position:absolute;inset:0;background:#000b;display:flex;align-items:center;justify-content:center;padding:12px}.hji-modal{width:min(620px,96vw);max-height:88vh;overflow:auto;background:#22262c;border:1px solid #666;border-radius:8px;padding:14px}
        .hji-modal h3{margin-top:0;color:#fff}.hji-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}.hji-muted{color:#999;font-size:12px}.hji-pill{display:inline-block;padding:3px 7px;border-radius:999px;background:#343a42}
        @media(max-width:700px){#hji-launcher{right:9px;bottom:10px}.hji-grid{grid-template-columns:repeat(2,1fr)}.hji-form{grid-template-columns:1fr}.hji-form .wide{grid-column:auto}.hji-table{font-size:12px}.hji-table th,.hji-table td{padding:6px}#hji-app{height:96vh;width:99vw}}
        `;
        document.head.appendChild(s);
    }

    function policyStatus(p) {
        if (p.status === 'cancelled') return ['Cancelled','hji-muted'];
        if (p.type === 'single') return p.used ? ['Used','hji-muted'] : ['Active','hji-active'];
        if (!p.endDate) return ['Active','hji-active'];
        const end = new Date(p.endDate).getTime();
        const diff = end - Date.now();
        if (diff < 0) return ['Expired','hji-expired'];
        if (diff <= Number(state.settings.dueSoonDays || 3) * 86400000) return ['Due soon','hji-due'];
        return ['Active','hji-active'];
    }

    function getCustomer(id) { return state.customers.find(x => x.id === id); }
    function getTier(id) { return state.tiers.find(x => x.id === id); }
    function getPolicy(id) { return state.policies.find(x => x.id === id); }

    let currentTab = 'dashboard';
    let overlay = null;

    function openApp(tab='dashboard') {
        injectStyles();
        currentTab = tab;
        if (overlay) overlay.remove();
        overlay = document.createElement('div');
        overlay.id = 'hji-overlay';
        overlay.innerHTML = `<div id="hji-app">
          <div class="hji-head"><div><h2>🛡️ Happy Jump Insurance Manager</h2><div class="hji-muted">v${esc(VERSION)} · local manager database</div></div><button class="hji-close">Close</button></div>
          <div class="hji-tabs"></div><div class="hji-body"></div>
        </div>`;
        document.body.appendChild(overlay);
        overlay.querySelector('.hji-close').onclick = () => { overlay.remove(); overlay=null; };
        renderTabs();
        renderTab();
    }

    function renderTabs() {
        const tabs = [
            ['dashboard','Dashboard'],['customers','Customers'],['policies','Policies'],
            ['payments','Payments'],['claims','Claims'],['tiers','Tiers'],['settings','Settings']
        ];
        const el = overlay.querySelector('.hji-tabs');
        el.innerHTML = tabs.map(([id,label]) => `<button class="hji-tab ${id===currentTab?'active':''}" data-tab="${id}">${label}${id==='claims' ? ` (${state.claims.filter(c=>c.status==='submitted').length})` : ''}</button>`).join('');
        el.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { currentTab=b.dataset.tab; renderTabs(); renderTab(); });
    }

    function renderTab() {
        const body = overlay.querySelector('.hji-body');
        ({dashboard:renderDashboard,customers:renderCustomers,policies:renderPolicies,payments:renderPayments,claims:renderClaims,tiers:renderTiers,settings:renderSettings}[currentTab] || renderDashboard)(body);
    }

    function renderDashboard(body) {
        const statuses = state.policies.map(policyStatus).map(x=>x[0]);
        const active = statuses.filter(x=>x==='Active').length;
        const due = statuses.filter(x=>x==='Due soon').length;
        const expired = statuses.filter(x=>x==='Expired').length;
        const pendingClaims = state.claims.filter(c=>c.status==='submitted').length;
        const monthAgo = Date.now()-30*86400000;
        const revenue = state.payments.filter(p=>new Date(p.date).getTime()>=monthAgo && p.method==='cash').reduce((s,p)=>s+Number(p.amount||0),0);
        body.innerHTML = `
        <div class="hji-grid">
          <div class="hji-card">Active policies<b>${active}</b></div>
          <div class="hji-card">Due soon<b>${due}</b></div>
          <div class="hji-card">Expired<b>${expired}</b></div>
          <div class="hji-card">Open claims<b>${pendingClaims}</b></div>
        </div>
        <div style="height:10px"></div>
        <div class="hji-card">Cash payments recorded in last 30 days<b>$${money(revenue)}</b></div>
        <div style="height:10px"></div>
        <div class="hji-card"><strong>Quick start</strong><p>1. Set provider ID/API key in Settings. 2. Edit Tiers. 3. Add a customer. 4. Create a policy. 5. Use “Scan Torn Mail” in Claims to import structured client claims.</p></div>`;
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

    function renderPolicies(body) {
        body.innerHTML = `<div class="hji-toolbar"><button class="hji-btn good" id="hji-add-policy">+ Add policy</button></div>
        <table class="hji-table"><thead><tr><th>Customer</th><th>Tier</th><th>Started</th><th>Ends / Use</th><th>Status</th><th></th></tr></thead><tbody>
        ${state.policies.map(p=>{const c=getCustomer(p.customerId),t=getTier(p.tierId),st=policyStatus(p); return `<tr><td>${esc(c?.name||'Unknown')}</td><td>${esc(t?.name||p.tierName||'Unknown')}</td><td>${dateOnly(p.startDate)}</td><td>${p.type==='single'?(p.used?'Used':'Not used'):dateOnly(p.endDate)}</td><td class="hji-status ${st[1]}">${st[0]}</td><td><button class="hji-btn" data-edit-policy="${p.id}">Edit</button></td></tr>`}).join('') || '<tr><td colspan="6">No policies yet.</td></tr>'}
        </tbody></table>`;
        body.querySelector('#hji-add-policy').onclick=()=>policyModal();
        body.querySelectorAll('[data-edit-policy]').forEach(b=>b.onclick=()=>policyModal(getPolicy(b.dataset.editPolicy)));
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
        body.innerHTML=`<div class="hji-toolbar"><button class="hji-btn good" id="hji-add-payment">+ Record payment</button></div>
        <table class="hji-table"><thead><tr><th>Date</th><th>Customer</th><th>Method</th><th>Amount</th><th>Notes</th></tr></thead><tbody>
        ${[...state.payments].sort((a,b)=>new Date(b.date)-new Date(a.date)).map(p=>{const c=getCustomer(p.customerId);return `<tr><td>${dateOnly(p.date)}</td><td>${esc(c?.name||'Unknown')}</td><td>${esc(p.method)}</td><td>${p.method==='cash'?'$'+money(p.amount):`${esc(p.itemQty)} × ${esc(p.itemName)}`}</td><td>${esc(p.notes||'')}</td></tr>`}).join('')||'<tr><td colspan="5">No payments recorded.</td></tr>'}
        </tbody></table>`;
        body.querySelector('#hji-add-payment').onclick=()=>paymentModal();
    }

    function paymentModal(){
        if(!state.customers.length)return alert('Add a customer first.');
        const modal=createModal('Record payment');
        modal.content.innerHTML+=`<div class="hji-form">
          <label>Customer<select id="pay-c">${state.customers.map(c=>`<option value="${c.id}">${esc(c.name)} [${esc(c.tornId)}]</option>`).join('')}</select></label>
          <label>Date<input type="date" id="pay-date" value="${new Date().toISOString().slice(0,10)}"></label>
          <label>Method<select id="pay-method"><option value="cash">Cash</option><option value="item">Item</option></select></label>
          <label>Cash amount<input id="pay-amount" inputmode="numeric" value="0"></label>
          <label>Item name<input id="pay-item" value=""></label><label>Item quantity<input id="pay-qty" inputmode="numeric" value="0"></label>
          <label class="wide">Notes<textarea id="pay-notes"></textarea></label>
        </div>`;
        modal.addSave(()=>{state.payments.push({id:uid('payment'),customerId:modal.el.querySelector('#pay-c').value,date:new Date(modal.el.querySelector('#pay-date').value+'T00:00:00').toISOString(),method:modal.el.querySelector('#pay-method').value,amount:Number(modal.el.querySelector('#pay-amount').value||0),itemName:modal.el.querySelector('#pay-item').value.trim(),itemQty:Number(modal.el.querySelector('#pay-qty').value||0),notes:modal.el.querySelector('#pay-notes').value.trim(),createdAt:nowISO()});saveAll();modal.close();renderTab();});
    }

    function renderClaims(body) {
        body.innerHTML=`<div class="hji-toolbar"><button class="hji-btn good" id="hji-scan-mail">↻ Scan Torn Mail</button><button class="hji-btn" id="hji-add-claim">+ Manual claim</button></div>
        <div class="hji-muted" style="margin-bottom:8px">Last scan: ${state.settings.lastMailScan?new Date(state.settings.lastMailScan).toLocaleString('en-GB'):'Never'}. Imported claims are matched by claimant Torn ID where possible.</div>
        <table class="hji-table"><thead><tr><th>Reference</th><th>Claimant</th><th>Submitted</th><th>Tier / Policy</th><th>Status</th><th></th></tr></thead><tbody>
        ${[...state.claims].sort((a,b)=>new Date(b.submittedAt)-new Date(a.submittedAt)).map(c=>`<tr><td>${esc(c.reference)}</td><td>${esc(c.claimantName||'')} [${esc(c.claimantId||'')}]</td><td>${dateOnly(c.submittedAt)}</td><td>${esc(c.tierName||'')}</td><td class="hji-status ${c.status==='submitted'?'hji-pending':c.status==='approved'?'hji-active':c.status==='rejected'?'hji-expired':''}">${esc(c.status)}</td><td><button class="hji-btn" data-view-claim="${c.id}">View</button></td></tr>`).join('')||'<tr><td colspan="6">No claims yet.</td></tr>'}
        </tbody></table>`;
        body.querySelector('#hji-scan-mail').onclick=scanMail;
        body.querySelector('#hji-add-claim').onclick=()=>manualClaimModal();
        body.querySelectorAll('[data-view-claim]').forEach(b=>b.onclick=()=>claimModal(state.claims.find(c=>c.id===b.dataset.viewClaim)));
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

    function claimModal(c){
        const modal=createModal(`Claim ${c.reference}`);
        modal.content.innerHTML+=`<div class="hji-card">
          <b style="font-size:14px">${esc(c.claimantName||'')} [${esc(c.claimantId||'')}]</b>
          <p><strong>Tier:</strong> ${esc(c.tierName||'—')}</p>
          <p><strong>Submitted:</strong> ${esc(new Date(c.submittedAt).toLocaleString('en-GB'))}</p>
          <p><strong>Source:</strong> ${esc(c.source||'')}</p>
          <p><strong>Details</strong></p><pre style="white-space:pre-wrap">${esc(c.details||c.rawBody||'')}</pre>
        </div><div class="hji-form" style="margin-top:10px"><label>Status<select id="cl-status">${['submitted','reviewing','approved','rejected','paid','closed'].map(x=>`<option value="${x}" ${c.status===x?'selected':''}>${x}</option>`).join('')}</select></label><label>Provider note<input id="cl-note" value="${esc(c.providerNote||'')}"></label></div>`;
        modal.addSave(()=>{c.status=modal.el.querySelector('#cl-status').value;c.providerNote=modal.el.querySelector('#cl-note').value.trim();c.updatedAt=nowISO();saveAll();modal.close();renderTab();renderTabs();});
    }

    function renderTiers(body) {
        body.innerHTML=`<div class="hji-toolbar"><button class="hji-btn good" id="hji-add-tier">+ Add tier</button></div>
        <table class="hji-table"><thead><tr><th>Name</th><th>Type</th><th>Coverage</th><th>Cash</th><th>Alternative item</th><th></th></tr></thead><tbody>
        ${state.tiers.map(t=>`<tr><td>${esc(t.name)} ${!t.active?'<span class="hji-pill">Disabled</span>':''}</td><td>${esc(t.type)}</td><td>${esc(t.coverage)}</td><td>$${money(t.cashPrice)}</td><td>${t.itemName?`${esc(t.itemQty)} × ${esc(t.itemName)}`:'—'}</td><td><button class="hji-btn" data-edit-tier="${t.id}">Edit</button></td></tr>`).join('')}
        </tbody></table>`;
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
          <label>Cash price<input id="tier-cash" inputmode="numeric" value="${esc(existing?.cashPrice??0)}"></label>
          <label>Enabled<select id="tier-active"><option value="1">Yes</option><option value="0" ${existing?.active===false?'selected':''}>No</option></select></label>
          <label>Alternative item<input id="tier-item" value="${esc(existing?.itemName||'')}"></label>
          <label>Item quantity<input id="tier-qty" inputmode="numeric" value="${esc(existing?.itemQty??0)}"></label>
        </div>`;
        modal.addSave(()=>{const data={name:modal.el.querySelector('#tier-name').value.trim(),type:modal.el.querySelector('#tier-type').value,durationDays:Number(modal.el.querySelector('#tier-days').value||0),maxDvds:Number(modal.el.querySelector('#tier-dvds').value||0),coverage:modal.el.querySelector('#tier-cover').value.trim(),cashPrice:Number(modal.el.querySelector('#tier-cash').value||0),active:modal.el.querySelector('#tier-active').value==='1',itemName:modal.el.querySelector('#tier-item').value.trim(),itemQty:Number(modal.el.querySelector('#tier-qty').value||0)};if(!data.name)return alert('Tier name is required.');if(existing)Object.assign(existing,data);else state.tiers.push({id:uid('tier'),...data});saveAll();modal.close();renderTab();});
    }

    function renderSettings(body){
        body.innerHTML=`<div class="hji-form">
          <label>Provider Torn name<input id="set-name" value="${esc(state.settings.providerName||'')}"></label>
          <label>Provider Torn ID<input id="set-id" inputmode="numeric" value="${esc(state.settings.providerId||'')}"></label>
          <label class="wide">Torn API key <span class="hji-muted">Used only to read the provider's own Torn mail for claim imports.</span><input id="set-key" type="password" value="${esc(state.settings.apiKey||'')}"></label>
          <label>Due soon warning (days)<input id="set-due" inputmode="numeric" value="${esc(state.settings.dueSoonDays||3)}"></label>
          <label>Claim scan interval hint (minutes)<input id="set-poll" inputmode="numeric" value="${esc(state.settings.claimPollMinutes||10)}"></label>
        </div>
        <div class="hji-toolbar" style="margin-top:12px"><button class="hji-btn good" id="set-save">Save settings</button><button class="hji-btn" id="set-keydocs">Open Torn custom key builder</button><button class="hji-btn" id="set-export">Export backup</button><button class="hji-btn" id="set-import">Import backup</button></div>
        <p class="hji-muted">The manager's database is stored locally in the script/browser. Export backups regularly. API keys are never placed in claim messages.</p>`;
        body.querySelector('#set-save').onclick=()=>{Object.assign(state.settings,{providerName:body.querySelector('#set-name').value.trim(),providerId:body.querySelector('#set-id').value.trim(),apiKey:body.querySelector('#set-key').value.trim(),dueSoonDays:Number(body.querySelector('#set-due').value||3),claimPollMinutes:Number(body.querySelector('#set-poll').value||10)});saveAll();alert('Saved.');};
        body.querySelector('#set-keydocs').onclick=()=>window.open('https://www.torn.com/preferences.php#tab=api?step=addNewKey&user=messages&title=Happy%20Jump%20Insurance%20Manager','_blank');
        body.querySelector('#set-export').onclick=()=>{const blob=new Blob([JSON.stringify({version:VERSION,exportedAt:nowISO(),state},null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`torn-hji-backup-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);};
        body.querySelector('#set-import').onclick=()=>{const inp=document.createElement('input');inp.type='file';inp.accept='.json,application/json';inp.onchange=()=>{const f=inp.files[0];if(!f)return;const r=new FileReader();r.onload=()=>{try{const obj=JSON.parse(r.result);if(!obj.state)throw new Error('Missing state');if(!confirm('Replace current local HJI manager data with this backup?'))return;state=obj.state;saveAll();renderTabs();renderTab();alert('Backup imported.');}catch(e){alert('Import failed: '+e.message)}};r.readAsText(f)};inp.click();};
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

    function walkMessages(obj, out=[]) {
        if (!obj || typeof obj!=='object') return out;
        if (Array.isArray(obj)) { obj.forEach(v=>walkMessages(v,out)); return out; }
        const keys=Object.keys(obj);
        const hasText=keys.some(k=>/message|body|text/i.test(k));
        const hasTitle=keys.some(k=>/title|subject/i.test(k));
        if (hasText || hasTitle) out.push(obj);
        Object.values(obj).forEach(v=>{if(v&&typeof v==='object')walkMessages(v,out)});
        return out;
    }

    function pick(obj, patterns) {
        for (const [k,v] of Object.entries(obj||{})) if (patterns.some(rx=>rx.test(k)) && (typeof v==='string'||typeof v==='number')) return v;
        return '';
    }

    function parseClaimText(subject, body, raw) {
        const all=`${subject}\n${body}`;
        if (!all.includes(CLAIM_PREFIX) && !/HJI-[A-Z0-9_-]+/i.test(all)) return null;
        const find=(label)=>{const m=all.match(new RegExp(`^${label}\\s*:\\s*(.+)$`,'im'));return m?m[1].trim():''};
        const ref=(all.match(/HJI-[A-Z0-9_-]+/i)||[])[0] || find('Claim Reference') || uid('HJI').toUpperCase();
        return {
            reference:ref,
            claimantId:find('Claimant ID') || String(pick(raw,[/sender.*id/i,/user.*id/i,/player.*id/i,/from.*id/i])||''),
            claimantName:find('Claimant Name') || String(pick(raw,[/sender.*name/i,/user.*name/i,/player.*name/i,/from.*name/i])||''),
            tierName:find('Tier') || find('Policy'),
            details:body || all,
            submittedAt: (()=>{const ts=pick(raw,[/timestamp/i,/date/i,/time/i]);if(typeof ts==='number')return new Date(ts*1000).toISOString();return nowISO();})(),
            status:'submitted',
            source:'torn-mail',
            rawBody:body
        };
    }

    async function scanMail() {
        const btn=overlay.querySelector('#hji-scan-mail');
        if (!state.settings.apiKey) return alert('Add the provider Torn API key in Settings first.');
        if (btn) {btn.disabled=true;btn.textContent='Scanning…';}
        try {
            let data;
            try {
                data=await requestApi(`${API_BASE}/user/newmessages`,state.settings.apiKey);
            } catch {
                data=await requestApi(`${API_BASE}/user/messages?limit=100`,state.settings.apiKey);
            }
            if (data?.error) throw new Error(data.error.error || data.error.message || JSON.stringify(data.error));
            const objs=walkMessages(data);
            let added=0;
            for(const m of objs){
                const subject=String(pick(m,[/subject/i,/title/i])||'');
                const body=String(pick(m,[/^message$/i,/body/i,/text/i,/content/i])||'');
                const c=parseClaimText(subject,body,m);
                if(!c)continue;
                if(state.claims.some(x=>x.reference===c.reference))continue;
                c.id=uid('claim');
                const customer=state.customers.find(x=>String(x.tornId)===String(c.claimantId));
                if(customer){c.customerId=customer.id;if(!c.claimantName)c.claimantName=customer.name;const p=state.policies.find(p=>p.customerId===customer.id && policyStatus(p)[0]!=='Expired' && p.status!=='cancelled');if(p){c.policyId=p.id;c.tierName=c.tierName||getTier(p.tierId)?.name||p.tierName;}}
                state.claims.push(c); added++;
            }
            state.settings.lastMailScan=nowISO();saveAll();alert(`Mail scan complete. ${added} new claim${added===1?'':'s'} imported.`);renderTab();renderTabs();
        } catch(e) { alert(`Could not scan Torn Mail.\n\n${e.message}\n\nCheck the API key has access to your messages.`); }
        finally { if(btn){btn.disabled=false;btn.textContent='↻ Scan Torn Mail';} }
    }

    function addLauncher(){
        injectStyles();
        if(document.getElementById('hji-launcher'))return;
        const b=document.createElement('button');b.id='hji-launcher';b.textContent='🛡 HJI Manager';b.onclick=()=>openApp();document.body.appendChild(b);
    }

    function boot(){ addLauncher(); }
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
    new MutationObserver(()=>{if(document.body&&!document.getElementById('hji-launcher')&&!overlay)addLauncher();}).observe(document.documentElement,{childList:true,subtree:true});
})();
