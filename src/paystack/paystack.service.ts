import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { FournisseurPaiement } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { SettingsService } from 'src/modules/settings/settings.service';
import { ErreurPaystack, appelerPaystack } from './paystack-http';
import {
  CANAUX_PAYSTACK,
  DEVISE_PAYSTACK,
  HOTE_CHECKOUT_PAYSTACK,
  MoyenPaystack,
  SousComptePaystack,
  TAUX_FRAIS_DEFAUT,
  TauxFraisPaystack,
  TransactionPaystackLue,
  emailPourPaystack,
  emailTechnique,
  fraisClient,
  lireSousCompte,
  lireTaux,
  lireTransaction,
  modeDeCle,
  motifSousCompteInutilisable,
  motifTransactionRefusee,
  referenceTentative,
  statutTentative,
  versUnitePaystack,
} from './paystack.rules';

/** Clés des réglages (table settings). La clé secrète et le secret du webhook sont masqués à la lecture. */
export const CLES_PAYSTACK = {
  cleSecrete: 'paystack_secret_key',
  secretWebhook: 'paystack_webhook_secret',
  sousCompte: (restaurantId: string) => `paystack.${restaurantId}.subaccount_code`,
  /** Frais ajoutés au client (25/11), en pourcentage. */
  fraisMobileMoney: 'paystack_frais_mobile_money',
  fraisCarte: 'paystack_frais_carte',
  fraisSupplement: 'paystack_frais_supplement',
} as const;

export interface ConfigPaystack {
  cle: string | null;
  mode: 'test' | 'live' | null;
  secretsWebhook: string[];
  /** Taux des frais ajoutés au client ; le supplément borne aussi la part du compte principal. */
  frais: TauxFraisPaystack;
}

/** Sous-compte lu chez Paystack et gardé en mémoire (deux serveurs partagent la base, pas la mémoire). */
interface SousCompteEnCache {
  valeur: SousComptePaystack | null;
  lu: number;
}

const TTL_CONFIG_MS = 30_000;
const TTL_SOUS_COMPTE_MS = 10 * 60_000;
/** Paystack injoignable : on garde un sous-compte déjà validé jusqu'à 24 h. */
const SECOURS_SOUS_COMPTE_MS = 24 * 3_600_000;

/**
 * PAYSTACK (25/11) : seul détenteur de la clé secrète. Lance un paiement sur
 * le sous-compte du restaurant (frais portés par le sous-compte, rien sur le
 * compte principal), vérifie une transaction, lit les sous-comptes, rembourse.
 *
 * Clé lue en base d'abord (réglée au back-office), puis `PAYSTACK_SECRET_KEY`
 * en dernier recours (banc d'essai). Une clé live est refusée hors production.
 */
@Injectable()
export class PaystackService {
  private readonly logger = new Logger(PaystackService.name);
  private configEnCache: { valeur: ConfigPaystack; expire: number } | null = null;
  private readonly sousComptes = new Map<string, SousCompteEnCache>();

  constructor(
    private readonly settings: SettingsService,
    private readonly prisma: PrismaService,
  ) {}

  invaliderCache(): void {
    this.configEnCache = null;
    this.sousComptes.clear();
  }

