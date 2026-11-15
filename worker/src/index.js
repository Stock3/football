// Telegram-бот «Пʼятниця 5×5» на Cloudflare Workers: webhook (миттєві відповіді) + cron кожні 15 хв.
// Власного сховища немає: data.json, index.html (блок DEF) і tg.json читаються й пишуться в репозиторії
// через GitHub API: читання — Contents API, запис — Git Data API, усі змінені файли одним комітом (ghCommit). Логіка — у core.js і poll.js (опитування); тут лише мережа.
//
// Ендпоінти:
//   POST /tg      — webhook Telegram (перевірка X-Telegram-Bot-Api-Secret-Token)
//   POST /notify  — кнопки сайту {mode: thanks|remind|gather|cancel|sync|played|unlink, player?, game?}; Authorization: Bearer <GitHub-токен редактора>
//                   unlink — прибрати привʼязку чату гравця (tg.json), без повідомлення гравцю
//                   sync/played — сайт щойно зберіг data.json: звірити опитування, надіслати підсумок гри й подяки
//   GET  /setup?key=TG_SECRET — підключити webhook і меню команд
//   GET  /health  — «ok»
// Режим тесту (settings.testMode): усі повідомлення гравцям іде адміну (settings.org) з позначкою «👤 для Імʼя:», кнопки в них діють
//   від імені гравця (callback_data «дія|гра|гравець»), /as Імʼя … виконує команду від імені гравця; повідомлення від не-адміна ігноруються.
//   Усі відправки гравцям — лише через deliver()/routeEdit(): там єдине місце, де вирішується, куди йде повідомлення.
// Секрети: TG_TOKEN, GH_TOKEN, TG_SECRET. Змінні: GH_REPO, GH_BRANCH, SITE_ORIGIN (+ TG_API, GH_API, OM_API — лише для тестів).
import * as core from "./core.js";
import * as poll from "./poll.js";

const UA = "friday55-bot";
const DEF_TTL = 5 * 60e3;
let defCache = null; // {at, DEF} — index.html змінюється рідко, тримаємо 5 хв у памʼяті ізолята

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") return text("ok");
      if (url.pathname === "/tg" && request.method === "POST") return webhook(request, env, ctx);
      if (url.pathname === "/notify") return notify(request, env);
      if (url.pathname === "/setup" && request.method === "GET") return setup(url, env);
      return text("Not found", 404);
    } catch (e) {
      console.log("Помилка:", e.message);
      return text("Помилка", 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cron(env).catch((e) => console.log("cron:", e.message)));
  },
};

const text = (body, status = 200, headers = {}) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
const siteUrl = (env) => (env.SITE_ORIGIN || "").replace(/\/$/, "") + "/" + (env.GH_REPO || "/").split("/")[1] + "/";

// ---------- webhook ----------
async function webhook(request, env, ctx) {
  if (!env.TG_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TG_SECRET) return text("Forbidden", 403);
  let upd = null;
  try { upd = await request.json(); } catch {}
  // Telegram чекає швидкої відповіді; обробка — після неї
  if (upd && upd.message) ctx.waitUntil(onUpdate(env, upd).catch((e) => console.log("webhook:", e.message)));
  else if (upd && upd.callback_query) ctx.waitUntil(onCallback(env, upd.callback_query).catch((e) => console.log("webhook:", e.message)));
  return text("ok");
}
async function onUpdate(env, upd) {
  const st = await load(env);
  const C = ctx(env, st);
  if (core.testBlocked(C, upd.message.chat && upd.message.chat.id)) { console.log("режим тесту: ігнорую повідомлення не від адміна"); return; }
  const r = core.onMessage(C, upd.message);
  if (r.weather) return sendWeather(env, C, r.weather.chat, r.weather.date, r.weather.as);
  if (r.poll) return pollRun(env, r.poll);
  await run(env, st, C, r);
}
// Кнопки під повідомленнями опитування. На кожен callback треба відповісти (answerCallbackQuery), інакше крутиться годинник.
async function onCallback(env, q) {
  const msg = q.message || {};
  const ev = { t: "cb", id: q.id, chat: (msg.chat && msg.chat.id) ?? (q.from && q.from.id), msg: msg.message_id, data: q.data || "" };
  try { await pollRun(env, ev); }
  catch (e) {
    await tgCall(env, "answerCallbackQuery", { callback_query_id: q.id, text: "Щось пішло не так, спробуй ще раз 🙏" }).catch(() => {});
    throw e;
  }
}
async function sendWeather(env, C, chat, date, as) {
  let w = null;
  try {
    const res = await fetch(core.WX.url(C.S, env.OM_API));
    if (res.ok) w = await res.json(); else console.log("Open-Meteo:", res.status);
  } catch (e) { console.log("Open-Meteo:", e.message); }
  await deliver(env, C, { chat, text: core.weatherReply(C, w, date), ...(as ? { as } : {}) });
}

