import { sanitizeOrderForBroadcast } from 'src/common/utils/order-broadcast.util';
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
  User,
} from '@prisma/client';
import { QueryPaiementDto } from 'src/modules/paiements/dto/query-paiement.dto';
import { KkiapayService } from 'src/kkiapay/kkiapay.service';
import { CreatePaiementKkiapayDto } from 'src/modules/paiements/dto/create-paiement-kkiapay.dto';
import type { Request } from 'express';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PaiementEvent } from 'src/modules/paiements/events/paiement.event';
import { PromoCodeService } from 'src/modules/promo-code/promo-code.service';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';
import { OrderChannels } from 'src/modules/order/enums/order-channels';
import { RESTAURANT_COMMANDE_SELECT } from 'src/modules/restaurant/constantes/restaurant-public.select';
import { CLIENT_COMMANDE_SELECT } from 'src/modules/order/constantes/client-commande.select';
import { sansIdentifiantsPush } from 'src/modules/order/helpers/identifiants-push.helper';
import { assertCanAccessRestaurant } from 'src/modules/order/helpers/restaurant-scope.helper';
import { ANNULEE_PAR_CLIENT_SUPPRIMEE_WHERE } from 'src/modules/order/helpers/brouillons.rules';
import { AlertesService, CodeAlerte } from 'src/modules/alertes/alertes.service';
import {
  encaisseAvant,
  estPaiementEnDouble,
  etatApresEncaissement,
  extraireEncaissement,
  PaiementReussi,
  PAYMENT_AMOUNT_TOLERANCE,
  verifierCommandeEncaissable,
} from 'src/modules/paiements/helpers/encaissement.helper';

