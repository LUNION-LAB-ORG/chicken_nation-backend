import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DiscountType,
  EntityStatus,
  Prisma,
  PromoCodeUsageStatus,
  TargetType,
  User,
  UserRole,
  UserType,
  VoucherStatus,
} from '@prisma/client';
import { addDays } from 'date-fns';
import { PrismaService } from 'src/database/services/prisma.service';
import { AuditService } from 'src/modules/audit/audit.service';
import { permissionsByRole } from 'src/modules/auth/constantes/permissionsByRole';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { PromoCodeService } from 'src/modules/promo-code/promo-code.service';
import { VoucherService } from 'src/modules/voucher/voucher.service';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';
import { CreateOrderDto } from '../dto/create-order.dto';
import { ApercuCouponDto } from '../dto/apercu-coupon.dto';
import {
  arrondirRemise,
  arrondirSolde,
  assietteDesRemises,
  formaterFrancs,
  JOURS_PROLONGATION_BON,
  LIBELLE_BON,
  libelleCodePromo,
  LigneAssiette,
  LONGUEUR_MAX_CODE,
  masquerCode,
  MESSAGE_AUCUN_COUPON,
  MESSAGE_SANS_REDUCTION,
  motifRefusBon,
  normaliserCode,
  reformulerRefusCodePromo,
} from '../helpers/coupon.helper';
import { OrderHelper } from '../helpers/order.helper';

export type TypeCoupon = 'PROMO_CODE' | 'VOUCHER';

/** Requête à l'origine d'un usage, pour le journal : la création par défaut. */
export interface RequeteCoupon {
  methode: string;
  chemin: string;
  statut: number;
}

/** Coupon vérifié pour une commande précise. `remise` est au franc, > 0, ≤ netAmount. */
export interface CouponResolu {
  type: TypeCoupon;
  code: string;
  remise: number;
  libelle: string;
  codePromo?: {
    id: string;
    discount_type: DiscountType;
    discount_value: number;
    max_discount_amount: number | null;
    min_order_amount: number | null;
    target_type: TargetType;
    expiration_date: Date | null;
  };
  bon?: {
    id: string;
    solde: number;
    solde_apres: number;
    expire_le: Date | null;
  };
}

/** Ce qui a été consommé dans la transaction de création. */
export interface ConsommationCoupon {
  type: TypeCoupon;
  code: string;
  remise: number;
  promoCodeId?: string;
  usageId?: string;
  bonId?: string;
  redemptionId?: string;
  soldeApres?: number;
}

/** Bon recrédité par une annulation ou une suppression. */
export interface BonRestitue {
  bonId: string;
  code: string;
  customerId: string;
  montant: number;
  solde: number;
  prolonge: boolean;
  expireLe: Date | null;
  /** Bon annulé ou supprimé entre-temps : solde recrédité mais bon toujours inutilisable. */
  inutilisable: boolean;
}

export interface RestitutionCoupon {
  bons: BonRestitue[];
  codesPromo: { promoCodeId: string; code: string | null; montant: number }[];
}

/** RETRAIT : coupon retiré d'une commande modifiée par le personnel (02/10). */
export type MotifRestitution = 'ANNULATION' | 'SUPPRESSION' | 'RETRAIT';

/** Coupon retiré d'une commande dans la transaction de sa modification. */
export interface RetraitCoupon {
  restitution: RestitutionCoupon;
  /** Part de `Order.discount` qui venait du coupon (ses traces, sinon la remise entière). */
  remise: number;
}

export const MESSAGE_DROIT_COUPON =
  "L'application d'un coupon est réservée au centre d'appels, à la caisse et aux administrateurs.";

/** Coupon d'un panier annulé par le client, à sa réactivation. */
export interface ReconsommationCoupon {
  type: TypeCoupon | null;
  code: string | null;
  /** Remise du coupon, comprise dans `Order.discount`. */
  remise: number;
  /** Vrai : le coupon est consommé (de nouveau, ou jamais rendu), la remise reste. */
  consomme: boolean;
  /** Vrai : il n'avait jamais été rendu, rien n'a été écrit. */
  deja_consomme?: boolean;
  /** Faux `consomme` : pourquoi la remise est retirée, en français. */
  raison?: string;
  bonId?: string;
  soldeApres?: number;
  promoCodeId?: string;
}

/**
 * Restitution déclenchée ailleurs que par `PATCH /orders/:id/status` : course
 * annulée (livreur, administrateur, annulation automatique), livraison
 * échouée, ou filet de rattrapage (voir CouponRestitutionListener). Le journal
 * dit alors d'où elle vient.
 */
export interface OrigineRestitution {
  methode: string;
  chemin: string;
  /** Complément du résumé, après « commande CMD annulée » : « livraison échouée ». */
  precision: string;
}

export interface ContexteRestitution {
  motif: MotifRestitution;
  acteurId?: string | null;
  acteurRole?: string | null;
  origine?: OrigineRestitution;
}

type Transaction = Prisma.TransactionClient;

const ERREUR_SOLDE_CHANGE =
  "Le solde de ce bon a changé entre-temps. Vérifiez-le de nouveau avant d'enregistrer la commande.";

/**
 * CODES PROMO ET BONS D'ACHAT À LA PRISE DE COMMANDE DU PERSONNEL.
 *
 *  - `resoudre` : le code est d'abord cherché parmi les codes promo (coupons CRM
 *    compris), puis parmi les bons du client. Les refus sont précis, écrits pour
 *    l'agent qui a le client au téléphone.
 *  - `apercu` : la remise d'une commande qui n'existe pas encore, calculée avec
 *    EXACTEMENT les fonctions de la création. L'écran n'envoie aucun montant.
 *  - `consommer` : dans la transaction qui crée la commande. Un échec annule la
 *    commande entière : jamais de bon débité sans commande, ni l'inverse.
 *  - `restituerPourCommande` : à l'annulation et à la suppression, pour TOUTES
 *    les commandes (personnel et application). Idempotent.
 *  - `retirerDansTransaction` : le coupon d'une commande MODIFIÉE (02/10), dans
 *    la transaction de la modification, pour qu'un remplacement soit tout ou
 *    rien. `consommer` sert ensuite au nouveau coupon, comme à la création.
 *
 * Le chemin de l'application (createv2, OrderV2Helper.applyPromoCode) n'est pas
 * modifié ; il profite seulement de la restitution.
 */
