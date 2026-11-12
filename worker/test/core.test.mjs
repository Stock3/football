// Тести бота без мережі: node --test worker/test/
// core.js — чисті функції; index.js — з підміненим fetch (моки Telegram, GitHub API, Open-Meteo).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../src/core.js";
import worker from "../src/index.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(dir, "..", "..", "index.html"), "utf8");
const DEF = core.parseDef(HTML);
const NOW = new Date("2026-11-11T10:00:00Z"); // середа, 12:00 у Києві

function fixture() {
  return {
    v: 1,
    settings: { payFrom: "2026-11-01", card: "1234567812345678", remind: { on: true, mode: "after", after: 1, times: ["12:00"], quiet: { from: "", to: "" }, every: 2, max: 3 } },
    players: [
      { id: "p1", name: "Аня", active: true },
      { id: "p2", name: "Борис", active: true, tg: "bob" },
      { id: "p3", name: "Вова", active: true },
      { id: "p4", name: "Гліб", active: true },
      { id: "p5", name: "Дана", active: true },
    ],
    games: [
      { id: "g1", date: "2026-11-06", y: ["p1", "p2"], b: ["p3", "p4"], gy: 0, gb: 0, sy: 3, sb: 2, paid: ["p3"] },
      { id: "g2", date: "2026-11-13", c: ["p1", "p5"], y: ["p2"], b: [], gy: 1, gb: 0 },
    ],
  };
}
const chats = { p1: { id: 101, u: "anya" }, p2: { id: 102, u: "bob" }, p3: { id: 103, u: "" } };
const C0 = (o = {}) => core.context({ data: o.data || fixture(), DEF, tg: o.tg || { chats }, now: o.now || NOW, site: "https://stock3.github.io/football/", rand: () => 0 });
const pm = (text, chat = 900, username = "") => ({ text, chat: { id: chat, type: "private" }, from: { username } });

