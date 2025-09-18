import { SetMetadata } from '@nestjs/common';
import { Action } from 'src/common/enum/action.enum';
import { Modules } from 'src/common/enum/module-enum';

export const REQUIRE_PERMISSION_KEY = 'permission';
export const RequirePermission = (module: Modules, action: Action) =>
  SetMetadata(REQUIRE_PERMISSION_KEY, { module, action });
