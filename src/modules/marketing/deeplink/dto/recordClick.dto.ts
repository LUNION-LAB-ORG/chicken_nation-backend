import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsOptional, IsString } from "class-validator";

export class RecordClickDto {
    @ApiPropertyOptional({ description: 'La plateforme sur laquelle le clic a été effectué (par exemple, web, mobile, etc.)' })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => String(value).trim())
    platform?: string;

    @ApiPropertyOptional({ description: "L'agent utilisateur (User-Agent) du client effectuant la requête" })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => String(value).trim())
    userAgent?: string;

    @ApiPropertyOptional({ description: "L'adresse IP du client effectuant le clic" })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => String(value).trim())
    ip?: string;

    @ApiPropertyOptional({ description: "L'URL de la page précédente qui a conduit au clic (Referer)" })
    @IsOptional()
    @Transform(({ value }) => String(value).trim())
    referer?: string

    @ApiPropertyOptional({ description: 'Le type de cible du deeplink (home, dish, category, order, voucher, loyalty, nation_card)' })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => String(value).trim())
    type?: string;

    @ApiPropertyOptional({ description: "L'identifiant de la cible du deeplink (id du plat, de la catégorie, etc.)" })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => String(value).trim())
    targetId?: string;

    @ApiPropertyOptional({ description: "Le libellé lisible de la cible du deeplink" })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => String(value).trim())
    targetLabel?: string;
}