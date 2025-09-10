import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CategoriesTicketService } from '../services/categories-ticket.service';
import { CreateTicketCategoryDto } from '../dtos/create-ticket-category.dto';
import { UpdateTicketCategoryDto } from '../dtos/update-ticket-category.dto';
import { FilterQueryDto } from 'src/common/dto/filter-query.dto';
import { AgentToCategoryDto } from '../dtos/category.dto';

@Controller('categories-ticket')
export class CategoriesTicketController {
    constructor(private readonly categoriesTicketService: CategoriesTicketService) { }

    // Create a new category
    @Post()
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
    update(@Param('id') id: string, @Body() updateTicketCategoryDto: UpdateTicketCategoryDto) {
        return this.categoriesTicketService.update(id, updateTicketCategoryDto);
    }

    // Delete a category
    @Delete(':id')
    remove(@Param('id') id: string) {
        return this.categoriesTicketService.remove(id);
    }

    // Ajouter un agent a une categorie
    @Post('agents')
    addAgentToCategory(@Body() addAgentDto: AgentToCategoryDto) {
        return this.categoriesTicketService.addAgentToCategory(addAgentDto);
    }

    // Retirer un agent d'une categorie
    @Delete('agents')
    removeAgentFromCategory(@Body() removeAgentDto: AgentToCategoryDto) {
        return this.categoriesTicketService.removeUserFromCategory(removeAgentDto);
    }
}
