import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AvisStatut,
  AvisSuiviType,
  EntityStatus,
  IncidentGeste,
  IncidentPole,
  IncidentStatut,
  IncidentSuiviType,
  Prisma,
  User,
  UserType,
  VoucherStatus,
} from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { ROLES_SIEGE_INCIDENT } from 'src/modules/auth/constantes/roles-incidents';
import { changementStatut, passageIncident } from 'src/modules/customer/avis-prives/avis-prive.rules';
import { VoucherService } from 'src/modules/voucher/voucher.service';
import { TwilioService } from 'src/twilio/services/twilio.service';
import { IncidentAlertesService } from './incident-alertes.service';
import {
  AssignerIncidentDto,
  CloturerIncidentDto,
  NoteIncidentDto,
  ResoudreIncidentDto,
  RouvrirIncidentDto,
  SignalerIncidentDto,
} from './incident.dto';
import {
  LienOrigine,
  MESSAGE_AGENT,
  MESSAGE_AVIS_COMMANDE,
  MESSAGE_AVIS_DEJA,
  MESSAGE_AVIS_SIEGE,
  MESSAGE_BON_ABSENT,
  MESSAGE_BON_ECHEC,
  MESSAGE_BON_EN_COURS,
  MESSAGE_BON_INTERDIT,
  MESSAGE_BON_SANS_OBJET,
  MESSAGE_CATEGORIE,
  MESSAGE_COMMANDE_AUTRE,
  MESSAGE_CONFLIT,
  MESSAGE_DOUBLON,
  MESSAGE_DROIT,
  MESSAGE_LIEN,
  MESSAGE_NOTE_DEJA,
  MESSAGE_ORIGINE,
  MESSAGE_SMS_ECHEC,
  MESSAGE_SMS_RECENT,
  MESSAGE_STATUT,
  ReglagesIncident,
  STATUTS_A_RESOUDRE,
  STATUTS_NON_CLOTURES,
  codeIncident,
  droitsIncident,
  echeance,
  estCompteRestaurant,
  estSiegeIncident,
  expirationBon,
  formatJour,
  numeroSuivant,
  origineRetenue,
  peutSignaler,
  peutTraiterIncident,
  prefixeCode,
  saisirDescription,
  saisirMotif,
  saisirNote,
  solutionAvis,
  texteSmsBon,
  verifierCloture,
  verifierResolution,
} from './incident.rules';
import { IncidentComplet, IncidentFiche, IncidentService } from './incident.service';

/** Nouveaux essais quand le code du jour est pris au même instant. */
const ESSAIS_CODE = 4;
/** Au-delà, une création de bon restée sans suite (serveur arrêté en route) ne bloque plus. */
const DELAI_DEMANDE_BON_MS = 2 * 60_000;
/** Deux SMS du même bon ne partent pas à moins de deux minutes d'écart. */
const DELAI_ENTRE_SMS_MS = 2 * 60_000;

const CODE_DOUBLON = 'INCIDENT_DOUBLON';

/** Contrainte d'unicité violée : son nom ou ses colonnes, sinon null. */
function uniciteViolee(erreur: unknown): string | null {
  if (!(erreur instanceof Prisma.PrismaClientKnownRequestError) || erreur.code !== 'P2002') return null;
  return JSON.stringify(erreur.meta?.target ?? '');
}

/**
 * Écritures des incidents sur commande : signaler, prendre en charge ou
 * confier, résoudre (avec le bon), clôturer, rouvrir, noter.
 *
 * Chaque geste part de l'état que l'agent avait sous les yeux (`statut_lu`)
 * et s'écrit par une mise à jour conditionnée : deux gestes lancés ensemble
 * n'aboutissent pas tous les deux. Les droits sont ceux de
 * `incident.rules.ts`, relus sur l'incident chargé.
 */
@Injectable()
export class IncidentTraitementService {
  private readonly logger = new Logger(IncidentTraitementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly incidents: IncidentService,
    private readonly vouchers: VoucherService,
    private readonly twilio: TwilioService,
    private readonly alertes: IncidentAlertesService,
  ) {}

