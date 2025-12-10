export const orderEventMock = {
  orderCreatedEvent: jest.fn().mockResolvedValue(undefined),
  orderStatusUpdatedEvent: jest.fn().mockResolvedValue(undefined),
  orderUpdatedEvent: jest.fn().mockResolvedValue(undefined),
  orderDeletedEvent: jest.fn().mockResolvedValue(undefined),
};
