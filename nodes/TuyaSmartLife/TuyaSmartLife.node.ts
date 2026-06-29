import {
  IDataObject,
  IExecuteFunctions,
  ILoadOptionsFunctions,
  INodeExecutionData,
  INodePropertyOptions,
  INodeType,
  INodeTypeDescription,
  NodeOperationError,
  IBinaryData,
} from 'n8n-workflow';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { TuyaApiClient, TokenInfo, Command, EndpointResult, MqttMapResult, PollMapResult, EnergyQueryResult, MeterStatus } from './TuyaApiClient';

// File-based token storage — persists across workflows, executions and n8n restarts
function tokenFilePath(): string {
  const base =
    process.env.N8N_USER_FOLDER ||
    (process.env.HOME ? path.join(process.env.HOME, '.n8n') : '/tmp');
  return path.join(base, 'tuya-smartlife-tokens.json');
}

function loadTokens(): Record<string, TokenInfo> {
  try {
    const raw = fs.readFileSync(tokenFilePath(), 'utf8');
    return JSON.parse(raw) as Record<string, TokenInfo>;
  } catch {
    return {};
  }
}

function saveTokens(all: Record<string, TokenInfo>): void {
  try {
    fs.writeFileSync(tokenFilePath(), JSON.stringify(all, null, 2), 'utf8');
  } catch {
    // non-fatal — worst case login must be re-run
  }
}

// Token key is "clientId:userCode" so each distinct credential set has its own session.
// Falls back to legacy "userCode"-only key for backward compatibility with older token files.
function tokenKey(clientId: string, userCode: string): string {
  return `${clientId}:${userCode}`;
}

function readToken(clientId: string, userCode: string): TokenInfo | undefined {
  const all = loadTokens();
  return all[tokenKey(clientId, userCode)] ?? all[userCode]; // legacy fallback
}

function writeToken(clientId: string, userCode: string, info: TokenInfo): void {
  const all = loadTokens();
  all[tokenKey(clientId, userCode)] = info;
  delete all[userCode]; // migrate away from legacy key
  saveTokens(all);
}

function deleteToken(clientId: string, userCode: string): void {
  const all = loadTokens();
  delete all[tokenKey(clientId, userCode)];
  delete all[userCode]; // clean up legacy key too
  saveTokens(all);
}

// Convert the string value from the UI to the correct JS type for the Tuya API
function parseCommandValue(v: string): boolean | number | string {
  if (v === 'true') return true;
  if (v === 'false') return false;
  const trimmed = v.trim();
  if (trimmed !== '' && !isNaN(Number(trimmed))) return Number(trimmed);
  return v;
}

// Fetch QR code image from URL, following up to 3 redirects, returns data URL
function fetchQrImage(url: string, redirectsLeft = 3): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects fetching QR image'));
            return;
          }
          fetchQrImage(res.headers.location, redirectsLeft - 1).then(resolve).catch(reject);
          res.resume();
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve(`data:image/png;base64,${buffer.toString('base64')}`);
        });
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

