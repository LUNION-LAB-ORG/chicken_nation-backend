import { HttpException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateTicketCategoryDto } from '../dtos/create-ticket-category.dto';
import { UpdateTicketCategoryDto } from '../dtos/update-ticket-category.dto';
import { EntityStatus } from '@prisma/client';
import { FilterQueryDto } from 'src/common/dto/filter-query.dto';

@Injectable()
export class CategoriesTicketService {
    constructor(private readonly prisma: PrismaService) { }

    async create(createTicketCategoryDto: CreateTicketCategoryDto) {
        const exists = await this.prisma.ticketCategory.findUnique({
            where: { name: createTicketCategoryDto.name }
        });
        if (exists) {
            // Si la catégorie existe mais est en statut DELETED, on la réactive
            if (exists.entity_status === EntityStatus.DELETED) {
                return this.prisma.ticketCategory.update({
                    where: { id: exists.id },
                    data: { entity_status: EntityStatus.ACTIVE }
                });
            }
            throw new HttpException('Ce nom est déjà utilisé', 409);
        }

        return this.prisma.ticketCategory.create({ data: createTicketCategoryDto });
    }

    findAll(filter: FilterQueryDto) {
        const { search = '', page = 1, limit = 10 } = filter;
        return this.prisma.ticketCategory.findMany({
            where: {
                entity_status: { not: EntityStatus.DELETED },
                name: {
                    contains: search,
                    mode: 'insensitive'
                }
            },
            orderBy: { name: 'asc' },
            skip: (page - 1) * limit,
            take: limit
        });
    }

    async findOne(id: string) {
        const cat = await this.prisma.ticketCategory.findUnique({ where: { id } });
        if (!cat) throw new HttpException('Catégorie non trouvée', 404);
        return cat;
    }

    async update(id: string, updateTicketCategoryData: UpdateTicketCategoryDto) {
        if (updateTicketCategoryData.name) {
            const exists = await this.prisma.ticketCategory.findUnique({ where: { name: updateTicketCategoryData.name } });
            if (exists && exists.id !== id) throw new HttpException('Ce nom est déjà utilisé', 409);
        }
        return this.prisma.ticketCategory.update({ where: { id }, data: updateTicketCategoryData });
    }

    async remove(id: string) {
        await this.findOne(id);
        return this.prisma.ticketCategory.update({ where: { id }, data: { entity_status: EntityStatus.DELETED } });
    }
}
