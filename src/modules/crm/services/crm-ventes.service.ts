import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { SettingsService } from 'src/modules/settings/settings.service';
import { CRM_SETTINGS, PUBLICS_CAPTES, porteePublics, publicsDe } from '../crm.rules';
import { VentesQueryDto } from '../dto/analytics.dto';
import {
  Perimetre,
  VENTE_VALIDE,
  filtreCampagne,
  filtreRestaurant,
  filtreSegments,
  jointurePassage,
  plage,
} from './crm-passages.query';

/**
 * Public d'une vente : celui du passage où elle a eu lieu (voir `jointurePassage`).
 * Une vente de l'ancienne acquisition garde son public d'origine (Glovo ou Yango).
 */
const PUBLIC_V = "CASE WHEN v.source = 'ACQUISITION_HISTORIQUE' THEN v.segment ELSE coalesce(ya.segment, v.segment) END";

type LigneCaptures = {
  restaurant_id: string | null;
  restaurant: string | null;
  captures: number;
  personnes: number;
  ventes: number;
  /** 1 sur la ligne de total (GROUPING SETS), 0 sinon. */
  total: number;
};

/**
 * Ventes du CRM, lues dans le registre : une vente par personne et par cycle,
 * une commande ne comptant qu'une fois, et seulement les ventes valides (ni
 * annulées au registre, ni portées par une commande annulée ou supprimée).
 * Remplace les onglets Tableau de bord et Ventes de l'ancienne acquisition
 * Glovo/Yango : les ventes antérieures à la bascule y figurent comme
 * « historique acquisition ».
 *
 * Compte de point de vente (`perimetre_restaurant`, posé par le contrôleur) :
 * les ventes des fiches de son restaurant, le filtre restaurant forcé au sien
 * (commande directe ou capture chez lui), les captures faites chez lui.
 */
