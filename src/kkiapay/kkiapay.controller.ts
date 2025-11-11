import { Body, Controller, Headers, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import * as crypto from 'crypto';
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
        @Headers('x-kkiapay-secret') signature: string,
        @Body() body: any,
    ) {
        const webhookSecret = this.configService.get<string>('KKIA_PAY_WEBHOOK_SECRET') ?? "";
        const rawBody = (request as any).rawBody || JSON.stringify(body);

        // Vérification de la signature
        const computed = crypto.createHmac('sha256', webhookSecret)
            .update(rawBody)
            .digest('hex');
        if (computed !== signature) {
            // signature invalide : on renvoie quand même 200 ou 400 selon politique
            console.log(`Invalid signature for webhook: ${signature}`);
            return response.status(HttpStatus.BAD_REQUEST).send('Invalid signature');
        }

        try {
            await this.kkiapayService.handleEvent(body);
            return response.send({ received: true });
        } catch (err) {
            console.log('Error processing webhook', err);
            // On renvoie 200 pour éviter retrys ou on renvoie 5xx selon design
            return response.status(HttpStatus.OK).send('Error processing');
        }
    }
}