@Injectable()
export class OrderCouponService {
  private readonly logger = new Logger(OrderCouponService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orderHelper: OrderHelper,
    private readonly promoCodeService: PromoCodeService,
    private readonly voucherService: VoucherService,
    private readonly auditService: AuditService,
    private readonly appGateway: AppGateway,
  ) {}

  /* ================================================================
     RÉSOLUTION
  ================================================================ */

  async resoudre(params: {
    code: string;
    customerId: string;
    netAmount: number;
    assiette: LigneAssiette[];
    restaurantId?: string | null;
    /** Commande dont le coupon est retiré dans la même requête : ses usages ne comptent pas. */
    ignorerCommandeId?: string | null;
  }): Promise<CouponResolu> {
    const code = normaliserCode(params.code);
    if (!code) throw new BadRequestException('Saisissez un code promo ou un bon.');
    if (code.length > LONGUEUR_MAX_CODE) {
      throw new BadRequestException(`Le code compte ${LONGUEUR_MAX_CODE} caractères au plus.`);
    }
    const netAmount = Math.max(0, Number(params.netAmount) || 0);

    // 1. Code promo (le moteur de l'app, avec le restaurant en plus).
    let promo: Awaited<ReturnType<PromoCodeService['applyPromoCode']>> | null = null;
    try {
      promo = await this.promoCodeService.applyPromoCode(
        code,
        params.customerId,
        netAmount,
        params.assiette,
        { restaurantId: params.restaurantId ?? undefined, ignorerCommandeId: params.ignorerCommandeId ?? undefined },
      );
    } catch (e) {
      const introuvable = e instanceof HttpException && e.getStatus() === HttpStatus.NOT_FOUND;
      if (!introuvable) {
        if (e instanceof HttpException) {
          throw new HttpException(reformulerRefusCodePromo(e.message), e.getStatus());
        }
        throw e;
      }
    }

    if (promo) {
      const remise = arrondirRemise(promo.discountAmount, netAmount);
      if (remise <= 0) throw new BadRequestException(MESSAGE_SANS_REDUCTION);
      const p = promo.promoCode;
      return {
        type: 'PROMO_CODE',
        code: p.code,
        remise,
        libelle: libelleCodePromo(p),
        codePromo: {
          id: p.id,
          discount_type: p.discount_type,
          discount_value: p.discount_value,
          max_discount_amount: p.max_discount_amount ?? null,
          min_order_amount: p.min_order_amount ?? null,
          target_type: p.target_type,
          expiration_date: p.expiration_date ?? null,
        },
      };
    }

    // 2. Bon d'achat : toujours nominatif, sans minimum ni restaurant.
    const bon = await this.prisma.voucher.findUnique({ where: { code } });
    if (!bon || bon.entity_status === EntityStatus.DELETED) {
      throw new NotFoundException(MESSAGE_AUCUN_COUPON);
    }
    if (bon.customer_id !== params.customerId) {
      throw new ForbiddenException('Ce bon appartient à un autre client.');
    }
    const refus = motifRefusBon(bon, new Date());
    if (refus) throw new BadRequestException(refus);

    // Le bon couvre au plus les articles : jamais la livraison ni la taxe. Et
    // jamais plus que son solde, même arrondi (les soldes sont à virgule).
    const plafond = Math.min(netAmount, bon.remaining_amount);
    const remise = arrondirRemise(plafond, plafond);
    if (remise <= 0) throw new BadRequestException(MESSAGE_SANS_REDUCTION);
    return {
      type: 'VOUCHER',
      code: bon.code,
      remise,
      libelle: LIBELLE_BON,
      bon: {
        id: bon.id,
        solde: arrondirSolde(bon.remaining_amount),
        solde_apres: arrondirSolde(bon.remaining_amount - remise),
        expire_le: bon.expires_at ?? null,
      },
    };
  }

  /* ================================================================
     APERÇU (aucune écriture)
  ================================================================ */

  async apercu(user: User, dto: ApercuCouponDto) {
    this.assertRestaurantDuCompte(user, dto.restaurant_id);

    // Mêmes fonctions, dans le même ordre, que OrderService.create.
    const client = await this.orderHelper.resolveCustomerData({
      customer_id: dto.customer_id,
    } as CreateOrderDto);

    const restaurant = await this.prisma.restaurant.findFirst({
      where: { id: dto.restaurant_id, entity_status: EntityStatus.ACTIVE },
      select: { id: true },
    });
    if (!restaurant) throw new BadRequestException('Restaurant introuvable.');

    const plats = await this.orderHelper.getDishesWithDetails(dto.items.map((i) => i.dish_id));
    const { orderItems, netAmount } = await this.orderHelper.calculateOrderDetails(dto.items, plats, {
      orderType: dto.type,
    });

    // Remplacement sur une commande en modification : seulement si elle est
    // bien celle du client et porte un coupon (sinon rien n'est ignoré).
    let ignorerCommandeId: string | undefined;
    if (dto.commande_id) {
      const commande = await this.prisma.order.findFirst({
        where: { id: dto.commande_id, customer_id: client.customer_id },
        select: { id: true, code_promo: true },
      });
      if (commande?.code_promo) ignorerCommandeId = commande.id;
    }

    const coupon = await this.resoudre({
      code: dto.code,
      customerId: client.customer_id,
      netAmount,
      assiette: assietteDesRemises(orderItems),
      restaurantId: restaurant.id,
      ignorerCommandeId,
    });
    return this.versReponse(coupon, netAmount);
  }

  /** Réponse de l'aperçu, dans la forme exacte que lit l'écran. */
  versReponse(coupon: CouponResolu, netAmount: number) {
    const commun = {
      type: coupon.type,
      code: coupon.code,
      remise: coupon.remise,
      sous_total: netAmount,
      total_articles_apres_remise: Math.max(0, netAmount - coupon.remise),
      libelle: coupon.libelle,
    };
    if (coupon.type === 'VOUCHER' && coupon.bon) {
      return {
        ...commun,
        bon: {
          solde: coupon.bon.solde,
          solde_apres: coupon.bon.solde_apres,
          expire_le: coupon.bon.expire_le,
        },
      };
    }
    const p = coupon.codePromo!;
    return {
      ...commun,
      code_promo: {
        discount_type: p.discount_type,
        discount_value: p.discount_value,
        max_discount_amount: p.max_discount_amount,
        min_order_amount: p.min_order_amount,
        target_type: p.target_type,
        expiration_date: p.expiration_date,
      },
    };
  }

