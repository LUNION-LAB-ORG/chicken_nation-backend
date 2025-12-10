export const prismaMock = {
  order: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },

  user: {
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },

  restaurant: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },

  // 👉 Ajout du mock de la transaction
  $transaction: jest.fn((operations) => {
    // Exécute les opérations comme Prisma le ferait
    return Promise.all(operations);
  }),
};
