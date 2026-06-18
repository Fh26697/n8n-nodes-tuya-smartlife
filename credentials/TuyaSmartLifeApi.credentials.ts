import { ICredentialType, INodeProperties } from 'n8n-workflow';

export class TuyaSmartLifeApi implements ICredentialType {
  name = 'tuyaSmartLifeApi';
  displayName = 'Tuya Smart Life API';
  documentationUrl = 'https://github.com/Fh26697/n8n-nodes-tuya-smartlife';
  properties: INodeProperties[] = [
    {
      displayName: 'User Code',
      name: 'userCode',
      type: 'string',
      default: '',
      required: true,
      description: 'Open Smart Life App → Me → ⚙️ → Account & Security → User Code',
    },
    {
      displayName: 'Region',
      name: 'region',
      type: 'options',
      options: [
        { name: 'Europe', value: 'eu' },
        { name: 'United States', value: 'us' },
        { name: 'China', value: 'cn' },
      ],
      default: 'eu',
      required: true,
    },
    {
      displayName: 'Access Token',
      name: 'accessToken',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      description: 'Set automatically after QR login — do not edit manually',
    },
    {
      displayName: 'Refresh Token',
      name: 'refreshToken',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      description: 'Set automatically after QR login — do not edit manually',
    },
    {
      displayName: 'Token Expire Time',
      name: 'expireTime',
      type: 'number',
      default: 0,
      description: 'Unix timestamp (ms) when the access token expires — set automatically',
    },
    {
      displayName: 'User ID',
      name: 'uid',
      type: 'string',
      default: '',
      description: 'Set automatically after QR login',
    },
    {
      displayName: 'Terminal ID',
      name: 'terminalId',
      type: 'string',
      default: '',
      description: 'Set automatically after QR login',
    },
  ];
}
