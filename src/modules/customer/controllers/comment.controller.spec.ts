import { GUARDS_METADATA } from '@nestjs/common/constants';
import { User, UserRole, UserType } from '@prisma/client';
import type { Request } from 'express';
import { REQUIRE_PERMISSION_KEY } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { CommentService } from '../services/comment.service';
import { CommentController } from './comment.controller';

const proto = CommentController.prototype;
const gardes = (methode: keyof CommentController) => Reflect.getMetadata(GUARDS_METADATA, proto[methode]);
const droit = (methode: keyof CommentController) => Reflect.getMetadata(REQUIRE_PERMISSION_KEY, proto[methode]);

describe('CommentController, routes de lecture', () => {
  it("GET /comments/:id : personnel avec COMMENTAIRES READ, plus d'accès sans jeton", () => {
    expect(gardes('getCommentById')).toEqual([JwtAuthGuard, UserPermissionsGuard]);
    expect(droit('getCommentById')).toEqual({ module: Modules.COMMENTAIRES, action: Action.READ });
  });

  it('GET /comments/dish/:dishId : personnel avec MENUS READ (fiche plat)', () => {
    expect(gardes('getDishComments')).toEqual([JwtAuthGuard, UserPermissionsGuard]);
    expect(droit('getDishComments')).toEqual({ module: Modules.MENUS, action: Action.READ });
  });

  it('GET /comments/bests reste publique pour le site', () => {
    expect(gardes('getBestComments')).toBeUndefined();
  });

  it('les corrections du personnel ne déclarent plus deux fois la garde du jeton', () => {
    expect(gardes('setSiteVisible')).toEqual([JwtAuthGuard, UserPermissionsGuard]);
    expect(gardes('updateMessageAsStaff')).toEqual([JwtAuthGuard, UserPermissionsGuard]);
  });

  it('passe le restaurant du jeton, jamais celui de la requête', async () => {
    const service = {
      getCommentById: jest.fn().mockResolvedValue({}),
      getDishComments: jest.fn().mockResolvedValue({}),
    };
    const controller = new CommentController(service as unknown as CommentService);
    const caissier = { role: UserRole.CAISSIER, type: UserType.RESTAURANT, restaurant_id: 'r1' } as User;
    const admin = { role: UserRole.ADMIN, type: UserType.BACKOFFICE, restaurant_id: null } as User;
    const req = (user: User) => ({ user }) as unknown as Request;

    await controller.getCommentById(req(caissier), 'a1');
    expect(service.getCommentById).toHaveBeenLastCalledWith('a1', 'r1');
    await controller.getCommentById(req(admin), 'a1');
    expect(service.getCommentById).toHaveBeenLastCalledWith('a1', undefined);

    await controller.getDishComments(req(caissier), 'd1', { restaurantId: 'r2' });
    expect(service.getDishComments).toHaveBeenLastCalledWith('d1', { restaurantId: 'r2' }, 'r1');
  });
});
