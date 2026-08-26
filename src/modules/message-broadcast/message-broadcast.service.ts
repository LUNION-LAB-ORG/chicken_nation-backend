import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PrismaService } from 'src/database/services/prisma.service';
import {
  CriteresAudience,
  CustomerAudienceService,
} from 'src/common/services/customer-audience.service';
import { ApercuAudienceDto, CreerDiffusionDto } from './dto/message-broadcast.dto';

/** Taille d'un lot confié à la file. Assez petit pour qu'un incident coûte peu. */
export const TAILLE_LOT = 100;

/** Au-delà, un destinataire réservé est considéré comme abandonné et repris. */
export const DELAI_REPRISE_MS = 5 * 60 * 1000;

@Injectable()
export class MessageBroadcastService {
  private readonly logger = new Logger(MessageBroadcastService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audience: CustomerAudienceService,
    @InjectQueue('message-broadcast') private readonly file: Queue,
  ) {}

  /**
   * Clients visés par un ciblage donné.
   *
   * ⚠️ Aucune joignabilité n'est exigée : un message s'écrit en base, le client
   * le lira en ouvrant l'application. C'est toute la différence avec une
   * notification push, qui a besoin d'un jeton et dont le compteur d'audience
   * écarte donc les clients sans jeton. Utiliser ici le compteur du module push
   * afficherait un effectif amputé, sans que personne ne comprenne pourquoi.
   */
  async resoudreCible(target_type: string, target_config: Record<string, any>): Promise<string[]> {
    if (target_type === 'all') {
      return this.audience.resoudre({});
    }

    if (target_type === 'ids') {
      const ids = Array.isArray(target_config?.ids) ? target_config.ids : [];
      if (ids.length === 0) return [];
      // On repasse par la base : un identifiant obsolète ou un compte supprimé
      // ne doit pas devenir un destinataire fantôme, bloqué à jamais en attente.
      const clients = await this.prisma.customer.findMany({
        where: { id: { in: ids }, entity_status: 'ACTIVE' },
        select: { id: true },
      });
      return clients.map((c) => c.id);
    }

    if (target_type === 'segment') {
      const cle = String(target_config?.segment ?? '');
      const criteres = await this.criteresDuSegment(cle);
      return this.audience.resoudre(criteres);
    }

    throw new BadRequestException(`Ciblage inconnu : ${target_type}`);
  }

  /** Compte sans rien écrire, pour l'aperçu de l'écran de création. */
  async apercu(dto: ApercuAudienceDto): Promise<{ total: number }> {
    const ids = await this.resoudreCible(dto.target_type, dto.target_config);
    return { total: ids.length };
  }

  /**
   * Crée la diffusion et MATÉRIALISE ses destinataires.
   *
   * L'audience est figée à cet instant : un client qui remplira le segment
   * demain ne recevra pas une diffusion partie aujourd'hui. C'est le seul moyen
   * d'avoir un rapport d'envoi qui veut dire quelque chose, et de pouvoir
   * reprendre un envoi interrompu sans recalculer une cible qui a bougé.
   */
  async creer(dto: CreerDiffusionDto, auteur: string) {
    const ids = await this.resoudreCible(dto.target_type, dto.target_config);
    if (ids.length === 0) {
      throw new BadRequestException("Ce ciblage ne désigne aucun client. Rien à envoyer.");
    }

    const diffusion = await this.prisma.messageBroadcast.create({
      data: {
        name: dto.name.trim(),
        body: dto.body.trim(),
        target_type: dto.target_type,
        target_config: dto.target_config as any,
        status: dto.scheduled_at ? 'scheduled' : 'draft',
        scheduled_at: dto.scheduled_at ? new Date(dto.scheduled_at) : null,
        total_targeted: ids.length,
        created_by: auteur,
      },
    });

    // `skipDuplicates` avec l'index unique (broadcast_id, customer_id) : une
    // reprise de cette étape ne peut pas dédoubler l'audience.
    for (let i = 0; i < ids.length; i += 500) {
      await this.prisma.messageBroadcastRecipient.createMany({
        data: ids.slice(i, i + 500).map((customer_id) => ({
          broadcast_id: diffusion.id,
          customer_id,
        })),
        skipDuplicates: true,
      });
    }

    return this.detail(diffusion.id);
  }

  /**
   * Lance l'envoi.
   *
   * Le passage à `sending` est un CLAIM ATOMIQUE : deux clics, ou deux
   * instances du backend, ne peuvent pas lancer la même diffusion deux fois.
   * `enqueue_seq` est incrémenté au passage et entre dans l'identifiant de
   * tâche : sans lui, une relance réutiliserait le même identifiant et BullMQ
   * l'avalerait en silence, sans erreur, sans tâche créée, et des centaines de
   * clients ne recevraient rien.
   */
  async envoyer(id: string) {
    const claim = await this.prisma.messageBroadcast.updateMany({
      where: { id, status: { in: ['draft', 'scheduled'] } },
      data: { status: 'sending', started_at: new Date(), enqueue_seq: { increment: 1 } },
    });
    if (claim.count === 0) {
      throw new BadRequestException(
        "Cette diffusion est déjà partie ou en cours d'envoi.",
      );
    }
    return this.enfiler(id);
  }

