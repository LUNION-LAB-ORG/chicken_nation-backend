import { ApiProperty } from '@nestjs/swagger';
import { WebhookEvent } from '../enums/webhook-event.enum';
import { IsEnum, IsObject } from 'class-validator';

export class WebhookEventDto {
  @ApiProperty({
    example: WebhookEvent.DELIVERY_CREATED,
    enum: WebhookEvent,
    description: "Type d'événement reçu via le webhook"
  })
  @IsEnum(WebhookEvent)
  alias: WebhookEvent;

  @ApiProperty({
    description: "Payload dépendant du type d'événement",
    example: { orderId: "12345", courierId: "67890" }
  })
  @IsObject()
  data: any;
}

export class WebhookResponseDto {
  @ApiProperty({
    description: "Type d'événement",
    example: WebhookEvent.DELIVERY_CREATED,
  })
  event: WebhookEvent;

  @ApiProperty({
    description: "Statut de réception",
    example: true,
  })
  received: boolean;

  @ApiProperty({
    description: "Statut de traitement",
    example: true,
  })
  process: boolean;
}
