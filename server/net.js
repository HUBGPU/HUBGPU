// Outbound HTTP through curl. Blockscout sits behind Cloudflare and answers curl
// with browser headers but 403s Node's fetch; the official Robinhood RPC is
// TLS-intercepted on some ISPs. One door for every read keeps that in one place.
import { execFile } from 'node:child_process';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const PREFER_V6 = process.env.CURL_PREFER_V6 === '1';

function run(args, { timeoutS = 15, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('curl', ['-s', '--compressed', '-L', '-m', String(timeoutS), ...(PREFER_V6 ? ['-6'] : []), '-w', '\n%{http_code}', ...args],
      { maxBuffer: 24 * 1024 * 1024, encoding: binary ? 'buffer' : 'utf8' },
      (err, out) => {
        if (err) return reject(new Error('curl: ' + err.message.split('\n')[0]));
        const cut = binary ? out.lastIndexOf(10) : out.lastIndexOf('\n');
        const code = Number(binary ? out.subarray(cut + 1).toString() : out.slice(cut + 1));
        const body = binary ? out.subarray(0, cut) : out.slice(0, cut);
        if (code >= 400 || code === 0) return reject(Object.assign(new Error('HTTP ' + code), { code }));
        resolve(body);
      });
  });
}
const headers = referer => ['-H', 'User-Agent: ' + UA, '-H', 'accept-language: en-US,en;q=0.9', ...(referer ? ['-H', 'referer: ' + referer] : [])];

export async function getJson(url, referer) {
  const body = await run([...headers(referer), '-H', 'accept: application/json', url]);
  try { return JSON.parse(body); } catch { throw new Error('not JSON from ' + new URL(url).host); }
}
export const getBinary = (url, timeoutS = 20) => run([...headers(), '-H', 'accept: image/*', '--max-filesize', '8000000', url], { binary: true, timeoutS });
export async function postJson(url, payload, timeoutS = 12) {
  const body = await run(['-H', 'content-type: application/json', '-H', 'User-Agent: ' + UA, '--data-binary', JSON.stringify(payload), url], { timeoutS });
  return JSON.parse(body);
}
/** multipart upload of a local file: fields = { name: value }, file = path */
export async function postForm(url, fields, filePath, timeoutS = 40) {
  const args = [...headers()];
  for (const [k, v] of Object.entries(fields)) args.push('--form-string', `${k}=${v}`);
  args.push('-F', `file=@${filePath}`, url);
  return JSON.parse(await run(args, { timeoutS }));
}
