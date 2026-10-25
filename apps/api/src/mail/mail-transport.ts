export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Abstraction over the delivery mechanism so it can be swapped (SMTP, provider API, tests). */
export interface MailTransport {
  send(message: MailMessage): Promise<void>;
}

export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');
