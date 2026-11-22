import fs from 'fs';
import os from 'os';
import path from 'path';

import '..';
import { ChatGPTFileImporter } from '../chatgpt';
import { ClaudeFileImporter } from '../claude';
import { dataSourcesRecognize } from '../registry';
import type { Graph, ImportParams, Relationship } from '../timeline';

import type { EmittedGraph, TestPipeline } from './support/emitted';
import { metaText, metaAttachments } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const CLAUDE_DIR = path.join(FIXTURES_DIR, 'claude-export');
const CLAUDE_FILE = path.join(CLAUDE_DIR, 'conversations.json');
const CHATGPT_DIR = path.join(FIXTURES_DIR, 'chatgpt-export');

function run(entry: { filename: string; fullPath: string }) {
  const fi = new ClaudeFileImporter();
  const pipeline: EmittedGraph[] = [];

  return fi
    .fileImport({}, entry, { pipeline, timeframe: {}, log: () => {} } as unknown as ImportParams)
    .then(() => pipeline);
}

describe('Claude datasource', () => {
  it('recognizes the conversations.json file', async () => {
    const fi = new ClaudeFileImporter();
    const rec = await fi.recognize({}, { filename: 'conversations.json', fullPath: CLAUDE_FILE });
    expect(rec.confidence).toBeGreaterThan(0.9);
  });

  it('recognizes a directory containing conversations.json', async () => {
    const fi = new ClaudeFileImporter();
    const rec = await fi.recognize({}, { filename: 'claude-export', fullPath: CLAUDE_DIR });
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('imports human and assistant messages as message items', async () => {
    const pipeline = await run({ filename: 'claude-export', fullPath: CLAUDE_DIR });
    const messages = pipeline.filter((p) => p.item.classification === 'message');
    // 2 conversations × 2 messages each = 4 (msg-3 has empty text but a content[] block)
    expect(messages.length).toBe(4);
  });

  it('imports saved memories from a sibling memories.json as note items', async () => {
    const pipeline = await run({ filename: 'claude-export', fullPath: CLAUDE_DIR });
    const notes = pipeline.filter((p) => p.item.classification === 'note');
    expect(notes.length).toBe(2);
    expect(notes.every((p) => p.item.metadata.Source === 'Claude')).toBe(true);
    expect(notes.every((p) => p.item.metadata.Kind === 'memory')).toBe(true);

    const eng = notes.find((p) => metaText(p.item.metadata.Text).includes('data engineer'));
    expect(eng!.item.id).toBe('claude:memory:3f2a9c1e-0001-4d6b-9a1f-52e10a77c001');
    expect(eng!.item.timestamp).toEqual(new Date('2026-03-05T12:00:00.000Z'));
    expect(eng!.item.metadata.Updated).toEqual(new Date('2026-03-10T08:30:00.000Z'));

    // `summary` is an accepted text field; category carried through
    const pi = notes.find((p) => metaText(p.item.metadata.Text).includes('Raspberry Pi'));
    expect(pi).toBeDefined();
    expect(pi!.item.metadata.Category).toBe('projects');
  });

  it('recognizes a memory-only export directory (memories.json + users.json)', async () => {
    const dir = path.join(FIXTURES_DIR, 'claude-memory-export');
    const fi = new ClaudeFileImporter();
    const rec = await fi.recognize({}, { filename: 'claude-memory-export', fullPath: dir });
    expect(rec.confidence).toBeGreaterThan(0.8);

    const pipeline = await run({ filename: 'claude-memory-export', fullPath: dir });
    expect(pipeline.length).toBe(2);
    expect(pipeline.every((p) => p.item.classification === 'note')).toBe(true);
  });

  it('imports the aggregate conversations_memory profile as one note per section', async () => {
    // Mirrors the current (2026) claude.ai export: memories.json is
    // [{ conversations_memory: "<markdown blob>", account_uuid }] with
    // **Section** header lines, next to users.json.
    const dir = path.join(FIXTURES_DIR, 'claude-profile-memory-export');
    const fi = new ClaudeFileImporter();
    const rec = await fi.recognize({}, { filename: 'claude-profile-memory-export', fullPath: dir });
    expect(rec.confidence).toBeGreaterThan(0.8);

    const pipeline = await run({ filename: 'claude-profile-memory-export', fullPath: dir });
    expect(pipeline.every((p) => p.item.classification === 'note')).toBe(true);
    expect(pipeline.every((p) => p.item.metadata.Kind === 'memory')).toBe(true);
    const titles = pipeline.map((p) => p.item.metadata.Title).sort();
    expect(titles).toEqual([
      'Brief history',
      'Other instructions',
      'Personal context',
      'Top of mind',
      'Work context',
    ]);

    // Section heading becomes Title + Category and is stripped from the body;
    // the id keys off account uuid + section slug so re-importing an edited
    // profile supersedes the old notes instead of accumulating snapshots.
    const work = pipeline.find((p) => p.item.metadata.Title === 'Work context');
    expect(work!.item.id).toBe('claude:memory:0f3c5a7e-2222-4000-9000-00000000abcd:work-context');
    expect(work!.item.metadata.Category).toBe('Work context');
    expect(work!.item.metadata.Text).toContain('Contoso Example Corp');
    expect(work!.item.metadata.Text).not.toContain('**Work context**');
  });

  it('recognizes a standalone Claude-shaped memories.json file', async () => {
    const fi = new ClaudeFileImporter();
    const rec = await fi.recognize(
      {},
      {
        filename: 'memories.json',
        fullPath: path.join(CLAUDE_DIR, 'memories.json'),
      },
    );
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('does NOT recognize a ChatGPT-shaped memories.json (epoch timestamps)', async () => {
    const fi = new ClaudeFileImporter();
    const recFile = await fi.recognize(
      {},
      {
        filename: 'memories.json',
        fullPath: path.join(CHATGPT_DIR, 'memories.json'),
      },
    );
    expect(recFile.confidence).toBe(0);
    const recDir = await fi.recognize(
      {},
      {
        filename: 'chatgpt-memory-export',
        fullPath: path.join(FIXTURES_DIR, 'chatgpt-memory-export'),
      },
    );
    expect(recDir.confidence).toBe(0);
  });

  it('memory import is idempotent (re-import yields identical ids)', async () => {
    const first = await run({ filename: 'claude-export', fullPath: CLAUDE_DIR });
    const again = await run({ filename: 'claude-export', fullPath: CLAUDE_DIR });
    expect(again.map((p) => p.item.id!)).toEqual(first.map((p) => p.item.id!));
    expect(new Set(first.map((p) => p.item.id!)).size).toBe(first.length);
  });

  it('maps sender to Role and sets Source + Conversation metadata', async () => {
    const pipeline = await run({ filename: 'conversations.json', fullPath: CLAUDE_FILE });
    expect(pipeline[0].item.metadata.Role).toBe('user'); // human → user
    expect(pipeline[0].item.metadata.Direction).toBe('outgoing');
    expect(pipeline[0].item.metadata.Source).toBe('Claude');
    expect(pipeline[0].item.metadata.Conversation).toBe('Brainstorming names');
    expect(pipeline[1].item.metadata.Role).toBe('assistant');
    expect(pipeline[1].item.metadata.Direction).toBe('incoming');
    expect(pipeline[0].item.timestamp).toBeInstanceOf(Date);
  });

  it('falls back to content[] text blocks when text is empty', async () => {
    const pipeline = await run({ filename: 'conversations.json', fullPath: CLAUDE_FILE });
    const recursionMsg = pipeline.find(
      (p) => p.item.metadata.Conversation === 'Explaining recursion' && p.item.metadata.Role === 'user',
    );
    expect(recursionMsg).toBeDefined();
    const data = await recursionMsg!.item.content.data!();
    expect(data.toString()).toBe('Explain recursion simply.');
  });

  it('does NOT recognize the ChatGPT fixture (disambiguation)', async () => {
    const fi = new ClaudeFileImporter();
    const recFile = await fi.recognize(
      {},
      {
        filename: 'conversations.json',
        fullPath: path.join(CHATGPT_DIR, 'conversations.json'),
      },
    );
    expect(recFile.confidence).toBe(0);
    const recDir = await fi.recognize({}, { filename: 'chatgpt-export', fullPath: CHATGPT_DIR });
    expect(recDir.confidence).toBe(0);
  });

  it('and ChatGPTFileImporter does NOT recognize the Claude fixture', async () => {
    const fi = new ChatGPTFileImporter();
    const recFile = await fi.recognize({}, { filename: 'conversations.json', fullPath: CLAUDE_FILE });
    expect(recFile.confidence).toBe(0);
    const recDir = await fi.recognize({}, { filename: 'claude-export', fullPath: CLAUDE_DIR });
    expect(recDir.confidence).toBe(0);
  });

  it('malformed input does not throw', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-bad-'));
    const fpath = path.join(dir, 'conversations.json');
    fs.writeFileSync(fpath, '\x00\x01\x02 not json at all }}}');
    const fi = new ClaudeFileImporter();
    await expect(
      fi.recognize({}, { filename: 'conversations.json', fullPath: fpath }),
    ).resolves.toBeDefined();
    const pipeline = await run({ filename: 'conversations.json', fullPath: fpath });
    expect(pipeline.length).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('assigns a unique, stable id to every message so same-second messages do not collapse', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dedup-'));
    const fpath = path.join(dir, 'conversations.json');
    // Two messages sharing the exact same created_at second (and the constant
    // 'message.txt' filename) would collapse under the timestamp-only dedup hash.
    fs.writeFileSync(
      fpath,
      JSON.stringify([
        {
          uuid: 'conv-a',
          name: 'Same second',
          chat_messages: [
            { uuid: 'm-a1', text: 'first', sender: 'human', created_at: '2024-03-01T09:00:00Z' },
            { uuid: 'm-a2', text: 'second', sender: 'assistant', created_at: '2024-03-01T09:00:00Z' },
            // No uuid → must fall back to a conversation+index id, still unique.
            { text: 'third', sender: 'human', created_at: '2024-03-01T09:00:00Z' },
          ],
        },
      ]),
    );

    const pipeline = await run({ filename: 'conversations.json', fullPath: fpath });
    expect(pipeline.length).toBe(3);
    const ids = pipeline.map((p) => p.item.id!);
    expect(ids.every((id) => !!id)).toBe(true); // (a) every id truthy
    expect(new Set(ids).size).toBe(pipeline.length); // (b) all unique

    // (c) re-import yields identical ids (idempotent)
    const again = await run({ filename: 'conversations.json', fullPath: fpath });
    expect(again.map((p) => p.item.id!)).toEqual(ids);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  // The conversation UUID, not its name: a claude.ai conversation can be
  // renamed and an untitled one has no name at all, so the uuid is the stable
  // thread key — and mediaForMessage already stamped it that way. The message
  // path stamped only `Conversation`, so its rows reached
  // ci.communications.thread_id with no key at all (4 NULL rows on the live
  // database) and disagreed with the media items from the same conversation.
  it('threads every message in a conversation on the conversation uuid, not its renameable name', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-thread-'));
    const fpath = path.join(dir, 'conversations.json');
    fs.writeFileSync(
      fpath,
      JSON.stringify([
        {
          uuid: 'conv-threaded',
          name: 'A name the user can change',
          chat_messages: [
            { uuid: 'm-1', text: 'first', sender: 'human', created_at: '2024-03-01T09:00:00Z' },
            { uuid: 'm-2', text: 'second', sender: 'assistant', created_at: '2024-03-01T09:00:01Z' },
          ],
        },
        {
          uuid: 'conv-untitled',
          chat_messages: [
            { uuid: 'm-3', text: 'alone', sender: 'human', created_at: '2024-03-01T10:00:00Z' },
          ],
        },
      ]),
    );

    const pipeline = await run({ filename: 'conversations.json', fullPath: fpath });
    const threadOf = (id: string): unknown => pipeline.find((p) => p.item.id === id)!.item.metadata!.ThreadId;

    expect(threadOf('m-1')).toBe('conv-threaded');
    expect(threadOf('m-2')).toBe('conv-threaded');
    // An untitled conversation has no name to fall back on — the uuid is the
    // only thread key it will ever have.
    expect(threadOf('m-3')).toBe('conv-untitled');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('empty input yields no items', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-empty-'));
    const fpath = path.join(dir, 'conversations.json');
    fs.writeFileSync(fpath, '[]');
    const pipeline = await run({ filename: 'conversations.json', fullPath: fpath });
    expect(pipeline.length).toBe(0);
    const fi = new ClaudeFileImporter();
    const rec = await fi.recognize({}, { filename: 'conversations.json', fullPath: fpath });
    expect(rec.confidence).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('Claude media extraction', () => {
  const MEDIA_DIR = path.join(FIXTURES_DIR, 'claude-media-export');

  function runMedia() {
    const fi = new ClaudeFileImporter();
    const pipeline: EmittedGraph[] = [];
    const drops: [string, string?][] = [];
    (pipeline as TestPipeline).drop = (reason: string, detail?: string) => drops.push([reason, detail]);

    return fi
      .fileImport({}, { filename: 'claude-media-export', fullPath: MEDIA_DIR }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams)
      .then(() => ({ pipeline, drops }));
  }

  it('recognizes the media-export directory as a Claude export', async () => {
    const fi = new ClaudeFileImporter();
    const rec = await fi.recognize({}, { filename: 'claude-media-export', fullPath: MEDIA_DIR });
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('attaches an on-disk file reference to its message as a MediaAttachments descriptor', async () => {
    const { pipeline } = await runMedia();
    const msg = pipeline.find((p) => p.item.id === 'cm-1');
    expect(msg).toBeDefined();
    // No attachment sub-item edge — that used to mint a duplicate ci.events row.
    expect(msg!.edges).toBeUndefined();
    const atts = metaAttachments(msg!.item.metadata.MediaAttachments);
    expect(atts).toHaveLength(1);
    expect(atts[0].filename).toBe('sunset.png');
    expect(atts[0].type).toBe('image');
    expect(atts[0].mimetype).toBe('image/png');
    expect(atts[0].path.endsWith('sunset.png')).toBe(true);
    expect(fs.readFileSync(atts[0].path).length).toBeGreaterThan(0);
  });

  it('imports a media-only message (no text) as a standalone media item', async () => {
    const { pipeline } = await runMedia();
    const solo = pipeline.find((p) => p.item.id === 'claude:media:files/beach.png');
    expect(solo).toBeDefined();
    expect(solo!.edges).toBeUndefined();
    expect(solo!.item.classification).toBe('media');
    // the empty-text message itself is not emitted
    expect(pipeline.find((p) => p.item.id === 'cm-2')).toBeUndefined();
  });

  it('ledgers a missing media reference and skips non-media attachments silently', async () => {
    const { pipeline, drops } = await runMedia();
    // missing.jpg looks like media but is not on disk → ledgered
    expect(drops).toContainEqual(['media_asset_missing', 'missing.jpg']);
    // notes.txt (extracted-content attachment) is out of scope: no drop for it
    expect(drops.some((d) => d[1] === 'notes.txt')).toBe(false);
    const withText = pipeline.find((p) => p.item.id === 'cm-3');
    expect(withText!.edges).toBeUndefined();
    const withMissing = pipeline.find((p) => p.item.id === 'cm-4');
    expect(withMissing!.edges).toBeUndefined();
  });

  it('media import is idempotent (re-import yields identical ids)', async () => {
    const first = await runMedia();
    const again = await runMedia();
    const ids = (g: Graph) => [g.item!.id, ...(g.edges ?? []).map((e: Relationship) => e.to.item!.id)];
    expect(again.pipeline.flatMap(ids)).toEqual(first.pipeline.flatMap(ids));
  });

  it('a text-only export emits no media items and no drops', async () => {
    const fi = new ClaudeFileImporter();
    const pipeline: EmittedGraph[] = [];
    const drops: unknown[] = [];
    (pipeline as TestPipeline).drop = (...d: unknown[]) => drops.push(d);
    await fi.fileImport({}, { filename: 'claude-export', fullPath: CLAUDE_DIR }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);
    expect(pipeline.some((p) => p.item.classification === 'media')).toBe(false);
    expect(drops).toEqual([]);
  });

  it('a file_name that path-traverses outside the export root is not resolved, even when the target exists on disk', async () => {
    // Proves the insideRoot guard in resolveAsset is load-bearing rather than
    // incidentally passing: a real file sits just outside the export root, at
    // exactly the path an unguarded path.join(root, '../decoy/secret.png')
    // would land on. Without the guard this attaches an arbitrary file from
    // outside the export as a 'media' item.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-traversal-'));
    const decoyDir = path.join(tmp, 'decoy');
    fs.mkdirSync(decoyDir);
    fs.writeFileSync(path.join(decoyDir, 'secret.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const exportDir = path.join(tmp, 'export');
    fs.mkdirSync(exportDir);
    fs.writeFileSync(
      path.join(exportDir, 'conversations.json'),
      JSON.stringify([
        {
          uuid: 'conv-traversal',
          name: 'Traversal attempt',
          chat_messages: [
            {
              uuid: 'cm-traversal',
              text: 'exfil attempt',
              sender: 'human',
              created_at: '2026-05-01T10:00:00Z',
              files: [{ file_name: '../decoy/secret.png' }],
            },
          ],
        },
      ]),
    );

    const fi = new ClaudeFileImporter();
    const pipeline: EmittedGraph[] = [];
    const drops: [string, string?][] = [];
    (pipeline as TestPipeline).drop = (reason: string, detail?: string) => drops.push([reason, detail]);
    await fi.fileImport({}, { filename: 'export', fullPath: exportDir }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    // The message has text, so a resolved attachment would show up as an edge
    // on the message item (see 'attaches an on-disk file reference...' above)
    // — not as a standalone top-level pipeline entry. Assert on the edge, not
    // a top-level media scan, or this test passes even if resolution silently
    // succeeds via the wrong candidate.
    const msg = pipeline.find((p) => p.item.id === 'cm-traversal');
    expect(msg).toBeDefined();
    expect(msg!.edges).toBeUndefined();
    expect(pipeline.some((p) => p.item.classification === 'media')).toBe(false);
    expect(drops).toContainEqual(['media_asset_missing', '../decoy/secret.png']);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('Claude project extraction', () => {
  const PROJECT_DIR = path.join(FIXTURES_DIR, 'claude-project-export');

  it('still recognizes the directory as a Claude export (ownership stays with conversations.json)', async () => {
    const fi = new ClaudeFileImporter();
    const rec = await fi.recognize({}, { filename: 'claude-project-export', fullPath: PROJECT_DIR });
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('imports a sibling projects/<uuid>.json as a note item, not silently dropped', async () => {
    const pipeline = await run({ filename: 'claude-project-export', fullPath: PROJECT_DIR });
    const projects = pipeline.filter((p) => p.item.metadata.Kind === 'project');
    expect(projects.length).toBe(1);

    const item = projects[0].item;
    expect(item.classification).toBe('note');
    expect(item.metadata.Source).toBe('Claude');
    expect(item.metadata.Title).toBe('Book Club Reading List');
    expect(item.id).toBe('claude:project:5b1e2f3a-0001-4c9d-8a2e-1f9b6d7c0abc');
    expect(item.timestamp).toEqual(new Date('2026-03-22T11:05:00.000Z')); // updated_at wins over created_at

    // Body carries description + prompt_template ("Instructions") + every doc's content.
    const text = item.metadata.Text as string;
    expect(text).toContain('Track what our book club is reading');
    expect(text).toContain('Instructions:');
    expect(text).toContain('avoid spoilers unless the user explicitly asks');
    expect(text).toContain('reading-list.md');
    expect(text).toContain('Klara and the Sun');
    expect(text).toContain('discussion-notes.md');
    expect(text).toContain('March meeting');

    // Content stream mirrors the metadata text.
    const bytes = await item.content.data!();
    expect(bytes.toString()).toBe(text);
  });

  it('conversations from the same export still import alongside the project', async () => {
    const pipeline = await run({ filename: 'claude-project-export', fullPath: PROJECT_DIR });
    const messages = pipeline.filter((p) => p.item.classification === 'message');
    expect(messages.length).toBe(2);
  });

  it('project import is idempotent (re-import yields identical ids)', async () => {
    const first = await run({ filename: 'claude-project-export', fullPath: PROJECT_DIR });
    const again = await run({ filename: 'claude-project-export', fullPath: PROJECT_DIR });
    expect(again.map((p) => p.item.id!)).toEqual(first.map((p) => p.item.id!));
  });

  it('falls back to the filename stem for id when a project has no uuid, and skips unparseable/empty entries without throwing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-project-'));
    fs.writeFileSync(path.join(dir, 'conversations.json'), '[]');
    const projectsDir = path.join(dir, 'projects');
    fs.mkdirSync(projectsDir);
    // No `uuid` field: falls back to the file's own name as a stable id.
    fs.writeFileSync(
      path.join(projectsDir, 'no-uuid-project.json'),
      JSON.stringify({ name: 'Untitled Experiment', description: 'A project with no uuid field.' }),
    );
    // Not valid JSON at all.
    fs.writeFileSync(path.join(projectsDir, 'corrupt.json'), '{not json');
    // Valid JSON but nothing recognizable as a project (no name, no content).
    fs.writeFileSync(path.join(projectsDir, 'unrelated.json'), JSON.stringify({ foo: 'bar' }));
    // A non-.json file in the directory must be ignored, not crash the import.
    fs.writeFileSync(path.join(projectsDir, 'README.txt'), 'not a project');

    const fi = new ClaudeFileImporter();
    const pipeline: EmittedGraph[] = [];
    await expect(
      fi.fileImport({}, { filename: 'proj', fullPath: dir }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams),
    ).resolves.toBeUndefined();

    const projects = pipeline.filter((p) => p.item.metadata.Kind === 'project');
    expect(projects.length).toBe(1);
    expect(projects[0].item.id).toBe('claude:project:no-uuid-project');
    expect(projects[0].item.metadata.Title).toBe('Untitled Experiment');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is defensive about doc shape: docs missing content are skipped, doc title falls back through filename/name/title', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-project-docs-'));
    fs.writeFileSync(path.join(dir, 'conversations.json'), '[]');
    const projectsDir = path.join(dir, 'projects');
    fs.mkdirSync(projectsDir);
    fs.writeFileSync(
      path.join(projectsDir, 'proj-1.json'),
      JSON.stringify({
        uuid: 'proj-1',
        name: 'Shape Tolerance Test',
        docs: [
          { filename: 'notes.md', content: 'has both filename and content' },
          { name: 'named-doc', text: 'content lives under text, not content' },
          { title: 'titled-doc', content: 'title used when filename/name absent' },
          { content: 'no title at all' },
          { filename: 'empty.md' }, // no content/text at all → skipped
          null, // malformed entry → skipped, does not throw
        ],
      }),
    );

    const fi = new ClaudeFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'proj', fullPath: dir }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const projects = pipeline.filter((p) => p.item.metadata.Kind === 'project');
    expect(projects.length).toBe(1);
    const text = projects[0].item.metadata.Text as string;
    expect(text).toContain('has both filename and content');
    expect(text).toContain('content lives under text, not content');
    expect(text).toContain('title used when filename/name absent');
    expect(text).toContain('no title at all');
    expect(text).not.toContain('empty.md');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('Claude: a whole export reaches the importer', () => {
  let root: string;

  const write = (rel: string, body: unknown): void => {
    const fpath = path.join(root, rel);
    fs.mkdirSync(path.dirname(fpath), { recursive: true });
    fs.writeFileSync(fpath, JSON.stringify(body));
  };

  const conversation = (attachments: unknown[] = []) => ({
    uuid: 'conv-1',
    name: 'Fern on the north wall',
    chat_messages: [
      {
        uuid: 'msg-1',
        text: 'And this planting plan, does it make sense?',
        sender: 'human',
        created_at: '2026-10-06T08:31:30.000000Z',
        attachments,
        files: [],
      },
    ],
  });

  const project = {
    uuid: 'proj-1',
    name: 'Garden wall ferns',
    description: 'What grows on the north wall',
    prompt_template: 'Keep answers short.',
    created_at: '2026-10-06T08:40:00.000000Z',
    updated_at: '2026-10-06T08:40:00.000000Z',
    docs: [{ uuid: 'doc-1', filename: 'fern-list.txt', content: "hart's-tongue, wall rue" }],
  };

  beforeEach(() => {
    // The export unzips into a folder named after the archive.
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-whole-export-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('recognizes the export folder, not conversations.json inside it, so projects/ is read', async () => {
    const exportDir = path.join(root, 'data-2026-11-19-21-41-07-batch-0000');
    write('data-2026-11-19-21-41-07-batch-0000/conversations.json', [conversation()]);
    write('data-2026-11-19-21-41-07-batch-0000/memories.json', [
      { conversations_memory: '**Top of mind**\n\nFinishing the talk.', account_uuid: 'acct-1' },
    ]);
    write('data-2026-11-19-21-41-07-batch-0000/projects/proj-1.json', project);

    const matches = await dataSourcesRecognize(
      undefined,
      { filename: path.basename(root), fullPath: root, fsRoot: root },
      {},
      { descend: true },
    );
    const claude = matches.filter((m) => m.data_source.name === 'claude');

    // One match, on the folder: conversations.json and memories.json are inside it.
    expect(claude.map((m) => m.matchedPath)).toEqual([exportDir]);

    const pipeline = await run({ filename: path.basename(exportDir), fullPath: exportDir });
    expect(
      pipeline.filter((p) => p.item.metadata.Kind === 'project').map((p) => p.item.metadata.Title),
    ).toEqual(['Garden wall ferns']);
    expect(pipeline.filter((p) => p.item.metadata.Kind === 'memory')).toHaveLength(1);
  });

  it('imports Projects from a single projects.json array', async () => {
    write('conversations.json', [conversation()]);
    write('projects.json', [
      project,
      { name: 'No uuid project', docs: [{ filename: 'a.md', content: 'alpha' }] },
      7,
    ]);

    const first = (await run({ filename: path.basename(root), fullPath: root })).filter(
      (p) => p.item.metadata.Kind === 'project',
    );
    expect(first.map((p) => p.item.metadata.Title)).toEqual(['Garden wall ferns', 'No uuid project']);
    expect(first[0].item.id).toBe('claude:project:proj-1');
    expect(first[0].item.metadata.Text).toContain('fern-list.txt');
    // A project without a uuid is keyed on its content, the same on every import.
    expect(first[1].item.id).toMatch(/^claude:project:[0-9a-f]{24}$/);
    const again = (await run({ filename: path.basename(root), fullPath: root })).filter(
      (p) => p.item.metadata.Kind === 'project',
    );
    expect(again.map((p) => p.item.id)).toEqual(first.map((p) => p.item.id));
  });

  it('adds the text Claude extracted from an attachment to the message', async () => {
    write('conversations.json', [
      conversation([
        {
          file_name: 'planting-plan.txt',
          file_type: 'text/plain',
          extracted_content: "North wall: hart's-tongue x3, maidenhair spleenwort x5, wall rue x2.",
        },
        { file_name: 'empty.txt', file_type: 'text/plain', extracted_content: '' },
      ]),
    ]);

    const [message] = await run({ filename: path.basename(root), fullPath: root });
    expect(message.item.id).toBe('msg-1');
    expect(message.item.metadata.Text).toBe(
      "And this planting plan, does it make sense?\n\n--- planting-plan.txt ---\nNorth wall: hart's-tongue x3, maidenhair spleenwort x5, wall rue x2.",
    );
  });

  it('keeps a message that has only an attachment', async () => {
    const conv = conversation([{ file_name: 'notes.txt', extracted_content: 'Buy lime mortar.' }]);
    conv.chat_messages[0].text = '';
    write('conversations.json', [conv]);

    const pipeline = await run({ filename: path.basename(root), fullPath: root });
    expect(pipeline.map((p) => p.item.metadata.Text)).toEqual(['--- notes.txt ---\nBuy lime mortar.']);
  });

  const recognizeTree = () =>
    dataSourcesRecognize(
      undefined,
      { filename: path.basename(root), fullPath: root, fsRoot: root },
      {},
      { descend: true },
    );

  it('leaves loose files beside conversations.json to the catch-all importer', async () => {
    write('conversations.json', [conversation()]);
    fs.writeFileSync(path.join(root, 'holiday.jpg'), 'not really a photo');

    const matches = await recognizeTree();
    // The file, not the folder: a claim on the folder would drop holiday.jpg.
    expect(matches.filter((m) => m.data_source.name === 'claude').map((m) => m.matchedPath)).toEqual([
      path.join(root, 'conversations.json'),
    ]);
  });

  it('keeps the export folder when it carries a JSON file the importer does not know', async () => {
    write('conversations.json', [conversation()]);
    write('artifacts.json', []);
    write('projects.json', [project]);

    const matches = await recognizeTree();
    expect(matches.filter((m) => m.data_source.name === 'claude').map((m) => m.matchedPath)).toEqual([root]);
  });

  it('reads projects beside memories when the export has no conversations', async () => {
    const exportDir = path.join(root, 'data-2026-11-19-batch-0000');
    write('data-2026-11-19-batch-0000/conversations.json', []);
    write('data-2026-11-19-batch-0000/memories.json', [
      { conversations_memory: '**Top of mind**\n\nFinishing the talk.', account_uuid: 'acct-1' },
    ]);
    write('data-2026-11-19-batch-0000/projects.json', [project]);
    write('data-2026-11-19-batch-0000/users.json', [{ uuid: 'acct-1' }]);

    const matches = await recognizeTree();
    expect(matches.filter((m) => m.data_source.name === 'claude').map((m) => m.matchedPath)).toEqual([
      exportDir,
    ]);

    const pipeline = await run({ filename: path.basename(exportDir), fullPath: exportDir });
    expect(
      pipeline.filter((p) => p.item.metadata.Kind === 'project').map((p) => p.item.metadata.Title),
    ).toEqual(['Garden wall ferns']);
    expect(pipeline.filter((p) => p.item.metadata.Kind === 'memory')).toHaveLength(1);
  });
});
