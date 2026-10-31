import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { ImpersonationEndReason } from '@coobra/database';
import type { AuditAction } from '@coobra/shared';
import { CLOCK, utcTimestampSql, type Clock } from '../common/clock.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { MailService } from '../mail/mail.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { endImpersonationIn } from './impersonation-records.js';
import { redactForLog } from '../common/log-redaction.js';

const SWEEP_INTERVAL_MS = 60_000;
const BATCH = 50;
const LEASE_MS = 2 * 60_000;
const MAX_ATTEMPTS = 5;

/**
 * Runs on every API instance (ADR 0003 §13). Each step claims rows with FOR UPDATE SKIP LOCKED,
 * so instances never process the same row at the same time.
 *
 * 1. Ends impersonations that expired, or whose admin session ended, without a request noticing.
 * 2. Delivers the end-of-impersonation summaries from the durable outbox. Delivery is
 *    at least once: a row is leased with a fencing token, sent, then marked SENT only by the
 *    holder of that token. A crash after the mail server accepted the message but before the
 *    row is marked can send it again; the stable Message-ID only helps mail clients recognise
 *    the duplicate, it does not prevent it.
 */
@Injectable()
export class ImpersonationSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ImpersonationSweeper.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    // Why impersonation may be off is logged once at start-up (startupDiagnostics in main.ts).
    if (!this.config.impersonationSweeperEnabled) return;
    this.timer = setInterval(() => void this.tick(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error(`Impersonation sweep failed: ${redactForLog(error)}`);
    } finally {
      this.running = false;
    }
  }

  /** One sweep: end what must end, then deliver due summaries. */
  async runOnce(): Promise<{ ended: number; sent: number; retried: number; failed: number }> {
    const ended = await this.endStale();
    const delivery = await this.deliverSummaries();
    return { ended, ...delivery };
  }

  async endStale(): Promise<number> {
    const now = this.clock.now();
    const at = utcTimestampSql(now);
    return this.prisma.client.$transaction(async (tx) => {
      const due = await tx.$queryRaw<{ id: string; reason: ImpersonationEndReason }[]>`
        SELECT i.id,
               (CASE WHEN i.expires_at <= (${at}::timestamptz AT TIME ZONE 'UTC') THEN 'EXPIRED'
                     ELSE 'ACTOR_SESSION_ENDED' END)::"ImpersonationEndReason" AS reason
        FROM impersonation_sessions i
        JOIN sessions s ON s.id = i.actor_session_id
        WHERE i.ended_at IS NULL
          AND (i.expires_at <= (${at}::timestamptz AT TIME ZONE 'UTC')
               OR s.revoked_at IS NOT NULL
               OR s.expires_at <= (${at}::timestamptz AT TIME ZONE 'UTC'))
        ORDER BY i.expires_at
        LIMIT ${BATCH}
        FOR UPDATE OF i SKIP LOCKED`;
      for (const row of due) {
        await endImpersonationIn(tx, { impersonationId: row.id, reason: row.reason, now });
      }
      return due.length;
    });
  }

  async deliverSummaries(): Promise<{ sent: number; retried: number; failed: number }> {
    const now = this.clock.now();
    const at = utcTimestampSql(now);
    const leaseUntil = utcTimestampSql(new Date(now.getTime() + LEASE_MS));
    const claimed = await this.prisma.client.$queryRaw<
      { id: string; lease_token: string; attempts: number; impersonation_id: string }[]
    >`
      UPDATE notification_outbox o
      SET lease_token = gen_random_uuid(),
          lease_expires_at = (${leaseUntil}::timestamptz AT TIME ZONE 'UTC'),
          attempts = o.attempts + 1,
          updated_at = (${at}::timestamptz AT TIME ZONE 'UTC')
      WHERE o.id IN (
        SELECT id FROM notification_outbox
        WHERE status = 'PENDING'
          AND kind = 'IMPERSONATION_SUMMARY'
          AND next_attempt_at <= (${at}::timestamptz AT TIME ZONE 'UTC')
          AND (lease_expires_at IS NULL OR lease_expires_at <= (${at}::timestamptz AT TIME ZONE 'UTC'))
        ORDER BY next_attempt_at
        LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED)
      RETURNING o.id, o.lease_token::text AS lease_token, o.attempts, o.impersonation_id::text AS impersonation_id`;
    let sent = 0;
    let retried = 0;
    let failed = 0;
    for (const row of claimed) {
      // Each row has its own fencing token: only this lease holder can complete or fail it.
      const token = row.lease_token;
      try {
        await this.sendSummary(row.id, row.impersonation_id);
        const done = await this.prisma.client.notificationOutbox.updateMany({
          where: { id: row.id, leaseToken: token, status: 'PENDING' },
          data: {
            status: 'SENT',
            sentAt: this.clock.now(),
            leaseToken: null,
            leaseExpiresAt: null,
            lastError: null,
          },
        });
        if (done.count === 1) sent++;
      } catch (error) {
        const last = row.attempts >= MAX_ATTEMPTS;
        // Never the message or its recipient: only the kind of error.
        const lastError = (error instanceof Error ? error.name : 'Error').slice(0, 100);
        await this.prisma.client.notificationOutbox.updateMany({
          where: { id: row.id, leaseToken: token },
          data: last
            ? { status: 'FAILED', leaseToken: null, leaseExpiresAt: null, lastError }
            : {
                leaseToken: null,
                leaseExpiresAt: null,
                lastError,
                // 1, 2, 4, 8 minutes.
                nextAttemptAt: new Date(now.getTime() + 2 ** (row.attempts - 1) * 60_000),
              },
        });
        if (last) failed++;
        else retried++;
        this.logger.warn(`Impersonation summary ${row.id} not sent (attempt ${row.attempts})`);
      }
    }
    return { sent, retried, failed };
  }

  /** Builds the summary from the impersonation and its audit entries (safe allowlist, §13). */
  private async sendSummary(outboxId: string, impersonationId: string): Promise<void> {
    const imp = await this.prisma.client.impersonationSession.findUniqueOrThrow({
      where: { id: impersonationId },
      include: {
        actor: { select: { fullName: true } },
        target: { select: { email: true, fullName: true, role: true, language: true } },
      },
    });
    const entries = await this.prisma.client.auditLog.findMany({
      where: { impersonationId },
      orderBy: { createdAt: 'asc' },
      select: { action: true, createdAt: true, metadata: true },
      take: 200,
    });
    await this.mail.sendImpersonationSummary(
      imp.target,
      {
        adminName: imp.actor.fullName,
        startedAt: imp.startedAt,
        endedAt: imp.endedAt ?? this.clock.now(),
        endReason: imp.endedReason ?? 'EXPIRED',
        actions: entries.map((entry) => {
          const metadata = (entry.metadata ?? {}) as Record<string, unknown>;
          const tracking = metadata.trackingNumber;
          return {
            action: entry.action as AuditAction,
            at: entry.createdAt,
            trackingNumber: typeof tracking === 'string' ? tracking : null,
          };
        }),
      },
      `<notification-${outboxId}@coobra.local>`,
    );
  }
}
