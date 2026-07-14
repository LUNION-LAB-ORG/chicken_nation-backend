import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AddPaiementDto, CreatePaiementDto } from 'src/modules/paiements/dto/create-paiement.dto';
import { UpdatePaiementDto } from 'src/modules/paiements/dto/update-paiement.dto';
import { PrismaService } from 'src/database/services/prisma.service';
import {
  Customer,
  EntityStatus,
  OrderStatus,
  OrderType,
  PaiementMode,
  PaiementStatus,
  PaymentMethod,
} from '@prisma/client';
import { QueryPaiementDto } from 'src/modules/paiements/dto/query-paiement.dto';
import { KkiapayService } from 'src/kkiapay/kkiapay.service';
import { CreatePaiementKkiapayDto } from 'src/modules/paiements/dto/create-paiement-kkiapay.dto';
import type { Request } from 'express';
import { PaiementEvent } from 'src/modules/paiements/events/paiement.event';
import { PromoCodeService } from 'src/modules/promo-code/promo-code.service';

/**
 * Tolérance d'arrondi (FCFA) entre le cumul des paiements SUCCESS et le total de
 * la commande. Absorbe l'écart de taxe app/back (≈ ±50 : l'app arrondit la taxe
 * au plancher de 50, le back au plafond de 10). Au-delà, la commande n'est PAS
 * considérée comme payée (paiement-jeton ou sous-paiement). cf. réconciliation KKiaPay.
 */
const PAYMENT_AMOUNT_TOLERANCE = 50;

