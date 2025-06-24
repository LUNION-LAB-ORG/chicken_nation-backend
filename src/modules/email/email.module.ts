import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DefaultEmailService } from './services/default-email.service';
import { GoogleEmailService } from './services/google-email.service';
import { EmailController } from './controllers/email.controller';
import { EmailTemplateService } from './templates/email-template.service';
import { EmailComponentsService } from './components/email.components.service';
import { EmailPreviewController } from './controllers/email-preview.controller';
import { EmailThemeService } from './theme/email-theme.service';
import { EmailRecipientService } from './recipients/email-recipient.service';

@Global()
@Module({
    controllers: [EmailController, EmailPreviewController],
    providers: [
        EmailRecipientService,
        EmailTemplateService,
        EmailComponentsService,
        DefaultEmailService,
        GoogleEmailService,
        EmailThemeService,
        {
            provide: 'EMAIL_SERVICE',
            useFactory: (configService: ConfigService, emailTemplateService: EmailTemplateService, emailComponentsService: EmailComponentsService) => {
                const emailProvider = configService.get<string>('EMAIL_PROVIDER', 'default');
                switch (emailProvider.toLowerCase()) {
                    case 'google':
                        return new GoogleEmailService(configService, emailTemplateService, emailComponentsService);
                    default:
                        return new DefaultEmailService(configService, emailTemplateService, emailComponentsService);
                }
            },
            inject: [ConfigService, EmailTemplateService, EmailComponentsService],
        },
    ],
    exports: ['EMAIL_SERVICE', DefaultEmailService, GoogleEmailService, EmailComponentsService, EmailThemeService, EmailRecipientService],
})
export class EmailModule { }