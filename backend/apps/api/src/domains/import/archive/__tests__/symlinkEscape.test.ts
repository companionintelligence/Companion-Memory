import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { stripSymlinks, unpackArchives } from '../unpack';

/**
 * The escape these close was reproduced end to end on a live appliance: an
 * inbox unit containing `Takeout -> /somewhere/outside` had that directory's
 * contents moved into the run's scratch tree and then PERMANENTLY DELETED with
 * it at the end of the run, outside every configured import root.
 *
 * Two independent guards, because the two vectors are independent: the wrapper
 * flatten resolved the link itself, and a zip can carry a symlink entry that
 * only exists after extraction — where no name-based containment check can see
 * it.
 */

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ci-symlink-escape-'));
}

describe('symlink containment in the staged tree', () => {
  it('does not follow a symlinked Takeout wrapper', async () => {
    const work = scratch();
    const staged = path.join(work, 'staged');
    const outside = path.join(work, 'precious');
    fs.mkdirSync(staged, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'irreplaceable.txt'), 'the only copy');

    // The attack: the unit's `Takeout` is a link to somewhere else entirely.
    fs.symlinkSync(outside, path.join(staged, 'Takeout'));

    await unpackArchives(staged, () => undefined, { deleteArchives: false });

    // The file must still be where it was, under its own name.
    expect(fs.existsSync(path.join(outside, 'irreplaceable.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(outside, 'irreplaceable.txt'), 'utf8')).toBe('the only copy');
    // And must NOT have been hoisted into the staged tree, which is what the
    // end-of-run reclaim would later delete.
    expect(fs.existsSync(path.join(staged, 'irreplaceable.txt'))).toBe(false);

    fs.rmSync(work, { recursive: true, force: true });
  });

  it('removes symlinks left anywhere in the staged tree', () => {
    const work = scratch();
    const staged = path.join(work, 'staged');
    const outside = path.join(work, 'precious');
    fs.mkdirSync(path.join(staged, 'Photos', 'nested'), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep me');
    fs.writeFileSync(path.join(staged, 'Photos', 'real.jpg'), 'jpeg');

    // A link to a file, and a link to a whole directory, both buried.
    fs.symlinkSync(path.join(outside, 'keep.txt'), path.join(staged, 'Photos', 'link.txt'));
    fs.symlinkSync(outside, path.join(staged, 'Photos', 'nested', 'escape'));

    const removed = stripSymlinks(staged);

    expect(removed).toBe(2);
    expect(fs.existsSync(path.join(staged, 'Photos', 'link.txt'))).toBe(false);
    expect(fs.existsSync(path.join(staged, 'Photos', 'nested', 'escape'))).toBe(false);
    // Real content is untouched, and so is the target the links pointed at.
    expect(fs.readFileSync(path.join(staged, 'Photos', 'real.jpg'), 'utf8')).toBe('jpeg');
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep me');

    fs.rmSync(work, { recursive: true, force: true });
  });

  it('leaves a tree with no symlinks alone', () => {
    const work = scratch();
    fs.mkdirSync(path.join(work, 'Mail'), { recursive: true });
    fs.writeFileSync(path.join(work, 'Mail', 'inbox.mbox'), 'From: someone');

    expect(stripSymlinks(work)).toBe(0);
    expect(fs.existsSync(path.join(work, 'Mail', 'inbox.mbox'))).toBe(true);

    fs.rmSync(work, { recursive: true, force: true });
  });
});
