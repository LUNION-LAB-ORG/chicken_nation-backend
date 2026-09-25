import { CrmSegment, Prisma } from '@prisma/client';
import {
  COUPON_UTILISE_SQL,
  PUBLICS_CAPTES,
  VENTE_VALIDE_SQL,
  bornesPeriode,
  ficheDuRestaurantSql,
  publicsDe,
} from '../crm.rules';

/**
 * Morceaux de requêtes communs aux tableaux de bord du CRM (lot 3).
 *
 * Règle de lecture : un indicateur de PÉRIODE ne lit jamais l'état actuel de
 * la fiche (son public, sa conversion, son nombre d'appels), effacé à chaque
 * nouveau cycle. Il lit les passages ("CrmCycle"), les appels et coupons de
 * chaque passage (contact_id, cycle) et le registre des ventes. Seuls les
 * stocks « aujourd'hui » lisent la fiche.
 *
 * Définitions (reprises dans l'aide des écrans) :
 *  - entrée au CRM = greatest(segment_since, crm_entered_at) : le stock repris
 *    à l'ouverture tombe le jour de l'ouverture ;
 *  - étapes emboîtées dans le même passage : contacté (au moins un appel),
 *    joint (et un appel joint), intéressé (et issue INTERESSE ou coupon),
 *    coupon envoyé (et coupon), commande (et vente) ;
 *  - vente du passage : registre, source CRM, vente valide, à partir de
 *    l'entrée ; une vente antérieure à l'entrée est « reprise », hors taux.
 */

export { publicsDe };

/** Filtres communs aux tableaux de bord. */
export interface FiltresAnalyse {
  from?: string;
  to?: string;
  campaign_id?: string;
  segment?: string;
  segments?: string[];
  /**
   * Restaurant d'un compte de point de vente : seules les fiches de ce
   * restaurant comptent. Posé par le contrôleur à partir du compte connecté
   * (`CrmAccessService.filtresAnalyse`), jamais lu dans la requête HTTP.
   */
  perimetre_restaurant?: string;
}

/** Périmètre restaurant d'un tableau de bord (voir `FiltresAnalyse`). */
export type Perimetre = Pick<FiltresAnalyse, 'perimetre_restaurant'>;

export const VENTE_VALIDE = Prisma.raw(VENTE_VALIDE_SQL);
export const COUPON_UTILISE = Prisma.raw(COUPON_UTILISE_SQL);
export const DEFINITIFS = Prisma.sql`('INTERESSE', 'NON_INTERESSE', 'NUMERO_INVALIDE')`;

/** La date `colonne` tombe dans la période, en expression booléenne (vrai sans borne). */
export function dansPeriode(colonne: string, q: Pick<FiltresAnalyse, 'from' | 'to'>): Prisma.Sql {
  const col = Prisma.raw(colonne);
  const { debut, fin } = bornesPeriode(q);
  const conditions: Prisma.Sql[] = [];
  if (debut) conditions.push(Prisma.sql`${col} >= ${debut}`);
  if (fin) conditions.push(Prisma.sql`${col} < ${fin}`);
  return conditions.length ? Prisma.sql`(${Prisma.join(conditions, ' AND ')})` : Prisma.sql`true`;
}

/** `AND` + période sur `colonne` : [from 00:00 ; to + 1 jour[, en UTC. */
export function plage(colonne: string, q: Pick<FiltresAnalyse, 'from' | 'to'>): Prisma.Sql {
  return q.from || q.to ? Prisma.sql`AND ${dansPeriode(colonne, q)}` : Prisma.empty;
}

/** Liste SQL de publics : ('GLOVO'::"CrmSegment", …). */
export function listePublics(publics: CrmSegment[]): Prisma.Sql {
  return Prisma.join(publics.map((p) => Prisma.sql`${p}::"CrmSegment"`));
}

/** `AND colonne IN (…)` ; rien quand tous les publics sont demandés. */
export function filtreSegments(colonne: string, publics: CrmSegment[]): Prisma.Sql {
  return publics.length ? Prisma.sql`AND ${Prisma.raw(colonne)} IN (${listePublics(publics)})` : Prisma.empty;
}

/** `AND colonne = campagne` pour une action (appel, coupon, vente) portant sa campagne. */
export function filtreCampagne(colonne: string, q: Pick<FiltresAnalyse, 'campaign_id'>): Prisma.Sql {
  return q.campaign_id ? Prisma.sql`AND ${Prisma.raw(colonne)} = ${q.campaign_id}::uuid` : Prisma.empty;
}

