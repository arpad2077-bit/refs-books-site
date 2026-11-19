/* ============================================================
   server.js — сервер Refs.Books
   ------------------------------------------------------------
   Отдаёт сам сайт (index.html, js, css, docs) и API аккаунтов:

     GET  /api/ping              — сервер жив
     POST /api/register          — регистрация
     POST /api/login             — вход
     GET  /api/me                — кто вошёл (по токену)
     GET  /api/data              — данные профиля
     PUT  /api/data              — сохранить данные профиля
     POST /api/logout            — выход

   Запуск:  node server/server.js   (порт из переменной PORT)
   Зависимостей нет — только стандартная библиотека Node.
   База — файл server/data/db.json, пароли хранятся как scrypt-хеш.
   ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
/* Куда писать базу.
   1) DATA_DIR из окружения (Render, Docker);
   2) папка /data — единственное постоянное хранилище Amvera:
      всё остальное там стирается при перезапуске;
   3) рядом с сервером (локальный запуск). */
function pickDataDir() {
  if (process.env.DATA_DIR) return path.resolve(process.env.DATA_DIR);
  if (process.platform !== 'win32') {
    try {
      if (fs.existsSync('/data') && fs.statSync('/data').isDirectory()) {
        return path.join('/data', 'refs-books');
      }
    } catch (e) {}
  }
  return path.join(__dirname, 'data');
}

const DATA_DIR = pickDataDir();
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PORT = Number(process.env.PORT) || 3000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};

/* ---------------- база ---------------- */
let db = { users: [], data: {} };

function loadDb() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const d = JSON.parse(raw);
    if (d && Array.isArray(d.users)) db = { users: d.users, data: d.data || {} };
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('база не прочитана:', e.message);
  }
}

let saveTimer = null;
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeDb, 200);
}
function writeDb() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    console.warn('база не сохранена:', e.message);
  }
}

/* ---------------- утилиты ---------------- */
function uid() { return crypto.randomBytes(9).toString('hex'); }
function token() { return crypto.randomBytes(32).toString('hex'); }
function normEmail(e) { return String(e || '').trim().toLowerCase(); }
function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e); }

function hashPass(pass, salt) {
  return crypto.scryptSync(String(pass), salt, 64).toString('hex');
}
function makePass(pass) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + hashPass(pass, salt);
}
function checkPass(stored, pass) {
  const i = String(stored).indexOf(':');
  if (i < 0) return false;
  const salt = stored.slice(0, i), h = stored.slice(i + 1);
  const probe = Buffer.from(hashPass(pass, salt), 'hex');
  const orig = Buffer.from(h, 'hex');
  return probe.length === orig.length && crypto.timingSafeEqual(probe, orig);
}
function pubUser(u) { return { id: u.id, name: u.name, email: u.email }; }
function userByToken(req) {
  const h = String(req.headers.authorization || '');
  const t = h.indexOf('Bearer ') === 0 ? h.slice(7).trim() : '';
  if (!t) return null;
  return db.users.find(function (u) { return u.token === t; }) || null;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req, limit) {
  limit = limit || 5 * 1024 * 1024;
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > limit) { reject(new Error('слишком большой запрос')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () {
      try {
        const s = Buffer.concat(chunks).toString('utf8');
        resolve(s ? JSON.parse(s) : {});
      } catch (e) { reject(new Error('некорректный JSON')); }
    });
    req.on('error', reject);
  });
}

