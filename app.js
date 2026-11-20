import { app, query, sparqlEscapeUri } from 'mu';
import bodyParser from 'body-parser';
import { Agent } from 'undici';
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const REQUIRE_AUTHENTICATION = process.env.REQUIRE_AUTHENTICATION !== 'false';
const USER_AGENT =
    process.env.VALIDATE_URL_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/74.0.3729.169 Safari/537.36 LBLOD check url service';
const SESSION_GRAPH = 'http://mu.semte.ch/graphs/sessions';
const USE_SUDO = process.env.ALLOW_MU_AUTH_SUDO === 'true';

app.use(bodyParser.json());

// A session is logged in when it has an account. One ASK answers that.
async function checkSessionIsLoggedIn(sessionId) {
    const result = await query(`
        PREFIX session: <http://mu.semte.ch/vocabularies/session/>
        ASK {
            GRAPH ${sparqlEscapeUri(SESSION_GRAPH)} {
                ${sparqlEscapeUri(sessionId)} session:account ?account .
            }
        }`, { sudo: USE_SUDO });

    return result?.boolean === true;
}

app.use('/check', async (req, res, next) => {
    if (!REQUIRE_AUTHENTICATION) {
        return next();
    }

    const sessionId = req.get('mu-session-id');

    if (!sessionId) {
        return res.status(401).json({
            error: 'Authentication required'
        });
    }

    try {
        const isLoggedIn = await checkSessionIsLoggedIn(sessionId);

        if (!isLoggedIn) {
            return res.status(401).json({
                error: 'Invalid session'
            });
        }

        return next();
    } catch (error) {
        console.error('Failed to validate session:', error);

        return res.status(503).json({
            error: 'Unable to validate session'
        });
    }
});

const NON_PUBLIC_SUBNETS = [
    ['0.0.0.0', 8, 'ipv4'], // this network
    ['10.0.0.0', 8, 'ipv4'], // private
    ['100.64.0.0', 10, 'ipv4'], // carrier-grade NAT
    ['127.0.0.0', 8, 'ipv4'], // loopback
    ['169.254.0.0', 16, 'ipv4'], // link-local
    ['172.16.0.0', 12, 'ipv4'], // private
    ['192.0.0.0', 24, 'ipv4'], // IETF protocol assignments
    ['192.0.2.0', 24, 'ipv4'], // documentation
    ['192.168.0.0', 16, 'ipv4'], // private
    ['198.18.0.0', 15, 'ipv4'], // benchmarking
    ['198.51.100.0', 24, 'ipv4'], // documentation
    ['203.0.113.0', 24, 'ipv4'], // documentation
    ['224.0.0.0', 3, 'ipv4'], // multicast and reserved
    ['::', 96, 'ipv6'], // IPv4-compatible
    ['::ffff:0:0:0', 96, 'ipv6'], // IPv4-translated
    ['64:ff9b::', 96, 'ipv6'], // NAT64
    ['64:ff9b:1::', 48, 'ipv6'], // local NAT64
    ['100::', 64, 'ipv6'], // discard
    ['2001::', 32, 'ipv6'], // Teredo
    ['2001:db8::', 32, 'ipv6'], // documentation
    ['2002::', 16, 'ipv6'], // 6to4
    ['fc00::', 7, 'ipv6'], // unique local
    ['fe80::', 10, 'ipv6'], // link-local
    ['fec0::', 10, 'ipv6'], // site-local
    ['ff00::', 8, 'ipv6'] // multicast
];

const nonPublicAddresses = new BlockList();

for (const [network, prefix, family] of NON_PUBLIC_SUBNETS) {
    nonPublicAddresses.addSubnet(network, prefix, family);
}

function isPrivateAddress({ address, family }) {
    return nonPublicAddresses.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

// Tag an error with a reason so the route can pick the right answer.
function createCheckError(reason, message) {
    return Object.assign(new Error(message), { reason });
}

function assertAllowedUrl(parsedUrl) {
    if (parsedUrl.username || parsedUrl.password) {
        throw new Error('URLs containing credentials are not supported');
    }

    const allowHttp = process.env.VALIDATE_URL_ALLOW_HTTP === 'true';

    if (
        parsedUrl.protocol !== 'https:' &&
        !(allowHttp && parsedUrl.protocol === 'http:')
    ) {
        throw new Error('Unsupported URL protocol');
    }
}

// Stop a promise when the request signal aborts.
function stopOnAbort(promise, signal) {
    if (signal.aborted) {
        return Promise.reject(signal.reason);
    }

    return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason);

        signal.addEventListener('abort', onAbort, { once: true });
        promise
            .then(resolve, reject)
            .finally(() => signal.removeEventListener('abort', onAbort));
    });
}