  /* ================================================================
     BONS DU CLIENT (code masqué)
  ================================================================ */

  async listerBonsClient(user: User, customerId: string) {
    void user; // Les bons ne dépendent pas du restaurant : nominatifs, valables partout.
    const maintenant = new Date();
    const bons = await this.prisma.voucher.findMany({
      where: {
        customer_id: customerId,
        status: VoucherStatus.ACTIVE,
        entity_status: { not: EntityStatus.DELETED },
        remaining_amount: { gte: 1 },
        OR: [{ expires_at: null }, { expires_at: { gt: maintenant } }],
      },
      orderBy: [{ expires_at: { sort: 'asc', nulls: 'last' } }, { created_at: 'asc' }],
      take: 20,
      select: { id: true, code: true, remaining_amount: true, initial_amount: true, expires_at: true },
    });
    return {
      data: bons.map((b) => ({
        id: b.id,
        // Jamais le code complet : le client le dicte (décision du 25/09).
        code_masque: masquerCode(b.code),
        solde: arrondirSolde(b.remaining_amount),
        montant_initial: arrondirSolde(b.initial_amount),
        expire_le: b.expires_at ?? null,
      })),
    };
  }

  /* ================================================================
     CONSOMMATION (dans la transaction de création)
  ================================================================ */

  /**
   * `compter` (vrai par défaut) : l'usage d'un code promo est compté tout de
   * suite (usage ACTIVE, compteur +1), comme pour une commande du personnel qui
   * naît acceptée. Faux pour une commande encore EN ATTENTE : l'usage est
   * préparé (INACTIVE) et compté à l'acceptation par `activateUsageForOrder`,
   * comme le code d'un panier de l'application. Un bon est débité dans les
   * deux cas : l'annulation le rend.
   */
  async consommer(
    tx: Transaction,
    params: {
      coupon: CouponResolu;
      orderId: string;
      customerId: string;
      restaurantId?: string | null;
      compter?: boolean;
    },
  ): Promise<ConsommationCoupon> {
    const { coupon, orderId, customerId } = params;
    const compter = params.compter !== false;
    const remise = coupon.remise;
    if (!(remise > 0)) throw new BadRequestException(MESSAGE_SANS_REDUCTION);

    if (coupon.type === 'PROMO_CODE') {
      const id = coupon.codePromo!.id;
      // Verrou de ligne : deux commandes avec le même code passent l'une après
      // l'autre, et la seconde voit l'usage de la première.
      await tx.$queryRaw`SELECT id FROM "PromoCode" WHERE id = ${id}::uuid FOR UPDATE`;
      const refus = await this.refusCodePromo(tx, id, customerId, params.restaurantId);
      if (refus) throw new BadRequestException(refus);
      // ACTIVE d'emblée : la commande du personnel naît ACCEPTED. Montant EXACT
      // du coupon (le repli de activateUsageForOrder prenait la remise totale).
      const usage = await tx.promoCodeUsage.create({
        data: {
          promo_code_id: id,
          customer_id: customerId,
          order_id: orderId,
          discount_amount: remise,
          status: compter ? PromoCodeUsageStatus.ACTIVE : PromoCodeUsageStatus.INACTIVE,
        },
      });
      if (compter) {
        await tx.promoCode.update({ where: { id }, data: { usage_count: { increment: 1 } } });
      }
      return { type: 'PROMO_CODE', code: coupon.code, remise, promoCodeId: id, usageId: usage.id };
    }

    // Bon : débit CONDITIONNÉ, atomique. Si un autre débit est passé entre
    // l'aperçu et maintenant, la condition ne tient plus et rien n'est écrit.
    const bonId = coupon.bon!.id;
    const maintenant = new Date();
    const debit = await tx.voucher.updateMany({
      where: {
        id: bonId,
        customer_id: customerId,
        status: VoucherStatus.ACTIVE,
        entity_status: { not: EntityStatus.DELETED },
        remaining_amount: { gte: remise },
        OR: [{ expires_at: null }, { expires_at: { gt: maintenant } }],
      },
      data: { remaining_amount: { decrement: remise }, updated_at: maintenant },
    });
    if (debit.count === 0) throw new BadRequestException(ERREUR_SOLDE_CHANGE);

    // Moins d'un franc restant : le bon est épuisé.
    await tx.voucher.updateMany({
      where: { id: bonId, status: VoucherStatus.ACTIVE, remaining_amount: { lt: 1 } },
      data: { status: VoucherStatus.REDEEMED, redeemed_at: maintenant },
    });
    const redemption = await tx.redemption.create({
      data: { voucher_id: bonId, order_id: orderId, amount: remise },
    });
    const apres = await tx.voucher.findUnique({
      where: { id: bonId },
      select: { remaining_amount: true },
    });
    return {
      type: 'VOUCHER',
      code: coupon.code,
      remise,
      bonId,
      redemptionId: redemption.id,
      soldeApres: arrondirSolde(apres?.remaining_amount ?? 0),
    };
  }

