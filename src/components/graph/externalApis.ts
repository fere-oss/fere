import type { ExternalApi } from '../../types/electron';

export const EXTERNAL_API_CACHE_TTL_MS = 60000;
export const externalApiCache = new Map<string, { timestamp: number; apis: ExternalApi[] }>();
export const externalApiInFlight = new Set<string>();
