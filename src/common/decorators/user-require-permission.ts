import { SetMetadata } from '@nestjs/common';

export const REQUIRE_PERMISSION_KEY = 'permission';
export const RequirePermission = (module: string, action: string) =>
  SetMetadata(REQUIRE_PERMISSION_KEY, { module, action });
