import type { CliContext } from '../context';
import { json, table } from '../output';

export interface DataSourcesOptions {
  json?: boolean;
  /**
   * List authored SERVICES rather than parsers.
   *
   * The two lists differ on purpose and both are worth having: several services
   * share the `generic` parser, and a service whose importer is not written yet
   * has no parser at all but still belongs in an answer to "can this appliance
   * take my Instagram export?" — `importerReady: false` says "known, not yet
   * built", which is a different answer from silence.
   */
  catalog?: boolean;
}

/** What this appliance can import. */
export async function dataSourcesCommand(ctx: CliContext, options: DataSourcesOptions = {}): Promise<void> {
  if (options.catalog) {
    const entries = await ctx.client.sourceCatalog();

    if (options.json) {
      json(ctx.term, entries);

      return;
    }

    // WIZARD_SOURCES order is curated (tier, then ecosystem) and carries
    // meaning — best-first within a section. Printed as received; never sorted.
    ctx.term.out(
      table(entries, [
        { header: 'id', value: (entry) => entry.id },
        { header: 'title', value: (entry) => entry.title },
        { header: 'importer', value: (entry) => entry.importer },
        { header: 'ready', value: (entry) => (entry.importerReady ? 'yes' : '') },
        { header: 'ecosystem', value: (entry) => entry.ecosystem },
        { header: 'acquisition', value: (entry) => entry.acquisition },
      ]),
    );
    ctx.term.out(`\n${entries.length} authored source(s).`);

    return;
  }

  const sources = await ctx.client.listSources();

  if (options.json) {
    json(ctx.term, sources);

    return;
  }

  ctx.term.out(
    table(sources, [
      { header: 'name', value: (source) => source.name },
      { header: 'title', value: (source) => source.title },
      { header: 'file', value: (source) => (source.supportsFiles ? 'yes' : '') },
      { header: 'api', value: (source) => (source.supportsApi ? 'yes' : '') },
      { header: 'stub', value: (source) => (source.stub ? 'yes' : '') },
    ]),
  );

  const stubs = sources.filter((source) => source.stub).length;

  ctx.term.out(
    `\n${sources.length} importer(s)` +
      (stubs > 0 ? `, ${stubs} recognized but not yet implemented (stub).` : '.'),
  );
}
