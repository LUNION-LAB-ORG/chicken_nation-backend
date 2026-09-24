import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { SettingsService } from 'src/modules/settings/settings.service';
import { CRM_SETTINGS, VENTE_VALIDE_SQL } from '../crm.rules';
import { VentesQueryDto } from '../dto/analytics.dto';

const JOUR = 86_400_000;
const VENTE_VALIDE = Prisma.raw(VENTE_VALIDE_SQL);

/**
 * Ventes du CRM, lues dans le registre : une vente par personne et par cycle,
 * une commande ne comptant qu'une fois. Remplace les onglets Tableau de bord et
 * Ventes de l'ancienne acquisition Glovo/Yango : les ventes antérieures à la
 * bascule y figurent comme « historique acquisition ».
 */
@Injectable()
export class CrmVentesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  private conditions(q: VentesQueryDto, colonneDate: string, alias: string): Prisma.Sql {
    const morceaux: Prisma.Sql[] = [];
    const col = Prisma.raw(colonneDate);
    if (q.from) morceaux.push(Prisma.sql`AND ${col} >= ${new Date(`${q.from.slice(0, 10)}T00:00:00.000Z`)}`);
    if (q.to) morceaux.push(Prisma.sql`AND ${col} < ${new Date(new Date(`${q.to.slice(0, 10)}T00:00:00.000Z`).getTime() + JOUR)}`);
    if (q.segment && alias === 'v') morceaux.push(Prisma.sql`AND v.segment = ${q.segment}::"CrmSegment"`);
    return morceaux.length ? Prisma.join(morceaux, ' ') : Prisma.empty;
  }

  async ventes(q: VentesQueryDto) {
    // Restaurant : celui de la commande directe, ou celui où le client a été capté.
    const restaurant = q.restaurant_id
      ? Prisma.sql`AND (v.restaurant_id = ${q.restaurant_id}::uuid OR cap.restaurant_id = ${q.restaurant_id}::uuid)`
      : Prisma.empty;
    const base = Prisma.sql`
      FROM "CrmConversion" v
      LEFT JOIN "Prospect" cap ON cap.id = v.capture_id
      WHERE ${VENTE_VALIDE}
        ${this.conditions(q, 'v.converted_at', 'v')} ${restaurant}`;

    const [[total], parPublic, parMois, captures, dernieres, bascule] = await Promise.all([
      this.prisma.$queryRaw<{ ventes: number; ca: number; historique: number }[]>`
        SELECT count(*)::int AS ventes, coalesce(sum(v.amount), 0)::float AS ca,
               count(*) FILTER (WHERE v.source = 'ACQUISITION_HISTORIQUE')::int AS historique ${base}`,
      this.prisma.$queryRaw<{ segment: string; ventes: number; ca: number }[]>`
        SELECT v.segment::text AS segment, count(*)::int AS ventes, coalesce(sum(v.amount), 0)::float AS ca ${base}
        GROUP BY v.segment ORDER BY ventes DESC`,
      this.prisma.$queryRaw<{ mois: string; segment: string; ventes: number; ca: number; historique: number }[]>`
        SELECT to_char(date_trunc('month', v.converted_at), 'YYYY-MM') AS mois, v.segment::text AS segment,
               count(*)::int AS ventes, coalesce(sum(v.amount), 0)::float AS ca,
               count(*) FILTER (WHERE v.source = 'ACQUISITION_HISTORIQUE')::int AS historique ${base}
        GROUP BY 1, 2 ORDER BY 1, 2`,
      // Captures par restaurant : combien de clients Glovo/Yango relevés, et
      // combien de ces personnes ont commandé en direct depuis.
      this.prisma.$queryRaw<{ restaurant_id: string | null; restaurant: string | null; captures: number; personnes: number; ventes: number }[]>`
        SELECT cap.restaurant_id, r.name AS restaurant, count(*)::int AS captures,
               count(DISTINCT cap.contact_id)::int AS personnes,
               count(DISTINCT v.id) FILTER (WHERE v.id IS NOT NULL)::int AS ventes
        FROM "Prospect" cap
        LEFT JOIN "Restaurant" r ON r.id = cap.restaurant_id
        LEFT JOIN "CrmConversion" v ON v.capture_id = cap.id AND ${VENTE_VALIDE}
        WHERE cap.entity_status <> 'DELETED' AND cap.platform IN ('GLOVO', 'YANGO')
          ${this.conditions(q, 'cap.created_at', 'cap')}
          ${q.restaurant_id ? Prisma.sql`AND cap.restaurant_id = ${q.restaurant_id}::uuid` : Prisma.empty}
          ${q.segment === 'GLOVO' || q.segment === 'YANGO' ? Prisma.sql`AND cap.platform::text = ${q.segment}` : Prisma.empty}
        GROUP BY cap.restaurant_id, r.name ORDER BY captures DESC`,
      this.prisma.$queryRaw<
        { id: string; converted_at: Date; segment: string; amount: number; source: string; reference: string | null; restaurant: string | null; contact_id: string; nom: string }[]
      >`
        SELECT v.id, v.converted_at, v.segment::text AS segment, v.amount, v.source::text AS source, o.reference,
               coalesce(ro.name, rc.name) AS restaurant, v.contact_id,
               coalesce(nullif(trim(concat_ws(' ', cu.first_name, cu.last_name)), ''), x.name, 'Client sans nom') AS nom
        FROM "CrmConversion" v
        JOIN "CrmContact" x ON x.id = v.contact_id
        LEFT JOIN "Customer" cu ON cu.id = x.customer_id
        LEFT JOIN "Order" o ON o.id = v.order_id
        LEFT JOIN "Restaurant" ro ON ro.id = v.restaurant_id
        LEFT JOIN "Prospect" cap ON cap.id = v.capture_id
        LEFT JOIN "Restaurant" rc ON rc.id = cap.restaurant_id
        WHERE ${VENTE_VALIDE}
          ${this.conditions(q, 'v.converted_at', 'v')} ${restaurant}
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
      },
      par_public: parPublic.map((p) => ({ ...p, ca: Math.round(p.ca) })),
      par_mois: parMois.map((m) => ({ ...m, ca: Math.round(m.ca) })),
      captures_par_restaurant: captures.map((c) => ({ ...c, restaurant: c.restaurant ?? 'Sans restaurant' })),
      dernieres: dernieres.map((d) => ({ ...d, amount: Math.round(d.amount) })),
    };
  }
}
