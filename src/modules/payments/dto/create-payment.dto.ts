import { IsNotEmpty, IsNumber, IsObject, IsOptional, IsString, Min } from "class-validator";

export class CreatePaymentDto {
    @IsString()
    @IsNotEmpty()
    merchantId: string;

    @IsNumber()
    @IsNotEmpty()
    @Min(1)
    amount: number;

    @IsString()
    @IsNotEmpty()
    currency: string;

    @IsOptional()
    @IsObject()
    metadata: Record<string, any>;

    @IsOptional()
    @IsString()
    payerName: string;

    @IsOptional()
    @IsString()
    payerEmail: string;

    @IsOptional()
    @IsString()
    countryCode: string;

    @IsOptional()
    @IsString()
    payerPhone: string;

}