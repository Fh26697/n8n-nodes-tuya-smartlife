import * as crypto from 'crypto';
import * as https from 'https';
import { URL } from 'url';
import { SCHEMA, ENDPOINT, NONCE_CHARS } from './constants';

export interface TokenInfo {
  accessToken: string;
  refreshToken: string;
  expireTime: number; // absolute ms timestamp
  uid: string;
  terminalId: string;
  endpoint: string; // returned by login response, varies per user/region
}

export interface Device {
  id: string;
  name: string;
  category: string;
  online: boolean;
  status: Status[];
  homeId: string;
}

export interface Status {
  code: string;
  value: boolean | number | string;
}

export interface Command {
  code: string;
  value: boolean | number | string;
}

export interface FunctionSpec {
  code: string;
  type: string;   // 'Boolean' | 'Integer' | 'Enum' | 'String' | 'Json'
  values: string; // JSON string describing allowed values / range
}

export interface EndpointCandidate {
  method: string;
  path: string;
  params?: Record<string, string>;
  body?: Record<string, unknown>;
}

export interface EndpointResult {
  endpoint: string;
  method: string;
  success: boolean;
  result?: any;
  error?: string;
}

export class TuyaApiClient {
  private tokenInfo: TokenInfo | null;
  private endpoint: string;
  private clientId: string;

  constructor(clientId: string, tokenInfo?: TokenInfo) {
    this.clientId = clientId;
    this.tokenInfo = tokenInfo ?? null;
    this.endpoint = normalizeEndpoint(tokenInfo?.endpoint);
  }

  // --- Public API methods ---

  async generateQRCode(userCode: string): Promise<{ qrcode: string; token: string }> {
    // LoginControl flow: plain HTTP, no signing or encryption (per tuya-device-sharing-sdk/user.py)
    const url = new URL(`${this.endpoint}/v1.0/m/life/home-assistant/qrcode/tokens`);
    url.searchParams.set('clientid', this.clientId);
    url.searchParams.set('usercode', userCode);
    url.searchParams.set('schema', SCHEMA);
    const res = await plainRequest('POST', url.toString());
    if (!res.success) {
      throw new Error(`Tuya API error (${res.code ?? '?'}): ${res.msg ?? JSON.stringify(res)}`);
    }
    return res.result as { qrcode: string; token: string };
  }

  async pollLoginResult(token: string, userCode: string): Promise<TokenInfo> {
    // LoginControl flow: plain HTTP, no signing or encryption (per tuya-device-sharing-sdk/user.py)
    const maxAttempts = 30;
    for (let i = 0; i < maxAttempts; i++) {
      const url = new URL(`${this.endpoint}/v1.0/m/life/home-assistant/qrcode/tokens/${token}`);
      url.searchParams.set('clientid', this.clientId);
      url.searchParams.set('usercode', userCode);
      const res = await plainRequest('GET', url.toString());
      if (res.success && res.result) {
        const r = res.result as any;
        // API returns snake_case on initial login; camelCase on refresh — handle both
        const endpoint = normalizeEndpoint(r.endpoint);
        return {
          accessToken: r.access_token ?? r.accessToken ?? '',
          refreshToken: r.refresh_token ?? r.refreshToken ?? '',
          expireTime: (res.t as number) + (r.expire_time ?? r.expireTime ?? 7200) * 1000,
          uid: r.uid ?? '',
          terminalId: r.terminalId ?? r.terminal_id ?? '',
          endpoint,
        };
      }
      await sleep(2000);
    }
    throw new Error('QR login timed out — please scan within 60 seconds');
  }

  async getDevice(deviceId: string): Promise<Device | undefined> {
    const devices = await this.getDevices();
    return devices.find((d) => d.id === deviceId);
  }

  async getDevices(): Promise<Device[]> {
    const homesRes = await this.request('GET', '/v1.0/m/life/users/homes');
    const homes = (homesRes.result as any[]) ?? [];
    const allDevices: Device[] = [];
    for (const home of homes) {
      const homeId: string = String(home.ownerId ?? home.homeId ?? home.home_id ?? home.id);
      const devRes = await this.request('GET', '/v1.0/m/life/ha/home/devices', { homeId });
      const devices = ((devRes.result as any[]) ?? []).map((d: any) => ({
        id: d.id,
        name: d.name,
        category: d.category,
        online: d.online,
        status: d.status ?? [],
        homeId,
      }));
      allDevices.push(...devices);
    }
    return allDevices;
  }

  async getDeviceStatus(deviceId: string): Promise<Status[]> {
    const res = await this.request('GET', `/v1.0/m/life/devices/${deviceId}/status`);
    return res.result as Status[];
  }

