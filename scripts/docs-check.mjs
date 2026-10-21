#!/usr/bin/env node
/**
 * Documentation & CI workflow drift checker (`make docs-check`).
 *
 * Verifies that normative repository documentation stays synchronized with the
 * live file tree:
 *   1. Relative Markdown links (`[label](path)`) in normative docs resolve to
 *      existing files or directories on disk.
 *   2. `.github/workflows/<name>.yml` references in normative docs resolve to
 *      existing workflow files (excluding explicitly retired historical files).
 *   3. The workflow trigger posture documented in `CLAUDE.md` and `docs/CI.md`
 *      (all workflows gated to `workflow_dispatch`) matches `.github/workflows/*.yml`.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NORMATIVE_DOCS = [
  'CLAUDE.md',
  'AGENTS.md',
  'ARCHITECTURE.md',
  'docs/CI.md',
  'docs/README.md',
  'docs/asks-system-guide.md',
  'docs/qa/ci-gate-proposal.md',
];

/**
 * Workflows that are explicitly documented in history sections as having been
 * deleted (`pr-gate.yml` on 2026-09-17, `video.yml` in #1853).
 */
export const HISTORICAL_DELETED_WORKFLOWS = new Set(['pr-gate.yml', 'video.yml']);

/**
 * External sibling repositories referenced by name in architecture docs.
 */
const EXTERNAL_REPO_PREFIXES = ['CI-Engineering/', 'CI-Local-CICD/', 'CI-Hub/'];

/**
 * Strip fenced code blocks from markdown text so example snippets don't
 * produce false-positive link matches.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function stripCodeFences(markdown) {
  return markdown.replace(/```[\s\S]*?```/g, '');
}

/**
 * Check all relative Markdown links `[text](target)` in a document.
 *
 * @param {string} docRelPath
 * @param {string} content
 * @param {string} rootDir
 * @returns {string[]}
 */
export function checkMarkdownLinks(docRelPath, content, rootDir) {
  const problems = [];
  const docAbsDir = dirname(join(rootDir, docRelPath));
  const stripped = stripCodeFences(content);
  const linkRegex = /!?\[[^\]]*\]\(([^)]+)\)/g;

  for (const match of stripped.matchAll(linkRegex)) {
    const rawTarget = match[1].trim();
    if (
      !rawTarget ||
      rawTarget.startsWith('#') ||
      rawTarget.startsWith('http://') ||
      rawTarget.startsWith('https://') ||
      rawTarget.startsWith('mailto:') ||
      rawTarget.startsWith('file://') ||
      rawTarget.startsWith('conversation://') ||
      rawTarget.startsWith('sidecar://')
    ) {
      continue;
    }

    const targetWithoutTitle = rawTarget.split(/\s+/)[0];
    const cleanPath = targetWithoutTitle.split('#')[0].split('?')[0];
    if (!cleanPath) {
      continue;
    }

    if (EXTERNAL_REPO_PREFIXES.some((prefix) => cleanPath.startsWith(prefix))) {
      continue;
    }

    const resolvedFromDoc = resolve(docAbsDir, cleanPath);
    const resolvedFromRoot = resolve(rootDir, cleanPath);

    if (!existsSync(resolvedFromDoc) && !existsSync(resolvedFromRoot)) {
      problems.push(`${docRelPath}: broken relative link '${cleanPath}'`);
    }
  }

  return problems;
}

/**
 * Check `.github/workflows/<name>.yml` references in a document.
 *
 * @param {string} docRelPath
 * @param {string} content
 * @param {string} rootDir
 * @param {Set<string>} [historicalDeleted]
 * @returns {string[]}
 */
export function checkWorkflowReferences(
  docRelPath,
  content,
  rootDir,
  historicalDeleted = HISTORICAL_DELETED_WORKFLOWS,
) {
  const problems = [];
  const workflowRegex = /\.github\/workflows\/([a-zA-Z0-9._-]+\.yml)/g;

  for (const match of content.matchAll(workflowRegex)) {
    const wfName = match[1];
    if (historicalDeleted.has(wfName)) {
      continue;
    }

    const wfAbs = join(rootDir, '.github/workflows', wfName);
    if (!existsSync(wfAbs)) {
      problems.push(`${docRelPath}: references non-existent workflow '.github/workflows/${wfName}'`);
    }
  }

  return problems;
}

/**
 * Verify that all `.github/workflows/*.yml` files respect the manual-dispatch
 * gating invariant documented in `CLAUDE.md` and `docs/CI.md`.
 *
 * @param {string} rootDir
 * @returns {string[]}
 */
export function checkGatedWorkflowsInvariant(rootDir) {
  const workflowsDir = join(rootDir, '.github/workflows');
  if (!existsSync(workflowsDir)) {
    return [];
  }

  const problems = [];
  const files = readdirSync(workflowsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  const selfTriggerLine = /^[ \t]+(pull_request|push|schedule):/m;

  for (const file of files.sort()) {
    const content = readFileSync(join(workflowsDir, file), 'utf8');
    // Extract the `on:` block up to the next top-level key (`concurrency:`, `env:`, `permissions:`, `jobs:`)
    const onBlockMatch = content.match(/^on:\s*\n([\s\S]*?)(?=^[a-zA-Z_-]+:|Z)/m);
    const onBlock = onBlockMatch ? onBlockMatch[1] : '';
    const uncommentedLines = onBlock
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');

    if (selfTriggerLine.test(uncommentedLines)) {
      problems.push(
        `.github/workflows/${file} has an active self-trigger (pull_request/push/schedule), ` +
          `contradicting CLAUDE.md and docs/CI.md ('all workflows are workflow_dispatch-only').`,
      );
    }
  }

  return problems;
}

/**
 * Run all documentation integrity checks against `rootDir`.
 *
 * @param {{ rootDir?: string, docs?: string[] }} [options]
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function runDocsCheck(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const docs = options.docs ?? NORMATIVE_DOCS;
  const problems = [];

  for (const docRelPath of docs) {
    const absPath = join(rootDir, docRelPath);
    if (!existsSync(absPath)) {
      problems.push(`Missing normative documentation file: ${docRelPath}`);
      continue;
    }

    const content = readFileSync(absPath, 'utf8');
    problems.push(...checkMarkdownLinks(docRelPath, content, rootDir));
    problems.push(...checkWorkflowReferences(docRelPath, content, rootDir));
  }

  problems.push(...checkGatedWorkflowsInvariant(rootDir));

  return {
    ok: problems.length === 0,
    problems,
  };
}

export function runDocsCheckCli(rootDir = process.cwd()) {
  const result = runDocsCheck({ rootDir });
  if (!result.ok) {
    console.error('✗ Documentation integrity check failed:\n');
    for (const problem of result.problems) {
      console.error(`  - ${problem}`);
    }

    console.error('');

    return 1;
  }

  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(runDocsCheckCli());
}
