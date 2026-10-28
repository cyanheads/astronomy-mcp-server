/**
 * @fileoverview Pins the entry-matching regexes that `scripts/clean-mcpb.ts` and
 *   `scripts/lint-packaging.ts` each declare their own copy of. The strip step and
 *   the check that verifies it must agree exactly: if the strip's pattern is
 *   narrowed, the check silently stops catching what the strip stopped removing,
 *   and a platform-locked or agent-doc-bloated bundle ships green. Both files'
 *   `AGENT_DOC_ENTRY` JSDoc points here.
 * @module tests/scripts/packaging-regexes.test
 */

import { describe, expect, it } from 'vitest';
import {
  AGENT_DOC_ENTRY as CLEAN_AGENT_DOC_ENTRY,
  BUILD_ONLY_ENTRY as CLEAN_BUILD_ONLY_ENTRY,
  NATIVE_BINDING_ENTRY as CLEAN_NATIVE_BINDING_ENTRY,
  NODE_GYP_OUTPUT as CLEAN_NODE_GYP_OUTPUT,
  filterAgentDocEntries,
  filterNativeBindingEntries,
} from '../../scripts/clean-mcpb.js';

/** The `scripts/lint-packaging.ts` exports this suite reads. */
interface LintPackagingModule {
  AGENT_DOC_ENTRY: RegExp;
  BUILD_ONLY_ENTRY: RegExp;
  checkBundleEntries: (entries: string[], bundleLabel: string) => string[];
  NATIVE_BINDING_ENTRY: RegExp;
  NODE_GYP_OUTPUT: RegExp;
}

/**
 * Loaded by URL at run time rather than through a static import. The script's
 * validator fallback imports `../src/mcp-server/skills.js`, a path that exists
 * only in the mcp-ts-core repository, so a static import pulls the script into
 * this project's `tsc` program and fails the typecheck
 * (cyanheads/mcp-ts-core#797). The shape assertions below stand in for the
 * type check the import no longer gets.
 */
const lint = (await import(
  new URL('../../scripts/lint-packaging.ts', import.meta.url).href
)) as LintPackagingModule;

describe('lint-packaging exports the members this suite reads', () => {
  it('has the regexes and the bundle check', () => {
    for (const regex of [
      lint.AGENT_DOC_ENTRY,
      lint.BUILD_ONLY_ENTRY,
      lint.NATIVE_BINDING_ENTRY,
      lint.NODE_GYP_OUTPUT,
    ]) {
      expect(regex).toBeInstanceOf(RegExp);
    }
    expect(lint.checkBundleEntries).toBeTypeOf('function');
  });
});

describe('bundle entry regexes stay in sync across the two scripts', () => {
  it.each([
    ['AGENT_DOC_ENTRY', lint.AGENT_DOC_ENTRY, CLEAN_AGENT_DOC_ENTRY],
    ['NATIVE_BINDING_ENTRY', lint.NATIVE_BINDING_ENTRY, CLEAN_NATIVE_BINDING_ENTRY],
    ['NODE_GYP_OUTPUT', lint.NODE_GYP_OUTPUT, CLEAN_NODE_GYP_OUTPUT],
    ['BUILD_ONLY_ENTRY', lint.BUILD_ONLY_ENTRY, CLEAN_BUILD_ONLY_ENTRY],
  ])('%s is identical in clean-mcpb and lint-packaging', (_name, linted, cleaned) => {
    expect(linted.source).toBe(cleaned.source);
    expect(linted.flags).toBe(cleaned.flags);
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
    const errors = lint.checkBundleEntries(entries, 'test.mcpb');
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('agent-doc entries');
    expect(errors[1]).toContain('native binding entries');
    expect(lint.checkBundleEntries(['dist/index.js'], 'test.mcpb')).toEqual([]);
  });
});

describe('agent-doc trees match at a package root only (cyanheads/mcp-ts-core#794)', () => {
  /** SDK runtime modules the server imports at startup; stripping them fails the bundle. */
  const runtime = [
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
    'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
    'node_modules/@cyanheads/mcp-ts-core/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
    'node_modules/some-pkg/lib/skills/loader.js',
    'node_modules/some-pkg/dist/.claude/hooks.js',
  ];

  /** Agent docs at a dependency's package root, scoped or not, at any nesting depth. */
  const agentDocs = [
    'node_modules/some-pkg/skills/guide/reference.md',
    'node_modules/some-pkg/framework-skills/add-tool/references/x.md',
    'node_modules/@scope/pkg/skills/guide/notes.txt',
    'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
    'node_modules/a/node_modules/@scope/b/.claude/settings.json',
    'node_modules/a/node_modules/b/.agents/x.md',
    'node_modules/a/node_modules/b/skills/y.md',
  ];

  it('keeps nested runtime skills/ modules in both scripts', () => {
    expect(filterAgentDocEntries(runtime)).toEqual([]);
    expect(runtime.filter((entry) => lint.AGENT_DOC_ENTRY.test(entry))).toEqual([]);
    expect(lint.checkBundleEntries(runtime, 'test.mcpb')).toEqual([]);
  });

  it('still strips package-root skills/, framework-skills/, .claude/, and .agents/', () => {
    expect(filterAgentDocEntries(agentDocs)).toEqual(agentDocs);
    expect(agentDocs.filter((entry) => lint.AGENT_DOC_ENTRY.test(entry))).toEqual(agentDocs);
  });
});
