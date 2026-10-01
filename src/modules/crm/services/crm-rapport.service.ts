import { Injectable } from '@nestjs/common';
import { CrmSegment, Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import {
  COMMANDE_VALIDE_SQL,
  Devenir,
  LIBELLES_LIGNE_PUBLIC,
  PUBLICS_CAPTES,
  arrondiOuNul,
  bornesPeriode,
  bornesTendance,
  porteePublics,
  publicsDe,
} from '../crm.rules';
import { AnalyticsQueryDto } from '../dto/analytics.dto';
import { CrmAnalyticsService } from './crm-analytics.service';
import { FichierExport } from './crm-export.service';
import { Perimetre, filtreRestaurant, filtreSegments } from './crm-passages.query';
import { Activite, CleLigne, CrmPublicsService } from './crm-publics.service';
import { dessinerRapport } from './crm-rapport.pdf';
import { IRapport, LEVIER_VIDE, Levier, SegmentCapte, comparer, phrasesARetenir, taux } from './crm-rapport.rules';

const JOUR = 86_400_000;
const COMMANDE_VALIDE = Prisma.raw(COMMANDE_VALIDE_SQL);
/** Au-delà de 45 jours, la courbe des inscriptions se lit par semaine. */
const JOURS_MAX_PAR_JOUR = 45;

const jour = (d: Date) => d.toISOString().slice(0, 10);
const n = (v: unknown) => Number(v ?? 0);

/** Chiffres bruts des inscriptions d'une période (voir `inscriptions`). */
interface BrutInscriptions {
  inscrits: number;
  ont_commande: number;
  sous_7_jours: number;
  delai_median_j: number | null;
  ca: number;
}

const BRUT_INSCRIPTIONS_VIDE: BrutInscriptions = { inscrits: 0, ont_commande: 0, sous_7_jours: 0, delai_median_j: null, ca: 0 };

/**
 * RAPPORT « OÙ EN SOMMES-NOUS » : une période, comparée à la période
 * précédente de même durée, lue selon les trois leviers de croissance
 * (inscriptions, passage en direct des clients Glovo et Yango, reconquête
 * des inactifs), puis l'effort de l'équipe et le résultat.
 *
 * Il n'invente aucune définition : les entrés viennent de
 * `CrmPublicsService.devenir`, l'activité (appelés, joints, coupons, ventes,
 * chiffre d'affaires) de `CrmPublicsService.activite`, les agents et les
 * raisons de `CrmAnalyticsService`. Seules les inscriptions ont leur requête,
 * parce qu'un inscrit est un compte client, pas un passage au CRM ; elle
 * reprend mot pour mot la définition des cohortes d'inscrits.
 *
 * Ce qu'il ajoute : la COMPARAISON (`comparer`, muette quand la base est
 * trop petite) et les phrases « À retenir », calculées ici pour que l'écran
 * et le PDF disent la même chose.
 */
@Injectable()
export class CrmRapportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: CrmAnalyticsService,
    private readonly publics: CrmPublicsService,
  ) {}

  /**
   * Bornes de la période et de celle qui la précède, de même durée. Sans
   * `from` (« Depuis le début »), la période part du premier passage au CRM,
   * un an au plus (même règle que la tendance) ; la période précédente est
   * alors le plus souvent vide, donc muette.
   */
  private async bornes(q: AnalyticsQueryDto & Perimetre) {
    const publics = publicsDe(q);
    const premier = q.from
      ? null
      : await this.prisma.$queryRaw<{ premier: Date | null }[]>`
          SELECT min(greatest(y.segment_since, y.crm_entered_at)) AS premier
          FROM "CrmCycle" y JOIN "CrmContact" x ON x.id = y.contact_id
          WHERE x.entity_status <> 'DELETED' ${filtreSegments('y.segment', publics)} ${filtreRestaurant('x.id', q)}`;
    const { debut, fin } = bornesTendance({ from: q.from, to: q.to, premierPassage: premier?.[0]?.premier ?? null });
    const jours = Math.max(1, Math.round((fin.getTime() - debut.getTime()) / JOUR) + 1);
    const finPrecedente = new Date(debut.getTime() - JOUR);
    const debutPrecedent = new Date(finPrecedente.getTime() - (jours - 1) * JOUR);
    return { debut, fin, debutPrecedent, finPrecedente, jours };
  }

  async rapport(q: AnalyticsQueryDto & Perimetre): Promise<IRapport> {
    const { debut, fin, debutPrecedent, finPrecedente, jours } = await this.bornes(q);
    const periode = { ...q, from: jour(debut), to: jour(fin) };
    const precedente = { ...q, from: jour(debutPrecedent), to: jour(finPrecedente) };
    const demandes = publicsDe(q);
    const portee = porteePublics(demandes);
    const dansFiltre = (p: CrmSegment) => portee.includes(p);

    // Les inscrits ne sont ni des passages au CRM ni des membres d'une
    // campagne : hors du filtre quand on regarde une campagne ou quand le
    // public des inscrits est exclu. Tout le réseau pour un point de vente.
    const inscriptionsHorsFiltre = !dansFiltre(CrmSegment.JAMAIS_COMMANDE) || !!q.campaign_id;
    const fenetre = await this.publics.fenetre();

    const [devenir, devenirPrec, activite, activitePrec, agents, raisons, inscrits, inscritsPrec, serie, campagne, restaurant] =
      await Promise.all([
        this.publics.devenir(periode, fenetre),
        this.publics.devenir(precedente, fenetre),
        this.publics.activite(periode),
        this.publics.activite(precedente),
        this.analytics.agents(periode),
        this.analytics.raisons(periode),
        inscriptionsHorsFiltre ? BRUT_INSCRIPTIONS_VIDE : this.inscriptions(periode),
        inscriptionsHorsFiltre ? BRUT_INSCRIPTIONS_VIDE : this.inscriptions(precedente),
        inscriptionsHorsFiltre ? [] : this.serieInscriptions(debut, fin),
        q.campaign_id
          ? this.prisma.crmCampaign.findUnique({ where: { id: q.campaign_id }, select: { id: true, name: true } })
          : null,
        q.perimetre_restaurant
          ? this.prisma.restaurant.findUnique({ where: { id: q.perimetre_restaurant }, select: { id: true, name: true } })
          : null,
      ]);

    const levier = (cle: CleLigne): Levier =>
      construireLevier(devenir[cle], devenirPrec[cle], activite[cle], activitePrec[cle]);

    const captesDansFiltre = PUBLICS_CAPTES.some(dansFiltre);
    const inactifsDansFiltre = dansFiltre(CrmSegment.INACTIF);
    const total = activite.TOTAL;
    const totalPrec = activitePrec.TOTAL;

    const corps: Omit<IRapport, 'a_retenir'> = {
      periode: { debut: jour(debut), fin: jour(fin), jours },
      precedente: { debut: jour(debutPrecedent), fin: jour(finPrecedente) },
      edite_le: jour(new Date()),
      filtres: {
        publics: demandes,
        campagne: campagne ? { id: campagne.id, nom: campagne.name } : null,
        restaurant: restaurant ? { id: restaurant.id, nom: restaurant.name } : null,
      },
      inscriptions: {
        hors_restaurant: !!q.perimetre_restaurant,
        hors_filtre: inscriptionsHorsFiltre,
        inscrits: comparer(inscrits.inscrits, inscritsPrec.inscrits),
        ont_commande: comparer(inscrits.ont_commande, inscritsPrec.ont_commande),
        sous_7_jours: comparer(inscrits.sous_7_jours, inscritsPrec.sous_7_jours),
        taux_commande: taux(inscrits.ont_commande, inscrits.inscrits, inscritsPrec.ont_commande, inscritsPrec.inscrits),
        delai_median_j: inscrits.delai_median_j,
        ca: comparer(inscrits.ca, inscritsPrec.ca, true),
        sans_commande: inscrits.inscrits - inscrits.ont_commande,
        pas: jours > JOURS_MAX_PAR_JOUR ? 'semaine' : 'jour',
        serie: jours > JOURS_MAX_PAR_JOUR ? parSemaine(serie) : serie,
      },
      captes: {
        hors_filtre: !captesDansFiltre,
        total: captesDansFiltre ? levier('CAPTES') : LEVIER_VIDE,
        par_public: PUBLICS_CAPTES.map((p) => ({
          segment: p as SegmentCapte,
          libelle: LIBELLES_LIGNE_PUBLIC[p],
          hors_filtre: !dansFiltre(p),
          ...(dansFiltre(p) ? levier(p) : LEVIER_VIDE),
        })),
      },
      inactifs: {
        hors_filtre: !inactifsDansFiltre,
        ...(inactifsDansFiltre ? levier(CrmSegment.INACTIF) : LEVIER_VIDE),
        delai_median_j: inactifsDansFiltre ? devenir.INACTIF.delai_median_j : null,
      },
      equipe: {
        appels: comparer(total.appels, totalPrec.appels),
        appeles: comparer(total.contacts_appeles, totalPrec.contacts_appeles),
        joints: comparer(total.contacts_joints, totalPrec.contacts_joints),
        coupons: comparer(total.coupons_envoyes, totalPrec.coupons_envoyes),
        taux_contact: taux(total.contacts_joints, total.contacts_appeles, totalPrec.contacts_joints, totalPrec.contacts_appeles),
        agents: agents.map((a) => ({
          id: a.id,
          nom: a.fullname,
          appels: a.appels,
          joints: a.joints,
          coupons: a.coupons,
          ventes: a.ventes,
          ca: a.ca,
        })),
      },
      resultat: {
        ventes: comparer(total.ventes_crm, totalPrec.ventes_crm),
        ca: comparer(total.ca_crm, totalPrec.ca_crm, true),
        panier_moyen: comparer(total.panier_moyen, totalPrec.panier_moyen, true),
        par_public: portee.map((p) => ({
          segment: p,
          libelle: LIBELLES_LIGNE_PUBLIC[p],
          ventes: activite[p].ventes_crm,
          ca: activite[p].ca_crm,
        })),
      },
      raisons: raisons.raisons.slice(0, 6).map((x) => ({ raison: x.raison, nombre: x.nombre, part: x.part })),
    };

    return { ...corps, a_retenir: phrasesARetenir(corps) };
  }

  /** Le même rapport, en PDF, avec les filtres appliqués. */
  async pdf(q: AnalyticsQueryDto & Perimetre): Promise<FichierExport> {
    const r = await this.rapport(q);
    return {
      nom: `rapport-crm-${r.periode.debut}-${r.periode.fin}.pdf`,
      type: 'application/pdf',
      contenu: await dessinerRapport(r),
    };
  }

  /**
   * Inscrits de la période : comptes clients créés sur la période, non
   * supprimés (définition des cohortes d'inscrits) ; parmi eux, ceux qui ont
   * passé une première commande qui compte (jusqu'à aujourd'hui), dans les
   * 7 jours, le délai médian, et le chiffre d'affaires de toutes leurs
   * commandes qui comptent. Jamais limité à un restaurant : un inscrit
   * n'appartient à aucun.
   */
  private async inscriptions(q: Pick<AnalyticsQueryDto, 'from' | 'to'>): Promise<BrutInscriptions> {
    const { debut, fin } = bornesPeriode(q);
    const [l] = await this.prisma.$queryRaw<BrutInscriptions[]>`
      WITH inscrits AS (
        SELECT c.id, c.created_at FROM "Customer" c
        WHERE c.entity_status <> 'DELETED' AND c.created_at >= ${debut} AND c.created_at < ${fin}
      ), premieres AS (
        SELECT o.customer_id, min(o.created_at) AS premiere
        FROM "Order" o JOIN inscrits i ON i.id = o.customer_id
        WHERE ${COMMANDE_VALIDE} GROUP BY o.customer_id
      ), ca AS (
        SELECT coalesce(sum(o.amount), 0)::float AS ca
        FROM "Order" o JOIN inscrits i ON i.id = o.customer_id WHERE ${COMMANDE_VALIDE}
      ), d AS (
        SELECT i.id, p.premiere, greatest(0, EXTRACT(EPOCH FROM (p.premiere - i.created_at)) / 86400)::float AS jours
        FROM inscrits i LEFT JOIN premieres p ON p.customer_id = i.id
      )
      SELECT count(*)::int AS inscrits,
        count(d.premiere)::int AS ont_commande,
        count(d.premiere) FILTER (WHERE d.jours <= 7)::int AS sous_7_jours,
        (percentile_cont(0.5) WITHIN GROUP (ORDER BY d.jours) FILTER (WHERE d.premiere IS NOT NULL))::float AS delai_median_j,
        (SELECT ca FROM ca) AS ca
      FROM d`;
    return {
      inscrits: n(l?.inscrits),
      ont_commande: n(l?.ont_commande),
      sous_7_jours: n(l?.sous_7_jours),
      delai_median_j: arrondiOuNul(l?.delai_median_j),
      ca: Math.round(n(l?.ca)),
    };
  }

  /**
   * Par jour : les inscrits, et les premières commandes (qui comptent) des
   * inscrits de la période, le jour où elles tombent dans la période. C'est
   * la courbe qui fait voir les pics d'un live et ce qu'il laisse derrière.
   */
  private async serieInscriptions(debut: Date, fin: Date): Promise<IRapport['inscriptions']['serie']> {
    const lendemain = new Date(fin.getTime() + JOUR);
    const lignes = await this.prisma.$queryRaw<{ date: string; inscrits: number; premieres_commandes: number }[]>`
      WITH jours AS (SELECT generate_series(${debut}::date, ${fin}::date, interval '1 day')::date AS jour),
      inscrits AS (
        SELECT c.id, c.created_at FROM "Customer" c
        WHERE c.entity_status <> 'DELETED' AND c.created_at >= ${debut} AND c.created_at < ${lendemain}
      ), premieres AS (
        SELECT o.customer_id, min(o.created_at) AS premiere
        FROM "Order" o JOIN inscrits i ON i.id = o.customer_id
        WHERE ${COMMANDE_VALIDE} GROUP BY o.customer_id
      )
      SELECT to_char(j.jour, 'YYYY-MM-DD') AS date,
        (SELECT count(*) FROM inscrits i WHERE i.created_at::date = j.jour)::int AS inscrits,
        (SELECT count(*) FROM premieres p WHERE p.premiere::date = j.jour)::int AS premieres_commandes
      FROM jours j ORDER BY j.jour`;
    return lignes.map((l) => ({ date: l.date, inscrits: n(l.inscrits), premieres_commandes: n(l.premieres_commandes) }));
  }
}

