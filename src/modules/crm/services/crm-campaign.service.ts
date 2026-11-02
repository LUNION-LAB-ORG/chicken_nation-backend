import { BadRequestException, ConflictException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  CrmSegment,
  CampaignDistributionMode,
  CampaignStatus,
  CrmEventType,
  CrmStatus,
  CrmReleaseReason,
  EntityStatus,
  Prisma,
  User,
  UserRole,
} from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { Action } from 'src/modules/auth/enums/action.enum';
import {
  BacApercu,
  CAMPAGNES_EN_COURS,
  PUBLICS_VIVIER,
  PublicCampagne,
  bacsApercu,
  critereCampagne,
  estCapte,
  jourUTC,
  memesCriteres,
  populationCampagne,
  publicsDepuisAncienCorps,
  sortieFinCampagne,
  verifierPublics,
} from '../crm-campagne.rules';
import { LIBELLES_PUBLIC, STATUTS_OUVERTS, compter } from '../crm.rules';
import {
  CampaignPublicDto,
  CampaignVentesQueryDto,
  CompareCampaignsQueryDto,
  CreateCrmCampaignDto,
  DistributeCrmDto,
  PreviewCampaignDto,
  QueryCampaignsDto,
  UpdateCrmCampaignDto,
  UpdateCrmTeamDto,
} from '../dto/campaign.dto';
import { CrmAccessService } from './crm-access.service';
import { CrmCampaignStatsService } from './crm-campaign-stats.service';
import { CrmCampaignVentesService } from './crm-campaign-ventes.service';
import { CrmEventsService } from './crm-events.service';

const JOUR = 86_400_000;
const PAQUET = 2000;
const EN_COURS = CAMPAGNES_EN_COURS;
/** Ajout quotidien : au plus 20 paquets de 2 000 par campagne et par passage. */
const PAQUETS_AJOUT_MAX = 20;
/** Panne du lancement automatique (délai dépassé, base injoignable) : plus d'essai seul. */
const PANNE_LANCEMENT = 'Le lancement a échoué : lancez-la à la main';

/** Bacs de l'aperçu, dans l'ordre où le lancement écarte les contacts. */
const BACS: BacApercu[] = ['non_interesses', 'injoignables', 'autre_campagne', 'agent_hors_equipe', 'captes_aujourdhui'];

const SELECT_PUBLIC = {
  segment: true,
  period_from: true,
  period_to: true,
  restaurant_ids: true,
  account: true,
  relapsed_only: true,
  offer_id: true,
  offer: { select: { id: true, label: true } },
  target_conversion_rate: true,
  target_contacts_count: true,
  targeted_count: true,
} satisfies Prisma.CrmCampaignPublicSelect;

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
  segments: true,
  distribution_mode: true,
  started_at: true,
  completed_at: true,
  targeted_count: true,
  duration_days: true,
  suspended_at: true,
  launch_error: true,
  created_at: true,
  lead_agent: { select: { id: true, fullname: true } },
  created_by: { select: { id: true, fullname: true } },
  offer: { select: { id: true, label: true } },
  assigned_agents: { select: { agent: { select: { id: true, fullname: true, role: true } } } },
  publics: { select: SELECT_PUBLIC, orderBy: { segment: 'asc' } },
} satisfies Prisma.CrmCampaignSelect;

/**
 * Ce que la carte doit savoir en plus : une campagne planifiée dont la date de
 * début est passée sans lancement (le lancement automatique la prendra dans
 * l'heure, ou `launch_error` dit pourquoi il ne le peut pas).
 */
function avecEtat<T extends { status: CampaignStatus; start_date: Date }>(c: T, maintenant = new Date()) {
  return { ...c, date_debut_passee: c.status === CampaignStatus.PLANIFIED && c.start_date <= maintenant };
}

/** Fin d'une campagne de N jours qui démarre ce jour-là : le dernier jour compris. */
const finApres = (depart: Date, duree: number) => new Date(jourUTC(depart).getTime() + (duree - 1) * JOUR);

function paquets<T>(liste: T[], taille = PAQUET): T[][] {
  const r: T[][] = [];
  for (let i = 0; i < liste.length; i += taille) r.push(liste.slice(i, i + taille));
  return r;
}

/** Date saisie « AAAA-MM-JJ » ou ISO → minuit UTC de ce jour (Abidjan est à UTC+0). */
const jour = (valeur: string): Date => jourUTC(valeur);

/** Public saisi (corps `publics`, ou reconstitué depuis l'ancien corps). */
type PublicSaisi = PublicCampagne & Pick<CampaignPublicDto, 'offer_id' | 'target_conversion_rate' | 'target_contacts_count'>;

/** Public saisi → ligne de "CrmCampaignPublic" : chaque critère sur le seul public qu'il concerne. */
function lignePublic(p: PublicSaisi) {
  const capte = estCapte(p.segment);
  return {
    segment: p.segment,
    period_from: p.period_from ? jourUTC(p.period_from) : null,
    period_to: p.period_to ? jourUTC(p.period_to) : null,
    restaurant_ids: capte ? [...new Set(p.restaurant_ids ?? [])] : [],
    account: capte ? (p.account ?? null) : null,
    relapsed_only: p.segment === CrmSegment.INACTIF ? !!p.relapsed_only : false,
    offer_id: p.offer_id ?? null,
    target_conversion_rate: p.target_conversion_rate ?? null,
    target_contacts_count: p.target_contacts_count ?? null,
  };
}

/** Champs de l'ancien corps recopiés à partir des publics : anciens écrans et puces. */
function champsCompatibles(publics: { segment: CrmSegment; period_from: Date | null; period_to: Date | null }[]) {
  const inscrits = publics.find((p) => p.segment === CrmSegment.JAMAIS_COMMANDE);
  return {
    segments: publics.map((p) => p.segment),
    registered_from: inscrits?.period_from ?? null,
    registered_to: inscrits?.period_to ?? null,
  };
}

/**
 * Publics du corps de requête : `publics`, sinon l'ancien corps (`segments`
 * et `registered_*`), complété par la campagne actuelle pour une modification.
 */
function publicsSaisis(
  dto: Partial<CreateCrmCampaignDto>,
  actuel?: { segments: CrmSegment[]; registered_from: Date | null; registered_to: Date | null },
): PublicSaisi[] | undefined {
  if (dto.publics) return dto.publics;
  if (dto.segments || dto.registered_from !== undefined || dto.registered_to !== undefined) {
    return publicsDepuisAncienCorps(
      dto.segments ?? actuel?.segments,
      dto.registered_from !== undefined ? dto.registered_from : actuel?.registered_from,
      dto.registered_to !== undefined ? dto.registered_to : actuel?.registered_to,
    );
  }
  return undefined;
}

/**
 * Campagnes de conversion (cahier §6) : une opération nommée, datée, avec un
 * pilote, une équipe et des objectifs, qui prend les contacts actifs au
 * lancement et les rend à la clôture.
 *
 * Règle d'or : un contact n'est que dans UNE campagne en cours à la fois, pour
 * ne jamais être sollicité deux fois.
 */
@Injectable()
export class CrmCampaignService {
  private readonly logger = new Logger(CrmCampaignService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CrmAccessService,
    private readonly events: CrmEventsService,
    private readonly stats: CrmCampaignStatsService,
    private readonly ventesCampagne: CrmCampaignVentesService,
  ) {}

  async lister(user: User, q: QueryCampaignsDto) {
    const where: Prisma.CrmCampaignWhereInput = {
      entity_status: { not: EntityStatus.DELETED },
      ...(q.status && { status: q.status }),
      ...(q.segment && { publics: { some: { segment: q.segment } } }),
      ...this.porteeCampagnes(user),
    };
    const campagnes = await this.prisma.crmCampaign.findMany({
      where,
      orderBy: { created_at: 'desc' },
      select: SELECT_CAMPAGNE,
    });
    const resumes = await this.stats.resumes(campagnes.map((c) => c.id));
    const maintenant = new Date();
    return campagnes.map((c) => ({ ...avecEtat(c, maintenant), resume: resumes.get(c.id) }));
  }

