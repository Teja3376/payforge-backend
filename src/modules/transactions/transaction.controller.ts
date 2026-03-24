import { Body, Controller, Get, Param, Post, Put } from "@nestjs/common";
import { TransactionService } from "./transaction.service";
import { CreateTransactionDto } from "./dto/create-transaction.dto";
import { UpdateTransactionDto } from "./dto/update-transaction.dto";

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
    getAllTransactions() {
        return this.transactionService.getAllTransactions()
    }
}