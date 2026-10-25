import { Logger } from '@nestjs/common';
import type { MailMessage, MailTransport } from './mail-transport.js';

/**
 * Development-only transport that prints emails (including links) to the console.
 * The configuration refuses this transport when NODE_ENV=production.
 */
export class LogMailTransport implements MailTransport {
  private readonly logger = new Logger('Mail');

  async send(message: MailMessage): Promise<void> {
    this.logger.log(`To: ${message.to}\nSubject: ${message.subject}\n\n${message.text}`);
  }
}
