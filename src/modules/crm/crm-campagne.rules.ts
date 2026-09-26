import { CampaignStatus, CrmSegment, CrmStatus, EntityStatus, OrderStatus, OrderType, Prisma, ProspectPlatform } from '@prisma/client';
import { LIBELLES_PUBLIC, STATUTS_OUVERTS, VENTE_VALIDE_SQL, dateCourte, identiteContact } from './crm.rules';
import { codeMasque } from './services/crm-contact.query';

/**
 * Règles des campagnes multi-publics (lot 3), sans aucune dépendance : elles
 * sont testées seules (crm-campagne.rules.spec.ts) et partagées par le
 * lancement, l'aperçu, la clôture et le rapport. Le même constructeur de
 * filtre sert à l'aperçu et au lancement : les deux chiffres coïncident par
 * construction.
 */

const JOUR = 86_400_000;

/** Campagne « en cours » : un contact n'est jamais dans deux à la fois. */
export const CAMPAGNES_EN_COURS: CampaignStatus[] = [CampaignStatus.ACTIVE, CampaignStatus.SUSPENDED];

/** Publics captés en caisse sur une plateforme de livraison. */
export const PUBLICS_CAPTES: CrmSegment[] = [CrmSegment.GLOVO, CrmSegment.YANGO];

export const COMPTES_APPLI = ['AVEC', 'SANS'] as const;
export type CompteAppli = (typeof COMPTES_APPLI)[number];

/** Critères d'un public visé par une campagne, tels qu'ils sont enregistrés. */
export interface PublicCampagne {
  segment: CrmSegment;
  /** Inscription, décrochage ou capture selon le public ; jour UTC inclus. */
  period_from?: Date | string | null;
  period_to?: Date | string | null;
  /** Glovo/Yango : restaurants de la capture. */
  restaurant_ids?: string[] | null;
  /** Glovo/Yango : avec ou sans compte sur l'application. */
  account?: CompteAppli | string | null;
  /** Inactifs : seulement les clients déjà reconquis une fois (cycle 2 et plus). */
  relapsed_only?: boolean | null;
}

/** Minuit UTC du jour donné (la Côte d'Ivoire vit à UTC+0). */
export function jourUTC(v: Date | string): Date {
  const iso = typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10);
  return new Date(`${iso}T00:00:00.000Z`);
}

/** Bornes [du 00:00 ; au + 1 jour[, ou null sans période. */
export function plageJours(
  depuis?: Date | string | null,
  jusque?: Date | string | null,
): { gte?: Date; lt?: Date } | null {
  if (!depuis && !jusque) return null;
  return {
    ...(depuis && { gte: jourUTC(depuis) }),
    ...(jusque && { lt: new Date(jourUTC(jusque).getTime() + JOUR) }),
  };
}

export const estCapte = (segment: CrmSegment) => PUBLICS_CAPTES.includes(segment);

/**
 * Ce qui définit le public lui-même : sa date propre, les restaurants et le
 * compte pour Glovo/Yango, « déjà reconquis » pour les inactifs. Ni statut,
 * ni campagne, ni agent : ce sont les exclusions, comptées à part.
 */
export function criteresPublic(pub: PublicCampagne): Prisma.CrmContactWhereInput[] {
  const et: Prisma.CrmContactWhereInput[] = [
    { segment: pub.segment, entity_status: { not: EntityStatus.DELETED } },
  ];
  const periode = plageJours(pub.period_from, pub.period_to);
  switch (pub.segment) {
    case CrmSegment.JAMAIS_COMMANDE:
      if (periode) et.push({ registered_at: periode });
      break;
    case CrmSegment.INACTIF:
      if (periode) et.push({ segment_since: periode });
      if (pub.relapsed_only) et.push({ cycle: { gte: 2 } });
      break;
    case CrmSegment.GLOVO:
    case CrmSegment.YANGO: {
      // Restaurant et date portent sur une MÊME capture de la plateforme. Une
      // fiche sans compte n'a pas de date d'inscription : aucune période ne
      // l'écarte plus.
      const restaurants = [...new Set(pub.restaurant_ids ?? [])];
      if (periode || restaurants.length > 0) {
        et.push({
          captures: {
            some: {
              platform: pub.segment as unknown as ProspectPlatform,
              entity_status: { not: EntityStatus.DELETED },
              ...(restaurants.length > 0 && { restaurant_id: { in: restaurants } }),
              ...(periode && { created_at: periode }),
            },
          },
        });
      }
      if (pub.account === 'AVEC') et.push({ customer_id: { not: null } });
      if (pub.account === 'SANS') et.push({ customer_id: null });
      break;
    }
  }
  return et;
}

