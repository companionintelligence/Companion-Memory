import {
  Children,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { cn, Label, Popover } from '@ci/shadcn';
import { CircleAlert, CircleCheck, CircleHelp, Info, LoaderCircle, TriangleAlert } from '@ci/shadcn/icons';

/*
 * The building blocks every settings section is made of, so the sections share one
 * layout instead of each picking its own paddings, heading sizes and status colours.
 *
 *   SettingsSection   title, one-line description, (?) for the long explanation, actions
 *   SettingsGroup     optional heading above one card of rows
 *   SettingsRow       label + hint on the left, control on the right (or content below)
 *   SettingsFooter    the card's action strip: status on the left, buttons on the right
 *
 * Spacing: 24px between the header and groups and between groups, 10px from a group
 * heading to its card, 20px/16px inside every row. Text: 18px section title, 14px group
 * heading and row label, 12px hints. Anything longer than about two lines of hint goes
 * into an InfoTip instead.
 */

const SUCCESS_TEXT = 'text-teal-700 dark:text-teal-300';

// A foreground tint, not --border: in the dark themes --border is within a few shades of
// --card, which left the rows of a card with no visible separation.
const ROW_DIVIDERS = 'divide-y divide-foreground/[0.08]';

/**
 * The (?)'s name for a heading: "About privacy", but "About API path" and "About BlueBubbles",
 * since lowercasing an acronym or a product name makes a screen reader say it as a word.
 */
function aboutLabel(text: ReactNode): string {
  if (typeof text !== 'string') {
    return 'More about this';
  }

  const firstWord = text.split(/\s/, 1)[0];

  return /^[A-Z][^A-Z]*$/.test(firstWord)
    ? `About ${text[0].toLowerCase()}${text.slice(1)}`
    : `About ${text}`;
}

/** The (?) button. Opens on hover with a mouse, and on click or tap everywhere. */
export function InfoTip({
  label,
  children,
  side = 'bottom',
  align = 'start',
  className,
}: {
  /** Accessible name of the button, such as "About autonomy". */
  label: string;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  // A click pins the popover open, so moving the mouse away no longer closes it.
  const pinned = useRef(false);
  // Whether focus went into the popover. Only then does closing hand it back to the (?):
  // after a hover it never left what the reader was doing, such as typing in a field.
  const holdsFocus = useRef(false);
  const content = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);

  const cancelClose = useCallback(() => window.clearTimeout(closeTimer.current), []);
  const closeSoon = useCallback(() => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => {
      if (!pinned.current) {
        setOpen(false);
      }
    }, 150);
  }, [cancelClose]);

  useEffect(() => cancelClose, [cancelClose]);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          pinned.current = false;
        }

        setOpen(next);
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            'inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none data-[state=open]:text-foreground',
            className,
          )}
          onClick={(event) => {
            // Handled here rather than by Radix's toggle: a hover may already have opened it,
            // and the click should then keep it open, not close it.
            event.preventDefault();
            cancelClose();

            if (open && pinned.current) {
              pinned.current = false;
              setOpen(false);
            } else if (open) {
              // A mouse hovers before it clicks, so the popover is already open and will not
              // move focus on its own.
              pinned.current = true;
              holdsFocus.current = true;
              content.current?.focus();
            } else {
              pinned.current = true;
              setOpen(true);
            }
          }}
          onPointerEnter={(event) => {
            if (event.pointerType === 'mouse') {
              cancelClose();
              setOpen(true);
            }
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === 'mouse') {
              closeSoon();
            }
          }}
        >
          <CircleHelp className="size-3.5" aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Content
        ref={content}
        side={side}
        align={align}
        className="w-80 max-w-[calc(100vw-2rem)] space-y-2 p-3 text-xs leading-relaxed text-popover-foreground [&_a]:underline [&_a]:underline-offset-2 [&_code]:font-mono [&_li]:ml-4 [&_li]:list-disc [&_ul]:space-y-1"
        // Opened by hover, focus stays where the reader is. Opened by click, tap or the
        // keyboard, it moves into the popover, so a link inside it can be reached with Tab
        // and Escape brings focus back to the (?).
        onOpenAutoFocus={(event) => {
          holdsFocus.current = pinned.current;

          if (!pinned.current) {
            event.preventDefault();
          }
        }}
        // Radix focuses the trigger whenever a popover closes. After a hover-only open that
        // pulled focus out of the field the reader was typing in, for moving the mouse past.
        // Left alone unless focus fell to the body, as when a link inside was clicked.
        onCloseAutoFocus={(event) => {
          if (!holdsFocus.current && document.activeElement !== document.body) {
            event.preventDefault();
          }
        }}
        onPointerEnter={cancelClose}
        onPointerLeave={(event) => {
          if (event.pointerType === 'mouse') {
            closeSoon();
          }
        }}
      >
        {children}
      </Popover.Content>
    </Popover>
  );
}