@Injectable()
export class CrmVentesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Période, publics (public du passage), campagne et fiches du restaurant
   * d'un point de vente, pour une vente du registre (alias v, passage ya).
   */
  private conditions(q: VentesQueryDto & Perimetre): Prisma.Sql {
    return Prisma.sql`${plage('v.converted_at', q)} ${filtreSegments(PUBLIC_V, publicsDe(q))} ${filtreCampagne('v.campaign_id', q)}
      ${filtreRestaurant('v.contact_id', q)}`;
  }

  async ventes(q: VentesQueryDto & Perimetre) {
    const plateformes = porteePublics(publicsDe(q)).filter((p) => PUBLICS_CAPTES.includes(p));
    // Un point de vente ne choisit pas son restaurant : c'est le sien.
    const restaurantId = q.perimetre_restaurant ?? q.restaurant_id;
    // Restaurant : celui de la commande directe, ou celui où le client a été capté.
    const restaurant = restaurantId
      ? Prisma.sql`AND (v.restaurant_id = ${restaurantId}::uuid OR cap.restaurant_id = ${restaurantId}::uuid)`
      : Prisma.empty;
    const base = Prisma.sql`
      FROM "CrmConversion" v
      ${jointurePassage('v')}
      LEFT JOIN "Prospect" cap ON cap.id = v.capture_id
      WHERE ${VENTE_VALIDE}
        ${this.conditions(q)} ${restaurant}`;
    // Les ventes de l'ancienne acquisition (avant la bascule) restent à part :
    // hors ventes et hors chiffre d'affaires du CRM.
    const colonnes = Prisma.sql`
      count(*) FILTER (WHERE v.source = 'CRM')::int AS ventes,
      coalesce(sum(v.amount) FILTER (WHERE v.source = 'CRM'), 0)::float AS ca,
      count(*) FILTER (WHERE v.source = 'ACQUISITION_HISTORIQUE')::int AS historique,
      coalesce(sum(v.amount) FILTER (WHERE v.source = 'ACQUISITION_HISTORIQUE'), 0)::float AS ca_historique`;

    const [[total], parPublic, parMois, captures, dernieres, bascule] = await Promise.all([
      this.prisma.$queryRaw<{ ventes: number; ca: number; historique: number; ca_historique: number }[]>`
        SELECT ${colonnes} ${base}`,
      this.prisma.$queryRaw<{ segment: string; ventes: number; ca: number; historique: number; ca_historique: number }[]>`
        SELECT ${Prisma.raw(PUBLIC_V)}::text AS segment, ${colonnes} ${base}
        GROUP BY 1 ORDER BY ventes DESC`,
      this.prisma.$queryRaw<{ mois: string; segment: string; ventes: number; ca: number; historique: number; ca_historique: number }[]>`
        SELECT to_char(date_trunc('month', v.converted_at), 'YYYY-MM') AS mois, ${Prisma.raw(PUBLIC_V)}::text AS segment,
               ${colonnes} ${base}
        GROUP BY 1, 2 ORDER BY 1, 2`,
      // Captures par restaurant : combien de clients Glovo/Yango relevés, et
      // combien de ces personnes ont commandé en direct depuis. Seulement quand
      // un public capté est regardé (rien pour les inscrits ou les inactifs seuls).
      plateformes.length
        ? this.prisma.$queryRaw<LigneCaptures[]>`
            SELECT cap.restaurant_id, r.name AS restaurant, count(*)::int AS captures,
                   -- Ligne de total : une personne relevée dans deux restaurants n'y compte qu'une fois.
                   GROUPING(cap.restaurant_id)::int AS total,
                   count(DISTINCT cap.contact_id)::int AS personnes,
                   count(DISTINCT v.id) FILTER (WHERE v.id IS NOT NULL)::int AS ventes
            FROM "Prospect" cap
            LEFT JOIN "Restaurant" r ON r.id = cap.restaurant_id
            LEFT JOIN "CrmConversion" v ON v.capture_id = cap.id AND ${VENTE_VALIDE}
            WHERE cap.entity_status <> 'DELETED' AND cap.platform::text IN (${Prisma.join(plateformes.map((p) => String(p)))})
              ${plage('cap.created_at', q)}
              ${restaurantId ? Prisma.sql`AND cap.restaurant_id = ${restaurantId}::uuid` : Prisma.empty}
              ${
                q.campaign_id
                  ? Prisma.sql`AND EXISTS (SELECT 1 FROM "CrmCampaignMember" m WHERE m.contact_id = cap.contact_id AND m.campaign_id = ${q.campaign_id}::uuid)`
                  : Prisma.empty
              }
            GROUP BY GROUPING SETS ((cap.restaurant_id, r.name), ()) ORDER BY total, captures DESC`
        : Promise.resolve([] as LigneCaptures[]),
      this.prisma.$queryRaw<
        { id: string; converted_at: Date; segment: string; amount: number; source: string; reference: string | null; restaurant: string | null; contact_id: string; nom: string }[]
      >`
        SELECT v.id, v.converted_at, ${Prisma.raw(PUBLIC_V)}::text AS segment, v.amount, v.source::text AS source, o.reference,
               coalesce(ro.name, rc.name) AS restaurant, v.contact_id,
               coalesce(nullif(trim(concat_ws(' ', cu.first_name, cu.last_name)), ''), x.name, 'Client sans nom') AS nom
        FROM "CrmConversion" v
        ${jointurePassage('v')}
        JOIN "CrmContact" x ON x.id = v.contact_id
        LEFT JOIN "Customer" cu ON cu.id = x.customer_id
        LEFT JOIN "Order" o ON o.id = v.order_id
        LEFT JOIN "Restaurant" ro ON ro.id = v.restaurant_id
        LEFT JOIN "Prospect" cap ON cap.id = v.capture_id
        LEFT JOIN "Restaurant" rc ON rc.id = cap.restaurant_id
        WHERE ${VENTE_VALIDE}
          ${this.conditions(q)} ${restaurant}
        ORDER BY v.converted_at DESC LIMIT 100`,
      this.settings.get(CRM_SETTINGS.BASCULE_ACQUISITION),
    ]);

    return {
      bascule: bascule || null,
      total: {
        ventes: total.ventes,
        ca: Math.round(total.ca),
        panier_moyen: total.ventes > 0 ? Math.round(total.ca / total.ventes) : 0,
        historique: total.historique,
        ca_historique: Math.round(total.ca_historique),
      },
      par_public: parPublic.map((p) => ({ ...p, ca: Math.round(p.ca), ca_historique: Math.round(p.ca_historique) })),
      par_mois: parMois.map((m) => ({ ...m, ca: Math.round(m.ca), ca_historique: Math.round(m.ca_historique) })),
      captures_par_restaurant: captures
        .filter((c) => !c.total)
        .map(({ total: _t, ...c }) => ({ ...c, restaurant: c.restaurant ?? 'Sans restaurant' })),
      /** Personnes distinctes relevées sur la période, tous restaurants confondus. */
      captures_total: (() => {
        const t = captures.find((c) => c.total);
        return { captures: t?.captures ?? 0, personnes: t?.personnes ?? 0, ventes: t?.ventes ?? 0 };
      })(),
      dernieres: dernieres.map((d) => ({ ...d, amount: Math.round(d.amount) })),
    };
  }
}
