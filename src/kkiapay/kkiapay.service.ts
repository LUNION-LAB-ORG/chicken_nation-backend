import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { KkiapayResponse, KkiapayWebhookDto } from './kkiapay.type';
import { KkiapayEvent } from './kkiapay.event';
import { SettingsService } from 'src/modules/settings/settings.service';

/**
 * Client HTTP DIRECT vers l'API KKiaPay (remplace le SDK officiel, qui écrase
 * TOUTES les erreurs en « Transaction Not Found » — y compris un timeout réseau
 * ou un 5xx. Or confondre « KKiaPay injoignable » avec « transaction inconnue »
 * transforme un blip en paiement PERDU : le webhook est ACKé sans retry).
 * Mêmes baseURL/headers que le SDK (@kkiapay-org/nodejs-sdk/dist/lib/index.js).
 */
const KKIAPAY_URL_LIVE = 'https://api.kkiapay.me';
const KKIAPAY_URL_SANDBOX = 'https://api-sandbox.kkiapay.me';
const VERIFY_PATH = '/api/v1/transactions/status';
const REFUND_PATH = '/api/v1/transactions/revert';

/**
 * Compte KKiaPay résolu (global ou dédié à un restaurant).
 * `restaurantId` = null → compte GLOBAL historique.
 */
interface ResolvedAccount {
    /** null = compte global ; sinon l'id du restaurant dont les clés sont utilisées. */
    restaurantId: string | null;
    http: AxiosInstance;
    publicKey: string;
    sandbox: boolean;
    expiresAt: number;
}

/**
 * MULTI-COMPTES (décision 31/07) : chaque restaurant peut encaisser sur SON
 * compte KKiaPay. Les clés par restaurant vivent dans la table Setting sous
 * `kkiapay.<restaurantId>.{public_key,private_key,secret_key,webhook_secret,sandbox}` —
 * table déjà protégée par permissions, PAS sur le modèle Restaurant (dont les
 * routes publiques ont trop longtemps tout exposé).
 *
 * Résolution : clés complètes (public+private+secret) → compte dédié ; sinon
 * REPLI SILENCIEUX sur le compte global historique (déploiement sans big-bang :
 * tant qu'un restaurant n'est pas configuré, rien ne change pour lui).
 *
 * ⚠️ Cache à TTL COURT (60 s), jamais infini : deux backends partagent la même
 * base — une rotation de clé doit converger sur les deux process sans redémarrage.
 */
@Injectable()
export class KkiapayService {

    private readonly accountCache = new Map<string, ResolvedAccount>();
    /** Secret webhook par restaurant : `freshUntil` borne la FRAÎCHEUR (60 s —
     *  une rotation de secret converge en ≤ 60 s sur les deux backends) ; la
     *  valeur elle-même est conservée SANS limite comme copie de DERNIER RECOURS
     *  quand Neon est injoignable — un blip DB ne doit pas transformer la
     *  vérification de secret en 403/500 (paiement perdu, cf. incident 14/07). */
    private readonly webhookSecretCache = new Map<string, { value: string; freshUntil: number }>();
    private static readonly ACCOUNT_TTL_MS = 60_000;
    private static readonly WEBHOOK_SECRET_FRESH_MS = 60_000;
    private readonly logger = new Logger(KkiapayService.name);

    constructor(
        private readonly settingsService: SettingsService,
        private readonly eventEmitter: KkiapayEvent,
        private readonly configService: ConfigService,
    ) {}

    /** Client HTTP d'un jeu de clés (mêmes en-têtes que le SDK officiel). */
    private buildHttp(keys: { publickey: string; privatekey: string; secretkey: string; sandbox: boolean }): AxiosInstance {
        return axios.create({
            baseURL: keys.sandbox ? KKIAPAY_URL_SANDBOX : KKIAPAY_URL_LIVE,
            timeout: 15_000,
            headers: {
                'x-api-key': keys.publickey,
                'x-secret-key': keys.secretkey,
                'x-private-key': keys.privatekey,
            },
        });
    }

