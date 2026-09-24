import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CampaignDistributionMode,
  CampaignStatus,
  ConversionEventType,
  ConversionProspectStatus,
  ConversionReleaseReason,
  EntityStatus,
  Prisma,
  User,
} from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { Action } from 'src/modules/auth/enums/action.enum';
import { STATUTS_OUVERTS } from '../conversion.rules';
import { CreateCampaignDto, DistributeDto, QueryCampaignsDto, UpdateCampaignDto, UpdateTeamDto } from '../dto/campaign.dto';
import { ConversionAccessService } from './conversion-access.service';
import { ConversionCampaignStatsService } from './conversion-campaign-stats.service';
import { ConversionEventsService } from './conversion-events.service';

const JOUR = 86_400_000;
const PAQUET = 2000;
const EN_COURS: CampaignStatus[] = [CampaignStatus.ACTIVE, CampaignStatus.SUSPENDED];

const SELECT_CAMPAGNE = {
  id: true,
  name: true,
  description: true,
  start_date: true,
  end_date: true,
  status: true,
  target_conversion_rate: true,
  target_contacts_count: true,
  registered_from: true,
  registered_to: true,
  distribution_mode: true,
  started_at: true,
  completed_at: true,
  targeted_count: true,
  created_at: true,
  lead_agent: { select: { id: true, fullname: true } },
  created_by: { select: { id: true, fullname: true } },
  offer: { select: { id: true, label: true } },
  assigned_agents: { select: { agent: { select: { id: true, fullname: true, role: true } } } },
} satisfies Prisma.ConversionCampaignSelect;

function paquets<T>(liste: T[], taille = PAQUET): T[][] {
  const r: T[][] = [];
  for (let i = 0; i < liste.length; i += taille) r.push(liste.slice(i, i + taille));
  return r;
}

/** Date saisie « AAAA-MM-JJ » ou ISO → minuit UTC de ce jour (Abidjan est à UTC+0). */
function jour(valeur: string): Date {
  return new Date(`${valeur.slice(0, 10)}T00:00:00.000Z`);
}

/**
 * Campagnes de conversion (cahier §6) : une opération nommée, datée, avec un
 * pilote, une équipe et des objectifs, qui prend les prospects actifs au
 * lancement et les rend à la clôture.
 *
 * Règle d'or : un prospect n'est que dans UNE campagne en cours à la fois, pour
 * ne jamais être sollicité deux fois.
 */