/* ---------------- API ---------------- */
async function api(req, res, url) {
  const p = url.pathname;

  if (p === '/api/ping') {
    return json(res, 200, { ok: true, server: true, time: Date.now() });
  }

  if (p === '/api/register' && req.method === 'POST') {
    let b;
    try { b = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    const name = String(b.name || '').trim();
    const email = normEmail(b.email);
    const pass = String(b.password || '');
    if (name.length < 2) return json(res, 400, { ok: false, error: 'Имя профиля — минимум 2 символа' });
    if (!validEmail(email)) return json(res, 400, { ok: false, error: 'Проверьте электронную почту' });
    if (pass.length < 6) return json(res, 400, { ok: false, error: 'Пароль — минимум 6 символов' });
    if (db.users.some(function (u) { return u.email === email; })) {
      return json(res, 409, { ok: false, error: 'Аккаунт с такой почтой уже есть — войдите в него' });
    }
    const u = {
      id: uid(), name: name, email: email, pass: makePass(pass),
      token: token(), createdAt: Date.now()
    };
    db.users.push(u);
    db.data[u.id] = { data: b.startData || null, updatedAt: Number(b.updatedAt) || 0 };
    saveDb();
    return json(res, 200, { ok: true, token: u.token, user: pubUser(u) });
  }

  if (p === '/api/login' && req.method === 'POST') {
    let b;
    try { b = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    const email = normEmail(b.email);
    const u = db.users.find(function (x) { return x.email === email; });
    if (!u) return json(res, 404, { ok: false, error: 'Аккаунт с такой почтой не найден' });
    if (!checkPass(u.pass, String(b.password || ''))) {
      return json(res, 401, { ok: false, error: 'Неверный пароль' });
    }
    u.token = token();
    u.lastLogin = Date.now();
    saveDb();
    return json(res, 200, { ok: true, token: u.token, user: pubUser(u) });
  }

  if (p === '/api/me' && req.method === 'GET') {
    const u = userByToken(req);
    if (!u) return json(res, 401, { ok: false, error: 'Нужен вход' });
    return json(res, 200, { ok: true, user: pubUser(u) });
  }

  if (p === '/api/logout' && req.method === 'POST') {
    const u = userByToken(req);
    if (u) { u.token = null; saveDb(); }
    return json(res, 200, { ok: true });
  }

  if (p === '/api/data') {
    const u = userByToken(req);
    if (!u) return json(res, 401, { ok: false, error: 'Нужен вход' });

    if (req.method === 'GET') {
      const rec = db.data[u.id] || { data: null, updatedAt: 0 };
      return json(res, 200, { ok: true, data: rec.data, updatedAt: rec.updatedAt });
    }
    if (req.method === 'PUT') {
      let b;
      try { b = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      const updatedAt = Number(b.updatedAt) || Date.now();
      const cur = db.data[u.id] || { updatedAt: 0 };
      /* не затираем более свежие данные с другого устройства */
      if (updatedAt < cur.updatedAt) {
        return json(res, 200, { ok: true, stale: true, updatedAt: cur.updatedAt });
      }
      db.data[u.id] = { data: b.data || null, updatedAt: updatedAt };
      saveDb();
      return json(res, 200, { ok: true, updatedAt: updatedAt });
    }
    return json(res, 405, { ok: false, error: 'Метод не поддерживается' });
  }

  return json(res, 404, { ok: false, error: 'Нет такого адреса' });
}

/* ---------------- статика ---------------- */
function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch (e) { rel = '/'; }
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel.indexOf('/server') === 0 || rel.indexOf('/.') === 0) {
    res.writeHead(403); return res.end('403');
  }
  const file = path.normalize(path.join(ROOT, rel));
  if (file.indexOf(ROOT) !== 0) { res.writeHead(403); return res.end('403'); }

  fs.stat(file, function (err, st) {
    if (err || !st.isFile()) {
      /* неизвестный адрес — отдаём главную, чтобы работали ссылки вида #/… */
      return fs.readFile(path.join(ROOT, 'index.html'), function (e2, html) {
        if (e2) { res.writeHead(404); return res.end('404'); }
        res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache' });
        res.end(html);
      });
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------------- сервер ---------------- */
loadDb();

const server = http.createServer(function (req, res) {
  let url;
  try { url = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); }
  catch (e) { res.writeHead(400); return res.end('400'); }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');

  if (url.pathname.indexOf('/api/') === 0) {
    api(req, res, url).catch(function (e) {
      console.error(e);
      try { json(res, 500, { ok: false, error: 'Ошибка сервера' }); } catch (e2) {}
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('405'); }
  serveStatic(req, res, url);
});

server.listen(PORT, function () {
  console.log('Refs.Books: сервер запущен на порту ' + PORT);
  console.log('Сайт: http://localhost:' + PORT + '/');
});

process.on('SIGTERM', function () { writeDb(); process.exit(0); });
process.on('SIGINT', function () { writeDb(); process.exit(0); });
