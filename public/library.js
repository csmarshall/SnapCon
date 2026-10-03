// public/library.js — the Library (docs/library-design.md §13.2, M5): the
// grid of Models, search and filters, the Model page and Needs attention.
// A page inside the app like Health: /library, /library/m/<uuid>,
// /library/attention, with its own small router. Loaded after app.js and
// uses its globals ($, esc, t, tn, fmtDuration, FLEET, the role helpers, and
// the File Browser's own selection + Send/Queue dialogs for printing).
//
// Read-only: nothing here edits a Model (that is M6). Everything shown comes
// from the index (/api/library/*), so browsing never reads a file on the NAS;
// thumbnails come from the Library's local cache.
"use strict";
(function(){
  const PAGE=60;
  const L={
    open:false, view:null, uuid:null, syncing:false, req:0,
    filters:{ q:"", printer:"", location:"", type:"", material:"", attention:false, sort:"name" },
    models:[], next:null, total:0, facets:null, overview:null, loadingMore:false,
    // Back from a Model returns to the same cards at the same place.
    gridKept:false, gridScroll:0,
  };

  // ---- data ----
  async function api(url){
    const r=await fetch(url);
    if(typeof checkAuthFailure==="function") checkAuthFailure(r);
    const body=await r.json().catch(()=>({}));
    if(!r.ok){ const e=new Error(body.error||("HTTP "+r.status)); e.status=r.status; e.code=body.code; throw e; }
    return body;
  }
  const thumbUrl=k=>"/api/library/thumbs/"+encodeURIComponent(k);
  const stem=n=>String(n||"").replace(/(\.gcode)?\.(gcode|gco|g|bgcode|3mf|stl|obj|step|stp|png|jpe?g|webp|pdf)$/i,"");
  const fmtG=g=>g==null?null:(g>=1000?(g/1000).toFixed(2)+" kg":(g>=10?Math.round(g):g.toFixed(1))+" g");

  // Printers of the fleet that can print a family, and how many are idle
  // ("Fits my idle printers" is applied here, §14).
  const BUSY_STATES=["printing","paused","error","maintenance","updating","rebooting"];
  function fleetFit(family){
    const ps=(typeof FLEET!=="undefined"&&Array.isArray(FLEET)?FLEET:[]).filter(p=>p.printerFamily&&p.printerFamily===family);
    return { printers:ps, idle:ps.filter(p=>p.online&&!BUSY_STATES.includes(p.state)) };
  }

  // ---- page frame ----
  function hideFleet(hide){
    document.querySelectorAll(".main > .sechead, .main > .jobcard, .main > .jobloading, #fleet-wrap").forEach(el=>el.style.display=hide?"none":"");
  }
  function openPage(path, push){
    if(!L.open){
      if(typeof closeQueueDashboard==="function") closeQueueDashboard();
      if(typeof closeHealthPage==="function") closeHealthPage();
      L.open=true;
      $("libraryPage").classList.add("show");
      hideFleet(true);
      $("libraryBtn").title=t("global.topbar.back_to_fleet_title");
      $("libraryBtn").setAttribute("aria-pressed","true");
    }
    route(path||"/library", push);
  }
  function closePage(){
    if(!L.open) return;
    L.open=false; L.req++; L.gridKept=false;
    $("libraryPage").classList.remove("show");
    hideFleet(false);
    $("libraryBtn").title=t("library.title");
    $("libraryBtn").setAttribute("aria-pressed","false");
    if(!L.syncing && /^\/library/i.test(location.pathname)) history.pushState(null,"","/");
    if(typeof applyRoleUI==="function") applyRoleUI();
  }
  function go(path){ route(path,true); }
  function route(path, push){
    const m=/^\/library\/m\/([0-9a-f-]{36})\/?$/i.exec(path);
    const view=m?"model":/^\/library\/attention\/?$/i.test(path)?"attention":"grid";
    if(push && !L.syncing && location.pathname!==path) history.pushState(null,"",path);
    const pageEl=$("libraryPage");
    if(L.view==="grid" && view!=="grid" && L.models.length){ L.gridKept=true; L.gridScroll=pageEl?pageEl.scrollTop:0; }
    L.view=view; L.uuid=m?m[1].toLowerCase():null;
    if(pageEl) pageEl.scrollTop=0;
    render();
  }
  window.addEventListener("popstate",()=>{
    const onLib=/^\/library/i.test(location.pathname);
    L.syncing=true;
    try{ if(!onLib){ closePage(); return; } openPage(location.pathname,false); }
    finally{ L.syncing=false; }
  });

  function render(){
    const root=$("libraryPage");
    if(!root) return;
    root.innerHTML=`<div class="lib-shell">
      <div class="lib-bars" id="libBars"></div>
      <div id="libBody"><div class="lib-loading">${esc(t("library.loading"))}</div></div></div>`;
    loadOverview();
    if(L.view==="model") renderModel(L.uuid);
    else if(L.view==="attention") renderAttention();
    else renderGrid();
  }

  // Offline locations, indexing, and the way to Needs attention: shown on
  // every Library view.
  async function loadOverview(){
    const token=L.req;
    try{ L.overview=await api("/api/library/overview"); }catch(e){ L.overview=null; return renderBars(e); }
    if(token!==L.req) return;
    renderBars();
  }
  function renderBars(err){
    const el=$("libBars"); if(!el) return;
    if(err){ el.innerHTML=err.code==="library_unavailable"||err.status===503?`<div class="lib-bar is-bad">${esc(t("library.unavailable"))}</div>`:""; return; }
    const o=L.overview; if(!o) return;
    const off=o.roots.filter(r=>r.offline);
    const ix=o.indexing;
    const idx=ix&&(ix.scanning||ix.queued||ix.hashing);
    el.innerHTML=
      off.map(r=>`<div class="lib-bar is-warn" role="status"><span class="lib-bar-dot"></span>
        <span>${esc(t("library.offline_bar",{name:r.name}))}</span>
        ${isAdmin()?`<button type="button" class="btn ghost btn-sm lib-recheck" data-root="${esc(r.id)}">${esc(t("library.recheck"))}</button>`:""}</div>`).join("")+
      (idx?`<div class="lib-pill" role="status"><span class="lib-spin"></span>${esc(ix.scanning?t("library.indexing_scan",{name:(o.roots.find(r=>r.id===ix.scanning.rootId)||{}).name||""}):ix.hashing?t("library.indexing_hash",{n:ix.hashing.remaining??"…"}):t("library.indexing"))}</div>`:"");
    el.querySelectorAll(".lib-recheck").forEach(b=>b.addEventListener("click",async()=>{
      b.disabled=true; b.textContent=t("library.rechecking");
      try{ await fetch("/api/library/roots/"+encodeURIComponent(b.dataset.root)+"/rescan",{method:"POST"}); }catch{}
      setTimeout(loadOverview,1500);
    }));
    const n=$("libAttnCount");
    if(n){ const c=o.attention||{}; const k=(c.action||0)+(c.review||0); n.textContent=k?String(k):""; n.style.display=k?"":"none"; n.classList.toggle("is-bad",!!c.action); }
  }

  // ---- grid ----
  function filterQS(f, extra){
    const p=new URLSearchParams();
    if(f.q) p.set("q",f.q);
    if(f.printer) p.set("printer",f.printer);
    if(f.location) p.set("location",f.location);
    if(f.type) p.set("type",f.type);
    if(f.material) p.set("material",f.material);
    if(f.attention) p.set("attention","1");
    if(f.sort&&f.sort!=="name") p.set("sort",f.sort);
    for(const [k,v] of Object.entries(extra||{})) if(v!=null) p.set(k,v);
    return p.toString();
  }
  async function renderGrid(){
    const body=$("libBody");
    const f=L.filters;
    body.innerHTML=`
      <div class="lib-head">
        <div class="lib-title"><h1>${esc(t("library.title"))}</h1><span class="lib-count" id="libCount"></span></div>
        <a class="lib-attn-link" href="/library/attention" id="libAttnLink">${esc(t("library.needs_attention"))}<span class="lib-attn-n" id="libAttnCount" style="display:none"></span></a>
      </div>
      <div class="lib-filters" role="search">
        <div class="lib-search"><label class="fl" for="libQ">${esc(t("library.search_label"))}</label>
          <input class="field" id="libQ" type="search" autocomplete="off" placeholder="${esc(t("library.search_placeholder"))}" value="${esc(f.q)}"></div>
        <div class="lib-f"><label class="fl" for="libPrinter">${esc(t("library.f_printer"))}</label><select class="field" id="libPrinter"></select></div>
        <div class="lib-f"><label class="fl" for="libLocation">${esc(t("library.f_location"))}</label><select class="field" id="libLocation"></select></div>
        <div class="lib-f"><label class="fl" for="libType">${esc(t("library.f_type"))}</label><select class="field" id="libType"></select></div>
        <div class="lib-f"><label class="fl" for="libMaterial">${esc(t("library.f_material"))}</label><select class="field" id="libMaterial"></select></div>
        <div class="lib-f"><label class="fl" for="libSort">${esc(t("library.f_sort"))}</label><select class="field" id="libSort">
          <option value="name">${esc(t("library.sort_name"))}</option><option value="recent">${esc(t("library.sort_recent"))}</option></select></div>
        <div class="lib-f lib-f-check">${checkboxHtml("libAttention", f.attention, t("library.f_attention"), "", false)}</div>
      </div>
      <div class="lib-active" id="libActive"></div>
      <div class="lib-grid" id="libGrid" aria-live="polite"></div>
      <div class="lib-more" id="libMore"></div>`;
    $("libSort").value=f.sort;
    if(L.overview) renderBars();
    let debounce=null;
    $("libQ").addEventListener("input",()=>{ clearTimeout(debounce); debounce=setTimeout(()=>{ f.q=$("libQ").value.trim(); loadModels(true); },220); });
    for(const [id,key] of [["libPrinter","printer"],["libLocation","location"],["libType","type"],["libMaterial","material"],["libSort","sort"]]){
      $(id).addEventListener("change",()=>{ f[key]=$(id).value; loadModels(true); });
    }
    $("libAttention").addEventListener("change",()=>{ f.attention=$("libAttention").checked; loadModels(true); });
    $("libAttnLink").addEventListener("click",e=>{ e.preventDefault(); go("/library/attention"); });
    if(L.gridKept && L.models.length){
      // Back from a Model: the same cards, the same place, no new requests.
      L.gridKept=false;
      applyFacets();
      showCards(0, true);
      const pageEl=$("libraryPage");
      if(pageEl) requestAnimationFrame(()=>{ pageEl.scrollTop=L.gridScroll; });
      return;
    }
    await loadFacets();
    loadModels(true);
  }
  async function loadFacets(){
    try{ L.facets=await api("/api/library/facets"); }catch{ L.facets=null; }
    applyFacets();
  }
  function applyFacets(){
    const fc=L.facets||{families:[],roots:[],types:[],materials:[]}, f=L.filters;
    const opts=(sel, all, items, val)=>{ const el=$(sel); if(!el) return;
      el.innerHTML=`<option value="">${esc(all)}</option>`+items.map(i=>`<option value="${esc(i.v)}">${esc(i.l)} (${i.n})</option>`).join("");
      el.value=items.some(i=>i.v===val)?val:""; };
    opts("libPrinter", t("library.f_any_printer"), fc.families.map(x=>({v:x.key,l:x.label||x.key,n:x.count})), f.printer);
    opts("libLocation", t("library.f_any_location"), fc.roots.map(x=>({v:x.id,l:x.name,n:x.count})), f.location);
    opts("libType", t("library.f_any_type"), fc.types.map(x=>({v:x.key,l:t("library.type_"+x.key),n:x.count})), f.type);
    opts("libMaterial", t("library.f_any_material"), fc.materials.map(x=>({v:x.key,l:x.key,n:x.count})), f.material);
  }
  async function loadModels(reset){
    const token=++L.req;
    const grid=$("libGrid"); if(!grid) return;
    if(reset){ L.models=[]; L.next=null; grid.setAttribute("aria-busy","true"); }
    let res;
    try{ res=await api("/api/library/models?"+filterQS(L.filters,{limit:PAGE, cursor:reset?null:L.next})); }
    catch(e){ if(token===L.req){ grid.removeAttribute("aria-busy"); grid.innerHTML=`<div class="lib-empty">${esc(e.status===503?t("library.unavailable"):t("library.load_failed"))}</div>`; } return; }
    if(token!==L.req||!$("libGrid")) return;
    grid.removeAttribute("aria-busy");
    L.total=res.total; L.next=res.next;
    const start=L.models.length;
    L.models=L.models.concat(res.models);
    showCards(start, reset);
  }
  function showCards(start, reset){
    const grid=$("libGrid"); if(!grid) return;
    $("libCount").textContent=tn("library.models_count",L.total);
    renderActive();
    if(reset) grid.innerHTML="";
    if(!L.models.length){ grid.innerHTML=`<div class="lib-empty">${esc(anyFilter()?t("library.no_match"):t("library.empty"))}</div>`; }
    else grid.insertAdjacentHTML("beforeend", L.models.slice(start).map(cardHtml).join(""));
    grid.querySelectorAll(".lib-card:not([data-wired])").forEach(c=>{
      c.dataset.wired="1";
      c.addEventListener("click",e=>{ if(e.metaKey||e.ctrlKey||e.button===1) return; e.preventDefault(); go("/library/m/"+c.dataset.uuid); });
    });
    const more=$("libMore");
    more.innerHTML=L.next?`<button type="button" class="btn ghost" id="libMoreBtn">${esc(t("library.show_more",{shown:L.models.length,total:L.total}))}</button>`:"";
    if(L.next){
      $("libMoreBtn").addEventListener("click",()=>loadModels(false));
      // Next page when the button scrolls into view: still one request at a
      // time, and never for a page nobody scrolled to.
      if("IntersectionObserver" in window){
        const io=new IntersectionObserver(es=>{ if(es.some(x=>x.isIntersecting)){ io.disconnect(); if(L.next&&!L.loadingMore){ L.loadingMore=true; loadModels(false).finally(()=>{ L.loadingMore=false; }); } } },{root:$("libraryPage"),rootMargin:"400px"});
        io.observe($("libMoreBtn"));
      }
    }
  }
  const anyFilter=()=>{ const f=L.filters; return !!(f.q||f.printer||f.location||f.type||f.material||f.attention); };
  function renderActive(){
    const el=$("libActive"); if(!el) return;
    el.innerHTML=anyFilter()?`<button type="button" class="btn ghost btn-sm" id="libClear">${esc(t("library.clear_filters"))}</button>`:"";
    if($("libClear")) $("libClear").addEventListener("click",()=>{ Object.assign(L.filters,{q:"",printer:"",location:"",type:"",material:"",attention:false}); renderGrid(); });
  }

  // The fleet-fit chips: which printer families this Model has files for,
  // lit when the fleet has such a printer, with how many are idle now.
  function familyChips(families, max){
    const shown=families.slice(0,max);
    return shown.map(fam=>{
      const fit=fleetFit(fam.key);
      const cls=fit.idle.length?"is-fit is-idle":fit.printers.length?"is-fit":"";
      const title=fit.printers.length?tn("library.fit_title",fit.printers.length,{family:fam.label||fam.key,idle:fit.idle.length}):t("library.fit_none_title",{family:fam.label||fam.key});
      return `<span class="lib-fam ${cls}" title="${esc(title)}">${esc(shortFamily(fam.label||fam.key))}${fit.idle.length?`<b>${fit.idle.length}</b>`:""}</span>`;
    }).join("")+(families.length>max?`<span class="lib-fam is-more" title="${esc(families.slice(max).map(x=>x.label).join(", "))}">+${families.length-max}</span>`:"");
  }
  // "Creality Ender-3 V3 Plus" → "Ender-3 V3 Plus": the brand is noise on a card.
  const shortFamily=l=>String(l||"").replace(/^(Creality|Flashforge|Snapmaker|Bambu Lab|Anycubic|Prusa|Elegoo|Qidi|Sovol)\s+/i,"");

  function coverHtml(cover, name, cls){
    return cover&&cover.thumb
      ? `<img class="${cls||"lib-cover-img"}" loading="lazy" decoding="async" alt="" data-initial="${esc((name||"?").trim().charAt(0).toUpperCase())}" src="${thumbUrl(cover.thumb)}">`
      : `<span class="lib-noimg" aria-hidden="true">${esc((name||"?").trim().charAt(0).toUpperCase())}</span>`;
  }
  function cardHtml(m){
    const meta=m.variants>1?tn("library.n_variants",m.variants):m.projects&&!m.variants?tn("library.n_projects",m.projects):m.files>1?tn("library.n_files",m.files):t("library.one_file");
    const att=m.attention&&m.attention.count?`<span class="lib-badge ${m.attention.level==="action"?"is-bad":"is-warn"}" title="${esc(tn("library.attention_title",m.attention.count))}">${esc(m.attention.level==="action"?t("library.badge_action"):t("library.badge_review"))}</span>`:"";
    const off=m.offline?`<span class="lib-badge is-off" title="${esc(m.offline==="all"?t("library.offline_card_title"):t("library.offline_some_title"))}">${esc(t("library.badge_offline"))}</span>`:
      m.missing||m.unreadable?`<span class="lib-badge is-bad" title="${esc(t("library.missing_card_title"))}">${esc(m.missing?t("library.badge_missing"):t("library.badge_unreadable"))}</span>`:"";
    return `<a class="lib-card${m.offline==="all"?" is-offline":""}" href="/library/m/${esc(m.uuid)}" data-uuid="${esc(m.uuid)}">
      <span class="lib-well">${coverHtml(m.cover,m.name)}<span class="lib-badges">${att}${off}</span></span>
      <span class="lib-card-body">
        <span class="lib-name" title="${esc(m.name)}">${esc(m.name)}</span>
        <span class="lib-meta">${esc(meta)}${m.materials.length?` · ${esc(m.materials.slice(0,3).join(", "))}`:""}</span>
        <span class="lib-fams">${familyChips(m.families,2)}</span>
      </span></a>`;
  }

  // ---- the Model page ----
  async function renderModel(uuid){
    const token=L.req;
    let m;
    try{ m=await api("/api/library/models/"+encodeURIComponent(uuid)); }
    catch(e){ if(token===L.req) $("libBody").innerHTML=`${backHtml()}<div class="lib-empty">${esc(e.status===404?t("library.model_not_found"):t("library.load_failed"))}</div>`; wireBack(); return; }
    if(token!==L.req||!$("libBody")) return;
    const byFamily=new Map();
    for(const v of m.printables){ const k=v.printer.family||"~unknown"; if(!byFamily.has(k)) byFamily.set(k,[]); byFamily.get(k).push(v); }
    const famOrder=[...byFamily.keys()].sort((a,b)=>(a==="~unknown")-(b==="~unknown")||byFamily.get(b).length-byFamily.get(a).length);
    const facts=[
      m.designer?[t("library.designer"),esc(m.designer)]:null,
      m.license?[t("library.license"),esc(m.license)]:null,
      m.designModelId?[t("library.makerworld_id"),`<span class="lib-mono">${esc(m.designModelId)}</span>`]:null,
      [t("library.locations"),m.locations.map(l=>esc(l.name)+(l.offline?` <span class="lib-badge is-off">${esc(t("library.badge_offline"))}</span>`:"")).join(", ")],
    ].filter(Boolean);
    const fits=m.families.map(f=>({f,fit:fleetFit(f.key)})).filter(x=>x.fit.printers.length);
    // An unsliced project fits nothing yet, but says what it is set up for.
    const setUp=[...new Set(m.projects.map(p=>p.setUpFor&&p.setUpFor.label).filter(Boolean))];
    const fitsNone=m.printables.length?(m.families.length?t("library.fits_none"):t("library.fits_unknown"))
      :setUp.length?t("library.fits_setup",{printer:setUp.join(", ")}):t("library.fits_unsliced");
    $("libBody").innerHTML=`
      ${backHtml()}
      <div class="lib-model">
        <div class="lib-model-hero">
          <div class="lib-gallery">
            <div class="lib-well lib-well-lg" id="libHeroWell">${coverHtml(m.cover,m.name,"lib-cover-img")}</div>
            ${m.gallery.length>1?`<div class="lib-strip" role="list">${m.gallery.slice(0,12).map((g,i)=>`<button type="button" class="lib-thumb${i===0?" is-on":""}" data-thumb="${esc(g.thumb)}" title="${esc(g.label||"")}" aria-label="${esc(t("library.show_image",{n:i+1}))}"><img loading="lazy" alt="" src="${thumbUrl(g.thumb)}"></button>`).join("")}</div>`:""}
          </div>
          <div class="lib-model-facts">
            <h1 class="lib-model-name">${esc(m.name)}</h1>
            <div class="lib-model-sub">${esc(summaryLine(m))}</div>
            <dl class="lib-dl">${facts.map(([k,v])=>`<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}
              <dt>${esc(t("library.fits"))}</dt><dd>${fits.length?fits.map(x=>fitLine(x)).join(""):`<span class="lib-dim">${esc(fitsNone)}</span>`}</dd>
            </dl>
            ${attentionBlock(m.attention)}
          </div>
        </div>
        ${m.suggestions.length?`<section class="lib-sec"><h2>${esc(t("library.sec_suggestions"))}</h2>${m.suggestions.map(suggestionHtml).join("")}</section>`:""}
        ${m.printables.length||!m.projects.length?`<section class="lib-sec"><h2>${esc(t("library.sec_printables"))} <span class="lib-sec-n">${m.printables.length}</span></h2>
          ${m.printables.length?famOrder.map(k=>familyGroupHtml(k,byFamily.get(k))).join(""):`<div class="lib-empty-sm">${esc(t("library.no_printables"))}</div>`}
        </section>`:""}
        ${m.projects.length?`<section class="lib-sec"><h2>${esc(t("library.sec_projects"))} <span class="lib-sec-n">${m.projects.length}</span></h2>${m.projects.map(projectHtml).join("")}</section>`:""}
        ${m.others.length?`<section class="lib-sec"><h2>${esc(t("library.sec_other"))} <span class="lib-sec-n">${m.others.length}</span></h2><div class="lib-others">${m.others.map(otherHtml).join("")}</div></section>`:""}
        ${isAdmin()?`<p class="settings-help lib-diag-link"><a href="/library-diagnostics.html" target="_blank" rel="noopener">${esc(t("library.diagnostics_link"))}</a></p>`:""}
      </div>`;
    wireBack();
    $("libBody").querySelectorAll(".lib-thumb").forEach(b=>b.addEventListener("click",()=>{
      $("libBody").querySelectorAll(".lib-thumb").forEach(x=>x.classList.toggle("is-on",x===b));
      $("libHeroWell").innerHTML=`<img class="lib-cover-img" alt="" src="${thumbUrl(b.dataset.thumb)}">`;
    }));
    $("libBody").querySelectorAll("[data-model]").forEach(a=>a.addEventListener("click",e=>{ e.preventDefault(); go("/library/m/"+a.dataset.model); }));
    $("libBody").querySelectorAll(".lib-print").forEach(b=>b.addEventListener("click",()=>printVia(b.dataset.path,"print")));
    $("libBody").querySelectorAll(".lib-queue").forEach(b=>b.addEventListener("click",()=>printVia(b.dataset.path,"queue")));
  }
  function fitLine(x){
    const names=x.fit.printers.slice().sort((a,b)=>(x.fit.idle.includes(b)-x.fit.idle.includes(a))).map(p=>p.name+(x.fit.idle.includes(p)?" ("+t("library.idle")+")":""));
    const shown=names.slice(0,4), rest=names.length-shown.length;
    return `<span class="lib-fit-line" title="${esc(names.join(", "))}"><span class="lib-fam is-fit${x.fit.idle.length?" is-idle":""}">${esc(shortFamily(x.f.label))}</span>
      ${esc(shown.join(", "))}${rest>0?" "+esc(tn("library.and_more",rest)):""}</span>`;
  }
  function summaryLine(m){
    const parts=[];
    if(m.counts.printables) parts.push(tn("library.n_printables",m.counts.printables));
    if(m.counts.projects) parts.push(tn("library.n_projects",m.counts.projects));
    if(m.families.length) parts.push(tn("library.n_printer_types",m.families.length));
    if(m.counts.files>1) parts.push(tn("library.n_files",m.counts.files));
    return parts.join(" · ");
  }
  function backHtml(){ return `<a class="lib-back" href="/library" id="libBack">← ${esc(t("library.back"))}</a>`; }
  function wireBack(){ const b=$("libBack"); if(b) b.addEventListener("click",e=>{ e.preventDefault(); go("/library"); }); }

  function familyGroupHtml(key, list){
    const unknown=key==="~unknown";
    const label=unknown?t("library.printer_unknown_group"):(list[0].printer.label||key);
    const fit=unknown?null:fleetFit(key);
    return `<div class="lib-famgroup">
      <div class="lib-famgroup-hd"><span class="lib-famgroup-name">${esc(label)}</span>
        <span class="lib-famgroup-n">${esc(tn("library.n_variants",list.length))}</span>
        ${fit&&fit.printers.length?`<span class="lib-fam is-fit${fit.idle.length?" is-idle":""}">${esc(tn("library.fit_short",fit.printers.length,{idle:fit.idle.length}))}</span>`:""}</div>
      ${list.map(variantHtml).join("")}</div>`;
  }
  function printerHtml(p){
    if(p.state==="decision") return `<span class="lib-conf is-decision">${esc(t("library.printer_set"))}</span>`;
    if(p.state==="applied") return `<span class="lib-conf is-ok">${esc(t("library.printer_confident"))}</span>`;
    if(p.state==="suggested") return `<span class="lib-conf is-warn" title="${esc(t("library.printer_likely_title"))}">${esc(t("library.printer_likely"))}</span>`;
    return `<span class="lib-conf is-dim">${esc(t("library.printer_unknown"))}</span>`;
  }
  function availHtml(a){
    if(a==="ok") return "";
    const k={offline:"badge_offline",missing:"badge_missing",unreadable:"badge_unreadable"}[a]||"badge_missing";
    return `<span class="lib-badge ${a==="offline"?"is-off":"is-bad"}" title="${esc(t("library.avail_"+a+"_title"))}">${esc(t("library."+k))}</span>`;
  }
  function swatches(fil){
    return fil.length?`<span class="lib-swatches">${fil.slice(0,8).map(x=>`<span class="lib-sw" style="--sw:${/^#[0-9a-f]{3,8}$/i.test(x.color||"")?x.color:"transparent"}" title="${esc([x.type,x.vendor,x.color,x.grams!=null?fmtG(x.grams):null].filter(Boolean).join(" · "))}"></span>`).join("")}<span class="lib-sw-txt">${esc([...new Set(fil.map(x=>x.type).filter(Boolean))].join(", "))}</span></span>`:"";
  }
  function variantHtml(v){
    const f=v.file;
    const facts=[
      v.estSeconds?`<span title="${esc(t("library.est_time"))}">${esc(fmtDuration(v.estSeconds))}</span>`:null,
      v.weightG?`<span title="${esc(t("library.weight"))}">${esc(fmtG(v.weightG))}</span>`:null,
      v.copies>1?`<span>${esc(tn("library.copies",v.copies))}</span>`:null,
      v.layerHeight?`<span>${esc(v.layerHeight+" mm")}</span>`:null,
      v.nozzle?`<span>${esc(t("library.nozzle",{d:v.nozzle}))}</span>`:null,
    ].filter(Boolean);
    const plate=v.plate!=null?`<span class="lib-plate">${esc(t("library.plate_n",{n:v.plate}))}${v.plateName?" · "+esc(v.plateName):""}</span>`:"";
    const canAct_=canAct();
    const s=v.send;
    const why=!canAct_?t("library.print_view_only"):s.ok?"":s.reason==="location"?t("library.print_location_title",{name:f.rootName}):t("library.print_unavailable_"+s.reason);
    const pbtn=`<button type="button" class="btn primary btn-sm lib-print" ${s.ok&&canAct_?`data-path="${esc(s.path)}"`:`disabled title="${esc(why)}"`}>${esc(t("library.print"))}</button>`;
    const qbtn=(typeof QUEUE_MANAGEMENT_ENABLED!=="undefined"&&QUEUE_MANAGEMENT_ENABLED)?`<button type="button" class="btn ghost btn-sm lib-queue" ${s.ok&&canAct_?`data-path="${esc(s.path)}"`:`disabled title="${esc(why)}"`}>${esc(t("library.queue"))}</button>`:"";
    return `<div class="lib-var${f.availability!=="ok"?" is-unavailable":""}">
      <span class="lib-var-thumb">${v.thumb?`<img loading="lazy" alt="" src="${thumbUrl(v.thumb)}">`:`<span class="lib-noimg is-sm"></span>`}</span>
      <div class="lib-var-main">
        <div class="lib-var-title"><span class="lib-fname" title="${esc(f.name)}">${esc(stem(f.name))}</span>${plate}${availHtml(f.availability)}</div>
        <div class="lib-var-where" title="${esc(f.rootName+" · "+f.path)}">${esc(f.rootName)} · ${esc(f.path)}</div>
        <div class="lib-var-facts">${printerHtml(v.printer)}${v.profile.printer?`<span class="lib-prof" title="${esc([v.profile.printer,v.profile.print].filter(Boolean).join(" · "))}">${esc(v.profile.printer)}</span>`:""}${v.slicer?`<span class="lib-dim">${esc(v.slicer)}</span>`:""}${facts.join("")}</div>
        ${swatches(v.filaments)}
        ${f.duplicates.length?`<div class="lib-var-dup">${esc(tn("library.also_at",f.duplicates.length,{where:f.duplicates.map(d=>d.rootName+" · "+d.path).join("; ")}))}</div>`:""}
        <div class="lib-explains">${whyHereHtml(f.why)}${whyPrinterHtml(v.printer)}</div>
      </div>
      <div class="lib-var-act">${pbtn}${qbtn}</div>
    </div>`;
  }

  // ---- explanations (§4 provenance, in plain words; Diagnostics has the rest) ----
  function evidenceLine(e){
    const v=String(e.value==null?"":e.value);
    if(e.signal==="title"&&e.strength==="weak"){ const [a,b]=v.split(" = "); return t("library.ev_title_weak",{a:a||"",b:b||""}); }
    if(e.strength==="weak") return evidenceLine({...e, strength:"medium"})+" ("+t("library.weak_not_counted")+")";
    switch(e.signal){
      case "object_names": return t("library.ev_objects",{value:v});
      case "title": return e.compare?t("library.ev_title_cmp",{a:e.compare.a,b:e.compare.b,n:e.compare.normalized}):t("library.ev_title",{value:v.split(" = ")[0]});
      case "model_folder": return t("library.ev_folder",{value:v.slice(v.indexOf(":")+1)});
      case "design_model_id": return t("library.ev_design",{value:v});
      case "plate_md5": return t("library.ev_plate_md5");
      case "source_file": return t("library.ev_source",{value:v});
      case "designer_folder": return t("library.ev_designer_folder",{value:v});
      default: return e.signal+": "+v;
    }
  }
  function whyHereHtml(w){
    if(!w) return "";
    let summary, lines=[];
    if(w.kind==="decision"){ summary=t("library.why_decision"); if(w.decision&&w.decision.reason) lines.push(w.decision.reason); }
    else if(w.kind==="automatic"){
      summary=t("library.why_auto");
      lines=w.evidence.map(evidenceLine);
      lines.push(t("library.why_auto_rule"));
    } else summary=t("library.why_single");
    return `<details class="lib-why"><summary>${esc(t("library.why_here"))}</summary><p>${esc(summary)}</p>${lines.length?`<ul>${lines.map(l=>`<li>${esc(l)}</li>`).join("")}</ul>`:""}</details>`;
  }
  const PRINTER_SIGNAL={ printer_model:"library.pev_printer_model", printer_settings_id:"library.pev_printer_settings", print_compatible_printers:"library.pev_compatible",
    default_print_profile:"library.pev_default_profile", printer_model_id:"library.pev_model_id", generator:"library.pev_generator" };
  function whyPrinterHtml(p){
    let summary;
    if(p.state==="decision") summary=t("library.pwhy_decision");
    else if(p.state==="applied") summary=t("library.pwhy_applied",{family:p.label});
    else if(p.state==="suggested") summary=t("library.pwhy_suggested",{family:p.label});
    else if(p.state==="recorded") summary=t("library.pwhy_recorded");
    else summary=t("library.pwhy_unknown");
    const lines=(p.evidence||[]).map(e=>{
      const k=PRINTER_SIGNAL[e.signal];
      const base=k?t(k,{value:String(e.value)}):e.signal+": "+e.value;
      return base+(e.familyLabel&&e.familyLabel!==p.label?" → "+e.familyLabel:"")+(e.strength==="weak"?" ("+t("library.weak")+")":"");
    });
    if(p.others&&p.others.length) lines.push(t("library.pwhy_others",{list:p.others.map(o=>o.label).join(", ")}));
    return `<details class="lib-why"><summary>${esc(t("library.why_printer"))}</summary><p>${esc(summary)}</p>${lines.length?`<ul>${lines.map(l=>`<li>${esc(l)}</li>`).join("")}</ul>`:""}</details>`;
  }
  function suggestionHtml(s){
    const other=s.other?`<a href="/library/m/${esc(s.other.uuid)}" data-model="${esc(s.other.uuid)}">${esc(s.other.name)}</a>`:esc(t("library.another_model"));
    const lines=s.evidence.map(evidenceLine);
    return `<div class="lib-sugg">
      <div>${esc(t("library.sugg_line",{other:"\u0000"})).replace("\u0000",other)}</div>
      <details class="lib-why"><summary>${esc(t("library.why_only_suggestion"))}</summary>
        <p>${esc(t("library.sugg_explain"))}</p>${lines.length?`<ul>${lines.map(l=>`<li>${esc(l)}</li>`).join("")}</ul>`:""}
        ${s.missing?`<p class="lib-dim">${esc(missingText(s))}</p>`:""}</details>
      <p class="settings-help">${esc(t("library.m6_note"))}</p></div>`;
  }
  function missingText(s){
    const g=s.groups||[];
    if(g.length===1&&g[0]==="filename") return t("library.missing_filename");
    if(g.length===1&&g[0]==="internal-content") return t("library.missing_content");
    if(g.length===1&&g[0]==="location") return t("library.missing_location");
    return t("library.missing_generic");
  }
  function projectHtml(p){
    const f=p.file;
    return `<div class="lib-proj">
      <div class="lib-var-title"><span class="lib-fname" title="${esc(f.name)}">${esc(p.title||stem(f.name))}</span>${availHtml(f.availability)}</div>
      <div class="lib-var-where" title="${esc(f.rootName+" · "+f.path)}">${esc(f.rootName)} · ${esc(f.path)}</div>
      <div class="lib-var-facts">${p.designer?`<span>${esc(p.designer)}</span>`:""}${p.license?`<span>${esc(p.license)}</span>`:""}<span class="lib-dim">${esc(t("library.flavour_"+p.flavour))}</span>
        ${p.setUpFor&&p.setUpFor.label?`<span title="${esc(p.setUpFor.profile||"")}">${esc(t("library.set_up_for",{printer:p.setUpFor.label}))}</span>`:""}
        <span>${esc(tn("library.n_plates",p.plates.length))}${p.plates.some(x=>x.printable)?" · "+esc(tn("library.n_printable_plates",p.plates.filter(x=>x.printable).length)):""}</span></div>
      ${p.plates.length?`<div class="lib-plates">${p.plates.map(pl=>`<div class="lib-plate-card${pl.printable?" is-printable":""}" title="${esc(pl.objects.join(", "))}">
        <span class="lib-well lib-well-sm">${pl.thumb?`<img loading="lazy" alt="" src="${thumbUrl(pl.thumb)}">`:`<span class="lib-noimg is-sm">${pl.plate}</span>`}</span>
        <span class="lib-plate-name">${esc(pl.name||t("library.plate_n",{n:pl.plate}))}</span>
        <span class="lib-plate-state">${esc(pl.printable?t("library.plate_printable"):t("library.plate_not_sliced"))}</span></div>`).join("")}</div>`:""}
      <div class="lib-explains">${whyHereHtml(f.why)}</div></div>`;
  }
  function otherHtml(o){
    return `<div class="lib-other">
      <span class="lib-var-thumb">${o.thumb?`<img loading="lazy" alt="" src="${thumbUrl(o.thumb)}">`:`<span class="lib-noimg is-sm"></span>`}</span>
      <div><div class="lib-var-title"><span class="lib-fname" title="${esc(o.entry||o.name)}">${esc(o.name)}</span>${availHtml(o.availability)}</div>
      <div class="lib-var-where">${esc(o.container?t("library.inside",{name:o.container}):o.rootName+" · "+o.path)} · ${esc(t("library.role_"+o.role))}</div></div></div>`;
  }

  // Print/Queue: the File Browser's own path, so every existing check applies
  // (brand and model, active-file, plate choice, colours). Only files in the
  // G-code folder can be sent today; other locations come with root-aware
  // printing (§12).
  async function printVia(path, how){
    if(!path) return;
    if(how==="queue"){
      SELECTED_FILES.clear(); SELECTED_FILES.add(path);
      openSendQueueModal();
      return;
    }
    await selectFile(path);
    if(L.open) hideFleet(true);    // selectFile shows the job header behind the Library
    if(SELECTED===path&&MAP) openSendModal();
    else alert(t("library.print_open_failed"));
  }

  // ---- Needs attention ----
  const LEVELS=["action","review","info"];
  async function renderAttention(){
    const token=L.req;
    $("libBody").innerHTML=`${backHtml()}<div class="lib-head"><div class="lib-title"><h1>${esc(t("library.needs_attention"))}</h1><span class="lib-count" id="libAttnTotal"></span></div></div><div id="libAttnBody"><div class="lib-loading">${esc(t("library.loading"))}</div></div>`;
    wireBack();
    let a;
    try{ a=await api("/api/library/attention"); }catch(e){ if(token===L.req) $("libAttnBody").innerHTML=`<div class="lib-empty">${esc(t("library.load_failed"))}</div>`; return; }
    if(token!==L.req||!$("libAttnBody")) return;
    $("libAttnTotal").textContent=tn("library.items_count",a.items.length);
    if(!a.items.length){ $("libAttnBody").innerHTML=`<div class="lib-empty">${esc(t("library.attention_none"))}</div>`; return; }
    $("libAttnBody").innerHTML=`<p class="settings-help">${esc(t("library.attention_intro"))}</p>`+LEVELS.map(level=>{
      const items=a.items.filter(i=>i.level===level);
      if(!items.length) return "";
      const kinds=new Map();
      for(const i of items){ if(!kinds.has(i.kind)) kinds.set(i.kind,[]); kinds.get(i.kind).push(i); }
      return `<section class="lib-sec lib-level lib-level-${level}"><h2>${esc(t("library.level_"+level))} <span class="lib-sec-n">${items.length}</span></h2>
        <p class="settings-help">${esc(t("library.level_"+level+"_help"))}</p>
        ${[...kinds.entries()].map(([kind,list])=>`<details class="lib-kind"${level!=="info"||list.length<=3?" open":""}><summary><span class="lib-kind-name">${esc(t("library.kind_"+kind))}</span> <span class="lib-sec-n">${list.length}</span></summary>
          <p class="settings-help">${esc(t("library.kind_"+kind+"_help"))}</p>
          <ul class="lib-items">${list.map(itemHtml).join("")}</ul></details>`).join("")}</section>`;
    }).join("");
    if(isAdmin()) $("libAttnBody").insertAdjacentHTML("beforeend",`<p class="settings-help lib-diag-link"><a href="/library-diagnostics.html" target="_blank" rel="noopener">${esc(t("library.diagnostics_link"))}</a></p>`);
    $("libAttnBody").querySelectorAll("[data-model]").forEach(x=>x.addEventListener("click",e=>{ e.preventDefault(); go("/library/m/"+x.dataset.model); }));
  }
  // The Model page's own attention items: what is wrong or uncertain about
  // this Model, in the same words as Needs attention.
  function attentionBlock(items){
    // Suggestions have their own section on this page.
    const sorted=items.filter(i=>i.kind!=="suggested_match").sort((a,b)=>LEVELS.indexOf(a.level)-LEVELS.indexOf(b.level));
    if(!sorted.length) return "";
    return `<div class="lib-attn"><ul class="lib-items">${sorted.map(i=>itemHtml({...i, models:[], modelCount:0})).join("")}</ul></div>`;
  }
  function where(l){ if(!l) return ""; const i=l.indexOf(":"); const root=(L.overview&&L.overview.roots.find(r=>r.id===l.slice(0,i)))||null; return (root?root.name:l.slice(0,i))+" · "+l.slice(i+1); }
  function itemHtml(i){
    const d=i.detail||{};
    const models=i.models.map(m=>`<a href="/library/m/${esc(m.uuid)}" data-model="${esc(m.uuid)}">${esc(m.name)}</a>`).join(", ")+(i.modelCount>i.models.length?" …":"");
    let text;
    switch(i.kind){
      case "folder_disagrees": text=t("library.it_folder",{file:where(i.location),folder:d.folder||"",folderFamily:(d.folderFamilies||[]).join("/"),fileFamily:d.fileFamily||""}); break;
      case "unknown_printer": text=d.likely?t("library.it_printer_likely",{file:where(i.location),family:d.likely}):t("library.it_printer_none",{file:where(i.location)}); break;
      case "possible_duplicate": text=t("library.it_duplicate",{a:where(i.location),b:where(i.otherLocation)}); break;
      case "suggested_match": text=t("library.it_suggested"); break;
      case "ambiguous_grouping":
        text=d.variant==="generic"?t("library.it_generic",{terms:(d.terms||[]).join(", "),n:d.files||0})
          :d.variant==="file"?t("library.it_ambiguous_file",{file:where(i.location),n:(d.candidates||[]).length})
          :d.variant==="nested"?t("library.it_nested",{folder:where(d.folder||i.location)})
          :t("library.it_anchor",{model:d.model||""});
        break;
      case "missing_file": text=t("library.it_missing",{file:where(i.location)}); break;
      case "unreadable_file": text=t("library.it_unreadable",{file:where(i.location)}); break;
      case "source_offline": text=t("library.it_offline",{name:(L.overview&&(L.overview.roots.find(r=>r.id===i.location)||{}).name)||i.location||""}); break;
      case "file_changed": text=t("library.it_changed",{file:where(d.lastSeenAt||i.location)}); break;
      case "decision_unmatched": text=t("library.it_unmatched",{file:where(d.lastSeenAt||i.location)}); break;
      case "empty_model": text=t("library.it_empty"); break;
      case "source_may_match": text=t("library.it_source"); break;
      default: text=i.kind;
    }
    return `<li class="lib-item lib-item-${i.level}"><span class="lib-item-dot" aria-hidden="true"></span><div><div>${esc(text)}</div>${models?`<div class="lib-item-models">${models}</div>`:""}</div></li>`;
  }

  // ---- wiring ----
  function init(){
    const btn=$("libraryBtn");
    if(!btn) return;
    // A thumbnail that can't be loaded (evicted from the cache, a broken
    // image) becomes the same placeholder as a Model without a cover, never
    // a broken-image icon. Image errors don't bubble: listen in capture.
    document.addEventListener("error",e=>{
      const el=e.target;
      if(!el||el.tagName!=="IMG"||!el.closest||!el.closest("#libraryPage")) return;
      const ph=document.createElement("span");
      ph.className="lib-noimg"+(el.closest(".lib-var-thumb,.lib-thumb,.lib-well-sm")?" is-sm":"");
      ph.setAttribute("aria-hidden","true");
      ph.textContent=el.dataset.initial||"";
      el.replaceWith(ph);
    },true);
    btn.addEventListener("click",()=>{ if(L.open) closePage(); else openPage("/library",true); });
  }
  // First-run onboarding (Settings opened because no printer is configured)
  // wins over a /library deep link: the two are never shown together.
  window.LibraryPage={ openFromLocation:()=>{ if($("setup")&&$("setup").classList.contains("show")) return; if(/^\/library/i.test(location.pathname)){ L.syncing=true; try{ openPage(location.pathname,false); } finally{ L.syncing=false; } } },
    close:closePage, isOpen:()=>L.open };
  init();
})();
