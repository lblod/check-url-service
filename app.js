import { app } from 'mu';
import bodyParser from 'body-parser';
import { lookup } from 'node:dns/promises';

const REQUEST_TIMEOUT_MS = 10_000;

app.use(bodyParser.json());

function isPrivateIPv4(ip) {
    const [a, b] = ip.split('.').map(Number);
    return (
        a === 0 || // 0.0.0.0/8
        a === 10 || // 10.0.0.0/8
        (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10
        a === 127 || // 127.0.0.0/8
        (a === 169 && b === 254) || // 169.254.0.0/16
        (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
        (a === 192 && b === 168) || // 192.168.0.0/16
        a >= 224 // multicast, reserved and broadcast ranges
    );
}

function parseIPv6Groups(part) {
    if (!part) {
        return [];
    }

    const groups = [];

    for (const chunk of part.split(':')) {
        if (chunk.includes('.')) {
            const octets = chunk.split('.').map(Number);

            if (
                octets.length !== 4 ||
                octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
            ) {
                return null;
            }

            groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
        } else {
            const group = parseInt(chunk, 16);

            if (!Number.isInteger(group) || group < 0 || group > 0xffff) {
                return null;
            }
            groups.push(group);
        }
    }

    return groups;
}

function expandIPv6(ip) {
    const address = ip.toLowerCase();

    if (!address.includes('::')) {
        return parseIPv6Groups(address);
    }

    const parts = address.split('::');

    if (parts.length !== 2) {
        return null;
    }

    const [rawHead, rawTail] = parts;
    const head = parseIPv6Groups(rawHead);
    const tail = parseIPv6Groups(rawTail);

    if (!head || !tail) {
        return null;
    }

    const missingGroups = 8 - head.length - tail.length;

    if (missingGroups < 1) {
        return null;
    }

    return [...head, ...Array(missingGroups).fill(0), ...tail];
}

function isPrivateIPv6(ip) {
    const groups = expandIPv6(ip);

    if (!groups || groups.length !== 8) {
        return true; // unparseable addresses are never trusted
    }

    if (groups.every((group) => group === 0)) {
        return true; // ::
    }

    if (
        groups.slice(0, 7).every((group) => group === 0) &&
        groups[7] === 1
    ) {
        return true; // ::1
    }

    if (
        groups.slice(0, 5).every((group) => group === 0) &&
        groups[5] === 0xffff
    ) {
        const ipv4 = [
            groups[6] >> 8,
            groups[6] & 0xff,
            groups[7] >> 8,
            groups[7] & 0xff
        ].join('.');

        return isPrivateIPv4(ipv4); // IPv4-mapped addresses
    }

    const first = groups[0];

    return (
        (first & 0xfe00) === 0xfc00 || // Unique local fc00::/7
        (first & 0xffc0) === 0xfe80 || // Link-local fe80::/10
        (first & 0xff00) === 0xff00 // Multicast ff00::/8
    );
}

function isPrivateAddress({ address, family }) {
    return family === 4 ? isPrivateIPv4(address) : isPrivateIPv6(address);
}

async function validatePublicUrl(url) {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');

    if (!hostname.includes('.') && !hostname.includes(':')) {
        return false;
    }

    try {
        const addresses = hostname.includes(':')
            ? [{ address: hostname, family: 6 }]
            : /^[\d.]+$/.test(hostname)
                ? [{ address: hostname, family: 4 }]
                : await lookup(hostname, { all: true });

        if (!addresses.length) {
            return false;
        }

        return !addresses.some(isPrivateAddress);
    } catch {
        return false;
    }
}

app.get('/', (req, res) => {
    res.send('Hello from the check-url-service.');
});

app.post('/check', async (req, res) => {
    const urlInput = req.body?.url;

    if (!urlInput) {
        return res.status(400).json({
            error: 'URL is required'
        });
    }

    if (typeof urlInput !== 'string' || !urlInput.trim()) {
        return res.status(400).json({
            error: 'A valid URL is required'
        });
    }

    let parsedUrl;

    try {
        parsedUrl = new URL(urlInput);
    } catch {
        return res.status(400).json({
            error: 'Invalid URL'
        });
    }

    if (parsedUrl.username || parsedUrl.password) {
        return res.status(400).json({
            error: 'URLs containing credentials are not supported'
        });
    }

    const allowHttp = process.env.VALIDATE_URL_ALLOW_HTTP === 'true';

    if (
        parsedUrl.protocol !== 'https:' &&
        !(allowHttp && parsedUrl.protocol === 'http:')
    ) {
        return res.status(400).json({
            error: 'Unsupported URL protocol'
        });
    }

    const isPublic = await validatePublicUrl(parsedUrl);

    if (!isPublic) {
        return res.status(400).json({
            error: 'URLs pointing to private or internal hosts are not supported'
        });
    }

    try {
        const response = await fetch(parsedUrl, {
            redirect: req.body?.follow === true ? 'follow' : 'manual',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });

        await response.body?.cancel();

        return res.json({
            url: response.url || parsedUrl.href,
            status: response.ok,
            statusCode: response.status
        });
    } catch (error) {
        console.error(`Link check failed for ${parsedUrl.href}:`, error);

        return res.status(502).json({
            error: 'Unable to check the URL'
        });
    }
});