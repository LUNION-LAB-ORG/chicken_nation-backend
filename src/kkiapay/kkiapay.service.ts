import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { kkiapay } from "@kkiapay-org/nodejs-sdk"
import { ConfigService } from "@nestjs/config";
import { KkiapayResponse, KkiapayWebhookDto } from './kkiapay.type';
import { PaiementsService } from 'src/modules/paiements/services/paiements.service';
import { PaiementStatus } from '@prisma/client';


@Injectable()
export class KkiapayService {

    private readonly kkiapay: {
        verify: (transactionId: string) => Promise<any>;
        refund: (transactionId: string) => Promise<any>;
    };
    private readonly logger = new Logger(KkiapayService.name);

    constructor(private readonly config: ConfigService, private readonly paiementService: PaiementsService) {
        this.kkiapay = kkiapay({
            privatekey: this.config.get<string>('KKIA_PAY_PRIVATE_KEY') ?? "",
            publickey: this.config.get<string>('KKIA_PAY_PUBLIC_KEY') ?? "",
            secretkey: this.config.get<string>('KKIA_PAY_SECRET_KEY') ?? "",
            sandbox: this.config.get<string>('KKIA_PAY_SANDBOX') === "true"
        })
    }

    // Verification de la transaction
    async verifyTransaction(transactionId: string): Promise<KkiapayResponse> {
        if (!transactionId) {
            throw new BadRequestException("Transaction non trouvée");
        }
        return this.kkiapay.verify(transactionId).
            then((response) => {
                return response as KkiapayResponse;
            }).
            catch((error) => {
                throw new BadRequestException("Transaction non trouvée");
            })
    }

    // Remboursement de la transaction
    async refundTransaction(transactionId: string): Promise<KkiapayResponse> {
        if (!transactionId) {
            throw new BadRequestException("Transaction non trouvée");
        }
        return this.kkiapay.refund(transactionId).
            then((response) => {
                return response as KkiapayResponse;
            }).
            catch((error) => {
                throw new BadRequestException("Transaction non trouvée");
            })
    }

    async handleEvent(payload: KkiapayWebhookDto): Promise<void> {
        this.logger.log({ "Kkiapay event": payload });
        this.logger.log(`Received KkiaPay event: ${payload.event} for transaction ${payload.transactionId}`);

        // Exemple de traitement : selon l’event on met à jour la base de données, etc.
        if (payload.event === 'transaction.success') {
            this.logger.log(`Transaction successful: ${payload.transactionId}`);

            // Test création de paiement
            await this.paiementService.create({
                reference: payload.transactionId,
                amount: payload.amount,
                fees: payload.fees,
                total: payload.amount + payload.fees,
                mode: payload.method,
                source: payload.method,
                status: PaiementStatus.SUCCESS,
            });

        } else if (payload.event === 'transaction.failed') {
            this.logger.warn(`Transaction failed: ${payload.transactionId} – ${payload.failureCode} / ${payload.failureMessage}`);
        } else {
            this.logger.warn(`Unhandled event type: ${payload.event}`);
        }
    }
}