  private auteur(user: User) {
    return { auteur_id: user.id, auteur_nom: user.fullname };
  }

  private exigerStatutLu(i: { statut: IncidentStatut }, lu: IncidentStatut): void {
    if (i.statut !== lu) throw new ConflictException(MESSAGE_CONFLIT);
  }

  /** Geste refusé : l'incident a avancé (409), ou ce compte n'y a pas droit (403). */
  private refuser(permisParLeStatut: boolean): never {
    if (!permisParLeStatut) throw new ConflictException(MESSAGE_STATUT);
    throw new ForbiddenException(MESSAGE_DROIT);
  }

  // ─── Signaler ───────────────────────────────────────────────────────────────

  /**
   * Ouvre un incident sur une commande. Le responsable et l'échéance viennent
   * de la catégorie ; l'origine, du lien (ticket, avis, note) ou du choix de
   * l'agent. Un seul incident non clôturé par commande et par catégorie : le
   * second signalement reçoit le premier (409 `INCIDENT_DOUBLON`).
   */
  async signaler(dto: SignalerIncidentDto, user: User, maintenant = new Date()): Promise<IncidentFiche> {
    const commande = await this.incidents.commande(dto.order_id);
    if (!peutSignaler(user, commande.restaurant_id)) {
      throw new ForbiddenException(estCompteRestaurant(user) ? MESSAGE_COMMANDE_AUTRE : MESSAGE_DROIT);
    }
    const description = saisirDescription(dto.description);
    if ('refus' in description) throw new BadRequestException(description.refus);

    const categorie = await this.prisma.incidentCategorie.findFirst({
      where: { id: dto.categorie_id, actif: true },
      select: { id: true, pole: true, delai_heures: true },
    });
    if (!categorie) throw new NotFoundException(MESSAGE_CATEGORIE);

    const lien: LienOrigine = dto.ticket_id ? 'ticket' : dto.avis_id ? 'avis' : dto.comment_id ? 'note' : null;
    const origine = origineRetenue(lien, dto.origine);
    if (!origine) throw new BadRequestException(MESSAGE_ORIGINE);
    const avis = await this.verifierLiens(dto, user);

    await this.refuserDoublon(dto.order_id, categorie.id);

    let cree: { id: string } | null = null;
    for (let essai = 0; essai < ESSAIS_CODE && !cree; essai++) {
      const prefixe = prefixeCode(maintenant);
      const dernier = await this.prisma.incident.findFirst({
        where: { code: { startsWith: prefixe } },
        orderBy: { code: 'desc' },
        select: { code: true },
      });
      const code = codeIncident(maintenant, numeroSuivant(dernier?.code));
      try {
        cree = await this.prisma.$transaction(async (tx) => {
          const incident = await tx.incident.create({
            data: {
              code,
              statut: IncidentStatut.OUVERT,
              gravite: dto.gravite,
              origine,
              categorie_id: categorie.id,
              description: description.texte,
              order_id: commande.id,
              restaurant_id: commande.restaurant_id,
              customer_id: commande.customer_id,
              ticket_id: dto.ticket_id ?? null,
              avis_id: dto.avis_id ?? null,
              comment_id: dto.comment_id ?? null,
              pole: categorie.pole,
              echeance_at: echeance(maintenant, categorie.delai_heures),
              signale_par_id: user.id,
              signale_par_nom: user.fullname,
              created_at: maintenant,
            },
            select: { id: true },
          });
          await tx.incidentSuivi.create({
            data: {
              incident_id: incident.id,
              type: IncidentSuiviType.CREATION,
              statut_apres: IncidentStatut.OUVERT,
              meta: { origine },
              ...this.auteur(user),
              created_at: maintenant,
            },
          });
          if (avis) {
            // L'avis passe « Incident ouvert » ; changé entre-temps par un
            // collègue, son statut reste, l'incident est rattaché quand même.
            const passage = passageIncident(avis.statut);
            const lie = await tx.avisPrive.updateMany({
              where: { id: avis.id, statut: avis.statut },
              data: { ...passage, updated_at: maintenant },
            });
            await tx.avisPriveSuivi.create({
              data: {
                avis_id: avis.id,
                type: AvisSuiviType.INCIDENT,
                statut_avant: avis.statut,
                statut_apres: lie.count > 0 ? passage.statut : null,
                meta: { code, incident_id: incident.id },
                ...this.auteur(user),
                created_at: maintenant,
              },
            });
          }
          return incident;
        });
      } catch (erreur) {
        const cible = uniciteViolee(erreur);
        if (cible === null) throw erreur;
        if (cible.includes('comment')) throw new ConflictException(MESSAGE_NOTE_DEJA);
        if (cible.includes('code')) continue;
        // Index unique « un incident non clôturé par commande et par catégorie ».
        await this.refuserDoublon(dto.order_id, categorie.id);
        throw new ConflictException(MESSAGE_DOUBLON);
      }
    }
    if (!cree) throw new InternalServerErrorException("L'incident n'a pas pu être enregistré. Réessayez.");

    const incident = await this.incidents.charger(cree.id);
    this.alertes.diffuser(incident);
    await this.alertes.nouveau(incident, user.id);
    return this.incidents.fiche(cree.id, user, maintenant);
  }

