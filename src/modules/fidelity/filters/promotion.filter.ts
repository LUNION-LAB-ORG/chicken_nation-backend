import { BadRequestException } from "@nestjs/common";
import { PromotionErrorKeys } from "../enums/promotion-error-keys.enum";

export class PromotionException extends BadRequestException {
    constructor(error: { key: PromotionErrorKeys; message: string; data?: any }) {
        super(
            {
                error_key: error.key,
                message: error.message,
                data: error.data,
            }
        );
    }
}