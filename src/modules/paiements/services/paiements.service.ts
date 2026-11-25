import { sanitizeOrderForBroadcast } from 'src/common/utils/order-broadcast.util';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AddPaiementDto, CreatePaiementDto } from 'src/modules/paiements/dto/create-paiement.dto';
import { UpdatePaiementDto } from 'src/modules/paiements/dto/update-paiement.dto';
import { PrismaService } from 'src/database/services/prisma.service';
import { PaystackService } from 'src/paystack/paystack.service';
import { referenceRemboursementPaystack } from 'src/modules/paiements/helpers/remboursement.rules';
import {
  Customer,
  EntityStatus,
  FournisseurPaiement,
  Order,
  OrderStatus,
  OrderType,
  Paiement,
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
import {
  ANNULEE_PAR_CLIENT_EN_LIGNE_WHERE,
  ANNULEE_PAR_CLIENT_SUPPRIMEE_WHERE,
  estBrouillon,
} from 'src/modules/order/helpers/brouillons.rules';
import { PaiementChannels } from 'src/modules/paiements/enums/paiement-channels';
import { AlertesService, CodeAlerte } from 'src/modules/alertes/alertes.service';
import {
  encaisseAvant,
  estPaiementEnDouble,
  etatApresEncaissement,
  extraireEncaissement,
  PaiementReussi,
  PAYMENT_AMOUNT_TOLERANCE,
  REFUS_ENCAISSEMENT,
  verifierAjoutSansExces,
  verifierCommandeEncaissable,
  verifierConfirmationSansExces,
  verifierCorrectionSansExces,
} from 'src/modules/paiements/helpers/encaissement.helper';

/** Transaction vérifiée chez le prestataire, dans la forme commune à KKiaPay et Paystack (25/11). */
interface TransactionVerifiee {
  transactionId: string;
  amount: number;
  fees: number;
  total: number;
  source: PaiementMode;
  source_common_name: string | null;
  client: string | null;
  status: PaiementStatus;
  failureCode: string | null;
  failureMessage: string | null;
}

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
    // En dernier : les essais existants construisent le service sans lui.
    @Optional() private readonly paystackService?: PaystackService,
  ) { }

  private get paystack(): PaystackService {
    if (!this.paystackService) throw new ServiceUnavailableException("Paystack n'est pas disponible.");
    return this.paystackService;
  }

  /**
   * PAIEMENT REÇU SUR UN PANIER QUE LE CLIENT AVAIT ANNULÉ (revue du 01/10,
   * revue le 25/11).
   *
   * Le client annule son panier avant de payer ; son paiement en ligne est
   * validé APRÈS l'annulation (Mobile Money confirmé sur le téléphone une
   * fois l'application fermée) : `paied` vient de passer à vrai, la commande
   * n'est plus relançable, l'argent est reçu et personne ne le rembourse.
   * Une alerte demande donc le remboursement.
   *
   * Avant le 25/11, l'annulation la supprimait : elle redevient ACTIVE,
   * visible dans Commandes avec le badge « Payé ». Écriture conditionnée,
   * rejouée sans effet. Depuis le 25/11, elle reste active : rien à rendre
   * visible, seul le passage qui vient de poser `paied` (`vientDEtrePayee`)
   * signale, pour qu'un rejeu du webhook ne l'annonce pas une seconde fois.
   * Ne touche aucune autre commande, annulée par le personnel comprise.
   *
   * @returns vrai si le remboursement vient d'être signalé.
   */
  private async retablirAnnuleeParClientPayee(
    commande: { id: string; reference?: string | null; restaurant_id?: string | null },
    transactionId: string,
    vientDEtrePayee: boolean,
  ): Promise<boolean> {
    const { count } = await this.prisma.order.updateMany({
      where: { id: commande.id, ...ANNULEE_PAR_CLIENT_SUPPRIMEE_WHERE, paied: true },
      data: { entity_status: EntityStatus.ACTIVE, deleted_at: null },
    });
    let aSignaler = count === 1;
    if (!aSignaler && vientDEtrePayee) {
      // Relue en base : le client a pu annuler après la lecture de la commande.
      const resteeActive = await this.prisma.order.findFirst({
        where: { id: commande.id, ...ANNULEE_PAR_CLIENT_EN_LIGNE_WHERE, paied: true },
        select: { id: true },
      });
      aSignaler = !!resteeActive;
    }
    if (!aSignaler) return false;
    this.alertes.signaler({
      code: CodeAlerte.PAIEMENT_SUR_COMMANDE_ANNULEE,
      restaurantId: commande.restaurant_id ?? null,
      reference: commande.reference ?? null,
      details: [
        `Le client a payé dans l'application une commande qu'il avait annulée avant la validation de son paiement.`,
        `Elle est dans Commandes, au statut Annulée avec le badge Payé : la rembourser, ou la reprendre avec le client.`,
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

  /**
   * KKIAPAY PRIORITAIRE (18/11).
   *
   * Un paiement en ligne vérifié auprès de KKiaPay (webhook, retour de
   * l'application, rattrapage) vient de solder la commande. Les encaissements
   * que le livreur avait déclarés à la livraison, encore en attente, ne
   * peuvent plus être que de trop : ils sont refusés d'office, pour que
   * personne ne les confirme par erreur. L'argent de KKiaPay est réel et
   * vérifié, la déclaration du livreur ne l'est pas.
   *
   * Une alerte prévient l'équipe : si le livreur a vraiment reçu cet argent,
   * le client a payé deux fois et il doit être remboursé.
   *
   * Idempotent (seuls les paiements encore en attente changent) et isolé : le
   * paiement est déjà enregistré, une erreur ici ne doit pas faire échouer sa
   * prise en compte. La caisse peut toujours refuser à la main.
   */
  private async refuserDeclarationsApresKkiapay(
    commande: { id: string; reference?: string | null; restaurant_id?: string | null },
    transactionId: string,
  ): Promise<void> {
    try {
      const enAttente = await this.prisma.paiement.findMany({
        where: { order_id: commande.id, status: PaiementStatus.PENDING },
        select: { id: true, amount: true, source: true },
      });
      if (enAttente.length === 0) return;
      const { count } = await this.prisma.paiement.updateMany({
        where: { id: { in: enAttente.map((p) => p.id) }, status: PaiementStatus.PENDING },
        data: {
          status: PaiementStatus.FAILED,
          failure_code: REFUS_ENCAISSEMENT.PAYEE_EN_LIGNE,
          failure_message: "Refusé d'office : commande payée en ligne (KKiaPay)",
          updated_at: new Date(),
        },
      });
      if (count === 0) return;
      const montant = enAttente.reduce((somme, p) => somme + (p.amount ?? 0), 0);
      const moyens = [...new Set(enAttente.map((p) => p.source).filter(Boolean))].join(', ');
      this.alertes.signaler({
        code: CodeAlerte.ENCAISSEMENT_LIVREUR_REFUSE,
        restaurantId: commande.restaurant_id ?? null,
        reference: commande.reference ?? null,
        details: [
          `La commande est payée en ligne (transaction KKiaPay ${transactionId}).`,
          `L'encaissement déclaré par le livreur, ${montant.toLocaleString('fr-FR')} XOF${moyens ? ` (${moyens})` : ''}, est refusé d'office : il serait de trop.`,
          `Si le livreur a vraiment reçu cet argent, le client a payé deux fois : il est à rembourser.`,
        ],
        cleBridage: `${CodeAlerte.ENCAISSEMENT_LIVREUR_REFUSE}:${commande.reference ?? commande.id}`,
        meta: { orderId: commande.id, transactionId, paiements: enAttente.map((p) => p.id), montant },
      });
    } catch (e) {
      console.error(
        `[Paiement KKiaPay] Encaissements du livreur non refusés pour ${commande.reference ?? commande.id} : ${(e as Error)?.message}`,
      );
    }
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
        // KKiaPay prioritaire : les déclarations du livreur en attente sont de trop.
        await this.refuserDeclarationsApresKkiapay(result.order, transaction.transactionId);
        const paymentAt = result.paiement.created_at;
        // TODO(§3a) : unifier ce chemin app-confirm avec linkPaiementToOrder pour qu'il
        // fasse aussi avancer le statut (PENDING → ACCEPTED) et déclenche les effets de
        // bord (points, cloche, push). Aujourd'hui il ne pose QUE paied=true : le statut
        // reste PENDING jusqu'au webhook (dont linkPaiementToOrder claim désormais bien
        // sur status:PENDING) ou au cron de réconciliation. Laissé tel quel volontairement
        // (unifier ici change la valeur de retour de l'endpoint /paiements/pay — risqué).
        const paye = await this.prisma.order.updateMany({
          where: { id: result.order.id, paied: false }, // claim atomique anti-rejeu
          data: {
            paied_at: paymentAt,
            paied: true,
            // Paiement différé : ramène la commande "à aujourd'hui" (tri + filtre période)
            ...this.buildPaymentDateAlignment(result.order, paymentAt),
          },
        });
        // Déjà remise au client (commande reprise, payée après coup) : terminée.
        if (paye.count === 1) await this.terminerSiRecuperee(result.order.id, 'payWithKkiapay');
        // Panier annulé par le client entre-temps : remboursement signalé, et
        // visible de nouveau s'il avait été supprimé. Isolé : la réponse au client ne doit pas
        // échouer, et le webhook du même paiement rejoue ce geste.
        try {
          await this.retablirAnnuleeParClientPayee(result.order, transaction.transactionId, paye.count === 1);
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
   *   - le client du paiement est celui de la commande, jamais celui du corps ;
   *   - jamais plus que le prix de la commande (18/11), en comptant ce que le
   *     livreur a déclaré sans confirmation (`verifierAjoutSansExces`), sous
   *     le verrou de la commande.
   *
   * Cascade sur l'Order :
   *   - `paied = true` seulement si la somme des paiements **SUCCESS**
   *     (nouveaux + existants) couvre `order.amount`, à la tolérance près ;
   *   - si de plus la commande est déjà `COLLECTED` (livrée mais pas encore
   *     encaissée), elle passe en `COMPLETED` avec `completed_at = now`. Une
   *     commande partiellement payée garde son statut et un reste dû ;
   *   - si elle est EN ATTENTE (14/11 : paiement en ligne dont le webhook
   *     n'est jamais arrivé), elle se CONFIRME : ACCEPTED et `accepted_at`,
   *     par le chemin ordinaire de l'acceptation (`CommandeSoldeeListener`).
   */
  async addPaiement(
    req: Request,
    data: AddPaiementDto,
  ) {
    const { orderId, lignes } = extraireEncaissement(data.items);
    // Moyens contrôlés avant le verrou (aucune lecture en base).
    const moyens = await Promise.all(
      lignes.map((item) => this.verifyPaiementMode(item.mode, item.source ?? null)),
    );

    // PAIEMENTS DE TROP (18/11) : contrôle et écriture sous le verrou de la
    // commande. Deux postes qui encaissent la même commande au même instant
    // (caisse et back office, double backend) passaient tous les deux le
    // contrôle, puis enregistraient chacun leur paiement. Le second attend
    // désormais le premier, et relit ce qu'il a enregistré.
    const { commande, crees } = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId}::uuid FOR UPDATE`;
      const commande = verifierCommandeEncaissable(
        await tx.order.findUnique({
          where: { id: orderId },
          select: {
            id: true,
            restaurant_id: true,
            customer_id: true,
            status: true,
            entity_status: true,
            amount: true,
            // Réussis ET en attente : une déclaration du livreur pas encore
            // confirmée compte dans le plafond (`verifierAjoutSansExces`).
            paiements: {
              where: { status: { in: [PaiementStatus.SUCCESS, PaiementStatus.PENDING] } },
              select: { status: true, amount: true, total: true },
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
      const dejaPercu = (commande.paiements ?? [])
        .filter((p) => p.status === PaiementStatus.SUCCESS)
        .reduce((somme, p) => somme + (p.total ?? p.amount ?? 0), 0);
      if (lignes.length > 0 && commande.amount != null) {
        if (dejaPercu >= commande.amount - PAYMENT_AMOUNT_TOLERANCE) {
          throw new BadRequestException('Commande déjà payée.');
        }
        // Jamais plus que le prix de la commande.
        verifierAjoutSansExces(
          commande.amount,
          commande.paiements ?? [],
          lignes.reduce((somme, l) => somme + l.amount, 0),
        );
      }

      // Écrits un par un dans la transaction : un refus annule tout le lot.
      const crees: Paiement[] = [];
      for (const [i, item] of lignes.entries()) {
        crees.push(
          await tx.paiement.create({
            data: {
              reference: `PAY-${Date.now()}-${Math.floor(Math.random() * 1000)}-${i}`,
              amount: item.amount,
              fees: 0,
              total: item.amount,
              mode: moyens[i].mode,
              source: moyens[i].source,
              status: PaiementStatus.SUCCESS,
              order_id: commande.id,
              // ⚠️ Le client venait du corps de la requête, sans contrôle.
              client_id: commande.customer_id,
              entity_status: EntityStatus.ACTIVE,
            },
          }),
        );
      }
      return { commande, crees };
    });
    // Après l'écriture définitive : un paiement annulé avec le lot ne doit
    // jamais avoir été annoncé.
    for (const paiement of crees) this.paiementEvent.paiementEffectue(paiement);

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

    // Commande en attente soldée : elle se confirme (14/11). Lu AVANT
    // l'écriture : payée, elle ne serait plus un brouillon, et le restaurant,
    // qui ne l'a jamais vue, ne recevrait pas « Nouvelle commande ».
    const aConfirmer = soldee && order.status === OrderStatus.PENDING;
    const etaitBrouillon = estBrouillon(order);

    const updatedOrder = await this.prisma.order.update({
      where: { id: order.id },
      data: {
        ...(soldee && {
          paied: true,
          paied_at: order.paied_at ?? now,
        }),
        // Paiement différé : ramenée à l'instant du paiement, comme au webhook.
        ...(aConfirmer && this.buildPaymentDateAlignment(order, now)),
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

    // Acceptation par le module des commandes (Paiements ne dépend pas de
    // lui) : ACCEPTED, `accepted_at`, cloche et « Nouvelle commande » au
    // restaurant, sockets. Le paiement reste enregistré si elle échoue.
    let confirmee = false;
    if (aConfirmer) {
      const user = req.user as User | undefined;
      const issues = await this.eventEmitter.emitAsync(PaiementChannels.COMMANDE_EN_ATTENTE_SOLDEE, {
        orderId: order.id,
        etaitBrouillon,
        userId: user?.id ?? null,
        role: user?.role ?? null,
      });
      confirmee = issues.some((issue) => issue === true);
    }

    return {
      success: true,
      confirmee,
      message: confirmee
        ? 'Paiement enregistré : la commande est confirmée.'
        : soldee
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
        amount: true,
        order_id: true,
        order: { select: { status: true, restaurant_id: true, amount: true } },
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
        paiement.status === PaiementStatus.FAILED
          ? 'Cet encaissement a été refusé : il ne peut plus être confirmé.'
          : 'Seul un encaissement en attente peut être confirmé.',
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

    // PAIEMENTS DE TROP (18/11) : jamais plus que le prix de la commande. Le
    // livreur déclarait 8 000 pendant que la caisse encaissait les mêmes
    // 8 000 : confirmer doublait le paiement. Contrôle et claim sous le verrou
    // de la commande, comme l'ajout d'un paiement : une confirmation et un
    // encaissement simultanés ne passent pas tous les deux.
    const orderId = paiement.order_id;
    const claim = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId}::uuid FOR UPDATE`;
      if (paiement.order?.amount != null) {
        const reussis = await tx.paiement.findMany({
          where: { order_id: orderId, status: PaiementStatus.SUCCESS },
          select: { status: true, amount: true },
        });
        verifierConfirmationSansExces(paiement.order.amount, reussis, paiement.amount ?? 0);
      }
      // Claim atomique PENDING → SUCCESS.
      return tx.paiement.updateMany({
        where: { id: paiementId, status: PaiementStatus.PENDING },
        data: { status: PaiementStatus.SUCCESS, updated_at: new Date() },
      });
    });
    if (claim.count !== 1) {
      // Traité entre la lecture et le claim : confirmé (rejeu, idempotent) ou
      // refusé par un autre poste.
      const maintenant = await this.prisma.paiement.findUnique({
        where: { id: paiementId },
        select: { status: true },
      });
      if (maintenant?.status === PaiementStatus.FAILED) {
        throw new BadRequestException('Cet encaissement vient d\'être refusé : il ne peut plus être confirmé.');
      }
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
      await this.annoncerTerminee(updatedOrder, previousStatus, 'confirmerEncaissement');
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
   * REFUS D'UN ENCAISSEMENT DU LIVREUR (18/11), depuis la caisse ou le back
   * office.
   *
   * Le livreur (interne ou Turbo) a déclaré un encaissement à la livraison :
   * le paiement est EN ATTENTE. Quand la déclaration est fausse (mauvais
   * moyen, mauvais montant, ou la caisse a déjà encaissé), la caissière la
   * refuse : le paiement passe en échec avec le motif et le nom de qui l'a
   * refusé, ne compte jamais dans ce que la commande a reçu, et elle peut
   * ensuite enregistrer le bon paiement. La commande ne bouge pas.
   *
   * Mêmes contrôles que la confirmation : restaurant du compte d'abord, puis
   * paiement en attente. Permis sur une commande annulée : c'est le moyen de
   * clore la déclaration. Revendication atomique : un double clic, ou une
   * confirmation au même instant sur un autre poste, n'a qu'un effet.
   */
  async refuserEncaissement(req: Request, paiementId: string) {
    const paiement = await this.prisma.paiement.findUnique({
      where: { id: paiementId },
      select: { id: true, status: true, order: { select: { restaurant_id: true } } },
    });
    if (!paiement) {
      throw new NotFoundException('Paiement introuvable');
    }
    const user = req.user as User | undefined;
    assertCanAccessRestaurant(user, paiement.order?.restaurant_id);
    if (paiement.status === PaiementStatus.FAILED) {
      return { success: true, message: 'Encaissement déjà refusé.' }; // idempotent
    }
    if (paiement.status !== PaiementStatus.PENDING) {
      throw new BadRequestException('Seul un encaissement en attente peut être refusé.');
    }
    const nom = user?.fullname?.trim();
    const claim = await this.prisma.paiement.updateMany({
      where: { id: paiementId, status: PaiementStatus.PENDING },
      data: {
        status: PaiementStatus.FAILED,
        failure_code: REFUS_ENCAISSEMENT.PAR_LE_RESTAURANT,
        failure_message: nom ? `Refusé par ${nom}` : 'Refusé par le restaurant',
        updated_at: new Date(),
      },
    });
    if (claim.count !== 1) {
      const maintenant = await this.prisma.paiement.findUnique({
        where: { id: paiementId },
        select: { status: true },
      });
      if (maintenant?.status === PaiementStatus.SUCCESS) {
        throw new BadRequestException('Cet encaissement vient d\'être confirmé : il ne peut plus être refusé.');
      }
      return { success: true, message: 'Encaissement déjà refusé.' };
    }
    return { success: true, message: 'Encaissement refusé.' };
  }

  /**
   * Une commande vient de passer TERMINÉE hors de `OrderService.updateStatus` :
   * mêmes sockets (client, back-office, restaurant) et même événement, donc
   * mêmes effets (cloche, points, notification « Merci »), qu'une clôture
   * ordinaire.
   */
  private async annoncerTerminee(updatedOrder: Order, previousStatus: OrderStatus, contexte: string): Promise<void> {
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
          `Jeton de notification illisible (${contexte}) pour ${updatedOrder.id}: ${(e as Error)?.message}`,
        );
        return null;
      });
    this.eventEmitter.emit(OrderChannels.ORDER_STATUS_UPDATED, {
      order: updatedOrder,
      expo_token: reglagesPush?.expo_push_token ?? null,
    });
  }

  /**
   * Paiement en ligne arrivé APRÈS la remise au client (« Récupérée ») : la
   * commande est remise et soldée, elle se termine, comme quand la caisse
   * encaisse une commande récupérée (03/11). Revendication atomique : rien si
   * elle n'est plus récupérée ou pas soldée. Ne lève jamais, le paiement est
   * déjà enregistré.
   */
  private async terminerSiRecuperee(orderId: string, contexte: string): Promise<void> {
    try {
      const { count } = await this.prisma.order.updateMany({
        where: { id: orderId, status: OrderStatus.COLLECTED, paied: true },
        data: { status: OrderStatus.COMPLETED, completed_at: new Date() },
      });
      if (count !== 1) return;
      const commande = await this.prisma.order.findUnique({ where: { id: orderId } });
      if (commande) await this.annoncerTerminee(commande, OrderStatus.COLLECTED, contexte);
    } catch (e) {
      console.error(`Clôture après paiement tardif (${contexte}) échouée pour ${orderId}: ${(e as Error)?.message}`);
    }
  }

  /**
   * Aligne `created_at` sur l'instant du PAIEMENT lorsqu'une commande encore NON
   * payée est payée (paiement différé : créée un jour, payée un autre). La commande
   * remonte ainsi en tête de liste et tombe dans la bonne période de filtrage, car
   * tout le tri/filtrage des commandes s'appuie sur `created_at`.
   *
   * L'instant de soumission initiale est préservé dans `submitted_at` (jamais écrasé).
   * Seulement pour une commande encore hors du circuit (en attente, ou panier
   * annulé par le client). Renvoie un patch VIDE si la commande était déjà payée → idempotent (le webhook
   * KKiaPay et le retour de l'app peuvent tirer plusieurs fois pour la même transaction).
   */
  private buildPaymentDateAlignment(
    order: { paied: boolean; status: OrderStatus; created_at: Date; submitted_at: Date | null },
    paymentAt: Date,
  ): { created_at?: Date; submitted_at?: Date } {
    if (order.paied) return {};
    // Déjà dans le circuit (reprise au téléphone, acceptée, en cuisine…) :
    // elle y est entrée à sa date, que le paiement ne déplace plus. Sinon
    // l'acceptation tomberait AVANT la création dans les statistiques (03/11).
    if (order.status !== OrderStatus.PENDING && order.status !== OrderStatus.CANCELLED) return {};
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
      /** Prestataire qui a encaissé (25/11) ; KKiaPay par défaut. Paystack :
       *  `transactionId` est la référence de la tentative. */
      fournisseur?: FournisseurPaiement;
    },
  ) {
    const fournisseur = data.fournisseur ?? FournisseurPaiement.KKIAPAY;
    const libelle = fournisseur === FournisseurPaiement.PAYSTACK ? 'Paystack' : 'KKiaPay';

    let transaction: TransactionVerifiee;
    let collectedBy: string | null;
    if (fournisseur === FournisseurPaiement.PAYSTACK) {
      // Vérifiée chez Paystack et contrôlée pour CETTE commande (référence,
      // mode de la clé, XOF, sous-compte attendu). Lève BadRequest (refus
      // définitif) ou ServiceUnavailable (Paystack injoignable, à retenter).
      if (!data.orderId) throw new BadRequestException('Commande inconnue pour ce paiement.');
      const verifie = await this.paystack.transactionPourCommande(data.transactionId, data.orderId);
      const t = verifie.transaction;
      collectedBy = verifie.restaurantId;
      // Paiement pas (encore) abouti : rien d'enregistré. Un paiement
      // « abandonné » peut encore aboutir tant que la page reste ouverte.
      if (t.statutPaystack !== 'success') {
        return {
          paiement: null,
          justPaid: false,
          isPaid: false,
          payeApresCoup: false,
          annuleeRetablie: false,
          enDouble: false,
          notPaidReason: `Paystack: paiement non abouti (${t.statutPaystack})`,
        };
      }
      // Le client a payé la commande plus les frais du moyen choisi (figés
      // sur la tentative) : `amount` est la part de la commande, `fees` les
      // frais ajoutés, `total` ce qui a été débité.
      const paye = t.montant ?? 0;
      const fraisAjoutes = Math.min(Math.max(0, verifie.frais), paye);
      transaction = {
        transactionId: t.reference,
        amount: paye - fraisAjoutes,
        fees: fraisAjoutes,
        total: paye,
        source: t.mode,
        source_common_name: t.source,
        client: t.client ? JSON.stringify(t.client) : null,
        status: t.statut,
        failureCode: null,
        failureMessage: t.motifEchec,
      };
    } else {
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

      const verifie = await this.kkiapay.verifyTransactionForRestaurant(
        data.transactionId,
        restaurantId,
      );
      collectedBy = verifie.collectedBy;
      transaction = {
        ...verifie.transaction,
        total: verifie.transaction.amount + verifie.transaction.fees,
        client:
          typeof verifie.transaction.client === 'object'
            ? JSON.stringify(verifie.transaction.client)
            : verifie.transaction.client,
      };
    }

    const result = await this.create({
      restaurant_id: collectedBy, // compte encaisseur TRACÉ (null = global)
      reference: transaction.transactionId,
      amount: transaction.amount,
      fees: transaction.fees,
      total: transaction.total,
      mode: transaction.source,
      source: transaction.source_common_name ?? undefined,
      client: transaction.client ?? undefined,
      status: transaction.status,
      failure_code: transaction.failureCode ?? undefined,
      failure_message: transaction.failureMessage ?? undefined,
      order_id: data.orderId,
      client_id: data.customer_id,
    }, { dedupeByReference: true, fournisseur });

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
    // Panier annulé par le client dont ce paiement vient de signaler le
    // remboursement (`retablirAnnuleeParClientPayee`) : il ne rapporte rien.
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
        notPaidReason = !isSuccess ? `${libelle}: statut non SUCCESS` : 'montant non couvert';
      }
      if (isPaid) {
        // KKiaPay prioritaire : les déclarations du livreur en attente sont de trop.
        await this.refuserDeclarationsApresKkiapay(result.order, transaction.transactionId);
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
          // Panier annulé par le client avant ce paiement : remboursement
          // signalé, et rendu visible s'il avait été supprimé. Rejoué à chaque
          // passage (idempotent), y compris quand `paied` était déjà posé par
          // un passage précédent ou par la confirmation de l'application. Une erreur remonte : le
          // webhook est alors retenté, et la commande retrouvée par sa
          // référence même payée (`findByReferenceOrNull`).
          annuleeRetablie = await this.retablirAnnuleeParClientPayee(result.order, transaction.transactionId, payeApresCoup);
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
        // Déjà remise au client (reprise, payée après coup) : la commande
        // soldée se termine (03/11).
        if (payeApresCoup) await this.terminerSiRecuperee(result.order.id, 'paiement KKiaPay tardif');

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

  // Remboursement d'un paiement par Kkiapay, à l'ANNULATION d'une commande
  // (OrderHelper, repli sur un bon si KKiaPay refuse). Le remboursement fait
  // à la main depuis l'onglet Paiement passe par RemboursementService (12/11).
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
      // PAYSTACK (25/11) : demande à Paystack, avec notre référence (une par
      // paiement). Souvent traitée en différé : « demandée », le paiement
      // passe « Remboursé » au webhook refund.processed.
      if (paiement.fournisseur === FournisseurPaiement.PAYSTACK) {
        const { statut } = await this.paystack.rembourser({
          transaction: paiement.reference,
          // Tout ce que le client a payé, frais compris.
          montant: Math.round(paiement.total || paiement.amount),
          reference: referenceRemboursementPaystack(paiement.id),
          note: 'Commande annulée',
        });
        if (statut === 'processed') {
          const rembourse = await this.update(paiementId, { status: PaiementStatus.REVERTED });
          if (paiement.order_id) await this.recomputeOrderPaiedFlag(paiement.order_id);
          this.paiementEvent.paiementAnnule(paiement);
          return { success: true, message: 'Remboursement effectué avec succès', transactionId: paiement.reference, paiement: rembourse };
        }
        if (['pending', 'processing', 'needs-attention'].includes(statut)) {
          const demande = await this.prisma.paiement.update({
            where: { id: paiementId },
            data: { remboursement_demande_at: new Date(), rembourse_par_nom: 'Annulation de la commande' },
          });
          return { success: true, message: 'Remboursement demandé à Paystack', transactionId: paiement.reference, paiement: demande };
        }
        throw new Error(`Remboursement Paystack ${statut}`);
      }

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

  /**
   * Création directe d'un paiement par l'administrateur (POST /paiements,
   * correction du registre, aucun écran). Même plafond que l'encaissement
   * (18/11) : un paiement réussi ne fait jamais dépasser le prix de la
   * commande.
   */
  async creerDepuisRegistre(dto: CreatePaiementDto) {
    if (dto.order_id && dto.status === PaiementStatus.SUCCESS) {
      const commande = await this.prisma.order.findUnique({
        where: { id: dto.order_id },
        select: {
          amount: true,
          paiements: { where: { status: PaiementStatus.SUCCESS }, select: { status: true, amount: true } },
        },
      });
      if (commande) verifierCorrectionSansExces(commande.amount, commande.paiements, 0, dto.amount);
    }
    return this.create(dto);
  }

  // Création de paiement
  async create(
    createPaiementDto: CreatePaiementDto,
    opts?: { dedupeByReference?: boolean; fournisseur?: FournisseurPaiement },
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
        ...(opts?.fournisseur ? { fournisseur: opts.fournisseur } : {}),
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

    // PAIEMENTS DE TROP (18/11) : une correction ne fait jamais dépasser le
    // prix de la commande. Seule une hausse de ce que la commande a reçu est
    // contrôlée (montant relevé, paiement repassé réussi) : baisser un
    // paiement de trop reste toujours permis.
    if (order) {
      const avant =
        paiement.status === PaiementStatus.SUCCESS && paiement.order_id === order.id ? paiement.amount : 0;
      const apres = status === PaiementStatus.SUCCESS ? nextAmount : 0;
      if (apres > avant) {
        const autres = await this.prisma.paiement.findMany({
          where: { order_id: order.id, status: PaiementStatus.SUCCESS, id: { not: paiement.id } },
          select: { status: true, amount: true },
        });
        verifierCorrectionSansExces(order.amount, autres, avant, apres);
      }
    }

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

  /**
   * Paiements déjà enregistrés sous cet identifiant de transaction KKiaPay, et
   * la commande de chacun. Lu avant une confirmation manuelle : une transaction
   * ne paie qu'une commande (`refusTransactionDejaRattachee`).
   */
  async enregistrementsDeLaTransaction(reference: string) {
    return this.prisma.paiement.findMany({
      where: { reference },
      select: { order_id: true, order: { select: { reference: true } } },
      take: 5,
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
  async recomputeOrderPaiedFlag(orderId: string) {
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
