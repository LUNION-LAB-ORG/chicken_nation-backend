import {
  Controller,
  Get,
  Put,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { SettingsService } from './settings.service';

@Controller('settings')
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  @RequirePermission(Modules.SETTINGS, Action.READ)
  async getAll(@Query('prefix') prefix?: string) {
    return this.settingsService.getAll(prefix);
  }

  @Get(':key')
  @RequirePermission(Modules.SETTINGS, Action.READ)
  async getOne(@Param('key') key: string) {
    const value = await this.settingsService.get(key);
    return { key, value };
  }

  @Put(':key')
  @RequirePermission(Modules.SETTINGS, Action.UPDATE)
  async upsert(
    @Param('key') key: string,
    @Body() body: { value: string; description?: string },
  ) {
    return this.settingsService.set(key, body.value, body.description);
  }

  @Delete(':key')
  @RequirePermission(Modules.SETTINGS, Action.DELETE)
  async remove(@Param('key') key: string) {
    await this.settingsService.delete(key);
    return { message: `Setting "${key}" supprimé` };
  }
}
