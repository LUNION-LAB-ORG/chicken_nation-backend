import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { AnalyticsQueryDto, VerbatimsQueryDto } from '../dto/analytics.dto';
import { ConversionAccessService } from './conversion-access.service';

const JOUR = 86_400_000;
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
const arrondi = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

/** Commande qui compte, en SQL (même définition que `commandeEffective`). */
const EFFECTIVE = Prisma.sql`o."entity_status" <> 'DELETED'
  AND NOT (o."payment_method" = 'ONLINE' AND o."paied" = false AND o."status" = 'PENDING')`;
const DEFINITIFS = Prisma.sql`('INTERESSE', 'NON_INTERESSE', 'NUMERO_INVALIDE')`;

const MOTS_VIDES = new Set(
  (
    "a à au aux avec ce ces c ça cela d de des du elle en est et être il ils j je la le les leur lui l m ma mais me mes " +
    "moi mon n ne ni nous on ou où par pas peu plus pour qu que qui s sa se ses si son sur t ta te tes toi ton tu un une " +
    "vos votre vous y a été ai as avait avez aussi bien car comme dans deux dit donc encore fait faut ici là va veut " +
    "client cliente monsieur madame appel appelé rappel rappeler oui non très trop déjà après avant"
  ).split(' '),
);

/**
 * Tableau de bord analytique (cahier §5 et §7). Chaque requête lit les tables
 * d'historique ; la période filtre la date qui a du sens pour l'indicateur
 * (inscription pour l'entonnoir, appel pour la qualité, envoi pour les coupons).
 */
