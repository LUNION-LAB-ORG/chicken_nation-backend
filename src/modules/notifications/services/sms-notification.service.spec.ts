import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SmsNotificationService } from './sms-notification.service';
import { Notification, NotificationType } from '../entities/notification.entity';

describe('SmsNotificationService', () => {
  let service: SmsNotificationService;
  let configService: jest.Mocked<ConfigService>;

  beforeEach(async () => {
    const mockConfigService = {
      get: jest.fn().mockImplementation((key, defaultValue) => {
        if (key === 'APP_URL') return 'http://test-app.com';
        return defaultValue;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SmsNotificationService,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<SmsNotificationService>(SmsNotificationService);
    configService = module.get(ConfigService) as jest.Mocked<ConfigService>;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('sendNotificationSms', () => {
    it('should successfully send an SMS notification', async () => {
      // Arrange
      const notification: Notification = {
        id: 'notif-123',
        userId: 'user-123',
        title: 'Commande confirmée',
        message: 'Votre commande #12345 a été confirmée',
        type: NotificationType.ORDER,
        icon: 'order-icon',
        iconBgColor: '#4CAF50',
        date: new Date(),
        time: '14:30',
        isRead: false,
        notifBanner: 'order-banner.jpg',
        notifTitle: 'Confirmation de commande',
        showChevron: true,
        data: { orderId: '12345' },
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Notification;

      const phoneNumber = '+33612345678';

      // Espionner la méthode console.log pour vérifier qu'elle est appelée
      const logSpy = jest.spyOn(console, 'log').mockImplementation();
      // Remplacer le logger interne du service
      const loggerSpy = jest.spyOn(service['logger'], 'log').mockImplementation();

      // Act
      const result = await service.sendNotificationSms(notification, phoneNumber);

      // Assert
      expect(result).toBe(true);
      expect(loggerSpy).toHaveBeenCalled();
      expect(loggerSpy.mock.calls[0][0]).toContain(phoneNumber);
      
      // Restaurer les mocks
      logSpy.mockRestore();
      loggerSpy.mockRestore();
    });

    it('should handle errors when sending SMS', async () => {
      // Arrange
      const notification: Notification = {
        id: 'notif-123',
        userId: 'user-123',
        title: 'Commande confirmée',
        message: 'Votre commande #12345 a été confirmée',
        type: NotificationType.ORDER,
        icon: 'order-icon',
        iconBgColor: '#4CAF50',
        date: new Date(),
        time: '14:30',
        isRead: false,
        notifBanner: 'order-banner.jpg',
        notifTitle: 'Confirmation de commande',
        showChevron: true,
        data: { orderId: '12345' },
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Notification;

      const phoneNumber = '+33612345678';

      // Simuler une erreur lors de l'envoi
      jest.spyOn(global, 'setTimeout').mockImplementation(() => {
        throw new Error('SMS sending failed');
      });

      // Espionner la méthode console.error
      const errorSpy = jest.spyOn(service['logger'], 'error').mockImplementation();

      // Act
      const result = await service.sendNotificationSms(notification, phoneNumber);

      // Assert
      expect(result).toBe(false);
      expect(errorSpy).toHaveBeenCalled();
      expect(errorSpy.mock.calls[0][0]).toContain('Erreur lors de l\'envoi du SMS');
      
      // Restaurer les mocks
      errorSpy.mockRestore();
      jest.restoreAllMocks();
    });
  });

  describe('formatSmsContent', () => {
    it('should format SMS content correctly with link', () => {
      // Arrange
      const notification: Notification = {
        id: 'notif-123',
        userId: 'user-123',
        title: 'Promotion',
        message: 'Profitez de 20% de réduction',
        type: NotificationType.PROMO,
        icon: 'promo-icon',
        iconBgColor: '#FF5722',
        date: new Date(),
        time: '14:30',
        isRead: false,
        notifBanner: 'promo-banner.jpg',
        notifTitle: 'Super Promotion',
        showChevron: true,
        data: { link: '/promotions/summer' },
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Notification;

      // Act
      const result = service['formatSmsContent'](notification);

      // Assert
      expect(result).toContain('Promotion: Profitez de 20% de réduction');
      expect(result).toContain('http://test-app.com/promotions/summer');
    });

    it('should format SMS content correctly without link', () => {
      // Arrange
      const notification: Notification = {
        id: 'notif-123',
        userId: 'user-123',
        title: 'Information',
        message: 'Votre compte a été créé avec succès',
        type: NotificationType.INFO,
        icon: 'info-icon',
        iconBgColor: '#2196F3',
        date: new Date(),
        time: '14:30',
        isRead: false,
        notifBanner: 'info-banner.jpg',
        notifTitle: 'Information',
        showChevron: true,
        data: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Notification;

      // Act
      const result = service['formatSmsContent'](notification);

      // Assert
      expect(result).toEqual('Information: Votre compte a été créé avec succès');
    });

    it('should truncate long SMS content', () => {
      // Arrange
      const longMessage = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.';
      const notification: Notification = {
        id: 'notif-123',
        userId: 'user-123',
        title: 'Information',
        message: longMessage,
        type: NotificationType.INFO,
        icon: 'info-icon',
        iconBgColor: '#2196F3',
        date: new Date(),
        time: '14:30',
        isRead: false,
        notifBanner: 'info-banner.jpg',
        notifTitle: 'Information',
        showChevron: true,
        data: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Notification;

      // Act
      const result = service['formatSmsContent'](notification);

      // Assert
      expect(result.length).toBeLessThanOrEqual(160);
      expect(result.endsWith('...')).toBe(true);
    });
  });
});
