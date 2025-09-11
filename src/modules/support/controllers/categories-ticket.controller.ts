import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CategoriesTicketService } from '../services/categories-ticket.service';
import { CreateTicketCategoryDto } from '../dtos/create-ticket-category.dto';
import { UpdateTicketCategoryDto } from '../dtos/update-ticket-category.dto';
import { FilterQueryDto } from 'src/common/dto/filter-query.dto';
import { AgentToCategoryDto } from '../dtos/category.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';

@Controller('categories-ticket')
export class CategoriesTicketController {
  constructor(private readonly categoriesTicketService: CategoriesTicketService) { }

  // Create a new category
  @Post()
  @UseGuards(JwtAuthGuard)
  create(@Body() createTicketCategoryDto: CreateTicketCategoryDto) {
    return this.categoriesTicketService.create(createTicketCategoryDto);
  }

  // Get all categories
  @Get()
  findAll(@Query() filter: FilterQueryDto) {
    return this.categoriesTicketService.findAll(filter);
  }

  // Get a single category by ID
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.categoriesTicketService.findOne(id);
  }

  // Update a category
  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  update(@Param('id') id: string, @Body() updateTicketCategoryDto: UpdateTicketCategoryDto) {
    return this.categoriesTicketService.update(id, updateTicketCategoryDto);
  }

  // Delete a category
  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  remove(@Param('id') id: string) {
    return this.categoriesTicketService.remove(id);
  }

  // Ajouter un agent a une categorie
  @Post('agents')
  @UseGuards(JwtAuthGuard)
  addAgentToCategory(@Body() addAgentDto: AgentToCategoryDto) {
    return this.categoriesTicketService.addAgentToCategory(addAgentDto);
  }

  // Retirer un agent d'une categorie
  @Post('agents/remove')
  @UseGuards(JwtAuthGuard)
  removeAgentFromCategory(@Body() removeAgentDto: AgentToCategoryDto) {
    return this.categoriesTicketService.removeUserFromCategory(removeAgentDto);
  }
}
