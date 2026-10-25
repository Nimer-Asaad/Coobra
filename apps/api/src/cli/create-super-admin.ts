/**
 * Creates the first SUPER_ADMIN account. Credentials are never hard-coded:
 *
 *   SUPER_ADMIN_EMAIL=you@example.com SUPER_ADMIN_NAME="Your Name" \
 *   SUPER_ADMIN_PASSWORD='a-strong-password-123' pnpm admin:create-super-admin
 *
 * Refuses to run if any SUPER_ADMIN already exists (further admins are created in the app).
 */
import { createPrismaClient } from '@coobra/database';
import { emailSchema, languageSchema, passwordSchema, toFieldErrors } from '@coobra/shared';
import { z } from 'zod';
import { loadRootEnvFile } from '../config/load-env-file.js';
import { PasswordService } from '../auth/password.service.js';

const inputSchema = z.object({
  SUPER_ADMIN_EMAIL: emailSchema,
  SUPER_ADMIN_NAME: z.string().trim().min(2),
  SUPER_ADMIN_PASSWORD: passwordSchema,
  SUPER_ADMIN_LANGUAGE: languageSchema.default('ar'),
  DATABASE_URL: z.string().min(1),
});

async function main(): Promise<void> {
  loadRootEnvFile();
  const parsed = inputSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid input:', toFieldErrors(parsed.error));
    process.exitCode = 1;
    return;
  }
  const input = parsed.data;
  const prisma = createPrismaClient({ connectionString: input.DATABASE_URL });
  try {
    const existing = await prisma.user.count({ where: { role: 'SUPER_ADMIN' } });
    if (existing > 0) {
      console.error(
        'A SUPER_ADMIN already exists. Create additional admins from the admin web app.',
      );
      process.exitCode = 1;
      return;
    }
    const now = new Date();
    const user = await prisma.user.create({
      data: {
        email: input.SUPER_ADMIN_EMAIL,
        fullName: input.SUPER_ADMIN_NAME,
        role: 'SUPER_ADMIN',
        language: input.SUPER_ADMIN_LANGUAGE,
        passwordHash: await new PasswordService().hash(input.SUPER_ADMIN_PASSWORD),
        passwordChangedAt: now,
        emailVerifiedAt: now,
      },
    });
    await prisma.auditLog.create({
      data: {
        action: 'USER_CREATED',
        targetUserId: user.id,
        metadata: { role: 'SUPER_ADMIN', via: 'cli' },
      },
    });
    console.log(`SUPER_ADMIN created: ${user.email} (${user.id})`);
  } finally {
    await prisma.$disconnect();
  }
}

await main();
