// Telegram-бот «Пʼятниця 5×5» на Cloudflare Workers: webhook (миттєві відповіді) + cron кожні 15 хв.
// Власного сховища немає: data.json, index.html (блок DEF) і tg.json читаються й пишуться в репозиторії
// через GitHub Contents API. Логіка — у core.js; тут лише мережа.
//
// Ендпоінти:
//   POST /tg      — webhook Telegram (перевірка X-Telegram-Bot-Api-Secret-Token)
//   POST /notify  — кнопки сайту {mode: thanks|remind|gather|cancel, player?, game?}; Authorization: Bearer <GitHub-токен редактора>
//   GET  /setup?key=TG_SECRET — підключити webhook і меню команд
//   GET  /health  — «ok»
// Секрети: TG_TOKEN, GH_TOKEN, TG_SECRET. Змінні: GH_REPO, GH_BRANCH, SITE_ORIGIN (+ TG_API, GH_API, OM_API — лише для тестів).
import * as core from "./core.js";

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
  return text("ok");
}
async function onUpdate(env, upd) {
  const st = await load(env);
  const C = ctx(env, st);
  const r = core.onMessage(C, upd.message);
  if (r.weather) {
    let w = null;
    try {
      const res = await fetch(core.WX.url(C.S, env.OM_API));
      if (res.ok) w = await res.json(); else console.log("Open-Meteo:", res.status);
    } catch (e) { console.log("Open-Meteo:", e.message); }
    await tgSend(env, r.weather.chat, core.weatherReply(C, w));
    return;
  }
  await run(env, st, C, r);
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
  if (mode === "thanks") r = core.thanks(C);
  else if (mode === "remind") r = core.reminders(C, { manual: true, player: String(b.player || "") });
  else if (mode === "gather" || mode === "cancel") r = core.announce(C, mode, String(b.game || ""));
  else return json({ ok: false, error: "Невідомий режим" }, 400, h);
  if (r.error) return json({ ok: false, error: r.error }, 404, h);
  const res = await run(env, st, C, r);
  console.log(`/notify ${mode}: надіслано ${res.sent.length}, без бота ${(r.missing || []).length}, помилок ${res.failed.length}`);
  return json({ ok: true, sent: res.sent, missing: [...(r.missing || []), ...res.failed] }, 200, h);
}

// ---------- розклад ----------
async function cron(env) {
  const st = await load(env), C = ctx(env, st);
  // подяки — страховка, якщо сайт не достукався до /notify; нагадування — за розкладом з Налаштувань
  const a = core.thanks(C), b = core.reminders(C);
  await run(env, st, C, { msgs: [...a.msgs, ...b.msgs], ops: [...a.ops, ...b.ops] });
}

// ---------- налаштування webhook ----------
async function setup(url, env) {
  if (!env.TG_SECRET || url.searchParams.get("key") !== env.TG_SECRET) return text("Forbidden", 403);
  const lines = [];
  const step = async (name, method, body) => {
    try { await tgCall(env, method, body); lines.push(`${name}: OK`); } catch (e) { lines.push(`${name}: ПОМИЛКА — ${e.message}`); }
  };
  await step("setWebhook " + url.origin + "/tg", "setWebhook", { url: url.origin + "/tg", secret_token: env.TG_SECRET, allowed_updates: ["message"], drop_pending_updates: false });
  await step("setMyCommands", "setMyCommands", { commands: [
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
  return { data: JSON.parse(d.text), DEF, tg: t ? JSON.parse(t.text) : {}, sha: t ? t.sha : null };
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
    const ok = await tgSend(env, m.chat, m.text);
    if (m.pid) (ok ? sent : failed).push(m.name);
    if (ok) ops.push(...(m.ops || []));
  }
  if (ops.length) await saveTg(env, st, ops, C.T.date);
  return { sent, failed };
}

// Записати tg.json лише якщо стан змінився. Конфлікт (409/422 — файл змінився між читанням і записом):
// перечитати, застосувати ті самі операції до свіжого стану, до 3 спроб.
async function saveTg(env, st, ops, today) {
  let tg = st.tg, sha = st.sha;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const next = core.applyOps(tg, ops, st.data, today);
    if (core.sameState(next, tg) && !("offset" in (tg || {}))) return false;
    const body = { message: "Бот: " + core.describeOps(ops, st.data), content: b64(JSON.stringify(next, null, 1) + "\n"), branch: env.GH_BRANCH || "main" };
    if (sha) body.sha = sha;
    const r = await fetch(`${ghApi(env)}/repos/${env.GH_REPO}/contents/tg.json`, { method: "PUT", headers: ghHeaders(env), body: JSON.stringify(body) });
    if (r.ok) return true;
    if ((r.status === 409 || r.status === 422) && attempt < 3) {
      console.log(`tg.json: конфлікт (${r.status}), спроба ${attempt + 1}`);
      const f = await ghRead(env, "tg.json");
      tg = f ? JSON.parse(f.text) : {}; sha = f ? f.sha : null;
      continue;
    }
    throw new Error(`GitHub запис tg.json: ${r.status}`);
  }
}

// ---------- GitHub ----------
const ghApi = (env) => env.GH_API || "https://api.github.com";
const ghHeaders = (env) => ({ Authorization: "Bearer " + env.GH_TOKEN, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": UA, "content-type": "application/json" });
async function ghRead(env, file) {
  const r = await fetch(`${ghApi(env)}/repos/${env.GH_REPO}/contents/${file}?ref=${encodeURIComponent(env.GH_BRANCH || "main")}`, { headers: ghHeaders(env) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub читання ${file}: ${r.status}`);
  const j = await r.json();
  return { text: unb64(j.content || ""), sha: j.sha };
}
function unb64(s) { const bin = atob(s.replace(/\s/g, "")); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new TextDecoder().decode(u); }
function b64(s) { const u = new TextEncoder().encode(s); let bin = ""; for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(bin); }

// ---------- Telegram ----------
// Адреса містить токен, тому її ніколи не логуємо — лише метод і опис помилки.
async function tgCall(env, method, body) {
  if (!env.TG_TOKEN) throw new Error("немає секрету TG_TOKEN");
  const r = await fetch(`${env.TG_API || "https://api.telegram.org"}/bot${env.TG_TOKEN}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description || "HTTP " + r.status);
  return j.result;
}
async function tgSend(env, chat, textBody) {
  try { await tgCall(env, "sendMessage", { chat_id: chat, text: textBody, disable_web_page_preview: true }); return true; }
  catch (e) { console.log("Telegram sendMessage:", e.message); return false; }
}
