import { type TestingModule } from '@nestjs/testing';
import { type MultiBar } from 'cli-progress';

import { NoteService } from '@ci/domains/notes';

import { NOTES } from './data/notes';
import { JOHN_SMITH } from './data/users';

export async function seedNotes(module: TestingModule, multibar: MultiBar) {
  const noteService = module.get(NoteService);

  const bar = multibar.create(NOTES.length, 0, { task: 'Notes' });

  for (const note of NOTES) {
    const existingNote = await noteService.findById(
      {
        userId: JOHN_SMITH.id,
      },
      note.id,
    );

    if (existingNote == null) {
      await noteService.create(
        {
          userId: JOHN_SMITH.id,
        },
        {
          id: note.id,
          title: note.title,
          content: note.content,
        },
      );
    }

    bar.increment();
  }

  bar.stop();
}