/** La fiche (alias `alias`) est membre de la campagne filtrée, quel que soit le passage. */
export function filtreMembre(alias: string, q: Pick<FiltresAnalyse, 'campaign_id'>): Prisma.Sql {
  return q.campaign_id
    ? Prisma.sql`AND EXISTS (SELECT 1 FROM "CrmCampaignMember" m WHERE m.contact_id = ${Prisma.raw(`${alias}.id`)} AND m.campaign_id = ${q.campaign_id}::uuid)`
    : Prisma.empty;
}

/**
 * `AND colonne IN (fiches du restaurant)` pour un compte de point de vente,
 * rien sinon. `colonne` porte l'id d'une fiche (voir `ficheDuRestaurantSql`).
 */
export function filtreRestaurant(colonne: string, q: Perimetre): Prisma.Sql {
  return q.perimetre_restaurant ? Prisma.sql`AND ${ficheDuRestaurantSql(colonne, q.perimetre_restaurant)}` : Prisma.empty;
}

/** Groupe « Glovo + Yango » d'un public, en SQL. */
export function groupeDe(colonne: string): Prisma.Sql {
  return Prisma.sql`CASE WHEN ${Prisma.raw(colonne)} IN (${listePublics(PUBLICS_CAPTES)}) THEN 'CAPTES' END`;
}

/**
 * Public d'une action (appel, coupon, vente) : celui du passage où elle a eu
 * lieu (jointure `LEFT JOIN "CrmCycle" ya ON (contact_id, cycle)`), à défaut
 * le public noté sur l'action (cycle 0, historique antérieur au premier passage).
 */
export function jointurePassage(alias: string): Prisma.Sql {
  return Prisma.sql`LEFT JOIN "CrmCycle" ya ON ya.contact_id = ${Prisma.raw(`${alias}.contact_id`)} AND ya.cycle = ${Prisma.raw(`${alias}.cycle`)}`;
}
export function publicAction(alias: string): Prisma.Sql {
  // Une vente de l'ancienne acquisition garde son public d'origine (Glovo ou Yango).
  if (alias === 'v') return Prisma.sql`CASE WHEN v.source = 'ACQUISITION_HISTORIQUE' THEN v.segment ELSE coalesce(ya.segment, v.segment) END`;
  return Prisma.sql`coalesce(ya.segment, ${Prisma.raw(`${alias}.segment`)})`;
}

/**
 * Agrégat par public d'une sous-requête qui rend une colonne `segment` :
 * `GROUP BY GROUPING SETS ((segment), (groupe), ())`, soit une ligne par
 * public, une pour Glovo + Yango réunis et le total. Les colonnes
 * s'écrivent sur l'alias `t`. Lire le résultat avec `classerGroupes`.
 */
export function parPublic(colonnes: Prisma.Sql, source: Prisma.Sql, publics: CrmSegment[]): Prisma.Sql {
  return Prisma.sql`
    SELECT GROUPING(t.segment)::int AS g_segment, GROUPING(t.groupe)::int AS g_groupe,
           t.segment::text AS segment, t.groupe, ${colonnes}
    FROM (SELECT s.*, ${groupeDe('s.segment')} AS groupe FROM (${source}) s) t
    WHERE true ${filtreSegments('t.segment', publics)}
    GROUP BY GROUPING SETS ((t.segment), (t.groupe), ())`;
}

/**
 * Les passages entrés sur la période et ce qui leur est arrivé, en CTE :
 *  - `pass` : un passage par ligne (fiches supprimées exclues, et celles des
 *    autres restaurants pour un compte de point de vente), avec `entree`, le
 *    compte de la fiche et `already_customer` ;
 *  - `ap` : ses appels (nombre, premier appel joint, issue INTERESSE, première
 *    issue définitive, premier appel NON repris et son issue) ;
 *  - `cp` : ses coupons (premier envoi, utilisé sur une commande qui compte) ;
 *  - `vt` : sa vente (registre, source CRM, vente valide) ;
 *  - `etat` : le passage avec ses étapes emboîtées en booléens.
 * S'utilise ainsi : Prisma.sql`WITH ${passages(q)} SELECT … FROM etat e …`.
 */
