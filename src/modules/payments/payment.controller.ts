import { Controller, Body, Post, Get, Param } from "@nestjs/common";
import { PaymentService } from "./payment.service";
import { CreatePaymentDto } from "./dto/create-payment.dto";

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
    getAllPayments() {
        return this.paymentService.getAllPayments()
    }
}