    /**
     * Appel verify BRUT avec la sémantique d'erreur qui manquait au SDK :
     *   • pas de réponse HTTP (réseau/timeout) ou 5xx → ServiceUnavailableException
     *     — l'appelant (worker BullMQ) RETENTE, le paiement n'est jamais perdu ;
     *   • 4xx avec réponse → BadRequestException « Transaction non trouvée »
     *     (transaction réellement inconnue de CE compte).
     */
    private async rawVerify(http: AxiosInstance, transactionId: string): Promise<KkiapayResponse> {
        try {
            const res = await http.post(VERIFY_PATH, { transactionId });
            return res.data as KkiapayResponse;
        } catch (error: any) {
            const status = error?.response?.status;
            if (!error?.response || status >= 500) {
                throw new ServiceUnavailableException('KKiaPay injoignable (verify)');
            }
            throw new BadRequestException('Transaction non trouvée');
        }
    }

    /** Clés de réglage d'un compte restaurant. */
    static settingKeys(restaurantId: string) {
        const p = `kkiapay.${restaurantId}.`;
        return {
            public_key: `${p}public_key`,
            private_key: `${p}private_key`,
            secret_key: `${p}secret_key`,
            webhook_secret: `${p}webhook_secret`,
            sandbox: `${p}sandbox`,
        };
    }

    /** Compte GLOBAL historique (Setting → fallback .env). */
    private async resolveGlobalAccount(): Promise<ResolvedAccount> {
        const config = await this.settingsService.getManyOrEnv({
            kkiapay_private_key: 'KKIA_PAY_PRIVATE_KEY',
            kkiapay_public_key: 'KKIA_PAY_PUBLIC_KEY',
            kkiapay_secret_key: 'KKIA_PAY_SECRET_KEY',
            kkiapay_sandbox: 'KKIA_PAY_SANDBOX',
        });
        const sandbox = config.kkiapay_sandbox === 'true';
        return {
            restaurantId: null,
            publicKey: config.kkiapay_public_key ?? '',
            sandbox,
            expiresAt: Date.now() + KkiapayService.ACCOUNT_TTL_MS,
            http: this.buildHttp({
                privatekey: config.kkiapay_private_key ?? '',
                publickey: config.kkiapay_public_key ?? '',
                secretkey: config.kkiapay_secret_key ?? '',
                sandbox,
            }),
        };
    }

    /**
     * Résout le compte à utiliser pour un restaurant (ou le global si
     * `restaurantId` est null / clés incomplètes). Toujours renvoyer un compte :
     * ne lève jamais pour cause de configuration manquante.
     */
    async resolveAccount(restaurantId: string | null): Promise<ResolvedAccount> {
        const cacheKey = restaurantId ?? '__global__';
        const hit = this.accountCache.get(cacheKey);
        if (hit && hit.expiresAt > Date.now()) return hit;

        let account: ResolvedAccount | null = null;
        if (restaurantId) {
            const keys = KkiapayService.settingKeys(restaurantId);
            try {
                const values = await this.settingsService.getMany([
                    keys.public_key, keys.private_key, keys.secret_key, keys.sandbox,
                ]);
                const pub = values[keys.public_key];
                const priv = values[keys.private_key];
                const sec = values[keys.secret_key];
                if (pub && priv && sec) {
                    // Sandbox par restaurant si posé, sinon on hérite du réglage global.
                    const sandbox = values[keys.sandbox] !== undefined
                        ? values[keys.sandbox] === 'true'
                        : (await this.resolveAccount(null)).sandbox;
                    account = {
                        restaurantId,
                        publicKey: pub,
                        sandbox,
                        expiresAt: Date.now() + KkiapayService.ACCOUNT_TTL_MS,
                        http: this.buildHttp({ privatekey: priv, publickey: pub, secretkey: sec, sandbox }),
                    };
                }
            } catch (e) {
                // Neon injoignable : cache périmé si présent, sinon on RELANCE.
                // ⚠️ ANTI-EMPOISONNEMENT (revue 31/07) : retomber ici sur le compte
                // global CACHERAIT le global sous la clé du restaurant pendant 60 s —
                // un webhook arrivant pendant un flap Neon vérifierait alors en
                // global-only, échouerait, et serait ACKé DÉFINITIVEMENT (paiement
                // perdu). L'erreur transitoire doit remonter au worker BullMQ, qui
                // retente. Le repli global reste réservé au cas « lecture RÉUSSIE
                // mais clés incomplètes » (restaurant pas encore configuré).
                if (hit) return hit;
                this.logger.warn(
                    `resolveAccount(${restaurantId}) : lecture Settings impossible, erreur relancée : ${(e as any)?.message}`,
                );
                throw e;
            }
        }

        if (!account) {
            const global = await this.resolveGlobalAccount();
            // Cache sous la clé demandée (restaurant non configuré → repli global,
            // re-testé à chaque expiration de TTL).
            account = { ...global };
        }
        this.accountCache.set(cacheKey, account);
        return account;
    }

