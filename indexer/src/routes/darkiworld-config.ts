/**
 * Darkiworld Configuration Routes
 * Provides API endpoints to proxy configuration requests to the Darkiworld container
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { fetchJson } from '../utils/http.js';

interface DarkiworldConfig {
  enabled: boolean;
  email: string;
  has_password: boolean;
  authenticated: boolean;
}

interface DarkiworldConfigResponse extends DarkiworldConfig {
  success?: boolean;
  error?: string;
}

interface ConfigUpdateBody {
  enabled?: boolean;
  email?: string;
  password?: string;
}

export async function darkiworldConfigRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /darkiworld/config - Get current Darkiworld configuration
   */
  fastify.get('/darkiworld/config', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const response = await fetchJson<DarkiworldConfigResponse>(
        `${config.darkiworldServiceUrl}/config`,
        { timeout: 5000 }
      );
      return response;
    } catch (error) {
      console.error('[Darkiworld Config] Error fetching config:', error);
      reply.status(500);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch config',
        enabled: false,
        email: '',
        has_password: false,
        authenticated: false,
      };
    }
  });

  /**
   * POST /darkiworld/config - Update Darkiworld configuration
   */
  fastify.post<{ Body: ConfigUpdateBody }>(
    '/darkiworld/config',
    async (request: FastifyRequest<{ Body: ConfigUpdateBody }>, reply: FastifyReply) => {
      try {
        const { enabled, email, password } = request.body || {};

        const payload: Record<string, unknown> = {};
        if (typeof enabled === 'boolean') payload.enabled = enabled;
        if (typeof email === 'string') payload.email = email;
        if (typeof password === 'string' && password) payload.password = password;

        const response = await fetch(`${config.darkiworldServiceUrl}/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        const data = (await response.json()) as DarkiworldConfigResponse;
        return data;
      } catch (error) {
        console.error('[Darkiworld Config] Error updating config:', error);
        reply.status(500);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update config',
        };
      }
    }
  );

  /**
   * POST /darkiworld/test-login - Test login with credentials
   */
  fastify.post<{ Body: ConfigUpdateBody }>(
    '/darkiworld/test-login',
    {
      config: {
        // Extend Fastify's default timeout for this slow endpoint
      },
    },
    async (request: FastifyRequest<{ Body: ConfigUpdateBody }>, reply: FastifyReply) => {
      try {
        const { email, password } = request.body || {};

        const payload: Record<string, unknown> = {};
        if (typeof email === 'string') payload.email = email;
        if (typeof password === 'string' && password) payload.password = password;

        // 90 second timeout for login test (can take up to 60s with Turnstile)
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 90000);

        try {
          const response = await fetch(`${config.darkiworldServiceUrl}/test-login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          const data = (await response.json()) as { success: boolean; authenticated: boolean; message: string };
          
          if (!response.ok) {
            reply.status(response.status);
          }
          
          return data;
        } catch (fetchError) {
          clearTimeout(timeoutId);
          throw fetchError;
        }
      } catch (error) {
        console.error('[Darkiworld Config] Error testing login:', error);
        reply.status(500);
        
        const message = error instanceof Error 
          ? (error.name === 'AbortError' ? 'Timeout - le test a pris trop de temps' : error.message)
          : 'Failed to test login';
        
        return {
          success: false,
          authenticated: false,
          message,
        };
      }
    }
  );
}

export default darkiworldConfigRoutes;

