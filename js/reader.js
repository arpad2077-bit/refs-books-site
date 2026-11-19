/* ============================================================
   reader.js — чтение текста произведения
   ------------------------------------------------------------
   Документ встраивается прямо в страницу (а не в iframe), чтобы
   работали выделения, закладки и учёт прочитанного — iframe с
   локального диска браузер не даёт читать из скрипта.
   Стили документа ограничиваются контейнером .rd-doc.
   ============================================================ */
(function (global) {
  'use strict';

  /* ---------- стили документа: префикс .rd-doc ---------- */
  function scopeCss(css) {
    var keep = [];
    css = css.replace(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, function (m) {
      keep.push(m); return '\u0000' + (keep.length - 1) + '\u0000';
    });
    css = css.replace(/([^{}\u0000]+)\{([^{}]*)\}/g, function (all, sel, body) {
      sel = sel.trim();
      if (!sel || sel.charAt(0) === '@') return all;
      var scoped = sel.split(',').map(function (s) {
        s = s.trim();
        if (s === ':root' || s === 'html' || s === 'body') return '.rd-doc';
        s = s.replace(/^(html|body)\s+/, '');
        return '.rd-doc ' + s;
      }).join(',');
      return scoped + '{' + body + '}';
    });
    return css.replace(/\u0000(\d+)\u0000/g, function (m, i) { return keep[+i]; });
  }

  function prepare(html) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var css = Array.prototype.map.call(doc.querySelectorAll('style'), function (s) {
      return s.textContent;
    }).join('\n');
    Array.prototype.forEach.call(doc.querySelectorAll('script,style,link,meta,title'), function (n) {
      n.remove();
    });
    return { css: scopeCss(css), body: doc.body ? doc.body.innerHTML : html };
  }

  /* ---------- позиция в тексте = смещение в символах ---------- */
  function textNodes(root) {
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null), out = [], n;
    while ((n = w.nextNode())) out.push(n);
    return out;
  }

  function offsetOf(root, node, off) {
    var r = document.createRange();
    r.setStart(root, 0);
    try { r.setEnd(node, off); } catch (e) { return 0; }
    return r.toString().length;
  }

  function locate(root, pos) {
    var nodes = textNodes(root), acc = 0;
    for (var i = 0; i < nodes.length; i++) {
      var len = nodes[i].nodeValue.length;
      if (acc + len >= pos) return { node: nodes[i], off: pos - acc };
      acc += len;
    }
    var last = nodes[nodes.length - 1];
    return last ? { node: last, off: last.nodeValue.length } : null;
  }

  /* ---------- выделения ---------- */
  function wrapRange(root, s, e, kind, at) {
    var nodes = textNodes(root), acc = 0;
    nodes.forEach(function (n) {
      var len = n.nodeValue.length, ns = acc, ne = acc + len;
      acc = ne;
      if (ne <= s || ns >= e) return;
      if (!n.nodeValue.trim() && n.parentNode && /^(DIV|MAIN|SECTION)$/.test(n.parentNode.tagName)) return;
      var a = Math.max(0, s - ns), b = Math.min(len, e - ns);
      var target = n;
      if (b < len) target.splitText(b);
      if (a > 0) target = target.splitText(a);
      var m = document.createElement('mark');
      m.className = 'rd-hl rd-' + kind;
      m.setAttribute('data-hl', String(at));
      target.parentNode.insertBefore(m, target);
      m.appendChild(target);
    });
  }

  function unwrapAll(root) {
    Array.prototype.forEach.call(root.querySelectorAll('mark.rd-hl'), function (m) {
      var p = m.parentNode;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m);
      p.normalize();
    });
  }

  /* ======================================================== */
  function Reader(opts) {
    this.id = opts.id;
    this.host = opts.host;          // прокручиваемый контейнер
    this.onChange = opts.onChange || function () {};
    this.onUndoable = opts.onUndoable || function () {};
    this.doc = null;
    this._bind();
  }

  Reader.prototype.load = function (html) {
    var p = prepare(html);
    this._ready = false;
    this.host.innerHTML =
      '<style>' + p.css + '</style>' +
      '<div class="rd-doc">' + p.body + '</div>';
    this.doc = this.host.querySelector('.rd-doc');
    this.paint();
    var self = this;
    var main = global.Account.bookmarks(this.id).main;
    /* пока позиция не восстановлена, события прокрутки от вставки
       документа не должны затирать прогресс и главную закладку нулём */
    setTimeout(function () {
      if (main) self.goTo(main.pos, false);
      clearTimeout(self._t);
      setTimeout(function () { self._ready = true; }, 80);
    }, 30);
  };

  /* ---------- видимые метки закладок ----------
     Метка — пустой элемент (без текста), номер и цвет рисуются через CSS,
     поэтому смещения символов в документе не меняются. */
  function clearMarks(root) {
    Array.prototype.forEach.call(root.querySelectorAll('span.rd-bm'), function (m) {
      var p = m.parentNode;
      p.removeChild(m);
      p.normalize();
    });
  }

  function insertMarker(root, pos, color, label, cls, key) {
    var loc = locate(root, pos);
    if (!loc) return;
    var n = loc.node, off = loc.off, len = n.nodeValue.length;
    var s = document.createElement('span');
    s.className = 'rd-bm ' + cls;
    s.setAttribute('data-n', label);
    s.setAttribute('data-bmk', key);
    s.style.setProperty('--c', color);
    if (off <= 0) n.parentNode.insertBefore(s, n);
    else if (off >= len) n.parentNode.insertBefore(s, n.nextSibling);
    else { var t = n.splitText(off); t.parentNode.insertBefore(s, t); }
  }

  Reader.prototype.paintMarks = function () {
    if (!this.doc) return;
    clearMarks(this.doc);
    var b = global.Account.bookmarks(this.id), root = this.doc, list = [];
    if (b.main) list.push({ pos: b.main.pos, color: '#8f1f3f', label: '⌂ главная', cls: 'main', key: 'main' });
    b.marks.forEach(function (m) {
      list.push({ pos: m.pos, color: m.color || '#8b6cf5', label: '№' + m.n, cls: 'num', key: String(m.n) });
    });
    list.sort(function (x, y) { return y.pos - x.pos; });
    list.forEach(function (it) { insertMarker(root, it.pos, it.color, it.label, it.cls, it.key); });
  };

  Reader.prototype.paint = function () {
    if (!this.doc) return;
    clearMarks(this.doc);
    unwrapAll(this.doc);
    var self = this;
    global.Account.highlights(this.id)
      .slice().sort(function (a, b) { return b.s - a.s; })
      .forEach(function (h) { wrapRange(self.doc, h.s, h.e, h.kind, h.at); });
    this.paintMarks();
  };

  /* текущая позиция: первый символ у верхнего края */
  Reader.prototype.currentPos = function () {
    if (!this.doc) return 0;
    var r = this.host.getBoundingClientRect();
    var x = r.left + Math.min(120, r.width / 3), y = r.top + 24;
    var range = null;
    if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(x, y);
    else if (document.caretPositionFromPoint) {
      var cp = document.caretPositionFromPoint(x, y);
      if (cp) { range = document.createRange(); range.setStart(cp.offsetNode, cp.offset); }
    }
    if (!range || !this.doc.contains(range.startContainer)) {
      /* запасной путь — доля прокрутки */
      var total = this.doc.textContent.length;
      return Math.round(total * this.ratio());
    }
    return offsetOf(this.doc, range.startContainer, range.startOffset);
  };

  Reader.prototype.snippet = function (pos) {
    var t = this.doc ? this.doc.textContent : '';
    return t.slice(pos, pos + 90).replace(/\s+/g, ' ').trim();
  };

  /* позиция в тексте по координатам на экране (для правого клика) */
  Reader.prototype.posAt = function (x, y) {
    if (!this.doc) return null;
    var range = null;
    if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(x, y);
    else if (document.caretPositionFromPoint) {
      var cp = document.caretPositionFromPoint(x, y);
      if (cp) { range = document.createRange(); range.setStart(cp.offsetNode, cp.offset); }
    }
    if (!range || !this.doc.contains(range.startContainer)) {
      /* клик в пустое поле — закладка у верхнего края видимой части */
      return this.currentPos();
    }
    return offsetOf(this.doc, range.startContainer, range.startOffset);
  };

  Reader.prototype.goTo = function (pos, flash) {
    if (!this.doc) return;
    var loc = locate(this.doc, pos);
    if (!loc) return;
    var el = loc.node.parentElement;
    var top = el.getBoundingClientRect().top - this.host.getBoundingClientRect().top + this.host.scrollTop;
    this.host.scrollTop = Math.max(0, top - 20);
    if (flash !== false) {
      el.classList.remove('rd-flash'); void el.offsetWidth; el.classList.add('rd-flash');
    }
  };

  Reader.prototype.ratio = function () {
    var h = this.host;
    var max = h.scrollHeight - h.clientHeight;
    return max > 0 ? h.scrollTop / max : 0;
  };

  /* ---------- выделение текста ---------- */
  Reader.prototype.selectionRange = function () {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !this.doc) return null;
    var r = sel.getRangeAt(0);
    if (!this.doc.contains(r.startContainer) || !this.doc.contains(r.endContainer)) return null;
    var s = offsetOf(this.doc, r.startContainer, r.startOffset);
    var e = offsetOf(this.doc, r.endContainer, r.endOffset);
    if (e - s < 2) return null;
    return { s: s, e: e, text: r.toString().slice(0, 300), rect: r.getBoundingClientRect() };
  };

  Reader.prototype.highlight = function (kind) {
    var sr = this.selectionRange();
    if (!sr) return null;
    var h = global.Account.addHighlight(this.id, { s: sr.s, e: sr.e, kind: kind, text: sr.text });
    window.getSelection().removeAllRanges();
    this.paint();
    var self = this;
    this.onUndoable({
      label: kind === 'mark' ? 'выделение цитаты' : 'подчёркивание цитаты',
      undo: function () { global.Account.removeHighlight(self.id, h.at); self.paint(); self.onChange(); }
    });
    this.onChange();
    return h;
  };

  Reader.prototype.removeHighlight = function (at) {
    var h = global.Account.removeHighlight(this.id, at);
    this.paint();
    var self = this;
    if (h) this.onUndoable({
      label: 'удаление выделения',
      undo: function () { global.Account.addHighlight(self.id, h); self.paint(); self.onChange(); }
    });
    this.onChange();
  };

  /* ---------- закладки ---------- */
  Reader.prototype.addMark = function (pos, color) {
    if (pos == null) pos = this.currentPos();
    var m = global.Account.addMark(this.id, pos, this.snippet(pos), color);
    var self = this;
    this.onUndoable({
      label: 'закладка № ' + m.n,
      undo: function () { global.Account.removeMark(self.id, m.n); self.onChange(); }
    });
    this.onChange();
    return m;
  };

  Reader.prototype.removeMark = function (n) {
    var m = global.Account.removeMark(this.id, n);
    var self = this;
    if (m) this.onUndoable({
      label: 'удаление закладки № ' + n,
      undo: function () { global.Account.restoreMark(self.id, m); self.onChange(); }
    });
    this.onChange();
  };

  /* ---------- прокрутка: прогресс и главная закладка ---------- */
  Reader.prototype._bind = function () {
    var self = this, t = null;
    this._onScroll = function () {
      clearTimeout(t);
      t = self._t = setTimeout(function () {
        if (!self.doc || self._ready === false) return;
        global.Account.setProgress(self.id, self.ratio());
        global.Account.setMain(self.id, self.currentPos());
        self.onChange('scroll');
      }, 450);
    };
    this.host.addEventListener('scroll', this._onScroll);

    /* внутренние ссылки документа (номера отсылок ↔ «к тексту») */
    this._onClick = function (ev) {
      var a = ev.target.closest && ev.target.closest('a.ref, a.back');
      if (!a || !self.doc || !self.doc.contains(a)) return;
      ev.preventDefault();
      var id = (a.getAttribute('href') || '').slice(1);
      var el = id && self.doc.querySelector('[id="' + id.replace(/"/g, '') + '"]');
      if (!el) return;
      var top = el.getBoundingClientRect().top - self.host.getBoundingClientRect().top + self.host.scrollTop;
      self.host.scrollTo({ top: Math.max(0, top - self.host.clientHeight / 3), behavior: 'smooth' });
      el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    };
    this.host.addEventListener('click', this._onClick);
  };

  Reader.prototype.destroy = function () {
    this.host.removeEventListener('scroll', this._onScroll);
    this.host.removeEventListener('click', this._onClick);
    this.host.innerHTML = '';
    this.doc = null;
  };

  global.Reader = Reader;
  global.Reader.scopeCss = scopeCss;
})(window);
