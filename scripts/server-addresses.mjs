import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

const httpURL = (address, port) => `http://${isIP(address) === 6 ? `[${address}]` : address}:${port}/`;

export function connectionURLs({ host, port, publicURL = '', interfaces = networkInterfaces() }) {
  const local = httpURL(host === '0.0.0.0' || host === '::' ? 'localhost' : host, port);
  const lan = new Set(), internet = new Set();
  if (publicURL) {
    let url;
    try { url = new URL(publicURL); } catch { throw new Error('PUBLIC_URLは http:// または https:// から始まる接続用URLを指定してください。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('PUBLIC_URLは認証情報を含まないHTTP/HTTPS URLを指定してください。');
    internet.add(url.href);
  }
  for (const entry of Object.values(interfaces).flat()) {
    if (!entry || entry.internal) continue;
    const family = isIP(entry.address);
    const reachable = host === '::' || (host === '0.0.0.0' && family === 4) || host === entry.address;
    if (!reachable) continue;
    if (family === 4) lan.add(httpURL(entry.address, port));
    // Globally routed IPv6 addresses are in 2000::/3; scoped/local addresses cannot be shared over the internet.
    if (family === 6 && /^[23][0-9a-f]{3}:/i.test(entry.address) && !/^2001:0?db8:/i.test(entry.address)) internet.add(httpURL(entry.address, port));
  }
  return { local, lan: [...lan], internet: [...internet] };
}
