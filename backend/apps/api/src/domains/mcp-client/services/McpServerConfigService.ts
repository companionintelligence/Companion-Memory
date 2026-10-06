import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';

import { HIGH_RISK_CATALOG_SLUGS } from '../catalog/mcpSuggestedCatalog';
import { McpServerConfigEntity } from '../entities/McpServerConfigEntity';
import { decryptedDraftFromEntity } from '../mapping';
import type {
  ApproveMcpToolsDto,
  CreateMcpServerConfigDto,
  McpApprovedTool,
  McpProbeResult,
  McpServerConfigEgress,
  McpTransport,
  TestMcpServerConfigDraftDto,
  UpdateMcpServerConfigDto,
} from '../types';

import { McpClientManagerService } from './McpClientManagerService';
import { McpSecretCodec } from './McpSecretCodec';
import { computeDescriptionDigest, computeSchemaDigest, grandfatherApprovals } from './mcpToolDigest';

/**
 * CRUD over `ci.mcp_server_configs`, scoped to the calling user, plus the security-critical
 * pieces the controller cannot be trusted to have already done: transport-field validation, the
 * high-risk catalog re-check, and per-field secret encryption/decryption.
 *
 * Every mutation ends with a call into {@link McpClientManagerService.onConfigChanged} so the live
 * connection pool never drifts from what is stored — this service never touches a live connection
 * directly.
 */
@Injectable()
export class McpServerConfigService {
  constructor(
    @InjectRepository(McpServerConfigEntity)
    private readonly repo: Repository<McpServerConfigEntity>,
    private readonly secretCodec: McpSecretCodec,
    private readonly manager: McpClientManagerService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(McpServerConfigService.name);
  }

  async listForUser(userId: string): Promise<McpServerConfigEgress[]> {
    const rows = await this.repo.find({ where: { userId }, order: { createdAt: 'ASC' } });

    return rows.map((row) => McpServerConfigEntity.toEgressType(row));
  }

  async create(userId: string, dto: CreateMcpServerConfigDto): Promise<McpServerConfigEgress> {
    this.assertTransportFieldsValid(dto.transport, dto.command ?? null, dto.url ?? null);

    // Re-validated independently of whatever the client already showed the user — a request
    // forged (or replayed) without ever rendering the confirmation UI must still be rejected.
    if (
      dto.catalogSlug &&
      HIGH_RISK_CATALOG_SLUGS.has(dto.catalogSlug) &&
      dto.acknowledgedHighRisk !== true
    ) {
      throw new BadRequestException(
        `"${dto.catalogSlug}" is a high-risk MCP server and requires acknowledgedHighRisk: true to add`,
      );
    }

    const slug = await this.resolveUniqueSlug(userId, dto.slug ?? dto.name);

    const entity = this.repo.create({
      id: uuidv7(),
      userId,
      name: dto.name,
      slug,
      transport: dto.transport,
      command: dto.command ?? null,
      args: dto.args ?? [],
      env: this.secretCodec.encryptEntries(dto.env ?? []),
      url: dto.url ?? null,
      auth: this.secretCodec.encryptAuth(dto.auth ?? null),
      enabled: dto.enabled ?? true,
      source: dto.source ?? 'user_added',
      catalogSlug: dto.catalogSlug ?? null,
      discoveredTools: null,
      // `[]`, never null: a server added after the approval gate exists contributes zero tools to
      // chat until someone approves them. null is reserved for pre-gate rows (legacy passthrough).
      approvedTools: [],
      connectionStatus: 'disconnected',
    });

    const saved = await this.repo.save(entity);

    await this.manager.onConfigChanged(saved.id, 'created');

    return McpServerConfigEntity.toEgressType(saved);
  }

  async update(userId: string, id: string, dto: UpdateMcpServerConfigDto): Promise<McpServerConfigEgress> {
    const existing = await this.findOwned(userId, id);

    const transport = dto.transport ?? existing.transport;
    const command = dto.command !== undefined ? dto.command : existing.command;
    const url = dto.url !== undefined ? dto.url : existing.url;

    this.assertTransportFieldsValid(transport, command ?? null, url ?? null);

    const env = dto.env
      ? this.secretCodec.encryptEntries(this.secretCodec.mergeEntriesForUpdate(existing.env ?? [], dto.env))
      : existing.env;

    const auth =
      dto.auth !== undefined
        ? dto.auth
          ? this.secretCodec.encryptAuth({
              type: dto.auth.type,
              fields: this.secretCodec.mergeEntriesForUpdate(
                existing.auth?.fields ?? [],
                dto.auth.fields ?? [],
              ),
            })
          : null
        : existing.auth;

    await this.repo.update(id, {
      name: dto.name ?? existing.name,
      transport,
      command: command ?? null,
      args: dto.args ?? existing.args,
      env,
      url: url ?? null,
      auth,
      enabled: dto.enabled ?? existing.enabled,
    });

    await this.manager.onConfigChanged(id, 'updated');

    const updated = await this.findOwned(userId, id);

    return McpServerConfigEntity.toEgressType(updated);
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.findOwned(userId, id);

    await this.repo.delete(id);
    await this.manager.onConfigChanged(id, 'deleted');
  }

