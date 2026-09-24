import {
  CrmStatus,
  EntityStatus,
  Prisma,
} from '@prisma/client';
import { identiteContact } from '../crm.rules';
import { EtatCoupon, QueryCrmContactDto } from '../dto/contact.dto';

/**
 * Construction des filtres et du format de ligne de la liste des contacts,
 * partagés par la liste, l'export et la file de l'agent.
 */

export const SELECT_LIGNE = {
  id: true,
  status: true,
  segment: true,
  segment_since: true,
  cycle: true,
  last_order_at: true,
  phone: true,
  name: true,
  registered_at: true,
  call_count: true,
  last_call_at: true,
  last_call_outcome: true,
  callback_at: true,
  last_comment: true,
  coupon_sent_at: true,
  converted_at: true,
  conversion_amount: true,
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
} satisfies Prisma.CrmContactSelect;

export type LigneBrute = Prisma.CrmContactGetPayload<{ select: typeof SELECT_LIGNE }>;

export function etatCoupon(c: { used_at: Date | null; expires_at: Date }, maintenant = new Date()): EtatCoupon {
  if (c.used_at) return 'UTILISE';
  return c.expires_at > maintenant ? 'ACTIF' : 'EXPIRE';
}

export function versLigne(p: LigneBrute) {
  const { coupons, ...reste } = p;
  const dernier = coupons[0];
  const identite = identiteContact(p);
  return {
    ...reste,
    nom: identite.nom,
    telephone: identite.telephone,
    coupon: dernier ? { ...dernier, etat: etatCoupon(dernier) } : null,
  };
}

/** Nom affichable d'un contact (compte appli, sinon nom relevé à la capture). */
export function nomClient(c: {
  name?: string | null;
  customer?: { first_name: string | null; last_name: string | null; phone: string | null } | null;
}): string {
  return identiteContact(c).nom;
}

/** Jour entier en UTC : la Côte d'Ivoire vit à UTC+0, sans heure d'été. */
function plage(depuis?: string, jusque?: string): Prisma.DateTimeFilter | undefined {
  if (!depuis && !jusque) return undefined;
  return {
    ...(depuis && { gte: new Date(`${depuis.slice(0, 10)}T00:00:00.000Z`) }),
    ...(jusque && { lte: new Date(`${jusque.slice(0, 10)}T23:59:59.999Z`) }),
  };
}

const STATUTS = Object.values(CrmStatus) as string[];

export function filtreContacts(
  portee: Prisma.CrmContactWhereInput,
  q: QueryCrmContactDto,
): Prisma.CrmContactWhereInput {
  const maintenant = new Date();
  const et: Prisma.CrmContactWhereInput[] = [
    portee,
    { entity_status: { not: EntityStatus.DELETED } },
  ];

  const statuts = (q.status ?? '').split(',').map((s) => s.trim()).filter((s) => STATUTS.includes(s));
  // Un client qui a commandé sort de la liste (cahier §3) : on ne le revoit
  // que si on le demande, pour l'historique.
  et.push(
    statuts.length > 0
      ? { status: { in: statuts as CrmStatus[] } }
      : { status: { not: CrmStatus.CONVERTI } },
  );

  if (q.segment) et.push({ segment: q.segment });

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

  // Restaurant et dates portent sur une MÊME capture Glovo/Yango.
  const capture = plage(q.captured_from, q.captured_to);
  if (q.restaurant_id || capture) {
    et.push({
      captures: {
        some: {
          entity_status: { not: EntityStatus.DELETED },
          ...(q.restaurant_id && { restaurant_id: q.restaurant_id }),
          ...(capture && { created_at: capture }),
        },
      },
    });
  }

  const recherche = filtreRecherche(q.search);
  if (recherche) et.push(recherche);

  return { AND: et };
}

function filtreCoupon(etat: EtatCoupon | undefined, maintenant: Date): Prisma.CrmContactWhereInput | null {
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
function filtreRecherche(search?: string): Prisma.CrmContactWhereInput | null {
  const s = (search ?? '').trim();
  if (!s) return null;
  const chiffres = s.replace(/\D/g, '');
  if (chiffres.length >= 4 && chiffres.length === s.replace(/[\s+.-]/g, '').length) {
    const bout = chiffres.slice(-10);
    return { OR: [{ phone: { contains: bout } }, { customer: { phone: { contains: bout } } }] };
  }
  const mots = s.split(/\s+/).filter(Boolean).slice(0, 4);
  return {
    AND: mots.map((mot) => ({
      OR: [
        { name: { contains: mot, mode: 'insensitive' as const } },
        {
          customer: {
            OR: [
              { first_name: { contains: mot, mode: 'insensitive' as const } },
              { last_name: { contains: mot, mode: 'insensitive' as const } },
              { email: { contains: mot, mode: 'insensitive' as const } },
            ],
          },
        },
      ],
    })),
  };
}

export function triContacts(sort?: QueryCrmContactDto['sort']): Prisma.CrmContactOrderByWithRelationInput[] {
  switch (sort) {
    case 'inscription_asc':
      return [{ registered_at: { sort: 'asc', nulls: 'last' } }];
    case 'appel_desc':
      return [{ last_call_at: { sort: 'desc', nulls: 'last' } }, { registered_at: { sort: 'desc', nulls: 'last' } }];
    case 'appel_asc':
      return [{ last_call_at: { sort: 'asc', nulls: 'first' } }, { registered_at: { sort: 'desc', nulls: 'last' } }];
    case 'tentatives_desc':
      return [{ call_count: 'desc' }, { registered_at: { sort: 'desc', nulls: 'last' } }];
    case 'inscription_desc':
      return [{ registered_at: { sort: 'desc', nulls: 'last' } }];
    case 'derniere_commande_asc':
      return [{ last_order_at: { sort: 'asc', nulls: 'last' } }, { registered_at: { sort: 'desc', nulls: 'last' } }];
    case 'derniere_commande_desc':
      return [{ last_order_at: { sort: 'desc', nulls: 'last' } }, { registered_at: { sort: 'desc', nulls: 'last' } }];
    default:
      // Les entrées les plus récentes d'abord : l'inscription pour un inscrit,
      // le jour où il est devenu inactif pour un ancien client.
      return [{ segment_since: 'desc' }, { registered_at: { sort: 'desc', nulls: 'last' } }];
  }
}
