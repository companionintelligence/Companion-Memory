import { Button } from '@ci/shadcn';
import { Cable, Database, Download, ExternalLink } from '@ci/shadcn/icons';

const IMPORT_TOOLS_URL = 'https://hub.ci.computer/store/ci-import-tools';

export function DataImportStep() {
  return (
    <div className="space-y-6 py-6 md:w-sm">
      <div className="space-y-3 text-center md:text-left">
        <div className="inline-flex items-center justify-center gap-2 rounded-full bg-teal-500/10 px-3 py-1 text-xs font-semibold text-teal-700 dark:text-teal-300">
          <Database className="h-3.5 w-3.5" />
          Build your memory faster
        </div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">
          Bring your existing data with you
        </h1>
        <p className="text-sm leading-6 text-muted-foreground">
          Companion gets more useful when it can start from your real history. Import tools help you bring in
          files, exports, calendars, messages, photos, and other sources you already have.
        </p>
      </div>

      <section className="space-y-4 rounded-xl border border-border/70 bg-muted/30 p-4">
        <div className="flex gap-3">
          <div className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-500/15 text-teal-700 dark:text-teal-300">
            <Download className="h-4 w-4" />
          </div>
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-foreground">Start with import tools</h2>
            <p className="text-sm leading-6 text-muted-foreground">
              Use the import tools package to pull in local exports and seed your memory before you begin.
            </p>
          </div>
        </div>

        <Button className="w-full justify-center gap-2" asChild>
          <a href={IMPORT_TOOLS_URL} target="_blank" rel="noopener noreferrer">
            Get import tools
            <ExternalLink className="h-4 w-4" />
          </a>
        </Button>
      </section>

      <section className="space-y-4 rounded-xl border border-border/70 bg-background/70 p-4">
        <div className="flex gap-3">
          <div className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/15 text-blue-700 dark:text-blue-300">
            <Cable className="h-4 w-4" />
          </div>
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-foreground">Add live connections too</h2>
            <p className="text-sm leading-6 text-muted-foreground">
              Connect accounts and devices so new activity keeps flowing in after setup.
            </p>
          </div>
        </div>

        <Button className="w-full justify-center gap-2" variant="outline" asChild>
          <a href="/connect" target="_blank" rel="noopener noreferrer">
            Open connections
            <ExternalLink className="h-4 w-4" />
          </a>
        </Button>
      </section>
    </div>
  );
}
