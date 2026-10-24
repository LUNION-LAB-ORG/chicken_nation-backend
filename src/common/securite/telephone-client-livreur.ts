import { CourseStatut, DeliveryStatut } from '@prisma/client';

/**
 * Numéro du client chez le livreur : le temps de la livraison, pas au-delà.
 *
 * Pendant la course, le livreur appelle le client (portail fermé, adresse
 * floue, client absent) : rien ne change. Une fois la livraison finie
 * (livrée, échouée, annulée) ou la course close (terminée, annulée, expirée),
 * il n'a plus aucune raison de garder le numéro. Il ne le retrouve ni dans
 * son historique, ni dans le détail d'une course passée, ni dans un
 * événement du socket.
 *
 * Le numéro devient `null`, jamais une valeur masquée : un numéro en points
 * aurait l'air composable, un numéro absent n'affiche pas de bouton d'appel.
 * Le WhatsApp du client est ce même numéro : il part avec.
 *
 * Seules les réponses et les émissions destinées au LIVREUR passent par ici.
 * Le personnel (backoffice, caisse) et le client gardent le numéro.
 */

const COURSES_TERMINEES: ReadonlySet<string> = new Set<string>([
  CourseStatut.COMPLETED,
  CourseStatut.CANCELLED,
  CourseStatut.EXPIRED,
]);

const LIVRAISONS_TERMINEES: ReadonlySet<string> = new Set<string>([
  DeliveryStatut.DELIVERED,
  DeliveryStatut.FAILED,
  DeliveryStatut.CANCELLED,
]);

/** Au-delà, on rend la valeur telle quelle : garde-fou contre un cycle. */
const PROFONDEUR_MAX = 10;

/**
 * Le livreur peut-il encore lire le numéro du client de cette livraison ?
 * Non dès que la course OU la livraison est terminée.
 */
export function telephoneClientVisible(
  statutCourse: string | null | undefined,
  statutLivraison: string | null | undefined,
): boolean {
  if (statutCourse && COURSES_TERMINEES.has(statutCourse)) return false;
  if (statutLivraison && LIVRAISONS_TERMINEES.has(statutLivraison)) return false;
  return true;
}

/**
 * Retire le numéro du client des livraisons terminées, où que la course se
 * trouve dans la charge utile : course seule, `{ course }` d'un événement,
 * `{ offer_id, course }` d'une offre, `{ items: [course] }` de l'historique.
 *
 * Une course se reconnaît à sa liste `deliveries` ; pour chaque livraison,
 * `order.phone` et `order.customer.phone` passent à `null`. Le reste ne
 * bouge pas.
 *
 * Copie à l'écriture, comme `sansSecretsRestaurant` : rien à retirer, la
 * charge utile ressort à l'identique, même référence. L'objet reçu n'est
 * jamais modifié : la même course part aussi au backoffice et au restaurant,
 * qui gardent le numéro. Seuls les objets simples et les tableaux sont
 * parcourus ; une Date ou un Decimal passent sans être touchés.
 */
export function sansTelephoneClientTermine<T>(donnees: T): T {
  return parcourir(donnees, 0) as T;
}

function estObjetSimple(valeur: unknown): valeur is Record<string, unknown> {
  if (valeur === null || typeof valeur !== 'object' || Array.isArray(valeur)) return false;
  const prototype = Object.getPrototypeOf(valeur) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function parcourir(valeur: unknown, profondeur: number): unknown {
  if (valeur === null || typeof valeur !== 'object' || profondeur > PROFONDEUR_MAX) {
    return valeur;
  }

  if (Array.isArray(valeur)) {
    let copie: unknown[] | null = null;
    for (let i = 0; i < valeur.length; i++) {
      const avant: unknown = valeur[i];
      const apres = parcourir(avant, profondeur + 1);
      if (apres !== avant) {
        copie ??= valeur.slice();
        copie[i] = apres;
      }
    }
    return copie ?? valeur;
  }

  if (!estObjetSimple(valeur)) return valeur;
  if (Array.isArray(valeur.deliveries)) return course(valeur);

  let copie: Record<string, unknown> | null = null;
  for (const cle of Object.keys(valeur)) {
    const avant = valeur[cle];
    const apres = parcourir(avant, profondeur + 1);
    if (apres !== avant) {
      copie ??= { ...valeur };
      copie[cle] = apres;
    }
  }
  return copie ?? valeur;
}

function course(source: Record<string, unknown>): Record<string, unknown> {
  const statutCourse = typeof source.statut === 'string' ? source.statut : null;
  const livraisons = source.deliveries as unknown[];
  let copie: unknown[] | null = null;
  for (let i = 0; i < livraisons.length; i++) {
    const avant = livraisons[i];
    const apres = livraison(avant, statutCourse);
    if (apres !== avant) {
      copie ??= livraisons.slice();
      copie[i] = apres;
    }
  }
  return copie ? { ...source, deliveries: copie } : source;
}

function livraison(valeur: unknown, statutCourse: string | null): unknown {
  if (!estObjetSimple(valeur)) return valeur;
  const statut = typeof valeur.statut === 'string' ? valeur.statut : null;
  if (telephoneClientVisible(statutCourse, statut)) return valeur;

  const commande = valeur.order;
  if (!estObjetSimple(commande)) return valeur;
  const sansNumero = sansTelephone(commande);
  const client = commande.customer;
  const clientSansNumero = estObjetSimple(client) ? sansTelephone(client) : client;
  if (sansNumero === commande && clientSansNumero === client) return valeur;

  return {
    ...valeur,
    order: clientSansNumero === client ? sansNumero : { ...sansNumero, customer: clientSansNumero },
  };
}

function sansTelephone(source: Record<string, unknown>): Record<string, unknown> {
  if (!('phone' in source) || source.phone === null) return source;
  return { ...source, phone: null };
}
