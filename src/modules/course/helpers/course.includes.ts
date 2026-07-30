/**
 * Include Prisma partagé pour le détail d'une Course.
 *
 * Centralisé ici pour garantir que :
 *  - les queries (getCurrent, findOne, findAllAdmin) retournent la structure complète
 *  - les émissions WebSocket (offerNew, courseAssigned, courseStatutChanged, courseCompleted,
 *    courseCancelled) transportent la même structure que le mobile/backoffice attendent
 *
 * Bug historique : utiliser `include: { deliveries: true }` (shallow) cassait les mappers côté
 * mobile qui lisent `course.restaurant.name` ou `delivery.order.*`.
 *
 * 🔒 `delivery_pin` est OMIS ici (même logique que la clé API restaurant) :
 * ce payload part vers l'app LIVREUR et les rooms WebSocket — or le code à
 * 4 chiffres est le secret que LE CLIENT donne au livreur pour prouver la
 * remise. S'il voyageait dans le payload, un livreur pourrait auto-valider
 * ses livraisons sans voir le client. Le staff, lui, le voit via
 * `COURSE_ADMIN_INCLUDE` (support : client qui a perdu son code).
 */
export const COURSE_FULL_INCLUDE = {
  deliveries: {
    orderBy: { sequence_order: 'asc' as const },
    omit: { delivery_pin: true },
    include: {
      order: {
        select: {
          id: true,
          reference: true,
          status: true,
          paied: true,
          payment_method: true,
          amount: true,
          net_amount: true,
          delivery_fee: true,
          address: true,
          fullname: true,
          phone: true,
          note: true,
          customer: {
            select: { id: true, first_name: true, last_name: true, phone: true },
          },
          // P-fix #4 (audit) : real order_items pour que le drawer mobile et
          // les bottom cards affichent la vraie liste des plats commandés
          // ("2× Poulet Burger, 1× Frites") au lieu du fallback "Commande {ref}".
          order_items: {
            select: {
              id: true,
              quantity: true,
              amount: true,
              epice: true,
              dish: {
                select: { id: true, name: true, image: true },
              },
            },
          },
        },
      },
    },
  },
  restaurant: {
    select: {
      id: true,
      name: true,
      image: true,
      address: true,
      latitude: true,
      longitude: true,
    },
  },
  deliverer: {
    select: {
      id: true,
      reference: true,
      first_name: true,
      last_name: true,
      phone: true,
      image: true,
    },
  },
} as const;

/**
 * Variante BACKOFFICE (staff uniquement — `findAllAdmin`, `findOne` admin) :
 * identique à `COURSE_FULL_INCLUDE` mais AVEC `delivery_pin` sur chaque
 * livraison. Le staff doit pouvoir lire le code de récupération au client
 * (support : client qui ne retrouve plus son code, litige de remise).
 * ⚠️ Ne JAMAIS utiliser sur un endpoint ou une émission destinés au livreur.
 */
export const COURSE_ADMIN_INCLUDE = {
  ...COURSE_FULL_INCLUDE,
  deliveries: {
    ...COURSE_FULL_INCLUDE.deliveries,
    omit: { delivery_pin: false },
  },
} as const;