export function passages(q: FiltresAnalyse, publics: CrmSegment[] = publicsDe(q)): Prisma.Sql {
  const membre = q.campaign_id
    ? Prisma.sql`AND EXISTS (SELECT 1 FROM "CrmCampaignMember" m
        WHERE m.contact_id = y.contact_id AND m.cycle = y.cycle AND m.campaign_id = ${q.campaign_id}::uuid)`
    : Prisma.empty;
  return Prisma.sql`
    pass AS (
      SELECT y.contact_id, y.cycle, y.segment, y.segment_since, y.crm_entered_at, y.closed_at, y.already_customer,
             greatest(y.segment_since, y.crm_entered_at) AS entree,
             x.customer_id, x.registered_at
      FROM "CrmCycle" y JOIN "CrmContact" x ON x.id = y.contact_id
      WHERE x.entity_status <> 'DELETED'
        ${plage('greatest(y.segment_since, y.crm_entered_at)', q)}
        ${filtreSegments('y.segment', publics)} ${membre} ${filtreRestaurant('x.id', q)}
    ),
    ap AS (
      SELECT k.contact_id, k.cycle,
             count(*)::int AS appels,
             min(k.created_at) FILTER (WHERE k.reached) AS premier_joint,
             bool_or(k.outcome = 'INTERESSE') AS interesse,
             min(k.created_at) FILTER (WHERE k.outcome IN ${DEFINITIFS}) AS premiere_issue,
             min(k.created_at) FILTER (WHERE NOT k.imported) AS premier_appel,
             (array_agg(k.outcome::text ORDER BY k.created_at, k.id) FILTER (WHERE NOT k.imported))[1] AS issue_premier_appel
      FROM "CrmCall" k JOIN pass p ON p.contact_id = k.contact_id AND p.cycle = k.cycle
      GROUP BY k.contact_id, k.cycle
    ),
    cp AS (
      SELECT c.contact_id, c.cycle, min(c.sent_at) AS premier_coupon, count(*)::int AS coupons,
             bool_or(${COUPON_UTILISE}) AS coupon_utilise
      FROM "CrmCoupon" c JOIN pass p ON p.contact_id = c.contact_id AND p.cycle = c.cycle
      GROUP BY c.contact_id, c.cycle
    ),
    vt AS (
      -- La vente du passage est une vente du CRM ; « déjà converti à l'entrée »
      -- regarde TOUTES les ventes valides, historique de l'acquisition compris.
      SELECT v.contact_id, v.cycle,
             min(v.converted_at) FILTER (WHERE v.source = 'CRM') AS converted_at,
             (sum(v.amount) FILTER (WHERE v.source = 'CRM'))::float AS montant,
             bool_or(v.converted_at < p.entree) AS anterieure
      FROM "CrmConversion" v JOIN pass p ON p.contact_id = v.contact_id AND p.cycle = v.cycle
      WHERE ${VENTE_VALIDE}
      GROUP BY v.contact_id, v.cycle
    ),
    etat AS (
      SELECT p.*, ap.premier_appel, ap.issue_premier_appel, ap.premiere_issue, vt.converted_at,
             coalesce(vt.montant, 0)::float AS montant,
             coalesce(ap.appels, 0) > 0 AS contacte,
             ap.premier_joint IS NOT NULL AS joint,
             ap.premier_joint IS NOT NULL AND (coalesce(ap.interesse, false) OR cp.premier_coupon IS NOT NULL) AS interesse,
             ap.premier_joint IS NOT NULL AND cp.premier_coupon IS NOT NULL AS coupon,
             coalesce(vt.converted_at >= p.entree, false) AS vente,
             -- Déjà converti avant d'entrer (stock repris, historique de
             -- l'acquisition) : compté à part, hors ventes et hors taux.
             coalesce(vt.anterieure, false) AS repris,
             -- Parmi les ventes hors entonnoir (pas de coupon à un contact joint),
             -- celles sans appel joint ni coupon AVANT la commande.
             coalesce(vt.converted_at >= p.entree, false)
               AND NOT (ap.premier_joint IS NOT NULL AND cp.premier_coupon IS NOT NULL)
               AND NOT coalesce(ap.premier_joint <= vt.converted_at, false)
               AND NOT coalesce(cp.premier_coupon <= vt.converted_at, false) AS sans_contact,
             (CASE WHEN vt.converted_at IS NOT NULL
                   THEN greatest(0, EXTRACT(EPOCH FROM (vt.converted_at - p.entree)) / 86400) END)::float AS delai_j,
             (CASE WHEN ap.premier_appel IS NOT NULL
                   THEN greatest(0, EXTRACT(EPOCH FROM (ap.premier_appel - p.entree)) / 3600) END)::float AS delai_appel_h
      FROM pass p
      LEFT JOIN ap ON ap.contact_id = p.contact_id AND ap.cycle = p.cycle
      LEFT JOIN cp ON cp.contact_id = p.contact_id AND cp.cycle = p.cycle
      LEFT JOIN vt ON vt.contact_id = p.contact_id AND vt.cycle = p.cycle
    )`;
}
