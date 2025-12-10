export const generateDataServiceMock = {
  generateOrderReference: jest.fn().mockReturnValue('ORD-251209-12345'),
  generateSecurePassword: jest.fn().mockReturnValue('Aa1@securePwd'),
  toRadians: jest.fn().mockImplementation((deg: number) => deg * (Math.PI / 180)),
  haversineDistance: jest.fn().mockImplementation((lat1, lon1, lat2, lon2) => 5), // distance fictive
  generateImageName: jest.fn().mockResolvedValue('image_1234567890'),
  generateSecureImageName: jest.fn().mockResolvedValue('image_1234567890'),
  decryptSecureImageName: jest.fn().mockResolvedValue('image_1234567890'),
  generateCipher: jest.fn().mockResolvedValue('ciphered-text'),
  generateDecipher: jest.fn().mockResolvedValue('plain-text'),
};
