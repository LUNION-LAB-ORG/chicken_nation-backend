import { Prisma } from '@prisma/client';
import { FILTRE_VENTE } from 'src/modules/statistics/helpers/statistics.helper';

/**
 * Requêtes du pilotage du parrainage (backoffice). Le tri et les états portent
 * sur des totaux par parrain (filleuls, ventes, gains) : seul le SQL sait les
 * classer et les paginer sans charger tous les parrains en mémoire.
 *
 * Période : les filleuls se datent à leur inscription, les ventes à leur date
 * de commande. Les gains sont des soldes à ce jour : la période ne les change pas.
 */

/** Plage de dates ; `null` = tout le programme. */
export type Periode = { debut: Date; fin: Date } | null;

export const ETATS_PARRAIN = [
  'avec_filleuls',
  'sans_filleul',
  'qualifies',
  'en_attente',
  'payable',
  'paye',
] as const;
export type EtatParrain = (typeof ETATS_PARRAIN)[number];

export const TRIS_PARRAIN = [
  'filleuls',
  'qualifies',
  'ventes',
  'en_attente',
  'payable',
  'paye',
  'dernier_filleul',
] as const;
export type TriParrain = (typeof TRIS_PARRAIN)[number];

export const ETATS_FILLEUL = ['en_attente', 'a_commande', 'qualifie', 'annule'] as const;
export type EtatFilleul = (typeof ETATS_FILLEUL)[number];

const CONDITION_ETAT: Record<EtatParrain, string> = {
  avec_filleuls: 'filleuls > 0',
  sans_filleul: 'filleuls = 0',
  qualifies: 'qualifies > 0',
  en_attente: 'en_attente > 0',
  payable: 'payable > 0',
  paye: 'paye > 0',
};

export type PasCourbe = 'jour' | 'mois';

/** Même règle que les statistiques (FILTRE_VENTE), écrite pour le SQL. */
const EST_VENTE = Prisma.sql`o.paied = ${FILTRE_VENTE.paied} AND o.status::text IN (${Prisma.join(FILTRE_VENTE.status.in)})`;

const dans = (colonne: 'r.created_at' | 'o.created_at', p: Periode) =>
  p
    ? Prisma.sql`AND ${Prisma.raw(colonne)} >= ${p.debut} AND ${Prisma.raw(colonne)} <= ${p.fin}`
    : Prisma.empty;

/**
 * Une ligne par parrain, ses totaux calculés. `ids` : les parrains retenus par
 * la recherche (`null` = tous).
 */
function lignesParrains(periode: Periode, ids: string[] | null) {
  const inscrits = dans('r.created_at', periode);
  // Recherche sans résultat : aucune ligne (Prisma.join refuse une liste vide).
  const seulement = !ids
    ? Prisma.empty
    : ids.length
      ? Prisma.sql`AND c.id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})`
      : Prisma.sql`AND FALSE`;
  return Prisma.sql`
    WITH parrains AS (
      SELECT c.id, c.first_name, c.last_name, c.phone, c.referral_code, c.referral_code_ancien, c.created_at
      FROM "Customer" c
      WHERE c.referral_code IS NOT NULL AND c.entity_status <> 'DELETED' ${seulement}
    ),
    filleuls AS (
      SELECT r.referrer_id AS id,
        count(*) FILTER (WHERE r.status <> 'CANCELLED' ${inscrits})::int AS filleuls,
        count(*) FILTER (WHERE r.status = 'REWARDED' ${inscrits})::int AS qualifies,
        max(r.created_at) FILTER (WHERE r.status <> 'CANCELLED' ${inscrits}) AS dernier_filleul
      FROM "Referral" r
      GROUP BY r.referrer_id
    ),
    ventes AS (
      SELECT r.referrer_id AS id, sum(o.net_amount)::float8 AS ventes
      FROM "Referral" r
      JOIN "Order" o ON o.customer_id = r.referee_id
      WHERE r.status <> 'CANCELLED' AND ${EST_VENTE} ${dans('o.created_at', periode)}
      GROUP BY r.referrer_id
    ),
    gains AS (
      SELECT e.referrer_id AS id,
        coalesce(sum(e.amount) FILTER (WHERE e.status = 'PENDING'), 0)::int AS en_attente,
        coalesce(sum(e.amount) FILTER (WHERE e.status = 'PAYABLE'), 0)::int AS payable,
        coalesce(sum(e.amount) FILTER (WHERE e.status = 'PAID'), 0)::int AS paye
      FROM "ReferralEarning" e
      GROUP BY e.referrer_id
    ),
    lignes AS (
      SELECT p.*,
        coalesce(f.filleuls, 0) AS filleuls,
        coalesce(f.qualifies, 0) AS qualifies,
        f.dernier_filleul,
        coalesce(v.ventes, 0)::float8 AS ventes,
        coalesce(g.en_attente, 0) AS en_attente,
        coalesce(g.payable, 0) AS payable,
        coalesce(g.paye, 0) AS paye
      FROM parrains p
      LEFT JOIN filleuls f ON f.id = p.id
      LEFT JOIN ventes v ON v.id = p.id
      LEFT JOIN gains g ON g.id = p.id
    )`;
}

