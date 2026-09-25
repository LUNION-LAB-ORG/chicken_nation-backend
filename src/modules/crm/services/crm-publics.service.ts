import { Injectable } from '@nestjs/common';
import { CrmSegment, Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import {
  BRUT_DEVENIR_VIDE,
  BrutDevenir,
  COMMANDE_VALIDE_SQL,
  Devenir,
  LigneGroupee,
  PUBLICS_CAPTES,
  STATUTS_OUVERTS,
  arrondiOuNul,
  bornesMois,
  calculerDevenir,
  classerGroupes,
  fenetreComplete,
  libelleLigne,
  porteePublics,
  pourcentage,
  publicsDe,
} from '../crm.rules';
import { AnalyticsQueryDto, CohortesQueryDto } from '../dto/analytics.dto';
import { CrmAccessService, debutDuJour } from './crm-access.service';
import { CrmConfigService } from './crm-config.service';
import {
  COUPON_UTILISE,
  VENTE_VALIDE,
  dansPeriode,
  filtreCampagne,
  filtreMembre,
  jointurePassage,
  listePublics,
  parPublic,
  passages,
  plage,
  publicAction,
} from './crm-passages.query';

const JOUR = 86_400_000;
const COMMANDE_VALIDE = Prisma.raw(COMMANDE_VALIDE_SQL);
const OUVERTS = Prisma.join(STATUTS_OUVERTS.map((s) => Prisma.sql`${s}::"CrmStatus"`));

/** Clé d'une ligne de tableau de bord : un public, Glovo + Yango réunis, ou le total. */
export type CleLigne = CrmSegment | 'CAPTES' | 'TOTAL';
const CLES: CleLigne[] = [...Object.values(CrmSegment), 'CAPTES', 'TOTAL'];

/** Activité de la période : les événements datés dans la période, quel que soit le jour d'entrée. */
export interface Activite {
  appels: number;
  appels_joints: number;
  contacts_appeles: number;
  coupons_envoyes: number;
  coupons_utilises: number;
  ca_coupons: number;
  remises_coupons: number;
  ventes_crm: number;
  ca_crm: number;
  panier_moyen: number;
  ventes_historiques: number;
  ca_historique: number;
}

/** Stocks d'aujourd'hui, sans période : l'état actuel des fiches. */
export interface Aujourdhui {
  ouverts: number;
  jamais_appeles: number;
  a_rappeler: number;
  file_commune: number | null;
  sans_agent_hors_file: number;
  en_campagne: number;
}

/** Commande suivante après une vente du CRM, dans le délai d'inactivité. */
export interface SecondeCommande {
  fenetre_jours: number;
  ventes: number;
  non_mesurables: number;
  en_attente: number;
  mesurables: number;
  recommande_30j: number;
  taux_30j: number;
  delai_median_j: number | null;
}

export interface LignePublic {
  cle: CleLigne;
  segment: CrmSegment | null;
  libelle: string;
  devenir: Devenir;
  activite: Activite;
  aujourdhui: Aujourdhui;
  seconde_commande: SecondeCommande;
}

export interface ComparatifPublics {
  periode: { from: string | null; to: string | null };
  campaign_id: string | null;
  publics: CrmSegment[];
  fenetre_jours: number;
  lignes: LignePublic[];
  glovo_yango: LignePublic | null;
  total: LignePublic;
}

type Groupes<T> = Record<CleLigne, T>;

/** La ligne couvre-t-elle au moins un public capté (Glovo ou Yango) ? */
function couvreCaptes(cle: CleLigne, portee: CrmSegment[]): boolean {
  if (cle === 'CAPTES') return true;
  if (cle === 'TOTAL') return portee.some((p) => PUBLICS_CAPTES.includes(p));
  return PUBLICS_CAPTES.includes(cle);
}

/** Répartit les lignes d'un GROUPING SETS par clé, avec une valeur pour chaque clé. */
function grouper<T extends LigneGroupee, R>(lignes: T[], convertir: (l: T | null, cle: CleLigne) => R): Groupes<R> {
  const { parPublic: publics, captes, total } = classerGroupes(lignes);
  const sortie = {} as Groupes<R>;
  for (const cle of CLES) {
    const ligne = cle === 'TOTAL' ? total : cle === 'CAPTES' ? captes : (publics.get(cle) ?? null);
    sortie[cle] = convertir(ligne, cle);
  }
  return sortie;
}

const n = (v: unknown) => Number(v ?? 0);

/**
 * Vue comparée des publics (lot 3) et cohortes propres à chaque public.
 *
 *  - « devenir » : les passages ENTRÉS sur la période et ce qui leur est
 *    arrivé depuis, étapes emboîtées dans le même passage ;
 *  - « activité » : ce qui s'est passé PENDANT la période (appels, coupons,
 *    ventes), rangé sous le public du passage où l'action a eu lieu ;
 *  - « aujourd'hui » : les stocks actuels, seule partie qui lit la fiche ;
 *  - « seconde commande » : les ventes de la période suivies d'une autre
 *    commande avant que le client ne redevienne inactif.
 */
@Injectable()
export class CrmPublicsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CrmAccessService,
    private readonly config: CrmConfigService,
  ) {}

  /** Délai d'inactivité réglé (30 jours par défaut) : la fenêtre des taux « à 30 jours ». */
  fenetre(): Promise<number> {
    return this.config.joursInactivite();
  }

  async comparer(q: AnalyticsQueryDto): Promise<ComparatifPublics> {
    const publics = publicsDe(q);
    const portee = porteePublics(publics);
    const jours = await this.config.joursInactivite();
    const [devenir, activite, aujourdhui, seconde] = await Promise.all([
      this.devenir(q, jours),
      this.activite(q),
      this.aujourdhui(q),
      this.secondeCommande(q, jours),
    ]);
    const ligne = (cle: CleLigne): LignePublic => ({
      cle,
      segment: cle === 'CAPTES' || cle === 'TOTAL' ? null : cle,
      libelle: libelleLigne(cle),
      devenir: devenir[cle],
      activite: activite[cle],
      aujourdhui: aujourdhui[cle],
      seconde_commande: seconde[cle],
    });
    const deuxCaptes = PUBLICS_CAPTES.every((p) => portee.includes(p));
    return {
      periode: { from: q.from?.slice(0, 10) ?? null, to: q.to?.slice(0, 10) ?? null },
      campaign_id: q.campaign_id ?? null,
      publics: portee,
      fenetre_jours: jours,
      lignes: portee.map(ligne),
      glovo_yango: deuxCaptes ? ligne('CAPTES') : null,
      total: ligne('TOTAL'),
    };
  }

  /**
   * Devenir des passages entrés sur la période (entrée au CRM). Glovo/Yango :
   * les « déjà clients » (compte qui avait commandé dans le délai d'inactivité
   * avant la capture) restent comptés dans les entrées et l'entonnoir, mais
   * sortent du taux de conversion, avec leur propre ligne.
   */
  async devenir(q: AnalyticsQueryDto, jours?: number): Promise<Groupes<Devenir>> {
    const publics = publicsDe(q);
    const portee = porteePublics(publics);
    const fenetre = jours ?? (await this.config.joursInactivite());
    const maintenant = new Date();
    const limiteFenetre = new Date(maintenant.getTime() - fenetre * JOUR);
    const aujourdhui = debutDuJour(maintenant);
    // Traité à J+1 : premier appel au plus tard le lendemain de l'entrée ; ne se
    // juge que si ce lendemain est terminé (entrée il y a au moins 2 jours).
    const limiteJ1 = new Date(aujourdhui.getTime() - 2 * JOUR);
    const limiteJ2 = new Date(aujourdhui.getTime() - 3 * JOUR);
    const colonnes = Prisma.sql`
      count(*)::int AS entrees,
      count(*) FILTER (WHERE t.contacte)::int AS contactes,
      count(*) FILTER (WHERE t.joint)::int AS joints,
      count(*) FILTER (WHERE t.interesse)::int AS interesses,
      count(*) FILTER (WHERE t.coupon)::int AS coupons,
      count(*) FILTER (WHERE t.coupon AND t.vente)::int AS commandes,
      count(*) FILTER (WHERE t.vente)::int AS ventes,
      count(*) FILTER (WHERE t.vente AND NOT t.coupon)::int AS hors_entonnoir,
      count(*) FILTER (WHERE t.sans_contact)::int AS sans_contact,
      count(*) FILTER (WHERE t.repris)::int AS repris,
      coalesce(sum(t.montant) FILTER (WHERE t.vente), 0)::float AS ca,
      -- Base des taux : ni déjà clients (Glovo/Yango), ni déjà convertis à l'entrée (repris).
      count(*) FILTER (WHERE t.already_customer IS NOT TRUE AND NOT t.repris)::int AS base_taux,
      count(*) FILTER (WHERE t.vente AND t.already_customer IS NOT TRUE AND NOT t.repris)::int AS ventes_base,
      count(*) FILTER (WHERE t.already_customer IS NOT TRUE AND NOT t.repris AND t.entree <= ${limiteFenetre})::int AS mesurables_fenetre,
      count(*) FILTER (WHERE t.already_customer IS NOT TRUE AND NOT t.repris AND t.entree <= ${limiteFenetre}
        AND t.vente AND t.converted_at < t.entree + make_interval(days => ${fenetre}::int))::int AS ventes_fenetre,
      (percentile_cont(0.5) WITHIN GROUP (ORDER BY t.delai_j) FILTER (WHERE t.vente))::float AS delai_median_j,
      (avg(t.delai_j) FILTER (WHERE t.vente))::float AS delai_moyen_j,
      (percentile_cont(0.5) WITHIN GROUP (ORDER BY t.delai_appel_h) FILTER (WHERE t.premier_appel IS NOT NULL))::float AS premier_appel_median_h,
      count(*) FILTER (WHERE date_trunc('day', t.entree) <= ${limiteJ1})::int AS mesurables_j1,
      count(*) FILTER (WHERE date_trunc('day', t.entree) <= ${limiteJ1}
        AND t.premier_appel < date_trunc('day', t.entree) + interval '2 days')::int AS traites_j1,
      count(*) FILTER (WHERE date_trunc('day', t.entree) <= ${limiteJ2})::int AS mesurables_j2,
      count(*) FILTER (WHERE date_trunc('day', t.entree) <= ${limiteJ2}
        AND t.premier_appel < date_trunc('day', t.entree) + interval '3 days')::int AS traites_j2,
      count(*) FILTER (WHERE t.groupe = 'CAPTES')::int AS captes,
      count(*) FILTER (WHERE t.groupe = 'CAPTES' AND t.already_customer IS TRUE)::int AS deja_clients,
      count(*) FILTER (WHERE t.groupe = 'CAPTES' AND t.already_customer IS TRUE AND t.vente)::int AS ventes_deja_clients,
      count(*) FILTER (WHERE t.groupe = 'CAPTES' AND t.registered_at < t.segment_since)::int AS deja_inscrits_a_la_capture,
      count(*) FILTER (WHERE t.groupe = 'CAPTES' AND t.registered_at >= t.segment_since)::int AS inscrits_apres_capture,
      count(*) FILTER (WHERE t.groupe = 'CAPTES' AND t.customer_id IS NULL)::int AS sans_compte`;
    const lignes = await this.prisma.$queryRaw<(LigneGroupee & BrutDevenir)[]>`
      WITH ${passages(q, publics)}
      ${parPublic(colonnes, Prisma.sql`SELECT * FROM etat`, publics)}`;
    return grouper(lignes, (l, cle) => calculerDevenir(l ?? BRUT_DEVENIR_VIDE, couvreCaptes(cle, portee)));
  }

  /** Événements de la période, rangés sous le public du passage où ils ont eu lieu. */
  async activite(q: AnalyticsQueryDto): Promise<Groupes<Activite>> {
    const publics = publicsDe(q);
    const [appels, coupons, ventes] = await Promise.all([
      this.prisma.$queryRaw<(LigneGroupee & { appels: number; appels_joints: number; contacts_appeles: number })[]>`
        ${parPublic(
          Prisma.sql`count(*)::int AS appels, count(*) FILTER (WHERE t.reached)::int AS appels_joints,
            count(DISTINCT t.contact_id)::int AS contacts_appeles`,
          Prisma.sql`SELECT k.contact_id, k.reached, ${publicAction('k')} AS segment
            FROM "CrmCall" k ${jointurePassage('k')}
            WHERE true ${plage('k.created_at', q)} ${filtreCampagne('k.campaign_id', q)}`,
          publics,
        )}`,
      this.prisma.$queryRaw<
        (LigneGroupee & { coupons_envoyes: number; coupons_utilises: number; ca_coupons: number; remises_coupons: number })[]
      >`
        ${parPublic(
          Prisma.sql`count(*) FILTER (WHERE t.envoye)::int AS coupons_envoyes,
            count(*) FILTER (WHERE t.utilise)::int AS coupons_utilises,
            coalesce(sum(t.montant) FILTER (WHERE t.utilise), 0)::float AS ca_coupons,
            coalesce(sum(t.remise) FILTER (WHERE t.utilise), 0)::float AS remises_coupons`,
          Prisma.sql`SELECT c.contact_id, ${publicAction('c')} AS segment,
              ${dansPeriode('c.sent_at', q)} AS envoye,
              coalesce(${COUPON_UTILISE} AND ${dansPeriode('c.used_at', q)}, false) AS utilise,
              coalesce(c.order_amount, 0)::float AS montant, coalesce(o.discount, 0)::float AS remise
            FROM "CrmCoupon" c ${jointurePassage('c')} LEFT JOIN "Order" o ON o.id = c.order_id
            WHERE (${dansPeriode('c.sent_at', q)} OR ${dansPeriode('c.used_at', q)}) ${filtreCampagne('c.campaign_id', q)}`,
          publics,
        )}`,
      this.prisma.$queryRaw<
        (LigneGroupee & { ventes_crm: number; ca_crm: number; ventes_historiques: number; ca_historique: number })[]
      >`
        ${parPublic(
          Prisma.sql`count(*) FILTER (WHERE t.origine = 'CRM')::int AS ventes_crm,
            coalesce(sum(t.amount) FILTER (WHERE t.origine = 'CRM'), 0)::float AS ca_crm,
            count(*) FILTER (WHERE t.origine = 'ACQUISITION_HISTORIQUE')::int AS ventes_historiques,
            coalesce(sum(t.amount) FILTER (WHERE t.origine = 'ACQUISITION_HISTORIQUE'), 0)::float AS ca_historique`,
          Prisma.sql`SELECT v.contact_id, ${publicAction('v')} AS segment, v.amount, v.source::text AS origine
            FROM "CrmConversion" v ${jointurePassage('v')}
            WHERE ${VENTE_VALIDE} ${plage('v.converted_at', q)} ${filtreCampagne('v.campaign_id', q)}`,
          publics,
        )}`,
    ]);
    const a = grouper(appels, (l) => l);
    const c = grouper(coupons, (l) => l);
    const v = grouper(ventes, (l) => l);
    const sortie = {} as Groupes<Activite>;
    for (const cle of CLES) {
      const ventesCrm = n(v[cle]?.ventes_crm);
      const caCrm = n(v[cle]?.ca_crm);
      sortie[cle] = {
        appels: n(a[cle]?.appels),
        appels_joints: n(a[cle]?.appels_joints),
        contacts_appeles: n(a[cle]?.contacts_appeles),
        coupons_envoyes: n(c[cle]?.coupons_envoyes),
        coupons_utilises: n(c[cle]?.coupons_utilises),
        ca_coupons: Math.round(n(c[cle]?.ca_coupons)),
        remises_coupons: Math.round(n(c[cle]?.remises_coupons)),
        ventes_crm: ventesCrm,
        ca_crm: Math.round(caCrm),
        panier_moyen: ventesCrm > 0 ? Math.round(caCrm / ventesCrm) : 0,
        ventes_historiques: n(v[cle]?.ventes_historiques),
        ca_historique: Math.round(n(v[cle]?.ca_historique)),
      };
    }
    return sortie;
  }

  /**
   * Stocks d'aujourd'hui (seule partie qui lit la fiche). Filtre campagne : les
   * fiches qui en ont été membres. La file commune est celle de
   * `CrmAccessService.fileCommune()` ; « sans agent » l'exclut.
   */
  async aujourdhui(q: AnalyticsQueryDto): Promise<Groupes<Aujourdhui>> {
    const publics = publicsDe(q);
    const portee = porteePublics(publics);
    const maintenant = new Date();
    const [lignes, file] = await Promise.all([
      this.prisma.$queryRaw<
        (LigneGroupee & { ouverts: number; jamais_appeles: number; a_rappeler: number; sans_agent_hors_file: number; en_campagne: number })[]
      >`
        ${parPublic(
          Prisma.sql`count(*) FILTER (WHERE t.status IN (${OUVERTS}))::int AS ouverts,
            count(*) FILTER (WHERE t.status = 'A_APPELER' AND t.call_count = 0)::int AS jamais_appeles,
            count(*) FILTER (WHERE t.status = 'A_RAPPELER')::int AS a_rappeler,
            count(*) FILTER (WHERE t.status IN (${OUVERTS}) AND t.assigned_to_id IS NULL AND t.campaign_id IS NULL
              AND NOT (t.segment IN (${listePublics(PUBLICS_CAPTES)}) AND t.segment_since < ${debutDuJour(maintenant)}))::int AS sans_agent_hors_file,
            count(*) FILTER (WHERE t.status IN (${OUVERTS}) AND t.campaign_id IS NOT NULL)::int AS en_campagne`,
          Prisma.sql`SELECT p.id, p.segment, p.status, p.call_count, p.assigned_to_id, p.campaign_id, p.segment_since
            FROM "CrmContact" p WHERE p.entity_status <> 'DELETED' ${filtreMembre('p', q)}`,
          publics,
        )}`,
      this.fileCommune(q, maintenant),
    ]);
    return grouper(lignes, (l, cle) => {
      const fileCle =
        cle === 'TOTAL' || cle === 'CAPTES'
          ? PUBLICS_CAPTES.filter((p) => portee.includes(p)).reduce((s, p) => s + (file.get(p) ?? 0), 0)
          : (file.get(cle) ?? 0);
      return {
        ouverts: n(l?.ouverts),
        jamais_appeles: n(l?.jamais_appeles),
        a_rappeler: n(l?.a_rappeler),
        file_commune: couvreCaptes(cle, portee) ? fileCle : null,
        sans_agent_hors_file: n(l?.sans_agent_hors_file),
        en_campagne: n(l?.en_campagne),
      };
    });
  }

  /** File commune Glovo/Yango du jour, par public, dans le périmètre des filtres. */
  async fileCommune(q: AnalyticsQueryDto, maintenant = new Date()): Promise<Map<CrmSegment, number>> {
    const publics = publicsDe(q);
    const captes = PUBLICS_CAPTES.filter((p) => !publics.length || publics.includes(p));
    if (!captes.length) return new Map();
    const lignes = await this.prisma.crmContact.groupBy({
      by: ['segment'],
      where: {
        AND: [
          this.access.fileCommune(maintenant),
          { segment: { in: captes } },
          ...(q.campaign_id ? [{ members: { some: { campaign_id: q.campaign_id } } }] : []),
        ],
      },
      _count: { _all: true },
    });
    return new Map(lignes.map((l) => [l.segment, l._count._all]));
  }

  /**
   * Seconde commande : pour chaque vente du CRM de la période, la première
   * commande valide suivante du même compte. « Recommande » si elle arrive
   * dans le délai d'inactivité (avant que le client ne redevienne inactif).
   * Une vente sans compte (Glovo/Yango converti par un coupon utilisé sur un
   * autre compte) n'est pas mesurable ; une vente trop récente est « en attente ».
   */
  async secondeCommande(q: AnalyticsQueryDto, jours?: number): Promise<Groupes<SecondeCommande>> {
    const publics = publicsDe(q);
    const fenetre = jours ?? (await this.config.joursInactivite());
    const limite = new Date(Date.now() - fenetre * JOUR);
    const lignes = await this.prisma.$queryRaw<
      (LigneGroupee & { ventes: number; non_mesurables: number; en_attente: number; mesurables: number; recommande: number; delai_median_j: number | null })[]
    >`
      ${parPublic(
        Prisma.sql`count(*)::int AS ventes,
          count(*) FILTER (WHERE t.customer_id IS NULL)::int AS non_mesurables,
          count(*) FILTER (WHERE t.customer_id IS NOT NULL AND t.converted_at > ${limite})::int AS en_attente,
          count(*) FILTER (WHERE t.customer_id IS NOT NULL AND t.converted_at <= ${limite})::int AS mesurables,
          count(*) FILTER (WHERE t.customer_id IS NOT NULL AND t.converted_at <= ${limite}
            AND t.suivante <= t.converted_at + make_interval(days => ${fenetre}::int))::int AS recommande,
          (percentile_cont(0.5) WITHIN GROUP (ORDER BY (EXTRACT(EPOCH FROM (t.suivante - t.converted_at)) / 86400)::float)
            FILTER (WHERE t.suivante IS NOT NULL))::float AS delai_median_j`,
        Prisma.sql`SELECT ${publicAction('v')} AS segment, x.customer_id, v.converted_at, n.created_at AS suivante
          FROM "CrmConversion" v
          JOIN "CrmContact" x ON x.id = v.contact_id
          ${jointurePassage('v')}
          LEFT JOIN LATERAL (
            SELECT o.created_at FROM "Order" o
            WHERE o.customer_id = x.customer_id AND ${COMMANDE_VALIDE}
              AND o.created_at > v.converted_at AND o.id IS DISTINCT FROM v.order_id
            ORDER BY o.created_at LIMIT 1
          ) n ON true
          WHERE v.source = 'CRM' AND ${VENTE_VALIDE} ${plage('v.converted_at', q)} ${filtreCampagne('v.campaign_id', q)}`,
        publics,
      )}`;
    return grouper(lignes, (l) => ({
      fenetre_jours: fenetre,
      ventes: n(l?.ventes),
      non_mesurables: n(l?.non_mesurables),
      en_attente: n(l?.en_attente),
      mesurables: n(l?.mesurables),
      recommande_30j: n(l?.recommande),
      taux_30j: pourcentage(n(l?.recommande), n(l?.mesurables)),
      delai_median_j: arrondiOuNul(l?.delai_median_j),
    }));
  }

  // ---------------------------------------------------------------------------
  // Cohortes
  // ---------------------------------------------------------------------------

  /**
   * Cohortes propres à chaque public :
   *  - inscrits (ou sans public) : TOUS les clients par mois d'inscription,
   *    seule vue qui remonte avant l'ouverture du CRM ;
   *  - inactifs : passages par mois de décrochage ;
   *  - Glovo/Yango : passages par mois de la capture qui les ouvre.
   */
  async cohortes(q: CohortesQueryDto) {
    if (q.segment === CrmSegment.INACTIF) return this.cohortesInactifs(q);
    if (q.segment === CrmSegment.GLOVO || q.segment === CrmSegment.YANGO) return this.cohortesCaptes(q, q.segment);
    return this.cohortesInscrits(q);
  }

  private bornesCohorte(colonne: string, q: CohortesQueryDto): Prisma.Sql {
    const { debut, fin } = bornesMois(q);
    const col = Prisma.raw(colonne);
    return Prisma.sql`${debut ? Prisma.sql`AND ${col} >= ${debut}` : Prisma.empty} ${fin ? Prisma.sql`AND ${col} < ${fin}` : Prisma.empty}`;
  }

  private async cohortesInscrits(q: CohortesQueryDto) {
    const lignes = await this.prisma.$queryRaw<
      { mois: string; inscrits: number; convertis: number; sous_7_jours: number; delai_moyen: number | null; delai_median: number | null }[]
    >`
      WITH premieres AS (
        SELECT o.customer_id, min(o.created_at) AS premiere FROM "Order" o WHERE ${COMMANDE_VALIDE} GROUP BY o.customer_id
      ), delais AS (
        SELECT c.created_at, pr.premiere,
          greatest(0, EXTRACT(EPOCH FROM (pr.premiere - c.created_at)) / 86400)::float AS jours
        FROM "Customer" c LEFT JOIN premieres pr ON pr.customer_id = c.id
        WHERE c.entity_status <> 'DELETED' ${this.bornesCohorte('c.created_at', q)}
      )
      SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS mois,
        count(*)::int AS inscrits,
        count(premiere)::int AS convertis,
        count(premiere) FILTER (WHERE jours <= 7)::int AS sous_7_jours,
        (avg(jours) FILTER (WHERE premiere IS NOT NULL))::float AS delai_moyen,
        (percentile_cont(0.5) WITHIN GROUP (ORDER BY jours) FILTER (WHERE premiere IS NOT NULL))::float AS delai_median
      FROM delais GROUP BY 1 ORDER BY 1`;
    return {
      type: 'INSCRITS' as const,
      segment: q.segment ?? null,
      lignes: lignes.map((l) => ({
        mois: l.mois,
        inscrits: n(l.inscrits),
        convertis: n(l.convertis),
        sous_7_jours: n(l.sous_7_jours),
        taux: pourcentage(n(l.convertis), n(l.inscrits)),
        taux_7_jours: pourcentage(n(l.sous_7_jours), n(l.inscrits)),
        delai_moyen: arrondiOuNul(l.delai_moyen) ?? 0,
        delai_median: arrondiOuNul(l.delai_median) ?? 0,
      })),
    };
  }

  private async cohortesInactifs(q: CohortesQueryDto) {
    const maintenant = new Date();
    const lignes = await this.prisma.$queryRaw<
      {
        mois: string;
        entres: number;
        reconquis: number;
        reconquis_30j: number;
        reconquis_60j: number;
        reconquis_90j: number;
        delai_median_j: number | null;
        encore_ouverts: number;
        deja_reconquis_avant: number;
      }[]
    >`
      WITH pass AS (
        SELECT y.contact_id, y.cycle, y.segment_since, y.closed_at
        FROM "CrmCycle" y JOIN "CrmContact" x ON x.id = y.contact_id
        WHERE x.entity_status <> 'DELETED' AND y.segment = 'INACTIF' ${this.bornesCohorte('y.segment_since', q)}
      ), vt AS (
        SELECT v.contact_id, v.cycle, min(v.converted_at) AS converted_at
        FROM "CrmConversion" v JOIN pass p ON p.contact_id = v.contact_id AND p.cycle = v.cycle
        WHERE v.source = 'CRM' AND ${VENTE_VALIDE}
        GROUP BY v.contact_id, v.cycle
      ), e AS (
        SELECT p.*, vt.converted_at,
          (CASE WHEN vt.converted_at IS NOT NULL
                THEN greatest(0, EXTRACT(EPOCH FROM (vt.converted_at - p.segment_since)) / 86400) END)::float AS jours
        FROM pass p LEFT JOIN vt ON vt.contact_id = p.contact_id AND vt.cycle = p.cycle
      )
      SELECT to_char(date_trunc('month', e.segment_since), 'YYYY-MM') AS mois,
        count(*)::int AS entres,
        count(e.converted_at)::int AS reconquis,
        count(*) FILTER (WHERE e.jours <= 30)::int AS reconquis_30j,
        count(*) FILTER (WHERE e.jours <= 60)::int AS reconquis_60j,
        count(*) FILTER (WHERE e.jours <= 90)::int AS reconquis_90j,
        (percentile_cont(0.5) WITHIN GROUP (ORDER BY e.jours) FILTER (WHERE e.converted_at IS NOT NULL))::float AS delai_median_j,
        count(*) FILTER (WHERE e.converted_at IS NULL AND e.closed_at IS NULL)::int AS encore_ouverts,
        count(*) FILTER (WHERE e.cycle >= 2)::int AS deja_reconquis_avant
      FROM e GROUP BY 1 ORDER BY 1`;
    return {
      type: 'INACTIFS' as const,
      segment: CrmSegment.INACTIF,
      lignes: lignes.map((l) => ({
        mois: l.mois,
        entres: n(l.entres),
        reconquis: n(l.reconquis),
        reconquis_30j: n(l.reconquis_30j),
        reconquis_60j: n(l.reconquis_60j),
        reconquis_90j: n(l.reconquis_90j),
        complet_30j: fenetreComplete(l.mois, 30, maintenant),
        complet_60j: fenetreComplete(l.mois, 60, maintenant),
        complet_90j: fenetreComplete(l.mois, 90, maintenant),
        taux: pourcentage(n(l.reconquis), n(l.entres)),
        delai_median_j: arrondiOuNul(l.delai_median_j),
        encore_ouverts: n(l.encore_ouverts),
        deja_reconquis_avant: n(l.deja_reconquis_avant),
      })),
    };
  }

  private async cohortesCaptes(q: CohortesQueryDto, segment: CrmSegment) {
    const maintenant = new Date();
    const lignes = await this.prisma.$queryRaw<
      {
        mois: string;
        captes: number;
        deja_clients: number;
        sans_compte: number;
        deja_inscrits_a_la_capture: number;
        inscrits_apres_capture: number;
        commandes_directes: number;
        commandes_directes_30j: number;
        commandes_directes_60j: number;
        commandes_directes_90j: number;
        commandes_deja_clients: number;
        historiques: number;
        delai_median_inscription_j: number | null;
        delai_median_commande_j: number | null;
      }[]
    >`
      WITH pass AS (
        SELECT y.contact_id, y.cycle, y.segment_since, y.already_customer IS TRUE AS deja_client,
               x.customer_id, x.registered_at
        FROM "CrmCycle" y JOIN "CrmContact" x ON x.id = y.contact_id
        WHERE x.entity_status <> 'DELETED' AND y.segment = ${segment}::"CrmSegment" ${this.bornesCohorte('y.segment_since', q)}
      ), vt AS (
        SELECT v.contact_id, v.cycle, min(v.converted_at) AS converted_at
        FROM "CrmConversion" v JOIN pass p ON p.contact_id = v.contact_id AND p.cycle = v.cycle
        WHERE v.source = 'CRM' AND ${VENTE_VALIDE}
        GROUP BY v.contact_id, v.cycle
      ), hist AS (
        -- Convertis par l'ancienne acquisition : comptés à part, hors taux (décision 7).
        SELECT DISTINCT v.contact_id, v.cycle
        FROM "CrmConversion" v JOIN pass p ON p.contact_id = v.contact_id AND p.cycle = v.cycle
        WHERE v.source = 'ACQUISITION_HISTORIQUE' AND ${VENTE_VALIDE}
      ), e AS (
        SELECT p.*, vt.converted_at, hist.contact_id IS NOT NULL AS historique,
          (CASE WHEN vt.converted_at IS NOT NULL
                THEN greatest(0, EXTRACT(EPOCH FROM (vt.converted_at - p.segment_since)) / 86400) END)::float AS jours,
          (CASE WHEN p.registered_at IS NOT NULL
                THEN greatest(0, EXTRACT(EPOCH FROM (p.registered_at - p.segment_since)) / 86400) END)::float AS jours_inscription
        FROM pass p LEFT JOIN vt ON vt.contact_id = p.contact_id AND vt.cycle = p.cycle
        LEFT JOIN hist ON hist.contact_id = p.contact_id AND hist.cycle = p.cycle
      )
      SELECT to_char(date_trunc('month', e.segment_since), 'YYYY-MM') AS mois,
        count(*)::int AS captes,
        count(*) FILTER (WHERE e.deja_client)::int AS deja_clients,
        count(*) FILTER (WHERE e.customer_id IS NULL)::int AS sans_compte,
        count(*) FILTER (WHERE e.registered_at < e.segment_since)::int AS deja_inscrits_a_la_capture,
        count(*) FILTER (WHERE e.registered_at >= e.segment_since)::int AS inscrits_apres_capture,
        count(e.converted_at) FILTER (WHERE NOT e.deja_client AND NOT e.historique)::int AS commandes_directes,
        count(*) FILTER (WHERE NOT e.deja_client AND NOT e.historique AND e.jours <= 30)::int AS commandes_directes_30j,
        count(*) FILTER (WHERE NOT e.deja_client AND NOT e.historique AND e.jours <= 60)::int AS commandes_directes_60j,
        count(*) FILTER (WHERE NOT e.deja_client AND NOT e.historique AND e.jours <= 90)::int AS commandes_directes_90j,
        count(e.converted_at) FILTER (WHERE e.deja_client)::int AS commandes_deja_clients,
        count(*) FILTER (WHERE e.historique AND NOT e.deja_client)::int AS historiques,
        (percentile_cont(0.5) WITHIN GROUP (ORDER BY e.jours_inscription)
          FILTER (WHERE e.registered_at >= e.segment_since))::float AS delai_median_inscription_j,
        (percentile_cont(0.5) WITHIN GROUP (ORDER BY e.jours)
          FILTER (WHERE e.converted_at IS NOT NULL AND NOT e.deja_client))::float AS delai_median_commande_j
      FROM e GROUP BY 1 ORDER BY 1`;
    return {
      type: 'CAPTES' as const,
      segment,
      lignes: lignes.map((l) => ({
        mois: l.mois,
        captes: n(l.captes),
        deja_clients: n(l.deja_clients),
        sans_compte: n(l.sans_compte),
        deja_inscrits_a_la_capture: n(l.deja_inscrits_a_la_capture),
        inscrits_apres_capture: n(l.inscrits_apres_capture),
        commandes_directes: n(l.commandes_directes),
        commandes_directes_30j: n(l.commandes_directes_30j),
        commandes_directes_60j: n(l.commandes_directes_60j),
        commandes_directes_90j: n(l.commandes_directes_90j),
        complet_30j: fenetreComplete(l.mois, 30, maintenant),
        complet_60j: fenetreComplete(l.mois, 60, maintenant),
        complet_90j: fenetreComplete(l.mois, 90, maintenant),
        commandes_deja_clients: n(l.commandes_deja_clients),
        // Convertis par l'ancienne acquisition : ni au numérateur ni au dénominateur.
        historiques: n(l.historiques),
        taux: pourcentage(n(l.commandes_directes), n(l.captes) - n(l.deja_clients) - n(l.historiques)),
        delai_median_inscription_j: arrondiOuNul(l.delai_median_inscription_j),
        delai_median_commande_j: arrondiOuNul(l.delai_median_commande_j),
      })),
    };
  }
}

