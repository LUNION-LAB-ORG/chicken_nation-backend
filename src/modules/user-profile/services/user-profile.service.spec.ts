import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserProfileService } from './user-profile.service';
import { User } from '../../auth/entities/user.entity';
import { NotFoundException } from '@nestjs/common';

// Désactiver la connexion à la base de données pour les tests unitaires
jest.mock('typeorm', () => {
  const original = jest.requireActual('typeorm');
  return {
    ...original,
    // Empêcher la connexion à la base de données
    createConnection: jest.fn(),
    getConnection: jest.fn(),
    getManager: jest.fn(),
    getRepository: jest.fn(),
    // Conserver les décorateurs et autres utilitaires
    PrimaryGeneratedColumn: original.PrimaryGeneratedColumn,
    PrimaryColumn: original.PrimaryColumn,
    Column: original.Column,
    Entity: original.Entity,
    ManyToOne: original.ManyToOne,
    OneToMany: original.OneToMany,
    ManyToMany: original.ManyToMany,
    JoinTable: original.JoinTable,
    JoinColumn: original.JoinColumn,
    Repository: original.Repository,
    EntityRepository: original.EntityRepository,
    FindOneOptions: original.FindOneOptions,
    FindManyOptions: original.FindManyOptions,
    Like: original.Like,
  };
});

describe('UserProfileService', () => {
  let service: UserProfileService;
  let userRepository: Repository<User>;

  const mockUserRepository = {
    findOne: jest.fn(),
    save: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserProfileService,
        {
          provide: getRepositoryToken(User),
          useValue: mockUserRepository,
        },
      ],
    }).compile();

    service = module.get<UserProfileService>(UserProfileService);
    userRepository = module.get<Repository<User>>(getRepositoryToken(User));
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getProfile', () => {
    it('should return a user profile', async () => {
      const mockUser = {
        id: 'user-id',
        first_name: 'John',
        last_name: 'Doe',
        username: 'johndoe',
        email: 'john@example.com',
        password: 'hashed-password',
        phone_number: '123456789',
        is_admin: false,
        profile_picture: 'profile.jpg',
      };

      mockUserRepository.findOne.mockResolvedValue(mockUser);

      const result = await service.getProfile('user-id');
      
      expect(result).toEqual({ ...mockUser, password: undefined });
      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'user-id' },
      });
    });

    it('should throw NotFoundException if user not found', async () => {
      mockUserRepository.findOne.mockResolvedValue(null);

      await expect(service.getProfile('non-existent-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateProfile', () => {
    it('should update and return the user profile', async () => {
      const mockUser = {
        id: 'user-id',
        first_name: 'John',
        last_name: 'Doe',
        username: 'johndoe',
        email: 'john@example.com',
        password: 'hashed-password',
        phone_number: '123456789',
        is_admin: false,
        profile_picture: null,
      };

      const updateDto = {
        first_name: 'Jane',
        profile_picture: 'new-profile.jpg',
      };

      const updatedUser = {
        ...mockUser,
        first_name: 'Jane',
        profile_picture: 'new-profile.jpg',
      };

      mockUserRepository.findOne.mockResolvedValue(mockUser);
      mockUserRepository.save.mockResolvedValue(updatedUser);

      const result = await service.updateProfile('user-id', updateDto);

      expect(result).toEqual({ ...updatedUser, password: undefined });
      expect(userRepository.save).toHaveBeenCalled();
    });
  });
});
