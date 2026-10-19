import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

@Injectable()
export class KeepAliveService {
  private readonly logger = new Logger(KeepAliveService.name);

  /**
   * Cron job that pings the public health endpoint every 5 minutes.
   * Render free tier spins down instances after 15 minutes of inactivity.
   * Calling the external URL through Render's public router counts as an active
   * incoming HTTP request and prevents hibernation.
   *
   * Render automatically sets RENDER_EXTERNAL_URL (e.g. https://your-app.onrender.com).
   * You can also specify KEEP_ALIVE_URL manually.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async keepAlive() {
    const baseUrl = process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL;
    if (!baseUrl) {
      return;
    }

    const targetUrl = `${baseUrl.replace(/\/+$/, '')}/health`;
    try {
      const response = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'PayForge-KeepAlive/1.0',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (response.ok) {
        this.logger.log(`Keep-alive ping sent to ${targetUrl} [${response.status}]`);
      } else {
        this.logger.warn(`Keep-alive ping to ${targetUrl} returned status [${response.status}]`);
      }
    } catch (error: any) {
      this.logger.warn(`Keep-alive ping to ${targetUrl} failed: ${error?.message || error}`);
    }
  }
}