  private async refuserDoublon(orderId: string, categorieId: string): Promise<void> {
    const existant = await this.prisma.incident.findFirst({
      where: { order_id: orderId, categorie_id: categorieId, statut: { in: STATUTS_NON_CLOTURES } },
      select: { id: true, code: true },
    });
    if (existant) {
      throw new ConflictException({ message: MESSAGE_DOUBLON, code: CODE_DOUBLON, incident: existant });
    }
  }

  /**
   * Le ticket, l'avis ou la note d'où vient le signalement doit exister et
   * porter sur la commande choisie. Renvoie l'avis à passer « Incident
   * ouvert », s'il y en a un.
   */
  private async verifierLiens(
    dto: SignalerIncidentDto,
    user: User,
  ): Promise<{ id: string; statut: AvisStatut } | null> {
    if (dto.ticket_id) {
      const ticket = await this.prisma.ticketThread.findUnique({
        where: { id: dto.ticket_id },
        select: { id: true, orderId: true },
      });
      if (!ticket) throw new NotFoundException('Ticket introuvable.');
      if (ticket.orderId && ticket.orderId !== dto.order_id) throw new BadRequestException(MESSAGE_LIEN);
    }
    if (dto.comment_id) {
      const note = await this.prisma.comment.findUnique({
        where: { id: dto.comment_id },
        select: { id: true, order_id: true },
      });
      if (!note) throw new NotFoundException('Note introuvable.');
      if (note.order_id !== dto.order_id) throw new BadRequestException(MESSAGE_LIEN);
      const deja = await this.prisma.incident.findFirst({
        where: { comment_id: dto.comment_id },
        select: { id: true, code: true },
      });
      if (deja) throw new ConflictException({ message: MESSAGE_NOTE_DEJA, code: CODE_DOUBLON, incident: deja });
    }
    if (!dto.avis_id) return null;
    // Les retours privés se traitent au siège (administrateur, call center).
    if (!estSiegeIncident(user)) throw new ForbiddenException(MESSAGE_AVIS_SIEGE);
    const avis = await this.prisma.avisPrive.findFirst({
      where: { id: dto.avis_id, entity_status: { not: EntityStatus.DELETED } },
      select: { id: true, statut: true, order_id: true },
    });
    if (!avis) throw new NotFoundException('Avis introuvable.');
    if (!avis.order_id) throw new BadRequestException(MESSAGE_AVIS_COMMANDE);
    if (avis.order_id !== dto.order_id) throw new BadRequestException(MESSAGE_LIEN);
    const deja = await this.prisma.incident.findFirst({
      where: { avis_id: dto.avis_id, statut: { in: STATUTS_NON_CLOTURES } },
      select: { id: true, code: true },
    });
    if (deja) throw new ConflictException({ message: MESSAGE_AVIS_DEJA, code: CODE_DOUBLON, incident: deja });
    return { id: avis.id, statut: avis.statut };
  }