@Injectable()
export class PaiementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kkiapay: KkiapayService,
    private readonly paiementEvent: PaiementEvent,
    private readonly promoCodeService: PromoCodeService,
    private readonly appGateway: AppGateway,
    private readonly eventEmitter: EventEmitter2,
    private readonly alertes: AlertesService,
  ) { }

  /**
   * PAIEMENT REÇU SUR UN PANIER QUE LE CLIENT AVAIT ANNULÉ (revue du 01/10).
   *
   * Le panier annulé par le client avant de payer est supprimé des listes
   * (`entity_status` DELETED) et suivi dans « À relancer ». Si son paiement
   * en ligne est validé APRÈS l'annulation (Mobile Money confirmé sur le
   * téléphone une fois l'application fermée), `paied` vient de passer à vrai :
   * la commande n'est plus relançable, et resterait supprimée, donc absente
   * de tous les écrans, alors que l'argent est reçu et que personne ne la
   * rembourse.
   *
   * Elle redevient donc ACTIVE : une annulation payée ordinaire, visible dans
   * Commandes avec le badge « Payé », et une alerte demande le remboursement.
   * Écriture conditionnée (idempotente) : rejouée, elle ne fait rien. Ne
   * touche aucune autre commande, annulée par le personnel comprise.
   *
   * @returns vrai si la commande vient d'être rendue visible.
   */
  private async retablirAnnuleeParClientPayee(
    commande: { id: string; reference?: string | null; restaurant_id?: string | null },
    transactionId: string,
  ): Promise<boolean> {
    const { count } = await this.prisma.order.updateMany({
      where: { id: commande.id, ...ANNULEE_PAR_CLIENT_SUPPRIMEE_WHERE, paied: true },
      data: { entity_status: EntityStatus.ACTIVE, deleted_at: null },
    });
    if (count !== 1) return false;
    this.alertes.signaler({
      code: CodeAlerte.PAIEMENT_SUR_COMMANDE_ANNULEE,
      restaurantId: commande.restaurant_id ?? null,
      reference: commande.reference ?? null,
      details: [
        `Le client a payé dans l'application une commande qu'il avait annulée avant la validation de son paiement.`,
        `Elle réapparaît dans Commandes, au statut Annulée avec le badge Payé : la rembourser, ou la reprendre avec le client.`,
      ],
      cleBridage: `${CodeAlerte.PAIEMENT_SUR_COMMANDE_ANNULEE}:${commande.reference ?? commande.id}`,
      meta: { orderId: commande.id, transactionId },
    });
    return true;
  }

  /**
   * PAIEMENT REÇU DEUX FOIS (revue du 02/10).
   *
   * Le client paie de nouveau une commande déjà réglée : paiement rouvert au
   * rechargement de la page de suivi du site, deux onglets, notification du
   * premier paiement en retard. Le second paiement était enregistré sans que
   * rien ne le signale : il n'était remboursé que sur réclamation du client.
   *
   * Une alerte demande donc de le rembourser, que la commande soit payable en
   * ligne ou à la caisse. Elle ne part qu'au PREMIER enregistrement de la
   * transaction (`nouveau`) : un rejeu (nouvelle tentative du webhook, ou
   * webhook après la confirmation de l'application) reste silencieux. Bridage
   * par transaction : un troisième paiement aurait sa propre alerte.
   *
   * @returns vrai si ce paiement arrive sur une commande déjà réglée, rejeu
   *   compris.
   */
  private controlerPaiementEnDouble(
    commande: { id: string; reference?: string | null; restaurant_id?: string | null; amount: number },
    paiement: { id: string; reference: string; amount: number; source?: string | null; created_at: Date },
    reussis: PaiementReussi[],
    nouveau: boolean,
  ): boolean {
    const dejaEncaisse = encaisseAvant(reussis, paiement);
    if (!estPaiementEnDouble(commande.amount, dejaEncaisse)) return false;
    if (nouveau) {
      const francs = (montant: number) => `${montant.toLocaleString('fr-FR')} F`;
      this.alertes.signaler({
        code: CodeAlerte.PAIEMENT_EN_DOUBLE,
        restaurantId: commande.restaurant_id ?? null,
        reference: commande.reference ?? null,
        details: [
          `Le client a payé en ligne une commande déjà réglée : ce paiement est à lui rembourser.`,
          `Déjà encaissé avant lui : ${francs(dejaEncaisse)} pour ${francs(commande.amount)} dus.`,
          `À rembourser : ${francs(paiement.amount)}${paiement.source ? ` (${paiement.source})` : ''}, transaction KKiaPay ${paiement.reference}.`,
        ],
        cleBridage: `${CodeAlerte.PAIEMENT_EN_DOUBLE}:${paiement.reference}`,
        meta: {
          orderId: commande.id,
          paiementId: paiement.id,
          transactionId: paiement.reference,
          montant: paiement.amount,
          dejaEncaisse,
        },
      });
    }
    return true;
  }

  // Payer avec Kkiapay
  async payWithKkiapay(
    req: Request,
    createPaiementKkiapayDto: CreatePaiementKkiapayDto,
  ) {

    // MULTI-COMPTES : la transaction se vérifie auprès du compte KKiaPay du
    // RESTAURANT de la commande (repli global automatique pendant la transition —
    // anciennes versions d'app). Sans orderId (paiement libre), compte global.
    const restaurantId = createPaiementKkiapayDto.orderId
      ? (await this.prisma.order.findUnique({
          where: { id: createPaiementKkiapayDto.orderId },
          select: { restaurant_id: true },
        }))?.restaurant_id ?? null
      : null;

    const { transaction, collectedBy } = await this.kkiapay.verifyTransactionForRestaurant(
      createPaiementKkiapayDto.transactionId,
      restaurantId,
    );

    const customer = req.user as Customer;

    const result = await this.create({
      restaurant_id: collectedBy, // compte encaisseur TRACÉ (null = global)
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
      const reussis = isSuccess ? await this.paiementsReussis(result.order.id) : [];
      const totalSuccess = this.sommeEncaissee(reussis);
      const covered = totalSuccess >= result.order.amount - PAYMENT_AMOUNT_TOLERANCE;
      // Paiement reçu deux fois : même contrôle que le webhook, qui trouvera
      // ensuite cette transaction déjà enregistrée et se taira.
      if (isSuccess) {
        this.controlerPaiementEnDouble(result.order, result.paiement, reussis, !result.dejaEnregistre);
      }
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
        // Panier annulé par le client entre-temps : visible de nouveau, et
        // remboursement signalé. Isolé : la réponse au client ne doit pas
        // échouer, et le webhook du même paiement rejoue ce geste.
        try {
          await this.retablirAnnuleeParClientPayee(result.order, transaction.transactionId);
        } catch (e) {
          console.error(
            `[Paiement KKiaPay] Commande annulée par le client ${result.order.reference} payée, ` +
            `non rétablie : ${(e as Error)?.message}`,
          );
        }
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
   * Enregistre un ou plusieurs paiements ajoutés par la caissière depuis la
   * caisse ou le backoffice (liste de modes : CASH / Mobile Money / Carte / Wave…).
   *
   * Contrôles, AVANT toute écriture (cf. `encaissement.helper.ts`) :
   *   - toutes les lignes portent la même commande ;
   *   - la commande existe, n'est pas annulée, et appartient au restaurant du
   *     compte quand c'est un compte de restaurant ;
   *   - le client du paiement est celui de la commande, jamais celui du corps.
   *
   * Cascade sur l'Order :
   *   - `paied = true` seulement si la somme des paiements **SUCCESS**
   *     (nouveaux + existants) couvre `order.amount`, à la tolérance près ;
   *   - si de plus la commande est déjà `COLLECTED` (livrée mais pas encore
   *     encaissée), elle passe en `COMPLETED` avec `completed_at = now`. Une
   *     commande partiellement payée garde son statut et un reste dû.
   */
  async addPaiement(
    req: Request,
    data: AddPaiementDto,
  ) {
    const { orderId, lignes } = extraireEncaissement(data.items);

    const commande = verifierCommandeEncaissable(
      await this.prisma.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          restaurant_id: true,
          customer_id: true,
          status: true,
          entity_status: true,
          amount: true,
          paiements: {
            where: { status: PaiementStatus.SUCCESS },
            select: { amount: true, total: true },
          },
        },
      }),
      req.user as User | undefined,
    );

    // Commande déjà soldée : un nouvel encaissement serait un double
    // encaissement. Cas réel : client qui finit de payer dans l'application
    // pendant que la caisse, sur un écran pas encore rafraîchi, encaisse au
    // comptoir. Des lignes toutes à zéro n'enregistrent rien : elles gardent
    // leur traitement habituel, plus bas.
    const dejaPercu = (commande.paiements ?? []).reduce(
      (somme, p) => somme + (p.total ?? p.amount ?? 0),
      0,
    );
    if (
      lignes.length > 0 &&
      commande.amount != null &&
      dejaPercu >= commande.amount - PAYMENT_AMOUNT_TOLERANCE
    ) {
      throw new BadRequestException('Commande déjà payée.');
    }

    // Résoudre toutes les créations en parallèle — le bug précédent utilisait
    // `items.map(async)` sans Promise.all, donc la vérification `length`
    // portait sur un tableau de Promises, et seul paiements[0] était awaited.
    await Promise.all(
      lignes.map(async (item) => {
        const uniqueRef = `PAY-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        return this.create({
          reference: uniqueRef,
          amount: item.amount,
          fees: 0,
          total: item.amount,
          mode: item.mode,
          source: item.source,
          status: PaiementStatus.SUCCESS,
          order_id: commande.id,
          // ⚠️ Le client venait du corps de la requête, sans contrôle.
          client_id: commande.customer_id,
        });
      }),
    );

    const now = new Date();

    // Recharger l'order + tous les paiements SUCCESS pour décider si le total
    // est couvert (on ne peut pas se fier uniquement aux `items` entrants car
    // il peut déjà y avoir eu des paiements partiels précédents).
    const order = await this.prisma.order.findUnique({
      where: { id: commande.id },
      include: {
        paiements: { where: { status: PaiementStatus.SUCCESS } },
      },
    });
    if (!order) {
      return { success: true, message: 'Paiement effectué avec succès' };
    }

    const totalPaid = order.paiements.reduce((sum, p) => sum + (p.total ?? p.amount ?? 0), 0);
    // ⚠️ `paied` était posé dès le premier paiement, même partiel : une
    // commande à moitié réglée passait pour payée.
    const { soldee, aTerminer } = etatApresEncaissement(order.amount, totalPaid, order.status);
    // Rien n'a été enregistré (toutes les lignes à zéro) et il reste un dû :
    // répondre « paiement enregistré » serait faux.
    if (lignes.length === 0 && !soldee) {
      throw new BadRequestException('Aucun montant à encaisser : saisissez le montant reçu.');
    }

    const updatedOrder = await this.prisma.order.update({
      where: { id: order.id },
      data: {
        ...(soldee && {
          paied: true,
          paied_at: order.paied_at ?? now,
        }),
        ...(aTerminer && {
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
      message: soldee
        ? 'Paiement effectué avec succès'
        : `Paiement enregistré, reste dû ${Math.max(0, order.amount - totalPaid).toLocaleString('fr-FR')} XOF (commande non soldée).`,
    };
  }

  /**
   * CONFIRMATION D'UN ENCAISSEMENT LIVREUR (backoffice).
   *
   * Un livreur (Turbo) a encaissé le client à la livraison : le webhook a
   * enregistré un Paiement **PENDING** et la commande est restée COLLECTED.
   * La confirmation par le staff :
   *   1. passe le paiement en SUCCESS (claim atomique — double-clic et
   *      2 backends sans double effet) ;
   *   2. marque la commande payée (`paied`, `paied_at`) ;
   *   3. la termine (COMPLETED) si elle est déjà livrée (COLLECTED) et que le
   *      cumul des paiements SUCCESS couvre le montant — même cascade que
   *      `addPaiement` ;
   *   4. émet les mêmes sockets/événements métier qu'une transition normale
   *      (app client, backoffice, fidélité).
   */
  async confirmerEncaissement(req: Request, paiementId: string) {
    const paiement = await this.prisma.paiement.findUnique({
      where: { id: paiementId },
      select: {
        id: true,
        status: true,
        order_id: true,
        order: { select: { status: true, restaurant_id: true } },
      },
    });
    if (!paiement) {
      throw new NotFoundException('Paiement introuvable');
    }
    // ⚠️ `req` n'était pas lu : un compte du restaurant A confirmait
    // l'encaissement d'une commande du restaurant B, qui passait payée et
    // terminée. Contrôle AVANT tout autre, pour ne rien apprendre d'un
    // paiement étranger. Un paiement sans commande n'a pas de restaurant : un
    // compte de restaurant ne peut pas le confirmer, ce que le contrôle
    // ci-dessous refuserait de toute façon. Sans effet pour le back office.
    assertCanAccessRestaurant(req.user as User | undefined, paiement.order?.restaurant_id);
    if (paiement.status !== PaiementStatus.PENDING) {
      throw new BadRequestException(
        'Seul un encaissement en attente peut être confirmé.',
      );
    }
    if (!paiement.order_id) {
      throw new BadRequestException(
        "Cet encaissement n'est rattaché à aucune commande.",
      );
    }
    // Commande annulée entre temps : l'argent encaissé par le livreur est un
    // LITIGE (remboursement/restitution), pas un paiement à confirmer — on ne
    // marque jamais payée une commande annulée.
    if (paiement.order?.status === OrderStatus.CANCELLED) {
      throw new BadRequestException(
        'Commande annulée : encaissement non confirmable. Traitez le litige manuellement (paiements).',
      );
    }

    // Claim atomique PENDING → SUCCESS.
    const claim = await this.prisma.paiement.updateMany({
      where: { id: paiementId, status: PaiementStatus.PENDING },
      data: { status: PaiementStatus.SUCCESS, updated_at: new Date() },
    });
    if (claim.count !== 1) {
      return { success: true, message: 'Encaissement déjà confirmé.' }; // idempotent
    }

    // Cascade sur la commande — même logique que `addPaiement`.
    const order = await this.prisma.order.findUnique({
      where: { id: paiement.order_id },
      include: { paiements: { where: { status: PaiementStatus.SUCCESS } } },
    });
    if (!order) {
      return { success: true, message: 'Encaissement confirmé.' };
    }

    const now = new Date();
    const totalPaid = order.paiements.reduce(
      (sum, p) => sum + (p.total ?? p.amount ?? 0),
      0,
    );
    const { soldee: isFullyPaid, aTerminer: shouldComplete } = etatApresEncaissement(
      order.amount,
      totalPaid,
      order.status,
    );

    const previousStatus = order.status;
    const updatedOrder = await this.prisma.order.update({
      where: { id: order.id },
      data: {
        // `paied` SEULEMENT si le cumul couvre le montant (leçon KKiaPay : un
        // encaissement partiel ne rend pas la commande « payée » — elle reste
        // COLLECTED avec un reste dû, encaissable via l'ajout caissière).
        ...(isFullyPaid && {
          paied: true,
          paied_at: order.paied_at ?? now,
        }),
        ...(shouldComplete && {
          status: OrderStatus.COMPLETED,
          completed_at: now,
        }),
      },
      include: {
        // Liste blanche : la commande part sur les sockets si elle se termine.
        restaurant: { select: RESTAURANT_COMMANDE_SELECT },
        // ⚠️ La ligne client complète et ses réglages de notification (jeton
        // Expo, identifiants OneSignal) partaient vers tout le restaurant et
        // tout le back office. Le jeton est relu à part, plus bas.
        customer: { select: CLIENT_COMMANDE_SELECT },
      },
    });

    // Usage code promo (idempotent, isolé — comme addPaiement).
    try {
      await this.promoCodeService.activateUsageForOrder(updatedOrder);
    } catch (e) {
      console.error(
        `Sync usage promo (confirmerEncaissement) échoué pour ${order.id}: ${(e as Error)?.message}`,
      );
    }

    // La commande vient de se TERMINER : mêmes sockets et effets métier
    // (fidélité, notifications) qu'une transition COMPLETED normale.
    if (shouldComplete) {
      const statusData = {
        // Filet : aucun identifiant de notification ne part sur un socket.
        order: sansIdentifiantsPush(updatedOrder),
        message: 'Commande terminée',
        previousStatus,
      };
      this.appGateway.emitToUser(
        updatedOrder.customer_id,
        'customer',
        OrderChannels.ORDER_STATUS_UPDATED,
        statusData,
      );
      // Sans le code de récupération : la room du restaurant est aussi écoutée
      // par ses livreurs, à qui ce code doit rester inconnu.
      const statusDataDiffusion = { ...statusData, order: sanitizeOrderForBroadcast(statusData.order) };
      this.appGateway.emitToBackoffice(OrderChannels.ORDER_STATUS_UPDATED, statusDataDiffusion);
      this.appGateway.emitToRestaurant(
        updatedOrder.restaurant_id,
        OrderChannels.ORDER_STATUS_UPDATED,
        statusDataDiffusion,
      );
      // Destinataire de la notification « commande terminée » : lu ici, jamais
      // rangé dans la commande. Un échec coûte la notification, pas la
      // confirmation, déjà enregistrée.
      const reglagesPush = await this.prisma.notificationSetting
        .findUnique({
          where: { customer_id: updatedOrder.customer_id },
          select: { expo_push_token: true },
        })
        .catch((e) => {
          console.error(
            `Jeton de notification illisible (confirmerEncaissement) pour ${order.id}: ${(e as Error)?.message}`,
          );
          return null;
        });
      this.eventEmitter.emit(OrderChannels.ORDER_STATUS_UPDATED, {
        order: updatedOrder,
        expo_token: reglagesPush?.expo_push_token ?? null,
      });
    }

    return {
      success: true,
      message: shouldComplete
        ? 'Encaissement confirmé, commande terminée.'
        : isFullyPaid
          ? 'Encaissement confirmé.'
          : `Encaissement confirmé, reste dû ${Math.max(0, order.amount - totalPaid).toLocaleString('fr-FR')} XOF (commande non soldée).`,
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
    data: CreatePaiementKkiapayDto & {
      customer_id: string;
      /** Compte annoncé par la ROUTE webhook /kkiapay/webhook/:restaurantId —
       *  il a validé le secret de ce compte, c'est donc lui qui a ENCAISSÉ.
       *  Prioritaire sur le restaurant de la commande (revue 31/07 : une
       *  commande réaffectée à un autre restaurant après paiement rendait la
       *  transaction introuvable — vérifiée sur [nouveau restaurant, global]
       *  mais jamais sur le compte qui avait réellement reçu l'argent). */
      collectorRestaurantId?: string | null;
    },
  ) {

    // MULTI-COMPTES : compte annoncé par le webhook d'abord, sinon le compte du
    // restaurant de la commande — avec repli global dans les deux cas
    // (transaction encaissée par une ancienne version de l'app).
    const restaurantId = data.collectorRestaurantId
      ?? (data.orderId
        ? (await this.prisma.order.findUnique({
            where: { id: data.orderId },
            select: { restaurant_id: true },
          }))?.restaurant_id ?? null
        : null);

    const { transaction, collectedBy } = await this.kkiapay.verifyTransactionForRestaurant(
      data.transactionId,
      restaurantId,
    );

    const result = await this.create({
      restaurant_id: collectedBy, // compte encaisseur TRACÉ (null = global)
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
    // Paiement arrivé sur une commande déjà sortie de PENDING, et qui l'a
    // soldée : l'appelant doit prévenir les écrans ouverts (aucun autre
    // événement ne part sur ce chemin).
    let payeApresCoup = false;
    // Panier annulé par le client que ce paiement vient de rendre visible
    // (`retablirAnnuleeParClientPayee`) : il ne rapporte rien.
    let annuleeRetablie = false;
    // Motif lisible d'un paiement NON abouti — remonté à l'appelant (confirmation
    // manuelle admin) pour un 4xx explicite. `undefined` si isPaid=true.
    let notPaidReason: string | undefined;
    // Paiement arrivé sur une commande que les paiements précédents réglaient
    // déjà (`controlerPaiementEnDouble`) : à rembourser. Vrai aussi au rejeu.
    let enDouble = false;
    if (result.order) {
      // Ne confirmer la commande QUE si la transaction est SUCCESS ET si le cumul
      // des paiements SUCCESS couvre le total (pas d'acompte app). Bloque les
      // paiements FAILED (Z) et les paiements-jetons (B). cf. réconciliation KKiaPay.
      const isSuccess = transaction.status === PaiementStatus.SUCCESS;
      const reussis = isSuccess ? await this.paiementsReussis(result.order.id) : [];
      const totalSuccess = this.sommeEncaissee(reussis);
      const covered = totalSuccess >= result.order.amount - PAYMENT_AMOUNT_TOLERANCE;
      isPaid = isSuccess && covered;
      // Contrôlé AVANT toute écriture sur la commande : si l'une d'elles
      // échoue, le webhook retenté trouve la transaction déjà enregistrée et
      // ne signalerait plus rien. L'alerte doit donc être partie.
      if (isSuccess) {
        enDouble = this.controlerPaiementEnDouble(result.order, result.paiement, reussis, !result.dejaEnregistre);
      }
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

        // Commande sortie de PENDING sans être payée (reprise par le
        // personnel, confirmée au téléphone) : le claim ne la touche pas, et
        // `paied` restait faux alors que l'argent est reçu. Le livreur, Turbo
        // ou la caisse le réclamaient une seconde fois. Même geste que
        // payWithKkiapay : `paied` seul, le statut ne bouge pas. Idempotent.
        if (!justPaid) {
          const tardif = await this.prisma.order.updateMany({
            where: { id: result.order.id, paied: false },
            data: { paied: true, paied_at: paymentAt },
          });
          payeApresCoup = tardif.count === 1;
          // Panier annulé par le client avant ce paiement : rendu visible,
          // remboursement signalé. Rejoué à chaque passage (idempotent), y
          // compris quand `paied` était déjà posé par un passage précédent ou
          // par la confirmation de l'application. Une erreur remonte : le
          // webhook est alors retenté, et la commande retrouvée par sa
          // référence même payée (`findByReferenceOrNull`).
          annuleeRetablie = await this.retablirAnnuleeParClientPayee(result.order, transaction.transactionId);
        }

        // Paiement tardif : c'est LUI qui solde la commande, plus personne ne
        // l'encaissera. Le code promo doit donc être compté ici, comme sur
        // tous les autres chemins qui soldent une commande. Idempotent ; isolé.
        // Jamais sur une commande ANNULÉE : son coupon a été rendu à
        // l'annulation, le compter de nouveau le ferait payer au client sans
        // qu'il en profite.
        if (payeApresCoup) {
          try {
            const commandePayee = await this.prisma.order.findUnique({ where: { id: result.order.id } });
            if (commandePayee && commandePayee.status !== OrderStatus.CANCELLED) {
              await this.promoCodeService.activateUsageForOrder(commandePayee);
            }
          } catch (e) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            console.error(`Sync usage promo (paiement KKiaPay tardif) échoué pour ${result.order.id}: ${(e as any)?.message}`);
          }
        }

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

    return { paiement: result.paiement, justPaid, isPaid, payeApresCoup, annuleeRetablie, enDouble, notPaidReason };
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
      // Rembourse depuis le compte qui a ENCAISSÉ (tracé à la vérification ;
      // null = compte global historique). Jamais de repli : rembourser depuis
      // un autre compte serait une erreur comptable.
      const transaction = await this.kkiapay.refundTransaction(
        paiement.reference,
        paiement.restaurant_id ?? null,
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
        // Rejeu d'une transaction connue : ce qui ne doit parler qu'une fois
        // (paiement reçu deux fois) se tait.
        return { paiement: existing, order, dejaEnregistre: true };
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

    return { paiement, order, dejaEnregistre: false };
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

  /**
   * Paiements SUCCESS d'une commande. Une seule lecture sert au cumul encaissé
   * (`sommeEncaissee`) et au contrôle du paiement reçu deux fois.
   */
  private async paiementsReussis(orderId: string) {
    return this.prisma.paiement.findMany({
      where: { order_id: orderId, status: PaiementStatus.SUCCESS },
      select: { id: true, reference: true, amount: true, total: true, created_at: true },
    });
  }

  /** Somme des paiements SUCCESS d'une commande (montant réellement encaissé). */
  private sommeEncaissee(paiements: { amount: number | null; total: number | null }[]): number {
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

    // Vérification de la validité du statut du paiement.
    // ⚠️ PENDING est volontairement ABSENT : un encaissement « en attente »
    // ne naît QUE du webhook Turbo (interne) — jamais via l'API de
    // création/édition, sinon n'importe quel client pourrait fabriquer des
    // paiements à confirmer ou en repasser un en attente.
    const STATUTS_AUTORISES: PaiementStatus[] = [
      PaiementStatus.REVERTED,
      PaiementStatus.SUCCESS,
      PaiementStatus.FAILED,
    ];
    if (!STATUTS_AUTORISES.includes(status)) {
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