  /**
   * Pourquoi un code promo ne peut plus être compté pour ce client, ou null.
   * À appeler sous le verrou de ligne du code (`FOR UPDATE`) : la seconde de
   * deux commandes simultanées voit l'usage de la première.
   */
  private async refusCodePromo(
    tx: Transaction,
    id: string,
    customerId: string,
    restaurantId?: string | null,
  ): Promise<string | null> {
    const promo = await tx.promoCode.findUnique({ where: { id } });
    const maintenant = new Date();
    if (!promo || promo.entity_status === EntityStatus.DELETED || !promo.is_active) {
      return "Ce code promo n'est plus actif.";
    }
    if (maintenant < promo.start_date) return "Ce code promo n'est pas encore valide.";
    if (maintenant > promo.expiration_date) return 'Ce code promo a expiré.';
    if (restaurantId && (promo.restaurant_ids?.length ?? 0) > 0 && !promo.restaurant_ids.includes(restaurantId)) {
      return "Ce code promo n'est pas valable dans ce restaurant.";
    }
    if (promo.max_usage && promo.usage_count >= promo.max_usage) {
      return "Ce code promo a atteint son nombre maximum d'utilisations.";
    }
    if (promo.max_usage_per_user) {
      const dejaUtilise = await tx.promoCodeUsage.count({
        where: { promo_code_id: id, customer_id: customerId, status: PromoCodeUsageStatus.ACTIVE },
      });
      if (dejaUtilise >= promo.max_usage_per_user) {
        return 'Ce client a déjà utilisé ce code promo le nombre maximum de fois.';
      }
    }
    return null;
  }

  /**
   * Après la création (transaction validée) : journal d'audit avec l'agent,
   * notification au client pour un bon, rafraîchissement des écrans. Ne lève
   * jamais : la commande est enregistrée.
   */
  signalerUsage(params: {
    order: { id: string; reference?: string | null; customer_id: string; restaurant_id?: string | null };
    consommation: ConsommationCoupon;
    acteur?: Pick<User, 'id' | 'fullname' | 'email' | 'role' | 'restaurant_id'> | null;
    /** Absente : la création (`POST /orders/create`). Modification : `PATCH /orders/:id`. */
    requete?: RequeteCoupon;
  }): void {
    const { order, consommation: c, acteur } = params;
    const requete = params.requete ?? { methode: 'POST', chemin: '/orders/create', statut: 201 };
    try {
      const nature = c.type === 'VOUCHER' ? 'Bon' : 'Code promo';
      const ou = requete.methode === 'PATCH' ? 'sur la commande modifiée' : 'sur la commande';
      this.auditService.record({
        actor_id: acteur?.id ?? null,
        actor_name: acteur?.fullname ?? acteur?.email ?? null,
        actor_role: acteur?.role ?? null,
        restaurant_id: order.restaurant_id ?? null,
        action: 'COUPON_APPLIQUE',
        module: 'orders',
        entity_id: order.id,
        method: requete.methode,
        path: requete.chemin,
        status_code: requete.statut,
        summary: `${nature} ${c.code} appliqué ${ou} ${order.reference ?? order.id} : réduction de ${formaterFrancs(c.remise)} F`,
        metadata: {
          code: c.code,
          type: c.type,
          remise: c.remise,
          customer_id: order.customer_id,
          ...(c.type === 'VOUCHER' ? { solde_apres: c.soldeApres ?? null } : { promo_code_id: c.promoCodeId ?? null }),
        },
      });
    } catch (e: any) {
      this.logger.warn(`Audit COUPON_APPLIQUE non écrit : ${e?.message}`);
    }

    if (c.type === 'VOUCHER' && c.bonId) {
      void this.voucherService.notifierMouvementBon({
        customerId: order.customer_id,
        code: c.code,
        sens: 'DEBIT',
        montant: c.remise,
        solde: c.soldeApres ?? 0,
        reference: order.reference ?? null,
      });
      void this.voucherService.diffuserBon(c.bonId, 'voucher:redeemed');
    } else if (c.type === 'PROMO_CODE' && c.promoCodeId) {
      try {
        this.appGateway.emitToBackoffice('promo_code:usage_recorded', {
          promoCodeId: c.promoCodeId,
          orderId: order.id,
        });
      } catch (e: any) {
        this.logger.warn(`Diffusion de l'usage du code ${c.code} impossible : ${e?.message}`);
      }
    }
  }

  /* ================================================================
     RESTITUTION (annulation, suppression)
  ================================================================ */

  /**
   * Rend ce qu'une commande avait consommé : solde des bons (prolongé de 30
   * jours s'il a expiré entre-temps) et usages des codes promo. Pour toutes les
   * commandes, application comprise. Idempotent : chaque utilisation est
   * réservée par une écriture conditionnée avant d'être rendue, un second appel
   * ne rend rien.
   *
   * Chaque étape est isolée : l'échec de l'une n'empêche pas l'autre, et rien
   * ne remonte à l'appelant (le statut de la commande est déjà enregistré).
   */
  async restituerPourCommande(
    commande: { id: string; reference?: string | null; customer_id?: string | null; restaurant_id?: string | null },
    contexte: ContexteRestitution,
  ): Promise<RestitutionCoupon> {
    const resultat: RestitutionCoupon = { bons: [], codesPromo: [] };

    // 1. Bons d'achat.
    try {
      const lignes = await this.prisma.redemption.findMany({
        where: { order_id: commande.id, entity_status: EntityStatus.ACTIVE },
        select: { id: true, voucher_id: true, amount: true },
      });
      for (const ligne of lignes) {
        try {
          const rendu = await this.prisma.$transaction((tx) => this.rendreUneUtilisation(tx, ligne));
          if (rendu) resultat.bons.push(rendu);
        } catch (e: any) {
          this.logger.error(
            `Restitution du bon (utilisation ${ligne.id}) échouée pour la commande ${commande.reference ?? commande.id} : ${e?.message}`,
          );
        }
      }
    } catch (e: any) {
      this.logger.error(`Lecture des bons de la commande ${commande.id} impossible : ${e?.message}`);
    }

    // 2. Codes promo : l'usage repasse INACTIVE et le compteur baisse.
    try {
      const usages = await this.promoCodeService.deactivateUsageForOrder(commande.id);
      resultat.codesPromo = (usages ?? []).map((u) => ({
        promoCodeId: u.promo_code_id,
        code: u.code,
        montant: u.discount_amount,
      }));
    } catch (e: any) {
      this.logger.error(`Décompte du code promo échoué pour la commande ${commande.id} : ${e?.message}`);
    }

    if (resultat.bons.length > 0 || resultat.codesPromo.length > 0) {
      await this.signalerRestitution(commande, contexte, resultat);
    }
    return resultat;
  }

