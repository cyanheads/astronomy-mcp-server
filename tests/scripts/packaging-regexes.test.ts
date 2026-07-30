/**
 * @fileoverview Pins the entry-matching regexes that `scripts/clean-mcpb.ts` and
 *   `scripts/lint-packaging.ts` each declare their own copy of. The strip step and
 *   the check that verifies it must agree exactly: if the strip's pattern is
 *   narrowed, the check silently stops catching what the strip stopped removing,
 *   and a platform-locked or agent-doc-bloated bundle ships green. Both files'
 *   JSDoc points here.
 * @module tests/scripts/packaging-regexes.test
 */

import { describe, expect, it } from 'vitest';
import {
  AGENT_DOC_ENTRY as CLEAN_AGENT_DOC_ENTRY,
  NATIVE_BINDING_ENTRY as CLEAN_NATIVE_BINDING_ENTRY,
  filterAgentDocEntries,
  filterNativeBindingEntries,
} from '../../scripts/clean-mcpb.js';
import {
  AGENT_DOC_ENTRY,
  checkBundleEntries,
  NATIVE_BINDING_ENTRY,
} from '../../scripts/lint-packaging.js';

describe('bundle entry regexes stay in sync across the two scripts', () => {
  it('AGENT_DOC_ENTRY is identical in clean-mcpb and lint-packaging', () => {
    expect(AGENT_DOC_ENTRY.source).toBe(CLEAN_AGENT_DOC_ENTRY.source);
    expect(AGENT_DOC_ENTRY.flags).toBe(CLEAN_AGENT_DOC_ENTRY.flags);
  });

  it('NATIVE_BINDING_ENTRY is identical in clean-mcpb and lint-packaging', () => {
    expect(NATIVE_BINDING_ENTRY.source).toBe(CLEAN_NATIVE_BINDING_ENTRY.source);
    expect(NATIVE_BINDING_ENTRY.flags).toBe(CLEAN_NATIVE_BINDING_ENTRY.flags);
  });
});

describe('bundle entry classification', () => {
  const entries = [
    'dist/index.js',
    'node_modules/@cyanheads/mcp-ts-core/skills/add-tool/SKILL.md',
    'node_modules/some-pkg/.claude/settings.json',
    'node_modules/some-pkg/.agents/skills/x.md',
    'node_modules/some-pkg/SKILL.md',
    'node_modules/@duckdb/node-bindings-darwin-arm64/duckdb.node',
    'node_modules/@duckdb/node-api/lib/index.js',
    'src/skills-are-not-node-modules/SKILL.md',
  ];

  it('matches dependency-shipped agent docs and nothing else', () => {
    expect(filterAgentDocEntries(entries)).toEqual([
      'node_modules/@cyanheads/mcp-ts-core/skills/add-tool/SKILL.md',
      'node_modules/some-pkg/.claude/settings.json',
      'node_modules/some-pkg/.agents/skills/x.md',
      'node_modules/some-pkg/SKILL.md',
    ]);
  });

  it('matches platform-specific native bindings but not the pure-JS wrapper', () => {
    expect(filterNativeBindingEntries(entries)).toEqual([
      'node_modules/@duckdb/node-bindings-darwin-arm64/duckdb.node',
    ]);
  });

  it('reports both classes separately and passes a clean listing', () => {
    const errors = checkBundleEntries(entries, 'test.mcpb');
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('agent-doc entries');
    expect(errors[1]).toContain('native binding entries');
    expect(checkBundleEntries(['dist/index.js'], 'test.mcpb')).toEqual([]);
  });
});
