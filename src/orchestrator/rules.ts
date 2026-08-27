import type { PermRule } from "./permissions.ts";

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

/** Read-only / obviously safe commands that run without asking. */
const SHELL_READONLY =
  /^(ls|pwd|cat|head|tail|wc|echo|date|whoami|env|printenv|which|file|stat|tree|grep|rg|find|diff|sort|uniq|node\s+(-v|--version)|npm\s+(test|run\s+test|ls|list)|git\s+(status|diff|log|show|branch|remote))\b/;

export const defaultRules: PermRule[] = [
  {
    name: "shell:hard-block",
    match: (r) =>
      r.tool === "run_shell" && SHELL_HARD_BLOCK.some((re) => re.test(r.detail))
        ? "deny"
        : null,
  },
  {
    name: "shell:read-only",
    match: (r) =>
      r.tool === "run_shell" && SHELL_READONLY.test(r.detail.trim()) ? "allow" : null,
  },
  {
    name: "shell:ask",
    match: (r) => (r.tool === "run_shell" ? "ask" : null),
  },
];
