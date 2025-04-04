import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AdminNotificationService } from './admin-notification.service';
import { NotificationsService } from './notifications.service';
import { EmailNotificationService } from './email-notification.service';
import { PushNotificationService } from './push-notification.service';
import { Notification, NotificationType } from '../entities/notification.entity';
import { AdminNotificationToUsersDto, AdminBroadcastNotificationDto } from '../dto/admin-notification.dto';
import { CreateNotificationDto } from '../dto/create-notification.dto';

// Désactiver la connexion à la base de données pour les tests unitaires
jest.mock('typeorm', () => {
  const originalModule = jest.requireActual('typeorm');
  return {
    ...originalModule,
    DataSource: jest.fn().mockImplementation(() => ({
      initialize: jest.fn().mockResolvedValue({}),
      isInitialized: true,
      manager: {}
    })),
  };
});

type MockRepository<T = any> = Partial<Record<keyof Repository<T>, jest.Mock>>;

const createMockRepository = <T = any>(): MockRepository<T> => ({
  find: jest.fn(),
  findOne: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
  update: jest.fn(),
  count: jest.fn(),
  remove: jest.fn(),
  delete: jest.fn(),
});

describe('AdminNotificationService', () => {
  let service: AdminNotificationService;
  let notificationsRepository: MockRepository<Notification>;
  let notificationsService: jest.Mocked<NotificationsService>;
  let emailService: jest.Mocked<EmailNotificationService>;
  let pushService: jest.Mocked<PushNotificationService>;

  beforeEach(async () => {
    const mockNotificationsService = {
      create: jest.fn(),
      findByUserId: jest.fn(),
      findOne: jest.fn(),
      markAsRead: jest.fn(),
      markAllAsRead: jest.fn(),
      remove: jest.fn(),
      getPreferences: jest.fn(),
      updatePreferences: jest.fn(),
    };

    const mockEmailService = {
      sendNotificationEmail: jest.fn(),
    };

    const mockPushService = {
      sendPushNotification: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminNotificationService,
        {
          provide: getRepositoryToken(Notification),
          useValue: createMockRepository(),
        },
        {
          provide: NotificationsService,
          useValue: mockNotificationsService,
        },
        {
          provide: EmailNotificationService,
          useValue: mockEmailService,
        },
        {
          provide: PushNotificationService,
          useValue: mockPushService,
        },
      ],
    }).compile();

    service = module.get<AdminNotificationService>(AdminNotificationService);
    notificationsRepository = module.get<MockRepository<Notification>>(getRepositoryToken(Notification));
    notificationsService = module.get(NotificationsService) as jest.Mocked<NotificationsService>;
    emailService = module.get(EmailNotificationService) as jest.Mocked<EmailNotificationService>;
    pushService = module.get(PushNotificationService) as jest.Mocked<PushNotificationService>;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('sendToUsers', () => {
    it('should send notifications to multiple users', async () => {
      // Arrange
      const adminNotificationDto: AdminNotificationToUsersDto = {
        userIds: ['user-1', 'user-2'],
        icon: 'promo-icon',
        iconBgColor: '#4CAF50',
        title: 'Promotion',
        message: 'Profitez de 20% de réduction',
        type: NotificationType.PROMO,
        notifBanner: 'promo-banner.jpg',
        notifTitle: 'Super Promotion',
        data: { promoCode: 'SUMMER20' },
      };

      const now = new Date();
      const mockNotification1 = {
        id: 'notif-1',
        userId: 'user-1',
        icon: adminNotificationDto.icon,
        iconBgColor: adminNotificationDto.iconBgColor,
        title: adminNotificationDto.title,
        message: adminNotificationDto.message,
        type: adminNotificationDto.type,
        notifBanner: adminNotificationDto.notifBanner,
        notifTitle: adminNotificationDto.notifTitle,
        data: adminNotificationDto.data,
        date: now,
        time: '12:00',
        isRead: false,
        showChevron: true,
        createdAt: now,
        updatedAt: now,
      } as Notification;

      const mockNotification2 = {
        id: 'notif-2',
        userId: 'user-2',
        icon: adminNotificationDto.icon,
        iconBgColor: adminNotificationDto.iconBgColor,
        title: adminNotificationDto.title,
        message: adminNotificationDto.message,
        type: adminNotificationDto.type,
        notifBanner: adminNotificationDto.notifBanner,
        notifTitle: adminNotificationDto.notifTitle,
        data: adminNotificationDto.data,
        date: now,
        time: '12:00',
        isRead: false,
        showChevron: true,
        createdAt: now,
        updatedAt: now,
      } as Notification;

      notificationsService.create.mockResolvedValueOnce(mockNotification1);
      notificationsService.create.mockResolvedValueOnce(mockNotification2);

      // Act
      const result = await service.sendToUsers(adminNotificationDto);

      // Assert
      expect(notificationsService.create).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(mockNotification1);
      expect(result[1]).toEqual(mockNotification2);
    });

    it('should handle errors when sending notifications', async () => {
      // Arrange
      const adminNotificationDto: AdminNotificationToUsersDto = {
        userIds: ['user-1', 'user-2'],
        icon: 'promo-icon',
        iconBgColor: '#4CAF50',
        title: 'Promotion',
        message: 'Profitez de 20% de réduction',
        type: NotificationType.PROMO,
        notifBanner: 'promo-banner.jpg',
        notifTitle: 'Super Promotion',
        data: { promoCode: 'SUMMER20' },
      };

      const now = new Date();
      const mockNotification = {
        id: 'notif-1',
        userId: 'user-1',
        icon: adminNotificationDto.icon,
        iconBgColor: adminNotificationDto.iconBgColor,
        title: adminNotificationDto.title,
        message: adminNotificationDto.message,
        type: adminNotificationDto.type,
        notifBanner: adminNotificationDto.notifBanner,
        notifTitle: adminNotificationDto.notifTitle,
        data: adminNotificationDto.data,
        date: now,
        time: '12:00',
        isRead: false,
        showChevron: true,
        createdAt: now,
        updatedAt: now,
      } as Notification;

      // Configurer les mocks pour simuler une réussite pour le premier utilisateur
      // et une erreur pour le second
      notificationsService.create.mockImplementation((dto: CreateNotificationDto) => {
        if (dto.userId === 'user-1') {
          return Promise.resolve(mockNotification);
        } else {
          return Promise.reject(new Error('Database error'));
        }
      });

      // Act
      const result = await service.sendToUsers(adminNotificationDto);

      // Assert
      expect(notificationsService.create).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(mockNotification);
    });
  });

  describe('broadcast', () => {
    it('should broadcast notifications to all users', async () => {
      // Arrange
      const broadcastDto: AdminBroadcastNotificationDto = {
        broadcast: true,
        icon: 'info-icon',
        iconBgColor: '#2196F3',
        title: 'Maintenance',
        message: 'Maintenance prévue ce soir',
        type: NotificationType.INFO,
        sendEmail: true,
        sendPush: true,
        notifBanner: 'maintenance-banner.jpg',
        notifTitle: 'Information Importante',
      };

      const now = new Date();
      notificationsService.create.mockResolvedValue({
        id: 'notif-id',
        userId: 'any-user',
        icon: broadcastDto.icon,
        iconBgColor: broadcastDto.iconBgColor,
        title: broadcastDto.title,
        message: broadcastDto.message,
        type: broadcastDto.type,
        date: now,
        time: '12:00',
        isRead: false,
        notifBanner: broadcastDto.notifBanner,
        notifTitle: broadcastDto.notifTitle,
        showChevron: true,
        createdAt: now,
        updatedAt: now,
      } as Notification);

      // Mock pour simuler 10 utilisateurs dans la base de données
      notificationsRepository.count.mockResolvedValue(10);

      // Act
      const result = await service.broadcast(broadcastDto);

      // Assert
      expect(result).toBeDefined();
      expect(result.count).toBe(10);
      expect(notificationsService.create).toHaveBeenCalledTimes(10);
    });

    it('should handle broadcast with specific users', async () => {
      // Arrange
      // Utilisation d'un objet AdminNotificationToUsersDto pour tester l'envoi à des utilisateurs spécifiques
      const notificationToUsersDto: AdminNotificationToUsersDto = {
        userIds: ['user-1', 'user-2', 'user-3'],
        icon: 'info-icon',
        iconBgColor: '#2196F3',
        title: 'Maintenance',
        message: 'Maintenance prévue ce soir',
        type: NotificationType.INFO,
        notifBanner: 'maintenance-banner.jpg',
        notifTitle: 'Information Importante',
      };

      const now = new Date();
      // Mock pour les 3 utilisateurs spécifiés
      for (let i = 0; i < 3; i++) {
        notificationsService.create.mockResolvedValueOnce({
          id: `notif-${i}`,
          userId: `user-${i + 1}`,
          icon: notificationToUsersDto.icon,
          iconBgColor: notificationToUsersDto.iconBgColor,
          title: notificationToUsersDto.title,
          message: notificationToUsersDto.message,
          type: notificationToUsersDto.type,
          date: now,
          time: '12:00',
          isRead: false,
          notifBanner: notificationToUsersDto.notifBanner,
          notifTitle: notificationToUsersDto.notifTitle,
          showChevron: true,
          createdAt: now,
          updatedAt: now,
        } as Notification);
      }

      // Act - Nous testons ici la méthode sendToUsers plutôt que broadcast
      const result = await service.sendToUsers(notificationToUsersDto);

      // Assert
      expect(result).toBeDefined();
      expect(result.length).toBe(3);
      expect(notificationsService.create).toHaveBeenCalledTimes(3);
    });
  });

  describe('cleanupOldNotifications', () => {
    it('should delete old notifications of a specific type', async () => {
      // Arrange
      const type = NotificationType.PROMO;
      const cutoffDate = new Date();
      cutoffDate.setMonth(cutoffDate.getMonth() - 1); // 1 mois en arrière

      notificationsRepository.delete.mockResolvedValue({ affected: 5 });

      // Act
      const result = await service.cleanupOldNotifications(type, cutoffDate);

      // Assert
      expect(result).toBeDefined();
      expect(result.count).toBe(5);
      expect(notificationsRepository.delete).toHaveBeenCalledWith({
        type,
        createdAt: expect.any(Object),
      });
    });
  });
});
