import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from 'src/database/services/prisma.service';
import { ACTIONS_JOURNAL_RELANCE } from '../relance/relance.events';
import { classerBrouillons, doitAlerter } from '../relance/relance.rules';
import { OrderRelanceService } from '../services/order-relance.service';

/**
 * ALERTE DES PANIERS À RELANCER.
 *
 * Aucun événement ne signale qu'un panier vient de passer le délai : cette
 * tâche le constate toutes les 30 s et fait sonner les postes du centre
 * d'appels (`relance:changed`, motif « alerte »). Le son vient de là, une fois
 * par panier, jamais d'une horloge de navigateur.
 *
 * Une tête de groupe à relancer sonne :
 *  - si elle n'a jamais sonné (`alerte_le` nul) ;
 *  - ou si une prise « Je m'en occupe » a expiré sans traitement depuis sa
 *    dernière alerte (`prise_expire_le` échue et postérieure à `alerte_le`).
 *
 * Double backend : chaque alerte est REVENDIQUÉE par une écriture conditionnée
 * sur les valeurs lues (`alerte_le`, `prise_expire_le`). Deux processus qui
 * lisent le même état n'alertent qu'une fois : le second ne trouve plus la
 * ligne dans l'état lu.
 *
 * Désactivable par DISABLE_RELANCE_CRON=true (comme DISABLE_KKIAPAY_RECONCILE_CRON
 * dans order.task.ts), pour un second backend ou un banc de test.
 */
@Injectable()
export class OrderRelanceTask {
  private readonly logger = new Logger(OrderRelanceTask.name);
  /** Un passage à la fois dans ce processus : une base lente ne les empile pas. */
  private enCours = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly relances: OrderRelanceService,
  ) {}

  @Cron('*/30 * * * * *')
  async alerter(): Promise<string[]> {
    if (process.env.DISABLE_RELANCE_CRON === 'true') return [];
    if (this.enCours) return [];
    this.enCours = true;
    try {
      return await this.passage(new Date());
    } catch (e) {
      // Base injoignable : le prochain passage réessaiera.
      this.logger.warn(`Relance : passage d'alerte interrompu : ${(e as Error)?.message}`);
      return [];
    } finally {
      this.enCours = false;
    }
  }

  /** Un passage, à une heure donnée. Renvoie les têtes alertées par CE processus. */
  async passage(maintenant: Date): Promise<string[]> {
    const regles = await this.relances.regles();
    const { brouillons, effectives } = await this.relances.lireBrouillons(undefined, maintenant, regles);
    const { groupes } = classerBrouillons({ brouillons, effectives, maintenant, regles, moi: '' });

    const candidates = groupes
      .filter((g) => g.etat === 'A_RELANCER' && doitAlerter(g.tete.relance, maintenant))
      .map((g) => g.tete)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (candidates.length === 0) return [];

    await this.prisma.orderRelance.createMany({
      data: candidates.map((t) => ({ order_id: t.id })),
      skipDuplicates: true,
    });

    const gagnes: string[] = [];
    for (const tete of candidates) {
      const lu = tete.relance;
      const echue = lu?.prise_expire_le && lu.prise_expire_le <= maintenant ? lu.prise_expire_le : null;
      const { count } = await this.prisma.orderRelance.updateMany({
        where: {
          order_id: tete.id,
          ignore_le: null,
          AND: [
            // Personne ne l'a prise entre la lecture et l'écriture.
            { OR: [{ pris_par_id: null }, { prise_expire_le: { lte: maintenant } }] },
            // Toujours dans l'état lu : jamais alertée, ou prise expirée depuis.
            {
              OR: [
                { alerte_le: null },
                ...(echue ? [{ prise_expire_le: echue, alerte_le: { lt: echue } }] : []),
              ],
            },
          ],
        },
        data: { alerte_le: maintenant },
      });
      if (count === 1) gagnes.push(tete.id);
    }
    if (gagnes.length === 0) return [];

    try {
      await this.prisma.orderRelanceJournal.createMany({
        data: gagnes.map((order_id) => ({ order_id, action: ACTIONS_JOURNAL_RELANCE.ALERTE, user_id: null })),
      });
    } catch (e) {
      // L'alerte est posée : le journal manquant ne doit pas la faire taire.
      this.logger.warn(`Relance : journal d'alerte non écrit : ${(e as Error)?.message}`);
    }
    this.relances.signaler('alerte', gagnes, undefined, gagnes);
    return gagnes;
  }
}
