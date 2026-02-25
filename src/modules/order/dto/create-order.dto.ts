import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ArrayMinSize, IsArray, IsDateString, IsEnum, IsInt, IsOptional, IsString, IsBoolean, IsUUID, ValidateNested, IsNumber } from "class-validator";
import { Transform, Type } from "class-transformer";
import { CreateOrderItemDto } from "src/modules/order/dto/create-order-item.dto";
import { OrderType } from "src/modules/order/enums/order-type.enum";
import { TypeTable } from "src/modules/order/enums/order-type-table.enum";
import { parse, isValid } from 'date-fns';
import { PaymentMethod } from "@prisma/client";

export class CreateOrderDto {
    @ApiProperty({ description: "Type de commande", enum: OrderType })
    @IsEnum(OrderType)
    type: OrderType;

    @ApiPropertyOptional({ description: "Type de paiement", enum: PaymentMethod })
    @IsEnum(PaymentMethod)
    @IsOptional()
    payment_method?: PaymentMethod;
    
    @ApiPropertyOptional({ description: "Type de table", enum: TypeTable })
    @IsEnum(TypeTable)
    @IsOptional()
    table_type?: TypeTable;

    @ApiPropertyOptional({ description: "Nombre de places" })
    @IsOptional()
    @IsInt()
    @Type(() => Number)
    places?: number;

    @ApiPropertyOptional({ description: "l'adresse de livraison/retrait" })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => typeof value !== "string" ? (typeof value == "object" ? JSON.stringify(value) : String(value)) : value)
    address?: string;

    @ApiPropertyOptional({ description: "Code promo" })
    @IsOptional()
    @IsString()
    code_promo?: string;

    @ApiPropertyOptional({ description: "Date souhaitée de livraison" })
    @IsOptional()
    @IsDateString({}, { message: 'La date de livraison doit être au format JJ/MM/AAAA' })
    @Transform(({ value }) => {
        const parsedDate = parse(value, 'dd/MM/yyyy', new Date());
        if (isValid(parsedDate)) {
            return parsedDate.toISOString();
        }
        return new Date().toISOString();
    })
    date?: string;

    @ApiPropertyOptional({ description: "Heure souhaitée de livraison" })
    @IsOptional()
    @IsString()
    time?: string;

    @ApiPropertyOptional({ description: "Nom complet du client" })
    @IsOptional()
    @IsString()
    fullname?: string;

    @ApiPropertyOptional({ description: 'Numéro de téléphone du client', example: '+225070707070' })
    @IsOptional()
    // @IsPhoneNumber("CI", { message: 'Numéro de téléphone non valide, utilisez le format +225' })
    @IsString()
    @Transform(({ value }) => value.trim())
    phone?: string;

    @ApiPropertyOptional({ description: "Email du client" })
    @IsOptional()
    @IsString()
    email?: string;

    @ApiPropertyOptional({ description: "Note ou commentaire sur la commande" })
    @IsOptional()
    @IsString()
    note?: string;

    @ApiProperty({ description: "Éléments de la commande", type: [CreateOrderItemDto] })
    @IsArray()
    @ValidateNested({ each: true })
    @ArrayMinSize(1)
    @Type(() => CreateOrderItemDto)
    items: CreateOrderItemDto[];

    @ApiPropertyOptional({ description: "ID du client" })
    @IsOptional()
    @IsUUID()
    customer_id?: string;

    @ApiPropertyOptional({ description: "ID du restaurant" })
    @IsOptional()
    @IsUUID()
    restaurant_id?: string;

    @ApiPropertyOptional({ description: "ID du paiement" })
    @IsOptional()
    @IsUUID()
    paiement_id?: string;

    @ApiPropertyOptional({ description: "Points de fidélité à utiliser" })
    @IsOptional()
    @IsInt()
    @Type(() => Number)
    points?: number;

    @ApiPropertyOptional({ description: "ID de la promotion" })
    @IsOptional()
    @IsUUID()
    promotion_id?: string;

    @ApiPropertyOptional({ description: "Commande automatique" })
    @IsOptional()
    @Transform(({ value }) => String(value).trim() == "true" ? true : false)
    @IsBoolean()
    auto?: boolean;

    @ApiPropertyOptional({ description: "Celui qui a enregistrer la commande" })
    @IsOptional()
    @Transform(({ value }) => value.trim())
    @IsString()
    user_id?: string;

    @ApiPropertyOptional({ description: "Celui qui a enregistrer la commande" })
    @IsOptional()
    @IsNumber()
    @Type(() => Number)
    delivery_fee?: number;
}