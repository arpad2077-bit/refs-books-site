/* ============================================================
   docstore.js — хранение загруженных HTML-документов
   ------------------------------------------------------------
   Blob-ссылка живёт только до перезагрузки страницы, поэтому
   текст документа кладём в IndexedDB и восстанавливаем при старте.
   ============================================================ */
(function (global) {
  'use strict';

  var DB_NAME = 'refmap-docs';
  var STORE = 'docs';
  var dbp = null;

  function openDB() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbp;
  }

  function tx(mode) {
    return openDB().then(function (db) {
      return db.transaction(STORE, mode).objectStore(STORE);
    });
  }

  function put(id, html) {
    return tx('readwrite').then(function (st) {
      return new Promise(function (resolve, reject) {
        var r = st.put(html, id);
        r.onsuccess = function () { resolve(true); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }

  function get(id) {
    return tx('readonly').then(function (st) {
      return new Promise(function (resolve, reject) {
        var r = st.get(id);
        r.onsuccess = function () { resolve(r.result || null); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }

  function remove(id) {
    return tx('readwrite').then(function (st) {
      return new Promise(function (resolve) {
        var r = st.delete(id);
        r.onsuccess = function () { resolve(true); };
        r.onerror = function () { resolve(false); };
      });
    });
  }

  global.DocStore = {
    put: put,
    get: get,
    remove: remove,
    available: (function () {
      try { return !!global.indexedDB; } catch (e) { return false; }
    })()
  };
})(window);
