import { ApiOperation } from '@nestjs/swagger';
import { Body, Controller, Get, Headers, HttpStatus, Logger, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type { Request, Response } from 'express';
import { KkiapayService } from './kkiapay.service';
import { KkiapayResponse, KkiapayWebhookDto } from './kkiapay.type';
import { SettingsService } from 'src/modules/settings/settings.service';
import { PrismaService } from 'src/database/services/prisma.service';
import { AuditService } from 'src/modules/audit/audit.service';
import { journalRefusWebhook } from './kkiapay-audit.helper';
import { AlertesService, CodeAlerte } from 'src/modules/alertes/alertes.service';

/**
 * Longueur, bords et 3 premiers/derniers caractères d'un secret, pour
 * diagnostiquer un désalignement sans jamais écrire la valeur entière.
 * En dessous de 12 caractères, seule la longueur est donnée.
 */
function empreinteSecret(valeur: string | undefined | null): string {
    if (valeur === undefined || valeur === null) return 'absent';
    const n = valeur.length;
    const espaces = valeur !== valeur.trim() ? ', espaces aux bords' : '';
    if (n < 12) return `${n} car.${espaces}`;
    return `${n} car. ${JSON.stringify(valeur.slice(0, 3))}…${JSON.stringify(valeur.slice(-3))}${espaces}`;
}

@Controller('kkiapay')
export class KkiapayController {
    private readonly logger = new Logger(KkiapayController.name);

    constructor(
        private readonly kkiapayService: KkiapayService,
        private readonly settingsService: SettingsService,
        private readonly prisma: PrismaService,
        private readonly auditService: AuditService,
        private readonly alertes: AlertesService,
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
        @Req() request: Request,
        @Res() response: Response,
        @Headers('x-kkiapay-secret') receivedSecret: string,
        @Body() body: KkiapayWebhookDto,
    ) {
        return this.ingestWebhook(request, response, receivedSecret, body, null);
    }

    /**
     * MULTI-COMPTES : une URL de webhook PAR RESTAURANT
     * (`/kkiapay/webhook/<restaurantId>`, configurée dans le dashboard du compte
     * KKiaPay du restaurant, chacun avec SON secret). La route legacy ci-dessus
     * reste active pour le compte global historique pendant toute la transition.
     */
    @Post("webhook/:restaurantId")
    async handleWebhookForRestaurant(
        @Req() request: Request,
        @Res() response: Response,
        @Headers('x-kkiapay-secret') receivedSecret: string,
        @Body() body: KkiapayWebhookDto,
        @Param('restaurantId') restaurantId: string,
    ) {
        return this.ingestWebhook(request, response, receivedSecret, body, restaurantId);
    }

    private async ingestWebhook(
        request: Request,
        response: Response,
        receivedSecret: string,
        body: KkiapayWebhookDto,
        restaurantId: string | null,
    ) {
        /**
         * Tout refus est JOURNALISÉ (Audits → Logs).
         *
         * Un webhook repoussé ne laissait de trace que dans les logs du
         * conteneur : il fallait un accès SSH à la production pour découvrir
         * qu'un secret était désaligné, pendant que des commandes payées
         * restaient en attente sans explication visible. Écriture
         * fire-and-forget : elle ne peut ni ralentir ni casser l'ingestion.
         * Le secret reçu n'est JAMAIS journalisé.
         */
        const tracerRefus = (statut: number, motif: string, compteReconnu: boolean) => {
            // `null` = refus bridé : une ligne récente couvre déjà ce cas. La route
            // est publique et sans limitation de débit, et le refus survient
            // justement quand l'appelant n'est pas authentifié : sans cette bride,
            // n'importe qui ferait grossir la table d'audit à volonté.
            const entree = journalRefusWebhook({
                payload: body ?? {},
                restaurantId,
                statut,
                motif,
                compteReconnu,
                path: request?.originalUrl ?? request?.url ?? '/kkiapay/webhook',
                ip: request?.ip ?? null,
                userAgent: request?.headers?.['user-agent'] ?? null,
            });
            if (entree) this.auditService.record(entree);

            /**
             * Le refus est aussi annoncé dans le groupe. Un secret désaligné se
             * voyait jusqu'ici dans les logs du conteneur, c'est-à-dire nulle
             * part : trois paiements ont été perdus le 21/09 avant que
             * quiconque s'en aperçoive. Le service brime lui-même les
             * répétitions, une panne ne produira pas cent messages.
             */
            this.alertes.signaler({
                code: CodeAlerte.WEBHOOK_REFUSE,
                restaurantId: restaurantId,
                details: [
                    motif,
                    "Les paiements de ce compte ne confirment plus les commandes.",
                ],
                meta: { statut, transactionId: body?.transactionId ?? null },
            });
        };
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
            // Compte NON reconnu : aucun secret n'existe pour cet identifiant, qui
            // peut donc être n'importe quoi. Tous ces refus partagent une clé.
            tracerRefus(
                HttpStatus.SERVICE_UNAVAILABLE,
                'secret de webhook indisponible (non configuré, ou base injoignable sans cache)',
                false,
            );
            return response.status(HttpStatus.SERVICE_UNAVAILABLE).send('Secret unavailable');
        }

        // Vérification simple : Kkiapay renvoie le secret en clair.
        if (!webhookSecret || receivedSecret !== webhookSecret) {
            // Empreinte des deux valeurs, jamais la valeur entière : sans elle,
            // impossible de savoir si KKiaPay envoie un ancien secret, rien, ou
            // la bonne valeur entourée d'espaces (incident ZONE 4, 24/09).
            this.logger.warn(
                `Webhook KKiaPay${restaurantId ? ` [${restaurantId}]` : ''} : secret invalide` +
                ` (reçu ${empreinteSecret(receivedSecret)}, attendu ${empreinteSecret(webhookSecret)})`,
            );
            // Compte RECONNU : on n'arrive ici que si un secret existe pour cet
            // identifiant, donc l'espace de clés est borné par le nombre de
            // restaurants configurés, et l'identifiant reste utile au diagnostic.
            tracerRefus(
                HttpStatus.FORBIDDEN,
                'secret invalide : la valeur envoyée par KKiaPay ne correspond pas à celle enregistrée pour ce compte',
                true,
            );
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
            // Le secret a été validé plus haut : compte reconnu.
            tracerRefus(
                HttpStatus.SERVICE_UNAVAILABLE,
                `file d'attente indisponible : ${(err as Error)?.message ?? 'cause inconnue'}`,
                true,
            );
            return response.status(HttpStatus.SERVICE_UNAVAILABLE).send('Queue unavailable');
        }
    }
}
