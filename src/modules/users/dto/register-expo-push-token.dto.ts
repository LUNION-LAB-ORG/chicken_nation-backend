import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * DTO d'enregistrement du token Expo Push d'un staff (Chicken Nation Pro).
 *
 * Appelé par le mobile au login (et lors de chaque renouvellement de token,
 * géré automatiquement par expo-notifications). Le token est stocké sur
 * `User.expo_push_token` et utilisé par `UserPushService` pour envoyer
 * les notifications de nouvelle commande aux staffs du restaurant.
 */
export class RegisterUserExpoPushTokenDto {
  @ApiProperty({
    description:
      'Token Expo Push (format ExponentPushToken[xxxxx]) — fourni par expo-notifications côté mobile',
    example: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  token: string;
}
