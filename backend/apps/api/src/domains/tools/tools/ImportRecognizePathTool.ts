import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { importRootsCallerFor, recognizePathWithinRoots } from '@ci/domains/import';
import { UserService } from '@ci/domains/user';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

interface RecognizePathInput {
  path?: string;
}

/**
 * Ask every parser what it makes of a path.
 *
 * This is the one capability the REST surface deliberately does not have. There,
 * an archive is opaque bytes in object storage until a run unpacks it, so
 * recognition reports what the parse stage found. Here the caller already has
 * the files on a disk the appliance can see, so the question can be answered
 * directly — which is what makes an agent able to say "that folder looks like a
 * Google Takeout" before anything is imported.
 *
 * Scoped to the caller's OWN inbox subtree, plus the configured import roots
 * when the caller is the appliance administrator.
 * An unconstrained absolute path over an API is a filesystem read primitive,
 * and "which of these paths exists?" is information on its own — and on a
 * multi-account appliance, so is another user's dropped archive.
 *
 * The work itself is {@link recognizePathWithinRoots}, shared verbatim with
 * `POST /import/recognize` — the tool and the endpoint must never come to
 * different conclusions about the same folder.
 */
@Injectable()
export class ImportRecognizePathTool extends BaseTool<RecognizePathInput, unknown> {
  readonly schema: IntentDefinition = {
    name: 'import.recognize_path',
    domain: 'import',
    title: 'Recognize an export on disk',
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
    // Probes a path on the appliance's disk with the server's importer registry.
    localCapable: false,
    phrases: ['What is in this folder', 'What kind of export is $path'],
    description:
      'Ask every registered importer to inspect a path the appliance can see and report how ' +
      'confident it is that this is its kind of data, highest first. Reads the files but imports ' +
      'nothing. Only paths in your own import-inbox folder may be inspected, plus the configured ' +
      'import roots when you are the appliance administrator.',
    category: 'database',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Absolute path to a file or directory, within your import-inbox folder or (administrator ' +
            'only) a configured import root.',
        },
      },
      required: ['path'],
    },
  };

  constructor(
    private readonly users: UserService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(ImportRecognizePathTool.name);
  }

  protected async executeInternal(context: ToolExecutionContext, input: RecognizePathInput) {
    if (!input?.path) {
      throw new Error('path is required');
    }

    // The caller's account scopes which inbox subtree they may read — their
    // own — and only the administrator reaches the configured roots. No
    // resolvable user means neither: no inbox and no configured roots.
    const user = context.userId
      ? await this.users.findById({ userId: context.userId }, context.userId)
      : null;

    // An out-of-bounds path comes back as `allowed: false` rather than thrown:
    // an agent can act on "not allowed, upload instead", where a tool error
    // reads as a malfunction.
    return recognizePathWithinRoots(input.path, importRootsCallerFor(user));
  }
}