    /**
     * Configuration PUBLIQUE de paiement d'un restaurant — embarquée dans les
     * réponses de commande côté app (clé publique + sandbox, jamais de secret).
     */
    async getPublicPaymentConfig(restaurantId: string | null): Promise<{
        provider: 'kkiapay';
        public_key: string;
        sandbox: boolean;
    }> {
        const account = await this.resolveAccount(restaurantId);
        return { provider: 'kkiapay', public_key: account.publicKey, sandbox: account.sandbox };
    }

    /**
     * Secret de webhook d'un restaurant (null = route legacy globale).
     * Renvoie `null` si AUCUNE source n'est disponible (ni DB ni cache mémoire) :
     * l'appelant doit alors répondre 503 (retry KKiaPay), jamais 403.
     */
    async getWebhookSecret(restaurantId: string | null): Promise<string | null> {
        // GLOBAL : DB-FIRST (revue 31/07) — l'ancien chemin env-first rendait la
        // rotation du secret au backoffice SANS EFFET tant que la variable d'env
        // restait posée (403 systématique après rotation = paiements plus jamais
        // confirmés). Même mécanique de cache que par-restaurant ; l'env ne sert
        // plus que de DERNIER recours (première installation, DB down sans cache).
        const cacheKey = restaurantId ?? '__global__';
        const cached = this.webhookSecretCache.get(cacheKey);
        if (cached && cached.freshUntil > Date.now()) return cached.value;
        const envFallback = restaurantId === null
            ? this.configService.get<string>('KKIA_PAY_WEBHOOK_SECRET')
            : undefined;
        try {
            const key = restaurantId === null
                ? 'kkiapay_webhook_secret'
                : KkiapayService.settingKeys(restaurantId).webhook_secret;
            const dbValue = await this.settingsService.get(key);
            const value = dbValue || envFallback || '';
            if (value) {
                this.webhookSecretCache.set(cacheKey, {
                    value,
                    freshUntil: Date.now() + KkiapayService.WEBHOOK_SECRET_FRESH_MS,
                });
                return value;
            }
            // Secret retiré / jamais posé : on purge la copie de secours pour ne
            // pas accepter indéfiniment un secret révoqué.
            this.webhookSecretCache.delete(cacheKey);
            return null; // aucun secret configuré → l'appelant tranche (503)
        } catch (e) {
            // Neon injoignable : dernier recours = copie mémoire même périmée,
            // puis l'env (global uniquement).
            if (cached) return cached.value;
            if (envFallback) return envFallback;
            this.logger.warn(`getWebhookSecret(${restaurantId ?? 'global'}) : DB injoignable et aucun cache`);
            return null;
        }
    }

    // Verification de la transaction (compte GLOBAL — chemin historique)
    async verifyTransaction(transactionId: string): Promise<KkiapayResponse> {
        const { transaction } = await this.verifyTransactionForRestaurant(transactionId, null);
        return transaction;
    }