  /**
   * Reprend une diffusion restée en cours.
   *
   * Indispensable, et pas seulement confortable : la file vit dans Redis, qui
   * n'a pas la persistance activée dans ce déploiement. Un redémarrage de Redis
   * fait disparaître le reste à envoyer sans que rien ne le signale. La base,
   * elle, sait toujours qui n'a pas reçu.
   */
  async reprendre(id: string) {
    const diffusion = await this.prisma.messageBroadcast.findUnique({ where: { id } });
    if (!diffusion) throw new NotFoundException('Diffusion introuvable');
    /**
     * ⚠️ `sent` est accepté, et c'est volontaire.
     *
     * Une diffusion où mille messages sont partis et trois ont échoué est
     * « envoyée », c'est le bon statut. Mais refuser de la reprendre
     * condamnerait ces trois clients à ne jamais rien recevoir, alors que la
     * machinerie sait très bien les traiter. On vérifie donc qu'il reste
     * quelque chose à faire, pas que le statut soit un échec.
     */
    if (!['sending', 'failed', 'sent'].includes(diffusion.status)) {
      throw new BadRequestException("Cette diffusion n'est pas à reprendre.");
    }
    const aFaire = await this.prisma.messageBroadcastRecipient.count({
      where: { broadcast_id: id, status: { in: ['pending', 'sending', 'failed'] } },
    });
    if (aFaire === 0) {
      throw new BadRequestException('Tous les destinataires ont déjà reçu ce message.');
    }
    await this.prisma.messageBroadcast.update({
      where: { id },
      data: { status: 'sending', enqueue_seq: { increment: 1 } },
    });
    return this.enfiler(id);
  }

