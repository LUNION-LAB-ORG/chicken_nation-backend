import { Injectable, Logger } from '@nestjs/common';
import { CrmEventType, CrmStatus } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { conditionDormants, limiteDormants } from '../crm.rules';
import { CrmConfigService } from './crm-config.service';

/**
 * RÉVEIL DES CONTACTS ENDORMIS.
 *
 * « Intéressé » et « coupon envoyé » sont des statuts OUVERTS qui ne
 * vieillissaient pas. Un contact appelé une fois y restait des semaines sans
 * que rien ne le fasse bouger : trois intéressés à 24 jours dormaient dans une
 * file que l'agent croyait bloquée, et le client n'était jamais rappelé.
 *
 * Passé le délai (`crm.dormant_days`, 7 jours par défaut), ils repassent « à
 * appeler ». Avec un `call_count` déjà supérieur à zéro, ils reparaissent dans
 * « À relancer », donc dans une section que l'agent traite, au lieu d'une
 * section qu'il ne regarde plus.
 *
 * ⚠️ Ils RESTENT dans le portefeuille de leur agent. On ne les lui retire pas :
 * il a déjà travaillé ce client, le passer à un collègue ferait recommencer la
 * relation de zéro.
 */
@Injectable()
export class CrmDormantsService {
  private readonly logger = new Logger(CrmDormantsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: CrmConfigService,
  ) {}

  /** Un passage. Renvoie le nombre de contacts réveillés PAR CE PROCESSUS. */
  async reveiller(maintenant = new Date()): Promise<number> {
    const { dormant_days } = await this.config.lireReglages();
    const limite = limiteDormants(maintenant, dormant_days);
    const condition = conditionDormants(limite);

    const dormants = await this.prisma.crmContact.findMany({
      where: condition,
      select: { id: true, status: true, campaign_id: true },
      take: 500,
    });
    if (dormants.length === 0) return 0;

    let reveilles = 0;
    for (const contact of dormants) {
      /*
        Revendication : l'écriture reste conditionnée au statut LU. Si un agent
        vient de rappeler ce client, ou si un second backend est passé avant,
        la ligne n'est plus dans l'état attendu et on n'écrit rien — ni statut,
        ni événement en double dans le journal.
      */
      const { count } = await this.prisma.crmContact.updateMany({
        where: { id: contact.id, status: contact.status },
        data: { status: CrmStatus.A_APPELER },
      });
      if (count !== 1) continue;

      await this.prisma.crmEvent.create({
        data: {
          contact_id: contact.id,
          campaign_id: contact.campaign_id,
          type: CrmEventType.RETOUR,
          label: `Sans suite depuis ${dormant_days} jours : remis à relancer`,
          data: { depuis: contact.status, jours: dormant_days },
        },
      });
      reveilles += 1;
    }

    this.logger.log(`CRM : ${reveilles} contact(s) endormi(s) remis à relancer`);
    return reveilles;
  }
}
