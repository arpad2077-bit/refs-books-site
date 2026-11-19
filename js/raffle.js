/* ============================================================
   raffle.js — розыгрыш годовой подписки
   ------------------------------------------------------------
   • Взнос за участие — 70 ₽, сумма не возвращается.
   • Розыгрыш стартует сразу, как только набирается 22 участника.
   • Рандомайзер (стрелка) выбирает одного участника; победитель
     получает промокод на год подписки в своём профиле.
   • Промокод бессрочный, привязан к профилю победителя и
     суммируется с уже оплаченным сроком подписки.

   ВАЖНО: участники, оплата и сам розыгрыш сейчас живут в браузере
   (localStorage). Честный розыгрыш между разными людьми требует
   сервера: см. Raffle.backend ниже — там точки подключения.
   ============================================================ */
(function (global) {
  'use strict';

  var KEY = 'refbooks.raffle.v1';

  var CONFIG = {
    size: 22,        // сколько участников запускает розыгрыш
    price: 70,       // взнос, ₽
    prizeDays: 365,  // промокод на год подписки
    prizeTitle: 'Годовая подписка Refs.Books'
  };

  var BOT_NAMES = [
    'Анна К.', 'Дмитрий Р.', 'Мария С.', 'Илья В.', 'Ольга П.', 'Артём Л.',
    'Софья М.', 'Никита Б.', 'Елена Т.', 'Пётр Ж.', 'Вера Н.', 'Максим Д.',
    'Ксения Ф.', 'Роман Ш.', 'Полина Я.', 'Глеб У.', 'Дарья И.', 'Юрий А.',
    'Татьяна Г.', 'Сергей Х.', 'Алиса Ч.', 'Егор З.', 'Ирина Щ.', 'Владимир Ю.'
  ];

  function uid() {
    return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  }

  function blank() {
    return {
      round: 1,
      entries: [],          // [{id, name, me, at}]
      drawn: null,          // {round, winner, entries:[...], at}
      history: []           // прошлые розыгрыши
    };
  }

  var D = load();

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var d = JSON.parse(raw), b = blank();
        for (var k in b) if (!(k in d)) d[k] = b[k];
        return d;
      }
    } catch (e) {}
    return blank();
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(D)); } catch (e) {}
  }

  /* ---------- участники ---------- */
  function meId() { return global.Account.data.id; }
  function meName() {
    var n = global.Account.data.name;
    return n || 'Вы';
  }
  /* очереди: queues[0] — следующий розыгрыш, queues[1] — послеследующий и т. д. */
  function Q() { if (!D.queues) D.queues = []; return D.queues; }
  function inRound() { return !D.drawn && D.entries.some(function (e) { return e.me; }); }
  /* 0 — не в очереди; 1 — следующий розыгрыш; 2 — послеследующий; ... */
  function myQueue() {
    var q = Q();
    for (var i = 0; i < q.length; i++) if (q[i].some(function (e) { return e.me; })) return i + 1;
    return 0;
  }
  function isJoined() { return inRound() || myQueue() > 0; }
  function count() { return D.entries.length; }
  function needed() { return Math.max(0, CONFIG.size - count()); }
  function roundOpen() { return !D.drawn && D.entries.length < CONFIG.size; }

  /* queue в ответе: 0 — участвует в текущем розыгрыше, N — N-я очередь */
  function join() {
    if (isJoined()) return { ok: false, error: 'Вы уже участвуете' };
    var entry = { id: meId(), name: meName(), me: true, at: Date.now() };
    if (roundOpen()) {
      D.entries.push(entry);
      save();
      return { ok: true, queue: 0 };
    }
    var q = Q(), i = 0;
    while (q[i] && q[i].length >= CONFIG.size) i++;
    if (!q[i]) q[i] = [];
    q[i].push(entry);
    save();
    return { ok: true, queue: i + 1 };
  }

  /* демо-участники: пока нет сервера, других людей взять неоткуда */
  function addDemo(n) {
    n = n || 1;
    for (var i = 0; i < n && D.entries.length < CONFIG.size; i++) {
      var used = {};
      D.entries.forEach(function (e) { used[e.name] = 1; });
      var free = BOT_NAMES.filter(function (x) { return !used[x]; });
      var name = free.length ? free[Math.floor(Math.random() * free.length)]
        : 'Читатель ' + (count() + 1);
      D.entries.push({ id: uid(), name: name, me: false, at: Date.now() });
    }
    save();
    return count();
  }

  function fillDemo() { return addDemo(needed()); }

  /* ---------- розыгрыш ---------- */
  function ready() { return D.entries.length >= CONFIG.size && !D.drawn; }

  function promoCode(round) {
    var abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', s = '';
    for (var i = 0; i < 4; i++) s += abc[Math.floor(Math.random() * abc.length)];
    var t = '';
    for (var j = 0; j < 4; j++) t += abc[Math.floor(Math.random() * abc.length)];
    return 'RFS-' + (round || D.round) + s + '-' + t;
  }

  /* Провести розыгрыш. Возвращает объект с победителем и углом
     для стрелки (idx — номер строки списка сверху вниз). */
  function draw() {
    if (D.drawn) return D.drawn;
    if (!ready()) return null;
    var idx = Math.floor(Math.random() * D.entries.length);
    var winner = D.entries[idx];
    var code = promoCode(D.round);
    var result = {
      round: D.round,
      idx: idx,
      winner: { id: winner.id, name: winner.name, me: !!winner.me },
      entries: D.entries.slice(),
      code: winner.me ? code : null,   // чужой промокод в этом профиле не нужен
      at: Date.now()
    };
    if (winner.me) global.Account.grantPromo(code, CONFIG.prizeDays, 'r' + D.round);
    D.history.push({
      round: D.round, at: result.at,
      winner: result.winner, code: code,
      total: D.entries.length
    });
    D.drawn = result;
    save();
    return result;
  }

  /* новый круг после показа результата */
  function reset() {
    D.round += 1;
    /* первая очередь становится участниками нового круга, остальные сдвигаются */
    var q = Q();
    D.entries = (q.shift() || []).slice(0, CONFIG.size);
    D.drawn = null;
    save();
  }

  /* что этот профиль уже выигрывал */
  function myWins() {
    return D.history.filter(function (h) { return h.winner && h.winner.id === meId(); });
  }

  /* ---------- сервер (заглушка) ---------- */
  var backend = {
    url: '',
    join: function (userId) {
      if (!this.url) return Promise.resolve({ local: true });
      return fetch(this.url + '/raffle/join', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: userId })
      }).then(function (r) { return r.json(); });
    }
  };

  global.Raffle = {
    CONFIG: CONFIG,
    get data() { return D; },
    save: save,
    count: count, needed: needed, isJoined: isJoined,
    myQueue: myQueue, roundOpen: roundOpen, inRound: inRound,
    join: join, addDemo: addDemo, fillDemo: fillDemo,
    ready: ready, draw: draw, reset: reset,
    myWins: myWins,
    backend: backend
  };
})(window);
