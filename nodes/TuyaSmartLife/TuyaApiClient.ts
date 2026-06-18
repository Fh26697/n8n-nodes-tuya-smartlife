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
}

export interface Device {
  id: string;
  name: string;
  category: string;
  online: boolean;
  status: Status[];
}

export interface Status {
  code: string;
  value: boolean | number | string;
}

export interface Command {
  code: string;
  value: boolean | number | string;
}

export class TuyaApiClient {
  private tokenInfo: TokenInfo | null;
  private endpoint: string;
  private clientId: string;

  constructor(clientId: string, tokenInfo?: TokenInfo) {
    this.clientId = clientId;
    this.tokenInfo = tokenInfo ?? null;
    this.endpoint = ENDPOINT;
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
      throw new Error(`Tuya API error (${res.code}): ${res.msg}`);
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
        return {
          accessToken: r.access_token,
          refreshToken: r.refresh_token,
          expireTime: (res.t as number) + r.expireTime * 1000,
          uid: r.uid,
          terminalId: r.terminalId,
        };
      }
      await sleep(2000);
    }
    throw new Error('QR login timed out — please scan within 60 seconds');
  }

  async getDevices(): Promise<Device[]> {
    const res = await this.request('GET', '/v1.0/m/life/ha/home/devices');
    return (res.result as any[]).map((d: any) => ({
      id: d.id,
      name: d.name,
      category: d.category,
      online: d.online,
      status: d.status ?? [],
    }));
  }

  async getDeviceStatus(deviceId: string): Promise<Status[]> {
    const res = await this.request('GET', `/v1.0/m/life/devices/${deviceId}/status`);
    return res.result as Status[];
  }

  async sendCommand(deviceId: string, commands: Command[]): Promise<void> {
    await this.request('POST', `/v1.1/m/thing/${deviceId}/commands`, undefined, { commands });
  }

  async logout(accessToken: string, terminalId: string): Promise<void> {
    await this.request('GET', '/v1.0/m/token/terminal/expire', undefined, { accessToken, terminalId });
  }

  getTokenInfo(): TokenInfo | null {
    return this.tokenInfo;
  }

  // --- Core request method ---

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
    const actualQueryParams: Record<string, string> = { encdata: queryEncdata };

    let bodyEncdata = '';
    if (body && Object.keys(body).length > 0) {
      bodyEncdata = aesGcmEncrypt(JSON.stringify(body), secret);
    }
    const actualBody = { encdata: bodyEncdata };

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
      throw new Error(`Tuya API error (${raw.code}): ${raw.msg}`);
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
        { encdata: '' },
        { encdata: '' },
      );

      if (raw.success && typeof raw.result === 'string') {
        const r = JSON.parse(aesGcmDecrypt(raw.result, secret));
        this.tokenInfo = {
          accessToken: r.accessToken,
          refreshToken: r.refreshToken,
          expireTime: raw.t + r.expireTime * 1000,
          uid: r.uid ?? this.tokenInfo.uid,
          terminalId: this.tokenInfo.terminalId,
        };
      }
    } catch {
      // Continue with existing token on refresh failure
    }
  }
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
    const bodyStr = JSON.stringify(jsonBody ?? {});
    const reqHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(bodyStr)),
      ...headers,
    };

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
    req.write(bodyStr);
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
