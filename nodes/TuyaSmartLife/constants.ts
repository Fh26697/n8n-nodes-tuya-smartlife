export const SCHEMA   = 'haauthorize';
export const ENDPOINT = 'https://apigw.iotbing.com';
export const NONCE_CHARS = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';

// Auth-gateway endpoints for QR login flow (apigw.*, NOT the signed-API host).
// Tried in order when auto-detection is on; first success wins.
export const AUTH_GATEWAYS = [
  'https://apigw.tuyaeu.com',   // EU  (try first — most common for non-China)
  'https://apigw.tuyaus.com',   // US
  'https://apigw.iotbing.com',  // China
  'https://apigw.tuyain.com',   // India
];