  async detail(user: User, id: string) {
    const c = await this.prisma.crmCampaign.findFirst({
      where: { id, entity_status: { not: EntityStatus.DELETED }, ...this.porteeCampagnes(user) },
      select: SELECT_CAMPAGNE,
    });
    if (!c) throw new NotFoundException('Campagne introuvable');
    const resume = (await this.stats.resumes([id])).get(id);
    return { ...avecEtat(c), resume };
  }

  async statistiques(user: User, id: string) {
    await this.detail(user, id);
    return this.stats.statistiques(id);
  }

  /**
   * Ventes comptées pour la campagne, page par page : mêmes droits que ses
   * statistiques. La consultation voit les téléphones, jamais les codes.
   */
  async ventes(user: User, id: string, q: CampaignVentesQueryDto) {
    await this.assertVisible(user, id);
    return this.ventesCampagne.lister(id, q, this.access.estLecteur(user));
  }

  /**
   * Campagne existante et dans la portée du compte, sinon 404 : la même règle
   * que le détail, sans relancer ses agrégats à chaque page.
   */
  private async assertVisible(user: User, id: string): Promise<void> {
    const c = await this.prisma.crmCampaign.findFirst({
      where: { id, entity_status: { not: EntityStatus.DELETED }, ...this.porteeCampagnes(user) },
      select: { id: true },
    });
    if (!c) throw new NotFoundException('Campagne introuvable');
  }

  /** Comparatif, avec la même portée que la liste pour un agent. */
  comparer(user: User, q: CompareCampaignsQueryDto) {
    return this.stats.comparer(q, this.porteeCampagnes(user));
  }

  /**
   * Un agent ne voit que les campagnes qu'il pilote ou dont il fait partie ;
   * la direction et la consultation les voient toutes. Un compte de point de
   * vente n'arrive pas jusqu'ici (`CrmSiegeGuard`).
   */
  private porteeCampagnes(user: User): Prisma.CrmCampaignWhereInput {
    if (this.access.estGestionnaire(user) || !this.access.peut(user, Action.UPDATE)) return {};
    return { OR: [{ lead_agent_id: user.id }, { assigned_agents: { some: { agent_id: user.id } } }] };
  }

  async creer(user: User, dto: CreateCrmCampaignDto) {
    const { debut, fin } = this.dates(dto.start_date, dto.end_date ?? undefined, dto.duration_days);
    const equipe = [...new Set(dto.agent_ids)];
    await this.verifierAgents([dto.lead_agent_id, ...equipe]);
    if (dto.offer_id) await this.verifierOffre(dto.offer_id);
    // Rien de choisi : les inscrits sans commande, comme avant.
    const publics = publicsSaisis(dto) ?? publicsDepuisAncienCorps(undefined);
    await this.verifierPublicsSaisis(publics);
    const lignes = publics.map(lignePublic);

    const c = await this.prisma.crmCampaign.create({
      data: {
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        start_date: debut,
        end_date: fin,
        // « Après N jours » : la fin provisoire part du début saisi, la vraie
        // se calcule au lancement. Une date saisie l'emporte sur la durée.
        duration_days: dto.end_date ? null : (dto.duration_days ?? null),
        target_conversion_rate: dto.target_conversion_rate ?? null,
        target_contacts_count: dto.target_contacts_count ?? null,
        ...champsCompatibles(lignes),
        distribution_mode: dto.distribution_mode ?? CampaignDistributionMode.AUTOMATIQUE,
        offer_id: dto.offer_id ?? null,
        lead_agent_id: dto.lead_agent_id,
        created_by_id: user.id,
        assigned_agents: { create: equipe.map((agent_id) => ({ agent_id })) },
        publics: { create: lignes },
      },
      select: SELECT_CAMPAGNE,
    });
    return avecEtat(c);
  }

  async modifier(id: string, dto: UpdateCrmCampaignDto) {
    const c = await this.trouver(id);
    if (c.status === CampaignStatus.COMPLETED) {
      throw new BadRequestException('Une campagne terminée ne se modifie plus');
    }
    const lancee = c.status !== CampaignStatus.PLANIFIED;
    if (lancee && (dto.start_date || dto.registered_from || dto.registered_to || dto.segments || dto.distribution_mode || dto.agent_ids || dto.lead_agent_id)) {
      throw new BadRequestException(
        "Campagne lancée : la population, le début et le mode de répartition sont figés. L'équipe se modifie à part.",
      );
    }
    if (lancee && dto.publics) this.verifierPublicsFiges(c.publics, dto.publics);
    const nouveauxPublics = lancee ? undefined : publicsSaisis(dto, c);
    // Seules les offres qui CHANGENT sont vérifiées : une offre désactivée
    // depuis ne bloque pas un simple renommage de la campagne.
    if (nouveauxPublics) {
      await this.verifierPublicsSaisis(nouveauxPublics, { offres: false });
      await this.verifierOffresChangees(c.publics, nouveauxPublics);
    } else if (dto.publics) await this.verifierOffresChangees(c.publics, dto.publics);
    if (dto.offer_id) await this.verifierOffre(dto.offer_id);
    const { debut, fin, duree } = this.datesModifiees(c, dto, lancee);
    if (!lancee) {
      if (dto.lead_agent_id || dto.agent_ids) {
        await this.verifierAgents([dto.lead_agent_id ?? c.lead_agent_id, ...(dto.agent_ids ?? [])]);
      }
    }

    return this.prisma.$transaction(async (tx) => {
      // La campagne ne doit pas avoir changé d'état depuis la lecture (un
      // lancement concurrent, par exemple) : sinon on remplacerait les publics
      // et l'équipe d'une campagne déjà en cours.
      const garde = await tx.crmCampaign.updateMany({ where: { id, status: c.status }, data: { updated_at: new Date() } });
      if (garde.count === 0) throw new ConflictException("La campagne vient de changer d'état : rechargez-la avant de la modifier");
      if (!lancee && dto.agent_ids) {
        await tx.crmCampaignAgent.deleteMany({ where: { campaign_id: id } });
        await tx.crmCampaignAgent.createMany({ data: [...new Set(dto.agent_ids)].map((agent_id) => ({ campaign_id: id, agent_id })) });
      }
      const lignes = nouveauxPublics?.map(lignePublic);
      if (lignes) {
        // Campagne planifiée : les publics et leurs critères se remplacent en bloc.
        await tx.crmCampaignPublic.deleteMany({ where: { campaign_id: id } });
        await tx.crmCampaignPublic.createMany({ data: lignes.map((l) => ({ ...l, campaign_id: id })) });
      } else if (lancee && dto.publics) {
        // Campagne lancée : seuls l'offre et les objectifs de chaque public changent.
        for (const p of dto.publics) {
          await tx.crmCampaignPublic.update({
            where: { campaign_id_segment: { campaign_id: id, segment: p.segment } },
            data: {
              ...(p.offer_id !== undefined && { offer_id: p.offer_id }),
              ...(p.target_conversion_rate !== undefined && { target_conversion_rate: p.target_conversion_rate }),
              ...(p.target_contacts_count !== undefined && { target_contacts_count: p.target_contacts_count }),
            },
          });
        }
      }
      const modifiee = await tx.crmCampaign.update({
        where: { id },
        data: {
          ...(dto.name && { name: dto.name.trim() }),
          ...(dto.description !== undefined && { description: dto.description.trim() || null }),
          start_date: debut,
          end_date: fin,
          duration_days: duree,
          // La direction a revu la campagne : le lancement automatique réessaie.
          launch_error: null,
          launch_failed_at: null,
          ...(dto.target_conversion_rate !== undefined && { target_conversion_rate: dto.target_conversion_rate }),
          ...(dto.target_contacts_count !== undefined && { target_contacts_count: dto.target_contacts_count }),
          ...(dto.offer_id !== undefined && { offer_id: dto.offer_id }),
          ...(lignes && champsCompatibles(lignes)),
          ...(!lancee && dto.distribution_mode && { distribution_mode: dto.distribution_mode }),
          ...(!lancee && dto.lead_agent_id && { lead_agent_id: dto.lead_agent_id }),
        },
        select: SELECT_CAMPAGNE,
      });
      return avecEtat(modifiee);
    });
  }

