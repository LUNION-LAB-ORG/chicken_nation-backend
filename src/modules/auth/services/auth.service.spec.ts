import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { User } from '../entities/user.entity';
import { Role } from '../entities/role.entity';
import { Otp } from '../entities/otp.entity';
import { Repository } from 'typeorm';
import { UnauthorizedException, BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';

type MockRepository<T = any> = Partial<Record<keyof Repository<T>, jest.Mock>>;

const createMockRepository = <T = any>(): MockRepository<T> => ({
  findOne: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
});

describe('AuthService', () => {
  let service: AuthService;
  let userRepository: MockRepository<User>;
  let roleRepository: MockRepository<Role>;
  let otpRepository: MockRepository<Otp>;
  let jwtService: JwtService;
  let configService: ConfigService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: getRepositoryToken(User),
          useValue: createMockRepository(),
        },
        {
          provide: getRepositoryToken(Role),
          useValue: createMockRepository(),
        },
        {
          provide: getRepositoryToken(Otp),
          useValue: createMockRepository(),
        },
        {
          provide: JwtService,
          useValue: {
            sign: jest.fn(),
            verify: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string) => {
              if (key === 'JWT_SECRET') return 'test-secret';
              if (key === 'JWT_EXPIRATION') return '1h';
              if (key === 'JWT_REFRESH_SECRET') return 'test-refresh-secret';
              if (key === 'JWT_REFRESH_EXPIRATION') return '7d';
              return null;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    userRepository = module.get<MockRepository<User>>(getRepositoryToken(User));
    roleRepository = module.get<MockRepository<Role>>(getRepositoryToken(Role));
    otpRepository = module.get<MockRepository<Otp>>(getRepositoryToken(Otp));
    jwtService = module.get<JwtService>(JwtService);
    configService = module.get<ConfigService>(ConfigService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('register', () => {
    it('should register a new user successfully', async () => {
      // Arrange
      const createUserDto = {
        email: 'test@example.com',
        username: 'testuser',
        password: 'password123',
        first_name: 'Test',
        last_name: 'User',
        phone_number: '+33612345678',
      };
      const userRole = { id: 1, name: 'user' };
      const hashedPassword = 'hashed_password';
      const createdUser = { ...createUserDto, id: 1, roles: [userRole] };

      userRepository.findOne.mockResolvedValue(null);
      roleRepository.findOne.mockResolvedValue(userRole);
      userRepository.create.mockReturnValue({
        ...createUserDto,
        password: hashedPassword,
      });
      userRepository.save.mockResolvedValue(createdUser);

      jest.spyOn(bcrypt, 'hash').mockImplementation(() => Promise.resolve(hashedPassword));

      // Act
      const result = await service.register(createUserDto);

      // Assert
      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: [
          { email: createUserDto.email },
          { username: createUserDto.username },
        ],
      });
      expect(bcrypt.hash).toHaveBeenCalledWith(createUserDto.password, 10);
      expect(userRepository.create).toHaveBeenCalledWith({
        ...createUserDto,
        password: hashedPassword,
      });
      expect(roleRepository.findOne).toHaveBeenCalledWith({
        where: { name: 'user' },
      });
      expect(userRepository.save).toHaveBeenCalled();
      expect(result).toEqual(createdUser);
    });

    it('should throw BadRequestException if user already exists', async () => {
      // Arrange
      const createUserDto = {
        email: 'existing@example.com',
        username: 'existinguser',
        password: 'password123',
        first_name: 'Existing',
        last_name: 'User',
        phone_number: '+33612345678',
      };
      const existingUser = { ...createUserDto, id: 1 };

      userRepository.findOne.mockResolvedValue(existingUser);

      // Act & Assert
      await expect(service.register(createUserDto)).rejects.toThrow(BadRequestException);
      expect(userRepository.findOne).toHaveBeenCalled();
    });
  });

  describe('login', () => {
    it('should login successfully and return tokens', async () => {
      // Arrange
      const loginDto = {
        email: 'test@example.com',
        password: 'password123',
      };
      const userRole = { id: 1, name: 'user' };
      const user = {
        id: 1,
        email: 'test@example.com',
        password: 'hashed_password',
        username: 'testuser',
        roles: [userRole],
      };
      const accessToken = 'access_token';
      const refreshToken = 'refresh_token';

      userRepository.findOne.mockResolvedValue(user);
      jest.spyOn(bcrypt, 'compare').mockImplementation(() => Promise.resolve(true));
      (jwtService.sign as jest.Mock).mockReturnValueOnce(accessToken).mockReturnValueOnce(refreshToken);

      // Act
      const result = await service.login(loginDto);

      // Assert
      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { email: loginDto.email },
        relations: ['roles'],
      });
      expect(bcrypt.compare).toHaveBeenCalledWith(loginDto.password, user.password);
      expect(jwtService.sign).toHaveBeenCalledTimes(2);
      expect(result).toEqual({
        access_token: accessToken,
        refresh_token: refreshToken,
        user: expect.objectContaining({ id: user.id, email: user.email }),
      });
      expect(result.user).not.toHaveProperty('password');
    });

    it('should throw UnauthorizedException if user not found', async () => {
      // Arrange
      const loginDto = {
        email: 'nonexistent@example.com',
        password: 'password123',
      };

      userRepository.findOne.mockResolvedValue(null);

      // Act & Assert
      await expect(service.login(loginDto)).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException if password is invalid', async () => {
      // Arrange
      const loginDto = {
        email: 'test@example.com',
        password: 'wrongpassword',
      };
      const user = {
        id: 1,
        email: 'test@example.com',
        password: 'hashed_password',
        roles: [{ id: 1, name: 'user' }],
      };

      userRepository.findOne.mockResolvedValue(user);
      jest.spyOn(bcrypt, 'compare').mockImplementation(() => Promise.resolve(false));

      // Act & Assert
      await expect(service.login(loginDto)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('requestOtp', () => {
    it('should create a new OTP if none exists', async () => {
      // Arrange
      const otpRequestDto = { phone_number: '+33612345678' };
      const otpCode = '123456';
      const newOtp = {
        phone_number: otpRequestDto.phone_number,
        code: otpCode,
        expires_at: expect.any(Date),
        is_used: false,
      };

      otpRepository.findOne.mockResolvedValue(null);
      otpRepository.create.mockReturnValue(newOtp);
      otpRepository.save.mockResolvedValue(newOtp);
      
      // Mock Math.random to return a predictable value
      const mockMath = Object.create(global.Math);
      mockMath.random = () => 0.123456;
      global.Math = mockMath;

      // Act
      const result = await service.requestOtp(otpRequestDto);

      // Assert
      expect(otpRepository.findOne).toHaveBeenCalledWith({
        where: { phone_number: otpRequestDto.phone_number },
      });
      expect(otpRepository.create).toHaveBeenCalled();
      expect(otpRepository.save).toHaveBeenCalled();
      expect(result).toEqual({ message: 'Code OTP envoyé avec succès' });
    });

    it('should update an existing OTP', async () => {
      // Arrange
      const otpRequestDto = { phone_number: '+33612345678' };
      const existingOtp = {
        phone_number: otpRequestDto.phone_number,
        code: '654321',
        expires_at: new Date(),
        is_used: true,
      };

      otpRepository.findOne.mockResolvedValue(existingOtp);
      otpRepository.save.mockResolvedValue({
        ...existingOtp,
        code: expect.any(String),
        is_used: false,
        expires_at: expect.any(Date),
      });

      // Act
      const result = await service.requestOtp(otpRequestDto);

      // Assert
      expect(otpRepository.findOne).toHaveBeenCalled();
      expect(existingOtp.is_used).toBe(false);
      expect(otpRepository.save).toHaveBeenCalledWith(existingOtp);
      expect(result).toEqual({ message: 'Code OTP envoyé avec succès' });
    });
  });

  describe('verifyOtp', () => {
    it('should verify a valid OTP successfully', async () => {
      // Arrange
      const otpVerifyDto = {
        phone_number: '+33612345678',
        otp_code: '123456',
      };
      const validOtp = {
        phone_number: otpVerifyDto.phone_number,
        code: otpVerifyDto.otp_code,
        expires_at: new Date(Date.now() + 1000 * 60), // 1 minute in the future
        is_used: false,
      };

      otpRepository.findOne.mockResolvedValue(validOtp);
      otpRepository.save.mockResolvedValue({ ...validOtp, is_used: true });

      // Act
      const result = await service.verifyOtp(otpVerifyDto);

      // Assert
      expect(otpRepository.findOne).toHaveBeenCalledWith({
        where: {
          phone_number: otpVerifyDto.phone_number,
          code: otpVerifyDto.otp_code,
          is_used: false,
        },
      });
      expect(validOtp.is_used).toBe(true);
      expect(otpRepository.save).toHaveBeenCalledWith(validOtp);
      expect(result).toEqual({ message: 'Vérification OTP réussie', verified: true });
    });

    it('should throw BadRequestException if OTP is invalid', async () => {
      // Arrange
      const otpVerifyDto = {
        phone_number: '+33612345678',
        otp_code: 'invalid',
      };

      otpRepository.findOne.mockResolvedValue(null);

      // Act & Assert
      await expect(service.verifyOtp(otpVerifyDto)).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if OTP is expired', async () => {
      // Arrange
      const otpVerifyDto = {
        phone_number: '+33612345678',
        otp_code: '123456',
      };
      const expiredOtp = {
        phone_number: otpVerifyDto.phone_number,
        code: otpVerifyDto.otp_code,
        expires_at: new Date(Date.now() - 1000 * 60), // 1 minute in the past
        is_used: false,
      };

      otpRepository.findOne.mockResolvedValue(expiredOtp);

      // Act & Assert
      await expect(service.verifyOtp(otpVerifyDto)).rejects.toThrow(BadRequestException);
    });
  });

  describe('refreshToken', () => {
    it('should refresh token successfully', async () => {
      // Arrange
      const refreshToken = 'valid_refresh_token';
      const payload = { sub: 1, email: 'test@example.com', roles: ['user'] };
      const user = {
        id: 1,
        email: 'test@example.com',
        roles: [{ id: 1, name: 'user' }],
      };
      const newAccessToken = 'new_access_token';

      (jwtService.verify as jest.Mock).mockReturnValue(payload);
      userRepository.findOne.mockResolvedValue(user);
      (jwtService.sign as jest.Mock).mockReturnValue(newAccessToken);

      // Act
      const result = await service.refreshToken(refreshToken);

      // Assert
      expect(jwtService.verify).toHaveBeenCalledWith(refreshToken, {
        secret: 'test-refresh-secret',
      });
      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { id: payload.sub },
        relations: ['roles'],
      });
      expect(jwtService.sign).toHaveBeenCalled();
      expect(result).toEqual({ access_token: newAccessToken });
    });

    it('should throw UnauthorizedException if token verification fails', async () => {
      // Arrange
      const invalidToken = 'invalid_token';

      (jwtService.verify as jest.Mock).mockImplementation(() => {
        throw new Error('Invalid token');
      });

      // Act & Assert
      await expect(service.refreshToken(invalidToken)).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException if user not found', async () => {
      // Arrange
      const refreshToken = 'valid_refresh_token';
      const payload = { sub: 999, email: 'nonexistent@example.com', roles: ['user'] };

      (jwtService.verify as jest.Mock).mockReturnValue(payload);
      userRepository.findOne.mockResolvedValue(null);

      // Act & Assert
      await expect(service.refreshToken(refreshToken)).rejects.toThrow(UnauthorizedException);
    });
  });
});