// ---------- core ----------
test("/start з параметром підключає гравця й вітає", () => {
  const r = core.onMessage(C0({ tg: {} }), pm("/start p1", 555, "anya"));
  assert.equal(r.ops.length, 1);
  assert.deepEqual({ ...r.ops[0], at: undefined }, { op: "link", pid: "p1", id: 555, u: "anya", at: undefined });
  assert.match(r.msgs[0].text, /Привіт, Аня!/);
});
test("/start без параметра — за username з профілю", () => {
  const r = core.onMessage(C0({ tg: {} }), pm("/start", 556, "BOB"));
  assert.equal(r.ops[0].pid, "p2");
});
test("/start: чужий username не може підключитися до профілю з іншим username", () => {
  const r = core.onMessage(C0({ tg: {} }), pm("/start p2", 557, "mallory"));
  assert.equal(r.ops.length, 0);
  assert.match(r.msgs[0].text, /Це посилання для гравця Борис/);
});
test("/start: невідомий гравець і невідомий username", () => {
  assert.match(core.onMessage(C0(), pm("/start p99")).msgs[0].text, /Не знайшов такого гравця/);
  assert.match(core.onMessage(C0(), pm("/start", 1, "nobody")).msgs[0].text, /Щоб я знав, хто ти/);
});
test("/status: борг підключеного, незнайомцю — підказка", () => {
  const t = core.onMessage(C0(), pm("/status", 101)).msgs[0].text;
  assert.match(t, /Аня, не оплачено за гру 6 листопада\. Разом 81 грн/);
  assert.match(t, /1234 5678 1234 5678/);
  assert.match(core.onMessage(C0(), pm("/status", 103)).msgs[0].text, /боргів немає/);
  assert.match(core.onMessage(C0(), pm("/status", 999)).msgs[0].text, /Я тебе ще не знаю/);
});
test("/stop відключає; невідома команда — підказка з /weather", () => {
  assert.deepEqual(core.onMessage(C0(), pm("/stop", 102)).ops, [{ op: "unlink", pid: "p2" }]);
  assert.match(core.onMessage(C0(), pm("/foo", 102)).msgs[0].text, /\/weather — погода на пʼятницю/);
});
test("/weather і «погода» — будь-кому; без даних — ввічлива відповідь", () => {
  assert.deepEqual(core.onMessage(C0(), pm("/weather@x_bot", 999)).weather, { chat: 999 });
  assert.deepEqual(core.onMessage(C0(), pm("Погода?", 998)).weather, { chat: 998 });
  assert.match(core.weatherReply(C0(), null), /недоступний/);
  assert.equal(core.nextFriday(core.kyiv(NOW)), "2026-11-13");
  assert.equal(core.nextFriday(core.kyiv(new Date("2026-11-13T20:00:00Z"))), "2026-11-13"); // пʼятниця → сьогодні
  assert.equal(core.nextFriday(core.kyiv(new Date("2026-11-14T08:00:00Z"))), "2026-11-20"); // субота → наступна
});
test("не приватні чати й повідомлення без тексту ігноруються", () => {
  assert.deepEqual(core.onMessage(C0(), { text: "/status", chat: { id: 1, type: "group" } }), { msgs: [], ops: [] });
  assert.deepEqual(core.onMessage(C0(), { chat: { id: 1, type: "private" } }), { msgs: [], ops: [] });
});
test("подяка після оплати — один раз", () => {
  const data = fixture(); data.games[0].paid = ["p1", "p3"];
  let C = C0({ data });
  const r = core.thanks(C);
  assert.deepEqual(r.msgs.map((m) => m.pid).sort(), ["p1", "p3"]);
  assert.deepEqual(r.msgs[0].ops.map((o) => o.op), ["thx"]);
  const tg = core.applyOps(C.tg, r.msgs.flatMap((m) => m.ops), data, C.T.date);
  assert.equal(core.thanks(C0({ data, tg })).msgs.length, 0);
});
test("нагадування за розкладом: не двічі за слот, повтор через every", () => {
  let C = C0();
  let r = core.reminders(C);
  assert.deepEqual(r.msgs.map((m) => m.pid).sort(), ["p1", "p2"]); // p3 оплатив, p4 без бота
  assert.deepEqual(r.ops, [{ op: "slots", keys: ["2026-11-11 12:00"] }]);
  let tg = core.applyOps(C.tg, [...r.ops, ...r.msgs.flatMap((m) => m.ops)], C.data, C.T.date);
  assert.equal(core.reminders(C0({ tg, now: new Date("2026-11-11T10:40:00Z") })).msgs.length, 0, "той самий слот");
  assert.equal(core.reminders(C0({ tg, now: new Date("2026-11-12T10:05:00Z") })).msgs.length, 0, "every=2");
  assert.equal(core.reminders(C0({ tg, now: new Date("2026-11-13T10:05:00Z") })).msgs.length, 2, "через 2 дні");
  assert.equal(core.reminders(C0({ now: new Date("2026-11-11T09:55:00Z") })).msgs.length, 0, "до 12:00");
});
test("нагадування вручну: одному або всім, missing — боржники без бота", () => {
  const r = core.reminders(C0({ now: new Date("2026-11-11T22:00:00Z") }), { manual: true });
  assert.deepEqual(r.msgs.map((m) => m.pid).sort(), ["p1", "p2"]);
  assert.deepEqual(r.missing, ["Гліб"]);
  assert.equal(r.msgs[0].ops[0].key, "2026-11-12 manual");
  const one = core.reminders(C0(), { manual: true, player: "p4" });
  assert.equal(one.msgs.length, 0); assert.deepEqual(one.missing, ["Гліб"]);
});
test("gather/cancel — лише гравцям цієї гри", () => {
  for (const kind of ["gather", "cancel"]) {
    const r = core.announce(C0(), kind, "g2");
    assert.deepEqual(r.msgs.map((m) => m.pid).sort(), ["p1", "p2"]); // p3 підключений, але не в грі
    assert.deepEqual(r.missing, ["Дана"]);
    assert.equal(r.msgs[0].text, core.fill(DEF[kind][0], { name: "Аня", date: "13 листопада", day: "пʼятниця", time: "21:00", place: "штучне поле Буковини", count: 4, list: "Аня, Дана, Борис + 1 гість", site: "https://stock3.github.io/football/" }));
  }
  assert.equal(core.announce(C0(), "gather", "nope").error, "Гру не знайдено");
});
test("applyOps: один чат — один гравець, прибирання зниклих ігор і старих слотів", () => {
  const s = core.applyOps({ chats: { p1: { id: 7 } }, sent: { gone: { p1: { r: ["x"] } }, g1: { p2: { r: [] } } }, slots: ["2026-10-01 12:00", "2026-11-10 12:00"], offset: 5 },
    [{ op: "link", pid: "p2", id: 7, u: "", at: "t" }], fixture(), "2026-11-11");
  assert.deepEqual(Object.keys(s.chats), ["p2"]);
  assert.deepEqual(s.sent, {});
  assert.deepEqual(s.slots, ["2026-11-10 12:00"]);
  assert.ok(!("offset" in s));
});
test("старі налаштування без нових полів працюють (DEF)", () => {
  const data = fixture(); data.settings = { payFrom: "2026-11-01", remind: { on: true, after: 1, every: 2, max: 3, hour: 12 } };
  const C = C0({ data });
  assert.deepEqual(C.S.remind.times, ["12:00"]);
  assert.equal(C.S.time, "21:00");
  assert.equal(core.reminders(C).msgs.length, 2);
});
test("worker/src/wx.js збігається з блоком /*WX*/ в index.html (інакше: node worker/sync-wx.mjs)", () => {
  const wx = fs.readFileSync(path.join(dir, "..", "src", "wx.js"), "utf8");
  assert.equal(wx.match(/\/\*WX\*\/[\s\S]*?\/\*\/WX\*\//)[0], HTML.match(/\/\*WX\*\/[\s\S]*?\/\*\/WX\*\//)[0]);
});

// ---------- index.js з моками ----------
const SECRET = "s3cr3t-webhook", TGT = "123456:TG-TOKEN-XYZ", GHT = "github_pat_WORKER_TOKEN";
const env = { TG_TOKEN: TGT, GH_TOKEN: GHT, TG_SECRET: SECRET, GH_REPO: "Stock3/football", GH_BRANCH: "main", SITE_ORIGIN: "https://stock3.github.io" };
function mockWorld({ data = fixture(), tg = { chats }, conflicts = 0, onConflict } = {}) {
  // sha — версія tg.json, dsha — data.json; conflicts — скільки наступних записів відповісти 409
  const w = { files: { "data.json": JSON.stringify(data), "index.html": HTML, "tg.json": JSON.stringify(tg) }, sha: 1, dsha: 1, sent: [], puts: [], tgCalls: [], conflicts, logs: [], om: 0, mid: 500 };
  const enc = (s) => Buffer.from(s, "utf8").toString("base64").replace(/(.{60})/g, "$1\n");
  globalThis.fetch = async (url, opt = {}) => {
    url = String(url); const body = opt.body ? JSON.parse(opt.body) : null; const hdr = opt.headers || {};
    const res = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://api.telegram.org/bot")) {
      assert.ok(url.includes(TGT));
      const method = url.split("/").pop(); w.tgCalls.push({ method, body });
      if (method === "sendMessage") {
        if (w.blocked && w.blocked.includes(body.chat_id)) return res(403, { ok: false, description: "Forbidden: bot was blocked by the user" });
        w.sent.push(body); return res(200, { ok: true, result: { message_id: ++w.mid } });
      }
      if (method === "getWebhookInfo") return res(200, { ok: true, result: { url: "https://bot.example/tg", pending_update_count: 0 } });
      return res(200, { ok: true, result: true });
    }
    if (url.startsWith("https://api.open-meteo.com/")) { w.om++; return res(500, {}); }
    const cm = url.match(/^https:\/\/api\.github\.com\/repos\/Stock3\/football\/contents\/([^?]+)/);
    if (cm) {
      assert.equal(hdr.Authorization, "Bearer " + GHT);
      assert.ok(hdr["User-Agent"]);
      const f = cm[1];
      const cur = () => (f === "tg.json" ? "sha" + w.sha : f === "data.json" ? "d" + w.dsha : "x");
      const bump = () => { if (f === "tg.json") w.sha++; else if (f === "data.json") w.dsha++; };
      if (!opt.method || opt.method === "GET") return f in w.files ? res(200, { content: enc(w.files[f]), sha: cur() }) : res(404, {});
      w.puts.push({ f, body });
      if (body.sha !== cur() || w.conflicts > 0) {
        if (w.conflicts > 0) { w.conflicts--; if (onConflict) onConflict(w, f); bump(); }
        return res(409, { message: "conflict" });
      }
      w.files[f] = Buffer.from(body.content, "base64").toString("utf8"); bump();
      return res(200, { content: { sha: cur() } });
    }
    if (url === "https://api.github.com/repos/Stock3/football") {
      const t = hdr.Authorization;
      if (t === "Bearer owner-token") return res(200, { permissions: { push: true } });
      if (t === "Bearer reader-token") return res(200, { permissions: { push: false, pull: true } });
      return res(401, { message: "Bad credentials" });
    }
    throw new Error("Неочікуваний запит " + url);
  };
  return w;
}
const ctxMock = () => { const p = []; return { waitUntil: (x) => p.push(x), done: () => Promise.all(p) }; };
const req = (url, opt = {}) => new Request("https://bot.shtuchka.workers.dev" + url, opt);
const tgState = (w) => JSON.parse(w.files["tg.json"]);
async function quiet(fn) { const logs = [], orig = console.log; console.log = (...a) => logs.push(a.join(" ")); try { await fn(); } finally { console.log = orig; } return logs; }

test("webhook: невалідний секрет → 403, без обробки", async () => {
  const w = mockWorld(), c = ctxMock();
  const r = await worker.fetch(req("/tg", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "wrong" }, body: JSON.stringify({ message: pm("/status", 101) }) }), env, c);
  assert.equal(r.status, 403); await c.done(); assert.equal(w.sent.length, 0);
  const r2 = await worker.fetch(req("/tg", { method: "POST", body: "{}" }), env, c);
  assert.equal(r2.status, 403);
});
test("webhook: /start одразу 200, далі підключення й запис tg.json", async () => {
  const w = mockWorld({ tg: {} }), c = ctxMock();
  const r = await worker.fetch(req("/tg", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET }, body: JSON.stringify({ update_id: 1, message: pm("/start p5", 505, "dana") }) }), env, c);
  assert.equal(r.status, 200);
  await c.done();
  assert.match(w.sent[0].text, /Привіт, Дана/);
  assert.equal(tgState(w).chats.p5.id, 505);
  assert.equal(w.puts[0].body.message, "Бот: підключено Дана");
  assert.equal(w.puts[0].body.branch, "main");
});
test("webhook: /status не пише tg.json; /weather при помилці Open-Meteo відповідає", async () => {
  const w = mockWorld(), c = ctxMock();
  const h = { "X-Telegram-Bot-Api-Secret-Token": SECRET };
  await worker.fetch(req("/tg", { method: "POST", headers: h, body: JSON.stringify({ message: pm("/status", 102) }) }), env, c);
  await worker.fetch(req("/tg", { method: "POST", headers: h, body: JSON.stringify({ message: pm("/weather", 9999) }) }), env, c);
  await quiet(() => c.done());
  assert.equal(w.puts.length, 0);
  assert.match(w.sent.find((m) => m.chat_id === 102).text, /Борис, не оплачено/);
  assert.match(w.sent.find((m) => m.chat_id === 9999).text, /недоступний/);
  assert.equal(w.om, 1);
});
test("tg.json: 409 → перечитати, застосувати знову (зберігаються обидві зміни)", async () => {
  const w = mockWorld({ tg: { chats: {} }, conflicts: 1, onConflict: (w) => { w.files["tg.json"] = JSON.stringify({ chats: { p3: { id: 103 } }, sent: {}, slots: [] }); } }), c = ctxMock();
  const logs = await quiet(async () => {
    await worker.fetch(req("/tg", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET }, body: JSON.stringify({ message: pm("/start p1", 101, "anya") }) }), env, c);
    await c.done();
  });
  assert.equal(w.puts.length, 2);
  assert.deepEqual(Object.keys(tgState(w).chats).sort(), ["p1", "p3"]);
  assert.ok(logs.some((l) => /конфлікт \(409\)/.test(l)));
});
test("tg.json: три конфлікти поспіль — помилка в лог, без зациклення", async () => {
  const w = mockWorld({ tg: { chats: {} }, conflicts: 5 }), c = ctxMock();
  const logs = await quiet(async () => {
    await worker.fetch(req("/tg", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET }, body: JSON.stringify({ message: pm("/start p1", 101, "anya") }) }), env, c);
    await c.done();
  });
  assert.equal(w.puts.length, 3);
  assert.ok(logs.some((l) => /webhook: GitHub запис tg\.json: 409/.test(l)), logs.join("\n"));
});
test("/notify: без токена 401, без права запису 403, CORS", async () => {
  mockWorld();
  const o = { Origin: "https://stock3.github.io", "content-type": "application/json" };
  let r = await worker.fetch(req("/notify", { method: "POST", headers: o, body: '{"mode":"thanks"}' }), env, ctxMock());
  assert.equal(r.status, 401);
  r = await worker.fetch(req("/notify", { method: "POST", headers: { ...o, Authorization: "Bearer reader-token" }, body: '{"mode":"thanks"}' }), env, ctxMock());
  assert.equal(r.status, 403);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "https://stock3.github.io");
  r = await worker.fetch(req("/notify", { method: "POST", headers: { ...o, Authorization: "Bearer garbage" }, body: '{"mode":"thanks"}' }), env, ctxMock());
  assert.equal(r.status, 401);
  r = await worker.fetch(req("/notify", { method: "OPTIONS", headers: { Origin: "https://stock3.github.io" } }), env, ctxMock());
  assert.equal(r.status, 204);
  assert.match(r.headers.get("Access-Control-Allow-Headers"), /Authorization/);
  r = await worker.fetch(req("/notify", { method: "OPTIONS", headers: { Origin: "https://evil.example" } }), env, ctxMock());
  assert.equal(r.status, 403);
});
test("/notify thanks / remind / gather / cancel", async () => {
  const data = fixture(); data.games[0].paid = ["p1", "p3"];
  const w = mockWorld({ data });
  const call = async (b) => { const r = await worker.fetch(req("/notify", { method: "POST", headers: { Origin: "https://stock3.github.io", Authorization: "Bearer owner-token" }, body: JSON.stringify(b) }), env, ctxMock()); return { status: r.status, j: await r.json() }; };
  await quiet(async () => {
    let r = await call({ mode: "thanks" });
    assert.deepEqual(r.j.sent.sort(), ["Аня", "Вова"]);
    assert.equal(tgState(w).sent.g1.p1.thx > "", true);
    r = await call({ mode: "thanks" });
    assert.deepEqual(r.j.sent, [], "повторно не дякує");
    r = await call({ mode: "remind", player: "" });
    assert.deepEqual(r.j, { ok: true, sent: ["Борис"], missing: ["Гліб"] });
    r = await call({ mode: "gather", game: "g2" });
    assert.deepEqual(r.j, { ok: true, sent: ["Аня", "Борис"], missing: ["Дана"] });
    r = await call({ mode: "cancel", game: "g2" });
    assert.deepEqual(r.j.sent, ["Аня", "Борис"]);
    r = await call({ mode: "gather", game: "nope" });
    assert.equal(r.status, 404);
    r = await call({ mode: "bad" });
    assert.equal(r.status, 400);
  });
});
test("cron: нагадування за розкладом один раз за слот", async () => {
  const data = fixture(); data.settings.remind.times = ["00:00"];
  // підсумок гри g1 уже надіслано — тут перевіряємо лише нагадування й подяки
  const w = mockWorld({ data, tg: { chats, sent: { g1: { p1: { pg: "t", r: [] }, p2: { pg: "t", r: [] } } } } });
  for (let i = 0; i < 2; i++) { const c = ctxMock(); await quiet(async () => { await worker.scheduled({}, env, c); await c.done(); }); }
  // нагадування Ані й Борису + подяка-страховка Вові (оплату позначено, подяки ще не було); другий запуск — нічого
  assert.deepEqual(w.sent.map((m) => m.chat_id).sort(), [101, 102, 103]);
  assert.match(w.sent.find((m) => m.chat_id === 103).text, /Вова/);
  assert.equal(w.puts.length, 1);
  assert.equal(w.puts[0].body.message, "Бот: подяки; нагадування");
});
test("/setup: ключ, webhook з секретом, команди; /health", async () => {
  const w = mockWorld();
  assert.equal((await worker.fetch(req("/setup?key=nope"), env, ctxMock())).status, 403);
  const r = await worker.fetch(req("/setup?key=" + SECRET), env, ctxMock());
  const t = await r.text();
  assert.match(t, /setWebhook https:\/\/bot\.shtuchka\.workers\.dev\/tg: OK/);
  assert.match(t, /setMyCommands: OK/);
  assert.match(t, /GitHub data\.json: OK/);
  const sw = w.tgCalls.find((x) => x.method === "setWebhook").body;
  assert.deepEqual(sw, { url: "https://bot.shtuchka.workers.dev/tg", secret_token: SECRET, allowed_updates: ["message", "callback_query"], drop_pending_updates: false });
  // /poll і /endpoll — лише для організатора, у публічному меню їх немає
  assert.deepEqual(w.tgCalls.find((x) => x.method === "setMyCommands").body.commands.map((c) => c.command), ["who", "out", "status", "weather", "stop"]);
  const h = await worker.fetch(req("/health"), env, ctxMock());
  assert.equal(await h.text(), "ok");
  assert.equal((await worker.fetch(req("/nope"), env, ctxMock())).status, 404);
});
test("токени ніколи не потрапляють у лог", async () => {
  mockWorld({ tg: { chats: {} }, conflicts: 5 });
  globalThis.fetch = ((f) => async (url, opt) => { if (String(url).includes("sendMessage")) return new Response(JSON.stringify({ ok: false, description: "Forbidden: bot was blocked by the user" }), { status: 403 }); return f(url, opt); })(globalThis.fetch);
  const c = ctxMock();
  const logs = await quiet(async () => {
    await worker.fetch(req("/tg", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET }, body: JSON.stringify({ message: pm("/start p1", 101, "anya") }) }), env, c);
    await worker.fetch(req("/setup?key=" + SECRET), env, c);
    await c.done();
  });
  const all = logs.join("\n");
  assert.ok(all.length > 0);
  for (const s of [TGT, GHT, SECRET, "owner-token"]) assert.ok(!all.includes(s), "у лозі є секрет");
  assert.match(all, /Telegram sendMessage: Forbidden: bot was blocked by the user/);
});

