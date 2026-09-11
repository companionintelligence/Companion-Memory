import { execFileSync } from 'node:child_process';

/**
 * Whether the libvips command-line tools are on PATH. The suites that decode
 * real bytes through VipsService need them; a machine without `libvips-tools`
 * skips those suites (same convention as the pdftotext-gated Hulu tests) and
 * `make health` tells the developer what to install. CI installs the package
 * in the backend job, so the skip never hides a regression there.
 */
export function vipsCliAvailable(): boolean {
  try {
    execFileSync('vips', ['--version'], { stdio: 'ignore' });

    return true;
  } catch {
    return false;
  }
}
