/* Shared EXIF + container-metadata helpers for the photo/video importers. */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

import exifr from 'exifr';

const execFileAsync = promisify(execFile);

/**
 * exifr revives the timezone-less EXIF wall-clock (DateTimeOriginal / CreateDate)
 * with LOCAL Date constructors, so the SAME photo yields a different absolute
 * instant per host timezone (a dev laptop vs a UTC container) — breaking date
 * bucketing and making imports non-idempotent across machines. Re-interpret the
 * wall-clock as UTC so the timestamp is host-independent.
 *
 * (We don't have the photo's own offset unless OffsetTimeOriginal is present;
 * treating the wall-clock as UTC keeps "floating local time" stable, which is the
 * right call for a personal timeline.)
 */
export function exifWallClockToUtc(d: Date): Date {
  return new Date(
    Date.UTC(
      d.getFullYear(),
      d.getMonth(),
      d.getDate(),
      d.getHours(),
      d.getMinutes(),
      d.getSeconds(),
      d.getMilliseconds(),
    ),
  );
}

/**
 * Parse an EXIF OffsetTime* tag ("+02:00", "-05:30", "Z") into minutes east of
 * UTC, or null when absent/malformed. When OffsetTimeOriginal is present, the
 * camera has recorded which zone its DateTimeOriginal wall-clock was in — so
 * the TRUE instant is recoverable (wall-clock-as-UTC minus this offset),
 * matching what e.g. a Takeout sidecar's photoTakenTime says for the same
 * photo. Lenient on the colon (some writers emit "+0200"); anything else
 * non-conforming returns null so callers keep the floating-wall-clock
 * convention rather than guess.
 */
export function parseExifOffsetMinutes(offset: unknown): number | null {
  if (typeof offset !== 'string') {
    return null;
  }

  const t = offset.trim();
  if (t === 'Z') {
    return 0;
  }

  const m = t.match(/^([+-])(\d{2}):?(\d{2})$/);
  if (!m) {
    return null;
  }

  const minutes = Number(m[2]) * 60 + Number(m[3]);
  if (minutes > 14 * 60) {
    return null;
  } // beyond ±14:00 is no real zone — treat as junk

  return m[1] === '-' ? -minutes : minutes;
}

/**
 * The instant for an exifr-revived EXIF wall-clock: when the paired OffsetTime*
 * tag parses, the TRUE UTC instant (wall-clock minus offset); otherwise the
 * host-independent floating wall-clock (exifWallClockToUtc). Callers pass the
 * offset tag that PAIRS with the datetime tag the wall-clock came from —
 * DateTimeOriginal↔OffsetTimeOriginal, CreateDate↔OffsetTimeDigitized,
 * ModifyDate↔OffsetTime — never a mixed pair.
 */
export function exifInstant(dt: Date, offsetTag?: unknown): Date {
  const wallAsUtc = exifWallClockToUtc(dt);
  const offsetMinutes = parseExifOffsetMinutes(offsetTag);

  return offsetMinutes === null ? wallAsUtc : new Date(wallAsUtc.getTime() - offsetMinutes * 60_000);
}

/**
 * Files at or under this size are read whole and handed to exifr as a Buffer;
 * larger ones keep the path input. Every image — RAW included — fits with room
 * to spare; only the video fallback (extractVideoMetadata's exifr leg) can see
 * files past it, and buffering a multi-GB MP4 for its metadata would trade a
 * broken read for a broken RSS.
 */
const MAX_BUFFERED_EXIF_BYTES = 256 * 1024 * 1024;

