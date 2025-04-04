import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from '../services/auth.service';
import { CreateUserDto } from '../dto/create-user.dto';
import { LoginDto } from '../dto/login.dto';
import { OtpRequestDto } from '../dto/otp-request.dto';
import { OtpVerifyDto } from '../dto/otp-verify.dto';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';

describe('AuthController', () => {
  let controller: AuthController;
  let authService: AuthService;

  beforeEach(async () => {
    const mockAuthService = {
      register: jest.fn(),
      login: jest.fn(),
      requestOtp: jest.fn(),
      verifyOtp: jest.fn(),
      refreshToken: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: mockAuthService,
        },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
    authService = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('register', () => {
    it('should call authService.register with createUserDto', async () => {
      // Arrange
      const createUserDto: CreateUserDto = {
        email: 'test@example.com',
        username: 'testuser',
        password: 'password123',
        first_name: 'Test',
        last_name: 'User',
        phone_number: '+33612345678',
      };
      const expectedResult = { id: 1, ...createUserDto, password: 'hashed_password' };
      jest.spyOn(authService, 'register').mockResolvedValue(expectedResult as any);

      // Act
      const result = await controller.register(createUserDto);

      // Assert
      expect(authService.register).toHaveBeenCalledWith(createUserDto);
      expect(result).toEqual(expectedResult);
    });
  });

  describe('login', () => {
    it('should call authService.login with loginDto', async () => {
      // Arrange
      const loginDto: LoginDto = {
        email: 'test@example.com',
        password: 'password123',
      };
      const expectedResult = {
        access_token: 'access_token',
        refresh_token: 'refresh_token',
        user: { id: 1, email: 'test@example.com' },
      };
      jest.spyOn(authService, 'login').mockResolvedValue(expectedResult);

      // Act
      const result = await controller.login(loginDto);

      // Assert
      expect(authService.login).toHaveBeenCalledWith(loginDto);
      expect(result).toEqual(expectedResult);
    });
  });

  describe('requestOtp', () => {
    it('should call authService.requestOtp with otpRequestDto', async () => {
      // Arrange
      const otpRequestDto: OtpRequestDto = {
        phone_number: '+33612345678',
      };
      const expectedResult = { message: 'Code OTP envoyé avec succès' };
      jest.spyOn(authService, 'requestOtp').mockResolvedValue(expectedResult);

      // Act
      const result = await controller.requestOtp(otpRequestDto);

      // Assert
      expect(authService.requestOtp).toHaveBeenCalledWith(otpRequestDto);
      expect(result).toEqual(expectedResult);
    });
  });

  describe('verifyOtp', () => {
    it('should call authService.verifyOtp with otpVerifyDto', async () => {
      // Arrange
      const otpVerifyDto: OtpVerifyDto = {
        phone_number: '+33612345678',
        otp_code: '123456',
      };
      const expectedResult = { message: 'Vérification OTP réussie', verified: true };
      jest.spyOn(authService, 'verifyOtp').mockResolvedValue(expectedResult);

      // Act
      const result = await controller.verifyOtp(otpVerifyDto);

      // Assert
      expect(authService.verifyOtp).toHaveBeenCalledWith(otpVerifyDto);
      expect(result).toEqual(expectedResult);
    });
  });

  describe('refreshToken', () => {
    it('should call authService.refreshToken with refresh_token', async () => {
      // Arrange
      const refreshTokenDto = { refresh_token: 'refresh_token' };
      const expectedResult = { access_token: 'new_access_token' };
      jest.spyOn(authService, 'refreshToken').mockResolvedValue(expectedResult);

      // Act
      const result = await controller.refreshToken(refreshTokenDto);

      // Assert
      expect(authService.refreshToken).toHaveBeenCalledWith(refreshTokenDto.refresh_token);
      expect(result).toEqual(expectedResult);
    });
  });

  describe('getProfile', () => {
    it('should return user from request object', () => {
      // Arrange
      const req = { user: { id: 1, email: 'test@example.com' } };

      // Act
      const result = controller.getProfile(req);

      // Assert
      expect(result).toEqual(req.user);
    });
  });
});