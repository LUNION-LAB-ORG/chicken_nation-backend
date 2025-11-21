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
}