  /** Une utilisation de bon, dans sa propre transaction. Null si déjà rendue. */
  private async rendreUneUtilisation(
    tx: Transaction,
    ligne: { id: string; voucher_id: string; amount: number },
  ): Promise<BonRestitue | null> {
    // Réservation : une seule restitution par utilisation, même rejouée.
    const reserve = await tx.redemption.updateMany({
      where: { id: ligne.id, entity_status: EntityStatus.ACTIVE },
      data: { entity_status: EntityStatus.DELETED },
    });
    if (reserve.count === 0) return null;

    const bon = await tx.voucher.findUnique({ where: { id: ligne.voucher_id } });
    if (!bon) return null;

    const maintenant = new Date();
    // Annulé ou supprimé par un administrateur : on rend le solde (la
    // comptabilité reste juste) sans rendre le bon utilisable.
    const inutilisable =
      bon.status === VoucherStatus.CANCELLED || bon.entity_status === EntityStatus.DELETED;
    const expire = !!bon.expires_at && new Date(bon.expires_at).getTime() <= maintenant.getTime();
    const prolonge = expire && !inutilisable;

    const maj = await tx.voucher.update({
      where: { id: bon.id },
      data: {
        remaining_amount: { increment: ligne.amount },
        updated_at: maintenant,
        ...(inutilisable ? {} : { status: VoucherStatus.ACTIVE, redeemed_at: null }),
        ...(prolonge ? { expires_at: addDays(maintenant, JOURS_PROLONGATION_BON) } : {}),
      },
    });

    return {
      bonId: bon.id,
      code: bon.code,
      customerId: bon.customer_id,
      montant: ligne.amount,
      solde: arrondirSolde(maj.remaining_amount),
      prolonge,
      expireLe: maj.expires_at ?? null,
      inutilisable,
    };
  }

  private async signalerRestitution(
    commande: { id: string; reference?: string | null; customer_id?: string | null; restaurant_id?: string | null },
    contexte: ContexteRestitution,
    resultat: RestitutionCoupon,
  ): Promise<void> {
    // Auteur : un membre du personnel (rôle connu) ou le client lui-même.
    let acteur: { id: string; fullname: string; email: string; role: string } | null = null;
    if (contexte.acteurId && contexte.acteurRole) {
      acteur = await this.prisma.user
        .findUnique({
          where: { id: contexte.acteurId },
          select: { id: true, fullname: true, email: true, role: true },
        })
        .catch(() => null);
    }
    const parLeClient = !contexte.acteurRole && !!contexte.acteurId && !contexte.origine;
    const ref = commande.reference ?? commande.id;
    // Fin du résumé : « commande CMD annulée », « commande CMD supprimée », ou
    // « coupon retiré de la commande CMD » (la commande continue).
    const evenement =
      contexte.motif === 'RETRAIT'
        ? `coupon retiré de la commande ${ref}`
        : `commande ${ref} ${contexte.motif === 'SUPPRESSION' ? 'supprimée' : 'annulée'}`;
    const chemin =
      contexte.origine?.chemin ??
      (contexte.motif === 'ANNULATION' ? `/orders/${commande.id}/status` : `/orders/${commande.id}`);
    const methode = contexte.origine?.methode ?? (contexte.motif === 'SUPPRESSION' ? 'DELETE' : 'PATCH');
    const complement = parLeClient
      ? ' (par le client)'
      : contexte.origine
        ? ` (${contexte.origine.precision})`
        : '';

    const ecrire = (summary: string, metadata: Prisma.InputJsonValue) => {
      try {
        this.auditService.record({
          actor_id: acteur?.id ?? null,
          actor_name: acteur?.fullname ?? acteur?.email ?? null,
          actor_role: acteur?.role ?? null,
          restaurant_id: commande.restaurant_id ?? null,
          action: 'COUPON_RESTITUE',
          module: 'orders',
          entity_id: commande.id,
          method: methode,
          path: chemin,
          status_code: 200,
          summary: `${summary}${complement}`,
          metadata,
        });
      } catch (e: any) {
        this.logger.warn(`Audit COUPON_RESTITUE non écrit : ${e?.message}`);
      }
    };

    for (const b of resultat.bons) {
      ecrire(
        `Bon ${b.code} recrédité de ${formaterFrancs(b.montant)} F : ${evenement}`,
        {
          code: b.code,
          type: 'VOUCHER',
          montant: b.montant,
          solde: b.solde,
          prolonge: b.prolonge,
          expire_le: b.expireLe ? b.expireLe.toISOString() : null,
          customer_id: b.customerId,
          motif: contexte.motif,
        },
      );
      if (!b.inutilisable) {
        void this.voucherService.notifierMouvementBon({
          customerId: b.customerId,
          code: b.code,
          sens: 'CREDIT',
          montant: b.montant,
          solde: b.solde,
          reference: commande.reference ?? null,
          motif: contexte.motif,
          valableJusquau: b.prolonge ? b.expireLe : null,
        });
      }
      void this.voucherService.diffuserBon(b.bonId, 'voucher:updated');
    }

    for (const c of resultat.codesPromo) {
      ecrire(
        `Code promo${c.code ? ` ${c.code}` : ''} rendu : ${evenement}`,
        {
          code: c.code,
          type: 'PROMO_CODE',
          montant: c.montant,
          promo_code_id: c.promoCodeId,
          customer_id: commande.customer_id ?? null,
          motif: contexte.motif,
        },
      );
    }
  }

  /* ================================================================
     RETRAIT DU COUPON D'UNE COMMANDE MODIFIÉE (02/10)
  ================================================================ */

