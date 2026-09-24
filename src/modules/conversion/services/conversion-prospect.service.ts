import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CampaignStatus,
  ConversionEventType,
  ConversionProspectStatus,
  EntityStatus,
  Prisma,
  ProspectPlatform,
  User,
} from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { STATUTS_OUVERTS } from '../conversion.rules';
import { AssignProspectsDto, QueryConversionProspectDto } from '../dto/prospect.dto';
import { ConversionAccessService } from './conversion-access.service';
import { ConversionEventsService } from './conversion-events.service';
import {
  SELECT_LIGNE,
  etatCoupon,
  filtreProspects,
  triProspects,
  versLigne,
} from './conversion-prospect.query';

@Injectable()
export class ConversionProspectService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ConversionAccessService,
    private readonly events: ConversionEventsService,
  ) {}

  async lister(user: User, q: QueryConversionProspectDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 25;
    const where = filtreProspects(this.access.portee(user), q);
    const [lignes, total] = await Promise.all([
      this.prisma.conversionProspect.findMany({
        where,
        select: SELECT_LIGNE,
        orderBy: triProspects(q.sort),
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.conversionProspect.count({ where }),
    ]);
    return {
      data: lignes.map(versLigne),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async fiche(user: User, id: string) {
    const p = await this.prisma.conversionProspect.findUnique({
      where: { id },
      select: {
        ...SELECT_LIGNE,
        first_reached_at: true,
        qualified_at: true,
        first_order_id: true,
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
      throw new NotFoundException('Prospect introuvable');
    }
    await this.access.assertPeutTraiter(user, p);

    const telephone = (p.customer.phone ?? '').replace(/\D/g, '').slice(-10);
    const [commande, abandons, acquisition] = await Promise.all([
      p.first_order_id
        ? this.prisma.order.findUnique({
            where: { id: p.first_order_id },
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
      p.abandoned_orders > 0
        ? this.prisma.order.findMany({
            where: { customer_id: p.customer.id, entity_status: EntityStatus.DELETED },
            orderBy: { created_at: 'desc' },
            take: 10,
            select: { id: true, reference: true, created_at: true, amount: true, payment_method: true },
          })
        : [],
      // Le même numéro a pu être capté par l'acquisition Glovo/Yango : l'agent
      // doit le savoir avant d'appeler, pour ne pas répéter le même discours.
      telephone.length === 10
        ? this.prisma.prospect.findMany({
            where: {
              phone: telephone,
              entity_status: { not: EntityStatus.DELETED },
              platform: { not: ProspectPlatform.APP_ORGANIC },
            },
            orderBy: { created_at: 'desc' },
            take: 5,
            select: {
              id: true,
              platform: true,
              status: true,
              created_at: true,
              coupon_sent_at: true,
              restaurant: { select: { name: true } },
            },
          })
        : [],
    ]);

    const { calls, coupons, members, events, ...reste } = p;
    const maintenant = new Date();
    return {
      ...versLigne({ ...reste, coupons: coupons.slice(0, 1) }),
      first_reached_at: p.first_reached_at,
      qualified_at: p.qualified_at,
      customer: p.customer,
      delai_conversion_jours: p.converted_at
        ? Math.max(0, Math.round((p.converted_at.getTime() - p.registered_at.getTime()) / 86_400_000))
        : null,
      appels: calls,
      coupons: coupons.map((c) => ({ ...c, etat: etatCoupon(c, maintenant) })),
      campagnes: members,
      journal: events,
      commande,
      paiements_abandonnes: abandons,
      acquisition,
    };
  }

  /**
   * Affectation à un agent, à l'unité ou en masse (cahier §4.3). Le pilote
   * d'une campagne ne répartit que les prospects de SA campagne, et seulement
   * entre les agents de son équipe.
   */
  async assigner(user: User, dto: AssignProspectsDto) {
    const ids = [...new Set(dto.prospect_ids)];
    const prospects = await this.prisma.conversionProspect.findMany({
      where: { id: { in: ids }, entity_status: { not: EntityStatus.DELETED } },
      select: { id: true, status: true, campaign_id: true, assigned_to_id: true },
    });
    if (prospects.length !== ids.length) throw new NotFoundException('Prospect introuvable');
    if (prospects.some((p) => p.status === ConversionProspectStatus.CONVERTI)) {
      throw new BadRequestException('Un client qui a déjà commandé ne peut plus être assigné');
    }

    let agent: { id: string; fullname: string } | null = null;
    if (dto.agent_id) {
      agent = await this.prisma.user.findFirst({
        where: { id: dto.agent_id, entity_status: EntityStatus.ACTIVE, role: { in: this.access.rolesAgents() } },
        select: { id: true, fullname: true },
      });
      if (!agent) throw new BadRequestException("Cet utilisateur ne peut pas traiter de prospects");
    }

    if (!this.access.estGestionnaire(user)) {
      const campagnes = [...new Set(prospects.map((p) => p.campaign_id))];
      if (campagnes.length !== 1 || !campagnes[0]) {
        throw new BadRequestException('Un pilote ne répartit que les prospects de sa campagne');
      }
      await this.access.assertGestionnaireOuPilote(user, campagnes[0]);
      if (agent) {
        const membre = await this.prisma.campaignAgent.findUnique({
          where: { campaign_id_agent_id: { campaign_id: campagnes[0], agent_id: agent.id } },
        });
        if (!membre) throw new BadRequestException("Cet agent ne fait pas partie de l'équipe de la campagne");
      }
    }

    const maintenant = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.conversionProspect.updateMany({
        where: { id: { in: ids } },
        data: { assigned_to_id: agent?.id ?? null, assigned_at: agent ? maintenant : null },
      });
      await tx.conversionCampaignMember.updateMany({
        where: { prospect_id: { in: ids }, released_at: null },
        data: { agent_id: agent?.id ?? null, assigned_at: agent ? maintenant : null, alert_sent_at: null },
      });
      await this.events.journaliser(
        prospects.map((p) => ({
          prospect_id: p.id,
          type: ConversionEventType.ASSIGNATION,
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
    // Une campagne suspendue met ses prospects en pause : ils sortent de la file.
    const base: Prisma.ConversionProspectWhereInput = {
      assigned_to_id: user.id,
      entity_status: { not: EntityStatus.DELETED },
      OR: [{ campaign_id: null }, { campaign: { status: CampaignStatus.ACTIVE } }],
    };
    const prendre = (
      where: Prisma.ConversionProspectWhereInput,
      orderBy: Prisma.ConversionProspectOrderByWithRelationInput[],
      take = 50,
    ) =>
      this.prisma.conversionProspect
        .findMany({ where: { AND: [base, where] }, select: SELECT_LIGNE, orderBy, take })
        .then((l) => l.map(versLigne));

    const [rappels, interesses, nouveaux, relances, coupons, rappelsPlanifies] = await Promise.all([
      prendre({ status: ConversionProspectStatus.A_RAPPELER, callback_at: { lte: maintenant } }, [{ callback_at: 'asc' }]),
      prendre({ status: ConversionProspectStatus.INTERESSE }, [{ last_call_at: 'asc' }]),
      prendre({ status: ConversionProspectStatus.A_APPELER, call_count: 0 }, [{ registered_at: 'desc' }]),
      prendre(
        {
          OR: [
            { status: ConversionProspectStatus.A_APPELER, call_count: { gt: 0 } },
            { status: ConversionProspectStatus.A_RAPPELER, callback_at: null },
          ],
        },
        [{ last_call_at: 'asc' }],
      ),
      prendre({ status: ConversionProspectStatus.COUPON_ENVOYE }, [{ coupon_sent_at: 'asc' }]),
      prendre({ status: ConversionProspectStatus.A_RAPPELER, callback_at: { gt: maintenant } }, [{ callback_at: 'asc' }], 20),
    ]);

    const [appels, joints, couponsJour, conversionsJour, portefeuille] = await Promise.all([
      this.prisma.conversionCall.count({ where: { agent_id: user.id, created_at: { gte: debutJour } } }),
      this.prisma.conversionCall.count({ where: { agent_id: user.id, reached: true, created_at: { gte: debutJour } } }),
      this.prisma.conversionCoupon.count({ where: { sent_by_id: user.id, sent_at: { gte: debutJour } } }),
      this.prisma.conversionProspect.count({ where: { assigned_to_id: user.id, converted_at: { gte: debutJour } } }),
      this.prisma.conversionProspect.count({ where: { AND: [base, { status: { in: STATUTS_OUVERTS } }] } }),
    ]);

    return {
      rappels,
      interesses,
      nouveaux,
      relances,
      coupons,
      rappels_planifies: rappelsPlanifies,
      indicateurs: {
        appels_jour: appels,
        joints_jour: joints,
        coupons_jour: couponsJour,
        conversions_jour: conversionsJour,
        portefeuille,
      },
    };
  }

  /** Personnes à qui confier des prospects, avec leur charge actuelle. */
  async agents() {
    const agents = await this.prisma.user.findMany({
      where: { entity_status: EntityStatus.ACTIVE, role: { in: this.access.rolesAgents() } },
      select: { id: true, fullname: true, role: true, image: true },
      orderBy: { fullname: 'asc' },
    });
    const charges = await this.prisma.conversionProspect.groupBy({
      by: ['assigned_to_id'],
      where: {
        assigned_to_id: { in: agents.map((a) => a.id) },
        status: { in: STATUTS_OUVERTS },
        entity_status: { not: EntityStatus.DELETED },
      },
      _count: { _all: true },
    });
    const parAgent = new Map(charges.map((c) => [c.assigned_to_id, c._count._all]));
    return agents.map((a) => ({ ...a, portefeuille: parAgent.get(a.id) ?? 0 }));
  }
}
