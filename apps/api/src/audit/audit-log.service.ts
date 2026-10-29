import { Injectable } from '@nestjs/common';
import { Prisma } from '@coobra/database';
import {
  actionsInCategory,
  AUDIT_ENTITY_KEYS,
  auditCategory,
  type AuditLogDetails,
  type AuditLogListItem,
  type AuditPerson,
  type ListAuditLogsQuery,
  type Paginated,
  type UserRole,
} from '@coobra/shared';
import { Errors } from '../common/app-exception.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { auditEntity, auditSummary, redactMetadata, splitChanges } from './audit-redaction.js';

type Actor = { id: string; role: UserRole };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRACKING_PATTERN = /^CB-\d{4,}$/i;
/** People matched by a name or email search (keeps the IN list small). */
const PEOPLE_SEARCH_LIMIT = 50;

const personSelect = { select: { id: true, fullName: true, role: true } } as const;
type Row = Prisma.AuditLogGetPayload<{
  include: { actor: typeof personSelect; target: typeof personSelect };
}>;

/**
 * The audit log viewer: read only, SUPER_ADMIN only (the routes require it and every method
 * checks it again). Pages are newest first with the id as a stable tie-break. Metadata only
 * leaves through the redaction in audit-redaction.ts.
 */
@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  private assertSuperAdmin(actor: Actor) {
    if (actor.role !== 'SUPER_ADMIN') throw Errors.forbidden();
  }

  async list(actor: Actor, query: ListAuditLogsQuery): Promise<Paginated<AuditLogListItem>> {
    this.assertSuperAdmin(actor);
    const where = await this.where(query);
    const offset = (query.page - 1) * query.pageSize;
    const db = this.prisma.client;
    const [counted, ids] = await Promise.all([
      db.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS total FROM audit_logs a WHERE ${where}`,
      db.$queryRaw<{ id: string }[]>`
        SELECT a.id FROM audit_logs a WHERE ${where}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ${query.pageSize} OFFSET ${offset}`,
    ]);
    const rows = await db.auditLog.findMany({
      where: { id: { in: ids.map((row) => row.id) } },
      include: { actor: personSelect, target: personSelect },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return {
      items: ids.map(({ id }) => this.toListItem(byId.get(id)!)),
      page: query.page,
      pageSize: query.pageSize,
      total: counted[0]?.total ?? 0,
    };
  }

  async details(actor: Actor, id: string): Promise<AuditLogDetails> {
    this.assertSuperAdmin(actor);
    if (!UUID_PATTERN.test(id)) throw Errors.notFound();
    const row = await this.prisma.client.auditLog.findUnique({
      where: { id },
      include: { actor: personSelect, target: personSelect },
    });
    if (!row) throw Errors.notFound();
    const { value, redacted } = redactMetadata(row.metadata);
    const { changes, details } = splitChanges(value);
    return {
      ...this.toListItem(row),
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      changes,
      details,
      redacted,
    };
  }

  private toListItem(row: Row): AuditLogListItem {
    const { value } = redactMetadata(row.metadata);
    return {
      id: row.id,
      action: row.action,
      category: auditCategory(row.action),
      createdAt: row.createdAt.toISOString(),
      actor: person(row.actor),
      targetUser: person(row.target),
      entity: auditEntity(value, row.targetUserId),
      summary: auditSummary(value),
    };
  }

  /** Every filter maps to an indexed condition (see the audit_logs indexes). */
  private async where(query: ListAuditLogsQuery): Promise<Prisma.Sql> {
    const conditions: Prisma.Sql[] = [];
    if (query.action) conditions.push(Prisma.sql`a.action = ${query.action}`);
    else if (query.category) {
      conditions.push(Prisma.sql`a.action IN (${Prisma.join(actionsInCategory(query.category))})`);
    }
    if (query.actorId) conditions.push(Prisma.sql`a.actor_user_id = ${query.actorId}::uuid`);
    if (query.targetUserId) {
      conditions.push(Prisma.sql`a.target_user_id = ${query.targetUserId}::uuid`);
    }
    if (query.from) conditions.push(Prisma.sql`a.created_at >= ${new Date(query.from)}`);
    if (query.to) conditions.push(Prisma.sql`a.created_at < ${new Date(query.to)}`);

    if (query.entityType === 'USER') {
      if (query.entityId) {
        // A user id that isn't a uuid matches nothing (instead of a cast error).
        conditions.push(
          UUID_PATTERN.test(query.entityId)
            ? Prisma.sql`a.target_user_id = ${query.entityId}::uuid`
            : Prisma.sql`false`,
        );
      } else {
        conditions.push(Prisma.sql`a.target_user_id IS NOT NULL`);
      }
    } else if (query.entityType) {
      const key = AUDIT_ENTITY_KEYS[query.entityType];
      conditions.push(
        query.entityId
          ? Prisma.sql`a.metadata @> ${JSON.stringify({ [key]: query.entityId })}::jsonb`
          : Prisma.sql`a.metadata ? ${key}`,
      );
    }
    if (query.q) conditions.push(await this.search(query.q));

    return conditions.length ? Prisma.join(conditions, ' AND ') : Prisma.sql`true`;
  }

  /**
   * Search by what an administrator usually has at hand: an id (entry, person or entity), a
   * tracking number, a receipt/payment reference, or a person's name or email.
   */
  private async search(q: string): Promise<Prisma.Sql> {
    const contains = (key: string, value: string) =>
      Prisma.sql`a.metadata @> ${JSON.stringify({ [key]: value })}::jsonb`;
    if (UUID_PATTERN.test(q)) {
      const id = q.toLowerCase();
      return Prisma.sql`(${Prisma.join(
        [
          Prisma.sql`a.id = ${id}::uuid`,
          Prisma.sql`a.actor_user_id = ${id}::uuid`,
          Prisma.sql`a.target_user_id = ${id}::uuid`,
          ...Object.values(AUDIT_ENTITY_KEYS).map((key) => contains(key, id)),
        ],
        ' OR ',
      )})`;
    }
    if (TRACKING_PATTERN.test(q)) return contains('trackingNumber', q.toUpperCase());

    const people = await this.prisma.client.user.findMany({
      where: {
        OR: [
          { fullName: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: { id: true },
      take: PEOPLE_SEARCH_LIMIT,
    });
    const options = [
      contains('receiptReference', q.toUpperCase()),
      contains('reference', q),
      contains('code', q),
      contains('key', q.toUpperCase()),
    ];
    if (people.length) {
      const ids = Prisma.join(people.map((person) => Prisma.sql`${person.id}::uuid`));
      options.push(
        Prisma.sql`a.actor_user_id IN (${ids})`,
        Prisma.sql`a.target_user_id IN (${ids})`,
      );
    }
    return Prisma.sql`(${Prisma.join(options, ' OR ')})`;
  }
}

function person(user: { id: string; fullName: string; role: UserRole } | null): AuditPerson | null {
  return user ? { id: user.id, fullName: user.fullName, role: user.role } : null;
}
