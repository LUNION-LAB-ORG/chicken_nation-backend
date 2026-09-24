import { Injectable, Logger } from '@nestjs/common';
import { CrmEventType, CrmSegment, CrmStatus, EntityStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { NOUVEAU_CYCLE_SQL, chiffresTelephone, cleTelephone, commandeEffective, compter, publicALaCapture } from '../crm.rules';
import { CrmConfigService } from './crm-config.service';
import { CrmEventsService } from './crm-events.service';
import { CrmIdentiteService } from './crm-identite.service';
import { CrmSyncService } from './crm-sync.service';

const JOUR = 86_400_000;
const PLATEFORME: Record<string, string> = { GLOVO: 'Glovo', YANGO: 'Yango' };

/** Nom relevé à la capture, sans le « Client » par défaut ni excès de longueur. */
export function nomDeCapture(nom?: string | null): string | null {
  const n = (nom ?? '').trim().slice(0, 120);
  return n && n.toLowerCase() !== 'client' ? n : null;
}

/**
 * Commandes Glovo/Yango relevées par les caissiers : chaque capture rejoint la
 * fiche de son numéro. Ne fait JAMAIS échouer la capture elle-même : en cas de
 * souci, la capture reste sans fiche et la reprise la rattache au passage
 * suivant (10 minutes au plus).
 */
@Injectable()
export class CrmCaptureService {
  private readonly logger = new Logger(CrmCaptureService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: CrmConfigService,
    private readonly events: CrmEventsService,
    private readonly identite: CrmIdentiteService,
    private readonly sync: CrmSyncService,
  ) {}

  async rattacherCapture(captureId: string): Promise<string | null> {
    try {
      const contactId = await this.rattacher(captureId);
      if (contactId) {
        this.events.signaler([contactId], 'capture');
        await this.sync.synchroniserContact(contactId);
      }
      return contactId;
    } catch (e) {
      this.logger.warn(`Capture ${captureId} laissée à la reprise : ${(e as Error).message}`);
      return null;
    }
  }

  private async rattacher(captureId: string): Promise<string | null> {
    const capture = await this.prisma.prospect.findUnique({
      where: { id: captureId },
      select: {
        id: true,
        platform: true,
        name: true,
        phone: true,
        order_number: true,
        created_at: true,
        contact_id: true,
        entity_status: true,
        restaurant: { select: { name: true } },
      },
    });
    if (!capture || capture.contact_id || capture.entity_status === EntityStatus.DELETED) return capture?.contact_id ?? null;
    if (capture.platform !== 'GLOVO' && capture.platform !== 'YANGO') return null;
    const cle = cleTelephone(capture.phone);
    if (!cle) return null;
    const segment = capture.platform === 'YANGO' ? CrmSegment.YANGO : CrmSegment.GLOVO;
    const jours = await this.config.joursInactivite();

    return this.prisma.$transaction(
      async (tx) => {
        await this.identite.verrouiller(tx, cle);
        const client = await this.identite.clientDuNumero(tx, cle);
        let fiche = client
          ? await tx.crmContact.findUnique({
              where: { customer_id: client.id },
              select: { id: true, status: true, customer_id: true, converted_at: true, entity_status: true },
            })
          : null;
        if (!fiche) {
          const orpheline = await this.identite.ficheDuNumero(tx, cle);
          if (orpheline) {
            if (client) {
              await tx.crmContact.updateMany({
                where: { id: orpheline.id, customer_id: null },
                data: { customer_id: client.id, registered_at: client.created_at },
              });
            }
            fiche = await tx.crmContact.findUnique({
              where: { id: orpheline.id },
              select: { id: true, status: true, customer_id: true, converted_at: true, entity_status: true },
            });
          }
        }

        if (!fiche) {
          // Des captures plus anciennes de ce numéro attendent la reprise : c'est
          // elle qui crée la fiche, avec l'état venu de l'acquisition.
          const enAttente = await tx.prospect.count({
            where: {
              id: { not: capture.id },
              contact_id: null,
              entity_status: { not: EntityStatus.DELETED },
              platform: { in: ['GLOVO', 'YANGO'] },
              phone: { endsWith: cle },
              created_at: { lt: capture.created_at },
            },
          });
          if (enAttente > 0) return null;
          // Client qui a un compte : ce qui est arrivé en premier (inscription,
          // inactivité, capture) donne son public, quel que soit l'ordre des tâches.
          const derniere = client
            ? await tx.order.findFirst({ where: commandeEffective(client.id), orderBy: { created_at: 'desc' }, select: { created_at: true } })
            : null;
          const choix = client
            ? publicALaCapture({
                plateforme: segment,
                capteLe: capture.created_at,
                inscritLe: client.created_at,
                derniereCommande: derniere?.created_at ?? null,
                joursInactivite: jours,
              })
            : { segment, depuis: capture.created_at };
          const [creee] = await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO "CrmContact" ("id", "customer_id", "phone", "phone_key", "name", "registered_at", "segment", "segment_since",
              "last_order_at", "updated_at")
            VALUES (gen_random_uuid(), ${client?.id ?? null}::uuid, ${chiffresTelephone(capture.phone)}, ${cle}, ${nomDeCapture(capture.name)},
              ${client?.created_at ?? null}, ${choix.segment}::"CrmSegment", ${choix.depuis}, ${derniere?.created_at ?? null}, now())
            ON CONFLICT DO NOTHING
            RETURNING "id"`;
          if (!creee) return null; // course perdue : la reprise rattachera
          const entree =
            choix.segment === CrmSegment.JAMAIS_COMMANDE
              ? 'Inscription sans commande'
              : choix.segment === CrmSegment.INACTIF
                ? `Plus aucune commande depuis ${compter(jours, 'jour')}`
                : `Client ${PLATEFORME[capture.platform]} capté en restaurant`;
          await this.events.journaliser([{ contact_id: creee.id, type: CrmEventType.ENTREE, label: entree }], tx);
          fiche = { id: creee.id, status: CrmStatus.A_APPELER, customer_id: client?.id ?? null, converted_at: null, entity_status: EntityStatus.ACTIVE };
        } else if (fiche.status === CrmStatus.CONVERTI && !fiche.customer_id && (await this.inactif(tx, fiche, jours))) {
          // Un client sans compte converti depuis longtemps, revu sur Glovo/Yango :
          // nouveau cycle. Avec un compte, c'est la rechute en inactif (synchronisation
          // qui suit) qui s'en charge, comme pour tout client qui ne commande plus.
          await tx.$executeRawUnsafe(
            `UPDATE "CrmContact" SET ${NOUVEAU_CYCLE_SQL}, "segment" = $2::"CrmSegment", "segment_since" = $3,
               "cycle" = "cycle" + 1, "updated_at" = now()
             WHERE "id" = $1::uuid AND "status" = 'CONVERTI'`,
            fiche.id,
            segment,
            capture.created_at,
          );
        }
        const nom = nomDeCapture(capture.name);
        if (nom) await tx.crmContact.updateMany({ where: { id: fiche.id, name: null }, data: { name: nom } });

        await tx.prospect.updateMany({ where: { id: capture.id, contact_id: null }, data: { contact_id: fiche.id } });
        await this.events.journaliser(
          [
            {
              contact_id: fiche.id,
              type: CrmEventType.CAPTURE,
              label: `Commande ${PLATEFORME[capture.platform]} n° ${capture.order_number} relevée à ${capture.restaurant?.name ?? 'un restaurant'}`.slice(0, 255),
              data: { capture_id: capture.id },
            },
          ],
          tx,
        );
        return fiche.id;
      },
      { maxWait: 2000, timeout: 5000 },
    );
  }

  /** Converti depuis plus longtemps que le délai d'inactivité ? */
  private async inactif(
    tx: Prisma.TransactionClient,
    fiche: { customer_id: string | null; converted_at: Date | null },
    jours: number,
  ): Promise<boolean> {
    const seuil = Date.now() - jours * JOUR;
    if (!fiche.customer_id) return !!fiche.converted_at && fiche.converted_at.getTime() < seuil;
    const derniere = await tx.order.findFirst({
      where: commandeEffective(fiche.customer_id),
      orderBy: { created_at: 'desc' },
      select: { created_at: true },
    });
    const repere = Math.max(derniere?.created_at.getTime() ?? 0, fiche.converted_at?.getTime() ?? 0);
    return repere > 0 && repere < seuil;
  }
}
