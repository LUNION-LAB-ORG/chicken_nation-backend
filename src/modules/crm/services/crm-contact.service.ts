import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CampaignStatus,
  CrmEventType,
  CrmStatus,
  EntityStatus,
  Prisma,
  User,
} from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { STATUTS_OUVERTS, cleTelephone, commandeEffective, compter, ficheDuRestaurant } from '../crm.rules';
import {
  AssignContactsDto,
  COMPTES_CLIENT,
  MaFileLignesQueryDto,
  QueryCrmContactDto,
  RenommerContactDto,
} from '../dto/contact.dto';
import { CrmAccessService } from './crm-access.service';
import { CrmEventsService } from './crm-events.service';
import {
  CLE_COMMUNE,
  CLE_SANS_CAMPAGNE,
  ComptesDossier,
  DossierFile,
  RUBRIQUES_FILE,
  SELECT_LIGNE,
  SuiviCampagne,
  TRI_COMMUNE,
  baseMaFile,
  codeMasque,
  comptesDossierVides,
  etatCoupon,
  filtreContacts,
  pourAnnuaire,
  sansCodes,
  triContacts,
  trierDossiers,
  versLigne,
} from './crm-contact.query';

type RubriqueAgent = keyof typeof RUBRIQUES_FILE;
/** Rubriques rangées en dossiers : les rappels dus restent à l'accueil. */
const RUBRIQUES_DOSSIER = ['interesses', 'nouveaux', 'relances', 'coupons', 'rappels_planifies'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class CrmContactService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CrmAccessService,
    private readonly events: CrmEventsService,
  ) {}

  async lister(user: User, q: QueryCrmContactDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 25;
    // Contacts est l'annuaire : tout le monde le parcourt (cf. porteeListe).
    const where = filtreContacts(this.access.porteeListe(user), q);
    const [lignes, total] = await Promise.all([
      this.prisma.crmContact.findMany({
        where,
        select: SELECT_LIGNE,
        orderBy: triContacts(q.sort),
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.crmContact.count({ where }),
    ]);
    const lecteur = this.access.estLecteur(user);
    // MÊME projection que la fiche : la liste porte les mêmes champs sensibles
    // (agent, coupon, dernier appel, raison). L'oublier ici aurait tout laissé
    // fuiter par la liste pendant qu'on protégeait la fiche.
    const annuaire = this.access.estAnnuaire(user);
    return {
      data: lignes
        .map(versLigne)
        .map((l) =>
          lecteur && l.coupon ? { ...l, coupon: { ...l.coupon, code: codeMasque(l.coupon.code) } } : l,
        )
        .map((l) => (annuaire ? pourAnnuaire(l) : l)),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * `telephone` : numéro tapé dans « Un client appelle ? ». Conservé pour
   * cette entrée-là ; il ne conditionne PLUS l'ouverture d'une fiche, depuis
   * que Contacts est l'annuaire entier.
   *
   * `mode` de la fiche : « gestion » (direction), « sien » ou « commune »
   * (l'agent peut agir), « lecture » (agent, client d'un collègue retrouvé par
   * son numéro), « consultation » (lecteur : tout voir, téléphone compris,
   * aucun geste). Un compte de point de vente n'ouvre que les fiches de son
   * restaurant, et n'y voit que les captures et commandes de ce restaurant.
   */
  /**
   * COMBIEN DANS CHAQUE PUBLIC, sur le périmètre filtré.
   *
   * La liste n'affichait qu'un total : pour connaître la répartition il
   * fallait filtrer quatre fois de suite en notant les résultats. Supportable
   * quand le CRM ne portait que les cibles de relance, absurde depuis qu'il
   * porte tout le fichier client.
   *
   * ⚠️ Le filtre de PUBLIC et celui de COMPTE sont retirés du périmètre.
   * Sinon, cliquer sur « Glovo » mettrait tous les autres à zéro et on ne
   * pourrait plus en changer : la bande servirait une fois, puis deviendrait
   * un cul-de-sac. Les autres filtres, eux, sont respectés — le décompte
   * décrit ce qu'on regarde.
   */
  async repartition(user: User, q: QueryCrmContactDto) {
    const { segment: _public, compte: _compte, page: _p, limit: _l, ...reste } = q;
    // MÊME portée que la liste : sinon les pastilles compteraient une
    // population que les lignes en dessous ne montrent pas.
    const base = filtreContacts(this.access.porteeListe(user), reste as QueryCrmContactDto);

    const [parPublic, ...parCompte] = await Promise.all([
      this.prisma.crmContact.groupBy({ by: ['segment'], where: base, _count: { _all: true } }),
      ...COMPTES_CLIENT.map((compte) =>
        this.prisma.crmContact.count({
          where: filtreContacts(base, { compte } as QueryCrmContactDto),
        }),
      ),
    ]);

    return {
      total: parPublic.reduce((somme, l) => somme + l._count._all, 0),
      publics: parPublic
        .map((l) => ({ segment: l.segment, nombre: l._count._all }))
        .sort((a, b) => b.nombre - a.nombre),
      comptes: COMPTES_CLIENT.map((compte, i) => ({ compte, nombre: parCompte[i] })),
    };
  }

  async fiche(user: User, id: string, telephone?: string) {
    const restaurant = this.access.restaurantDe(user);
    const p = await this.prisma.crmContact.findUnique({
      where: { id },
      select: {
        ...SELECT_LIGNE,
        phone_key: true,
        first_reached_at: true,
        qualified_at: true,
        conversion_order_id: true,
        entity_status: true,
        customer: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            phone: true,
            email: true,
            created_at: true,
            last_login_at: true,
            whatsapp_opt_in: true,
          },
        },
        calls: {
          orderBy: { created_at: 'desc' },
          select: {
            id: true,
            created_at: true,
            status_label: true,
            outcome: true,
            reached: true,
            attempt: true,
            comment: true,
            callback_at: true,
            agent: { select: { id: true, fullname: true } },
            loss_reason: { select: { id: true, name: true } },
            campaign: { select: { id: true, name: true } },
          },
        },
        coupons: {
          orderBy: { sent_at: 'desc' },
          select: {
            id: true,
            code: true,
            offer_label: true,
            discount_type: true,
            discount_value: true,
            sent_at: true,
            expires_at: true,
            used_at: true,
            channel: true,
            send_error: true,
            resent_count: true,
            order_amount: true,
            sent_by: { select: { id: true, fullname: true } },
            campaign: { select: { id: true, name: true } },
          },
        },
        members: {
          orderBy: { joined_at: 'desc' },
          select: {
            id: true,
            joined_at: true,
            released_at: true,
            release_reason: true,
            converted_at: true,
            campaign: { select: { id: true, name: true, status: true, lead_agent_id: true } },
            agent: { select: { id: true, fullname: true } },
          },
        },
        captures: {
          where: { entity_status: { not: EntityStatus.DELETED }, ...(restaurant !== undefined && { restaurant_id: restaurant }) },
          orderBy: { created_at: 'desc' },
          take: 30,
          select: {
            id: true,
            platform: true,
            order_number: true,
            name: true,
            created_at: true,
            restaurant: { select: { name: true } },
            creator: { select: { fullname: true } },
          },
        },
        events: {
          orderBy: { created_at: 'desc' },
          take: 100,
          select: {
            id: true,
            type: true,
            label: true,
            created_at: true,
            actor: { select: { id: true, fullname: true } },
            campaign: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!p || p.entity_status === EntityStatus.DELETED) {
      throw new NotFoundException('Contact introuvable');
    }
    await this.access.assertDuRestaurant(user, p.id);
    // Tout agent peut consulter une fiche (client qui rappelle) ; agir sur un
    // contact reste réservé à son agent, à la file commune et à la direction.
    // Un lecteur voit toute fiche de sa portée, sans numéro à taper.
    const mode = this.access.estAnnuaire(user)
      ? ('annuaire' as const)
      : this.access.estGestionnaire(user)
      ? 'gestion'
      : this.access.estLecteur(user)
        ? ('consultation' as const)
        : await this.access.assertPeutTraiter(user, p).catch(() => 'lecture' as const);
    /*
      TOUT AGENT CONSULTE TOUTE FICHE.

      Il fallait auparavant TAPER LE NUMÉRO du client pour ouvrir la fiche d'un
      collègue : seul « Un client appelle ? » la donnait. Depuis que Contacts
      est l'annuaire entier, la liste montrait des clients que cliquer
      refusait — on voyait la ligne et on butait sur un message.

      Consulter s'ouvre donc, AGIR reste fermé : le mode « lecture » n'autorise
      ni appel, ni coupon, ni changement d'agent.
    */
    if (mode === 'lecture') this.access.assertAgent(user);

    const [commande, abandons, achats] = await Promise.all([
      p.conversion_order_id
        ? this.prisma.order.findFirst({
            where: { id: p.conversion_order_id, ...(restaurant !== undefined && { restaurant_id: restaurant }) },
            select: {
              id: true,
              reference: true,
              created_at: true,
              amount: true,
              status: true,
              type: true,
              payment_method: true,
              restaurant: { select: { name: true } },
            },
          })
        : null,
      p.customer && p.abandoned_orders > 0
        ? this.prisma.order.findMany({
            where: {
              customer_id: p.customer.id,
              entity_status: EntityStatus.DELETED,
              ...(restaurant !== undefined && { restaurant_id: restaurant }),
            },
            orderBy: { created_at: 'desc' },
            take: 10,
            select: { id: true, reference: true, created_at: true, amount: true, payment_method: true },
          })
        : [],
      p.customer && p.last_order_at ? this.historiqueAchats(p.customer.id, restaurant) : null,
    ]);

    const { calls, coupons: couponsBruts, members, events: journalBrut, captures, ...reste } = p;
    const maintenant = new Date();
    // Consultation : les codes de coupon sont masqués partout, journal compris.
    const codes = mode === 'consultation' ? couponsBruts.map((c) => c.code) : [];
    const coupons = codes.length ? couponsBruts.map((c) => ({ ...c, code: codeMasque(c.code) })) : couponsBruts;
    const events = codes.length ? journalBrut.map((e) => ({ ...e, label: sansCodes(e.label, codes) })) : journalBrut;
    const fiche = {
      ...versLigne({ ...reste, coupons: coupons.slice(0, 1) }),
      first_reached_at: p.first_reached_at,
      qualified_at: p.qualified_at,
      customer: p.customer,
      segment_since: p.segment_since,
      // Depuis l'inscription pour un inscrit, depuis l'inactivité pour un ancien client.
      delai_conversion_jours: p.converted_at
        ? Math.max(0, Math.round((p.converted_at.getTime() - p.segment_since.getTime()) / 86_400_000))
        : null,
      appels: calls,
      coupons: coupons.map((c) => ({ ...c, etat: etatCoupon(c, maintenant) })),
      campagnes: members,
      journal: events,
      commande,
      paiements_abandonnes: abandons,
      captures,
      achats,
      mode,
    };

    return mode === 'annuaire' ? pourAnnuaire(fiche) : fiche;
  }

  /**
   * Ce qu'un ancien client a acheté : l'agent qui appelle un inactif doit
   * savoir à qui il parle (fidèle de l'application ou client du centre d'appel).
   * `restaurant` : compte de point de vente, ses seules commandes chez lui.
   */
  private async historiqueAchats(customerId: string, restaurant?: string) {
    const commandes: Prisma.OrderWhereInput = {
      ...commandeEffective(customerId),
      ...(restaurant !== undefined && { restaurant_id: restaurant }),
    };
    const [total, canaux] = await Promise.all([
      this.prisma.order.aggregate({
        where: commandes,
        _count: { _all: true },
        _sum: { amount: true },
        _min: { created_at: true },
        _max: { created_at: true },
      }),
      this.prisma.order.groupBy({
        by: ['auto'],
        where: commandes,
        _count: { _all: true },
      }),
    ]);
    const app = canaux.find((c) => c.auto)?._count._all ?? 0;
    const centre = canaux.find((c) => !c.auto)?._count._all ?? 0;
    return {
      commandes: total._count._all,
      montant: Math.round(total._sum.amount ?? 0),
      premiere: total._min.created_at,
      derniere: total._max.created_at,
      canal: app > centre ? 'APPLICATION' : centre > app ? 'CENTRE_APPEL' : 'MIXTE',
    };
  }

  /**
   * Affectation à un agent, à l'unité ou en masse (cahier §4.3). Le pilote
   * d'une campagne ne répartit que les contacts de SA campagne, et seulement
   * entre les agents de son équipe.
   *
   * Un client déjà converti est laissé de côté, sans refuser le reste du lot ;
   * le lot n'est refusé que s'il ne contient que des convertis. La direction
   * peut confier un contact de campagne à un agent hors de l'équipe : c'est
   * permis, et dit dans le message.
   */
  async assigner(user: User, dto: AssignContactsDto) {
    const ids = [...new Set(dto.contact_ids)];
    const contacts = await this.prisma.crmContact.findMany({
      where: { id: { in: ids }, entity_status: { not: EntityStatus.DELETED } },
      select: { id: true, status: true, campaign_id: true, assigned_to_id: true },
    });
    if (contacts.length !== ids.length) throw new NotFoundException('Contact introuvable');
    const retenus = contacts.filter((p) => p.status !== CrmStatus.CONVERTI);
    const ecartes = contacts.length - retenus.length;
    if (retenus.length === 0) {
      throw new BadRequestException('Un client qui a déjà commandé ne peut plus être assigné');
    }
    const idsRetenus = retenus.map((p) => p.id);

    let agent: { id: string; fullname: string } | null = null;
    if (dto.agent_id) {
      agent = await this.prisma.user.findFirst({
        where: { id: dto.agent_id, entity_status: EntityStatus.ACTIVE, role: { in: this.access.rolesAgents() } },
        select: { id: true, fullname: true },
      });
      if (!agent) throw new BadRequestException("Cet utilisateur ne peut pas traiter de contacts");
    }

    let horsEquipe = 0;
    if (!this.access.estGestionnaire(user)) {
      const campagnes = [...new Set(retenus.map((p) => p.campaign_id))];
      if (campagnes.length !== 1 || !campagnes[0]) {
        throw new BadRequestException('Un pilote ne répartit que les contacts de sa campagne');
      }
      await this.access.assertGestionnaireOuPilote(user, campagnes[0]);
      if (agent) {
        const membre = await this.prisma.crmCampaignAgent.findUnique({
          where: { campaign_id_agent_id: { campaign_id: campagnes[0], agent_id: agent.id } },
        });
        if (!membre) throw new BadRequestException("Cet agent ne fait pas partie de l'équipe de la campagne");
      }
    } else if (agent) {
      const campagnes = [...new Set(retenus.map((p) => p.campaign_id).filter((c): c is string => !!c))];
      if (campagnes.length > 0) {
        const equipes = await this.prisma.crmCampaignAgent.findMany({
          where: { agent_id: agent.id, campaign_id: { in: campagnes } },
          select: { campaign_id: true },
        });
        const siennes = new Set(equipes.map((e) => e.campaign_id));
        horsEquipe = retenus.filter((p) => p.campaign_id && !siennes.has(p.campaign_id)).length;
      }
    }

    const maintenant = new Date();
    const assignes = await this.prisma.$transaction(async (tx) => {
      // Converti entre la lecture et l'écriture : laissé tel quel, comme les autres convertis.
      const { count } = await tx.crmContact.updateMany({
        where: { id: { in: idsRetenus }, status: { not: CrmStatus.CONVERTI } },
        data: { assigned_to_id: agent?.id ?? null, assigned_at: agent ? maintenant : null },
      });

      /*
        Assigner un client de l'ANNUAIRE vaut prise en charge.

        Sans ça, l'assignation était un geste SANS EFFET : le statut
        « non démarché » exclut la fiche de toutes les files, l'agent la
        recevait donc sans jamais la voir. On le promeut « à appeler », comme le
        ferait le bouton de sa fiche.

        La date d'entrée devient celle de la prise : seule une commande passée
        APRÈS compte comme une vente du centre d'appels. Garder la dernière
        commande (date de création de la fiche) la faisait « convertir » par
        cette commande-là, sans aucun appel.

        Seulement quand on assigne à quelqu'un : retirer l'agent d'un contact ne
        doit pas le faire entrer dans l'entonnoir.
      */
      if (agent) {
        await tx.crmContact.updateMany({
          where: { id: { in: idsRetenus }, status: CrmStatus.NON_DEMARCHE },
          data: { status: CrmStatus.A_APPELER, segment_since: maintenant },
        });
      }
      await tx.crmCampaignMember.updateMany({
        where: { contact_id: { in: idsRetenus }, released_at: null },
        data: { agent_id: agent?.id ?? null, assigned_at: agent ? maintenant : null, alert_sent_at: null },
      });
      await this.events.journaliser(
        retenus.map((p) => ({
          contact_id: p.id,
          type: CrmEventType.ASSIGNATION,
          label: agent ? `Assigné à ${agent.fullname}` : 'Retiré de son agent',
          actor_id: user.id,
          campaign_id: p.campaign_id,
        })),
        tx,
      );
      return count;
    });
    this.events.signaler(idsRetenus, 'assignation');
    const phrases = [
      ecartes > 0 ? `${compter(ecartes, 'client déjà converti laissé', 'clients déjà convertis laissés')} de côté.` : null,
      horsEquipe > 0 ? `${compter(horsEquipe, 'contact confié', 'contacts confiés')} hors de l'équipe de sa campagne.` : null,
    ].filter((p): p is string => !!p);
    return { count: assignes, ecartes, hors_equipe: horsEquipe, message: phrases.length > 0 ? phrases.join(' ') : null };
  }

  /**
   * File de l'agent, dans l'ordre où il doit la traiter : les rappels promis
   * d'abord, puis les intéressés qui attendent leur coupon, les inscrits jamais
   * appelés (les plus récents en tête : ils se souviennent de l'application),
   * les relances sans réponse, et enfin les coupons envoyés à relancer.
   *
   * Les listes restent coupées (50 lignes, 20 pour les rappels planifiés) pour
   * l'accueil. Les VRAIS nombres viennent de `comptes` et `dossiers`, comptés
   * en base : compter les lignes coupées faisait disparaître une campagne
   * derrière 50 contacts plus récents, et annonçait « 50 au total » pour une
   * file commune de 300. Un dossier charge ses lignes à l'ouverture
   * (`lignesMaFile`). `suivi` : les campagnes en cours que l'agent pilote.
   */
  async maFile(user: User) {
    const maintenant = new Date();
    const debutJour = new Date(`${maintenant.toISOString().slice(0, 10)}T00:00:00.000Z`);
    // Une campagne suspendue met ses contacts en pause : ils sortent des listes.
    const base = baseMaFile(user.id);
    const prendre = (rubrique: RubriqueAgent) => {
      const r = RUBRIQUES_FILE[rubrique];
      return this.prisma.crmContact
        .findMany({ where: { AND: [base, r.filtre(maintenant)] }, select: SELECT_LIGNE, orderBy: r.tri, take: r.plafond })
        .then((l) => l.map(versLigne));
    };

    const [rappels, interesses, nouveaux, relances, coupons, rappelsPlanifies, commune] = await Promise.all([
      prendre('rappels'),
      prendre('interesses'),
      prendre('nouveaux'),
      prendre('relances'),
      prendre('coupons'),
      prendre('rappels_planifies'),
      // File commune Glovo/Yango (J+1) : les plus anciens d'abord, le premier
      // qui compose prend le contact.
      this.prisma.crmContact
        .findMany({ where: this.access.fileCommune(maintenant), select: SELECT_LIGNE, orderBy: TRI_COMMUNE, take: 50 })
        .then((l) => l.map(versLigne)),
    ]);

    const [appels, joints, couponsJour, conversionsJour, portefeuille, jamaisAppeles] = await Promise.all([
      this.prisma.crmCall.count({ where: { agent_id: user.id, created_at: { gte: debutJour } } }),
      this.prisma.crmCall.count({ where: { agent_id: user.id, reached: true, created_at: { gte: debutJour } } }),
      this.prisma.crmCoupon.count({ where: { sent_by_id: user.id, sent_at: { gte: debutJour } } }),
      // Une conversion de l'agent : un contact qu'il a APPELÉ. Une fiche confiée
      // qui commande avant tout appel n'est pas son travail.
      this.prisma.crmContact.count({
        where: { assigned_to_id: user.id, converted_at: { gte: debutJour }, call_count: { gt: 0 } },
      }),
      this.prisma.crmContact.count({ where: { AND: [base, { status: { in: STATUTS_OUVERTS } }] } }),
      /**
       * LE NOMBRE QUI BAISSE QUAND ON TRAVAILLE.
       *
       * Le portefeuille compte un STOCK : les contacts confiés encore ouverts.
       * Or « coupon envoyé » et « intéressé » sont des statuts ouverts, et
       * prendre une fiche dans la file commune en ajoute une. Un agent qui
       * passe sa journée au téléphone voit donc son portefeuille MONTER, ce
       * qui lui donne le sentiment de ne pas avancer.
       *
       * Celui-ci compte le RESTE À FAIRE : les confiés que personne n'a encore
       * appelés. Il descend à chaque premier appel, et ne remonte que quand
       * l'agent prend de nouveaux contacts — ce qui est la vérité.
       */
      this.prisma.crmContact.count({
        where: { AND: [base, { status: { in: STATUTS_OUVERTS } }, { call_count: 0 }] },
      }),
    ]);

    const [{ comptes, dossiers }, suivi] = await Promise.all([
      this.comptesMaFile(user, base, maintenant),
      this.suiviPilote(user),
    ]);

    return {
      rappels,
      interesses,
      nouveaux,
      relances,
      coupons,
      rappels_planifies: rappelsPlanifies,
      commune,
      indicateurs: {
        appels_jour: appels,
        joints_jour: joints,
        coupons_jour: couponsJour,
        conversions_jour: conversionsJour,
        portefeuille,
        jamais_appeles: jamaisAppeles,
      },
      comptes,
      dossiers,
      suivi,
    };
  }

  /**
   * Vrais totaux de « Ma file », rubrique par rubrique et dossier par dossier,
   * comptés en base avec les mêmes filtres que les listes. Une campagne
   * suspendue donne un dossier « pause » : ses contacts attendent la reprise.
   */
  private async comptesMaFile(user: User, base: Prisma.CrmContactWhereInput, maintenant: Date) {
    const rubriques = Object.keys(RUBRIQUES_FILE) as RubriqueAgent[];
    const commune = this.access.fileCommune(maintenant);
    const enPause: Prisma.CrmContactWhereInput = {
      assigned_to_id: user.id,
      entity_status: { not: EntityStatus.DELETED },
      status: { in: STATUTS_OUVERTS },
      campaign: { status: CampaignStatus.SUSPENDED },
    };
    const [parRubrique, communeTotal, communeJamais, pause, pauseJamais] = await Promise.all([
      Promise.all(
        rubriques.map((r) =>
          this.prisma.crmContact.groupBy({
            by: ['campaign_id'],
            where: { AND: [base, RUBRIQUES_FILE[r].filtre(maintenant)] },
            _count: { _all: true },
          }),
        ),
      ),
      this.prisma.crmContact.count({ where: commune }),
      this.prisma.crmContact.count({ where: { AND: [commune, { call_count: 0 }] } }),
      this.prisma.crmContact.groupBy({ by: ['campaign_id'], where: enPause, _count: { _all: true } }),
      this.prisma.crmContact.groupBy({ by: ['campaign_id'], where: { AND: [enPause, { call_count: 0 }] }, _count: { _all: true } }),
    ]);

    const comptes: Record<RubriqueAgent | 'commune', number> = {
      rappels: 0,
      interesses: 0,
      nouveaux: 0,
      relances: 0,
      coupons: 0,
      rappels_planifies: 0,
      commune: communeTotal,
    };
    const parDossier = new Map<string | null, ComptesDossier>();
    rubriques.forEach((r, i) => {
      for (const g of parRubrique[i]) {
        comptes[r] += g._count._all;
        if (r === 'rappels') continue;
        const d = parDossier.get(g.campaign_id) ?? comptesDossierVides();
        d[r] += g._count._all;
        parDossier.set(g.campaign_id, d);
      }
    });

    const ids = [...new Set([...parDossier.keys(), ...pause.map((p) => p.campaign_id)])].filter((v): v is string => !!v);
    const noms = new Map(
      ids.length > 0
        ? (await this.prisma.crmCampaign.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map(
            (c) => [c.id, c.name] as const,
          )
        : [],
    );

    const dossiers: DossierFile[] = [];
    for (const [cle, c] of parDossier) {
      c.total = RUBRIQUES_DOSSIER.reduce((n, r) => n + c[r], 0);
      c.jamais_appeles = c.nouveaux;
      c.a_relancer = c.relances;
      if (c.total === 0) continue;
      dossiers.push(
        cle
          ? { cle, genre: 'campagne', nom: noms.get(cle) ?? 'Campagne', campaign_id: cle, comptes: c }
          : { cle: CLE_SANS_CAMPAGNE, genre: 'sans-campagne', nom: 'Hors campagne', campaign_id: null, comptes: c },
      );
    }
    if (communeTotal > 0) {
      dossiers.push({
        cle: CLE_COMMUNE,
        genre: 'commune',
        nom: 'File commune Glovo/Yango',
        campaign_id: null,
        comptes: {
          ...comptesDossierVides(),
          commune: communeTotal,
          total: communeTotal,
          jamais_appeles: communeJamais,
          a_relancer: communeTotal - communeJamais,
        },
      });
    }
    for (const p of pause) {
      if (!p.campaign_id || p._count._all === 0) continue;
      dossiers.push({
        cle: p.campaign_id,
        genre: 'pause',
        nom: noms.get(p.campaign_id) ?? 'Campagne',
        campaign_id: p.campaign_id,
        comptes: {
          ...comptesDossierVides(),
          total: p._count._all,
          jamais_appeles: pauseJamais.find((j) => j.campaign_id === p.campaign_id)?._count._all ?? 0,
        },
      });
    }
    return { comptes, dossiers: trierDossiers(dossiers) };
  }

  /**
   * Le pilote suit ses campagnes en cours (ou suspendues) même sans y avoir
   * de contact : ce qui reste, ce qui n'a jamais été appelé, et chez qui.
   */
  private async suiviPilote(user: User): Promise<SuiviCampagne[]> {
    const campagnes = await this.prisma.crmCampaign.findMany({
      where: {
        lead_agent_id: user.id,
        status: { in: [CampaignStatus.ACTIVE, CampaignStatus.SUSPENDED] },
        entity_status: { not: EntityStatus.DELETED },
      },
      select: { id: true, name: true, status: true, distribution_mode: true },
      orderBy: { name: 'asc' },
    });
    if (campagnes.length === 0) return [];
    const ouverts: Prisma.CrmContactWhereInput = {
      campaign_id: { in: campagnes.map((c) => c.id) },
      status: { in: STATUTS_OUVERTS },
      entity_status: { not: EntityStatus.DELETED },
    };
    const [restants, jamais] = await Promise.all([
      this.prisma.crmContact.groupBy({ by: ['campaign_id', 'assigned_to_id'], where: ouverts, _count: { _all: true } }),
      this.prisma.crmContact.groupBy({
        by: ['campaign_id', 'assigned_to_id'],
        where: { AND: [ouverts, { call_count: 0 }] },
        _count: { _all: true },
      }),
    ]);
    const agents = [...new Set(restants.map((r) => r.assigned_to_id))].filter((v): v is string => !!v);
    const noms = new Map(
      agents.length > 0
        ? (await this.prisma.user.findMany({ where: { id: { in: agents } }, select: { id: true, fullname: true } })).map(
            (u) => [u.id, u.fullname] as const,
          )
        : [],
    );
    const nombre = (liste: typeof restants, campagne: string, agent: string | null) =>
      liste.find((l) => l.campaign_id === campagne && l.assigned_to_id === agent)?._count._all ?? 0;

    return campagnes.map((c) => {
      const lignes = restants.filter((r) => r.campaign_id === c.id);
      const par_agent = lignes
        .filter((l): l is typeof l & { assigned_to_id: string } => !!l.assigned_to_id)
        .map((l) => ({
          agent_id: l.assigned_to_id,
          nom: noms.get(l.assigned_to_id) ?? 'Compte sans nom',
          restants: l._count._all,
          jamais_appeles: nombre(jamais, c.id, l.assigned_to_id),
        }))
        .sort((a, b) => b.restants - a.restants || a.nom.localeCompare(b.nom, 'fr'));
      return {
        campaign_id: c.id,
        nom: c.name,
        statut: c.status as SuiviCampagne['statut'],
        mode: c.distribution_mode,
        restants: lignes.reduce((n, l) => n + l._count._all, 0),
        jamais_appeles: jamais.filter((j) => j.campaign_id === c.id).reduce((n, j) => n + j._count._all, 0),
        sans_agent: nombre(restants, c.id, null),
        par_agent,
      };
    });
  }

  /**
   * Lignes d'un dossier de « Ma file », une rubrique à la fois, page par page :
   * le dossier ouvert montre tout ce qu'il annonce, pas les 50 premières
   * lignes de toute la file. Mêmes filtres et même ordre que l'accueil.
   * `toutes` ne sert qu'aux rappels dus (toutes campagnes confondues), et la
   * file commune n'a que sa rubrique.
   */
  async lignesMaFile(user: User, q: MaFileLignesQueryDto) {
    const { cle, rubrique } = q;
    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const valide =
      (cle === 'toutes') === (rubrique === 'rappels') &&
      (cle === CLE_COMMUNE) === (rubrique === 'commune') &&
      (cle === 'toutes' || cle === CLE_COMMUNE || cle === CLE_SANS_CAMPAGNE || UUID.test(cle));
    if (!valide) throw new BadRequestException('Dossier ou rubrique inconnus');

    const maintenant = new Date();
    let where: Prisma.CrmContactWhereInput;
    let orderBy: Prisma.CrmContactOrderByWithRelationInput[];
    if (rubrique === 'commune') {
      where = this.access.fileCommune(maintenant);
      orderBy = TRI_COMMUNE;
    } else {
      const r = RUBRIQUES_FILE[rubrique];
      const dossier: Prisma.CrmContactWhereInput =
        cle === 'toutes' ? {} : cle === CLE_SANS_CAMPAGNE ? { campaign_id: null } : { campaign_id: cle };
      where = { AND: [baseMaFile(user.id), dossier, r.filtre(maintenant)] };
      orderBy = r.tri;
    }
    const [lignes, total] = await Promise.all([
      this.prisma.crmContact.findMany({ where, select: SELECT_LIGNE, orderBy, skip: (page - 1) * limit, take: limit }),
      this.prisma.crmContact.count({ where }),
    ]);
    return {
      data: lignes.map(versLigne),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Recherche par numéro exact (client qui appelle) : ouverte à tout agent,
   * en consultation. Égalité de clé (10 derniers chiffres), jamais un début ou
   * une fin de numéro : un numéro incomplet ne ramène personne d'autre.
   */
  async rechercher(user: User, telephone: string) {
    if (!this.access.estGestionnaire(user)) this.access.assertAgent(user);
    const cle = cleTelephone(telephone);
    if (!cle || cle.length < 8) throw new BadRequestException('Tapez le numéro complet du client');
    const parCompte = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT x."id" FROM "CrmContact" x JOIN "Customer" cu ON cu."id" = x."customer_id"
      WHERE x."entity_status" <> 'DELETED' AND right(regexp_replace(cu."phone", '\D', '', 'g'), 10) = ${cle}
      LIMIT 10`;
    const restaurant = this.access.restaurantDe(user);
    const lignes = await this.prisma.crmContact.findMany({
      where: {
        AND: [
          {
            entity_status: { not: EntityStatus.DELETED },
            OR: [{ phone_key: cle }, { id: { in: parCompte.map((r) => r.id) } }],
          },
          ...(restaurant !== undefined ? [ficheDuRestaurant(restaurant)] : []),
        ],
      },
      select: SELECT_LIGNE,
      orderBy: [{ segment_since: 'desc' }],
      take: 10,
    });
    const annuaire = this.access.estAnnuaire(user);
    return lignes.map(versLigne).map((l) => (annuaire ? pourAnnuaire(l) : l));
  }

  /** L'agent prend un contact de la file commune au moment de composer son numéro. */
  async prendreContact(user: User, id: string) {
    const contact = await this.prisma.crmContact.findFirst({
      where: { id, entity_status: { not: EntityStatus.DELETED } },
      select: { id: true, assigned_to_id: true, campaign_id: true, segment: true, status: true, segment_since: true },
    });
    if (!contact) throw new NotFoundException('Contact introuvable');
    await this.access.assertPeutTraiter(user, contact);
    const pris = await this.prisma.$transaction((tx) => this.access.prendre(tx, user, id));
    if (pris) {
      await this.events.journaliser([
        { contact_id: id, type: CrmEventType.ASSIGNATION, label: `Pris dans la file commune par ${user.fullname}`, actor_id: user.id },
      ]);
      this.events.signaler([id], 'assignation');
    }
    return { pris, assigned_to_id: pris ? user.id : contact.assigned_to_id };
  }

  /**
   * Personnes à qui confier des contacts, avec leur charge actuelle (pour un
   * compte de point de vente, leur charge parmi les fiches de son restaurant).
   */
  /**
   * NOMMER un contact qui n'en a pas.
   *
   * Le nom écrit ici part AUSSI sur le compte de l'application, parce que
   * c'est le même client : un nom qui ne vivrait que dans le CRM laisserait
   * la caisse, les reçus et les messages continuer à dire « Client sans nom ».
   */
  /**
   * PRENDRE EN CHARGE un client de l'annuaire.
   *
   * Les fiches « non démarchées » existent pour que l'onglet Contacts réunisse
   * toute la base : ce sont des clients qui commandent déjà, que le call center
   * ne travaille pas. Elles n'appellent donc aucun geste, et la fiche n'en
   * propose aucun tant qu'on n'a pas décidé de s'en occuper.
   *
   * Ce geste-ci est cette décision : le contact passe « à appeler », il est
   * confié à l'agent qui l'a pris, et il apparaît dans sa file.
   *
   * ⚠️ `call_count` n'est PAS touché : il reste à zéro pour un client jamais
   * appelé, qui doit donc atterrir dans « Jamais appelés » et non dans « À
   * relancer ». Un client repris après un cycle garde son compteur.
   */
  async prendreEnCharge(user: User, id: string) {
    this.access.assertAgent(user);

    const contact = await this.prisma.crmContact.findFirst({
      where: { id, entity_status: { not: EntityStatus.DELETED } },
      select: { id: true, status: true, campaign_id: true },
    });
    if (!contact) throw new NotFoundException('Contact introuvable');
    if (contact.status !== CrmStatus.NON_DEMARCHE) {
      throw new BadRequestException('Ce contact est déjà suivi par le call center.');
    }

    // Revendication : deux agents qui cliquent en même temps, un seul l'obtient.
    const { count } = await this.prisma.crmContact.updateMany({
      where: { id, status: CrmStatus.NON_DEMARCHE },
      data: {
        status: CrmStatus.A_APPELER,
        assigned_to_id: user.id,
        assigned_at: new Date(),
      },
    });
    if (count !== 1) {
      throw new ConflictException("Ce contact vient d'être pris par quelqu'un d'autre.");
    }

    await this.events.journaliser([
      {
        contact_id: id,
        campaign_id: contact.campaign_id,
        actor_id: user.id,
        type: CrmEventType.ASSIGNATION,
        label: 'Pris en charge depuis l’annuaire',
      },
    ]);
    this.events.signaler([id], 'prise_en_charge');

    return { success: true };
  }

  async renommer(user: User, id: string, dto: RenommerContactDto) {
    const prenom = (dto.prenom ?? '').trim();
    const nom = (dto.nom ?? '').trim();
    if (!prenom) throw new BadRequestException('Le prénom est obligatoire');

    const contact = await this.prisma.crmContact.findFirst({
      where: { id, entity_status: { not: EntityStatus.DELETED } },
      select: {
        id: true,
        customer_id: true,
        assigned_to_id: true,
        campaign_id: true,
        segment: true,
        status: true,
        segment_since: true,
        customer: { select: { first_name: true, last_name: true } },
      },
    });
    if (!contact) throw new NotFoundException('Contact introuvable');
    await this.access.assertPeutTraiter(user, contact);

    /**
     * Ce que le client a saisi LUI-MÊME dans l'application ne se corrige pas
     * depuis le centre d'appels : c'est son identité, pas la nôtre. On ne
     * nomme donc que ce qui n'a pas de nom de son côté, ce qui laisse aussi
     * la porte ouverte à la correction d'une faute de frappe de l'agent.
     */
    const nomDuCompte = [contact.customer?.first_name, contact.customer?.last_name]
      .filter(Boolean)
      .join(' ')
      .trim();
    if (nomDuCompte) {
      throw new BadRequestException(
        `Ce client a renseigné son nom dans l'application (${nomDuCompte}) : il ne se modifie pas depuis le CRM.`,
      );
    }

    /**
     * Ordre « Nom Prénom » sur la fiche CRM, celui des noms relevés en caisse.
     * C'est ce qui permet à `identiteContact` de retrouver le prénom en
     * dernier mot quand le contact n'a pas de compte sur l'application.
     */
    const nomReleve = [nom, prenom].filter(Boolean).join(' ');

    await this.prisma.$transaction(async (tx) => {
      await tx.crmContact.update({ where: { id }, data: { name: nomReleve } });
      if (contact.customer_id) {
        await tx.customer.update({
          where: { id: contact.customer_id },
          data: { first_name: prenom, last_name: nom || null },
        });
      }
    });

    this.events.signaler([id], 'identite');

    // Le compte l'emporte sur le relevé : quand il existe, la fiche affichera
    // « Prénom Nom », pas l'ordre de la capture.
    const nomAffiche = contact.customer_id ? [prenom, nom].filter(Boolean).join(' ') : nomReleve;
    return { id, nom: nomAffiche, prenom, sur_le_compte: !!contact.customer_id };
  }

  async agents(user: User) {
    const restaurant = this.access.restaurantDe(user);
    const agents = await this.prisma.user.findMany({
      where: { entity_status: EntityStatus.ACTIVE, role: { in: this.access.rolesAgents() } },
      select: { id: true, fullname: true, role: true, image: true },
      orderBy: { fullname: 'asc' },
    });
    const charges = await this.prisma.crmContact.groupBy({
      by: ['assigned_to_id'],
      where: {
        AND: [
          {
            assigned_to_id: { in: agents.map((a) => a.id) },
            status: { in: STATUTS_OUVERTS },
            entity_status: { not: EntityStatus.DELETED },
          },
          ...(restaurant !== undefined ? [ficheDuRestaurant(restaurant)] : []),
        ],
      },
      _count: { _all: true },
    });
    const parAgent = new Map(charges.map((c) => [c.assigned_to_id, c._count._all]));
    return agents.map((a) => ({ ...a, portefeuille: parAgent.get(a.id) ?? 0 }));
  }
}
