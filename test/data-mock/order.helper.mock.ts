export const orderHelperMock = {
  resolveCustomerData: jest.fn().mockResolvedValue({
    customer_id: 'uuid-customer',
    fullname: 'John Doe',
    phone: '0123456789',
    email: 'john@example.com',
    loyalty_level: 1,
    total_points: 100,
  }),

  getNearestRestaurant: jest.fn().mockResolvedValue({
    id: 'uuid-restaurant',
    name: 'Restaurant Mock',
    latitude: 5.356,
    longitude: -3.988,
    schedule: JSON.stringify([]),
  }),

  getClosestRestaurant: jest.fn().mockImplementation(({ restaurant_id, address }) => {
    return Promise.resolve({
      id: restaurant_id || 'uuid-restaurant',
      name: 'Restaurant Mock',
      latitude: 5.356,
      longitude: -3.988,
      schedule: JSON.stringify([]),
    });
  }),

  getDishesWithDetails: jest.fn().mockResolvedValue([]),

  validateAddress: jest.fn().mockImplementation(async (address: string) => {
    return JSON.parse(address || '{"latitude":5.356,"longitude":-3.988,"title":"Home","address":"Cocody"}');
  }),

  applyPromoCode: jest.fn().mockResolvedValue(0),

  calculateOrderDetails: jest.fn().mockResolvedValue({
    orderItems: [],
    netAmount: 20,
    totalDishes: 2,
    totalSupplements: 0,
  }),

  calculatePromotionPrice: jest.fn().mockResolvedValue(null),

  calculateLoyaltyFee: jest.fn().mockResolvedValue(0),

  calculateTax: jest.fn().mockResolvedValue(1),

  calculateDeliveryFee: jest.fn().mockResolvedValue(1000),

  calculateEstimatedTime: jest.fn().mockImplementation((timeStr: string) => new Date()),

  sendOrderNotifications: jest.fn().mockResolvedValue(undefined),

  validateStatusTransition: jest.fn(),

  handleStatusSpecificActions: jest.fn().mockResolvedValue(undefined),

  checkPayment: jest.fn().mockResolvedValue({
    id: 'payment-1',
    amount: 2000,
    created_at: new Date(),
  }),

  buildWhereClause: jest.fn().mockImplementation((filters) => ({
    entity_status: { not: 'DELETED' },
    ...filters,
  })),
};
