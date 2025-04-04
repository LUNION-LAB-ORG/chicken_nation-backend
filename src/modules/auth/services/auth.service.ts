import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';

import { User } from '../entities/user.entity';
import { Role } from '../entities/role.entity';
import { Otp } from '../entities/otp.entity';
import { CreateUserDto } from '../dto/create-user.dto';
import { LoginDto } from '../dto/login.dto';
import { OtpRequestDto } from '../dto/otp-request.dto';
import { OtpVerifyDto } from '../dto/otp-verify.dto';
import { CreateAdminDto } from '../dto/create-admin.dto';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(Role)
    private roleRepository: Repository<Role>,
    @InjectRepository(Otp)
    private otpRepository: Repository<Otp>,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async register(createUserDto: CreateUserDto): Promise<User> {
    // Vérifier si l'utilisateur existe déjà
    const existingUser = await this.userRepository.findOne({
      where: [
        { email: createUserDto.email },
        { username: createUserDto.username },
      ],
    });

    if (existingUser) {
      throw new BadRequestException('Email ou nom d\'utilisateur déjà utilisé');
    }

    // Hasher le mot de passe
    const hashedPassword = await bcrypt.hash(createUserDto.password, 10);

    // Créer le nouvel utilisateur
    const user = this.userRepository.create({
      ...createUserDto,
      password: hashedPassword,
    });

    // Assigner le rôle utilisateur par défaut
    const userRole = await this.roleRepository.findOne({
      where: { name: 'user' },
    });

    if (userRole) {
      user.roles = [userRole];
    }

    return this.userRepository.save(user);
  }

  async login(loginDto: LoginDto): Promise<{ access_token: string; refresh_token: string; user: any }> {
    const user = await this.userRepository.findOne({
      where: { email: loginDto.email },
      relations: ['roles'],
    });

    if (!user) {
      throw new UnauthorizedException('Identifiants invalides');
    }

    const isPasswordValid = await bcrypt.compare(loginDto.password, user.password);

    if (!isPasswordValid) {
      throw new UnauthorizedException('Identifiants invalides');
    }

    const payload = { sub: user.id, email: user.email, roles: user.roles.map(role => role.name) };

    const access_token = this.jwtService.sign(payload, {
      secret: this.configService.get('JWT_SECRET'),
      expiresIn: this.configService.get('JWT_EXPIRATION'),
    });

    const refresh_token = this.jwtService.sign(payload, {
      secret: this.configService.get('JWT_REFRESH_SECRET'),
      expiresIn: this.configService.get('JWT_REFRESH_EXPIRATION'),
    });

    // Retourner les informations de l'utilisateur sans le mot de passe
    const { password, ...userInfo } = user;

    return {
      access_token,
      refresh_token,
      user: userInfo,
    };
  }

  async requestOtp(otpRequestDto: OtpRequestDto): Promise<{ message: string }> {
    const { phone_number } = otpRequestDto;

    // Générer un code OTP à 6 chiffres
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Vérifier si un OTP existe déjà pour ce numéro
    const existingOtp = await this.otpRepository.findOne({
      where: { phone_number },
    });

    if (existingOtp) {
      // Mettre à jour l'OTP existant
      existingOtp.code = otpCode;
      existingOtp.is_used = false;
      existingOtp.expires_at = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
      await this.otpRepository.save(existingOtp);
    } else {
      // Créer un nouvel OTP
      const otp = this.otpRepository.create({
        phone_number,
        code: otpCode,
        expires_at: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
      });
      await this.otpRepository.save(otp);
    }

    // Dans un environnement de production, envoyer le code par SMS
    // Pour le développement, on retourne simplement un message
    console.log(`Code OTP pour ${phone_number}: ${otpCode}`);

    return { message: 'Code OTP envoyé avec succès' };
  }

  async verifyOtp(otpVerifyDto: OtpVerifyDto): Promise<{ message: string; verified: boolean }> {
    const { phone_number, otp_code } = otpVerifyDto;

    const otp = await this.otpRepository.findOne({
      where: { phone_number, code: otp_code, is_used: false },
    });

    if (!otp) {
      throw new BadRequestException('Code OTP invalide');
    }

    const now = new Date();
    if (now > otp.expires_at) {
      throw new BadRequestException('Code OTP expiré');
    }

    // Marquer l'OTP comme utilisé
    otp.is_used = true;
    await this.otpRepository.save(otp);

    return { message: 'Vérification OTP réussie', verified: true };
  }

  async refreshToken(refreshToken: string): Promise<{ access_token: string }> {
    try {
      const payload = this.jwtService.verify(refreshToken, {
        secret: this.configService.get('JWT_REFRESH_SECRET'),
      });

      const user = await this.userRepository.findOne({
        where: { id: payload.sub },
        relations: ['roles'],
      });

      if (!user) {
        throw new UnauthorizedException();
      }

      const newPayload = { sub: user.id, email: user.email, roles: user.roles.map(role => role.name) };

      return {
        access_token: this.jwtService.sign(newPayload, {
          secret: this.configService.get('JWT_SECRET'),
          expiresIn: this.configService.get('JWT_EXPIRATION'),
        }),
      };
    } catch (error) {
      throw new UnauthorizedException('Token de rafraîchissement invalide');
    }
  }

  async createAdminUser(createAdminDto: CreateAdminDto): Promise<User> {
    // Vérifier si l'utilisateur existe déjà
    const existingUser = await this.userRepository.findOne({
      where: [
        { email: createAdminDto.email },
        { username: createAdminDto.username },
      ],
    });

    if (existingUser) {
      throw new BadRequestException('Email ou nom d\'utilisateur déjà utilisé');
    }

    // Vérifier si le rôle demandé existe
    const role = await this.roleRepository.findOne({
      where: { name: createAdminDto.role_type },
    });

    if (!role) {
      throw new BadRequestException(`Le rôle ${createAdminDto.role_type} n'existe pas`);
    }

    // Hasher le mot de passe
    const hashedPassword = await bcrypt.hash(createAdminDto.password, 10);

    // Créer le nouvel utilisateur
    const user = this.userRepository.create({
      ...createAdminDto,
      password: hashedPassword,
      is_admin: createAdminDto.role_type === 'admin',
    });

    // Assigner le rôle
    user.roles = [role];

    // Sauvegarder l'utilisateur
    const savedUser = await this.userRepository.save(user);
    
    // Retourner l'utilisateur sans le mot de passe
    const { password, ...result } = savedUser;
    return result as User;
  }
}