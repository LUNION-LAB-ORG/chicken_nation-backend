import { Body, Controller, Delete, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Deliverer } from '@prisma/client';

import { CurrentDeliverer } from '../decorators/current-deliverer.decorator';
import { CompleteRegistrationDto } from '../dto/complete-registration.dto';
import { DeleteAccountDto } from '../dto/delete-account.dto';
import { LoginDelivererDto } from '../dto/login-deliverer.dto';
import { RegisterPhoneDto } from '../dto/register-phone.dto';
import { ResetPasswordDto } from '../dto/reset-password.dto';
import { VerifyDelivererOtpDto } from '../dto/verify-otp.dto';
import { JwtDelivererAuthGuard } from '../guards/jwt-deliverer-auth.guard';
import { JwtDelivererRefreshAuthGuard } from '../guards/jwt-deliverer-refresh-auth.guard';
import { AuthDelivererService } from '../services/auth-deliverer.service';

@ApiTags('Auth — Deliverer')
@Controller('auth/deliverer')
export class AuthDelivererController {
  constructor(private readonly authService: AuthDelivererService) {}

  // ============================================================
  // INSCRIPTION
  // ============================================================

  @ApiOperation({ summary: 'Étape 1 inscription : envoi OTP au numéro' })
  @ApiBody({ type: RegisterPhoneDto })
  @Post('register')
  async register(@Body() dto: RegisterPhoneDto) {
    return this.authService.registerPhone(dto);
  }

  @ApiOperation({ summary: 'Étape 2 inscription : vérification OTP → verifyToken' })
  @ApiBody({ type: VerifyDelivererOtpDto })
  @Post('verify-otp')
  async verifyOtp(@Body() dto: VerifyDelivererOtpDto) {
    return this.authService.verifyRegistrationOtp(dto);
  }

  @ApiOperation({ summary: 'Étape 3 inscription : création du compte (PENDING_VALIDATION)' })
  @ApiBody({ type: CompleteRegistrationDto })
  @Post('complete-registration')
  async completeRegistration(@Body() dto: CompleteRegistrationDto) {
    return this.authService.completeRegistration(dto);
  }

  // ============================================================
  // CONNEXION
  // ============================================================

  @ApiOperation({ summary: 'Connexion livreur (phone + code 4 chiffres)' })
  @ApiBody({ type: LoginDelivererDto })
  @Post('login')
  async login(@Body() dto: LoginDelivererDto) {
    return this.authService.login(dto);
  }

  // ============================================================
  // MOT DE PASSE OUBLIÉ
  // ============================================================

  @ApiOperation({ summary: 'Reset étape 1 : envoi OTP pour réinitialisation' })
  @ApiBody({ type: RegisterPhoneDto })
  @Post('forgot-password')
  async forgotPassword(@Body() dto: RegisterPhoneDto) {
    return this.authService.forgotPassword(dto);
  }

  @ApiOperation({ summary: 'Reset étape 2 : vérification OTP → resetToken' })
  @ApiBody({ type: VerifyDelivererOtpDto })
  @Post('verify-reset-otp')
  async verifyResetOtp(@Body() dto: VerifyDelivererOtpDto) {
    return this.authService.verifyResetOtp(dto);
  }

  @ApiOperation({ summary: 'Reset étape 3 : définir le nouveau mot de passe' })
  @ApiBody({ type: ResetPasswordDto })
  @Post('reset-password')
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  // ============================================================
  // SESSION
  // ============================================================

  @ApiOperation({ summary: 'Rafraîchissement du token d\'accès' })
  @UseGuards(JwtDelivererRefreshAuthGuard)
  @Get('refresh-token')
  async refreshToken(@CurrentDeliverer() deliverer: Deliverer) {
    return this.authService.refreshAccessToken(deliverer.id);
  }

  @ApiOperation({ summary: 'Profil livreur connecté (inclut is_operational)' })
  @UseGuards(JwtDelivererAuthGuard)
  @Get('me')
  async me(@CurrentDeliverer() deliverer: Deliverer) {
    return this.authService.getMe(deliverer.id);
  }

  @ApiOperation({ summary: 'Déconnexion — révoque le refresh token' })
  @UseGuards(JwtDelivererAuthGuard)
  @Post('logout')
  async logout(@CurrentDeliverer() deliverer: Deliverer) {
    return this.authService.logout(deliverer.id);
  }

  @ApiOperation({
    summary: 'Programmer la suppression du compte (RGPD + grâce 90j)',
    description:
      "Marque le compte pour suppression dans 90 jours. Vérification par mot de passe. " +
      'Pendant la période de grâce, le user peut restaurer son compte via /me/restore.',
  })
  @ApiBody({ type: DeleteAccountDto })
  @UseGuards(JwtDelivererAuthGuard)
  @Delete('me/account')
  async deleteAccount(
    @CurrentDeliverer() deliverer: Deliverer,
    @Body() dto: DeleteAccountDto,
  ) {
    return this.authService.deleteAccount(deliverer.id, dto);
  }

  @ApiOperation({
    summary: 'Annuler une suppression programmée',
    description: 'Restaure un compte qui était programmé pour suppression.',
  })
  @UseGuards(JwtDelivererAuthGuard)
  @Post('me/restore')
  async restoreAccount(@CurrentDeliverer() deliverer: Deliverer) {
    return this.authService.restoreAccount(deliverer.id);
  }
}
