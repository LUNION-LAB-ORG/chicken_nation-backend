import { Injectable } from '@nestjs/common';
import { UserType } from '@prisma/client';
import { SettingsService } from 'src/modules/settings/settings.service';
import {
  CALLS_ROLES_CONFIG_KEY,
  CallerRoleConfig,
  CallsRolesConfig,
  DEFAULT_CALLS_ROLES_CONFIG,
} from '../constants/calls.constants';

/**
 * Lecture / écriture du routage des appels (Setting `calls.roles_config`).
 * La config stockée est fusionnée avec les défauts (résilient si une clé manque).
 */
@Injectable()
export class CallsConfigService {
  constructor(private readonly settings: SettingsService) {}

  /** Config effective : Setting admin fusionné avec les valeurs par défaut. */
  async getConfig(): Promise<CallsRolesConfig> {
    const stored = await this.settings.getJson<Partial<CallsRolesConfig>>(CALLS_ROLES_CONFIG_KEY);
    return {
      [UserType.BACKOFFICE]: {
        ...DEFAULT_CALLS_ROLES_CONFIG[UserType.BACKOFFICE],
        ...(stored?.[UserType.BACKOFFICE] ?? {}),
      },
      [UserType.RESTAURANT]: {
        ...DEFAULT_CALLS_ROLES_CONFIG[UserType.RESTAURANT],
        ...(stored?.[UserType.RESTAURANT] ?? {}),
      },
    };
  }

  /** Config applicable à un type d'appelant donné. */
  async getForCaller(callerType: UserType): Promise<CallerRoleConfig> {
    const cfg = await this.getConfig();
    return cfg[callerType];
  }

  /** Écrit la config (admin). Renvoie la config effective résultante. */
  async setConfig(config: CallsRolesConfig): Promise<CallsRolesConfig> {
    await this.settings.setJson(
      CALLS_ROLES_CONFIG_KEY,
      config,
      'Routage des appels internes (Lunion Meet)',
    );
    return this.getConfig();
  }
}
