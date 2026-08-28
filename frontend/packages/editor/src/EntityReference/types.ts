/** A reference target — one row in the `[[` autocomplete, one link once inserted. */
export interface EntityReferenceItem {
  /**
   * The target's GlobalUID (opaque base64 `type:id`). Stored on the node, so a
   * reference keeps pointing at the same record even if its name changes.
   */
  uid: string;
  /** Entity-type slug from the GlobalUID, e.g. `note`, `person`, `place`. */
  type: string;
  /** Display text captured at insert time. */
  label: string;
}

export interface EntityReferenceConfig {
  /**
   * Look up reference candidates for what the user has typed after `[[`.
   * Called per keystroke, so the host should keep it cheap — the web app
   * serves it from the Apollo cache where it can.
   */
  search: (query: string) => Promise<EntityReferenceItem[]>;
  /**
   * Route for a reference. Owned by the host because the editor package has no
   * business knowing the app's URL scheme; it is called at render time rather
   * than baked into stored HTML, so routes can change without rewriting notes.
   */
  resolveHref: (item: { uid: string; type: string }) => string;
}
