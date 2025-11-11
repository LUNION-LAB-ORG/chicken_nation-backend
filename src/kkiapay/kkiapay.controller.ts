import { Body, Controller, Headers, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { KkiapayService } from './kkiapay.service';
import { KkiapayResponse } from './kkiapay.type';
import { ConfigService } from '@nestjs/config';

@Controller('kkiapay')
export class KkiapayController {

    constructor(private readonly kkiapayService: KkiapayService, private readonly configService: ConfigService) { }

    @Post('verify')
    async verifyTransaction(@Body() body: { transactionId: string }): Promise<KkiapayResponse> {
        return this.kkiapayService.verifyTransaction(body.transactionId);
    }

    @Post('refund')
    async refundTransaction(@Body() body: { transactionId: string }): Promise<KkiapayResponse> {
        return this.kkiapayService.refundTransaction(body.transactionId);
    }

    @Post("webhook")
    @HttpCode(HttpStatus.OK)
    async handleWebhook(
        @Req() request: Request,
        @Res() response: Response,
        @Headers('x-kkiapay-secret') receivedSecret: string,
        @Body() body: any,
    ) {
        const webhookSecret = this.configService.get<string>('KKIA_PAY_WEBHOOK_SECRET') ?? "";

        console.log("Received secret:", receivedSecret);
        console.log("Expected secret:", webhookSecret);

        // Vérification simple : Kkiapay renvoie le secret en clair
        if (receivedSecret !== webhookSecret) {
            console.warn(`Invalid webhook secret`);
            return response.status(HttpStatus.FORBIDDEN).send('Invalid secret');
        }

        try {
            await this.kkiapayService.handleEvent(body);
            return response.send({ received: true });
        } catch (err) {
            console.error('Error processing webhook', err);
            return response.status(HttpStatus.OK).send('Error processing');
        }
    }
}
