import { Body, Controller, Get, Param, Post } from '@nestjs/common'
import { MerchantService } from './merchant.service'
import { CreateMerchantDto } from './dto/create-merchant.dto'

@Controller('merchant')
export class MerchantController {

  constructor(private readonly merchantService: MerchantService) { }

  @Post()
  createMerchant(@Body() dto: CreateMerchantDto) {
    return this.merchantService.createMerchant(dto)
  }

  @Get()
  getAllMerchants() {
    return this.merchantService.getAllMerchants()
  }

  @Get(':publicId')
  getMerchant(@Param('publicId') publicId: string) {
    return this.merchantService.getMerchant(publicId)
  }

}