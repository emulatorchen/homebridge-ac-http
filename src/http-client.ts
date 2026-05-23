import http from 'http';
import https from 'https';
import axios, { type AxiosRequestConfig } from 'axios';
import type { EndpointConfig } from './types.js';

const _httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 1 });
const _httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 1 });

function agentFor(url: string): Pick<AxiosRequestConfig, 'httpAgent' | 'httpsAgent'> {
  return url.startsWith('https://') ? { httpsAgent: _httpsAgent } : { httpAgent: _httpAgent };
}

function extractJsonPath(data: unknown, path: string): string {
  const parts = path.replace(/^\$\./, '').split('.');
  let cursor: unknown = data;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== 'object') return String(cursor ?? '');
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return String(cursor ?? '');
}

export function applyMap(value: string, map?: Record<string, string>): string {
  if (!map) return value;
  return map[value] ?? value;
}

export function reverseMap(map: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [v, k]));
}

export async function httpGet(cfg: EndpointConfig): Promise<number> {
  const options: AxiosRequestConfig = { timeout: cfg.timeout ?? 5000, headers: cfg.headers, ...agentFor(cfg.url) };
  const resp   = await axios.get(cfg.url, options);
  const raw    = cfg.jsonPath ? extractJsonPath(resp.data, cfg.jsonPath) : String(resp.data);
  const mapped = applyMap(raw, cfg.valueMap);
  return parseFloat(mapped);
}

export async function httpSet(cfg: EndpointConfig, hkValue: number | string): Promise<void> {
  const setMap = cfg.setValueMap ?? (cfg.valueMap ? reverseMap(cfg.valueMap) : undefined);
  const mapped = applyMap(String(hkValue), setMap);
  const body   = cfg.body ? cfg.body.replace(/\{value\}/g, mapped) : mapped;
  const method = cfg.method ?? 'POST';
  const options: AxiosRequestConfig = { timeout: cfg.timeout ?? 5000, headers: cfg.headers, ...agentFor(cfg.url) };
  if (method === 'GET' || method === 'DELETE') {
    const sep = cfg.url.includes('?') ? '&' : '?';
    await axios({ method, url: `${cfg.url}${sep}value=${encodeURIComponent(mapped)}`, ...options });
  } else {
    let parsedBody: unknown = body;
    try { parsedBody = JSON.parse(body); } catch { /* send as string */ }
    await axios({ method, url: cfg.url, data: parsedBody, ...options });
  }
}