// ---------- режим тесту: куди насправді йде повідомлення ----------
// Звичайно — туди, куди просили. У режимі тесту — завжди в чат адміна: для гравця (pid) або «від імені гравця» (as)
// з позначкою «👤 для Імʼя:» (+ «немає бота», якщо в нього немає бота), кнопки несуть id гравця. Без адміна-з-ботом — нікуди.
const tagKb = (kb, pid) => kb && { inline_keyboard: kb.inline_keyboard.map((row) => row.map((b) => {
  const d = b.callback_data ? b.callback_data + "|" + pid : "";
  return d && new TextEncoder().encode(d).length <= 64 ? { ...b, callback_data: d } : b;
})) };
const forLabel = (C, pid) => "👤 для " + core.nameOf(C, pid) + (C.tg.chats[pid] ? "" : " (немає бота)") + ":\n";
function route(C, m) {
  if (!core.testOn(C)) return { chat: m.chat, text: m.text, kb: m.kb };
  const A = core.adminChat(C);
  if (A == null) return null;
  const pid = m.pid || m.as;
  if (m.admin || !pid || pid === C.S.org) return { chat: A, text: m.text, kb: m.kb }; // уже адміну: без змін
  return { chat: A, text: forLabel(C, pid) + m.text, kb: tagKb(m.kb, pid) };
}
async function deliver(env, C, m) {
  const d = route(C, m);
  if (!d) { console.log("режим тесту: адміна без бота немає — повідомлення не надіслано"); return false; }
  return tgSend(env, d.chat, d.text, d.kb);
}
// Редагування повідомлення: у режимі тесту — те саме, що в адмін-чаті (позначка й кнопки від імені гравця зберігаються)
function routeEdit(C, e) {
  if (!core.testOn(C)) return e;
  const A = core.adminChat(C);
  if (A == null || e.chat !== A) return null;
  if (!e.pid || e.pid === C.S.org) return e;
  return { ...e, text: forLabel(C, e.pid) + e.text, kb: tagKb(e.kb, e.pid) };
}

// ---------- опитування ----------
// Крок опитування як транзакція: прочитати data.json і tg.json → poll.step → записати обидва файли ОДНИМ комітом (ghCommit).
// Конфлікт (гілку змінив хтось інший після читання) — перечитати й порахувати заново (до 4 спроб; обробники ідемпотентні).
// Повідомлення — лише після коміту. Запрошення, що не дійшли (бот заблокований), — окремим кроком {t:"nobot"}:
// гравець тримає місце, організатору — 📵.
async function pollRun(env, ev) {
  let st, C, r;
  for (let attempt = 1; ; attempt++) {
    st = await load(env); C = ctx(env, st); r = poll.step(C, ev);
    if (!r.data && !r.tg) break;
    const files = {};
    if (r.data) files["data.json"] = r.data;
    if (r.tg) files["tg.json"] = r.tg;
    try {
      // крок порахований з обох файлів — тож на голові гілки обидва мають бути такими, як ми їх прочитали
      await ghCommit(env, files, { "data.json": st.dsha, "tg.json": st.sha }, pollMessage(r));
      break;
    } catch (e) {
      if (e.conflict && attempt < 4) { console.log(`опитування: конфлікт (${e.reason}), спроба ${attempt + 1}`); continue; }
      throw e;
    }
  }
  // Усе нижче — не критичне: збій одного кроку логуємо й не зупиняємо решту.
  const safe = async (name, fn) => { try { return await fn(); } catch (e) { console.log(name + ":", e.message); } };
  if (r.answer) {
    await safe("Telegram answerCallbackQuery", () => tgCall(env, "answerCallbackQuery", { callback_query_id: r.answer.id, ...(r.answer.text ? { text: r.answer.text } : {}) }));
  }
  for (const e0 of r.edits) {
    await safe("Telegram editMessageText", async () => {
      const e = routeEdit(C, e0);
      if (!e) return;
      try { await tgCall(env, "editMessageText", { chat_id: e.chat, message_id: e.msg, text: e.text, ...(e.kb ? { reply_markup: e.kb } : {}) }); }
      catch (err) { if (!/not modified/i.test(err.message)) throw err; }
    });
  }
  const sent = [], failed = [], nobot = [];
  for (const m of r.msgs) {
    const ok = (await safe("deliver", () => deliver(env, C, m))) === true;
    if (m.pid && !m.admin) (ok ? sent : failed).push(m.name);
    if (!ok && m.inv) nobot.push(m.inv);
  }
  if (r.weather) await safe("погода", () => sendWeather(env, C, r.weather.chat, r.weather.date, r.weather.as));
  if (nobot.length) await safe("nobot", () => pollRun(env, { t: "nobot", pids: nobot }));
  return { sent, failed };
}

