import { app } from 'mu';
import linkCheck from 'link-check';
import bodyParser from 'body-parser';

app.use(bodyParser.json());

app.post('/check', async function( req, res ) {
    const { url } = req.body;

    if (!url) {
    return res.status(400).json({
        error: 'URL is required',
    });
    }

    try {
    const result = await new Promise((resolve, reject) => {
        linkCheck(url, { timeout: '1s' }, (error, result) => {
            if (error) {
                reject(error);
            } else {
                resolve(result);
            }
        });
    });

    res.json({
        url: result.link,
        status: result.status,
        statusCode: result.statusCode,
    });
    } catch (error) {
        res.status(500).json({
            error: 'Unable to check the link ' + url,
        });
    }
});