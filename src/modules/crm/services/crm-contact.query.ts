import {
  CampaignStatus,
  CrmStatus,
  EntityStatus,
  Prisma,
} from '@prisma/client';
import { vivierAReprendre } from '../crm-campagne.rules';
import { identiteContact } from '../crm.rules';
import { EtatCoupon, QueryCrmContactDto, RubriqueMaFile } from '../dto/contact.dto';

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

/**
 * Code de coupon masqué pour un lecteur (consultation) : un code à usage
 * unique n'est lié à aucun client, il ne doit pas pouvoir servir en caisse.
 */
export const codeMasque = (code: string) => `${code.slice(0, 2)}••••`;

/** Masque, dans un texte (libellé du journal), chacun des codes donnés. */
export function sansCodes(texte: string, codes: string[]): string {
  return codes.reduce((t, code) => (code ? t.split(code).join(codeMasque(code)).split(code.toUpperCase()).join(codeMasque(code)) : t), texte);
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
  /*
    AUCUNE EXCLUSION PAR DÉFAUT.

    La liste écartait les convertis d'office (cahier §3). Résultat : chercher un
    client qui vient de commander ne donnait RIEN, alors qu'il est bien là. Sur
    un écran qui doit réunir tous les clients du système, un filtre invisible
    qui cache une partie de la base fait croire à une absence.

    « Hors convertis » reste disponible, mais en choix explicite.
  */
  if (statuts.length > 0) et.push({ status: { in: statuts as CrmStatus[] } });

  if (q.segment) et.push({ segment: q.segment });

  if (q.agent_id === 'none') et.push({ assigned_to_id: null });
  else if (q.agent_id) et.push({ assigned_to_id: q.agent_id });

  if (q.campaign_id === 'none') et.push({ campaign_id: null });
  else if (q.campaign_id) et.push({ campaign_id: q.campaign_id });

  if (q.call_status_id) et.push({ last_call_status_id: q.call_status_id });
  if (q.loss_reason_id) et.push({ loss_reason_id: q.loss_reason_id });
  if (q.never_called === 'true') et.push({ call_count: 0 });
  if (q.abandoned === 'true') et.push({ abandoned_orders: { gt: 0 } });
  // Inscrits et inactifs qu'aucune file ne montre : ils attendent une campagne.
  if (q.a_reprendre === 'true') et.push(vivierAReprendre());

  const couponFiltre = filtreCoupon(q.coupon, maintenant);
  if (couponFiltre) et.push(couponFiltre);

  /**
   * ÉTAT DU COMPTE, repris de la page Clients. Les conditions sont celles du
   * module `customer`, transposées à travers la relation : un même mot doit
   * désigner exactement la même population des deux côtés, sinon la fusion
   * des deux écrans aurait produit deux comptes différents pour « sans app ».
   */
  if (q.compte) {
    const PAS_SUPPRIMEE = { entity_status: { not: EntityStatus.DELETED } };
    const parCompte: Record<string, Prisma.CustomerWhereInput> = {
      avec_app: { notification_settings: { expo_push_token: { not: null }, active: true } },
      sans_app: {
        OR: [
          { notification_settings: { is: null } },
          { notification_settings: { expo_push_token: null } },
        ],
      },
      a_commande: { orders: { some: PAS_SUPPRIMEE } },
      jamais_commande: { orders: { none: PAS_SUPPRIMEE } },
      profil_incomplet: {
        OR: [
          { first_name: null },
          { first_name: '' },
          { last_name: null },
          { last_name: '' },
        ],
      },
    };
    // `customer: { ... }` n'accepte QUE les fiches rattachées à un compte :
    // un numéro relevé en caisse sans compte sort de lui-même.
    et.push({ customer: parCompte[q.compte] });
  }

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

/** Une rubrique de « Ma file » : qui y entre, dans quel ordre, combien à l'accueil. */
export interface RubriqueFile {
  filtre: (maintenant: Date) => Prisma.CrmContactWhereInput;
  tri: Prisma.CrmContactOrderByWithRelationInput[];
  /** Lignes renvoyées à l'accueil ; le reste se charge dossier par dossier. */
  plafond: number;
}

/**
 * Rubriques de « Ma file » parmi les contacts CONFIÉS à l'agent, dans l'ordre
 * où il doit les traiter. La liste d'accueil, les comptes et les lignes d'un
 * dossier lisent cette seule définition : les nombres annoncés et les lignes
 * chargées ne peuvent pas diverger. L'id départage les égalités, pour que les
 * pages se suivent sans doublon ni trou.
 */
export const RUBRIQUES_FILE: Record<Exclude<RubriqueMaFile, 'commune'>, RubriqueFile> = {
  // Rappels promis et dus : en tête de l'accueil, toutes campagnes confondues.
  rappels: {
    filtre: (maintenant) => ({ status: CrmStatus.A_RAPPELER, callback_at: { lte: maintenant } }),
    tri: [{ callback_at: 'asc' }, { id: 'asc' }],
    plafond: 50,
  },
  interesses: {
    filtre: () => ({ status: CrmStatus.INTERESSE }),
    tri: [{ last_call_at: 'asc' }, { id: 'asc' }],
    plafond: 50,
  },
  // Les plus récents en tête : ils se souviennent de l'application.
  nouveaux: {
    filtre: () => ({ status: CrmStatus.A_APPELER, call_count: 0 }),
    tri: [{ segment_since: 'desc' }, { id: 'asc' }],
    plafond: 50,
  },
  relances: {
    filtre: () => ({
      OR: [
        { status: CrmStatus.A_APPELER, call_count: { gt: 0 } },
        { status: CrmStatus.A_RAPPELER, callback_at: null },
      ],
    }),
    tri: [{ last_call_at: 'asc' }, { id: 'asc' }],
    plafond: 50,
  },
  coupons: {
    filtre: () => ({ status: CrmStatus.COUPON_ENVOYE }),
    tri: [{ coupon_sent_at: 'asc' }, { id: 'asc' }],
    plafond: 50,
  },
  rappels_planifies: {
    filtre: (maintenant) => ({ status: CrmStatus.A_RAPPELER, callback_at: { gt: maintenant } }),
    tri: [{ callback_at: 'asc' }, { id: 'asc' }],
    plafond: 20,
  },
};

/** File commune Glovo/Yango (J+1) : les plus anciens d'abord, le premier qui compose prend le contact. */
export const TRI_COMMUNE: Prisma.CrmContactOrderByWithRelationInput[] = [{ segment_since: 'asc' }, { id: 'asc' }];

/**
 * Contacts confiés à l'agent que « Ma file » montre : hors campagne, ou dans
 * une campagne EN COURS. Une campagne suspendue met les siens en pause : ils
 * n'apparaissent qu'en dossier grisé, sans ligne.
 */
export function baseMaFile(agentId: string): Prisma.CrmContactWhereInput {
  return {
    assigned_to_id: agentId,
    entity_status: { not: EntityStatus.DELETED },
    OR: [{ campaign_id: null }, { campaign: { status: CampaignStatus.ACTIVE } }],
  };
}

export const CLE_SANS_CAMPAGNE = 'sans-campagne';
export const CLE_COMMUNE = 'commune';

/** Comptes d'un dossier de « Ma file », faits en base (jamais sur les lignes coupées). */
export interface ComptesDossier {
  interesses: number;
  nouveaux: number;
  relances: number;
  coupons: number;
  rappels_planifies: number;
  commune: number;
  /** Somme des rubriques du dossier ; les rappels dus restent à l'accueil. */
  total: number;
  /** = nouveaux ; file commune : jamais appelés. */
  jamais_appeles: number;
  /** = relances ; file commune : déjà appelés. */
  a_relancer: number;
}

export const comptesDossierVides = (): ComptesDossier => ({
  interesses: 0,
  nouveaux: 0,
  relances: 0,
  coupons: 0,
  rappels_planifies: 0,
  commune: 0,
  total: 0,
  jamais_appeles: 0,
  a_relancer: 0,
});

export type GenreDossierFile = 'campagne' | 'sans-campagne' | 'commune' | 'pause';

export interface DossierFile {
  /** Id de campagne, « sans-campagne » ou « commune ». */
  cle: string;
  genre: GenreDossierFile;
  nom: string;
  campaign_id: string | null;
  comptes: ComptesDossier;
}

/** Où en est l'équipe d'une campagne que l'agent pilote. */
export interface SuiviCampagne {
  campaign_id: string;
  nom: string;
  statut: 'ACTIVE' | 'SUSPENDED';
  mode: 'AUTOMATIQUE' | 'MANUEL';
  /** Contacts ouverts de la campagne. */
  restants: number;
  jamais_appeles: number;
  sans_agent: number;
  par_agent: { agent_id: string; nom: string; restants: number; jamais_appeles: number }[];
}

/** Ordre des dossiers : les campagnes, la file commune (périssable), « Hors campagne », puis les campagnes en pause. */
const RANG_DOSSIER: Record<GenreDossierFile, number> = { campagne: 0, commune: 1, 'sans-campagne': 2, pause: 3 };

export function trierDossiers(dossiers: DossierFile[]): DossierFile[] {
  return [...dossiers].sort((a, b) => RANG_DOSSIER[a.genre] - RANG_DOSSIER[b.genre] || a.nom.localeCompare(b.nom, 'fr'));
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

/**
 * Champs de la fiche qui portent du CENTRE D'APPELS, et que le mode
 * « annuaire » vide. Sortis en constante pour qu'un test puisse les
 * parcourir : c'est lui, et pas la relecture, qui empêchera un champ ajouté
 * plus tard de fuiter.
 */
export const CHAMPS_CENTRE_APPELS = [
  'appels',
  'coupons',
  'campagnes',
  'journal',
  'coupon',
  'assigned_to',
  'assigned_to_id',
  'last_call_status',
  'loss_reason',
  'last_comment',
  'callback_at',
  'last_call_at',
  'last_call_outcome',
  'call_count',
] as const;

/**
 * LA FICHE VUE PAR UN COMPTE « ANNUAIRE » (caissier, assistant-manager).
 *
 * Ils tiennent le fichier client, pas le pipeline d'appels. La forme de la
 * réponse ne change pas — l'écran attend les mêmes clés — mais tout ce qui
 * relève du suivi téléphonique en sort vide.
 *
 * ⚠️ Masquer un onglet à l'écran ne retire rien de la réponse : c'est ICI que
 * la séparation se joue. Un test parcourt `CHAMPS_CENTRE_APPELS` et vérifie
 * qu'aucun ne revient rempli.
 */
export function pourAnnuaire<T extends Record<string, unknown>>(fiche: T): T {
  const vide: Record<string, unknown> = {};
  for (const champ of CHAMPS_CENTRE_APPELS) {
    vide[champ] = Array.isArray((fiche as Record<string, unknown>)[champ]) ? [] : null;
  }
  return { ...fiche, ...vide };
}
