import {
  IDataObject,
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeOperationError,
} from 'n8n-workflow';
import * as https from 'https';
import { TuyaApiClient, TokenInfo, Command } from './TuyaApiClient';

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
            description: 'Poll for QR login result and retrieve tokens',
            action: 'Complete login',
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
    const userCode = creds.userCode as string;

    const tokenInfo: TokenInfo | undefined = creds.accessToken
      ? {
          accessToken: creds.accessToken as string,
          refreshToken: creds.refreshToken as string,
          expireTime: (creds.expireTime as number) || 0,
          uid: creds.uid as string,
          terminalId: creds.terminalId as string,
        }
      : undefined;

    const client = new TuyaApiClient(tokenInfo);

    for (let i = 0; i < items.length; i++) {
      try {
        if (resource === 'setup') {
          if (operation === 'generateQRCode') {
            const qrResult = await client.generateQRCode(userCode);
            const qrcodeData = qrResult.qrcode;
            const token = qrResult.token;

            const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qrcodeData)}&size=300x300&format=png`;
            const qrImageDataUrl = await fetchQrImage(qrImageUrl);

            returnData.push({
              json: {
                qrcode: qrImageDataUrl,
                token,
                qrcodeData,
                hint: 'Scan the QR code with the Smart Life app, then use the "Complete Login" operation with the returned token.',
              },
            });
          } else if (operation === 'completeLogin') {
            const qrToken = this.getNodeParameter('qrToken', i) as string;
            const loginResult = await client.pollLoginResult(qrToken, userCode);

            returnData.push({
              json: {
                success: true,
                accessToken: loginResult.accessToken,
                refreshToken: loginResult.refreshToken,
                expireTime: loginResult.expireTime,
                uid: loginResult.uid,
                terminalId: loginResult.terminalId,
                message: 'Login successful — copy these values into your credential fields',
              },
            });
          }
        } else if (resource === 'devices') {
          if (operation === 'getAll') {
            const devices = await client.getDevices();
            for (const device of devices) {
              returnData.push({ json: device as unknown as IDataObject });
            }
          } else if (operation === 'getStatus') {
            const deviceId = this.getNodeParameter('deviceId', i) as string;
            const statuses = await client.getDeviceStatus(deviceId);
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
              throw new NodeOperationError(this.getNode(), `Invalid JSON in Commands parameter: ${commandsRaw}`, { itemIndex: i });
            }

            await client.sendCommand(deviceId, commands);
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
