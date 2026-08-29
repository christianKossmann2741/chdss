export const DEFAULT_PORT = 41730;

export function normalizePort(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 to 65535');
  return port;
}

export function publicViewerUrl(address, port, token) {
  const host = address.includes(':') ? `[${address}]` : address;
  return `http://${host}:${port}/#${encodeURIComponent(token)}`;
}

export function redactToken(token) {
  const value = String(token ?? '');
  return value.length >= 8 ? `${value.slice(0, 4)}…${value.slice(-4)}` : '••••';
}
