import { WIZARD_BUNDLES } from '../bundles';
import { WIZARD_SOURCES } from '../guides';

/**
 * A bundle is a promise about the guides: "this one download covers these
 * sources". The promise is only as good as the ids it names, and nothing at
 * runtime checks them — a member with no guide would make the wizard show a
 * bundle covering a service nobody can find, and a member outside the
 * bundle's ecosystem would be filtered out of its tile silently.
 */
describe('WIZARD_BUNDLES', () => {
  const guideById = new Map(WIZARD_SOURCES.map((source) => [source.id, source]));

  it('names only sources that have a guide', () => {
    const unknown = WIZARD_BUNDLES.flatMap((bundle) =>
      bundle.members.filter((member) => !guideById.has(member)).map((member) => `${bundle.id} → ${member}`),
    );

    expect(unknown).toEqual([]);
  });

  it("keeps every member inside the bundle's own ecosystem", () => {
    const strays = WIZARD_BUNDLES.flatMap((bundle) =>
      bundle.members
        .filter((member) => guideById.get(member)?.ecosystem !== bundle.ecosystem)
        .map((member) => `${bundle.id} → ${member}`),
    );

    expect(strays).toEqual([]);
  });

  it('leads one ecosystem each, with a distinct id', () => {
    expect(new Set(WIZARD_BUNDLES.map((bundle) => bundle.ecosystem)).size).toBe(WIZARD_BUNDLES.length);
    expect(new Set(WIZARD_BUNDLES.map((bundle) => bundle.id)).size).toBe(WIZARD_BUNDLES.length);
  });

  it('tells the person how to get the export', () => {
    for (const bundle of WIZARD_BUNDLES) {
      expect(bundle.steps.length).toBeGreaterThan(0);
      expect(bundle.members.length).toBeGreaterThan(1);
    }
  });
});
