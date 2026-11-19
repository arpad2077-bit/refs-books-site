/* ============================================================
   app.js — Refs.Books
   ------------------------------------------------------------
   Страницы: главная · карта (глобальная / по эпохам) ·
   произведение · профиль · подписка · каталог.
   Режимы: пользователь / разработчик.
   ============================================================ */
(function () {
  'use strict';

  /* ================= утилиты ================= */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };
  var Acc = window.Account;
  var PUB = window.PUBLISHED || { works: [], edges: [], annotations: {}, status: {}, docs: {} };

  var DEV_KEY = 'refbooks.dev.v1';
  var DEVMODE_KEY = 'refbooks.devmode';
  var OLD_KEY = 'refmap.v1';

  /* ================= состояние ================= */
  var S = {
    works: new Map(),
    edges: [],
    open: new Set(),
    page: new Map(),
    history: [],
    view: { x: 0, y: 0, k: 1 },
    route: { name: 'home' },
    builtin: new Set(),     // произведения из файлов сайта
    dev: false,
    devData: null           // правки разработчика (этот браузер)
  };
  var L = null;

  /* ================= имена и индекс ================= */
  function norm(t) {
    return String(t || '').toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[«»"“”„'`]/g, '')
      .replace(/\([^)]*\)/g, ' ')
      .replace(/[^\wа-я0-9 ]+/gi, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  function slug(t) {
    var b = norm(t).replace(/\s+/g, '-').replace(/[^\wа-я-]/gi, '');
    if (!b) b = 'work';
    var id = b, i = 2;
    while (S.works.has(id)) id = b + '-' + (i++);
    return id;
  }
  var index = new Map();
  function byTitle(t) { return index.get(norm(t)) || null; }

  /* ================= модель ================= */
  function addWork(o) {
    if (S.works.has(o.id)) {
      var ex = S.works.get(o.id);
      ['author', 'year', 'url', 'docScript'].forEach(function (k) { if (o[k] && !ex[k]) ex[k] = o[k]; });
      if (typeof o.sort === 'number' && ex.sort === 9999) ex.sort = o.sort;
      if (o.spine) ex.spine = true;
      if (o.hasDoc) ex.hasDoc = true;
      return ex;
    }
    var w = {
      id: o.id, title: o.title, author: o.author || '', year: o.year || '',
      sort: typeof o.sort === 'number' ? o.sort : 9999,
      spine: !!o.spine, hasDoc: !!o.hasDoc,
      docScript: o.docScript || '', url: o.url || ''
    };
    S.works.set(w.id, w);
    if (!index.has(norm(w.title))) index.set(norm(w.title), w);
    return w;
  }

  function addEdge(from, to, d) {
    if (!from || !to || from === to) return false;
    for (var i = 0; i < S.edges.length; i++) {
      if (S.edges[i].from === from && S.edges[i].to === to) return false;
    }
    S.edges.push({
      from: from, to: to,
      quote: (d && d.quote) || '', loc: (d && d.loc) || '',
      section: (d && d.section) || '', source: (d && d.source) || '',
      just: (d && (d.just || d.justification)) || ''
    });
    return true;
  }
  function outOf(id) { return S.edges.filter(function (e) { return e.from === id; }); }
  function inOf(id) { return S.edges.filter(function (e) { return e.to === id; }); }
  function sortWorks(a, b) {
    var wa = S.works.get(a.id), wb = S.works.get(b.id);
    if (!wa || !wb) return 0;
    if (wa.sort !== wb.sort) return wa.sort - wb.sort;
    return wa.title.localeCompare(wb.title, 'ru');
  }

  /* ================= встроенный контент ================= */
  function buildSpine() {
    var sp = window.SPINE || [];
    sp.forEach(function (s) {
      addWork({ id: s.id, title: s.title, author: s.author, year: s.year, sort: s.sort, spine: true });
    });
    for (var i = 1; i < sp.length; i++) {
      addEdge(sp[i].id, sp[i - 1].id, { section: 'Хронологическая линия', source: 'Обоснование связи', just: sp[i].note });
    }
  }

  function buildEpochs() {
    (window.EPOCHS || []).forEach(function (ep) {
      function chain(list, prevId) {
        list.forEach(function (w, i) {
          addWork({ id: w.id, title: w.title, author: w.author, year: w.year, sort: w.sort, spine: true });
          var prev = i > 0 ? list[i - 1].id : prevId;
          if (prev && w.ref) addEdge(w.id, prev, { section: 'Эпоха: ' + ep.title, source: 'Обоснование связи', just: w.ref });
        });
      }
      chain(ep.works, null);
      if (ep.bridge && ep.bridge.direct) {
        addEdge(ep.bridge.to, ep.bridge.from, { section: 'Межэпохальный мост', source: 'Обоснование связи', just: ep.bridge.note });
      }
      (ep.alts || []).forEach(function (alt) { chain(alt.works, alt.from || null); });
    });
  }

  function addAliases() {
    var al = window.TITLE_ALIASES || {};
    Object.keys(al).forEach(function (id) {
      var w = S.works.get(id);
      if (w) al[id].forEach(function (t) { index.set(norm(t), w); });
    });
  }

  function importRefs(work, refs) {
    var added = [];
    (refs || []).forEach(function (r) {
      (r.nodes || []).forEach(function (nd) {
        var t = typeof nd === 'string' ? nd : nd.title;
        if (!t) return;
        var target = byTitle(t) || addWork({ id: slug(t), title: t });
        if (target.id === work.id) return;
        if (addEdge(work.id, target.id, r)) added.push(target.id);
      });
    });
    return added;
  }

  /* ================= правки разработчика ================= */
  function devBlank() { return { works: [], edges: [], annotations: {}, status: {}, docIds: [] }; }

  function devLoad() {
    var d = null;
    try { d = JSON.parse(localStorage.getItem(DEV_KEY) || 'null'); } catch (e) {}
    d = d || devBlank();
    var b = devBlank();
    for (var k in b) if (!d[k]) d[k] = b[k];

    /* перенос из прежней версии сайта */
    try {
      var old = JSON.parse(localStorage.getItem(OLD_KEY) || 'null');
      if (old && !d.migrated) {
        (old.works || []).forEach(function (w) { d.works.push(w); if (w.docUrl) d.docIds.push(w.id); });
        (old.edges || []).forEach(function (e) { d.edges.push(e); });
        (old.read || []).forEach(function (id) { if (Acc.data.finished.indexOf(id) < 0) Acc.data.finished.push(id); });
        Acc.save();
        d.migrated = true;
      }
    } catch (e) {}
    return d;
  }

  function devSave() {
    try { localStorage.setItem(DEV_KEY, JSON.stringify(S.devData)); return true; }
    catch (e) { toast('Не удалось сохранить правки: мало места в браузере'); return false; }
  }

  function applyLayer(layer) {
    (layer.works || []).forEach(function (o) {
      addWork({ id: o.id, title: o.title, author: o.author, year: o.year, sort: o.sort, hasDoc: o.hasDoc, url: o.url });
    });
    (layer.edges || []).forEach(function (e) {
      if (S.works.has(e.from) && S.works.has(e.to)) addEdge(e.from, e.to, e);
    });
  }

  function annotationOf(id) {
    var d = S.devData.annotations;
    if (d[id] != null && d[id] !== '') return d[id];
    if (PUB.annotations && PUB.annotations[id]) return PUB.annotations[id];
    return (window.DEFAULT_ANNOTATIONS || {})[id] || '';
  }
  function statusOf(id) {
    var d = S.devData.status;
    if (id in d) return d[id] || '';
    return (PUB.status && PUB.status[id]) || '';
  }

  /* ================= текст произведения ================= */
  function hasText(w) {
    return !!(w.docScript || w.hasDoc || (PUB.docs && PUB.docs[w.id]) ||
      S.devData.docIds.indexOf(w.id) >= 0);
  }

  /* что показать вместо текста: text | link | copyright | lost | later */
  function textState(w) {
    var st = statusOf(w.id);
    if (st === 'copyright' && !S.dev) return 'copyright';
    if (hasText(w)) return 'text';
    if (w.url) return 'link';
    if (st === 'copyright') return 'copyright';
    if (st === 'lost') return 'lost';
    return 'later';
  }
  var STATE_LABEL = {
    copyright: 'Авторские права',
    lost: 'До нас не дошёл',
    later: 'Добавится позже'
  };

  var scriptLoads = {};
  function loadScript(src) {
    if (!scriptLoads[src]) {
      scriptLoads[src] = new Promise(function (res, rej) {
        var s = document.createElement('script');
        s.src = src; s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      });
    }
    return scriptLoads[src];
  }

  function getDocHtml(w) {
    if (PUB.docs && PUB.docs[w.id]) return Promise.resolve(PUB.docs[w.id]);
    if (window.DOCS && window.DOCS[w.id]) return Promise.resolve(window.DOCS[w.id]);
    if (S.devData.docIds.indexOf(w.id) >= 0 && window.DocStore && DocStore.available) {
      return DocStore.get(w.id);
    }
    if (w.docScript) {
      return loadScript(w.docScript).then(function () { return (window.DOCS || {})[w.id] || null; });
    }
    return Promise.resolve(null);
  }

  /* ================= «прочитано» ================= */
  function isRead(id) { return Acc.data.finished.indexOf(id) >= 0; }

  function setRead(id, val, remember) {
    if (!S.works.has(id) || isRead(id) === val) return;
    if (val) Acc.finish(id); else Acc.unfinish(id);
    if (remember !== false) {
      pushHistory({
        label: (val ? 'отметка «прочитано»: ' : 'снятие отметки: ') + S.works.get(id).title,
        undo: function () { setRead(id, !val, false); }
      });
    }
    repaintRead();
  }
  function toggleRead(id) { setRead(id, !isRead(id)); }

  function repaintRead() {
    $$('#nodes [data-id]').forEach(function (el) {
      el.classList.toggle('read', isRead(el.getAttribute('data-id')));
    });
    drawMini();
    if (S.route.name === 'work') {
      var ww = S.works.get(S.route.id);
      renderWorkTags(ww); renderProgress(ww); renderFinishBtn(ww);
    }
  }

  /* ================= история / уведомления ================= */
  function pushHistory(e) { S.history.push(e); if (S.history.length > 60) S.history.shift(); }
  function undo() {
    var e = S.history.pop();
    if (!e) { toast('Отменять нечего'); return; }
    try { e.undo(); } catch (err) { console.warn(err); }
    toast('Отменено: ' + e.label);
  }
  var toastT = null;
  function toast(msg) {
    var t = $('#toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.style.pointerEvents = '';
    t.classList.add('on');
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.classList.remove('on'); }, 2400);
  }

  /* уведомление с кнопкой действия */
  function toastAction(msg, label, fn) {
    var t = $('#toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
    t.innerHTML = '<span>' + esc(msg) + '</span>';
    t.style.pointerEvents = 'auto';
    if (label) {
      var b = document.createElement('button');
      b.className = 'toast-act';
      b.textContent = label;
      b.onclick = function () { t.classList.remove('on'); clearTimeout(toastT); fn(); };
      t.appendChild(b);
    }
    t.classList.add('on');
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.classList.remove('on'); }, 10000);
  }

  /* окно выбора: ask('Вопрос', [{v, label, prim}]) -> Promise(v) */
  function ask(title, opts, text) {
    return new Promise(function (resolve) {
      var dlg = $('#ask');
      var done = false;
      var finish = function (v) { if (!done) { done = true; resolve(v); } };

      $('#ask-body').innerHTML =
        '<h2>' + esc(title) + '</h2>' + (text ? '<p class="dlg-hint">' + text + '</p>' : '') +
        '<div class="ask-opts">' + opts.map(function (o) {
          return '<button class="tb' + (o.prim ? ' prim' : '') + '" data-v="' + esc(o.v) + '">' +
            esc(o.label) + (o.sub ? '<small>' + esc(o.sub) + '</small>' : '') + '</button>';
        }).join('') + '</div>';
      $$('#ask-body [data-v]').forEach(function (b) {
        b.onclick = function () {
          finish(b.getAttribute('data-v'));
          /* событие close приходит отдельной задачей — после того, как мы,
             возможно, уже открыли следующий вопрос. Помечаем свой close,
             чтобы он не сбросил ответ в null. */
          dlg._guard = true;
          dlg.close();
        };
      });
      dlg.onclose = function () {
        if (dlg._guard) { dlg._guard = false; return; }
        finish(null);
      };
      if (!dlg.open) dlg.showModal();
    });
  }

  /* ================= старт ================= */
  function boot() {
    S.devData = devLoad();

    buildSpine();
    buildEpochs();
    addAliases();

    if (window.SEED_FAUST) {
      var f = addWork({ id: 'faust', title: 'Фауст', author: SEED_FAUST.author, year: SEED_FAUST.year, sort: 1808, docScript: 'docs/faust.js' });
      importRefs(f, SEED_FAUST.refs);
    }
    S.works.forEach(function (w) { S.builtin.add(w.id); });

    applyLayer(PUB);
    (PUB.works || []).forEach(function (w) { S.builtin.add(w.id); });
    applyLayer(S.devData);

    /* ?open=a,b — раскрытые ветки; ?invite=id — приглашение; ?dev=1 */
    var q = location.search + '&' + location.hash;
    var m;
    if ((m = q.match(/[?&#]open=([^&#]+)/))) {
      decodeURIComponent(m[1]).split(',').forEach(function (id) { if (id) S.open.add(id.trim()); });
    }
    if ((m = q.match(/[?&]invite=([^&#]+)/))) Acc.acceptInvite(decodeURIComponent(m[1]));
    if (/[?&]dev=1/.test(q)) localStorage.setItem(DEVMODE_KEY, '1');
    if (/[?&]dev=0/.test(q)) localStorage.removeItem(DEVMODE_KEY);
    setDev(localStorage.getItem(DEVMODE_KEY) === '1', true);

    Acc.on(function () { renderStatusChip(); Ads.fill(); });
    renderStatusChip();
    renderAnnBtn();

    bindUI();
    route();
  }

  /* ================= технические работы ================= */
  function maintOn() {
    var d = S.devData && S.devData.maintenance;
    return d != null ? !!d : !!PUB.maintenance;
  }

  function applyMaint() {
    var ov = $('#maint');
    if (ov) ov.hidden = !(maintOn() && !S.dev);
    var b = $('#dev-maint');
    if (b) {
      b.textContent = 'Технические работы: ' + (maintOn() ? 'ВКЛ' : 'выкл');
      b.classList.toggle('prim', maintOn());
    }
  }

  /* ================= режим разработчика ================= */
  function setDev(on, silent) {
    S.dev = !!on;
    if (on) localStorage.setItem(DEVMODE_KEY, '1'); else localStorage.removeItem(DEVMODE_KEY);
    document.body.classList.toggle('dev-mode', S.dev);
    applyMaint();
    if (!silent) {
      toast(S.dev ? 'Режим разработчика включён' : 'Режим пользователя');
      route();
    }
  }

  /* ================= маршруты ================= */
  var VIEWS = ['home', 'map', 'work', 'profile', 'subscribe', 'catalog', 'raffle'];

  function route() {
    hideTip();
    var h = location.hash.replace(/^#/, '').replace(/[?&]?open=[^&]*/, '');
    var m;
    if (h === '' || h === '/') return showHome();
    if (h === '/map') return showMap();
    if ((m = h.match(/^\/w\/(.+)$/))) return showWork(decodeURIComponent(m[1]));
    if ((m = h.match(/^\/m\/([^/]+)\/(out|in)$/))) return showSingle(decodeURIComponent(m[1]), m[2]);
    if (h === '/profile') return showProfile();
    if (h === '/subscribe') return showSubscribe();
    if (h === '/catalog') return showCatalog();
    if (h === '/raffle') return showRaffle();
    return showHome();
  }

  function setView(name, sub) {
    /* пока текст ещё виден — запоминаем позицию и предупреждаем о закладке */
    if (name !== 'work' && guardWorkId) {
      var gid = guardWorkId;
      guardWorkId = null;
      warnNoMainBookmark(gid);
    }
    VIEWS.forEach(function (v) { $('#view-' + v).classList.toggle('on', v === name); });
    document.body.classList.toggle('at-home', name === 'home');
    document.body.classList.toggle('on-map', name === 'map');
    $('#btn-home').classList.toggle('hide', name === 'map' && sub !== 'single' || name === 'home');
    if (name !== 'work') closeReader();
    renderJourneyBar();
  }

  /* предупреждение: уходим из книги, а главной закладки пользователь не ставил */
  var guardWorkId = null;
  function warnNoMainBookmark(id) {
    if (!reader || reader.id !== id) return;
    var b = Acc.bookmarks(id).main;
    if (b && b.manual) return;
    if ((Acc.data.progress[id] || 0) < 0.003 && reader.ratio() < 0.003) return;
    var pos = reader.currentPos();
    toastAction('Главная закладка не поставлена — вернуться к месту чтения будет нечем.', 'Поставить здесь', function () {
      Acc.setMain(id, pos, true);
      toast('Главная закладка поставлена');
    });
  }

  function mapView() { return Acc.data.prefs.mapView === 'epochs' ? 'epochs' : 'global'; }

  function setMapView(v) {
    if (mapView() === v && S.route.name === 'map') return;
    var prev = mapView();
    Acc.data.prefs.mapView = v;
    Acc.save();
    pushHistory({ label: 'смена вида карты', undo: function () { Acc.data.prefs.mapView = prev; Acc.save(); showMap(); } });
    if (location.hash !== '#/map') location.hash = '#/map'; else showMap();
  }

  function showHome() {
    S.route = { name: 'home' };
    setView('home');
    Ads.fill($('#view-home'));
  }

  function showMap(opts) {
    S.route = { name: 'map' };
    $('#stage').classList.remove('flying');
    setView('map');
    $$('#view-switch [data-mapview]').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-mapview') === mapView());
    });
    renderMap(null, opts && opts.keepView);
    $('#map-title').innerHTML = mapView() === 'epochs'
      ? '<b>Литература по временным эпохам</b> · ' + (window.EPOCHS || []).length + ' эпох'
      : '<b>Глобальная хронология мировой литературы</b> · ' + (window.SPINE || []).length + ' произведений';
  }

  function showSingle(id, dir) {
    var w = S.works.get(id);
    if (!w) { location.hash = '#/map'; return; }
    S.route = { name: 'single', id: id, dir: dir };
    setView('map', 'single');
    S.open.add(id);
    renderMap({ work: w, dir: dir });
    $('#map-title').innerHTML = (dir === 'out' ? 'На что ссылается' : 'Кто ссылается на') +
      ' · <b>' + esc(w.title) + '</b> · <a href="#/w/' + encodeURIComponent(id) + '">страница произведения</a>';
  }

  /* ================= карта ================= */
  function shownCount(id) { var v = S.page.get(id); return v == null ? Layout.C.PAGE : v; }

  function makeCtx(mode) {
    return {
      mode: mode || null,
      view: mapView(),
      isOpen: function (id) { return S.open.has(id); },
      shown: shownCount,
      outCount: function (id) { return outOf(id).length; },
      list: function (id, dir) {
        var seen = {};
        return (dir === 'in' ? inOf(id) : outOf(id)).map(function (e) {
          var w = S.works.get(dir === 'in' ? e.from : e.to);
          if (!w || seen[w.id]) return null;
          seen[w.id] = 1;
          var n = outOf(w.id).length;
          return { id: w.id, title: w.title, spine: w.spine, hasRefs: n > 0, count: n };
        }).filter(Boolean).sort(sortWorks);
      }
    };
  }

  function curMode() {
    return S.route.name === 'single' ? { work: S.works.get(S.route.id), dir: S.route.dir } : null;
  }

  function renderMap(mode, keepView) {
    L = Layout.build(makeCtx(mode), window.SPINE || []);
    var nodesEl = $('#nodes'), svg = $('#edges'), bandsEl = $('#bands');
    nodesEl.innerHTML = ''; svg.innerHTML = ''; bandsEl.innerHTML = '';

    var bb = L.bbox;
    var w = Math.max(bb.maxX - bb.minX, 1), h = Math.max(bb.maxY - bb.minY, 1);
    svg.setAttribute('viewBox', bb.minX + ' ' + bb.minY + ' ' + w + ' ' + h);
    svg.style.left = bb.minX + 'px'; svg.style.top = bb.minY + 'px';
    svg.style.width = w + 'px'; svg.style.height = h + 'px';

    var g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    L.edges.forEach(function (e) {
      var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', e.d); p.setAttribute('class', e.cls);
      g.appendChild(p);
    });

    /* эпохи: подписи и разделители */
    (L.bands || []).forEach(function (b, i) {
      var d = document.createElement('div');
      d.className = 'band';
      d.style.left = b.x1 + 'px'; d.style.top = b.y + 'px'; d.style.width = (b.x2 - b.x1) + 'px';
      d.innerHTML = '<b>' + esc(b.title) + '</b><span>' + esc(b.span) + '</span>';
      bandsEl.appendChild(d);
      if (i > 0) {
        var px = (L.bands[i - 1].x2 + b.x1) / 2;
        var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', 'M' + px + ' ' + b.y + 'V' + bb.maxY);
        p.setAttribute('class', 'epoch-sep');
        g.insertBefore(p, g.firstChild);
      }
    });
    (L.labels || []).forEach(function (lb) {
      var d = document.createElement('div');
      d.className = 'lane-cap';
      d.style.left = lb.x + 'px'; d.style.top = lb.y + 'px';
      d.textContent = lb.text;
      bandsEl.appendChild(d);
    });
    svg.appendChild(g);

    var frag = document.createDocumentFragment();
    L.nodes.forEach(function (n) { frag.appendChild(buildBox(n, true, mode)); });
    L.items.forEach(function (it) { frag.appendChild(it.kind === 'more' ? buildMore(it, mode) : buildBox(it, false, mode)); });
    nodesEl.appendChild(frag);

    if (!keepView) fit(); else { applyView(); drawMini(); }
  }

  function plaque(open, hasRefs, count) {
    var svg = open
      ? '<svg viewBox="0 0 10 10"><path d="M2 3.4 L5 6.6 L8 3.4 Z"/></svg>'
      : '<svg viewBox="0 0 10 10"><path d="M6.6 2 L3.4 5 L6.6 8 Z"/></svg>';
    return '<span class="plaque' + (open ? ' open' : '') + (hasRefs ? '' : ' none') +
      '" data-plaque title="' + (hasRefs ? 'Показать отсылки' : 'Отсылок нет') + '">' + svg +
      (count ? '<span class="cnt">' + count + '</span>' : '') + '</span>';
  }

  function buildBox(n, isNode, mode) {
    var w = S.works.get(n.workId) || {};
    var el = document.createElement('div');
    var hasRefs = isNode ? n.count > 0 : n.hasRefs;
    el.className = (isNode ? 'node spine' : 'item' + (n.spine ? ' spine' : '')) +
      (n.alt ? ' alt' : '') + (isRead(n.workId) ? ' read' : '') +
      (S.dev ? (hasText(w) ? ' has-text' : ' no-text') : '');
    el.style.left = n.x + 'px'; el.style.top = n.y + 'px';
    el.style.width = n.w + 'px'; el.style.height = n.h + 'px';
    el.setAttribute('data-id', n.workId);
    el.innerHTML =
      plaque(n.open, hasRefs, n.count) +
      (S.dev ? '<span class="tx" title="' + (hasText(w) ? 'Текст загружен' : 'Текста нет') + '"></span>' : '') +
      '<span class="lbl">' + esc(n.title) + '</span>' +
      '<span class="mark-read" data-read title="Отметить как прочитанное">' +
      '<svg viewBox="0 0 10 10"><path d="M1.6 5.2 L4 7.4 L8.4 2.6"/></svg></span>' +
      (!isNode && n.spine ? '<span class="sdot"></span>' : '') +
      (isNode && n.year ? '<span class="yr">' + esc(n.year) + '</span>' : '');

    el.addEventListener('click', function (ev) {
      if (ev.target.closest('[data-plaque],[data-read]')) return;
      location.hash = '#/w/' + encodeURIComponent(n.workId);
    });
    el.querySelector('[data-plaque]').addEventListener('click', function (ev) {
      ev.stopPropagation(); ev.preventDefault();
      if (hasRefs) toggle(n.workId, el, mode);
    });
    el.querySelector('[data-read]').addEventListener('click', function (ev) {
      ev.stopPropagation(); ev.preventDefault();
      toggleRead(n.workId);
    });
    return el;
  }

  function buildMore(it, mode) {
    var el = document.createElement('div');
    el.className = 'item more';
    el.style.left = it.x + 'px'; el.style.top = it.y + 'px';
    el.style.width = it.w + 'px'; el.style.height = it.h + 'px';
    el.textContent = it.title;
    el.onclick = function () {
      var prev = shownCount(it.workId);
      S.page.set(it.workId, prev + Layout.C.PAGE);
      pushHistory({ label: 'показ ещё отсылок', undo: function () { S.page.set(it.workId, prev); renderMap(curMode(), true); } });
      renderMap(mode || null, true);
    };
    return el;
  }

  function cssq(s) { return String(s).replace(/["\\]/g, '\\$&'); }
  function elOf(id) { return $('#nodes [data-id="' + cssq(id) + '"]'); }

  function toggle(id, el, mode) {
    var r0 = el.getBoundingClientRect();
    var was = S.open.has(id);
    if (was) S.open.delete(id); else S.open.add(id);
    renderMap(mode || curMode(), true);
    var el2 = elOf(id);
    if (el2) {
      var r1 = el2.getBoundingClientRect();
      S.view.x += r0.left - r1.left; S.view.y += r0.top - r1.top;
      applyView(); drawMini();
    }
    pushHistory({
      label: (was ? 'сворачивание ветки: ' : 'раскрытие ветки: ') + (S.works.get(id) || {}).title,
      undo: function () { if (was) S.open.add(id); else S.open.delete(id); renderMap(curMode(), true); }
    });
  }

  /* ================= вид ================= */
  function applyView() {
    $('#world').style.transform = 'translate(' + S.view.x + 'px,' + S.view.y + 'px) scale(' + S.view.k + ')';
  }

  function centerOn(n, k) {
    var st = $('#stage').getBoundingClientRect();
    S.view.k = k;
    S.view.x = st.width / 2 - (n.x + n.w / 2) * k;
    S.view.y = st.height / 2 - (n.y + n.h / 2) * k;
  }

  function fit() {
    if (!L) return;
    var bb = L.bbox, st = $('#stage').getBoundingClientRect();
    var w = Math.max(bb.maxX - bb.minX, 1), h = Math.max(bb.maxY - bb.minY, 1);
    var k = Math.min((st.width - 144) / w, (st.height - 144) / h, 1.1);
    if (k < 0.55) {
      var want = S.route.id || (mapView() === 'epochs' ? (L.nodes[0] || {}).workId : 'faust');
      var a = L.nodes.filter(function (n) { return n.workId === want; })[0] || L.nodes[0];
      if (a) { centerOn(a, 0.55); applyView(); drawMini(); return; }
    }
    S.view.k = Math.max(k, 0.02);
    S.view.x = (st.width - w * S.view.k) / 2 - bb.minX * S.view.k;
    S.view.y = (st.height - h * S.view.k) / 2 - bb.minY * S.view.k;
    applyView(); drawMini();
  }

  function zoomAt(f, cx, cy) {
    var st = $('#stage').getBoundingClientRect();
    if (cx == null) { cx = st.width / 2; cy = st.height / 2; }
    var k0 = S.view.k, k1 = Math.min(Math.max(k0 * f, 0.02), 3);
    var wx = (cx - S.view.x) / k0, wy = (cy - S.view.y) / k0;
    S.view.k = k1; S.view.x = cx - wx * k1; S.view.y = cy - wy * k1;
    applyView(); drawMini();
  }

  function drawMini() {
    var cv = $('#minimap-canvas');
    if (!cv || !L) return;
    var c = cv.getContext('2d'), W = cv.width, H = cv.height;
    c.clearRect(0, 0, W, H);
    var bb = L.bbox, pad = 10;
    var k = Math.min((W - pad * 2) / Math.max(bb.maxX - bb.minX, 1), (H - pad * 2) / Math.max(bb.maxY - bb.minY, 1));
    var ox = pad - bb.minX * k, oy = pad - bb.minY * k;
    L.items.forEach(function (it) {
      c.fillStyle = isRead(it.workId) ? '#2f8b4f' : '#2f3541';
      c.fillRect(ox + it.x * k, oy + it.y * k, Math.max(it.w * k, 1), Math.max(it.h * k, 1));
    });
    L.nodes.forEach(function (n) {
      c.fillStyle = isRead(n.workId) ? '#4ade80' : (n.alt ? '#8a7a4a' : '#6b5aa3');
      c.fillRect(ox + n.x * k, oy + n.y * k, Math.max(n.w * k, 2), Math.max(n.h * k, 2));
    });
    var st = $('#stage').getBoundingClientRect();
    c.strokeStyle = 'rgba(167,139,250,.85)';
    c.strokeRect(ox - S.view.x / S.view.k * k, oy - S.view.y / S.view.k * k, st.width / S.view.k * k, st.height / S.view.k * k);
  }

  /* ================= облако с аннотацией ================= */
  var tipT = null;
  function showTip(el) {
    if (!Acc.data.prefs.annotations) return;
    var id = el.getAttribute('data-id');
    var text = annotationOf(id);
    if (!text) return;
    var w = S.works.get(id);
    var tip = $('#ann-tip');
    tip.innerHTML = '<b>' + esc(w.title) + '</b>' + (w.author ? '<i>' + esc(w.author) + '</i>' : '') + '<p>' + esc(text) + '</p>';
    tip.hidden = false;
    var r = el.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
    var x = Math.min(Math.max(8, r.left + r.width / 2 - tw / 2), innerWidth - tw - 8);
    var y = r.top - th - 12;
    if (y < 64) y = r.bottom + 12;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  function hideTip() { clearTimeout(tipT); var t = $('#ann-tip'); if (t) t.hidden = true; }

  function renderAnnBtn() {
    var on = Acc.data.prefs.annotations;
    $('#btn-ann').textContent = on ? 'Отключить аннотации' : 'Включить аннотации';
    $('#btn-ann').classList.toggle('off', !on);
  }

  /* ================= страница произведения ================= */
  var reader = null;

  function showWork(id) {
    var w = S.works.get(id);
    if (!w) { location.hash = '#/map'; return; }
    S.route = { name: 'work', id: id };
    guardWorkId = id;
    setView('work');
    renderWork(w);
    $('#view-work').scrollTop = 0;
  }

  function renderWork(w) {
    $('#w-title').textContent = w.title;
    var meta = [];
    if (w.author) meta.push('<span>' + esc(w.author) + '</span>');
    if (w.year) meta.push('<span>' + esc(w.year) + '</span>');
    $('#w-meta').innerHTML = meta.join('');
    var ann = annotationOf(w.id);
    $('#w-ann').textContent = ann;
    $('#w-ann').hidden = !ann;
    renderWorkTags(w);
    renderDevPanel(w);

    fillList($('#w-out'), outOf(w.id), 'to', '#w-out-cnt', '#w-out-empty');
    fillList($('#w-in'), inOf(w.id), 'from', '#w-in-cnt', '#w-in-empty');
    $('#w-out-title').onclick = function () { location.hash = '#/m/' + encodeURIComponent(w.id) + '/out'; };
    $('#w-in-title').onclick = function () { location.hash = '#/m/' + encodeURIComponent(w.id) + '/in'; };

    openReader(w);
    Ads.fill($('#view-work'));
  }

  function renderWorkTags(w) {
    if (!w) return;
    var tags = [];
    if (w.spine) tags.push('<span class="tag g">хронологическая линия</span>');
    var st = textState(w);
    if (STATE_LABEL[st]) tags.push('<span class="tag st-' + st + '">' + STATE_LABEL[st] + '</span>');
    if (S.dev && statusOf(w.id) === 'copyright' && hasText(w)) tags.push('<span class="tag st-copyright">© текст скрыт от пользователей</span>');
    var r = isRead(w.id);
    tags.push('<button class="tag read-btn' + (r ? ' on' : '') + '" data-read-work>' +
      (r ? '✓ прочитано' : 'отметить как прочитанное') + '</button>');
    $('#w-tags').innerHTML = tags.join('');
    $('#w-tags [data-read-work]').onclick = function () { toggleRead(w.id); };
  }

  function fillList(ol, edges, key, cntSel, emptySel) {
    ol.innerHTML = '';
    var seen = {}, n = 0;
    edges.forEach(function (e) {
      var id = e[key];
      if (seen[id]) return;
      seen[id] = 1;
      var w = S.works.get(id);
      if (!w) return;
      n++;
      var li = document.createElement('li');
      li.innerHTML = '<a href="#/w/' + encodeURIComponent(id) + '"' + (isRead(id) ? ' class="is-read"' : '') + '>' +
        '<span class="num">' + n + '</span><span class="txt">' + esc(w.title) +
        (w.author ? '<span class="a">' + esc(w.author) + '</span>' : '') + '</span>' +
        (w.spine ? '<span class="spine-dot" title="есть на хронологической линии"></span>' : '') + '</a>';
      ol.appendChild(li);
    });
    $(cntSel).textContent = n;
    $(emptySel).classList.toggle('hide', n > 0);
  }

  /* ---------- чтение ---------- */
  function closeReader() {
    if (reader) { reader.destroy(); reader = null; }
    $('#hl-bar').hidden = true; $('#hl-del').hidden = true;
    if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
  }

  function setReaderTools(on, w) {
    ['#rd-continue', '#rd-download', '#rd-full'].forEach(function (s) { $(s).hidden = !on; });
    $('#rd-foot').hidden = false;
    $('#bm-block').hidden = !on;
    if (on) {
      var can = Acc.isSubscriber() || S.dev;
      $('#rd-download').disabled = !can;
      $('#rd-download').title = can ? 'Скачать текст' : 'Скачивание доступно подписчикам';
      $('#rd-download').textContent = can ? '↓ Скачать' : '🔒 Скачать';
    }
    renderFinishBtn(w);
  }

  function renderFinishBtn(w) {
    var b = $('#rd-finish');
    var j = Acc.data.journey;
    var cur = j && j.active && j.current === w.id;
    b.textContent = cur ? 'Дочитал(а) — дальше по маршруту →' : (isRead(w.id) ? '✓ Книга прочитана' : 'Я дочитал(а) книгу');
    b.classList.toggle('done', !cur && isRead(w.id));
  }

  function placeholder(html) {
    $('#w-doc-holder').classList.add('empty');
    $('#w-doc-holder').innerHTML = '<div class="ph">' + html + '</div>';
  }

  function openReader(w) {
    closeReader();
    var holder = $('#w-doc-holder');
    holder.classList.remove('empty');
    holder.innerHTML = '';
    $('#w-progress-label').textContent = 'Текст произведения';
    $('#rd-bar').style.width = '0%';
    renderBookmarks(w);

    var st = textState(w);
    if (st !== 'text') {
      setReaderTools(false, w);
      if (st === 'link') {
        placeholder('Текст доступен по внешней ссылке<br><a href="' + esc(w.url) + '" target="_blank" rel="noopener">' + esc(w.url) + '</a>');
      } else {
        placeholder('<span class="ph-big st-' + st + '">' + STATE_LABEL[st] + '</span>' +
          (st === 'copyright' ? '<small>Оригинальный текст охраняется авторским правом и не может быть опубликован.</small>' :
           st === 'lost' ? '<small>Текст этого произведения не сохранился.</small>' :
           '<small>Мы ещё не добавили текст этого произведения.</small>') +
          (S.dev ? '<br><a href="#" data-upload-for="' + esc(w.id) + '">загрузить документ</a>' : ''));
      }
      return;
    }

    /* лимит гостя */
    if (!S.dev && !Acc.canRead(w.id)) {
      setReaderTools(false, w);
      $('#rd-foot').hidden = true;
      placeholder('<span class="ph-big">Бесплатные книги закончились</span>' +
        '<small>Гостям доступно ' + Acc.FREE_BOOKS + ' книг бесплатно и ещё по одной за каждого приглашённого друга. ' +
        'Вы уже открыли ' + Acc.used() + ' из ' + Acc.limit() + '.</small>' +
        '<div class="ph-actions"><a class="tb prim" href="#/subscribe">Оформить подписку</a>' +
        '<a class="tb" href="#/profile">Пригласить друга</a></div>');
      return;
    }

    setReaderTools(true, w);
    holder.innerHTML = '<div class="ph">Загрузка текста…</div>';
    var myId = w.id;
    getDocHtml(w).then(function (html) {
      if (S.route.name !== 'work' || S.route.id !== myId) return;
      if (!html) { placeholder('<span class="ph-big st-later">Добавится позже</span><small>Не удалось загрузить текст.</small>'); setReaderTools(false, w); return; }
      holder.innerHTML = '';
      if (!S.dev) Acc.markOpened(w.id);
      reader = new Reader({
        id: w.id, host: holder,
        onUndoable: pushHistory,
        onChange: function (kind) { renderBookmarks(w); renderProgress(w); if (reader && kind !== 'scroll') reader.paintMarks(); }
      });
      reader.load(html);
      reader.html = html;
      renderProgress(w);
      renderBookmarks(w);
    }).catch(function () {
      placeholder('<span class="ph-big st-later">Добавится позже</span><small>Не удалось загрузить текст.</small>');
    });
  }

  function renderProgress(w) {
    var done = isRead(w.id);
    var p = done ? 1 : (Acc.data.progress[w.id] || 0);
    $('#rd-bar').style.width = Math.round(p * 100) + '%';
    $('#rd-bar').classList.toggle('done', done);
    $('#w-progress-label').textContent = 'Прочитано ' + Math.round(p * 100) + '%' + (done ? ' · книга прочитана' : '');
    $('#w-progress-label').classList.toggle('done', done);
  }

  function renderBookmarks(w) {
    var b = Acc.bookmarks(w.id), ol = $('#bm-list');
    var rows = [];
    if (b.main) {
      rows.push('<li><a href="#" data-bm-main><span class="num">⌂</span><span class="txt">Где остановился' +
        '<span class="a">прочитано ' + Math.round((Acc.data.progress[w.id] || 0) * 100) + '%</span></span></a></li>');
    }
    b.marks.forEach(function (m) {
      rows.push('<li><a href="#" data-bm="' + m.n + '"><span class="num" style="color:' + esc(m.color || '#8b6cf5') + '">№' + m.n + '</span><span class="txt">' +
        esc(m.text || 'закладка') + '</span><span class="x" data-bm-del="' + m.n + '" title="Удалить">×</span></a></li>');
    });
    var hls = Acc.highlights(w.id);
    hls.forEach(function (h) {
      rows.push('<li><a href="#" data-hl-go="' + h.s + '"><span class="num">' + (h.kind === 'mark' ? '▮' : '_') +
        '</span><span class="txt q">«' + esc(h.text.slice(0, 80)) + (h.text.length > 80 ? '…' : '') + '»</span></a></li>');
    });
    ol.innerHTML = rows.join('');
    $('#bm-cnt').textContent = b.marks.length + hls.length;
    $('#bm-empty').classList.toggle('hide', rows.length > 0);
  }

  /* ---------- панель разработчика ---------- */
  function renderDevPanel(w) {
    var p = $('#w-dev');
    if (!S.dev) { p.innerHTML = ''; return; }
    var st = statusOf(w.id);
    var has = hasText(w);
    var own = S.devData.docIds.indexOf(w.id) >= 0;
    p.innerHTML =
      '<div class="dev-row"><b>Текст:</b> ' +
        (has ? '<span class="ok">загружен</span>' : '<span class="no">нет</span>') +
        (w.url ? ' · внешняя ссылка' : '') +
        ' <button class="mini" data-dev-upload>' + (has ? 'Заменить документ' : 'Загрузить текст и отсылки') + '</button>' +
        (own ? ' <button class="mini" data-dev-rmdoc>Удалить загруженный текст</button>' : '') +
      '</div>' +
      '<div class="dev-row"><b>Если текста нет, пользователь видит:</b>' +
        '<label><input type="radio" name="dst" value=""' + (st === '' ? ' checked' : '') + '> «Добавится позже» (авто)</label>' +
        '<label><input type="radio" name="dst" value="copyright"' + (st === 'copyright' ? ' checked' : '') + '> «Авторские права»</label>' +
        '<label><input type="radio" name="dst" value="lost"' + (st === 'lost' ? ' checked' : '') + '> «До нас не дошёл»</label>' +
        '<span class="hint-s">«Авторские права» скрывает текст от пользователей, даже если он загружен.</span>' +
      '</div>' +
      '<div class="dev-row col"><b>Аннотация</b> <span class="hint-s">— 2–4 предложения, появляются в облаке при наведении на прямоугольник</span>' +
        '<textarea id="dev-ann" rows="3" placeholder="Краткая аннотация…">' + esc(S.devData.annotations[w.id] != null ? S.devData.annotations[w.id] : annotationOf(w.id)) + '</textarea>' +
        '<div><button class="mini prim" data-dev-ann>Сохранить аннотацию</button></div>' +
      '</div>';

    p.querySelector('[data-dev-upload]').onclick = function () { openDialog({ id: w.id }); };
    var rm = p.querySelector('[data-dev-rmdoc]');
    if (rm) rm.onclick = function () {
      if (!confirm('Удалить загруженный текст «' + w.title + '»? Отсылки останутся.')) return;
      S.devData.docIds = S.devData.docIds.filter(function (x) { return x !== w.id; });
      var dw = S.devData.works.filter(function (x) { return x.id === w.id; })[0];
      if (dw) dw.hasDoc = false;
      w.hasDoc = false;
      DocStore.remove(w.id);
      devSave();
      renderWork(w);
    };
    $$('input[name="dst"]', p).forEach(function (r) {
      r.onchange = function () {
        var prev = statusOf(w.id);
        S.devData.status[w.id] = r.value;
        devSave();
        pushHistory({ label: 'пометка текста', undo: function () { S.devData.status[w.id] = prev; devSave(); renderWork(w); } });
        renderWork(w);
      };
    });
    p.querySelector('[data-dev-ann]').onclick = function () {
      var prev = S.devData.annotations[w.id];
      S.devData.annotations[w.id] = $('#dev-ann').value.trim();
      devSave();
      pushHistory({ label: 'аннотация', undo: function () { S.devData.annotations[w.id] = prev; devSave(); renderWork(w); } });
      $('#w-ann').textContent = annotationOf(w.id);
      $('#w-ann').hidden = !annotationOf(w.id);
      toast('Аннотация сохранена');
    };
  }

  /* ================= профиль ================= */
  function workLink(id) {
    var w = S.works.get(id);
    return w ? '<a href="#/w/' + encodeURIComponent(id) + '">' + esc(w.title) + '</a>' +
      (w.author ? ' <span class="a">' + esc(w.author) + '</span>' : '') : '';
  }

  function showProfile() {
    S.route = { name: 'profile' };
    setView('profile');
    var A = Acc.data, sub = Acc.isSubscriber();
    var plan = A.plan && Acc.PLANS[A.plan];
    var until = A.paidUntil ? new Date(A.paidUntil).toLocaleDateString('ru-RU') : '';

    var finished = A.finished.filter(function (id) { return S.works.has(id); });
    var progress = Acc.inProgress().filter(function (id) { return S.works.has(id); });
    var j = A.journey;

    $('#profile-root').innerHTML =
      '<h1>Профиль</h1>' +
      '<section class="card status ' + (sub ? 'sub' : 'guest') + '">' +
        '<div class="st-head"><span class="badge">' + (sub ? 'Подписчик' : 'Гость') + '</span>' +
          (sub ? '<span>' + esc(plan.title) + (until ? ' · до ' + until : ' · навсегда') + '</span>' : '<span>бесплатная версия</span>') + '</div>' +
        (sub
          ? '<ul class="perks"><li>Неограниченный доступ ко всем книгам</li><li>Без рекламы</li><li>Скачивание текстов</li></ul>' +
            '<a class="tb" href="#/subscribe">Продлить</a>'
          : '<div class="quota"><div class="q-bar"><i style="width:' + Math.min(100, Acc.used() / Acc.limit() * 100) + '%"></i></div>' +
              '<span>Открыто книг: <b>' + Acc.used() + '</b> из <b>' + Acc.limit() + '</b> бесплатных</span></div>' +
            '<ul class="perks off"><li>Есть реклама</li><li>Нельзя скачивать тексты</li><li>Бесплатно ' + Acc.FREE_BOOKS + ' книг + 1 за каждого друга</li></ul>' +
            '<a class="tb prim" href="#/subscribe">Оформить подписку</a>') +
      '</section>' +

      (!sub ? '<section class="card"><h2>Пригласить друзей</h2>' +
        '<p class="muted">За каждого друга, который откроет сайт по вашей ссылке, вы получаете ещё одну бесплатную книгу. Засчитано приглашений: <b>' + (A.invites || 0) + '</b>.</p>' +
        '<div class="invite"><input id="inv-link" readonly value="' + esc(Acc.inviteLink()) + '"><button class="tb" id="inv-copy">Скопировать</button>' +
        (navigator.share ? '<button class="tb" id="inv-share">Поделиться…</button>' : '') + '</div>' +
        (S.dev ? '<p class="dev-only-inline"><button class="mini" id="inv-test">+1 приглашение (тест разработчика)</button></p>' : '') +
        '</section>' : '') +

      '<section class="card"><h2>Читаю сейчас <span class="cnt">' + progress.length + '</span></h2>' +
        (progress.length ? '<ul class="books">' + progress.map(function (id) {
          var p = Math.round((A.progress[id] || 0) * 100);
          return '<li>' + workLink(id) + '<div class="b-bar"><i style="width:' + p + '%"></i></div><span class="pct">' + p + '%</span></li>';
        }).join('') + '</ul>' : '<p class="muted">Начните читать любую книгу — она появится здесь.</p>') +
      '</section>' +

      '<section class="card"><h2>Прочитано <span class="cnt">' + finished.length + '</span></h2>' +
        (finished.length ? '<ol class="books done">' + finished.map(function (id) { return '<li>' + workLink(id) + '</li>'; }).join('') + '</ol>'
          : '<p class="muted">Отмечайте прочитанные книги кружком на карте или кнопкой «Я дочитал(а)».</p>') +
      '</section>' +

      '<section class="card"><h2>Маршрут</h2>' +
        (j && j.active
          ? '<p>Вы читаете <b>по порядку</b> — ' + (j.kind === 'epochs' ? 'по временным эпохам' : 'в глобальной хронологии') +
            '. Сейчас: ' + workLink(j.current) + '.</p><button class="tb prim" id="jr-go">Продолжить маршрут</button> <button class="tb" id="jr-stop">Перейти в свободный режим</button>'
          : '<p class="muted">Сейчас свободный режим.</p><button class="tb" id="jr-start">Читать по порядку…</button>') +
      '</section>' +

      promoBlock() +

      '<section class="card"><h2>Настройки</h2>' +
        '<label class="sw"><input type="checkbox" id="pf-ann"' + (A.prefs.annotations ? ' checked' : '') + '> Показывать аннотации при наведении на произведение</label>' +
      '</section>';

    var c = $('#inv-copy');
    if (c) c.onclick = function () {
      var inp = $('#inv-link'); inp.select();
      (navigator.clipboard ? navigator.clipboard.writeText(inp.value) : Promise.reject()).then(
        function () { toast('Ссылка скопирована'); },
        function () { document.execCommand('copy'); toast('Ссылка скопирована'); });
    };
    var sh = $('#inv-share');
    if (sh) sh.onclick = function () { navigator.share({ title: 'Refs.Books', url: Acc.inviteLink() }).catch(function () {}); };
    var it = $('#inv-test');
    if (it) it.onclick = function () { Acc.creditInvite(1); showProfile(); };
    $('#pf-ann').onchange = function () { Acc.data.prefs.annotations = this.checked; Acc.save(); renderAnnBtn(); };
    var g = $('#jr-go'); if (g) g.onclick = function () { flyToCurrent(); };
    var s = $('#jr-stop'); if (s) s.onclick = function () { Acc.data.journey.active = false; Acc.save(); showProfile(); };
    var st = $('#jr-start'); if (st) st.onclick = chooseOrder;
    bindPromo();
  }

  /* промокоды розыгрыша в профиле: список + строка ввода */
  function promoBlock() {
    var list = Acc.promos() || [];
    var rows = list.map(function (p) {
      return '<li' + (p.claimedAt ? ' class="used"' : '') + '><code>' + esc(p.code) + '</code>' +
        '<span>' + (p.days === 365 ? 'год подписки' : p.days + ' дн.') + '</span>' +
        (p.claimedAt ? '<span class="ok">активирован</span>' : '<span class="muted">выигранный промокод — введите его ниже</span>') + '</li>';
    }).join('');
    return '<section class="card"><h2>Промокоды</h2>' +
      (rows ? '<ul class="promos">' + rows + '</ul>'
        : '<p class="muted">Промокод с розыгрыша появится здесь. <a href="#/raffle">Перейти к розыгрышу →</a></p>') +
      '<div class="promo-form"><input id="promo-in" type="text" placeholder="Введите промокод" autocomplete="off" spellcheck="false">' +
        '<button class="tb prim" id="promo-go">Активировать</button></div>' +
      '<p class="muted" style="font-size:12px;margin-top:8px">Промокод бессрочный и привязан к вашему профилю. Срок прибавляется к действующей подписке.</p>' +
      '</section>';
  }

  function bindPromo() {
    var inp = $('#promo-in'), btn = $('#promo-go');
    if (!inp || !btn) return;
    var go = function () {
      var r = Acc.redeemPromo(inp.value);
      if (!r.ok) { toast(r.error); return; }
      toast('Промокод активирован: +' + r.days + ' дней подписки');
      showProfile();
    };
    btn.onclick = go;
    inp.onkeydown = function (ev) { if (ev.key === 'Enter') go(); };
  }

  function renderStatusChip() {
    var sub = Acc.isSubscriber();
    $('#profile-status').textContent = sub ? 'Подписчик' : 'Гость';
    $('#btn-profile').classList.toggle('sub', sub);
    document.body.classList.toggle('is-sub', sub);
  }

  /* ================= подписка ================= */
  var payState = { plan: 'year', method: 'mir', busy: false };

  function showSubscribe() {
    S.route = { name: 'subscribe' };
    setView('subscribe');
    renderSubscribe();
  }

  function renderSubscribe() {
    var P = Acc.PLANS;
    var plans = ['month', 'year', 'lifetime'].map(function (k) {
      var p = P[k];
      var hint = k === 'month' ? '200 ₽ в месяц' : k === 'year' ? '125 ₽ в месяц · выгода 37%' : 'один платёж — навсегда';
      return '<button class="plan' + (payState.plan === k ? ' on' : '') + (k === 'year' ? ' best' : '') + '" data-plan="' + k + '">' +
        (k === 'year' ? '<span class="ribbon">выгодно</span>' : '') +
        '<span class="p-title">' + p.title + '</span><span class="p-price">' + p.price.toLocaleString('ru-RU') + ' ₽</span>' +
        '<span class="p-hint">' + hint + '</span></button>';
    }).join('');
    var methods = Payments.METHODS.map(function (m) {
      return '<button class="pm' + (payState.method === m.id ? ' on' : '') + '" data-method="' + m.id + '">' + m.title + '</button>';
    }).join('');
    var price = P[payState.plan].price.toLocaleString('ru-RU');

    $('#subscribe-root').innerHTML =
      '<h1>Подписка Refs.Books</h1>' +
      '<p class="lead">Неограниченный доступ ко всем книгам, никакой рекламы и возможность скачивать тексты.</p>' +
      (Acc.isSubscriber() ? '<p class="note ok">У вас уже есть подписка. Новый платёж продлит её срок.</p>' : '') +
      '<div class="plans">' + plans + '</div>' +
      '<h2>Способ оплаты</h2><div class="pms">' + methods + '</div>' +
      '<button class="tb prim pay" id="pay-btn"' + (payState.busy ? ' disabled' : '') + '>' +
        (payState.busy ? 'Обработка…' : 'Оплатить ' + price + ' ₽') + '</button>' +
      (Payments.isDemo()
        ? '<p class="note">Демонстрационный режим: платёжный сервис ещё не подключён, деньги не списываются, подписка выдаётся сразу. Подключение — в <code>js/payments.js</code>.</p>'
        : '<p class="note">Вы будете перенаправлены на защищённую страницу платёжного сервиса.</p>');

    $$('#subscribe-root [data-plan]').forEach(function (b) { b.onclick = function () { payState.plan = b.getAttribute('data-plan'); renderSubscribe(); }; });
    $$('#subscribe-root [data-method]').forEach(function (b) { b.onclick = function () { payState.method = b.getAttribute('data-method'); renderSubscribe(); }; });
    $('#pay-btn').onclick = function () {
      payState.busy = true; renderSubscribe();
      Payments.checkout(payState.plan, payState.method).then(function (r) {
        payState.busy = false;
        if (r.redirect) return;
        Ads.refresh();
        toast('Подписка оформлена');
        location.hash = '#/profile';
      }).catch(function (e) {
        payState.busy = false; renderSubscribe();
        toast('Оплата не прошла: ' + e.message);
      });
    };
  }

  /* ================= каталог ================= */
  var catState = { q: '', filter: 'all' };

  function showCatalog() {
    S.route = { name: 'catalog' };
    setView('catalog');
    renderCatalog();
  }

  function renderCatalog() {
    var all = Array.from(S.works.values());
    var withText = all.filter(hasText).length;
    var q = catState.q.toLowerCase();
    var list = all.filter(function (w) {
      if (q && w.title.toLowerCase().indexOf(q) < 0 && (w.author || '').toLowerCase().indexOf(q) < 0) return false;
      if (catState.filter === 'line') return w.spine;
      if (catState.filter === 'read') return isRead(w.id);
      if (catState.filter === 'text') return hasText(w);
      if (catState.filter === 'notext') return !hasText(w);
      return true;
    }).sort(function (a, b) { return a.title.localeCompare(b.title, 'ru'); });

    var filters = [['all', 'Все'], ['line', 'На хронологических линиях'], ['read', 'Прочитанные']];
    if (S.dev) filters.push(['text', 'С текстом'], ['notext', 'Без текста']);

    var letter = '';
    var rows = list.map(function (w, i) {
      var l = w.title.charAt(0).toUpperCase();
      var head = l !== letter ? '<li class="letter">' + esc(l) + '</li>' : '';
      letter = l;
      var st = textState(w);
      return head + '<li class="row' + (isRead(w.id) ? ' is-read' : '') + '"><span class="num">' + (i + 1) + '</span>' +
        '<a href="#/w/' + encodeURIComponent(w.id) + '">' + esc(w.title) + '</a>' +
        (w.author ? '<span class="a">' + esc(w.author) + '</span>' : '') +
        (w.spine ? '<span class="spine-dot" title="на хронологической линии"></span>' : '') +
        (S.dev ? '<span class="dev-st ' + (hasText(w) ? 'ok' : 'no') + '">' + (hasText(w) ? 'текст есть' : STATE_LABEL[st] || 'ссылка') + '</span>' : '') +
        '</li>';
    }).join('');

    $('#catalog-root').innerHTML =
      '<h1>Все произведения <span class="big-cnt">' + all.length + '</span></h1>' +
      '<p class="lead">' + pl(all.length, 'произведение', 'произведения', 'произведений') + ' на сайте — на хронологических линиях и в отсылочных ветках. Список обновляется сам при загрузке новых произведений.' +
        (S.dev ? ' Текст загружен для ' + withText + ', нет — у ' + (all.length - withText) + '.' : '') + '</p>' +
      '<div class="cat-tools"><input id="cat-q" type="search" placeholder="Фильтр по названию или автору" value="' + esc(catState.q) + '">' +
        filters.map(function (f) { return '<button class="fchip' + (catState.filter === f[0] ? ' on' : '') + '" data-f="' + f[0] + '">' + f[1] + '</button>'; }).join('') +
        '<span class="shown">показано: ' + list.length + '</span></div>' +
      '<ul class="catalog">' + rows + '</ul>';

    var inp = $('#cat-q');
    inp.oninput = function () {
      catState.q = inp.value; var pos = inp.selectionStart;
      renderCatalog();
      var n = $('#cat-q'); n.focus(); n.setSelectionRange(pos, pos);
    };
    $$('#catalog-root [data-f]').forEach(function (b) { b.onclick = function () { catState.filter = b.getAttribute('data-f'); renderCatalog(); }; });
  }

  function pl(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    var w = m10 === 1 && m100 !== 11 ? one : (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many);
    return n + ' ' + w;
  }

  /* ================= розыгрыш ================= */
  function showRaffle() {
    S.route = { name: 'raffle' };
    setView('raffle');
    rafState.angle = 0;
    renderRaffle();
    if (window.Raffle && window.Raffle.data.drawn) rafState.result = window.Raffle.data.drawn;
  }

  var rafState = { spinning: false, angle: 0, result: null, paid: false };

  /* название очереди для пользователя: 1 — следующий, 2 — послеследующий, дальше — по номеру */
  function queueName(q) {
    if (q === 1) return 'следующий розыгрыш';
    if (q === 2) return 'послеследующий розыгрыш (2-я очередь)';
    return q + '-я очередь (розыгрыш через ' + q + ')';
  }

  function renderRaffle() {
    var R = window.Raffle, cfg = R.CONFIG, d = R.data;
    var joined = R.isJoined();
    var myQ = R.myQueue ? R.myQueue() : 0;
    var n = R.count(), need = R.needed();
    var drawn = d.drawn;
    var myPromos = (Acc.promos && Acc.promos()) || [];

    var hero =
      '<h1>Розыгрыш годовой подписки</h1>' +
      '<p class="lead">Взнос — ' + cfg.price + ' ₽, он не возвращается. Как только участников становится ' +
        cfg.size + ', стрелка выбирает одного победителя: он получает бессрочный промокод на год подписки. ' +
        'Время по промокоду прибавляется к уже оплаченному сроку.</p>';

    /* --- состояние участия --- */
    var status;
    if (drawn) {
      status = '<div class="rf-status done"><b>Розыгрыш №' + drawn.round + ' завершён.</b> ' +
        (drawn.winner.me ? 'Победитель — вы!' : 'Победитель: ' + esc(drawn.winner.name)) + '</div>';
    } else if (myQ > 0) {
      status = '<div class="rf-status wait"><b>Вы в очереди: ' + queueName(myQ) + '.</b> Взнос уже оплачен — вы попадёте в круг, когда начнётся эта очередь.</div>';
    } else if (joined) {
      status = '<div class="rf-status wait"><b>Вы участвуете.</b> Набрано ' + n + ' из ' + cfg.size +
        ' участников. Осталось ' + need + ' — и розыгрыш начнётся.</div>';
    } else {
      status = '<div class="rf-status open"><b>Вы ещё не участвуете.</b> Взнос ' + cfg.price + ' ₽, сумма не возвращается.</div>';
    }

    if (drawn && myQ > 0) status += '<div class="rf-status wait"><b>Вы в очереди: ' + queueName(myQ) + '.</b></div>';
    var actions = '';
    if (!drawn && !joined) actions = '<div class="rf-actions"><a class="tb" href="#/subscribe">Просто оформить подписку</a></div>';
    if (drawn) actions = '<div class="rf-actions"><button class="tb prim" id="rf-next">Следующий розыгрыш</button>' +
      (drawn.winner.me ? '<a class="tb" href="#/profile">Промокод в профиле</a>' : '') + '</div>';

    var methods = Payments.METHODS.slice(0, 4).map(function (m) {
      return '<button class="pm' + (payState.method === m.id ? ' on' : '') + '" data-rf-method="' + m.id + '">' + m.title + '</button>';
    }).join('');

    /* --- список участников и стрелка --- */
    var list = (drawn ? drawn.entries : d.entries);
    var rows = list.map(function (e, i) {
      var win = drawn && drawn.idx === i;
      return '<li class="' + (e.me ? 'me ' : '') + (win ? 'win' : '') + '">' +
        '<span class="n">' + (i + 1) + '</span><span class="nm">' + esc(e.name) + '</span>' +
        (e.me ? '<span class="you">это вы</span>' : '') +
        (win ? '<span class="crown">победитель</span>' : '') + '</li>';
    }).join('');
    if (!list.length) rows = '<li class="empty-row">Пока никто не участвует — начните первым.</li>';

    /* колесо: список в столбик, слева от него стрелка */
    var wheel =
      '<div class="rf-wheel' + (rafState.spinning ? ' spinning' : '') + '">' +
        '<div class="rf-arrow" style="--a:' + rafState.angle + 'deg">➤</div>' +
        '<ol class="rf-list" id="rf-list">' + rows + '</ol>' +
      '</div>';

    var devTools = S.dev
      ? '<div class="rf-dev dev-only">' +
          '<b>Проверка (только разработчик):</b> ' +
          '<button class="mini" id="rf-bot">+1 демо-участник</button> ' +
          '<button class="mini" id="rf-fill">Заполнить до ' + cfg.size + '</button> ' +
          '<span class="hint-s">Настоящие участники приходят с сервера — см. Raffle.backend.</span></div>'
      : '';

    var payBlock = '';
    if (!joined) {
      payBlock = '<div class="rf-pay"><h2>Взнос</h2>' + (R.roundOpen() ? '' : '<p class="note">Текущий розыгрыш уже начался или набрал ' + cfg.size + ' участников — вы встанете в очередь на следующий.</p>') + '<div class="pms">' + methods + '</div>' +
        '<button class="tb prim pay" id="rf-paybtn">Оплатить взнос ' + cfg.price + ' ₽</button>' +
        (Payments.isDemo() ? '<p class="note">Демонстрационный режим: платёжный сервис не подключён, деньги не списываются, участие засчитывается сразу.</p>' : '') +
        '</div>';
    }

    var myCodes = '';
    if (myPromos.length) {
      myCodes = '<section class="card"><h2>Ваши промокоды</h2><ul class="promos">' + myPromos.map(function (p) {
        return '<li' + (p.claimedAt ? ' class="used"' : '') + '><code>' + esc(p.code) + '</code>' +
          '<span>' + (p.days === 365 ? 'год подписки' : p.days + ' дн.') + '</span>' +
          (p.claimedAt ? '<span class="ok">активирован</span>' : '<span class="muted">введите его в профиле</span>') + '</li>';
      }).join('') + '</ul><a class="tb" href="#/profile">Ввести промокод</a></section>';
    }

    $('#raffle-root').innerHTML = hero + status +
      '<div class="rf-progress"><i style="width:' + Math.min(100, n / cfg.size * 100) + '%"></i></div>' +
      '<div class="rf-count"><b>' + n + '</b> из ' + cfg.size + ' участников' + (drawn ? '' : ' · осталось ' + need) + '</div>' +
      wheel + actions + payBlock + devTools + myCodes +
      '<section class="card rf-rules"><h2>Правила</h2><ol>' +
        '<li>Взнос — ' + cfg.price + ' ₽ за круг. Сумма не возвращается.</li>' +
        '<li>Розыгрыш начинается сразу, как только участников становится ' + cfg.size + '.</li>' +
        '<li>Если розыгрыш уже начался или набрал ' + cfg.size + ' участников, вы встаёте в очередь на следующий; если и он заполнен — в послеследующий, и так далее. Номер вашей очереди виден в статусе участия.</li>' +
        '<li>Победителя выбирает случайная стрелка из списка участников.</li>' +
        '<li>Промокод на год (' + cfg.prizeDays + ' дней) появляется в профиле победителя. Он бессрочный, но привязан к профилю: передать его другому человеку нельзя.</li>' +
        '<li>Если выигрышных промокодов несколько — их сроки складываются и прибавляются к действующей подписке.</li>' +
      '</ol></section>';

    /* --- обработчики --- */
    $$('#raffle-root [data-rf-method]').forEach(function (b) {
      b.onclick = function () { payState.method = b.getAttribute('data-rf-method'); renderRaffle(); };
    });
    var payBtn = $('#rf-paybtn');
    if (payBtn) payBtn.onclick = function () {
      payBtn.disabled = true; payBtn.textContent = 'Обработка…';
      Payments.checkout('raffle', payState.method, { amount: cfg.price, kind: 'raffle' })
        .then(function () {
          var r = R.join();
          if (!r.ok) { toast(r.error); renderRaffle(); return; }
          toast(r.queue ? 'Взнос засчитан — вы в очереди: ' + queueName(r.queue) : 'Вы в игре — засчитан взнос ' + cfg.price + ' ₽');
          renderRaffle();
          maybeDraw();
        })
        .catch(function (e) { payBtn.disabled = false; toast('Оплата не прошла: ' + e.message); renderRaffle(); });
    };
    var joinBtn = $('#rf-join');
    if (joinBtn) joinBtn.onclick = function () {
      var r = R.join();
      if (!r.ok) { toast(r.error); return; }
      toast('Вы участвуете');
      renderRaffle();
      maybeDraw();
    };
    var bot = $('#rf-bot');
    if (bot) bot.onclick = function () { R.addDemo(1); renderRaffle(); maybeDraw(); };
    var fill = $('#rf-fill');
    if (fill) fill.onclick = function () { R.fillDemo(); renderRaffle(); maybeDraw(); };
    var next = $('#rf-next');
    if (next) next.onclick = function () { R.reset(); rafState.result = null; rafState.angle = 0; renderRaffle(); maybeDraw(); };
  }

  /* как только набралось нужное число — запускаем стрелку */
  function maybeDraw() {
    var R = window.Raffle;
    if (!R.ready() || rafState.spinning) return;
    rafState.spinning = true;
    var n = R.count();
    var el = $('#rf-list');
    if (el) {
      el.classList.add('spinning');
      /* прокручиваем список, чтобы были видны мелькающие имена */
      var i = 0, spin = setInterval(function () {
        el.scrollTop = (i++ * 29) % Math.max(1, el.scrollHeight - el.clientHeight);
      }, 60);
      setTimeout(function () { clearInterval(spin); el.scrollTop = 0; }, 1900);
    }
    setTimeout(function () {
      rafState.spinning = false;
      var res = R.draw();
      rafState.result = res;
      renderRaffle();
      if (res) {
        var row = $$('#rf-list li')[res.idx];
        if (row) row.scrollIntoView({ block: 'center' });
        toast(res.winner.me ? 'Вы выиграли! Промокод — в профиле' : 'Победитель: ' + res.winner.name);
      }
    }, 2000);
  }

  /* ================= маршрут «по порядку» ================= */
  function mainList(kind) {
    if (kind === 'epochs') {
      var ids = [];
      (window.EPOCHS || []).forEach(function (ep) { ep.works.forEach(function (w) { ids.push(w.id); }); });
      return ids;
    }
    return (window.SPINE || []).map(function (s) { return s.id; });
  }

  function sideList(id, j) {
    var onMain = {};
    j.main.forEach(function (x) { onMain[x] = 1; });
    var owners = {};
    j.stack.forEach(function (s) { owners[s.owner] = 1; });
    var seen = {};
    return outOf(id).map(function (e) { return e.to; }).filter(function (x) {
      if (seen[x] || onMain[x] || owners[x] || x === id || isRead(x)) return false;
      seen[x] = 1; return true;
    }).sort(function (a, b) { return sortWorks({ id: a }, { id: b }); });
  }

  function chooseOrder() {
    return ask('Изучать в свободном режиме или по порядку?', [
      { v: 'free', label: 'В свободном режиме', sub: 'сами выбираете книги на карте' },
      { v: 'order', label: 'По порядку', sub: 'сайт ведёт по хронологии', prim: true }
    ]).then(function (v) {
      if (!v) return;
      Acc.data.onboarded = true; Acc.save();
      if (v === 'free') {
        if (Acc.data.journey) Acc.data.journey.active = false;
        Acc.save();
        location.hash = '#/map';
        return;
      }
      return ask('В глобальной хронологии или по временным эпохам?', [
        { v: 'global', label: 'Глобальная хронология', sub: 'одна цепь от Гильгамеша до «1Q84»' },
        { v: 'epochs', label: 'По временным эпохам', sub: 'шесть эпох, от Древнего Востока до наших дней', prim: true }
      ]).then(function (k) { if (k) startJourney(k); });
    });
  }

  function startJourney(kind) {
    var main = mainList(kind);
    Acc.data.journey = { active: true, kind: kind, main: main, mainIdx: 0, stack: [], current: main[0] };
    Acc.data.prefs.mapView = kind === 'epochs' ? 'epochs' : 'global';
    Acc.save();
    flyToCurrent();
  }

  function advanceMain(j) {
    j.stack = [];
    j.mainIdx++;
    while (j.mainIdx < j.main.length && isRead(j.main[j.mainIdx]) && j.main[j.mainIdx] !== j.current) j.mainIdx++;
    if (j.mainIdx >= j.main.length) { j.active = false; j.current = null; return false; }
    j.current = j.main[j.mainIdx];
    return true;
  }

  function advanceSide(j) {
    while (j.stack.length) {
      var top = j.stack[j.stack.length - 1];
      top.pos++;
      while (top.pos < top.list.length && isRead(top.list[top.pos])) top.pos++;
      if (top.pos < top.list.length) { j.current = top.list[top.pos]; return true; }
      j.stack.pop();
    }
    return advanceMain(j);
  }

  /* книга дочитана — что дальше */
  function journeyChoice(j) {
    var cur = j.current, refs = sideList(cur, j), top = j.stack[j.stack.length - 1];
    var T = function (id) { return '«' + S.works.get(id).title + '»'; };
    var nextIn = function (lv) {
      var s = j.stack[lv];
      if (!s) return -1;
      for (var i = s.pos + 1; i < s.list.length; i++) if (!isRead(s.list[i])) return i;
      return -1;
    };
    var opts = [];
    if (refs.length) opts.push({ v: 'deeper', label: 'Перейти к следующей хронологической линии', sub: T(refs[0]) + ', отсылается из ' + T(cur), prim: true });
    var ci = nextIn(j.stack.length - 1);
    if (ci >= 0) opts.push({ v: 'current', label: 'Двигаться по нынешней отсылочной линии', sub: T(top.list[ci]) + ', отсылается из ' + T(top.owner) });
    var pi = j.stack.length >= 2 ? nextIn(j.stack.length - 2) : -1;
    if (pi >= 0) {
      var ps = j.stack[j.stack.length - 2];
      opts.push({ v: 'prev', label: 'Вернуться на прошлую хронологическую линию', sub: T(ps.list[pi]) + ', отсылается из ' + T(ps.owner) });
    }
    var mi = j.mainIdx + 1;
    while (mi < j.main.length && isRead(j.main[mi])) mi++;
    opts.push({ v: 'main', label: 'Вернуться к главной хронологической линии', sub: mi < j.main.length ? T(j.main[mi]) + ', главная линия' : 'главная линия пройдена' });
    var apply = function (v) {
      if (v === 'deeper') { j.stack.push({ owner: cur, list: refs, pos: 0 }); j.current = refs[0]; }
      else if (v === 'current') { top.pos = ci; j.current = top.list[ci]; }
      else if (v === 'prev') { j.stack.pop(); var p = j.stack[j.stack.length - 1]; p.pos = pi; j.current = p.list[pi]; }
      else if (v === 'main') {
        if (!advanceMain(j)) {
          Acc.save();
          ask('Маршрут пройден', [{ v: 'map', label: 'К большой карте', prim: true }], 'Вы прошли всю выбранную хронологическую линию. Продолжайте читать в свободном режиме.').then(function () { location.hash = '#/map'; });
          return;
        }
      } else return;
      Acc.save();
      flyToCurrent();
    };
    if (opts.length === 1) { apply('main'); return true; }
    ask('Что читать дальше?', opts).then(apply);
    return true;
  }

  function journeyNext() {
    var j0 = Acc.data.journey;
    if (j0 && j0.active && j0.stack.length && journeyChoice(j0)) return;
    var j = Acc.data.journey;
    if (!j || !j.active) return;
    var cur = j.current;
    var refs = sideList(cur, j);

    var go = function (ok) {
      Acc.save();
      if (ok === false || !j.active) {
        ask('Маршрут пройден', [{ v: 'map', label: 'К большой карте', prim: true }],
          'Вы прошли всю выбранную хронологическую линию. Продолжайте читать в свободном режиме.')
          .then(function () { location.hash = '#/map'; });
        return;
      }
      flyToCurrent();
    };

    if (!j.stack.length) {                           // дочитана книга главной линии
      if (refs.length) {
        j.stack.push({ owner: cur, list: refs, pos: 0 });
        j.current = refs[0];
        toast('Дальше — боковая линия: книги, на которые ссылается «' + S.works.get(cur).title + '»');
        return go(true);
      }
      return go(advanceMain(j));
    }

    if (refs.length) {                               // дочитана боковая книга со своими отсылками
      return ask('Вернуться к главной хронологической линии или перейти к побочной отсылочной линии?', [
        { v: 'main', label: 'К главной линии', sub: 'следующая книга хронологии' },
        { v: 'side', label: 'К побочной линии', sub: refs.length + ' ' + pl(refs.length, 'книга', 'книги', 'книг').split(' ')[1] + ' из «' + S.works.get(cur).title + '»', prim: true }
      ]).then(function (v) {
        if (v === 'side') {
          j.stack.push({ owner: cur, list: refs, pos: 0 });
          j.current = refs[0];
          go(true);
        } else if (v === 'main') {
          go(advanceMain(j));
        }
      });
    }
    go(advanceSide(j));
  }

  /* выход из режима «по порядку»: закрываем карточку и затемнение,
     показываем полную интерактивную карту */
  function hideIntroCard() {
    var card = $('#intro-card');
    card.classList.remove('on');
    $('#stage').classList.remove('dim');
    setTimeout(function () { card.hidden = true; }, 250);
  }

  function exitJourney() {
    var j = Acc.data.journey;
    if (j) { j.active = false; Acc.save(); }
    S.open.clear();
    hideIntroCard();
    var f = $('#nodes .focus'); if (f) f.classList.remove('focus');
    renderJourneyBar();
    if (S.route.name === 'map') { showMap(); fit(); }
    else if (location.hash !== '#/map') location.hash = '#/map';
    toast('Свободный режим');
  }

  function skipCurrent() {
    var j = Acc.data.journey;
    if (!j || !j.active) return;
    var ok = j.stack.length ? advanceSide(j) : advanceMain(j);
    Acc.save();
    if (ok) flyToCurrent(); else journeyNext();
  }

  /* полоса маршрута убрана: она загораживала верх страницы произведения.
     Управление маршрутом осталось в профиле и на карточке произведения. */
  function renderJourneyBar() {}

  /* полёт камеры к текущему произведению + карточка «НАЧАТЬ» */
  function flyToCurrent() {
    var j = Acc.data.journey;
    if (!j || !j.current) return;
    Acc.data.prefs.mapView = j.kind === 'epochs' ? 'epochs' : 'global';
    Acc.save();
    if (j.stack.length) S.open.add(j.stack[j.stack.length - 1].owner);

    if (location.hash !== '#/map') { flyPending = true; location.hash = '#/map'; return; }
    showMap();
    doFly();
  }
  var flyPending = false;

  function doFly() {
    var j = Acc.data.journey;
    var target = (L.nodes.concat(L.items)).filter(function (n) { return n.workId === j.current; })[0];
    if (!target) { showIntroCard(j.current); return; }

    var world = $('#world'), st = $('#stage').getBoundingClientRect();
    var cx = st.width / 2, cy = st.height / 2;
    var k1 = 1.5;
    var x1 = cx - (target.x + target.w / 2) * k1, y1 = cy - (target.y + target.h / 2) * k1;
    var tf = function (a, x, y, k) {
      return 'translate(' + cx + 'px,' + cy + 'px) rotateX(' + a + 'deg) translate(' + (-cx) + 'px,' + (-cy) + 'px) ' +
        'translate(' + x + 'px,' + y + 'px) scale(' + k + ')';
    };
    $('#stage').classList.add('flying');
    world.style.transition = 'none';
    world.style.transform = tf(0, S.view.x, S.view.y, S.view.k);
    void world.offsetWidth;
    world.style.transition = 'transform 1.5s cubic-bezier(.55,.05,.25,1)';
    world.style.transform = tf(38, x1, y1, k1);
    setTimeout(function () {
      $('#stage').classList.add('dim');
      world.style.transition = 'transform .7s ease-out';
      world.style.transform = tf(0, x1, y1, k1);
      setTimeout(function () {
        world.style.transition = '';
        $('#stage').classList.remove('flying');
        S.view = { x: x1, y: y1, k: k1 };
        applyView(); drawMini();
        var el = elOf(j.current);
        if (el) el.classList.add('focus');
        showIntroCard(j.current);
      }, 720);
    }, 1520);
  }

  function showIntroCard(id) {
    var w = S.works.get(id), card = $('#intro-card');
    var ann = annotationOf(id);
    var st = textState(w);
    card.innerHTML =
      '<div class="ic-inner">' +
        '<div class="ic-left"><div class="ic-kicker">' + esc(w.year || '') + '</div>' +
          '<h2>' + esc(w.title) + '</h2>' + (w.author ? '<div class="ic-author">' + esc(w.author) + '</div>' : '') +
          '<button class="start-btn small" data-ic="start">НАЧАТЬ</button>' +
          (st !== 'text' ? '<div class="ic-state st-' + st + '">' + (STATE_LABEL[st] || 'текст по ссылке') + '</div>' : '') +
          '<div class="ic-sub"><button class="mini" data-ic="skip">Пропустить</button><button class="mini" data-ic="close">Осмотреться на карте</button>' +
          '<button class="mini" data-ic="free">Свободный режим</button></div>' +
        '</div>' +
        (ann ? '<p class="ic-ann">' + esc(ann) + '</p>' : '') +
      '</div>';
    card.hidden = false;
    requestAnimationFrame(function () { card.classList.add('on'); });
    var close = function () { card.classList.remove('on'); $('#stage').classList.remove('dim'); setTimeout(function () { card.hidden = true; }, 250); };
    card.querySelector('[data-ic="start"]').onclick = function () { close(); location.hash = '#/w/' + encodeURIComponent(id); };
    card.querySelector('[data-ic="skip"]').onclick = function () { close(); skipCurrent(); };
    card.querySelector('[data-ic="close"]').onclick = close;
    card.querySelector('[data-ic="free"]').onclick = exitJourney;
    /* клик по затемнённому фону мимо карточки — осмотреться на карте */
    card.onclick = function (ev) { if (!ev.target.closest('.ic-inner')) hideIntroCard(); };
  }

  /* ================= загрузка (разработчик) ================= */
  var pendingPre = null;

  function openDialog(pre) {
    if (!S.dev) return;
    pendingPre = pre || null;
    var w = pre && S.works.get(pre.id);
    $('#dlg-title').value = w ? w.title : '';
    $('#dlg-title').readOnly = !!w;
    $('#dlg-author').value = w ? w.author : '';
    $('#dlg-url').value = w && w.url ? w.url : '';
    $('#dlg-file').value = '';
    $('#dlg-filename').textContent = 'файл не выбран';
    $('#dlg-filename').classList.remove('ok');
    $('#dlg-status').textContent = '';
    $('#dlg').showModal();
  }

  function devWorkRecord(w) {
    var rec = S.devData.works.filter(function (x) { return x.id === w.id; })[0];
    if (!rec) { rec = { id: w.id }; S.devData.works.push(rec); }
    rec.title = w.title; rec.author = w.author; rec.year = w.year; rec.sort = w.sort;
    rec.hasDoc = w.hasDoc; rec.url = w.url;
    return rec;
  }

  function doUpload() {
    var title = $('#dlg-title').value.trim();
    var author = $('#dlg-author').value.trim();
    var url = $('#dlg-url').value.trim();
    var file = $('#dlg-file').files[0];
    if (!title || (!file && !url)) return;

    var work = (pendingPre && S.works.get(pendingPre.id)) || byTitle(title) ||
      addWork({ id: slug(title), title: title, author: author });
    if (author) work.author = author;
    if (url) work.url = url;

    var finish = function (refs) {
      var added = importRefs(work, refs || []);
      added.forEach(function (to) {
        var e = S.edges.filter(function (x) { return x.from === work.id && x.to === to; })[0];
        S.devData.edges.push(e);
        var tw = S.works.get(to);
        if (!S.builtin.has(to)) devWorkRecord(tw);
      });
      devWorkRecord(work);
      devSave();
      toast('«' + work.title + '»: ' + (file ? 'текст загружен, ' : '') + 'новых отсылок ' + added.length);
      if (location.hash === '#/w/' + encodeURIComponent(work.id)) renderWork(work);
      else location.hash = '#/w/' + encodeURIComponent(work.id);
    };

    if (!file) return finish([]);

    var rd = new FileReader();
    rd.onload = function () {
      var html = String(rd.result || '');
      var parsed = { refs: [] };
      try { parsed = RefParser.parse(html, { title: title }); } catch (e) { console.error(e); }
      work.hasDoc = true;
      if (S.devData.docIds.indexOf(work.id) < 0) S.devData.docIds.push(work.id);
      DocStore.put(work.id, html).then(function () { finish(parsed.refs); }, function () {
        toast('Не удалось сохранить текст в браузере'); finish(parsed.refs);
      });
    };
    rd.readAsText(file, 'utf-8');
  }

  /* экспорт: собирает js/content.js для публикации */
  function exportContent() {
    var out = {
      version: 1,
      works: (PUB.works || []).slice(),
      edges: (PUB.edges || []).slice(),
      annotations: Object.assign({}, PUB.annotations || {}),
      status: Object.assign({}, PUB.status || {}),
      docs: Object.assign({}, PUB.docs || {}),
      maintenance: maintOn()
    };
    var have = {};
    out.works.forEach(function (w) { have[w.id] = w; });
    S.devData.works.forEach(function (w) { have[w.id] = w; });
    out.works = Object.keys(have).map(function (k) { return have[k]; });
    var ek = {};
    out.edges.concat(S.devData.edges).forEach(function (e) { if (e) ek[e.from + '→' + e.to] = e; });
    out.edges = Object.keys(ek).map(function (k) { return ek[k]; });
    Object.keys(S.devData.annotations).forEach(function (k) { out.annotations[k] = S.devData.annotations[k]; });
    Object.keys(S.devData.status).forEach(function (k) { out.status[k] = S.devData.status[k]; });

    Promise.all(S.devData.docIds.map(function (id) {
      return DocStore.get(id).then(function (h) { if (h) out.docs[id] = h; });
    })).then(function () {
      var js = '/* content.js — экспорт из режима разработчика, ' + new Date().toLocaleString('ru-RU') + ' */\n' +
        'window.PUBLISHED = ' + JSON.stringify(out) + ';\n';
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([js], { type: 'text/javascript' }));
      a.download = 'content.js';
      a.click();
      ask('Экспорт готов', [{ v: 'ok', label: 'Понятно', prim: true }],
        'Скачан файл <b>content.js</b>. Замените им файл <code>js/content.js</code> на сайте — после этого все пользователи увидят ваши тексты, отсылки, аннотации и пометки.');
    });
  }

  /* ================= интерфейс ================= */
  function bindUI() {
    /* поиск */
    var inp = $('#search'), box = document.createElement('div');
    box.className = 'suggest';
    inp.parentNode.appendChild(box);
    var close = function () { box.classList.remove('on'); };
    inp.addEventListener('input', function () {
      var q = inp.value.trim().toLowerCase();
      if (q.length < 2) return close();
      var hits = [];
      S.works.forEach(function (w) {
        if (w.title.toLowerCase().indexOf(q) >= 0 || (w.author && w.author.toLowerCase().indexOf(q) >= 0)) hits.push(w);
      });
      hits.sort(function (a, b) {
        var ia = a.title.toLowerCase().indexOf(q), ib = b.title.toLowerCase().indexOf(q);
        return ((ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib)) || a.title.length - b.title.length;
      });
      box.innerHTML = hits.length ? hits.slice(0, 12).map(function (w) {
        return '<div class="s" data-id="' + esc(w.id) + '"><span class="t">' + esc(w.title) + '</span><span class="a">' +
          esc(w.author || '') + '</span><span class="b">' + (w.spine ? 'на линии' : outOf(w.id).length + ' отсылок') + '</span></div>';
      }).join('') : '<div class="none">Ничего не найдено</div>';
      box.classList.add('on');
    });
    box.addEventListener('click', function (ev) {
      var s = ev.target.closest('[data-id]');
      if (!s) return;
      inp.value = ''; close();
      location.hash = '#/w/' + encodeURIComponent(s.getAttribute('data-id'));
    });
    inp.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { inp.value = ''; close(); inp.blur(); }
      if (ev.key === 'Enter') { var f = box.querySelector('.s'); if (f) f.click(); }
    });

    document.addEventListener('click', function (ev) {
      if (!ev.target.closest('.search')) close();
      var u = ev.target.closest('[data-upload-for]');
      if (u) { ev.preventDefault(); openDialog({ id: u.getAttribute('data-upload-for') }); }
    });

    /* верхняя панель */
    $$('#view-switch [data-mapview]').forEach(function (b) {
      b.onclick = function () { setMapView(b.getAttribute('data-mapview')); };
    });
    $('#btn-fit').onclick = function () {
      var prev = { x: S.view.x, y: S.view.y, k: S.view.k };
      pushHistory({ label: 'вид «вписать»', undo: function () { S.view = prev; applyView(); drawMini(); } });
      fit();
    };
    $('#btn-zoom-in').onclick = function () { zoomAt(1.25); };
    $('#btn-zoom-out').onclick = function () { zoomAt(0.8); };
    $('#btn-upload').onclick = function () { openDialog(null); };
    $('#btn-help').onclick = function () { $('#help').showModal(); };
    $('#btn-ann').onclick = function () {
      Acc.data.prefs.annotations = !Acc.data.prefs.annotations;
      Acc.save(); renderAnnBtn(); hideTip();
      toast(Acc.data.prefs.annotations ? 'Аннотации включены' : 'Аннотации отключены');
    };
    $('#btn-home').onclick = function (ev) { ev.preventDefault(); location.hash = '#/map'; };
    $('#dev-export').onclick = exportContent;
    $('#dev-maint').onclick = function () {
      S.devData.maintenance = !maintOn();
      devSave();
      applyMaint();
      toast(maintOn()
        ? 'Технические работы ВКЛ — после «Экспорта контента» пользователи увидят заглушку'
        : 'Технические работы выключены — не забудьте сделать экспорт');
    };
    $('#dev-exit').onclick = function () { setDev(false); };

    /* главная */
    $('#home-start').onclick = function () {
      if (!Acc.data.onboarded) return chooseOrder();
      var j = Acc.data.journey;
      if (j && j.active) return flyToCurrent();
      location.hash = '#/map';
    };

    /* карта: колесо, перетаскивание, аннотации */
    var stage = $('#stage');
    stage.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      var r = stage.getBoundingClientRect();
      zoomAt(Math.pow(1.0016, -ev.deltaY), ev.clientX - r.left, ev.clientY - r.top);
    }, { passive: false });
    var drag = null, downAt = null, moved = 0;
    var far = function (x, y) { return Math.abs(x - downAt.x) + Math.abs(y - downAt.y) > 5; };

    stage.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0 || ev.target.closest('.node,.item,.minimap,.map-title')) return;
      var card = $('#intro-card');
      if (!card.hidden) {
        /* клик мимо карточки — осмотреться на карте, не выходя из маршрута */
        if (ev.target.closest('#intro-card')) return;
        hideIntroCard();
        return;
      }
      downAt = { x: ev.clientX, y: ev.clientY };
      moved = 0;
      drag = { x: ev.clientX, y: ev.clientY, vx: S.view.x, vy: S.view.y };
      stage.classList.add('drag');
    });
    /* перетаскивание слушаем на всём окне: курсор может уйти за край
       карты или за пределы окна — карта не должна из-за этого «залипать» */
    window.addEventListener('pointermove', function (ev) {
      if (!drag) return;
      var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (!moved && Math.abs(dx) + Math.abs(dy) > 3) moved = 1;
      if (!moved) return;
      S.view.x = drag.vx + dx; S.view.y = drag.vy + dy;
      applyView(); drawMini();
    });
    ['pointerup', 'pointercancel'].forEach(function (t) {
      window.addEventListener(t, function (ev) {
        if (!drag) return;
        var wasDrag = moved || (downAt && far(ev.clientX, ev.clientY));
        drag = null;
        stage.classList.remove('drag');
        /* левый клик по пустому месту карты (без перетаскивания) —
           выйти из режима «по порядку» и осматривать карту */
        if (!wasDrag && downAt && S.route.name === 'map' &&
            !ev.target.closest('.node,.item,.minimap,.map-title,#intro-card')) {
          var j = Acc.data.journey;
          if (j && j.active) exitJourney();
        }
        downAt = null;
      });
    });
    stage.addEventListener('click', function (ev) { downAt = null; });
    $('#nodes').addEventListener('mouseover', function (ev) {
      var el = ev.target.closest('[data-id]');
      if (!el || (ev.relatedTarget && el.contains(ev.relatedTarget))) return;
      clearTimeout(tipT);
      tipT = setTimeout(function () { showTip(el); }, 320);
    });
    $('#nodes').addEventListener('mouseout', function (ev) {
      var el = ev.target.closest('[data-id]');
      if (el && ev.relatedTarget && el.contains(ev.relatedTarget)) return;
      hideTip();
    });
    stage.addEventListener('pointerdown', hideTip);

    /* чтение */
    var pane = $('#doc-pane');
    /* полный экран: только текст произведения (включая его отсылки),
       единственная кнопка — крестик выхода */
    function setFull(on) {
      pane.classList.toggle('fs', on);
      /* наложение на весь экран работает всегда, даже там, где браузер
         не даёт настоящий fullscreen (встроенные просмотры, file://) */
      pane.classList.toggle('pseudo-full', on);
      $('#rd-exit').hidden = !on;
      document.body.classList.toggle('reading-full', on);
    }
    function exitFull() {
      if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
      setFull(false);
    }
    $('#rd-full').onclick = function () {
      setFull(true);
      if (!Acc.isSubscriber() && !S.dev) Ads.interstitial();
      var fsEl = document.documentElement;
      if (fsEl.requestFullscreen) fsEl.requestFullscreen().catch(function () {});
    };
    $('#rd-exit').onclick = exitFull;
    document.addEventListener('fullscreenchange', function () {
      if (!document.fullscreenElement) setFull(false);
    });
    $('#rd-continue').onclick = function () {
      var b = reader && Acc.bookmarks(reader.id).main;
      if (b) reader.goTo(b.pos); else toast('Вы ещё не начинали читать');
    };
    $('#rd-download').onclick = function () {
      if (!reader) return;
      if (!Acc.isSubscriber() && !S.dev) { location.hash = '#/subscribe'; return; }
      var w = S.works.get(reader.id);
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([reader.html], { type: 'text/html' }));
      a.download = w.title + '.html';
      a.click();
    };
    $('#rd-finish').onclick = function () {
      var w = S.works.get(S.route.id);
      if (!w) return;
      var j = Acc.data.journey;
      if (j && j.active && j.current === w.id) {
        if (!isRead(w.id)) setRead(w.id, true);
        journeyNext();
        return;
      }
      toggleRead(w.id);
      renderFinishBtn(w);
    };
    $('#bm-list').addEventListener('click', function (ev) {
      var a = ev.target.closest('a');
      if (!a || !reader) return;
      ev.preventDefault();
      var del = ev.target.closest('[data-bm-del]');
      if (del) { reader.removeMark(+del.getAttribute('data-bm-del')); return; }
      if (a.hasAttribute('data-bm-main')) { reader.goTo(Acc.bookmarks(reader.id).main.pos); return; }
      if (a.hasAttribute('data-bm')) {
        var n = +a.getAttribute('data-bm');
        var m = Acc.bookmarks(reader.id).marks.filter(function (x) { return x.n === n; })[0];
        if (m) reader.goTo(m.pos);
        return;
      }
      if (a.hasAttribute('data-hl-go')) reader.goTo(+a.getAttribute('data-hl-go'));
    });

    /* выделение цитат */
    var holder = $('#w-doc-holder'), hlBar = $('#hl-bar'), hlDel = $('#hl-del'), hlAt = null;
    holder.addEventListener('mouseup', function (ev) {
      if (!reader) return;
      setTimeout(function () {
        var mk = ev.target.closest && ev.target.closest('mark.rd-hl');
        var sr = reader.selectionRange();
        hlBar.hidden = true; hlDel.hidden = true;
        if (sr) {
          hlBar.hidden = false;
          hlBar.style.left = Math.max(8, sr.rect.left + sr.rect.width / 2 - hlBar.offsetWidth / 2) + 'px';
          hlBar.style.top = Math.max(60, sr.rect.top - hlBar.offsetHeight - 8) + 'px';
        } else if (mk) {
          hlAt = +mk.getAttribute('data-hl');
          var r = mk.getBoundingClientRect();
          hlDel.hidden = false;
          hlDel.style.left = Math.max(8, r.left) + 'px';
          hlDel.style.top = Math.max(60, r.top - hlDel.offsetHeight - 8) + 'px';
        }
      }, 10);
    });
    holder.addEventListener('scroll', function () { hlBar.hidden = true; hlDel.hidden = true; });
    $$('#hl-bar [data-hl]').forEach(function (b) {
      b.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
      b.onclick = function () { if (reader) reader.highlight(b.getAttribute('data-hl')); hlBar.hidden = true; };
    });
    $('#hl-del [data-hl-del]').onclick = function () { if (reader && hlAt != null) reader.removeHighlight(hlAt); hlDel.hidden = true; };

    /* ---------- закладка по правому клику ---------- */
    var BM_COLORS = [
      { id: 'main',  label: 'Главная закладка', color: '#8f1f3f', main: true },
      { id: 'c1', label: 'Закладка', color: '#e0b341' },
      { id: 'c2', label: 'Закладка', color: '#4fa3e3' },
      { id: 'c3', label: 'Закладка', color: '#5cc98d' },
      { id: 'c4', label: 'Закладка', color: '#b57be8' },
      { id: 'c5', label: 'Закладка', color: '#e88a5c' },
      { id: 'c6', label: 'Закладка', color: '#d96f9f' }
    ];
    var bmPop = $('#bm-pop'), bmAt = null, bmScrollTop = 0;

    function hideBmPop() { bmPop.hidden = true; bmAt = null; }

    function showBmPop(ev) {
      if (!reader) return;
      var doc = reader.doc;
      if (!doc) return;
      bmAt = reader.posAt(ev.clientX, ev.clientY);
      if (bmAt == null) { hideBmPop(); return; }
      bmScrollTop = holder.scrollTop;
      var bar = $('#bm-list').closest('.list-block');
      var cur = bar && bar.querySelector('li');
      var rows = BM_COLORS.map(function (c) {
        return '<button data-bmc="' + c.id + '" data-col="' + c.color + '"' + (c.main ? ' data-main="1"' : '') + '>' +
          '<span class="sw' + (c.main ? ' main' : '') + '" style="background:' + c.color + '"></span>' +
          (c.main ? 'Главная закладка (тёмно-красная)' : 'Закладка ' + c.label.toLowerCase()) + '</button>';
      }).join('');
      bmPop.innerHTML = '<div class="bm-pop-h">Поставить закладку</div>' + rows + '<hr>' +
        '<button data-bmc="go-main">↧ Перейти к главной закладке</button>';
      bmPop.hidden = false;
      var x = Math.min(ev.clientX, window.innerWidth - bmPop.offsetWidth - 12);
      var y = Math.min(ev.clientY, window.innerHeight - bmPop.offsetHeight - 12);
      bmPop.style.left = Math.max(8, x) + 'px';
      bmPop.style.top = Math.max(8, y) + 'px';
    }

    holder.addEventListener('contextmenu', function (ev) {
      if (!reader || !reader.doc) return;
      if (!reader.doc.contains(ev.target)) return;
      ev.preventDefault();
      showBmPop(ev);
    });
    bmPop.addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-bmc]');
      if (!b || bmAt == null) return;
      var kind = b.getAttribute('data-bmc');
      if (kind === 'go-main') {
        var main = Acc.bookmarks(reader.id).main;
        if (main) reader.goTo(main.pos); else toast('Главной закладки ещё нет');
        hideBmPop(); return;
      }
      if (b.hasAttribute('data-main')) {
        Acc.setMain(reader.id, bmAt, true);
        reader.paintMarks(); renderBookmarks(S.works.get(reader.id)); toast('Главная закладка поставлена');
      } else {
        var m = reader.addMark(bmAt, b.getAttribute('data-col'));
        toast('Закладка № ' + m.n);
      }
      hideBmPop();
    });
    document.addEventListener('pointerdown', function (ev) {
      if (!bmPop.hidden && !bmPop.contains(ev.target)) hideBmPop();
    });
    holder.addEventListener('scroll', function () {
      /* закрываем только если текст реально сдвинулся — служебные
         события прокрутки сразу после открытия не должны мешать */
      if (!bmPop.hidden && Math.abs(holder.scrollTop - bmScrollTop) > 4) hideBmPop();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !bmPop.hidden) { ev.stopPropagation(); hideBmPop(); }
    });

    /* диалог загрузки */
    $('#dlg-pick').onclick = function () { $('#dlg-file').click(); };
    $('#dlg-file').onchange = function () {
      var f = this.files[0], lab = $('#dlg-filename');
      lab.textContent = f ? f.name : 'файл не выбран';
      lab.classList.toggle('ok', !!f);
    };
    $('#dlg').addEventListener('close', function () { if (this.returnValue === 'ok') doUpload(); });

    bindKeys();
    window.addEventListener('hashchange', function () {
      route();
      if (flyPending && S.route.name === 'map') { flyPending = false; setTimeout(doFly, 60); }
    });
    window.addEventListener('resize', drawMini);
  }

  function inField(el) {
    return el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
  }

  function bindKeys() {
    document.addEventListener('keydown', function (ev) {
      /* Ctrl+Shift+D — режим разработчика */
      if (ev.ctrlKey && ev.shiftKey && (ev.key === 'D' || ev.key === 'd' || ev.code === 'KeyD')) {
        ev.preventDefault(); setDev(!S.dev); return;
      }
      if (inField(ev.target) || document.querySelector('dialog[open]')) return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

      if (ev.key === 'Backspace') { ev.preventDefault(); undo(); return; }
      if (ev.key === 'Escape') {
        if (!$('#intro-card').hidden) { $('#intro-card').hidden = true; $('#stage').classList.remove('dim'); return; }
        if (S.route.name !== 'map' && S.route.name !== 'home') location.hash = '#/map';
        return;
      }
      if (S.route.name !== 'map' && S.route.name !== 'single') return;

      var step = ev.shiftKey ? 270 : 90, k = (ev.key || '').toLowerCase(), c = ev.code;
      var dx = 0, dy = 0;
      if (k === 'a' || k === 'ф' || c === 'KeyA' || ev.key === 'ArrowLeft') dx = step;
      else if (k === 'd' || k === 'в' || c === 'KeyD' || ev.key === 'ArrowRight') dx = -step;
      else if (k === 'w' || k === 'ц' || c === 'KeyW' || ev.key === 'ArrowUp') dy = step;
      else if (k === 's' || k === 'ы' || c === 'KeyS' || ev.key === 'ArrowDown') dy = -step;
      else return;
      ev.preventDefault();
      S.view.x += dx; S.view.y += dy;
      applyView(); drawMini();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* для проверок */
  window.__map = S;
  window.__app = {
    setDev: setDev, startJourney: startJourney, journeyNext: journeyNext,
    hasText: hasText, textState: textState, annotationOf: annotationOf, exportContent: exportContent
  };
})();
