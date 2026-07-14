import { Body, Controller, Headers, HttpStatus, Logger, Post, Res } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type { Response } from 'express';
import { KkiapayService } from './kkiapay.service';
import { KkiapayResponse, KkiapayWebhookDto } from './kkiapay.type';
import { SettingsService } from 'src/modules/settings/settings.service';

@Controller('kkiapay')
export class KkiapayController {
    private readonly logger = new Logger(KkiapayController.name);

    constructor(
        private readonly kkiapayService: KkiapayService,
        private readonly settingsService: SettingsService,
        @InjectQueue('kkiapay-webhooks') private readonly webhooksQueue: Queue,
    ) { }

    @Post('verify')
    async verifyTransaction(@Body() body: { transactionId: string }): Promise<KkiapayResponse> {
        return this.kkiapayService.verifyTransaction(body.transactionId);
    }

    @Post('refund')
    async refundTransaction(@Body() body: { transactionId: string }): Promise<KkiapayResponse> {
        return this.kkiapayService.refundTransaction(body.transactionId);
    }

    /**
     * Webhook KKiaPay — INGESTION SANS PERTE.
     *
     * 1. Vérifie le secret via un lecteur env-first Neon-indépendant (§2) → 403 si invalide.
     * 2. Enfile le payload brut dans BullMQ (Redis) avec un jobId idempotent
     *    `event:transactionId` → répond 200. Le traitement DB awaité se fait dans le
     *    worker (KkiapayWebhookConsumer), qui retente sur erreur transitoire.
     * 3. Si l'enfilement échoue (Redis injoignable) → 503 pour que KKiaPay RETENTE.
     *    On ne renvoie JAMAIS 200 sur erreur (sinon paiement perdu sans retry).
     */
    @Post("webhook")
    async handleWebhook(
        @Res() response: Response,
        @Headers('x-kkiapay-secret') receivedSecret: string,
        @Body() body: KkiapayWebhookDto,
    ) {
        const webhookSecret = await this.settingsService.getOrEnvSafe(
            'kkiapay_webhook_secret',
            'KKIA_PAY_WEBHOOK_SECRET',
            '',
        );

        // Vérification simple : Kkiapay renvoie le secret en clair.
        if (!webhookSecret || receivedSecret !== webhookSecret) {
            this.logger.warn('Webhook KKiaPay : secret invalide');
            return response.status(HttpStatus.FORBIDDEN).send('Invalid secret');
        }

        try {
            // jobId idempotent : un même event/transaction ne s'enfile pas deux fois
            // tant que le job existe. Le traitement est de toute façon idempotent.
            await this.webhooksQueue.add('event', body, {
                jobId: `${body.event}:${body.transactionId}`,
            });
            return response.status(HttpStatus.OK).send({ received: true });
        } catch (err) {
            // Redis injoignable → 503 pour que KKiaPay retente (NE PAS avaler en 200).
            this.logger.error('Échec enfilement webhook KKiaPay', err as any);
            return response.status(HttpStatus.SERVICE_UNAVAILABLE).send('Queue unavailable');
        }
    }
}
