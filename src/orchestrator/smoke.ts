/**
 * A dependency-free "does it even load" check for HTML artifacts.
 *
 * We can't run a real browser without a heavy dependency, so this loads a page
 * in a throwaway `node:vm` context wired to a minimal DOM/BOM shim: enough to
 * catch the failures a static review misses — syntax errors, `ReferenceError`s,
 * `.style`/`.textContent` on a `null` from a missing element, throws during
 * `onload` or the first game ticks, missing local `<script src>` files, and
 * "the arrow keys were never wired up".
 *
 * It does NOT check layout or "is anything visible" — only that the page's
 * JavaScript runs without throwing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import vm from "node:vm";

export interface SmokeResult {
  file: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
  scripts: number;
}

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const SRC_RE = /\bsrc\s*=\s*["']([^"']+)["']/i;
const TYPE_RE = /\btype\s*=\s*["']([^"']+)["']/i;
const ID_RE = /\bid\s*=\s*["']([^"']+)["']/g;

const DRIVER = `
document.readyState = "complete";
var L = window.__L;
function fire(list, arg) {
  (list || []).forEach(function (f) {
    try { f(arg); } catch (e) { window.__err((e && e.name || "Error") + ": " + (e && e.message || e)); }
  });
}
fire(L.doc["DOMContentLoaded"], { type: "DOMContentLoaded" });
fire(L.win["load"], { type: "load" });
if (typeof window.onload === "function") {
  try { window.onload({ type: "load" }); } catch (e) { window.__err("window.onload: " + (e && e.message || e)); }
}
for (var i = 0; i < 4; i++) {
  fire(L.raf.splice(0), 16 * (i + 1));
  L.intervals.slice().forEach(function (f) {
    try { f(); } catch (e) { window.__err("setInterval: " + (e && e.message || e)); }
  });
  L.timers.splice(0).forEach(function (f) {
    try { f(); } catch (e) { window.__err("setTimeout: " + (e && e.message || e)); }
  });
}
`;

/** Load one HTML file in the shim; report anything that throws. */
export function smokeHtml(absPath: string, expect: { canvas?: boolean } = {}): SmokeResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const dir = path.dirname(absPath);

  let html: string;
  try {
    html = fs.readFileSync(absPath, "utf8");
  } catch {
    return { file: absPath, ok: false, errors: [`cannot read ${absPath}`], warnings, scripts: 0 };
  }

  // scripts in document order (inline text + local src files)
  const scripts: Array<{ code: string; label: string }> = [];
  for (const m of html.matchAll(SCRIPT_RE)) {
    const attrs = m[1] || "";
    const type = (attrs.match(TYPE_RE)?.[1] || "").toLowerCase();
    if (type && !/javascript|module|ecmascript/.test(type)) continue; // JSON / templates
    const src = attrs.match(SRC_RE)?.[1];
    if (src) {
      if (/^(https?:)?\/\//i.test(src)) {
        warnings.push(`external script not checked: ${src}`);
        continue;
      }
      const p = path.resolve(dir, src.split(/[?#]/)[0]);
      try {
        scripts.push({ code: fs.readFileSync(p, "utf8"), label: src });
      } catch {
        errors.push(`missing script file: ${src}`);
      }
    } else if (m[2].trim()) {
      scripts.push({ code: m[2], label: "(inline script)" });
    }
  }

  const ids = new Set([...html.matchAll(ID_RE)].map((m) => m[1]));
  const hasCanvas = /<canvas\b/i.test(html);
  const listeners: Record<string, number> = {};
  const track = (t: string) => void (listeners[t] = (listeners[t] || 0) + 1);
  const noop = () => undefined;

  const ctx2d: unknown = new Proxy(
    {},
    {
      get(_t, p) {
        if (p === "measureText") return () => ({ width: 0 });
        if (p === "getImageData") return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
        if (p === "createLinearGradient" || p === "createRadialGradient" || p === "createPattern") {
          return () => ({ addColorStop: noop });
        }
        return noop;
      },
    },
  );

  const cache = new Map<string, Record<string, unknown>>();
  const makeEl = (tag = "div", id = ""): Record<string, unknown> => {
    const el: Record<string, unknown> = {
      tagName: String(tag).toUpperCase(),
      id,
      nodeType: 1,
      children: [],
      style: new Proxy({}, { get: () => "", set: () => true }),
      dataset: {},
      classList: { add: noop, remove: noop, toggle: noop, contains: () => false, replace: noop },
      addEventListener: (t: string) => track(t),
      removeEventListener: noop,
      dispatchEvent: () => true,
      appendChild: (c: unknown) => c,
      removeChild: noop,
      insertBefore: (c: unknown) => c,
      replaceChild: noop,
      append: noop,
      prepend: noop,
      remove: noop,
      cloneNode: () => makeEl(tag, id),
      setAttribute: noop,
      getAttribute: () => null,
      removeAttribute: noop,
      hasAttribute: () => false,
      querySelector: () => null,
      querySelectorAll: () => [],
      getContext: () => ctx2d,
      getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 150, width: 300, height: 150 }),
      focus: noop,
      blur: noop,
      click: noop,
      scrollIntoView: noop,
      width: 300,
      height: 150,
      offsetWidth: 300,
      offsetHeight: 150,
      clientWidth: 300,
      clientHeight: 150,
      textContent: "",
      innerText: "",
      innerHTML: "",
      value: "",
      checked: false,
    };
    return el;
  };
  const byId = (id: string) => {
    if (!ids.has(id)) return null;
    let el = cache.get(id);
    if (!el) cache.set(id, (el = makeEl("div", id)));
    return el;
  };
  const canvasEl = makeEl("canvas");

  const mkStore = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
      setItem: (k: string, v: unknown) => void m.set(k, String(v)),
      removeItem: (k: string) => void m.delete(k),
      clear: () => m.clear(),
      key: (i: number) => [...m.keys()][i] ?? null,
      get length() {
        return m.size;
      },
    };
  };

  const documentShim: Record<string, unknown> = {
    readyState: "loading",
    getElementById: byId,
    querySelector: (s: string) => {
      const t = String(s).trim();
      if (t.startsWith("#")) return byId(t.slice(1));
      if (t.toLowerCase() === "canvas") return canvasEl;
      if (/^[a-z][\w-]*$/i.test(t)) return makeEl(t);
      return null;
    },
    querySelectorAll: () => [],
    getElementsByTagName: (t: string) => (String(t).toLowerCase() === "canvas" ? [canvasEl] : []),
    getElementsByClassName: () => [],
    createElement: (t: string) => (String(t).toLowerCase() === "canvas" ? makeEl("canvas") : makeEl(t)),
    createElementNS: (_ns: string, t: string) => makeEl(t),
    createTextNode: () => makeEl("#text"),
    createDocumentFragment: () => makeEl("#fragment"),
    addEventListener: (t: string, f: unknown) => {
      ((sandbox.__L as Record<string, Record<string, unknown[]>>).doc[t] ||= []).push(f);
      track(t);
    },
    removeEventListener: noop,
    dispatchEvent: () => true,
    body: makeEl("body"),
    head: makeEl("head"),
    documentElement: makeEl("html"),
    cookie: "",
    title: "",
  };

  const sandbox: Record<string, unknown> = {
    __L: { doc: {}, win: {}, timers: [], intervals: [], raf: [] },
    __err: (s: string) => void errors.push(s),
    __warn: (s: string) => void warnings.push(s),
    console: {
      log: noop,
      info: noop,
      debug: noop,
      warn: (...a: unknown[]) => void warnings.push(`console.warn: ${a.map(String).join(" ")}`),
      error: (...a: unknown[]) => void errors.push(`console.error: ${a.map(String).join(" ")}`),
    },
    document: documentShim,
    localStorage: mkStore(),
    sessionStorage: mkStore(),
    location: {
      href: "http://smoke.local/",
      protocol: "http:",
      host: "smoke.local",
      hostname: "smoke.local",
      pathname: "/",
      search: "",
      hash: "",
      origin: "http://smoke.local",
      reload: noop,
      assign: noop,
      replace: noop,
    },
    navigator: { userAgent: "office-smoke", language: "en", platform: "node", onLine: true },
    history: { pushState: noop, replaceState: noop, back: noop, forward: noop },
    performance: { now: () => Date.now() },
    requestAnimationFrame: (f: unknown) => (sandbox.__L as { raf: unknown[] }).raf.push(f),
    cancelAnimationFrame: noop,
    setTimeout: (f: unknown) => {
      if (typeof f === "function") (sandbox.__L as { timers: unknown[] }).timers.push(f);
      return 0;
    },
    clearTimeout: noop,
    setInterval: (f: unknown) => {
      if (typeof f === "function") (sandbox.__L as { intervals: unknown[] }).intervals.push(f);
      return 0;
    },
    clearInterval: noop,
    addEventListener: (t: string, f: unknown) => {
      ((sandbox.__L as Record<string, Record<string, unknown[]>>).win[t] ||= []).push(f);
      track(t);
    },
    removeEventListener: noop,
    dispatchEvent: () => true,
    alert: noop,
    confirm: () => true,
    prompt: () => null,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop }),
    getComputedStyle: () => new Proxy({}, { get: () => "" }),
    fetch: () => Promise.reject(new Error("network disabled in smoke check")),
    Image: class {
      set src(_v: string) {}
    },
    Audio: class {
      play() {
        return Promise.resolve();
      }
      pause() {}
    },
    Event: class {
      type: string;
      constructor(t: string) {
        this.type = t;
      }
    },
    CustomEvent: class {
      type: string;
      detail: unknown;
      constructor(t: string, o: { detail?: unknown } = {}) {
        this.type = t;
        this.detail = o.detail;
      }
    },
    KeyboardEvent: class {
      type: string;
      key: string;
      constructor(t: string, o: { key?: string } = {}) {
        this.type = t;
        this.key = o.key ?? "";
      }
    },
    MouseEvent: class {
      type: string;
      constructor(t: string) {
        this.type = t;
      }
    },
    URL,
    URLSearchParams,
    crypto: globalThis.crypto,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  documentShim.defaultView = sandbox;

  const context = vm.createContext(sandbox);
  for (const s of scripts) {
    try {
      new vm.Script(s.code, { filename: s.label }).runInContext(context, { timeout: 2000 });
    } catch (e) {
      const err = e as Error;
      errors.push(`${s.label}: ${err.name || "Error"}: ${err.message || String(e)}`);
    }
  }
  try {
    new vm.Script(DRIVER, { filename: "(page lifecycle)" }).runInContext(context, { timeout: 3000 });
  } catch (e) {
    errors.push(`page lifecycle: ${(e as Error).message || String(e)}`);
  }

  // heuristics — warnings only, never fail the page
  const src = scripts.map((s) => s.code).join("\n");
  const wantsKeys = /\bkeydown\b|\bkeyup\b|\bkeypress\b|arrow(up|down|left|right)|\bwasd\b/i.test(html + src);
  const wiredInput = ["keydown", "keyup", "keypress", "click", "pointerdown", "mousedown"].some((t) => listeners[t]);
  if (wantsKeys && !wiredInput) {
    warnings.push("no keyboard/pointer listener registered — the controls are probably dead");
  }
  if (expect.canvas && !hasCanvas) {
    warnings.push("the task asks for a canvas game but the page has no <canvas> element");
  }

  return {
    file: absPath,
    ok: errors.length === 0,
    errors: [...new Set(errors)].slice(0, 12),
    warnings: [...new Set(warnings)].slice(0, 12),
    scripts: scripts.length,
  };
}

/** Smoke every `*.html` under `root` touched at or after `sinceMs`. */
export function smokeProject(root: string, sinceMs = 0, expect: { canvas?: boolean } = {}): SmokeResult[] {
  const out: SmokeResult[] = [];
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git" || e.name === "node_modules" || e.name === ".office") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (/\.html?$/i.test(e.name)) {
        try {
          if (fs.statSync(p).mtimeMs >= sinceMs) out.push(smokeHtml(p, expect));
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(root);
  return out;
}

/** A short, reviewer-readable report of the failures (and warnings). */
export function formatSmoke(results: SmokeResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    const name = r.file.split("/").slice(-2).join("/");
    if (r.errors.length) {
      lines.push(`✗ ${name} — the page throws on load:`);
      for (const e of r.errors) lines.push(`   • ${e}`);
    }
    for (const w of r.warnings) lines.push(`⚠ ${name}: ${w}`);
  }
  return lines.join("\n");
}