  /**
   * Rend le coupon d'une commande que le personnel MODIFIE, DANS la
   * transaction de la modification : si elle échoue (nouveau coupon refusé,
   * commande changée entre-temps), rien n'est rendu.
   *
   *  - Bons : chaque utilisation active est rendue (`rendreUneUtilisation`,
   *    solde recrédité, prolongé de 30 jours s'il a expiré).
   *  - Code promo compté (usage ACTIVE) : l'usage repasse INACTIVE et le
   *    compteur baisse, comme `deactivateUsageForOrder`, mais sur `tx`.
   *  - Usage seulement PRÉPARÉ (INACTIVE, commande encore en attente) : effacé.
   *    Laissé en place, l'acceptation le compterait (`activateUsageForOrder`
   *    prend le premier usage de la commande) pour un code qu'elle n'a plus,
   *    ou à la place du coupon qui le remplace.
   *
   * `remise` : ce que le coupon pesait dans `Order.discount`, d'après ses
   * traces (utilisations rendues, usage), sinon la remise entière de la
   * commande. L'appelant la retire du total. Les notifications et le journal
   * partent après la validation (`signalerRetrait`).
   */
  async retirerDansTransaction(
    tx: Transaction,
    commande: { id: string; discount?: number | null },
  ): Promise<RetraitCoupon> {
    const restitution: RestitutionCoupon = { bons: [], codesPromo: [] };
    let remise = 0;

    const lignes = await tx.redemption.findMany({
      where: { order_id: commande.id, entity_status: EntityStatus.ACTIVE },
      select: { id: true, voucher_id: true, amount: true },
    });
    for (const ligne of lignes) {
      const rendu = await this.rendreUneUtilisation(tx, ligne);
      if (!rendu) continue;
      restitution.bons.push(rendu);
      remise += ligne.amount;
    }

    const usages = await tx.promoCodeUsage.findMany({
      where: { order_id: commande.id },
      orderBy: { created_at: 'desc' },
      include: { promo_code: { select: { code: true } } },
    });
    for (const u of usages) {
      if (u.status !== PromoCodeUsageStatus.ACTIVE) continue;
      const reserve = await tx.promoCodeUsage.updateMany({
        where: { id: u.id, status: PromoCodeUsageStatus.ACTIVE },
        data: { status: PromoCodeUsageStatus.INACTIVE },
      });
      if (reserve.count === 0) continue;
      await tx.promoCode.updateMany({
        where: { id: u.promo_code_id, usage_count: { gt: 0 } },
        data: { usage_count: { decrement: 1 } },
      });
      restitution.codesPromo.push({ promoCodeId: u.promo_code_id, code: u.promo_code?.code ?? null, montant: u.discount_amount });
      remise += u.discount_amount;
    }
    if (remise <= 0 && usages.length > 0) {
      // Usage préparé, jamais compté : sa remise est bien dans le total.
      remise = usages[0].discount_amount;
    }
    // Toute trace de code promo de cette commande disparaît : les usages rendus
    // comme les usages préparés (voir ci-dessus). Les utilisations de bons
    // rendues restent, marquées supprimées, comme à l'annulation.
    if (usages.length > 0) {
      await tx.promoCodeUsage.deleteMany({ where: { order_id: commande.id } });
    }

    if (remise <= 0) remise = Math.max(0, Number(commande.discount) || 0);
    return { restitution, remise };
  }

  /**
   * Après la modification (transaction validée) : journal COUPON_RESTITUE
   * (motif RETRAIT), mouvement du bon notifié au client, écrans rafraîchis.
   * Ne lève jamais.
   */
  async signalerRetrait(params: {
    order: { id: string; reference?: string | null; customer_id?: string | null; restaurant_id?: string | null };
    retrait: RetraitCoupon;
    acteur?: Pick<User, 'id' | 'role'> | null;
  }): Promise<void> {
    const { order, retrait, acteur } = params;
    const { restitution } = retrait;
    if (restitution.bons.length === 0 && restitution.codesPromo.length === 0) return;
    try {
      await this.signalerRestitution(
        order,
        { motif: 'RETRAIT', acteurId: acteur?.id ?? null, acteurRole: acteur?.role ?? null },
        restitution,
      );
      for (const c of restitution.codesPromo) {
        this.appGateway.emitToBackoffice('promo_code:usage_reverted', { promoCodeId: c.promoCodeId, orderId: order.id });
      }
    } catch (e: any) {
      this.logger.warn(`Signalement du retrait du coupon de ${order.id} impossible : ${e?.message}`);
    }
  }

  /**
   * Qui change le coupon d'une commande : les rôles qui ont COMMANDES CREATE
   * (ADMIN, CALL_CENTER, CAISSIER), ceux qui l'appliquent à la création. La
   * route de modification n'exige que UPDATE_FULL (un gestionnaire l'a) : le
   * droit se vérifie donc ici, dans la même table que la garde des routes.
   */
  assertPeutChangerCoupon(user?: Pick<User, 'role'> | null): void {
    const droits = user?.role ? permissionsByRole[user.role as UserRole] : undefined;
    const actions = droits?.modules[Modules.COMMANDES] ?? droits?.modules[Modules.ALL] ?? [];
    const exclu = droits?.exclusions?.includes(Modules.COMMANDES) ?? false;
    if (!droits || exclu || !actions.includes(Action.CREATE)) {
      throw new ForbiddenException(MESSAGE_DROIT_COUPON);
    }
  }

  /* ================================================================
     RÉACTIVATION D'UN PANIER ANNULÉ PAR LE CLIENT
  ================================================================ */