  async getDeviceSpecifications(deviceId: string): Promise<{ functions: FunctionSpec[]; status: FunctionSpec[] }> {
    const res = await this.request('GET', `/v1.1/m/life/${deviceId}/specifications`);
    return (res.result ?? { functions: [], status: [] }) as { functions: FunctionSpec[]; status: FunctionSpec[] };
  }

  async sendCommand(deviceId: string, commands: Command[]): Promise<void> {
    await this.request('POST', `/v1.1/m/thing/${deviceId}/commands`, undefined, { commands });
  }

  async logout(accessToken: string, terminalId: string): Promise<void> {
    await this.request('POST', '/v1.0/m/token/terminal/expire', undefined, { accessToken, terminalId });
  }

  getTokenInfo(): TokenInfo | null {
    return this.tokenInfo;
  }

  // --- Vacuum / Sweeper endpoints (undocumented consumer API — probe all variants) ---

  async probeEndpoints(candidates: EndpointCandidate[]): Promise<EndpointResult[]> {
    const results: EndpointResult[] = [];
    for (const c of candidates) {
      try {
        const raw = await this.rawRequest(c.method, c.path, c.params, c.body);
        results.push({ endpoint: c.path, method: c.method, success: raw.success, result: raw.result ?? raw, error: raw.success ? undefined : (raw.msg ?? raw.message) });
      } catch (e: any) {
        results.push({ endpoint: c.path, method: c.method, success: false, error: e.message });
      }
    }
    return results;
  }

  async getVacuumCurrentMap(deviceId: string): Promise<EndpointResult[]> {
    return this.probeEndpoints([
      { method: 'GET', path: `/v1.0/m/life/laser/devices/${deviceId}/map/current` },
      { method: 'GET', path: `/v1.0/m/life/laser/${deviceId}/map/current` },
      { method: 'GET', path: `/v2.0/m/life/laser/devices/${deviceId}/map/current` },
      { method: 'GET', path: `/v2.0/m/life/laser/${deviceId}/map/current` },
      { method: 'GET', path: `/v1.0/m/life/sweeper/devices/${deviceId}/map/current` },
      { method: 'GET', path: `/v1.0/m/life/sweeper/${deviceId}/map/current` },
      { method: 'GET', path: `/v1.0/m/life/sd/${deviceId}/map/current` },
      { method: 'GET', path: `/v1.0/m/life/sd/devices/${deviceId}/map/current` },
    ]);
  }

  async getVacuumMapFileList(deviceId: string): Promise<EndpointResult[]> {
    return this.probeEndpoints([
      { method: 'GET', path: `/v1.0/m/life/laser/devices/${deviceId}/map/file/list` },
      { method: 'GET', path: `/v1.0/m/life/laser/${deviceId}/map/file/list` },
      { method: 'GET', path: `/v2.0/m/life/laser/devices/${deviceId}/map/file/list` },
      { method: 'GET', path: `/v2.0/m/life/laser/${deviceId}/map/file/list` },
      { method: 'GET', path: `/v1.0/m/life/sweeper/devices/${deviceId}/map/file/list` },
      { method: 'GET', path: `/v1.0/m/life/sweeper/${deviceId}/map/file/list` },
      { method: 'GET', path: `/v1.0/m/life/sd/${deviceId}/map/file/list` },
    ]);
  }

