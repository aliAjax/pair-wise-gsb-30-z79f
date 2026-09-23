import { build } from "vite";
import vue from "@vitejs/plugin-vue";
import { webcrypto } from "node:crypto";

globalThis.localStorage = {
  store: new Map(),
  getItem(k) { return this.store.get(k) ?? null; },
  setItem(k, v) { this.store.set(k, v); },
  removeItem(k) { this.store.delete(k); }
};
globalThis.crypto ??= webcrypto;

await build({
  logLevel: "error",
  configFile: false,
  plugins: [vue()],
  build: {
    ssr: "scripts/render-entry.ts",
    write: true,
    outDir: "scripts/.render-out",
    rollupOptions: { output: { entryFileNames: "render-built.mjs", format: "esm" } }
  }
});

const mod = await import("./.render-out/render-built.mjs");
const { createSSRApp } = await import("vue");
const { createPinia } = await import("pinia");
const { renderToString } = await import("vue/server-renderer");

const app = createSSRApp(mod.default);
app.use(createPinia());
const html = await renderToString(app);

const must = ["罐车分舱", "登记配送趟次", "鲁B·7218", "PS20260701-02", "退油待处理", "修订留痕", "到站顺序", "分舱装载"];
let fail = 0;
for (const text of must) {
  if (!html.includes(text)) { console.error("missing marker:", text); fail++; }
}
console.log(`rendered ${html.length} chars; ${must.length - fail}/${must.length} key markers present`);
process.exit(fail ? 1 : 0);
