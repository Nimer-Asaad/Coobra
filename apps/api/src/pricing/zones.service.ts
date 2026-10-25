import { Injectable } from '@nestjs/common';
import type { Prisma, Zone, ZoneKind } from '@coobra/database';
import type {
  CreateZoneInput,
  CreateZoneKindInput,
  UpdateZoneInput,
  UpdateZoneKindInput,
  ZoneItem,
  ZoneKindItem,
  ZoneLabel,
} from '@coobra/shared';
import { AuditService } from '../audit/audit.service.js';
import { isUniqueViolation } from '../auth/auth.service.js';
import { Errors } from '../common/app-exception.js';
import type { RequestMeta } from '../common/request.js';
import { PrismaService } from '../prisma/prisma.service.js';

type Db = Prisma.TransactionClient;
type Actor = { id: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ZonePathNode {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  depth: number;
  active: boolean;
}

/** Root-to-leaf path of a zone. */
export type ZonePath = ZonePathNode[];

export function zoneLabel(path: ZonePath): ZoneLabel {
  const leaf = path[path.length - 1];
  if (!leaf) throw new Error('Empty zone path');
  return {
    id: leaf.id,
    code: leaf.code,
    nameAr: leaf.nameAr,
    nameEn: leaf.nameEn,
    pathAr: path.map((zone) => zone.nameAr).join(' / '),
    pathEn: path.map((zone) => zone.nameEn).join(' / '),
  };
}

export function toZoneItem(zone: Zone): ZoneItem {
  return {
    id: zone.id,
    code: zone.code,
    kindId: zone.kindId,
    parentId: zone.parentId,
    depth: zone.depth,
    nameAr: zone.nameAr,
    nameEn: zone.nameEn,
    active: zone.active,
    sortOrder: zone.sortOrder,
  };
}

function toZoneKindItem(kind: ZoneKind): ZoneKindItem {
  return {
    id: kind.id,
    code: kind.code,
    nameAr: kind.nameAr,
    nameEn: kind.nameEn,
    sortOrder: kind.sortOrder,
  };
}

/** The delivery zone tree. Codes are stable identifiers; the parent never changes. */
@Injectable()
export class ZonesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Loads a zone and its ancestors (root first). Throws ZONE_INVALID if it does not exist. */
  async path(db: Db, zoneId: string): Promise<ZonePath> {
    if (!UUID_PATTERN.test(zoneId)) throw Errors.zoneInvalid();
    const rows = await db.$queryRaw<
      {
        id: string;
        code: string;
        name_ar: string;
        name_en: string;
        depth: number;
        active: boolean;
      }[]
    >`
      WITH RECURSIVE path AS (
        SELECT id, parent_id, code, name_ar, name_en, depth, active FROM zones WHERE id = ${zoneId}::uuid
        UNION ALL
        SELECT z.id, z.parent_id, z.code, z.name_ar, z.name_en, z.depth, z.active
        FROM zones z JOIN path p ON z.id = p.parent_id
      )
      SELECT id, code, name_ar, name_en, depth, active FROM path ORDER BY depth`;
    if (rows.length === 0) throw Errors.zoneInvalid();
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      nameAr: row.name_ar,
      nameEn: row.name_en,
      depth: Number(row.depth),
      active: row.active,
    }));
  }

  /** A zone usable for new shipments and pricing: it and all its ancestors are active. */
  async activePath(db: Db, zoneId: string): Promise<ZonePath> {
    const path = await this.path(db, zoneId);
    if (path.some((zone) => !zone.active)) throw Errors.zoneInactive();
    return path;
  }

  /** Labels for many zones at once (for lists). */
  async labels(db: Db, zoneIds: string[]): Promise<Map<string, ZoneLabel>> {
    const unique = [...new Set(zoneIds)];
    const result = new Map<string, ZoneLabel>();
    if (unique.length === 0) return result;
    const all = await db.zone.findMany({
      select: {
        id: true,
        parentId: true,
        code: true,
        nameAr: true,
        nameEn: true,
        depth: true,
        active: true,
      },
    });
    const byId = new Map(all.map((zone) => [zone.id, zone]));
    for (const id of unique) {
      const path: ZonePath = [];
      for (
        let zone = byId.get(id);
        zone;
        zone = zone.parentId ? byId.get(zone.parentId) : undefined
      ) {
        path.unshift(zone);
      }
      if (path.length > 0) result.set(id, zoneLabel(path));
    }
    return result;
  }

  async listKinds(): Promise<ZoneKindItem[]> {
    const kinds = await this.prisma.client.zoneKind.findMany({ orderBy: { sortOrder: 'asc' } });
    return kinds.map(toZoneKindItem);
  }

  async createKind(actor: Actor, input: CreateZoneKindInput, meta: RequestMeta) {
    try {
      const kind = await this.prisma.client.zoneKind.create({ data: input });
      await this.audit.record({
        action: 'ZONE_KIND_CREATED',
        actorUserId: actor.id,
        meta,
        metadata: { zoneKindId: kind.id, code: kind.code },
      });
      return toZoneKindItem(kind);
    } catch (error) {
      if (isUniqueViolation(error)) throw Errors.validation({ code: 'validation.zone.codeTaken' });
      throw error;
    }
  }

  async updateKind(actor: Actor, id: string, input: UpdateZoneKindInput, meta: RequestMeta) {
    if (!UUID_PATTERN.test(id)) throw Errors.notFound();
    const existing = await this.prisma.client.zoneKind.findUnique({ where: { id } });
    if (!existing) throw Errors.notFound();
    const kind = await this.prisma.client.zoneKind.update({ where: { id }, data: input });
    await this.audit.record({
      action: 'ZONE_KIND_UPDATED',
      actorUserId: actor.id,
      meta,
      metadata: { zoneKindId: id, changes: { ...input } },
    });
    return toZoneKindItem(kind);
  }

  async list({ includeInactive }: { includeInactive: boolean }): Promise<ZoneItem[]> {
    const zones = await this.prisma.client.zone.findMany({
      where: includeInactive ? {} : { active: true },
      orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }, { nameEn: 'asc' }],
    });
    if (includeInactive) return zones.map(toZoneItem);
    // Hide active children of inactive parents.
    const visible = new Set<string>();
    return zones
      .filter((zone) => {
        const ok = !zone.parentId || visible.has(zone.parentId);
        if (ok) visible.add(zone.id);
        return ok;
      })
      .map(toZoneItem);
  }

  async create(actor: Actor, input: CreateZoneInput, meta: RequestMeta): Promise<ZoneItem> {
    const kind = await this.prisma.client.zoneKind.findUnique({ where: { id: input.kindId } });
    if (!kind) throw Errors.validation({ kindId: 'validation.zone.kind' });
    let depth = 0;
    if (input.parentId) {
      const parent = await this.prisma.client.zone.findUnique({ where: { id: input.parentId } });
      if (!parent) throw Errors.validation({ parentId: 'validation.zone.parent' });
      depth = parent.depth + 1;
    }
    try {
      const zone = await this.prisma.client.zone.create({ data: { ...input, depth } });
      await this.audit.record({
        action: 'ZONE_CREATED',
        actorUserId: actor.id,
        meta,
        metadata: { zoneId: zone.id, code: zone.code, parentId: zone.parentId },
      });
      return toZoneItem(zone);
    } catch (error) {
      if (isUniqueViolation(error)) throw Errors.validation({ code: 'validation.zone.codeTaken' });
      throw error;
    }
  }

  async update(actor: Actor, id: string, input: UpdateZoneInput, meta: RequestMeta) {
    if (!UUID_PATTERN.test(id)) throw Errors.notFound();
    const existing = await this.prisma.client.zone.findUnique({ where: { id } });
    if (!existing) throw Errors.notFound();
    const zone = await this.prisma.client.zone.update({ where: { id }, data: input });
    await this.audit.record({
      action: 'ZONE_UPDATED',
      actorUserId: actor.id,
      meta,
      metadata: { zoneId: id, code: zone.code, changes: { ...input } },
    });
    return toZoneItem(zone);
  }
}
