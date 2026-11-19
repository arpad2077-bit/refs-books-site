/* ============================================================
   account.js — профиль пользователя (хранится в браузере)
   ------------------------------------------------------------
   • статус: гость / подписчик (+ срок подписки)
   • лимит бесплатных книг для гостя: 5 + 1 за каждого
     приглашённого друга
   • прогресс чтения, прочитанные книги
   • закладки (главная + «№…») и выделения цитат
   ------------------------------------------------------------
   ВАЖНО: всё это хранится в localStorage и проверяется на
   стороне браузера. Для настоящей платной подписки статус,
   лимиты и приглашения должны подтверждаться сервером —
   см. Account.backend ниже.
   ============================================================ */
(function (global) {
  'use strict';

  var KEY = 'refbooks.account.v1';
  var AUTH_KEY = 'refbooks.auth.v1';        // список аккаунтов на этом устройстве
  var SESS_KEY = 'refbooks.session.v1';     // вход без «запомнить» — на одну вкладку
  var FREE_BOOKS = 5;

  var PLANS = {
    month:    { id: 'month',    title: 'Месяц',              price: 200,  days: 30 },
    year:     { id: 'year',     title: 'Год',                price: 1500, days: 365 },
    lifetime: { id: 'lifetime', title: 'Бесконечный доступ', price: 2500, days: null }
  };

  function uid() {
    return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  }

  function blank() {
    return {
      id: uid(),
      name: '',
      createdAt: Date.now(),
      plan: null,            // 'month' | 'year' | 'lifetime'
      paidUntil: null,       // ms; null для lifetime
      opened: [],            // id книг, открытых гостем (расходуют лимит)
      invites: 0,            // засчитанные приглашения
      invitedBy: null,
      progress: {},          // id -> 0..1
      finished: [],          // id прочитанных до конца
      bookmarks: {},         // id -> { main: {pos, at}, marks: [{n, pos, text, color, at}] }
      highlights: {},        // id -> [{s, e, kind, text, at}]
      promos: [],            // выигранные промокоды: [{code, days, raffleId, createdAt, claimedAt}]
      prefs: { annotations: true },
      onboarded: false,
      lastWork: null,        // последнее открытое произведение
      journey: null          // режим «по порядку»
    };
  }

  /* ================= аккаунты (вход и регистрация) =================
     Данные каждого профиля лежат отдельно: refbooks.account.v1.<id>,
     у гостя без входа — refbooks.account.v1.
     Это хранилище браузера: пароль не отправляется никуда и хранится
     только в виде хеша, но настоящей защитой это не является —
     для реальных аккаунтов нужен сервер (см. backend ниже). */
  function loadAuth() {
    try {
      var d = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null');
      if (d && d.accounts) {
        d.current = (d.current && d.accounts.some(function (a) { return a.id === d.current; })) ? d.current : null;
        d.remember = d.remember !== false;
        return d;
      }
    } catch (e) {}
    return { accounts: [], current: null, remember: true };
  }
  function saveAuth() {
    try { localStorage.setItem(AUTH_KEY, JSON.stringify(auth)); } catch (e) {}
  }
  var auth = loadAuth();

  /* «запомнить» выключено — вход живёт только до закрытия вкладки */
  function sessionActive() {
    if (!auth.current) return false;
    if (auth.remember) return true;
    try { return sessionStorage.getItem(SESS_KEY) === auth.current; } catch (e) { return false; }
  }
  /* сессия истекла (вкладку закрыли) — считаем, что пользователь вышел */
  if (auth.current && !sessionActive()) { auth.current = null; saveAuth(); }

  function dataKey() { return auth.current ? KEY + '.' + auth.current : KEY; }

  /* ---------------- сервер ----------------
     Если сайт открыт с сервера (server/server.js) — аккаунты живут там
     и работают на любом устройстве. Если сервера нет (файл на диске,
     GitHub Pages) — работает прежний локальный режим. */
  var Srv = {
    state: 'unknown',      // unknown | up | down
    checked: false,
    ping: function () {
      if (Srv.checked) return Promise.resolve(Srv.state);
      Srv.checked = true;
      return fetch('/api/ping', { headers: { 'Accept': 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          Srv.state = (d && d.server) ? 'up' : 'down';
          return Srv.state;
        })
        .catch(function () { Srv.state = 'down'; return 'down'; });
    },
    req: function (method, url, body, tok) {
      var h = { 'Content-Type': 'application/json' };
      if (tok) h['Authorization'] = 'Bearer ' + tok;
      return fetch(url, {
        method: method,
        headers: h,
        body: body ? JSON.stringify(body) : undefined
      }).then(function (r) {
        return r.text().then(function (t) {
          var b = null;
          try { b = t ? JSON.parse(t) : null; } catch (e) {}
          return { status: r.status, body: b };
        });
      });
    }
  };
  Srv.ping();

  function normEmail(e) { return String(e || '').trim().toLowerCase(); }
  function hexOf(buf) {
    var b = new Uint8Array(buf), s = '';
    for (var i = 0; i < b.length; i++) s += ('0' + b[i].toString(16)).slice(-2);
    return s;
  }
  function plainHash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return 'f:' + h.toString(16);
  }
  function sha256(s) {
    try {
      if (global.crypto && global.crypto.subtle && global.TextEncoder) {
        return global.crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
          .then(function (buf) { return 's:' + hexOf(buf); });
      }
    } catch (e) {}
    return Promise.resolve(null);
  }
  function makeHash(email, pass) {
    var s = 'refs|' + normEmail(email) + '|' + pass;
    return sha256(s).then(function (h) { return h || plainHash(s); });
  }
  function checkHash(stored, email, pass) {
    var s = 'refs|' + normEmail(email) + '|' + pass;
    if (String(stored).charAt(0) === 's') {
      return sha256(s).then(function (h) { return !!h && h === stored || stored === plainHash(s); });
    }
    return Promise.resolve(stored === plainHash(s));
  }
  function pubUser(a) { return a ? { id: a.id, name: a.name, email: a.email } : null; }

  function isLoggedIn() { return !!auth.current; }
  function user() {
    for (var i = 0; i < auth.accounts.length; i++) {
      if (auth.accounts[i].id === auth.current) return pubUser(auth.accounts[i]);
    }
    return null;
  }
  function accounts() {
    return auth.accounts.map(function (a) { return pubUser(a); });
  }

  function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || '').trim()); }

  /* войти (или остаться) в аккаунт: перезагрузка подхватит его данные */
  function enter(id, remember) {
    auth.current = id;
    auth.remember = remember !== false;
    saveAuth();
    try {
      if (auth.remember) sessionStorage.removeItem(SESS_KEY);
      else sessionStorage.setItem(SESS_KEY, id);
    } catch (e) {}
    return Promise.resolve({ ok: true, user: user() });
  }

  function register(d) {
    d = d || {};
    var name = String(d.name || '').trim();
    var email = normEmail(d.email);
    var pass = String(d.password || '');
    if (name.length < 2) return Promise.resolve({ ok: false, error: 'Имя профиля — минимум 2 символа' });
    if (!validEmail(email)) return Promise.resolve({ ok: false, error: 'Проверьте электронную почту' });
    if (pass.length < 6) return Promise.resolve({ ok: false, error: 'Пароль — минимум 6 символов' });

    /* есть сервер — аккаунт создаётся там и работает на любом устройстве */
    if (Srv.state === 'up') {
      return Srv.req('POST', '/api/register', {
        name: name, email: email, password: pass,
        startData: remoteStartData(), updatedAt: Date.now()
      }).then(function (r) {
        if (r.status !== 200 || !r.body || !r.body.ok) {
          return { ok: false, error: (r.body && r.body.error) || 'Не удалось создать аккаунт' };
        }
        return adoptServerUser(r.body, name, rememberOf(d));
      }, function () { return onlineFallback(); });
    }

    if (auth.accounts.some(function (a) { return a.email === email; })) {
      return Promise.resolve({ ok: false, error: 'Аккаунт с такой почтой уже есть — войдите в него' });
    }
    var id = uid();
    return makeHash(email, pass).then(function (hash) {
      auth.accounts.push({ id: id, name: name, email: email, pass: hash, createdAt: Date.now() });
      /* первые данные гостя (прогресс, закладки) забирает новый аккаунт */
      try {
        var anon = localStorage.getItem(KEY);
        if (anon && !localStorage.getItem(KEY + '.' + id)) {
          localStorage.setItem(KEY + '.' + id, anon);
          localStorage.removeItem(KEY);
        }
      } catch (e) {}
      return enter(id, d.remember).then(function () { return { ok: true, user: user() }; });
    });
  }

  function login(email, password, remember) {
    email = normEmail(email);

    if (Srv.state === 'up') {
      return Srv.req('POST', '/api/login', { email: email, password: password }).then(function (r) {
        if (r.status !== 200 || !r.body || !r.body.ok) {
          return { ok: false, error: (r.body && r.body.error) || 'Не удалось войти' };
        }
        return adoptServerUser(r.body, (r.body.user || {}).name, remember !== false);
      }, function () { return onlineFallback(); });
    }

    var acc = null;
    for (var i = 0; i < auth.accounts.length; i++) if (auth.accounts[i].email === email) acc = auth.accounts[i];
    if (!acc) return Promise.resolve({ ok: false, error: 'Аккаунт с такой почтой не найден' });
    return checkHash(acc.pass, email, password).then(function (okHash) {
      if (!okHash) return { ok: false, error: 'Неверный пароль' };
      return enter(acc.id, remember).then(function () { return { ok: true, user: user() }; });
    });
  }

  function rememberOf(d) { return d.remember !== false; }
  function onlineFallback() {
    return { ok: false, error: 'Сервер не отвечает — попробуйте ещё раз через минуту' };
  }

  /* ---- сервер: вход, токен и синхронизация профиля ---- */
  var SRV_USER_KEY = 'refbooks.serverUser';

  function adoptServerUser(body, name, remember) {
    var u = body.user || {};
    var cur = null;
    try { cur = JSON.parse(localStorage.getItem(SRV_USER_KEY) || 'null'); } catch (e) {}
    if (cur && cur.id && cur.id !== u.id) {
      /* выходим из прежнего профиля — его данные остаются под своим ключом */
      try { localStorage.setItem(KEY + '.' + cur.id, JSON.stringify(A)); } catch (e) {}
    }
    try {
      localStorage.setItem(SRV_USER_KEY, JSON.stringify({
        id: u.id, name: u.name, email: u.email,
        token: body.token, remember: remember !== false
      }));
      if (remember === false) sessionStorage.setItem('refbooks.srvSession', u.id);
      else sessionStorage.removeItem('refbooks.srvSession');
    } catch (e) {}
    /* разные аккаунты на одном устройстве не должны смешивать данные:
       у каждого свой ключ хранения, данные другого профиля не трогаем */
    auth.current = u.id;
    auth.remember = remember !== false;
    if (!auth.accounts.some(function (a) { return a.id === u.id; })) {
      auth.accounts.push({ id: u.id, name: u.name, email: u.email, pass: null, createdAt: Date.now() });
    }
    saveAuth();
    /* данные, записанные до входа, остаются за первым аккаунтом */
    return pull().then(function () { return { ok: true, user: user() }; });
  }

  function remoteStartData() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return null;
      var d = JSON.parse(raw);
      return d && d.onboarded ? d : null;
    } catch (e) { return null; }
  }

  /* забрать данные профиля с сервера (или отправить свои, если сервер пуст) */
  function pull() {
    var su = serverUser();
    if (!su) return Promise.resolve(false);
    return Srv.req('GET', '/api/data', null, su.token).then(function (r) {
      if (r.status !== 200 || !r.body || !r.body.ok) return false;
      var d = r.body.data;
      if (d && typeof d === 'object') {
        try { localStorage.setItem(KEY + '.' + su.id, JSON.stringify(migrate(d))); } catch (e) {}
      } else {
        A.lastSyncAt = 0;
        push(true);
      }
      return true;
    }, function () { return false; });
  }

  function migrate(d) {
    var b = blank();
    for (var k in b) if (!(k in d)) d[k] = b[k];
    d.prefs = Object.assign(b.prefs, d.prefs || {});
    return d;
  }

  var pushTimer = null;
  function push(immediate) {
    var su = serverUser();
    if (!su || Srv.state !== 'up') return;
    clearTimeout(pushTimer);
    var go = function () {
      A.lastSyncAt = Date.now();
      var payload = {};
      for (var k in A) if (k !== '_synced') payload[k] = A[k];
      Srv.req('PUT', '/api/data', { data: payload, updatedAt: A.lastSyncAt }, su.token).catch(function () {});
    };
    if (immediate) go(); else pushTimer = setTimeout(go, 1200);
  }

  function serverUser() {
    try {
      var su = JSON.parse(localStorage.getItem(SRV_USER_KEY) || 'null');
      if (su && su.id) return su;
    } catch (e) {}
    return null;
  }

  /* «не запоминать»: вход живёт, пока не закрыта вкладка */
  function checkServerSession() {
    var su = serverUser();
    if (!su) return;
    if (su.remember !== false) return;
    var alive = false;
    try { alive = sessionStorage.getItem('refbooks.srvSession') === su.id; } catch (e) {}
    if (!alive) {
      try { localStorage.removeItem(SRV_USER_KEY); } catch (e) {}
      auth.current = null;
      saveAuth();
    }
  }
  checkServerSession();

  function logout() {
    var su = serverUser();
    if (su && su.token) Srv.req('POST', '/api/logout', null, su.token).catch(function () {});
    try { localStorage.removeItem(SRV_USER_KEY); } catch (e) {}
    if (!su) save();                      // сохраняем локальные данные профиля
    auth.current = null;
    saveAuth();
    try { sessionStorage.removeItem(SESS_KEY); } catch (e) {}
    return Promise.resolve();
  }

  /* вкладка закрыта без «запомнить» — на сервере считаем, что вышли */
  function endSession() {
    var su = serverUser();
    if (!su || su.remember !== false) return;
    try {
      var payload = { token: su.token };
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/logout', new Blob([JSON.stringify(payload)], { type: 'application/json' }));
      }
    } catch (e) {}
  }

  var A = load();

  function load() {
    try {
      var raw = localStorage.getItem(dataKey());
      if (raw) {
        var d = JSON.parse(raw);
        var b = blank();
        for (var k in b) if (!(k in d)) d[k] = b[k];
        d.prefs = Object.assign(b.prefs, d.prefs || {});
        return d;
      }
    } catch (e) {}
    return blank();
  }

  function save() {
    try { localStorage.setItem(dataKey(), JSON.stringify(A)); } catch (e) {}
    emit();
    push(false);
  }

  /* синхронизация при открытии сайта: если на сервере данные новее —
     забираем их (и перезагружаемся), иначе отправляем свои */
  function syncOnBoot() {
    var su = serverUser();
    if (!su || !su.token) return Promise.resolve(false);
    return Srv.ping().then(function (st) {
      if (st !== 'up') return false;
      return Srv.req('GET', '/api/data', null, su.token).then(function (r) {
        if (r.status === 401) {
          try { localStorage.removeItem(SRV_USER_KEY); } catch (e) {}
          return false;
        }
        if (r.status !== 200 || !r.body || !r.body.ok) return false;
        var remote = r.body.data, rAt = Number(r.body.updatedAt) || 0;
        if (remote && rAt > (Number(A.lastSyncAt) || 0)) {
          try {
            localStorage.setItem(KEY + '.' + su.id, JSON.stringify(migrate(remote)));
            localStorage.setItem('refbooks.booted', '1');
          } catch (e) {}
          return true;                       // данные обновились — перезагрузимся
        }
        push(true);
        return false;
      });
    });
  }

  /* --- подписка на изменения --- */
  var listeners = [];
  function on(fn) { listeners.push(fn); }
  function emit() { listeners.forEach(function (f) { try { f(A); } catch (e) {} }); }

  /* ================= статус ================= */
  function isSubscriber() {
    if (!A.plan) return false;
    if (A.plan === 'lifetime') return true;
    return A.paidUntil && A.paidUntil > Date.now();
  }

  function status() {
    return isSubscriber() ? 'subscriber' : 'guest';
  }

  function activate(planId) {
    var p = PLANS[planId];
    if (!p) return false;
    A.plan = planId;
    if (p.days) {
      var from = (A.paidUntil && A.paidUntil > Date.now()) ? A.paidUntil : Date.now();
      A.paidUntil = from + p.days * 86400000;
    } else {
      A.paidUntil = null;
    }
    save();
    return true;
  }

  /* продление подписки на N дней (промокод, подарок).
     Время прибавляется к уже оплаченному, а не заменяет его.
     Бессрочную подписку продлевать нечем — она и так без срока. */
  function extend(days) {
    if (!days) return false;
    if (A.plan === 'lifetime') return false;
    var from = (A.paidUntil && A.paidUntil > Date.now()) ? A.paidUntil : Date.now();
    A.paidUntil = from + days * 86400000;
    if (!A.plan) A.plan = 'year';   // тариф «год», срок уточняет paidUntil
    save();
    return true;
  }

  function cancel() {
    A.plan = null;
    A.paidUntil = null;
    save();
  }

  /* ================= лимит гостя ================= */
  function limit() { return FREE_BOOKS + (A.invites || 0); }
  function used() { return A.opened.length; }
  function left() { return Math.max(0, limit() - used()); }

  /* можно ли открыть текст книги */
  function canRead(id) {
    if (isSubscriber()) return true;
    if (A.opened.indexOf(id) >= 0) return true;   // уже открытые остаются доступны
    return used() < limit();
  }

  /* засчитать открытие (вызывается, когда текст реально показан) */
  function markOpened(id) {
    if (isSubscriber()) return;
    if (A.opened.indexOf(id) >= 0) return;
    A.opened.push(id);
    save();
  }

  /* ================= приглашения ================= */
  function inviteLink() {
    var base = location.href.split('#')[0].split('?')[0];
    return base + '?invite=' + encodeURIComponent(A.id);
  }

  /* засчитать приглашение — должно приходить с сервера,
     когда друг по ссылке открыл сайт впервые */
  function creditInvite(n) {
    A.invites = (A.invites || 0) + (n || 1);
    save();
  }

  /* друг пришёл по ссылке: запоминаем, кто пригласил,
     и сообщаем бэкенду (если он подключён) */
  function acceptInvite(fromId) {
    if (!fromId || fromId === A.id || A.invitedBy) return;
    A.invitedBy = fromId;
    save();
    backend.reportInvite(fromId, A.id);
  }

  /* ================= прогресс ================= */
  function setLastWork(id) {
    if (!id || A.lastWork === id) return;
    A.lastWork = id;
    save();
  }

  function setProgress(id, p) {
    if (A.finished.indexOf(id) >= 0) return;   /* прочитанное не «откатывается» назад */
    p = Math.max(0, Math.min(1, p));
    var prev = A.progress[id] || 0;
    if (Math.abs(prev - p) < 0.003) return;
    A.progress[id] = p;
    if (p >= 0.985 && A.finished.indexOf(id) < 0) A.finished.push(id);
    save();
  }

  function finish(id) {
    A.progress[id] = 1;
    if (A.finished.indexOf(id) < 0) A.finished.push(id);
    save();
  }

  function unfinish(id) {
    var i = A.finished.indexOf(id);
    if (i >= 0) A.finished.splice(i, 1);
    if (A.progress[id] >= 0.985) A.progress[id] = 0.95;
    save();
  }

  function inProgress() {
    return Object.keys(A.progress).filter(function (id) {
      return A.progress[id] > 0.005 && A.finished.indexOf(id) < 0;
    });
  }

  /* ================= закладки ================= */
  function bm(id) {
    if (!A.bookmarks[id]) A.bookmarks[id] = { main: null, marks: [] };
    return A.bookmarks[id];
  }

  /* manual: закладку поставил сам пользователь (правым кликом),
     а не сайт при прокрутке */
  function setMain(id, pos, manual) {
    var prev = bm(id).main;
    bm(id).main = { pos: pos, at: Date.now(), manual: !!manual || !!(prev && prev.manual) };
    save();
  }

  function addMark(id, pos, text, color) {
    var b = bm(id);
    var n = b.marks.reduce(function (m, x) { return Math.max(m, x.n); }, 0) + 1;
    var mark = { n: n, pos: pos, text: (text || '').slice(0, 120), color: color || '#8b6cf5', at: Date.now() };
    b.marks.push(mark);
    b.marks.sort(function (x, y) { return x.pos - y.pos; });
    save();
    return mark;
  }

  /* перекрасить закладку */
  function recolorMark(id, n, color) {
    var m = bm(id).marks.filter(function (x) { return x.n === n; })[0];
    if (!m) return false;
    m.color = color;
    save();
    return true;
  }

  function removeMark(id, n) {
    var b = bm(id);
    var removed = null;
    b.marks = b.marks.filter(function (m) {
      if (m.n === n) { removed = m; return false; }
      return true;
    });
    save();
    return removed;
  }

  function restoreMark(id, mark) {
    bm(id).marks.push(mark);
    bm(id).marks.sort(function (x, y) { return x.pos - y.pos; });
    save();
  }

  /* ================= выделения ================= */
  function highlights(id) { return A.highlights[id] || []; }

  function addHighlight(id, h) {
    if (!A.highlights[id]) A.highlights[id] = [];
    h.at = Date.now();
    A.highlights[id].push(h);
    save();
    return h;
  }

  function removeHighlight(id, at) {
    var list = A.highlights[id] || [];
    var removed = null;
    A.highlights[id] = list.filter(function (h) {
      if (h.at === at) { removed = h; return false; }
      return true;
    });
    save();
    return removed;
  }

  /* ================= промокоды розыгрышей =================
     Промокод привязан к профилю: он лежит в этом профиле и
     проверяется вместе с его id. Перепродать его нельзя —
     у другого профиля в списке его нет. Срок действия
     промокода не ограничен, а время подписки суммируется. */
  function promos() { return A.promos || []; }

  function hasPromo(code) {
    code = String(code || '').trim().toUpperCase();
    return promos().some(function (p) { return p.code === code; });
  }

  /* выдать промокод этому профилю (вызывается розыгрышем) */
  function grantPromo(code, days, raffleId) {
    code = String(code || '').trim().toUpperCase();
    if (!code || !days) return null;
    if (hasPromo(code)) return promos().filter(function (p) { return p.code === code; })[0];
    var p = { code: code, days: days, raffleId: raffleId || null, createdAt: Date.now(), claimedAt: null };
    A.promos.push(p);
    save();
    return p;
  }

  /* активировать промокод: возможно только владельцу профиля */
  function redeemPromo(code) {
    code = String(code || '').trim().toUpperCase();
    var p = promos().filter(function (x) { return x.code === code; })[0];
    if (!p) return { ok: false, error: 'Такого промокода нет в вашем профиле' };
    if (p.claimedAt) return { ok: false, error: 'Этот промокод уже активирован' };
    if (A.plan === 'lifetime') return { ok: false, error: 'У вас бессрочная подписка — промокод некуда прибавить' };
    p.claimedAt = Date.now();
    extend(p.days);
    save();
    return { ok: true, days: p.days };
  }

  /* ================= бэкенд (заглушка) ================= */
  /* Подключите сюда свой сервер. Пока методы ничего не отправляют. */
  var backend = {
    url: '',                         // например 'https://api.refs.books'
    reportInvite: function (inviterId, newUserId) {
      if (!this.url) return;
      try {
        fetch(this.url + '/invites', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inviter: inviterId, invitee: newUserId })
        });
      } catch (e) {}
    }
  };

  global.Account = {
    get data() { return A; },
    PLANS: PLANS,
    FREE_BOOKS: FREE_BOOKS,
    save: save,
    on: on,

    isSubscriber: isSubscriber,
    status: status,
    activate: activate,
    extend: extend,
    cancel: cancel,

    limit: limit, used: used, left: left,
    canRead: canRead, markOpened: markOpened,

    inviteLink: inviteLink,
    creditInvite: creditInvite,
    acceptInvite: acceptInvite,

    /* аккаунты */
    isLoggedIn: isLoggedIn, user: user, accounts: accounts,
    get remember() { return auth.remember !== false; },
    server: Srv, syncOnBoot: syncOnBoot, endSession: endSession,
    register: register, login: login, logout: logout, enter: enter,
    validEmail: validEmail,

    setProgress: setProgress,
    setLastWork: setLastWork,
    finish: finish, unfinish: unfinish,
    inProgress: inProgress,

    bookmarks: bm,
    setMain: setMain, addMark: addMark, removeMark: removeMark, restoreMark: restoreMark,
    recolorMark: recolorMark,

    promos: promos, hasPromo: hasPromo, grantPromo: grantPromo, redeemPromo: redeemPromo,

    highlights: highlights, addHighlight: addHighlight, removeHighlight: removeHighlight,

    backend: backend
  };
})(window);