/** Un levier à partir des entrés (devenir) et de l'activité de la période, face au précédent. */
export function construireLevier(d: Devenir, dp: Devenir, a: Activite, ap: Activite): Levier {
  return {
    entres: comparer(d.entrees, dp.entrees),
    appeles: comparer(a.contacts_appeles, ap.contacts_appeles),
    joints: comparer(a.contacts_joints, ap.contacts_joints),
    coupons: comparer(a.coupons_envoyes, ap.coupons_envoyes),
    ventes: comparer(a.ventes_crm, ap.ventes_crm),
    ca: comparer(a.ca_crm, ap.ca_crm, true),
    taux_contact: taux(a.contacts_joints, a.contacts_appeles, ap.contacts_joints, ap.contacts_appeles),
    taux_conversion: taux(a.ventes_crm, d.entrees, ap.ventes_crm, dp.entrees),
  };
}

/** Regroupe une série quotidienne par tranches de 7 jours, datées de leur premier jour. */
export function parSemaine(serie: IRapport['inscriptions']['serie']): IRapport['inscriptions']['serie'] {
  const sortie: IRapport['inscriptions']['serie'] = [];
  serie.forEach((l, i) => {
    if (i % 7 === 0) sortie.push({ date: l.date, inscrits: 0, premieres_commandes: 0 });
    const s = sortie[sortie.length - 1];
    s.inscrits += l.inscrits;
    s.premieres_commandes += l.premieres_commandes;
  });
  return sortie;
}

export type { IRapport };