// ---------- кнопки сайту ----------
function cors(request, env) {
  const o = request.headers.get("Origin");
  return o && o === env.SITE_ORIGIN ? { "Access-Control-Allow-Origin": o, "Vary": "Origin" } : { "Vary": "Origin" };
}
async function notify(request, env) {
  const h = cors(request, env);
  if (request.method === "OPTIONS") {
    if (!h["Access-Control-Allow-Origin"]) return text("Forbidden", 403, h);
    return new Response(null, { status: 204, headers: { ...h, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Max-Age": "86400" } });
  }
  if (request.method !== "POST") return text("Method not allowed", 405, h);
  // лише той, хто має право запису в репозиторій (тобто власник сайту)
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ ok: false, error: "Немає токена" }, 401, h);
  const rr = await fetch(`${ghApi(env)}/repos/${env.GH_REPO}`, { headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "User-Agent": UA } });
  if (rr.status === 401) return json({ ok: false, error: "Токен недійсний" }, 401, h);
  const repo = rr.ok ? await rr.json().catch(() => ({})) : {};
  if (!(repo.permissions && repo.permissions.push === true)) return json({ ok: false, error: "Немає права запису в репозиторій" }, 403, h);

  let b = {};
  try { b = await request.json(); } catch { return json({ ok: false, error: "Некоректний запит" }, 400, h); }
  const mode = b.mode, st = await load(env), C = ctx(env, st);
  let r;
  if (mode === "unlink") {
    // «Відвʼязати» в налаштуваннях сайту: прибрати привʼязку чату до гравця (гравцю нічого не пишемо)
    const pid = String(b.player || "");
    if (!pid) return json({ ok: false, error: "Не вказано гравця" }, 400, h);
    const had = !!C.tg.chats[pid];
    if (had) await saveTg(env, st, [{ op: "unlink", pid }], C.T.date);
    console.log(`/notify unlink: ${had ? "відвʼязано" : "привʼязки не було"}`);
    return json({ ok: true, unlinked: had }, 200, h);
  }
  if (mode === "thanks") r = core.thanks(C);
  else if (mode === "remind") r = core.reminders(C, { manual: true, player: String(b.player || "") });
  else if (mode === "gather" || mode === "cancel") r = core.announce(C, mode, String(b.game || ""));
  else if (mode === "sync" || mode === "played") {
    // спершу опитування (може змінити data.json), потім підсумок гри й подяки на свіжих даних
    const a = await pollRun(env, { t: "sync" });
    const st2 = await load(env), C2 = ctx(env, st2);
    const pg = core.postGame(C2, b.game ? String(b.game) : ""), th = core.thanks(C2);
    const res = await run(env, st2, C2, { msgs: [...pg.msgs, ...th.msgs], ops: [] });
    console.log(`/notify ${mode}: надіслано ${a.sent.length + res.sent.length}, помилок ${a.failed.length + res.failed.length}`);
    return json({ ok: true, sent: [...a.sent, ...res.sent], missing: [...pg.missing, ...a.failed, ...res.failed] }, 200, h);
  }
  else return json({ ok: false, error: "Невідомий режим" }, 400, h);
  if (r.error) return json({ ok: false, error: r.error }, 404, h);
  const res = await run(env, st, C, r);
  console.log(`/notify ${mode}: надіслано ${res.sent.length}, без бота ${(r.missing || []).length}, помилок ${res.failed.length}`);
  return json({ ok: true, sent: res.sent, missing: [...(r.missing || []), ...res.failed] }, 200, h);
}

// ---------- розклад ----------
async function cron(env) {
  // опитування: автозапуск, «скажу пізніше», нагадування тим, хто мовчить, закриття в час гри
  try { await pollRun(env, { t: "tick" }); } catch (e) { console.log("cron опитування:", e.message); }
  const st = await load(env), C = ctx(env, st);
  // подяки й підсумки гри — страховка, якщо сайт не достукався до /notify; нагадування — за розкладом з Налаштувань
  const a = core.thanks(C), p = core.postGame(C), b = core.reminders(C);
  await run(env, st, C, { msgs: [...a.msgs, ...p.msgs, ...b.msgs], ops: [...a.ops, ...b.ops] });
}

