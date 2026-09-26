export type Skill = { name: string; description: string; body: string };
const NAME = /^[a-z][a-z0-9-]{0,40}$/;

/** A skill is a markdown file. Front matter supplies the slash name. The body is text, never a command. */
export function parseSkill(directoryName: string, markdown: string): Skill | null {
  const text = markdown.replace(/^\uFEFF/, '').slice(0, 16000);
  let name = directoryName;
  let description = '';
  let body = text;
  if (text.startsWith('---\n') || text.startsWith('---\r\n')) {
    const end = text.indexOf('\n---', 3);
    if (end > 0) {
      const front = text.slice(text.indexOf('\n') + 1, end);
      body = text.slice(end + 4).replace(/^\r?\n/, '');
      for (const line of front.split(/\r?\n/)) {
        const match = /^(name|description):\s*(.*)$/.exec(line);
        if (match?.[1] === 'name') name = match[2].trim();
        if (match?.[1] === 'description') description = match[2].trim();
      }
    }
  }
  if (!NAME.test(name)) return null;
  if (!description) description = (body.trim().split(/\r?\n/).find(line => line.trim()) ?? name).replace(/^#+\s*/, '').slice(0, 200);
  return { name, description: description.slice(0, 200), body: body.trim().slice(0, 16000) };
}

/**
 * What the model is told, in order. AGENTS.md is the shared project guide.
 * `.afteredit.json` instructions come last and win when they disagree.
 * A chosen skill is for this run only. Task rules and Git hooks are not included.
 */
export function composeGuidance(parts: { agents?: string; instructions?: string; skill?: Skill | null }): string {
  const sections = [
    parts.agents?.trim() ? `# AGENTS.md\n${parts.agents.trim()}` : '',
    parts.instructions?.trim() ? `# Project instructions\n${parts.instructions.trim()}` : '',
    parts.skill ? `# Skill ${parts.skill.name}\n${parts.skill.description}\n\n${parts.skill.body}` : '',
  ].filter(Boolean);
  return sections.join('\n\n').slice(0, 48000);
}

/** `/name rest` selects a skill and leaves the rest as the goal. */
export function takeSlashSkill(goal: string, skills: Skill[]): { goal: string; skill: Skill | null } {
  const match = /^\/([a-z][a-z0-9-]{0,40})(?:\s+([\s\S]*))?$/.exec(goal.trim());
  if (!match) return { goal, skill: null };
  const skill = skills.find(item => item.name === match[1]) ?? null;
  if (!skill) return { goal, skill: null };
  return { goal: (match[2] ?? '').trim() || skill.description, skill };
}

type Entry = { name: string; path: string; directory: boolean };
/** Read `.afteredit/skills/<name>/SKILL.md`. Missing directories are an empty list, not an error. */
export async function discoverSkills(root: string, list: (path: string) => Promise<Entry[]>, read: (path: string) => Promise<string>): Promise<Skill[]> {
  let entries: Entry[] = [];
  try { entries = await list(`${root}/.afteredit/skills`); } catch { return []; }
  const skills: Skill[] = [];
  for (const entry of entries.filter(item => item.directory).slice(0, 20)) {
    try {
      const skill = parseSkill(entry.name, await read(`${entry.path}/SKILL.md`));
      if (skill && !skills.some(item => item.name === skill.name)) skills.push(skill);
    } catch { /* a folder without SKILL.md is skipped */ }
  }
  return skills;
}
