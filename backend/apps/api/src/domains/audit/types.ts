import { type ChangeType, type ChangedField, type NodeType } from './entities/DeltaEntity';

export interface CreateDeltaDto {
  deltaId?: string;
  entityId?: string | null;
  relationshipId?: string | null;
  nodeType: NodeType;
  entityType?: string | null;
  relationshipType?: string | null;
  fromEntityId?: string | null;
  toEntityId?: string | null;
  changeType: ChangeType;
  changedFields: Record<string, ChangedField>;
  changeSource?: string | null;
  changeReason?: string | null;
  summaryId?: string | null;
  changedByUserId?: string | null;
  ownerUserId: string;
}

export interface FindDeltasOptions {
  entityId?: string;
  relationshipId?: string;
  nodeType?: NodeType;
  changeType?: ChangeType;
  unsummarizedOnly?: boolean;
  since?: Date;
  until?: Date;
  limit?: number;
}

export interface UpdateDeltasSummaryDto {
  deltaIds: string[];
  summaryId: string;
}