  /**
   * Aperçu de la population avant le lancement : pour chaque public, les
   * contacts disponibles (même filtre que le lancement) et ceux qu'il
   * écarterait, raison par raison. Rien n'est écrit.
   */
  async apercu(dto: PreviewCampaignDto) {
    await this.verifierPublicsSaisis(dto.publics, { offres: false, restaurants: false });
    // Comme au lancement : un agent désactivé, ou qui ne traite plus de
    // contacts, ne compte pas dans l'équipe.
    const actifs = dto.agent_ids?.length
      ? await this.prisma.user.findMany({
          where: {
            id: { in: [...new Set(dto.agent_ids)] },
            entity_status: EntityStatus.ACTIVE,
            role: { in: this.access.rolesAgents() },
          },
          select: { id: true },
        })
      : [];
    const equipe = actifs.map((a) => a.id);
    const maintenant = new Date();
    const publics = await Promise.all(
      dto.publics.map(async (p) => {
        const pub = lignePublic(p);
        const critere = critereCampagne(pub, equipe, maintenant);
        const bacs = bacsApercu(pub, equipe, maintenant);
        // Même filtre que le lancement : la somme par statut EST le nombre de disponibles.
        const [statuts, ...exclus] = await Promise.all([
          this.prisma.crmContact.groupBy({ by: ['status'], where: critere, _count: { _all: true } }),
          ...BACS.map((nom) => {
            const w = bacs[nom];
            return w ? this.prisma.crmContact.count({ where: w }) : Promise.resolve(0);
          }),
        ]);
        const parBac = Object.fromEntries(BACS.map((nom, i) => [nom, exclus[i]])) as Record<BacApercu, number>;
        return {
          segment: p.segment,
          disponibles: statuts.reduce((n, l) => n + l._count._all, 0),
          par_statut: Object.fromEntries(statuts.map((l) => [l.status, l._count._all])) as Partial<Record<CrmStatus, number>>,
          exclus: parBac,
          total_exclus: exclus.reduce((a, b) => a + b, 0),
        };
      }),
    );
    return {
      calcule_le: maintenant,
      disponibles: publics.reduce((a, p) => a + p.disponibles, 0),
      exclus: publics.reduce((a, p) => a + p.total_exclus, 0),
      publics,
    };
  }

  /**
   * Lancement (cahier §6.2) : la campagne prend, dans chacun de ses publics,
   * les contacts ouverts qui ne sont ni dans une campagne en cours, ni suivis
   * par un agent actif hors de l'équipe, ni (Glovo/Yango) captés aujourd'hui.
   * La population est figée ici (seul l'ajout quotidien des inscrits et des
   * inactifs à reprendre l'enrichit ensuite). Un contact déjà suivi par un
   * agent actif de l'équipe lui reste confié.
   *
   * Répartition manuelle : les autres contacts sont confiés au PILOTE, qui les
   * répartit. Sans lui, ils n'étaient dans la file de personne.
   *
   * `acteur` est null quand le lancement vient de la date de début (tâche
   * planifiée). « Après N jours » : la fin se calcule ici, depuis le jour du
   * lancement.
   */
  async lancer(acteur: User | null, id: string) {
    const debutChrono = Date.now();
    const avant = await this.trouver(id);
    if (avant.status !== CampaignStatus.PLANIFIED) throw new BadRequestException('Cette campagne est déjà lancée');
    if (!avant.duration_days && avant.end_date && avant.end_date < jourUTC(new Date())) {
      throw new BadRequestException('La date de fin est passée : modifiez-la avant de lancer');
    }
    this.equipeActive(avant);

    const maintenant = new Date();
    // Tout se décide dans la transaction, après la bascule en cours : une
    // modification concurrente ne peut plus changer les publics ou l'équipe,
    // et une fiche prise entre la lecture et l'écriture reste à qui l'a prise.
    const bilan = await this.prisma.$transaction(
      async (tx) => {
        const claim = await tx.crmCampaign.updateMany({
          where: { id, status: CampaignStatus.PLANIFIED },
          data: {
            status: CampaignStatus.ACTIVE,
            started_at: maintenant,
            launch_error: null,
            launch_failed_at: null,
          },
        });
        if (claim.count === 0) throw new BadRequestException('Cette campagne est déjà lancée');
        const c = await this.trouverDans(tx, id);
        const equipe = this.equipeActive(c);
        // Campagne créée avant le lot 3 sans ligne de public : on la reconstitue.
        const publics: PublicCampagne[] =
          c.publics.length > 0 ? c.publics : publicsDepuisAncienCorps(c.segments, c.registered_from, c.registered_to);
        const population = populationCampagne(publics, equipe, maintenant);

        const eligibles = await tx.crmContact.findMany({
          where: population,
          select: { id: true, assigned_to_id: true, segment: true, cycle: true },
          orderBy: { segment_since: 'desc' },
        });
        if (eligibles.length === 0) throw new BadRequestException('Aucun contact disponible pour cette population');

        const suiviDansEquipe = (p: { assigned_to_id: string | null }) => !!p.assigned_to_id && equipe.includes(p.assigned_to_id);
        const manuel = c.distribution_mode === CampaignDistributionMode.MANUEL;
        const pilote = manuel ? await this.piloteActif(tx, c.lead_agent_id) : null;
        const affectation = manuel
          ? new Map(eligibles.map((p) => [p.id, suiviDansEquipe(p) ? p.assigned_to_id : pilote]))
          : this.repartir(eligibles, equipe, new Map());
        const confiesAuPilote = new Set(pilote ? eligibles.filter((p) => !suiviDansEquipe(p)).map((p) => p.id) : []);

        if (c.publics.length === 0) {
          await tx.crmCampaignPublic.createMany({
            data: publics.map((p) => ({
              campaign_id: id,
              segment: p.segment,
              period_from: p.period_from ? jourUTC(p.period_from) : null,
              period_to: p.period_to ? jourUTC(p.period_to) : null,
            })),
            skipDuplicates: true,
          });
        }
        for (const lot of paquets(eligibles)) {
          await tx.crmCampaignMember.createMany({
            data: lot.map((p) => {
              const agent = affectation.get(p.id) ?? null;
              return {
                campaign_id: id,
                contact_id: p.id,
                agent_id: agent,
                assigned_at: agent ? maintenant : null,
                joined_at: maintenant,
                // Public et passage au ciblage : la campagne se lit par public.
                segment: p.segment,
                cycle: p.cycle,
              };
            }),
            skipDuplicates: true,
          });
        }
        await this.appliquerAffectation(tx, id, affectation, maintenant, population);
        // Fiches prises ailleurs entre la lecture et l'écriture : ni membres, ni comptées.
        await tx.crmCampaignMember.deleteMany({
          where: { campaign_id: id, contact: { OR: [{ campaign_id: null }, { campaign_id: { not: id } }] } },
        });
        const membres = await tx.crmCampaignMember.findMany({
          where: { campaign_id: id },
          select: { contact_id: true, segment: true, agent_id: true },
        });

        const parPublic = new Map<CrmSegment, number>(publics.map((p) => [p.segment, 0]));
        for (const m of membres) parPublic.set(m.segment, (parPublic.get(m.segment) ?? 0) + 1);
        for (const [segment, nombre] of parPublic) {
          await tx.crmCampaignPublic.updateMany({ where: { campaign_id: id, segment }, data: { targeted_count: nombre } });
        }
        // « Après N jours » : la fin part du jour du lancement. Lue après la
        // bascule, la durée ne peut plus changer d'ici la fin de la transaction.
        await tx.crmCampaign.update({
          where: { id },
          data: { targeted_count: membres.length, ...(c.duration_days && { end_date: finApres(maintenant, c.duration_days) }) },
        });
        for (const lot of paquets(membres)) {
          await this.events.journaliser(
            lot.map((m) => ({
              contact_id: m.contact_id,
              type: CrmEventType.CAMPAGNE_ENTREE,
              label: `Entre dans la campagne « ${c.name} »`,
              actor_id: acteur?.id ?? null,
              campaign_id: id,
            })),
            tx,
          );
        }
        const auPilote = membres.filter((m) => confiesAuPilote.has(m.contact_id) && m.agent_id === pilote).length;
        return { membres, publics, parPublic, auPilote, nom: c.name };
      },
      { timeout: 180_000, maxWait: 10_000 },
    );

    const { membres, publics, parPublic, auPilote } = bilan;
    // Mesure en production des grosses cibles (le lancement tient en une transaction de 180 s au plus).
    this.logger.log(
      `Campagne « ${bilan.nom} » lancée : ${membres.length} contacts en ${Math.round((Date.now() - debutChrono) / 100) / 10} s`,
    );
    // Un public vide ne bloque pas les autres : on lance, et on le dit.
    const avertissements = publics
      .filter((p) => parPublic.get(p.segment) === 0)
      .map((p) => `Aucun contact disponible pour le public « ${LIBELLES_PUBLIC[p.segment] ?? p.segment} » : la campagne part sans lui`);
    this.events.signaler(membres.slice(0, 500).map((m) => m.contact_id), 'campagne');
    return {
      cibles: membres.length,
      repartis: membres.filter((m) => m.agent_id).length,
      au_pilote: auPilote,
      par_public: [...parPublic].map(([segment, cibles]) => ({ segment, cibles })),
      avertissements,
    };
  }