  async getVacuumCleaningRecords(deviceId: string): Promise<EndpointResult[]> {
    return this.probeEndpoints([
      { method: 'GET', path: `/v1.0/m/life/sweeper/devices/${deviceId}/sweep/records` },
      { method: 'GET', path: `/v1.0/m/life/sweeper/${deviceId}/sweep/records` },
      { method: 'GET', path: `/v1.0/m/life/laser/devices/${deviceId}/sweep/records` },
      { method: 'GET', path: `/v1.0/m/life/laser/${deviceId}/sweep/records` },
      { method: 'GET', path: `/v2.0/m/life/laser/sweep/devices/${deviceId}/histories` },
      { method: 'GET', path: `/v2.0/m/life/laser/${deviceId}/histories` },
      { method: 'GET', path: `/v1.0/m/life/sd/${deviceId}/records` },
      { method: 'GET', path: `/v1.0/m/life/sd/devices/${deviceId}/records` },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/report` },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/events` },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/log` },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/history` },
    ]);
  }

  async getVacuumAreas(deviceId: string): Promise<EndpointResult[]> {
    return this.probeEndpoints([
      { method: 'GET', path: `/v1.0/m/life/laser/devices/${deviceId}/areas` },
      { method: 'GET', path: `/v1.0/m/life/laser/${deviceId}/areas` },
      { method: 'GET', path: `/v2.0/m/life/laser/devices/${deviceId}/areas` },
      { method: 'GET', path: `/v1.0/m/life/sweeper/devices/${deviceId}/areas` },
      { method: 'GET', path: `/v1.0/m/life/sweeper/${deviceId}/areas` },
      { method: 'GET', path: `/v1.0/m/life/sd/${deviceId}/areas` },
    ]);
  }

  async getVacuumRooms(deviceId: string): Promise<EndpointResult[]> {
    return this.probeEndpoints([
      { method: 'GET', path: `/v1.0/m/life/laser/devices/${deviceId}/rooms` },
      { method: 'GET', path: `/v1.0/m/life/laser/${deviceId}/rooms` },
      { method: 'GET', path: `/v2.0/m/life/laser/devices/${deviceId}/rooms` },
      { method: 'GET', path: `/v2.0/m/life/laser/${deviceId}/rooms` },
      { method: 'GET', path: `/v1.0/m/life/sweeper/devices/${deviceId}/rooms` },
      { method: 'GET', path: `/v1.0/m/life/sweeper/${deviceId}/rooms` },
      { method: 'GET', path: `/v1.0/m/life/sd/${deviceId}/rooms` },
    ]);
  }

  async getVacuumConfigurations(deviceId: string): Promise<EndpointResult[]> {
    return this.probeEndpoints([
      { method: 'GET', path: `/v1.0/m/life/laser/devices/${deviceId}/configurations` },
      { method: 'GET', path: `/v1.0/m/life/laser/${deviceId}/configurations` },
      { method: 'GET', path: `/v2.0/m/life/laser/devices/${deviceId}/configurations` },
      { method: 'GET', path: `/v1.0/m/life/sweeper/devices/${deviceId}/configurations` },
      { method: 'GET', path: `/v1.0/m/life/sweeper/${deviceId}/configurations` },
      { method: 'GET', path: `/v1.0/m/life/sd/${deviceId}/configurations` },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/configurations` },
    ]);
  }

  async getVacuumDps(deviceId: string): Promise<EndpointResult[]> {
    return this.probeEndpoints([
      { method: 'GET', path: `/v1.0/m/life/laser/devices/${deviceId}/dps` },
      { method: 'GET', path: `/v1.0/m/life/laser/${deviceId}/dps` },
      { method: 'GET', path: `/v1.0/m/life/sweeper/devices/${deviceId}/dps` },
      { method: 'GET', path: `/v1.0/m/life/sweeper/${deviceId}/dps` },
      { method: 'GET', path: `/v1.0/m/life/sd/${deviceId}/dps` },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/dps` },
    ]);
  }

  async getVacuumSchedules(deviceId: string): Promise<EndpointResult[]> {
    return this.probeEndpoints([
      { method: 'GET', path: `/v1.0/m/life/laser/devices/${deviceId}/schedules` },
      { method: 'GET', path: `/v1.0/m/life/laser/${deviceId}/schedules` },
      { method: 'GET', path: `/v1.0/m/life/sweeper/devices/${deviceId}/schedules` },
      { method: 'GET', path: `/v1.0/m/life/sweeper/${deviceId}/schedules` },
      { method: 'GET', path: `/v1.0/m/life/sd/${deviceId}/schedules` },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/schedules` },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/timers` },
    ]);
  }

  async probeAllVacuumEndpoints(deviceId: string): Promise<EndpointResult[]> {
    const [map, mapFiles, records, areas, rooms, configs, dps, schedules] = await Promise.all([
      this.getVacuumCurrentMap(deviceId),
      this.getVacuumMapFileList(deviceId),
      this.getVacuumCleaningRecords(deviceId),
      this.getVacuumAreas(deviceId),
      this.getVacuumRooms(deviceId),
      this.getVacuumConfigurations(deviceId),
      this.getVacuumDps(deviceId),
      this.getVacuumSchedules(deviceId),
    ]);
    return [...map, ...mapFiles, ...records, ...areas, ...rooms, ...configs, ...dps, ...schedules];
  }

  // --- Core request method ---

  // Same as request() but never throws on API-level errors (success:false) — used for endpoint probing
  private async rawRequest(
    method: string,
    path: string,
    params?: Record<string, string>,
    body?: Record<string, unknown>,
  ): Promise<any> {
    await this.refreshTokenIfNeeded();

    const rid = crypto.randomUUID();
    const sid = '';
    const refreshToken = this.tokenInfo?.refreshToken ?? '';

    const md5 = crypto.createHash('md5');
    md5.update(rid + refreshToken, 'utf8');
    const hashKey = md5.digest('hex');

    const secret = generateSecret(rid, sid, hashKey);

    let queryEncdata = '';
    if (params && Object.keys(params).length > 0) {
      queryEncdata = aesGcmEncrypt(JSON.stringify(params), secret);
    }
    const actualQueryParams: Record<string, string> = queryEncdata ? { encdata: queryEncdata } : {};

    let bodyEncdata = '';
    if (body && Object.keys(body).length > 0) {
      bodyEncdata = aesGcmEncrypt(JSON.stringify(body), secret);
    }
    const actualBody: Record<string, string> = bodyEncdata ? { encdata: bodyEncdata } : {};

    const t = Date.now().toString();
    const headers: Record<string, string> = {
      'X-appKey': this.clientId,
      'X-requestId': rid,
      'X-sid': sid,
      'X-time': t,
    };
    if (this.tokenInfo?.accessToken) {
      headers['X-token'] = this.tokenInfo.accessToken;
    }
    headers['X-sign'] = buildSignature(hashKey, queryEncdata, bodyEncdata, headers);

    const raw = await httpRequest(method, this.endpoint + path, headers, actualQueryParams, actualBody);

    if (raw.success && typeof raw.result === 'string' && raw.result.length > 0) {
      try {
        raw.result = JSON.parse(aesGcmDecrypt(raw.result, secret));
      } catch {
        raw.result = aesGcmDecrypt(raw.result, secret);
      }
    }

    return raw;
  }

  private async request(
    method: string,
    path: string,
    params?: Record<string, string>,
    body?: Record<string, unknown>,
  ): Promise<any> {
    await this.refreshTokenIfNeeded();

    const rid = crypto.randomUUID();
    const sid = '';
    const refreshToken = this.tokenInfo?.refreshToken ?? '';

    const md5 = crypto.createHash('md5');
    md5.update(rid + refreshToken, 'utf8');
    const hashKey = md5.digest('hex');

    const secret = generateSecret(rid, sid, hashKey);

    let queryEncdata = '';
    if (params && Object.keys(params).length > 0) {
      queryEncdata = aesGcmEncrypt(JSON.stringify(params), secret);
    }
    const actualQueryParams: Record<string, string> = queryEncdata ? { encdata: queryEncdata } : {};

    let bodyEncdata = '';
    if (body && Object.keys(body).length > 0) {
      bodyEncdata = aesGcmEncrypt(JSON.stringify(body), secret);
    }
    const actualBody: Record<string, string> = bodyEncdata ? { encdata: bodyEncdata } : {};

    const t = Date.now().toString();
    const headers: Record<string, string> = {
      'X-appKey': this.clientId,
      'X-requestId': rid,
      'X-sid': sid,
      'X-time': t,
    };
    if (this.tokenInfo?.accessToken) {
      headers['X-token'] = this.tokenInfo.accessToken;
    }
    headers['X-sign'] = buildSignature(hashKey, queryEncdata, bodyEncdata, headers);

    const raw = await httpRequest(method, this.endpoint + path, headers, actualQueryParams, actualBody);

    if (!raw.success) {
      throw new Error(`Tuya API error (${raw.code ?? raw.status ?? '?'}): ${raw.msg ?? raw.message ?? JSON.stringify(raw)}`);
    }

    if (typeof raw.result === 'string' && raw.result.length > 0) {
      try {
        raw.result = JSON.parse(aesGcmDecrypt(raw.result, secret));
      } catch {
        raw.result = aesGcmDecrypt(raw.result, secret);
      }
    }

    return raw;
  }

  private async refreshTokenIfNeeded(): Promise<void> {
    if (!this.tokenInfo?.refreshToken) return;
    if (this.tokenInfo.expireTime - 60000 > Date.now()) return;

    try {
      const rid = crypto.randomUUID();
      const hashKey = crypto.createHash('md5').update(rid + this.tokenInfo.refreshToken, 'utf8').digest('hex');
      const secret = generateSecret(rid, '', hashKey);

      const queryEncdata = '';
      const bodyEncdata = '';
      const t = Date.now().toString();
      const headers: Record<string, string> = {
        'X-appKey': this.clientId,
        'X-requestId': rid,
        'X-sid': '',
        'X-time': t,
        'X-token': this.tokenInfo.accessToken,
      };
      headers['X-sign'] = buildSignature(hashKey, queryEncdata, bodyEncdata, headers);

      const raw = await httpRequest(
        'GET',
        `${this.endpoint}/v1.0/m/token/${this.tokenInfo.refreshToken}`,
        headers,
        {},
        {},
      );

      if (raw.success && typeof raw.result === 'string') {
        const r = JSON.parse(aesGcmDecrypt(raw.result, secret));
        this.tokenInfo = {
          accessToken: r.accessToken,
          refreshToken: r.refreshToken,
          expireTime: raw.t + (r.expireTime ?? 7200) * 1000,
          uid: r.uid ?? this.tokenInfo.uid,
          terminalId: this.tokenInfo.terminalId,
          endpoint: this.tokenInfo.endpoint,
        };
      }
    } catch {
      // Continue with existing token on refresh failure
    }
  }
}

