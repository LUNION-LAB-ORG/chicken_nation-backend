import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CampaignStatus,
  CrmEventType,
  CrmStatus,
  EntityStatus,
  Prisma,
  User,
} from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { STATUTS_OUVERTS, cleTelephone, commandeEffective, ficheDuRestaurant } from '../crm.rules';
import { AssignContactsDto, QueryCrmContactDto } from '../dto/contact.dto';
import { CrmAccessService } from './crm-access.service';
import { CrmEventsService } from './crm-events.service';
import {
  SELECT_LIGNE,
  codeMasque,
  etatCoupon,
  filtreContacts,
  sansCodes,
  triContacts,
  versLigne,
} from './crm-contact.query';

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
    const where = filtreContacts(this.access.portee(user), q);
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
    return {
      data: lignes.map(versLigne).map((l) =>
        lecteur && l.coupon ? { ...l, coupon: { ...l.coupon, code: codeMasque(l.coupon.code) } } : l,
      ),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * `telephone` : numéro tapé par l'agent dans « Un client appelle ? ». Seul
   * ce numéro, s'il est bien celui de la fiche, ouvre en lecture la fiche d'un
   * client suivi par un collègue : un identifiant seul ne suffit pas.
   *
   * `mode` de la fiche : « gestion » (direction), « sien » ou « commune »
   * (l'agent peut agir), « lecture » (agent, client d'un collègue retrouvé par
   * son numéro), « consultation » (lecteur : tout voir, téléphone compris,
   * aucun geste). Un compte de point de vente n'ouvre que les fiches de son
   * restaurant, et n'y voit que les captures et commandes de ce restaurant.
   */
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
    const mode = this.access.estGestionnaire(user)
      ? 'gestion'
      : this.access.estLecteur(user)
        ? ('consultation' as const)
        : await this.access.assertPeutTraiter(user, p).catch(() => 'lecture' as const);
    if (mode === 'lecture') {
      this.access.assertAgent(user);
      const cle = cleTelephone(telephone);
      if (!cle || (cle !== p.phone_key && cle !== cleTelephone(p.customer?.phone))) {
        throw new ForbiddenException("Ce client est suivi par un collègue : retrouvez-le par son numéro dans « Un client appelle ? »");
      }
    }

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
    return {
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
   */
  async assigner(user: User, dto: AssignContactsDto) {
    const ids = [...new Set(dto.contact_ids)];
    const contacts = await this.prisma.crmContact.findMany({
      where: { id: { in: ids }, entity_status: { not: EntityStatus.DELETED } },
      select: { id: true, status: true, campaign_id: true, assigned_to_id: true },
    });
    if (contacts.length !== ids.length) throw new NotFoundException('Contact introuvable');
    if (contacts.some((p) => p.status === CrmStatus.CONVERTI)) {
      throw new BadRequestException('Un client qui a déjà commandé ne peut plus être assigné');
    }

    let agent: { id: string; fullname: string } | null = null;
    if (dto.agent_id) {
      agent = await this.prisma.user.findFirst({
        where: { id: dto.agent_id, entity_status: EntityStatus.ACTIVE, role: { in: this.access.rolesAgents() } },
        select: { id: true, fullname: true },
      });
      if (!agent) throw new BadRequestException("Cet utilisateur ne peut pas traiter de contacts");
    }

    if (!this.access.estGestionnaire(user)) {
      const campagnes = [...new Set(contacts.map((p) => p.campaign_id))];
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
    }

    const maintenant = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.crmContact.updateMany({
        where: { id: { in: ids } },
        data: { assigned_to_id: agent?.id ?? null, assigned_at: agent ? maintenant : null },
      });
      await tx.crmCampaignMember.updateMany({
        where: { contact_id: { in: ids }, released_at: null },
        data: { agent_id: agent?.id ?? null, assigned_at: agent ? maintenant : null, alert_sent_at: null },
      });
      await this.events.journaliser(
        contacts.map((p) => ({
          contact_id: p.id,
          type: CrmEventType.ASSIGNATION,
          label: agent ? `Assigné à ${agent.fullname}` : 'Retiré de son agent',
          actor_id: user.id,
          campaign_id: p.campaign_id,
        })),
        tx,
      );
    });
    this.events.signaler(ids, 'assignation');
    return { count: ids.length };
  }

  /**
   * File de l'agent, dans l'ordre où il doit la traiter : les rappels promis
   * d'abord, puis les intéressés qui attendent leur coupon, les inscrits jamais
   * appelés (les plus récents en tête : ils se souviennent de l'application),
   * les relances sans réponse, et enfin les coupons envoyés à relancer.
   */
  async maFile(user: User) {
    const maintenant = new Date();
    const debutJour = new Date(`${maintenant.toISOString().slice(0, 10)}T00:00:00.000Z`);
    // Une campagne suspendue met ses contacts en pause : ils sortent de la file.
    const base: Prisma.CrmContactWhereInput = {
      assigned_to_id: user.id,
      entity_status: { not: EntityStatus.DELETED },
      OR: [{ campaign_id: null }, { campaign: { status: CampaignStatus.ACTIVE } }],
    };
    const prendre = (
      where: Prisma.CrmContactWhereInput,
      orderBy: Prisma.CrmContactOrderByWithRelationInput[],
      take = 50,
    ) =>
      this.prisma.crmContact
        .findMany({ where: { AND: [base, where] }, select: SELECT_LIGNE, orderBy, take })
        .then((l) => l.map(versLigne));

    const [rappels, interesses, nouveaux, relances, coupons, rappelsPlanifies, commune] = await Promise.all([
      prendre({ status: CrmStatus.A_RAPPELER, callback_at: { lte: maintenant } }, [{ callback_at: 'asc' }]),
      prendre({ status: CrmStatus.INTERESSE }, [{ last_call_at: 'asc' }]),
      prendre({ status: CrmStatus.A_APPELER, call_count: 0 }, [{ segment_since: 'desc' }]),
      prendre(
        {
          OR: [
            { status: CrmStatus.A_APPELER, call_count: { gt: 0 } },
            { status: CrmStatus.A_RAPPELER, callback_at: null },
          ],
        },
        [{ last_call_at: 'asc' }],
      ),
      prendre({ status: CrmStatus.COUPON_ENVOYE }, [{ coupon_sent_at: 'asc' }]),
      prendre({ status: CrmStatus.A_RAPPELER, callback_at: { gt: maintenant } }, [{ callback_at: 'asc' }], 20),
      // File commune Glovo/Yango (J+1) : les plus anciens d'abord, le premier
      // qui compose prend le contact.
      this.prisma.crmContact
        .findMany({ where: this.access.fileCommune(maintenant), select: SELECT_LIGNE, orderBy: [{ segment_since: 'asc' }], take: 50 })
        .then((l) => l.map(versLigne)),
    ]);

    const [appels, joints, couponsJour, conversionsJour, portefeuille] = await Promise.all([
      this.prisma.crmCall.count({ where: { agent_id: user.id, created_at: { gte: debutJour } } }),
      this.prisma.crmCall.count({ where: { agent_id: user.id, reached: true, created_at: { gte: debutJour } } }),
      this.prisma.crmCoupon.count({ where: { sent_by_id: user.id, sent_at: { gte: debutJour } } }),
      this.prisma.crmContact.count({ where: { assigned_to_id: user.id, converted_at: { gte: debutJour } } }),
      this.prisma.crmContact.count({ where: { AND: [base, { status: { in: STATUTS_OUVERTS } }] } }),
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
      },
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
    return lignes.map(versLigne);
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
