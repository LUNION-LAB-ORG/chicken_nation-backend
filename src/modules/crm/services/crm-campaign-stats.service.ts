import { Injectable, NotFoundException } from '@nestjs/common';
import { CampaignStatus, CrmSegment, EntityStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { MEMBRE_DE_LA_VENTE_SQL, VENTE_DE_CAMPAGNE_SQL, criteresEnClair, estCapte } from '../crm-campagne.rules';
import { STATUTS_OUVERTS } from '../crm.rules';
import { CompareCampaignsQueryDto } from '../dto/campaign.dto';

const JOUR = 86_400_000;
/** Vente de campagne : enregistrée par le CRM (jamais l'historique d'acquisition) et valide. Même fragment que la liste des ventes. */
const VENTE_CRM = Prisma.raw(VENTE_DE_CAMPAGNE_SQL);
/** Membre qui porte la vente (alias m) : son public au ciblage. */
const MEMBRE_VENTE = Prisma.raw(MEMBRE_DE_LA_VENTE_SQL);
/** Coupon utilisé sur une commande ni annulée ni supprimée (alias cc sur le coupon, oc sur la commande). */
const COUPON_UTILISE = Prisma.raw(
  `cc."used_at" IS NOT NULL AND coalesce(oc."status"::text, '') <> 'CANCELLED' AND coalesce(oc."entity_status"::text, '') <> 'DELETED'`,
);
const OUVERTS = Prisma.join(STATUTS_OUVERTS);

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

export interface IndicateursCampagne {
  cibles: number;
  traites: number;
  restants: number;
  /** Ciblés encore dans la campagne et à travailler (statut ouvert), appelés ou non. 0 une fois close. */
  ouverts: number;
  joints: number;
  appels: number;
  couverture: number;
  taux_contact: number;
  coupons_envoyes: number;
  coupons_utilises: number;
  taux_utilisation: number;
  ca_coupons: number;
  conversions: number;
  taux_conversion: number;
  ca_conversions: number;
  panier_moyen: number;
  objectif_taux_conversion: number | null;
  objectif_contacts: number | null;
  /** Joints rapportés à l'objectif de contacts à joindre, en %. */
  progression_objectif_contacts: number | null;
}

/** Mêmes indicateurs pour un public de la campagne (public au ciblage). */
export interface IndicateursPublic extends IndicateursCampagne {
  segment: CrmSegment;
  /** Glovo/Yango : ciblés qui se sont inscrits sur l'appli pendant la campagne. Null pour les autres publics. */
  inscrits_appli_pendant: number | null;
}

interface Agregat {
  cibles: number;
  restants: number;
  ouverts: number;
  inscrits_pendant: number;
  appels: number;
  traites: number;
  joints: number;
  envoyes: number;
  utilises: number;
  ca_coupons: number;
  conversions: number;
  ca: number;
}

const AGREGAT_VIDE: Agregat = {
  cibles: 0,
  restants: 0,
  ouverts: 0,
  inscrits_pendant: 0,
  appels: 0,
  traites: 0,
  joints: 0,
  envoyes: 0,
  utilises: 0,
  ca_coupons: 0,
  conversions: 0,
  ca: 0,
};

type LigneStatut = { statut: string; nombre: number };

/** Ce que la clôture a figé (rapport version 2), relu pour une campagne terminée. */
interface RapportFige {
  version?: number;
  indicateurs?: { restants?: number };
  statuts?: LigneStatut[];
  par_public?: { segment: CrmSegment; restants?: number; statuts?: LigneStatut[] }[];
}

/** Clé d'un agrégat : campagne et public, « * » pour la campagne entière. */
const cle = (campagne: string, segment: string | null) => `${campagne}|${segment ?? '*'}`;

/**
 * Tableau de bord d'une campagne (cahier §6.3). Tout se lit dans les tables
 * d'historique (membres, appels, coupons, registre des ventes) et se ventile
 * par PUBLIC AU CIBLAGE (`CrmCampaignMember.segment`) : les chiffres d'une
 * campagne ne bougent plus quand ses contacts vivent leur vie après elle.
 *
 * Définitions :
 *  - ciblés : contacts entrés dans la campagne au lancement ;
 *  - traités : ciblés appelés au moins une fois pendant la campagne ;
 *  - joints : traités qui ont décroché au moins une fois ;
 *  - restants : ciblés encore ouverts (à appeler, à rappeler, intéressés,
 *    coupon envoyé) jamais appelés dans la campagne ; figés à la clôture ;
 *  - couverture = traités / ciblés, contact = joints / traités ;
 *  - conversions et CA : ventes valides du registre rattachées à la campagne
 *    (ni annulées, ni sur une commande annulée ou supprimée) ;
 *  - coupons utilisés : sur une commande ni annulée ni supprimée. Un coupon
 *    envoyé pendant la campagne et utilisé après sa clôture lui revient.
 */
@Injectable()
export class CrmCampaignStatsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Agrégats de plusieurs campagnes, par public et au total : une requête par
   * table, quel que soit le nombre de campagnes.
   */
  private async agregats(ids: string[]): Promise<Map<string, Agregat>> {
    const resultat = new Map<string, Agregat>();
    if (ids.length === 0) return resultat;
    const liste = Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));
    const [membres, appels, coupons, ventes] = await Promise.all([
      this.prisma.$queryRaw<{ campaign_id: string; segment: string | null; cibles: number; restants: number; ouverts: number; inscrits_pendant: number }[]>`
        SELECT m.campaign_id, m.segment::text AS segment, count(*)::int AS cibles,
               count(*) FILTER (WHERE m.released_at IS NULL AND x.status::text IN (${OUVERTS})
                                  AND x.entity_status <> 'DELETED' AND kc.contact_id IS NULL)::int AS restants,
               count(*) FILTER (WHERE m.released_at IS NULL AND x.status::text IN (${OUVERTS})
                                  AND x.entity_status <> 'DELETED')::int AS ouverts,
               count(*) FILTER (WHERE m.segment IN ('GLOVO', 'YANGO') AND c.started_at IS NOT NULL
                                  AND x.registered_at >= c.started_at
                                  AND x.registered_at < coalesce(c.completed_at, now()))::int AS inscrits_pendant
        FROM "CrmCampaignMember" m
        JOIN "CrmContact" x ON x.id = m.contact_id
        JOIN "ConversionCampaign" c ON c.id = m.campaign_id
        LEFT JOIN (SELECT DISTINCT campaign_id, contact_id FROM "CrmCall" WHERE campaign_id IN (${liste})) kc
               ON kc.campaign_id = m.campaign_id AND kc.contact_id = m.contact_id
        WHERE m.campaign_id IN (${liste})
        GROUP BY GROUPING SETS ((m.campaign_id, m.segment), (m.campaign_id))`,
      this.prisma.$queryRaw<{ campaign_id: string; segment: string | null; appels: number; traites: number; joints: number }[]>`
        SELECT k.campaign_id, m.segment::text AS segment, count(*)::int AS appels,
               count(DISTINCT k.contact_id)::int AS traites,
               count(DISTINCT k.contact_id) FILTER (WHERE k.reached)::int AS joints
        FROM "CrmCall" k
        JOIN "CrmCampaignMember" m ON m.campaign_id = k.campaign_id AND m.contact_id = k.contact_id
        WHERE k.campaign_id IN (${liste})
        GROUP BY GROUPING SETS ((k.campaign_id, m.segment), (k.campaign_id))`,
      this.prisma.$queryRaw<{ campaign_id: string; segment: string | null; envoyes: number; utilises: number; ca: number }[]>`
        SELECT cc.campaign_id, m.segment::text AS segment, count(*)::int AS envoyes,
               count(*) FILTER (WHERE ${COUPON_UTILISE})::int AS utilises,
               coalesce(sum(cc.order_amount) FILTER (WHERE ${COUPON_UTILISE}), 0)::float AS ca
        FROM "CrmCoupon" cc
        JOIN "CrmCampaignMember" m ON m.campaign_id = cc.campaign_id AND m.contact_id = cc.contact_id
        LEFT JOIN "Order" oc ON oc.id = cc.order_id
        WHERE cc.campaign_id IN (${liste})
        GROUP BY GROUPING SETS ((cc.campaign_id, m.segment), (cc.campaign_id))`,
      this.prisma.$queryRaw<{ campaign_id: string; segment: string | null; conversions: number; ca: number }[]>`
        SELECT v.campaign_id, m.segment::text AS segment, count(*)::int AS conversions,
               coalesce(sum(v.amount), 0)::float AS ca
        FROM "CrmConversion" v
        ${MEMBRE_VENTE}
        WHERE v.campaign_id IN (${liste}) AND ${VENTE_CRM}
        GROUP BY GROUPING SETS ((v.campaign_id, m.segment), (v.campaign_id))`,
    ]);
    const ligne = (campagne: string, segment: string | null) => {
      const k = cle(campagne, segment);
      if (!resultat.has(k)) resultat.set(k, { ...AGREGAT_VIDE });
      return resultat.get(k)!;
    };
    membres.forEach((l) => Object.assign(ligne(l.campaign_id, l.segment), { cibles: l.cibles, restants: l.restants, ouverts: l.ouverts, inscrits_pendant: l.inscrits_pendant }));
    appels.forEach((l) => Object.assign(ligne(l.campaign_id, l.segment), { appels: l.appels, traites: l.traites, joints: l.joints }));
    coupons.forEach((l) => Object.assign(ligne(l.campaign_id, l.segment), { envoyes: l.envoyes, utilises: l.utilises, ca_coupons: l.ca }));
    ventes.forEach((l) => Object.assign(ligne(l.campaign_id, l.segment), { conversions: l.conversions, ca: l.ca }));
    return resultat;
  }

  private indicateurs(
    a: Agregat,
    objectifs: { target_conversion_rate: number | null; target_contacts_count: number | null },
    restants = a.restants,
  ): IndicateursCampagne {
    return {
      cibles: a.cibles,
      traites: a.traites,
      restants,
      ouverts: a.ouverts,
      joints: a.joints,
      appels: a.appels,
      couverture: pct(a.traites, a.cibles),
      taux_contact: pct(a.joints, a.traites),
      coupons_envoyes: a.envoyes,
      coupons_utilises: a.utilises,
      taux_utilisation: pct(a.utilises, a.envoyes),
      ca_coupons: Math.round(a.ca_coupons),
      conversions: a.conversions,
      taux_conversion: pct(a.conversions, a.cibles),
      ca_conversions: Math.round(a.ca),
      panier_moyen: a.conversions > 0 ? Math.round(a.ca / a.conversions) : 0,
      objectif_taux_conversion: objectifs.target_conversion_rate,
      objectif_contacts: objectifs.target_contacts_count,
      progression_objectif_contacts: objectifs.target_contacts_count ? pct(a.joints, objectifs.target_contacts_count) : null,
    };
  }

  /** Indicateurs globaux et par public d'une campagne, restants figés si elle est close. */
  private construire(
    c: {
      id: string;
      status: CampaignStatus;
      report: Prisma.JsonValue;
      target_conversion_rate: number | null;
      target_contacts_count: number | null;
      publics: { segment: CrmSegment; target_conversion_rate: number | null; target_contacts_count: number | null }[];
    },
    agr: Map<string, Agregat>,
  ) {
    const fige = c.status === CampaignStatus.COMPLETED ? (c.report as RapportFige | null) : null;
    const total = agr.get(cle(c.id, null)) ?? AGREGAT_VIDE;
    // Une campagne close n'a plus de contacts rattachés : le « reste à
    // appeler » utile est celui qu'elle laissait au moment de sa clôture.
    const indicateurs = this.indicateurs(total, c, fige?.indicateurs?.restants ?? total.restants);
    // Les publics visés, puis ceux trouvés chez les membres (campagne ancienne).
    const segments = [...new Set([...c.publics.map((p) => p.segment), ...[...agr.keys()].filter((k) => k.startsWith(`${c.id}|`) && !k.endsWith('|*')).map((k) => k.split('|')[1] as CrmSegment)])];
    const par_public: IndicateursPublic[] = segments.map((segment) => {
      const a = agr.get(cle(c.id, segment)) ?? AGREGAT_VIDE;
      const pub = c.publics.find((p) => p.segment === segment);
      const restantsFiges = fige?.version === 2 ? fige.par_public?.find((p) => p.segment === segment)?.restants : undefined;
      return {
        segment,
        ...this.indicateurs(a, { target_conversion_rate: pub?.target_conversion_rate ?? null, target_contacts_count: pub?.target_contacts_count ?? null }, restantsFiges ?? a.restants),
        inscrits_appli_pendant: estCapte(segment) ? a.inscrits_pendant : null,
      };
    });
    return { indicateurs, par_public, fige };
  }

  async resumes(ids: string[]) {
    const resultat = new Map<
      string,
      { cibles: number; traites: number; conversions: number; coupons: number; par_public: { segment: CrmSegment; cibles: number; traites: number; conversions: number }[] }
    >();
    if (ids.length === 0) return resultat;
    const agr = await this.agregats(ids);
    for (const id of ids) {
      const total = agr.get(cle(id, null)) ?? AGREGAT_VIDE;
      const par_public = [...agr.entries()]
        .filter(([k]) => k.startsWith(`${id}|`) && !k.endsWith('|*'))
        .map(([k, a]) => ({ segment: k.split('|')[1] as CrmSegment, cibles: a.cibles, traites: a.traites, conversions: a.conversions }));
      resultat.set(id, { cibles: total.cibles, traites: total.traites, conversions: total.conversions, coupons: total.envoyes, par_public });
    }
    return resultat;
  }

  async statistiques(id: string) {
    const c = await this.prisma.crmCampaign.findFirst({
      where: { id, entity_status: { not: EntityStatus.DELETED } },
      select: {
        id: true,
        name: true,
        status: true,
        report: true,
        start_date: true,
        end_date: true,
        started_at: true,
        completed_at: true,
        target_conversion_rate: true,
        target_contacts_count: true,
        lead_agent: { select: { id: true, fullname: true } },
        assigned_agents: { select: { agent: { select: { id: true, fullname: true } } } },
        offer: { select: { id: true, label: true } },
        publics: {
          orderBy: { segment: 'asc' },
          select: {
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
          },
        },
      },
    });
    if (!c) throw new NotFoundException('Campagne introuvable');

    const idsRestaurants = [...new Set(c.publics.flatMap((p) => p.restaurant_ids))];
    const [agr, raisons, statutsVivants, premiersAppels, premiersJoints, appelsParJour, ventesParJour, agents, restaurants] = await Promise.all([
      this.agregats([id]),
      this.prisma.$queryRaw<{ raison: string; nombre: number }[]>`
        SELECT coalesce(r.name, 'Raison non renseignée') AS raison, count(*)::int AS nombre
        FROM (SELECT DISTINCT ON (contact_id) contact_id, loss_reason_id FROM "CrmCall"
              WHERE campaign_id = ${id}::uuid AND outcome = 'NON_INTERESSE' ORDER BY contact_id, created_at DESC) d
        LEFT JOIN "ProspectLossReason" r ON r.id = d.loss_reason_id
        GROUP BY 1 ORDER BY nombre DESC`,
      // Statut du membre dans SON passage : une fiche repartie dans un nouveau
      // cycle (elle ne le peut qu'après une vente) reste « convertie » ici,
      // au lieu de reprendre le « à appeler » remis à zéro.
      this.prisma.$queryRaw<{ segment: string | null; statut: string; nombre: number }[]>`
        SELECT t.segment, t.statut, count(*)::int AS nombre
        FROM (SELECT m.segment::text AS segment,
                     CASE WHEN x.cycle <> m.cycle THEN 'CONVERTI' ELSE x.status::text END AS statut
              FROM "CrmCampaignMember" m JOIN "CrmContact" x ON x.id = m.contact_id
              WHERE m.campaign_id = ${id}::uuid) t
        GROUP BY GROUPING SETS ((t.segment, t.statut), (t.statut)) ORDER BY nombre DESC`,
      this.parJour(Prisma.sql`
        SELECT min(created_at) AS jour FROM "CrmCall" WHERE campaign_id = ${id}::uuid GROUP BY contact_id`),
      this.parJour(Prisma.sql`
        SELECT min(created_at) AS jour FROM "CrmCall" WHERE campaign_id = ${id}::uuid AND reached GROUP BY contact_id`),
      this.parJour(Prisma.sql`SELECT created_at AS jour FROM "CrmCall" WHERE campaign_id = ${id}::uuid`),
      this.parJour(Prisma.sql`
        SELECT v.converted_at AS jour FROM "CrmConversion" v WHERE v.campaign_id = ${id}::uuid AND ${VENTE_CRM}`),
      this.parAgent(id, c.assigned_agents.map((a) => a.agent.id)),
      idsRestaurants.length > 0
        ? this.prisma.restaurant.findMany({ where: { id: { in: idsRestaurants } }, select: { id: true, name: true } })
        : Promise.resolve([] as { id: string; name: string }[]),
    ]);

    const { indicateurs, par_public, fige } = this.construire(c, agr);
    // Campagne close (rapport version 2) : les statuts sont ceux de la clôture,
    // pas ceux que les contacts ont pris depuis.
    const figee = fige?.version === 2;
    const statuts = figee ? (fige.statuts ?? []) : statutsVivants.filter((l) => l.segment === null).map(({ statut, nombre }) => ({ statut, nombre }));
    const statutsDe = (segment: CrmSegment) =>
      figee
        ? (fige.par_public?.find((p) => p.segment === segment)?.statuts ?? [])
        : statutsVivants.filter((l) => l.segment === segment).map(({ statut, nombre }) => ({ statut, nombre }));

    const noms = new Map(restaurants.map((r) => [r.id, r.name]));
    const totalRaisons = raisons.reduce((s, r) => s + r.nombre, 0);
    const { report: _rapport, publics, ...campagne } = c;
    return {
      campagne: {
        ...campagne,
        publics: publics.map((p) => ({
          ...p,
          restaurants: p.restaurant_ids.map((rid) => ({ id: rid, name: noms.get(rid) ?? null })),
          criteres: criteresEnClair(p, noms),
        })),
      },
      indicateurs,
      par_public: par_public.map((p) => ({ ...p, statuts: statutsDe(p.segment) })),
      raisons: raisons.map((r) => ({ ...r, part: pct(r.nombre, totalRaisons) })),
      statuts,
      chiffres_figes: figee,
      rythme: this.rythme(c, premiersAppels, premiersJoints, appelsParJour, ventesParJour),
      agents: agents.lignes,
      ventes_sans_agent: agents.sansAgent,
      duree: this.duree(c),
      genere_le: new Date(),
    };
  }

  /** Nombre d'événements par jour (UTC) d'une requête qui renvoie une colonne « jour ». */
  private parJour(source: Prisma.Sql) {
    return this.prisma.$queryRaw<{ jour: string; nombre: number }[]>`
      SELECT to_char(t.jour, 'YYYY-MM-DD') AS jour, count(*)::int AS nombre FROM (${source}) t GROUP BY 1 ORDER BY 1`;
  }

  /**
   * Performance comparée des agents (cahier §6.3), ventilée par public. Les
   * ventes sont celles que le registre attribue à l'agent ; une vente sans
   * agent (répartition manuelle) est rendue à part, pour que la somme des
   * agents et des « sans agent » égale la campagne.
   */
  private async parAgent(id: string, equipe: string[]) {
    type Ligne = { agent_id: string | null; segment: string | null };
    const [assignes, appels, coupons, ventes] = await Promise.all([
      this.prisma.$queryRaw<(Ligne & { assignes: number })[]>`
        SELECT m.agent_id, m.segment::text AS segment, count(*)::int AS assignes
        FROM "CrmCampaignMember" m WHERE m.campaign_id = ${id}::uuid AND m.agent_id IS NOT NULL
        GROUP BY GROUPING SETS ((m.agent_id, m.segment), (m.agent_id))`,
      this.prisma.$queryRaw<(Ligne & { appels: number; traites: number; joints: number })[]>`
        SELECT k.agent_id, m.segment::text AS segment, count(*)::int AS appels,
               count(DISTINCT k.contact_id)::int AS traites,
               count(DISTINCT k.contact_id) FILTER (WHERE k.reached)::int AS joints
        FROM "CrmCall" k JOIN "CrmCampaignMember" m ON m.campaign_id = k.campaign_id AND m.contact_id = k.contact_id
        WHERE k.campaign_id = ${id}::uuid AND k.agent_id IS NOT NULL
        GROUP BY GROUPING SETS ((k.agent_id, m.segment), (k.agent_id))`,
      this.prisma.$queryRaw<(Ligne & { coupons: number })[]>`
        SELECT cc.sent_by_id AS agent_id, m.segment::text AS segment, count(*)::int AS coupons
        FROM "CrmCoupon" cc JOIN "CrmCampaignMember" m ON m.campaign_id = cc.campaign_id AND m.contact_id = cc.contact_id
        WHERE cc.campaign_id = ${id}::uuid AND cc.sent_by_id IS NOT NULL
        GROUP BY GROUPING SETS ((cc.sent_by_id, m.segment), (cc.sent_by_id))`,
      // Les ventes sans agent forment leur propre groupe (agent_id nul).
      this.prisma.$queryRaw<(Ligne & { conversions: number; ca: number })[]>`
        SELECT v.agent_id, m.segment::text AS segment, count(*)::int AS conversions, coalesce(sum(v.amount), 0)::float AS ca
        FROM "CrmConversion" v ${MEMBRE_VENTE}
        WHERE v.campaign_id = ${id}::uuid AND ${VENTE_CRM}
        GROUP BY GROUPING SETS ((v.agent_id, m.segment), (v.agent_id))`,
    ]);

    type Chiffres = { assignes: number; appels: number; traites: number; joints: number; coupons: number; conversions: number; ca: number };
    const vide = (): Chiffres => ({ assignes: 0, appels: 0, traites: 0, joints: 0, coupons: 0, conversions: 0, ca: 0 });
    const table = new Map<string, Chiffres>();
    const ligne = (agent: string, segment: string | null) => {
      const k = cle(agent, segment);
      if (!table.has(k)) table.set(k, vide());
      return table.get(k)!;
    };
    assignes.forEach((l) => l.agent_id && (ligne(l.agent_id, l.segment).assignes = l.assignes));
    appels.forEach((l) => l.agent_id && Object.assign(ligne(l.agent_id, l.segment), { appels: l.appels, traites: l.traites, joints: l.joints }));
    coupons.forEach((l) => l.agent_id && (ligne(l.agent_id, l.segment).coupons = l.coupons));
    ventes.forEach((l) => l.agent_id && Object.assign(ligne(l.agent_id, l.segment), { conversions: l.conversions, ca: l.ca }));
    const sansAgent = ventes.find((l) => l.agent_id === null && l.segment === null);

    const ids = [...new Set([...equipe, ...[...table.keys()].map((k) => k.split('|')[0])])];
    const utilisateurs = ids.length > 0 ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullname: true } }) : [];
    const lignes = utilisateurs.map((u) => {
      const t = table.get(cle(u.id, null)) ?? vide();
      const par_public = [...table.entries()]
        .filter(([k]) => k.startsWith(`${u.id}|`) && !k.endsWith('|*'))
        .map(([k, x]) => ({ segment: k.split('|')[1] as CrmSegment, ...x, ca: Math.round(x.ca) }))
        .sort((a, b) => a.segment.localeCompare(b.segment));
      return {
        id: u.id,
        fullname: u.fullname,
        ...t,
        ca: Math.round(t.ca),
        taux_conversion: pct(t.conversions, t.assignes),
        taux_contact: pct(t.joints, t.traites),
        par_public,
      };
    });
    lignes.sort((a, b) => b.conversions - a.conversions || b.traites - a.traites);
    return { lignes, sansAgent: { conversions: sansAgent?.conversions ?? 0, ca: Math.round(sansAgent?.ca ?? 0) } };
  }

  /**
   * Rythme quotidien réalisé contre objectif, en cumulé (cahier §6.3).
   * L'objectif de volume est un nombre de contacts à JOINDRE : la courbe
   * cumule le premier appel joint de chaque ciblé.
   */
  private rythme(
    c: { start_date: Date; end_date: Date | null; started_at: Date | null; completed_at: Date | null; target_contacts_count: number | null },
    premiers: { jour: string; nombre: number }[],
    joints: { jour: string; nombre: number }[],
    appels: { jour: string; nombre: number }[],
    conversions: { jour: string; nombre: number }[],
  ) {
    const debut = new Date(`${(c.started_at ?? c.start_date).toISOString().slice(0, 10)}T00:00:00.000Z`);
    const finPrevue = c.end_date ? new Date(`${c.end_date.toISOString().slice(0, 10)}T00:00:00.000Z`) : null;
    // La série s'arrête au jour de clôture, ou à aujourd'hui tant que la
    // campagne tourne, y compris quand elle déborde de sa date de fin.
    const fin = c.completed_at
      ? new Date(`${c.completed_at.toISOString().slice(0, 10)}T00:00:00.000Z`)
      : new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
    const joursPrevus = finPrevue ? Math.round((finPrevue.getTime() - debut.getTime()) / JOUR) + 1 : null;
    // Jamais d'objectif négatif : une fin prévue antérieure au début n'en fixe pas.
    const objectifJour = c.target_contacts_count && joursPrevus && joursPrevus > 0 ? c.target_contacts_count / joursPrevus : null;

    const index = (l: { jour: string; nombre: number }[]) => new Map(l.map((x) => [x.jour, x.nombre]));
    const [t, j, a, v] = [index(premiers), index(joints), index(appels), index(conversions)];
    const serie: {
      jour: string;
      traites: number;
      joints: number;
      appels: number;
      conversions: number;
      cumul: number;
      cumul_traites: number;
      objectif_cumul: number | null;
    }[] = [];
    let cumul = 0;
    let cumulTraites = 0;
    for (let d = debut, i = 1; d <= fin && serie.length < 400; d = new Date(d.getTime() + JOUR), i++) {
      const jour = d.toISOString().slice(0, 10);
      cumul += j.get(jour) ?? 0;
      cumulTraites += t.get(jour) ?? 0;
      serie.push({
        jour,
        traites: t.get(jour) ?? 0,
        joints: j.get(jour) ?? 0,
        appels: a.get(jour) ?? 0,
        conversions: v.get(jour) ?? 0,
        cumul,
        cumul_traites: cumulTraites,
        objectif_cumul: objectifJour ? Math.round(objectifJour * i) : null,
      });
    }
    return { objectif_jour: objectifJour ? Math.round(objectifJour * 10) / 10 : null, serie };
  }

  private duree(c: { start_date: Date; end_date: Date | null; started_at: Date | null; completed_at: Date | null; status: CampaignStatus }) {
    const planifiee = c.end_date ? Math.round((c.end_date.getTime() - c.start_date.getTime()) / JOUR) + 1 : null;
    const reelle = c.started_at
      ? Math.round((((c.completed_at ?? new Date()).getTime() - c.started_at.getTime()) / JOUR) * 10) / 10
      : 0;
    return {
      planifiee_jours: planifiee,
      reelle_jours: reelle,
      debut_prevu: c.start_date,
      fin_prevue: c.end_date,
      debut_reel: c.started_at,
      fin_reelle: c.completed_at,
    };
  }

  /**
   * Historique et benchmark des campagnes lancées (cahier §6.3), dans l'ordre
   * chronologique. Mêmes chiffres que le tableau de bord de chaque campagne,
   * en quatre requêtes agrégées quel que soit le nombre de campagnes.
   * `portee` : pour un agent, les seules campagnes qu'il pilote ou dont il
   * fait partie. Avec `segment` : les campagnes qui visent ce public, avec la
   * ligne de ce public dans `public`.
   */
  async comparer(q: CompareCampaignsQueryDto, portee: Prisma.CrmCampaignWhereInput = {}) {
    const campagnes = await this.prisma.crmCampaign.findMany({
      where: {
        entity_status: { not: EntityStatus.DELETED },
        status: { not: CampaignStatus.PLANIFIED },
        ...(q.segment && { publics: { some: { segment: q.segment } } }),
        ...portee,
      },
      orderBy: [{ started_at: 'asc' }, { created_at: 'asc' }],
      select: {
        id: true,
        name: true,
        status: true,
        report: true,
        start_date: true,
        end_date: true,
        started_at: true,
        completed_at: true,
        target_conversion_rate: true,
        target_contacts_count: true,
        publics: {
          orderBy: { segment: 'asc' },
          select: { segment: true, target_conversion_rate: true, target_contacts_count: true },
        },
      },
    });
    const agr = await this.agregats(campagnes.map((c) => c.id));
    return campagnes.map((c) => {
      const { indicateurs, par_public } = this.construire(c, agr);
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        started_at: c.started_at,
        completed_at: c.completed_at,
        segments: c.publics.map((p) => p.segment),
        indicateurs,
        par_public,
        public: q.segment ? (par_public.find((p) => p.segment === q.segment) ?? null) : null,
        duree: this.duree(c),
      };
    });
  }
}
