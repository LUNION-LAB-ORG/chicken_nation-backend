import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AvisRessenti,
  AvisStatut,
  AvisSuiviType,
  EntityStatus,
  Prisma,
  TicketPriority,
  User,
  UserType,
} from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { ROLES_TRAITEMENT_AVIS } from 'src/modules/auth/constantes/roles-avis-prives';
import { TicketService } from 'src/modules/support/services/ticket.service';
import { AgentAvisDto, CommandeAvisDto, JournalAvisDto, StatutAvisDto, TicketAvisDto } from './avis-prive.dto';
import {
  changementStatut,
  effetsJournal,
  MESSAGE_AGENT,
  MESSAGE_CATEGORIE,
  MESSAGE_COMMANDE_AUTRE,
  MESSAGE_CONFLIT,
  MESSAGE_INTROUVABLE,
  MESSAGE_NON_RAPPROCHE,
  MESSAGE_SANS_COMMANDE,
  messageTicket,
  passageIncident,
  sujetTicket,
  TEXTE_NOTIFICATION_EFFACEE,
  verifierEntreeJournal,
} from './avis-prive.rules';
import { AvisFiche, AvisPriveService } from './avis-prive.service';

/** Au-delà, une demande de ticket restée sans suite (serveur arrêté en route) ne bloque plus. */
const DELAI_DEMANDE_TICKET_MS = 2 * 60_000;

const NON_SUPPRIME = { not: EntityStatus.DELETED } as const;

/**
 * Gestes du personnel sur un avis (contrat 3.3 à 3.8) : journal, statut,
 * commande cochée, agent, ticket, suppression.
 *
 * Tout changement d'état concurrent est un CLAIM : écriture conditionnée sur
 * la valeur lue (`updateMany`), 0 ligne → 409 « L'avis a changé entre-temps ».
 * Sûr à deux serveurs comme à deux agents sur la même fiche.
 */
@Injectable()
export class AvisPriveTraitementService {
  private readonly logger = new Logger(AvisPriveTraitementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly avis: AvisPriveService,
    private readonly tickets: TicketService,
  ) {}

  private auteur(user: User) {
    return { auteur_id: user.id, auteur_nom: user.fullname };
  }

  // ─── Journal (3.3) ────────────────────────────────────────────────────────

  async journal(id: string, dto: JournalAvisDto, user: User, maintenant = new Date()): Promise<AvisFiche> {
    const a = await this.avis.charger(id);
    const entree = verifierEntreeJournal(dto, a.accord_rappel);
    const effets = effetsJournal(a.statut, entree, !!a.premier_contact_at);

    await this.prisma.$transaction(async (tx) => {
      // Une note ne touche pas au statut : elle ne revendique que l'existence
      // de l'avis (sinon elle effacerait le statut posé entre-temps par un
      // collègue). Un appel ou un WhatsApp revendique le statut lu.
      const revendication: Prisma.AvisPriveUpdateManyArgs =
        entree.action === 'NOTE'
          ? { where: { id, entity_status: NON_SUPPRIME }, data: { updated_at: maintenant } }
          : {
              where: { id, statut: a.statut, entity_status: NON_SUPPRIME },
              data: {
                statut: effets.statut,
                updated_at: maintenant,
                ...(effets.tentative ? { tentatives_appel: { increment: 1 } } : {}),
              },
            };
      const pris = await tx.avisPrive.updateMany(revendication);
      if (pris.count === 0) throw new ConflictException(MESSAGE_CONFLIT);
      if (effets.premierContact) {
        // Seul le PREMIER « Joint » tient l'échéance, même à deux agents.
        await tx.avisPrive.updateMany({
          where: { id, premier_contact_at: null },
          data: { premier_contact_at: maintenant },
        });
      }
      await tx.avisPriveSuivi.create({
        data: {
          avis_id: id,
          type: AvisSuiviType[entree.action],
          resultat: entree.resultat,
          note: entree.note,
          statut_avant: a.statut,
          statut_apres: effets.statut,
          ...this.auteur(user),
          created_at: maintenant,
        },
      });
      // Un avis sans agent est confié à qui le traite ; jamais repris à un collègue.
      await tx.avisPrive.updateMany({ where: { id, agent_id: null }, data: { agent_id: user.id } });
    });
    return this.avis.fiche(id, user, maintenant);
  }

  // ─── Statut et clôture (3.4) ──────────────────────────────────────────────

