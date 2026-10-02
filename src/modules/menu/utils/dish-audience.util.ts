import { Customer, DishAudience, LoyaltyLevel, Prisma, ProfileType } from '@prisma/client';

/**
 * Contexte d'audience résolu pour UNE requête de lecture de plats/catégories.
 *
 *  - `apply: false` → AUCUN filtre (staff en gestion des menus, ou appel interne).
 *  - `apply: true` + `customer` → filtre par CE client (client app connecté, ou
 *    client cible d'une prise de commande backoffice).
 *  - `apply: true` sans `customer` → invité : plats PUBLIC uniquement.
 *
 * Voir {@link DishService.resolveAudience} pour la résolution depuis la requête.
 */
export type AudienceContext = {
  apply: boolean;
  customer?: Customer;
  /**
   * Vrai UNIQUEMENT si un membre du personnel authentifié est à l'origine de la
   * requête. Sert à décider qui a le droit de voir les plats composables
   * ({@link composableClause}). Volontairement distinct de `apply: false`, qui
   * vaut aussi pour les appels internes sans principal.
   */
  staff?: boolean;
  /**
   * L'application appelante sait afficher un écran de composition et
   * transmettre les choix du client. Déclaré par l'en-tête `x-app-composable`.
   * Voir {@link litCapaciteComposable}.
   */
  composable?: boolean;
};

/**
 * MENUS COMPOSABLES — la capacité déclarée par l'application appelante.
 *
 * Une application déjà installée sur un téléphone ne peut plus gagner d'en-tête.
 * Celle qui envoie celui-ci a donc forcément été publiée après l'écran de
 * composition : c'est une preuve, pas une déclaration de bonne foi.
 *
 * La version native ne convient pas comme critère : les mises à jour à distance
 * changent le code sans la changer. Un en-tête posé dans le paquet JavaScript,
 * lui, suit exactement le code réellement exécuté.
 */
export function litCapaciteComposable(headers: unknown): boolean {
  if (!headers || typeof headers !== 'object') return false;
  const brut = (headers as Record<string, unknown>)['x-app-composable'];
  const valeur = Array.isArray(brut) ? brut[0] : brut;
  return valeur === '1' || valeur === 'true';
}

/**
 * Ciblage d'audience des plats.
 *
 * Un plat porte `audiences: DishAudience[]` :
 *  - `[]`  → PUBLIC (visible par tout le monde, y compris invité) ;
 *  - sinon → visible UNIQUEMENT par les clients dont l'audience recoupe la liste.
 *
 * L'audience d'un CLIENT = { ETUDIANT si profil étudiant } ∪ { son niveau de
 * fidélité EXACT }. Match STRICT (pas cumulatif) : un plat `[VIP]` n'est PAS vu
 * par un VVIP tant que `VVIP` n'est pas coché aussi. Un invité (pas de client)
 * n'a aucune audience → ne voit que les plats PUBLIC.
 */

type AudienceCustomer = {
  profile_type?: ProfileType | null;
  loyalty_level?: LoyaltyLevel | null;
} | null | undefined;

const LEVEL_TO_AUDIENCE: Record<LoyaltyLevel, DishAudience> = {
  [LoyaltyLevel.STANDARD]: DishAudience.STANDARD,
  [LoyaltyLevel.VIP]: DishAudience.VIP,
  [LoyaltyLevel.VVIP]: DishAudience.VVIP,
};

/** Ensemble des audiences que ce client peut voir (hors PUBLIC, géré à part). */
export function customerAudiences(customer: AudienceCustomer): DishAudience[] {
  if (!customer) return [];
  const set: DishAudience[] = [];
  if (customer.profile_type === ProfileType.ETUDIANT) {
    set.push(DishAudience.ETUDIANT);
  }
  // Niveau null (jamais calculé) traité comme STANDARD par défaut.
  const level = customer.loyalty_level ?? LoyaltyLevel.STANDARD;
  set.push(LEVEL_TO_AUDIENCE[level]);
  return set;
}

/**
 * MENUS COMPOSABLES — verrou de visibilité.
 *
 * Un plat composable ne se commande correctement qu'avec un écran capable
 * d'afficher ses groupes d'options. Les applications déjà installées sur les
 * téléphones ne l'ont pas : elles afficheraient un burger à son prix de base,
 * sans sauce ni format, et enverraient une commande au mauvais prix.
 *
 * La règle est donc VERROUILLÉE PAR DÉFAUT. Deux appelants seulement passent :
 *
 *  - le PERSONNEL authentifié, qui configure ces plats et prend des commandes ;
 *  - une APPLICATION qui déclare savoir composer, par l'en-tête
 *    `x-app-composable` ({@link litCapaciteComposable}).
 *
 * Tout le reste, y compris les appels internes et les routes sans
 * authentification, ne les voit pas. Une version installée avant l'écran de
 * composition n'envoie pas cet en-tête et reste donc aveugle sans qu'on ait à
 * tenir la moindre liste de versions.
 *
 * Renvoie `{}` quand il n'y a rien à filtrer, pour ne pas polluer les `where`.
 */
export function composableClause(audience: AudienceContext): Prisma.DishWhereInput {
  return audience.staff || audience.composable ? {} : { composable: false };
}

/**
 * Clause Prisma à combiner (via AND) dans le `where` des listes de plats côté
 * app. À placer dans un tableau `AND: [dishAudienceClause(customer)]` pour ne
 * jamais entrer en conflit avec un éventuel `OR` de recherche déjà présent.
 */