  /** Découpe le reste à envoyer en lots et les confie à la file. */
  private async enfiler(id: string) {
    const diffusion = await this.prisma.messageBroadcast.findUnique({
      where: { id },
      select: { id: true, enqueue_seq: true },
    });
    if (!diffusion) throw new NotFoundException('Diffusion introuvable');

    const restants = await this.prisma.messageBroadcastRecipient.findMany({
      where: {
        broadcast_id: id,
        OR: [
          { status: 'pending' },
          // Réservés puis abandonnés : un processus tombé en cours de lot les
          // laisserait sinon en attente pour toujours.
          { status: 'sending', claimed_at: { lt: new Date(Date.now() - DELAI_REPRISE_MS) } },
          { status: 'failed' },
        ],
      },
      select: { id: true },
      orderBy: { created_at: 'asc' },
    });

    if (restants.length === 0) {
      await this.cloturerSiTermine(id);
      return this.detail(id);
    }

    /**
     * ⚠️ Les destinataires repris repassent en `pending` AVANT la mise en file.
     *
     * `cloturerSiTermine` est appelée à la fin de CHAQUE lot et ne compte que
     * `pending` et `sending`. Sans cette remise à zéro, une reprise de plus de
     * cent échecs se clôturerait dès la fin du premier lot, la diffusion
     * passerait pour terminée, et tout destinataire qui échouerait dans les
     * lots suivants serait gelé pour de bon.
     */
    await this.prisma.messageBroadcastRecipient.updateMany({
      where: { id: { in: restants.map((r) => r.id) } },
      data: { status: 'pending', claimed_at: null },
    });

    for (let i = 0; i < restants.length; i += TAILLE_LOT) {
      const lot = restants.slice(i, i + TAILLE_LOT).map((r) => r.id);
      await this.file.add(
        'lot',
        { broadcastId: id, recipientIds: lot },
        {
          // ⚠️ Le caractère « : » est proscrit dans un identifiant de tâche.
          jobId: `broadcast-${id}-run-${diffusion.enqueue_seq}-lot-${i / TAILLE_LOT}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
    }

    this.logger.log(
      `Diffusion ${id} : ${restants.length} destinataires confiés à la file (passage ${diffusion.enqueue_seq})`,
    );
    return this.detail(id);
  }

  /**
   * Clôture quand plus rien n'est en attente.
   *
   * ⚠️ Une diffusion dont TOUS les envois ont échoué ne passe pas pour
   * « Envoyée ». Le statut est le premier coup d'oeil du gestionnaire : lui
   * afficher « Envoyée » sur zéro message parti serait le laisser croire que
   * sa campagne est passée. Elle bascule en « Échouée », et le bouton Reprendre
   * reste offert.
   */
  async cloturerSiTermine(id: string) {
    const restants = await this.prisma.messageBroadcastRecipient.count({
      where: { broadcast_id: id, status: { in: ['pending', 'sending'] } },
    });
    if (restants > 0) return;

    const envoyes = await this.prisma.messageBroadcastRecipient.count({
      where: { broadcast_id: id, status: 'sent' },
    });

    await this.prisma.messageBroadcast.updateMany({
      where: { id, status: 'sending' },
      data:
        envoyes > 0
          ? { status: 'sent', sent_at: new Date() }
          : { status: 'failed' },
    });
  }

  /**
   * Détail et compteurs.
   *
   * ⚠️ Les compteurs sont DÉRIVÉS d'un `count()`, jamais stockés ni incrémentés.
   * Un compteur incrémenté en fin de lot dérive à la baisse au premier
   * redémarrage : le seul instrument de contrôle de l'opérateur se mettrait
   * alors à mentir, silencieusement.
   */
  async detail(id: string) {
    const diffusion = await this.prisma.messageBroadcast.findUnique({ where: { id } });
    if (!diffusion) throw new NotFoundException('Diffusion introuvable');

    const parStatut = await this.prisma.messageBroadcastRecipient.groupBy({
      by: ['status'],
      where: { broadcast_id: id },
      _count: { _all: true },
    });
    const compteur = (statut: string) =>
      parStatut.find((p) => p.status === statut)?._count._all ?? 0;

    return {
      ...diffusion,
      stats: {
        cibles: diffusion.total_targeted,
        envoyes: compteur('sent'),
        en_attente: compteur('pending') + compteur('sending'),
        echecs: compteur('failed'),
      },
    };
  }

  async lister(status?: string) {
    const diffusions = await this.prisma.messageBroadcast.findMany({
      where: status ? { status } : undefined,
      orderBy: { created_at: 'desc' },
      take: 100,
    });
    if (diffusions.length === 0) return { data: [], meta: { total: 0 } };

    /**
     * ⚠️ Les compteurs sont joints à la LISTE, en une seule requête groupée.
     *
     * L'écran décide d'afficher le bouton « Reprendre » à partir du nombre
     * d'échecs. Sans ces compteurs ici, la condition portait sur une valeur
     * toujours absente : le bouton ne se serait jamais affiché, et une
     * diffusion interrompue serait restée sans issue.
     */
    const parStatut = await this.prisma.messageBroadcastRecipient.groupBy({
      by: ['broadcast_id', 'status'],
      where: { broadcast_id: { in: diffusions.map((d) => d.id) } },
      _count: { _all: true },
    });

    const data = diffusions.map((d) => {
      const lignes = parStatut.filter((p) => p.broadcast_id === d.id);
      const compteur = (statut: string) =>
        lignes.find((l) => l.status === statut)?._count._all ?? 0;
      return {
        ...d,
        stats: {
          cibles: d.total_targeted,
          envoyes: compteur('sent'),
          en_attente: compteur('pending') + compteur('sending'),
          echecs: compteur('failed'),
        },
      };
    });

    return { data, meta: { total: data.length } };
  }

  /**
   * Critères d'un segment, système ou enregistré.
   *
   * La table des segments est celle du module push, et c'est voulu : un segment
   * est une définition de population, pas de canal. « VIP Abidjan » veut dire la
   * même chose qu'on l'atteigne par notification ou par message. Le dupliquer
   * obligerait le marketing à maintenir la même définition deux fois.
   */
  private async criteresDuSegment(cle: string): Promise<CriteresAudience> {
    if (!cle) throw new BadRequestException('Segment non précisé');

    const SYSTEME: Record<string, CriteresAudience> = {
      all: {},
      vip: { loyalty_level: 'VIP' },
      vvip: { loyalty_level: 'VVIP' },
      standard: { loyalty_level: 'STANDARD' },
      inactive_30d: { no_order_days: 30 },
      inactive_90d: { no_order_days: 90 },
      recent_30d: { last_order_days: 30 },
    };
    // ⚠️ `hasOwnProperty`, et surtout pas `SYSTEME[cle]`. Un objet littéral
    // hérite de `Object.prototype` : `segment: '__proto__'` renvoyait une
    // valeur héritée, traitée comme des critères vides, et la diffusion partait
    // à TOUTE la base en s'affichant « par segment ».
    if (Object.prototype.hasOwnProperty.call(SYSTEME, cle)) return SYSTEME[cle];

    const id = cle.startsWith('custom_') ? cle.slice('custom_'.length) : cle;
    const segment = await this.prisma.pushSegment.findUnique({ where: { id } });
    if (!segment) {
      throw new BadRequestException(
        "Ce segment n'existe plus. Choisissez-en un autre avant d'envoyer.",
      );
    }
    return (segment.filters ?? {}) as CriteresAudience;
  }
}
