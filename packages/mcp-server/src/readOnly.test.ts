import { describe, expect, it } from 'vitest';

import {
  assertReadOnlyTool,
  READ_ONLY_POLICY,
  ReadOnlyPolicyError,
} from './readOnly.js';

describe('assertReadOnlyTool', () => {
  describe('allow-list (positive)', () => {
    it.each([
      'get_project',
      'list_narratives',
      'query_findings',
      'search_topics',
      'count_sessions',
      'describe_schema',
    ])('accepts "%s"', (name) => {
      expect(assertReadOnlyTool(name)).toBe(name);
    });
  });

  describe('forbidden write verbs', () => {
    it.each([
      'write_session',
      'create_narrative',
      'update_project',
      'delete_pattern',
      'remove_finding',
      'set_state',
      'put_topic',
      'patch_session',
      'insert_revision',
      'upsert_narrative',
      'exec_query',
      'run_migration',
      'spawn_subprocess',
      'execute_sql',
      'eval_expression',
    ])('rejects forbidden verb "%s"', (name) => {
      try {
        assertReadOnlyTool(name);
      } catch (e) {
        expect(e).toBeInstanceOf(ReadOnlyPolicyError);
        expect((e as ReadOnlyPolicyError).code).toBe('forbidden-verb');
        return;
      }
      throw new Error(`expected assertReadOnlyTool to throw on "${name}"`);
    });
  });

  describe('unknown verbs (not in either list)', () => {
    it.each(['fetch_project', 'browse_topics', 'show_narratives'])(
      'rejects unknown verb "%s"',
      (name) => {
        try {
          assertReadOnlyTool(name);
        } catch (e) {
          expect(e).toBeInstanceOf(ReadOnlyPolicyError);
          expect((e as ReadOnlyPolicyError).code).toBe('unknown-verb');
          return;
        }
        throw new Error(`expected assertReadOnlyTool to throw on "${name}"`);
      },
    );
  });

  describe('shape validation', () => {
    it('rejects empty + whitespace-only', () => {
      try {
        assertReadOnlyTool('');
      } catch (e) {
        expect((e as ReadOnlyPolicyError).code).toBe('empty-name');
      }
      try {
        assertReadOnlyTool('   ');
      } catch (e) {
        expect((e as ReadOnlyPolicyError).code).toBe('empty-name');
      }
    });

    it('rejects camelCase', () => {
      try {
        assertReadOnlyTool('getProject');
      } catch (e) {
        expect((e as ReadOnlyPolicyError).code).toBe('invalid-shape');
        return;
      }
      throw new Error('expected throw on camelCase');
    });

    it('rejects names without a verb_noun separator', () => {
      try {
        assertReadOnlyTool('getproject');
      } catch (e) {
        expect((e as ReadOnlyPolicyError).code).toBe('invalid-shape');
        return;
      }
      throw new Error('expected throw on missing underscore');
    });

    it('rejects names with non-ASCII alnum characters', () => {
      try {
        assertReadOnlyTool('get_pröject');
      } catch (e) {
        expect((e as ReadOnlyPolicyError).code).toBe('invalid-shape');
        return;
      }
      throw new Error('expected throw on non-ASCII');
    });

    it('rejects names starting with underscore or digit', () => {
      try {
        assertReadOnlyTool('_get_project');
      } catch (e) {
        expect((e as ReadOnlyPolicyError).code).toBe('invalid-shape');
      }
      try {
        assertReadOnlyTool('1get_project');
      } catch (e) {
        expect((e as ReadOnlyPolicyError).code).toBe('invalid-shape');
      }
    });
  });

  describe('embedded write-verb segment-scan (iter-1 hardening)', () => {
    // Adversarial-review hole on PR #93: a prefix-only check
    // accepted `list_then_delete_project` because the prefix
    // `list_` matched and the deny-list only checked position 0.
    // The segment-scan fix tokenizes on `_` and rejects ANY
    // segment that's a forbidden verb root.
    it.each([
      'list_then_delete_project',
      'get_delete_all',
      'list_run_migration',
      'query_eval_expression',
      'get_exec_query',
      'list_spawn_process',
    ])('rejects embedded write-verb in "%s"', (name) => {
      try {
        assertReadOnlyTool(name);
      } catch (e) {
        expect(e).toBeInstanceOf(ReadOnlyPolicyError);
        expect((e as ReadOnlyPolicyError).code).toBe('forbidden-verb');
        return;
      }
      throw new Error(
        `expected segment-scan to reject embedded write verb in "${name}"`,
      );
    });

    it('allows read-verb-only names with multiple noun segments', () => {
      // Sanity: the segment-scan must NOT over-reject names that
      // happen to have ≥2 noun segments and zero write verbs.
      expect(assertReadOnlyTool('get_project_by_id')).toBe(
        'get_project_by_id',
      );
      expect(assertReadOnlyTool('list_recent_narratives')).toBe(
        'list_recent_narratives',
      );
    });

    it('rejects names where the FIRST segment is forbidden (the original prefix case still fires)', () => {
      // Sanity: didn't accidentally regress the original prefix-
      // position behavior while adding embedded-position coverage.
      try {
        assertReadOnlyTool('delete_project');
      } catch (e) {
        expect((e as ReadOnlyPolicyError).code).toBe('forbidden-verb');
        return;
      }
      throw new Error('expected delete_ prefix to still be rejected');
    });
  });

  describe('READ_ONLY_POLICY export', () => {
    it('exposes both lists for reviewer + downstream inspection', () => {
      expect(READ_ONLY_POLICY.readVerbPrefixes).toContain('get_');
      expect(READ_ONLY_POLICY.readVerbPrefixes).toContain('list_');
      expect(READ_ONLY_POLICY.forbiddenVerbPrefixes).toContain('write_');
      expect(READ_ONLY_POLICY.forbiddenVerbPrefixes).toContain('exec_');
    });

    it('is frozen (policy cannot be mutated at runtime)', () => {
      expect(Object.isFrozen(READ_ONLY_POLICY)).toBe(true);
      expect(Object.isFrozen(READ_ONLY_POLICY.readVerbPrefixes)).toBe(true);
      expect(Object.isFrozen(READ_ONLY_POLICY.forbiddenVerbPrefixes)).toBe(
        true,
      );
    });

    it('read and forbidden verb lists are disjoint', () => {
      const reads = new Set(READ_ONLY_POLICY.readVerbPrefixes);
      for (const forbidden of READ_ONLY_POLICY.forbiddenVerbPrefixes) {
        expect(reads.has(forbidden)).toBe(false);
      }
    });
  });
});
