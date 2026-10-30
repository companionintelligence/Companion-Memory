/*
 * The file listing of a zip that is NOT on this machine, read with a few small
 * ranged fetches instead of a download.
 *
 * A zip keeps its table of contents (the central directory) at the END of the
 * file, so the names of everything inside a multi-gigabyte archive cost two or
 * three reads of its tail — tens of kilobytes to a few megabytes. That is what
 * lets a cloud-drive sync ask "is this zip an export an importer reads?"
 * (see ./archiveListingRecognition) before committing to the download.
 *
 * The record parsing is ./zipDirectory's; only the reads differ.
 */
import {
  parseCentralDirectory,
  parseEndOfCentralDirectory,
  parseZip64EndOfCentralDirectory,
  ZIP64_EOCD_BYTES,
  zipTailWindow,
} from './zipDirectory';

/** Fetch `length` bytes starting at `offset`. Must return exactly that many. */
export type ReadRange = (offset: number, length: number) => Promise<Buffer>;

/**
 * Every entry path in the remote zip, or null when the bytes do not read as a
 * zip (not an archive, truncated, a central directory past the size cap).
 * Read failures from `readRange` propagate — "could not reach the file" is the
 * caller's to retry, and is not the same answer as "not a zip".
 */
export async function listRemoteZipEntries(fileSize: number, readRange: ReadRange): Promise<string[] | null> {
  const window = zipTailWindow(fileSize);
  if (window < 22) {
    return null;
  }

  const tail = await readRange(fileSize - window, window);
  let located = parseEndOfCentralDirectory(tail, fileSize);

  if (located != null && 'zip64At' in located) {
    located = parseZip64EndOfCentralDirectory(await readRange(located.zip64At, ZIP64_EOCD_BYTES), fileSize);
  }

  if (located == null) {
    return null;
  }

  // Usually already in hand: a small archive's directory sits inside the tail.
  const tailStart = fileSize - window;
  const central =
    located.offset >= tailStart
      ? tail.subarray(located.offset - tailStart, located.offset - tailStart + located.size)
      : await readRange(located.offset, located.size);

  // Names are UTF-8 in every export this is aimed at; a legacy-codepage name
  // decodes to replacement characters, which only matters if a recogniser
  // keys on that exact non-ASCII name.
  return parseCentralDirectory(central).map((entry) => entry.nameBytes.toString('utf8'));
}