/**
 * exifr.parse with a hard timeout. A malformed HEIC with a zero-length box spins
 * exifr's HEIF parse loop forever (no zero-length-box guard upstream); because an
 * infinite loop never throws, the importer's try/catch never fires and the
 * sequential `await` wedges the ENTIRE directory walk. The timeout turns that into
 * an ordinary parse failure (the caller's catch returns {}), so one bad file no
 * longer halts a large library.
 *
 * Caveat: the race cannot cancel the spinning loop — one CPU keeps burning until
 * the process exits. The durable fix is patching/upgrading exifr; this just keeps
 * the import making progress.
 *
 * ## Why the bytes are read here instead of letting exifr open the path
 *
 * exifr's own file reader hands a DataView to `FileHandle.read`, which Yarn
 * PnP's patched `fs` rejects (`TypeError: The "buffer" argument must be an
 * instance of Buffer … Received an instance of ArrayBuffer`) — under PnP every
 * path-based parse threw before reading a byte, the callers' best-effort
 * catches ate it, and "no EXIF anywhere" looked like a property of the photos:
 * on a real Takeout import, 517 sidecar-less camera JPGs all fell back to
 * file-system time (the archive's own date) and lost their camera fields,
 * while `DateTimeOriginal` sat intact in every one of them. A Buffer input
 * skips exifr's reader entirely and behaves identically on every runtime.
 * Bounded by MAX_BUFFERED_EXIF_BYTES; an over-size file keeps the path input,
 * which works where the fs patch is absent and fails exactly as before where
 * it is not.
 */
