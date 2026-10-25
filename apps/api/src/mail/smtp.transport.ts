import nodemailer, { type Transporter } from 'nodemailer';
import type { AppConfig } from '../config/env.js';
import type { MailMessage, MailTransport } from './mail-transport.js';

export class SmtpMailTransport implements MailTransport {
  private readonly transporter: Transporter;

  constructor(private readonly config: AppConfig['mail']) {
    const { host, port, secure, user, password } = config.smtp;
    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: user ? { user, pass: password } : undefined,
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transporter.sendMail({ from: this.config.from, ...message });
  }
}
