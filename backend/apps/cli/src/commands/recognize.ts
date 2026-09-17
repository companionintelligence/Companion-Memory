import path from 'node:path';

import { CliError, type CliContext } from '../context';
import { json, table } from '../output';

export interface RecognizeOptions {
  json?: boolean;
}

/**
 * Ask every parser what it makes of a path, without importing anything.
 *
 * The path is resolved on the APPLIANCE, not here — this is a question about
 * the server's disk, and the CLI merely relays it. That distinction matters
 * when the two are not the same filesystem (the API in a container, the CLI on
 * the host): a path that reads fine locally can still be invisible to the
 * appliance, and the refusal says so rather than pretending.
 */
export async function recognizeCommand(
  ctx: CliContext,
  target: string,
  options: RecognizeOptions = {},
): Promise<void> {
  // Resolved locally first only so a relative argument means what the user
  // typed it in; the server resolves and confines it again regardless.
  const result = await ctx.client.recognize(path.resolve(target));

  if (options.json) {
    json(ctx.term, result);

    if (!result.allowed) {
      throw new CliError(result.reason ?? `${target} cannot be read by the appliance`);
    }

    return;
  }

  if (!result.allowed) {
    throw new CliError(
      `${result.reason ?? `${target} cannot be read by the appliance.`}\n` +
        `\nTwo ways forward:\n` +
        `  • put the archive in the import inbox and run \`ci inbox\`\n` +
        `  • or import the file directly with \`ci import ${target}\`, which uploads the\n` +
        `    bytes and needs no configured root at all.`,
    );
  }

  if (result.recognized.length === 0) {
    ctx.term.out(`No importer recognizes ${result.path}.`);
    ctx.term.out(
      `\nThat is not always a dead end: \`ci import\` still stages it, and the parse stage\n` +
        `looks again inside the unpacked tree. Run \`ci datasources --catalog\` to see which\n` +
        `services this appliance knows about.`,
    );

    return;
  }

  const root = result.path ?? '';

  ctx.term.out(
    table(result.recognized, [
      { header: 'dataSource', value: (match) => match.dataSource },
      { header: 'confidence', value: (match) => match.confidence.toFixed(2), align: 'right' },
      { header: 'title', value: (match) => match.title },
      { header: 'matched', value: (match) => relativize(match.matchedPath, root) },
    ]),
  );
  ctx.term.out(`\n${result.recognized.length} match(es) under ${result.path}.`);
}

/**
 * A match's path as it reads under the queried root.
 *
 * The absolute path is the same long prefix on every row, and the whole column
 * is then as wide as that prefix — which pushes the confidence and the name a
 * reader is actually comparing off the side of an 80-column terminal. `.` for
 * the root itself; anything genuinely outside it (there should be none) keeps
 * its absolute form rather than growing a run of `../`.
 */
function relativize(matched: string, root: string): string {
  if (root === '' || matched === root) {
    return '.';
  }

  const relative = path.relative(root, matched);

  return relative === '' || relative.startsWith('..') ? matched : relative;
}
