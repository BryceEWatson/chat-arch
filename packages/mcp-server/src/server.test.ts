import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ReadOnlyPolicyError } from './readOnly.js';
import { createMcpServer, type McpTool } from './server.js';
import { WorkingDirError } from './workingDir.js';

const ABS_WORKING_DIR = path.resolve('/tmp/chat-arch-data');

function makeTool(name: string): McpTool {
  return {
    name,
    description: `mock tool ${name}`,
    handler: async () => ({ ok: true }),
  };
}

describe('createMcpServer', () => {
  it('constructs with a valid working dir + exposes empty toolset', () => {
    const server = createMcpServer({ workingDir: ABS_WORKING_DIR });
    expect(server.workingDir.absolute).toBe(path.resolve(ABS_WORKING_DIR));
    expect(server.listTools()).toEqual([]);
  });

  it('rejects construction when working dir is invalid', () => {
    expect(() =>
      createMcpServer({ workingDir: 'not-absolute' }),
    ).toThrowError(WorkingDirError);
    expect(() =>
      createMcpServer({ workingDir: path.resolve('/tmp/other-dir') }),
    ).toThrowError(WorkingDirError);
  });

  it('registers an allow-listed tool and lists it', () => {
    const server = createMcpServer({ workingDir: ABS_WORKING_DIR });
    server.registerTool(makeTool('get_project'));
    server.registerTool(makeTool('list_narratives'));
    const names = server.listTools().map((t) => t.name);
    expect(names).toEqual(['get_project', 'list_narratives']);
  });

  it('rejects registering a write-shaped tool', () => {
    const server = createMcpServer({ workingDir: ABS_WORKING_DIR });
    expect(() =>
      server.registerTool(makeTool('write_finding')),
    ).toThrowError(ReadOnlyPolicyError);
    expect(() =>
      server.registerTool(makeTool('delete_project')),
    ).toThrowError(ReadOnlyPolicyError);
    expect(() =>
      server.registerTool(makeTool('exec_query')),
    ).toThrowError(ReadOnlyPolicyError);
    // The failed registrations must not leak into listTools.
    expect(server.listTools()).toEqual([]);
  });

  it('rejects duplicate registration of the same tool name', () => {
    const server = createMcpServer({ workingDir: ABS_WORKING_DIR });
    server.registerTool(makeTool('get_project'));
    expect(() =>
      server.registerTool(makeTool('get_project')),
    ).toThrowError(ReadOnlyPolicyError);
    // Only one registration.
    expect(server.listTools().length).toBe(1);
  });

  it('listTools returns a frozen array snapshot', () => {
    const server = createMcpServer({ workingDir: ABS_WORKING_DIR });
    server.registerTool(makeTool('get_project'));
    const tools = server.listTools();
    expect(Object.isFrozen(tools)).toBe(true);
    // Adding a new tool after the snapshot does not mutate the
    // already-returned array.
    server.registerTool(makeTool('list_narratives'));
    expect(tools.length).toBe(1);
    expect(server.listTools().length).toBe(2);
  });

  it('close clears the tool registry', async () => {
    const server = createMcpServer({ workingDir: ABS_WORKING_DIR });
    server.registerTool(makeTool('get_project'));
    expect(server.listTools().length).toBe(1);
    await server.close();
    expect(server.listTools().length).toBe(0);
  });
});
