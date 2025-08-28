(async function(){
  const el = document.getElementById("member-qr-widget"); if (!el) return;
  const s = document.currentScript;
  const API = s.getAttribute("data-api") || (location.origin.replace(/\/$/,'') + "/api");
  const BRAND = s.getAttribute("data-brand") || "Your Brand";
  let email = s.getAttribute("data-email") || "";
  const TOKEN = s.getAttribute("data-token") || "";

  function h(tag, attrs={}, kids=[]) {
    const e=document.createElement(tag);
    Object.entries(attrs).forEach(([k,v])=> e.setAttribute(k,v));
    (Array.isArray(kids)?kids:[kids]).forEach(c=> e.appendChild(typeof c==="string"?document.createTextNode(c):c));
    return e;
  }
  function promptEmail(){ el.innerHTML="";
    const box=h("div",{style:"border:1px solid #e2e8f0;padding:16px;border-radius:12px;max-width:520px"});
    box.append(h("h3",{},BRAND+" — Member Perks"));
    box.append(h("p",{},"Enter your membership email to view your monthly perks."));
    const inp=h("input",{type:"email",placeholder:"email@example.com",style:"width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px"});
    const btn=h("button",{style:"margin-top:8px;padding:10px 14px;border-radius:8px;border:1px solid #1e293b;background:#1e293b;color:#fff"},"Show my perks");
    btn.onclick=()=>{ email=inp.value.trim(); load(); };
    box.append(inp,btn); el.append(box);
  }
  async function load(){
    if(!email) return promptEmail();
    el.innerHTML="Loading…";
    try{
      const headers = TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {};
      const r=await fetch(API+"/my-codes?email="+encodeURIComponent(email), { headers });
      const j=await r.json();
      if(j.reason==="inactive_membership"){ el.innerHTML="<p>Your membership is not active.</p>"; return; }
      const codes=j.codes||[]; if(!codes.length){ el.innerHTML="<p>No available perks.</p>"; return; }
      const grid=h("div",{style:"display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));"});
      for(const c of codes){
        const card=h("div",{style:"border:1px solid #e2e8f0;border-radius:12px;padding:16px"});
        card.append(h("h4",{},c.benefit_label));
        const canv=h("div",{style:"width:200px;height:200px;margin:auto"}); card.append(canv);
        const badge=c.display_policy==="always_show"?"Valid all month":"Single-use";
        card.append(h("p",{style:"font-size:12px;opacity:0.8;text-align:center;margin-top:8px"},badge));
        const url=location.origin.replace(/\/$/,'')+"/redeem?code="+encodeURIComponent(c.code);
        try{
          const m=await import("https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js");
          const canvas=document.createElement("canvas"); canv.append(canvas);
          await m.default.toCanvas(canvas, url, { width:200, margin:1 });
        }catch(e){ canv.append(h("a",{href:url}, "Open redemption link")); }
        grid.append(card);
      }
      el.innerHTML=""; el.append(grid);
    }catch(e){ el.innerHTML="<p>Could not load perks.</p>"; }
  }
  load();
})();
