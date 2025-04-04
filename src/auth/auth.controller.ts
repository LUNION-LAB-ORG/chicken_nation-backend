import { Controller, Get, Post, Body, Req, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginUserDto } from './dto/login-user.dto';
import {
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import { Request } from 'express';
import { JwtRefreshAuthGuard } from './guard/jwt-refresh-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // LOGIN USER
  @ApiOperation({ summary: 'Connexion utilisateur' })
  @ApiOkResponse({
    type: String,
    description: 'Utilisateur, Token et refreshToken envoyé',
  })
  @ApiNotFoundResponse({
    description: 'Utilisateur non trouvé',
  })
  @ApiBody({ type: LoginUserDto })
  @Post('login')
  async login(@Body() data: LoginUserDto) {
    return this.authService.login(data);
  }

  // REFRESH TOKEN
  @ApiOperation({ summary: 'Rafraichissement du token' })
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