    /**
     * Vérifie une transaction auprès du compte du restaurant, avec REPLI sur le
     * compte global si elle y est inconnue — indispensable pendant la transition :
     * les anciennes versions de l'app paient encore sur le compte historique.
     * Renvoie aussi `collectedBy` (l'id du restaurant dont le compte a réellement
     * reconnu la transaction, null = global) pour TRACER le compte encaisseur.
     */
    async verifyTransactionForRestaurant(
        transactionId: string,
        restaurantId: string | null,
    ): Promise<{ transaction: KkiapayResponse; collectedBy: string | null }> {
        if (!transactionId) {
            throw new BadRequestException("Transaction non trouvée");
        }

        const account = await this.resolveAccount(restaurantId);
        try {
            const transaction = await this.rawVerify(account.http, transactionId);
            return { transaction, collectedBy: account.restaurantId };
        } catch (error) {
            // KKiaPay INJOIGNABLE (réseau/5xx) : on remonte tel quel — le worker
            // BullMQ retente. Ne JAMAIS interpréter comme « transaction inconnue »
            // (c'est ce que faisait le SDK : blip = paiement perdu, revue 31/07).
            if (error instanceof ServiceUnavailableException) throw error;
            // Transaction réellement inconnue de CE compte. Compte dédié →
            // possiblement encaissée sur le compte global (ancienne app, commande
            // d'avant la bascule). On retente UNE fois en global.
            if (account.restaurantId !== null) {
                const global = await this.resolveAccount(null);
                const transaction = await this.rawVerify(global.http, transactionId);
                this.logger.log(
                    `Transaction ${transactionId} inconnue du compte ${account.restaurantId}, ` +
                    `trouvée sur le compte global (transition).`,
                );
                return { transaction, collectedBy: null };
            }
            throw new BadRequestException("Transaction non trouvée");
        }
    }

    /**
     * Remboursement — STRICTEMENT depuis le compte qui a encaissé
     * (`restaurantId` = valeur tracée sur le Paiement ; null = compte global).
     * Pas de repli : rembourser depuis un autre compte serait une erreur comptable.
     */
    async refundTransaction(transactionId: string, restaurantId: string | null = null): Promise<KkiapayResponse> {
        if (!transactionId) {
            throw new BadRequestException("Transaction non trouvée");
        }

        const account = await this.resolveAccount(restaurantId);
        // STRICT (revue 31/07) : si le compte du restaurant n'est plus configuré,
        // resolveAccount replie sur le global — rembourser depuis ce compte-là
        // serait une erreur comptable. On refuse explicitement.
        if (restaurantId !== null && account.restaurantId !== restaurantId) {
            throw new BadRequestException(
                'Le compte KKiaPay de ce restaurant n\'est plus configuré : impossible de rembourser depuis le compte encaisseur. Reconfigurez ses clés avant de rembourser.',
            );
        }

        try {
            const res = await account.http.post(REFUND_PATH, { transactionId });
            return res.data as KkiapayResponse;
        } catch (error: any) {
            if (!error?.response || error.response.status >= 500) {
                throw new ServiceUnavailableException('KKiaPay injoignable (refund)');
            }
            throw new BadRequestException("Transaction non trouvée");
        }
    }

    async handleEvent(payload: KkiapayWebhookDto): Promise<void> {
        this.logger.log({ "Kkiapay event": payload });

        // Exemple de traitement : selon l'event on met à jour la base de données, etc.
        if (payload.event === 'transaction.success') {
            this.logger.log(`Transaction successful: ${payload.transactionId}`);
            // AWAIT (pas fire-and-forget) : emitAsync propage tout rejet du listener
            // (ex : erreur transitoire Neon relancée par le processeur) → le worker
            // BullMQ voit l'échec et retente. Le chemin critique de paiement est ainsi
            // synchrone à l'ack du job.
            await this.eventEmitter.kkiapayTransactionSuccessEvent(payload);

        } else if (payload.event === 'transaction.failed') {
            this.logger.warn(`Transaction failed: ${payload.transactionId} – ${payload.failureCode} / ${payload.failureMessage}`);
            this.eventEmitter.kkiapayTransactionFailedEvent(payload);
        } else {
            this.logger.warn(`Unhandled event type: ${payload.event}`);
        }
    }
}