  async statut(id: string, dto: StatutAvisDto, user: User, maintenant = new Date()): Promise<AvisFiche> {
    const a = await this.avis.charger(id);
    if (a.statut !== dto.statut_lu) throw new ConflictException(MESSAGE_CONFLIT);
    const changement = changementStatut({
      actuel: a.statut,
      cible: dto.statut,
      solution: dto.solution,
      accordRappel: a.accord_rappel,
      maintenant,
    });

    await this.prisma.$transaction(async (tx) => {
      const pris = await tx.avisPrive.updateMany({
        where: { id, statut: dto.statut_lu, entity_status: NON_SUPPRIME },
        data: { ...changement, updated_at: maintenant },
      });
      if (pris.count === 0) throw new ConflictException(MESSAGE_CONFLIT);
      await tx.avisPriveSuivi.create({
        data: {
          avis_id: id,
          type: AvisSuiviType.STATUT,
          statut_avant: a.statut,
          statut_apres: changement.statut,
          solution: changement.solution,
          ...this.auteur(user),
          created_at: maintenant,
        },
      });
    });
    return this.avis.fiche(id, user, maintenant);
  }

  // ─── Commande cochée (3.7) ────────────────────────────────────────────────

  /**
   * Revendiquée sur la commande LUE (`order_id_lu`) : un collègue qui a coché
   * une autre commande entre-temps donne un 409, jamais un écrasement muet.
   */
  async commande(id: string, dto: CommandeAvisDto, user: User, maintenant = new Date()): Promise<AvisFiche> {
    const a = await this.avis.charger(id);
    if (a.order_id === dto.order_id) return this.avis.fiche(id, user, maintenant);
    if (a.order_id !== dto.order_id_lu) throw new ConflictException(MESSAGE_CONFLIT);

    let reference: string | null = null;
    if (dto.order_id) {
      if (!a.customer_id) throw new BadRequestException(MESSAGE_NON_RAPPROCHE);
      const commande = await this.prisma.order.findFirst({
        where: { id: dto.order_id, customer_id: a.customer_id, entity_status: NON_SUPPRIME },
        select: { reference: true },
      });
      if (!commande) throw new BadRequestException(MESSAGE_COMMANDE_AUTRE);
      reference = commande.reference;
    }

    await this.prisma.$transaction(async (tx) => {
      const pris = await tx.avisPrive.updateMany({
        where: { id, order_id: dto.order_id_lu, entity_status: NON_SUPPRIME },
        data: { order_id: dto.order_id, updated_at: maintenant },
      });
      if (pris.count === 0) throw new ConflictException(MESSAGE_CONFLIT);
      await tx.avisPriveSuivi.create({
        data: {
          avis_id: id,
          type: AvisSuiviType.COMMANDE,
          meta: reference ? { reference } : Prisma.DbNull,
          ...this.auteur(user),
          created_at: maintenant,
        },
      });
    });
    return this.avis.fiche(id, user, maintenant);
  }

  // ─── Agent (3.7) ──────────────────────────────────────────────────────────

  /**
   * Revendiquée sur l'agent LU (`agent_lu`) : deux agents qui se choisissent
   * à la même seconde, un seul l'emporte, l'autre reçoit un 409.
   */
  async agent(id: string, dto: AgentAvisDto, user: User, maintenant = new Date()): Promise<AvisFiche> {
    const a = await this.avis.charger(id);
    if (a.agent_id === dto.agent_id) return this.avis.fiche(id, user, maintenant);
    if (a.agent_id !== dto.agent_lu) throw new ConflictException(MESSAGE_CONFLIT);

    let nom: string | null = null;
    if (dto.agent_id) {
      const agent = await this.prisma.user.findFirst({
        where: {
          id: dto.agent_id,
          entity_status: EntityStatus.ACTIVE,
          type: UserType.BACKOFFICE,
          role: { in: [...ROLES_TRAITEMENT_AVIS] },
        },
        select: { fullname: true },
      });
      if (!agent) throw new BadRequestException(MESSAGE_AGENT);
      nom = agent.fullname;
    }

    await this.prisma.$transaction(async (tx) => {
      const pris = await tx.avisPrive.updateMany({
        where: { id, agent_id: dto.agent_lu, entity_status: NON_SUPPRIME },
        data: { agent_id: dto.agent_id, updated_at: maintenant },
      });
      if (pris.count === 0) throw new ConflictException(MESSAGE_CONFLIT);
      await tx.avisPriveSuivi.create({
        data: {
          avis_id: id,
          type: AvisSuiviType.AGENT,
          meta: nom ? { agent: nom } : Prisma.DbNull,
          ...this.auteur(user),
          created_at: maintenant,
        },
      });
    });
    return this.avis.fiche(id, user, maintenant);
  }

  // ─── Créer un incident (3.7) ──────────────────────────────────────────────