/** Une page de parrains. `tri` vient d'une liste fermée (TRIS_PARRAIN, vérifiée par le DTO). */
export function sqlPageParrains(o: {
  periode: Periode;
  ids: string[] | null;
  etat?: EtatParrain;
  tri: TriParrain;
  limite: number;
  decalage: number;
}) {
  const filtre = o.etat ? Prisma.sql`WHERE ${Prisma.raw(CONDITION_ETAT[o.etat])}` : Prisma.empty;
  return Prisma.sql`${lignesParrains(o.periode, o.ids)}
    SELECT * FROM lignes ${filtre}
    ORDER BY ${Prisma.raw(o.tri)} DESC NULLS LAST, filleuls DESC, created_at DESC NULLS LAST, id
    LIMIT ${Prisma.raw(String(Math.trunc(o.limite)))} OFFSET ${Prisma.raw(String(Math.trunc(o.decalage)))}`;
}

/** Nombre de parrains pour chaque état, affiché sur les filtres. */
export function sqlCompteursParrains(periode: Periode, ids: string[] | null) {
  const colonnes = ETATS_PARRAIN.map(
    (e) => `count(*) FILTER (WHERE ${CONDITION_ETAT[e]})::int AS ${e}`,
  ).join(', ');
  return Prisma.sql`${lignesParrains(periode, ids)}
    SELECT count(*)::int AS tous, ${Prisma.raw(colonnes)} FROM lignes`;
}

/** Filleuls inscrits sur la période et ce qu'ils sont devenus. */
export function sqlChiffresFilleuls(periode: Periode) {
  return Prisma.sql`
    SELECT
      count(*) FILTER (WHERE r.status <> 'CANCELLED')::int AS inscrits,
      count(*) FILTER (WHERE r.status = 'REWARDED')::int AS qualifies,
      count(*) FILTER (WHERE r.status = 'PENDING')::int AS en_attente,
      count(*) FILTER (WHERE r.status = 'CANCELLED')::int AS annules,
      count(DISTINCT r.referrer_id) FILTER (WHERE r.status <> 'CANCELLED')::int AS parrains_actifs,
      count(*) FILTER (WHERE r.status <> 'CANCELLED' AND EXISTS (
        SELECT 1 FROM "Order" o WHERE o.customer_id = r.referee_id AND ${EST_VENTE}
      ))::int AS ont_commande
    FROM "Referral" r
    WHERE TRUE ${dans('r.created_at', periode)}`;
}

/** Ventes des filleuls sur la période. */
export function sqlChiffresVentes(periode: Periode) {
  return Prisma.sql`
    SELECT coalesce(sum(o.net_amount), 0)::float8 AS montant, count(*)::int AS commandes
    FROM "Referral" r
    JOIN "Order" o ON o.customer_id = r.referee_id
    WHERE r.status <> 'CANCELLED' AND ${EST_VENTE} ${dans('o.created_at', periode)}`;
}

/** Soldes à ce jour : montants, parrains concernés, primes et commissions. */
export function sqlSoldes() {
  return Prisma.sql`
    SELECT
      coalesce(sum(e.amount) FILTER (WHERE e.status = 'PENDING'), 0)::int AS en_attente,
      count(DISTINCT e.referrer_id) FILTER (WHERE e.status = 'PENDING')::int AS parrains_en_attente,
      coalesce(sum(e.amount) FILTER (WHERE e.status = 'PAYABLE'), 0)::int AS payable,
      count(DISTINCT e.referrer_id) FILTER (WHERE e.status = 'PAYABLE')::int AS parrains_payable,
      coalesce(sum(e.amount) FILTER (WHERE e.status = 'PAID'), 0)::int AS paye,
      count(DISTINCT e.referrer_id) FILTER (WHERE e.status = 'PAID')::int AS parrains_paye,
      coalesce(sum(e.amount) FILTER (WHERE e.status <> 'CANCELLED' AND e.type = 'PRIME'), 0)::int AS primes,
      coalesce(sum(e.amount) FILTER (WHERE e.status <> 'CANCELLED' AND e.type = 'COMMISSION'), 0)::int AS commissions
    FROM "ReferralEarning" e`;
}

const FORMAT_PAS: Record<PasCourbe, string> = { jour: "'YYYY-MM-DD'", mois: "'YYYY-MM'" };

/** Filleuls par date d'inscription. */
export function sqlCourbeFilleuls(periode: Periode, pas: PasCourbe) {
  return Prisma.sql`
    SELECT to_char(r.created_at, ${Prisma.raw(FORMAT_PAS[pas])}) AS date,
      count(*) FILTER (WHERE r.status = 'REWARDED')::int AS qualifies,
      count(*) FILTER (WHERE r.status = 'PENDING')::int AS en_attente
    FROM "Referral" r
    WHERE r.status <> 'CANCELLED' ${dans('r.created_at', periode)}
    GROUP BY 1`;
}

/** Ventes des filleuls par date de commande. */
export function sqlCourbeVentes(periode: Periode, pas: PasCourbe) {
  return Prisma.sql`
    SELECT to_char(o.created_at, ${Prisma.raw(FORMAT_PAS[pas])}) AS date, sum(o.net_amount)::float8 AS ventes
    FROM "Referral" r
    JOIN "Order" o ON o.customer_id = r.referee_id
    WHERE r.status <> 'CANCELLED' AND ${EST_VENTE} ${dans('o.created_at', periode)}
    GROUP BY 1`;
}