  /**
   * Le coupon d'un panier annulé par le client, de nouveau consommé à sa
   * réactivation (`OrderService.update`), DANS la transaction qui la
   * revendique : si celle-ci échoue, rien n'est débité.
   *
   * L'annulation a rendu le bon (solde recrédité, prolongé de 30 jours s'il
   * avait expiré) ; le code promo d'un panier de l'application, lui, n'a
   * jamais été compté (usage préparé INACTIVE, compté à l'acceptation). La
   * réactivation accepte la commande : le coupon doit être consommé de
   * nouveau, avec les mêmes contrôles qu'à la prise de commande, sous le
   * verrou de sa ligne.
   *
   *  - Bon : lignes verrouillées (`FOR UPDATE`), contrôlées, puis débitées ;
   *    une nouvelle utilisation est écrite (l'ancienne reste rendue).
   *  - Code promo : verrou du code, contrôles de `refusCodePromo`, puis
   *    l'usage passe ACTIVE (ou est créé) et le compteur monte.
   *  - Toujours consommé (jamais rendu) : rien à faire, la remise reste.
   *
   * Tout ou rien : si le coupon ne peut plus l'être (bon réutilisé ou épuisé,
   * expiré, code promo à bout), rien n'est écrit et `consomme` vaut faux ;
   * l'appelant retire alors la remise du total. Jamais de remise sans coupon
   * consommé, jamais de double usage. Null : la commande n'avait aucun coupon.
   */
  async reconsommerALaReactivation(
    tx: Transaction,
    commande: {
      id: string;
      customer_id: string;
      restaurant_id?: string | null;
      code_promo?: string | null;
      discount?: number | null;
      points?: number | null;
      promotion_id?: string | null;
    },
  ): Promise<ReconsommationCoupon | null> {
    const maintenant = new Date();
    const remiseCommande = Math.max(0, Number(commande.discount) || 0);

    // 1. Bon d'achat, d'après ses utilisations sur cette commande.
    const utilisations = await tx.redemption.findMany({
      where: { order_id: commande.id },
      select: { id: true, voucher_id: true, amount: true, entity_status: true },
    });
    if (utilisations.length > 0) {
      const actives = utilisations.filter((u) => u.entity_status === EntityStatus.ACTIVE);
      if (actives.length > 0) {
        const bon = await tx.voucher.findUnique({ where: { id: actives[0].voucher_id }, select: { code: true } });
        return {
          type: 'VOUCHER',
          code: bon?.code ?? commande.code_promo ?? null,
          remise: actives.reduce((t, u) => t + u.amount, 0),
          consomme: true,
          deja_consomme: true,
        };
      }
      const parBon = new Map<string, number>();
      for (const u of utilisations) parBon.set(u.voucher_id, (parBon.get(u.voucher_id) ?? 0) + u.amount);
      return this.redebiterBons(tx, commande, parBon, maintenant);
    }

    // 2. Code promo, d'après ses usages sur cette commande.
    const usages = await tx.promoCodeUsage.findMany({
      where: { order_id: commande.id },
      orderBy: { created_at: 'desc' },
      include: { promo_code: { select: { code: true } } },
    });
    if (usages.length > 0) {
      const active = usages.find((u) => u.status === PromoCodeUsageStatus.ACTIVE);
      if (active) {
        return {
          type: 'PROMO_CODE',
          code: active.promo_code?.code ?? commande.code_promo ?? null,
          remise: active.discount_amount,
          consomme: true,
          deja_consomme: true,
        };
      }
      const usage = usages[0];
      return this.recompterCodePromo(tx, commande, {
        promoCodeId: usage.promo_code_id,
        code: usage.promo_code?.code ?? commande.code_promo ?? '',
        remise: usage.discount_amount,
        usageId: usage.id,
      });
    }

    // 3. Aucune trace (l'écriture de l'usage avait échoué à la création) :
    // le code porté par la commande, s'il donnait une remise.
    const code = (commande.code_promo ?? '').trim();
    if (!code || remiseCommande <= 0) return null;
    // La remise mêle aussi des points ou une promotion : la part du code ne se
    // retrouve pas, et la retirer entière priverait le client de ses points.
    // Rien n'est touché ; l'acceptation compte l'usage comme avant
    // (`activateUsageForOrder`). Cas sans trace : antérieur au 25/09, hors de
    // la fenêtre de relance en pratique.
    if ((Number(commande.points) || 0) > 0 || commande.promotion_id) {
      this.logger.warn(
        `Réactivation de ${commande.id} : code ${code} sans trace d'usage, remise mêlée à des points ou une promotion, laissée telle quelle.`,
      );
      return null;
    }
    const promo = await tx.promoCode.findFirst({
      where: { code: { equals: code, mode: 'insensitive' } },
      select: { id: true, code: true },
    });
    if (promo) {
      return this.recompterCodePromo(tx, commande, {
        promoCodeId: promo.id,
        code: promo.code,
        remise: remiseCommande,
      });
    }
    const bon = await tx.voucher.findUnique({ where: { code }, select: { id: true } });
    if (bon) return this.redebiterBons(tx, commande, new Map([[bon.id, remiseCommande]]), maintenant);
    return {
      type: null,
      code,
      remise: remiseCommande,
      consomme: false,
      raison: 'Aucun code promo ni bon ne correspond à ce code.',
    };
  }

  /** Débit de nouveau des bons rendus. Tout ou rien, sous verrou de ligne. */
  private async redebiterBons(
    tx: Transaction,
    commande: { id: string; customer_id: string; code_promo?: string | null },
    parBon: Map<string, number>,
    maintenant: Date,
  ): Promise<ReconsommationCoupon> {
    const ids = [...parBon.keys()].sort();
    const remise = [...parBon.values()].reduce((t, v) => t + v, 0);
    // Verrou des lignes, dans un ordre fixe : un débit concurrent attend, et
    // les contrôles qui suivent restent vrais jusqu'à l'écriture.
    for (const id of ids) {
      await tx.$queryRaw`SELECT id FROM "Voucher" WHERE id = ${id}::uuid FOR UPDATE`;
    }
    const bons = await tx.voucher.findMany({ where: { id: { in: ids } } });
    const premier = bons.find((b) => b.id === ids[0]);
    const code = premier?.code ?? commande.code_promo ?? null;

    for (const id of ids) {
      const bon = bons.find((b) => b.id === id);
      const montant = parBon.get(id) ?? 0;
      let raison: string | null = null;
      if (!bon || bon.entity_status === EntityStatus.DELETED) raison = "Ce bon n'existe plus.";
      else if (bon.customer_id !== commande.customer_id) raison = 'Ce bon appartient à un autre client.';
      else raison = motifRefusBon(bon, maintenant);
      if (!raison && bon && bon.remaining_amount + 1e-6 < montant) {
        raison = `Le solde de ce bon (${formaterFrancs(bon.remaining_amount)} F) ne couvre plus la remise.`;
      }
      if (raison) return { type: 'VOUCHER', code, remise, consomme: false, raison };
    }

    let soldeApres = 0;
    for (const id of ids) {
      const montant = parBon.get(id) ?? 0;
      const debit = await tx.voucher.updateMany({
        where: {
          id,
          customer_id: commande.customer_id,
          status: VoucherStatus.ACTIVE,
          entity_status: { not: EntityStatus.DELETED },
          remaining_amount: { gte: montant },
          OR: [{ expires_at: null }, { expires_at: { gt: maintenant } }],
        },
        data: { remaining_amount: { decrement: montant }, updated_at: maintenant },
      });
      // Sous verrou, après les contrôles : ne peut échouer. Si c'était le cas,
      // la transaction entière est annulée, réactivation comprise.
      if (debit.count === 0) throw new ConflictException(ERREUR_SOLDE_CHANGE);
      await tx.voucher.updateMany({
        where: { id, status: VoucherStatus.ACTIVE, remaining_amount: { lt: 1 } },
        data: { status: VoucherStatus.REDEEMED, redeemed_at: maintenant },
      });
      await tx.redemption.create({ data: { voucher_id: id, order_id: commande.id, amount: montant } });
      if (id === ids[0]) {
        const apres = await tx.voucher.findUnique({ where: { id }, select: { remaining_amount: true } });
        soldeApres = arrondirSolde(apres?.remaining_amount ?? 0);
      }
    }
    return { type: 'VOUCHER', code, remise, consomme: true, bonId: ids[0], soldeApres };
  }

