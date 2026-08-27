import path from "node:path";
import type { PermRule, PermRequest } from "./permissions.ts";

/** Commands refused outright, approval or not. */
export const SHELL_HARD_BLOCK: RegExp[] = [
  /\brm\s+-[a-z]*r/i,
  /\bmkfs\b/i,
  /\bdd\b\s+if=/i,
  /:\(\)\s*\{.*\}\s*;/, // fork bomb
  /\b(shutdown|reboot|halt)\b/i,
  />\s*\/dev\/(sd|disk|null\/)/i,
  /\b(curl|wget|fetch)\b[^|]*\|\s*(sh|bash|zsh)\b/i,
  /\bsudo\b/i,
];

/** Shell metacharacters — anything with these is never auto-allowed. */
const META = /[|;&`$><\n]|\$\(/;

/** No filesystem-read risk: always safe to auto-run. */
const SHELL_SAFE =
  /^(pwd|whoami|date|hostname|uname|id|echo|env|printenv|node\s+(-v|--version)|npm\s+(test|run\s+test|ls|list)|git\s+(status|log|branch|remote|show|diff|rev-parse))\b/;

/** Read files: safe to auto-run only if every path argument stays in the workspace. */
const SHELL_READERS = /^(ls|cat|head|tail|wc|nl|grep|rg|tree|stat|file|sort|uniq|cut|diff)\b/;

/** True if a simple command reads nothing outside `cwd`. */
export function commandStaysInside(cmd: string, cwd: string): boolean {
  if (META.test(cmd)) return false;
  for (const tok of cmd.split(/\s+/).slice(1)) {
    if (!tok || tok.startsWith("-")) continue; // flag
    if (tok.includes("~") || tok.includes("..")) return false;
    if (path.isAbsolute(tok)) return false;
    const resolved = path.resolve(cwd, tok);
    if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) return false;
  }
  return true;
}

function shellDecision(r: PermRequest): "allow" | "deny" | "ask" {
  const cmd = r.detail.trim();
  if (SHELL_HARD_BLOCK.some((re) => re.test(cmd))) return "deny";
  if (SHELL_SAFE.test(cmd) && !META.test(cmd)) return "allow";
  if (SHELL_READERS.test(cmd) && r.cwd && commandStaysInside(cmd, r.cwd)) return "allow";
  return "ask";
}

export const defaultRules: PermRule[] = [
  {
    name: "run_shell",
    match: (r) => (r.tool === "run_shell" ? shellDecision(r) : null),
  },
];