// ---------- налаштування webhook ----------
async function setup(url, env) {
  if (!env.TG_SECRET || url.searchParams.get("key") !== env.TG_SECRET) return text("Forbidden", 403);
  const lines = [];
  const step = async (name, method, body) => {
    try { await tgCall(env, method, body); lines.push(`${name}: OK`); } catch (e) { lines.push(`${name}: ПОМИЛКА — ${e.message}`); }
  };
  await step("setWebhook " + url.origin + "/tg", "setWebhook", { url: url.origin + "/tg", secret_token: env.TG_SECRET, allowed_updates: ["message", "callback_query"], drop_pending_updates: false });
  // /poll, /endpoll, /no — команди організатора, у меню їх немає
  await step("setMyCommands", "setMyCommands", { commands: [
    { command: "who", description: "Хто йде" },
    { command: "in", description: "Хочу грати" },
    { command: "out", description: "Не зможу" },
    { command: "status", description: "Мій борг за ігри" },
    { command: "weather", description: "Погода на пʼятницю" },
    { command: "stop", description: "Не писати мені" },
  ] });
  try {
    const i = await tgCall(env, "getWebhookInfo", {});
    lines.push(`getWebhookInfo: ${i.url || "(немає)"}, у черзі ${i.pending_update_count || 0}` + (i.last_error_message ? `, остання помилка: ${i.last_error_message}` : ""));
  } catch (e) { lines.push("getWebhookInfo: ПОМИЛКА — " + e.message); }
  // GitHub: чи бачить Worker репозиторій
  try { await ghRead(env, "data.json"); lines.push("GitHub data.json: OK"); } catch (e) { lines.push("GitHub data.json: ПОМИЛКА — " + e.message); }
  return text(lines.join("\n"));
}

// ---------- спільне: завантажити, надіслати, зберегти ----------
function ctx(env, st) { return core.context({ data: st.data, DEF: st.DEF, tg: st.tg, now: new Date(), site: siteUrl(env) }); }

async function load(env) {
  const [d, t, DEF] = await Promise.all([ghRead(env, "data.json"), ghRead(env, "tg.json"), loadDef(env)]);
  if (!d) throw new Error("data.json не знайдено");
  return { data: JSON.parse(d.text), dsha: d.sha, DEF, tg: t ? JSON.parse(t.text) : {}, sha: t ? t.sha : null };
}
async function loadDef(env) {
  if (defCache && Date.now() - defCache.at < DEF_TTL) return defCache.DEF;
  const f = await ghRead(env, "index.html");
  if (!f) throw new Error("index.html не знайдено");
  defCache = { at: Date.now(), DEF: core.parseDef(f.text) };
  return defCache.DEF;
}

// Надіслати повідомлення по черзі, зібрати операції стану для успішних і зберегти tg.json.
async function run(env, st, C, r) {
  const ops = [...(r.ops || [])], sent = [], failed = [];
  for (const m of r.msgs || []) {
    const ok = await deliver(env, C, m);
    if (m.pid) (ok ? sent : failed).push(m.name);
    if (ok) ops.push(...(m.ops || []));
  }
  if (ops.length) await saveTg(env, st, ops, C.T.date);
  return { sent, failed };
}

// Записати tg.json лише якщо стан змінився (тим самим ghCommit). Конфлікт (tg.json змінився між читанням і записом
// або гілку змінено під час запису): перечитати, застосувати ті самі операції до свіжого стану, до 3 спроб.
async function saveTg(env, st, ops, today) {
  let tg = st.tg, sha = st.sha;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const next = core.applyOps(tg, ops, st.data, today);
    if (core.sameState(next, tg) && !("offset" in (tg || {}))) return false;
    try { return await ghCommit(env, { "tg.json": next }, { "tg.json": sha }, "Бот: " + core.describeOps(ops, st.data)); }
    catch (e) {
      if (!e.conflict || attempt >= 3) throw e;
      console.log(`tg.json: конфлікт (${e.reason}), спроба ${attempt + 1}`);
      const f = await ghRead(env, "tg.json");
      tg = f ? JSON.parse(f.text) : {}; sha = f ? f.sha : null;
    }
  }
}