  async config(): Promise<ConfigPaystack> {
    const maintenant = Date.now();
    if (this.configEnCache && this.configEnCache.expire > maintenant) return this.configEnCache.valeur;
    const valeurs = await this.settings.getMany([
      CLES_PAYSTACK.cleSecrete,
      CLES_PAYSTACK.secretWebhook,
      CLES_PAYSTACK.fraisMobileMoney,
      CLES_PAYSTACK.fraisCarte,
      CLES_PAYSTACK.fraisSupplement,
    ]);
    const brute = (valeurs[CLES_PAYSTACK.cleSecrete] || process.env.PAYSTACK_SECRET_KEY || '').trim();
    let mode = modeDeCle(brute);
    if (mode === 'live' && process.env.NODE_ENV !== 'production' && process.env.PAYSTACK_LIVE_HORS_PRODUCTION !== 'true') {
      this.logger.warn('Clé Paystack live refusée hors production.');
      mode = null;
    }
    const secrets = [valeurs[CLES_PAYSTACK.secretWebhook], process.env.PAYSTACK_WEBHOOK_SECRET]
      .map((s) => (s ?? '').trim())
      .filter((s) => /^whsec_[A-Za-z0-9_-]{8,}$/.test(s));
    const frais: TauxFraisPaystack = {
      mobileMoney: lireTaux(valeurs[CLES_PAYSTACK.fraisMobileMoney], TAUX_FRAIS_DEFAUT.mobileMoney),
      carte: lireTaux(valeurs[CLES_PAYSTACK.fraisCarte], TAUX_FRAIS_DEFAUT.carte),
      supplement: lireTaux(valeurs[CLES_PAYSTACK.fraisSupplement], TAUX_FRAIS_DEFAUT.supplement),
    };
    const valeur: ConfigPaystack = { cle: mode ? brute : null, mode, secretsWebhook: [...new Set(secrets)], frais };
    this.configEnCache = { valeur, expire: maintenant + TTL_CONFIG_MS };
    return valeur;
  }

  private apiUrl(): string | undefined {
    // Faux Paystack local pour les essais seulement ; jamais en production.
    const url = process.env.PAYSTACK_API_URL?.trim();
    return url && process.env.NODE_ENV !== 'production' ? url.replace(/\/+$/, '') : undefined;
  }

  private async appeler(methode: 'GET' | 'POST' | 'PUT', chemin: string, corps: unknown = null, delaiMs = 10_000) {
    const { cle } = await this.config();
    return appelerPaystack(cle, methode, chemin, corps, delaiMs, this.apiUrl());
  }

  // ---------------------------------------------------------------------------
  // Sous-comptes
  // ---------------------------------------------------------------------------

  async codeSousCompte(restaurantId: string): Promise<string | null> {
    const v = (await this.settings.get(CLES_PAYSTACK.sousCompte(restaurantId)))?.trim();
    return v && /^ACCT_[A-Za-z0-9]{4,}$/.test(v) ? v : null;
  }

  async codesSousComptes(restaurantIds: string[]): Promise<Record<string, string | null>> {
    if (!restaurantIds.length) return {};
    const valeurs = await this.settings.getMany(restaurantIds.map((id) => CLES_PAYSTACK.sousCompte(id)));
    const resultat: Record<string, string | null> = {};
    for (const id of restaurantIds) {
      const v = valeurs[CLES_PAYSTACK.sousCompte(id)]?.trim();
      resultat[id] = v && /^ACCT_[A-Za-z0-9]{4,}$/.test(v) ? v : null;
    }
    return resultat;
  }

  /**
   * Sous-compte lu chez Paystack (10 min en mémoire). Paystack injoignable :
   * la dernière lecture de moins de 24 h sert ; sinon l'erreur remonte.
   * `frais` : relit chez Paystack, sans le cache (écran d'administration).
   */
  async lireSousCompte(code: string, options: { frais?: boolean } = {}): Promise<SousComptePaystack | null> {
    const maintenant = Date.now();
    const enCache = this.sousComptes.get(code);
    if (!options.frais && enCache && maintenant - enCache.lu < TTL_SOUS_COMPTE_MS) return enCache.valeur;
    try {
      const { data } = await this.appeler('GET', `/subaccount/${encodeURIComponent(code)}`);
      const valeur = lireSousCompte(data);
      this.sousComptes.set(code, { valeur, lu: maintenant });
      return valeur;
    } catch (e) {
      if (e instanceof ErreurPaystack && e.nature === 'INTROUVABLE') {
        this.sousComptes.set(code, { valeur: null, lu: maintenant });
        return null;
      }
      if (enCache?.valeur && maintenant - enCache.lu < SECOURS_SOUS_COMPTE_MS) return enCache.valeur;
      throw e;
    }
  }

