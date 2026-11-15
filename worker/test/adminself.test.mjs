// Адмін (settings.org) натискає кнопки на власному запрошенні: помилок немає, звіт іде окремим повідомленням, збій редагування не ламає крок.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../src/core.js";
import worker from "../src/index.js";
import { initGit } from "./gh-mock.mjs";

Math.random = () => 0; // бот обирає випадковий варіант тексту — у тестах завжди перший
const dir = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(dir, "..", "..", "index.html"), "utf8");
const DEF = core.parseDef(HTML);
const THU = new Date("2026-11-12T09:00:00Z"); // четвер, 11:00 у Києві; гра — пʼятниця 13 листопада
const FRI_EVE = new Date("2026-11-13T17:00:00Z"); // пʼятниця, 19:00: до гри ще дві години
const SAT_NOON = new Date("2026-11-14T10:00:00Z"); // субота, 12:00
const GID = "g20261113";
const ADMIN = 101;

const NAMES = ["Аня", "Борис", "Вова", "Гліб", "Дана", "Еля", "Женя", "Зоя", "Іра", "Їжак", "Йосип", "Кіра", "Богдан"];
const chat = (pid) => 100 + +pid.slice(1);
const pidOf = (name) => "p" + (NAMES.indexOf(name) + 1);
function fixture(testMode = true) {
  return {
    v: 1,
    settings: { payFrom: "2026-11-01", org: "p1", card: "1234567812345678", testMode, remind: { on: true, mode: "after", after: 1, times: ["12:00"], quiet: { from: "22:00", to: "09:00" }, every: 1, max: 3 } },
    players: NAMES.map((n, i) => ({ id: "p" + (i + 1), name: n, active: i < 12 })),
    games: [],
  };
}
// у всіх є бот, окрім Дани (p5)
const allChats = () => Object.fromEntries(NAMES.map((n, i) => "p" + (i + 1)).filter((p) => p !== "p5").map((p) => [p, { id: chat(p), u: "" }]));

const SECRET = "s3cr3t", TGT = "123456:TG-TOKEN", GHT = "github_pat_WORKER";
const env = { TG_TOKEN: TGT, GH_TOKEN: GHT, TG_SECRET: SECRET, GH_REPO: "Stock3/football", GH_BRANCH: "main", SITE_ORIGIN: "https://stock3.github.io" };
function mockWorld({ data = fixture(), tg = { chats: allChats() } } = {}) {
  const w = { files: { "data.json": JSON.stringify(data), "index.html": HTML, "tg.json": JSON.stringify(tg) }, sent: [], tgCalls: [], mid: 500 };
  const gh = initGit(w);
  globalThis.fetch = async (url, opt = {}) => {
    url = String(url); const body = opt.body ? JSON.parse(opt.body) : null;
    const res = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://api.telegram.org/bot")) {
      const method = url.split("/").pop(); w.tgCalls.push({ method, body });
      if (method === "sendMessage") { w.sent.push(body); return res(200, { ok: true, result: { message_id: ++w.mid } }); }
      return res(200, { ok: true, result: true });
    }
    if (url.startsWith("https://api.open-meteo.com/")) return res(500, {});
    const r = gh(url, opt, body, res);
    if (r) return r;
    if (url === "https://api.github.com/repos/Stock3/football") return res(200, { permissions: { push: true } });
    throw new Error("Неочікуваний запит " + url);
  };
  return w;
}
const tgState = (w) => JSON.parse(w.files["tg.json"]);
const dataState = (w) => JSON.parse(w.files["data.json"]);
const setData = (w, f) => { const d = dataState(w); f(d); w.files["data.json"] = JSON.stringify(d); };
const game = (w) => dataState(w).games.find((g) => g.id === GID);
const quiet = async (fn) => { const orig = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = orig; } };
const clock = (t, d) => t.mock.timers.enable({ apis: ["Date"], now: d });

async function hook(body) {
  const waits = [];
  const r = await worker.fetch(new Request("https://bot.example/tg", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET }, body: JSON.stringify(body) }), env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  return r;
}
const msgOf = (text, from = ADMIN) => ({ text, chat: { id: from, type: "private" }, from: { username: "" } });
const say = (text, from = ADMIN) => quiet(() => hook({ message: msgOf(text, from) }));
let cbn = 0;
const press = (data, from = ADMIN, mid = 9) => quiet(() => hook({ callback_query: { id: "cb" + ++cbn, from: { id: from }, data, message: { message_id: mid, chat: { id: from, type: "private" } } } }));
const notify = (b) => quiet(async () => { const r = await worker.fetch(new Request("https://bot.example/notify", { method: "POST", headers: { Origin: env.SITE_ORIGIN, Authorization: "Bearer owner-token" }, body: JSON.stringify(b) }), env, { waitUntil() {} }); return r.json(); });
const cron = () => quiet(async () => { const waits = []; await worker.scheduled({}, env, { waitUntil: (p) => waits.push(p) }); await Promise.all(waits); });
// кнопка під перенаправленим повідомленням для гравця
const btns = (w, name) => (w.sent.filter((m) => m.text.startsWith("👤 для " + name) && m.reply_markup).at(-1) || { reply_markup: { inline_keyboard: [] } }).reply_markup.inline_keyboard.flat();
const btn = (w, name, label) => (btns(w, name).find((b) => b.text.includes(label)) || {}).callback_data;
const lastTo = (w, from = 0) => w.sent.slice(from).map((m) => m.text);
const mark = (w) => w.sent.length;

