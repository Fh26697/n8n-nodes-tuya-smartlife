import {
  IDataObject,
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeOperationError,
  IBinaryData,
} from 'n8n-workflow';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { TuyaApiClient, TokenInfo, Command } from './TuyaApiClient';

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

function readToken(userCode: string): TokenInfo | undefined {
  return loadTokens()[userCode];
}

function writeToken(userCode: string, info: TokenInfo): void {
  const all = loadTokens();
  all[userCode] = info;
  saveTokens(all);
}

function deleteToken(userCode: string): void {
  const all = loadTokens();
  delete all[userCode];
  saveTokens(all);
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
            name: 'Get Status',
            value: 'getStatus',
            description: 'Get the current status of a device',
            action: 'Get device status',
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
        displayOptions: { show: { resource: ['devices'], operation: ['getStatus'] } },
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
      {
        displayName: 'Commands (JSON)',
        name: 'commands',
        type: 'string',
        default: '[{"code":"switch_1","value":true}]',
        required: true,
        description: 'JSON array of commands, e.g. [{"code":"switch_1","value":true}]',
        displayOptions: { show: { resource: ['device'], operation: ['sendCommand'] } },
      },
    ],
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
    // The file is keyed by userCode so multiple accounts don't collide.
    const stored = readToken(userCode);
    const storedEndpoint = endpointOverride || stored?.endpoint || '';

    const tokenInfo: TokenInfo | undefined = stored?.accessToken
      ? { ...stored, endpoint: storedEndpoint }
      : undefined;

    const client = new TuyaApiClient(clientId, tokenInfo);

    // Persist any token refresh back to disk
    const syncTokens = () => {
      const t = client.getTokenInfo();
      if (t) writeToken(userCode, t);
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
            writeToken(userCode, loginResult);

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
                message: 'Login successful — tokens saved automatically, no manual steps needed.',
              },
            });

          } else if (operation === 'loginStatus') {
            const token = readToken(userCode);
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
          }

        } else if (resource === 'devices') {
          if (operation === 'getAll') {
            const devices = await client.getDevices();
            syncTokens();
            for (const device of devices) {
              returnData.push({ json: device as unknown as IDataObject });
            }
          } else if (operation === 'getStatus') {
            const deviceId = this.getNodeParameter('deviceId', i) as string;
            const statuses = await client.getDeviceStatus(deviceId);
            syncTokens();
            returnData.push({ json: { deviceId, status: statuses } });
          }

        } else if (resource === 'device') {
          if (operation === 'sendCommand') {
            const deviceId = this.getNodeParameter('deviceId', i) as string;
            const commandsRaw = this.getNodeParameter('commands', i) as string;

            let commands: Command[];
            try {
              commands = JSON.parse(commandsRaw) as Command[];
            } catch {
              throw new NodeOperationError(
                this.getNode(),
                `Invalid JSON in Commands parameter: ${commandsRaw}`,
                { itemIndex: i },
              );
            }

            await client.sendCommand(deviceId, commands);
            syncTokens();
            returnData.push({ json: { success: true, deviceId, commands } });
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
