import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { kkiapay } from "@kkiapay-org/nodejs-sdk"
import { KkiapayResponse, KkiapayWebhookDto } from './kkiapay.type';
import { KkiapayEvent } from './kkiapay.event';
import { SettingsService } from 'src/modules/settings/settings.service';

@Injectable()
export class KkiapayService {

    private kkiapayInstance: { verify: (id: string) => Promise<any>; refund: (id: string) => Promise<any>; } | null = null;
    private kkiapayOldInstance: { verify: (id: string) => Promise<any>; refund: (id: string) => Promise<any>; } | null = null;
    private readonly logger = new Logger(KkiapayService.name);

    constructor(
        private readonly settingsService: SettingsService,
        private readonly eventEmitter: KkiapayEvent,
    ) {}

    private async getKkiapayInstances() {
        if (this.kkiapayInstance && this.kkiapayOldInstance) {
            return { main: this.kkiapayInstance, old: this.kkiapayOldInstance };
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

        // Les anciennes clés restent en .env (pas configurables depuis le backoffice)
        const oldConfig = await this.settingsService.getManyOrEnv({
            kkiapay_private_key_old: 'KKIA_PAY_PRIVATE_KEY_OLD',
            kkiapay_public_key_old: 'KKIA_PAY_PUBLIC_KEY_OLD',
            kkiapay_secret_key_old: 'KKIA_PAY_SECRET_KEY_OLD',
            kkiapay_sandbox_old: 'KKIA_PAY_SANDBOX_OLD',
        });

        this.kkiapayOldInstance = kkiapay({
            privatekey: oldConfig.kkiapay_private_key_old ?? "",
            publickey: oldConfig.kkiapay_public_key_old ?? "",
            secretkey: oldConfig.kkiapay_secret_key_old ?? "",
            sandbox: oldConfig.kkiapay_sandbox_old === "true"
        });

        return { main: this.kkiapayInstance, old: this.kkiapayOldInstance };
    }

    // Verification de la transaction
    async verifyTransaction(transactionId: string): Promise<KkiapayResponse> {
        if (!transactionId) {
            throw new BadRequestException("Transaction non trouvée");
        }

        const { main, old } = await this.getKkiapayInstances();

        return main.verify(transactionId).
            then((response) => {
                return response as KkiapayResponse;
            }).
            catch((error) => {
                return old.verify(transactionId).
                    then((response) => {
                        return response as KkiapayResponse;
                    }).
                    catch((error) => {
                        throw new BadRequestException("Transaction non trouvée");
                    })
            })
    }

    // Remboursement de la transaction
    async refundTransaction(transactionId: string): Promise<KkiapayResponse> {
        if (!transactionId) {
            throw new BadRequestException("Transaction non trouvée");
        }

        const { main, old } = await this.getKkiapayInstances();

        return main.refund(transactionId).
            then((response) => {
                return response as KkiapayResponse;
            }).
            catch((error) => {
                return old.refund(transactionId).
                    then((response) => {
                        return response as KkiapayResponse;
                    }).
                    catch((error) => {
                        throw new BadRequestException("Transaction non trouvée");
                    })
            })
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