  // ─── Prendre en charge, confier ─────────────────────────────────────────────

  /**
   * Sans responsable ni agent dans le corps : « Prendre en charge » (En
   * cours, à mon nom). Sinon le siège change le responsable ou l'agent ;
   * l'incident passe En cours dès qu'une personne en répond.
   */
  async assigner(id: string, dto: AssignerIncidentDto, user: User, maintenant = new Date()): Promise<IncidentFiche> {
    const i = await this.incidents.chargerVisible(id, user);
    this.exigerStatutLu(i, dto.statut_lu);
    const droits = droitsIncident(user, i, { bon_restaurant: false });
    const aResoudre = STATUTS_A_RESOUDRE.includes(i.statut);
    const prise = dto.pole === undefined && dto.agent_id === undefined;

    let data: Prisma.IncidentUncheckedUpdateManyInput;
    let meta: Prisma.InputJsonObject;
    let poleChange = false;
    if (prise) {
      if (!droits.prendre) this.refuser(aResoudre);
      data = { statut: IncidentStatut.EN_COURS, agent_id: user.id, assigne_at: maintenant };
      meta = { prise: true };
    } else {
      if (!droits.assigner) this.refuser(aResoudre);
      const pole = dto.pole ?? i.pole;
      poleChange = pole !== i.pole;
      let agentId = dto.agent_id === undefined ? i.agent_id : dto.agent_id;
      let agentNom: string | null = dto.agent_id === undefined ? (i.agent?.fullname ?? null) : null;
      if (dto.agent_id) {
        const agent = await this.prisma.user.findFirst({
          where: {
            id: dto.agent_id,
            entity_status: EntityStatus.ACTIVE,
            type: UserType.BACKOFFICE,
            role: { in: [...ROLES_SIEGE_INCIDENT] },
          },
          select: { id: true, fullname: true },
        });
        if (!agent) throw new BadRequestException(MESSAGE_AGENT);
        agentId = agent.id;
        agentNom = agent.fullname;
      }
      // Un incident confié au restaurant ou à la livraison n'a plus d'agent du siège par défaut.
      if (poleChange && dto.agent_id === undefined) {
        agentId = null;
        agentNom = null;
      }
      data = {
        pole,
        agent_id: agentId,
        assigne_at: maintenant,
        statut: agentId ? IncidentStatut.EN_COURS : IncidentStatut.OUVERT,
      };
      meta = { pole, agent: agentNom };
    }

    const statutApres = data.statut as IncidentStatut;
    await this.prisma.$transaction(async (tx) => {
      const ecrit = await tx.incident.updateMany({ where: { id, statut: i.statut }, data });
      if (ecrit.count === 0) throw new ConflictException(MESSAGE_CONFLIT);
      await tx.incidentSuivi.create({
        data: {
          incident_id: id,
          type: IncidentSuiviType.ASSIGNATION,
          statut_avant: i.statut,
          statut_apres: statutApres,
          meta,
          ...this.auteur(user),
          created_at: maintenant,
        },
      });
    });

    this.alertes.diffuser({ ...i, statut: statutApres });
    if (poleChange) {
      await this.alertes.nouveau({ ...i, pole: data.pole as IncidentPole }, user.id);
    }
    return this.incidents.fiche(id, user, maintenant);
  }

  // ─── Résoudre ───────────────────────────────────────────────────────────────

