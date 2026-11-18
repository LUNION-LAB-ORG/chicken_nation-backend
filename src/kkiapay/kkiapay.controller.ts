import { ApiOperation } from '@nestjs/swagger';
import { Body, Controller, Get, Headers, HttpStatus, Logger, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { Action } from 'src/modules/auth/enums/action.enum';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type { Request, Response } from 'express';
import { KkiapayService } from './kkiapay.service';
import { KkiapayResponse, KkiapayWebhookDto } from './kkiapay.type';
import { SettingsService } from 'src/modules/settings/settings.service';
import { AuditService } from 'src/modules/audit/audit.service';
import { journalRefusWebhook } from './kkiapay-audit.helper';
import { AlertesService, CodeAlerte } from 'src/modules/alertes/alertes.service';
import { isUUID } from 'class-validator';

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
        private readonly auditService: AuditService,
        private readonly alertes: AlertesService,
        @InjectQueue('kkiapay-webhooks') private readonly webhooksQueue: Queue,
    ) { }

    // Guards AJOUTÉS (audit 31/07) : ces routes étaient PUBLIQUES, un
    // REMBOURSEMENT était déclenchable anonymement avec un simple transactionId.
    // Aucun client (app/backoffice/site) ne les consommait ; le remboursement
    // officiel passe par POST /paiements/refund/:id (gardé + tracé par compte).
    //
    // Audit des droits (25/09) : le seul JWT laissait passer TOUT le personnel,
    // cuisine et caisse comprises. POST /kkiapay/refund est SUPPRIMÉ : il
    // remboursait de l'argent réel sans toucher la base (Paiement resté SUCCESS,
    // commande restée payée, points acquis), et personne ne l'appelait.
    // Diagnostic et vérification sont réservés à qui lit les clés KKiaPay dans
    // Paramètres (SETTINGS READ, administrateur seul aujourd'hui).
    // ⚠️ @RequirePermission se pose sur la MÉTHODE : le garde ne lit que le handler.
    /**
     * DIAGNOSTIC (06/08) : quel compte KKiaPay sert réellement un restaurant, et
     * pourquoi. Sans cet outil, un repli silencieux sur le compte global ne se
     * constate qu'après un vrai paiement parti au mauvais endroit.
     * Ne renvoie AUCUN secret : uniquement des présences et des empreintes.
     */
    @Get('diagnostic/:restaurantId')
    @UseGuards(JwtAuthGuard, UserPermissionsGuard)
    @RequirePermission(Modules.SETTINGS, Action.READ)
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
            // Les 8 premiers caractères suffisent à distinguer deux comptes.
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

    // Renvoie l'identité du payeur (nom, téléphone, email) : lecture réservée.
    @Post('verify')
    @UseGuards(JwtAuthGuard, UserPermissionsGuard)
    @RequirePermission(Modules.SETTINGS, Action.READ)
    async verifyTransaction(@Body() body: { transactionId: string }): Promise<KkiapayResponse> {
        return this.kkiapayService.verifyTransaction(body.transactionId);
    }

    /**
     * Webhook KKiaPay — INGESTION SANS PERTE, POUR TOUS LES COMPTES.
     *
     * 1. Enfile le payload brut dans BullMQ (Redis) avec un jobId idempotent
     *    `event_transactionId` (assaini, sans ':' interdit par BullMQ) → répond 200.
     *    Le traitement DB awaité se fait dans le worker (KkiapayWebhookConsumer),
     *    qui retente sur erreur transitoire.
     * 2. Si l'enfilement échoue (Redis injoignable) → 503 pour que KKiaPay RETENTE.
     *    On ne renvoie JAMAIS 200 sur erreur (sinon paiement perdu sans retry).
     * 3. La clé (`x-kkiapay-secret`) ne décide plus rien, pour aucun restaurant :
     *    elle est comparée APRÈS la réponse, pour le journal seulement.
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
     * KKiaPay du restaurant). La route legacy ci-dessus reste active pour le
     * compte global historique.
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
         * Tout refus est JOURNALISÉ (Audits → Logs) et annoncé dans le groupe.
         * Le secret reçu n'est JAMAIS journalisé. Écriture fire-and-forget : elle
         * ne peut ni ralentir ni casser l'ingestion.
         */
        const tracerRefus = (statut: number, motif: string, avecAlerte: boolean) => {
            // `null` = refus bridé : une ligne récente couvre déjà ce cas. La route
            // est publique : sans cette bride, n'importe qui ferait grossir la
            // table d'audit à volonté. Aucun compte n'est « reconnu » ici (la base
            // n'est plus lue avant la réponse) : tous les refus partagent une clé.
            const entree = journalRefusWebhook({
                payload: body ?? {},
                restaurantId,
                statut,
                motif,
                compteReconnu: false,
                path: request?.originalUrl ?? request?.url ?? '/kkiapay/webhook',
                ip: request?.ip ?? null,
                userAgent: request?.headers?.['user-agent'] ?? null,
            });
            if (entree) this.auditService.record(entree);
            if (!avecAlerte) return;
            // Le service brime lui-même les répétitions : une panne ne produira
            // pas cent messages.
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

        // Les comptes des restaurants sont des UUID : une autre valeur dans
        // l'adresse ne vient pas d'un compte KKiaPay configuré par nous.
        if (restaurantId !== null && !isUUID(restaurantId)) {
            tracerRefus(HttpStatus.NOT_FOUND, `compte inconnu dans l'adresse (« ${restaurantId.slice(0, 40)} »)`, false);
            return response.status(HttpStatus.NOT_FOUND).send('Unknown account');
        }

        /**
         * CLÉ NON BLOQUANTE POUR TOUS (18/11). Depuis le 24/09 (incident ZONE 4 :
         * clé collée à l'identique des deux côtés, webhooks refusés quand même),
         * une clé DIFFÉRENTE n'arrêtait plus rien. Restait un cas bloquant :
         * aucune clé enregistrée chez nous pour le compte, ou base injoignable
         * sans copie en mémoire → 503, et le paiement attendait que KKiaPay
         * renvoie son webhook. Il n'existe plus.
         *
         * La clé ne protège pas l'argent : le traitement revérifie la transaction
         * auprès de KKiaPay avec les clés du compte, exige un statut SUCCESS et un
         * montant qui couvre la commande, et une transaction déjà rattachée ne
         * compte pas pour une autre commande.
         *
         * La réponse ne lit donc plus la base : le webhook est mis en file tout
         * de suite, même quand Neon est lent ou injoignable (le worker retente).
         */
        try {
            // jobId idempotent : un même event/transaction ne s'enfile pas deux fois
            // tant que le job existe. Le traitement est de toute façon idempotent.
            // ⚠️ BullMQ INTERDIT le caractère ':' dans un custom jobId
            // (Error: Custom Id cannot contain :) : avec un séparateur ':' l'enfilement
            // throw à CHAQUE webhook → 503 → aucun paiement web n'est jamais traité.
            // On assainit donc le jobId (on ne garde que [a-zA-Z0-9_.-]).
            const jobId = `${body.event}_${body.transactionId}`.replace(/[^a-zA-Z0-9_.-]/g, '');
            // L'id du restaurant voyage AVEC le payload : le traitement aval vérifie
            // la transaction auprès du bon compte (repli global si non configuré).
            await this.webhooksQueue.add('event', { ...body, restaurantId: restaurantId ?? undefined }, { jobId });
        } catch (err) {
            // Redis injoignable → 503 pour que KKiaPay retente (NE PAS avaler en 200).
            this.logger.error('Échec enfilement webhook KKiaPay', err as any);
            tracerRefus(
                HttpStatus.SERVICE_UNAVAILABLE,
                `file d'attente indisponible : ${(err as Error)?.message ?? 'cause inconnue'}`,
                true,
            );
            return response.status(HttpStatus.SERVICE_UNAVAILABLE).send('Queue unavailable');
        }

        response.status(HttpStatus.OK).send({ received: true });
        // Après la réponse : la clé, pour le journal seulement.
        void this.noterCle(receivedSecret, restaurantId);
    }

    /**
     * Compare la clé reçue à celle enregistrée pour le compte, pour pouvoir la
     * réaligner (empreintes, jamais la valeur entière). Ne décide de rien, ne
     * lève jamais.
     */
    private async noterCle(receivedSecret: string | undefined, restaurantId: string | null): Promise<void> {
        const compte = restaurantId ? ` [${restaurantId}]` : '';
        try {
            const attendue = await this.kkiapayService.getWebhookSecret(restaurantId);
            if (attendue === null) {
                this.logger.warn(
                    `Webhook KKiaPay${compte} : aucune clé enregistrée pour ce compte (ou base injoignable), traité quand même` +
                    ` (reçu ${empreinteSecret(receivedSecret)})`,
                );
            } else if (receivedSecret !== attendue) {
                this.logger.warn(
                    `Webhook KKiaPay${compte} : clé différente, traité quand même` +
                    ` (reçu ${empreinteSecret(receivedSecret)}, attendu ${empreinteSecret(attendue)})`,
                );
            }
        } catch (e) {
            this.logger.warn(`Webhook KKiaPay${compte} : clé non comparée (${(e as Error)?.message ?? 'cause inconnue'})`);
        }
    }
}