  /**
   * Lancement automatique (tâche horaire) : chaque campagne planifiée dont la
   * date de début est arrivée passe par le MÊME lancement que le bouton. Un
   * refus (équipe vide, aucun contact) est écrit sur la carte et réessayé à
   * l'heure suivante. Une panne (délai dépassé...) arrête les essais : la
   * direction la lance à la main, ce qui efface la panne.
   *
   * Sûr en double serveur : la bascule « planifiée → en cours » est un claim,
   * et chaque écriture d'échec exige que la campagne soit encore planifiée.
   */
  async lancerPlanifiees(maintenant = new Date()) {
    const dues = await this.prisma.crmCampaign.findMany({
      where: {
        status: CampaignStatus.PLANIFIED,
        entity_status: { not: EntityStatus.DELETED },
        start_date: { lte: maintenant },
        launch_failed_at: null,
        OR: [{ duration_days: { not: null } }, { end_date: null }, { end_date: { gte: jourUTC(maintenant) } }],
      },
      orderBy: { start_date: 'asc' },
      select: { id: true, name: true, launch_error: true },
    });
    const bilan = { lancees: 0, refusees: 0, pannes: 0 };
    for (const c of dues) {
      try {
        await this.lancer(null, c.id);
        bilan.lancees++;
      } catch (e) {
        const refus = e instanceof HttpException && e.getStatus() < 500;
        const message = refus ? (e as Error).message.slice(0, 255) : PANNE_LANCEMENT;
        if (refus) {
          bilan.refusees++;
          // Écrit seulement s'il change : la tâche repasse toutes les heures.
          if (c.launch_error !== message) {
            await this.prisma.crmCampaign.updateMany({
              where: { id: c.id, status: CampaignStatus.PLANIFIED, launch_failed_at: null },
              data: { launch_error: message },
            });
          }
          this.logger.warn(`Lancement automatique de « ${c.name} » refusé : ${message}`);
        } else {
          bilan.pannes++;
          await this.prisma.crmCampaign.updateMany({
            where: { id: c.id, status: CampaignStatus.PLANIFIED, launch_failed_at: null },
            data: { launch_error: message, launch_failed_at: new Date() },
          });
          this.logger.error(`Lancement automatique de « ${c.name} » en panne : ${(e as Error).message}`);
        }
      }
    }
    return bilan;
  }

  /**
   * Campagne planifiée dont la date de fin fixe est passée sans lancement :
   * close, sans rapport ni notification. Elle n'a aucun contact à rendre, et
   * le comparatif l'ignore (jamais lancée).
   */
  async cloreNonLancees(maintenant = new Date()): Promise<number> {
    const { count } = await this.prisma.crmCampaign.updateMany({
      where: {
        status: CampaignStatus.PLANIFIED,
        entity_status: { not: EntityStatus.DELETED },
        duration_days: null,
        end_date: { lt: jourUTC(maintenant) },
      },
      data: { status: CampaignStatus.COMPLETED, completed_at: maintenant },
    });
    return count;
  }

  async suspendre(user: User, id: string) {
    const c = await this.changerStatut(user, id, CampaignStatus.ACTIVE, CampaignStatus.SUSPENDED, 'Seule une campagne en cours peut être suspendue', {
      suspended_at: new Date(),
      suspension_alert_sent_at: null,
    });
    await this.signalerCampagne(id);
    return c;
  }

  async reprendre(user: User, id: string) {
    const c = await this.changerStatut(user, id, CampaignStatus.SUSPENDED, CampaignStatus.ACTIVE, 'Seule une campagne suspendue peut reprendre', {
      suspended_at: null,
      suspension_alert_sent_at: null,
    });
    await this.signalerCampagne(id);
    return c;
  }

  private async changerStatut(
    user: User,
    id: string,
    depuis: CampaignStatus,
    vers: CampaignStatus,
    erreur: string,
    suivi: Pick<Prisma.CrmCampaignUpdateManyMutationInput, 'suspended_at' | 'suspension_alert_sent_at'>,
  ) {
    await this.trouver(id);
    await this.access.assertGestionnaireOuPilote(user, id);
    const claim = await this.prisma.crmCampaign.updateMany({ where: { id, status: depuis }, data: { status: vers, ...suivi } });
    if (claim.count === 0) throw new BadRequestException(erreur);
    const c = await this.prisma.crmCampaign.findUnique({ where: { id }, select: SELECT_CAMPAGNE });
    return c && avecEtat(c);
  }

  /**
   * Suspension et reprise changent la file de chaque agent de la campagne :
   * leurs écrans se rafraîchissent tout de suite, pas à la minute suivante.
   */
  private async signalerCampagne(id: string) {
    const ouverts = await this.prisma.crmContact.findMany({
      where: { campaign_id: id, status: { in: STATUTS_OUVERTS }, entity_status: { not: EntityStatus.DELETED } },
      select: { id: true },
      take: 500,
    });
    this.events.signaler(
      ouverts.map((o) => o.id),
      'campagne',
    );
  }