// Повідомлення коміту кроку опитування: примітка про склад, якщо змінився data.json, інакше — про опитування;
// якщо змінилися обидва й примітки різні — через «; ».
function pollMessage(r) {
  const notes = [];
  if (r.data) notes.push(r.dnote);
  if (r.tg && (!r.data || r.note !== r.dnote)) notes.push(r.note);
  return "Бот: " + notes.filter(Boolean).join("; ");
}

// ---------- GitHub ----------
const ghApi = (env) => env.GH_API || "https://api.github.com";
const ghHeaders = (env) => ({ Authorization: "Bearer " + env.GH_TOKEN, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": UA, "content-type": "application/json" });
async function gh(env, method, url, body, what) {
  const r = await fetch(url, { method, headers: ghHeaders(env), ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!r.ok) throw Object.assign(new Error(`GitHub ${what}: ${r.status}`), { status: r.status });
  return r.json();
}

// Записати кілька файлів у гілку одним комітом (Git Data API) — єдиний шлях запису бота.
//   files:  {шлях: обʼєкт} — що записати (JSON з відступом 1 і переносом рядка в кінці), лише змінені файли;
//   expect: {шлях: sha|null} — sha блобів, які ми прочитали (null — файла не було). Якщо на голові гілки інакше —
//           дані змінилися після читання: конфлікт, крок треба перерахувати.
// GET ref → коміт → дерево (перевірка expect) → POST tree (base_tree, вміст inline) → POST commit (parent — голова) →
// PATCH ref (force: false). Не fast-forward (хтось закомітив між GET ref і PATCH) — теж конфлікт.
// Помилка конфлікту має conflict: true. Повертає false, якщо вміст не змінився (коміт не створюється).
async function ghCommit(env, files, expect, message) {
  const base = `${ghApi(env)}/repos/${env.GH_REPO}/git`, branch = env.GH_BRANCH || "main";
  const conflict = (reason) => Object.assign(new Error(`GitHub запис ${Object.keys(files).join(" + ")}: конфлікт (${reason})`), { conflict: true, reason });
  const head = (await gh(env, "GET", `${base}/ref/heads/${branch}`, null, "читання гілки")).object.sha;
  const tree = (await gh(env, "GET", `${base}/commits/${head}`, null, "читання коміту")).tree.sha;
  if (expect && Object.keys(expect).length) {
    const t = await gh(env, "GET", `${base}/trees/${tree}`, null, "читання дерева");
    const cur = {};
    for (const e of t.tree || []) if (e.type === "blob") cur[e.path] = e.sha;
    for (const [p, sha] of Object.entries(expect)) if ((cur[p] || null) !== (sha || null)) throw conflict(p + " змінено");
  }
  const entries = Object.entries(files).map(([path, obj]) => ({ path, mode: "100644", type: "blob", content: JSON.stringify(obj, null, 1) + "\n" }));
  const nt = (await gh(env, "POST", `${base}/trees`, { base_tree: tree, tree: entries }, "запис дерева")).sha;
  if (nt === tree) return false;
  const c = (await gh(env, "POST", `${base}/commits`, { message, tree: nt, parents: [head] }, "запис коміту")).sha;
  try { await gh(env, "PATCH", `${base}/refs/heads/${branch}`, { sha: c, force: false }, "оновлення гілки"); }
  catch (e) { if (e.status === 409 || e.status === 422) throw conflict("гілку змінено"); throw e; }
  return true;
}

async function ghRead(env, file) {
  const r = await fetch(`${ghApi(env)}/repos/${env.GH_REPO}/contents/${file}?ref=${encodeURIComponent(env.GH_BRANCH || "main")}`, { headers: ghHeaders(env) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub читання ${file}: ${r.status}`);
  const j = await r.json();
  return { text: unb64(j.content || ""), sha: j.sha };
}
function unb64(s) { const bin = atob(s.replace(/\s/g, "")); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new TextDecoder().decode(u); }

// ---------- Telegram ----------
// Адреса містить токен, тому її ніколи не логуємо — лише метод і опис помилки.
async function tgCall(env, method, body) {
  if (!env.TG_TOKEN) throw new Error("немає секрету TG_TOKEN");
  const r = await fetch(`${env.TG_API || "https://api.telegram.org"}/bot${env.TG_TOKEN}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description || "HTTP " + r.status);
  return j.result;
}
async function tgSend(env, chat, textBody, kb) {
  try { await tgCall(env, "sendMessage", { chat_id: chat, text: textBody, disable_web_page_preview: true, ...(kb ? { reply_markup: kb } : {}) }); return true; }
  catch (e) { console.log("Telegram sendMessage:", e.message); return false; }
}
