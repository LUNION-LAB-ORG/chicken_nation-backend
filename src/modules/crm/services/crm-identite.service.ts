import { Injectable } from '@nestjs/common';
import { CrmEventType, EntityStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { cleTelephone } from '../crm.rules';
import { CrmEventsService } from './crm-events.service';

type Client = Prisma.TransactionClient | PrismaService;

/** Verrou consultatif par numéro, commun à la capture, à la liaison et aux anciennes routes. */
export const CLASSE_VERROU_NUMERO = 727225;

/**
 * Qui est derrière un numéro. Une personne a UNE fiche : celle de son compte
 * sur l'application, ou, tant qu'elle n'en a pas, la fiche de son numéro
 * (contact Glovo/Yango). Quand le compte apparaît, la fiche du numéro lui est
 * rattachée au lieu d'en créer une seconde.
 */
@Injectable()
export class CrmIdentiteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: CrmEventsService,
  ) {}

  async verrouiller(tx: Prisma.TransactionClient, cle: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CLASSE_VERROU_NUMERO}::int, hashtext(${cle}))`;
  }

  /**
   * Le client actif qui porte ce numéro. Des doublons historiques existent
   * (« 225… » supprimé, « +225… » actif) : on écarte les comptes supprimés et
   * on préfère le format « + », comme la connexion des clients.
   */
  async clientDuNumero(tx: Client, cle: string): Promise<{ id: string; created_at: Date } | null> {
    const [client] = await tx.$queryRaw<{ id: string; created_at: Date }[]>`
      SELECT c."id", c."created_at" FROM "Customer" c
      WHERE c."entity_status" <> 'DELETED' AND c."phone" IS NOT NULL
        AND right(regexp_replace(c."phone", '\\D', '', 'g'), 10) = ${cle}
      ORDER BY (c."phone" LIKE '+%') DESC, c."created_at", c."id"
      LIMIT 1`;
    return client ?? null;
  }

  /** Fiche sans compte d'un numéro (au plus une, garantie par un index partiel). */
  ficheDuNumero(tx: Client, cle: string) {
    return tx.crmContact.findFirst({
      where: { customer_id: null, phone_key: cle, entity_status: { not: EntityStatus.DELETED } },
      orderBy: { created_at: 'asc' },
      select: { id: true },
    });
  }

  /**
   * Fiche d'un client : la sienne, ou la fiche sans compte de son numéro, qui
   * lui est alors rattachée. `null` s'il n'en a aucune : à l'appelant de créer
   * celle du bon public (inscrit sans commande ou inactif).
   */
  async ficheDuClient(customerId: string): Promise<string | null> {
    const propre = await this.prisma.crmContact.findUnique({ where: { customer_id: customerId }, select: { id: true } });
    if (propre) return propre.id;
    const client = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { phone: true, created_at: true, entity_status: true },
    });
    const cle = cleTelephone(client?.phone);
    if (!client || !cle || client.entity_status === EntityStatus.DELETED) return null;

    return this.prisma.$transaction(
      async (tx) => {
        await this.verrouiller(tx, cle);
        const deja = await tx.crmContact.findUnique({ where: { customer_id: customerId }, select: { id: true } });
        if (deja) return deja.id;
        // Le numéro doit désigner CE client : un doublon supprimé ne vole pas la fiche.
        const elu = await this.clientDuNumero(tx, cle);
        if (elu?.id !== customerId) return null;
        const orpheline = await this.ficheDuNumero(tx, cle);
        if (!orpheline) return null;
        const lien = await tx.crmContact.updateMany({
          where: { id: orpheline.id, customer_id: null },
          data: { customer_id: customerId, registered_at: client.created_at },
        });
        if (lien.count === 0) return null;
        await this.events.journaliser(
          [{ contact_id: orpheline.id, type: CrmEventType.INSCRIPTION, label: "Compte sur l'application associé" }],
          tx,
        );
        return orpheline.id;
      },
      { maxWait: 2000, timeout: 5000 },
    );
  }
}