  /** Sous-comptes du compte Paystack (jusqu'à 500), pour les relier aux restaurants. */
  async listerSousComptes(): Promise<SousComptePaystack[]> {
    const tous: SousComptePaystack[] = [];
    for (let page = 1; page <= 5; page++) {
      const { data, meta } = await this.appeler('GET', `/subaccount?perPage=100&page=${page}`);
      const liste = Array.isArray(data) ? data : [];
      for (const brut of liste) {
        const s = lireSousCompte(brut);
        if (s) {
          tous.push(s);
          this.sousComptes.set(s.code, { valeur: s, lu: Date.now() });
        }
      }
      const pages = typeof meta?.pageCount === 'number' ? meta.pageCount : 1;
      if (page >= pages || liste.length < 100) break;
    }
    return tous;
  }

  /** Sous-compte utilisable du restaurant, ou le motif qui l'empêche (aucun appel si non relié). */
  async sousCompteUtilisable(restaurantId: string): Promise<{ code: string | null; motif: string | null }> {
    const code = await this.codeSousCompte(restaurantId);
    if (!code) return { code: null, motif: 'NON_RELIE' };
    try {
      const [s, { frais }] = await Promise.all([this.lireSousCompte(code), this.config()]);
      return { code, motif: motifSousCompteInutilisable(s, frais.supplement) };
    } catch (e) {
      this.logger.warn(`Sous-compte ${code} illisible (${(e as Error).message}).`);
      return { code, motif: 'ILLISIBLE' };
    }
  }

  // ---------------------------------------------------------------------------
  // Paiement
  // ---------------------------------------------------------------------------

  /**
   * Lance le paiement d'une commande : tentative enregistrée, puis
   * transaction initialisée chez Paystack sur le sous-compte du restaurant,
   * frais portés par le sous-compte. Rend le lien de la page de paiement.
   */
  async initialiser(params: {
    order: { id: string; reference: string; amount: number; restaurant_id: string; customer_id: string };
    email: string | null;
    canal: 'APP' | 'WEB';
    /** Moyen choisi par le client : il fixe les frais, et la page ne propose que lui. */
    moyen: MoyenPaystack;
    callbackUrl: string;
  }): Promise<{ authorization_url: string; reference: string; montant: number; frais: number; total: number; moyen: MoyenPaystack }> {
    const { order, moyen } = params;
    const montant = Math.round(Number(order.amount));
    // Paystack n'ajoute rien : le client paie la commande plus les frais du
    // moyen choisi (taux et supplément réglés au back-office).
    const frais = fraisClient(montant, moyen, (await this.config()).frais);
    const total = montant + frais;
    const unites = versUnitePaystack(total);
    if (unites === null || montant < 1) throw new BadRequestException('Montant de la commande invalide pour un paiement en ligne.');

    const { code, motif } = await this.sousCompteUtilisable(order.restaurant_id);
    if (!code || motif) {
      throw new BadRequestException(
        "Le paiement en ligne n'est pas encore disponible pour ce restaurant.",
      );
    }

    const reference = referenceTentative(order.reference);
    await this.prisma.tentativePaiement.create({
      data: {
        order_id: order.id,
        fournisseur: FournisseurPaiement.PAYSTACK,
        reference,
        montant,
        frais,
        moyen,
        restaurant_id: order.restaurant_id,
        sous_compte: code,
        canal: params.canal,
      },
    });

    const corps = {
      email: emailPourPaystack(params.email, order.customer_id),
      amount: unites,
      currency: DEVISE_PAYSTACK,
      reference,
      callback_url: params.callbackUrl,
      // Un seul moyen proposé : celui dont les frais viennent d'être calculés.
      channels: CANAUX_PAYSTACK.filter((c) => c === moyen),
      subaccount: code,
      // Frais Paystack portés par le sous-compte : rien sur le compte principal.
      bearer: 'subaccount',
      metadata: JSON.stringify({
        order_id: order.id,
        order_reference: order.reference,
        restaurant_id: order.restaurant_id,
        canal: params.canal,
        montant_commande: montant,
        frais,
        cancel_action: params.callbackUrl,
      }),
    };
    let data: unknown;
    try {
      try {
        ({ data } = await this.appeler('POST', '/transaction/initialize', corps));
      } catch (e) {
        // Paystack juge l'e-mail du client invalide (faute de frappe, domaine
        // inconnu) : le paiement ne doit pas en dépendre. Relancé une fois
        // avec l'adresse technique.
        const adresse = emailTechnique(order.customer_id);
        if (!(e instanceof ErreurPaystack) || e.nature !== 'REFUS' || !/email/i.test(e.messagePaystack ?? '') || corps.email === adresse) {
          throw e;
        }
        this.logger.warn(`E-mail du client refusé par Paystack pour ${order.reference} : adresse technique utilisée.`);
        ({ data } = await this.appeler('POST', '/transaction/initialize', { ...corps, email: adresse }));
      }
    } catch (e) {
      await this.prisma.tentativePaiement.update({ where: { reference }, data: { statut: 'ECHEC' } }).catch(() => undefined);
      this.logger.error(`Initialisation Paystack refusée pour ${order.reference} : ${(e as Error).message}`);
      if (e instanceof ErreurPaystack && e.nature === 'INJOIGNABLE') {
        throw new ServiceUnavailableException('Le paiement en ligne ne répond pas. Réessayez dans un instant.');
      }
      throw new BadRequestException("Le paiement en ligne n'a pas pu être lancé. Réessayez dans un instant.");
    }
    const d = (data ?? {}) as Record<string, unknown>;
    const url = typeof d.authorization_url === 'string' ? d.authorization_url : '';
    if (!this.lienAccepte(url) || (typeof d.reference === 'string' && d.reference !== reference)) {
      this.logger.error(`Réponse Paystack inattendue à l'initialisation de ${order.reference}.`);
      throw new BadRequestException("Le paiement en ligne n'a pas pu être lancé. Réessayez dans un instant.");
    }
    return { authorization_url: url, reference, montant, frais, total, moyen };
  }

