const https = require('https');
const config = require('config');
const Twitter = require('twitter');

function handleError(callback) {
    return function handler(error) {
        if (error) {
            throw new Error(JSON.stringify(error));
        }

        const args = Array.prototype.slice.call(arguments, 1);

        return callback.apply(this, args);
    }
}

function getToken() {
    const credential = new Buffer(
        [
            'twitter.consumer_key',
            'twitter.consumer_secret',
        ]
        .map(key => config.get(key))
        .map(encodeURIComponent)
        .join(':')
    ).toString('base64');

    const req = https.request({
        hostname: 'api.twitter.com',
        port: 443,
        path: '/oauth2/token',
        method: 'POST',
        headers: {
            Authorization: `Basic ${credential}`,
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
    }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
            const text = Buffer.concat(chunks);
            if (res.statusCode !== 200) {
                throw new Error(text.toString());
            }

            const data = JSON.parse(text);
            const client = new Twitter(Object.assign({
                bearer_token: data.access_token,
            }, config.get('twitter')));

            client.get('search/tweets', {
                q: config.get('search.query'),
            }, handleError(res => {
                const releases = res.statuses
                    .map(tweet => Object.assign({
                        version: tweet.text.match(/Ver\.[0-9]+\.[0-9]+\.[0-9]+/),
                    }, tweet))
                    .filter(tweet => tweet.version)
                    .map(tweet => ({
                        text: tweet.text,
                        id: tweet.id,
                        created_at: tweet.created_at,
                        version: tweet.version[0],
                        url: `http://www.dodontof.com/DodontoF/DodontoF_${tweet.version[0]}.zip`
                    }));
                console.dir(releases);
            }));
        });
    });

    req.write('grant_type=client_credentials');
    req.end();
}

getToken();


