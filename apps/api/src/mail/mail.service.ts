import { Inject, Injectable, Logger } from '@nestjs/common';
import { createI18n } from '@coobra/i18n';
import { clientAppForRole, directionOf, type Language, type UserRole } from '@coobra/shared';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { MAIL_TRANSPORT, type MailTransport } from './mail-transport.js';

export interface MailRecipient {
  email: string;
  fullName: string;
  role: UserRole;
  language: Language;
}

type TemplateKey = 'verify' | 'reset' | 'invite';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Builds localised transactional emails and links each user to the app for their role. */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
  ) {}

  async sendEmailVerification(to: MailRecipient, token: string, validHours: number): Promise<void> {
    await this.send(to, 'verify', this.link(to.role, '/verify-email', token), {
      hours: validHours,
    });
  }

  async sendPasswordReset(to: MailRecipient, token: string, validMinutes: number): Promise<void> {
    await this.send(to, 'reset', this.link(to.role, '/reset-password', token), {
      minutes: validMinutes,
    });
  }

  async sendAccountSetup(to: MailRecipient, token: string, validHours: number): Promise<void> {
    await this.send(to, 'invite', this.link(to.role, '/reset-password', token), {
      hours: validHours,
    });
  }

  /** Sends without blocking the request; failures are logged. Used where timing must not leak. */
  sendInBackground(task: Promise<void>): void {
    task.catch((error: unknown) => this.logger.error('Failed to send email', error as Error));
  }

  private link(role: UserRole, path: string, token: string): string {
    const base = {
      ADMIN_WEB: this.config.links.adminWebUrl,
      DRIVER_APP: this.config.links.driverAppUrl,
      MERCHANT_APP: this.config.links.merchantAppUrl,
    }[clientAppForRole(role)];
    const url = new URL(path, base);
    url.searchParams.set('token', token);
    return url.toString();
  }

  private async send(
    to: MailRecipient,
    template: TemplateKey,
    link: string,
    params: Record<string, number>,
  ): Promise<void> {
    const { t } = createI18n(to.language);
    const greeting = t('email.greeting', { name: to.fullName });
    const body = t(`email.${template}.body`, params);
    const footer = t('email.footer');
    const dir = directionOf(to.language);

    await this.transport.send({
      to: to.email,
      subject: t(`email.${template}.subject`),
      text: `${greeting}\n\n${body}\n${link}\n\n${footer}`,
      html: `<!doctype html><html lang="${to.language}" dir="${dir}"><body style="font-family:sans-serif">
<p>${escapeHtml(greeting)}</p>
<p>${escapeHtml(body)}</p>
<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>
<p style="color:#666">${escapeHtml(footer)}</p>
</body></html>`,
    });
  }
}