@Injectable()
export class PaiementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kkiapay: KkiapayService,
    private readonly paiementEvent: PaiementEvent,
    private readonly promoCodeService: PromoCodeService,
  ) { }

  // Payer avec Kkiapay
  async payWithKkiapay(
    req: Request,
    createPaiementKkiapayDto: CreatePaiementKkiapayDto,
  ) {

    const transaction = await this.kkiapay.verifyTransaction(
      createPaiementKkiapayDto.transactionId,
    );

    const customer = req.user as Customer;

    const result = await this.create({
      reference: transaction.transactionId,
      amount: transaction.amount,
      fees: transaction.fees,
      total: transaction.amount + transaction.fees,
      mode: transaction.source,
      source: transaction.source_common_name,
      client:
        typeof transaction.client === 'object'
          ? JSON.stringify(transaction.client)
          : transaction.client,
      status: transaction.status,
      failure_code: transaction.failureCode,
      failure_message: transaction.failureMessage,
      order_id: createPaiementKkiapayDto?.orderId,
      client_id: customer.id,
    }, { dedupeByReference: true });


    // Mise à jour de la commande à "payée" — UNIQUEMENT si la transaction est
    // SUCCESS ET si le cumul des paiements SUCCESS couvre le total (pas d'acompte
    // sur l'app mobile). Empêche qu'un paiement FAILED (famille Z) ou un paiement-
    // jeton de 50 F (famille B) valide une commande. cf. réconciliation KKiaPay.
    if (result.order) {
      const isSuccess = transaction.status === PaiementStatus.SUCCESS;
      const totalSuccess = isSuccess
        ? await this.sumSuccessPaiements(result.order.id)
        : 0;
      const covered = totalSuccess >= result.order.amount - PAYMENT_AMOUNT_TOLERANCE;
      if (isSuccess && covered) {
        const paymentAt = result.paiement.created_at;
        // TODO(§3a) : unifier ce chemin app-confirm avec linkPaiementToOrder pour qu'il
        // fasse aussi avancer le statut (PENDING → ACCEPTED) et déclenche les effets de
        // bord (points, cloche, push). Aujourd'hui il ne pose QUE paied=true : le statut
        // reste PENDING jusqu'au webhook (dont linkPaiementToOrder claim désormais bien
        // sur status:PENDING) ou au cron de réconciliation. Laissé tel quel volontairement
        // (unifier ici change la valeur de retour de l'endpoint /paiements/pay — risqué).
        await this.prisma.order.updateMany({
          where: { id: result.order.id, paied: false }, // claim atomique anti-rejeu
          data: {
            paied_at: paymentAt,
            paied: true,
            // Paiement différé : ramène la commande "à aujourd'hui" (tri + filtre période)
            ...this.buildPaymentDateAlignment(result.order, paymentAt),
          },
        });
      } else {
        console.warn(
          `[Paiement KKiaPay] Commande ${result.order.reference} laissée NON payée ` +
          `(statut=${transaction.status}, encaissé SUCCESS=${totalSuccess}/${result.order.amount}). ` +
          `Paiement conservé pour audit.`,
        );
      }
    }

    return {
      success: transaction.status === 'SUCCESS',
      message:
        transaction.status === 'SUCCESS'
          ? 'Paiement effectué avec succès'
          : 'Paiement echoué',
      transactionId: transaction.transactionId,
      paiement: result.paiement
      ,
    };
  }
  /**
   * Enregistre un ou plusieurs paiements ajoutés par la caissière depuis le
   * backoffice (liste de modes : CASH / Mobile Money / Carte / Wave…).
   *
   * Cascade sur l'Order :
   *   - `paied_at = now`, `paied = true` dès qu'on a au moins un paiement.
   *   - Si la somme des paiements **SUCCESS** (nouveaux + existants) couvre
   *     le `order.amount` ET que la commande est déjà `COLLECTED` (livrée
   *     mais pas encore encaissée), alors elle passe en `COMPLETED` avec
   *     `completed_at = now`. Une commande partiellement payée reste en
   *     `COLLECTED` (ou son statut initial si pas encore livrée).
   */
  async addPaiement(
    req: Request,
    data: AddPaiementDto,
  ) {
    const { items } = data;
    if (!items || items.length === 0) {
      throw new BadRequestException('Aucun paiement à ajouter');
    }

    // Résoudre toutes les créations en parallèle — le bug précédent utilisait
    // `items.map(async)` sans Promise.all, donc la vérification `length`
    // portait sur un tableau de Promises, et seul paiements[0] était awaited.
    const createdPaiements = await Promise.all(
      items.map(async (item) => {
        const uniqueRef = `PAY-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        return this.create({
          reference: uniqueRef,
          amount: item.amount,
          fees: 0,
          total: item.amount,
          mode: item.mode,
          source: item.source,
          status: PaiementStatus.SUCCESS,
          order_id: item.order_id,
          client_id: item.client_id,
        });
      }),
    );

    const first = createdPaiements.find((r) => r?.order?.id);
    if (!first?.order?.id) {
      return { success: true, message: 'Paiement effectué avec succès' };
    }

    const orderId = first.order.id;
    const now = new Date();

    // Recharger l'order + tous les paiements SUCCESS pour décider si le total
    // est couvert (on ne peut pas se fier uniquement aux `items` entrants car
    // il peut déjà y avoir eu des paiements partiels précédents).
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        paiements: { where: { status: PaiementStatus.SUCCESS } },
      },
    });
    if (!order) {
      return { success: true, message: 'Paiement effectué avec succès' };
    }

    const totalPaid = order.paiements.reduce((sum, p) => sum + (p.total ?? p.amount ?? 0), 0);
    const isFullyPaid = totalPaid >= order.amount;
    const shouldComplete = isFullyPaid && order.status === OrderStatus.COLLECTED;

    const updatedOrder = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        paied_at: now,
        paied: true,
        ...(shouldComplete && {
          status: OrderStatus.COMPLETED,
          completed_at: now,
        }),
      },
    });

    // Paiement (backoffice) confirmé → comptabiliser l'usage du code promo.
    // Idempotent (no-op si déjà ACTIVE) ; isolé.
    try {
      await this.promoCodeService.activateUsageForOrder(updatedOrder);
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      console.error(`Sync usage promo (addPaiement) échoué pour ${orderId}: ${(e as any)?.message}`);
    }

    return {
      success: true,
      message: 'Paiement effectué avec succès',
    };
  }

  /**
   * Aligne `created_at` sur l'instant du PAIEMENT lorsqu'une commande encore NON
   * payée est payée (paiement différé : créée un jour, payée un autre). La commande
   * remonte ainsi en tête de liste et tombe dans la bonne période de filtrage, car
   * tout le tri/filtrage des commandes s'appuie sur `created_at`.
   *
   * L'instant de soumission initiale est préservé dans `submitted_at` (jamais écrasé).
   * Renvoie un patch VIDE si la commande était déjà payée → idempotent (le webhook
   * KKiaPay et le retour de l'app peuvent tirer plusieurs fois pour la même transaction).
   */
  private buildPaymentDateAlignment(
    order: { paied: boolean; created_at: Date; submitted_at: Date | null },
    paymentAt: Date,
  ): { created_at?: Date; submitted_at?: Date } {
    if (order.paied) return {};
    return {
      submitted_at: order.submitted_at ?? order.created_at,
      created_at: paymentAt,
    };
  }

  // Lier un paiement à une commande
  async linkPaiementToOrder(
    data: CreatePaiementKkiapayDto & { customer_id: string },
  ) {

    const transaction = await this.kkiapay.verifyTransaction(
      data.transactionId,
    );

    const result = await this.create({
      reference: transaction.transactionId,
      amount: transaction.amount,
      fees: transaction.fees,
      total: transaction.amount + transaction.fees,
      mode: transaction.source,
      source: transaction.source_common_name,
      client:
        typeof transaction.client === 'object'
          ? JSON.stringify(transaction.client)
          : transaction.client,
      status: transaction.status,
      failure_code: transaction.failureCode,
      failure_message: transaction.failureMessage,
      order_id: data.orderId,
      client_id: data.customer_id,
    }, { dedupeByReference: true });

    // Mise a jour de la commande à payée — CLAIM ATOMIQUE sur la TRANSITION de statut
    // PENDING → ACCEPTED (et non plus sur paied:false). Raisons (§3a) :
    //   • Une commande confirmée d'abord côté app (payWithKkiapay pose paied=true SANS
    //     changer le statut) reste PENDING : gater sur paied:false la « bloquait » alors
    //     qu'elle doit encore avancer. Gater sur status:PENDING la fait bien avancer.
    //   • Un rejeu / double backend / commande déjà avancée (≠ PENDING) → count=0 →
    //     justPaid=false → aucun effet de bord one-time en double, aucune régression.
    // `isPaid` (SUCCESS ET couvert) remonte séparément de justPaid : le listener rejoue
    // les effets IDEMPOTENTS (points, parrainage) même sur retry (justPaid=false), et ne
    // garde derrière justPaid que les effets STRICTEMENT one-time (cloche, push, WS).
    let justPaid = false;
    let isPaid = false;
    // Motif lisible d'un paiement NON abouti — remonté à l'appelant (confirmation
    // manuelle admin) pour un 4xx explicite. `undefined` si isPaid=true.
    let notPaidReason: string | undefined;
    if (result.order) {
      // Ne confirmer la commande QUE si la transaction est SUCCESS ET si le cumul
      // des paiements SUCCESS couvre le total (pas d'acompte app). Bloque les
      // paiements FAILED (Z) et les paiements-jetons (B). cf. réconciliation KKiaPay.
      const isSuccess = transaction.status === PaiementStatus.SUCCESS;
      const totalSuccess = isSuccess
        ? await this.sumSuccessPaiements(result.order.id)
        : 0;
      const covered = totalSuccess >= result.order.amount - PAYMENT_AMOUNT_TOLERANCE;
      isPaid = isSuccess && covered;
      if (!isPaid) {
        notPaidReason = !isSuccess ? 'KKiaPay: statut non SUCCESS' : 'montant non couvert';
      }
      if (isPaid) {
        const next_status = this.getOrderStatus(result.order.payment_method!, result.order.type, result.order.status);
        const paymentAt = result.paiement.created_at;
        const claim = await this.prisma.order.updateMany({
          where: { id: result.order.id, status: OrderStatus.PENDING }, // claim la transition, pas paied
          data: {
            paied_at: paymentAt,
            paied: true,
            status: next_status,
            ...(next_status == OrderStatus.ACCEPTED && { accepted_at: new Date() }),
            // Paiement différé : ramène la commande "à aujourd'hui" (tri + filtre période)
            ...this.buildPaymentDateAlignment(result.order, paymentAt),
          },
        });
        justPaid = claim.count === 1;

        // Paiement confirmé (1re fois) → comptabiliser l'usage du code promo (usage_count++).
        // Isolé pour ne jamais casser la confirmation du paiement.
        if (justPaid && next_status === OrderStatus.ACCEPTED) {
          try {
            const updatedOrder = await this.prisma.order.findUnique({ where: { id: result.order.id } });
            if (updatedOrder) await this.promoCodeService.activateUsageForOrder(updatedOrder);
          } catch (e) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            console.error(`Sync usage promo (paiement KKiaPay) échoué pour ${result.order.id}: ${(e as any)?.message}`);
          }
        }
      } else {
        console.warn(
          `[Paiement KKiaPay] Commande ${result.order.reference} laissée NON payée ` +
          `(statut=${transaction.status}, encaissé SUCCESS=${totalSuccess}/${result.order.amount}).`,
        );
      }
    }

    return { paiement: result.paiement, justPaid, isPaid, notPaidReason };
  }

  // Récupération des paiements succès libres
  async getFreePaiements(req: Request) {
    const customer = req.user as Customer;
    let paiements = await this.prisma.paiement.findMany({
      where: {
        status: PaiementStatus.SUCCESS,
        order_id: null,
        client_id: customer.id,
      },
      orderBy: {
        created_at: 'desc',
      },
    });

    if (paiements.length === 0) {
      paiements = paiements.filter((p) => {
        const client = JSON.parse(
          typeof p?.client == 'string' ? p.client : '{}',
        );
        return (
          client?.email?.trim()?.toLowerCase() ===
          customer.email?.trim()?.toLowerCase() ||
          client?.phone
            ?.trim()
            ?.toLowerCase()
            .includes(customer.phone?.trim()?.toLowerCase()) ||
          customer?.phone
            ?.trim()
            ?.toLowerCase()
            .includes(client?.phone?.trim()?.toLowerCase())
        );
      });
    }

    return paiements;
  }

  // Remboursement d'un paiement par Kkiapay
  async refundPaiement(paiementId: string) {
    const paiement = await this.findOne(paiementId);

    if (paiement.status !== PaiementStatus.SUCCESS) {
      return {
        success: false,
        message: "Le paiement n'est pas en cours",
        transactionId: paiement.reference,
        paiement: paiement,
      };
    }
    try {
      const transaction = await this.kkiapay.refundTransaction(
        paiement.reference,
      );

      const updatedPaiement = await this.update(paiementId, {
        status: PaiementStatus.REVERTED,
        failure_code: transaction.failureCode,
        failure_message: transaction.failureMessage,
      });

      // Repropager le remboursement : si le cumul des paiements SUCCESS retombe
      // sous le total, la commande repasse paied=false (corrige les commandes
      // restées "payées" après un refund — famille Z-25 de la réconciliation KKiaPay).
      if (paiement.order_id) {
        await this.recomputeOrderPaiedFlag(paiement.order_id);
      }

      // Émission de l'événement de paiement annulé
      this.paiementEvent.paiementAnnule(paiement);

      return {
        success: updatedPaiement.status === 'REVERTED',
        message:
          updatedPaiement.status === 'REVERTED'
            ? 'Remboursement effectué avec succès'
            : 'Remboursement echoué',
        transactionId: updatedPaiement.reference,
        paiement: updatedPaiement,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Remboursement echoué',
        transactionId: paiement.reference,
        paiement: paiement,
      };
    }
  }

  // Création de paiement
  async create(
    createPaiementDto: CreatePaiementDto,
    opts?: { dedupeByReference?: boolean },
  ) {
    // Idempotence (KKiaPay) : un même transactionId (reference) ne doit créer qu'UN
    // paiement, même si le webhook est rejoué ou reçu en parallèle (double backend).
    // NON activé pour le cash (références PAY-… générées, non stables) → opt-in.
    if (opts?.dedupeByReference && createPaiementDto.reference) {
      const existing = await this.prisma.paiement.findFirst({
        where: { reference: createPaiementDto.reference },
      });
      if (existing) {
        const order = createPaiementDto.order_id
          ? await this.prisma.order.findUnique({ where: { id: createPaiementDto.order_id } })
          : null;
        return { paiement: existing, order };
      }
    }

    // Vérification de la commande
    const order = await this.verifyOrder(
      createPaiementDto.amount,
      createPaiementDto.order_id ?? null,
    );

    // Traitement du mode de paiement et du type de mobile money
    const { mode, source } = await this.verifyPaiementMode(
      createPaiementDto.mode,
      createPaiementDto.source ?? null,
    );

    // Traitement du statut du paiement
    const status = await this.verifyPaiementStatus(createPaiementDto.status);

    const paiement = await this.prisma.paiement.create({
      data: {
        ...createPaiementDto,
        order_id: order?.id ?? null,
        mode,
        status,
        source,
        entity_status: EntityStatus.ACTIVE,
      },
    });

    // Émission de l'événement de paiement effectué
    this.paiementEvent.paiementEffectue(paiement);

    return { paiement, order };
  }

  // Récupération de tous les paiements
  async findAll(queryDto: QueryPaiementDto) {
    const {
      page = 1,
      limit = 10,
      status = EntityStatus.ACTIVE,
      state = PaiementStatus.SUCCESS,
      order_id,
      search,
    } = queryDto;
    const whereClause: any = { entity_status: EntityStatus.ACTIVE };

    if (status) {
      whereClause.entity_status = status;
    }

    if (state) {
      whereClause.status = state;
    }

    if (order_id) {
      whereClause.order_id = order_id;
    }
    if (search) {
      whereClause.OR = [
        { order_id: { contains: search, mode: 'insensitive' } },
        { mode: { contains: search, mode: 'insensitive' } },
        { state: { contains: search, mode: 'insensitive' } },
        { source: { contains: search, mode: 'insensitive' } },
      ];
    }

    const paiements = await this.prisma.paiement.findMany({
      where: whereClause,
      orderBy: {
        created_at: 'desc',
      },
      select: {
        id: true,
        amount: true,
        order_id: true,
        mode: true,
        source: true,
        status: true,
        reference: true,
        order: {
          select: {
            id: true,
            reference: true,
            customer: {
              select: {
                id: true,
                first_name: true,
                last_name: true,
                phone: true,
                email: true,
                image: true,
              },
            },
          },
        },
      },
      take: limit,
      skip: (page - 1) * limit,
    });
    return paiements;
  }

  // Récupération d'un paiement
  async findOne(paiementId: string) {
    const paiement = await this.prisma.paiement.findUnique({
      where: {
        id: paiementId,
      },
    });
    if (!paiement) {
      throw new NotFoundException('Paiement non trouvé');
    }
    return paiement;
  }

  // Mise à jour d'un paiement
  async update(paiementId: string, updatePaiementDto: UpdatePaiementDto) {
    const paiement = await this.findOne(paiementId);

    // Vérification de la commande
    const order = await this.verifyOrder(
      updatePaiementDto.amount ?? paiement.amount,
      updatePaiementDto.order_id ?? paiement.order_id,
    );

    // Traitement du mode de paiement et du type de mobile money
    const { mode, source } = await this.verifyPaiementMode(
      updatePaiementDto.mode ?? paiement.mode,
      updatePaiementDto.source ?? paiement.source,
    );

    // Traitement du statut du paiement
    const status = await this.verifyPaiementStatus(
      updatePaiementDto.status ?? paiement.status,
    );

    // Si l'amount change ou que le total change, recopier total = amount + fees
    // (logique standard, sauf si l'appelant a explicitement fourni un total).
    const nextAmount = updatePaiementDto.amount ?? paiement.amount;
    const nextFees = updatePaiementDto.fees ?? paiement.fees ?? 0;
    const nextTotal = updatePaiementDto.total ?? (nextAmount + nextFees);

    const updated = await this.prisma.paiement.update({
      where: {
        id: paiement.id,
      },
      data: {
        ...updatePaiementDto,
        order_id: order?.id,
        mode,
        status,
        source,
        amount: nextAmount,
        fees: nextFees,
        total: nextTotal,
      },
    });

    // Re-synchroniser le flag `paied` de la commande : un changement de montant
    // ou de statut (SUCCESS → FAILED) peut faire basculer paied true ↔ false.
    if (paiement.order_id) {
      await this.recomputeOrderPaiedFlag(paiement.order_id);
    }
    // Si l'order_id a changé (rare), recomputer aussi l'ancienne et la nouvelle.
    if (order?.id && order.id !== paiement.order_id) {
      await this.recomputeOrderPaiedFlag(order.id);
    }

    return updated;
  }

  // Suppression d'un paiement
  async remove(paiementId: string) {
    const paiement = await this.findOne(paiementId);
    const result = await this.prisma.paiement.delete({
      where: {
        id: paiement.id,
      },
    });

    // Re-synchroniser le flag `paied` de la commande après suppression
    // (paiement retiré → potentiellement plus assez perçu → paied = false).
    if (paiement.order_id) {
      await this.recomputeOrderPaiedFlag(paiement.order_id);
    }

    return result;
  }

  /** Somme des paiements SUCCESS d'une commande (montant réellement encaissé). */
  private async sumSuccessPaiements(orderId: string): Promise<number> {
    const paiements = await this.prisma.paiement.findMany({
      where: { order_id: orderId, status: PaiementStatus.SUCCESS },
      select: { amount: true, total: true },
    });
    return paiements.reduce((s, p) => s + (p.total ?? p.amount ?? 0), 0);
  }

  /**
   * Recalcule `order.paied` selon la somme actuelle des paiements SUCCESS.
   * Appelé après update/remove de paiement (et après update d'amount commande
   * côté OrderService — logique dupliquée pour éviter une dépendance circulaire
   * Paiements ↔ Order). À garder synchronisé avec OrderService.recomputeOrderPaiedFlag.
   */
  private async recomputeOrderPaiedFlag(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        paiements: { where: { status: PaiementStatus.SUCCESS } },
      },
    });
    if (!order) return;
    const totalPaid = order.paiements.reduce(
      (sum, p) => sum + (p.total ?? p.amount ?? 0),
      0,
    );
    const shouldBePaied = totalPaid >= order.amount - PAYMENT_AMOUNT_TOLERANCE;
    if (shouldBePaied === order.paied) return;
    const mostRecentSuccess = order.paiements.reduce<Date | null>(
      (latest, p) => {
        const at = p.created_at ?? null;
        if (!at) return latest;
        return !latest || at > latest ? at : latest;
      },
      null,
    );
    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        paied: shouldBePaied,
        paied_at: shouldBePaied ? (order.paied_at ?? mostRecentSuccess ?? new Date()) : null,
      },
    });
  }

  // Vérification de la commande
  private async verifyOrder(amount: number, order_id: string | null) {
    if (!order_id) {
      return null;
    }
    const order = await this.prisma.order.findUnique({
      where: {
        id: order_id,
      },
    });
    if (!order) {
      return null;
    }

    // if (amount < order.amount) {
    //   throw new BadRequestException(
    //     'Le montant est inférieur au montant de la commande',
    //   );
    // }
    return order;
  }

  // Vérification du mode de paiement
  private async verifyPaiementMode(mode: PaiementMode, source: string | null) {
    // Vérification de l'existence du mode de paiement
    if (!mode) {
      throw new BadRequestException('Mode de paiement non fourni');
    }
    // Vérification de la validité du mode de paiement
    if (
      ![
        PaiementMode.MOBILE_MONEY,
        PaiementMode.WALLET,
        PaiementMode.CARD,
        PaiementMode.CASH,
      ].includes(mode)
    ) {
      throw new BadRequestException('Mode de paiement non valide');
    }

    return { mode, source };
  }

  // Vérification du statut du paiement
  private async verifyPaiementStatus(status: PaiementStatus) {
    // Vérification de l'existence du statut du paiement
    if (!status) {
      throw new BadRequestException('Statut du paiement non fourni');
    }

    // Vérification de la validité du statut du paiement
    if (
      ![
        PaiementStatus.REVERTED,
        PaiementStatus.SUCCESS,
        PaiementStatus.FAILED,
      ].includes(status)
    ) {
      throw new BadRequestException('Statut du paiement non valide');
    }
    return status;
  }

  // Statut cible d'une commande au moment du paiement.
  // SEULE une commande PENDING devient ACCEPTED. Une commande déjà avancée
  // (ACCEPTED/IN_PROGRESS/READY…) n'est JAMAIS rétrogradée : un webhook tardif ou
  // rejoué ne doit pas renvoyer une commande en préparation vers ACCEPTED.
  // (Les paramètres méthode/type sont conservés pour la signature des appelants ;
  // l'ancienne double branche renvoyait ACCEPTED dans les deux cas → morte.)
  private getOrderStatus(_paymentMethod: PaymentMethod, _orderType: OrderType, oldStatus: OrderStatus): OrderStatus {
    return oldStatus === OrderStatus.PENDING ? OrderStatus.ACCEPTED : oldStatus;
  }
}
