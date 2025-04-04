import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RestaurantsService } from './restaurants.service';
import { Restaurant } from '../entities/restaurant.entity';
import { NotFoundException } from '@nestjs/common';

type MockRepository<T = any> = Partial<Record<keyof Repository<T>, jest.Mock>>;
const createMockRepository = <T = any>(): MockRepository<T> => ({
  findOne: jest.fn(),
  find: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
  remove: jest.fn(),
  query: jest.fn(), 
  createQueryBuilder: jest.fn(() => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
    getOne: jest.fn().mockResolvedValue({}),
    execute: jest.fn().mockResolvedValue([]), 
  })),
});

describe('RestaurantsService', () => {
  let service: RestaurantsService;
  let restaurantRepository: MockRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RestaurantsService,
        {
          provide: getRepositoryToken(Restaurant),
          useValue: createMockRepository(),
        },
      ],
    }).compile();

    service = module.get<RestaurantsService>(RestaurantsService);
    restaurantRepository = module.get<MockRepository>(getRepositoryToken(Restaurant));
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findAll', () => {
    it('should return an array of restaurants', async () => {
      const expectedRestaurants = [{ name: 'Restaurant 1' }, { name: 'Restaurant 2' }];
      const queryBuilder = restaurantRepository.createQueryBuilder();
      queryBuilder.getMany.mockResolvedValue(expectedRestaurants);

      const result = await service.findAll();
      expect(result).toEqual(expectedRestaurants);
      expect(restaurantRepository.createQueryBuilder).toHaveBeenCalledWith('restaurant');
    });

    it('should filter restaurants by isOpen', async () => {
      const expectedRestaurants = [{ name: 'Restaurant 1', is_open: true }];
      const queryBuilder = restaurantRepository.createQueryBuilder();
      queryBuilder.getMany.mockResolvedValue(expectedRestaurants);

      const result = await service.findAll({ isOpen: true });
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('restaurant.is_open = :isOpen', { isOpen: true });
      expect(result).toEqual(expectedRestaurants);
    });

    it('should filter restaurants by location', async () => {
      const expectedRestaurants = [{ name: 'Restaurant 1', location: 'Paris' }];
      const queryBuilder = restaurantRepository.createQueryBuilder();
      queryBuilder.getMany.mockResolvedValue(expectedRestaurants);

      const result = await service.findAll({ location: 'Paris' });
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('restaurant.location ILIKE :location', { location: '%Paris%' });
      expect(result).toEqual(expectedRestaurants);
    });
  });

  describe('findOne', () => {
    it('should return a restaurant if it exists', async () => {
      const expectedRestaurant = { id: '1', name: 'Restaurant 1' };
      restaurantRepository.findOne.mockResolvedValue(expectedRestaurant);

      const result = await service.findOne('1');
      expect(result).toEqual(expectedRestaurant);
      expect(restaurantRepository.findOne).toHaveBeenCalledWith({
        where: { id: '1' },
        relations: ['schedules', 'tables', 'reservation_slots'],
      });
    });

    it('should throw NotFoundException if restaurant does not exist', async () => {
      restaurantRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne('1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('should create and return a restaurant', async () => {
      const createRestaurantDto = {
        name: 'New Restaurant',
        description: 'Description',
        address: '123 Main St',
        location: 'Paris',
        phone_number: '+33123456789',
        email: 'contact@restaurant.com',
        website: 'http://restaurant.com',
        is_open: true,
        opening_hours: '9:00-22:00',
        image: 'restaurant.jpg',
        delivery_start_time: '10:00',
        min_reservation_size: 1,
        max_reservation_size: 10,
        reservation_lead_hours: 2,
        reservation_max_days: 30
      };
      
      const expectedRestaurant = {
        id: '1',
        ...createRestaurantDto,
      };
      
      restaurantRepository.create.mockReturnValue(createRestaurantDto);
      restaurantRepository.save.mockResolvedValue(expectedRestaurant);

      const result = await service.create(createRestaurantDto);
      expect(result).toEqual(expectedRestaurant);
      expect(restaurantRepository.create).toHaveBeenCalledWith(createRestaurantDto);
      expect(restaurantRepository.save).toHaveBeenCalledWith(createRestaurantDto);
    });
  });

  describe('update', () => {
    it('should update and return a restaurant', async () => {
      const updateRestaurantDto = { name: 'Updated Restaurant' };
      const existingRestaurant = { id: '1', name: 'Restaurant 1' };
      const updatedRestaurant = { ...existingRestaurant, ...updateRestaurantDto };
      
      restaurantRepository.findOne.mockResolvedValue(existingRestaurant);
      restaurantRepository.save.mockResolvedValue(updatedRestaurant);

      const result = await service.update('1', updateRestaurantDto);
      expect(result).toEqual(updatedRestaurant);
      expect(restaurantRepository.findOne).toHaveBeenCalledWith({
        where: { id: '1' },
        relations: ['schedules', 'tables', 'reservation_slots'],
      });
      expect(restaurantRepository.save).toHaveBeenCalledWith(updatedRestaurant);
    });

    it('should throw NotFoundException if restaurant to update does not exist', async () => {
      restaurantRepository.findOne.mockResolvedValue(null);

      await expect(service.update('1', { name: 'Updated Restaurant' })).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('should remove a restaurant and return a success message', async () => {
      const existingRestaurant = { id: '1', name: 'Restaurant 1' };
      
      restaurantRepository.findOne.mockResolvedValue(existingRestaurant);
      restaurantRepository.remove.mockResolvedValue(existingRestaurant);

      const result = await service.remove('1');
      expect(result).toEqual({ message: `Restaurant avec l'ID 1 supprimé avec succès` });
      expect(restaurantRepository.findOne).toHaveBeenCalledWith({
        where: { id: '1' },
        relations: ['schedules', 'tables', 'reservation_slots'],
      });
      expect(restaurantRepository.remove).toHaveBeenCalledWith(existingRestaurant);
    });

    it('should throw NotFoundException if restaurant to remove does not exist', async () => {
      restaurantRepository.findOne.mockResolvedValue(null);

      await expect(service.remove('1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('searchByName', () => {
    it('should return restaurants matching the name search', async () => {
      const expectedRestaurants = [{ name: 'Restaurant 1' }, { name: 'Restaurant 2' }];
      const queryBuilder = restaurantRepository.createQueryBuilder();
      queryBuilder.getMany.mockResolvedValue(expectedRestaurants);

      const result = await service.searchByName('Restaurant');
      expect(queryBuilder.where).toHaveBeenCalledWith('restaurant.name ILIKE :name', { name: '%Restaurant%' });
      expect(result).toEqual(expectedRestaurants);
    });
  });

  describe('getTopRated', () => {
    it('should return top rated restaurants', async () => {
      const expectedRestaurants = [{ name: 'Restaurant 1', rating: 4.5 }, { name: 'Restaurant 2', rating: 4.2 }];
      const queryBuilder = restaurantRepository.createQueryBuilder();
      queryBuilder.getMany.mockResolvedValue(expectedRestaurants);

      const result = await service.getTopRated(2);
      
      expect(result).toEqual(expectedRestaurants);
      expect(restaurantRepository.createQueryBuilder).toHaveBeenCalledWith('restaurant');
      expect(queryBuilder.leftJoin).toHaveBeenCalledWith('restaurant.menu_items', 'menuItem');
      expect(queryBuilder.select).toHaveBeenCalledWith('restaurant');
      expect(queryBuilder.addSelect).toHaveBeenCalledWith('AVG(menuItem.rating)', 'avgRating');
      expect(queryBuilder.groupBy).toHaveBeenCalledWith('restaurant.id');
      expect(queryBuilder.orderBy).toHaveBeenCalledWith('avgRating', 'DESC');
      expect(queryBuilder.limit).toHaveBeenCalledWith(2);
    });
  });
});
