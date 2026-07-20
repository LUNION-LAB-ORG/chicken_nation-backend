import { Type } from 'class-transformer';
import { ArrayNotContains, IsArray, IsBoolean, IsEnum, IsIn, ValidateNested } from 'class-validator';
import { UserRole, UserType } from '@prisma/client';

class CallerRoleConfigDto {
  @IsBoolean()
  canCall: boolean;

  @IsIn(['RESTAURANT', 'CALL_CENTER'])
  targetKind: 'RESTAURANT' | 'CALL_CENTER';

  @IsEnum(UserType)
  receiverType: UserType;

  @IsArray()
  @IsEnum(UserRole, { each: true })
  @ArrayNotContains([UserRole.ADMIN])
  receiverRoles: UserRole[];
}

export class UpdateCallsConfigDto {
  @ValidateNested()
  @Type(() => CallerRoleConfigDto)
  BACKOFFICE: CallerRoleConfigDto;

  @ValidateNested()
  @Type(() => CallerRoleConfigDto)
  RESTAURANT: CallerRoleConfigDto;
}
