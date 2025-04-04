import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../entities/user.entity';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    @InjectRepository(User)
    private userRepository: Repository<User>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get('JWT_SECRET'),
    });
  }

  async validate(payload: any) {
    // Récupérer l'utilisateur complet avec ses rôles
    const user = await this.userRepository.findOne({
      where: { id: payload.sub },
      relations: ['roles'],
    });

    if (!user) {
      return { userId: payload.sub, email: payload.email, roles: payload.roles };
    }

    // Extraire les noms des rôles pour faciliter la vérification
    const roleNames = user.roles.map(role => role.name);

  
    return {
      userId: user.id,
      email: user.email,
      username: user.username,
      is_admin: user.is_admin,
      roles: roleNames,   
      user_roles: user.roles  
    };
  }
}