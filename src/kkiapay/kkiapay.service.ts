import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { kkiapay } from "@kkiapay-org/nodejs-sdk"
import { KkiapayResponse, KkiapayWebhookDto } from './kkiapay.type';
import { KkiapayEvent } from './kkiapay.event';
import { SettingsService } from 'src/modules/settings/settings.service';

type KkiapayInstance = { verify: (id: string) => Promise<any>; refund: (id: string) => Promise<any> };

/**
 * Compte KKiaPay résolu (global ou dédié à un restaurant).
 * `restaurantId` = null → compte GLOBAL historique.
 */
interface ResolvedAccount {
    /** null = compte global ; sinon l'id du restaurant dont les clés sont utilisées. */
    restaurantId: string | null;
    instance: KkiapayInstance;
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
    private readonly webhookSecretCache = new Map<string, { value: string; expiresAt: number }>();
    private static readonly ACCOUNT_TTL_MS = 60_000;
    /** Les secrets de webhook gardent une copie mémoire longue (4 h) utilisée en
     *  DERNIER RECOURS si Neon est injoignable — un blip DB ne doit pas transformer
     *  la vérification de secret en 403/500 (paiement perdu, cf. incident 14/07). */
    private static readonly WEBHOOK_SECRET_STALE_MS = 4 * 60 * 60 * 1000;
    private readonly logger = new Logger(KkiapayService.name);

    constructor(
        private readonly settingsService: SettingsService,
        private readonly eventEmitter: KkiapayEvent,
    ) {}

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
            instance: kkiapay({
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
                        instance: kkiapay({ privatekey: priv, publickey: pub, secretkey: sec, sandbox }),
                    };
                }
            } catch (e) {
                // Neon injoignable : on retombe sur le cache périmé si présent, sinon global.
                if (hit) return hit;
                this.logger.warn(
                    `resolveAccount(${restaurantId}) : lecture Settings impossible, repli global : ${(e as any)?.message}`,
                );
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
        if (restaurantId === null) {
            const secret = await this.settingsService.getOrEnvSafe(
                'kkiapay_webhook_secret', 'KKIA_PAY_WEBHOOK_SECRET', '',
            );
            return secret || null;
        }
        const cacheKey = restaurantId;
        const cached = this.webhookSecretCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) return cached.value;
        try {
            const key = KkiapayService.settingKeys(restaurantId).webhook_secret;
            const value = await this.settingsService.get(key);
            if (value) {
                this.webhookSecretCache.set(cacheKey, {
                    value,
                    expiresAt: Date.now() + KkiapayService.WEBHOOK_SECRET_STALE_MS,
                });
                return value;
            }
            return null; // restaurant sans secret configuré → l'appelant tranche
        } catch (e) {
            // Neon injoignable : dernier recours = copie mémoire même périmée.
            if (cached) return cached.value;
            this.logger.warn(`getWebhookSecret(${restaurantId}) : DB injoignable et aucun cache`);
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
            const response = await account.instance.verify(transactionId);
            return { transaction: response as KkiapayResponse, collectedBy: account.restaurantId };
        } catch (error) {
            // Compte dédié → transaction possiblement encaissée sur le compte global
            // (ancienne app, commande d'avant la bascule). On retente UNE fois en global.
            if (account.restaurantId !== null) {
                const global = await this.resolveAccount(null);
                try {
                    const response = await global.instance.verify(transactionId);
                    this.logger.log(
                        `Transaction ${transactionId} inconnue du compte ${account.restaurantId}, ` +
                        `trouvée sur le compte global (transition).`,
                    );
                    return { transaction: response as KkiapayResponse, collectedBy: null };
                } catch {
                    throw new BadRequestException("Transaction non trouvée");
                }
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

        try {
            const response = await account.instance.refund(transactionId);
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