/** Statuts encore à travailler : ni pas intéressé, ni injoignable, ni converti. */
const STATUT_OUVERT: Prisma.CrmContactWhereInput = { status: { in: STATUTS_OUVERTS } };

/** Hors de toute campagne en cours. */
const HORS_CAMPAGNE: Prisma.CrmContactWhereInput = {
  OR: [{ campaign_id: null }, { campaign: { status: { notIn: CAMPAGNES_EN_COURS } } }],
};

/**
 * Agent compatible avec l'équipe : personne, un agent de l'équipe, ou un
 * agent désactivé (son contact est repris). Un agent actif hors équipe garde
 * le sien.
 */
function agentCompatible(equipe: string[]): Prisma.CrmContactWhereInput {
  return {
    OR: [
      { assigned_to_id: null },
      ...(equipe.length > 0 ? [{ assigned_to_id: { in: equipe } }] : []),
      { assigned_to: { entity_status: { not: EntityStatus.ACTIVE } } },
    ],
  };
}

/** J+1 : un client capté aujourd'hui n'entre qu'à partir de demain. */
function veille(pub: PublicCampagne, maintenant: Date): Prisma.CrmContactWhereInput[] {
  return estCapte(pub.segment) ? [{ segment_since: { lt: jourUTC(maintenant) } }] : [];
}

/** Population d'UN public au lancement : ce que l'aperçu appelle « disponibles ». */
export function critereCampagne(pub: PublicCampagne, equipe: string[], maintenant: Date): Prisma.CrmContactWhereInput {
  return {
    AND: [...criteresPublic(pub), STATUT_OUVERT, HORS_CAMPAGNE, agentCompatible(equipe), ...veille(pub, maintenant)],
  };
}

/** Population de toute la campagne : un « ou » entre ses publics (qui sont disjoints). */
export function populationCampagne(publics: PublicCampagne[], equipe: string[], maintenant: Date): Prisma.CrmContactWhereInput {
  return { OR: publics.map((p) => critereCampagne(p, equipe, maintenant)) };
}

export type BacApercu = 'autre_campagne' | 'agent_hors_equipe' | 'captes_aujourdhui' | 'non_interesses' | 'injoignables';

/**
 * Contacts du public écartés au lancement, un filtre par raison. Les bacs sont
 * DISJOINTS et suivent l'ordre du lancement : statut, puis campagne en cours,
 * puis agent hors équipe, puis J+1. Les convertis ne sont pas comptés : ils
 * ont quitté la liste.
 */
export function bacsApercu(pub: PublicCampagne, equipe: string[], maintenant: Date): Record<BacApercu, Prisma.CrmContactWhereInput | null> {
  const base = criteresPublic(pub);
  return {
    non_interesses: { AND: [...base, { status: CrmStatus.NON_INTERESSE }] },
    injoignables: { AND: [...base, { status: CrmStatus.INJOIGNABLE }] },
    autre_campagne: { AND: [...base, STATUT_OUVERT, { campaign: { status: { in: CAMPAGNES_EN_COURS } } }] },
    agent_hors_equipe: {
      AND: [
        ...base,
        STATUT_OUVERT,
        HORS_CAMPAGNE,
        { assigned_to_id: { not: null, notIn: equipe } },
        { assigned_to: { entity_status: EntityStatus.ACTIVE } },
      ],
    },
    captes_aujourdhui: estCapte(pub.segment)
      ? { AND: [...base, STATUT_OUVERT, HORS_CAMPAGNE, agentCompatible(equipe), { segment_since: { gte: jourUTC(maintenant) } }] }
      : null,
  };
}

