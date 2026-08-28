import fs from "node:fs/promises";
import path from "node:path";

export interface Skill {
  name: string;
  description: string;
  /** roles this skill is relevant to (for the per-role index) */
  roles: string[];
  keywords: string[];
  body: string;
  dir: string;
}

export interface SkillRegistry {
  all: Skill[];
  get(name: string): Skill | undefined;
  /** compact "- name — description" list for a prompt, optionally filtered by role */
  index(roles?: string[]): string;
  /** concatenated bodies for the given names, size-capped */
  resolve(names: string[] | undefined): string;
}

type LogFn = (level: "info" | "warn" | "error", text: string) => void;

const MAX_RESOLVED = 6000;

/** Minimal front-matter parse — `key: value` and `key: [a, b]`, no YAML dep. */
function parseFrontmatter(text: string): {
  meta: Record<string, string | string[]>;
  body: string;
} {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(text);
  if (!m) return { meta: {}, body: text.trim() };
  const meta: Record<string, string | string[]> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const [, k, raw] = kv;
    const v = raw.trim();
    if (v.startsWith("[") && v.endsWith("]")) {
      meta[k] = v
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      meta[k] = v.replace(/^["']|["']$/g, "");
    }
  }
  return { meta, body: text.slice(m[0].length).trim() };
}

function toRegistry(skills: Skill[]): SkillRegistry {
  const byName = new Map(skills.map((s) => [s.name, s]));
  return {
    all: skills,
    get: (name) => byName.get(name?.trim()),
    index(roles) {
      const wanted = roles && roles.length ? new Set(roles) : null;
      return skills
        .filter((s) => !wanted || s.roles.length === 0 || s.roles.some((r) => wanted.has(r)))
        .map((s) => `- ${s.name} — ${s.description}`)
        .join("\n");
    },
    resolve(names) {
      if (!names?.length) return "";
      let out = "";
      for (const n of names) {
        const s = byName.get(String(n).trim());
        if (!s) continue;
        out += `# Skill: ${s.name}\n${s.body}\n\n`;
      }
      out = out.trim();
      return out.length > MAX_RESOLVED ? `${out.slice(0, MAX_RESOLVED)}\n…(truncated)` : out;
    },
  };
}

async function loadOne(dir: string): Promise<Skill[]> {
  let entries: string[];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const skills: Skill[] = [];
  for (const name of entries) {
    const skillDir = path.join(dir, name);
    let text: string;
    try {
      text = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    const { meta, body } = parseFrontmatter(text);
    if (!body) continue;
    skills.push({
      name: (typeof meta.name === "string" && meta.name) || name,
      description: typeof meta.description === "string" ? meta.description : "",
      roles: Array.isArray(meta.roles) ? meta.roles : [],
      keywords: Array.isArray(meta.keywords) ? meta.keywords : [],
      body,
      dir: skillDir,
    });
  }
  return skills;
}

/** Load `<dir>/<name>/SKILL.md` from one or more folders. Later folders win on a
 *  name clash. A missing folder is skipped. */
export async function loadSkills(
  dirs: string | string[],
  log: LogFn = () => {},
): Promise<SkillRegistry> {
  const list = Array.isArray(dirs) ? dirs : [dirs];
  const byName = new Map<string, Skill>();
  for (const dir of list) {
    for (const s of await loadOne(dir)) byName.set(s.name, s);
  }
  const skills = [...byName.values()];
  if (skills.length) {
    log("info", `skills: ${skills.length} loaded (${skills.map((s) => s.name).join(", ")})`);
  }
  return toRegistry(skills);
}
