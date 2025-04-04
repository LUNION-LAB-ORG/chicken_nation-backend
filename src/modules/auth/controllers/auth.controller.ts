import { Controller, Post, Body, UseGuards, Get, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from '../services/auth.service';
import { CreateUserDto } from '../dto/create-user.dto';
import { LoginDto } from '../dto/login.dto';
import { OtpRequestDto } from '../dto/otp-request.dto';
import { OtpVerifyDto } from '../dto/otp-verify.dto';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @ApiOperation({ summary: 'Inscription d\'un nouvel utilisateur' })
  @ApiResponse({ status: 201, description: 'Utilisateur créé avec succès' })
  @ApiResponse({ status: 400, description: 'Données invalides' })
  async register(@Body() createUserDto: CreateUserDto) {
    return this.authService.register(createUserDto);
  }

  @Post('login')
  @ApiOperation({ summary: 'Connexion utilisateur' })
  @ApiResponse({ status: 200, description: 'Connexion réussie' })
  @ApiResponse({ status: 401, description: 'Identifiants invalides' })
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  @Post('otp/request')
  @ApiOperation({ summary: 'Demande de code OTP' })
  @ApiResponse({ status: 200, description: 'Code OTP envoyé' })
  async requestOtp(@Body() otpRequestDto: OtpRequestDto) {
    return this.authService.requestOtp(otpRequestDto);
  }

  @Post('otp/verify')
  @ApiOperation({ summary: 'Vérification de code OTP' })
  @ApiResponse({ status: 200, description: 'Code OTP vérifié' })
  @ApiResponse({ status: 400, description: 'Code OTP invalide ou expiré' })
  async verifyOtp(@Body() otpVerifyDto: OtpVerifyDto) {
    return this.authService.verifyOtp(otpVerifyDto);
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Rafraîchir le token d\'accès' })
  @ApiResponse({ status: 200, description: 'Token rafraîchi avec succès' })
  @ApiResponse({ status: 401, description: 'Token de rafraîchissement invalide' })
  async refreshToken(@Body() body: { refresh_token: string }) {
    return this.authService.refreshToken(body.refresh_token);
  }

  @Get('profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Obtenir le profil utilisateur' })
  @ApiResponse({ status: 200, description: 'Profil récupéré avec succès' })
  @ApiResponse({ status: 401, description: 'Non autorisé' })
  getProfile(@Req() req) {
    return req.user;
  }
}