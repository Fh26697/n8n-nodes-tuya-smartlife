import * as crypto from 'crypto';
import * as https from 'https';
import { URL } from 'url';
import mqtt from 'mqtt';
import { SCHEMA, ENDPOINT, NONCE_CHARS } from './constants';

export interface MqttConfig {
  url: string;
  port: number;
  clientId: string;
  username: string;
  password: string;
  sourceTopic: string;
  sinkTopic?: string;
}

export interface MqttMapResult {
  commandTrans: string | null;
  pathData: string | null;
  allMessages: any[];
  timedOut: boolean;
  elapsedMs: number;
}

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
  category?: string;
  label?: string;
}

export interface EndpointResult {
  endpoint: string;
  method: string;
  category?: string;
  label?: string;
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

  async getMqttConfig(uid: string): Promise<MqttConfig> {
    const res = await this.request('GET', `/v1.0/m/life/users/${uid}/mqtt`);
    const r = res.result as any;
    return {
      url:         r.url         ?? r.mqttUrl    ?? r.host      ?? r.broker,
      port:        r.port        ?? 8883,
      clientId:    r.clientId    ?? r.client_id  ?? r.clientid,
      username:    r.username    ?? r.user        ?? r.userName,
      password:    r.password    ?? r.pwd         ?? r.pass,
      sourceTopic: r.sourceTopic ?? r.source_topic ?? r.subscribeTopic ?? r.subTopic ?? r.topic,
      sinkTopic:   r.sinkTopic  ?? r.sink_topic  ?? r.publishTopic,
    };
  }