  /**
   * Résolu : cause, action corrective et geste pour le client. Un bon de
   * réduction est créé aussitôt et son code part par SMS ; s'il ne peut pas
   * l'être, l'incident reste résolu et la fiche propose « Créer le bon ».
   */
  async resoudre(id: string, dto: ResoudreIncidentDto, user: User, maintenant = new Date()): Promise<IncidentFiche> {
    const i = await this.incidents.chargerVisible(id, user);
    this.exigerStatutLu(i, dto.statut_lu);
    const reglages = await this.incidents.reglages();
    const droits = droitsIncident(user, i, reglages);
    if (!droits.resoudre) this.refuser(STATUTS_A_RESOUDRE.includes(i.statut));

    const resolution = verifierResolution(dto, {
      peutOffrirBon: droits.bon,
      bareme: reglages.bareme,
      bonExistant: i.voucher ? i.voucher.initial_amount : null,
    });
    if ('refus' in resolution) throw new BadRequestException(resolution.refus);

    await this.prisma.$transaction(async (tx) => {
      const ecrit = await tx.incident.updateMany({
        where: { id, statut: i.statut },
        data: {
          statut: IncidentStatut.RESOLU,
          cause: resolution.cause,
          action: resolution.action,
          geste: resolution.geste,
          bon_montant: resolution.bon_montant,
          resolu_at: maintenant,
          resolu_par_id: user.id,
          resolu_par_nom: user.fullname,
          // Qui résout sans que personne ait pris l'incident en répond.
          agent_id: i.agent_id ?? user.id,
          assigne_at: i.assigne_at ?? maintenant,
        },
      });
      if (ecrit.count === 0) throw new ConflictException(MESSAGE_CONFLIT);
      await tx.incidentSuivi.create({
        data: {
          incident_id: id,
          type: IncidentSuiviType.RESOLUTION,
          statut_avant: i.statut,
          statut_apres: IncidentStatut.RESOLU,
          meta: { geste: resolution.geste },
          ...this.auteur(user),
          created_at: maintenant,
        },
      });
    });

    if (resolution.geste === IncidentGeste.BON && !i.voucher_id) {
      await this.emettreBon(id, user, maintenant, reglages);
    }
    this.alertes.diffuser({ ...i, statut: IncidentStatut.RESOLU });
    await this.alertes.resolu({ ...i, geste: resolution.geste }, user.id);
    return this.incidents.fiche(id, user, maintenant);
  }

  // ─── Bon de réduction ───────────────────────────────────────────────────────

