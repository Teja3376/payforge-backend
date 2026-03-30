import { Body, Controller, Get, Param, Post, Put, Query } from "@nestjs/common";
import { TransactionService } from "./transaction.service";
import { CreateTransactionDto } from "./dto/create-transaction.dto";
import { UpdateTransactionDto } from "./dto/update-transaction.dto";
import { ApiQuery } from "@nestjs/swagger";

@Controller('transaction')
export class TransactionController {
    constructor(private readonly transactionService: TransactionService) { }

    @Post()
    createTransaction(@Body() dto: CreateTransactionDto) {
        return this.transactionService.createTransaction(dto)
    }

    @Put(':publicId')
    updateTransaction(
        @Param('publicId') publicId: string,
        @Body() dto: UpdateTransactionDto,
    ) {
        return this.transactionService.updateTransaction(publicId, dto.status)
    }
    @Get(':publicId')
    getTransaction(@Param('publicId') publicId: string) {
        return this.transactionService.getTransaction(publicId)
    }
    @Get()
    @ApiQuery({ name: 'cursor', required: false, type: String })
    @ApiQuery({ name: 'limit', required: false, type: String })
    getAllTransactions(
        @Query('cursor') cursor?: string,
        @Query('limit') limit?: string,
    ) {
        return this.transactionService.getAllTransactions(
            cursor,
            limit ? parseInt(limit) : 10
        );
    }
}