export async function parseExifSafe(
  fpath: string,
  options?: Parameters<typeof exifr.parse>[1],
  timeoutMs = 5000,
): Promise<ReturnType<typeof exifr.parse>> {
  let input: string | Buffer = fpath;
  try {
    if ((await fs.promises.stat(fpath)).size <= MAX_BUFFERED_EXIF_BYTES) {
      input = await fs.promises.readFile(fpath);
    }
  } catch {
    /* unstattable/unreadable — let exifr's own open report it */
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exifr.parse(input, options),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('exif-timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

// exifr's parse returns `Promise<any>`, so the awaited result has no nominal
// shape. Typed loosely as a Record<string, unknown> here — every read below
// is value-guarded so a missing/wrong-typed tag is dropped rather than coerced.
export type ExifBag = Record<string, unknown> | null | undefined;

/**
 * Pick the camera/lens/exposure fields out of an exifr.parse() result and emit
 * them under the keys downstream consumers expect (mirrors the generic
 * importer's vocabulary: Make / Model / Lens / F-Number / Exposure Time / ISO /
 * Focal Length / Orientation). Returns an object with only the keys that have
 * a defined value, so callers can spread it into a metadata bag without
 * stomping nulls. `null`/`undefined` input is a no-op (returns {}).
 *
 * Without this, every photo's camera context (which body, which lens, which
 * exposure settings) is silently dropped between importer and server, so
 * camera-aware queries ("photos shot on the X100V", "low-light shots") fail.
 */
export function extractCameraFields(exif: ExifBag): Record<string, unknown> {
  if (!exif) {
    return {};
  }

  const out: Record<string, unknown> = {};
  if (typeof exif.Make === 'string' && exif.Make.trim()) {
    out.Make = exif.Make.trim();
  }

  if (typeof exif.Model === 'string' && exif.Model.trim()) {
    out.Model = exif.Model.trim();
  }

  if (typeof exif.LensModel === 'string' && exif.LensModel.trim()) {
    out.Lens = exif.LensModel.trim();
  }

  if (typeof exif.FNumber === 'number' && Number.isFinite(exif.FNumber)) {
    out['F-Number'] = exif.FNumber;
  }

  if (typeof exif.ExposureTime === 'number' && Number.isFinite(exif.ExposureTime)) {
    out['Exposure Time'] = exif.ExposureTime;
  }

  if (typeof exif.ISO === 'number' && Number.isFinite(exif.ISO)) {
    out.ISO = exif.ISO;
  }

  if (typeof exif.FocalLength === 'number' && Number.isFinite(exif.FocalLength)) {
    out['Focal Length'] = exif.FocalLength;
  }

  // Orientation is the EXIF 1..8 enum the renderer needs to rotate previews
  // (sharp().rotate() in CI-Server's preview generator honors it).
  if (typeof exif.Orientation === 'number' && Number.isFinite(exif.Orientation)) {
    out.Orientation = exif.Orientation;
  }

  return out;
}

/**
 * Pick the QuickTime/MP4 container fields out of an exifr.parse() result —
 * Duration / VideoFrameRate / ImageWidth / ImageHeight — and emit them under
 * the metadata vocabulary the rest of the importer expects. exifr's QuickTime
 * support is partial but covers iPhone/Android .mov/.mp4 reliably; for sources
 * it can't read, the bag is empty (no-op).
 *
 * This is the slow-lane fallback; the fast lane is ffprobe via
 * extractVideoMetadata(), which gives reliable duration/codec/framerate for
 * every container ffmpeg supports. Without either, apple_photos treats videos
 * as images, calls EXIF parse on QuickTime atoms, silently gets {}, and emits
 * the video with only filename + mtime.
 */
export function extractVideoFields(exif: ExifBag): Record<string, unknown> {
  if (!exif) {
    return {};
  }

  const out: Record<string, unknown> = {};
  // Duration: exifr emits a number (seconds) for most QuickTime sources.
  if (typeof exif.Duration === 'number' && Number.isFinite(exif.Duration) && exif.Duration > 0) {
    out.Duration = exif.Duration;
  }

  if (typeof exif.VideoFrameRate === 'number' && Number.isFinite(exif.VideoFrameRate)) {
    out['Frame Rate'] = exif.VideoFrameRate;
  }

  // Container dimensions live under ImageWidth/ImageHeight for QuickTime.
  if (typeof exif.ImageWidth === 'number' && Number.isFinite(exif.ImageWidth)) {
    out.Width = exif.ImageWidth;
  }

  if (typeof exif.ImageHeight === 'number' && Number.isFinite(exif.ImageHeight)) {
    out.Height = exif.ImageHeight;
  }

  // Codec ID when present (e.g. 'avc1' for H.264, 'hvc1' for HEVC, 'apch' for ProRes).
  if (typeof exif.CompressorID === 'string' && exif.CompressorID.trim()) {
    out.Codec = exif.CompressorID.trim();
  } else if (typeof exif.CompressorName === 'string' && exif.CompressorName.trim()) {
    out.Codec = exif.CompressorName.trim();
  }

  return out;
}

/* ---------- Shared media-metadata extraction ---------- */

export interface MediaLocation {
  latitude: number;
  longitude: number;
}

export interface MediaMetadata {
  /** Capture timestamp, re-interpreted as host-TZ-independent UTC. */
  timestamp?: Date;
  /** Location, null-island-guarded. */
  location?: MediaLocation;
  /**
   * Horizontal positional error in meters (EXIF GPSHPositioningError or the
   * equivalent from a container side-car). Lets the canonical mapper publish a
   * real accuracy_meters for the position pipeline instead of falling back to
   * the 30m EXIF default.
   */
  accuracyMeters?: number;
  /**
   * Per-file metadata fields (Make/Model/Lens/Duration/Codec/etc.) to merge
   * into the importer's `item.metadata`. Values are the union exifr / ffprobe
   * happen to emit; downstream just spreads this into a Record.
   */
  metadata: Record<string, unknown>;
}

function pickLocation(lat: unknown, lng: unknown): MediaLocation | undefined {
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return undefined;
  }

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return undefined;
  }

  if (lat === 0 && lng === 0) {
    return undefined;
  }

  return { latitude: lat, longitude: lng };
}

function pickAccuracyMeters(exif: Record<string, unknown>): number | undefined {
  const err = exif.GPSHPositioningError;
  if (typeof err === 'number' && Number.isFinite(err) && err > 0) {
    return err;
  }

  return undefined;
}

/**
 * Extract image EXIF (capture time + GPS + camera tags). Returns an empty
 * MediaMetadata on any parse failure, so a single bad file never halts the walk.
 */
export async function extractImageExif(fpath: string): Promise<MediaMetadata> {
  const out: MediaMetadata = { metadata: {} };
  try {
    const exif = await parseExifSafe(fpath, { tiff: true, exif: true, gps: true });
    if (!exif) {
      return out;
    }

    const dt = exif.DateTimeOriginal ?? exif.CreateDate ?? exif.CreationDate ?? exif.ModifyDate;
    if (dt instanceof Date && !Number.isNaN(dt.getTime())) {
      // Pair the offset tag that belongs to whichever datetime tag won —
      // OffsetTimeOriginal describes DateTimeOriginal's zone, not CreateDate's.
      // (CreationDate is an Apple QuickTime tag with no EXIF offset companion.)
      const offsetTag =
        dt === exif.DateTimeOriginal
          ? exif.OffsetTimeOriginal
          : dt === exif.CreateDate
            ? exif.OffsetTimeDigitized
            : dt === exif.ModifyDate
              ? exif.OffsetTime
              : undefined;
      out.timestamp = exifInstant(dt, offsetTag);
    }

    const loc = pickLocation(exif.latitude, exif.longitude);
    if (loc) {
      out.location = loc;
      const acc = pickAccuracyMeters(exif as Record<string, unknown>);
      if (acc != null) {
        out.accuracyMeters = acc;
      }
    }

    Object.assign(out.metadata, extractCameraFields(exif as ExifBag));
  } catch {
    /* fall through to {} */
  }

  return out;
}

/** Parse a fractional rate like "30000/1001" → 29.97. */
function parseRationalRate(s: string | undefined): number | undefined {
  if (!s) {
    return undefined;
  }

  const parts = s.split('/');
  if (parts.length !== 2) {
    return undefined;
  }

  const num = Number(parts[0]);
  const den = Number(parts[1]);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
    return undefined;
  }

  return num / den;
}