@Injectable()
export class ConversionAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ConversionAccessService,
  ) {}

  private plage(colonne: string, q: AnalyticsQueryDto): Prisma.Sql {
    const col = Prisma.raw(colonne);
    const conditions: Prisma.Sql[] = [];
    if (q.from) conditions.push(Prisma.sql`${col} >= ${new Date(`${q.from.slice(0, 10)}T00:00:00.000Z`)}`);
    if (q.to) conditions.push(Prisma.sql`${col} < ${new Date(new Date(`${q.to.slice(0, 10)}T00:00:00.000Z`).getTime() + JOUR)}`);
    return conditions.length ? Prisma.sql`AND ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;
  }

  /** Filtre campagne pour une requête sur les prospects (alias p). */
  private campagneProspect(q: AnalyticsQueryDto): Prisma.Sql {
    return q.campaign_id
      ? Prisma.sql`AND EXISTS (SELECT 1 FROM "ConversionCampaignMember" m WHERE m.prospect_id = p.id AND m.campaign_id = ${q.campaign_id}::uuid)`
      : Prisma.empty;
  }

  /** Filtre campagne pour une table qui porte la colonne campaign_id. */
  private campagneColonne(alias: string, q: AnalyticsQueryDto): Prisma.Sql {
    return q.campaign_id ? Prisma.sql`AND ${Prisma.raw(`${alias}.campaign_id`)} = ${q.campaign_id}::uuid` : Prisma.empty;
  }

  /** Population, entonnoir de conversion et chiffre d'affaires (cahier §7). */
  async vueEnsemble(q: AnalyticsQueryDto) {
    const [[entonnoir], [population], [conversions]] = await Promise.all([
      this.prisma.$queryRaw<
        { inscrits: number; traites: number; joints: number; interesses: number; coupons: number; commandes: number; delai: number }[]
      >`
        SELECT count(*)::int AS inscrits,
          count(*) FILTER (WHERE p.call_count > 0)::int AS traites,
          count(*) FILTER (WHERE p.first_reached_at IS NOT NULL)::int AS joints,
          count(*) FILTER (WHERE p.coupon_sent_at IS NOT NULL OR EXISTS (
            SELECT 1 FROM "ConversionCall" k WHERE k.prospect_id = p.id AND k.outcome = 'INTERESSE'))::int AS interesses,
          count(*) FILTER (WHERE p.coupon_sent_at IS NOT NULL)::int AS coupons,
          count(*) FILTER (WHERE p.converted_at IS NOT NULL)::int AS commandes,
          coalesce(avg(greatest(0, EXTRACT(EPOCH FROM (p.converted_at - p.registered_at)) / 86400))
            FILTER (WHERE p.converted_at IS NOT NULL), 0)::float AS delai
        FROM "ConversionProspect" p
        WHERE p.entity_status <> 'DELETED' ${this.plage('p.registered_at', q)} ${this.campagneProspect(q)}`,
      this.prisma.$queryRaw<
        { actifs: number; jamais_appeles: number; non_assignes: number; a_rappeler: number; interesses: number; coupons: number; non_interesses: number; injoignables: number; abandons: number }[]
      >`
        SELECT count(*) FILTER (WHERE p.status <> 'CONVERTI')::int AS actifs,
          count(*) FILTER (WHERE p.status = 'A_APPELER' AND p.call_count = 0)::int AS jamais_appeles,
          count(*) FILTER (WHERE p.status <> 'CONVERTI' AND p.assigned_to_id IS NULL)::int AS non_assignes,
          count(*) FILTER (WHERE p.status = 'A_RAPPELER')::int AS a_rappeler,
          count(*) FILTER (WHERE p.status = 'INTERESSE')::int AS interesses,
          count(*) FILTER (WHERE p.status = 'COUPON_ENVOYE')::int AS coupons,
          count(*) FILTER (WHERE p.status = 'NON_INTERESSE')::int AS non_interesses,
          count(*) FILTER (WHERE p.status = 'INJOIGNABLE')::int AS injoignables,
          count(*) FILTER (WHERE p.status <> 'CONVERTI' AND p.abandoned_orders > 0)::int AS abandons
        FROM "ConversionProspect" p
        WHERE p.entity_status <> 'DELETED' ${this.campagneProspect(q)}`,
      this.prisma.$queryRaw<{ conversions: number; ca: number }[]>`
        SELECT count(*)::int AS conversions,
          coalesce(sum(p.first_order_amount) FILTER (WHERE coalesce(o.status::text, '') <> 'CANCELLED'), 0)::float AS ca
        FROM "ConversionProspect" p LEFT JOIN "Order" o ON o.id = p.first_order_id
        WHERE p.entity_status <> 'DELETED' AND p.converted_at IS NOT NULL
          ${this.plage('p.converted_at', q)} ${this.campagneProspect(q)}`,
    ]);

    const etapes: [string, string, number][] = [
      ['inscrits', 'Inscrits', entonnoir.inscrits],
      ['traites', 'Contactés', entonnoir.traites],
      ['joints', 'Joints', entonnoir.joints],
      ['interesses', 'Intéressés', entonnoir.interesses],
      ['coupons', 'Coupon envoyé', entonnoir.coupons],
      ['commandes', 'Commande passée', entonnoir.commandes],
    ];
    return {
      population,
      entonnoir: etapes.map(([cle, libelle, nombre], i) => ({
        cle,
        libelle,
        nombre,
        part_inscrits: pct(nombre, entonnoir.inscrits),
        part_etape_precedente: i === 0 ? 100 : pct(nombre, etapes[i - 1][2]),
      })),
      conversion: {
        taux: pct(entonnoir.commandes, entonnoir.inscrits),
        delai_moyen_jours: arrondi(entonnoir.delai),
        conversions_periode: conversions.conversions,
        ca_periode: Math.round(conversions.ca),
        panier_moyen: conversions.conversions > 0 ? Math.round(conversions.ca / conversions.conversions) : 0,
      },
    };
  }

  /** Pareto des raisons de non-achat (cahier §7) : les 2 ou 3 blocages qui pèsent le plus. */
  async raisons(q: AnalyticsQueryDto) {
    const lignes = await this.prisma.$queryRaw<{ id: string; raison: string; nombre: number }[]>`
      SELECT r.id, r.name AS raison, count(*)::int AS nombre
      FROM "ConversionProspect" p JOIN "ProspectLossReason" r ON r.id = p.loss_reason_id
      WHERE p.entity_status <> 'DELETED' AND p.status = 'NON_INTERESSE'
        ${this.plage('p.last_call_at', q)} ${this.campagneProspect(q)}
      GROUP BY r.id, r.name ORDER BY nombre DESC`;
    const total = lignes.reduce((s, l) => s + l.nombre, 0);
    let cumul = 0;
    return {
      total,
      raisons: lignes.map((l) => {
        const avant = cumul;
        cumul += l.nombre;
        return { ...l, part: pct(l.nombre, total), cumul: pct(cumul, total), principale: pct(avant, total) < 80 };
      }),
    };
  }

  /**
   * Cohortes par mois d'inscription (cahier §7), sur TOUS les clients depuis
   * l'ouverture : combien finissent par commander, et au bout de combien de
   * temps. C'est la seule vue qui remonte avant l'ouverture du module.
   */
  async cohortes() {
    const lignes = await this.prisma.$queryRaw<
      { mois: string; inscrits: number; convertis: number; sous_7_jours: number; delai_moyen: number; delai_median: number }[]
    >`
      WITH premieres AS (
        SELECT o.customer_id, min(o.created_at) AS premiere FROM "Order" o WHERE ${EFFECTIVE} GROUP BY o.customer_id
      ), delais AS (
        SELECT c.created_at, pr.premiere,
          greatest(0, EXTRACT(EPOCH FROM (pr.premiere - c.created_at)) / 86400) AS jours
        FROM "Customer" c LEFT JOIN premieres pr ON pr.customer_id = c.id
        WHERE c.entity_status <> 'DELETED'
      )
      SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS mois,
        count(*)::int AS inscrits,
        count(premiere)::int AS convertis,
        count(premiere) FILTER (WHERE jours <= 7)::int AS sous_7_jours,
        coalesce(avg(jours) FILTER (WHERE premiere IS NOT NULL), 0)::float AS delai_moyen,
        coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY jours) FILTER (WHERE premiere IS NOT NULL), 0)::float AS delai_median
      FROM delais GROUP BY 1 ORDER BY 1`;
    return lignes.map((l) => ({
      ...l,
      taux: pct(l.convertis, l.inscrits),
      taux_7_jours: pct(l.sous_7_jours, l.inscrits),
      delai_moyen: arrondi(l.delai_moyen),
      delai_median: arrondi(l.delai_median),
    }));
  }

  /** Coupons et mesure de la conversion (cahier §5), par date d'envoi. */
  async coupons(q: AnalyticsQueryDto) {
    const [[total], parOffre, parCanal] = await Promise.all([
      this.prisma.$queryRaw<{ envoyes: number; utilises: number; actifs: number; expires: number; ca: number; delai: number }[]>`
        SELECT count(*)::int AS envoyes,
          count(*) FILTER (WHERE c.used_at IS NOT NULL)::int AS utilises,
          count(*) FILTER (WHERE c.used_at IS NULL AND c.expires_at > now())::int AS actifs,
          count(*) FILTER (WHERE c.used_at IS NULL AND c.expires_at <= now())::int AS expires,
          coalesce(sum(c.order_amount) FILTER (WHERE c.used_at IS NOT NULL), 0)::float AS ca,
          coalesce(avg(EXTRACT(EPOCH FROM (c.used_at - c.sent_at)) / 86400) FILTER (WHERE c.used_at IS NOT NULL), 0)::float AS delai
        FROM "ConversionCoupon" c WHERE true ${this.plage('c.sent_at', q)} ${this.campagneColonne('c', q)}`,
      this.prisma.$queryRaw<{ offre: string; envoyes: number; utilises: number; ca: number }[]>`
        SELECT c.offer_label AS offre, count(*)::int AS envoyes,
          count(*) FILTER (WHERE c.used_at IS NOT NULL)::int AS utilises,
          coalesce(sum(c.order_amount) FILTER (WHERE c.used_at IS NOT NULL), 0)::float AS ca
        FROM "ConversionCoupon" c WHERE true ${this.plage('c.sent_at', q)} ${this.campagneColonne('c', q)}
        GROUP BY c.offer_label ORDER BY envoyes DESC`,
      this.prisma.$queryRaw<{ canal: string; envoyes: number }[]>`
        SELECT c.channel::text AS canal, count(*)::int AS envoyes
        FROM "ConversionCoupon" c WHERE true ${this.plage('c.sent_at', q)} ${this.campagneColonne('c', q)}
        GROUP BY c.channel ORDER BY envoyes DESC`,
    ]);
    return {
      envoyes: total.envoyes,
      utilises: total.utilises,
      actifs: total.actifs,
      expires: total.expires,
      taux_utilisation: pct(total.utilises, total.envoyes),
      ca: Math.round(total.ca),
      panier_moyen: total.utilises > 0 ? Math.round(total.ca / total.utilises) : 0,
      delai_moyen_jours: arrondi(total.delai),
      par_offre: parOffre.map((o) => ({ ...o, ca: Math.round(o.ca), taux: pct(o.utilises, o.envoyes) })),
      par_canal: parCanal,
    };
  }

  /**
   * Qualité du traitement (cahier §7) : résolution au premier appel, effort
   * et temps pour qualifier un prospect, et rétention après la conversion.
   */
  async qualite(q: AnalyticsQueryDto) {
    const [[premier], [effort], [appels], [retention]] = await Promise.all([
      this.prisma.$queryRaw<{ traites: number; resolus: number }[]>`
        SELECT count(*)::int AS traites, count(*) FILTER (WHERE outcome IN ${DEFINITIFS})::int AS resolus
        FROM (SELECT DISTINCT ON (k.prospect_id) k.prospect_id, k.outcome, k.created_at
              FROM "ConversionCall" k WHERE true ${this.campagneColonne('k', q)}
              ORDER BY k.prospect_id, k.created_at ASC) t
        WHERE true ${this.plage('t.created_at', q)}`,
      this.prisma.$queryRaw<{ qualifies: number; tentatives: number; heures: number }[]>`
        SELECT count(*)::int AS qualifies, coalesce(avg(d.attempt), 0)::float AS tentatives,
          coalesce(avg(EXTRACT(EPOCH FROM (d.created_at - f.premier)) / 3600), 0)::float AS heures
        FROM (SELECT DISTINCT ON (k.prospect_id) k.prospect_id, k.attempt, k.created_at
              FROM "ConversionCall" k WHERE k.outcome IN ${DEFINITIFS} ${this.campagneColonne('k', q)}
              ORDER BY k.prospect_id, k.created_at ASC) d
        JOIN (SELECT k.prospect_id, min(k.created_at) AS premier FROM "ConversionCall" k GROUP BY k.prospect_id) f
          ON f.prospect_id = d.prospect_id
        WHERE true ${this.plage('d.created_at', q)}`,
      this.prisma.$queryRaw<{ appels: number; prospects: number }[]>`
        SELECT count(*)::int AS appels, count(DISTINCT k.prospect_id)::int AS prospects
        FROM "ConversionCall" k WHERE true ${this.plage('k.created_at', q)} ${this.campagneColonne('k', q)}`,
      this.prisma.$queryRaw<{ convertis: number; deuxieme: number; delai: number }[]>`
        WITH conv AS (
          SELECT p.customer_id FROM "ConversionProspect" p
          WHERE p.converted_at IS NOT NULL AND p.entity_status <> 'DELETED'
            ${this.plage('p.converted_at', q)} ${this.campagneProspect(q)}
        ), cmd AS (
          SELECT o.customer_id, o.created_at, row_number() OVER (PARTITION BY o.customer_id ORDER BY o.created_at) AS rang
          FROM "Order" o JOIN conv ON conv.customer_id = o.customer_id WHERE ${EFFECTIVE}
        )
        SELECT (SELECT count(*) FROM conv)::int AS convertis,
          count(c2.*)::int AS deuxieme,
          coalesce(avg(EXTRACT(EPOCH FROM (c2.created_at - c1.created_at)) / 86400), 0)::float AS delai
        FROM cmd c2 JOIN cmd c1 ON c1.customer_id = c2.customer_id AND c1.rang = 1
        WHERE c2.rang = 2`,
    ]);
    return {
      resolution_premier_appel: { traites: premier.traites, resolus: premier.resolus, taux: pct(premier.resolus, premier.traites) },
      traitement: {
        qualifies: effort.qualifies,
        tentatives_moyennes: arrondi(effort.tentatives),
        heures_moyennes: arrondi(effort.heures),
        appels_par_prospect: appels.prospects > 0 ? arrondi(appels.appels / appels.prospects) : 0,
      },
      retention: {
        convertis: retention.convertis,
        deuxieme_commande: retention.deuxieme,
        taux: pct(retention.deuxieme, retention.convertis),
        delai_moyen_jours: arrondi(retention.delai),
      },
    };
  }

  /** Performance des agents sur la période. */
  async agents(q: AnalyticsQueryDto) {
    const roles = this.access.rolesAgents();
    const lignes = await this.prisma.$queryRaw<
      { id: string; fullname: string; appels: number; traites: number; joints: number; coupons: number; conversions: number; ca: number; portefeuille: number }[]
    >`
      SELECT u.id, u.fullname,
        (SELECT count(*) FROM "ConversionCall" k WHERE k.agent_id = u.id ${this.plage('k.created_at', q)} ${this.campagneColonne('k', q)})::int AS appels,
        (SELECT count(DISTINCT k.prospect_id) FROM "ConversionCall" k WHERE k.agent_id = u.id ${this.plage('k.created_at', q)} ${this.campagneColonne('k', q)})::int AS traites,
        (SELECT count(DISTINCT k.prospect_id) FROM "ConversionCall" k WHERE k.agent_id = u.id AND k.reached ${this.plage('k.created_at', q)} ${this.campagneColonne('k', q)})::int AS joints,
        (SELECT count(*) FROM "ConversionCoupon" c WHERE c.sent_by_id = u.id ${this.plage('c.sent_at', q)} ${this.campagneColonne('c', q)})::int AS coupons,
        (SELECT count(*) FROM "ConversionProspect" p WHERE p.assigned_to_id = u.id AND p.converted_at IS NOT NULL ${this.plage('p.converted_at', q)} ${this.campagneProspect(q)})::int AS conversions,
        (SELECT coalesce(sum(p.first_order_amount), 0) FROM "ConversionProspect" p WHERE p.assigned_to_id = u.id AND p.converted_at IS NOT NULL ${this.plage('p.converted_at', q)} ${this.campagneProspect(q)})::float AS ca,
        (SELECT count(*) FROM "ConversionProspect" p WHERE p.assigned_to_id = u.id AND p.status IN ('A_APPELER', 'A_RAPPELER', 'INTERESSE', 'COUPON_ENVOYE'))::int AS portefeuille
      FROM "User" u
      WHERE u.entity_status = 'ACTIVE' AND u.role::text IN (${Prisma.join(roles)})`;
    return lignes
      .filter((l) => l.appels + l.coupons + l.conversions + l.portefeuille > 0)
      .map((l) => ({ ...l, ca: Math.round(l.ca), taux_contact: pct(l.joints, l.traites), taux_conversion: pct(l.conversions, l.traites) }))
      .sort((a, b) => b.conversions - a.conversions || b.traites - a.traites);
  }

  /** Série quotidienne : appels, joints, coupons, conversions, inscriptions. */
  async tendance(q: AnalyticsQueryDto) {
    const fin = q.to ? new Date(`${q.to.slice(0, 10)}T00:00:00.000Z`) : new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
    const debutDemande = q.from ? new Date(`${q.from.slice(0, 10)}T00:00:00.000Z`) : new Date(fin.getTime() - 29 * JOUR);
    // Au plus un an de points : au-delà, le graphique ne se lit plus.
    const debut = new Date(Math.max(debutDemande.getTime(), fin.getTime() - 365 * JOUR));
    const lendemain = new Date(fin.getTime() + JOUR);
    return this.prisma.$queryRaw<{ jour: string; appels: number; joints: number; coupons: number; conversions: number; inscriptions: number }[]>`
      WITH jours AS (SELECT generate_series(${debut}::date, ${fin}::date, interval '1 day')::date AS jour),
      a AS (SELECT k.created_at::date AS j, count(*) AS n, count(*) FILTER (WHERE k.reached) AS r FROM "ConversionCall" k
            WHERE k.created_at >= ${debut} AND k.created_at < ${lendemain} ${this.campagneColonne('k', q)} GROUP BY 1),
      c AS (SELECT c.sent_at::date AS j, count(*) AS n FROM "ConversionCoupon" c
            WHERE c.sent_at >= ${debut} AND c.sent_at < ${lendemain} ${this.campagneColonne('c', q)} GROUP BY 1),
      v AS (SELECT p.converted_at::date AS j, count(*) AS n FROM "ConversionProspect" p
            WHERE p.converted_at >= ${debut} AND p.converted_at < ${lendemain} ${this.campagneProspect(q)} GROUP BY 1),
      i AS (SELECT p.registered_at::date AS j, count(*) AS n FROM "ConversionProspect" p
            WHERE p.registered_at >= ${debut} AND p.registered_at < ${lendemain} ${this.campagneProspect(q)} GROUP BY 1)
      SELECT to_char(jours.jour, 'YYYY-MM-DD') AS jour,
        coalesce(a.n, 0)::int AS appels, coalesce(a.r, 0)::int AS joints, coalesce(c.n, 0)::int AS coupons,
        coalesce(v.n, 0)::int AS conversions, coalesce(i.n, 0)::int AS inscriptions
      FROM jours
      LEFT JOIN a ON a.j = jours.jour LEFT JOIN c ON c.j = jours.jour
      LEFT JOIN v ON v.j = jours.jour LEFT JOIN i ON i.j = jours.jour
      ORDER BY jours.jour`;
  }

  /**
   * Verbatims (cahier §7) : les commentaires des agents, filtrables, avec les
   * mots qui reviennent le plus, en complément des raisons codifiées.
   */
  async verbatims(q: VerbatimsQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const recherche = q.search?.trim();
    const where = Prisma.sql`
      k.comment IS NOT NULL AND k.comment <> ''
      ${this.plage('k.created_at', q)} ${this.campagneColonne('k', q)}
      ${q.loss_reason_id ? Prisma.sql`AND k.loss_reason_id = ${q.loss_reason_id}::uuid` : Prisma.empty}
      ${q.agent_id ? Prisma.sql`AND k.agent_id = ${q.agent_id}::uuid` : Prisma.empty}
      ${recherche ? Prisma.sql`AND k.comment ILIKE ${`%${recherche}%`}` : Prisma.empty}`;
    const [lignes, [total], corpus] = await Promise.all([
      this.prisma.$queryRaw<
        { id: string; created_at: Date; comment: string; status_label: string; outcome: string; raison: string | null; agent: string | null; prospect: string; prospect_id: string }[]
      >`
        SELECT k.id, k.created_at, k.comment, k.status_label, k.outcome::text AS outcome, r.name AS raison, u.fullname AS agent,
          coalesce(nullif(trim(concat_ws(' ', cu.first_name, cu.last_name)), ''), 'Client sans nom') AS prospect, p.id AS prospect_id
        FROM "ConversionCall" k
        JOIN "ConversionProspect" p ON p.id = k.prospect_id
        JOIN "Customer" cu ON cu.id = p.customer_id
        LEFT JOIN "ProspectLossReason" r ON r.id = k.loss_reason_id
        LEFT JOIN "User" u ON u.id = k.agent_id
        WHERE ${where}
        ORDER BY k.created_at DESC
        LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      this.prisma.$queryRaw<{ total: number }[]>`SELECT count(*)::int AS total FROM "ConversionCall" k WHERE ${where}`,
      this.prisma.$queryRaw<{ comment: string }[]>`
        SELECT k.comment FROM "ConversionCall" k WHERE ${where} ORDER BY k.created_at DESC LIMIT 3000`,
    ]);

    const frequences = new Map<string, number>();
    for (const { comment } of corpus) {
      const mots = comment
        .toLowerCase()
        .normalize('NFC')
        .split(/[^a-zàâäçéèêëîïôöùûüÿœ']+/)
        .map((m) => m.replace(/^'+|'+$/g, '').replace(/^[a-z]'/, ''))
        .filter((m) => m.length > 2 && !MOTS_VIDES.has(m));
      for (const mot of new Set(mots)) frequences.set(mot, (frequences.get(mot) ?? 0) + 1);
    }
    const mots = [...frequences.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([mot, nombre]) => ({ mot, nombre }));

    return { data: lignes, meta: { total: total.total, page, limit, totalPages: Math.ceil(total.total / limit) }, mots };
  }
}
