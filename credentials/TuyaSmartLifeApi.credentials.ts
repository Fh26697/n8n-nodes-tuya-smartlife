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
  ];
}
