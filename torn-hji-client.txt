// ==UserScript==
// @name         Torn Happy Jump Insurance Client
// @namespace    torn-hji
// @version      0.1.0
// @description  Insured-user client for viewing Happy Jump cover and preparing structured Torn Mail claims.
// @author       YourName
// @match        https://www.torn.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=torn.com
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/YOUR_GITHUB/YOUR_REPO/main/torn-hji-client.user.js
// @updateURL    https://raw.githubusercontent.com/YOUR_GITHUB/YOUR_REPO/main/torn-hji-client.user.js
// ==/UserScript==

(() => {
    'use strict';

    const VERSION=(typeof GM_info!=='undefined'&&GM_info?.script?.version)||'0.1.0';
    const PREFIX='torn_hji_client_v1_';
    const CLAIM_PREFIX='[HJI CLAIM]';
    const storage={
        get(k,f){const key=PREFIX+k;try{if(typeof GM_getValue==='function'){const v=GM_getValue(key,undefined);if(v!==undefined)return v}}catch{}try{const r=localStorage.getItem(key);return r==null?f:JSON.parse(r)}catch{return f}},
        set(k,v){const key=PREFIX+k;try{if(typeof GM_setValue==='function')GM_setValue(key,v)}catch{}try{localStorage.setItem(key,JSON.stringify(v))}catch{}}
    };
    const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const state=storage.get('state',{
        providerId:'',
        providerName:'',
        claimantId:'',
        claimantName:'',
        policyTier:'',
        coverage:'',
        validUntil:'',
        notes:'',
        claims:[]
    });
    const save=()=>storage.set('state',state);
    const claimRef=()=>`HJI-${new Date().toISOString().slice(0,10).replaceAll('-','')}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;

    function styles(){
        if(document.getElementById('hji-client-style'))return;
        const s=document.createElement('style');s.id='hji-client-style';s.textContent=`
        #hji-client-launch{position:fixed;right:16px;bottom:18px;z-index:999999;background:#20252b;color:#fff;border:1px solid #666;border-radius:999px;padding:10px 14px;font:600 13px Arial;box-shadow:0 3px 14px #0008;cursor:pointer}
        #hji-client-overlay{position:fixed;inset:0;z-index:1000000;background:#0009;display:flex;align-items:center;justify-content:center;padding:10px}
        #hji-client-app{width:min(720px,98vw);max-height:94vh;overflow:auto;background:#181b20;color:#ddd;border:1px solid #555;border-radius:10px;font:14px Arial}
        .hc-head{display:flex;justify-content:space-between;align-items:center;padding:13px;background:#242930;border-bottom:1px solid #444}.hc-head h2{margin:0;color:#fff;font-size:18px}
        .hc-body{padding:13px}.hc-card{background:#22262c;border:1px solid #3e444d;border-radius:8px;padding:12px;margin-bottom:10px}.hc-card h3{margin:0 0 8px;color:#fff}
        .hc-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.hc-field{background:#171a1f;padding:9px;border-radius:6px}.hc-field small{display:block;color:#999;margin-bottom:3px}
        .hc-btn{background:#3a414b;color:#fff;border:1px solid #59616d;border-radius:6px;padding:9px 11px;cursor:pointer}.hc-btn.good{background:#315d3e}.hc-close{background:#3b414b;color:#fff;border:0;border-radius:6px;padding:7px 10px}
        .hc-form{display:grid;grid-template-columns:1fr 1fr;gap:9px}.hc-form label{display:flex;flex-direction:column;gap:5px}.hc-form .wide{grid-column:1/-1}.hc-form input,.hc-form textarea{box-sizing:border-box;width:100%;background:#111419;color:#fff;border:1px solid #555;border-radius:6px;padding:9px}.hc-form textarea{min-height:90px}.hc-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.hc-muted{font-size:12px;color:#999}
        @media(max-width:600px){#hji-client-launch{right:9px;bottom:10px}.hc-grid,.hc-form{grid-template-columns:1fr}.hc-form .wide{grid-column:auto}}
        `;document.head.appendChild(s);
    }

    let overlay=null;
    function open(){
        styles();if(overlay)overlay.remove();
        overlay=document.createElement('div');overlay.id='hji-client-overlay';overlay.innerHTML=`<div id="hji-client-app">
          <div class="hc-head"><div><h2>🛡️ My Happy Jump Insurance</h2><div class="hc-muted">v${esc(VERSION)}</div></div><button class="hc-close">Close</button></div>
          <div class="hc-body">
            <div class="hc-card"><h3>My cover</h3>
              <div class="hc-grid">
                <div class="hc-field"><small>Provider</small>${esc(state.providerName||'Not configured')} ${state.providerId?`[${esc(state.providerId)}]`:''}</div>
                <div class="hc-field"><small>Tier</small>${esc(state.policyTier||'Not configured')}</div>
                <div class="hc-field"><small>Coverage</small>${esc(state.coverage||'—')}</div>
                <div class="hc-field"><small>Valid until</small>${esc(state.validUntil||'—')}</div>
              </div>
              <div class="hc-actions"><button class="hc-btn good" id="hc-claim">Submit claim</button><button class="hc-btn" id="hc-settings">Settings</button></div>
            </div>
            <div class="hc-card"><h3>My submitted claims</h3>
              ${state.claims.length?state.claims.slice().reverse().map(c=>`<div class="hc-field" style="margin-bottom:6px"><strong>${esc(c.reference)}</strong><br><small>${esc(new Date(c.createdAt).toLocaleString('en-GB'))} · prepared for Torn Mail</small>${esc(c.summary||'')}</div>`).join(''):'<div class="hc-muted">No claims prepared yet.</div>'}
            </div>
          </div>
        </div>`;
        document.body.appendChild(overlay);
        overlay.querySelector('.hc-close').onclick=()=>{overlay.remove();overlay=null};
        overlay.querySelector('#hc-settings').onclick=settingsModal;
        overlay.querySelector('#hc-claim').onclick=claimModal;
    }

    function settingsModal(){
        const body=overlay.querySelector('.hc-body');
        body.innerHTML=`<div class="hc-card"><h3>Client settings</h3><div class="hc-form">
          <label>Provider name<input id="cs-pname" value="${esc(state.providerName)}"></label>
          <label>Provider Torn ID<input id="cs-pid" inputmode="numeric" value="${esc(state.providerId)}"></label>
          <label>Your Torn name<input id="cs-cname" value="${esc(state.claimantName)}"></label>
          <label>Your Torn ID<input id="cs-cid" inputmode="numeric" value="${esc(state.claimantId)}"></label>
          <label>Insurance tier<input id="cs-tier" value="${esc(state.policyTier)}"></label>
          <label>Valid until<input id="cs-until" type="date" value="${esc(state.validUntil)}"></label>
          <label class="wide">What's included / coverage<textarea id="cs-cover">${esc(state.coverage)}</textarea></label>
          <label class="wide">Notes<textarea id="cs-notes">${esc(state.notes)}</textarea></label>
        </div><div class="hc-actions"><button class="hc-btn good" id="cs-save">Save</button><button class="hc-btn" id="cs-back">Back</button></div>
        <p class="hc-muted">Version 0.1 stores policy details locally. A later version can add a provider-issued setup code so insured users do not need to type these values manually.</p></div>`;
        body.querySelector('#cs-save').onclick=()=>{Object.assign(state,{providerName:body.querySelector('#cs-pname').value.trim(),providerId:body.querySelector('#cs-pid').value.trim(),claimantName:body.querySelector('#cs-cname').value.trim(),claimantId:body.querySelector('#cs-cid').value.trim(),policyTier:body.querySelector('#cs-tier').value.trim(),validUntil:body.querySelector('#cs-until').value,coverage:body.querySelector('#cs-cover').value.trim(),notes:body.querySelector('#cs-notes').value.trim()});save();open();};
        body.querySelector('#cs-back').onclick=open;
    }

    function claimModal(){
        if(!/^\d+$/.test(state.providerId))return alert('Set the provider Torn ID in Settings first.');
        if(!/^\d+$/.test(state.claimantId))return alert('Set your Torn ID in Settings first.');
        const body=overlay.querySelector('.hc-body');
        const ref=claimRef();
        body.innerHTML=`<div class="hc-card"><h3>Submit a claim</h3><div class="hc-form">
          <label>Claim reference<input id="cc-ref" value="${esc(ref)}" readonly></label>
          <label>Tier<input id="cc-tier" value="${esc(state.policyTier)}"></label>
          <label class="wide">What happened? / claim details<textarea id="cc-details" placeholder="Add the details the provider needs to review this claim."></textarea></label>
          <label class="wide">Optional evidence / Torn link<textarea id="cc-evidence" placeholder="Paste any relevant Torn link or reference here."></textarea></label>
        </div><div class="hc-actions"><button class="hc-btn good" id="cc-mail">Prepare Torn Mail</button><button class="hc-btn" id="cc-back">Cancel</button></div>
        <p class="hc-muted">The client prepares a structured Torn Mail claim. You remain in control of sending the message through Torn.</p></div>`;
        body.querySelector('#cc-back').onclick=open;
        body.querySelector('#cc-mail').onclick=()=>{
            const reference=body.querySelector('#cc-ref').value.trim();
            const tier=body.querySelector('#cc-tier').value.trim();
            const details=body.querySelector('#cc-details').value.trim();
            const evidence=body.querySelector('#cc-evidence').value.trim();
            if(!details)return alert('Add some claim details first.');
            const subject=`${CLAIM_PREFIX} ${reference}`;
            const msg=[
                CLAIM_PREFIX,
                `Claim Reference: ${reference}`,
                `Claimant Name: ${state.claimantName}`,
                `Claimant ID: ${state.claimantId}`,
                `Provider Name: ${state.providerName}`,
                `Provider ID: ${state.providerId}`,
                `Tier: ${tier}`,
                `Submitted: ${new Date().toISOString()}`,
                '',
                'Claim Details:',
                details,
                '',
                'Evidence / Link:',
                evidence || 'None supplied',
                '',
                `HJI Client v${VERSION}`
            ].join('\n');
            state.claims.push({reference,createdAt:new Date().toISOString(),summary:details.slice(0,120)});save();
            storage.set('pending_mail',{providerId:state.providerId,subject,body:msg,createdAt:Date.now()});
            copyText(`${subject}\n\n${msg}`).finally(()=>{
                window.location.href=`https://www.torn.com/messages.php#/p=compose&XID=${encodeURIComponent(state.providerId)}`;
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
            const body=textareas.find(x=>x.offsetParent!==null) || document.querySelector('[contenteditable="true"]');
            let changed=false;
            if(subject&&!subject.value){setNativeValue(subject,p.subject);changed=true;}
            if(body){
                if(body.tagName==='TEXTAREA'&&!body.value){setNativeValue(body,p.body);changed=true;}
                else if(body.isContentEditable&&!body.textContent){body.focus();document.execCommand('insertText',false,p.body);body.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:p.body}));changed=true;}
            }
            if((subject&&body)||tries>20){
                clearInterval(timer);
                if(subject&&body)storage.set('pending_mail',null);
                else if(tries>20)alert('I opened Torn Mail and copied the claim to your clipboard. The current Torn/PDA composer could not be auto-filled, so paste it into the message manually.');
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
        const b=document.createElement('button');b.id='hji-client-launch';b.textContent='🛡 My Insurance';b.onclick=open;document.body.appendChild(b);
    }

    function boot(){launcher();tryFillPendingMail();}
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
    new MutationObserver(()=>{if(document.body&&!document.getElementById('hji-client-launch')&&!overlay)launcher();if(location.href.includes('messages.php'))tryFillPendingMail();}).observe(document.documentElement,{childList:true,subtree:true});
})();
