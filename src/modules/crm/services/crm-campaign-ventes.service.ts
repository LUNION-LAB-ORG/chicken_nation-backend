import { Injectable, NotFoundException } from '@nestjs/common';
import { CrmSegment, Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import {
  ETAT_COMMANDE_SQL,
  LigneVenteBrute,
  MEMBRE_DE_LA_VENTE_SQL,
  VENTE_DE_CAMPAGNE_SQL,
  VenteCampagne,
  versVenteCampagne,
} from '../crm-campagne.rules';
import { ORDRE_PUBLICS } from '../crm.rules';
import { CampaignVentesQueryDto } from '../dto/campaign.dto';

/** Ventes par page, par défaut et au plus. */
export const VENTES_PAR_PAGE = 20;
export const VENTES_PAR_PAGE_MAX = 100;
/** Autres commandes détaillées par vente : à l'écran, puis dans le rapport. */
export const AUTRES_A_L_ECRAN = 20;
export const AUTRES_DANS_LE_RAPPORT = 100;

const VENTE = Prisma.raw(VENTE_DE_CAMPAGNE_SQL);
const MEMBRE = Prisma.raw(MEMBRE_DE_LA_VENTE_SQL);
const ETAT = Prisma.raw(ETAT_COMMANDE_SQL('oa'));

export interface ResumeVentes {
  ventes: number;
  ca: number;
  /** Tous les publics de la campagne, quel que soit le filtre. */
  par_public: { segment: CrmSegment; ventes: number; ca: number }[];
}

export interface VentesCampagne {
  resume: ResumeVentes;
  /** Fenêtre des autres commandes : du lancement à la clôture (fin nulle : campagne en cours). */
  fenetre: { debut: Date | null; fin: Date | null };
  /** Codes de coupon et codes promo masqués (consultation). */
  masque: boolean;
  data: VenteCampagne[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

/**
 * Résumé des ventes d'une campagne, par public et au total (ligne au segment
 * nul) : même FROM, même jointure et même WHERE que le compteur du tableau de
 * bord. Jamais filtré par public, pour que les puces gardent tous les publics.
 */
export function requeteResume(id: string): Prisma.Sql {
  return Prisma.sql`
    SELECT m.segment::text AS segment, count(*)::int AS ventes, coalesce(sum(v.amount), 0)::float AS ca
    FROM "CrmConversion" v
    ${MEMBRE}
    WHERE v.campaign_id = ${id}::uuid AND ${VENTE}
    GROUP BY GROUPING SETS ((m.segment), ())`;
}

/**
 * Une ligne par vente comptée, la plus récente d'abord, avec le client, son
 * agent, la commande, le coupon passé dessus, les délais et les AUTRES
 * commandes du client pendant la campagne (du lancement à la clôture, ou à
 * maintenant tant qu'elle tourne). Les autres commandes excluent celles déjà
 * comptées comme ventes de la campagne : elles ont leur propre ligne.
 *
 * La page est découpée D'ABORD (sous-requête « p », sur le seul registre) :
 * le coupon et les autres commandes ne sont cherchés que pour les lignes
 * affichées, jamais pour toutes les ventes de la campagne à chaque page. Le
 * coupon passé sur la commande (le plus récent s'il y en a deux) vient d'une
 * seule lecture des coupons utilisés : "CrmCoupon".order_id n'a pas d'index,
 * une recherche par vente parcourrait toute la table à chaque ligne.
 *
 * Les colonnes sont en `timestamp` sans fuseau : dans le JSON, une date sort
 * sans « Z » et serait lue en heure locale, d'où le `AT TIME ZONE 'UTC'`.
 * Comptages en `::int` et montants en `::float` : jamais de BigInt.
 */
export function requeteVentes(
  id: string,
  o: { segment?: CrmSegment | null; limit: number | null; offset: number; autres: number },
): Prisma.Sql {
  const filtrePublic = o.segment ? Prisma.sql`AND m.segment = ${o.segment}::"CrmSegment"` : Prisma.empty;
  const page = o.limit != null ? Prisma.sql`LIMIT ${o.limit} OFFSET ${o.offset}` : Prisma.empty;
  return Prisma.sql`
    SELECT v.id, v.converted_at, v.amount::float AS montant, v.cycle, m.segment::text AS segment, m.joined_at,
           x.id AS contact_id, x.name, x.phone, (x.entity_status = 'DELETED') AS fiche_supprimee,
           cu.id AS compte_id, cu.first_name, cu.last_name, cu.phone AS tel_compte,
           ag.id AS agent_id, ag.fullname AS agent,
           o.id AS order_id, o.reference, o.amount::float AS montant_commande, o.status::text AS statut,
           o.type::text AS type, o.created_at AS commande_le, o.code_promo, r.name AS restaurant,
           cp.code AS coupon_code, cp.offer_label AS coupon_offre, cp.sent_at AS coupon_envoye_le,
           (cp.code IS NOT NULL AND cp.campaign_id IS DISTINCT FROM v.campaign_id) AS coupon_hors_campagne,
           greatest(0, extract(epoch FROM v.converted_at - m.joined_at) / 86400)::float AS delai_campagne_j,
           (CASE WHEN y.contact_id IS NOT NULL
                 THEN greatest(0, extract(epoch FROM v.converted_at - greatest(y.segment_since, y.crm_entered_at)) / 86400)
            END)::float AS delai_entree_j,
           coalesce(ac.nombre, 0)::int AS autres_nombre, coalesce(ac.valides, 0)::int AS autres_valides,
           coalesce(ac.montant, 0)::float AS autres_montant, coalesce(ac.commandes, '[]'::json) AS autres
    FROM (
      SELECT v.id
      FROM "CrmConversion" v
      ${MEMBRE}
      WHERE v.campaign_id = ${id}::uuid AND ${VENTE} ${filtrePublic}
      ORDER BY v.converted_at DESC, v.id DESC
      ${page}
    ) p
    JOIN "CrmConversion" v ON v.id = p.id
    ${MEMBRE}
    JOIN "ConversionCampaign" c ON c.id = v.campaign_id
    JOIN "CrmContact" x ON x.id = v.contact_id
    LEFT JOIN "Customer" cu ON cu.id = x.customer_id
    LEFT JOIN "User" ag ON ag.id = v.agent_id
    LEFT JOIN "Order" o ON o.id = v.order_id
    LEFT JOIN "Restaurant" r ON r.id = coalesce(o.restaurant_id, v.restaurant_id)
    LEFT JOIN "CrmCycle" y ON y.contact_id = v.contact_id AND y.cycle = v.cycle
    LEFT JOIN (
      SELECT DISTINCT ON (cc.order_id) cc.order_id, cc.code, cc.offer_label, cc.sent_at, cc.campaign_id
      FROM "CrmCoupon" cc
      WHERE cc.order_id IS NOT NULL
      ORDER BY cc.order_id, cc.used_at DESC NULLS LAST, cc.id
    ) cp ON cp.order_id = v.order_id
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS nombre,
             count(*) FILTER (WHERE e.etat = 'VALIDE')::int AS valides,
             coalesce(sum(oa.amount) FILTER (WHERE e.etat = 'VALIDE'), 0)::float AS montant,
             array_to_json((array_agg(json_build_object(
               'id', oa.id, 'reference', oa.reference, 'cree_le', oa.created_at AT TIME ZONE 'UTC',
               'montant', oa.amount, 'statut', oa.status::text, 'type', oa.type::text,
               'restaurant', ra.name, 'etat', e.etat) ORDER BY oa.created_at DESC, oa.id DESC))[1:${o.autres}::int]) AS commandes
      FROM "Order" oa
      LEFT JOIN "Restaurant" ra ON ra.id = oa.restaurant_id
      CROSS JOIN LATERAL (SELECT ${ETAT} AS etat) e
      WHERE oa.customer_id IN (x.customer_id, o.customer_id)
        AND oa.id IS DISTINCT FROM v.order_id
        AND oa.created_at >= c.started_at
        AND oa.created_at < coalesce(c.completed_at, now() AT TIME ZONE 'UTC')
        AND NOT EXISTS (
          SELECT 1 FROM "CrmConversion" v2
          WHERE v2.order_id = oa.id AND v2.campaign_id = v.campaign_id AND v2.source = 'CRM' AND v2.cancelled_at IS NULL
            AND oa.status <> 'CANCELLED' AND oa.entity_status <> 'DELETED')
    ) ac ON true
    ORDER BY v.converted_at DESC, v.id DESC`;
}

type LigneResume = { segment: string | null; ventes: number; ca: number };

/**
 * Ventes d'une campagne (détail et rapport) : la liste derrière le compteur
 * « Commande directe » et le chiffre d'affaires, ligne pour ligne. Deux
 * requêtes, jamais une par vente. Les droits sont vérifiés par l'appelant.
 */
@Injectable()
export class CrmCampaignVentesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Une page de ventes. */
  lister(id: string, q: CampaignVentesQueryDto = {}, masquer = false): Promise<VentesCampagne> {
    const limit = Math.min(Math.max(1, Math.trunc(q.limit ?? VENTES_PAR_PAGE)), VENTES_PAR_PAGE_MAX);
    const page = Math.max(1, Math.trunc(q.page ?? 1));
    return this.lire(id, { segment: q.segment ?? null, limit, page, autres: AUTRES_A_L_ECRAN }, masquer);
  }

  /** Toutes les ventes, pour l'onglet « Ventes » du rapport Excel. */
  async toutes(id: string, masquer = false): Promise<VenteCampagne[]> {
    const r = await this.lire(id, { segment: null, limit: null, page: 1, autres: AUTRES_DANS_LE_RAPPORT }, masquer);
    return r.data;
  }

  private async lire(
    id: string,
    o: { segment: CrmSegment | null; limit: number | null; page: number; autres: number },
    masquer: boolean,
  ): Promise<VentesCampagne> {
    const campagne = await this.prisma.crmCampaign.findUnique({
      where: { id },
      select: { started_at: true, completed_at: true, publics: { select: { segment: true } } },
    });
    if (!campagne) throw new NotFoundException('Campagne introuvable');
    const fenetre = { debut: campagne.started_at, fin: campagne.completed_at };
    const limit = o.limit ?? 0;

    // Une campagne planifiée n'a encore rien vendu.
    const [resume, lignes] = campagne.started_at
      ? await Promise.all([
          this.prisma.$queryRaw<LigneResume[]>(requeteResume(id)),
          this.prisma.$queryRaw<LigneVenteBrute[]>(
            requeteVentes(id, { segment: o.segment, limit: o.limit, offset: (o.page - 1) * limit, autres: o.autres }),
          ),
        ])
      : [[] as LigneResume[], [] as LigneVenteBrute[]];

    const total = resume.find((l) => l.segment === null);
    // Les publics visés, puis ceux trouvés dans les ventes (campagne ancienne).
    const segments = [...new Set([...campagne.publics.map((p) => p.segment), ...resume.flatMap((l) => (l.segment ? [l.segment as CrmSegment] : []))])];
    segments.sort((a, b) => ORDRE_PUBLICS.indexOf(a) - ORDRE_PUBLICS.indexOf(b));
    const par_public = segments.map((segment) => {
      const l = resume.find((x) => x.segment === segment);
      return { segment, ventes: l?.ventes ?? 0, ca: Math.round(l?.ca ?? 0) };
    });
    const retenu = o.segment ? par_public.find((p) => p.segment === o.segment) : null;
    const ventes = o.segment ? (retenu?.ventes ?? 0) : (total?.ventes ?? 0);
    const ca = o.segment ? (retenu?.ca ?? 0) : Math.round(total?.ca ?? 0);
    const data = lignes.map((l) => versVenteCampagne(l, { masquer }));
    const parPage = o.limit ?? Math.max(data.length, 1);

    return {
      resume: { ventes, ca, par_public },
      fenetre,
      masque: masquer,
      data,
      meta: { total: ventes, page: o.page, limit: parPage, totalPages: Math.ceil(ventes / parPage) },
    };
  }
}
