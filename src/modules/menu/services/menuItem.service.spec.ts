import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MenuItemService } from './menuItem.service';
import { MenuItem } from '../entities/menuItem.entity';
import { MenuItemOption } from '../entities/menuItemOption.entity';
import { Category } from '../entities/category.entity';
import { NotFoundException, BadRequestException } from '@nestjs/common';

type MockRepository<T = any> = Partial<Record<keyof Repository<T>, jest.Mock>>;

const createMockRepository = <T>(): MockRepository<T> => ({
  find: jest.fn(),
  findOne: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
  delete: jest.fn(),
  query: jest.fn(), 
});

describe('MenuItemService', () => {
  let service: MenuItemService;
  let menuItemRepository: MockRepository<MenuItem>;
  let menuItemOptionRepository: MockRepository<MenuItemOption>;
  let categoryRepository: MockRepository<Category>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MenuItemService,
        {
          provide: getRepositoryToken(MenuItem),
          useValue: createMockRepository(),
        },
        {
          provide: getRepositoryToken(MenuItemOption),
          useValue: createMockRepository(),
        },
        {
          provide: getRepositoryToken(Category),
          useValue: createMockRepository(),
        },
      ],
    }).compile();

    service = module.get<MenuItemService>(MenuItemService);
    menuItemRepository = module.get<MockRepository<MenuItem>>(getRepositoryToken(MenuItem));
    menuItemOptionRepository = module.get<MockRepository<MenuItemOption>>(
      getRepositoryToken(MenuItemOption),
    );
    categoryRepository = module.get<MockRepository<Category>>(
      getRepositoryToken(Category),
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getAllMenuItems', () => {
    it('should return all available menu items', async () => {
      const expectedMenuItems = [
        { 
          id: '123e4567-e89b-12d3-a456-426614174001', 
          name: 'Pizza Margherita', 
          description: 'Classic Italian pizza', 
          price: 10.99, 
          category_id: '123e4567-e89b-12d3-a456-426614174000', 
          restaurant_id: '123e4567-e89b-12d3-a456-426614174100',
          is_available: true,
          is_new: false,
          ingredients: 'Tomato, Mozzarella, Basil',
          rating: 4.5,
          total_reviews: 10,
          discounted_price: null,
          original_price: null
        },
        { 
          id: '123e4567-e89b-12d3-a456-426614174002', 
          name: 'Pizza Pepperoni', 
          description: 'American style pizza', 
          price: 12.99, 
          category_id: '123e4567-e89b-12d3-a456-426614174000', 
          restaurant_id: '123e4567-e89b-12d3-a456-426614174100',
          is_available: true,
          is_new: false,
          ingredients: 'Tomato, Mozzarella, Pepperoni',
          rating: 4.7,
          total_reviews: 15,
          discounted_price: null,
          original_price: null
        },
      ];
      
      menuItemRepository.query.mockResolvedValue(expectedMenuItems);
      menuItemOptionRepository.query.mockResolvedValue([]);

      const result = await service.getAllMenuItems();
      
      expect(result).toEqual(expectedMenuItems);
      expect(menuItemRepository.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM menu_items WHERE is_available = true'),
        []
      );
    });

    it('should filter by category if categoryId is provided', async () => {
      const categoryId = '123e4567-e89b-12d3-a456-426614174000';
      const expectedMenuItems = [
        { 
          id: '123e4567-e89b-12d3-a456-426614174001', 
          name: 'Pizza Margherita', 
          description: 'Classic Italian pizza', 
          price: 10.99, 
          category_id: '123e4567-e89b-12d3-a456-426614174000', 
          restaurant_id: '123e4567-e89b-12d3-a456-426614174100',
          is_available: true,
          is_new: false,
          ingredients: 'Tomato, Mozzarella, Basil',
          rating: 4.5,
          total_reviews: 10,
          discounted_price: null,
          original_price: null
        },
      ];
      
      menuItemRepository.query.mockResolvedValue(expectedMenuItems);
      menuItemOptionRepository.query.mockResolvedValue([]);

      const result = await service.getAllMenuItems(categoryId);
      
      expect(result).toEqual(expectedMenuItems);
      expect(menuItemRepository.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM menu_items WHERE is_available = true AND category_id = $1'),
        [categoryId]
      );
    });
  });

  describe('setPromotion', () => {
    it('should set a promotion for a menu item', async () => {
      const id = '123e4567-e89b-12d3-a456-426614174010';
      const promotionDto = { is_promoted: true, promotion_price: 8.99 };
      
      const menuItem = {
        id: '123e4567-e89b-12d3-a456-426614174010',
        name: 'Pizza Margherita',
        description: 'Classic Italian pizza',
        price: 10.99,
        image: 'pizza-margherita.jpg',
        category_id: '123e4567-e89b-12d3-a456-426614174000',
        category: null,
        restaurant_id: '123e4567-e89b-12d3-a456-426614174100',
        restaurant: null,
        options: [],
        is_available: true,
        is_new: false,
        is_promoted: false,
        promotion_price: null,
        ingredients: 'Tomato, Mozzarella, Basil',
        rating: 4.5,
        total_reviews: 10,
        discounted_price: null,
        original_price: null,
        created_at: new Date(),
        updated_at: new Date()
      };
      
      const updatedMenuItem = {
        ...menuItem,
        is_promoted: true,
        promotion_price: 8.99,
      };
      
      jest.spyOn(service, 'getMenuItemById').mockImplementation(() => Promise.resolve(menuItem as unknown as MenuItem));
      
      menuItemRepository.save.mockResolvedValue(updatedMenuItem);
      
      const result = await service.setPromotion(id, promotionDto);
      
      expect(result).toEqual(updatedMenuItem);
      expect(menuItemRepository.save).toHaveBeenCalledWith(expect.objectContaining({
        is_promoted: true,
        promotion_price: 8.99,
      }));
    });

    it('should throw BadRequestException if promotion price is missing', async () => {
      const id = '123e4567-e89b-12d3-a456-426614174010';
      const promotionDto = { is_promoted: true }; 
      
      const menuItem = {
        id: '123e4567-e89b-12d3-a456-426614174010',
        name: 'Pizza Margherita',
        description: 'Classic Italian pizza',
        price: 10.99,
        image: 'pizza-margherita.jpg',
        category_id: '123e4567-e89b-12d3-a456-426614174000',
        category: null,
        restaurant_id: '123e4567-e89b-12d3-a456-426614174100',
        restaurant: null,
        options: [],
        is_available: true,
        is_new: false,
        is_promoted: false,
        promotion_price: null,
        ingredients: 'Tomato, Mozzarella, Basil',
        rating: 4.5,
        total_reviews: 10,
        discounted_price: null,
        original_price: null,
        created_at: new Date(),
        updated_at: new Date()
      };
      
      jest.spyOn(service, 'getMenuItemById').mockImplementation(() => Promise.resolve(menuItem as unknown as MenuItem));
      
      await expect(service.setPromotion(id, promotionDto)).rejects.toThrow(BadRequestException);
    });
  });
});