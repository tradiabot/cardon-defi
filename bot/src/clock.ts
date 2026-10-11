import { DurableObject } from 'cloudflare:workers';
import type { Env } from './config';
import { nextTick, runAll } from './scheduler';

/**
 * Reloj del bot: una alarma que se vuelve a programar sola cada 5 minutos y lanza los ciclos.
 * Cloudflare garantiza que una alarma programada se ejecuta (la reintenta si falla), y no depende del cron.
 */
export class Clock extends DurableObject<Env> {
  /** Arma la alarma si no hay ninguna pendiente (o si quedó atrasada). */
  async fetch(): Promise<Response> {
    const now = Date.now();
    const current = await this.ctx.storage.getAlarm();
    if (current !== null && current > now - 60_000) return new Response(`armado ${new Date(current).toISOString()}`);
    const next = nextTick(now);
    await this.ctx.storage.setAlarm(next);
    return new Response(`rearmado ${new Date(next).toISOString()}`);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    // Primero la siguiente alarma: pase lo que pase en este ciclo, el reloj no se detiene.
    await this.ctx.storage.setAlarm(nextTick(now));
    try {
      await runAll(this.env, now, 'reloj');
    } catch (error) {
      console.error('reloj: ciclo', error);
    }
  }
}
