import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const scrypt = (p, salt) => new Promise((res, rej) => crypto.scrypt(p, salt, 64, (e, k) => e ? rej(e) : res(k.toString("hex"))));
const sha = t => crypto.createHash("sha256").update(t).digest("hex");
const num = v => (typeof v === "number" && isFinite(v) ? Math.max(0, Math.min(v, 1e300)) : 0);

export default async (req) => {
  if (req.method !== "POST") return J({ err: "method" }, 405);
  let b; try { b = await req.json(); } catch { return J({ err: "bad" }, 400); }
  const users = getStore("users"), lb = getStore("lb");
  const login = String(b.l || "").trim().toLowerCase();

  if (b.a === "lb") {
    const { blobs } = await lb.list();
    const rows = (await Promise.all(blobs.slice(0, 300).map(x => lb.get(x.key, { type: "json" })))).filter(Boolean);
    return J({ rows });
  }

  if (!/^[a-z0-9_]{3,16}$/.test(login)) return J({ err: "Логин: 3–16 символов, латиница, цифры или _" });

  if (b.a === "auth") {
    const pass = String(b.p || "");
    if (pass.length < 4 || pass.length > 64) return J({ err: "Пароль: 4–64 символа" });
    let u = await users.get(login, { type: "json" });
    const now = Date.now();
    if (u) {
      if (u.lockUntil && now < u.lockUntil) return J({ err: "Слишком много попыток. Подожди 10 минут" });
      const h = await scrypt(pass, u.salt);
      if (!crypto.timingSafeEqual(Buffer.from(h), Buffer.from(u.hash))) {
        u.fails = (u.fails || 0) + 1;
        if (u.fails >= 8) { u.lockUntil = now + 600000; u.fails = 0; }
        await users.setJSON(login, u);
        return J({ err: "Неверный пароль" });
      }
      u.fails = 0; u.lockUntil = 0;
    } else {
      const salt = crypto.randomBytes(16).toString("hex");
      u = { salt, hash: await scrypt(pass, salt), tokens: [], save: null, created: now };
    }
    const token = crypto.randomBytes(24).toString("hex");
    u.tokens = [...(u.tokens || []), sha(token)].slice(-5);
    await users.setJSON(login, u);
    return J({ login, token, save: u.save });
  }

  if (b.a === "save") {
    const u = await users.get(login, { type: "json" });
    if (!u || !u.tokens || !u.tokens.includes(sha(String(b.t || "")))) return J({ err: "auth" }, 401);
    const save = String(b.save || "");
    if (save.length > 1500000) return J({ err: "size" }, 413);
    u.save = save;
    await users.setJSON(login, u);
    const s = b.lb || {};
    await lb.setJSON(login, { name: login, uid: login, money: num(s.money), clicks: num(s.clicks), cases: num(s.cases), skins: num(s.skins), ach: num(s.ach), reb: num(s.reb), ts: Date.now() });
    return J({ ok: 1 });
  }
  if (b.a && String(b.a).startsWith("duel_")) {
    const u = await users.get(login, { type: "json" });
    if (!u || !u.tokens || !u.tokens.includes(sha(String(b.t || "")))) return J({ err: "auth" }, 401);
    const D = getStore("duels"), now = Date.now(), TTL = 600000;
    const rnd = () => ({ r1: crypto.randomInt(0, 1e9) / 1e9, r2: crypto.randomInt(0, 1e9) / 1e9 });
    const { blobs } = await D.list();
    const all = (await Promise.all(blobs.slice(0, 200).map(x => D.get(x.key, { type: "json" })))).filter(Boolean);
    const exp = d => d.st === "open" && now - d.t0 >= TTL;
    const mineOf = l => all.filter(d => (d.a === l || d.b === l) && !(d.done && d.done[l]));
    const pub = d => ({ id: d.id, st: exp(d) ? "expired" : d.st, n: d.n, price: d.price, a: d.a, b: d.b, ra: d.st === "ready" ? d.ra : null, rb: d.st === "ready" ? d.rb : null, t0: d.t0 });
    // cleanup finished / very old duels
    for (const d of all) if ((d.done && d.a && d.done[d.a] && (!d.b || d.done[d.b])) || now - d.t0 > 172800000) await D.delete(d.id);
    const busy = mineOf(login).some(d => d.st === "ready" || (d.st === "open" && !exp(d)));

    if (b.a === "duel_list") {
      return J({ open: all.filter(d => d.st === "open" && !exp(d) && d.a !== login).map(pub), mine: mineOf(login).map(pub) });
    }
    if (b.a === "duel_create") {
      const n = Math.floor(Number(b.n)), price = Number(b.price);
      if (busy) return J({ err: "У тебя уже есть активная дуэль" });
      if (!(n >= 1 && n <= 7) || !(price > 0) || !isFinite(price)) return J({ err: "Неверные данные" });
      const id = crypto.randomBytes(4).toString("hex");
      await D.setJSON(id, { id, st: "open", n, price, a: login, b: null, ra: rnd(), rb: null, t0: now, done: {} });
      return J({ id });
    }
    const d = await D.get(String(b.id || ""), { type: "json" });
    if (!d) return J({ err: "Дуэль не найдена" });
    if (b.a === "duel_join") {
      if (busy) return J({ err: "У тебя уже есть активная дуэль" });
      if (d.st !== "open" || exp(d) || d.a === login) return J({ err: "Дуэль недоступна" });
      d.st = "ready"; d.b = login; d.rb = rnd(); d.t1 = now;
      await D.setJSON(d.id, d);
      const chk = await D.get(d.id, { type: "json" });
      if (!chk || chk.b !== login) return J({ err: "Кто-то успел раньше" });
      return J({ price: d.price, n: d.n });
    }
    if (b.a === "duel_cancel") {
      if (d.a !== login || d.st !== "open") return J({ err: "Нельзя отменить" });
      d.st = "cancelled"; await D.setJSON(d.id, d); return J({ ok: 1 });
    }
    if (b.a === "duel_settle") {
      if (d.a !== login && d.b !== login) return J({ err: "Не твоя дуэль" });
      d.done = d.done || {};
      if (d.done[login]) return J({ err: "done" });
      let out;
      if (d.st === "ready") out = { kind: "play", n: d.n, ra: d.ra, rb: d.rb, a: d.a, b: d.b, price: d.price };
      else if (d.a === login && (d.st === "cancelled" || exp(d))) out = { kind: "refund", price: d.price };
      else return J({ err: "notyet" });
      d.done[login] = true; await D.setJSON(d.id, d);
      return J(out);
    }
  }

  return J({ err: "bad" }, 400);
};
