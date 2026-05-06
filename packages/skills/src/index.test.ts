import { describe, expect, it } from 'vitest';
import { parseSkill } from './index.js';

describe('parseSkill', () => {
  it('parses frontmatter scalars and string lists', () => {
    const raw = `---
name: test-skill
description: hello
trigger:
  - foo
  - bar
---

Body goes here.`;
    const skill = parseSkill(raw, '/tmp/test.md');
    expect(skill.name).toBe('test-skill');
    expect(skill.frontmatter.description).toBe('hello');
    expect(skill.frontmatter.trigger).toEqual(['foo', 'bar']);
    expect(skill.body).toBe('Body goes here.');
  });

  it('throws if frontmatter is missing', () => {
    expect(() => parseSkill('no frontmatter here', '/tmp/x.md')).toThrow();
  });
});