  /**
   * Ouvre un ticket du module « Messages et tickets », rattaché au client et à
   * la commande cochée (obligatoires, règle des tickets). Un seul clic
   * aboutit : la demande est revendiquée sur l'avis avant la création, ET sur
   * la commande que l'agent a vue dans la fenêtre (`dto.order_id`) : cochée
   * autrement entre-temps par un collègue, 409, aucun ticket.
   */
  async ticket(id: string, dto: TicketAvisDto, user: User, maintenant = new Date()): Promise<AvisFiche> {
    const a = await this.avis.charger(id);
    if (a.ticket_id) throw new ConflictException(MESSAGE_CONFLIT);
    if (!a.customer_id) throw new BadRequestException(MESSAGE_NON_RAPPROCHE);
    if (a.order_id && a.order_id !== dto.order_id) throw new ConflictException(MESSAGE_CONFLIT);
    if (!a.order_id) throw new BadRequestException(MESSAGE_SANS_COMMANDE);

    const categorie = await this.prisma.ticketCategory.findFirst({
      where: { id: dto.categoryId, entity_status: NON_SUPPRIME },
      select: { id: true },
    });
    if (!categorie) throw new NotFoundException(MESSAGE_CATEGORIE);

    const demande = await this.prisma.avisPrive.updateMany({
      where: {
        id,
        order_id: dto.order_id,
        ticket_id: null,
        entity_status: NON_SUPPRIME,
        OR: [
          { ticket_demande_at: null },
          { ticket_demande_at: { lt: new Date(maintenant.getTime() - DELAI_DEMANDE_TICKET_MS) } },
        ],
      },
      data: { ticket_demande_at: maintenant },
    });
    if (demande.count === 0) throw new ConflictException(MESSAGE_CONFLIT);

    const store = a.restaurant?.name ?? null;
    let ticket: { id: string; code: string };
    try {
      ticket = await this.tickets.createTicket({
        subject: sujetTicket(a, store),
        categoryId: categorie.id,
        priority: a.ressenti === AvisRessenti.PAS_CONTENT ? TicketPriority.HIGH : TicketPriority.MEDIUM,
        source: 'avis',
        customerId: a.customer_id,
        orderId: dto.order_id,
        assigneeId: user.id,
      });
    } catch (erreur) {
      await this.prisma.avisPrive.updateMany({
        where: { id, ticket_demande_at: maintenant },
        data: { ticket_demande_at: null },
      });
      if (erreur instanceof HttpException) throw erreur;
      this.logger.error(`Ticket de l'avis ${id} non créé : ${(erreur as Error)?.message ?? erreur}`);
      throw new InternalServerErrorException("Le ticket n'a pas pu être créé.");
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.ticketMessage.create({
        data: {
          ticketId: ticket.id,
          authorUserId: user.id,
          body: messageTicket(a, store),
          internal: true,
          meta: { avis_id: id },
        },
      });
      // Statut lu inchangé : « Incident ouvert ». Changé entre-temps par un
      // collègue : son statut reste, le ticket est rattaché quand même.
      const incident = passageIncident(a.statut);
      const lie = await tx.avisPrive.updateMany({
        where: { id, statut: a.statut, ticket_id: null },
        data: { ...incident, ticket_id: ticket.id, ticket_demande_at: null, updated_at: maintenant },
      });
      let statutApres: AvisStatut | null = incident.statut;
      if (lie.count === 0) {
        await tx.avisPrive.updateMany({
          where: { id, ticket_id: null },
          data: { ticket_id: ticket.id, ticket_demande_at: null, updated_at: maintenant },
        });
        statutApres = null;
      }
      await tx.avisPriveSuivi.create({
        data: {
          avis_id: id,
          type: AvisSuiviType.INCIDENT,
          statut_avant: a.statut,
          statut_apres: statutApres,
          meta: { code: ticket.code, ticket_id: ticket.id },
          ...this.auteur(user),
          created_at: maintenant,
        },
      });
    });
    return this.avis.fiche(id, user, maintenant);
  }

  // ─── Suppression (3.8) ────────────────────────────────────────────────────

  /**
   * Droit à l'effacement (« Pour le faire supprimer : 27 21 71 21 30 ») :
   * suppression logique ET effacement du contenu personnel, dans la même
   * transaction : commentaire, numéro, prénom, lien client et commande, notes
   * et données du journal, texte des notifications de la cloche. La ligne
   * garde date, ressenti, store, statut et qui a supprimé. Le ticket éventuel
   * vit dans son module, inchangé.
   */
  async supprimer(id: string, user: User, maintenant = new Date()): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const pris = await tx.avisPrive.updateMany({
        where: { id, entity_status: NON_SUPPRIME },
        data: {
          entity_status: EntityStatus.DELETED,
          supprime_at: maintenant,
          supprime_par_id: user.id,
          commentaire: '',
          telephone: null,
          prenom: null,
          customer_id: null,
          rapproche_at: null,
          order_id: null,
          updated_at: maintenant,
        },
      });
      if (pris.count === 0) throw new NotFoundException(MESSAGE_INTROUVABLE);
      await tx.avisPriveSuivi.updateMany({ where: { avis_id: id }, data: { note: null, meta: Prisma.DbNull } });
      await tx.avisPriveSuivi.create({
        data: { avis_id: id, type: AvisSuiviType.SUPPRESSION, ...this.auteur(user), created_at: maintenant },
      });
      await tx.notification.updateMany({
        where: { data: { path: ['avis_id'], equals: id } },
        data: { message: TEXTE_NOTIFICATION_EFFACEE },
      });
    });
  }
}
