import { Controller, Post, Body } from '@nestjs/common';
import { KkiapayService } from './kkiapay.service';
import { KkiapayResponse } from './kkiapay.type';

@Controller('kkiapay')
export class KkiapayController {

    constructor(private readonly kkiapayService: KkiapayService) { }

    @Post('verify')
    async verifyTransaction(@Body() body: { transactionId: string }): Promise<KkiapayResponse> {
        return this.kkiapayService.verifyTransaction(body.transactionId);
    }

    @Post('refund')
    async refundTransaction(@Body() body: { transactionId: string }): Promise<KkiapayResponse> {
        return this.kkiapayService.refundTransaction(body.transactionId);
    }
}
