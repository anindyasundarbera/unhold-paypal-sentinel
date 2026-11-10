/**
 * Render Cloud API Client & Deployment Inspector
 * Provides typed programmatic access to Render.com services, deploys, and build logs.
 */

export interface RenderService {
  id: string;
  name: string;
  type: string;
  repo?: string;
  branch?: string;
  suspended: string;
  serviceDetails?: {
    env?: string;
    url?: string;
    region?: string;
    plan?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface RenderDeploy {
  id: string;
  commit?: {
    id: string;
    message: string;
    createdAt: string;
  };
  status:
    | 'created'
    | 'build_in_progress'
    | 'live'
    | 'deactivated'
    | 'build_failed'
    | 'update_failed'
    | 'canceled';
  trigger: string;
  createdAt: string;
  finishedAt?: string;
}

export interface RenderEvent {
  id: string;
  timestamp: string;
  type: string;
  details?: Record<string, unknown>;
}

export class RenderClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey?: string, baseUrl: string = 'https://api.render.com/v1') {
    this.apiKey = apiKey || process.env.RENDER_API_KEY || '';
    this.baseUrl = baseUrl;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    if (!this.apiKey) {
      throw new Error(
        'RENDER_API_KEY is not set. Please add RENDER_API_KEY=rnd_... to your .env file or environment.'
      );
    }

    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...options.headers,
    };

    const res = await fetch(url, { ...options, headers });
    if (!res.ok) {
      const errorText = await res.text();
      let errorJson: { message?: string } = {};
      try {
        errorJson = JSON.parse(errorText);
      } catch {}
      throw new Error(
        `Render API error [HTTP ${res.status}] on ${endpoint}: ${errorJson.message || errorText}`
      );
    }

    return (await res.json()) as T;
  }

  /**
   * Lists all services in the Render account.
   */
  async listServices(limit: number = 20): Promise<RenderService[]> {
    const raw = await this.request<Array<{ service: RenderService }>>(`/services?limit=${limit}`);
    return raw.map((item) => item.service);
  }

  /**
   * Retrieves a specific service by ID.
   */
  async getService(serviceId: string): Promise<RenderService> {
    const raw = await this.request<{ service: RenderService }>(`/services/${serviceId}`);
    return raw.service || (raw as unknown as RenderService);
  }

  /**
   * Lists deploys for a given service.
   */
  async listDeploys(serviceId: string, limit: number = 10): Promise<RenderDeploy[]> {
    const raw = await this.request<Array<{ deploy: RenderDeploy }>>(
      `/services/${serviceId}/deploys?limit=${limit}`
    );
    return raw.map((item) => item.deploy);
  }

  /**
   * Gets details for a specific deploy.
   */
  async getDeploy(serviceId: string, deployId: string): Promise<RenderDeploy> {
    const raw = await this.request<{ deploy: RenderDeploy }>(
      `/services/${serviceId}/deploys/${deployId}`
    );
    return raw.deploy || (raw as unknown as RenderDeploy);
  }

  /**
   * Retrieves recent event logs for a service to inspect build/runtime failures.
   */
  async listEvents(serviceId: string, limit: number = 20): Promise<RenderEvent[]> {
    const raw = await this.request<Array<{ event: RenderEvent }>>(
      `/services/${serviceId}/events?limit=${limit}`
    );
    return raw.map((item) => item.event);
  }

  /**
   * Triggers a new deploy for the service, optionally clearing build cache.
   */
  async triggerDeploy(
    serviceId: string,
    clearCache: boolean = false
  ): Promise<RenderDeploy> {
    const raw = await this.request<{ deploy: RenderDeploy }>(
      `/services/${serviceId}/deploys`,
      {
        method: 'POST',
        body: JSON.stringify({
          clearCache: clearCache ? 'clear' : 'do_not_clear',
        }),
      }
    );
    return raw.deploy || (raw as unknown as RenderDeploy);
  }
}
