import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Deliverer } from '@prisma/client';

/**
 * Extrait le Deliverer injecté par JwtDelivererAuthGuard / JwtDelivererRefreshAuthGuard.
 *
 * Usage :
 *   @Get('me')
 *   @UseGuards(JwtDelivererAuthGuard)
 *   async me(@CurrentDeliverer() deliverer: Deliverer) { ... }
 */
export const CurrentDeliverer = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Omit<Deliverer, 'password' | 'refresh_token'> => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
