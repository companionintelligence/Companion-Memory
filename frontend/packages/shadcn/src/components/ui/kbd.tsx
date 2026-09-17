// Relative, not the `@/` alias the `shadcn add` CLI generates. That alias is
// declared in THIS package's tsconfig only, so it resolves while typechecking
// @ci/shadcn alone and fails the moment another workspace typechecks against
// these sources — which is every consumer: @ci/common, @ci/capture, @ci/editor,
// and through them all four shipping targets. The other 44 files in this
// directory already import it this way; re-run of the CLI will reintroduce the
// alias, so convert it again rather than adding a path mapping to every
// consumer's tsconfig.
import { cn } from '../../lib/utils';

function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'bg-muted text-muted-foreground pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-sm px-1 font-sans text-xs font-medium select-none',
        "[&_svg:not([class*='size-'])]:size-3",
        '[[data-slot=tooltip-content]_&]:bg-background/20 [[data-slot=tooltip-content]_&]:text-background dark:[[data-slot=tooltip-content]_&]:bg-background/10',
        className,
      )}
      {...props}
    />
  );
}

function KbdGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return <kbd data-slot="kbd-group" className={cn('inline-flex items-center gap-1', className)} {...props} />;
}

export { Kbd, KbdGroup };
