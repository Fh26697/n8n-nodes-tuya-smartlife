import { ICredentialType, INodeProperties } from 'n8n-workflow';

export class TuyaSmartLifeApi implements ICredentialType {
  name = 'tuyaSmartLifeApi';
  displayName = 'Tuya Smart Life API';
  documentationUrl = 'https://github.com/Fh26697/n8n-nodes-tuya-smartlife';
  properties: INodeProperties[] = [
    {
      displayName: 'App Client ID',
      name: 'clientId',
      type: 'string',
      default: 'HA_3y9q4ak7g4ephrvke',
      required: true,
      description: 'Tuya app client ID. The pre-filled default works for most users. Replace with your own if you have a dedicated app registration.',
    },
    {
      displayName: 'User Code',
      name: 'userCode',
      type: 'string',
      default: '',
      required: true,
      description: 'Open Smart Life App → Me → ⚙️ → Account & Security → User Code',
    },
    {
      displayName: 'API Region',
      name: 'apiRegion',
      type: 'options',
      default: 'auto',
      description: 'Select your Tuya account region. Use "Auto-detect" first — override only if Get Devices returns Not Found. Check the endpoint shown by "Show Login Status" to confirm.',
      options: [
        { name: 'Auto-detect (from login response)', value: 'auto' },
        { name: 'China', value: 'https://apigw.iotbing.com' },
        { name: 'Central Europe', value: 'https://apigw.tuyaeu.com' },
        { name: 'Western America', value: 'https://apigw.tuyaus.com' },
        { name: 'India', value: 'https://apigw.tuyain.com' },
        { name: 'Custom (see below)', value: 'custom' },
      ],
    },
    {
      displayName: 'Custom API Endpoint',
      name: 'customEndpoint',
      type: 'string',
      default: '',
      placeholder: 'https://apigw.example.com',
      description: 'Custom API gateway URL. Only used when API Region is set to "Custom".',
      displayOptions: { show: { apiRegion: ['custom'] } },
    },
  ];
}