  /** Lien de paiement en https sur l'hôte de Paystack (http admis hors production, pour le faux local). */
  private lienAccepte(url: string): boolean {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (u.username || u.password) return false;
    if (process.env.NODE_ENV !== 'production' && this.apiUrl()) return u.protocol === 'http:' || u.protocol === 'https:';
    return u.protocol === 'https:' && u.hostname.toLowerCase() === HOTE_CHECKOUT_PAYSTACK;
  }

  /** Tentative Paystack et la référence de sa commande ; null si inconnue. */
  async tentative(reference: string) {
    if (typeof reference !== 'string' || !reference || reference.length > 100) return null;
    const t = await this.prisma.tentativePaiement.findUnique({
      where: { reference },
      select: {
        reference: true,
        order_id: true,
        restaurant_id: true,
        statut: true,
        fournisseur: true,
        created_at: true,
        order: { select: { reference: true, customer_id: true } },
      },
    });
    return t && t.fournisseur === FournisseurPaiement.PAYSTACK ? t : null;
  }

  /** Références des tentatives Paystack d'une commande, les plus récentes d'abord. */
  async referencesDeCommande(orderId: string, nombre = 5): Promise<string[]> {
    const liste = await this.prisma.tentativePaiement.findMany({
      where: { order_id: orderId, fournisseur: FournisseurPaiement.PAYSTACK },
      select: { reference: true },
      orderBy: { created_at: 'desc' },
      take: nombre,
    });
    return liste.map((t) => t.reference);
  }

  /** Transaction lue chez Paystack (GET /transaction/verify/:reference). */
  async verifier(reference: string): Promise<TransactionPaystackLue> {
    const { data } = await this.appeler('GET', `/transaction/verify/${encodeURIComponent(reference)}`, null, 9_000);
    return lireTransaction(data, reference);
  }

