import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';
import {
  importRootsCallerFor,
  ImportRunService,
  PathOutsideImportRootsError,
  resolveWithinImportRoots,
  sanitizeFilename,
  StagedSourceService,
  uploadsRoot,
} from '@ci/domains/import';
import { UserService } from '@ci/domains/user';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

interface ImportPathInput {
  path?: string;
  label?: string;
}

/**
 * Import an archive the appliance can already see.
 *
 * Upstream this ran the importer synchronously and returned what it produced.
 * Here it cannot: an import is three durable stages across a queue, and a 40GB
 * Takeout does not finish inside a tool call. So this STARTS a run and returns
 * its id, and `import.run_status` is how the caller follows it. That is also why
 * that fourth tool exists at all — upstream had no need for it.
 *
 * The file is staged through the same path an upload takes: COPIED into the
 * uploads directory, registered, then claimed by the run. Copied, not moved —
 * paths under the roots are the user's own files and are never touched — and
 * through the one staging pipeline, because a second way in would be a second
 * thing to keep correct.
 */
@Injectable()
export class ImportPathTool extends BaseTool<ImportPathInput, unknown> {
  readonly schema: IntentDefinition = {
    name: 'import.import_path',
    domain: 'import',
    title: 'Import an export from disk',
    // `write`: this puts records into the user's corpus. Not `destructive` —
    // importing adds, and re-importing the same archive is a no-op — but a
    // dispatcher should still treat it as a real action rather than a lookup.
    privacy: { access: 'write', sensitivity: 'personal', destructive: false, external: false },
    // Starts the server-side pipeline (local staging, ci_import stages) over a path only the
    // appliance can see; a device cannot stand in for any of it.
    localCapable: false,
    phrases: ['Import this export', 'Bring in the archive at $path'],
    description:
      'Start importing an archive the appliance can see on disk. Returns a run id immediately — ' +
      'the import continues in the background across three stages. Use import.run_status to follow ' +
      'it. Re-importing the same archive is safe and creates no duplicates. Only paths in your own ' +
      'import-inbox folder may be imported, plus the configured import roots when you are the ' +
      'appliance administrator.',
    category: 'database',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Absolute path to the archive, within your import-inbox folder or (administrator only) a ' +
            'configured import root.',
        },
        label: {
          type: 'string',
          description: 'Display name for the run. Defaults to the filename.',
        },
      },
      required: ['path'],
    },
  };

  constructor(
    private readonly sources: StagedSourceService,
    private readonly runs: ImportRunService,
    private readonly users: UserService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(ImportPathTool.name);
  }

  protected async executeInternal(context: ToolExecutionContext, input: ImportPathInput) {
    if (!context.userId) {
      throw new Error('An authenticated user is required to import');
    }

    if (!input?.path) {
      throw new Error('path is required');
    }

    // The caller's account scopes which inbox subtree they may read — their
    // own — and only the administrator reaches the configured roots.
    const user = await this.users.findById({ userId: context.userId }, context.userId);

    let resolved: string;

    try {
      resolved = await resolveWithinImportRoots(input.path, importRootsCallerFor(user));
    } catch (err) {
      if (err instanceof PathOutsideImportRootsError) {
        return { started: false, reason: err.message };
      }

      throw err;
    }

    const info = await stat(resolved);

    if (!info.isFile()) {
      // A directory has no single set of bytes to stage. Recognition handles
      // directories; importing one means moving it into the inbox, where the
      // pipeline can own (and consume) the tree.
      return {
        started: false,
        reason:
          `${resolved} is a directory. Point this at the archive file itself, or move the ` +
          `folder into the import inbox and use import.import_inbox.`,
      };
    }

    const filename = path.basename(resolved);
    const dropId = uuidv7();
    const dropDir = path.join(uploadsRoot(), dropId);
    const sourcePath = path.join(dropDir, sanitizeFilename(filename));

    // A copy, never a move: the source is the user's own file under a root.
    // The staged copy is what the run consumes.
    await mkdir(dropDir, { recursive: true });
    await copyFile(resolved, sourcePath);

    await this.sources.registerUpload(
      { userId: context.userId },
      { dropId, sourcePath, originalFilename: filename, sizeBytes: info.size },
    );

    const { run, stages } = await this.runs.startRun(
      { userId: context.userId },
      { dropId, label: input.label ?? filename, source: 'mcp' },
    );

    this.logger.log('Started an import from a path', {
      runId: run.id,
      userId: context.userId,
      path: resolved,
    });

    return {
      started: true,
      runId: run.id,
      label: run.label,
      stages: stages.map((stage) => stage.kind),
      // Said plainly, because the natural next move for a caller is to poll and
      // the natural mistake is to assume the work is already done.
      note: 'The import runs in the background. Follow it with import.run_status.',
    };
  }
}