  /**
   * Clôture : les indicateurs sont figés (rapport version 2, statuts et
   * publics compris) et chaque contact non converti quitte la campagne. Un
   * intéressé, un coupon encore valable ou un rappel promis à venir restent à
   * leur agent ; tous les autres sont libérés (un Glovo/Yango revient alors
   * dans la file commune). `acteur` est null quand la clôture vient de la date
   * de fin (tâche planifiée).
   */
  async terminer(acteur: User | null, id: string) {
    const c = await this.trouver(id);
    if (acteur) await this.access.assertGestionnaireOuPilote(acteur, id);
    if (!EN_COURS.includes(c.status)) throw new BadRequestException("Cette campagne n'est pas en cours");

    const stats = await this.stats.statistiques(id);
    const rapport = JSON.parse(JSON.stringify({ version: 2, ...stats })) as Prisma.InputJsonValue;
    const maintenant = new Date();
    const bilan = await this.prisma.$transaction(
      async (tx) => {
        const claim = await tx.crmCampaign.updateMany({
          where: { id, status: { in: EN_COURS } },
          data: { status: CampaignStatus.COMPLETED, completed_at: maintenant, report: rapport },
        });
        if (claim.count === 0) throw new BadRequestException("Cette campagne n'est pas en cours");
        const ouverts = await tx.crmCampaignMember.findMany({
          where: { campaign_id: id, released_at: null },
          select: { contact_id: true },
        });
        await tx.crmCampaignMember.updateMany({
          where: { campaign_id: id, released_at: null },
          data: { released_at: maintenant, release_reason: CrmReleaseReason.FIN_CAMPAGNE },
        });
        const contacts = await tx.crmContact.findMany({
          where: { campaign_id: id, status: { not: CrmStatus.CONVERTI } },
          select: {
            id: true,
            status: true,
            segment: true,
            callback_at: true,
            assigned_to_id: true,
            assigned_to: { select: { fullname: true, entity_status: true, role: true } },
            coupons: { where: { used_at: null, expires_at: { gt: maintenant } }, select: { id: true }, take: 1 },
          },
        });
        const gardes: string[] = [];
        const liberes: string[] = [];
        const libelles = new Map<string, string>();
        const rolesAgents = this.access.rolesAgents();
        for (const x of contacts) {
          const sortie = sortieFinCampagne(x, x.coupons.length > 0, maintenant);
          // Un agent désactivé, ou passé en consultation, ne tiendra pas la
          // promesse : le contact est libéré.
          if (
            sortie === 'GARDER_AGENT' &&
            x.assigned_to_id &&
            x.assigned_to?.entity_status === EntityStatus.ACTIVE &&
            rolesAgents.includes(x.assigned_to.role)
          ) {
            gardes.push(x.id);
            libelles.set(x.id, `Fin de la campagne « ${c.name} » : reste confié à ${x.assigned_to?.fullname ?? 'son agent'}`);
          } else {
            liberes.push(x.id);
            // Où va un contact encore à travailler : la file commune pour un
            // Glovo/Yango, le vivier « à reprendre » pour un inscrit ou un inactif.
            const suite = !STATUTS_OUVERTS.includes(x.status)
              ? ''
              : estCapte(x.segment)
                ? ', retour dans la file commune'
                : PUBLICS_VIVIER.includes(x.segment)
                  ? ', à reprendre'
                  : '';
            libelles.set(x.id, `Fin de la campagne « ${c.name} » : libéré${suite}`);
          }
        }
        for (const lot of paquets(gardes)) {
          await tx.crmContact.updateMany({ where: { id: { in: lot }, campaign_id: id }, data: { campaign_id: null } });
        }
        for (const lot of paquets(liberes)) {
          await tx.crmContact.updateMany({
            where: { id: { in: lot }, campaign_id: id },
            data: { campaign_id: null, assigned_to_id: null, assigned_at: null },
          });
        }
        for (const lot of paquets(ouverts)) {
          await this.events.journaliser(
            lot.map((m) => ({
              contact_id: m.contact_id,
              type: CrmEventType.CAMPAGNE_SORTIE,
              label: libelles.get(m.contact_id) ?? `Fin de la campagne « ${c.name} »`,
              actor_id: acteur?.id ?? null,
              campaign_id: id,
            })),
            tx,
          );
        }
        return { sortis: ouverts.length, gardes, liberes };
      },
      { timeout: 180_000, maxWait: 10_000 },
    );
    this.events.signaler([...bilan.gardes, ...bilan.liberes].slice(0, 500), 'campagne');
    return {
      sortis: bilan.sortis,
      liberes: bilan.liberes.length,
      gardes: bilan.gardes.length,
      message: `${compter(bilan.liberes.length, 'contact libéré', 'contacts libérés')}, ${
        bilan.gardes.length >= 2 ? `${bilan.gardes.length} contacts restés à leur agent` : `${bilan.gardes.length} contact resté à son agent`
      }`,
      rapport,
    };
  }