export type SortieFinCampagne = 'GARDER_AGENT' | 'LIBERER';

/**
 * Sort d'un contact non converti à la clôture, le même pour tous les publics :
 * un intéressé, un coupon encore valable ou un rappel promis à venir restent à
 * leur agent (hors campagne), pour que la parole donnée soit tenue. Tout le
 * reste est libéré ; un Glovo/Yango libéré revient seul dans la file commune.
 */
export function sortieFinCampagne(
  contact: { status: CrmStatus; callback_at: Date | null },
  couponActif: boolean,
  maintenant: Date,
): SortieFinCampagne {
  switch (contact.status) {
    case CrmStatus.INTERESSE:
      return 'GARDER_AGENT';
    case CrmStatus.COUPON_ENVOYE:
      return couponActif ? 'GARDER_AGENT' : 'LIBERER';
    case CrmStatus.A_RAPPELER:
      return contact.callback_at && contact.callback_at >= maintenant ? 'GARDER_AGENT' : 'LIBERER';
    default:
      return 'LIBERER';
  }
}

const nomPublic = (s: CrmSegment) => LIBELLES_PUBLIC[s] ?? s;

/**
 * Cohérence des publics d'une campagne. Renvoie les erreurs, en français,
 * prêtes à afficher ; une liste vide veut dire que tout va bien.
 */
export function verifierPublics(publics: PublicCampagne[]): string[] {
  const erreurs: string[] = [];
  if (publics.length === 0) erreurs.push('Choisissez au moins un public');
  const vus = new Set<CrmSegment>();
  for (const p of publics) {
    const nom = nomPublic(p.segment);
    if (vus.has(p.segment)) erreurs.push(`Le public « ${nom} » est choisi deux fois : un seul jeu de critères par public`);
    vus.add(p.segment);
    if (p.period_from && p.period_to && jourUTC(p.period_to) < jourUTC(p.period_from)) {
      erreurs.push(`La période du public « ${nom} » est inversée`);
    }
    if (!estCapte(p.segment) && ((p.restaurant_ids?.length ?? 0) > 0 || p.account)) {
      erreurs.push(`Les restaurants de capture et le compte sur l'appli ne concernent que les clients Glovo et Yango (public « ${nom} »)`);
    }
    if (p.account && !(COMPTES_APPLI as readonly string[]).includes(p.account)) {
      erreurs.push(`Compte sur l'appli inconnu pour le public « ${nom} »`);
    }
    if (p.relapsed_only && p.segment !== CrmSegment.INACTIF) {
      erreurs.push(`« Déjà reconquis une fois » ne concerne que les clients inactifs (public « ${nom} »)`);
    }
  }
  return erreurs;
}

/** Les critères de ciblage sont-ils les mêmes ? (seuls l'offre et les objectifs changent après le lancement) */
export function memesCriteres(a: PublicCampagne, b: PublicCampagne): boolean {
  const jourOuRien = (v?: Date | string | null) => (v ? jourUTC(v).getTime() : null);
  const restos = (v?: string[] | null) => [...new Set(v ?? [])].sort().join(',');
  return (
    a.segment === b.segment &&
    jourOuRien(a.period_from) === jourOuRien(b.period_from) &&
    jourOuRien(a.period_to) === jourOuRien(b.period_to) &&
    restos(a.restaurant_ids) === restos(b.restaurant_ids) &&
    (a.account ?? null) === (b.account ?? null) &&
    !!a.relapsed_only === !!b.relapsed_only
  );
}

/**
 * Publics d'une campagne créée par l'ancien corps de requête (`segments` et
 * `registered_*`) : la période d'inscription ne vaut que pour les inscrits.
 */
