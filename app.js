import { app } from 'mu';
import linkCheck from 'link-check';
import bodyParser from 'body-parser';

app.use(bodyParser.json());

app.get('/', (req, res) => {
    res.send("Hello from the check-url-service.");
});

app.post('/check', async function( req, res ) {
    const urlInput = req.body?.url;

    if (!urlInput) {
        return res.status(400).json({
            error: 'URL is required',
        });
    }

    if (typeof urlInput !== 'string' || !urlInput.trim()) {
        return res.status(400).json({
            error: 'A valid URL is required',
        });
    }

    let parsedUrl;

    try {
        parsedUrl = new URL(urlInput);
    } catch {
        return res.status(400).json({
            error: 'Invalid URL',
        });
    }

    if (parsedUrl.username || parsedUrl.password) {
        return res.status(400).json({
            error: 'URLs containing credentials are not supported',
        });
    }

    try {
        const result = await new Promise((resolve, reject) => {
            linkCheck(parsedUrl.href, { timeout: '10s', retryOn429: false }, (error, result) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(result);
                }
            });
        });

        res.json({
            url: result.link,
            status: result.status === 'alive',
            statusCode: result.statusCode,
        });
    } catch (error) {
        console.error('Link check failed');
        res.status(502).json({
            error: 'Unable to check the URL',
        });
    }
});