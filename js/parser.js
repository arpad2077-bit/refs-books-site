/* ============================================================
   parser.js — разбор HTML-документа «произведение с отсылками»
   Формат эталона: «Фауст — с отсылками.html»
   ------------------------------------------------------------
   Ищет блоки <div class="note"> и вытаскивает из них:
     • номер, раздел (<h3>), место в тексте, цитату,
     • источник, обоснование,
     • список произведений (<span class="chip">…</span>).
   Если разметки нет — пробует разобрать markdown-вариант
   (**Источник:** / **Обоснование:**).
   ============================================================ */
(function (global) {
  'use strict';

  function clean(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  function textOf(el) { return el ? clean(el.textContent) : ''; }

  /* --- markdown-фолбэк ------------------------------------- */
  function parseMarkdown(text) {
    var refs = [];
    var section = '';
    var lines = String(text).split(/\r?\n/);
    var cur = null;

    lines.forEach(function (raw) {
      var line = raw.trim();

      var sec = /^<summary>.*?<\/strong>\s*<\/summary>$/i.test(line)
        ? '' : null;
      var h = line.match(/^(?:#{1,4}\s+)?(\d+)\.\s+(.+)$/);
      if (/^<summary>/i.test(line)) {
        section = clean(line.replace(/<[^>]+>/g, ' ').replace(/^<summary>/, ''));
        return;
      }

      // заголовок раздела: «1. Посвящение…» без кавычек-цитаты
      if (h && line.indexOf('**') < 0) { section = clean(h[2]); cur = null; return; }

      // начало отсылки: «1. **«цитата»** *(с. 1, Сцена)*»
      var m = line.match(/^(\d+)\.\s+\*\*(.+?)\*\*\s*(?:\*\((.*?)\)\*)?/);
      if (m) {
        cur = {
          n: parseInt(m[1], 10),
          section: section,
          loc: clean(m[3] || ''),
          quote: clean(m[2]).replace(/^[«"]|[»"]$/g, ''),
          source: '', justification: '', nodes: []
        };
        refs.push(cur);
        return;
      }

      if (!cur) return;
      var src = line.match(/^\*?\s*\*\*(Источник|Обоснование):?\*\*\s*([\s\S]*)$/i);
      if (src) {
        var val = clean(src[2].replace(/\*\*/g, ''));
        if (/Обоснование/i.test(src[1])) cur.justification = val;
        else { cur.source = val; cur.nodes = splitNodes(val); }
      }
    });

    return refs;
  }

  // очень грубое извлечение названий из строки «Источник:»
  function splitNodes(src) {
    var out = [];
    String(src).split(/;\s*/).forEach(function (part) {
      var p = clean(part);
      if (!p) return;
      var name = p.split(/\s*\(/)[0];
      name = clean(name.replace(/^(?:и|или|напр\.|например),?\s*/i, ''));
      if (name.length > 2 && name.length < 90) out.push({ title: name, terminal: false });
    });
    return out;
  }

  /* --- основной парсер HTML -------------------------------- */
  function parseHTML(htmlString, opts) {
    opts = opts || {};
    var doc = new DOMParser().parseFromString(htmlString, 'text/html');

    var notes = Array.prototype.slice.call(doc.querySelectorAll('.note'));
    var heads = Array.prototype.slice.call(doc.querySelectorAll('h3'));

    if (!notes.length) {
      var bodyText = doc.body ? doc.body.textContent : htmlString;
      return { refs: parseMarkdown(bodyText), title: guessTitle(doc, opts), mode: 'markdown' };
    }

    var refs = [];
    notes.forEach(function (el, idx) {
      var n = parseInt(textOf(el.querySelector('.num')), 10) || (idx + 1);

      // раздел — последний <h3> перед этим блоком
      var section = '';
      for (var i = heads.length - 1; i >= 0; i--) {
        if (heads[i].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
          section = textOf(heads[i]); break;
        }
      }

      var hd = el.querySelector('.hd');
      var loc = textOf(hd).replace(/^\d+\s*/, '');

      var quote = textOf(el.querySelector('.q'))
        .replace(/^[«"]/, '').replace(/[»"]$/, '');

      var source = '', justification = '';
      Array.prototype.forEach.call(el.querySelectorAll('p'), function (p) {
        var sp = p.querySelector('.src');
        if (!sp) return;
        var key = clean(sp.textContent).replace(/:$/, '');
        var val = clean(p.textContent).replace(clean(sp.textContent), '');
        if (/Обоснован/i.test(key)) justification = val;
        else source = val;
      });

      var nodes = [];
      var seen = {};
      Array.prototype.forEach.call(el.querySelectorAll('.chip'), function (c) {
        var t = clean(c.textContent);
        if (!t || seen[t]) return;
        seen[t] = 1;
        nodes.push({ title: t, terminal: c.classList.contains('end') });
      });

      refs.push({
        n: n, section: section, loc: loc, quote: quote,
        source: source, justification: justification, nodes: nodes
      });
    });

    return { refs: refs, title: guessTitle(doc, opts), mode: 'html' };
  }

  function guessTitle(doc, opts) {
    if (opts.title) return opts.title;
    var h1 = doc.querySelector('h1');
    return h1 ? clean(h1.textContent) : (doc.title || 'Без названия');
  }

  global.RefParser = {
    parse: parseHTML,
    parseMarkdown: parseMarkdown,
    clean: clean
  };
})(window);
