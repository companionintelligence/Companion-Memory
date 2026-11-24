import { Injectable } from '@nestjs/common';

export type GraphWriterOrigin = 'compaction' | 'concept_extraction' | 'graph_ingest' | 'manual';

export interface GraphEntityProvenance {
  sourceWriter: GraphWriterOrigin;
  sourceRecordId?: string;
  extractedAt: string;
  confidence: number;
}

export interface GraphEntityCandidate {
  name: string;
  entityType: string;
  aliases?: string[];
  description?: string;
  confidence?: number;
  sourceWriter: GraphWriterOrigin;
  sourceRecordId?: string;
  extractedAt?: string;
}

export interface ExistingGraphEntity {
  id: string;
  name: string;
  entityType: string;
  aliases?: string[];
  confidence?: number;
  provenance?: GraphEntityProvenance[];
}

export interface ReconciledEntityAction {
  action: 'create' | 'merge';
  matchedEntityId: string | null;
  canonicalName: string;
  normalizedKey: string;
  entityType: string;
  aliases: string[];
  description?: string;
  confidence: number;
  provenance: GraphEntityProvenance[];
}

const PERSON_HONORIFICS = /^(dr|prof|professor|mr|mrs|ms|miss|mx|sir|madam)\.?(\s+|$)/i;
const ORG_SUFFIXES = /\b(inc|incorporated|corp|corporation|llc|ltd|limited|co|company|plc|gmbh)\.?$/i;

/**
 * Canonical normalization for entity names across all three graph writers
 * (`MemoryCompactionService`, `ConceptExtractionService`, `GraphIngestService`).
 */
export function normalizeEntityName(rawName: string, entityType: string): string {
  let cleaned = rawName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ');

  const normalizedType = entityType.trim().toLowerCase();
  if (normalizedType === 'person') {
    cleaned = cleaned.replace(PERSON_HONORIFICS, '').trim();
    // Strip single middle initials like "Jane M. Doe" -> "Jane Doe" for key matching
    cleaned = cleaned.replace(/^(\S+)\s+[A-Za-z]\.?\s+(\S+)$/, '$1 $2');
  } else if (normalizedType === 'organization' || normalizedType === 'company') {
    cleaned = cleaned.replace(/,\s*$/, '').replace(ORG_SUFFIXES, '').trim();
  }

  return cleaned
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeEntityKey(rawName: string, entityType: string): string {
  const normType = entityType.trim().toLowerCase();
  const normName = normalizeEntityName(rawName, normType);

  return `${normType}::${normName}`;
}

/**
 * Deterministic lexical/alias similarity in `[0, 1]` between two entity names of
 * the same type. Used by the gateway to merge aliases before requiring an LLM
 * or embedding round-trip.
 */
export function computeEntityAliasSimilarity(nameA: string, nameB: string, entityType: string): number {
  const normA = normalizeEntityName(nameA, entityType);
  const normB = normalizeEntityName(nameB, entityType);

  if (!normA || !normB) {
    return 0;
  }

  if (normA === normB) {
    return 1;
  }

  const tokensA = new Set(normA.split(' ').filter(Boolean));
  const tokensB = new Set(normB.split(' ').filter(Boolean));

  if (tokensA.size === 0 || tokensB.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) {
      intersection += 1;
    }
  }

  const union = tokensA.size + tokensB.size - intersection;
  const jaccard = union > 0 ? intersection / union : 0;

  // Boost when one normalized multi-character string is a prefix of the other (e.g. "acme" vs "acme labs")
  if (normA.length >= 4 && normB.length >= 4 && (normA.startsWith(normB) || normB.startsWith(normA))) {
    return Math.max(jaccard, 0.85);
  }

  return jaccard;
}

/**
 * Unified Entity Resolution & Graph Write Gateway.
 *
 * Consolidates entity normalization, alias deduplication, and provenance tracking
 * across `MemoryCompactionService`, `ConceptExtractionService`, and `GraphIngestService`
 * so all writers produce consistent entity keys, alias sets, and audit provenance.
 */
@Injectable()
export class EntityGraphGatewayService {
  normalizeKey(name: string, entityType: string): string {
    return normalizeEntityKey(name, entityType);
  }

