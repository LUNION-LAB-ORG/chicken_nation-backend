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
 */
export const COURSE_FULL_INCLUDE = {
  deliveries: {
    orderBy: { sequence_order: 'asc' as const },
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
