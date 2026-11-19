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
      journey: null          // режим «по порядку»
    };
  }

  var A = load();

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
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
    try { localStorage.setItem(KEY, JSON.stringify(A)); } catch (e) {}
    emit();
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
  function setProgress(id, p) {
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

  function setMain(id, pos) {
    bm(id).main = { pos: pos, at: Date.now() };
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

    setProgress: setProgress,
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