/** One settings page: its header, then its groups 24px apart. */
export function SettingsSection({
  title,
  description,
  help,
  actions,
  children,
}: {
  title: string;
  /** One sentence. Longer explanations go in `help`. */
  description?: ReactNode;
  help?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6">
      <header data-slot="settings-header" className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h2 className="text-lg leading-7 font-semibold">{title}</h2>
            {help ? <InfoTip label={aboutLabel(title)}>{help}</InfoTip> : null}
          </div>
          {description ? <p className="mt-0.5 text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}

/** A heading (optional) above one card of rows. */
export function SettingsGroup({
  title,
  description,
  help,
  actions,
  children,
  className,
  cardClassName,
  testId,
}: {
  title?: ReactNode;
  description?: ReactNode;
  help?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  cardClassName?: string;
  testId?: string;
}) {
  const headingId = useId();
  const hasHeading = title != null || actions != null;

  return (
    <section
      className={cn('flex flex-col gap-2.5', className)}
      aria-labelledby={title != null ? headingId : undefined}
      data-testid={testId}
    >
      {hasHeading ? (
        <div className="flex min-h-8 items-end justify-between gap-3">
          <div className="min-w-0">
            {title != null ? (
              <div className="flex items-center gap-1.5">
                <h3 id={headingId} className="text-sm font-semibold">
                  {title}
                </h3>
                {help ? <InfoTip label={aboutLabel(title)}>{help}</InfoTip> : null}
              </div>
            ) : null}
            {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <SettingsCard className={cardClassName}>{children}</SettingsCard>
    </section>
  );
}

/** The card itself: rows separated by hairlines. Nothing at all when every row is hidden. */
export function SettingsCard({ children, className }: { children: ReactNode; className?: string }) {
  // Rows are mostly conditional. When none of them shows, an empty bordered box would
  // read as something that failed to load.
  if (Children.toArray(children).length === 0) {
    return null;
  }

  return (
    <div
      data-slot="settings-card"
      className={cn(
        ROW_DIVIDERS,
        'overflow-hidden rounded-xl border bg-card text-card-foreground',
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * A <form> inside a card, for rows that submit together. The card draws hairlines only
 * between its own children, so the form draws them between the rows it holds.
 */
export function SettingsForm({ className, ...props }: React.ComponentProps<'form'>) {
  return <form className={cn(ROW_DIVIDERS, className)} {...props} />;
}

/**
 * One row of a card. With `control`, the control sits on the right of the label; with
 * `children`, the content goes under the label at full width. Both can be given: a list
 * item's name and buttons on top, its details below.
 */
export function SettingsRow({
  label,
  htmlFor,
  hint,
  help,
  helpLabel,
  meta,
  control,
  children,
  className,
  align = 'center',
  testId,
}: {
  label?: ReactNode;
  /** Makes the label a <label> for this control. */
  htmlFor?: string;
  /** One or two lines under the label. */
  hint?: ReactNode;
  /** The (?) beside the label, for anything longer than a hint. */
  help?: ReactNode;
  helpLabel?: string;
  /** Badges or short status on the label's line. */
  meta?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
  className?: string;
  align?: 'center' | 'start';
  testId?: string;
}) {
  // min-w-0 lets a long label shrink to the row, so a label that truncates (a key or server
  // name) shows an ellipsis instead of running under the buttons.
  const labelText =
    label == null ? null : htmlFor ? (
      <Label htmlFor={htmlFor} className="min-w-0 text-sm leading-5 font-medium">
        {label}
      </Label>
    ) : (
      <span className="min-w-0 text-sm leading-5 font-medium">{label}</span>
    );

  // Beside a control the label column starts at 12rem and grows, so on a narrow screen the
  // control drops under the label instead of squeezing the text into a sliver.
  const heading =
    label != null || hint != null ? (
      <div className={cn('min-w-0', control != null ? 'grow basis-48' : null)}>
        {label != null ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
            {labelText}
            {help ? <InfoTip label={helpLabel ?? aboutLabel(label)}>{help}</InfoTip> : null}
            {meta}
          </div>
        ) : null}
        {hint != null ? (
          <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</div>
        ) : null}
      </div>
    ) : null;

  return (
    <div data-slot="settings-row" data-testid={testId} className={cn('px-5 py-4', className)}>
      {control != null ? (
        <div
          className={cn(
            'flex flex-wrap justify-between gap-x-6 gap-y-3',
            align === 'center' ? 'items-center' : 'items-start',
          )}
        >
          {heading}
          <div className="flex max-w-full shrink-0 items-center gap-2">{control}</div>
        </div>
      ) : (
        heading
      )}
      {/* Counted, not compared: `{error}{note}` arrives as an array even when both are null. */}
      {Children.toArray(children).length > 0 ? (
        <div className={cn(heading || control != null ? 'mt-3' : null)}>{children}</div>
      ) : null}
    </div>
  );
}

/** Small print under a control, such as an example of the chosen format. */
export function SettingsHint({ children, className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p className={cn('mt-2 text-xs leading-relaxed text-muted-foreground', className)} {...props}>
      {children}
    </p>
  );
}

/** The action strip at the bottom of a card: status on the left, buttons on the right. */
export function SettingsFooter({ status, children }: { status?: ReactNode; children?: ReactNode }) {
  return (
    <div
      data-slot="settings-footer"
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 bg-foreground/[0.03] px-5 py-3"
    >
      {/* The status starts at 15rem, so when it and the buttons don't fit side by side the
          buttons wrap below it rather than squeezing a long error down to a word per line. */}
      {status ? <div className="min-w-0 grow basis-60">{status}</div> : null}
      {children ? (
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{children}</div>
      ) : null}
    </div>
  );
}

type StatusTone = 'success' | 'error' | 'pending' | 'muted';

/** "Saved", "Connected", "Could not save": one look for every outcome. */
export function SettingsStatus({
  tone = 'muted',
  children,
  className,
  ...props
}: { tone?: StatusTone } & React.ComponentProps<'p'>) {
  const Icon =
    tone === 'success'
      ? CircleCheck
      : tone === 'error'
        ? CircleAlert
        : tone === 'pending'
          ? LoaderCircle
          : null;

  // The text stays a direct child of the <p>, so the element that holds the message is the
  // one a ref (to scroll it into view) or a test finds by its text.
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'relative text-sm leading-5',
        Icon && 'pl-5.5',
        tone === 'success' && SUCCESS_TEXT,
        tone === 'error' && 'text-destructive',
        (tone === 'muted' || tone === 'pending') && 'text-muted-foreground',
        className,
      )}
      {...props}
    >
      {Icon ? (
        <Icon
          className={cn('absolute top-0.5 left-0 size-4', tone === 'pending' && 'animate-spin')}
          aria-hidden="true"
        />
      ) : null}
      {children}
    </p>
  );
}

type NoticeTone = 'info' | 'warning' | 'error' | 'success';

const NOTICE_TONES: Record<NoticeTone, { box: string; icon: typeof Info }> = {
  info: { box: 'border-border bg-muted/40 text-muted-foreground', icon: Info },
  warning: {
    box: 'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200',
    icon: TriangleAlert,
  },
  error: { box: 'border-destructive/30 bg-destructive/10 text-destructive', icon: CircleAlert },
  success: { box: `border-teal-500/30 bg-teal-500/10 ${SUCCESS_TEXT}`, icon: CircleCheck },
};

/** A message about the whole section or card: why something is off, what failed, what to do. */
export function SettingsNotice({
  tone = 'info',
  title,
  action,
  children,
  className,
  role,
}: {
  tone?: NoticeTone;
  title?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
  role?: string;
}) {
  const { box, icon: Icon } = NOTICE_TONES[tone];

  return (
    <div
      role={role ?? (tone === 'error' ? 'alert' : 'note')}
      className={cn('flex items-start gap-3 rounded-lg border px-4 py-3 text-sm', box, className)}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1">
        {title ? <p className={cn('font-medium', tone === 'info' && 'text-foreground')}>{title}</p> : null}
        {children ? <div className="leading-relaxed">{children}</div> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2 self-center">{action}</div> : null}
    </div>
  );
}

/** What a card shows when its list is empty. */
export function SettingsEmpty({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-5 py-10 text-center">
      {icon ? (
        <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5">
          {icon}
        </div>
      ) : null}
      <div>
        <p className="text-sm font-medium">{title}</p>
        {description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

/** A card row that is still loading. */
export function SettingsLoading({ children = 'Loading…' }: { children?: ReactNode }) {
  return (
    <div role="status" className="flex items-center gap-2 px-5 py-4 text-sm text-muted-foreground">
      <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
      {children}
    </div>
  );
}

/**
 * The keyboard pattern of a radio group: one tab stop (the checked option, or the first one
 * that can be chosen), and the arrow keys move the choice to the next or previous option.
 */
function useRadioKeys<T extends string>(
  options: ReadonlyArray<{ value: T; disabled?: boolean }>,
  value: T,
  onChange: (value: T) => void,
  groupDisabled: boolean | undefined,
) {
  const buttons = useRef(new Map<T, HTMLButtonElement>());
  const choosable = groupDisabled ? [] : options.filter((option) => !option.disabled);
  const tabStop = choosable.some((option) => option.value === value) ? value : choosable[0]?.value;

  return {
    tabIndex: (option: T) => (option === tabStop ? 0 : -1),
    ref: (option: T) => (button: HTMLButtonElement | null) => {
      if (button) {
        buttons.current.set(option, button);
      } else {
        buttons.current.delete(option);
      }
    },
    onKeyDown: (event: KeyboardEvent, current: T) => {
      const step =
        event.key === 'ArrowRight' || event.key === 'ArrowDown'
          ? 1
          : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
            ? -1
            : 0;

      if (step === 0 || choosable.length === 0) {
        return;
      }

      event.preventDefault();
      const from = choosable.findIndex((option) => option.value === current);
      const next = choosable[(from + step + choosable.length) % choosable.length];
      buttons.current.get(next.value)?.focus();
      onChange(next.value);
    },
  };
}

/** Two to four mutually exclusive choices in one control: theme, location mode, a filter. */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  className,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: ReactNode; disabled?: boolean }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  const keys = useRadioKeys(options, value, onChange, disabled);

  return (
    <div
      role="radiogroup"
      aria-label={label}
      // max-w-full: a width set by the caller (w-72) gives way on a phone narrower than it.
      className={cn(
        'inline-flex h-9 max-w-full items-center gap-1 rounded-lg bg-muted p-1 max-device:h-12',
        className,
      )}
    >
      {options.map((option) => {
        const checked = option.value === value;

        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={disabled || option.disabled}
            ref={keys.ref(option.value)}
            tabIndex={keys.tabIndex(option.value)}
            onKeyDown={(event) => keys.onKeyDown(event, option.value)}
            onClick={() => onChange(option.value)}
            className={cn(
              'h-7 flex-1 cursor-pointer rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 max-device:h-10',
              checked
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Pick one of several options, each with a sentence of explanation: one row per option
 * inside the card, the chosen one marked.
 */
export function ChoiceList<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: ReactNode; hint?: ReactNode }>;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const keys = useRadioKeys(options, value, onChange, disabled);

  return (
    <div role="radiogroup" aria-label={label} className={ROW_DIVIDERS}>
      {options.map((option) => {
        const checked = option.value === value;

        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={disabled}
            ref={keys.ref(option.value)}
            tabIndex={keys.tabIndex(option.value)}
            onKeyDown={(event) => keys.onKeyDown(event, option.value)}
            onClick={() => onChange(option.value)}
            className={cn(
              'flex w-full cursor-pointer items-start gap-3 px-5 py-4 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-60',
              checked ? 'bg-primary/5' : 'hover:bg-accent/40',
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
                checked ? 'border-primary bg-primary' : 'border-muted-foreground/50',
              )}
            >
              {checked ? <span className="size-1.5 rounded-full bg-primary-foreground" /> : null}
            </span>
            <span className="min-w-0">
              <span className="block text-sm leading-5 font-medium">{option.label}</span>
              {option.hint ? (
                <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                  {option.hint}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Label/value pairs, such as a connection's last sync. */
export function SettingsFacts({
  items,
}: {
  items: ReadonlyArray<{ label: ReactNode; value: ReactNode } | null | false>;
}) {
  return (
    <dl className="grid gap-2 text-sm">
      {items.filter(Boolean).map((item, index) => {
        const { label, value } = item as { label: ReactNode; value: ReactNode };

        return (
          <div key={index} className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right tabular-nums">{value}</dd>
          </div>
        );
      })}
    </dl>
  );
}
