import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { IncidentSuiviType } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { IncidentAlertesService } from './incident-alertes.service';
import { STATUTS_A_RESOUDRE } from './incident.rules';

/** Incidents traités au plus par passage. */
const LOT = 100;

/**
 * DÉLAI DÉPASSÉ : toutes les 10 minutes, les incidents ni résolus ni
 * clôturés après leur échéance sonnent UNE fois dans la cloche de leur
 * responsable (restaurant de la commande, sinon call center) et des
 * administrateurs.
 *
 * Deux serveurs : chaque incident est REVENDIQUÉ par une écriture
 * conditionnée (`alerte_retard_at` encore vide) ; le second processus ne
 * trouve plus la ligne dans l'état attendu et n'alerte pas.
 *
 * Désactivable par DISABLE_INCIDENT_RETARD_CRON=true (banc de test).
 */
@Injectable()
export class IncidentRetardTask {
  private readonly logger = new Logger(IncidentRetardTask.name);
  private enCours = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly alertes: IncidentAlertesService,
  ) {}

  @Cron('3-59/10 * * * *')
  async verifier(): Promise<string[]> {
    if (process.env.DISABLE_INCIDENT_RETARD_CRON === 'true') return [];
    if (this.enCours) return [];
    this.enCours = true;
    try {
      return await this.passage(new Date());
    } catch (e) {
      this.logger.warn(`Incidents en retard : passage interrompu : ${(e as Error)?.message}`);
      return [];
    } finally {
      this.enCours = false;
    }
  }

  /** Un passage, à une heure donnée. Renvoie les incidents alertés par CE processus. */
  async passage(maintenant: Date): Promise<string[]> {
    const candidats = await this.prisma.incident.findMany({
      where: { statut: { in: STATUTS_A_RESOUDRE }, echeance_at: { lt: maintenant }, alerte_retard_at: null },
      select: {
        id: true,
        code: true,
        order_id: true,
        restaurant_id: true,
        statut: true,
        pole: true,
        gravite: true,
        description: true,
        geste: true,
        echeance_at: true,
        categorie: { select: { nom: true } },
        restaurant: { select: { name: true } },
        order: { select: { reference: true } },
      },
      orderBy: { echeance_at: 'asc' },
      take: LOT,
    });

    const alertes: string[] = [];
    for (const i of candidats) {
      // Revendication sur l'état lu : une résolution arrivée entre-temps fait passer son tour à l'incident.
      const pris = await this.prisma.incident.updateMany({
        where: { id: i.id, alerte_retard_at: null, statut: { in: STATUTS_A_RESOUDRE } },
        data: { alerte_retard_at: maintenant },
      });
      if (pris.count === 0) continue;
      alertes.push(i.id);
      try {
        const servis = await this.alertes.retard(i);
        if (servis > 0) {
          await this.prisma.incidentSuivi.create({
            data: { incident_id: i.id, type: IncidentSuiviType.RETARD, created_at: maintenant },
          });
        }
        this.alertes.diffuser(i);
      } catch (e) {
        this.logger.error(`Cloche de retard de l'incident ${i.code} non envoyée : ${(e as Error)?.message ?? e}`);
      }
    }
    return alertes;
  }
}
