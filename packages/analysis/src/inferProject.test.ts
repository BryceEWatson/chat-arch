import { describe, it, expect } from 'vitest';
import { inferProject, extractBasename } from './inferProject.js';

describe('inferProject — resolution order', () => {
  it('(1) project field wins when present', () => {
    const r = inferProject({
      project: 'chat-arch',
      cwd: 'C:/Users/example/Projects/my-project-a',
      title: 'Profitability Outlook for my-project-c',
    });
    expect(r).not.toBeNull();
    expect(r!.id).toBe('chat-arch');
    expect(r!.inferenceSource).toBe('project_field');
  });

  it('(2) cwd basename wins when project is null', () => {
    const r = inferProject({
      project: undefined,
      cwd: 'C:\\Users\\example\\Projects\\my-project-b',
      title: 'Ignored',
    });
    expect(r!.id).toBe('my-project-b');
    expect(r!.inferenceSource).toBe('cwd_basename');
  });

  it('(2) cwd basename works with POSIX separators', () => {
    const r = inferProject({
      project: undefined,
      cwd: '/home/example/projects/my-project-a-v3',
      title: 't',
    });
    expect(r!.id).toBe('my-project-a-v3');
    expect(r!.inferenceSource).toBe('cwd_basename');
  });

  it('(3) title-keyword fallback — my-project-c', () => {
    const r = inferProject({
      project: undefined,
      cwd: undefined,
      title: 'Profitability Outlook for my-project-c',
    });
    expect(r!.id).toBe('my-project-c');
    expect(r!.inferenceSource).toBe('title_keyword');
  });

  it('(3) title-keyword fallback — my-project-a (variant spacing)', () => {
    const r = inferProject({
      project: undefined,
      cwd: undefined,
      title: 'Comprehensive Git Commit for My Project A Dashboard',
    });
    expect(r!.id).toBe('my-project-a');
    expect(r!.inferenceSource).toBe('title_keyword');
  });

  it('(3) title-keyword fallback — case-insensitive', () => {
    const r = inferProject({
      project: undefined,
      cwd: undefined,
      title: 'my-project-b roadmap review',
    });
    expect(r!.id).toBe('my-project-b');
    expect(r!.inferenceSource).toBe('title_keyword');
  });

  it('(3) title-keyword fallback — chat-arch', () => {
    const r = inferProject({
      project: undefined,
      cwd: undefined,
      title: 'Build Chat Archaeologist orchestrator system',
    });
    expect(r!.id).toBe('chat-arch');
    expect(r!.inferenceSource).toBe('title_keyword');
  });

  it('returns null when no resolution path matches', () => {
    const r = inferProject({
      project: undefined,
      cwd: undefined,
      title: 'Translating French poetry',
    });
    expect(r).toBeNull();
  });

  it('treats empty project field as absent (falls through to cwd)', () => {
    const r = inferProject({
      project: '',
      cwd: '/tmp/foo',
      title: 't',
    });
    expect(r!.id).toBe('foo');
    expect(r!.inferenceSource).toBe('cwd_basename');
  });
});

describe('extractBasename', () => {
  it('handles Windows paths', () => {
    expect(extractBasename('C:\\Users\\example\\Projects\\chat-arch')).toBe('chat-arch');
  });
  it('handles POSIX paths', () => {
    expect(extractBasename('/home/example/projects/chat-arch')).toBe('chat-arch');
  });
  it('strips trailing slashes', () => {
    expect(extractBasename('/home/example/chat-arch/')).toBe('chat-arch');
    expect(extractBasename('C:\\code\\x\\')).toBe('x');
  });
  it('returns bare segment when no separator', () => {
    expect(extractBasename('solo')).toBe('solo');
  });
  it('returns null for empty input', () => {
    expect(extractBasename('')).toBeNull();
    expect(extractBasename('   ')).toBeNull();
  });
});
