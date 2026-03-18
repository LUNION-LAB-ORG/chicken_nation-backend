import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { kkiapay } from "@kkiapay-org/nodejs-sdk"
import { KkiapayResponse, KkiapayWebhookDto } from './kkiapay.type';
import { KkiapayEvent } from './kkiapay.event';
import { SettingsService } from 'src/modules/settings/settings.service';

@Injectable()
export class KkiapayService {

    private kkiapayInstance: { verify: (id: string) => Promise<any>; refund: (id: string) => Promise<any>; } | null = null;
    private readonly logger = new Logger(KkiapayService.name);

    constructor(
        private readonly settingsService: SettingsService,
        private readonly eventEmitter: KkiapayEvent,
    ) {}

    private async getKkiapayInstance() {
        if (this.kkiapayInstance) {
            return this.kkiapayInstance;
        }

        const config = await this.settingsService.getManyOrEnv({
            kkiapay_private_key: 'KKIA_PAY_PRIVATE_KEY',
            kkiapay_public_key: 'KKIA_PAY_PUBLIC_KEY',
            kkiapay_secret_key: 'KKIA_PAY_SECRET_KEY',
            kkiapay_sandbox: 'KKIA_PAY_SANDBOX',
        });

        this.kkiapayInstance = kkiapay({
            privatekey: config.kkiapay_private_key ?? "",
            publickey: config.kkiapay_public_key ?? "",
            secretkey: config.kkiapay_secret_key ?? "",
            sandbox: config.kkiapay_sandbox === "true"
        });

        return this.kkiapayInstance;
    }

    // Verification de la transaction
    async verifyTransaction(transactionId: string): Promise<KkiapayResponse> {
        if (!transactionId) {
            throw new BadRequestException("Transaction non trouvée");
        }

        const instance = await this.getKkiapayInstance();

        try {
            const response = await instance.verify(transactionId);
            return response as KkiapayResponse;
        } catch (error) {
            throw new BadRequestException("Transaction non trouvée");
        }
    }

    // Remboursement de la transaction
    async refundTransaction(transactionId: string): Promise<KkiapayResponse> {
        if (!transactionId) {
            throw new BadRequestException("Transaction non trouvée");
        }

        const instance = await this.getKkiapayInstance();

        try {
            const response = await instance.refund(transactionId);
            return response as KkiapayResponse;
        } catch (error) {
            throw new BadRequestException("Transaction non trouvée");
        }
    }

    async handleEvent(payload: KkiapayWebhookDto): Promise<void> {
        this.logger.log({ "Kkiapay event": payload });

        // Exemple de traitement : selon l'event on met à jour la base de données, etc.
        if (payload.event === 'transaction.success') {
            this.logger.log(`Transaction successful: ${payload.transactionId}`);
            this.eventEmitter.kkiapayTransactionSuccessEvent(payload);

        } else if (payload.event === 'transaction.failed') {
            this.logger.warn(`Transaction failed: ${payload.transactionId} – ${payload.failureCode} / ${payload.failureMessage}`);
            this.eventEmitter.kkiapayTransactionFailedEvent(payload);
        } else {
            this.logger.warn(`Unhandled event type: ${payload.event}`);
        }
    }
}