export class TuyaSmartLife implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Tuya Smart Life',
    name: 'tuyaSmartLife',
    icon: 'file:tuya.svg',
    group: ['transform'],
    version: 1,
    description: 'Control Tuya Smart Life devices',
    defaults: { name: 'Tuya Smart Life' },
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'tuyaSmartLifeApi', required: true }],
    properties: [
      {
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        noDataExpression: true,
        options: [
          { name: 'Setup', value: 'setup' },
          { name: 'Devices', value: 'devices' },
          { name: 'Device', value: 'device' },
          { name: 'Smart Meter', value: 'smartMeter' },
          { name: 'Vacuum', value: 'vacuum' },
          { name: 'API Explorer', value: 'apiExplorer' },
        ],
        default: 'setup',
      },

      // ── Setup operations ──────────────────────────────────────────────────
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['setup'] } },
        options: [
          {
            name: 'Generate QR Code',
            value: 'generateQRCode',
            description: 'Generate a QR code to log in via the Smart Life app',
            action: 'Generate QR code',
          },
          {
            name: 'Complete Login',
            value: 'completeLogin',
            description: 'Poll for QR login result and save tokens automatically',
            action: 'Complete login',
          },
          {
            name: 'Show Login Status',
            value: 'loginStatus',
            description: 'Check whether tokens are stored and when they expire',
            action: 'Show login status',
          },
          {
            name: 'Import Token Manually',
            value: 'importToken',
            description: 'Paste an existing access token directly — use this if QR login fails',
            action: 'Import token manually',
          },
        ],
        default: 'generateQRCode',
      },
      {
        displayName: 'QR Token',
        name: 'qrToken',
        type: 'string',
        default: '',
        required: true,
        description: 'The token returned by the Generate QR Code operation',
        displayOptions: { show: { resource: ['setup'], operation: ['completeLogin'] } },
      },
      {
        displayName: 'Access Token',
        name: 'importAccessToken',
        type: 'string',
        typeOptions: { password: true },
        default: '',
        required: true,
        description: 'Access token from another Tuya tool (e.g. tinytuya wizard, HA Tuya integration)',
        displayOptions: { show: { resource: ['setup'], operation: ['importToken'] } },
      },
      {
        displayName: 'Refresh Token',
        name: 'importRefreshToken',
        type: 'string',
        typeOptions: { password: true },
        default: '',
        description: 'Refresh token (optional but recommended)',
        displayOptions: { show: { resource: ['setup'], operation: ['importToken'] } },
      },
      {
        displayName: 'UID',
        name: 'importUid',
        type: 'string',
        default: '',
        required: true,
        description: 'User ID (e.g. eu1575716270639BOZ50)',
        displayOptions: { show: { resource: ['setup'], operation: ['importToken'] } },
      },
      {
        displayName: 'API Endpoint',
        name: 'importEndpoint',
        type: 'string',
        default: '',
        placeholder: 'https://apigw.tuyaeu.com',
        description: 'Regional API endpoint. Use apigw.tuyaeu.com for EU, apigw.tuyaus.com for US, apigw.iotbing.com for China.',
        displayOptions: { show: { resource: ['setup'], operation: ['importToken'] } },
      },
      {
        displayName: 'Terminal ID',
        name: 'importTerminalId',
        type: 'string',
        default: '',
        description: 'Terminal/session ID (optional)',
        displayOptions: { show: { resource: ['setup'], operation: ['importToken'] } },
      },

      // ── Devices operations ────────────────────────────────────────────────
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['devices'] } },
        options: [
          {
            name: 'Get All',
            value: 'getAll',
            description: 'Retrieve all devices in your home',
            action: 'Get all devices',
          },
          {
            name: 'Get',
            value: 'get',
            description: 'Get a single device with its current live values',
            action: 'Get device',
          },
        ],
        default: 'getAll',
      },
      {
        displayName: 'Device ID',
        name: 'deviceId',
        type: 'string',
        default: '',
        required: true,
        description: 'The ID of the device',
        displayOptions: { show: { resource: ['devices'], operation: ['get'] } },
      },

      // ── Device operations ─────────────────────────────────────────────────
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['device'] } },
        options: [
          {
            name: 'Send Command',
            value: 'sendCommand',
            description: 'Send one or more commands to a device',
            action: 'Send command to device',
          },
        ],
        default: 'sendCommand',
      },
      {
        displayName: 'Device ID',
        name: 'deviceId',
        type: 'string',
        default: '',
        required: true,
        description: 'The ID of the device to control',
        displayOptions: { show: { resource: ['device'], operation: ['sendCommand'] } },
      },
      // ── Smart Meter operations ────────────────────────────────────────────
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['smartMeter'] } },
        options: [
          {
            name: 'Get Meter Status',
            value: 'getMeterStatus',
            description: 'Read all current energy DPs from device status (forward_energy_total, energy_daily, energy_month, …)',
            action: 'Get smart meter status',
          },
          {
            name: 'Get Energy Daily',
            value: 'getEnergyDaily',
            description: 'Send energy_daily command and poll for electricTotal response. Falls back to current status if device does not support the command (error 2008).',
            action: 'Get daily energy consumption',
          },
          {
            name: 'Get Energy Monthly',
            value: 'getEnergyMonthly',
            description: 'Send energy_month command and poll for electricTotal response. Falls back to current status if device does not support the command (error 2008).',
            action: 'Get monthly energy consumption',
          },
        ],
        default: 'getEnergyDaily',
      },
      {
        displayName: 'Device ID',
        name: 'deviceId',
        type: 'string',
        default: '',
        required: true,
        description: 'ID of the smart meter device (zndb or znjdq category)',
        displayOptions: { show: { resource: ['smartMeter'] } },
      },
      {
        displayName: 'Start Month',
        name: 'startMonth',
        type: 'number',
        default: 1,
        required: true,
        typeOptions: { minValue: 1, maxValue: 12 },
        description: 'Start month (1–12)',
        displayOptions: { show: { resource: ['smartMeter'], operation: ['getEnergyDaily'] } },
      },
      {
        displayName: 'Start Day',
        name: 'startDay',
        type: 'number',
        default: 1,
        required: true,
        typeOptions: { minValue: 1, maxValue: 31 },
        description: 'Start day (1–31)',
        displayOptions: { show: { resource: ['smartMeter'], operation: ['getEnergyDaily'] } },
      },
      {
        displayName: 'End Month',
        name: 'endMonth',
        type: 'number',
        default: 1,
        required: true,
        typeOptions: { minValue: 1, maxValue: 12 },
        description: 'End month (1–12)',
        displayOptions: { show: { resource: ['smartMeter'], operation: ['getEnergyDaily'] } },
      },
      {
        displayName: 'End Day',
        name: 'endDay',
        type: 'number',
        default: 31,
        required: true,
        typeOptions: { minValue: 1, maxValue: 31 },
        description: 'End day (1–31)',
        displayOptions: { show: { resource: ['smartMeter'], operation: ['getEnergyDaily'] } },
      },
      {
        displayName: 'Start Year',
        name: 'startYear',
        type: 'number',
        default: 25,
        required: true,
        description: 'Start year as 2-digit number (e.g. 25 for 2025)',
        displayOptions: { show: { resource: ['smartMeter'], operation: ['getEnergyMonthly'] } },
      },
      {
        displayName: 'Start Month',
        name: 'startMonth',
        type: 'number',
        default: 1,
        required: true,
        typeOptions: { minValue: 1, maxValue: 12 },
        description: 'Start month (1–12)',
        displayOptions: { show: { resource: ['smartMeter'], operation: ['getEnergyMonthly'] } },
      },
      {
        displayName: 'End Year',
        name: 'endYear',
        type: 'number',
        default: 25,
        required: true,
        description: 'End year as 2-digit number (e.g. 25 for 2025)',
        displayOptions: { show: { resource: ['smartMeter'], operation: ['getEnergyMonthly'] } },
      },
      {
        displayName: 'End Month',
        name: 'endMonth',
        type: 'number',
        default: 12,
        required: true,
        typeOptions: { minValue: 1, maxValue: 12 },
        description: 'End month (1–12)',
        displayOptions: { show: { resource: ['smartMeter'], operation: ['getEnergyMonthly'] } },
      },
      {
        displayName: 'Timeout (Seconds)',
        name: 'timeoutSec',
        type: 'number',
        default: 15,
        typeOptions: { minValue: 5, maxValue: 60 },
        description: 'How long to wait for the meter to respond (seconds)',
        displayOptions: { show: { resource: ['smartMeter'] } },
      },

      // ── Vacuum operations ─────────────────────────────────────────────────
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['vacuum'] } },
        options: [
          {
            name: 'Get Current Map',
            value: 'getCurrentMap',
            description: 'Try all known API variants to fetch the current map data',
            action: 'Get current vacuum map',
          },
          {
            name: 'Get Map File List',
            value: 'getMapFileList',
            description: 'Try all known API variants to list stored map files',
            action: 'Get vacuum map file list',
          },
          {
            name: 'Get Cleaning Records',
            value: 'getCleaningRecords',
            description: 'Try all known API variants to fetch cleaning history',
            action: 'Get vacuum cleaning records',
          },
          {
            name: 'Get Areas',
            value: 'getAreas',
            description: 'Try all known API variants to fetch saved cleaning areas',
            action: 'Get vacuum areas',
          },
          {
            name: 'Get Rooms',
            value: 'getRooms',
            description: 'Try all known API variants to fetch room list',
            action: 'Get vacuum rooms',
          },
          {
            name: 'Get Configurations',
            value: 'getConfigurations',
            description: 'Try all known API variants to fetch device configuration',
            action: 'Get vacuum configurations',
          },
          {
            name: 'Get DPS',
            value: 'getDps',
            description: 'Try all known API variants to fetch raw data points',
            action: 'Get vacuum DPS',
          },
          {
            name: 'Get Schedules',
            value: 'getSchedules',
            description: 'Try all known API variants to fetch cleaning schedules/timers',
            action: 'Get vacuum schedules',
          },
          {
            name: 'Probe All Endpoints',
            value: 'probeAll',
            description: 'Try every known endpoint category at once — useful to discover which ones this device supports',
            action: 'Probe all vacuum endpoints',
          },
          {
            name: 'Get Map (Polling)',
            value: 'getMapPoll',
            description: 'Send get_both request, then poll the REST API every few seconds until map data appears. Reliable, no MQTT needed.',
            action: 'Get vacuum map via polling',
          },
          {
            name: 'Get Map (MQTT)',
            value: 'getMapMqtt',
            description: 'Send get_both request, connect via MQTT and wait for map + path data. Faster but requires MQTT credentials.',
            action: 'Get vacuum map via MQTT',
          },
        ],
        default: 'probeAll',
      },
      {
        displayName: 'Device ID',
        name: 'deviceId',
        type: 'string',
        default: '',
        required: true,
        description: 'The ID of the vacuum device',
        displayOptions: { show: { resource: ['vacuum'] } },
      },
      {
        displayName: 'MQTT Timeout (seconds)',
        name: 'mqttTimeout',
        type: 'number',
        default: 15,
        description: 'How long to wait for the vacuum to respond with map data (5–60 seconds)',
        displayOptions: { show: { resource: ['vacuum'], operation: ['getMapMqtt', 'getMapPoll'] } },
      },
      {
        displayName: 'Output Mode',
        name: 'outputMode',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['vacuum'], operation: ['getCurrentMap', 'getMapFileList', 'getCleaningRecords', 'getAreas', 'getRooms', 'getConfigurations', 'getDps', 'getSchedules', 'probeAll'] } },
        options: [
          {
            name: 'Successful Only',
            value: 'successOnly',
            description: 'Return only endpoints that responded with success:true',
          },
          {
            name: 'All Results',
            value: 'all',
            description: 'Return every endpoint tried, including failed ones — useful for debugging',
          },
        ],
        default: 'successOnly',
      },

      // ── API Explorer operations ───────────────────────────────────────────
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['apiExplorer'] } },
        options: [
          {
            name: 'Probe All',
            value: 'probeAll',
            description: 'Try every known endpoint across all categories (needs Device ID + Home ID for full coverage)',
            action: 'Probe all known API endpoints',
          },
          {
            name: 'Probe User Endpoints',
            value: 'probeUser',
            description: 'Try all user/profile endpoints — no Device ID or Home ID needed',
            action: 'Probe user endpoints',
          },
          {
            name: 'Probe HA Endpoints',
            value: 'probeHa',
            description: 'Try all Home Assistant integration endpoints',
            action: 'Probe HA endpoints',
          },
          {
            name: 'Probe Home Endpoints',
            value: 'probeHome',
            description: 'Try all home-level endpoints (members, rooms, scenes, weather, …)',
            action: 'Probe home endpoints',
          },
          {
            name: 'Probe Device Endpoints',
            value: 'probeDevice',
            description: 'Try all generic device endpoints (status, logs, schedules, properties, …)',
            action: 'Probe device endpoints',
          },
          {
            name: 'Probe Camera Endpoints',
            value: 'probeCamera',
            description: 'Try all IPC / camera endpoints (stream, RTSP, snapshots, playback, …)',
            action: 'Probe camera endpoints',
          },
          {
            name: 'Probe Lock Endpoints',
            value: 'probeLock',
            description: 'Try all smart lock endpoints (records, passwords, users, …)',
            action: 'Probe lock endpoints',
          },
          {
            name: 'Probe Infrared Endpoints',
            value: 'probeInfrared',
            description: 'Try all IR/remote control endpoints (remotes, categories, keys, …)',
            action: 'Probe infrared endpoints',
          },
          {
            name: 'Probe Energy Endpoints',
            value: 'probeEnergy',
            description: 'Try all energy monitoring endpoints (statistics, day/month/year, …)',
            action: 'Probe energy endpoints',
          },
          {
            name: 'Probe Air Quality Endpoints',
            value: 'probeAirQuality',
            description: 'Try all air quality / environment sensor endpoints',
            action: 'Probe air quality endpoints',
          },
          {
            name: 'Probe Doorbell Endpoints',
            value: 'probeDoorbell',
            description: 'Try all doorbell endpoints (records, messages, …)',
            action: 'Probe doorbell endpoints',
          },
          {
            name: 'Probe HVAC Endpoints',
            value: 'probeHvac',
            description: 'Try all HVAC / thermostat endpoints (status, schedules, …)',
            action: 'Probe HVAC endpoints',
          },
          {
            name: 'Probe Scene Endpoints',
            value: 'probeScenes',
            description: 'Try all scene and automation endpoints',
            action: 'Probe scene endpoints',
          },
        ],
        default: 'probeAll',
      },
      {
        displayName: 'Device ID',
        name: 'deviceId',
        type: 'string',
        default: '',
        description: 'Device ID for device-specific endpoints (leave blank to skip those categories)',
        displayOptions: { show: { resource: ['apiExplorer'] } },
      },
      {
        displayName: 'Home ID',
        name: 'homeId',
        type: 'string',
        default: '',
        description: 'Home ID for home-level endpoints (leave blank to skip those categories). Find it via Devices > Get All.',
        displayOptions: { show: { resource: ['apiExplorer'] } },
      },
      {
        displayName: 'Output Mode',
        name: 'outputMode',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['apiExplorer'] } },
        options: [
          {
            name: 'Successful Only',
            value: 'successOnly',
            description: 'Return only endpoints that responded with success:true',
          },
          {
            name: 'All Results',
            value: 'all',
            description: 'Return every endpoint tried, including failed ones — useful for debugging',
          },
        ],
        default: 'successOnly',
      },

      // ── Device > Send Command fields ──────────────────────────────────────
      {
        displayName: 'Commands',
        name: 'commandsUi',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true, minValue: 1 },
        required: true,
        default: { commands: [{ code: '', valueType: 'boolean', valueBoolean: false, valueText: '' }] },
        description: 'Commands to send. Click "Refresh" on the Code dropdown to load available commands for this device.',
        displayOptions: { show: { resource: ['device'], operation: ['sendCommand'] } },
        options: [
          {
            displayName: 'Command',
            name: 'commands',
            values: [
              {
                displayName: 'Code',
                name: 'code',
                type: 'options',
                typeOptions: { loadOptionsMethod: 'getDeviceCommands' },
                default: '',
                description: 'Command code — click refresh to load from the device\'s available functions',
              },
              {
                displayName: 'Value Type',
                name: 'valueType',
                type: 'options',
                options: [
                  { name: 'Boolean (Ein/Aus-Schalter)', value: 'boolean' },
                  { name: 'Text / Zahl / Enum', value: 'text' },
                ],
                default: 'boolean',
                description: 'Boolean for on/off switches; Text for numbers, enums, or strings',
              },
              {
                displayName: 'Value',
                name: 'valueBoolean',
                type: 'boolean',
                default: false,
                description: 'true = on / einschalten, false = off / ausschalten',
                displayOptions: { show: { valueType: ['boolean'] } },
              },
              {
                displayName: 'Value',
                name: 'valueText',
                type: 'string',
                default: '',
                description: 'For integers enter a number (e.g. 500), for enums one of the allowed values shown in the Code description',
                displayOptions: { show: { valueType: ['text'] } },
              },
            ],
          },
        ],
      },
    ],
  };

  methods = {
    loadOptions: {
      async getDeviceCommands(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        const creds = await this.getCredentials('tuyaSmartLifeApi');
        const clientId = creds.clientId as string;
        const userCode = creds.userCode as string;
        const deviceId = this.getNodeParameter('deviceId', 0) as string;

        if (!deviceId) throw new Error('Enter a Device ID first, then refresh this list.');

        const stored = readToken(clientId, userCode);
        if (!stored?.accessToken) throw new Error('Not logged in — run Setup > Complete Login first.');

        const client = new TuyaApiClient(clientId, stored);
        const specs = await client.getDeviceSpecifications(deviceId);

        if (!specs.functions?.length) {
          return [{ name: '(no functions returned by API)', value: '' }];
        }

        return specs.functions.map((fn) => {
          let hint = fn.type;
          try {
            const v = JSON.parse(fn.values);
            if (fn.type === 'Boolean') hint = 'Boolean: true / false';
            else if (fn.type === 'Integer') hint = `Integer ${v.min ?? ''}–${v.max ?? ''} step ${v.step ?? 1}`;
            else if (fn.type === 'Enum' && v.range) hint = `Enum: ${(v.range as string[]).join(' | ')}`;
            else if (fn.type === 'String') hint = `String max ${v.maxlen ?? '?'} chars`;
          } catch { /* leave raw hint */ }
          return {
            name: `${fn.code}  [${hint}]`,
            value: fn.code,
            description: fn.values,
          };
        });
      },
    },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];

    const resource = this.getNodeParameter('resource', 0) as string;
    const operation = this.getNodeParameter('operation', 0) as string;

    const creds = await this.getCredentials('tuyaSmartLifeApi');
    const clientId = creds.clientId as string;
    const userCode = creds.userCode as string;
    const apiRegion = (creds.apiRegion as string) || 'auto';
    const customEndpoint = (creds.customEndpoint as string) || '';

    // Resolve endpoint override from credentials (overrides the stored login endpoint)
    let endpointOverride: string | undefined;
    if (apiRegion !== 'auto') {
      endpointOverride = apiRegion === 'custom' ? customEndpoint : apiRegion;
    }

    // Load tokens from file — persists across workflows, executions and n8n restarts.
    // Keyed by clientId:userCode so each distinct credential set has its own session.
    const stored = readToken(clientId, userCode);
    const storedEndpoint = endpointOverride || stored?.endpoint || '';

    const tokenInfo: TokenInfo | undefined = stored?.accessToken
      ? { ...stored, endpoint: storedEndpoint }
      : undefined;

    const client = new TuyaApiClient(clientId, tokenInfo);

    // Persist any token refresh back to disk
    const syncTokens = () => {
      const t = client.getTokenInfo();
      if (t) writeToken(clientId, userCode, t);
    };

    for (let i = 0; i < items.length; i++) {
      try {
        if (resource === 'setup') {
          if (operation === 'generateQRCode') {
            const qrResult = await client.generateQRCode(userCode);
            // The API returns the poll token in the "qrcode" field
            const pollToken = (qrResult.qrcode ?? qrResult.token) as string;
            const deepLink = `tuyaSmart--qrLogin?token=${pollToken}`;

            const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(deepLink)}&size=300x300&format=png`;
            const qrImageDataUrl = await fetchQrImage(qrImageUrl);
            const base64Data = qrImageDataUrl.replace(/^data:image\/png;base64,/, '');

            const binaryData: IBinaryData = {
              data: base64Data,
              mimeType: 'image/png',
              fileName: 'qrcode.png',
              fileExtension: 'png',
            };

            returnData.push({
              json: {
                token: pollToken,
                hint: 'Scan the QR code with the Smart Life app, then run "Complete Login" with the token value above.',
              },
              binary: { qrcode: binaryData },
            });

          } else if (operation === 'completeLogin') {
            const qrToken = this.getNodeParameter('qrToken', i) as string;
            const loginResult = await client.pollLoginResult(qrToken, userCode);

            // Persist tokens to file so any workflow can use them
            writeToken(clientId, userCode, loginResult);

            returnData.push({
              json: {
                success: true,
                uid: loginResult.uid,
                terminalId: loginResult.terminalId,
                endpoint: loginResult.endpoint,
                tokenFile: tokenFilePath(),
                expiresAt: loginResult.expireTime
                  ? new Date(loginResult.expireTime).toISOString()
                  : 'unknown',
                mqttPasswordFromLogin: loginResult.mqttPassword ?? null,
                extraLoginFields: loginResult.extras ?? null,
                message: 'Login successful — tokens saved automatically, no manual steps needed.',
              },
            });

          } else if (operation === 'loginStatus') {
            const token = readToken(clientId, userCode);
            const effectiveEndpoint = endpointOverride || token?.endpoint || null;
            returnData.push({
              json: {
                loggedIn: !!(token?.accessToken),
                uid: token?.uid || null,
                terminalId: token?.terminalId || null,
                endpoint: effectiveEndpoint,
                endpointSource: endpointOverride ? 'credentials override' : 'login response',
                tokenFile: tokenFilePath(),
                expiresAt: token?.expireTime ? new Date(token.expireTime).toISOString() : null,
                isExpired: token?.expireTime ? token.expireTime < Date.now() : null,
              },
            });

          } else if (operation === 'importToken') {
            const accessToken   = (this.getNodeParameter('importAccessToken', i) as string).trim();
            const refreshToken  = (this.getNodeParameter('importRefreshToken', i, '') as string).trim();
            const uid           = (this.getNodeParameter('importUid', i) as string).trim();
            const endpoint      = (this.getNodeParameter('importEndpoint', i, '') as string).trim();
            const terminalId    = (this.getNodeParameter('importTerminalId', i, '') as string).trim();

            if (!accessToken) throw new NodeOperationError(this.getNode(), 'Access Token is required for manual import.');
            if (!uid)         throw new NodeOperationError(this.getNode(), 'UID is required for manual import.');

            const imported: TokenInfo = {
              accessToken,
              refreshToken: refreshToken || '',
              uid,
              terminalId: terminalId || '',
              endpoint: endpoint || 'https://apigw.tuyaeu.com',
              expireTime: Date.now() + 7200_000, // assume 2 h; user can re-import if it expires
            };
            writeToken(clientId, userCode, imported);
            returnData.push({
              json: {
                success: true,
                uid,
                endpoint: imported.endpoint,
                tokenFile: tokenFilePath(),
                message: 'Token imported and saved. Run "Show Login Status" to verify.',
              },
            });
          }

        } else if (resource === 'devices') {
          if (operation === 'getAll') {
            const devices = await client.getDevices();
            syncTokens();
            for (const device of devices) {
              returnData.push({ json: device as unknown as IDataObject });
            }
          } else if (operation === 'get') {
            const deviceId = this.getNodeParameter('deviceId', i) as string;
            const [device, specs] = await Promise.all([
              client.getDevice(deviceId),
              client.getDeviceSpecifications(deviceId),
            ]);
            syncTokens();
            if (!device) throw new NodeOperationError(this.getNode(), `Device ${deviceId} not found`);

            const specMap = new Map<string, { type: string; values: string }>();
            for (const fn of [...(specs.functions ?? []), ...(specs.status ?? [])]) {
              specMap.set(fn.code, fn);
            }

            const enrichedStatus = (device.status ?? []).map((s) => {
              const spec = specMap.get(s.code);
              if (!spec) return { code: s.code, value: s.value };
              const entry: IDataObject = { code: s.code, type: spec.type };
              try {
                const desc = JSON.parse(spec.values);
                if (spec.type === 'Integer' && typeof s.value === 'number') {
                  const scale: number = desc.scale ?? 0;
                  const factor = Math.pow(10, scale);
                  entry.rawValue = s.value;
                  entry.factor = factor;
                  entry.value = scale > 0 ? s.value / factor : s.value;
                  if (desc.unit) entry.unit = desc.unit;
                } else {
                  entry.value = s.value;
                  if (desc.unit) entry.unit = desc.unit;
                }
              } catch {
                entry.value = s.value;
              }
              return entry;
            });

            returnData.push({ json: { ...device, status: enrichedStatus } as unknown as IDataObject });
          }

        } else if (resource === 'vacuum') {
          const deviceId = this.getNodeParameter('deviceId', i) as string;

          if (operation === 'getMapPoll') {
            const timeoutSec = this.getNodeParameter('mqttTimeout', i, 30) as number;

            const result: PollMapResult = await client.requestVacuumMapViaPolling(deviceId, timeoutSec * 1000);
            syncTokens();

            returnData.push({
              json: {
                deviceId,
                method: 'polling',
                timedOut: result.timedOut,
                elapsedMs: result.elapsedMs,
                pollCount: result.pollCount,
                commandTrans: result.commandTrans,
                pathData: result.pathData,
                baseCommandTrans: result.baseCommandTrans,
                basePathData: result.basePathData,
                note: result.timedOut
                  ? 'Timeout reached — device may not have updated its map. Try running a cleaning cycle first.'
                  : 'Map data received.',
              } as unknown as IDataObject,
            });
            continue;
          }

          if (operation === 'getMapMqtt') {
            const timeoutSec = this.getNodeParameter('mqttTimeout', i, 15) as number;
            const uid = client.getTokenInfo()?.uid ?? stored?.uid ?? '';
            if (!uid) throw new NodeOperationError(this.getNode(), 'No UID found — run Setup > Complete Login first.');

            const result: MqttMapResult = await client.requestVacuumMapViaMqtt(deviceId, uid, timeoutSec * 1000);
            syncTokens();

            returnData.push({
              json: {
                deviceId,
                uid,
                method: 'mqtt',
                mqttConfigSource: result.mqttConfigSource ?? null,
                brokerUrl: result.brokerUrl ?? null,
                timedOut: result.timedOut,
                elapsedMs: result.elapsedMs,
                receivedMessages: result.allMessages.length,
                commandTrans: result.commandTrans,
                pathData: result.pathData,
                allMessages: result.allMessages,
                strategiesTried: result.strategiesTried ?? [],
                authError: result.authError ?? null,
              } as unknown as IDataObject,
            });
            continue;
          }

          const outputMode = this.getNodeParameter('outputMode', i) as string;

          let results: EndpointResult[] = [];

          if (operation === 'getCurrentMap') {
            results = await client.getVacuumCurrentMap(deviceId);
          } else if (operation === 'getMapFileList') {
            results = await client.getVacuumMapFileList(deviceId);
          } else if (operation === 'getCleaningRecords') {
            results = await client.getVacuumCleaningRecords(deviceId);
          } else if (operation === 'getAreas') {
            results = await client.getVacuumAreas(deviceId);
          } else if (operation === 'getRooms') {
            results = await client.getVacuumRooms(deviceId);
          } else if (operation === 'getConfigurations') {
            results = await client.getVacuumConfigurations(deviceId);
          } else if (operation === 'getDps') {
            results = await client.getVacuumDps(deviceId);
          } else if (operation === 'getSchedules') {
            results = await client.getVacuumSchedules(deviceId);
          } else if (operation === 'probeAll') {
            results = await client.probeAllVacuumEndpoints(deviceId);
          }

          syncTokens();

          const filtered = outputMode === 'successOnly' ? results.filter((r) => r.success) : results;
          const successCount = results.filter((r) => r.success).length;

          // Each result becomes a separate item so they can be processed individually in n8n
          if (filtered.length === 0) {
            returnData.push({
              json: {
                deviceId,
                operation,
                successCount,
                totalTried: results.length,
                message: outputMode === 'successOnly'
                  ? 'No endpoints responded successfully. Switch Output Mode to "All Results" to see errors.'
                  : 'No endpoints tried.',
              },
            });
          } else {
            for (const r of filtered) {
              returnData.push({
                json: {
                  deviceId,
                  operation,
                  endpoint: r.endpoint,
                  method: r.method,
                  success: r.success,
                  result: r.result ?? null,
                  error: r.error ?? null,
                } as unknown as IDataObject,
              });
            }
          }

        } else if (resource === 'apiExplorer') {
          const deviceId = (this.getNodeParameter('deviceId', i) as string).trim() || undefined;
          const homeId = (this.getNodeParameter('homeId', i) as string).trim() || undefined;
          const outputMode = this.getNodeParameter('outputMode', i) as string;

          let results: EndpointResult[] = [];

          if (operation === 'probeAll') {
            results = await client.probeAllKnownEndpoints(deviceId, homeId);
          } else if (operation === 'probeUser') {
            results = await client.probeUserEndpoints();
          } else if (operation === 'probeHa') {
            results = await client.probeHaEndpoints(homeId);
          } else if (operation === 'probeHome') {
            if (!homeId) throw new NodeOperationError(this.getNode(), 'Home ID is required for Probe Home Endpoints');
            results = await client.probeHomeEndpoints(homeId);
          } else if (operation === 'probeDevice') {
            if (!deviceId) throw new NodeOperationError(this.getNode(), 'Device ID is required for Probe Device Endpoints');
            results = await client.probeDeviceEndpoints(deviceId);
          } else if (operation === 'probeCamera') {
            if (!deviceId) throw new NodeOperationError(this.getNode(), 'Device ID is required for Probe Camera Endpoints');
            results = await client.probeCameraEndpoints(deviceId);
          } else if (operation === 'probeLock') {
            if (!deviceId) throw new NodeOperationError(this.getNode(), 'Device ID is required for Probe Lock Endpoints');
            results = await client.probeLockEndpoints(deviceId);
          } else if (operation === 'probeInfrared') {
            if (!deviceId) throw new NodeOperationError(this.getNode(), 'Device ID is required for Probe Infrared Endpoints');
            results = await client.probeInfraredEndpoints(deviceId);
          } else if (operation === 'probeEnergy') {
            if (!deviceId) throw new NodeOperationError(this.getNode(), 'Device ID is required for Probe Energy Endpoints');
            results = await client.probeEnergyEndpoints(deviceId);
          } else if (operation === 'probeAirQuality') {
            if (!deviceId) throw new NodeOperationError(this.getNode(), 'Device ID is required for Probe Air Quality Endpoints');
            results = await client.probeAirQualityEndpoints(deviceId);
          } else if (operation === 'probeDoorbell') {
            if (!deviceId) throw new NodeOperationError(this.getNode(), 'Device ID is required for Probe Doorbell Endpoints');
            results = await client.probeDoorbellEndpoints(deviceId);
          } else if (operation === 'probeHvac') {
            if (!deviceId) throw new NodeOperationError(this.getNode(), 'Device ID is required for Probe HVAC Endpoints');
            results = await client.probeHvacEndpoints(deviceId);
          } else if (operation === 'probeScenes') {
            if (!homeId) throw new NodeOperationError(this.getNode(), 'Home ID is required for Probe Scene Endpoints');
            results = await client.probeSceneEndpoints(homeId);
          }

          syncTokens();

          const filtered = outputMode === 'successOnly' ? results.filter((r) => r.success) : results;
          const successCount = results.filter((r) => r.success).length;

          if (filtered.length === 0) {
            returnData.push({
              json: {
                deviceId: deviceId ?? null,
                homeId: homeId ?? null,
                operation,
                successCount,
                totalTried: results.length,
                message: outputMode === 'successOnly'
                  ? 'No endpoints responded successfully. Switch Output Mode to "All Results" to see all errors.'
                  : 'No endpoints tried.',
              },
            });
          } else {
            for (const r of filtered) {
              returnData.push({
                json: {
                  category: r.category ?? null,
                  label: r.label ?? null,
                  endpoint: r.endpoint,
                  method: r.method,
                  success: r.success,
                  result: r.result ?? null,
                  error: r.error ?? null,
                } as unknown as IDataObject,
              });
            }
          }

        } else if (resource === 'device') {
          if (operation === 'sendCommand') {
            const deviceId = this.getNodeParameter('deviceId', i) as string;
            const uiCommands = (this.getNodeParameter('commandsUi.commands', i, []) as Array<{ code: string; valueType: string; valueBoolean: boolean; valueText: string }>);

            const commands: Command[] = uiCommands.map((item) => ({
              code: item.code,
              value: item.valueType === 'boolean' ? item.valueBoolean : parseCommandValue(item.valueText ?? ''),
            }));

            await client.sendCommand(deviceId, commands);
            syncTokens();
            returnData.push({ json: { success: true, deviceId, commands } });
          }

        } else if (resource === 'smartMeter') {
          const deviceId = this.getNodeParameter('deviceId', i) as string;
          const timeoutSec = this.getNodeParameter('timeoutSec', i, 15) as number;
          const timeoutMs = timeoutSec * 1000;

          if (operation === 'getMeterStatus') {
            const status: MeterStatus = await client.getMeterStatus(deviceId);
            syncTokens();
            returnData.push({
              json: {
                deviceId,
                forwardEnergyTotal: status.forwardEnergyTotal ?? null,
                reverseEnergyTotal: status.reverseEnergyTotal ?? null,
                energyDaily: status.energyDaily ?? null,
                energyMonth: status.energyMonth ?? null,
                raw: status.raw,
              } as unknown as IDataObject,
            });

          } else if (operation === 'getEnergyDaily') {
            const startMonth = this.getNodeParameter('startMonth', i) as number;
            const startDay   = this.getNodeParameter('startDay',   i) as number;
            const endMonth   = this.getNodeParameter('endMonth',   i) as number;
            const endDay     = this.getNodeParameter('endDay',     i) as number;

            const result: EnergyQueryResult = await client.requestEnergyDaily(
              deviceId, startMonth, startDay, endMonth, endDay, timeoutMs,
            );
            syncTokens();
            returnData.push({
              json: {
                deviceId,
                electricTotal: result.electricTotal,
                unit: 'kWh',
                startMonth: result.startMonth,
                startDay: result.startDay,
                endMonth: result.endMonth,
                endDay: result.endDay,
                timedOut: result.timedOut,
                elapsedMs: result.elapsedMs,
                pollCount: result.pollCount,
                commandNotSupported: result.commandNotSupported ?? false,
              } as unknown as IDataObject,
            });

          } else if (operation === 'getEnergyMonthly') {
            const startYear  = this.getNodeParameter('startYear',  i) as number;
            const startMonth = this.getNodeParameter('startMonth', i) as number;
            const endYear    = this.getNodeParameter('endYear',    i) as number;
            const endMonth   = this.getNodeParameter('endMonth',   i) as number;

            const result: EnergyQueryResult = await client.requestEnergyMonthly(
              deviceId, startYear, startMonth, endYear, endMonth, timeoutMs,
            );
            syncTokens();
            returnData.push({
              json: {
                deviceId,
                electricTotal: result.electricTotal,
                unit: 'kWh',
                startYear: result.startYear,
                startMonth: result.startMonth,
                endYear: result.endYear,
                endMonth: result.endMonth,
                timedOut: result.timedOut,
                elapsedMs: result.elapsedMs,
                pollCount: result.pollCount,
                commandNotSupported: result.commandNotSupported ?? false,
              } as unknown as IDataObject,
            });
          }
        }
      } catch (error) {
        if (this.continueOnFail()) {
          returnData.push({
            json: { error: (error as Error).message },
            pairedItem: { item: i },
          });
          continue;
        }
        throw error;
      }
    }

    return [returnData];
  }
}