export function publicsDepuisAncienCorps(
  segments: CrmSegment[] | undefined | null,
  registeredFrom?: Date | string | null,
  registeredTo?: Date | string | null,
): PublicCampagne[] {
  const liste = segments && segments.length > 0 ? [...new Set(segments)] : [CrmSegment.JAMAIS_COMMANDE];
  return liste.map((segment) => ({
    segment,
    ...(segment === CrmSegment.JAMAIS_COMMANDE && { period_from: registeredFrom ?? null, period_to: registeredTo ?? null }),
  }));
}

/** Libellé de la période selon le public : ce que la date veut dire. */
export const LIBELLES_PERIODE: Record<CrmSegment, string> = {
  JAMAIS_COMMANDE: 'Inscrits',
  INACTIF: 'Devenus inactifs',
  GLOVO: 'Captés sur Glovo',
  YANGO: 'Captés sur Yango',
};

/** Critères d'un public écrits en clair, pour le rapport et la synthèse. */
export function criteresEnClair(pub: PublicCampagne, nomsRestaurants: Map<string, string> = new Map()): string {
  const morceaux: string[] = [];
  const debut = pub.period_from ? dateCourte(jourUTC(pub.period_from)) : null;
  const fin = pub.period_to ? dateCourte(jourUTC(pub.period_to)) : null;
  const libelle = LIBELLES_PERIODE[pub.segment];
  if (debut && fin) morceaux.push(`${libelle} du ${debut} au ${fin}`);
  else if (debut) morceaux.push(`${libelle} depuis le ${debut}`);
  else if (fin) morceaux.push(`${libelle} jusqu'au ${fin}`);
  else morceaux.push(`${libelle}, toutes dates`);
  const restaurants = [...new Set(pub.restaurant_ids ?? [])];
  if (restaurants.length > 0) {
    const noms = restaurants.map((id) => nomsRestaurants.get(id) ?? 'restaurant supprimé');
    morceaux.push(`${restaurants.length > 1 ? 'restaurants' : 'restaurant'} de capture : ${noms.join(', ')}`);
  }
  if (pub.account === 'AVEC') morceaux.push("avec un compte sur l'appli");
  if (pub.account === 'SANS') morceaux.push("sans compte sur l'appli");
  if (pub.relapsed_only) morceaux.push('déjà reconquis une fois');
  return morceaux.join(' ; ');
}

// ---------------------------------------------------------------------------
// Ventes d'une campagne : la liste du détail et l'onglet « Ventes » du rapport
// ---------------------------------------------------------------------------

/**
 * Vente comptée pour une campagne (alias v sur "CrmConversion") : enregistrée
 * par le CRM, jamais l'historique d'acquisition, et valide (ni annulée au
 * registre, ni portée par une commande annulée ou supprimée). Le compteur du
 * tableau de bord, la liste des ventes et le rapport lisent ce même fragment :
 * la liste et le compteur concordent par construction.
 */
export const VENTE_DE_CAMPAGNE_SQL = `v."source" = 'CRM' AND ${VENTE_VALIDE_SQL}`;

/**
 * Membre de la campagne qui porte la vente (alias m) : il donne le public au
 * ciblage. Un membre est unique par campagne et contact : la jointure ne
 * double jamais une vente.
 */
export const MEMBRE_DE_LA_VENTE_SQL = `JOIN "CrmCampaignMember" m ON m.campaign_id = v.campaign_id AND m.contact_id = v.contact_id`;

/** État d'une commande du client affichée à côté d'une vente : seules les valides entrent dans les totaux. */
export const ETATS_COMMANDE = ['VALIDE', 'ANNULEE', 'SUPPRIMEE', 'PAIEMENT_EN_ATTENTE'] as const;
export type EtatCommande = (typeof ETATS_COMMANDE)[number];

