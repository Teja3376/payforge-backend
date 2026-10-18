import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { HealthResponseDto } from './dto/health-response.dto';
import { PrismaService } from '../../database/prisma.service';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Liveness: is the process up? Deliberately does not touch dependencies, so
   * a database blip cannot cause the orchestrator to restart a healthy process.
   */
  @Public()
  @Get()
  @ApiOperation({ summary: 'Liveness check' })
  @ApiOkResponse({ type: HealthResponseDto })
  health(): HealthResponseDto {
    return { status: 'ok' };
  }

  /**
   * Readiness: can the process actually serve traffic?
   *
   * The original returned `{status:'ok'}` unconditionally, so a process with a
   * dead database was still routed traffic and accepted every request into a
   * guaranteed 500.
   */
  @Public()
  @Get('ready')
  @ApiOperation({ summary: 'Readiness check — verifies database connectivity' })
  @ApiOkResponse({ type: HealthResponseDto })
  @ApiServiceUnavailableResponse({ description: 'A dependency is unreachable.' })
  async ready(): Promise<HealthResponseDto> {
    const startedAt = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', database: 'up', latencyMs: Date.now() - startedAt };
    } catch {
      throw new ServiceUnavailableException({
        status: 'unavailable',
        database: 'down',
      });
    }
  }
}
