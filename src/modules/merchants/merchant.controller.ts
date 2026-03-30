import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common'
import { MerchantService } from './merchant.service'
import { CreateMerchantDto } from './dto/create-merchant.dto'
import { ApiQuery } from '@nestjs/swagger';

@Controller('merchant')
export class MerchantController {

  constructor(private readonly merchantService: MerchantService) { }

  @Post()
  createMerchant(@Body() dto: CreateMerchantDto) {
    return this.merchantService.createMerchant(dto)
  }

  @Get()
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: String })
  getAllMerchants(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.merchantService.getAllMerchants(
      cursor,
      limit ? parseInt(limit) : 10
    );
  }

  @Get(':publicId')
  getMerchant(@Param('publicId') publicId: string) {
    return this.merchantService.getMerchant(publicId)
  }

}