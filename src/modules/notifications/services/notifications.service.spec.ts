import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationsService } from './notifications.service';
import { Notification, NotificationType } from '../entities/notification.entity';
import { NotificationPreference } from '../entities/notification-preference.entity';
import { CreateNotificationDto } from '../dto/create-notification.dto';
import { UpdateNotificationStatusDto } from '../dto/update-notification-status.dto';
import { UpdateNotificationPreferenceDto } from '../dto/update-notification-preference.dto';
import { NotFoundException } from '@nestjs/common';

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

describe('NotificationsService', () => {
  let service: NotificationsService;
  let notificationsRepository: MockRepository<Notification>;
  let preferencesRepository: MockRepository<NotificationPreference>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        {
          provide: getRepositoryToken(Notification),
          useValue: createMockRepository(),
        },
        {
          provide: getRepositoryToken(NotificationPreference),
          useValue: createMockRepository(),
        },
      ],
    }).compile();

    service = module.get<NotificationsService>(NotificationsService);
    notificationsRepository = module.get<MockRepository<Notification>>(getRepositoryToken(Notification));
    preferencesRepository = module.get<MockRepository<NotificationPreference>>(getRepositoryToken(NotificationPreference));
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('should create a notification', async () => {
      // Arrange
      const createNotificationDto: CreateNotificationDto = {
        userId: 'user-123',
        title: 'Test Notification',
        message: 'This is a test notification',
        type: NotificationType.PAYMENT,
        icon: 'payment-icon',
        iconBgColor: '#FF5733',
        date: new Date(),
        time: '14:30',
        notifBanner: 'banner-image.jpg',
        notifTitle: 'Notification Title',
        showChevron: true,
        data: { orderId: '123' }
      };

      const mockNotification = {
        id: 'notif-123',
        ...createNotificationDto,
        isRead: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      notificationsRepository.create.mockReturnValue(mockNotification);
      notificationsRepository.save.mockResolvedValue(mockNotification);

      // Act
      const result = await service.create(createNotificationDto);

      // Assert
      expect(notificationsRepository.create).toHaveBeenCalledWith(createNotificationDto);
      expect(notificationsRepository.save).toHaveBeenCalledWith(mockNotification);
      expect(result).toEqual(mockNotification);
    });

    it('should create default preferences if none exist', async () => {
      // Arrange
      const userId = 'user-123';
      const createNotificationDto: CreateNotificationDto = {
        userId,
        title: 'Test Notification',
        message: 'This is a test notification',
        type: NotificationType.PAYMENT,
        icon: 'payment-icon',
        iconBgColor: '#FF5733',
        date: new Date(),
        time: '14:30',
        notifBanner: 'banner-image.jpg',
        notifTitle: 'Notification Title',
        showChevron: true,
        data: { orderId: '123' }
      };

      const mockNotification: Notification = {
        id: 'notif-123',
        ...createNotificationDto,
        isRead: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Notification;

      const defaultPreferences: NotificationPreference = {
        id: 'pref-123',
        userId,
        orderUpdates: {
          email: true,
          push: true,
          inApp: true,
        },
        promotions: {
          email: true,
          push: true,
          inApp: true,
        },
        newsletter: {
          email: true,
        },
        pushNotifications: {
          quietHours: {
            enabled: false,
            start: '22:00',
            end: '08:00',
          },
        },
      } as NotificationPreference;

      preferencesRepository.findOne.mockResolvedValue(null);
      preferencesRepository.create.mockReturnValue(defaultPreferences);
      preferencesRepository.save.mockResolvedValue(defaultPreferences);
      notificationsRepository.create.mockReturnValue(mockNotification);
      notificationsRepository.save.mockResolvedValue(mockNotification);

      // Act
      const result = await service.create(createNotificationDto);

      // Assert
      expect(preferencesRepository.findOne).toHaveBeenCalledWith({
        where: { userId },
      });
      expect(preferencesRepository.create).toHaveBeenCalled();
      expect(preferencesRepository.save).toHaveBeenCalledWith(defaultPreferences);
      expect(notificationsRepository.create).toHaveBeenCalledWith(createNotificationDto);
      expect(notificationsRepository.save).toHaveBeenCalledWith(mockNotification);
      expect(result).toEqual(mockNotification);
    });
  });

  describe('findByUserId', () => {
    it('should return all notifications for a user', async () => {
      // Arrange
      const userId = 'user-123';
      const mockNotifications: Notification[] = [
        {
          id: 'notif-1',
          userId,
          title: 'Notification 1',
          message: 'Message 1',
          type: NotificationType.PAYMENT,
          createdAt: new Date(),
          updatedAt: new Date(),
          icon: 'payment-icon',
          iconBgColor: '#FF5733',
          date: new Date(),
          time: '14:30',
          isRead: false,
          showChevron: true,
          notifBanner: 'banner-image.jpg',
          notifTitle: 'Notification Title 1',
          data: { orderId: '123' },
        },
        {
          id: 'notif-2',
          userId,
          title: 'Notification 2',
          message: 'Message 2',
          type: NotificationType.ORDER,
          createdAt: new Date(),
          updatedAt: new Date(),
          icon: 'order-icon',
          iconBgColor: '#33FF57',
          date: new Date(),
          time: '15:30',
          isRead: true,
          showChevron: true,
          notifBanner: 'banner-image.jpg',
          notifTitle: 'Notification Title 2',
          data: { orderId: '456' },
        },
      ];

      notificationsRepository.find.mockResolvedValue(mockNotifications);

      // Act
      const result = await service.findByUserId(userId);

      // Assert
      expect(notificationsRepository.find).toHaveBeenCalledWith({
        where: { userId },
        order: { createdAt: 'DESC' },
      });
      expect(result).toEqual(mockNotifications);
    });
  });

  describe('findOne', () => {
    it('should return a notification if it exists', async () => {
      // Arrange
      const notificationId = 'notif-123';
      const mockNotification: Notification = {
        id: notificationId,
        userId: 'user-123',
        title: 'Test Notification',
        message: 'This is a test notification',
        type: NotificationType.PAYMENT,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Notification;

      notificationsRepository.findOne.mockResolvedValue(mockNotification);

      // Act
      const result = await service.findOne(notificationId);

      // Assert
      expect(notificationsRepository.findOne).toHaveBeenCalledWith({
        where: { id: notificationId },
      });
      expect(result).toEqual(mockNotification);
    });

    it('should throw NotFoundException if notification does not exist', async () => {
      // Arrange
      const notificationId = 'non-existent-id';
      notificationsRepository.findOne.mockResolvedValue(null);

      // Act & Assert
      await expect(service.findOne(notificationId)).rejects.toThrow(NotFoundException);
      expect(notificationsRepository.findOne).toHaveBeenCalledWith({
        where: { id: notificationId },
      });
    });
  });

  describe('updateStatus', () => {
    it('should update notification status', async () => {
      // Arrange
      const notificationId = 'notif-123';
      const updateStatusDto: UpdateNotificationStatusDto = {
        isRead: true,
      };

      const mockNotification: Notification = {
        id: notificationId,
        userId: 'user-123',
        title: 'Test Notification',
        message: 'This is a test notification',
        type: NotificationType.PAYMENT,
        icon: 'payment-icon',
        iconBgColor: '#FF5733',
        date: new Date(),
        time: '14:30',
        isRead: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        showChevron: true,
        notifBanner: 'banner-image.jpg',
        notifTitle: 'Notification Title',
        data: { orderId: '123' }
      } as Notification;

      const updatedNotification = {
        ...mockNotification,
        isRead: true,
      };

      notificationsRepository.findOne.mockResolvedValue(mockNotification);
      notificationsRepository.save.mockResolvedValue(updatedNotification);

      // Act
      const result = await service.updateStatus(notificationId, updateStatusDto);

      // Assert
      expect(notificationsRepository.findOne).toHaveBeenCalledWith({
        where: { id: notificationId },
      });
      expect(notificationsRepository.save).toHaveBeenCalledWith(updatedNotification);
      expect(result).toEqual(updatedNotification);
    });
  });

  describe('markAsRead', () => {
    it('should mark a notification as read', async () => {
      // Arrange
      const notificationId = 'notif-123';
      const mockNotification: Notification = {
        id: notificationId,
        userId: 'user-123',
        title: 'Test Notification',
        message: 'This is a test notification',
        type: NotificationType.PAYMENT,
        icon: 'payment-icon',
        iconBgColor: '#FF5733',
        date: new Date(),
        time: '14:30',
        isRead: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        showChevron: true,
        notifBanner: 'banner-image.jpg',
        notifTitle: 'Notification Title',
        data: { orderId: '123' }
      } as Notification;

      const updatedNotification = {
        ...mockNotification,
        isRead: true,
      };

      notificationsRepository.findOne.mockResolvedValue(mockNotification);
      notificationsRepository.save.mockResolvedValue(updatedNotification);

      // Act
      const result = await service.markAsRead(notificationId);

      // Assert
      expect(notificationsRepository.findOne).toHaveBeenCalledWith({
        where: { id: notificationId },
      });
      expect(result).toEqual(updatedNotification);
      expect(result.isRead).toBe(true);
    });

    it('should throw NotFoundException if notification not found', async () => {
      // Arrange
      const notificationId = 'non-existent-id';
      notificationsRepository.findOne.mockResolvedValue(null);

      // Act & Assert
      await expect(service.markAsRead(notificationId)).rejects.toThrow(NotFoundException);
    });
  });

  describe('markAllAsRead', () => {
    it('should mark all unread notifications for a user as read', async () => {
      // Arrange
      const userId = 'user-123';
      const affectedRows = 5;
      notificationsRepository.update.mockResolvedValue({ affected: affectedRows });

      // Act
      const result = await service.markAllAsRead(userId);

      // Assert
      expect(notificationsRepository.update).toHaveBeenCalledWith(
        { userId, isRead: false },
        { isRead: true },
      );
      expect(result).toEqual(affectedRows);
    });
  });

  describe('remove', () => {
    it('should remove a notification', async () => {
      // Arrange
      const notificationId = 'notif-123';
      notificationsRepository.delete.mockResolvedValue({ affected: 1 });

      // Act
      const result = await service.remove(notificationId);

      // Assert
      expect(notificationsRepository.delete).toHaveBeenCalledWith(notificationId);
      expect(result).toBe(true);
    });

    it('should return false if notification does not exist', async () => {
      // Arrange
      const notificationId = 'non-existent-id';
      notificationsRepository.delete.mockResolvedValue({ affected: 0 });

      // Act
      const result = await service.remove(notificationId);

      // Assert
      expect(result).toBe(false);
      expect(notificationsRepository.delete).toHaveBeenCalledWith(notificationId);
    });
  });

  describe('getPreferences', () => {
    it('should return user preferences if they exist', async () => {
      // Arrange
      const userId = 'user-123';
      const mockPreferences: NotificationPreference = {
        userId,
        orderUpdates: {
          email: true,
          push: true,
          inApp: true
        },
        promotions: {
          email: true,
          push: false,
          inApp: true
        },
        newsletter: {
          email: true,
        },
        pushNotifications: {
          quietHours: {
            enabled: false,
            start: '22:00',
            end: '08:00',
          },
        }
      } as NotificationPreference;

      preferencesRepository.findOne.mockResolvedValue(mockPreferences);

      // Act
      const result = await service.getPreferences(userId);

      // Assert
      expect(preferencesRepository.findOne).toHaveBeenCalledWith({
        where: { userId }
      });
      expect(result).toEqual(mockPreferences);
    });

    it('should create default preferences when getting preferences for a new user', async () => {
      // Arrange
      const userId = 'user-123';
      
      const defaultPreferences = {
        userId,
        orderUpdates: {
          email: true,
          push: true,
          inApp: true
        },
        promotions: {
          email: true,
          push: true,
          inApp: true
        },
        newsletter: {
          email: true
        },
        pushNotifications: {
          enabled: true,
          quietHours: {
            start: null,
            end: null
          }
        }
      };

      preferencesRepository.findOne.mockResolvedValue(null);
      preferencesRepository.create.mockReturnValue(defaultPreferences);
      preferencesRepository.save.mockResolvedValue(defaultPreferences);

      // Act
      const result = await service.getPreferences(userId);

      // Assert
      expect(preferencesRepository.findOne).toHaveBeenCalledWith({
        where: { userId }
      });
      expect(preferencesRepository.create).toHaveBeenCalled();
      expect(preferencesRepository.save).toHaveBeenCalledWith(defaultPreferences);
      expect(result).toEqual(defaultPreferences);
    });
  });

  describe('updatePreferences', () => {
    it('should update notification preferences', async () => {
      const userId = 'user123';
      const updateDto: UpdateNotificationPreferenceDto = {
        orderUpdates: {
          email: false,
          push: true,
          inApp: true
        },
        pushNotifications: {
          quietHours: {
            enabled: false,
            start: '22:00',
            end: '06:00'
          }
        }
      };

      const existingPreference = {
        id: 'pref123',
        userId,
        orderUpdates: {
          email: true,
          push: true,
          inApp: true
        },
        promotions: {
          email: true,
          push: true,
          inApp: true
        },
        newsletter: {
          email: true
        },
        pushNotifications: {
          enabled: true,
          quietHours: {
            start: '23:00',
            end: '07:00'
          }
        }
      };

      const expectedSavedPreference = {
        ...existingPreference,
        orderUpdates: {
          ...existingPreference.orderUpdates,
          ...updateDto.orderUpdates
        },
        pushNotifications: {
          ...existingPreference.pushNotifications,
          ...updateDto.pushNotifications
        }
      };

      preferencesRepository.findOne.mockResolvedValue(existingPreference);
      preferencesRepository.save.mockResolvedValue(expectedSavedPreference);

      const result = await service.updatePreferences(userId, updateDto);

      expect(preferencesRepository.findOne).toHaveBeenCalledWith({
        where: { userId }
      });
      expect(preferencesRepository.save).toHaveBeenCalledWith(expect.objectContaining({
        id: 'pref123',
        userId,
        orderUpdates: {
          email: false,
          push: true,
          inApp: true
        },
        pushNotifications: expect.objectContaining({
          enabled: true,
          quietHours: {
            enabled: false,
            start: '22:00',
            end: '06:00'
          }
        })
      }));
      expect(result).toEqual(expectedSavedPreference);
    });

    it('should create default preferences if none exist before updating', async () => {
      // Arrange
      const userId = 'user123';
      const updateDto: UpdateNotificationPreferenceDto = {
        orderUpdates: {
          email: false,
          push: true,
          inApp: true
        }
      };

      // Aucune pru00e9fu00e9rence existante
      preferencesRepository.findOne.mockResolvedValue(null);

      // Pru00e9fu00e9rences par du00e9faut
      const defaultPreferences = {
        userId,
        orderUpdates: {
          email: true,
          push: true,
          inApp: true
        },
        promotions: {
          email: true,
          push: true,
          inApp: true
        },
        newsletter: {
          email: true
        },
        pushNotifications: {
          enabled: true,
          quietHours: {
            start: null,
            end: null
          }
        }
      };

      // Pru00e9fu00e9rences par du00e9faut avec la mise u00e0 jour appliquu00e9e
      const updatedPreferences = {
        ...defaultPreferences,
        orderUpdates: {
          ...defaultPreferences.orderUpdates,
          ...updateDto.orderUpdates
        }
      };

      preferencesRepository.create.mockReturnValue(defaultPreferences);
      preferencesRepository.save.mockImplementation((prefs) => {
        if (prefs === defaultPreferences) {
          return Promise.resolve(defaultPreferences);
        }
        return Promise.resolve(updatedPreferences);
      });

      const result = await service.updatePreferences(userId, updateDto);

      expect(preferencesRepository.findOne).toHaveBeenCalledWith({
        where: { userId }
      });
      expect(preferencesRepository.create).toHaveBeenCalledWith(expect.objectContaining({
        userId
      }));
      expect(preferencesRepository.save).toHaveBeenCalledTimes(2); // Une fois pour cru00e9er les pru00e9fu00e9rences par du00e9faut, une fois pour les mettre u00e0 jour
      expect(result).toEqual(updatedPreferences);
    });
  });

  describe('countUnread', () => {
    it('should return the count of unread notifications for a user', async () => {
      // Arrange
      const userId = 'user-123';
      const unreadCount = 5;
      notificationsRepository.count.mockResolvedValue(unreadCount);

      // Act
      const result = await service.countUnread(userId);

      // Assert
      expect(notificationsRepository.count).toHaveBeenCalledWith({
        where: { userId, isRead: false },
      });
      expect(result).toEqual(unreadCount);
    });
  });
});
