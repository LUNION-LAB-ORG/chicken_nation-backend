import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CategoriesTicketService } from '../services/categories-ticket.service';
import { CreateTicketCategoryDto } from '../dtos/create-ticket-category.dto';
import { UpdateTicketCategoryDto } from '../dtos/update-ticket-category.dto';
import { FilterQueryDto } from 'src/common/dto/filter-query.dto';
import { AgentToCategoryDto } from '../dtos/category.dto';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { Action } from 'src/modules/auth/enums/action.enum';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';

@Controller('categories-ticket')
export class CategoriesTicketController {
  constructor(private readonly categoriesTicketService: CategoriesTicketService) { }

  // Create a new category
  // ⚠️ Aucune permission : tout membre du personnel modifiait le routage des tickets.
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.MESSAGES, Action.CREATE)
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
  // ⚠️ Aucune permission : tout membre du personnel modifiait le routage des tickets.
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.MESSAGES, Action.UPDATE)
  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  update(@Param('id') id: string, @Body() updateTicketCategoryDto: UpdateTicketCategoryDto) {
    return this.categoriesTicketService.update(id, updateTicketCategoryDto);
  }

  // Delete a category
  // ⚠️ Aucune permission : tout membre du personnel modifiait le routage des tickets.
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.MESSAGES, Action.DELETE)
  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  remove(@Param('id') id: string) {
    return this.categoriesTicketService.remove(id);
  }

  // Ajouter un agent a une categorie
  // ⚠️ Aucune permission : tout membre du personnel modifiait le routage des tickets.
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.MESSAGES, Action.UPDATE)
  @Post('agents')
  @UseGuards(JwtAuthGuard)
  addAgentToCategory(@Body() addAgentDto: AgentToCategoryDto) {
    return this.categoriesTicketService.addAgentToCategory(addAgentDto);
  }

  // Retirer un agent d'une categorie
  // ⚠️ Aucune permission : tout membre du personnel modifiait le routage des tickets.
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.MESSAGES, Action.UPDATE)
  @Post('agents/remove')
  @UseGuards(JwtAuthGuard)
  removeAgentFromCategory(@Body() removeAgentDto: AgentToCategoryDto) {
    return this.categoriesTicketService.removeUserFromCategory(removeAgentDto);
  }
}
