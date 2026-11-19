/* ============================================================
   ads.js — места под рекламу
   ------------------------------------------------------------
   Рекламные места есть на главной странице (внизу, под
   описанием) и по бокам от текста произведения (только на
   широких экранах, чтобы не сжимать текст).
   Подписчикам реклама не показывается.

   Как подключить рекламную сеть (например, РСЯ):
   1. Подключите скрипт сети в index.html.
   2. Задайте Ads.config.provider и Ads.config.render —
      функцию, которая рисует блок в переданный контейнер:

      Ads.config.render = function (el, slot) {
        // slot: 'home' | 'reader-left' | 'reader-right'
        window.yaContextCb.push(() => Ya.Context.AdvManager.render({
          blockId: 'R-A-XXXXXX-' + (slot === 'home' ? 1 : 2),
          renderTo: el.id
        }));
      };
   ============================================================ */
(function (global) {
  'use strict';

  var config = {
    provider: '',          // пусто — показываем аккуратные заглушки
    render: null
  };

  var seq = 0;

  /* заполняет все элементы [data-ad-slot] внутри root */
  function fill(root) {
    var show = !(global.Account && global.Account.isSubscriber());
    Array.prototype.forEach.call((root || document).querySelectorAll('[data-ad-slot]'), function (el) {
      el.hidden = !show;
      if (!show) return;
      if (el.getAttribute('data-ad-filled')) return;
      el.setAttribute('data-ad-filled', '1');
      if (!el.id) el.id = 'ad-' + (++seq);

      var slot = el.getAttribute('data-ad-slot');
      if (typeof config.render === 'function') {
        try { config.render(el, slot); return; } catch (e) { console.warn(e); }
      }
      el.innerHTML = '<div class="ad-ph"><span>Реклама</span><small>место для рекламного блока</small></div>';
    });
  }

  /* после смены статуса — переотрисовать */
  function refresh(root) {
    Array.prototype.forEach.call((root || document).querySelectorAll('[data-ad-slot]'), function (el) {
      el.removeAttribute('data-ad-filled');
      el.innerHTML = '';
    });
    fill(root);
  }

  /* рекламный ролик при открытии текста на весь экран — только гостям, один раз за открытие */
  function interstitial(onDone) {
    if (global.Account && global.Account.isSubscriber()) { if (onDone) onDone(); return false; }
    var wait = config.skipAfter || 5;
    var ov = document.createElement('div');
    ov.className = 'ad-full';
    ov.innerHTML = `<div class='ad-full-box'><div class='ad-full-media'></div><div class='ad-full-bar'><span>Реклама</span><button class='ad-full-close' disabled>Закрыть через ${wait}</button></div></div>`;
    document.body.appendChild(ov);
    var media = ov.querySelector('.ad-full-media'), btn = ov.querySelector('.ad-full-close');
    if (typeof config.renderVideo === 'function') {
      try { config.renderVideo(media); } catch (e) { console.warn(e); }
    } else if (config.videoSrc) {
      media.innerHTML = `<video src='${config.videoSrc}' autoplay muted playsinline loop></video>`;
    } else {
      media.innerHTML = `<div class='ad-ph'><span>Реклама</span><small>место для рекламного ролика</small></div>`;
    }
    var left = wait, t = setInterval(function () {
      left--;
      if (left > 0) { btn.textContent = 'Закрыть через ' + left; return; }
      clearInterval(t); btn.disabled = false; btn.textContent = 'Закрыть ✕';
    }, 1000);
    btn.onclick = function () {
      if (btn.disabled) return;
      clearInterval(t); ov.remove();
      if (onDone) onDone();
    };
    return true;
  }

  global.Ads = { config: config, fill: fill, refresh: refresh, interstitial: interstitial };
})(window);