  /**
   * Crée le bon d'achat du client, une seule fois par incident : la création
   * est revendiquée sur l'incident avant d'appeler le module des bons. Un
   * échec libère la revendication et laisse une ligne au journal.
   */
  private async emettreBon(
    id: string,
    user: User,
    maintenant: Date,
    reglages: ReglagesIncident,
  ): Promise<'cree' | 'pris' | 'echec'> {
    const demande = await this.prisma.incident.updateMany({
      where: {
        id,
        geste: IncidentGeste.BON,
        voucher_id: null,
        bon_montant: { not: null },
        OR: [{ bon_demande_at: null }, { bon_demande_at: { lt: new Date(maintenant.getTime() - DELAI_DEMANDE_BON_MS) } }],
      },
      data: { bon_demande_at: maintenant },
    });
    if (demande.count === 0) return 'pris';

    const i = await this.prisma.incident.findFirst({
      where: { id },
      select: { id: true, code: true, customer_id: true, bon_montant: true, customer: { select: { phone: true } } },
    });
    const expire = expirationBon(maintenant, reglages.validite_jours);
    let bon: { id: string; code: string };
    try {
      if (!i || !i.bon_montant) throw new Error('incident sans montant de bon');
      bon = await this.vouchers.createForCustomer({
        customerId: i.customer_id,
        amount: i.bon_montant,
        createdBy: user.id,
        expiresAt: expire,
      });
    } catch (erreur) {
      this.logger.error(`Bon de l'incident ${id} non créé : ${(erreur as Error)?.message ?? erreur}`);
      await this.prisma.incident.updateMany({ where: { id, bon_demande_at: maintenant }, data: { bon_demande_at: null } });
      await this.prisma.incidentSuivi.create({
        data: { incident_id: id, type: IncidentSuiviType.BON, meta: {}, created_at: maintenant },
      });
      return 'echec';
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.incident.updateMany({ where: { id }, data: { voucher_id: bon.id, bon_demande_at: null } });
      await tx.incidentSuivi.create({
        data: {
          incident_id: id,
          type: IncidentSuiviType.BON,
          meta: { code: bon.code, montant: i!.bon_montant, expire: formatJour(expire) },
          ...this.auteur(user),
          created_at: maintenant,
        },
      });
    });
    await this.envoyerSmsBon(
      { id, telephone: i!.customer.phone, montant: i!.bon_montant!, code: bon.code, expire },
      maintenant,
    );
    return 'cree';
  }

  /** SMS du code. Jamais d'exception : le résultat est écrit sur l'incident et au journal. */
  private async envoyerSmsBon(
    p: { id: string; telephone: string | null; montant: number; code: string; expire: Date },
    maintenant: Date,
  ): Promise<boolean> {
    let envoye = false;
    try {
      if (p.telephone) {
        const reponse = await this.twilio.sendSmsMessage({
          phoneNumber: p.telephone,
          message: texteSmsBon({ montant: p.montant, code: p.code, expire: p.expire }),
        });
        envoye = !!reponse;
      }
    } catch (erreur) {
      this.logger.warn(`SMS du bon de l'incident ${p.id} non envoyé : ${(erreur as Error)?.message ?? erreur}`);
    }
    try {
      await this.prisma.incident.updateMany({
        where: { id: p.id },
        data: { bon_message_at: maintenant, bon_message_canal: envoye ? 'SMS' : 'AUCUN' },
      });
      await this.prisma.incidentSuivi.create({
        data: { incident_id: p.id, type: IncidentSuiviType.MESSAGE, meta: { envoye }, created_at: maintenant },
      });
    } catch (erreur) {
      this.logger.error(`Suivi du SMS de l'incident ${p.id} non écrit : ${(erreur as Error)?.message ?? erreur}`);
    }
    return envoye;
  }

  /** « Créer le bon » : nouvel essai quand la création a échoué à la résolution. */
  async creerBon(id: string, user: User, maintenant = new Date()): Promise<IncidentFiche> {
    const i = await this.incidents.chargerVisible(id, user);
    const reglages = await this.incidents.reglages();
    if (!peutTraiterIncident(user, i)) throw new ForbiddenException(MESSAGE_DROIT);
    if (!estSiegeIncident(user) && !reglages.bon_restaurant) throw new ForbiddenException(MESSAGE_BON_INTERDIT);
    if (i.geste !== IncidentGeste.BON || i.voucher_id || STATUTS_A_RESOUDRE.includes(i.statut)) {
      throw new BadRequestException(MESSAGE_BON_SANS_OBJET);
    }
    const resultat = await this.emettreBon(id, user, maintenant, reglages);
    if (resultat === 'pris') throw new ConflictException(MESSAGE_BON_EN_COURS);
    if (resultat === 'echec') throw new InternalServerErrorException(MESSAGE_BON_ECHEC);
    this.alertes.diffuser(i);
    return this.incidents.fiche(id, user, maintenant);
  }

  /** « Renvoyer le SMS » du code : bon encore utilisable, et pas deux envois en deux minutes. */
  async renvoyerSms(id: string, user: User, maintenant = new Date()): Promise<IncidentFiche> {
    const i = await this.incidents.chargerVisible(id, user);
    if (!peutTraiterIncident(user, i)) throw new ForbiddenException(MESSAGE_DROIT);
    if (!i.voucher || i.voucher.status !== VoucherStatus.ACTIVE) throw new BadRequestException(MESSAGE_BON_ABSENT);
    const seuil = new Date(maintenant.getTime() - DELAI_ENTRE_SMS_MS);
    // Revendication : deux clics ensemble n'envoient qu'un message.
    const prise = await this.prisma.incident.updateMany({
      where: { id, OR: [{ bon_message_at: null }, { bon_message_at: { lt: seuil } }] },
      data: { bon_message_at: maintenant },
    });
    if (prise.count === 0) throw new ConflictException(MESSAGE_SMS_RECENT);
    const envoye = await this.envoyerSmsBon(
      {
        id,
        telephone: i.customer.phone,
        montant: i.voucher.initial_amount,
        code: i.voucher.code,
        expire: i.voucher.expires_at ?? maintenant,
      },
      maintenant,
    );
    if (!envoye) throw new HttpException(MESSAGE_SMS_ECHEC, 502);
    return this.incidents.fiche(id, user, maintenant);
  }

  // ─── Clôturer ───────────────────────────────────────────────────────────────

  /**
   * Clôturé : le client a été rappelé (sa réaction est notée), n'a pas pu
   * l'être, ou n'avait pas à l'être. L'avis du site encore « Incident ouvert »
   * passe « Résolu », avec la solution qui correspond au geste.
   */
  async cloturer(id: string, dto: CloturerIncidentDto, user: User, maintenant = new Date()): Promise<IncidentFiche> {
    const i = await this.incidents.chargerVisible(id, user);
    this.exigerStatutLu(i, dto.statut_lu);
    const droits = droitsIncident(user, i, { bon_restaurant: false });
    if (!droits.cloturer) this.refuser(i.statut === IncidentStatut.RESOLU);
    const cloture = verifierCloture(dto);
    if ('refus' in cloture) throw new BadRequestException(cloture.refus);

    await this.prisma.$transaction(async (tx) => {
      const ecrit = await tx.incident.updateMany({
        where: { id, statut: IncidentStatut.RESOLU },
        data: {
          statut: IncidentStatut.CLOTURE,
          recontact: cloture.recontact,
          reaction: cloture.reaction,
          cloture_at: maintenant,
          cloture_par_id: user.id,
          cloture_par_nom: user.fullname,
        },
      });
      if (ecrit.count === 0) throw new ConflictException(MESSAGE_CONFLIT);
      await tx.incidentSuivi.create({
        data: {
          incident_id: id,
          type: IncidentSuiviType.CLOTURE,
          note: cloture.reaction,
          statut_avant: IncidentStatut.RESOLU,
          statut_apres: IncidentStatut.CLOTURE,
          meta: { recontact: cloture.recontact },
          ...this.auteur(user),
          created_at: maintenant,
        },
      });
      if (i.avis_id) await this.reglerAvis(tx, i, user, maintenant);
    });

    this.alertes.diffuser({ ...i, statut: IncidentStatut.CLOTURE });
    return this.incidents.fiche(id, user, maintenant);
  }

  /** L'avis lié, s'il attend encore son incident, est résolu avec lui. */
  private async reglerAvis(
    tx: Prisma.TransactionClient,
    i: Pick<IncidentComplet, 'avis_id' | 'geste' | 'code'>,
    user: User,
    maintenant: Date,
  ): Promise<void> {
    const avis = await tx.avisPrive.findFirst({
      where: { id: i.avis_id!, statut: AvisStatut.INCIDENT_OUVERT, entity_status: { not: EntityStatus.DELETED } },
      select: { id: true, accord_rappel: true },
    });
    if (!avis) return;
    const changement = changementStatut({
      actuel: AvisStatut.INCIDENT_OUVERT,
      cible: AvisStatut.RESOLU,
      solution: solutionAvis(i.geste),
      accordRappel: avis.accord_rappel,
      maintenant,
    });
    const ecrit = await tx.avisPrive.updateMany({
      where: { id: avis.id, statut: AvisStatut.INCIDENT_OUVERT },
      data: { ...changement, updated_at: maintenant },
    });
    if (ecrit.count === 0) return;
    await tx.avisPriveSuivi.create({
      data: {
        avis_id: avis.id,
        type: AvisSuiviType.STATUT,
        statut_avant: AvisStatut.INCIDENT_OUVERT,
        statut_apres: changement.statut,
        solution: changement.solution,
        meta: { code: i.code },
        ...this.auteur(user),
        created_at: maintenant,
      },
    });
  }

  // ─── Rouvrir ────────────────────────────────────────────────────────────────

  /**
   * Rouvert (siège) : retour En cours, avec un nouveau délai. Cause, action et
   * geste restent, pour être repris ; le bon déjà créé reste au client.
   */
  async rouvrir(id: string, dto: RouvrirIncidentDto, user: User, maintenant = new Date()): Promise<IncidentFiche> {
    const i = await this.incidents.chargerVisible(id, user);
    this.exigerStatutLu(i, dto.statut_lu);
    const droits = droitsIncident(user, i, { bon_restaurant: false });
    if (!droits.rouvrir) this.refuser(!STATUTS_A_RESOUDRE.includes(i.statut));
    const motif = saisirMotif(dto.motif);
    if ('refus' in motif) throw new BadRequestException(motif.refus);

    try {
      await this.prisma.$transaction(async (tx) => {
        const ecrit = await tx.incident.updateMany({
          where: { id, statut: i.statut },
          data: {
            statut: IncidentStatut.EN_COURS,
            resolu_at: null,
            resolu_par_id: null,
            resolu_par_nom: null,
            recontact: null,
            reaction: null,
            cloture_at: null,
            cloture_par_id: null,
            cloture_par_nom: null,
            echeance_at: echeance(maintenant, i.categorie.delai_heures),
            alerte_retard_at: null,
          },
        });
        if (ecrit.count === 0) throw new ConflictException(MESSAGE_CONFLIT);
        await tx.incidentSuivi.create({
          data: {
            incident_id: id,
            type: IncidentSuiviType.REOUVERTURE,
            note: motif.texte,
            statut_avant: i.statut,
            statut_apres: IncidentStatut.EN_COURS,
            ...this.auteur(user),
            created_at: maintenant,
          },
        });
        if (i.avis_id) {
          // L'avis résolu avec son incident le suit : de nouveau « Incident ouvert ».
          const avis = await tx.avisPrive.findFirst({
            where: { id: i.avis_id, statut: AvisStatut.RESOLU, entity_status: { not: EntityStatus.DELETED } },
            select: { id: true },
          });
          if (avis) {
            const passage = passageIncident(AvisStatut.RESOLU);
            const lie = await tx.avisPrive.updateMany({
              where: { id: avis.id, statut: AvisStatut.RESOLU },
              data: { ...passage, updated_at: maintenant },
            });
            if (lie.count > 0) {
              await tx.avisPriveSuivi.create({
                data: {
                  avis_id: avis.id,
                  type: AvisSuiviType.INCIDENT,
                  statut_avant: AvisStatut.RESOLU,
                  statut_apres: passage.statut,
                  meta: { code: i.code, incident_id: id },
                  ...this.auteur(user),
                  created_at: maintenant,
                },
              });
            }
          }
        }
      });
    } catch (erreur) {
      // Un autre incident a été ouvert entre-temps sur la même commande et la même catégorie.
      if (uniciteViolee(erreur) !== null) throw new ConflictException(MESSAGE_DOUBLON);
      throw erreur;
    }

    this.alertes.diffuser({ ...i, statut: IncidentStatut.EN_COURS });
    return this.incidents.fiche(id, user, maintenant);
  }

  // ─── Noter ──────────────────────────────────────────────────────────────────

  async noter(id: string, dto: NoteIncidentDto, user: User, maintenant = new Date()): Promise<IncidentFiche> {
    const i = await this.incidents.chargerVisible(id, user);
    if (!droitsIncident(user, i, { bon_restaurant: false }).noter) throw new ForbiddenException(MESSAGE_DROIT);
    const note = saisirNote(dto.note);
    if ('refus' in note) throw new BadRequestException(note.refus);
    await this.prisma.incidentSuivi.create({
      data: {
        incident_id: id,
        type: IncidentSuiviType.NOTE,
        note: note.texte,
        ...this.auteur(user),
        created_at: maintenant,
      },
    });
    this.alertes.diffuser(i);
    return this.incidents.fiche(id, user, maintenant);
  }
}
