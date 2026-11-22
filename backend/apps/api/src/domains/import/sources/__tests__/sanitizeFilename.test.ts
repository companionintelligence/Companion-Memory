import { sanitizeFilename, sanitizeRelativePath, sanitizeUploadName } from '../sanitizeFilename';

/**
 * The name is attacker-controlled text — a browser sends whatever it likes as
 * `originalname` — landing as a REAL filename under the uploads staging
 * directory, which the importer later moves and deletes from. Every case here
 * is a way to make that name reshape a path.
 */
describe('sanitizeFilename', () => {
  it('strips directory traversal to the basename', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('..\\..\\windows\\system32')).toBe('system32');
  });

  it('removes control characters', () => {
    expect(sanitizeFilename('ex\x00port\x1f.zip')).toBe('export.zip');
  });

  it('flattens shell-hostile characters to underscores', () => {
    expect(sanitizeFilename('my export (2).zip')).toBe('my_export__2_.zip');
  });

  it('refuses to produce a dotfile', () => {
    expect(sanitizeFilename('...hidden')).toBe('hidden');
  });

  it('bounds the length and never returns an empty name', () => {
    expect(sanitizeFilename('x'.repeat(400)).length).toBe(180);
    expect(sanitizeFilename('///')).toBe('upload.zip');
  });
});

describe('sanitizeUploadName', () => {
  it('keeps the names importers recognize exports by', () => {
    expect(sanitizeUploadName('My Clippings.txt')).toBe('My Clippings.txt');
    expect(sanitizeUploadName('WhatsApp Chat with Thaddeus Wrenfield.txt')).toBe(
      'WhatsApp Chat with Thaddeus Wrenfield.txt',
    );
    expect(sanitizeUploadName('Saved Places.json')).toBe('Saved Places.json');
    expect(sanitizeUploadName('my export (2).zip')).toBe('my export (2).zip');
    expect(sanitizeUploadName('Zoë & Ana, 2026.zip')).toBe('Zoë & Ana, 2026.zip');
  });

  it('strips directory traversal and absolute paths to the basename', () => {
    expect(sanitizeUploadName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeUploadName('..\\..\\windows\\system32')).toBe('system32');
    expect(sanitizeUploadName('/etc/cron.d/job')).toBe('job');
    expect(sanitizeUploadName('C:\\Users\\me\\My Clippings.txt')).toBe('My Clippings.txt');
  });

  it('removes control and bidirectional characters', () => {
    expect(sanitizeUploadName('ex\x00port\x1f\x7f.zip')).toBe('export.zip');
    // C1 controls too: a UTF-8 name misread as latin1 is full of them.
    expect(sanitizeUploadName('JosÃ\u0080\u0099\u009f.txt')).toBe('JosÃ.txt');
    expect(sanitizeUploadName('photo\u202egpj.exe')).toBe('photogpj.exe');
  });

  it('replaces what Windows refuses in a name', () => {
    expect(sanitizeUploadName('a<b>c:d"e|f?g*.txt')).toBe('a_b_c_d_e_f_g_.txt');
  });

  it('makes the device names Windows refuses into ordinary names', () => {
    expect(sanitizeUploadName('CON')).toBe('CON_');
    expect(sanitizeUploadName('nul.txt')).toBe('nul_.txt');
    expect(sanitizeUploadName('com1.tar.gz')).toBe('com1_.tar.gz');
    expect(sanitizeUploadName('console.log')).toBe('console.log');
    expect(sanitizeUploadName('auxiliary.json')).toBe('auxiliary.json');
  });

  it('refuses dotfiles and trailing dots or spaces', () => {
    expect(sanitizeUploadName('...hidden')).toBe('hidden');
    expect(sanitizeUploadName('  .env')).toBe('env');
    expect(sanitizeUploadName('notes.txt. . ')).toBe('notes.txt');
  });

  it('falls back when nothing is left after cleaning', () => {
    for (const name of ['', '.', '..', '...', ' . ', '///', '\\', '\x00\x01', '\u202e']) {
      expect(sanitizeUploadName(name)).toBe('upload');
    }

    expect(sanitizeUploadName('..', '_')).toBe('_');
  });

  it('normalizes to NFC so a macOS name matches its typed spelling', () => {
    expect(sanitizeUploadName('Zoe\u0308.txt')).toBe('Zo\u00eb.txt');
  });

  it('bounds the length in bytes and keeps the extension', () => {
    const ascii = sanitizeUploadName(`${'x'.repeat(400)}.tar.gz`);
    expect(Buffer.byteLength(ascii)).toBeLessThanOrEqual(200);
    expect(ascii.endsWith('x.tar.gz')).toBe(true);

    // 3-byte characters: a character count would let this pass 255 bytes.
    const wide = sanitizeUploadName(`${'記'.repeat(150)}.zip`);
    expect(Buffer.byteLength(wide)).toBeLessThanOrEqual(200);
    expect(wide.endsWith('記.zip')).toBe(true);
    expect(wide).not.toContain('\ufffd');

    // An "extension" too long to be one is not kept over the name.
    const long = sanitizeUploadName(`report.${'y'.repeat(300)}`);
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(200);
    expect(long.startsWith('report.')).toBe(true);
  });
});

describe('sanitizeRelativePath', () => {
  it("keeps a folder tree and each segment's own name", () => {
    expect(sanitizeRelativePath('ChatGPT Data/conversations.json')).toBe('ChatGPT Data/conversations.json');
    expect(sanitizeRelativePath('Takeout/Maps (your places)/Saved Places.json')).toBe(
      'Takeout/Maps (your places)/Saved Places.json',
    );
  });

  it('never lets a segment become empty or a dot name', () => {
    expect(sanitizeRelativePath('export/.../a.json')).toBe('export/_/a.json');
    expect(sanitizeRelativePath('export/ /a.json')).toBe('export/_/a.json');
  });

  it('wraps a bare filename so the staged source is a directory', () => {
    expect(sanitizeRelativePath('conversations.json')).toBe('export/conversations.json');
  });

  it('refuses a traversal segment', () => {
    expect(() => sanitizeRelativePath('ok/../etc/passwd')).toThrow(/escapes/);
  });
});
