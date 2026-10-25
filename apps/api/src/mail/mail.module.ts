import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { LogMailTransport } from './log.transport.js';
import { MAIL_TRANSPORT } from './mail-transport.js';
import { MailService } from './mail.service.js';
import { SmtpMailTransport } from './smtp.transport.js';

@Global()
@Module({
  providers: [
    {
      provide: MAIL_TRANSPORT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        config.mail.transport === 'smtp'
          ? new SmtpMailTransport(config.mail)
          : new LogMailTransport(),
    },
    MailService,
  ],
  exports: [MailService],
})
export class MailModule {}
