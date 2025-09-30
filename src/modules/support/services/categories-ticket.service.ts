import { AgentToCategoryDto } from './../dtos/category.dto';
import { HttpException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateTicketCategoryDto } from '../dtos/create-ticket-category.dto';
import { UpdateTicketCategoryDto } from '../dtos/update-ticket-category.dto';
import { EntityStatus } from '@prisma/client';
import { FilterQueryDto } from 'src/common/dto/filter-query.dto';
import { th } from 'date-fns/locale';

@Injectable()
export class CategoriesTicketService {
  private readonly logger = new Logger(CategoriesTicketService.name);
  private readonly isDev = process.env.NODE_ENV !== 'production';
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
    const { search = '', page = 1, limit = 10, orderBy = 'name', sort = 'asc' } = filter;

    this.logger.log(`Fetching categories - Page: ${page}, Limit: ${limit}, Search: "${search}" OrderBy: ${orderBy}, Sort: ${sort}`);

    const trimmedSearch = search.trim();
    this.logger.log(`Searching categories with query: ${trimmedSearch}`);

    return this.prisma.ticketCategory.findMany({
      where: {
        entity_status: { not: EntityStatus.DELETED },
        name: (trimmedSearch && trimmedSearch.length > 0) ? {
          contains: trimmedSearch,
          mode: 'insensitive'
        } : undefined
      },
      orderBy: orderBy ? { [orderBy]: sort || 'asc' } : { created_at: 'desc' },
      skip: (page - 1) * limit,
      take: limit
    });
  }

  async findOne(id: string) {
    this.logger.log(`Fetching category with ID: ${id}`);

    const cat = await this.prisma.ticketCategory.findUnique({ where: { id } });

    if (this.isDev) {
      this.logger.debug(`Category fetched: ${JSON.stringify(cat)}`);
    }

    if (!cat) throw new HttpException('Catégorie non trouvée', 404);
    return cat;
  }

  async update(id: string, updateTicketCategoryData: UpdateTicketCategoryDto) {

    if (updateTicketCategoryData.name) {
      const exists = await this.findOne(id);
      if (exists && exists.id !== id) throw new HttpException('Ce nom est déjà utilisé', 409);
    }
    return this.prisma.ticketCategory.update({ where: { id }, data: updateTicketCategoryData });
  }

  async remove(id: string) {
    this.logger.log(`Soft deleting category with ID: ${id}`);
    // await this.findOne(id);
    return this.prisma.ticketCategory.update({ where: { id }, data: { entity_status: EntityStatus.DELETED } });
  }

  async addAgentToCategory(addAgentToCategoryDto: AgentToCategoryDto) {
    const { categoryId, agentId: userId } = addAgentToCategoryDto;
    // Vérifier si la catégorie existe
    const category = await this.prisma.ticketCategory.findUnique({ where: { id: categoryId } });
    if (!category) {
      throw new HttpException('Catégorie non trouvée', 404);
    }
    // Vérifier si l'agent existe
    const agent = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!agent) {
      throw new HttpException('Agent non trouvé', 404);
    }
    // Vérifier si l'agent est déjà assigné à la catégorie
    const existingAssignment = await this.prisma.ticketUserSkill.findFirst({
      where: {
        categoryId,
        userId
      }
    });

    if (existingAssignment) {
      throw new HttpException('Agent déjà assigné à cette catégorie', 409);
    }

    // Assigner l'agent à la catégorie
    return this.prisma.ticketUserSkill.create({
      data: {
        categoryId,
        userId
      }
    });
  }

  async removeUserFromCategory(removeAgentDto: AgentToCategoryDto) {
    const { categoryId, agentId: userId } = removeAgentDto;
    this.logger.log(`Removing agent ${userId} from category ${categoryId}`);
    // Vérifier si la catégorie existe
    const [category, user] = await Promise.all([
      this.findOne(categoryId),
      this.prisma.user.findUnique({ where: { id: userId } })
    ]);

    if (!user) {
      throw new HttpException('Agent non trouvé', 404);
    }

    if (!category) {
      throw new HttpException('Catégorie non trouvée', 404);
    }

    // Vérifier si l'assignation existe
    const existingAssignment = await this.prisma.ticketUserSkill.findFirst({
      where: {
        categoryId,
        userId
      }
    });
    if (!existingAssignment) {
      throw new HttpException('Assignation non trouvée', 404);
    }
    return this.prisma.ticketUserSkill.delete({
      where: {
        id: existingAssignment.id
      }
    });
  }
}