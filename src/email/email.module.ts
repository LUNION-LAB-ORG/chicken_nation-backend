import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DefaultEmailService } from './services/default-email.service';
import { GoogleEmailService } from './services/google-email.service';
import { EmailController } from './controllers/email.controller';

@Module({
    controllers: [EmailController],
    providers: [
        DefaultEmailService,
        GoogleEmailService,
        {
            provide: 'EMAIL_SERVICE',
            useFactory: (configService: ConfigService) => {
                const emailProvider = configService.get<string>('EMAIL_PROVIDER', 'default');
                switch (emailProvider.toLowerCase()) {
                    case 'google':
                        return new GoogleEmailService(configService);
                    default:
                        return new DefaultEmailService(configService);
                }
            },
            inject: [ConfigService],
        },
    ],
    exports: ['EMAIL_SERVICE', DefaultEmailService, GoogleEmailService],
})
export class EmailModule { }