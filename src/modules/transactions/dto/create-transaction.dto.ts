import { IsNotEmpty, IsString } from "class-validator";

export class CreateTransactionDto {
    @IsString()
    @IsNotEmpty()
    paymentPublicId: string;

    @IsString()
    @IsNotEmpty()
    method: string;
}