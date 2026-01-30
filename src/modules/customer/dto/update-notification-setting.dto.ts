import { Transform } from "class-transformer";
import { IsBoolean, IsOptional, IsString } from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";

export class UpdateNotificationSettingDto {
    @ApiPropertyOptional({
        description: 'Activer les notifications push',
        example: true,
    })
    @IsOptional()
    @IsBoolean()
    @Transform(({ value }) => Boolean(value))
    push?: boolean;

    @ApiPropertyOptional({
        description: 'Activer les notifications promotion',
        example: true,
    })
    @IsOptional()
    @IsBoolean()
    @Transform(({ value }) => Boolean(value))
    promotions?: boolean;

    @ApiPropertyOptional({
        description: 'Activer les notifications système',
        example: true,
    })
    @IsOptional()
    @IsBoolean()
    @Transform(({ value }) => Boolean(value))
    system?: boolean;

    @ApiPropertyOptional({
        description: 'Token push expo',
        example: 'expo_push_token',
    })
    @IsOptional()
    @IsString()
    expo_push_token?: string;

    @ApiPropertyOptional({
        description: 'ID OneSignal',
        example: 'onesignal_id',
    })
    @IsOptional()
    @IsString()
    onesignal_id?: string;

    @ApiPropertyOptional({
        description: 'ID OneSignal',
        example: 'onesignal_subscription_id',
    })
    @IsOptional()
    @IsString()
    onesignal_subscription_id?: string;
}
