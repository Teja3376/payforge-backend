import { Controller, Body, Post, Get, Param, Query } from "@nestjs/common";
import { PaymentService } from "./payment.service";
import { CreatePaymentDto } from "./dto/create-payment.dto";
import { ApiQuery } from "@nestjs/swagger";

@Controller('payment')
export class PaymentController {
    
    constructor(private readonly paymentService: PaymentService) { }

    @Post()
    createPayment(@Body() dto: CreatePaymentDto) {
        return this.paymentService.createPayment(dto)
    }

    @Get(':publicId')
    getPayment(@Param('publicId') publicId: string) {
        return this.paymentService.getPayment(publicId)
    }

    @Get()
    @ApiQuery({ name: 'cursor', required: false, type: String })
    @ApiQuery({ name: 'limit', required: false, type: String })
    getAllPayments(
        @Query('cursor') cursor?: string,
        @Query('limit') limit?: string,
    ) {
        return this.paymentService.getAllPayments(cursor, limit ? parseInt(limit) : 10);
    }
}