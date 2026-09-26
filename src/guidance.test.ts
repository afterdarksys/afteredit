import test from 'node:test';
import assert from 'node:assert/strict';
import { composeGuidance, discoverSkills, parseSkill, takeSlashSkill } from './guidance.ts';

test('a skill name comes from front matter and the body stays text', () => {
  const skill = parseSkill('folder', '---\nname: review\ndescription: Read the diff\n---\n\nLook at the change.\n');
  assert.equal(skill?.name, 'review');
  assert.equal(skill?.description, 'Read the diff');
  assert.match(skill?.body ?? '', /Look at the change/);
  assert.equal(parseSkill('../x', 'hello'), null);
});

test('project instructions come after AGENTS.md and a skill is optional', () => {
  const text = composeGuidance({ agents: 'Use the project tests.', instructions: 'Do not format.', skill: { name: 'review', description: 'Read the diff', body: 'Cite files.' } });
  assert.ok(text.indexOf('AGENTS.md') < text.indexOf('Project instructions'));
  assert.ok(text.indexOf('Project instructions') < text.indexOf('# Skill review'));
  assert.equal(composeGuidance({}).length, 0);
});

test('a slash name selects a skill and leaves the rest of the goal', () => {
  const skills = [{ name: 'review', description: 'Read the diff', body: 'Cite files.' }];
  assert.deepEqual(takeSlashSkill('/review the login', skills), { goal: 'the login', skill: skills[0] });
  assert.equal(takeSlashSkill('/missing', skills).skill, null);
  assert.equal(takeSlashSkill('plain goal', skills).skill, null);
});

test('skill discovery skips a missing directory and a folder without SKILL.md', async () => {
  const listed: string[] = [];
  const found = await discoverSkills('/proj', async path => { listed.push(path); throw new Error('missing'); }, async () => '');
  assert.deepEqual(found, []);
  assert.deepEqual(listed, ['/proj/.afteredit/skills']);
  const skills = await discoverSkills('/proj', async () => [{ name: 'review', path: '/proj/.afteredit/skills/review', directory: true }, { name: 'notes', path: '/proj/.afteredit/skills/notes', directory: false }], async path => path.endsWith('review/SKILL.md') ? '---\nname: review\ndescription: Read\n---\nBody' : Promise.reject(new Error('no skill')));
  assert.deepEqual(skills.map(skill => skill.name), ['review']);
});
