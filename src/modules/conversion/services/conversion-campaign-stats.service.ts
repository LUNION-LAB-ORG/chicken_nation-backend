import { Injectable, NotFoundException } from '@nestjs/common';
import { CampaignStatus, EntityStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';

const JOUR = 86_400_000;

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

export interface IndicateursCampagne {
  cibles: number;
  traites: number;
  restants: number;
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
}

/**
 * Tableau de bord d'une campagne (cahier §6.3). Tout se lit dans les tables
 * d'historique (membres, appels, coupons) : les chiffres d'une campagne ne
 * bougent plus quand ses prospects vivent leur vie après elle.
 *
 * Définitions :
 *  - ciblés : prospects entrés dans la campagne au lancement ;
 *  - traités : ciblés appelés au moins une fois pendant la campagne ;
 *  - joints : traités qui ont décroché au moins une fois ;
 *  - couverture = traités / ciblés, contact = joints / traités ;
 *  - conversions : ciblés dont la première commande tombe pendant la campagne.
 */
@Injectable()
export class ConversionCampaignStatsService {
  constructor(private readonly prisma: PrismaService) {}

  async resumes(ids: string[]) {
    const resultat = new Map<string, { cibles: number; traites: number; conversions: number; coupons: number }>();
    if (ids.length === 0) return resultat;
    const liste = Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));
    const [membres, appels, coupons] = await Promise.all([
      this.prisma.$queryRaw<{ campaign_id: string; cibles: number; conversions: number }[]>`
        SELECT campaign_id, count(*)::int AS cibles, count(*) FILTER (WHERE converted_at IS NOT NULL)::int AS conversions
        FROM "ConversionCampaignMember" WHERE campaign_id IN (${liste}) GROUP BY campaign_id`,
      this.prisma.$queryRaw<{ campaign_id: string; traites: number }[]>`
        SELECT campaign_id, count(DISTINCT prospect_id)::int AS traites
        FROM "ConversionCall" WHERE campaign_id IN (${liste}) GROUP BY campaign_id`,
      this.prisma.$queryRaw<{ campaign_id: string; coupons: number }[]>`
        SELECT campaign_id, count(*)::int AS coupons
        FROM "ConversionCoupon" WHERE campaign_id IN (${liste}) GROUP BY campaign_id`,
    ]);
    for (const id of ids) resultat.set(id, { cibles: 0, traites: 0, conversions: 0, coupons: 0 });
    membres.forEach((m) => Object.assign(resultat.get(m.campaign_id)!, { cibles: m.cibles, conversions: m.conversions }));
    appels.forEach((a) => (resultat.get(a.campaign_id)!.traites = a.traites));
    coupons.forEach((c) => (resultat.get(c.campaign_id)!.coupons = c.coupons));
    return resultat;
  }

  async statistiques(id: string) {
    const c = await this.prisma.conversionCampaign.findFirst({
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
      },
    });
    if (!c) throw new NotFoundException('Campagne introuvable');

    const [[membres], [appels], [coupons], [restants], raisons, statuts, premiersAppels, appelsParJour, conversionsParJour, agents] =
      await Promise.all([
        this.prisma.$queryRaw<{ cibles: number; conversions: number; ca: number }[]>`
          SELECT count(*)::int AS cibles,
                 count(*) FILTER (WHERE m.converted_at IS NOT NULL)::int AS conversions,
                 coalesce(sum(p.first_order_amount) FILTER (
                   WHERE m.converted_at IS NOT NULL AND coalesce(o.status::text, '') <> 'CANCELLED'), 0)::float AS ca
          FROM "ConversionCampaignMember" m
          JOIN "ConversionProspect" p ON p.id = m.prospect_id
          LEFT JOIN "Order" o ON o.id = p.first_order_id
          WHERE m.campaign_id = ${id}::uuid`,
        this.prisma.$queryRaw<{ appels: number; traites: number; joints: number }[]>`
          SELECT count(*)::int AS appels, count(DISTINCT prospect_id)::int AS traites,
                 count(DISTINCT prospect_id) FILTER (WHERE reached)::int AS joints
          FROM "ConversionCall" WHERE campaign_id = ${id}::uuid`,
        this.prisma.$queryRaw<{ envoyes: number; utilises: number; ca: number }[]>`
          SELECT count(*)::int AS envoyes, count(*) FILTER (WHERE used_at IS NOT NULL)::int AS utilises,
                 coalesce(sum(order_amount) FILTER (WHERE used_at IS NOT NULL), 0)::float AS ca
          FROM "ConversionCoupon" WHERE campaign_id = ${id}::uuid`,
        this.prisma.$queryRaw<{ restants: number }[]>`
          SELECT count(*)::int AS restants
          FROM "ConversionCampaignMember" m JOIN "ConversionProspect" p ON p.id = m.prospect_id
          WHERE m.campaign_id = ${id}::uuid AND m.released_at IS NULL AND p.status <> 'CONVERTI'
            AND NOT EXISTS (SELECT 1 FROM "ConversionCall" k WHERE k.campaign_id = m.campaign_id AND k.prospect_id = m.prospect_id)`,
        this.prisma.$queryRaw<{ raison: string; nombre: number }[]>`
          SELECT r.name AS raison, count(*)::int AS nombre
          FROM (SELECT DISTINCT ON (prospect_id) prospect_id, loss_reason_id FROM "ConversionCall"
                WHERE campaign_id = ${id}::uuid AND outcome = 'NON_INTERESSE' ORDER BY prospect_id, created_at DESC) d
          JOIN "ProspectLossReason" r ON r.id = d.loss_reason_id
          GROUP BY r.name ORDER BY nombre DESC`,
        this.prisma.$queryRaw<{ statut: string; nombre: number }[]>`
          SELECT p.status::text AS statut, count(*)::int AS nombre
          FROM "ConversionCampaignMember" m JOIN "ConversionProspect" p ON p.id = m.prospect_id
          WHERE m.campaign_id = ${id}::uuid GROUP BY p.status ORDER BY nombre DESC`,
        this.prisma.$queryRaw<{ jour: string; nombre: number }[]>`
          SELECT to_char(premier, 'YYYY-MM-DD') AS jour, count(*)::int AS nombre
          FROM (SELECT min(created_at) AS premier FROM "ConversionCall" WHERE campaign_id = ${id}::uuid GROUP BY prospect_id) t
          GROUP BY 1 ORDER BY 1`,
        this.prisma.$queryRaw<{ jour: string; nombre: number }[]>`
          SELECT to_char(created_at, 'YYYY-MM-DD') AS jour, count(*)::int AS nombre
          FROM "ConversionCall" WHERE campaign_id = ${id}::uuid GROUP BY 1 ORDER BY 1`,
        this.prisma.$queryRaw<{ jour: string; nombre: number }[]>`
          SELECT to_char(converted_at, 'YYYY-MM-DD') AS jour, count(*)::int AS nombre
          FROM "ConversionCampaignMember" WHERE campaign_id = ${id}::uuid AND converted_at IS NOT NULL GROUP BY 1 ORDER BY 1`,
        this.parAgent(id, c.assigned_agents.map((a) => a.agent.id)),
      ]);

    // Une campagne close n'a plus de prospects rattachés : le « reste à
    // appeler » utile est celui qu'elle laissait au moment de sa clôture.
    const restantsFiges = (c.report as { indicateurs?: { restants?: number } } | null)?.indicateurs?.restants;
    const indicateurs: IndicateursCampagne = {
      cibles: membres.cibles,
      traites: appels.traites,
      restants: c.status === CampaignStatus.COMPLETED && restantsFiges != null ? restantsFiges : restants.restants,
      joints: appels.joints,
      appels: appels.appels,
      couverture: pct(appels.traites, membres.cibles),
      taux_contact: pct(appels.joints, appels.traites),
      coupons_envoyes: coupons.envoyes,
      coupons_utilises: coupons.utilises,
      taux_utilisation: pct(coupons.utilises, coupons.envoyes),
      ca_coupons: Math.round(coupons.ca),
      conversions: membres.conversions,
      taux_conversion: pct(membres.conversions, membres.cibles),
      ca_conversions: Math.round(membres.ca),
      panier_moyen: membres.conversions > 0 ? Math.round(membres.ca / membres.conversions) : 0,
      objectif_taux_conversion: c.target_conversion_rate,
      objectif_contacts: c.target_contacts_count,
    };

    const totalRaisons = raisons.reduce((s, r) => s + r.nombre, 0);
    const { report: _rapport, ...campagne } = c;
    return {
      campagne,
      indicateurs,
      raisons: raisons.map((r) => ({ ...r, part: pct(r.nombre, totalRaisons) })),
      statuts,
      rythme: this.rythme(c, premiersAppels, appelsParJour, conversionsParJour),
      agents,
      duree: this.duree(c),
      genere_le: new Date(),
    };
  }

  /** Performance comparée des agents (cahier §6.3). */
  private async parAgent(id: string, equipe: string[]) {
    const lignes = await this.prisma.$queryRaw<
      { id: string; fullname: string; assignes: number; appels: number; traites: number; joints: number; coupons: number; conversions: number; ca: number }[]
    >`
      WITH acteurs AS (
        SELECT unnest(${equipe}::uuid[]) AS id
        UNION SELECT agent_id FROM "ConversionCall" WHERE campaign_id = ${id}::uuid AND agent_id IS NOT NULL
        UNION SELECT agent_id FROM "ConversionCampaignMember" WHERE campaign_id = ${id}::uuid AND agent_id IS NOT NULL
      )
      SELECT u.id, u.fullname,
        (SELECT count(*) FROM "ConversionCampaignMember" m WHERE m.campaign_id = ${id}::uuid AND m.agent_id = u.id)::int AS assignes,
        (SELECT count(*) FROM "ConversionCall" k WHERE k.campaign_id = ${id}::uuid AND k.agent_id = u.id)::int AS appels,
        (SELECT count(DISTINCT k.prospect_id) FROM "ConversionCall" k WHERE k.campaign_id = ${id}::uuid AND k.agent_id = u.id)::int AS traites,
        (SELECT count(DISTINCT k.prospect_id) FROM "ConversionCall" k WHERE k.campaign_id = ${id}::uuid AND k.agent_id = u.id AND k.reached)::int AS joints,
        (SELECT count(*) FROM "ConversionCoupon" cc WHERE cc.campaign_id = ${id}::uuid AND cc.sent_by_id = u.id)::int AS coupons,
        (SELECT count(*) FROM "ConversionCampaignMember" m WHERE m.campaign_id = ${id}::uuid AND m.agent_id = u.id AND m.converted_at IS NOT NULL)::int AS conversions,
        (SELECT coalesce(sum(p.first_order_amount), 0) FROM "ConversionCampaignMember" m JOIN "ConversionProspect" p ON p.id = m.prospect_id
           WHERE m.campaign_id = ${id}::uuid AND m.agent_id = u.id AND m.converted_at IS NOT NULL)::float AS ca
      FROM "User" u WHERE u.id IN (SELECT id FROM acteurs)
      ORDER BY conversions DESC, traites DESC`;
    return lignes.map((l) => ({
      ...l,
      ca: Math.round(l.ca),
      taux_conversion: pct(l.conversions, l.assignes),
      taux_contact: pct(l.joints, l.traites),
    }));
  }

  /** Rythme quotidien réalisé contre objectif, en cumulé (cahier §6.3). */
  private rythme(
    c: { start_date: Date; end_date: Date | null; started_at: Date | null; completed_at: Date | null; target_contacts_count: number | null },
    premiers: { jour: string; nombre: number }[],
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
    const objectifJour = c.target_contacts_count && joursPrevus ? c.target_contacts_count / joursPrevus : null;

    const index = (l: { jour: string; nombre: number }[]) => new Map(l.map((x) => [x.jour, x.nombre]));
    const [t, a, v] = [index(premiers), index(appels), index(conversions)];
    const serie: { jour: string; traites: number; appels: number; conversions: number; cumul: number; objectif_cumul: number | null }[] = [];
    let cumul = 0;
    for (let d = debut, i = 1; d <= fin && serie.length < 400; d = new Date(d.getTime() + JOUR), i++) {
      const jour = d.toISOString().slice(0, 10);
      cumul += t.get(jour) ?? 0;
      serie.push({
        jour,
        traites: t.get(jour) ?? 0,
        appels: a.get(jour) ?? 0,
        conversions: v.get(jour) ?? 0,
        cumul,
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
   * Historique et benchmark de toutes les campagnes lancées (cahier §6.3).
   * Mêmes chiffres que le tableau de bord de chaque campagne : un coupon
   * envoyé pendant la campagne et utilisé après sa clôture lui revient.
   */
  async comparer() {
    const campagnes = await this.prisma.conversionCampaign.findMany({
      where: { entity_status: { not: EntityStatus.DELETED }, status: { not: CampaignStatus.PLANIFIED } },
      orderBy: { started_at: 'desc' },
      select: { id: true, name: true, status: true, started_at: true, completed_at: true },
    });
    const lignes: unknown[] = [];
    for (const c of campagnes) {
      const stats = await this.statistiques(c.id);
      lignes.push({
        id: c.id,
        name: c.name,
        status: c.status,
        started_at: c.started_at,
        completed_at: c.completed_at,
        indicateurs: stats.indicateurs,
        duree: stats.duree,
      });
    }
    return lignes;
  }
}