@Injectable()
export class ConversionCampaignService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ConversionAccessService,
    private readonly events: ConversionEventsService,
    private readonly stats: ConversionCampaignStatsService,
  ) {}

  async lister(user: User, q: QueryCampaignsDto) {
    const where: Prisma.ConversionCampaignWhereInput = {
      entity_status: { not: EntityStatus.DELETED },
      ...(q.status && { status: q.status }),
      ...this.porteeCampagnes(user),
    };
    const campagnes = await this.prisma.conversionCampaign.findMany({
      where,
      orderBy: { created_at: 'desc' },
      select: SELECT_CAMPAGNE,
    });
    const resumes = await this.stats.resumes(campagnes.map((c) => c.id));
    return campagnes.map((c) => ({ ...c, resume: resumes.get(c.id) }));
  }

  async detail(user: User, id: string) {
    const c = await this.prisma.conversionCampaign.findFirst({
      where: { id, entity_status: { not: EntityStatus.DELETED }, ...this.porteeCampagnes(user) },
      select: SELECT_CAMPAGNE,
    });
    if (!c) throw new NotFoundException('Campagne introuvable');
    const resume = (await this.stats.resumes([id])).get(id);
    return { ...c, resume };
  }

  async statistiques(user: User, id: string) {
    await this.detail(user, id);
    return this.stats.statistiques(id);
  }

  /** Un agent ne voit que les campagnes qu'il pilote ou dont il fait partie. */
  private porteeCampagnes(user: User): Prisma.ConversionCampaignWhereInput {
    if (this.access.estGestionnaire(user) || !this.access.peut(user, Action.UPDATE)) return {};
    return { OR: [{ lead_agent_id: user.id }, { assigned_agents: { some: { agent_id: user.id } } }] };
  }

  async creer(user: User, dto: CreateCampaignDto) {
    const { debut, fin } = this.dates(dto.start_date, dto.end_date, dto.duration_days);
    const equipe = [...new Set(dto.agent_ids)];
    await this.verifierAgents([dto.lead_agent_id, ...equipe]);
    if (dto.offer_id) await this.verifierOffre(dto.offer_id);
    this.verifierPeriode(dto.registered_from, dto.registered_to);

    return this.prisma.conversionCampaign.create({
      data: {
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        start_date: debut,
        end_date: fin,
        target_conversion_rate: dto.target_conversion_rate ?? null,
        target_contacts_count: dto.target_contacts_count ?? null,
        registered_from: dto.registered_from ? jour(dto.registered_from) : null,
        registered_to: dto.registered_to ? jour(dto.registered_to) : null,
        distribution_mode: dto.distribution_mode ?? CampaignDistributionMode.AUTOMATIQUE,
        offer_id: dto.offer_id ?? null,
        lead_agent_id: dto.lead_agent_id,
        created_by_id: user.id,
        assigned_agents: { create: equipe.map((agent_id) => ({ agent_id })) },
      },
      select: SELECT_CAMPAGNE,
    });
  }

  async modifier(id: string, dto: UpdateCampaignDto) {
    const c = await this.trouver(id);
    if (c.status === CampaignStatus.COMPLETED) {
      throw new BadRequestException('Une campagne terminée ne se modifie plus');
    }
    const lancee = c.status !== CampaignStatus.PLANIFIED;
    if (lancee && (dto.start_date || dto.registered_from || dto.registered_to || dto.distribution_mode || dto.agent_ids || dto.lead_agent_id)) {
      throw new BadRequestException(
        "Campagne lancée : la population, le début et le mode de répartition sont figés. L'équipe se modifie à part.",
      );
    }
    if (dto.offer_id) await this.verifierOffre(dto.offer_id);
    const debutSaisi = dto.start_date ?? c.start_date.toISOString();
    const { debut, fin } = this.dates(
      debutSaisi,
      dto.end_date ?? (dto.duration_days ? undefined : c.end_date?.toISOString()),
      dto.duration_days,
    );
    if (!lancee) {
      this.verifierPeriode(dto.registered_from, dto.registered_to);
      if (dto.lead_agent_id || dto.agent_ids) {
        await this.verifierAgents([dto.lead_agent_id ?? c.lead_agent_id, ...(dto.agent_ids ?? [])]);
      }
    }

    return this.prisma.$transaction(async (tx) => {
      if (!lancee && dto.agent_ids) {
        await tx.campaignAgent.deleteMany({ where: { campaign_id: id } });
        await tx.campaignAgent.createMany({ data: [...new Set(dto.agent_ids)].map((agent_id) => ({ campaign_id: id, agent_id })) });
      }
      return tx.conversionCampaign.update({
        where: { id },
        data: {
          ...(dto.name && { name: dto.name.trim() }),
          ...(dto.description !== undefined && { description: dto.description.trim() || null }),
          start_date: debut,
          end_date: fin,
          ...(dto.target_conversion_rate !== undefined && { target_conversion_rate: dto.target_conversion_rate }),
          ...(dto.target_contacts_count !== undefined && { target_contacts_count: dto.target_contacts_count }),
          ...(dto.offer_id !== undefined && { offer_id: dto.offer_id }),
          ...(!lancee && dto.registered_from !== undefined && { registered_from: dto.registered_from ? jour(dto.registered_from) : null }),
          ...(!lancee && dto.registered_to !== undefined && { registered_to: dto.registered_to ? jour(dto.registered_to) : null }),
          ...(!lancee && dto.distribution_mode && { distribution_mode: dto.distribution_mode }),
          ...(!lancee && dto.lead_agent_id && { lead_agent_id: dto.lead_agent_id }),
        },
        select: SELECT_CAMPAGNE,
      });
    });
  }

  /**
   * Lancement (cahier §6.2) : la campagne prend tous les prospects actifs de sa
   * population qui ne sont pas déjà dans une campagne en cours, et les répartit
   * entre les agents de l'équipe si la répartition est automatique. Un prospect
   * déjà suivi par un agent de l'équipe lui reste confié.
   */
  async lancer(user: User, id: string) {
    const c = await this.trouver(id);
    if (c.status !== CampaignStatus.PLANIFIED) throw new BadRequestException('Cette campagne est déjà lancée');
    const equipe = c.assigned_agents.map((a) => a.agent_id);
    if (equipe.length === 0) throw new BadRequestException("L'équipe de la campagne est vide");

    const eligibles = await this.prisma.conversionProspect.findMany({
      where: {
        entity_status: { not: EntityStatus.DELETED },
        status: { notIn: [ConversionProspectStatus.CONVERTI, ConversionProspectStatus.INJOIGNABLE] },
        OR: [{ campaign_id: null }, { campaign: { status: { notIn: EN_COURS } } }],
        ...((c.registered_from || c.registered_to) && {
          registered_at: {
            ...(c.registered_from && { gte: c.registered_from }),
            ...(c.registered_to && { lt: new Date(c.registered_to.getTime() + JOUR) }),
          },
        }),
      },
      select: { id: true, assigned_to_id: true },
      orderBy: { registered_at: 'desc' },
    });
    if (eligibles.length === 0) throw new BadRequestException('Aucun prospect disponible pour cette population');

    const affectation =
      c.distribution_mode === CampaignDistributionMode.AUTOMATIQUE
        ? this.repartir(eligibles, equipe, new Map())
        : new Map(eligibles.map((p) => [p.id, p.assigned_to_id && equipe.includes(p.assigned_to_id) ? p.assigned_to_id : null]));

    const maintenant = new Date();
    await this.prisma.$transaction(
      async (tx) => {
        const claim = await tx.conversionCampaign.updateMany({
          where: { id, status: CampaignStatus.PLANIFIED },
          data: { status: CampaignStatus.ACTIVE, started_at: maintenant, targeted_count: eligibles.length },
        });
        if (claim.count === 0) throw new BadRequestException('Cette campagne est déjà lancée');
        for (const lot of paquets(eligibles)) {
          await tx.conversionCampaignMember.createMany({
            data: lot.map((p) => {
              const agent = affectation.get(p.id) ?? null;
              return { campaign_id: id, prospect_id: p.id, agent_id: agent, assigned_at: agent ? maintenant : null, joined_at: maintenant };
            }),
            skipDuplicates: true,
          });
        }
        await this.appliquerAffectation(tx, id, affectation, maintenant);
        for (const lot of paquets(eligibles)) {
          await this.events.journaliser(
            lot.map((p) => ({
              prospect_id: p.id,
              type: ConversionEventType.CAMPAGNE_ENTREE,
              label: `Entre dans la campagne « ${c.name} »`,
              actor_id: user.id,
              campaign_id: id,
            })),
            tx,
          );
        }
      },
      { timeout: 180_000, maxWait: 10_000 },
    );
    this.events.signaler(eligibles.slice(0, 500).map((p) => p.id), 'campagne');
    return { cibles: eligibles.length, repartis: [...affectation.values()].filter(Boolean).length };
  }

  async suspendre(user: User, id: string) {
    return this.changerStatut(user, id, CampaignStatus.ACTIVE, CampaignStatus.SUSPENDED, 'Seule une campagne en cours peut être suspendue');
  }

  async reprendre(user: User, id: string) {
    return this.changerStatut(user, id, CampaignStatus.SUSPENDED, CampaignStatus.ACTIVE, 'Seule une campagne suspendue peut reprendre');
  }

  private async changerStatut(user: User, id: string, depuis: CampaignStatus, vers: CampaignStatus, erreur: string) {
    await this.trouver(id);
    await this.access.assertGestionnaireOuPilote(user, id);
    const claim = await this.prisma.conversionCampaign.updateMany({ where: { id, status: depuis }, data: { status: vers } });
    if (claim.count === 0) throw new BadRequestException(erreur);
    return this.prisma.conversionCampaign.findUnique({ where: { id }, select: SELECT_CAMPAGNE });
  }

  /**
   * Clôture : les indicateurs sont figés, les prospects non convertis quittent
   * la campagne et leur agent, libres pour la suivante. `acteur` est null
   * quand la clôture vient de la date de fin (tâche planifiée).
   */
  async terminer(acteur: User | null, id: string) {
    const c = await this.trouver(id);
    if (acteur) await this.access.assertGestionnaireOuPilote(acteur, id);
    if (!EN_COURS.includes(c.status)) throw new BadRequestException("Cette campagne n'est pas en cours");

    const rapport = JSON.parse(JSON.stringify(await this.stats.statistiques(id))) as Prisma.InputJsonValue;
    const maintenant = new Date();
    const liberes = await this.prisma.$transaction(
      async (tx) => {
        const claim = await tx.conversionCampaign.updateMany({
          where: { id, status: { in: EN_COURS } },
          data: { status: CampaignStatus.COMPLETED, completed_at: maintenant, report: rapport },
        });
        if (claim.count === 0) throw new BadRequestException("Cette campagne n'est pas en cours");
        const ouverts = await tx.conversionCampaignMember.findMany({
          where: { campaign_id: id, released_at: null },
          select: { prospect_id: true },
        });
        await tx.conversionCampaignMember.updateMany({
          where: { campaign_id: id, released_at: null },
          data: { released_at: maintenant, release_reason: ConversionReleaseReason.FIN_CAMPAGNE },
        });
        await tx.conversionProspect.updateMany({
          where: { campaign_id: id, status: { not: ConversionProspectStatus.CONVERTI } },
          data: { campaign_id: null, assigned_to_id: null, assigned_at: null },
        });
        for (const lot of paquets(ouverts)) {
          await this.events.journaliser(
            lot.map((m) => ({
              prospect_id: m.prospect_id,
              type: ConversionEventType.CAMPAGNE_SORTIE,
              label: `Fin de la campagne « ${c.name} »`,
              actor_id: acteur?.id ?? null,
              campaign_id: id,
            })),
            tx,
          );
        }
        return ouverts.length;
      },
      { timeout: 180_000, maxWait: 10_000 },
    );
    return { liberes, rapport };
  }

  /**
   * Répartition équilibrée (cahier §6.2) : chaque prospect sans agent va à
   * l'agent de l'équipe qui en a le moins. Avec `inclure_non_appeles`, les
   * prospects jamais appelés sont remis en jeu aussi, pour rééquilibrer après
   * un changement d'équipe.
   */
  async distribuer(user: User, id: string, dto: DistributeDto) {
    const c = await this.trouver(id);
    await this.access.assertGestionnaireOuPilote(user, id);
    if (!EN_COURS.includes(c.status)) throw new BadRequestException("Cette campagne n'est pas en cours");
    const equipe = c.assigned_agents.map((a) => a.agent_id);
    if (equipe.length === 0) throw new BadRequestException("L'équipe de la campagne est vide");

    const membres = await this.prisma.conversionCampaignMember.findMany({
      where: {
        campaign_id: id,
        released_at: null,
        prospect: { status: { in: STATUTS_OUVERTS }, entity_status: { not: EntityStatus.DELETED } },
      },
      select: { prospect_id: true, agent_id: true, prospect: { select: { call_count: true, registered_at: true } } },
      orderBy: { prospect: { registered_at: 'desc' } },
    });
    const aRepartir = membres.filter(
      (m) => !m.agent_id || !equipe.includes(m.agent_id) || (dto.inclure_non_appeles && m.prospect.call_count === 0),
    );
    const charge = new Map<string, number>(equipe.map((a) => [a, 0]));
    for (const m of membres) {
      if (m.agent_id && charge.has(m.agent_id) && !aRepartir.includes(m)) charge.set(m.agent_id, charge.get(m.agent_id)! + 1);
    }
    const affectation = this.repartir(
      aRepartir.map((m) => ({ id: m.prospect_id, assigned_to_id: null })),
      equipe,
      charge,
    );
    const maintenant = new Date();
    await this.prisma.$transaction(
      async (tx) => {
        await this.appliquerAffectation(tx, id, affectation, maintenant);
        for (const lot of paquets([...affectation.entries()])) {
          await this.events.journaliser(
            lot.map(([prospect_id]) => ({
              prospect_id,
              type: ConversionEventType.ASSIGNATION,
              label: 'Réparti automatiquement dans la campagne',
              actor_id: user.id,
              campaign_id: id,
            })),
            tx,
          );
        }
      },
      { timeout: 180_000, maxWait: 10_000 },
    );
    this.events.signaler([...affectation.keys()].slice(0, 500), 'assignation');
    const parAgent: Record<string, number> = {};
    affectation.forEach((agent) => agent && (parAgent[agent] = (parAgent[agent] ?? 0) + 1));
    return { repartis: affectation.size, par_agent: parAgent };
  }

  /**
   * Équipe (cahier §9 : le pilote gère son équipe). Un agent retiré rend ses
   * prospects ; en répartition automatique ils sont aussitôt redonnés aux
   * agents restants.
   */
  async modifierEquipe(user: User, id: string, dto: UpdateTeamDto) {
    const c = await this.trouver(id);
    await this.access.assertGestionnaireOuPilote(user, id);
    if (c.status === CampaignStatus.COMPLETED) throw new BadRequestException('Une campagne terminée ne se modifie plus');
    if (dto.lead_agent_id && dto.lead_agent_id !== c.lead_agent_id && !this.access.estGestionnaire(user)) {
      throw new BadRequestException('Seule la direction change le pilote');
    }
    const equipe = [...new Set(dto.agent_ids)];
    await this.verifierAgents([dto.lead_agent_id ?? c.lead_agent_id, ...equipe]);
    const anciens = c.assigned_agents.map((a) => a.agent_id);
    const retires = anciens.filter((a) => !equipe.includes(a));

    await this.prisma.$transaction(async (tx) => {
      await tx.campaignAgent.deleteMany({ where: { campaign_id: id, agent_id: { in: retires } } });
      await tx.campaignAgent.createMany({
        data: equipe.filter((a) => !anciens.includes(a)).map((agent_id) => ({ campaign_id: id, agent_id })),
        skipDuplicates: true,
      });
      if (dto.lead_agent_id) await tx.conversionCampaign.update({ where: { id }, data: { lead_agent_id: dto.lead_agent_id } });
      if (retires.length > 0) {
        await tx.conversionCampaignMember.updateMany({
          where: { campaign_id: id, released_at: null, agent_id: { in: retires } },
          data: { agent_id: null, assigned_at: null },
        });
        await tx.conversionProspect.updateMany({
          where: { campaign_id: id, assigned_to_id: { in: retires }, status: { not: ConversionProspectStatus.CONVERTI } },
          data: { assigned_to_id: null, assigned_at: null },
        });
      }
    });

    if (retires.length > 0 && c.distribution_mode === CampaignDistributionMode.AUTOMATIQUE && EN_COURS.includes(c.status)) {
      await this.distribuer(user, id, {});
    }
    return this.detail(user, id);
  }

  // ---------------- Outils ----------------

  /** Chaque prospect va à l'agent le moins chargé ; un agent de l'équipe garde les siens. */
  private repartir(
    prospects: { id: string; assigned_to_id: string | null }[],
    equipe: string[],
    chargeInitiale: Map<string, number>,
  ): Map<string, string | null> {
    const charge = new Map<string, number>(equipe.map((a) => [a, chargeInitiale.get(a) ?? 0]));
    const affectation = new Map<string, string | null>();
    for (const p of prospects) {
      if (p.assigned_to_id && charge.has(p.assigned_to_id)) {
        affectation.set(p.id, p.assigned_to_id);
        charge.set(p.assigned_to_id, charge.get(p.assigned_to_id)! + 1);
      }
    }
    for (const p of prospects) {
      if (affectation.has(p.id)) continue;
      let moinsCharge = equipe[0];
      for (const a of equipe) if (charge.get(a)! < charge.get(moinsCharge)!) moinsCharge = a;
      affectation.set(p.id, moinsCharge);
      charge.set(moinsCharge, charge.get(moinsCharge)! + 1);
    }
    return affectation;
  }

  private async appliquerAffectation(
    tx: Prisma.TransactionClient,
    campagneId: string,
    affectation: Map<string, string | null>,
    maintenant: Date,
  ) {
    const parAgent = new Map<string | null, string[]>();
    affectation.forEach((agent, prospect) => parAgent.set(agent, [...(parAgent.get(agent) ?? []), prospect]));
    for (const [agent, ids] of parAgent) {
      for (const lot of paquets(ids)) {
        await tx.conversionProspect.updateMany({
          where: { id: { in: lot } },
          data: { campaign_id: campagneId, assigned_to_id: agent, assigned_at: agent ? maintenant : null },
        });
        await tx.conversionCampaignMember.updateMany({
          where: { campaign_id: campagneId, prospect_id: { in: lot } },
          data: { agent_id: agent, assigned_at: agent ? maintenant : null, alert_sent_at: null },
        });
      }
    }
  }

  private async trouver(id: string) {
    const c = await this.prisma.conversionCampaign.findFirst({
      where: { id, entity_status: { not: EntityStatus.DELETED } },
      select: {
        id: true,
        name: true,
        status: true,
        start_date: true,
        end_date: true,
        lead_agent_id: true,
        distribution_mode: true,
        registered_from: true,
        registered_to: true,
        assigned_agents: { select: { agent_id: true } },
      },
    });
    if (!c) throw new NotFoundException('Campagne introuvable');
    return c;
  }

  private dates(debutSaisi: string, finSaisie?: string, duree?: number) {
    const debut = jour(debutSaisi);
    const fin = finSaisie ? jour(finSaisie) : duree ? new Date(debut.getTime() + (duree - 1) * JOUR) : null;
    if (fin && fin < debut) throw new BadRequestException('La date de fin précède la date de début');
    return { debut, fin };
  }

  private verifierPeriode(depuis?: string, jusque?: string) {
    if (depuis && jusque && jour(jusque) < jour(depuis)) {
      throw new BadRequestException("La période d'inscription est inversée");
    }
  }

  private async verifierAgents(ids: string[]) {
    const uniques = [...new Set(ids)];
    const trouves = await this.prisma.user.count({
      where: { id: { in: uniques }, entity_status: EntityStatus.ACTIVE, role: { in: this.access.rolesAgents() } },
    });
    if (trouves !== uniques.length) {
      throw new BadRequestException('Le pilote et les agents doivent être des comptes actifs habilités aux prospects');
    }
  }

  private async verifierOffre(id: string) {
    const offre = await this.prisma.conversionOffer.findFirst({
      where: { id, is_active: true, entity_status: { not: EntityStatus.DELETED } },
      select: { id: true },
    });
    if (!offre) throw new BadRequestException('Offre inconnue ou désactivée');
  }
}
