import { DurableObject } from 'cloudflare:workers';
import handler from './worker.js';

// Authentication hashing and PDF inspection run within a Durable Object's
// CPU allowance. Database records remain in D1 and private media stays in R2.
export class PortalApi extends DurableObject {
  async fetch(request) {
    return handler.fetch(request, this.env, this.ctx);
  }
}

export default {
  async fetch(request, env, context) {
    if (new URL(request.url).pathname.startsWith('/api/')) {
      return env.PORTAL_API.getByName('portal').fetch(request);
    }
    return handler.fetch(request, env, context);
  },
  scheduled(event, env, context) {
    return handler.scheduled(event, env, context);
  },
};
