/* ============================================================
   payments.js — оплата подписки
   ------------------------------------------------------------
   Сейчас работает ДЕМО-провайдер: оплата имитируется и статус
   подписчика выдаётся сразу. Для приёма реальных денег нужен
   сервер и договор с платёжным агрегатором (ЮKassa,
   CloudPayments, Тинькофф Касса, Робокасса и т. п.) — все они
   принимают МИР, Visa, Mastercard и СБП.

   Как подключить настоящий провайдер:
   1. На сервере создайте метод POST /payments, который через API
      агрегатора создаёт платёж и возвращает { confirmationUrl }.
   2. Агрегатор после оплаты шлёт вебхук на сервер — там и
      выдаётся подписка (а не в браузере).
   3. Здесь укажите Payments.config.provider = 'server' и
      Payments.config.endpoint = 'https://ваш-сервер/payments'.
   ============================================================ */
(function (global) {
  'use strict';

  var METHODS = [
    { id: 'mir',        title: 'МИР',              kind: 'card' },
    { id: 'visa',       title: 'Visa',             kind: 'card' },
    { id: 'mastercard', title: 'Mastercard',       kind: 'card' },
    { id: 'sbp',        title: 'СБП',              kind: 'sbp'  },
    { id: 'sberpay',    title: 'SberPay',          kind: 'wallet' },
    { id: 'tpay',       title: 'T-Pay',            kind: 'wallet' },
    { id: 'yoomoney',   title: 'ЮMoney',           kind: 'wallet' }
  ];

  var config = {
    provider: 'demo',     // 'demo' | 'server'
    endpoint: '',
    currency: 'RUB'
  };

  /* checkout(planId, methodId, opts) -> Promise<{ok, demo?, redirect?}>
     opts = {amount, kind} — для разовых платежей вроде взноса
     за розыгрыш; такие платежи не выдают подписку сами по себе. */
  function checkout(planId, methodId, opts) {
    opts = opts || {};
    var plan = opts.kind === 'raffle'
      ? { id: 'raffle', title: 'Взнос за розыгрыш', price: opts.amount || 70 }
      : global.Account.PLANS[planId];
    if (!plan) return Promise.reject(new Error('Неизвестный тариф'));

    if (config.provider === 'server' && config.endpoint) {
      return fetch(config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan: plan.id,
          amount: plan.price,
          currency: config.currency,
          method: methodId,
          user: global.Account.data.id,
          returnUrl: location.href.split('#')[0] + '#/profile'
        })
      }).then(function (r) {
        if (!r.ok) throw new Error('Сервер оплаты ответил ' + r.status);
        return r.json();
      }).then(function (d) {
        if (d.confirmationUrl) {
          location.href = d.confirmationUrl;
          return { ok: true, redirect: true };
        }
        throw new Error('Сервер не вернул ссылку на оплату');
      });
    }

    /* демо: имитация успешной оплаты */
    return new Promise(function (resolve) {
      setTimeout(function () {
        /* взнос за розыгрыш подписку не выдаёт — только участие */
        if (plan.id !== 'raffle') global.Account.activate(plan.id);
        resolve({ ok: true, demo: true });
      }, 900);
    });
  }

  global.Payments = {
    METHODS: METHODS,
    config: config,
    checkout: checkout,
    isDemo: function () { return config.provider !== 'server' || !config.endpoint; }
  };
})(window);
