import { useId, useState, type ReactNode } from 'react';

import { Button, cn } from '@ci/shadcn';
import { QrCode as QrCodeIcon } from '@ci/shadcn/icons';
import { QRCodeSVG } from 'qrcode.react';
import { useTranslation } from 'react-i18next';

import logo from '@/assets/logo.png';

/**
 * The one place in this app where the design canon does NOT apply.
 *
 * Scanners are built around the spec's assumption of dark modules on a light
 * ground: a decoder binarizes the camera frame and takes the DARK run as data.
 * Inverting for dark mode, or painting the modules in `--primary` teal, makes
 * the code either unreadable or readable only on the subset of phones whose
 * decoder happens to handle inversion. So the plate and the modules are fixed
 * constants that do not participate in theming — deliberately not
 * `var(--background)` / `var(--foreground)`, which flip.
 *
 * The CI teal belongs on the frame, the border and the caption. Never on a
 * data module.
 */
const QR_PLATE_COLOR = '#ffffff';
const QR_MODULE_COLOR = '#0a0a0a';

/** Fraction of the code's width the excavated mark is allowed to occupy. */
const MARK_SCALE = 0.22;

export interface QrCodeProps {
  /** The payload to encode. */
  value: string;
  /**
   * The same payload as selectable text, rendered under the code.
   *
   * Required on purpose. A QR-only path dead-ends every user whose camera
   * won't focus, whose phone is the device already showing the code, or who
   * is reading this over a screen share — and "just scan it" is not a
   * recovery. If you find yourself wanting to omit this, the answer is that
   * the surface should not be showing a QR code at all.
   *
   * The one exception is `reveal`, where it waits with the code — see there.
   */
  fallback: string;
  /** Rendered size of the code in px. */
  size?: number;
  /**
   * Error-correction level. Forced to 'H' whenever `mark` is set — see `mark`.
   */
  level?: 'L' | 'M' | 'Q' | 'H';
  /**
   * Draw the CI mark in the middle of the code, excavating the modules under it.
   *
   * A logo is pure occlusion. Reed-Solomon spends its budget on *unknown-value*
   * symbols, but an occluded module is an unknown *position* too, which costs
   * roughly twice as much — so a centre mark eats about half the usable
   * correction budget. That is why this forces `level="H"` (30%) rather than
   * trusting the caller to remember: at 'M' (15%) a marked code decodes on a
   * clean screenshot and fails on a phone at an angle, which is the worst
   * possible failure because it passes review.
   */
  mark?: boolean;
  /** Rendered above the code. */
  caption?: ReactNode;
  /**
   * Start hidden behind a "Show code" button — the code AND the `fallback`.
   *
   * For payloads that are credentials. A QR of a secret is strictly worse than
   * the clipboard: screen-share codecs re-encode it cleanly enough to scan, and
   * a screenshot persists it in a camera roll that syncs. Revealing on an
   * explicit press at least makes the exposure a decision.
   *
   * The `fallback` is the same secret in plaintext, so it waits too. Blurring
   * only the machine-readable copy while printing the human-readable one under
   * it protects nothing.
   */
  reveal?: boolean;
  className?: string;
}

export function QrCode({
  value,
  fallback,
  size = 200,
  level = 'M',
  mark = false,
  caption,
  reveal = false,
  className,
}: QrCodeProps) {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState(false);
  const fallbackId = useId();

  const hidden = reveal && !revealed;

  const markSize = Math.round(size * MARK_SCALE);

  return (
    <div className={cn('flex flex-col items-center gap-2', className)}>
      {caption && <div className="text-sm font-medium text-primary">{caption}</div>}

      {/* The padding around the code is plate, so it takes the plate colour from
          the same constant the modules do — not a Tailwind literal that could
          drift from it. */}
      <div
        className="relative rounded-lg border-2 border-primary p-3"
        style={{ backgroundColor: QR_PLATE_COLOR }}
      >
        <QRCodeSVG
          value={value}
          size={size}
          // Not caller-controlled when `mark` is set: see the prop docs.
          level={mark ? 'H' : level}
          bgColor={QR_PLATE_COLOR}
          fgColor={QR_MODULE_COLOR}
          // The spec's 4-module quiet zone. Without it a scanner has no reliable
          // edge to find, and the border above is teal, not plate-white.
          marginSize={4}
          imageSettings={mark ? { src: logo, height: markSize, width: markSize, excavate: true } : undefined}
          className={cn('block transition-[filter]', hidden && 'blur-md')}
          // The description IS the payload, so it only exists while the payload
          // does. Pointing at an id that is not in the document while hidden
          // would be a dangling reference, and rendering the text off-screen to
          // satisfy it would hand the secret straight back to a screen reader.
          aria-describedby={hidden ? undefined : fallbackId}
        />

        {hidden && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Button size="sm" onClick={() => setRevealed(true)}>
              <QrCodeIcon className="h-4 w-4" />
              {t('QR_CODE_SHOW')}
            </Button>
          </div>
        )}
      </div>

      {/*
        The same string the code encodes, selectable and copyable — so it waits
        on exactly the same gate the code does.

        Without `reveal` (the default) that gate is open from the start, and
        this is the escape hatch for the camera that won't focus, the phone that
        is the device showing the code, the screen share. With `reveal` set the
        payload is a credential, and printing it in plaintext under a blurred
        picture of itself would conceal nothing — the blur would be theatre.
        Both halves are the payload, so both wait.
      */}
      {!hidden && (
        <p
          id={fallbackId}
          className="max-w-full text-center text-xs break-all text-muted-foreground select-all"
        >
          {fallback}
        </p>
      )}

      {reveal && revealed && (
        <Button variant="ghost" size="sm" onClick={() => setRevealed(false)}>
          {t('QR_CODE_HIDE')}
        </Button>
      )}
    </div>
  );
}
