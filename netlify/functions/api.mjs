// netlify/functions/api.mjs — серверная часть кликера (v4)
// Аккаунты, сохранения, лидерборд (+ онлайн), общий чат, дуэли.
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const VERSION = 4;
const ONLINE_MS = 70 * 1000;          // «в сети», если пинг был < 70 сек назад
const DUEL_TTL = 10 * 60 * 1000;      // открытая дуэль живёт 10 минут
const CHAT_TTL = 15 * 60 * 1000;      // сообщения чата живут 15 минут
const MAX_CASE_ID = 40;

const store = () => getStore({ name: "clicker", consistency: "strong" });

const json = (o) =>
  new Response(JSON.stringify(o), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const num = (x) => {
  x = Number(x);
  return Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0;
};
const rnd = () => crypto.randomInt(0, 1e9) / 1e9;
const rolls = (n) => Array.from({ length: n }, () => ({ r1: rnd(), r2: rnd() }));

// ---------- пароли ----------
const hashPass = (p, salt) => crypto.scryptSync(p, salt, 32).toString("hex");
const checkPass = (p, u) => {
  try {
    const a = Buffer.from(hashPass(p, u.salt), "hex");
    const b = Buffer.from(u.hash, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
};

// ---------- аккаунты ----------
async function doAuth(s, b) {
  const l = String(b.l || "").trim().toLowerCase();
  const p = String(b.p || "");
  if (!/^[a-z0-9_]{3,16}$/.test(l)) return { err: "Логин: 3–16 символов, латиница, цифры или _" };
  if (p.length < 4 || p.length > 100) return { err: "Пароль минимум 4 символа" };
  const u = await s.get("u:" + l, { type: "json" });
  if (!u) {
    const salt = crypto.randomBytes(16).toString("hex");
    const nu = {
      login: l,
      salt,
      hash: hashPass(p, salt),
      token: crypto.randomBytes(24).toString("hex"),
      created: Date.now(),
    };
    await s.setJSON("u:" + l, nu);
    return { login: l, token: nu.token };
  }
  if (!u.salt || !u.hash || !checkPass(p, u)) return { err: "Неверный пароль" };
  const save = await s.get("s:" + l);
  return { login: l, token: u.token, save: save || undefined };
}

async function authed(s, b) {
  const l = String(b.l || "").toLowerCase();
  if (!/^[a-z0-9_]{3,16}$/.test(l) || !b.t) return null;
  const u = await s.get("u:" + l, { type: "json" });
  if (!u || u.token !== b.t) return null;
  return l;
}

async function doSave(s, me, b) {
  const sv = typeof b.save === "string" ? b.save : null;
  if (!sv) return { err: "Нет данных" };
  if (sv.length > 1500000) return { err: "Сохранение слишком большое" };
  await s.set("s:" + me, sv);
  const lb = b.lb || {};
  await s.setJSON("l:" + me, {
    uid: me,
    name: me,
    money: num(lb.money),
    clicks: num(lb.clicks),
    cases: num(lb.cases),
    skins: num(lb.skins),
    ach: num(lb.ach),
    reb: num(lb.reb),
  });
  return { ok: true };
}

// ---------- лидерборд ----------
async function doLB(s) {
  const now = Date.now();
  const { blobs } = await s.list({ prefix: "l:" });
  const rows = await Promise.all(
    blobs.map(async (x) => {
      const login = x.key.slice(2);
      const [r, p] = await Promise.all([
        s.get(x.key, { type: "json" }),
        s.get("p:" + login, { type: "json" }),
      ]);
      if (!r) return null;
      return { ...r, on: !!p && !p.off && now - p.ts < ONLINE_MS };
    })
  );
  return { rows: rows.filter(Boolean) };
}

// ---------- онлайн ----------
async function doPing(s, me, b) {
  const now = Date.now();
  await s.setJSON("p:" + me, { ts: now, off: !!b.off });
  return { ok: true, now };
}

// ---------- чат ----------
const lastSend = new Map();
const chatKey = (ts) => "c:" + String(ts).padStart(13, "0") + ":" + crypto.randomBytes(3).toString("hex");
const keyTs = (k) => parseInt(k.slice(2, 15), 10) || 0;

async function chatPoll(s, b) {
  const since = Number(b.since) || 0;
  const { blobs } = await s.list({ prefix: "c:" });
  const fresh = blobs.filter((x) => keyTs(x.key) > since - 2000).slice(-60);
  const msgs = (await Promise.all(fresh.map((x) => s.get(x.key, { type: "json" }))))
    .filter(Boolean)
    .sort((a, c) => a.ts - c.ts);
  return { msgs, now: Date.now() };
}

async function chatSend(s, me, b) {
  const t = String(b.text || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!t) return { err: "Пустое сообщение" };
  const now = Date.now();
  if (now - (lastSend.get(me) || 0) < 700) return { err: "Не так быстро" };
  lastSend.set(me, now);
  await s.setJSON(chatKey(now), { ts: now, n: me, t });
  // чистим старое
  try {
    const { blobs } = await s.list({ prefix: "c:" });
    const old = blobs.filter((x) => now - keyTs(x.key) > CHAT_TTL).slice(0, 20);
    await Promise.all(old.map((x) => s.delete(x.key)));
  } catch {}
  return { ok: true };
}

// ---------- дуэли ----------
const dkey = (id) => "d:" + id;
const pub = (d, full) => ({
  id: d.id, a: d.a, b: d.b || null, cs: d.cs, price: d.price, st: d.st,
  ...(full ? { ra: d.ra, rb: d.rb } : {}),
});
const finished = (d) => d.sa && (d.b ? d.sb : true);
const busy = (d, me) =>
  (d.st === "open" && d.a === me && !d.sa) ||
  (d.st === "ready" && ((d.a === me && !d.sa) || (d.b === me && !d.sb)));

async function allDuels(s) {
  const { blobs } = await s.list({ prefix: "d:" });
  return (await Promise.all(blobs.map((x) => s.get(x.key, { type: "json" })))).filter(Boolean);
}

async function duelList(s, me) {
  const now = Date.now();
  const open = [];
  const mine = [];
  for (const d of await allDuels(s)) {
    if (d.st === "open" && now - d.ts > DUEL_TTL) {
      d.st = "expired";
      await s.setJSON(dkey(d.id), d);
    }
    if (finished(d) || now - d.ts > 7 * 24 * 3600 * 1000) {
      await s.delete(dkey(d.id));
      continue;
    }
    if (d.st === "open" && d.a !== me) open.push(pub(d));
    if ((d.a === me && !d.sa) || (d.b === me && !d.sb)) mine.push(pub(d, true));
  }
  open.sort((x, y) => x.price - y.price);
  return { open, mine };
}

async function duelCreate(s, me, b) {
  const cs = Array.isArray(b.cs) ? b.cs.map(Number) : [];
  if (cs.length < 1 || cs.length > 5 || cs.some((n) => !Number.isInteger(n) || n < 1 || n > MAX_CASE_ID))
    return { err: "Неверные данные" };
  const price = Number(b.price);
  if (!Number.isFinite(price) || price <= 0) return { err: "Неверные данные" };
  if ((await allDuels(s)).some((d) => busy(d, me))) return { err: "Сначала заверши текущую дуэль" };
  const d = {
    id: crypto.randomBytes(6).toString("hex"),
    a: me, b: null, cs, price, st: "open", ts: Date.now(),
    ra: rolls(cs.length), rb: rolls(cs.length), sa: false, sb: false,
  };
  await s.setJSON(dkey(d.id), d);
  return { ok: true, id: d.id };
}

async function duelJoin(s, me, b) {
  const id = String(b.id || "").replace(/[^a-f0-9]/g, "");
  const d = id && (await s.get(dkey(id), { type: "json" }));
  if (!d || d.st !== "open" || Date.now() - d.ts > DUEL_TTL) return { err: "Дуэль уже недоступна" };
  if (d.a === me) return { err: "Нельзя играть с собой" };
  if ((await allDuels(s)).some((x) => busy(x, me))) return { err: "Сначала заверши текущую дуэль" };
  d.b = me;
  d.st = "ready";
  await s.setJSON(dkey(id), d);
  const chk = await s.get(dkey(id), { type: "json" });
  if (!chk || chk.b !== me) return { err: "Дуэль уже занята" };
  return { ok: true };
}

async function duelCancel(s, me, b) {
  const id = String(b.id || "").replace(/[^a-f0-9]/g, "");
  const d = id && (await s.get(dkey(id), { type: "json" }));
  if (!d || d.a !== me) return { err: "Неверные данные" };
  if (d.st !== "open") return { err: "Соперник уже вступил" };
  d.st = "cancelled";
  await s.setJSON(dkey(id), d);
  return { ok: true };
}

async function duelSettle(s, me, b) {
  const id = String(b.id || "").replace(/[^a-f0-9]/g, "");
  const d = id && (await s.get(dkey(id), { type: "json" }));
  if (!d || (d.a !== me && d.b !== me)) return { err: "Неверные данные" };
  const isA = d.a === me;
  if (isA ? d.sa : d.sb) return { ok: true, kind: "done" };
  if (d.st === "cancelled" || d.st === "expired") {
    if (!isA) return { err: "Неверные данные" };
    d.sa = true;
    await s.setJSON(dkey(id), d);
    return { ok: true, kind: "refund", price: d.price };
  }
  if (d.st !== "ready") return { err: "Дуэль ещё не началась" };
  if (isA) d.sa = true; else d.sb = true;
  if (d.sa && d.sb) d.st = "done";
  await s.setJSON(dkey(id), d);
  return { ok: true, kind: "play" };
}

// ---------- роутер ----------
export default async (req) => {
  if (req.method !== "POST") return json({ err: "POST only" });
  let b;
  try {
    b = await req.json();
  } catch {
    return json({ err: "Неверный запрос" });
  }
  if (!b || typeof b !== "object") return json({ err: "Неверный запрос" });
  try {
    const s = store();
    switch (b.a) {
      case "ver": return json({ v: VERSION });
      case "lb": return json(await doLB(s));
      case "auth": return json(await doAuth(s, b));
    }
    const me = await authed(s, b);
    if (!me) return json({ err: "auth" });
    switch (b.a) {
      case "save": return json(await doSave(s, me, b));
      case "ping": return json(await doPing(s, me, b));
      case "chat_poll": return json(await chatPoll(s, b));
      case "chat_send": return json(await chatSend(s, me, b));
      case "duel_list": return json(await duelList(s, me));
      case "duel_create": return json(await duelCreate(s, me, b));
      case "duel_join": return json(await duelJoin(s, me, b));
      case "duel_cancel": return json(await duelCancel(s, me, b));
      case "duel_settle": return json(await duelSettle(s, me, b));
      default: return json({ err: "Неизвестное действие" });
    }
  } catch (e) {
    console.error(e);
    return json({ err: "Ошибка сервера" });
  }
};