  /**
   * Répartition équilibrée (cahier §6.2) : chaque contact sans agent va à
   * l'agent de l'équipe qui en a le moins. Avec `inclure_non_appeles`, les
   * contacts jamais appelés sont remis en jeu aussi, pour rééquilibrer après
   * un changement d'équipe.
   */
  async distribuer(acteur: User | null, id: string, dto: DistributeCrmDto) {
    const c = await this.trouver(id);
    // `acteur` null : une tâche planifiée (agent parti) redistribue.
    if (acteur) await this.access.assertGestionnaireOuPilote(acteur, id);
    if (!EN_COURS.includes(c.status)) throw new BadRequestException("Cette campagne n'est pas en cours");
    const equipe = this.equipeActive(c);

    const membres = await this.prisma.crmCampaignMember.findMany({
      where: {
        campaign_id: id,
        released_at: null,
        contact: { status: { in: STATUTS_OUVERTS }, entity_status: { not: EntityStatus.DELETED } },
      },
      select: { contact_id: true, agent_id: true, contact: { select: { call_count: true } } },
      // Les plus récemment entrés dans leur public d'abord : trier sur
      // l'inscription mettait en tête les fiches sans compte (date nulle).
      orderBy: { contact: { segment_since: 'desc' } },
    });
    const aRepartir = membres.filter(
      (m) => !m.agent_id || !equipe.includes(m.agent_id) || (dto.inclure_non_appeles && m.contact.call_count === 0),
    );
    const charge = new Map<string, number>(equipe.map((a) => [a, 0]));
    for (const m of membres) {
      if (m.agent_id && charge.has(m.agent_id) && !aRepartir.includes(m)) charge.set(m.agent_id, charge.get(m.agent_id)! + 1);
    }
    const affectation = this.repartir(
      aRepartir.map((m) => ({ id: m.contact_id, assigned_to_id: null })),
      equipe,
      charge,
    );
    const maintenant = new Date();
    await this.prisma.$transaction(
      async (tx) => {
        await this.appliquerAffectation(tx, id, affectation, maintenant);
        for (const lot of paquets([...affectation.entries()])) {
          await this.events.journaliser(
            lot.map(([contact_id]) => ({
              contact_id,
              type: CrmEventType.ASSIGNATION,
              label: 'Réparti automatiquement dans la campagne',
              actor_id: acteur?.id ?? null,
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
   * Équipe (cahier §9 : le pilote gère son équipe). Campagne en cours en
   * répartition automatique : un agent retiré rend ses contacts, aussitôt
   * confiés aux autres ; un agent ajouté reçoit sa part des contacts jamais
   * appelés. Répartition manuelle : les contacts ouverts d'un agent retiré
   * vont au pilote (sauf si c'est le pilote qu'on retire : ils restent sans
   * agent), et un agent ajouté ne reçoit rien tout seul.
   */
  async modifierEquipe(user: User, id: string, dto: UpdateCrmTeamDto) {
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
    const ajoutes = equipe.filter((a) => !anciens.includes(a));
    const enCours = EN_COURS.includes(c.status);
    const pilote = dto.lead_agent_id ?? c.lead_agent_id;
    // Ce que le pilote reprend : les contacts ouverts des agents retirés, autres que lui.
    const versPilote = c.distribution_mode === CampaignDistributionMode.MANUEL && enCours ? retires.filter((a) => a !== pilote) : [];
    const maintenant = new Date();

    const rendus = await this.prisma.$transaction(async (tx) => {
      await tx.crmCampaignAgent.deleteMany({ where: { campaign_id: id, agent_id: { in: retires } } });
      await tx.crmCampaignAgent.createMany({
        data: ajoutes.map((agent_id) => ({ campaign_id: id, agent_id })),
        skipDuplicates: true,
      });
      if (dto.lead_agent_id) await tx.crmCampaign.update({ where: { id }, data: { lead_agent_id: dto.lead_agent_id } });
      let auPilote: string[] = [];
      if (versPilote.length > 0) {
        const piloteId = await this.piloteActif(tx, pilote);
        if (piloteId) {
          const ouverts = await tx.crmContact.findMany({
            where: {
              campaign_id: id,
              assigned_to_id: { in: versPilote },
              status: { in: STATUTS_OUVERTS },
              entity_status: { not: EntityStatus.DELETED },
            },
            select: { id: true },
          });
          auPilote = ouverts.map((o) => o.id);
          await this.appliquerAffectation(tx, id, new Map(auPilote.map((x) => [x, piloteId])), maintenant);
          for (const lot of paquets(auPilote)) {
            await this.events.journaliser(
              lot.map((contact_id) => ({
                contact_id,
                type: CrmEventType.ASSIGNATION,
                label: "Confié au pilote : son agent a quitté l'équipe",
                actor_id: user.id,
                campaign_id: id,
              })),
              tx,
            );
          }
        }
      }
      if (retires.length > 0) {
        await tx.crmCampaignMember.updateMany({
          where: { campaign_id: id, released_at: null, agent_id: { in: retires } },
          data: { agent_id: null, assigned_at: null },
        });
        await tx.crmContact.updateMany({
          where: { campaign_id: id, assigned_to_id: { in: retires }, status: { not: CrmStatus.CONVERTI } },
          data: { assigned_to_id: null, assigned_at: null },
        });
      }
      return auPilote;
    });
    this.events.signaler(rendus.slice(0, 500), 'assignation');

    if (enCours && c.distribution_mode === CampaignDistributionMode.AUTOMATIQUE && (retires.length > 0 || ajoutes.length > 0)) {
      // Un renfort reçoit sa part des contacts que personne n'a encore appelés.
      await this.distribuer(user, id, { inclure_non_appeles: ajoutes.length > 0 });
    }
    return this.detail(user, id);
  }

  /**
   * Ajout quotidien (05 h 50) : chaque campagne EN COURS en répartition
   * AUTOMATIQUE reprend, dans le vivier « à reprendre », les inscrits et les
   * inactifs qui répondent à ses critères (libérés d'une campagne, nouveaux
   * inactifs, nouveaux inscrits), et les répartit dans son équipe. La plus
   * ancienne campagne se sert d'abord : un contact n'entre que dans une.
   * Une campagne en répartition manuelle ne reçoit rien.
   *
   * Par paquets de 2 000, une transaction chacun, 20 paquets au plus par
   * campagne et par passage. Chaque fiche est prise par un claim (toujours
   * sans agent ni campagne en cours au moment d'écrire) : sûr en double
   * serveur, et sans effet sur une campagne close entre-temps.
   */
  async rejoindreCampagnes(maintenant = new Date()) {
    const campagnes = await this.prisma.crmCampaign.findMany({
      where: {
        status: CampaignStatus.ACTIVE,
        distribution_mode: CampaignDistributionMode.AUTOMATIQUE,
        entity_status: { not: EntityStatus.DELETED },
      },
      orderBy: { started_at: 'asc' },
      select: { id: true },
    });
    const bilan: { campagne: string; entres: number }[] = [];
    for (const { id } of campagnes) {
      const c = await this.trouver(id);
      let equipe: string[];
      try {
        equipe = this.equipeActive(c);
      } catch {
        this.logger.warn(`Ajout du jour : campagne « ${c.name} » sautée, aucun agent actif dans son équipe`);
        continue;
      }
      const publics: PublicCampagne[] = (
        c.publics.length > 0 ? c.publics : publicsDepuisAncienCorps(c.segments, c.registered_from, c.registered_to)
      ).filter((p) => PUBLICS_VIVIER.includes(p.segment));
      let entres = 0;
      let paquetsFaits = 0;
      for (const pub of publics) {
        // Condition de la revendication : toujours disponible et sans agent au moment d'écrire.
        const critere: Prisma.CrmContactWhereInput = { AND: [critereCampagne(pub, equipe, maintenant), { assigned_to_id: null }] };
        // Déjà passé par cette campagne (converti puis retombé, par exemple) :
        // il n'y revient pas, sa ligne de membre existe déjà.
        const candidats: Prisma.CrmContactWhereInput = { AND: [critere, { members: { none: { campaign_id: id } } }] };
        while (paquetsFaits < PAQUETS_AJOUT_MAX) {
          const lot = await this.prisma.crmContact.findMany({
            where: candidats,
            select: { id: true, assigned_to_id: true, segment: true, cycle: true },
            orderBy: [{ segment_since: 'desc' }, { id: 'asc' }],
            take: PAQUET,
          });
          if (lot.length === 0) break;
          paquetsFaits++;
          const n = await this.rejoindre(id, c.name, pub.segment, equipe, lot, critere, maintenant);
          entres += n;
          // Rien n'est entré : les suivants seraient les mêmes, on s'arrête.
          if (lot.length < PAQUET || n === 0) break;
        }
      }
      if (entres > 0) {
        bilan.push({ campagne: c.name, entres });
        this.logger.log(`Ajout du jour : ${compter(entres, 'contact entré', 'contacts entrés')} dans la campagne « ${c.name} »`);
      }
    }
    return bilan;
  }

  /** Un paquet de l'ajout quotidien, dans sa transaction. Renvoie le nombre de contacts réellement entrés. */
  private async rejoindre(
    id: string,
    nom: string,
    segment: CrmSegment,
    equipe: string[],
    lot: { id: string; assigned_to_id: string | null; segment: CrmSegment; cycle: number }[],
    condition: Prisma.CrmContactWhereInput,
    maintenant: Date,
  ): Promise<number> {
    const entres = await this.prisma.$transaction(
      async (tx) => {
        // La campagne doit être encore en cours : le verrou pris ici fait
        // attendre une clôture concurrente, qui rendra alors ces contacts.
        const enCours = await tx.crmCampaign.updateMany({
          where: { id, status: CampaignStatus.ACTIVE },
          data: { updated_at: maintenant },
        });
        if (enCours.count === 0) return [];
        const ids = lot.map((p) => p.id);
        await tx.crmCampaignMember.createMany({
          data: lot.map((p) => ({ campaign_id: id, contact_id: p.id, joined_at: maintenant, segment: p.segment, cycle: p.cycle })),
          skipDuplicates: true,
        });
        // Charge actuelle : contacts ouverts déjà confiés dans la campagne.
        const charges = await tx.crmContact.groupBy({
          by: ['assigned_to_id'],
          where: {
            campaign_id: id,
            assigned_to_id: { in: equipe },
            status: { in: STATUTS_OUVERTS },
            entity_status: { not: EntityStatus.DELETED },
          },
          _count: { _all: true },
        });
        const charge = new Map(
          charges.filter((g) => g.assigned_to_id).map((g) => [g.assigned_to_id as string, g._count._all] as const),
        );
        const affectation = this.repartir(lot, equipe, charge);
        await this.appliquerAffectation(tx, id, affectation, maintenant, condition);
        // Fiches prises ailleurs entre la lecture et l'écriture : leur membre créé ici disparaît.
        await tx.crmCampaignMember.deleteMany({
          where: {
            campaign_id: id,
            contact_id: { in: ids },
            joined_at: maintenant,
            contact: { OR: [{ campaign_id: null }, { campaign_id: { not: id } }] },
          },
        });
        // Entrés par CE passage : rattachés à la campagne à cette heure-ci.
        const entres = await tx.crmContact.findMany({
          where: { id: { in: ids }, campaign_id: id, assigned_at: maintenant },
          select: { id: true },
        });
        if (entres.length === 0) return [];
        await tx.crmCampaign.update({ where: { id }, data: { targeted_count: { increment: entres.length } } });
        await tx.crmCampaignPublic.updateMany({
          where: { campaign_id: id, segment },
          data: { targeted_count: { increment: entres.length } },
        });
        await this.events.journaliser(
          entres.map((x) => ({
            contact_id: x.id,
            type: CrmEventType.CAMPAGNE_ENTREE,
            label: `Entre dans la campagne « ${nom} » (ajout du jour)`,
            actor_id: null,
            campaign_id: id,
          })),
          tx,
        );
        return entres.map((x) => x.id);
      },
      { timeout: 180_000, maxWait: 10_000 },
    );
    this.events.signaler(entres.slice(0, 500), 'campagne');
    return entres.length;
  }

  /**
   * Agents partis (chaque heure) : les fiches ouvertes d'un compte désactivé,
   * ou dont le rôle ne traite plus de contacts, ne restent pas bloquées chez
   * lui. Hors campagne en cours, elles sont libérées (un Glovo/Yango revient
   * dans la file commune, un inscrit ou un inactif dans le vivier « à
   * reprendre »). Dans une campagne en cours, elles sont redonnées à l'équipe
   * (répartition automatique) ou au pilote (répartition manuelle).
   */
  async libererAgentsPartis() {
    const fiches = await this.prisma.crmContact.findMany({
      where: {
        status: { in: STATUTS_OUVERTS },
        entity_status: { not: EntityStatus.DELETED },
        assigned_to: {
          OR: [{ entity_status: { not: EntityStatus.ACTIVE } }, { role: { notIn: this.access.rolesAgents() } }],
        },
      },
      select: {
        id: true,
        assigned_to_id: true,
        campaign_id: true,
        campaign: { select: { status: true, distribution_mode: true, lead_agent_id: true } },
      },
      orderBy: { id: 'asc' },
      take: PAQUET,
    });
    if (fiches.length === 0) return { liberes: 0, campagnes: 0 };

    // Revendication fiche par fiche, conditionnée à ce qui a été lu : un
    // second serveur passé avant, ou un geste entre-temps, et on n'écrit rien
    // (ni agent, ni ligne de journal en double).
    const liberes: { id: string; campaign_id: string | null }[] = [];
    const campagnes = new Map<string, { mode: CampaignDistributionMode; pilote: string; partis: Set<string> }>();
    for (const f of fiches) {
      const enCampagne = !!f.campaign_id && !!f.campaign && EN_COURS.includes(f.campaign.status);
      const { count } = await this.prisma.crmContact.updateMany({
        where: { id: f.id, assigned_to_id: f.assigned_to_id, campaign_id: f.campaign_id, status: { in: STATUTS_OUVERTS } },
        data: { assigned_to_id: null, assigned_at: null },
      });
      if (count !== 1) continue;
      liberes.push({ id: f.id, campaign_id: f.campaign_id });
      if (enCampagne && f.campaign_id && f.campaign) {
        await this.prisma.crmCampaignMember.updateMany({
          where: { campaign_id: f.campaign_id, contact_id: f.id, released_at: null },
          data: { agent_id: null, assigned_at: null },
        });
        const c = campagnes.get(f.campaign_id) ?? {
          mode: f.campaign.distribution_mode,
          pilote: f.campaign.lead_agent_id,
          partis: new Set<string>(),
        };
        if (f.assigned_to_id) c.partis.add(f.assigned_to_id);
        campagnes.set(f.campaign_id, c);
      }
    }
    for (const lot of paquets(liberes)) {
      await this.events.journaliser(
        lot.map((f) => ({
          contact_id: f.id,
          type: CrmEventType.ASSIGNATION,
          label: "Libéré : son agent n'est plus actif",
          actor_id: null,
          campaign_id: f.campaign_id,
        })),
      );
    }

    // Dans une campagne en cours : l'équipe (automatique) ou le pilote (manuelle) reprend.
    for (const [campagneId, c] of campagnes) {
      if (c.mode === CampaignDistributionMode.AUTOMATIQUE) {
        try {
          await this.distribuer(null, campagneId, {});
        } catch (e) {
          // Équipe sans agent actif : les contacts restent sans agent, comptés sur la carte.
          this.logger.warn(`Agents partis : campagne ${campagneId} non redistribuée : ${(e as Error).message}`);
        }
        continue;
      }
      if (c.partis.has(c.pilote)) continue;
      const ids = liberes.filter((f) => f.campaign_id === campagneId).map((f) => f.id);
      await this.prisma.$transaction(async (tx) => {
        const pilote = await this.piloteActif(tx, c.pilote);
        if (!pilote) return;
        const maintenant = new Date();
        await this.appliquerAffectation(tx, campagneId, new Map(ids.map((x) => [x, pilote])), maintenant, {
          campaign_id: campagneId,
          assigned_to_id: null,
          status: { in: STATUTS_OUVERTS },
        });
      });
    }
    this.events.signaler(
      liberes.slice(0, 500).map((f) => f.id),
      'assignation',
    );
    return { liberes: liberes.length, campagnes: campagnes.size };
  }

  // ---------------- Outils ----------------

  /** Chaque contact va à l'agent le moins chargé ; un agent de l'équipe garde les siens. */
  private repartir(
    contacts: { id: string; assigned_to_id: string | null }[],
    equipe: string[],
    chargeInitiale: Map<string, number>,
  ): Map<string, string | null> {
    const charge = new Map<string, number>(equipe.map((a) => [a, chargeInitiale.get(a) ?? 0]));
    const affectation = new Map<string, string | null>();
    for (const p of contacts) {
      if (p.assigned_to_id && charge.has(p.assigned_to_id)) {
        affectation.set(p.id, p.assigned_to_id);
        charge.set(p.assigned_to_id, charge.get(p.assigned_to_id)! + 1);
      }
    }
    for (const p of contacts) {
      if (affectation.has(p.id)) continue;
      let moinsCharge = equipe[0];
      for (const a of equipe) if (charge.get(a)! < charge.get(moinsCharge)!) moinsCharge = a;
      affectation.set(p.id, moinsCharge);
      charge.set(moinsCharge, charge.get(moinsCharge)! + 1);
    }
    return affectation;
  }

  /**
   * `condition` (lancement) : la fiche n'est prise que si elle répond encore à
   * la population au moment d'écrire. Un contact pris entre-temps dans la
   * file commune, ou par une autre campagne, reste où il est.
   */
  private async appliquerAffectation(
    tx: Prisma.TransactionClient,
    campagneId: string,
    affectation: Map<string, string | null>,
    maintenant: Date,
    condition?: Prisma.CrmContactWhereInput,
  ) {
    const parAgent = new Map<string | null, string[]>();
    affectation.forEach((agent, contact) => parAgent.set(agent, [...(parAgent.get(agent) ?? []), contact]));
    for (const [agent, ids] of parAgent) {
      for (const lot of paquets(ids)) {
        await tx.crmContact.updateMany({
          where: condition ? { AND: [{ id: { in: lot } }, condition] } : { id: { in: lot } },
          data: { campaign_id: campagneId, assigned_to_id: agent, assigned_at: agent ? maintenant : null },
        });
        await tx.crmCampaignMember.updateMany({
          where: { campaign_id: campagneId, contact_id: { in: lot } },
          data: { agent_id: agent, assigned_at: agent ? maintenant : null, alert_sent_at: null },
        });
      }
    }
  }

  private trouver(id: string) {
    return this.trouverDans(this.prisma, id);
  }

  private async trouverDans(client: Pick<Prisma.TransactionClient, 'crmCampaign'>, id: string) {
    const c = await client.crmCampaign.findFirst({
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
        segments: true,
        started_at: true,
        duration_days: true,
        assigned_agents: { select: { agent_id: true, agent: { select: { entity_status: true, role: true } } } },
        publics: {
          select: {
            segment: true,
            period_from: true,
            period_to: true,
            restaurant_ids: true,
            account: true,
            relapsed_only: true,
            offer_id: true,
          },
          orderBy: { segment: 'asc' },
        },
      },
    });
    if (!c) throw new NotFoundException('Campagne introuvable');
    return c;
  }

  /**
   * Équipe qui travaille vraiment : un agent désactivé, ou dont le rôle ne
   * traite plus de contacts (plus de droit UPDATE sur le CRM, passé en
   * consultation), resté dans l'équipe ne reçoit rien, et ses contacts sont
   * repris comme ceux de tout agent parti.
   */
  private equipeActive(c: { assigned_agents: { agent_id: string; agent: { entity_status: EntityStatus; role: UserRole } }[] }) {
    const roles = this.access.rolesAgents();
    const equipe = c.assigned_agents
      .filter((a) => a.agent.entity_status === EntityStatus.ACTIVE && roles.includes(a.agent.role))
      .map((a) => a.agent_id);
    if (equipe.length === 0) {
      throw new BadRequestException(
        c.assigned_agents.length === 0
          ? "L'équipe de la campagne est vide"
          : "Aucun agent actif et habilité aux contacts dans l'équipe : complétez-la avant de continuer",
      );
    }
    return equipe;
  }

  /**
   * Pilote qui peut recevoir des contacts (répartition manuelle) : compte
   * actif dont le rôle traite des contacts. Sinon null : les contacts restent
   * sans agent, comptés sur la carte de la campagne.
   */
  private async piloteActif(client: Pick<Prisma.TransactionClient, 'user'>, piloteId: string): Promise<string | null> {
    const actif = await client.user.count({
      where: { id: piloteId, entity_status: EntityStatus.ACTIVE, role: { in: this.access.rolesAgents() } },
    });
    return actif > 0 ? piloteId : null;
  }

  private dates(debutSaisi: string, finSaisie?: string, duree?: number) {
    const debut = jour(debutSaisi);
    const fin = finSaisie ? jour(finSaisie) : duree ? new Date(debut.getTime() + (duree - 1) * JOUR) : null;
    if (fin && fin < debut) throw new BadRequestException('La date de fin précède la date de début');
    return { debut, fin };
  }

  /**
   * Dates d'une campagne modifiée. Une fin saisie, ou effacée (`null`),
   * remplace la durée. Une durée (saisie ou déjà enregistrée) compte depuis
   * le lancement d'une campagne lancée, depuis le début saisi sinon (fin
   * provisoire). Sans rien de tout ça, la fin ne bouge pas.
   */
  private datesModifiees(
    c: { start_date: Date; end_date: Date | null; started_at: Date | null; duration_days: number | null },
    dto: Pick<UpdateCrmCampaignDto, 'start_date' | 'end_date' | 'duration_days'>,
    lancee: boolean,
  ) {
    const debut = jour(dto.start_date ?? c.start_date.toISOString());
    const finEffacee = dto.end_date === null;
    const finSaisie = dto.end_date || undefined;
    const duree = finEffacee || finSaisie ? null : (dto.duration_days ?? c.duration_days ?? null);
    const depart = lancee && c.started_at ? jourUTC(c.started_at) : debut;
    const fin = finEffacee ? null : finSaisie ? jour(finSaisie) : duree ? finApres(depart, duree) : c.end_date;
    // Une campagne lancée avant sa date de début se juge sur son vrai départ.
    const plancher = depart < debut ? depart : debut;
    if (fin && fin < plancher) throw new BadRequestException('La date de fin précède la date de début');
    return { debut, fin, duree };
  }

  /** Cohérence des publics, offres actives et restaurants existants. */
  private async verifierPublicsSaisis(
    publics: PublicSaisi[],
    options: { offres?: boolean; restaurants?: boolean } = {},
  ) {
    const erreurs = verifierPublics(publics);
    if (erreurs.length > 0) throw new BadRequestException(erreurs.join('. '));
    if (options.offres !== false) await this.verifierOffresPubliques(publics);
    if (options.restaurants !== false) {
      const ids = [...new Set(publics.flatMap((p) => p.restaurant_ids ?? []))];
      if (ids.length > 0) {
        const trouves = await this.prisma.restaurant.count({
          where: { id: { in: ids }, entity_status: { not: EntityStatus.DELETED } },
        });
        if (trouves !== ids.length) throw new BadRequestException('Un restaurant de capture choisi est inconnu ou supprimé');
      }
    }
  }

  /** Offre de public nouvelle ou changée : elle doit exister et être active ; le message nomme le public. */
  private async verifierOffresChangees(
    actuels: { segment: CrmSegment; offer_id: string | null }[],
    saisis: { segment: CrmSegment; offer_id?: string | null }[],
  ) {
    for (const p of saisis) {
      if (!p.offer_id) continue;
      if (actuels.find((a) => a.segment === p.segment)?.offer_id === p.offer_id) continue;
      const offre = await this.prisma.crmOffer.findFirst({
        where: { id: p.offer_id, is_active: true, entity_status: { not: EntityStatus.DELETED } },
        select: { id: true },
      });
      if (!offre) {
        throw new BadRequestException(`Offre inconnue ou désactivée pour le public « ${LIBELLES_PUBLIC[p.segment] ?? p.segment} » : choisissez-en une autre`);
      }
    }
  }

  private async verifierOffresPubliques(publics: PublicSaisi[]) {
    for (const offre of new Set(publics.map((p) => p.offer_id).filter((v): v is string => !!v))) {
      await this.verifierOffre(offre);
    }
  }

  /**
   * Campagne lancée : les critères de chaque public sont figés. Un critère
   * absent du corps ne change pas ; un critère présent doit être identique.
   */
  private verifierPublicsFiges(existants: PublicCampagne[], saisis: CampaignPublicDto[]) {
    for (const p of saisis) {
      const actuel = existants.find((e) => e.segment === p.segment);
      const definis = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) as Partial<PublicCampagne>;
      if (!actuel || !memesCriteres(actuel, { ...actuel, ...definis })) {
        throw new BadRequestException(
          "Campagne lancée : les publics et leurs critères sont figés. Seuls l'offre et les objectifs de chaque public se modifient",
        );
      }
    }
  }

  private async verifierAgents(ids: string[]) {
    const uniques = [...new Set(ids)];
    const trouves = await this.prisma.user.count({
      where: { id: { in: uniques }, entity_status: EntityStatus.ACTIVE, role: { in: this.access.rolesAgents() } },
    });
    if (trouves !== uniques.length) {
      throw new BadRequestException('Le pilote et les agents doivent être des comptes actifs habilités aux contacts');
    }
  }

  private async verifierOffre(id: string) {
    const offre = await this.prisma.crmOffer.findFirst({
      where: { id, is_active: true, entity_status: { not: EntityStatus.DELETED } },
      select: { id: true },
    });
    if (!offre) throw new BadRequestException('Offre inconnue ou désactivée');
  }
}
