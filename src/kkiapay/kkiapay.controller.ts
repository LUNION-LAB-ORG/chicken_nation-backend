import { ApiOperation } from '@nestjs/swagger';
import { Body, Controller, Get, Headers, HttpStatus, Logger, Param, Post, Res, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type { Response } from 'express';
import { KkiapayService } from './kkiapay.service';
import { KkiapayResponse, KkiapayWebhookDto } from './kkiapay.type';
import { SettingsService } from 'src/modules/settings/settings.service';
import { PrismaService } from 'src/database/services/prisma.service';

@Controller('kkiapay')
export class KkiapayController {
    private readonly logger = new Logger(KkiapayController.name);

    constructor(
        private readonly kkiapayService: KkiapayService,
        private readonly settingsService: SettingsService,
        private readonly prisma: PrismaService,
        @InjectQueue('kkiapay-webhooks') private readonly webhooksQueue: Queue,
    ) { }

    // Guards AJOUTÉS (audit 31/07) : ces deux routes étaient PUBLIQUES — un
    // REMBOURSEMENT était déclenchable anonymement avec un simple transactionId.
    // Aucun client (app/backoffice/site) ne les consommait ; le remboursement
    // officiel passe par POST /paiements/refund/:id (gardé + tracé par compte).
    /**
     * DIAGNOSTIC (06/08) : quel compte KKiaPay sert réellement un restaurant, et
     * pourquoi. Sans cet outil, un repli silencieux sur le compte global ne se
     * constate qu'après un vrai paiement parti au mauvais endroit.
     * Ne renvoie AUCUN secret : uniquement des présences et des empreintes.
     */
    @Get('diagnostic/:restaurantId')
    @UseGuards(JwtAuthGuard)
    @ApiOperation({ summary: 'Compte KKiaPay effectivement utilisé pour un restaurant' })
    async diagnostic(@Param('restaurantId') restaurantId: string) {
        const cles = KkiapayService.settingKeys(restaurantId);
        const valeurs = await this.settingsService.getMany([
            cles.public_key, cles.private_key, cles.secret_key,
            cles.webhook_secret, cles.sandbox,
        ]);
        const presence = (v?: string) => ({
            renseigne: !!v && v.trim() !== '',
            longueur: v?.length ?? 0,
        });

        const compte = await this.kkiapayService.resolveAccount(restaurantId);
        const dedie = compte.restaurantId === restaurantId;

        return {
            restaurant_id: restaurantId,
            compte_utilise: dedie ? 'DEDIE' : 'GLOBAL',
            // Les 4 premiers caractères suffisent à distinguer deux comptes.
            cle_publique_servie: compte.publicKey
                ? `${compte.publicKey.slice(0, 8)}…`
                : '(vide)',
            sandbox: compte.sandbox,
            cles_enregistrees: {
                public_key: presence(valeurs[cles.public_key]),
                private_key: presence(valeurs[cles.private_key]),
                secret_key: presence(valeurs[cles.secret_key]),
                webhook_secret: presence(valeurs[cles.webhook_secret]),
            },
            explication: dedie
                ? 'Les paiements de ce restaurant partent sur son propre compte.'
                : "Repli sur le compte global : les trois clés d'API (publique, privée, secrète) doivent toutes être renseignées pour que le compte dédié serve.",
        };
    }

    @Post('verify')
    @UseGuards(JwtAuthGuard)
    async verifyTransaction(@Body() body: { transactionId: string }): Promise<KkiapayResponse> {
        return this.kkiapayService.verifyTransaction(body.transactionId);
    }

    @Post('refund')
    @UseGuards(JwtAuthGuard)
    async refundTransaction(@Body() body: { transactionId: string }): Promise<KkiapayResponse> {
        // MULTI-COMPTES (revue 31/07) : cette route remboursait TOUJOURS depuis le
        // compte global, même une transaction encaissée par un compte restaurant.
        // On retrouve le paiement par sa référence pour rembourser depuis le
        // compte TRACÉ ; sans trace, comportement historique (global).
        const paiement = await this.prisma.paiement.findFirst({
            where: { reference: body.transactionId },
            select: { restaurant_id: true },
        });
        return this.kkiapayService.refundTransaction(
            body.transactionId,
            paiement?.restaurant_id ?? null,
        );
    }

    /**
     * Webhook KKiaPay — INGESTION SANS PERTE.
     *
     * 1. Vérifie le secret via un lecteur env-first Neon-indépendant (§2) → 403 si invalide.
     * 2. Enfile le payload brut dans BullMQ (Redis) avec un jobId idempotent
     *    `event_transactionId` (assaini, sans ':' interdit par BullMQ) → répond 200.
     *    Le traitement DB awaité se fait dans le
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
        return this.ingestWebhook(response, receivedSecret, body, null);
    }

    /**
     * MULTI-COMPTES : une URL de webhook PAR RESTAURANT
     * (`/kkiapay/webhook/<restaurantId>`, configurée dans le dashboard du compte
     * KKiaPay du restaurant, chacun avec SON secret). La route legacy ci-dessus
     * reste active pour le compte global historique pendant toute la transition.
     */
    @Post("webhook/:restaurantId")
    async handleWebhookForRestaurant(
        @Res() response: Response,
        @Headers('x-kkiapay-secret') receivedSecret: string,
        @Body() body: KkiapayWebhookDto,
        @Param('restaurantId') restaurantId: string,
    ) {
        return this.ingestWebhook(response, receivedSecret, body, restaurantId);
    }

    private async ingestWebhook(
        response: Response,
        receivedSecret: string,
        body: KkiapayWebhookDto,
        restaurantId: string | null,
    ) {
        // Secret : global (env-first Neon-indépendant) ou par restaurant (Settings
        // + cache mémoire longue durée). `null` = aucune source disponible
        // (restaurant pas encore configuré OU Neon injoignable sans cache) → 503
        // pour que KKiaPay RETENTE : si l'URL a été posée dans le dashboard avant
        // la saisie du secret au backoffice, les webhooks passeront dès la saisie ;
        // et un blip DB ne doit jamais devenir un paiement perdu (incident 14/07).
        const webhookSecret = await this.kkiapayService.getWebhookSecret(restaurantId);
        // 503 sur les DEUX routes (legacy comprise, revue 31/07) : « aucun secret
        // disponible » (pas encore configuré, ou DB injoignable sans cache ni env)
        // doit faire RETENTER KKiaPay, jamais rejeter en 403 définitif.
        if (webhookSecret === null) {
            this.logger.warn(
                `Webhook KKiaPay [${restaurantId}] : secret indisponible (non configuré ou DB injoignable sans cache)`,
            );
            return response.status(HttpStatus.SERVICE_UNAVAILABLE).send('Secret unavailable');
        }

        // Vérification simple : Kkiapay renvoie le secret en clair.
        if (!webhookSecret || receivedSecret !== webhookSecret) {
            this.logger.warn(`Webhook KKiaPay${restaurantId ? ` [${restaurantId}]` : ''} : secret invalide`);
            return response.status(HttpStatus.FORBIDDEN).send('Invalid secret');
        }

        try {
            // jobId idempotent : un même event/transaction ne s'enfile pas deux fois
            // tant que le job existe. Le traitement est de toute façon idempotent.
            // ⚠️ BullMQ INTERDIT le caractère ':' dans un custom jobId
            // (Error: Custom Id cannot contain :) : avec un séparateur ':' l'enfilement
            // throw à CHAQUE webhook → 503 → aucun paiement web n'est jamais traité.
            // On assainit donc le jobId (on ne garde que [a-zA-Z0-9_.-]).
            const jobId = `${body.event}_${body.transactionId}`.replace(/[^a-zA-Z0-9_.-]/g, '');
            // L'id du restaurant voyage AVEC le payload : le traitement aval vérifie
            // la transaction auprès du bon compte (repli global pendant la transition).
            await this.webhooksQueue.add('event', { ...body, restaurantId: restaurantId ?? undefined }, { jobId });
            return response.status(HttpStatus.OK).send({ received: true });
        } catch (err) {
            // Redis injoignable → 503 pour que KKiaPay retente (NE PAS avaler en 200).
            this.logger.error('Échec enfilement webhook KKiaPay', err as any);
            return response.status(HttpStatus.SERVICE_UNAVAILABLE).send('Queue unavailable');
        }
    }
}