/**
 * État d'une commande (alias `a` sur "Order"), dans cet ordre : supprimée,
 * annulée, paiement en ligne encore en attente (la règle des commandes
 * effectives), sinon valide. Un mode de paiement absent se lit comme le
 * défaut, en ligne : `COMMANDE_EFFECTIVE_SQL` écarte aussi cette commande-là
 * (la comparaison à NULL la fait sortir), les deux règles disent la même chose.
 */
export function ETAT_COMMANDE_SQL(a: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(a)) throw new Error(`Alias SQL invalide : ${a}`);
  return `CASE WHEN ${a}."entity_status" = 'DELETED' THEN 'SUPPRIMEE'
            WHEN ${a}."status" = 'CANCELLED' THEN 'ANNULEE'
            WHEN coalesce(${a}."payment_method"::text, 'ONLINE') = 'ONLINE' AND ${a}."paied" = false AND ${a}."status" = 'PENDING' THEN 'PAIEMENT_EN_ATTENTE'
            ELSE 'VALIDE' END`;
}

/** Statut d'une commande en français, pour le rapport. */
export const LIBELLES_STATUT_COMMANDE: Record<OrderStatus, string> = {
  PENDING: 'En attente',
  ACCEPTED: 'Nouvelle',
  IN_PROGRESS: 'En préparation',
  READY: 'Prête',
  PICKED_UP: 'En livraison',
  COLLECTED: 'Récupérée',
  COMPLETED: 'Terminée',
  CANCELLED: 'Annulée',
};

/** Ce qui écarte une commande des totaux, en minuscules pour se lire dans une phrase. */
export const LIBELLES_ETAT_COMMANDE: Record<Exclude<EtatCommande, 'VALIDE'>, string> = {
  ANNULEE: 'annulée',
  SUPPRIMEE: 'supprimée',
  PAIEMENT_EN_ATTENTE: 'en attente de paiement',
};

/** Une autre commande du client pendant la campagne. */
export interface AutreCommandeCampagne {
  id: string;
  reference: string;
  cree_le: Date;
  montant: number;
  statut: OrderStatus;
  type: OrderType;
  restaurant: string | null;
  etat: EtatCommande;
}

/** Une vente comptée pour la campagne, telle que la liste et le rapport la montrent. */
export interface VenteCampagne {
  id: string;
  vendu_le: Date;
  /** Montant du registre : celui que le compteur additionne. */
  montant: number;
  /** Public au ciblage. */
  segment: CrmSegment;
  contact: { id: string; nom: string; telephone: string; supprime: boolean };
  /** Null : vente sans agent (répartition manuelle, compte supprimé). */
  agent: { id: string; fullname: string } | null;
  commande: {
    id: string;
    reference: string;
    montant: number;
    statut: OrderStatus;
    type: OrderType;
    restaurant: string | null;
    cree_le: Date;
  } | null;
  coupon: { code: string; offre: string; envoye_le: Date; hors_campagne: boolean } | null;
  /** Code promo de la commande quand aucun coupon du CRM n'y est passé. */
  code_promo: string | null;
  delai_campagne_jours: number | null;
  delai_entree_jours: number | null;
  autres: { nombre: number; valides: number; montant: number; tronque: boolean; commandes: AutreCommandeCampagne[] };
}

/** Autre commande telle que la base la renvoie (JSON : dates en texte). */
export interface AutreCommandeBrute {
  id: string;
  reference: string;
  cree_le: string | Date;
  montant: number | null;
  statut: string;
  type: string;
  restaurant: string | null;
  etat: string;
}