  /** Usage du code promo compté de nouveau, ou refus. Sous verrou du code. */
  private async recompterCodePromo(
    tx: Transaction,
    commande: { id: string; customer_id: string; restaurant_id?: string | null },
    params: { promoCodeId: string; code: string; remise: number; usageId?: string },
  ): Promise<ReconsommationCoupon> {
    const { promoCodeId, code, remise, usageId } = params;
    await tx.$queryRaw`SELECT id FROM "PromoCode" WHERE id = ${promoCodeId}::uuid FOR UPDATE`;
    const raison = await this.refusCodePromo(tx, promoCodeId, commande.customer_id, commande.restaurant_id);
    if (raison) return { type: 'PROMO_CODE', code, remise, consomme: false, raison };

    if (usageId) {
      const active = await tx.promoCodeUsage.updateMany({
        where: { id: usageId, status: PromoCodeUsageStatus.INACTIVE },
        data: { status: PromoCodeUsageStatus.ACTIVE },
      });
      // Compté entre-temps par un autre chemin : rien de plus à compter.
      if (active.count === 0) {
        return { type: 'PROMO_CODE', code, remise, consomme: true, deja_consomme: true, promoCodeId };
      }
    } else {
      await tx.promoCodeUsage.create({
        data: {
          promo_code_id: promoCodeId,
          customer_id: commande.customer_id,
          order_id: commande.id,
          discount_amount: remise,
          status: PromoCodeUsageStatus.ACTIVE,
        },
      });
    }
    await tx.promoCode.update({ where: { id: promoCodeId }, data: { usage_count: { increment: 1 } } });
    return { type: 'PROMO_CODE', code, remise, consomme: true, promoCodeId };
  }

  /**
   * Après la réactivation (transaction validée) : journal d'audit, mouvement
   * du bon notifié au client, écrans rafraîchis. Ne lève jamais.
   */
  signalerReactivation(params: {
    order: { id: string; reference?: string | null; customer_id: string; restaurant_id?: string | null };
    coupon: ReconsommationCoupon;
    acteur?: Pick<User, 'id' | 'fullname' | 'email' | 'role'> | null;
  }): void {
    const { order, coupon: c, acteur } = params;
    if (c.deja_consomme) return;
    const nature = c.type === 'VOUCHER' ? 'Bon' : c.type === 'PROMO_CODE' ? 'Code promo' : 'Code';
    const code = c.type === 'VOUCHER' && c.code ? masquerCode(c.code) : (c.code ?? '');
    const ref = order.reference ?? order.id;
    try {
      this.auditService.record({
        actor_id: acteur?.id ?? null,
        actor_name: acteur?.fullname ?? acteur?.email ?? null,
        actor_role: acteur?.role ?? null,
        restaurant_id: order.restaurant_id ?? null,
        action: c.consomme ? 'COUPON_APPLIQUE' : 'COUPON_RETIRE',
        module: 'orders',
        entity_id: order.id,
        method: 'PATCH',
        path: `/orders/${order.id}`,
        status_code: 200,
        summary: c.consomme
          ? `${nature} ${code} de nouveau appliqué : commande ${ref} réactivée, réduction de ${formaterFrancs(c.remise)} F`
          : `${nature} ${code} retiré : commande ${ref} réactivée sans sa réduction de ${formaterFrancs(c.remise)} F. ${c.raison ?? ''}`.trim(),
        metadata: {
          code: c.code,
          type: c.type,
          remise: c.remise,
          consomme: c.consomme,
          raison: c.raison ?? null,
          customer_id: order.customer_id,
          ...(c.type === 'VOUCHER' ? { solde_apres: c.soldeApres ?? null } : { promo_code_id: c.promoCodeId ?? null }),
        },
      });
    } catch (e: any) {
      this.logger.warn(`Audit de la réactivation du coupon non écrit : ${e?.message}`);
    }
    if (!c.consomme) return;
    if (c.type === 'VOUCHER' && c.bonId && c.code) {
      void this.voucherService.notifierMouvementBon({
        customerId: order.customer_id,
        code: c.code,
        sens: 'DEBIT',
        montant: c.remise,
        solde: c.soldeApres ?? 0,
        reference: order.reference ?? null,
      });
      void this.voucherService.diffuserBon(c.bonId, 'voucher:redeemed');
    } else if (c.type === 'PROMO_CODE' && c.promoCodeId) {
      try {
        this.appGateway.emitToBackoffice('promo_code:usage_recorded', { promoCodeId: c.promoCodeId, orderId: order.id });
      } catch (e: any) {
        this.logger.warn(`Diffusion de l'usage du code ${c.code} impossible : ${e?.message}`);
      }
    }
  }

  /* ================================================================
     CLOISONNEMENT
  ================================================================ */

  /**
   * Un compte de point de vente (caissier) n'agit que pour SON restaurant. Le
   * back office (administrateur, centre d'appel) choisit librement.
   */
  assertRestaurantDuCompte(user: User | undefined, restaurantId?: string | null): void {
    if (user?.type !== UserType.RESTAURANT) return;
    if (!user.restaurant_id) {
      throw new ForbiddenException("Votre compte n'est rattaché à aucun restaurant.");
    }
    if (restaurantId && restaurantId !== user.restaurant_id) {
      throw new ForbiddenException(
        'Vous ne pouvez appliquer une réduction que sur une commande de votre restaurant.',
      );
    }
  }
}