/**
 * Parse an ISO 6709 location string as written by Apple QuickTime
 * (com.apple.quicktime.location.ISO6709), e.g. "+34.0441-118.2598+020.000/".
 * Returns undefined on a null-island sentinel or any parse failure.
 */
function parseIso6709(loc: string | undefined): MediaLocation | undefined {
  if (!loc) {
    return undefined;
  }

  const m = loc.match(/^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
  if (!m) {
    return undefined;
  }

  return pickLocation(parseFloat(m[1]), parseFloat(m[2]));
}

/**
 * Once ffprobe is missing on this host we don't keep paying the spawn cost
 * (ENOENT every time, log spam). Cache the verdict for the process lifetime.
 */
let ffprobeAvailable: boolean | undefined;

async function runFfprobe(fpath: string, timeoutMs: number): Promise<unknown | null> {
  if (ffprobeAvailable === false) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', fpath],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
    );
    ffprobeAvailable = true;

    return JSON.parse(stdout);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      ffprobeAvailable = false;
    }

    return null;
  }
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  bit_rate?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  tags?: Record<string, string>;
}
interface FfprobeFormat {
  duration?: string;
  bit_rate?: string;
  tags?: Record<string, string>;
}
interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

/**
 * Extract video container metadata: duration, dimensions, codec, framerate,
 * bitrate, audio codec, capture time + GPS, and camera tags. Tries ffprobe
 * first (reliable for QuickTime/MP4); falls back to extractVideoFields +
 * extractCameraFields on exifr's QuickTime atom subset so the importer still
 * degrades gracefully when ffprobe isn't on PATH.
 *
 * Field naming matches extractVideoFields/extractCameraFields ('Frame Rate',
 * 'F-Number', 'Codec', etc.) so the ffprobe path and the fallback path land
 * identical metadata shapes.
 */