  /**
   * Reconciles a batch of extracted entity candidates against existing entities
   * and deduplicates within the batch itself.
   */
  reconcileCandidateBatch(
    candidates: readonly GraphEntityCandidate[],
    existing: readonly ExistingGraphEntity[] = [],
    options: { similarityThreshold?: number; nowIso?: string } = {},
  ): ReconciledEntityAction[] {
    const threshold = options.similarityThreshold ?? 0.82;
    const nowIso = options.nowIso ?? new Date().toISOString();

    const results: ReconciledEntityAction[] = [];

    for (const candidate of candidates) {
      const trimmedName = candidate.name.trim();
      const trimmedType = candidate.entityType.trim();
      if (!trimmedName || !trimmedType) {
        continue;
      }

      const normalizedKey = normalizeEntityKey(trimmedName, trimmedType);
      const candidateNames = [trimmedName, ...(candidate.aliases ?? []).map((a) => a.trim()).filter(Boolean)];
      const provenanceEntry: GraphEntityProvenance = {
        sourceWriter: candidate.sourceWriter,
        ...(candidate.sourceRecordId ? { sourceRecordId: candidate.sourceRecordId } : {}),
        extractedAt: candidate.extractedAt ?? nowIso,
        confidence: candidate.confidence ?? 0.8,
      };

      // 1. Check if this candidate matches an already-reconciled item in the current batch
      const intraBatchMatch = results.find(
        (item) =>
          item.entityType.toLowerCase() === trimmedType.toLowerCase() &&
          (item.normalizedKey === normalizedKey ||
            this.maxAliasSimilarity(candidateNames, [item.canonicalName, ...item.aliases], trimmedType) >=
              threshold),
      );

      if (intraBatchMatch) {
        for (const alias of candidateNames) {
          if (
            alias.toLowerCase() !== intraBatchMatch.canonicalName.toLowerCase() &&
            !intraBatchMatch.aliases.some((a) => a.toLowerCase() === alias.toLowerCase())
          ) {
            intraBatchMatch.aliases.push(alias);
          }
        }

        intraBatchMatch.confidence = Math.max(intraBatchMatch.confidence, provenanceEntry.confidence);
        if (!intraBatchMatch.description && candidate.description) {
          intraBatchMatch.description = candidate.description;
        }

        intraBatchMatch.provenance.push(provenanceEntry);
        continue;
      }

      // 2. Check against existing graph entities of the same type
      const existingMatch = existing.find(
        (node) =>
          node.entityType.toLowerCase() === trimmedType.toLowerCase() &&
          (normalizeEntityKey(node.name, node.entityType) === normalizedKey ||
            this.maxAliasSimilarity(candidateNames, [node.name, ...(node.aliases ?? [])], trimmedType) >=
              threshold),
      );

      if (existingMatch) {
        const mergedAliases = [...(existingMatch.aliases ?? [])];
        for (const alias of candidateNames) {
          if (
            alias.toLowerCase() !== existingMatch.name.toLowerCase() &&
            !mergedAliases.some((a) => a.toLowerCase() === alias.toLowerCase())
          ) {
            mergedAliases.push(alias);
          }
        }

        results.push({
          action: 'merge',
          matchedEntityId: existingMatch.id,
          canonicalName: existingMatch.name,
          normalizedKey: normalizeEntityKey(existingMatch.name, existingMatch.entityType),
          entityType: existingMatch.entityType,
          aliases: mergedAliases,
          description: candidate.description,
          confidence: Math.max(existingMatch.confidence ?? 0.8, provenanceEntry.confidence),
          provenance: [...(existingMatch.provenance ?? []), provenanceEntry],
        });
        continue;
      }

      // 3. New entity
      const uniqueAliases = (candidate.aliases ?? [])
        .map((a) => a.trim())
        .filter((a) => a.length > 0 && a.toLowerCase() !== trimmedName.toLowerCase());

      results.push({
        action: 'create',
        matchedEntityId: null,
        canonicalName: trimmedName,
        normalizedKey,
        entityType: trimmedType,
        aliases: [...new Set(uniqueAliases)],
        description: candidate.description,
        confidence: provenanceEntry.confidence,
        provenance: [provenanceEntry],
      });
    }

    return results;
  }

  private maxAliasSimilarity(
    namesA: readonly string[],
    namesB: readonly string[],
    entityType: string,
  ): number {
    let best = 0;
    for (const a of namesA) {
      for (const b of namesB) {
        const sim = computeEntityAliasSimilarity(a, b, entityType);
        if (sim > best) {
          best = sim;
        }
      }
    }

    return best;
  }
}