// ---------- опитування через index.js ----------
// p1 — організатор (чат 101); гра ще не створена — /poll створить її в data.json
function pollWorld(o = {}) {
  const data = fixture();
  data.settings.org = "p1";
  data.games = [data.games[0]];
  return mockWorld({ data, tg: { chats }, ...o });
}
const hook = (body) => worker.fetch(req("/tg", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET }, body: JSON.stringify(body) }), env, ctxMockRun);
let ctxMockRun;
async function tgUpdate(body) { ctxMockRun = ctxMock(); const r = await hook(body); await ctxMockRun.done(); return r; }
const dataState = (w) => JSON.parse(w.files["data.json"]);

test("webhook: /poll → гра в data.json, запрошення з кнопками, стан у tg.json; кнопка «Буду» → c, редагування, answerCallbackQuery", async () => {
  const w = pollWorld();
  await quiet(async () => {
    await tgUpdate({ message: pm("/poll", 101) });
    const g = dataState(w).games.find((x) => x.id === "g20261113");
    assert.ok(g, "гру створено");
    assert.ok(w.puts.some((p) => p.f === "data.json" && /Бот: нова гра 2026-11-13/.test(p.body.message)));
    const poll = tgState(w).poll;
    assert.equal(poll.game, "g20261113");
    // 5 активних: p1, p2, p3 мають бота; p4, p5 — без бота (організатору 📵)
    const inv = w.sent.filter((m) => m.reply_markup);
    assert.deepEqual(inv.map((m) => m.chat_id).sort(), [101, 102, 103]);
    assert.match(w.sent.find((m) => m.chat_id === 101 && !m.reply_markup).text, /📵 Гліб без бота/);
    w.sent.length = 0; w.tgCalls.length = 0;
    await tgUpdate({ callback_query: { id: "cb1", from: { id: 102 }, data: "y|g20261113", message: { message_id: 9, chat: { id: 102, type: "private" } } } });
  });
  assert.deepEqual(dataState(w).games.find((x) => x.id === "g20261113").c, ["p2"]);
  assert.equal(tgState(w).poll.inv.p2.ans, "yes");
  const ans = w.tgCalls.find((x) => x.method === "answerCallbackQuery");
  assert.equal(ans.body.callback_query_id, "cb1");
  const ed = w.tgCalls.find((x) => x.method === "editMessageText");
  assert.equal(ed.body.message_id, 9);
  assert.equal(ed.body.text, "Ти в грі ✅ (1/10)");
  assert.match(w.sent.find((m) => m.chat_id === 101).text, /✅ Борис — буде \(1\/10\)/);
});
test("webhook: 409 на data.json → перечитати й перерахувати; гравець не дублюється", async () => {
  const w = pollWorld();
  await quiet(() => tgUpdate({ message: pm("/poll", 101) }));
  // поки бот рахував, сайт зберіг data.json (додав Аню вручну)
  w.conflicts = 1;
  let onc = (w2, f) => { const d = JSON.parse(w2.files["data.json"]); d.games.find((x) => x.id === "g20261113").y = ["p1"]; w2.files["data.json"] = JSON.stringify(d); };
  globalThis.fetch = ((f) => async (url, opt) => { if (opt && opt.method === "PUT" && w.conflicts > 0) { onc(w, "data.json"); } return f(url, opt); })(globalThis.fetch);
  const logs = await quiet(() => tgUpdate({ callback_query: { id: "cb2", data: "y|g20261113", message: { message_id: 3, chat: { id: 102 } } } }));
  const g = dataState(w).games.find((x) => x.id === "g20261113");
  assert.deepEqual(g.c, ["p2"]); assert.deepEqual(g.y, ["p1"]);
  assert.ok(logs.some((l) => /опитування: конфлікт \(409\)/.test(l)));
  assert.equal(w.tgCalls.filter((x) => x.method === "answerCallbackQuery").length, 1);
});
test("webhook: запрошення не дійшло (бот заблокований) → 📵 організатору, місце тримається", async () => {
  const w = pollWorld(); w.blocked = [103];
  await quiet(() => tgUpdate({ message: pm("/poll", 101) }));
  assert.equal(tgState(w).poll.inv.p3.nobot, true);
  assert.ok(w.sent.some((m) => m.chat_id === 101 && /📵 Вова без бота/.test(m.text)));
});
test("webhook: /out → причина → вихід зі складу; /who; не організатор — /poll заборонено", async () => {
  const w = pollWorld();
  await quiet(async () => {
    await tgUpdate({ message: pm("/poll", 101) });
    await tgUpdate({ callback_query: { id: "c", data: "y|g20261113", message: { message_id: 3, chat: { id: 102 } } } });
    w.sent.length = 0;
    await tgUpdate({ message: pm("/poll", 102) });
    assert.equal(w.sent.at(-1).text, "Ця команда лише для організатора");
    await tgUpdate({ message: pm("/who", 103) });
    assert.match(w.sent.at(-1).text, /✅ Буде \(1\): Борис/);
    await tgUpdate({ message: pm("/out", 102) });
    assert.match(w.sent.at(-1).text, /Напиши причину/);
    await tgUpdate({ message: pm("температура", 102) });
  });
  assert.deepEqual(dataState(w).games.find((x) => x.id === "g20261113").c, []);
  assert.ok(w.sent.some((m) => m.chat_id === 101 && /🚫 Борис скасував: температура/.test(m.text)));
});
test("/notify sync: рахунок внесено → підсумок гри з оплатою (один раз), опитування закривається", async () => {
  const data = fixture(); data.settings.org = "p1";
  data.games[0].paid = ["p3"];
  const w = mockWorld({ data, tg: { chats, poll: { game: "g1", open: true, startedAt: "x", announced: null, short: false, queueFront: [], inv: {} } } });
  const call = async (b) => { const r = await worker.fetch(req("/notify", { method: "POST", headers: { Origin: "https://stock3.github.io", Authorization: "Bearer owner-token" }, body: JSON.stringify(b) }), env, ctxMock()); return r.json(); };
  let j;
  await quiet(async () => { j = await call({ mode: "sync", game: "g1" }); });
  // g1 зіграна 3:2: жовті Аня (p1, організатор) і Борис — перемога; Вова оплатив — йому лише подяка; Гліб без бота
  assert.deepEqual(j.sent.sort(), ["Аня", "Борис", "Вова"]);
  assert.match(w.sent.find((m) => m.chat_id === 103).text, /Вова/);  assert.deepEqual(j.missing, ["Гліб"]);
  assert.match(w.sent.find((m) => m.chat_id === 102).text, /^🏆 Борис, класна гра — перемога 3:2!/);
  assert.equal(tgState(w).poll.open, false);
  assert.ok(tgState(w).sent.g1.p2.pg);
  await quiet(async () => { j = await call({ mode: "played", game: "g1" }); });
  assert.deepEqual(j.sent, [], "вдруге не надсилає");
});
