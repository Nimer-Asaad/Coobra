import { Global, Module } from '@nestjs/common';

/** The time source for expiry decisions (impersonation). Tests replace `now` to move time. */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('CLOCK');

export const systemClock: Clock = { now: () => new Date() };

/**
 * `timestamp(3)` columns hold UTC wall time without a zone. A raw SQL comparison must compare
 * with UTC wall time too, whatever the database session's time zone is.
 */
export function utcTimestampSql(date: Date): string {
  return date.toISOString();
}

@Global()
@Module({
  providers: [{ provide: CLOCK, useValue: systemClock }],
  exports: [CLOCK],
})
export class ClockModule {}
