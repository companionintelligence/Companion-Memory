import { Injectable } from '@nestjs/common';

import { type BrowserActivity } from '@ci/domains/browser-activity';
import { type Thread } from '@ci/domains/conversations';
import { type ResolvedEntity } from '@ci/domains/entity-resolution';
import { type SignedFile } from '@ci/domains/files';
import { type Answer } from '@ci/domains/intelligence';
import {
  type Communication,
  type Concept,
  type Content,
  type Event,
  type Item,
  type Person,
  type Place,
} from '@ci/domains/memory';
import { type Note } from '@ci/domains/notes';

/**
 * Serialises resolved domain entities into compact, human-readable lines for
 * LLM context injection.  Keeping token counts low is the primary goal.
 *
 * Format convention: "[label] Name — detail"
 *
 * This service is exported from AgentModule so it can be consumed by the
 * MCP domain without duplicating serialisation logic.
 */

// ---------------------------------------------------------------------------
// Module-level helpers (pure, no side-effects)
// ---------------------------------------------------------------------------

function str(val: unknown): string {
  return typeof val === 'string' && val.trim().length > 0 ? val.trim() : '';
}

/** Join non-empty parts with ' — ', discarding blanks. */
function join(label: string, ...details: (string | null | undefined)[]): string {
  const tail = details
    .map((d) => (typeof d === 'string' ? d.trim() : ''))
    .filter((d) => d.length > 0)
    .join(', ');

  return tail ? `${label} — ${tail}` : label;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class SerializerService {
  /**
   * Dispatch a resolved entity to the appropriate serializer.
   * Returns null for types that have no serialisation (e.g. 'action').
   */
  serialize(resolved: ResolvedEntity): string | null {
    switch (resolved.type) {
      case 'person':
        return this.serializePerson(resolved.entity);
      case 'concept':
        return this.serializeConcept(resolved.entity);
      case 'event':
        return this.serializeEvent(resolved.entity);
      case 'place':
        return this.serializePlace(resolved.entity);
      case 'item':
        return this.serializeItem(resolved.entity);
      case 'content':
        return this.serializeContent(resolved.entity);
      case 'communication':
        return this.serializeCommunication(resolved.entity);
      case 'note':
        return this.serializeNote(resolved.entity);
      case 'browser-activity':
        return this.serializeBrowserActivity(resolved.entity);
      case 'file':
        return this.serializeFile(resolved.entity);
      case 'answer':
        return this.serializeAnswer(resolved.entity);
      case 'thread':
        return this.serializeThread(resolved.entity);
      default:
        return null;
    }
  }

  // ---- per-type private methods -------------------------------------------

  private serializePerson(entity: Person) {
    const label = entity.name ?? 'Unknown person';
    const parts: string[] = [];
    const props = entity.properties ?? {};
    const occupation = str(props['occupation']);
    const age = props['age'] != null ? `age ${props['age']}` : '';
    if (occupation) {
      parts.push(occupation);
    }

    if (age) {
      parts.push(age);
    }

    const detail = parts.length > 0 ? parts.join(', ') : (entity.description?.slice(0, 120) ?? '');

    return join(label, detail);
  }

  private serializeConcept(entity: Concept) {
    const props = entity.properties ?? {};
    const type = str(props['type']) || str(props['subtype']);
    const label = type ? `${entity.name ?? 'Unknown concept'} (${type})` : (entity.name ?? 'Unknown concept');

    return join(label, entity.description?.slice(0, 120));
  }

  private serializeEvent(entity: Event) {
    const date =
      entity.startTime instanceof Date
        ? entity.startTime.toISOString()
        : entity.startTime
          ? String(entity.startTime)
          : '';
    const label = date ? `${entity.title ?? 'Event'} [${date}]` : (entity.title ?? 'Event');

    return join(label, entity.description?.slice(0, 120));
  }

  private serializePlace(entity: Place) {
    const props = entity.properties ?? {};
    const address = str(props['address']);

    return join(entity.name ?? 'Unknown place', entity.description?.slice(0, 100), address);
  }

  private serializeItem(entity: Item) {
    const condition = entity.condition ? str(entity.condition) : '';
    const parts = [entity.description?.slice(0, 80) ?? '', condition ? `condition: ${condition}` : ''].filter(
      Boolean,
    );

    return join(`[Item] ${entity.name ?? 'Unknown item'}`, ...parts);
  }

  private serializeContent(entity: Content) {
    const detail = entity.text?.slice(0, 120) ?? '';

    return join(`[Content] ${entity.title ?? 'Untitled'}`, detail);
  }

  private serializeCommunication(entity: Communication) {
    const date = new Date(entity.time).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    const snippet = (entity.summary ?? entity.content).slice(0, 200);

    return `[${entity.direction}, ${date}] "${snippet}"`;
  }

  private serializeNote(entity: Note) {
    return join(`[Note] ${entity.title ?? 'Untitled'}`, entity.content?.slice(0, 120));
  }

  private serializeBrowserActivity(entity: BrowserActivity) {
    const label = entity.title ? `[Browser] ${entity.title}` : `[Browser] ${entity.url.slice(0, 80)}`;
    const detail = entity.title && entity.url !== entity.title ? entity.url.slice(0, 80) : '';

    return join(label, detail);
  }

  private serializeFile(entity: SignedFile) {
    const name = entity.title ?? entity.filename ?? 'Unknown file';
    const meta = entity.contentType ? `(${entity.contentType})` : '';

    return join(`[File] ${name}`, meta, entity.description?.slice(0, 80));
  }

  private serializeAnswer(entity: Answer) {
    return `[Answer] "${entity.answer.slice(0, 200)}"`;
  }

  private serializeThread(entity: Thread) {
    return join(`[Thread] ${entity.name ?? 'Untitled'}`, entity.description?.slice(0, 120));
  }
}
