import { Test, TestingModule } from '@nestjs/testing';
import { AdminNotificationsController } from './admin-notifications.controller';
import { AdminNotificationService } from '../services/admin-notification.service';
import { Notification, NotificationType } from '../entities/notification.entity';
import { AdminNotificationToUsersDto, AdminBroadcastNotificationDto } from '../dto/admin-notification.dto';

describe('AdminNotificationsController', () => {
  let controller: AdminNotificationsController;
  let adminNotificationService: jest.Mocked<AdminNotificationService>;

  beforeEach(async () => {
    const mockAdminNotificationService = {
      sendToUsers: jest.fn(),
      broadcast: jest.fn(),
      cleanupOldNotifications: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminNotificationsController],
      providers: [
        {
          provide: AdminNotificationService,
          useValue: mockAdminNotificationService,
        },
      ],
    }).compile();

    controller = module.get<AdminNotificationsController>(AdminNotificationsController);
    adminNotificationService = module.get(AdminNotificationService) as jest.Mocked<AdminNotificationService>;
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('sendToUsers', () => {
    it('should send notifications to specified users', async () => {
      // Arrange
      const dto: AdminNotificationToUsersDto = {
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

      const mockNotifications: Notification[] = [
        {
          id: 'notif-1',
          userId: 'user-1',
          ...dto,
          date: new Date(),
          time: '14:30',
          isRead: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as Notification,
        {
          id: 'notif-2',
          userId: 'user-2',
          ...dto,
          date: new Date(),
          time: '14:30',
          isRead: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as Notification,
      ];

      adminNotificationService.sendToUsers.mockResolvedValue(mockNotifications);

      // Act
      const result = await controller.sendToUsers(dto);

      // Assert
      expect(adminNotificationService.sendToUsers).toHaveBeenCalledWith(dto);
      expect(result).toEqual(mockNotifications);
    });
  });

  describe('broadcast', () => {
    it('should broadcast notifications to all users', async () => {
      // Arrange
      const dto: AdminBroadcastNotificationDto = {
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

      const mockResult = { count: 10 };

      adminNotificationService.broadcast.mockResolvedValue(mockResult);

      // Act
      const result = await controller.broadcast(dto);

      // Assert
      expect(adminNotificationService.broadcast).toHaveBeenCalledWith(dto);
      expect(result).toEqual(mockResult);
    });
  });

  describe('cleanupOldNotifications', () => {
    it('should clean up old notifications of a specific type', async () => {
      // Arrange
      const type = 'promo';
      const olderThan = '2023-01-01';
      const mockResult = { count: 5 };

      adminNotificationService.cleanupOldNotifications.mockResolvedValue(mockResult);

      // Act
      const result = await controller.cleanupOldNotifications(type, olderThan);

      // Assert
      expect(adminNotificationService.cleanupOldNotifications).toHaveBeenCalledWith(
        type,
        new Date(olderThan),
      );
      expect(result).toEqual(mockResult);
    });

    it('should use default date when olderThan is not provided', async () => {
      // Arrange
      const type = 'promo';
      const mockResult = { count: 5 };

      adminNotificationService.cleanupOldNotifications.mockResolvedValue(mockResult);

      // Act
      const result = await controller.cleanupOldNotifications(type);

      // Assert
      expect(adminNotificationService.cleanupOldNotifications).toHaveBeenCalledWith(
        type,
        undefined,
      );
      expect(result).toEqual(mockResult);
    });
  });
});
