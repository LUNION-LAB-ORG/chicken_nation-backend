import {
  ConversionProspectStatus,
  EntityStatus,
  Prisma,
} from '@prisma/client';
import { EtatCoupon, QueryConversionProspectDto } from '../dto/prospect.dto';

/**
 * Construction des filtres et du format de ligne de la liste des prospects,
 * partagés par la liste, l'export et la file de l'agent.
 */

export const SELECT_LIGNE = {
  id: true,
  status: true,
  registered_at: true,
  call_count: true,
  last_call_at: true,
  last_call_outcome: true,
  callback_at: true,
  last_comment: true,
  coupon_sent_at: true,
  converted_at: true,
  first_order_amount: true,
  abandoned_orders: true,
  assigned_at: true,
  campaign_id: true,
  assigned_to_id: true,
  customer: {
    select: { id: true, first_name: true, last_name: true, phone: true, email: true },
  },
  assigned_to: { select: { id: true, fullname: true } },
  campaign: { select: { id: true, name: true, status: true } },
  last_call_status: { select: { id: true, label: true } },
  loss_reason: { select: { id: true, name: true } },
  coupons: {
    orderBy: { sent_at: 'desc' },
    take: 1,
    select: {
      id: true,
      code: true,
      offer_label: true,
      sent_at: true,
      expires_at: true,
      used_at: true,
      channel: true,
    },
  },
} satisfies Prisma.ConversionProspectSelect;

export type LigneBrute = Prisma.ConversionProspectGetPayload<{ select: typeof SELECT_LIGNE }>;

export function etatCoupon(c: { used_at: Date | null; expires_at: Date }, maintenant = new Date()): EtatCoupon {
  if (c.used_at) return 'UTILISE';
  return c.expires_at > maintenant ? 'ACTIF' : 'EXPIRE';
}

export function versLigne(p: LigneBrute) {
  const { coupons, ...reste } = p;
  const dernier = coupons[0];
  return {
    ...reste,
    nom: nomClient(p.customer),
    coupon: dernier ? { ...dernier, etat: etatCoupon(dernier) } : null,
  };
}

export function nomClient(c: { first_name: string | null; last_name: string | null }): string {
  return [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || 'Client sans nom';
}

/** Jour entier en UTC : la Côte d'Ivoire vit à UTC+0, sans heure d'été. */
function plage(depuis?: string, jusque?: string): Prisma.DateTimeFilter | undefined {
  if (!depuis && !jusque) return undefined;
  return {
    ...(depuis && { gte: new Date(`${depuis.slice(0, 10)}T00:00:00.000Z`) }),
    ...(jusque && { lte: new Date(`${jusque.slice(0, 10)}T23:59:59.999Z`) }),
  };
}

const STATUTS = Object.values(ConversionProspectStatus) as string[];

export function filtreProspects(
  portee: Prisma.ConversionProspectWhereInput,
  q: QueryConversionProspectDto,
): Prisma.ConversionProspectWhereInput {
  const maintenant = new Date();
  const et: Prisma.ConversionProspectWhereInput[] = [
    portee,
    { entity_status: { not: EntityStatus.DELETED } },
  ];

  const statuts = (q.status ?? '').split(',').map((s) => s.trim()).filter((s) => STATUTS.includes(s));
  // Un client qui a commandé sort de la liste (cahier §3) : on ne le revoit
  // que si on le demande, pour l'historique.
  et.push(
    statuts.length > 0
      ? { status: { in: statuts as ConversionProspectStatus[] } }
      : { status: { not: ConversionProspectStatus.CONVERTI } },
  );

  if (q.agent_id === 'none') et.push({ assigned_to_id: null });
  else if (q.agent_id) et.push({ assigned_to_id: q.agent_id });

  if (q.campaign_id === 'none') et.push({ campaign_id: null });
  else if (q.campaign_id) et.push({ campaign_id: q.campaign_id });

  if (q.call_status_id) et.push({ last_call_status_id: q.call_status_id });
  if (q.loss_reason_id) et.push({ loss_reason_id: q.loss_reason_id });
  if (q.never_called === 'true') et.push({ call_count: 0 });
  if (q.abandoned === 'true') et.push({ abandoned_orders: { gt: 0 } });

  const couponFiltre = filtreCoupon(q.coupon, maintenant);
  if (couponFiltre) et.push(couponFiltre);

  const inscription = plage(q.registered_from, q.registered_to);
  if (inscription) et.push({ registered_at: inscription });
  const appel = plage(q.last_call_from, q.last_call_to);
  if (appel) et.push({ last_call_at: appel });

  const recherche = filtreRecherche(q.search);
  if (recherche) et.push(recherche);

  return { AND: et };
}

function filtreCoupon(etat: EtatCoupon | undefined, maintenant: Date): Prisma.ConversionProspectWhereInput | null {
  switch (etat) {
    case 'AUCUN':
      return { coupons: { none: {} } };
    case 'ACTIF':
      return { coupons: { some: { used_at: null, expires_at: { gt: maintenant } } } };
    case 'UTILISE':
      return { coupons: { some: { used_at: { not: null } } } };
    case 'EXPIRE':
      return {
        coupons: {
          some: {},
          none: { OR: [{ used_at: { not: null } }, { expires_at: { gt: maintenant } }] },
        },
      };
    default:
      return null;
  }
}

/**
 * « Kouassi Jean » doit trouver Jean Kouassi : chaque mot doit figurer dans le
 * prénom, le nom ou l'e-mail. Une saisie de chiffres cherche le téléphone.
 */
function filtreRecherche(search?: string): Prisma.ConversionProspectWhereInput | null {
  const s = (search ?? '').trim();
  if (!s) return null;
  const chiffres = s.replace(/\D/g, '');
  if (chiffres.length >= 4 && chiffres.length === s.replace(/[\s+.-]/g, '').length) {
    return { customer: { phone: { contains: chiffres.slice(-10) } } };
  }
  const mots = s.split(/\s+/).filter(Boolean).slice(0, 4);
  return {
    AND: mots.map((mot) => ({
      customer: {
        OR: [
          { first_name: { contains: mot, mode: 'insensitive' as const } },
          { last_name: { contains: mot, mode: 'insensitive' as const } },
          { email: { contains: mot, mode: 'insensitive' as const } },
        ],
      },
    })),
  };
}

export function triProspects(sort?: QueryConversionProspectDto['sort']): Prisma.ConversionProspectOrderByWithRelationInput[] {
  switch (sort) {
    case 'inscription_asc':
      return [{ registered_at: 'asc' }];
    case 'appel_desc':
      return [{ last_call_at: { sort: 'desc', nulls: 'last' } }, { registered_at: 'desc' }];
    case 'appel_asc':
      return [{ last_call_at: { sort: 'asc', nulls: 'first' } }, { registered_at: 'desc' }];
    case 'tentatives_desc':
      return [{ call_count: 'desc' }, { registered_at: 'desc' }];
    default:
      return [{ registered_at: 'desc' }];
  }
}
