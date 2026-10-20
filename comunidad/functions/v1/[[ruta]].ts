import { handle, type Env } from '../../src/hub';

export const onRequest: PagesFunction<Env> = ctx => handle(ctx.request, ctx.env);