  async requestVacuumMapViaMqtt(deviceId: string, uid: string, timeoutMs = 15_000): Promise<MqttMapResult> {
    const mqttConfig = await this.getMqttConfig(uid);
    const start = Date.now();

    return new Promise((resolve, reject) => {
      const brokerUrl = `mqtts://${mqttConfig.url}:${mqttConfig.port}`;
      const client = mqtt.connect(brokerUrl, {
        clientId:         mqttConfig.clientId,
        username:         mqttConfig.username,
        password:         mqttConfig.password,
        rejectUnauthorized: false,
        connectTimeout:   10_000,
      });

      const allMessages: any[] = [];
      let commandTrans: string | null = null;
      let pathData: string | null = null;
      let done = false;

      const finish = (timedOut: boolean) => {
        if (done) return;
        done = true;
        client.end(true);
        resolve({ commandTrans, pathData, allMessages, timedOut, elapsedMs: Date.now() - start });
      };

      const timer = setTimeout(() => finish(true), timeoutMs);

      client.on('connect', () => {
        client.subscribe(mqttConfig.sourceTopic, async (err) => {
          if (err) { clearTimeout(timer); finish(true); return; }
          try {
            await this.sendCommand(deviceId, [{ code: 'request', value: 'get_both' }]);
          } catch (e) {
            clearTimeout(timer);
            client.end(true);
            reject(e);
          }
        });
      });

      client.on('message', (_topic: string, raw: Buffer) => {
        let msg: any;
        try { msg = JSON.parse(raw.toString()); } catch { msg = { raw: raw.toString('base64') }; }
        allMessages.push(msg);

        // DPs come as numeric keys (dpId) or string status codes — handle both
        const dps: Record<string, any> = msg?.data?.dps ?? msg?.data?.status ?? msg?.dps ?? msg?.status ?? {};
        if (dps['14']           !== undefined) pathData     = String(dps['14']);
        if (dps['15']           !== undefined) commandTrans = String(dps['15']);
        if (dps['path_data']    !== undefined) pathData     = String(dps['path_data']);
        if (dps['command_trans'] !== undefined) commandTrans = String(dps['command_trans']);

        // Both pieces received → done early
        if (commandTrans !== null && pathData !== null) {
          clearTimeout(timer);
          finish(false);
        }
      });

      client.on('error', (err: Error) => {
        clearTimeout(timer);
        if (!done) { done = true; client.end(true); reject(new Error(`MQTT: ${err.message}`)); }
      });
    });
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
        results.push({
          endpoint: c.path,
          method: c.method,
          category: c.category,
          label: c.label,
          success: raw.success,
          result: raw.result ?? raw,
          error: raw.success ? undefined : (raw.msg ?? raw.message),
        });
      } catch (e: any) {
        results.push({ endpoint: c.path, method: c.method, category: c.category, label: c.label, success: false, error: e.message });
      }
    }
    return results;
  }

  async getVacuumCurrentMap(deviceId: string): Promise<EndpointResult[]> {
    const cat = 'vacuum/map';
    return this.probeEndpoints([
      { method: 'GET', path: `/v1.0/m/life/laser/devices/${deviceId}/map/current`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/laser/${deviceId}/map/current`, category: cat },
      { method: 'GET', path: `/v2.0/m/life/laser/devices/${deviceId}/map/current`, category: cat },
      { method: 'GET', path: `/v2.0/m/life/laser/${deviceId}/map/current`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/sweeper/devices/${deviceId}/map/current`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/sweeper/${deviceId}/map/current`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/sd/${deviceId}/map/current`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/sd/devices/${deviceId}/map/current`, category: cat },
    ]);
  }

  async getVacuumMapFileList(deviceId: string): Promise<EndpointResult[]> {
    const cat = 'vacuum/map-files';
    return this.probeEndpoints([
      { method: 'GET', path: `/v1.0/m/life/laser/devices/${deviceId}/map/file/list`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/laser/${deviceId}/map/file/list`, category: cat },
      { method: 'GET', path: `/v2.0/m/life/laser/devices/${deviceId}/map/file/list`, category: cat },
      { method: 'GET', path: `/v2.0/m/life/laser/${deviceId}/map/file/list`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/sweeper/devices/${deviceId}/map/file/list`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/sweeper/${deviceId}/map/file/list`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/sd/${deviceId}/map/file/list`, category: cat },
    ]);
  }

  async getVacuumCleaningRecords(deviceId: string): Promise<EndpointResult[]> {
    const cat = 'vacuum/records';
    return this.probeEndpoints([
      { method: 'GET', path: `/v1.0/m/life/sweeper/devices/${deviceId}/sweep/records`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/sweeper/${deviceId}/sweep/records`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/laser/devices/${deviceId}/sweep/records`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/laser/${deviceId}/sweep/records`, category: cat },
      { method: 'GET', path: `/v2.0/m/life/laser/sweep/devices/${deviceId}/histories`, category: cat },
      { method: 'GET', path: `/v2.0/m/life/laser/${deviceId}/histories`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/sd/${deviceId}/records`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/sd/devices/${deviceId}/records`, category: cat },
    ]);
  }

  async getVacuumAreas(deviceId: string): Promise<EndpointResult[]> {
    const cat = 'vacuum/areas';
    return this.probeEndpoints([
      { method: 'GET', path: `/v1.0/m/life/laser/devices/${deviceId}/areas`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/laser/${deviceId}/areas`, category: cat },
      { method: 'GET', path: `/v2.0/m/life/laser/devices/${deviceId}/areas`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/sweeper/devices/${deviceId}/areas`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/sweeper/${deviceId}/areas`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/sd/${deviceId}/areas`, category: cat },
    ]);
  }

  async getVacuumRooms(deviceId: string): Promise<EndpointResult[]> {
    const cat = 'vacuum/rooms';
    return this.probeEndpoints([
      { method: 'GET', path: `/v1.0/m/life/laser/devices/${deviceId}/rooms`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/laser/${deviceId}/rooms`, category: cat },
      { method: 'GET', path: `/v2.0/m/life/laser/devices/${deviceId}/rooms`, category: cat },
      { method: 'GET', path: `/v2.0/m/life/laser/${deviceId}/rooms`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/sweeper/devices/${deviceId}/rooms`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/sweeper/${deviceId}/rooms`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/sd/${deviceId}/rooms`, category: cat },
    ]);
  }

  async getVacuumConfigurations(deviceId: string): Promise<EndpointResult[]> {
    const cat = 'vacuum/configurations';
    return this.probeEndpoints([
      { method: 'GET', path: `/v1.0/m/life/laser/devices/${deviceId}/configurations`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/laser/${deviceId}/configurations`, category: cat },
      { method: 'GET', path: `/v2.0/m/life/laser/devices/${deviceId}/configurations`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/sweeper/devices/${deviceId}/configurations`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/sweeper/${deviceId}/configurations`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/sd/${deviceId}/configurations`, category: cat },
    ]);
  }

  async getVacuumDps(deviceId: string): Promise<EndpointResult[]> {
    const cat = 'vacuum/dps';
    return this.probeEndpoints([
      { method: 'GET', path: `/v1.0/m/life/laser/devices/${deviceId}/dps`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/laser/${deviceId}/dps`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/sweeper/devices/${deviceId}/dps`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/sweeper/${deviceId}/dps`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/sd/${deviceId}/dps`, category: cat },
    ]);
  }

  async getVacuumSchedules(deviceId: string): Promise<EndpointResult[]> {
    const cat = 'vacuum/schedules';
    return this.probeEndpoints([
      { method: 'GET', path: `/v1.0/m/life/laser/devices/${deviceId}/schedules`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/laser/${deviceId}/schedules`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/sweeper/devices/${deviceId}/schedules`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/sweeper/${deviceId}/schedules`, category: cat },
      { method: 'GET', path: `/v1.0/m/life/sd/${deviceId}/schedules`, category: cat },
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

  // --- User endpoints ---

  async probeUserEndpoints(): Promise<EndpointResult[]> {
    const cat = 'user';
    return this.probeEndpoints([
      { method: 'GET', path: '/v1.0/m/life/users/homes', category: cat, label: 'List homes' },
      { method: 'GET', path: '/v2.0/m/life/users/homes', category: cat, label: 'List homes v2' },
      { method: 'GET', path: '/v1.0/m/life/users/info', category: cat, label: 'User info' },
      { method: 'GET', path: '/v1.0/m/life/users/detail', category: cat, label: 'User detail' },
      { method: 'GET', path: '/v1.0/m/life/users/profile', category: cat, label: 'User profile' },
      { method: 'GET', path: '/v1.0/m/life/user', category: cat, label: 'User (short path)' },
      { method: 'GET', path: '/v1.0/m/life/users', category: cat, label: 'Users list' },
      { method: 'GET', path: '/v2.0/m/life/users/info', category: cat, label: 'User info v2' },
      { method: 'GET', path: '/v1.0/m/life/users/message-push-setting', category: cat, label: 'Push notification settings' },
      { method: 'GET', path: '/v1.0/m/life/users/push-config', category: cat, label: 'Push config' },
      { method: 'GET', path: '/v1.0/m/life/users/devices', category: cat, label: 'All user devices' },
      { method: 'GET', path: '/v2.0/m/life/users/devices', category: cat, label: 'All user devices v2' },
    ]);
  }

  // --- Home Assistant specific endpoints ---

  async probeHaEndpoints(homeId?: string): Promise<EndpointResult[]> {
    const cat = 'ha';
    const candidates: EndpointCandidate[] = [
      { method: 'GET', path: '/v1.0/m/life/ha/home/devices', category: cat, label: 'HA home devices' },
      { method: 'GET', path: '/v1.0/m/life/ha/homes', category: cat, label: 'HA homes' },
      { method: 'GET', path: '/v2.0/m/life/ha/home/devices', category: cat, label: 'HA home devices v2' },
      { method: 'GET', path: '/v1.0/m/life/ha/devices', category: cat, label: 'HA devices' },
      { method: 'GET', path: '/v2.0/m/life/ha/devices', category: cat, label: 'HA devices v2' },
    ];
    if (homeId) {
      candidates.push(
        { method: 'GET', path: `/v1.0/m/life/ha/home/${homeId}/devices`, category: cat, label: 'HA home devices by ID' },
        { method: 'GET', path: `/v2.0/m/life/ha/home/${homeId}/devices`, category: cat, label: 'HA home devices by ID v2' },
      );
    }
    return this.probeEndpoints(candidates);
  }

  // --- Home endpoints (homeId required) ---

  async probeHomeEndpoints(homeId: string): Promise<EndpointResult[]> {
    const cat = 'home';
    return this.probeEndpoints([
      { method: 'GET', path: `/v1.0/m/life/homes/${homeId}`, category: cat, label: 'Home details' },
      { method: 'GET', path: `/v2.0/m/life/homes/${homeId}`, category: cat, label: 'Home details v2' },
      { method: 'GET', path: `/v1.0/m/life/homes/${homeId}/details`, category: cat, label: 'Home details (alt)' },
      { method: 'GET', path: `/v1.0/m/life/homes/${homeId}/members`, category: cat, label: 'Home members' },
      { method: 'GET', path: `/v2.0/m/life/homes/${homeId}/members`, category: cat, label: 'Home members v2' },
      { method: 'GET', path: `/v1.0/m/life/homes/${homeId}/rooms`, category: cat, label: 'Home rooms' },
      { method: 'GET', path: `/v2.0/m/life/homes/${homeId}/rooms`, category: cat, label: 'Home rooms v2' },
      { method: 'GET', path: `/v1.0/m/life/homes/${homeId}/devices`, category: cat, label: 'Home devices' },
      { method: 'GET', path: `/v2.0/m/life/homes/${homeId}/devices`, category: cat, label: 'Home devices v2' },
      { method: 'GET', path: `/v1.0/m/life/homes/${homeId}/groups`, category: cat, label: 'Device groups' },
      { method: 'GET', path: `/v2.0/m/life/homes/${homeId}/groups`, category: cat, label: 'Device groups v2' },
      { method: 'GET', path: `/v1.0/m/life/homes/${homeId}/scenes`, category: cat, label: 'Scenes/rules' },
      { method: 'GET', path: `/v2.0/m/life/homes/${homeId}/scenes`, category: cat, label: 'Scenes v2' },
      { method: 'GET', path: `/v1.0/m/life/homes/${homeId}/automations`, category: cat, label: 'Automations' },
      { method: 'GET', path: `/v2.0/m/life/homes/${homeId}/automations`, category: cat, label: 'Automations v2' },
      { method: 'GET', path: `/v1.0/m/life/homes/${homeId}/weather`, category: cat, label: 'Home weather' },
      { method: 'GET', path: `/v2.0/m/life/homes/${homeId}/weather`, category: cat, label: 'Home weather v2' },
      { method: 'GET', path: `/v1.0/m/life/homes/${homeId}/statistics`, category: cat, label: 'Home statistics' },
      { method: 'GET', path: `/v1.0/m/life/homes/${homeId}/safety`, category: cat, label: 'Safety status' },
      { method: 'GET', path: `/v1.0/m/life/homes/${homeId}/alarm`, category: cat, label: 'Alarm status' },
      { method: 'GET', path: `/v1.0/m/life/homes/${homeId}/messages`, category: cat, label: 'Home messages' },
      { method: 'GET', path: `/v1.0/m/life/homes/${homeId}/notice`, category: cat, label: 'Home notices' },
      { method: 'GET', path: `/v1.0/m/life/homes/${homeId}/share/devices`, category: cat, label: 'Shared devices' },
    ]);
  }

  // --- Generic device endpoints (deviceId required) ---

  async probeDeviceEndpoints(deviceId: string): Promise<EndpointResult[]> {
    const cat = 'device';
    return this.probeEndpoints([
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}`, category: cat, label: 'Device info' },
      { method: 'GET', path: `/v2.0/m/life/devices/${deviceId}`, category: cat, label: 'Device info v2' },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/status`, category: cat, label: 'Device status' },
      { method: 'GET', path: `/v2.0/m/life/devices/${deviceId}/status`, category: cat, label: 'Device status v2' },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/functions`, category: cat, label: 'Device functions' },
      { method: 'GET', path: `/v2.0/m/life/devices/${deviceId}/functions`, category: cat, label: 'Device functions v2' },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/specification`, category: cat, label: 'Device specification' },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/specifications`, category: cat, label: 'Device specifications' },
      { method: 'GET', path: `/v2.0/m/life/devices/${deviceId}/specification`, category: cat, label: 'Device specification v2' },
      { method: 'GET', path: `/v1.1/m/life/${deviceId}/specifications`, category: cat, label: 'Device specifications v1.1' },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/information`, category: cat, label: 'Device information' },
      { method: 'GET', path: `/v2.0/m/life/devices/${deviceId}/information`, category: cat, label: 'Device information v2' },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/infos`, category: cat, label: 'Device infos (alt)' },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/properties`, category: cat, label: 'Device properties' },
      { method: 'GET', path: `/v2.0/m/life/devices/${deviceId}/properties`, category: cat, label: 'Device properties v2' },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/configurations`, category: cat, label: 'Device configurations' },
      { method: 'GET', path: `/v2.0/m/life/devices/${deviceId}/configurations`, category: cat, label: 'Device configurations v2' },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/logs`, category: cat, label: 'Device logs' },
      { method: 'GET', path: `/v2.0/m/life/devices/${deviceId}/logs`, category: cat, label: 'Device logs v2' },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/report-logs`, category: cat, label: 'Report logs' },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/dp-logs`, category: cat, label: 'DP logs' },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/dps`, category: cat, label: 'Raw DPS' },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/dp-history`, category: cat, label: 'DP history' },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/events`, category: cat, label: 'Device events' },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/histories`, category: cat, label: 'Device histories' },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/report`, category: cat, label: 'Device report' },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/history`, category: cat, label: 'Device history' },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/timers`, category: cat, label: 'Device timers' },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/schedules`, category: cat, label: 'Device schedules' },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/statistics`, category: cat, label: 'Device statistics' },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/alarm`, category: cat, label: 'Device alarm status' },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/alarms`, category: cat, label: 'Device alarms' },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/members`, category: cat, label: 'Device members/sharing' },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/share`, category: cat, label: 'Device sharing' },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/air-quality`, category: cat, label: 'Air quality data' },
    ]);
  }

  // --- Camera / IPC endpoints ---

  async probeCameraEndpoints(deviceId: string): Promise<EndpointResult[]> {
    const cat = 'camera';
    return this.probeEndpoints([
      { method: 'GET', path: `/v1.0/m/life/ipc/${deviceId}/stream`, category: cat, label: 'Live stream info' },
      { method: 'GET', path: `/v2.0/m/life/ipc/${deviceId}/stream`, category: cat, label: 'Live stream info v2' },
      { method: 'GET', path: `/v1.0/m/ipc/${deviceId}/stream`, category: cat, label: 'Live stream (short path)' },
      { method: 'GET', path: `/v1.0/m/life/ipc/${deviceId}/rtsp`, category: cat, label: 'RTSP stream URL' },
      { method: 'GET', path: `/v2.0/m/life/ipc/${deviceId}/rtsp`, category: cat, label: 'RTSP stream URL v2' },
      { method: 'GET', path: `/v1.0/m/ipc/${deviceId}/rtsp`, category: cat, label: 'RTSP (short path)' },
      { method: 'GET', path: `/v1.0/m/life/ipc/${deviceId}/playback/records`, category: cat, label: 'Playback records' },
      { method: 'GET', path: `/v2.0/m/life/ipc/${deviceId}/playback/records`, category: cat, label: 'Playback records v2' },
      { method: 'GET', path: `/v1.0/m/life/ipc/${deviceId}/configs`, category: cat, label: 'Camera configs' },
      { method: 'GET', path: `/v1.0/m/life/ipc/${deviceId}/alarm/list`, category: cat, label: 'Alarm events list' },
      { method: 'GET', path: `/v2.0/m/life/ipc/${deviceId}/alarm/list`, category: cat, label: 'Alarm events list v2' },
      { method: 'GET', path: `/v1.0/m/life/ipc/${deviceId}/detect/alarm`, category: cat, label: 'Detection alarms' },
      { method: 'GET', path: `/v1.0/m/life/ipc/${deviceId}/snapshot/history`, category: cat, label: 'Snapshot history' },
      { method: 'GET', path: `/v1.0/m/life/ipc/${deviceId}/devices`, category: cat, label: 'Sub-devices (NVR)' },
      { method: 'POST', path: `/v1.0/m/life/ipc/${deviceId}/stream/start`, category: cat, label: 'Start stream session' },
      { method: 'POST', path: `/v1.0/m/life/ipc/${deviceId}/snapshot/trigger`, category: cat, label: 'Trigger snapshot' },
    ]);
  }

  // --- Lock endpoints ---

  async probeLockEndpoints(deviceId: string): Promise<EndpointResult[]> {
    const cat = 'lock';
    return this.probeEndpoints([
      { method: 'GET', path: `/v1.0/m/life/lock/${deviceId}/records`, category: cat, label: 'Unlock records' },
      { method: 'GET', path: `/v2.0/m/life/lock/${deviceId}/records`, category: cat, label: 'Unlock records v2' },
      { method: 'GET', path: `/v1.0/m/life/lock/devices/${deviceId}/records`, category: cat, label: 'Unlock records (alt path)' },
      { method: 'GET', path: `/v2.0/m/life/lock/devices/${deviceId}/records`, category: cat, label: 'Unlock records (alt) v2' },
      { method: 'GET', path: `/v1.0/m/life/lock/${deviceId}/passwords`, category: cat, label: 'Access codes/passwords' },
      { method: 'GET', path: `/v2.0/m/life/lock/${deviceId}/passwords`, category: cat, label: 'Access codes v2' },
      { method: 'GET', path: `/v1.0/m/life/lock/${deviceId}/users`, category: cat, label: 'Lock users' },
      { method: 'GET', path: `/v2.0/m/life/lock/${deviceId}/users`, category: cat, label: 'Lock users v2' },
      { method: 'GET', path: `/v1.0/m/life/lock/${deviceId}/temp-passwords`, category: cat, label: 'Temporary passwords' },
      { method: 'GET', path: `/v2.0/m/life/lock/${deviceId}/temp-passwords`, category: cat, label: 'Temporary passwords v2' },
      { method: 'GET', path: `/v1.0/m/life/lock/${deviceId}/configurations`, category: cat, label: 'Lock configurations' },
      { method: 'GET', path: `/v1.0/m/life/lock/${deviceId}/alarm-records`, category: cat, label: 'Lock alarm records' },
    ]);
  }

  // --- Infrared / Remote control endpoints ---

  async probeInfraredEndpoints(deviceId: string): Promise<EndpointResult[]> {
    const cat = 'infrared';
    return this.probeEndpoints([
      { method: 'GET', path: `/v1.0/m/life/infrared/${deviceId}/remotes`, category: cat, label: 'IR remotes list' },
      { method: 'GET', path: `/v2.0/m/life/infrared/${deviceId}/remotes`, category: cat, label: 'IR remotes v2' },
      { method: 'GET', path: `/v1.0/m/life/ir/${deviceId}/remotes`, category: cat, label: 'IR remotes (short path)' },
      { method: 'GET', path: `/v1.0/m/life/infrared/${deviceId}/categories`, category: cat, label: 'IR categories' },
      { method: 'GET', path: `/v2.0/m/life/infrared/${deviceId}/categories`, category: cat, label: 'IR categories v2' },
      { method: 'GET', path: `/v1.0/m/life/ir/${deviceId}/categories`, category: cat, label: 'IR categories (short path)' },
      { method: 'GET', path: `/v1.0/m/life/infrared/${deviceId}/brands`, category: cat, label: 'IR brands' },
      { method: 'GET', path: `/v1.0/m/life/infrared/${deviceId}/keys`, category: cat, label: 'IR keys' },
      { method: 'GET', path: `/v2.0/m/life/infrared/${deviceId}/keys`, category: cat, label: 'IR keys v2' },
    ]);
  }

  // --- Energy monitoring endpoints ---

  async probeEnergyEndpoints(deviceId: string): Promise<EndpointResult[]> {
    const cat = 'energy';
    return this.probeEndpoints([
      { method: 'GET', path: `/v1.0/m/energy/devices/${deviceId}/statistics`, category: cat, label: 'Energy statistics' },
      { method: 'GET', path: `/v2.0/m/energy/devices/${deviceId}/statistics`, category: cat, label: 'Energy statistics v2' },
      { method: 'GET', path: `/v1.0/m/energy/devices/${deviceId}/day`, category: cat, label: 'Energy by day' },
      { method: 'GET', path: `/v1.0/m/energy/devices/${deviceId}/month`, category: cat, label: 'Energy by month' },
      { method: 'GET', path: `/v2.0/m/energy/devices/${deviceId}/month`, category: cat, label: 'Energy by month v2' },
      { method: 'GET', path: `/v1.0/m/energy/devices/${deviceId}/year`, category: cat, label: 'Energy by year' },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/energy`, category: cat, label: 'Device energy (life path)' },
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/energy/statistics`, category: cat, label: 'Energy stats (life path)' },
    ]);
  }

  // --- Air quality / environment sensors ---

  async probeAirQualityEndpoints(deviceId: string): Promise<EndpointResult[]> {
    const cat = 'air-quality';
    return this.probeEndpoints([
      { method: 'GET', path: `/v1.0/m/life/devices/${deviceId}/air-quality`, category: cat, label: 'Air quality (device path)' },
      { method: 'GET', path: `/v1.0/m/life/air-quality/${deviceId}`, category: cat, label: 'Air quality' },
      { method: 'GET', path: `/v2.0/m/life/air-quality/${deviceId}`, category: cat, label: 'Air quality v2' },
      { method: 'GET', path: `/v1.0/m/life/air-quality/${deviceId}/history`, category: cat, label: 'Air quality history' },
      { method: 'GET', path: `/v1.0/m/life/air-quality/${deviceId}/statistics`, category: cat, label: 'Air quality statistics' },
    ]);
  }

  // --- Scenes and automations (homeId) ---

  async probeSceneEndpoints(homeId: string): Promise<EndpointResult[]> {
    const cat = 'scenes';
    return this.probeEndpoints([
      { method: 'GET', path: `/v1.0/m/life/homes/${homeId}/scenes`, category: cat, label: 'Scenes in home' },
      { method: 'GET', path: `/v2.0/m/life/homes/${homeId}/scenes`, category: cat, label: 'Scenes v2' },
      { method: 'GET', path: `/v1.0/m/life/homes/${homeId}/automations`, category: cat, label: 'Automations' },
      { method: 'GET', path: `/v2.0/m/life/homes/${homeId}/automations`, category: cat, label: 'Automations v2' },
      { method: 'GET', path: `/v1.0/m/life/scenes`, category: cat, label: 'Global scenes' },
      { method: 'GET', path: `/v1.0/m/life/automations`, category: cat, label: 'Global automations' },
      { method: 'GET', path: `/v1.0/m/life/scenes/${homeId}`, category: cat, label: 'Scenes by home (alt)' },
    ]);
  }

  // --- Doorbell endpoints ---

  async probeDoorbellEndpoints(deviceId: string): Promise<EndpointResult[]> {
    const cat = 'doorbell';
    return this.probeEndpoints([
      { method: 'GET', path: `/v1.0/m/life/doorbell/${deviceId}/records`, category: cat, label: 'Doorbell records' },
      { method: 'GET', path: `/v2.0/m/life/doorbell/${deviceId}/records`, category: cat, label: 'Doorbell records v2' },
      { method: 'GET', path: `/v1.0/m/life/doorbell/${deviceId}/messages`, category: cat, label: 'Doorbell messages' },
      { method: 'GET', path: `/v1.0/m/life/doorbell/devices/${deviceId}/records`, category: cat, label: 'Doorbell records (alt)' },
    ]);
  }

  // --- HVAC / Thermostat endpoints ---

  async probeHvacEndpoints(deviceId: string): Promise<EndpointResult[]> {
    const cat = 'hvac';
    return this.probeEndpoints([
      { method: 'GET', path: `/v1.0/m/life/hvac/${deviceId}/status`, category: cat, label: 'HVAC status' },
      { method: 'GET', path: `/v1.0/m/life/hvac/${deviceId}/schedules`, category: cat, label: 'HVAC schedules' },
      { method: 'GET', path: `/v2.0/m/life/hvac/${deviceId}/status`, category: cat, label: 'HVAC status v2' },
      { method: 'GET', path: `/v1.0/m/life/hvac/${deviceId}/configurations`, category: cat, label: 'HVAC configurations' },
      { method: 'GET', path: `/v1.0/m/life/thermostat/${deviceId}/status`, category: cat, label: 'Thermostat status' },
      { method: 'GET', path: `/v1.0/m/life/thermostat/${deviceId}/schedules`, category: cat, label: 'Thermostat schedules' },
    ]);
  }

  // --- Master probe: all known endpoint categories ---

  async probeAllKnownEndpoints(deviceId?: string, homeId?: string): Promise<EndpointResult[]> {
    const tasks: Promise<EndpointResult[]>[] = [
      this.probeUserEndpoints(),
      this.probeHaEndpoints(homeId),
    ];
    if (homeId) {
      tasks.push(this.probeHomeEndpoints(homeId));
      tasks.push(this.probeSceneEndpoints(homeId));
    }
    if (deviceId) {
      tasks.push(this.probeDeviceEndpoints(deviceId));
      tasks.push(this.probeCameraEndpoints(deviceId));
      tasks.push(this.probeLockEndpoints(deviceId));
      tasks.push(this.probeInfraredEndpoints(deviceId));
      tasks.push(this.probeEnergyEndpoints(deviceId));
      tasks.push(this.probeAirQualityEndpoints(deviceId));
      tasks.push(this.probeDoorbellEndpoints(deviceId));
      tasks.push(this.probeHvacEndpoints(deviceId));
      tasks.push(this.probeAllVacuumEndpoints(deviceId));
    }
    const all = await Promise.all(tasks);
    return all.flat();
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
