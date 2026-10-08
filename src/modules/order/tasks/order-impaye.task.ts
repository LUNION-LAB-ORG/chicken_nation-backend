import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OrderStatus } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { AlertesService, CodeAlerte } from 'src/modules/alertes/alertes.service';
import { anomaliePaiement, MINUTES_AVANT_ALERTE_IMPAYE } from '../helpers/impaye.rules';

/**
 * ALERTE DES COMMANDES TERMINÉES SANS PAIEMENT, À RETARDEMENT.
 *
 * ⚠️ Elle partait auparavant à l'INSTANT du changement de statut, dans
 * `OrderService.update`. Or le paiement arrive parfois bien après la fin de la
 * commande : un cas mesuré en production montrait 1 h 00 min 15 s d'écart. Le
 * groupe recevait donc « Commande terminée SANS paiement » sur des commandes
 * qui allaient être payées, et une alerte qui se trompe apprend à ignorer le
 * canal.
 *
 * Deux passages, toutes les 10 minutes :
 *  - ALERTE : commandes terminées depuis plus de 90 minutes, toujours
 *    impayées, jamais signalées ;
 *  - RÉGULARISATION : commandes déjà signalées dont le paiement a fini par
 *    arriver. On le dit dans le même canal, sinon l'alerte reste la dernière
 *    chose qu'on y a lue sur cette commande.
 *
 * Double backend : chaque commande est REVENDIQUÉE par une écriture
 * conditionnée sur la valeur lue (`alerte_impaye_at`). Deux processus qui
 * lisent le même état n'alertent qu'une fois, le second ne trouvant plus la
 * ligne dans l'état attendu.
 *
 * Désactivable par DISABLE_IMPAYE_CRON=true, pour un second backend ou un banc
 * de test.
 */
@Injectable()
export class OrderImpayeTask {
  private readonly logger = new Logger(OrderImpayeTask.name);
  /** Un passage à la fois dans ce processus : une base lente ne les empile pas. */
  private enCours = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly alertes: AlertesService,
  ) {}

  @Cron('0 */10 * * * *')
  async verifier(): Promise<{ alertees: string[]; regularisees: string[] }> {
    const vide = { alertees: [], regularisees: [] };
    if (process.env.DISABLE_IMPAYE_CRON === 'true') return vide;
    if (this.enCours) return vide;
    this.enCours = true;
    try {
      return await this.passage(new Date());
    } catch (e) {
      // Base injoignable : le prochain passage réessaiera.
      this.logger.warn(`Impayés : passage interrompu : ${(e as Error)?.message}`);
      return vide;
    } finally {
      this.enCours = false;
    }
  }

  /** Un passage, à une heure donnée. Renvoie les références traitées par CE processus. */
  async passage(maintenant: Date): Promise<{ alertees: string[]; regularisees: string[] }> {
    return {
      alertees: await this.alerter(maintenant),
      regularisees: await this.regulariser(),
    };
  }

  /** Commandes terminées depuis assez longtemps, toujours impayées, jamais signalées. */
  private async alerter(maintenant: Date): Promise<string[]> {
    const limite = new Date(maintenant.getTime() - MINUTES_AVANT_ALERTE_IMPAYE * 60_000);

    const candidates = await this.prisma.order.findMany({
      where: {
        status: { in: [OrderStatus.COLLECTED, OrderStatus.COMPLETED] },
        paied: false,
        alerte_impaye_at: null,
        OR: [{ completed_at: { lte: limite } }, { collected_at: { lte: limite } }],
      },
      select: {
        id: true,
        reference: true,
        amount: true,
        paied: true,
        restaurant_id: true,
        paiements: { select: { status: true, amount: true, total: true } },
      },
      take: 100,
      orderBy: { updated_at: 'asc' },
    });

    const alertees: string[] = [];
    for (const commande of candidates) {
      const anomalie = anomaliePaiement(commande);
      if (!anomalie) continue;

      // Revendication : si un autre processus l'a déjà prise, `count` vaut 0.
      const { count } = await this.prisma.order.updateMany({
        where: { id: commande.id, alerte_impaye_at: null },
        data: { alerte_impaye_at: maintenant },
      });
      if (count !== 1) continue;

      this.alertes.signaler({
        code: anomalie.code,
        restaurantId: commande.restaurant_id ?? null,
        reference: commande.reference,
        details: [
          ...anomalie.details,
          `Terminée depuis plus de ${MINUTES_AVANT_ALERTE_IMPAYE} min.`,
        ],
        meta: { orderId: commande.id, du: anomalie.du, encaisse: anomalie.encaisse },
      });
      alertees.push(commande.reference);
    }
    return alertees;
  }

  /**
   * Commandes signalées dont le paiement a fini par arriver.
   *
   * Le marqueur revient à NULL : la commande redevient éligible à l'alerte si
   * elle repassait impayée, ce qui est le bon comportement et évite un second
   * champ pour retenir qu'on a déjà régularisé.
   */
  private async regulariser(): Promise<string[]> {
    const reglees = await this.prisma.order.findMany({
      where: { alerte_impaye_at: { not: null }, paied: true },
      select: { id: true, reference: true, amount: true, restaurant_id: true, paied_at: true },
      take: 100,
    });

    const regularisees: string[] = [];
    for (const commande of reglees) {
      const { count } = await this.prisma.order.updateMany({
        where: { id: commande.id, alerte_impaye_at: { not: null } },
        data: { alerte_impaye_at: null },
      });
      if (count !== 1) continue;

      this.alertes.signaler({
        code: CodeAlerte.PAIEMENT_REGULARISE,
        restaurantId: commande.restaurant_id ?? null,
        reference: commande.reference,
        details: [
          `Le paiement de ${Number(commande.amount) || 0} F est arrivé.`,
          "L'alerte précédente sur cette commande est levée.",
        ],
        meta: { orderId: commande.id },
      });
      regularisees.push(commande.reference);
    }
    return regularisees;
  }
}