export async function extractVideoMetadata(fpath: string, timeoutMs = 8000): Promise<MediaMetadata> {
  const out: MediaMetadata = { metadata: {} };

  const probe = (await runFfprobe(fpath, timeoutMs)) as FfprobeOutput | null;
  if (probe) {
    const fmt = probe.format || {};
    const streams = probe.streams || [];
    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');

    const duration = Number(fmt.duration ?? video?.duration);
    if (Number.isFinite(duration) && duration > 0) {
      out.metadata.Duration = +duration.toFixed(3);
    }

    const bitrate = Number(fmt.bit_rate ?? video?.bit_rate);
    if (Number.isFinite(bitrate) && bitrate > 0) {
      out.metadata.Bitrate = bitrate;
    }

    if (video) {
      if (video.codec_name) {
        out.metadata.Codec = String(video.codec_name);
      }

      if (Number.isFinite(Number(video.width))) {
        out.metadata.Width = Number(video.width);
      }

      if (Number.isFinite(Number(video.height))) {
        out.metadata.Height = Number(video.height);
      }

      const fps = parseRationalRate(video.avg_frame_rate) ?? parseRationalRate(video.r_frame_rate);
      if (fps != null && Number.isFinite(fps) && fps > 0) {
        out.metadata['Frame Rate'] = +fps.toFixed(3);
      }
    }

    if (audio?.codec_name) {
      out.metadata.AudioCodec = String(audio.codec_name);
    }

    const fmtTags: Record<string, string> = fmt.tags || {};
    const videoTags: Record<string, string> = video?.tags || {};
    // QuickTime stamps creation_time with a real ISO 8601 instant (TZ-aware), so
    // unlike image EXIF we do NOT re-interpret it — `new Date(iso)` is correct.
    const tsRaw = fmtTags.creation_time || videoTags.creation_time;
    if (tsRaw) {
      const d = new Date(tsRaw);
      if (!Number.isNaN(d.getTime())) {
        out.timestamp = d;
      }
    }

    const loc =
      parseIso6709(fmtTags['com.apple.quicktime.location.ISO6709']) ??
      parseIso6709(videoTags['com.apple.quicktime.location.ISO6709']) ??
      parseIso6709(fmtTags.location);
    if (loc) {
      out.location = loc;
    }

    const make = fmtTags['com.apple.quicktime.make'] || fmtTags.make;
    const model = fmtTags['com.apple.quicktime.model'] || fmtTags.model;
    const software = fmtTags['com.apple.quicktime.software'] || fmtTags.encoder;
    if (make) {
      out.metadata.Make = make;
    }

    if (model) {
      out.metadata.Model = model;
    }

    if (software) {
      out.metadata.Software = software;
    }

    return out;
  }

  // Fallback: exifr handles a subset of QuickTime atoms (CreateDate, GPS, some
  // tags). Reuses extractVideoFields/extractCameraFields so the fallback emits
  // the same metadata vocabulary as the ffprobe path.
  try {
    const exif = await parseExifSafe(fpath);
    if (!exif) {
      return out;
    }

    const dt = exif.CreateDate ?? exif.CreationDate ?? exif.DateTimeOriginal;
    if (dt instanceof Date && !Number.isNaN(dt.getTime())) {
      out.timestamp = exifWallClockToUtc(dt);
    }

    const loc = pickLocation(exif.latitude, exif.longitude);
    if (loc) {
      out.location = loc;
      const acc = pickAccuracyMeters(exif as Record<string, unknown>);
      if (acc != null) {
        out.accuracyMeters = acc;
      }
    }

    Object.assign(out.metadata, extractCameraFields(exif as ExifBag));
    Object.assign(out.metadata, extractVideoFields(exif as ExifBag));
  } catch {
    /* swallow — empty result is the right signal */
  }

  return out;
}

/**
 * MIME-routed dispatcher: image/* → image EXIF, video/* → video container.
 * Anything else returns an empty result. Callers merge the returned `metadata`
 * into their item, and apply `timestamp` / `location` / `accuracyMeters` per
 * their own rules.
 */
export async function extractMediaMetadata(
  fpath: string,
  mediaType: string | undefined,
): Promise<MediaMetadata> {
  if (mediaType && mediaType.startsWith('video/')) {
    return extractVideoMetadata(fpath);
  }

  if (mediaType && mediaType.startsWith('image/')) {
    return extractImageExif(fpath);
  }

  return { metadata: {} };
}

/** Test-only hook: reset the ffprobe-availability cache between runs. */
export function _resetFfprobeAvailability(): void {
  ffprobeAvailable = undefined;
}
