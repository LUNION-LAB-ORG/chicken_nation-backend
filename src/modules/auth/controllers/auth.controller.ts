import { Controller, Get, Post, Body, Req, UseGuards, Query } from '@nestjs/common';
import { AuthService } from 'src/modules/auth/services/auth.service';
import { LoginUserDto } from 'src/modules/auth/dto/login-user.dto';
import {
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { User, UserRole } from '@prisma/client';
import { permissionsByRole } from '../constantes/permissionsByRole';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { JwtRefreshAuthGuard } from '../guards/jwt-refresh-auth.guard';
import { VerifyOtpDto } from '../dto/verify-otp.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) { }

  // LOGIN USER
  @ApiOperation({ summary: 'Connexion utilisateur' })
  @ApiOkResponse({
    type: String,
    description: 'Utilisateur, Token et refreshToken envoyé',
  })
  @ApiNotFoundResponse({ description: 'Utilisateur non trouvé' })
  @ApiBody({ type: LoginUserDto })
  @Post('login')
  async login(@Body() data: LoginUserDto) {
    return this.authService.login(data);
  }

  // LOGIN CUSTOMER
  @ApiOperation({ summary: 'Connexion client' })
  @ApiOkResponse({
    type: String,
    description: 'Client, Token et refreshToken envoyé',
  })
  @ApiNotFoundResponse({ description: 'Client non trouvé' })
  @ApiBody({ type: String })
  @Post('customer/login')
  async loginCustomer(@Body() { phone }: { phone: string }) {
    return this.authService.loginCustomer(phone);
  }

  // VERIFY OTP CUSTOMER
  @ApiOperation({ summary: 'Vérification du code OTP' })
  @ApiOkResponse({
    type: String,
    description: 'Client, Token et refreshToken envoyé',
  })
  @ApiNotFoundResponse({ description: 'Client non trouvé' })
  @ApiBody({ type: VerifyOtpDto })
  @Post('customer/verify-otp')
  async verifyOtpCustomer(@Body() data: VerifyOtpDto) {
    return this.authService.verifyOtp(data);
  }

  // DROITS À JOUR
  // Les droits sont recopiés dans le cookie à la connexion : quand un rôle
  // change (nouveau module, droit ajouté), le backoffice les relit ici au lieu
  // d'exiger une reconnexion.
  @ApiOperation({ summary: "Rôle et droits actuels de l'utilisateur connecté" })
  @UseGuards(JwtAuthGuard)
  @Get('permissions')
  permissions(@Req() req: Request) {
    const user = req.user as User;
    return { role: user.role, permissions: permissionsByRole[user.role as UserRole] ?? null };
  }

  // REFRESH TOKEN
  @ApiOperation({ summary: 'Rafraichissement du token utilisateur' })
  @ApiOkResponse({
    type: String,
    description: 'Token envoyé',
  })
  @ApiNotFoundResponse({
    description: 'Utilisateur non trouvé',
  })
  @UseGuards(JwtRefreshAuthGuard)
  @Get('refresh-token')
  async refreshToken(@Req() req: Request) {
    return this.authService.refreshToken(req);
  }
}