  async setEnabled(userId: string, id: string, enabled: boolean): Promise<McpServerConfigEgress> {
    await this.findOwned(userId, id);

    await this.repo.update(id, { enabled });
    await this.manager.onConfigChanged(id, 'toggled');

    const updated = await this.findOwned(userId, id);

    return McpServerConfigEntity.toEgressType(updated);
  }

  /**
   * Approve (or revoke) individual tools on one server — the grant `McpToolProvider` intersects
   * against. Merge semantics, not replace: a request naming three tools leaves every other stored
   * approval alone, so the settings screen can approve one drifted tool without silently revoking
   * the twenty that were fine.
   *
   * Each `tools[]` entry must carry the schema digest the client was shown, and may carry the
   * description digest. Each is re-derived from the tool currently stored in `discovered_tools` and
   * a mismatch is rejected — otherwise a schema
   * that drifted between rendering the list and clicking Approve would be approved sight-unseen,
   * which is the exact failure this feature exists to prevent.
   */
  async approveTools(userId: string, id: string, dto: ApproveMcpToolsDto): Promise<McpServerConfigEgress> {
    const existing = await this.findOwned(userId, id);
    const discovered = existing.discoveredTools ?? [];
    const approvedAt = new Date().toISOString();

    let next: McpApprovedTool[];

    if (dto.approveAll) {
      // The escape hatch a strict pin needs: re-bless everything this server currently offers,
      // preserving the provenance of every entry whose digest did not actually move.
      next = grandfatherApprovals(discovered, existing.approvedTools, userId, approvedAt);
    } else {
      const byName = new Map((existing.approvedTools ?? []).map((entry) => [entry.name, entry]));

      for (const requested of dto.tools ?? []) {
        const tool = discovered.find((candidate) => candidate.name === requested.name);

        if (!tool) {
          throw new BadRequestException(`"${requested.name}" is not currently offered by this MCP server`);
        }

        const actual = computeSchemaDigest(tool);
        const descriptionDigest = computeDescriptionDigest(tool);

        if (actual !== requested.schemaDigest) {
          throw new BadRequestException(
            `The schema for "${requested.name}" changed since it was shown to you; re-review it before approving`,
          );
        }

        // Optional on the wire (an older client sends only the schema digest), checked when sent:
        // the description is what the assistant reads, so one that moved between rendering the
        // list and clicking Approve must be reviewed again too.
        if (requested.descriptionDigest !== undefined && requested.descriptionDigest !== descriptionDigest) {
          throw new BadRequestException(
            `The description of "${requested.name}" changed since it was shown to you; re-review it before approving`,
          );
        }

        byName.set(requested.name, {
          name: requested.name,
          schemaDigest: actual,
          descriptionDigest,
          approvedAt,
          approvedBy: userId,
        });
      }

      for (const name of dto.revoke ?? []) {
        byName.delete(name);
      }

      next = Array.from(byName.values());
    }

    await this.repo.update(id, { approvedTools: next } as never);
    await this.manager.onToolApprovalsChanged();

    const updated = await this.findOwned(userId, id);

    return McpServerConfigEntity.toEgressType(updated);
  }

  async testConnection(userId: string, id: string): Promise<McpProbeResult> {
    const existing = await this.findOwned(userId, id);
    const draft = decryptedDraftFromEntity(existing, this.secretCodec);

    return this.manager.probe(draft);
  }

  async testDraftConnection(dto: TestMcpServerConfigDraftDto): Promise<McpProbeResult> {
    this.assertTransportFieldsValid(dto.transport, dto.command ?? null, dto.url ?? null);

    return this.manager.probe(dto);
  }

  private async findOwned(userId: string, id: string): Promise<McpServerConfigEntity> {
    const existing = await this.repo.findOne({ where: { id, userId } });

    if (!existing) {
      throw new NotFoundException('MCP server config not found');
    }

    return existing;
  }

  private assertTransportFieldsValid(
    transport: McpTransport,
    command: string | null,
    url: string | null,
  ): void {
    if (transport === 'stdio' && !command) {
      throw new BadRequestException('A stdio MCP server requires a command');
    }

    if (transport === 'http' && !url) {
      throw new BadRequestException('An http MCP server requires a url');
    }
  }

  private async resolveUniqueSlug(userId: string, source: string): Promise<string> {
    const base = slugify(source);
    let candidate = base;
    let suffix = 2;

    while (await this.repo.exist({ where: { userId, slug: candidate } })) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }

    return candidate;
  }
}

function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return base.length > 0 ? base : 'server';
}