export function dishAudienceClause(customer: AudienceCustomer): Prisma.DishWhereInput {
  const mine = customerAudiences(customer);
  if (mine.length === 0) {
    // Invité → uniquement les plats publics (audiences vide).
    return { audiences: { isEmpty: true } };
  }
  return {
    OR: [
      { audiences: { isEmpty: true } }, // PUBLIC
      { audiences: { hasSome: mine } }, // partage au moins une audience
    ],
  };
}

/** Ce que le contrôle des plats réservés lit d'un plat. */
export type PlatAudience = {
  id: string;
  name: string;
  audiences?: DishAudience[] | null;
};

/**
 * PLATS RÉSERVÉS À LA COMMANDE (02/10).
 *
 * Le masque ci-dessus ne s'applique qu'à certaines LECTURES du menu. Un plat
 * réservé restait commandable par quiconque connaissait son identifiant (lien
 * direct, favori, `/dishes/get-all` public), au prix promotionnel s'il en a
 * un. Cette règle est le contrôle de la création de commande.
 *
 * Même correspondance que {@link dishAudienceClause}, pour qu'un client ne
 * puisse commander que ce qu'on lui montre : une ligne passe si son plat est
 * public (`audiences` vide ou absent) ou partage au moins une audience avec le
 * client ({@link customerAudiences}). Un invité ne passe que sur les plats
 * publics.
 *
 * Lignes ignorées :
 *  - celles de `lignesExemptees` : les lignes-cadeau déjà VALIDÉES
 *    (`validateGiftLines`). Un lot Gratte&Gagne ou un parrainage peut offrir
 *    un plat réservé, et une telle ligne est forcée à une unité et 0 F : elle
 *    ne permet pas d'acheter le plat. Une ligne PAYANTE du même plat, elle,
 *    reste contrôlée ;
 *  - celles dont le plat est absent de `plats` : la lecture des plats a déjà
 *    refusé ce cas avant d'arriver ici.
 *
 * Renvoie les plats refusés, chacun une seule fois, dans l'ordre du panier.
 */
export function platsHorsAudience<P extends PlatAudience>(
  lignes: readonly { dish_id: string }[],
  plats: readonly P[],
  client: AudienceCustomer,
  lignesExemptees: ReadonlySet<number> = new Set(),
): P[] {
  const mine = customerAudiences(client);
  const parId = new Map(plats.map((plat) => [plat.id, plat]));
  const refuses = new Map<string, P>();
  lignes.forEach((ligne, index) => {
    if (lignesExemptees.has(index)) return;
    const plat = parId.get(ligne.dish_id);
    if (!plat) return;
    const audiences = plat.audiences ?? [];
    if (audiences.length === 0) return;
    if (audiences.some((audience) => mine.includes(audience))) return;
    if (!refuses.has(plat.id)) refuses.set(plat.id, plat);
  });
  return [...refuses.values()];
}

/** À qui un plat est réservé, tel que le client le lit. */
const LIBELLE_AUDIENCE: Record<DishAudience, string> = {
  [DishAudience.ETUDIANT]: 'aux étudiants',
  [DishAudience.STANDARD]: 'aux clients du niveau Standard',
  [DishAudience.VIP]: 'aux clients VIP',
  [DishAudience.VVIP]: 'aux clients VVIP',
};

/** Ordre de lecture fixe, quel que soit l'ordre des cases cochées. */
const ORDRE_AUDIENCES: DishAudience[] = [
  DishAudience.ETUDIANT,
  DishAudience.STANDARD,
  DishAudience.VIP,
  DishAudience.VVIP,
];

/** « aux étudiants ou aux clients VIP ». */
export function libelleReservation(audiences: readonly DishAudience[] | null | undefined): string {
  return ORDRE_AUDIENCES.filter((audience) => (audiences ?? []).includes(audience))
    .map((audience) => LIBELLE_AUDIENCE[audience])
    .join(' ou ');
}

function listerNoms(noms: string[]): string {
  const cites = noms.map((nom) => `« ${nom} »`);
  return cites.length <= 1 ? cites.join('') : `${cites.slice(0, -1).join(', ')} et ${cites[cites.length - 1]}`;
}

/**
 * Message de refus, montré tel quel par l'application et par le site. Il
 * nomme chaque plat : le panier est conservé sur le téléphone, et le client
 * doit savoir lequel retirer.
 *
 * « Le plat « Menu Campus » est réservé aux étudiants. Retirez-le du panier
 * pour continuer. » Les plats réservés au même public sont regroupés.
 *
 * ⚠️ Ne jamais y écrire « en choisissant ses options » : l'application
 * reconnaît cette phrase et affiche à la place un écran de mise à jour.
 */
export function messagePlatsReserves(plats: readonly PlatAudience[]): string {
  const groupes = new Map<string, string[]>();
  for (const plat of plats) {
    const pour = libelleReservation(plat.audiences);
    groupes.set(pour, [...(groupes.get(pour) ?? []), plat.name]);
  }
  const phrases = [...groupes].map(([pour, noms]) =>
    noms.length === 1
      ? `Le plat ${listerNoms(noms)} est réservé ${pour}.`
      : `Les plats ${listerNoms(noms)} sont réservés ${pour}.`,
  );
  const consigne = plats.length > 1 ? 'Retirez-les du panier pour continuer.' : 'Retirez-le du panier pour continuer.';
  return [...phrases, consigne].join(' ');
}
