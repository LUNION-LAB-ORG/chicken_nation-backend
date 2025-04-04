 
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CategoryService } from './category.service';
import { Category } from '../entities/category.entity';
import { NotFoundException } from '@nestjs/common';

type MockRepository<T = any> = Partial<Record<keyof Repository<T>, jest.Mock>>;

const createMockRepository = <T>(): MockRepository<T> => ({
  find: jest.fn(),
  findOne: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
});

describe('CategoryService', () => {
  let service: CategoryService;
  let categoryRepository: MockRepository<Category>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CategoryService,
        {
          provide: getRepositoryToken(Category),
          useValue: createMockRepository(),
        },
      ],
    }).compile();

    service = module.get<CategoryService>(CategoryService);
    categoryRepository = module.get<MockRepository<Category>>(getRepositoryToken(Category));
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getAllCategories', () => {
    it('should return all active categories', async () => {
      const expectedCategories = [
        { id: '123e4567-e89b-12d3-a456-426614174000', name: 'Entrées', isActive: true },
        { id: '123e4567-e89b-12d3-a456-426614174001', name: 'Plats principaux', isActive: true },
      ];
      
      categoryRepository.find.mockResolvedValue(expectedCategories);

      const result = await service.getAllCategories();
      
      expect(result).toEqual(expectedCategories);
      expect(categoryRepository.find).toHaveBeenCalledWith({
        where: { isActive: true },
        order: { name: 'ASC' },
      });
    });
  });

  describe('getCategoryById', () => {
    it('should return a category by id', async () => {
      const expectedCategory = { id: '123e4567-e89b-12d3-a456-426614174000', name: 'Entrées', isActive: true };
      categoryRepository.findOne.mockResolvedValue(expectedCategory);

      const result = await service.getCategoryById('123e4567-e89b-12d3-a456-426614174000');
      
      expect(result).toEqual(expectedCategory);
      expect(categoryRepository.findOne).toHaveBeenCalledWith({ where: { id: '123e4567-e89b-12d3-a456-426614174000' } });
    });

    it('should throw NotFoundException if category does not exist', async () => {
      categoryRepository.findOne.mockResolvedValue(null);

      await expect(service.getCategoryById('999')).rejects.toThrow(NotFoundException);
    });
  });

  describe('createCategory', () => {
    it('should create a new category', async () => {
      const categoryDto = { name: 'Desserts', description: 'Nos délicieux desserts' };
      const createdCategory = { id: '123e4567-e89b-12d3-a456-426614174002', ...categoryDto, isActive: true };
      
      categoryRepository.create.mockReturnValue(createdCategory);
      categoryRepository.save.mockResolvedValue(createdCategory);

      const result = await service.createCategory(categoryDto);
      
      expect(result).toEqual(createdCategory);
      expect(categoryRepository.create).toHaveBeenCalledWith(categoryDto);
      expect(categoryRepository.save).toHaveBeenCalledWith(createdCategory);
    });
  });
});