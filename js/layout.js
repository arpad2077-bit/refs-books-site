/* ============================================================
   layout.js — геометрия карты
   ------------------------------------------------------------
   • Основная линия: горизонтальная цепь произведений.
   • Плашка слева от узла открывает ветку: от неё влево-вниз
     уходит прямая линия, вдоль которой стоят прямоугольники
     произведений-источников.
   • Следующая ступень раскрытия уходит ещё левее.
   • Промежуток между узлом и предыдущим растягивается так,
     чтобы вся ветка поместилась в него.
   ============================================================ */
window.Layout = (function () {
  'use strict';

  var C = {
    NODE_W: 216, NODE_H: 46,      // узел основной линии
    ITEM_W: 200, ITEM_H: 30,      // прямоугольник отсылки
    DX: 46, DY: 46,               // шаг ступени влево-вниз
    COL_GAP: 210,                 // отступ до следующей ступени раскрытия
    GAP: 96,                      // зазор, когда ветка раскрыта
    MINGAP: 28,                   // зазор, когда ветка закрыта
    PAGE: 20,                     // сколько отсылок показывать сразу
    MAX_DEPTH: 5
  };

  function curve(x1, y1, x2, y2) {
    var mx = (x1 + x2) / 2;
    return 'M' + x1 + ' ' + y1 + 'C' + mx + ' ' + y1 + ' ' + mx + ' ' + y2 + ' ' + x2 + ' ' + y2;
  }

  /* ---------- одна ступень + её продолжения ----------
     ox, oy — точка на плашке, откуда уходит линия            */
  function plan(ctx, workId, dir, ox, oy, depth) {
    depth = depth || 0;

    var res = {
      items: [], edges: [],
      minX: ox, maxX: ox + C.NODE_W, maxY: oy + C.NODE_H
    };

    /* ветка существует только у раскрытого произведения */
    if (!ctx.isOpen(workId)) return res;

    var list = ctx.list(workId, dir);
    if (!list.length) return res;

    var shown = Math.min(list.length, ctx.shown(workId));
    var more = list.length - shown;
    var lastPt = null;

    function place(k, item) {
      var right = ox - (k + 1) * C.DX;          // правый край на линии
      var cy = oy + (k + 1) * C.DY;
      item.x = right - C.ITEM_W;
      item.y = cy - C.ITEM_H / 2;
      item.w = C.ITEM_W;
      item.h = C.ITEM_H;
      item.depth = depth;
      if (item.x < res.minX) res.minX = item.x;
      if (item.y + C.ITEM_H > res.maxY) res.maxY = item.y + C.ITEM_H;
      lastPt = { x: right, y: cy };
      return item;
    }

    for (var k = 0; k < shown; k++) {
      var it = list[k];
      res.items.push(place(k, {
        kind: 'ref', workId: it.id, title: it.title,
        spine: !!it.spine, hasRefs: !!it.hasRefs,
        open: ctx.isOpen(it.id), count: it.count || 0
      }));
    }

    if (more > 0) {
      res.items.push(place(shown, {
        kind: 'more', workId: workId, more: more,
        title: 'ещё ' + more + '…'
      }));
    }

    /* прямая линия ступени */
    if (lastPt) {
      res.edges.push({
        cls: 'branch',
        d: 'M' + ox + ' ' + oy + 'L' + lastPt.x + ' ' + lastPt.y
      });
    }

    if (depth >= C.MAX_DEPTH) return res;

    /* --- продолжения: ещё левее --- */
    var subX = res.minX - C.COL_GAP;
    var lastY = null;

    /* снимок: только элементы этой ступени, без добавленных ниже */
    var own = res.items.slice();

    for (var i = 0; i < own.length; i++) {
      var item = own[i];
      if (item.kind !== 'ref' || !item.open || !item.hasRefs) continue;

      var center = item.y + C.ITEM_H / 2;
      var childOy = (lastY === null) ? center : Math.max(center, lastY + C.DY);

      var child = plan(ctx, item.workId, 'out', subX, childOy, depth + 1);
      if (!child.items.length) continue;

      /* помечаем, из какого прямоугольника выросла эта ступень */
      child.items.forEach(function (ci) {
        if (!ci.owner) ci.owner = item.workId;
      });

      res.edges.push({
        cls: 'link',
        d: curve(item.x, center, subX, childOy)
      });

      res.items = res.items.concat(child.items);
      res.edges = res.edges.concat(child.edges);

      if (child.minX < res.minX) res.minX = child.minX;
      if (child.maxY > res.maxY) res.maxY = child.maxY;

      lastY = childOy;
    }

    return res;
  }

  /* ---------- основная карта ---------- */
  function main(ctx, spine) {
    var nodes = [], items = [], edges = [];
    var minX = 0, maxY = 0;
    var prevRight = null;

    spine.forEach(function (w, i) {
      var x = (prevRight === null) ? 0 : prevRight;
      var branch = plan(ctx, w.id, 'out', x, C.NODE_H / 2, 0);

      if (prevRight === null) {
        if (branch.minX < 0) {
          x = -branch.minX + 50;
          branch = plan(ctx, w.id, 'out', x, C.NODE_H / 2, 0);
        }
      } else if (branch.items.length) {
        /* промежуток растягивается на всю ширину раскрытой ветки */
        var shift = (prevRight + C.GAP) - branch.minX;
        if (shift > 0) {
          x += shift;
          branch = plan(ctx, w.id, 'out', x, C.NODE_H / 2, 0);
        }
      } else {
        x = prevRight + C.MINGAP;
      }

      nodes.push({
        kind: 'node', workId: w.id, title: w.title, year: w.year,
        x: x, y: 0, w: C.NODE_W, h: C.NODE_H,
        spine: true, idx: i, open: ctx.isOpen(w.id),
        count: ctx.outCount(w.id)
      });

      items = items.concat(branch.items);
      edges = edges.concat(branch.edges);
      if (branch.minX < minX) minX = branch.minX;
      if (branch.maxY > maxY) maxY = branch.maxY;

      if (prevRight !== null) {
        edges.push({ cls: 'spine', d: 'M' + (prevRight + 4) + ' ' + (C.NODE_H / 2) + 'H' + (x - 4) });
      }
      prevRight = x + C.NODE_W;
    });

    return {
      nodes: nodes, items: items, edges: edges,
      bbox: {
        minX: minX, minY: 0,
        maxX: prevRight || C.NODE_W,
        maxY: Math.max(maxY, C.NODE_H)
      }
    };
  }

  /* ---------- карта одного произведения ----------
     anchor: 'bottom' — единственный узел, к нему подстраиваем вид */
  function single(ctx, work, dir) {
    var branch = plan(ctx, work.id, dir, 0, C.NODE_H / 2, 0);
    var dx = branch.minX < 0 ? (-branch.minX + 50) : 0;
    if (dx) branch = plan(ctx, work.id, dir, dx, C.NODE_H / 2, 0);

    var node = {
      kind: 'node', workId: work.id, title: work.title, year: work.year,
      x: dx, y: 0, w: C.NODE_W, h: C.NODE_H,
      spine: !!work.spine, open: ctx.isOpen(work.id),
      count: ctx.list(work.id, dir).length
    };

    return {
      nodes: [node], items: branch.items, edges: branch.edges,
      bbox: {
        minX: Math.min(branch.minX, 0), minY: 0,
        maxX: dx + C.NODE_W,
        maxY: Math.max(branch.maxY, C.NODE_H)
      }
    };
  }

  /* ---------- раскладка цепочки слева направо ----------
     ids — последовательность; startX — откуда начинать; y — верх узлов;
     gapFn(i) — дополнительный зазор перед i-м узлом (между эпохами)   */
  function chain(ctx, ids, startX, y, gapFn) {
    var res = { nodes: [], items: [], edges: [], minX: startX, maxX: startX, maxY: y + C.NODE_H, xs: {} };
    var prevRight = null;

    ids.forEach(function (w, i) {
      var extra = gapFn ? gapFn(i) : 0;
      var x = prevRight === null ? startX : prevRight + extra;
      var oy = y + C.NODE_H / 2;
      var branch = plan(ctx, w.id, 'out', x, oy, 0);

      if (branch.items.length) {
        var limitX = (prevRight === null ? startX - 1e9 : prevRight) + C.GAP;
        var shift = limitX - branch.minX;
        if (prevRight === null) shift = 0;
        if (shift > 0) { x += shift; branch = plan(ctx, w.id, 'out', x, oy, 0); }
      } else if (prevRight !== null) {
        x = prevRight + Math.max(C.MINGAP, extra);
      }

      res.nodes.push({
        kind: 'node', workId: w.id, title: w.title, year: w.year,
        x: x, y: y, w: C.NODE_W, h: C.NODE_H,
        spine: true, idx: i, open: ctx.isOpen(w.id),
        count: ctx.outCount(w.id), lane: w.lane || 0
      });
      res.xs[w.id] = x;
      res.items = res.items.concat(branch.items);
      res.edges = res.edges.concat(branch.edges);
      if (branch.minX < res.minX) res.minX = branch.minX;
      if (branch.maxY > res.maxY) res.maxY = branch.maxY;

      if (prevRight !== null) {
        res.edges.push({
          cls: w.linkCls || 'spine',
          d: 'M' + (prevRight + 4) + ' ' + (y + C.NODE_H / 2) + 'H' + (x - 4)
        });
      }
      prevRight = x + C.NODE_W;
    });
    res.maxX = prevRight === null ? startX : prevRight;
    return res;
  }

  /* ---------- карта по эпохам ----------
     Главная линия эпох идёт по y = 0. Альтернативные маршруты
     выводятся вверх соединительным отрезком от узла расхождения
     и идут параллельно. Ветки отсылок раскрываются вниз-влево,
     поэтому параллельная линия поднимается на высоту раскрытых
     веток своих узлов и никогда их не перекрывает.                 */
  var EPOCH_GAP = 150, LANE_GAP = 70;

  function epochs(ctx, EP) {
    /* 1. главная линия */
    var seq = [], epochOf = {}, mainIds = {};
    EP.forEach(function (ep, ei) {
      ep.works.forEach(function (w, wi) {
        var o = { id: w.id, title: w.title, year: w.year };
        if (wi === 0 && ei > 0) {
          o.epochStart = true;
          o.linkCls = ep.bridge && ep.bridge.direct ? 'spine' : 'gap';
        }
        seq.push(o);
        epochOf[w.id] = ep.id;
        mainIds[w.id] = 1;
      });
    });

    var main = chain(ctx, seq, 0, 0, function (i) { return seq[i].epochStart ? EPOCH_GAP : 0; });
    if (main.minX < 0) main = chain(ctx, seq, -main.minX + 50, 0, function (i) { return seq[i].epochStart ? EPOCH_GAP : 0; });

    var nodes = main.nodes.slice(), items = main.items.slice(), edges = main.edges.slice();
    var xs = Object.assign({}, main.xs);
    var minX = main.minX, maxX = main.maxX, minY = 0, maxY = main.maxY;

    /* 2. альтернативные маршруты: сначала считаем по горизонтали */
    var lanes = [];
    EP.forEach(function (ep) {
      (ep.alts || []).forEach(function (alt) {
        var fromId = alt.from || ep.works[0].id;
        var list = [], joinId = alt.join || null;
        alt.works.forEach(function (w) {
          if (mainIds[w.id]) { if (!joinId) joinId = w.id; return; }
          list.push({ id: w.id, title: w.title, year: w.year });
        });
        if (!list.length) return;
        lanes.push({ alt: alt, ep: ep, fromId: fromId, joinId: joinId, list: list });
      });
    });

    /* порядок важен: «from» может лежать на ранее построенной линии */
    var levels = [];   // [{ ranges: [[x1,x2]], extent }]
    lanes.forEach(function (ln) {
      var fx = xs[ln.fromId];
      if (fx == null) return;
      var startX = fx + C.NODE_W + 60;

      /* пробный проход на y=0 — нужны ширина и глубина раскрытых веток */
      var probe = chain(ctx, ln.list, startX, 0);
      var extent = Math.max(0, probe.maxY - C.NODE_H);
      ln.x1 = Math.min(probe.minX, fx) - 20;
      ln.x2 = probe.maxX + 20;
      ln.extent = extent;
      ln.startX = startX;

      /* уровень: самый нижний, где нет пересечения по горизонтали */
      var lv = 0;
      for (; lv < levels.length; lv++) {
        var clash = levels[lv].ranges.some(function (r) { return !(ln.x2 < r[0] || ln.x1 > r[1]); });
        if (!clash) break;
      }
      if (!levels[lv]) levels[lv] = { ranges: [], extent: 0 };
      levels[lv].ranges.push([ln.x1, ln.x2]);
      levels[lv].extent = Math.max(levels[lv].extent, extent);
      ln.level = lv;
    });

    /* высота каждого уровня: узел + его раскрытые ветки + зазор */
    var levelY = [], y = 0;
    levels.forEach(function (lv, i) {
      y -= (C.NODE_H + lv.extent + LANE_GAP);
      levelY[i] = y;
    });

    lanes.forEach(function (ln) {
      if (ln.level == null) return;
      var ly = levelY[ln.level];
      var res = chain(ctx, ln.list, ln.startX, ly);
      res.nodes.forEach(function (n) { n.lane = ln.level + 1; n.alt = ln.alt.id; });
      nodes = nodes.concat(res.nodes);
      items = items.concat(res.items);
      edges = edges.concat(res.edges);
      Object.keys(res.xs).forEach(function (k) { if (xs[k] == null) xs[k] = res.xs[k]; });

      /* соединительный отрезок: вверх от узла расхождения, затем вправо */
      var fromNode = nodes.filter(function (n) { return n.workId === ln.fromId; })[0];
      var first = res.nodes[0];
      var cx = fromNode.x + C.NODE_W - 30;
      var cy = ly + C.NODE_H / 2;
      edges.push({
        cls: 'fork',
        d: 'M' + cx + ' ' + (fromNode.y - 2) + 'V' + (cy + 10) +
           'Q' + cx + ' ' + cy + ' ' + (cx + 10) + ' ' + cy + 'H' + (first.x - 4)
      });

      /* возврат к главной линии */
      if (ln.joinId) {
        var join = nodes.filter(function (n) { return n.workId === ln.joinId && !n.alt; })[0];
        var last = res.nodes[res.nodes.length - 1];
        if (join) {
          var jx = join.x + 30;
          edges.push({
            cls: 'fork',
            d: 'M' + (last.x + C.NODE_W + 4) + ' ' + cy + 'H' + (jx - 10) +
               'Q' + jx + ' ' + cy + ' ' + jx + ' ' + (cy + 10) + 'V' + (join.y - 2)
          });
        }
      }

      labels.push({ x: first.x, y: ly - 22, text: ln.alt.title, cls: 'lane-cap' });

      if (res.minX < minX) minX = res.minX;
      if (res.maxX > maxX) maxX = res.maxX;
      if (ly < minY) minY = ly;
      if (res.maxY > maxY) maxY = res.maxY;
    });

    /* 3. подписи эпох: полосы над всеми линиями */
    var bands = [];
    var topY = minY - 90;
    EP.forEach(function (ep) {
      var ns = main.nodes.filter(function (n) { return epochOf[n.workId] === ep.id; });
      if (!ns.length) return;
      var x1 = ns[0].x - 40;
      var x2 = ns[ns.length - 1].x + C.NODE_W + 40;
      bands.push({ id: ep.id, title: ep.title, span: ep.span, x1: x1, x2: x2, y: topY });
    });

    return {
      nodes: nodes, items: items, edges: edges, bands: bands, labels: labels,
      bbox: { minX: Math.min(minX, 0), minY: topY, maxX: maxX, maxY: maxY }
    };
  }
  var labels = [];

  return {
    build: function (ctx, spine) {
      if (ctx.mode) return single(ctx, ctx.mode.work, ctx.mode.dir);
      if (ctx.view === 'epochs') { labels = []; return epochs(ctx, window.EPOCHS || []); }
      return main(ctx, spine);
    },
    C: C
  };
})();