// --- Helper functions ---

function normalizeEndpoint(endpoint: string | undefined): string {
  if (!endpoint) return ENDPOINT;
  // Ensure https:// prefix
  if (!endpoint.startsWith('http')) endpoint = 'https://' + endpoint;
  // Remove trailing slash so paths starting with / don't produce double-slash
  return endpoint.replace(/\/+$/, '');
}

// --- Crypto helpers ---

function randomNonce(length: number): string {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += NONCE_CHARS[Math.floor(Math.random() * NONCE_CHARS.length)];
  }
  return result;
}

function generateSecret(rid: string, sid: string, hashKey: string): string {
  let message = hashKey;
  if (sid !== '') {
    const mod = 16;
    const length = Math.min(sid.length, mod);
    let ecode = '';
    for (let i = 0; i < length; i++) {
      const idx = sid.charCodeAt(i) % mod;
      ecode += sid[idx];
    }
    message += '_' + ecode;
  }
  const hmac = crypto.createHmac('sha256', Buffer.from(rid, 'utf8'));
  hmac.update(Buffer.from(message, 'utf8'));
  return hmac.digest('hex').slice(0, 16);
}

function aesGcmEncrypt(data: string, secret: string): string {
  const nonce = randomNonce(12);
  const key = Buffer.from(secret, 'utf8');
  const iv = Buffer.from(nonce, 'utf8');
  const cipher = crypto.createCipheriv('aes-128-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.from(nonce, 'utf8').toString('base64') + Buffer.concat([encrypted, tag]).toString('base64');
}

function aesGcmDecrypt(cipherData: string, secret: string): string {
  const decoded = Buffer.from(cipherData, 'base64');
  const nonce = decoded.slice(0, 12);
  const ciphertextWithTag = decoded.slice(12);
  const tag = ciphertextWithTag.slice(-16);
  const ciphertext = ciphertextWithTag.slice(0, -16);
  const key = Buffer.from(secret, 'utf8');
  const decipher = crypto.createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function buildSignature(
  hashKey: string,
  queryEncdata: string,
  bodyEncdata: string,
  headers: Record<string, string>,
): string {
  const headerOrder = ['X-appKey', 'X-requestId', 'X-sid', 'X-time', 'X-token'];
  const parts: string[] = [];
  for (const key of headerOrder) {
    const val = headers[key] ?? '';
    if (val !== '') parts.push(`${key}=${val}`);
  }
  let signStr = parts.join('||');
  if (queryEncdata) signStr += queryEncdata;
  if (bodyEncdata) signStr += bodyEncdata;
  return crypto
    .createHmac('sha256', Buffer.from(hashKey, 'utf8'))
    .update(Buffer.from(signStr, 'utf8'))
    .digest('hex');
}

function httpRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  queryParams?: Record<string, string>,
  jsonBody?: object,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    if (queryParams) {
      for (const [k, v] of Object.entries(queryParams)) {
        parsedUrl.searchParams.set(k, v);
      }
    }
    const hasBody = jsonBody != null && Object.keys(jsonBody).length > 0;
    const bodyStr = hasBody ? JSON.stringify(jsonBody) : '';
    const reqHeaders: Record<string, string> = { ...headers };
    if (hasBody) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = String(Buffer.byteLength(bodyStr));
    }

    const options: https.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: Number(parsedUrl.port) || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: method.toUpperCase(),
      headers: reqHeaders,
    };

    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`Non-JSON response (${res.statusCode}): ${body.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Plain unauthenticated HTTP request — used for QR login flow (no signing/encryption)
function plainRequest(method: string, url: string, jsonBody?: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const bodyStr = jsonBody ? JSON.stringify(jsonBody) : undefined;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (bodyStr) headers['Content-Length'] = String(Buffer.byteLength(bodyStr));

    const options: https.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: Number(parsedUrl.port) || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: method.toUpperCase(),
      headers,
    };

    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`Non-JSON response (${res.statusCode}): ${body.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