/** Ligne de la requête des ventes, avant mise en forme. */
export interface LigneVenteBrute {
  id: string;
  converted_at: Date;
  montant: number | null;
  cycle: number;
  segment: string;
  joined_at: Date;
  contact_id: string;
  name: string | null;
  phone: string | null;
  fiche_supprimee: boolean | null;
  compte_id: string | null;
  first_name: string | null;
  last_name: string | null;
  tel_compte: string | null;
  agent_id: string | null;
  agent: string | null;
  order_id: string | null;
  reference: string | null;
  montant_commande: number | null;
  statut: string | null;
  type: string | null;
  commande_le: Date | null;
  code_promo: string | null;
  restaurant: string | null;
  coupon_code: string | null;
  coupon_offre: string | null;
  coupon_envoye_le: Date | null;
  coupon_hors_campagne: boolean | null;
  delai_campagne_j: number | null;
  delai_entree_j: number | null;
  autres_nombre: number | null;
  autres_valides: number | null;
  autres_montant: number | null;
  autres: AutreCommandeBrute[] | string | null;
}

const montantArrondi = (n: number | string | null | undefined) => Math.round(Number(n ?? 0) || 0);

/** Délai en jours au dixième, jamais négatif ; null quand il n'est pas mesurable. */
function joursArrondis(n: number | string | null | undefined): number | null {
  if (n == null) return null;
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(0, Math.round(v * 10) / 10) : null;
}

const etatConnu = (e: string): EtatCommande => ((ETATS_COMMANDE as readonly string[]).includes(e) ? (e as EtatCommande) : 'VALIDE');

/**
 * Ligne de la base → vente affichée. `masquer` (consultation) cache le code
 * du coupon et le code promo comme sur les fiches : deux caractères puis des
 * points. Le téléphone reste visible, comme partout en consultation.
 */
export function versVenteCampagne(brut: LigneVenteBrute, options: { masquer: boolean }): VenteCampagne {
  const cacher = (code: string | null) => (code && options.masquer ? codeMasque(code) : code);
  const identite = identiteContact({
    name: brut.name,
    phone: brut.phone,
    customer: brut.compte_id ? { first_name: brut.first_name, last_name: brut.last_name, phone: brut.tel_compte } : null,
  });
  const autresBruts: AutreCommandeBrute[] =
    typeof brut.autres === 'string' ? (JSON.parse(brut.autres) as AutreCommandeBrute[]) : (brut.autres ?? []);
  const commandes = autresBruts.map((a) => ({
    id: a.id,
    reference: a.reference,
    cree_le: new Date(a.cree_le),
    montant: montantArrondi(a.montant),
    statut: a.statut as OrderStatus,
    type: a.type as OrderType,
    restaurant: a.restaurant ?? null,
    etat: etatConnu(a.etat),
  }));
  const nombre = Number(brut.autres_nombre ?? commandes.length);
  return {
    id: brut.id,
    vendu_le: brut.converted_at,
    montant: montantArrondi(brut.montant),
    segment: brut.segment as CrmSegment,
    contact: { id: brut.contact_id, nom: identite.nom, telephone: identite.telephone, supprime: !!brut.fiche_supprimee },
    agent: brut.agent_id ? { id: brut.agent_id, fullname: brut.agent ?? 'Compte sans nom' } : null,
    commande:
      brut.order_id && brut.reference
        ? {
            id: brut.order_id,
            reference: brut.reference,
            montant: montantArrondi(brut.montant_commande),
            statut: brut.statut as OrderStatus,
            type: brut.type as OrderType,
            restaurant: brut.restaurant ?? null,
            cree_le: brut.commande_le as Date,
          }
        : null,
    coupon: brut.coupon_code
      ? {
          code: cacher(brut.coupon_code) as string,
          offre: brut.coupon_offre ?? '',
          envoye_le: brut.coupon_envoye_le as Date,
          hors_campagne: !!brut.coupon_hors_campagne,
        }
      : null,
    code_promo: brut.coupon_code ? null : cacher(brut.code_promo?.trim() || null),
    delai_campagne_jours: joursArrondis(brut.delai_campagne_j),
    delai_entree_jours: joursArrondis(brut.delai_entree_j),
    autres: {
      nombre,
      valides: Number(brut.autres_valides ?? 0),
      montant: montantArrondi(brut.autres_montant),
      tronque: nombre > commandes.length,
      commandes,
    },
  };
}
