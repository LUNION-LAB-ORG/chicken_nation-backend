import {
  BadRequestException,
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
  UserType,
  VoucherStatus,
} from '@prisma/client';
import { addDays } from 'date-fns';
import { PrismaService } from 'src/database/services/prisma.service';
import { AuditService } from 'src/modules/audit/audit.service';
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

export type MotifRestitution = 'ANNULATION' | 'SUPPRESSION';

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
        { restaurantId: params.restaurantId ?? undefined },
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

    const coupon = await this.resoudre({
      code: dto.code,
      customerId: client.customer_id,
      netAmount,
      assiette: assietteDesRemises(orderItems),
      restaurantId: restaurant.id,
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

  async consommer(
    tx: Transaction,
    params: { coupon: CouponResolu; orderId: string; customerId: string; restaurantId?: string | null },
  ): Promise<ConsommationCoupon> {
    const { coupon, orderId, customerId } = params;
    const remise = coupon.remise;
    if (!(remise > 0)) throw new BadRequestException(MESSAGE_SANS_REDUCTION);

    if (coupon.type === 'PROMO_CODE') {
      const id = coupon.codePromo!.id;
      // Verrou de ligne : deux commandes avec le même code passent l'une après
      // l'autre, et la seconde voit l'usage de la première.
      await tx.$queryRaw`SELECT id FROM "PromoCode" WHERE id = ${id}::uuid FOR UPDATE`;
      const promo = await tx.promoCode.findUnique({ where: { id } });
      const maintenant = new Date();
      if (!promo || promo.entity_status === EntityStatus.DELETED || !promo.is_active) {
        throw new BadRequestException("Ce code promo n'est plus actif.");
      }
      if (maintenant < promo.start_date) {
        throw new BadRequestException("Ce code promo n'est pas encore valide.");
      }
      if (maintenant > promo.expiration_date) {
        throw new BadRequestException('Ce code promo a expiré.');
      }
      if (
        params.restaurantId &&
        (promo.restaurant_ids?.length ?? 0) > 0 &&
        !promo.restaurant_ids.includes(params.restaurantId)
      ) {
        throw new BadRequestException("Ce code promo n'est pas valable dans ce restaurant.");
      }
      if (promo.max_usage && promo.usage_count >= promo.max_usage) {
        throw new BadRequestException("Ce code promo a atteint son nombre maximum d'utilisations.");
      }
      if (promo.max_usage_per_user) {
        const dejaUtilise = await tx.promoCodeUsage.count({
          where: { promo_code_id: id, customer_id: customerId, status: PromoCodeUsageStatus.ACTIVE },
        });
        if (dejaUtilise >= promo.max_usage_per_user) {
          throw new BadRequestException('Ce client a déjà utilisé ce code promo le nombre maximum de fois.');
        }
      }
      // ACTIVE d'emblée : la commande du personnel naît ACCEPTED. Montant EXACT
      // du coupon (le repli de activateUsageForOrder prenait la remise totale).
      const usage = await tx.promoCodeUsage.create({
        data: {
          promo_code_id: id,
          customer_id: customerId,
          order_id: orderId,
          discount_amount: remise,
          status: PromoCodeUsageStatus.ACTIVE,
        },
      });
      await tx.promoCode.update({ where: { id }, data: { usage_count: { increment: 1 } } });
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
   * Après la création (transaction validée) : journal d'audit avec l'agent,
   * notification au client pour un bon, rafraîchissement des écrans. Ne lève
   * jamais : la commande est enregistrée.
   */
  signalerUsage(params: {
    order: { id: string; reference?: string | null; customer_id: string; restaurant_id?: string | null };
    consommation: ConsommationCoupon;
    acteur?: Pick<User, 'id' | 'fullname' | 'email' | 'role' | 'restaurant_id'> | null;
  }): void {
    const { order, consommation: c, acteur } = params;
    try {
      const nature = c.type === 'VOUCHER' ? 'Bon' : 'Code promo';
      this.auditService.record({
        actor_id: acteur?.id ?? null,
        actor_name: acteur?.fullname ?? acteur?.email ?? null,
        actor_role: acteur?.role ?? null,
        restaurant_id: order.restaurant_id ?? null,
        action: 'COUPON_APPLIQUE',
        module: 'orders',
        entity_id: order.id,
        method: 'POST',
        path: '/orders/create',
        status_code: 201,
        summary: `${nature} ${c.code} appliqué sur la commande ${order.reference ?? order.id} : réduction de ${formaterFrancs(c.remise)} F`,
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
    const evenement = contexte.motif === 'SUPPRESSION' ? 'supprimée' : 'annulée';
    const ref = commande.reference ?? commande.id;
    const chemin =
      contexte.origine?.chemin ??
      (contexte.motif === 'SUPPRESSION' ? `/orders/${commande.id}` : `/orders/${commande.id}/status`);
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
        `Bon ${b.code} recrédité de ${formaterFrancs(b.montant)} F : commande ${ref} ${evenement}`,
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
        `Code promo${c.code ? ` ${c.code}` : ''} rendu : commande ${ref} ${evenement}`,
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
