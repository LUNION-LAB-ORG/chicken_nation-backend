import { Injectable } from '@nestjs/common';
import { CrmSegment, Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import {
  ORDRE_PUBLICS,
  PUBLICS_CAPTES,
  STATUTS_OUVERTS,
  arrondiOuNul,
  bornesPeriode,
  bornesTendance,
  etapesEntonnoir,
  libelleLigne,
  pareto,
  porteePublics,
  pourcentage,
  publicsDe,
} from '../crm.rules';
import { AnalyticsQueryDto, VerbatimsQueryDto } from '../dto/analytics.dto';
import { CrmAccessService, debutDuJour } from './crm-access.service';
import {
  COUPON_UTILISE,
  DEFINITIFS,
  Perimetre,
  VENTE_VALIDE,
  filtreCampagne,
  filtreMembre,
  filtreRestaurant,
  filtreSegments,
  jointurePassage,
  listePublics,
  plage,
} from './crm-passages.query';
import { CrmPublicsService } from './crm-publics.service';

const OUVERTS = Prisma.join(STATUTS_OUVERTS.map((s) => Prisma.sql`${s}::"CrmStatus"`));
const n = (v: unknown) => Number(v ?? 0);

/** Public du passage d'un appel, d'un coupon ou d'une vente (voir `jointurePassage`). */
const PUBLIC_K = 'coalesce(ya.segment, k.segment)';
const PUBLIC_C = 'coalesce(ya.segment, c.segment)';
/** Public d'une vente ; une vente de l'ancienne acquisition garde son public d'origine (Glovo ou Yango). */
const PUBLIC_V = "CASE WHEN v.source = 'ACQUISITION_HISTORIQUE' THEN v.segment ELSE coalesce(ya.segment, v.segment) END";

const MOTS_VIDES = new Set(
  (
    "a à au aux avec ce ces c ça cela d de des du elle en est et être il ils j je la le les leur lui l m ma mais me mes " +
    "moi mon n ne ni nous on ou où par pas peu plus pour qu que qui s sa se ses si son sur t ta te tes toi ton tu un une " +
    "vos votre vous y a été ai as avait avez aussi bien car comme dans deux dit donc encore fait faut ici là va veut " +
    "client cliente monsieur madame appel appelé rappel rappeler oui non très trop déjà après avant"
  ).split(' '),
);

/** Objet { public: nombre } avec une clé pour chaque public couvert, à 0 par défaut. */
function parPublicVide(portee: CrmSegment[]): Record<string, number> {
  return Object.fromEntries(portee.map((p) => [p, 0]));
}

/**
 * Tableau de bord analytique (cahier §5 et §7, lot 3). Chaque indicateur de
 * période lit l'historique : passages ("CrmCycle"), appels et coupons de
 * chaque passage, registre des ventes (ventes valides seulement). Seuls les
 * stocks « aujourd'hui » lisent l'état actuel des fiches. Voir
 * `crm-passages.query.ts` pour les définitions.
 *
 * Filtres communs : période [from ; to + 1 jour[ en UTC, un ou plusieurs
 * publics (`segments`, ou l'ancien `segment`), une campagne. Pour un compte de
 * point de vente, `perimetre_restaurant` (posé par le contrôleur) limite
 * chaque requête aux fiches de son restaurant (`filtreRestaurant`).
 */
@Injectable()
export class CrmAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CrmAccessService,
    private readonly publics: CrmPublicsService,
  ) {}

  /** Population d'aujourd'hui, entonnoir des entrés de la période, ventes (cahier §7). */
  async vueEnsemble(q: AnalyticsQueryDto & Perimetre) {
    const publics = publicsDe(q);
    const portee = porteePublics(publics);
    const maintenant = new Date();
    const jours = await this.publics.fenetre();
    const [devenir, [population], [ventes], file] = await Promise.all([
      this.publics.devenir(q, jours),
      this.prisma.$queryRaw<
        {
          actifs: number;
          ouverts: number;
          jamais_appeles: number;
          non_assignes: number;
          a_rappeler: number;
          interesses: number;
          coupons: number;
          non_interesses: number;
          injoignables: number;
          abandons: number;
        }[]
      >`
        SELECT count(*) FILTER (WHERE p.status <> 'CONVERTI')::int AS actifs,
          count(*) FILTER (WHERE p.status IN (${OUVERTS}))::int AS ouverts,
          count(*) FILTER (WHERE p.status = 'A_APPELER' AND p.call_count = 0)::int AS jamais_appeles,
          count(*) FILTER (WHERE p.status IN (${OUVERTS}) AND p.assigned_to_id IS NULL
            AND NOT (p.segment IN (${listePublics(PUBLICS_CAPTES)}) AND p.campaign_id IS NULL
                     AND p.segment_since < ${debutDuJour(maintenant)}))::int AS non_assignes,
          count(*) FILTER (WHERE p.status = 'A_RAPPELER')::int AS a_rappeler,
          count(*) FILTER (WHERE p.status = 'INTERESSE')::int AS interesses,
          count(*) FILTER (WHERE p.status = 'COUPON_ENVOYE')::int AS coupons,
          count(*) FILTER (WHERE p.status = 'NON_INTERESSE')::int AS non_interesses,
          count(*) FILTER (WHERE p.status = 'INJOIGNABLE')::int AS injoignables,
          count(*) FILTER (WHERE p.status <> 'CONVERTI' AND p.abandoned_orders > 0)::int AS abandons
        FROM "CrmContact" p
        WHERE p.entity_status <> 'DELETED' ${filtreSegments('p.segment', publics)} ${filtreMembre('p', q)}
          ${filtreRestaurant('p.id', q)}`,
      this.prisma.$queryRaw<{ ventes: number; ca: number; historique: number; ca_historique: number }[]>`
        SELECT count(*) FILTER (WHERE v.source = 'CRM')::int AS ventes,
          coalesce(sum(v.amount) FILTER (WHERE v.source = 'CRM'), 0)::float AS ca,
          count(*) FILTER (WHERE v.source = 'ACQUISITION_HISTORIQUE')::int AS historique,
          coalesce(sum(v.amount) FILTER (WHERE v.source = 'ACQUISITION_HISTORIQUE'), 0)::float AS ca_historique
        FROM "CrmConversion" v ${jointurePassage('v')}
        WHERE ${VENTE_VALIDE} ${plage('v.converted_at', q)} ${filtreCampagne('v.campaign_id', q)}
          ${filtreSegments(PUBLIC_V, publics)} ${filtreRestaurant('v.contact_id', q)}`,
      this.publics.fileCommune(q, maintenant),
    ]);

    const total = devenir.TOTAL;
    const captes = portee.filter((p) => PUBLICS_CAPTES.includes(p));
    const g = devenir.CAPTES;
    return {
      population: {
        actifs: n(population.actifs),
        ouverts: n(population.ouverts),
        jamais_appeles: n(population.jamais_appeles),
        non_assignes: n(population.non_assignes),
        file_commune: [...file.values()].reduce((s, v) => s + v, 0),
        a_rappeler: n(population.a_rappeler),
        interesses: n(population.interesses),
        coupons: n(population.coupons),
        non_interesses: n(population.non_interesses),
        injoignables: n(population.injoignables),
        abandons: n(population.abandons),
      },
      entonnoir: etapesEntonnoir(total, portee),
      hors_entonnoir: { commandes: total.hors_entonnoir, sans_contact: total.sans_contact, repris: total.repris },
      entonnoirs: portee.map((segment) => ({
        segment,
        libelle: libelleLigne(segment),
        etapes: etapesEntonnoir(devenir[segment], [segment]),
        ventes: devenir[segment].ventes,
        hors_entonnoir: devenir[segment].hors_entonnoir,
        sans_contact: devenir[segment].sans_contact,
        repris: devenir[segment].repris,
        taux_conversion: devenir[segment].taux_conversion,
      })),
      passage_appli: captes.length
        ? {
            publics: captes,
            captes: g.captes ?? 0,
            sans_compte: g.sans_compte ?? 0,
            deja_inscrits_a_la_capture: g.deja_inscrits_a_la_capture ?? 0,
            inscrits_apres_capture: g.inscrits_apres_capture ?? 0,
            deja_clients: g.deja_clients ?? 0,
            ventes_deja_clients: g.ventes_deja_clients ?? 0,
            commandes_directes: g.ventes - (g.ventes_deja_clients ?? 0),
            taux_passage_direct: g.taux_conversion,
          }
        : null,
      conversion: {
        taux: total.taux_conversion,
        base_taux: total.base_taux,
        ventes_entres: total.ventes,
        taux_30j: total.taux_30j,
        mesurables_30j: total.mesurables_30j,
        ventes_30j: total.ventes_30j,
        fenetre_jours: jours,
        delai_median_j: total.delai_median_j,
        delai_moyen_j: total.delai_moyen_j,
        /** Ancien nom, gardé une version. */
        delai_moyen_jours: total.delai_moyen_j ?? 0,
        conversions_periode: n(ventes.ventes),
        ca_periode: Math.round(n(ventes.ca)),
        panier_moyen: n(ventes.ventes) > 0 ? Math.round(n(ventes.ca) / n(ventes.ventes)) : 0,
        historique: { ventes: n(ventes.historique), ca: Math.round(n(ventes.ca_historique)) },
      },
    };
  }

  /**
   * Pareto des raisons de non-achat (cahier §7) : pour chaque passage, le
   * DERNIER refus (appel « pas intéressé »), daté du jour de cet appel et rangé
   * sous le public du passage. Un refus reste compté quand le client repart
   * pour un nouveau cycle ; un refus repris sans raison apparaît en « Raison
   * non renseignée ».
   */
  async raisons(q: AnalyticsQueryDto & Perimetre) {
    const publics = publicsDe(q);
    const lignes = await this.prisma.$queryRaw<
      { g_segment: number; id: string | null; raison: string; segment: string | null; nombre: number }[]
    >`
      WITH d AS (
        SELECT DISTINCT ON (k.contact_id, k.cycle) k.loss_reason_id, k.created_at, k.campaign_id, ${Prisma.raw(PUBLIC_K)} AS segment
        FROM "CrmCall" k ${jointurePassage('k')}
        WHERE k.outcome = 'NON_INTERESSE' ${filtreRestaurant('k.contact_id', q)}
        ORDER BY k.contact_id, k.cycle, k.created_at DESC, k.id DESC
      )
      SELECT GROUPING(d.segment)::int AS g_segment, r.id, coalesce(r.name, 'Raison non renseignée') AS raison,
             d.segment::text AS segment, count(*)::int AS nombre
      FROM d LEFT JOIN "ProspectLossReason" r ON r.id = d.loss_reason_id
      WHERE true ${plage('d.created_at', q)} ${filtreCampagne('d.campaign_id', q)} ${filtreSegments('d.segment', publics)}
      GROUP BY GROUPING SETS ((r.id, r.name, d.segment), (r.id, r.name))`;
    const { total, lignes: raisons } = pareto(
      lignes.filter((l) => n(l.g_segment) === 1).map((l) => ({ id: l.id, raison: l.raison, nombre: n(l.nombre) })),
    );
    return {
      total,
      raisons,
      par_public: lignes
        .filter((l) => n(l.g_segment) === 0)
        .map((l) => ({ id: l.id, raison: l.raison, segment: l.segment as CrmSegment, nombre: n(l.nombre) }))
        .sort((a, b) => b.nombre - a.nombre || ORDRE_PUBLICS.indexOf(a.segment) - ORDRE_PUBLICS.indexOf(b.segment)),
    };
  }

  /**
   * Coupons et mesure de la conversion (cahier §5), par date d'envoi. Un coupon
   * « utilisé » l'a été sur une commande qui compte (ni annulée, ni supprimée).
   */
  async coupons(q: AnalyticsQueryDto & Perimetre) {
    const publics = publicsDe(q);
    const base = Prisma.sql`
      FROM "CrmCoupon" c ${jointurePassage('c')} LEFT JOIN "Order" o ON o.id = c.order_id
      WHERE true ${plage('c.sent_at', q)} ${filtreCampagne('c.campaign_id', q)} ${filtreSegments(PUBLIC_C, publics)}
        ${filtreRestaurant('c.contact_id', q)}`;
    const colonnes = Prisma.sql`count(*)::int AS envoyes,
      count(*) FILTER (WHERE ${COUPON_UTILISE})::int AS utilises,
      count(*) FILTER (WHERE c.used_at IS NOT NULL AND NOT (${COUPON_UTILISE}))::int AS sur_commande_annulee,
      count(*) FILTER (WHERE c.used_at IS NULL AND c.expires_at > now())::int AS actifs,
      count(*) FILTER (WHERE c.used_at IS NULL AND c.expires_at <= now())::int AS expires,
      coalesce(sum(c.order_amount) FILTER (WHERE ${COUPON_UTILISE}), 0)::float AS ca,
      coalesce(sum(o.discount) FILTER (WHERE ${COUPON_UTILISE}), 0)::float AS remises`;
    type Ligne = { envoyes: number; utilises: number; sur_commande_annulee: number; actifs: number; expires: number; ca: number; remises: number };
    const [[total], [delai], parOffre, parCanal, parPublic] = await Promise.all([
      this.prisma.$queryRaw<Ligne[]>`SELECT ${colonnes} ${base}`,
      this.prisma.$queryRaw<{ moyen: number | null; median: number | null }[]>`
        SELECT (avg(EXTRACT(EPOCH FROM (c.used_at - c.sent_at)) / 86400) FILTER (WHERE ${COUPON_UTILISE}))::float AS moyen,
          (percentile_cont(0.5) WITHIN GROUP (ORDER BY (EXTRACT(EPOCH FROM (c.used_at - c.sent_at)) / 86400)::float)
            FILTER (WHERE ${COUPON_UTILISE}))::float AS median
        ${base}`,
      this.prisma.$queryRaw<(Ligne & { offre: string })[]>`
        SELECT c.offer_label AS offre, ${colonnes} ${base} GROUP BY c.offer_label ORDER BY envoyes DESC`,
      this.prisma.$queryRaw<{ canal: string; envoyes: number }[]>`
        SELECT c.channel::text AS canal, count(*)::int AS envoyes ${base} GROUP BY c.channel ORDER BY envoyes DESC`,
      this.prisma.$queryRaw<(Ligne & { segment: string })[]>`
        SELECT ${Prisma.raw(PUBLIC_C)}::text AS segment, ${colonnes} ${base} GROUP BY 1`,
    ]);
    const resume = (l: Ligne) => ({
      envoyes: n(l.envoyes),
      utilises: n(l.utilises),
      sur_commande_annulee: n(l.sur_commande_annulee),
      actifs: n(l.actifs),
      expires: n(l.expires),
      taux_utilisation: pourcentage(n(l.utilises), n(l.envoyes)),
      ca: Math.round(n(l.ca)),
      panier_moyen: n(l.utilises) > 0 ? Math.round(n(l.ca) / n(l.utilises)) : 0,
      remises: Math.round(n(l.remises)),
    });
    const parSegment = new Map(parPublic.map((l) => [l.segment, l]));
    const vide: Ligne = { envoyes: 0, utilises: 0, sur_commande_annulee: 0, actifs: 0, expires: 0, ca: 0, remises: 0 };
    return {
      ...resume(total),
      delai_moyen_jours: arrondiOuNul(delai.moyen) ?? 0,
      delai_median_jours: arrondiOuNul(delai.median),
      par_offre: parOffre.map((o) => ({
        offre: o.offre,
        envoyes: n(o.envoyes),
        utilises: n(o.utilises),
        ca: Math.round(n(o.ca)),
        taux: pourcentage(n(o.utilises), n(o.envoyes)),
      })),
      par_canal: parCanal.map((c) => ({ canal: c.canal, envoyes: n(c.envoyes) })),
      par_public: porteePublics(publics).map((segment) => ({
        segment,
        libelle: libelleLigne(segment),
        ...resume(parSegment.get(segment) ?? vide),
      })),
    };
  }

  /**
   * Qualité du traitement (cahier §7), mesurée par passage (contact_id, cycle)
   * et sans les appels repris des anciens écrans :
   *  - résolution au premier appel : passages dont le premier appel (dans la
   *    période) a tranché ;
   *  - effort : pour les passages qualifiés dans la période, tentatives et
   *    temps écoulé depuis le premier appel du passage ;
   *  - délai du premier appel et traités à J+1 / J+2 : passages ENTRÉS sur la période ;
   *  - seconde commande : ventes de la période (voir `CrmPublicsService.secondeCommande`).
   */
  async qualite(q: AnalyticsQueryDto & Perimetre) {
    const publics = publicsDe(q);
    const { fin } = bornesPeriode(q);
    // Le premier appel d'un passage précède tous les autres : inutile de lire au-delà de la période.
    const avantFin = fin ? Prisma.sql`AND k.created_at < ${fin}` : Prisma.empty;
    const [[premier], [effort], [appels], devenir, seconde] = await Promise.all([
      this.prisma.$queryRaw<{ traites: number; resolus: number }[]>`
        WITH f AS (
          SELECT DISTINCT ON (k.contact_id, k.cycle) k.outcome, k.created_at, k.campaign_id, ${Prisma.raw(PUBLIC_K)} AS segment
          FROM "CrmCall" k ${jointurePassage('k')}
          WHERE NOT k.imported AND k.cycle >= 1 ${avantFin} ${filtreRestaurant('k.contact_id', q)}
          ORDER BY k.contact_id, k.cycle, k.created_at, k.id
        )
        SELECT count(*)::int AS traites, count(*) FILTER (WHERE f.outcome IN ${DEFINITIFS})::int AS resolus
        FROM f WHERE true ${plage('f.created_at', q)} ${filtreCampagne('f.campaign_id', q)} ${filtreSegments('f.segment', publics)}`,
      this.prisma.$queryRaw<{ qualifies: number; tentatives: number | null; heures: number | null; heures_medianes: number | null }[]>`
        WITH a AS (
          SELECT k.contact_id, k.cycle, k.outcome, k.created_at, k.id, k.campaign_id, ${Prisma.raw(PUBLIC_K)} AS segment,
                 row_number() OVER (PARTITION BY k.contact_id, k.cycle ORDER BY k.created_at, k.id) AS rang,
                 min(k.created_at) OVER (PARTITION BY k.contact_id, k.cycle) AS premier
          FROM "CrmCall" k ${jointurePassage('k')}
          WHERE NOT k.imported AND k.cycle >= 1 ${avantFin} ${filtreRestaurant('k.contact_id', q)}
        ), d AS (
          SELECT DISTINCT ON (a.contact_id, a.cycle) a.*, (EXTRACT(EPOCH FROM (a.created_at - a.premier)) / 3600)::float AS heures
          FROM a WHERE a.outcome IN ${DEFINITIFS}
          ORDER BY a.contact_id, a.cycle, a.created_at, a.id
        )
        SELECT count(*)::int AS qualifies, avg(d.rang)::float AS tentatives, avg(d.heures)::float AS heures,
          (percentile_cont(0.5) WITHIN GROUP (ORDER BY d.heures))::float AS heures_medianes
        FROM d WHERE true ${plage('d.created_at', q)} ${filtreCampagne('d.campaign_id', q)} ${filtreSegments('d.segment', publics)}`,
      this.prisma.$queryRaw<{ appels: number; contacts: number }[]>`
        SELECT count(*)::int AS appels, count(DISTINCT (k.contact_id, k.cycle))::int AS contacts
        FROM "CrmCall" k ${jointurePassage('k')}
        WHERE NOT k.imported ${plage('k.created_at', q)} ${filtreCampagne('k.campaign_id', q)} ${filtreSegments(PUBLIC_K, publics)}
          ${filtreRestaurant('k.contact_id', q)}`,
      this.publics.devenir(q),
      this.publics.secondeCommande(q),
    ]);
    const d = devenir.TOTAL;
    return {
      resolution_premier_appel: {
        traites: n(premier.traites),
        resolus: n(premier.resolus),
        taux: pourcentage(n(premier.resolus), n(premier.traites)),
      },
      traitement: {
        qualifies: n(effort.qualifies),
        tentatives_moyennes: arrondiOuNul(effort.tentatives) ?? 0,
        heures_moyennes: arrondiOuNul(effort.heures) ?? 0,
        heures_medianes: arrondiOuNul(effort.heures_medianes),
        appels_par_contact: n(appels.contacts) > 0 ? (arrondiOuNul(n(appels.appels) / n(appels.contacts)) ?? 0) : 0,
      },
      premier_appel: {
        entrees: d.entrees,
        premier_appel_median_h: d.premier_appel_median_h,
        mesurables_j1: d.mesurables_j1,
        traites_j1: d.traites_j1,
        part_j1: d.part_j1,
        mesurables_j2: d.mesurables_j2,
        traites_j2: d.traites_j2,
        part_j2: d.part_j2,
      },
      seconde_commande: seconde.TOTAL,
    };
  }

  /**
   * Performance des agents sur la période. Une vente est « travaillée » quand
   * l'agent à qui elle est créditée a appelé le client ou lui a envoyé un
   * coupon dans ce passage avant la commande ; sinon elle est « spontanée »
   * (le client a commandé seul pendant qu'il était dans son portefeuille).
   */
  async agents(q: AnalyticsQueryDto & Perimetre) {
    const publics = publicsDe(q);
    const portee = porteePublics(publics);
    const roles = this.access.rolesAgents();
    const [users, appels, coupons, ventes, portefeuille] = await Promise.all([
      this.prisma.$queryRaw<{ id: string; fullname: string }[]>`
        SELECT u.id, u.fullname FROM "User" u
        WHERE u.entity_status = 'ACTIVE' AND u.role::text IN (${Prisma.join(roles)})`,
      this.prisma.$queryRaw<{ agent_id: string; appels: number; traites: number; joints: number }[]>`
        SELECT k.agent_id, count(*)::int AS appels, count(DISTINCT k.contact_id)::int AS traites,
          count(DISTINCT k.contact_id) FILTER (WHERE k.reached)::int AS joints
        FROM "CrmCall" k ${jointurePassage('k')}
        WHERE k.agent_id IS NOT NULL ${plage('k.created_at', q)} ${filtreCampagne('k.campaign_id', q)} ${filtreSegments(PUBLIC_K, publics)}
          ${filtreRestaurant('k.contact_id', q)}
        GROUP BY k.agent_id`,
      this.prisma.$queryRaw<{ agent_id: string; coupons: number }[]>`
        SELECT c.sent_by_id AS agent_id, count(*)::int AS coupons
        FROM "CrmCoupon" c ${jointurePassage('c')}
        WHERE c.sent_by_id IS NOT NULL ${plage('c.sent_at', q)} ${filtreCampagne('c.campaign_id', q)} ${filtreSegments(PUBLIC_C, publics)}
          ${filtreRestaurant('c.contact_id', q)}
        GROUP BY c.sent_by_id`,
      this.prisma.$queryRaw<
        { agent_id: string; segment: string; ventes: number; travaillees: number; ca: number; ca_travaille: number }[]
      >`
        WITH s AS (
          SELECT v.agent_id, ${Prisma.raw(PUBLIC_V)}::text AS segment, v.amount,
            (EXISTS (SELECT 1 FROM "CrmCall" k2 WHERE k2.contact_id = v.contact_id AND k2.cycle = v.cycle
                       AND k2.agent_id = v.agent_id AND k2.created_at <= v.converted_at)
             OR EXISTS (SELECT 1 FROM "CrmCoupon" c2 WHERE c2.contact_id = v.contact_id AND c2.cycle = v.cycle
                       AND c2.sent_by_id = v.agent_id AND c2.sent_at <= v.converted_at)) AS travaillee
          FROM "CrmConversion" v ${jointurePassage('v')}
          WHERE v.agent_id IS NOT NULL AND v.source = 'CRM' AND ${VENTE_VALIDE}
            ${plage('v.converted_at', q)} ${filtreCampagne('v.campaign_id', q)} ${filtreSegments(PUBLIC_V, publics)}
            ${filtreRestaurant('v.contact_id', q)}
        )
        SELECT s.agent_id, s.segment, count(*)::int AS ventes, count(*) FILTER (WHERE s.travaillee)::int AS travaillees,
          coalesce(sum(s.amount), 0)::float AS ca, coalesce(sum(s.amount) FILTER (WHERE s.travaillee), 0)::float AS ca_travaille
        FROM s GROUP BY s.agent_id, s.segment`,
      this.prisma.$queryRaw<{ agent_id: string; portefeuille: number }[]>`
        SELECT p.assigned_to_id AS agent_id, count(*)::int AS portefeuille
        FROM "CrmContact" p
        WHERE p.assigned_to_id IS NOT NULL AND p.entity_status <> 'DELETED' AND p.status IN (${OUVERTS})
          ${filtreSegments('p.segment', publics)} ${filtreCampagne('p.campaign_id', q)} ${filtreRestaurant('p.id', q)}
        GROUP BY p.assigned_to_id`,
    ]);

    const parAgent = <T extends { agent_id: string }>(lignes: T[]) => new Map(lignes.map((l) => [l.agent_id, l]));
    const a = parAgent(appels);
    const c = parAgent(coupons);
    const p = parAgent(portefeuille);
    return users
      .map((u) => {
        const siennes = ventes.filter((v) => v.agent_id === u.id);
        const somme = (cle: 'ventes' | 'travaillees' | 'ca' | 'ca_travaille') => siennes.reduce((s, v) => s + n(v[cle]), 0);
        const traites = n(a.get(u.id)?.traites);
        const joints = n(a.get(u.id)?.joints);
        const travaillees = somme('travaillees');
        const parPublic = parPublicVide(portee);
        const spontaneesParPublic = parPublicVide(portee);
        for (const v of siennes) {
          parPublic[v.segment] = (parPublic[v.segment] ?? 0) + n(v.ventes);
          spontaneesParPublic[v.segment] = (spontaneesParPublic[v.segment] ?? 0) + n(v.ventes) - n(v.travaillees);
        }
        return {
          id: u.id,
          fullname: u.fullname,
          appels: n(a.get(u.id)?.appels),
          traites,
          joints,
          coupons: n(c.get(u.id)?.coupons),
          ventes: somme('ventes'),
          ventes_travaillees: travaillees,
          ventes_spontanees: somme('ventes') - travaillees,
          ca: Math.round(somme('ca')),
          ca_travaille: Math.round(somme('ca_travaille')),
          portefeuille: n(p.get(u.id)?.portefeuille),
          taux_contact: pourcentage(joints, traites),
          taux_conversion: pourcentage(travaillees, traites),
          par_public: parPublic,
          spontanees_par_public: spontaneesParPublic,
        };
      })
      .filter((l) => l.appels + l.coupons + l.ventes + l.portefeuille > 0)
      .sort((x, y) => y.ventes_travaillees - x.ventes_travaillees || y.ventes - x.ventes || y.traites - x.traites);
  }

  /**
   * Série quotidienne : entrées (passages par jour d'entrée au CRM, cycles
   * passés compris), captures Glovo/Yango, appels, joints, coupons, ventes du
   * CRM (registre, ventes valides). Sans `from`, la série part du premier
   * passage (un an au plus). Pour un compte de point de vente, les captures
   * sont celles faites dans son restaurant.
   */
  async tendance(q: AnalyticsQueryDto & Perimetre) {
    const publics = publicsDe(q);
    const portee = porteePublics(publics);
    const membreDuPassage = q.campaign_id
      ? Prisma.sql`AND EXISTS (SELECT 1 FROM "CrmCampaignMember" m
          WHERE m.contact_id = y.contact_id AND m.cycle = y.cycle AND m.campaign_id = ${q.campaign_id}::uuid)`
      : Prisma.empty;
    const [premier] = q.from
      ? [{ premier: null }]
      : await this.prisma.$queryRaw<{ premier: Date | null }[]>`
          SELECT min(greatest(y.segment_since, y.crm_entered_at)) AS premier
          FROM "CrmCycle" y JOIN "CrmContact" x ON x.id = y.contact_id
          WHERE x.entity_status <> 'DELETED' ${filtreSegments('y.segment', publics)} ${membreDuPassage}
            ${filtreRestaurant('x.id', q)}`;
    const { debut, fin } = bornesTendance({ from: q.from, to: q.to, premierPassage: premier?.premier ?? null });
    const lendemain = new Date(fin.getTime() + 86_400_000);
    const plateformes = portee.filter((s) => PUBLICS_CAPTES.includes(s));
    const captures = plateformes.length
      ? Prisma.sql`SELECT cap.created_at::date AS j, count(*) AS n FROM "Prospect" cap
          WHERE cap.entity_status <> 'DELETED' AND cap.platform::text IN (${Prisma.join(plateformes.map((s) => String(s)))})
            AND cap.created_at >= ${debut} AND cap.created_at < ${lendemain}
            ${q.perimetre_restaurant ? Prisma.sql`AND cap.restaurant_id = ${q.perimetre_restaurant}::uuid` : Prisma.empty}
            ${q.campaign_id ? Prisma.sql`AND EXISTS (SELECT 1 FROM "CrmCampaignMember" m WHERE m.contact_id = cap.contact_id AND m.campaign_id = ${q.campaign_id}::uuid)` : Prisma.empty}
          GROUP BY 1`
      : Prisma.sql`SELECT NULL::date AS j, 0 AS n WHERE false`;

    const lignes = await this.prisma.$queryRaw<
      {
        jour: string;
        appels: number;
        joints: number;
        coupons: number;
        conversions: number;
        entrees: number;
        captures: number;
        entrees_par_public: Record<string, number>;
        ventes_par_public: Record<string, number>;
      }[]
    >`
      WITH jours AS (SELECT generate_series(${debut}::date, ${fin}::date, interval '1 day')::date AS jour),
      a AS (SELECT k.created_at::date AS j, count(*) AS n, count(*) FILTER (WHERE k.reached) AS r
            FROM "CrmCall" k ${jointurePassage('k')}
            WHERE k.created_at >= ${debut} AND k.created_at < ${lendemain}
              ${filtreCampagne('k.campaign_id', q)} ${filtreSegments(PUBLIC_K, publics)} ${filtreRestaurant('k.contact_id', q)}
            GROUP BY 1),
      c AS (SELECT c.sent_at::date AS j, count(*) AS n
            FROM "CrmCoupon" c ${jointurePassage('c')}
            WHERE c.sent_at >= ${debut} AND c.sent_at < ${lendemain}
              ${filtreCampagne('c.campaign_id', q)} ${filtreSegments(PUBLIC_C, publics)} ${filtreRestaurant('c.contact_id', q)}
            GROUP BY 1),
      v AS (SELECT v.converted_at::date AS j, ${Prisma.raw(PUBLIC_V)}::text AS s, count(*) AS n
            FROM "CrmConversion" v ${jointurePassage('v')}
            WHERE v.source = 'CRM' AND ${VENTE_VALIDE} AND v.converted_at >= ${debut} AND v.converted_at < ${lendemain}
              ${filtreCampagne('v.campaign_id', q)} ${filtreSegments(PUBLIC_V, publics)} ${filtreRestaurant('v.contact_id', q)}
            GROUP BY 1, 2),
      e AS (SELECT greatest(y.segment_since, y.crm_entered_at)::date AS j, y.segment::text AS s, count(*) AS n
            FROM "CrmCycle" y JOIN "CrmContact" x ON x.id = y.contact_id AND x.entity_status <> 'DELETED'
            WHERE greatest(y.segment_since, y.crm_entered_at) >= ${debut} AND greatest(y.segment_since, y.crm_entered_at) < ${lendemain}
              ${filtreSegments('y.segment', publics)} ${membreDuPassage} ${filtreRestaurant('y.contact_id', q)}
            GROUP BY 1, 2),
      cap AS (${captures})
      SELECT to_char(jours.jour, 'YYYY-MM-DD') AS jour,
        coalesce(a.n, 0)::int AS appels, coalesce(a.r, 0)::int AS joints, coalesce(c.n, 0)::int AS coupons,
        coalesce((SELECT sum(v.n) FROM v WHERE v.j = jours.jour), 0)::int AS conversions,
        coalesce((SELECT jsonb_object_agg(v.s, v.n) FROM v WHERE v.j = jours.jour), '{}'::jsonb) AS ventes_par_public,
        coalesce((SELECT sum(e.n) FROM e WHERE e.j = jours.jour), 0)::int AS entrees,
        coalesce((SELECT jsonb_object_agg(e.s, e.n) FROM e WHERE e.j = jours.jour), '{}'::jsonb) AS entrees_par_public,
        coalesce(cap.n, 0)::int AS captures
      FROM jours
      LEFT JOIN a ON a.j = jours.jour LEFT JOIN c ON c.j = jours.jour LEFT JOIN cap ON cap.j = jours.jour
      ORDER BY jours.jour`;

    const completer = (o: Record<string, number> | null) => {
      const sortie = parPublicVide(portee);
      for (const [cle, valeur] of Object.entries(o ?? {})) sortie[cle] = n(valeur);
      return sortie;
    };
    return {
      debut: debut.toISOString().slice(0, 10),
      fin: fin.toISOString().slice(0, 10),
      depuis_ouverture: !q.from,
      serie: lignes.map((l) => ({
        jour: l.jour,
        entrees: n(l.entrees),
        captures: n(l.captures),
        appels: n(l.appels),
        joints: n(l.joints),
        coupons: n(l.coupons),
        conversions: n(l.conversions),
        entrees_par_public: completer(l.entrees_par_public),
        ventes_par_public: completer(l.ventes_par_public),
      })),
    };
  }

  /**
   * Verbatims (cahier §7) : les commentaires des agents, filtrables, avec les
   * mots qui reviennent le plus, en complément des raisons codifiées. Un
   * client Glovo/Yango sans compte apparaît sous le nom relevé à la capture.
   */
  async verbatims(q: VerbatimsQueryDto & Perimetre) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const recherche = q.search?.trim();
    const publics = publicsDe(q);
    const depuis = Prisma.sql`FROM "CrmCall" k ${jointurePassage('k')}`;
    const where = Prisma.sql`
      k.comment IS NOT NULL AND k.comment <> ''
      ${plage('k.created_at', q)} ${filtreCampagne('k.campaign_id', q)} ${filtreSegments(PUBLIC_K, publics)}
      ${q.loss_reason_id ? Prisma.sql`AND k.loss_reason_id = ${q.loss_reason_id}::uuid` : Prisma.empty}
      ${q.agent_id ? Prisma.sql`AND k.agent_id = ${q.agent_id}::uuid` : Prisma.empty}
      ${recherche ? Prisma.sql`AND k.comment ILIKE ${`%${recherche}%`}` : Prisma.empty}
      ${filtreRestaurant('k.contact_id', q)}`;
    const [lignes, [total], corpus] = await Promise.all([
      this.prisma.$queryRaw<
        {
          id: string;
          created_at: Date;
          comment: string;
          status_label: string;
          outcome: string;
          segment: string;
          raison: string | null;
          agent: string | null;
          contact: string;
          contact_id: string;
        }[]
      >`
        SELECT k.id, k.created_at, k.comment, k.status_label, k.outcome::text AS outcome, ${Prisma.raw(PUBLIC_K)}::text AS segment,
          r.name AS raison, u.fullname AS agent,
          coalesce(nullif(trim(concat_ws(' ', cu.first_name, cu.last_name)), ''), p.name, 'Client sans nom') AS contact, k.contact_id
        ${depuis}
        JOIN "CrmContact" p ON p.id = k.contact_id
        LEFT JOIN "Customer" cu ON cu.id = p.customer_id
        LEFT JOIN "ProspectLossReason" r ON r.id = k.loss_reason_id
        LEFT JOIN "User" u ON u.id = k.agent_id
        WHERE ${where}
        ORDER BY k.created_at DESC
        LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      this.prisma.$queryRaw<{ total: number }[]>`SELECT count(*)::int AS total ${depuis} WHERE ${where}`,
      this.prisma.$queryRaw<{ comment: string }[]>`
        SELECT k.comment ${depuis} WHERE ${where} ORDER BY k.created_at DESC LIMIT 3000`,
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

    const nombre = n(total.total);
    return { data: lignes, meta: { total: nombre, page, limit, totalPages: Math.ceil(nombre / limit) }, mots };
  }
}
