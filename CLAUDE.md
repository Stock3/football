# Пʼятниця 5×5

Сайт статистики щотижневої пʼятничної гри 5×5 з друзями. Мова інтерфейсу, коментарів, комітів і спілкування — українська.

## Як влаштовано
- GitHub Pages, публічний репо. Без збірки, без фреймворків, без залежностей.
- `index.html` — увесь застосунок: один файл, vanilla JS (ES5-стиль: `var`, `function`), CSS-токени для світлої/темної теми. Шрифти: Oswald (заголовки) + Golos Text. Кольори команд: жовті vs сині.
- `data.json` — усі дані. Глядачі читають `data.json?t=…`; редактор (лише власник) входить з fine-grained GitHub-токеном (зберігається тільки в localStorage) і зберігає через GitHub Contents API (PUT з sha). Кожне збереження — коміт.
- `worker/` — Telegram-бот на Cloudflare Workers (адреса https://bot.shtuchka.workers.dev), без npm-залежностей, деплой — Cloudflare Workers Builds з GitHub (root `worker`). Власного сховища немає: data.json, index.html (DEF) і tg.json читає/пише через GitHub Contents API (tg.json — з sha, при 409 перечитує й застосовує операції ще раз). data.json бот пише лише в опитуванні (склад гри c/y/b, нова чернетка гри, ann.gather).
  - `src/core.js` — логіка (чисті функції: дані + стан + час → повідомлення й операції стану): команди, подяки (і за оплату наперед), підсумок гри з оплатою (postGame, sent[gid][pid].pg — один раз), нагадування, оголошення, погода.
  - `src/poll.js` — опитування «хто йде» (чисто): `step(C, ev)` → новий data.json/tg.json + повідомлення, редагування, answerCallbackQuery. index.js виконує крок як транзакцію: пише data.json, потім tg.json; при 409 перечитує обидва й рахує крок заново (обробники ідемпотентні), повідомлення — лише після запису. Події: start, end, cb, ask, out, who, no, sync, tick, nobot.
  - `src/index.js` — мережа: POST /tg (webhook: message і callback_query, секрет X-Telegram-Bot-Api-Secret-Token), POST /notify (кнопки сайту; Bearer-токен редактора, пускає лише з permissions.push), GET /setup?key=TG_SECRET (webhook з allowed_updates message+callback_query, меню who/out/status/weather/stop), GET /health, cron */15 (опитування tick + подяки/підсумки-страховка + нагадування за розкладом).
  - Адмін бота — гравець settings.org з підключеним ботом: /poll, /endpoll, /no Імʼя (не в меню). Решта — /who, /out (причина наступним повідомленням або /skip), /status, /weather, /stop.
  - Режим тесту (settings.testMode, DEF false): усе, що мало піти гравцям, іде в чат адміна з «👤 для Імʼя:». Єдине місце вибору адресата — `deliver()`/`routeEdit()` в index.js (звичайний режим — без змін); core.chatFor вважає гравців без бота підключеними й веде все до адміна. Кнопки в перенаправлених повідомленнях несуть id гравця третьою частиною callback_data («дія|гра|гравець»), poll.step бере його як X.as/X.pid (ev.as — з /as). Адмін-команди `/as Імʼя …`, `/testreset` (core.onMessage → poll-подія testreset). Події не з чату адміна в тесті ігноруються (testBlocked); подяки/підсумки/нагадування в тесті — лише для гри з tg.poll.game, слоти не пишуться. Тести: worker/test/testmode.test.mjs. Сайт показує червоний банер.
  - Тихі години (settings.remind.quiet) — лише для повідомлень за розкладом (нагадування оплати, нагадування й «пізніше» в опитуванні, автозапуск); реакції на дії — одразу.
  - Секрети в Cloudflare: TG_TOKEN, GH_TOKEN, TG_SECRET. Змінні — у `worker/wrangler.toml`. Токени ніколи не логувати.
  - Тести: `node --test worker/test/` (моки Telegram/GitHub/Open-Meteo). Перевірка збірки: `npx wrangler deploy --dry-run` у `worker/`.
  - Стан бота — `tg.json` (пише лише бот): {chats, sent:{gid:{pid:{thx?,pg?,r[]}}}, slots, poll?}. poll = {game, open, startedAt, closedAt?, announced, short, empty?, queueFront[], wait?:{pid:ISO}, inv:{pid:{at, ans:"yes"|"no"|"later"|null, laterUntil?, remindedAt?, reason?, nobot?}}}. Склад гри — лише в data.json; «тримають місце» запрошені з ans null/later (і nobot).
- Сайт викликає бота через `settings.worker` + `/notify` ({mode: thanks|remind|gather|cancel|sync|played, player?, game?}). Після кожного збереження сайт тихо кличе sync (бот звіряє опитування зі складом, надсилає підсумок гри й подяки). save(build) на сайті приймає функцію-будівник: при 409 (дані змінив бот) перечитує data.json і будує зміни ще раз; форма гри робить тристороннє злиття (застосовує лише зміни редактора відносно складу на момент відкриття).
- Стандартні налаштування й тексти бота — блок `/*DEF*/{…}/*/DEF*/` в index.html; бот парсить його як JSON, тож він має лишатися валідним JSON.
- Погода (Open-Meteo: ECMWF, GFS, ICON) — блок `/*WX*/function(){…}/*/WX*/` в index.html: самодостатня ES5-функція (url, build(json,date,time,warn,dry), text, line, verdictText). Вдень — з 08:00 до години перед грою; вердикт dry/rain/warn. Workers не дозволяють eval, тому `worker/src/wx.js` — автоматична копія блоку: після зміни блоку запустити `node worker/sync-wx.mjs` (тест падає, якщо копія розійшлася). У блоці не можна звертатися до решти сторінки.

## Схема data.json
```
{ "v":1,
  "settings":{ price, card, cardName, bank, payFrom, org, bot, worker, remind:{on,mode:"after"|"days",after,days[1–7],times["HH:MM"],quiet:{from,to},every,max,hour?}, thanks[], reminders[], hello, verdicts:{w[],l[],d[]}, time, place, gather[], cancel[], city, lat, lon, rainWarn, rainDry, wxDry, wxRain, wxWarn, sinoptik, meteo,
               prepaid[], postW[], postL[], postD[], poll:{auto,day[1–7],time,need}, pollInvite[], pollRemind[], pollYes[], pollNo[], pollShort[], pollBack[], say:{adminOnly,closed,noPoll,notIn,askReason,outOk,inGame,skipped,full,laterAsk,laterOk} },
  "players":[{ id:"p1", name, active, prio?, num?, pos?:[≤2 кодів], foot?:"l"|"r", h?, bd?:"YYYY-MM-DD", quote?, phone?, tg? }],
  "games":[{ id:"g20261009", date, c?:[ids], y:[ids], b:[ids], gy, gb, sy?, sb?, paid?:[ids], x?:true, ann?:{gather?:ISO, cancel?:ISO} }] }
```
- y/b — гравці жовтих/синіх; gy/gb — кількість анонімних гостей; sy/sb — рахунок. Без sy/sb — запланована гра, у статистику не йде.
- Сезони — роки з дат ігор + «Весь час».
- c — «буде» (прийде, команда ще невідома); гравець лише в одному з c/y/b. Гру з рахунком не можна зберегти, поки в c хтось є. c у статистику й оплату не йде.
- x:true — гра скасована: не йде ні в статистику, ні в оплату (played() її відкидає). ann — коли сайт попросив бота надіслати «Збір є»/«Збір скасовано» (x пише сайт; ann.gather пише й бот, коли опитування набрало потрібну кількість).
- remind.hour — старий формат (без times): означає час відправки HH:00, без тихих годин.
- Оплата рахується для зіграних ігор з датою ≥ settings.payFrom; платять усі гравці гри, крім settings.org; гості не платять. paid можна ставити й на заплановану гру (оплата наперед, будь-хто з c/y/b) і на організатора — у борги й нагадування організатор не потрапляє ніколи.
- prio — місце в черзі запрошень опитування (менше — раніше; без prio — після, за імʼям). Неактивних не запрошують.

## Домовленості
- Голи окремих гравців не рахуємо, лише рахунок команди.
- Дані вносить тільки власник.
- Лишатися незалежним: без платного хостингу, без vendor lock-in, нічого не привʼязано до AI-акаунта.
- Нові поля в data.json — лише необовʼязкові; старі дані мають працювати без міграцій. Збереження не повинні губити поля, яких форма не знає.
- Перед комітом перевіряти сторінку в браузері (локально: `python3 -m http.server`, дані підтягуються лише через http, не з file://).
- Після змін оновлювати README.md (інструкція для власника).

## Ідеї на потім
- «Скопіювати для групи» після збереження гри: текст для Telegram з рахунком, складами й 2–3 фактами; «Скопіювати склади» в генераторі.
- Elo-рейтинг (і для балансу команд), head-to-head, графік форми.
- Досягнення й екран «Сезон у цифрах».
