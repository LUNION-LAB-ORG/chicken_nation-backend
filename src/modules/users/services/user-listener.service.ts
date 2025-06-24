import { Injectable, Inject } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from 'src/database/services/prisma.service';
import { User, UserType, EntityStatus, Restaurant } from '@prisma/client';
import { IEmailService } from 'src/modules/email/interfaces/email-service.interface';
import { UserEmailTemplates } from '../templates/user-email.template';
import { EmailRecipientService } from 'src/modules/email/recipients/email-recipient.service';

@Injectable()
export class UserListener {
    constructor(
        private readonly prisma: PrismaService,
        @Inject('EMAIL_SERVICE') private readonly emailService: IEmailService,
        private readonly userEmailTemplates: UserEmailTemplates,
        private readonly emailRecipientService: EmailRecipientService,

    ) { }

    @OnEvent('user.created')
    async userCreatedEventListener(payload: { actor: User, user: Omit<User, 'password' | 'id'> }) {
        //Envoie email et notification au backoffice
        const usersBackoffice = await this.emailRecipientService.getAllUsersByBackofficeAndRole();

        // Envoie email au backoffice
        await this.emailService.sendEmailTemplate(
            this.userEmailTemplates.NEW_USER,
            {
                recipients: usersBackoffice,
                data: payload,
            },
        );

        // Envoie email à l'utilisateur
        await this.emailService.sendEmailTemplate(
            this.userEmailTemplates.WELCOME_USER,
            {
                recipients: [payload.user.email],
                data: payload,
            },
        );
    }

    @OnEvent('member.created')
    async memberCreatedEventListener(payload: { actor: User, user: User & { restaurant: Restaurant } }) {
        // TODO : Envoie email et notification au restaurant

        // TODO : Envoie email et notification à l'utilisateur
        console.log('Member created: ', payload);
    }

    @OnEvent('user.activated')
    async userActivatedEventListener(payload: { actor: User, data: User }) {
        // TODO : Envoie email et notification au backoffice ou au restaurant

        // TODO : Envoie email et notification à l'utilisateur
        console.log('User activated: ', payload);
    }

    @OnEvent('user.deactivated')
    async userDeactivatedEventListener(payload: { actor: User, data: User }) {
        // TODO : Envoie email et notification au backoffice ou au restaurant

        // TODO : Envoie email et notification à l'utilisateur
        console.log('User deactivated: ', payload);
    }

    @OnEvent('user.deleted')
    async userDeletedEventListener(payload: { actor: User, data: User }) {
        // TODO : Envoie email et notification au backoffice ou au restaurant

        // TODO : Envoie email et notification à l'utilisateur
        console.log('User deleted: ', payload);
    }

}
