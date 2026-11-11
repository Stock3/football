// Копіює блок погоди /*WX*/…/*/WX*/ з ../index.html у src/wx.js.
// Cloudflare Workers не дозволяють new Function/eval, тож Worker не може виконати блок прямо з index.html, як сайт.
// Запуск після зміни погоди в index.html:  node worker/sync-wx.mjs
// Тест worker/test/core.test.mjs падає, якщо копія розійшлася з index.html.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(dir, "..", "index.html"), "utf8");
const m = html.match(/\/\*WX\*\/[\s\S]*?\/\*\/WX\*\//);
if (!m) throw new Error("У index.html немає блоку /*WX*/");
fs.writeFileSync(path.join(dir, "src", "wx.js"),
  "// АВТОМАТИЧНА КОПІЯ блоку погоди з index.html — не редагувати тут. Оновити: node worker/sync-wx.mjs\n" +
  "export const WX = (" + m[0] + ")();\n");
console.log("worker/src/wx.js оновлено");
