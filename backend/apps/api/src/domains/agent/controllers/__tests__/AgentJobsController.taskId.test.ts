import type { BadRequestException } from '@nestjs/common';

import { ValidationPipe } from '@ci/common/pipes';

import { createDispatchSchema } from '../AgentJobsController';

/**
 * ═══ WHICH ID FORM DOES THIS ENDPOINT SPEAK? ═══
 *
 * The Dispatch button 400'd before `AgentDispatchService` was ever entered,
 * because the web app sent the GraphQL global id (`base64("task:<uuid>")`) at
 * a body field validated as a uuid. The endpoint's answer is: raw uuids, in
 * and out — `job.taskId` in the response is the `ci.tasks.id`, so the request
 * has to match. The decode belongs on the client
 * (`lib/agentChat.ts:taskUuidFromGlobalId`).
 *
 * This pins that answer, and pins the rejection SAYING it: whichever direction
 * a future change picks, it should have to delete a test to pick it.
 */
describe('POST /v1/agent/jobs — taskId contract', () => {
  const pipe = new ValidationPipe(createDispatchSchema);
  const TASK_UUID = '018f3a2b-4c5d-7e8f-9a0b-1c2d3e4f5061';

  const body = {
    sourceKind: 'Task',
    sourceId: TASK_UUID,
    title: 'Book the dentist',
  };

  function issuesFor(taskId: unknown): Array<{ message: string }> {
    try {
      pipe.transform({ ...body, taskId });
    } catch (error) {
      const response = (error as BadRequestException).getResponse() as {
        errors: Array<{ message: string }>;
      };

      return response.errors;
    }

    throw new Error(`expected ${String(taskId)} to be rejected`);
  }

  it('takes the raw uuid the client decodes to', () => {
    expect(pipe.transform({ ...body, taskId: TASK_UUID })).toMatchObject({ taskId: TASK_UUID });
  });

  it('takes an ask with no task behind it', () => {
    expect(pipe.transform({ ...body, taskId: null })).toMatchObject({ taskId: null });
    expect(pipe.transform(body)).toMatchObject({ title: 'Book the dentist' });
  });

  it('rejects a GraphQL global id, and names it in the reason', () => {
    const globalId = Buffer.from(`task:${TASK_UUID}`).toString('base64');
    const messages = issuesFor(globalId).map((issue) => issue.message);

    expect(messages.join(' ')).toContain('global id');
  });

  it('rejects the title fallback a missing sourceId used to produce', () => {
    expect(issuesFor('Book the dentist')).not.toHaveLength(0);
  });
});