  /**
   * Transaction d'une tentative, vérifiée chez Paystack et contrôlée pour la
   * commande : même référence, mode de la clé, XOF, commande et sous-compte
   * attendus. Met à jour la tentative.
   *
   * @throws BadRequestException : tentative inconnue, ou transaction qui ne
   *   paie pas cette commande (permanent) ; ServiceUnavailableException :
   *   Paystack injoignable (à retenter).
   */
  async transactionPourCommande(reference: string, orderId: string) {
    const tentative = await this.prisma.tentativePaiement.findUnique({ where: { reference } });
    if (!tentative || tentative.order_id !== orderId || tentative.fournisseur !== FournisseurPaiement.PAYSTACK) {
      throw new BadRequestException('Transaction non trouvée pour cette commande.');
    }
    const { mode } = await this.config();
    if (!mode) throw new ServiceUnavailableException("Paystack n'est pas configuré.");
    let t: TransactionPaystackLue;
    try {
      t = await this.verifier(reference);
    } catch (e) {
      if (e instanceof ErreurPaystack && e.nature === 'INTROUVABLE') {
        // Paystack ne connaît pas cette référence : la tentative ne paiera
        // jamais. Classée en échec, le filet ne la revérifie plus.
        await this.prisma.tentativePaiement
          .update({ where: { reference }, data: { statut: 'ECHEC', verifiee_at: new Date() } })
          .catch(() => undefined);
        throw new BadRequestException('Transaction non trouvée chez Paystack.');
      }
      throw new ServiceUnavailableException('Paystack ne répond pas.');
    }
    const refus = motifTransactionRefusee(t, { reference, orderId, sousCompte: tentative.sous_compte, mode });
    const statut = refus ? 'ECHEC' : statutTentative(t);
    await this.prisma.tentativePaiement
      .update({ where: { reference }, data: { statut, verifiee_at: new Date() } })
      .catch(() => undefined);
    if (refus) {
      this.logger.error(`Transaction Paystack ${reference} refusée pour la commande ${orderId} : ${refus}.`);
      throw new BadRequestException(`Transaction refusée : ${refus}.`);
    }
    return { transaction: t, restaurantId: tentative.restaurant_id, frais: tentative.frais };
  }

  // ---------------------------------------------------------------------------
  // Remboursement
  // ---------------------------------------------------------------------------

  /**
   * Demande de remboursement (POST /refund). Notre référence rend la demande
   * unique : un second envoi répond 409, et on relit alors la demande existante.
   */
  async rembourser(params: { transaction: string; montant: number; reference: string; note: string }) {
    const unites = versUnitePaystack(params.montant);
    if (unites === null) throw new BadRequestException('Montant à rembourser invalide.');
    try {
      const { data } = await this.appeler('POST', '/refund', {
        transaction: params.transaction,
        amount: unites,
        currency: DEVISE_PAYSTACK,
        reference: params.reference,
        merchant_note: params.note.slice(0, 200),
      });
      return { statut: lireStatutRemboursement(data) };
    } catch (e) {
      if (e instanceof ErreurPaystack && e.statutHttp === 409) {
        return { statut: await this.statutRemboursement(params.reference) };
      }
      throw e;
    }
  }

  async statutRemboursement(reference: string): Promise<string> {
    const { data } = await this.appeler('GET', `/refund?reference=${encodeURIComponent(reference)}`);
    const liste = Array.isArray(data) ? data : data ? [data] : [];
    const trouve = liste.find(
      (r) => String((r as Record<string, unknown>)?.reference ?? (r as Record<string, unknown>)?.refund_reference ?? '').toLowerCase() === reference.toLowerCase(),
    );
    return trouve ? lireStatutRemboursement(trouve) : 'inconnu';
  }
}

/** Statut d'un remboursement Paystack : pending, processing, needs-attention, failed, processed. */
export function lireStatutRemboursement(brut: unknown): string {
  const s = (brut && typeof brut === 'object' ? (brut as Record<string, unknown>).status : null) ?? '';
  return typeof s === 'string' && s ? s.toLowerCase() : 'inconnu';
}
