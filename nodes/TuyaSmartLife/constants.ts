export const SCHEMA   = 'haauthorize';
export const ENDPOINT = 'https://apigw.iotbing.com';
export const NONCE_CHARS = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';

// Auth-gateway endpoints for QR login flow (apigw.*, NOT the signed-API host).
// iotbing.com is the global/China entry point where HA_3y9q4ak7g4ephrvke is registered.
// Tried in order; first success wins.
export const AUTH_GATEWAYS = [
  'https://apigw.iotbing.com',  // Global/China — HA clientId is registered here; try FIRST
  'https://apigw.tuyaeu.com',   // EU
  'https://apigw.tuyaus.com',   // US
  'https://apigw.tuyain.com',   // India
];