// ---------- адмін = гравець: кнопки на власному запрошенні (звичайний режим) ----------
const INVMID = 700; // id повідомлення із запрошенням адміна
async function startPoll(t, { fail } = {}) {
  clock(t, THU);
  const w = mockWorld({ data: fixture(false) });
  await say("/poll");
  return w;
}
const edits = (w) => w.tgCalls.filter((c) => c.method === "editMessageText").map((c) => c.body);
const answers = (w) => w.tgCalls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.body);
const toAdmin = (w, from = 0) => w.sent.slice(from).filter((m) => m.chat_id === ADMIN).map((m) => m.text);
const noError = (w) => assert.ok(!answers(w).some((a) => /не так/.test(a.text || "")), "без «щось пішло не так»");

test("адмін: «Буду» на власному запрошенні", async (t) => {
  const w = await startPoll(t);
  const b = mark(w);
  await press("y|" + GID, ADMIN, INVMID);
  noError(w);
  assert.ok(game(w).c.includes("p1"));
  const inv = tgState(w).poll.inv.p1;
  assert.equal(inv.ans, "yes"); assert.equal(inv.msg, INVMID);
  const e = edits(w).at(-1);
  assert.equal(e.chat_id, ADMIN); assert.equal(e.message_id, INVMID);
  assert.ok(/1\/10/.test(e.text), e.text);
  assert.ok(e.reply_markup.inline_keyboard.flat().some((x) => x.text.includes("Передумав")));
  const t2 = toAdmin(w, b);
  assert.ok(t2.some((x) => x.startsWith("✅ Аня — буде (1/10)")), "звіт адміну: " + JSON.stringify(t2));
});

test("адмін: «Не зможу» на власному запрошенні", async (t) => {
  const w = await startPoll(t);
  const b = mark(w);
  await press("n|" + GID, ADMIN, INVMID);
  noError(w);
  assert.equal(tgState(w).poll.inv.p1.ans, "no"); assert.equal(tgState(w).poll.inv.p1.msg, INVMID);
  assert.ok(edits(w).at(-1).reply_markup.inline_keyboard.flat().some((x) => x.text.includes("Передумав")));
  assert.ok(toAdmin(w, b).some((x) => x.startsWith("❌ Аня — не зможе")), JSON.stringify(toAdmin(w, b)));
});

test("адмін: «Буду» → «Передумав» (вихід) → «Повернутися в гру»", async (t) => {
  const w = await startPoll(t);
  await press("y|" + GID, ADMIN, INVMID);
  let b = mark(w);
  await press("c|" + GID, ADMIN, INVMID);
  noError(w);
  assert.ok(!game(w).c.includes("p1"));
  assert.ok(edits(w).at(-1).reply_markup.inline_keyboard.flat().some((x) => x.text.includes("Повернутися")));
  assert.ok(toAdmin(w, b).some((x) => x.startsWith("🚫 Аня скасував")), JSON.stringify(toAdmin(w, b)));
  b = mark(w);
  await press("r|" + GID, ADMIN, INVMID);
  noError(w);
  // місце вже віддали наступному з черги → Аня чекає місця (не день гри — у черзі за prio, не в queueFront)
  assert.ok(tgState(w).poll.inv.p1.req);
  assert.ok(!tgState(w).poll.queueFront.includes("p1"));
  assert.ok(toAdmin(w, b).some((x) => x.includes("Аня хоче грати — у черзі за пріоритетом")), JSON.stringify(toAdmin(w, b)));
});

test("адмін: «Скажу пізніше» → вибір часу", async (t) => {
  const w = await startPoll(t);
  const b = mark(w);
  await press("l|" + GID, ADMIN, INVMID);
  noError(w);
  const P = tgState(w).poll.inv.p1;
  assert.equal(P.ans, "later"); assert.equal(P.msg, INVMID, "msg зберігається й після «пізніше»");
  assert.ok(edits(w).at(-1).reply_markup.inline_keyboard.flat().some((x) => x.callback_data.startsWith("l30")));
  assert.ok(toAdmin(w, b).some((x) => x.startsWith("🕐 Аня")));
  await press("l30|" + GID, ADMIN, INVMID);
  noError(w);
  assert.ok(/30/.test(edits(w).at(-1).text) || edits(w).length >= 2);
});

test("збій editMessageText: відповідь збережена, звіт і відповідь гравцю надіслано, помилки немає", async (t) => {
  const w = await startPoll(t);
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opt) => {
    if (String(url).endsWith("/editMessageText")) return new Response(JSON.stringify({ ok: false, description: "Bad Request: message to edit not found" }), { status: 400 });
    return orig(url, opt);
  };
  const b = mark(w);
  await press("y|" + GID, ADMIN, INVMID);
  noError(w);
  assert.ok(game(w).c.includes("p1"));
  assert.equal(tgState(w).poll.inv.p1.ans, "yes");
  assert.equal(tgState(w).poll.inv.p1.msg, INVMID);
  const t2 = toAdmin(w, b);
  assert.ok(t2.some((x) => x.startsWith("✅ Аня — буде")), "звіт");
  assert.ok(t2.length >= 2, "і відповідь гравцю, і звіт");
});

test("збій коміту (data.json + tg.json одним комітом): нічого не записано, гравцю — «щось пішло не так», звіту немає", async (t) => {
  const w = await startPoll(t);
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opt = {}) => {
    if (opt.method === "PATCH" && String(url).includes("/git/refs/heads/")) return new Response(JSON.stringify({ message: "boom" }), { status: 500 });
    return orig(url, opt);
  };
  const before = { ...w.files }, b = mark(w);
  await press("y|" + GID, ADMIN, INVMID);
  assert.ok(answers(w).some((a) => /не так/.test(a.text || "")));
  assert.ok(!game(w).c.includes("p1"));
  assert.deepEqual(w.files, before, "жоден файл не змінено");
  assert.ok(!toAdmin(w, b).some((x) => x.startsWith("✅ Аня — буде")), "повідомлення — лише після коміту");
});