async function resolvePublicAddresses(hostname, signal) {
    const family = isIP(hostname);

    const addresses = family
        ? [{ address: hostname, family }]
        : await stopOnAbort(dnsLookup(hostname, { all: true, verbatim: true }), signal);

    if (!addresses.length || addresses.some(isPrivateAddress)) {
        throw createCheckError('blocked', 'The link must point to a public host');
    }

    return addresses;
}

function createPinnedAgent(hostname, addresses) {
    const normalizedHostname = hostname.toLowerCase();

    const pinnedLookup = (requestedHostname, options, callback) => {
        if (requestedHostname.toLowerCase() !== normalizedHostname) {
            return callback(new Error('Unexpected hostname'));
        }

        let candidates = addresses;

        if (options.family) {
            candidates = candidates.filter(
                (entry) => entry.family === options.family
            );
        }

        if (!candidates.length) {
            return callback(new Error('No validated address available'));
        }

        if (options.all) {
            return callback(null, candidates);
        }

        const selected = candidates[0];

        return callback(
            null,
            selected.address,
            selected.family
        );
    };

    return new Agent({
        connections: 1,
        pipelining: 0,
        connect: {
            lookup: pinnedLookup
        }
    });
}

// Map a transport error to the reason we report for a dead target.
function findFailureReason(error) {
    if (error?.reason) {
        return error.reason;
    }

    if (error?.name === 'TimeoutError') {
        return 'timeout';
    }

    const code = String(error?.code ?? error?.cause?.code ?? '');

    if (code === 'ERR_INVALID_URL') {
        return 'redirect';
    }

    if (code === 'ENOTFOUND' || code === 'ENODATA' || code.startsWith('EAI_')) {
        return 'dns';
    }

    if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
        return 'timeout';
    }

    if (
        code.includes('CERT') ||
        code.startsWith('ERR_TLS') ||
        code.startsWith('ERR_SSL') ||
        code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
    ) {
        return 'tls';
    }

    if (error?.message === 'fetch failed') {
        return 'connect';
    }

    return null;
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

    try {
        assertAllowedUrl(parsedUrl);
    } catch (error) {
        return res.status(400).json({
            error: error.message
        });
    }

    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let agent;
    let currentUrl = parsedUrl;

    try {
        let response;

        for (let redirects = 0; ; redirects += 1) {
            const hostname = currentUrl.hostname.replace(/^\[|\]$/g, '');
            let addresses;

            try {
                addresses = await resolvePublicAddresses(hostname, signal);
            } catch (error) {
                if (redirects === 0 && error.reason === 'blocked') {
                    return res.status(400).json({
                        error: error.message
                    });
                }

                throw error;
            }

            await agent?.close();
            agent = createPinnedAgent(hostname, addresses);

            response = await fetch(currentUrl, {
                dispatcher: agent,
                redirect: 'manual',
                signal,
                headers: {
                    'user-agent': USER_AGENT
                }
            });

            await response.body?.cancel();

            if (!REDIRECT_STATUSES.has(response.status)) {
                break;
            }

            if (redirects >= MAX_REDIRECTS) {
                throw createCheckError('redirect', 'Too many redirects');
            }

            const location = response.headers.get('location');

            if (!location) {
                break;
            }

            const nextUrl = new URL(location, currentUrl);

            if (currentUrl.protocol === 'https:' && nextUrl.protocol === 'http:') {
                throw createCheckError('blocked', 'Redirect from https to http');
            }

            currentUrl = nextUrl;

            try {
                assertAllowedUrl(currentUrl);
            } catch (error) {
                throw createCheckError('blocked', error.message);
            }
        }

        return res.json({
            url: response.url || currentUrl.href,
            status: response.ok,
            statusCode: response.status
        });
    } catch (error) {
        const reason = findFailureReason(error);

        console.error(`Link check failed for ${currentUrl.href} (${reason}):`, error);

        if (!reason) {
            return res.status(502).json({
                error: 'Unable to check the URL'
            });
        }

        return res.json({
            url: currentUrl.href,
            status: false,
            statusCode: null,
            reason
        });
    } finally {
        await agent?.close();
    }
});