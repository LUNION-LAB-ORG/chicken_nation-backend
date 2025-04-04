import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from '../services/notifications.service';
import { CreateNotificationDto } from '../dto/create-notification.dto';
import { UpdateNotificationPreferenceDto } from '../dto/update-notification-preference.dto';
import { Notification, NotificationType } from '../entities/notification.entity';
import { NotificationPreference } from '../entities/notification-preference.entity';

describe('NotificationsController', () => {
  let controller: NotificationsController;
  let service: NotificationsService;

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

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [
        {
          provide: NotificationsService,
          useValue: mockNotificationsService,
        },
      ],
    }).compile();

    controller = module.get<NotificationsController>(NotificationsController);
    service = module.get<NotificationsService>(NotificationsService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('create', () => {
    it('should create a notification', async () => {
      const currentDate = new Date();
      const createNotificationDto: CreateNotificationDto = {
        userId: 'user-123',
        title: 'Test Notification',
        message: 'This is a test notification',
        type: NotificationType.PAYMENT,
        icon: 'payment-icon',
        iconBgColor: '#FF5733',
        date: currentDate,
        time: '14:30',
        showChevron: true,
        notifBanner: 'banner-image.jpg',
        notifTitle: 'Notification Title',
        data: { orderId: '123' }
      };

      const mockNotification: Notification = {
        id: 'notif-123',
        ...createNotificationDto,
        isRead: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Notification;

      mockNotificationsService.create.mockResolvedValue(mockNotification);

      const result = await controller.create(createNotificationDto);

      expect(service.create).toHaveBeenCalledWith(createNotificationDto);
      expect(result).toEqual(mockNotification);
    });
  });

  describe('findUserNotifications', () => {
    it('should return all notifications for the user', async () => {
      const userId = 'user-123';
      const currentDate = new Date();
      const mockNotifications: Notification[] = [
        {
          id: 'notif-1',
          userId,
          title: 'Notification 1',
          message: 'Message 1',
          type: NotificationType.PAYMENT,
          icon: 'payment-icon',
          iconBgColor: '#FF5733',
          date: currentDate,
          time: '14:30',
          isRead: false,
          createdAt: new Date(),
          updatedAt: new Date(),
          showChevron: true,
          notifBanner: 'banner-image.jpg',
          notifTitle: 'Notification Title 1',
          data: { orderId: '123' }
        },
        {
          id: 'notif-2',
          userId,
          title: 'Notification 2',
          message: 'Message 2',
          type: NotificationType.ORDER,
          icon: 'order-icon',
          iconBgColor: '#33FF57',
          date: currentDate,
          time: '15:30',
          isRead: true,
          createdAt: new Date(),
          updatedAt: new Date(),
          showChevron: true,
          notifBanner: 'banner-image.jpg',
          notifTitle: 'Notification Title 2',
          data: { orderId: '456' }
        },
      ];

      mockNotificationsService.findByUserId.mockResolvedValue(mockNotifications);

      const req = { user: { id: userId } };
      const result = await controller.findUserNotifications(req);

      expect(service.findByUserId).toHaveBeenCalledWith(userId);
      expect(result).toEqual(mockNotifications);
    });
  });

  describe('countUnread', () => {
    it('should return the count of unread notifications', async () => {
      const userId = 'user-123';
      const currentDate = new Date();
      const mockNotifications: Notification[] = [
        {
          id: 'notif-1',
          userId,
          title: 'Notification 1',
          message: 'Message 1',
          type: NotificationType.PAYMENT,
          icon: 'payment-icon',
          iconBgColor: '#FF5733',
          date: currentDate,
          time: '14:30',
          isRead: false,
          createdAt: new Date(),
          updatedAt: new Date(),
          showChevron: true,
          notifBanner: 'banner-image.jpg',
          notifTitle: 'Notification Title 1',
          data: { orderId: '123' }
        },
        {
          id: 'notif-2',
          userId,
          title: 'Notification 2',
          message: 'Message 2',
          type: NotificationType.ORDER,
          icon: 'order-icon',
          iconBgColor: '#33FF57',
          date: currentDate,
          time: '15:30',
          isRead: true,
          createdAt: new Date(),
          updatedAt: new Date(),
          showChevron: true,
          notifBanner: 'banner-image.jpg',
          notifTitle: 'Notification Title 2',
          data: { orderId: '456' }
        },
      ];

      mockNotificationsService.findByUserId.mockResolvedValue(mockNotifications);

      const req = { user: { id: userId } };
      const result = await controller.countUnread(req);

      expect(service.findByUserId).toHaveBeenCalledWith(userId);
      expect(result).toEqual({ count: 1 });
    });
  });

  describe('findOne', () => {
    it('should return a notification by id', async () => {
      const currentDate = new Date();
      const mockNotification: Notification = {
        id: 'notif-123',
        userId: 'user-123',
        title: 'Test Notification',
        message: 'This is a test notification',
        type: NotificationType.PAYMENT,
        icon: 'payment-icon',
        iconBgColor: '#FF5733',
        date: currentDate,
        time: '14:30',
        isRead: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        showChevron: true,
        notifBanner: 'banner-image.jpg',
        notifTitle: 'Notification Title',
        data: { orderId: '123' }
      } as Notification;

      mockNotificationsService.findOne.mockResolvedValue(mockNotification);

      const result = await controller.findOne('notif-123');

      expect(service.findOne).toHaveBeenCalledWith('notif-123');
      expect(result).toEqual(mockNotification);
    });
  });

  describe('markAsRead', () => {
    it('should mark a notification as read', async () => {
      const currentDate = new Date();
      const mockNotification: Notification = {
        id: 'notif-123',
        userId: 'user-123',
        title: 'Test Notification',
        message: 'This is a test notification',
        type: NotificationType.PAYMENT,
        icon: 'payment-icon',
        iconBgColor: '#FF5733',
        date: currentDate,
        time: '14:30',
        isRead: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        showChevron: true,
        notifBanner: 'banner-image.jpg',
        notifTitle: 'Notification Title',
        data: { orderId: '123' }
      } as Notification;

      mockNotificationsService.markAsRead.mockResolvedValue(mockNotification);

      const result = await controller.markAsRead('notif-123');

      expect(service.markAsRead).toHaveBeenCalledWith('notif-123');
      expect(result).toEqual(mockNotification);
    });
  });

  describe('markAllAsRead', () => {
    it('should mark all notifications as read for the user', async () => {
      const userId = 'user-123';
      const currentDate = new Date();
      const mockNotifications: Notification[] = [
        {
          id: 'notif-1',
          userId,
          title: 'Notification 1',
          message: 'Message 1',
          type: NotificationType.PAYMENT,
          icon: 'payment-icon',
          iconBgColor: '#FF5733',
          date: currentDate,
          time: '14:30',
          isRead: false,
          createdAt: new Date(),
          updatedAt: new Date(),
          showChevron: true,
          notifBanner: 'banner-image.jpg',
          notifTitle: 'Notification Title 1',
          data: { orderId: '123' }
        },
        {
          id: 'notif-2',
          userId,
          title: 'Notification 2',
          message: 'Message 2',
          type: NotificationType.ORDER,
          icon: 'order-icon',
          iconBgColor: '#33FF57',
          date: currentDate,
          time: '15:30',
          isRead: true,
          createdAt: new Date(),
          updatedAt: new Date(),
          showChevron: true,
          notifBanner: 'banner-image.jpg',
          notifTitle: 'Notification Title 2',
          data: { orderId: '456' }
        },
      ];

      mockNotificationsService.markAllAsRead.mockResolvedValue(5);

      const req = { user: { id: userId } };
      const result = await controller.markAllAsRead(req);

      expect(service.markAllAsRead).toHaveBeenCalledWith(userId);
      expect(result).toEqual({ count: 5 });
    });
  });

  describe('remove', () => {
    it('should remove a notification', async () => {
      const currentDate = new Date();
      const mockNotification: Notification = {
        id: 'notif-123',
        userId: 'user-123',
        title: 'Test Notification',
        message: 'This is a test notification',
        type: NotificationType.PAYMENT,
        icon: 'payment-icon',
        iconBgColor: '#FF5733',
        date: currentDate,
        time: '14:30',
        isRead: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        showChevron: true,
        notifBanner: 'banner-image.jpg',
        notifTitle: 'Notification Title',
        data: { orderId: '123' }
      } as Notification;

      mockNotificationsService.findOne.mockResolvedValue(mockNotification);
      mockNotificationsService.remove.mockResolvedValue(true);

      const result = await controller.remove('notif-123');

      expect(service.remove).toHaveBeenCalledWith('notif-123');
      expect(result).toEqual({ success: true });
    });
  });

  describe('getPreferences', () => {
    it('should return notification preferences for the user', async () => {
      const expectedPreferences: NotificationPreference = {
        userId: 'user-123',
        orderUpdates: { email: true, push: true, inApp: true },
        promotions: { email: true, push: true, inApp: true },
        newsletter: { email: true, push: false, inApp: false },
        pushNotifications: { enabled: true },
      };

      mockNotificationsService.getPreferences.mockResolvedValue(expectedPreferences);

      const req = { user: { id: 'user-123' } };
      const result = await controller.getPreferences(req);

      expect(service.getPreferences).toHaveBeenCalledWith('user-123');
      expect(result).toEqual(expectedPreferences);
    });
  });

  describe('updatePreferences', () => {
    it('should update notification preferences for the user', async () => {
      const updateDto: UpdateNotificationPreferenceDto = {
        orderUpdates: { email: false, push: true, inApp: true },
        promotions: { email: false, push: false, inApp: true },
        newsletter: { email: true, push: false, inApp: false },
        pushNotifications: { enabled: false },
      };

      const expectedPreferences: NotificationPreference = {
        userId: 'user-123',
        orderUpdates: { email: false, push: true, inApp: true },
        promotions: { email: false, push: false, inApp: true },
        newsletter: { email: true, push: false, inApp: false },
        pushNotifications: { enabled: false },
      };

      mockNotificationsService.updatePreferences.mockResolvedValue(expectedPreferences);

      const req = { user: { id: 'user-123' } };
      const result = await controller.updatePreferences(req, updateDto);

      expect(service.updatePreferences).toHaveBeenCalledWith('user-123', updateDto);
      expect(result).toEqual(expectedPreferences);
    });
  });
});
