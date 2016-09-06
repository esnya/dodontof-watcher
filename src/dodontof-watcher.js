const https = require('https');
const config = require('config');
const Twitter = require('twitter');
const git = require('nodegit');
const path = require('path');
const promisify = require('promisify-node');
const fse = promisify(require('fs-extra'));

fse.ensureDir = promisify(fse.ensureDir);

function handleError(callback) {
    return function handler(error) {
        if (error) {
            throw new Error(JSON.stringify(error));
        }

        const args = Array.prototype.slice.call(arguments, 1);

        return callback.apply(this, args);
    }
}

function handle() {
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
                const release = releases[0];

                git.Clone(config.get('git.cloneURL'), `/tmp/dw-${release.version}`)
                    .then(repo => {
                        const versionCache = path.join(repo.workdir(), 'VERSION');
                        const template = path.join(repo.workdir(), 'Dockerfile.template');
                        const dockerfile = path.join(repo.workdir(), 'Dockerfile');
                
                        return fse.readFile(versionCache, 'utf8')
                            .catch(() => null)
                            .then(data => (
                                data !== release.version ? Promise.resolve() : Promise.reject(new Error('Already Updated'))
                            ))
                            .then(() => fse.readFile(template, 'utf8'))
                            .then(data => data.replace('<DODONTOF_VERSION>', release.version))
                            .then(data => fse.outputFile(dockerfile, data, 'utf8'))
                            .then(() => fse.outputFile(versionCache, release.version))
                            .then(() => repo.refreshIndex())
                            .then(index =>
                                Promise.all([
                                    index.addByPath('Dockerfile'),
                                    index.addByPath('VERSION'),
                                ])
                                    .then(() => index.write())
                                    .then(() => index.writeTree())
                                    .then(oid =>
                                        git.Reference.nameToId(repo, 'HEAD')
                                            .then(head => repo.getCommit(head))
                                            .then(parent => {
                                                const author = git.Signature.create.apply(
                                                    git.Signature,
                                                    config.get('git.author')
                                                );
                                                const comitter = git.Signature.create.apply(
                                                    git.Signature,
                                                    config.get('git.comitter')
                                                );

                                                return repo.createCommit('HEAD', author, comitter, release.version, oid, [parent]);
                                            })
                                    )
                            )
                            .then(() => git.Remote.create(repo, 'origin-push', config.get('git.pushURL')))
                            .then(remote => remote.push(
                                ['refs/heads/master:refs/heads/master'],
                                {
                                    callbacks: {
                                        credentials: (url, userName) => git.Cred.sshKeyNew(
                                            userName,
                                            path.join(__dirname, '../config/id_rsa.pub'),
                                            path.join(__dirname, '../config/id_rsa'),
                                            ''),
                                    },
                                }
                            ));
                    })
                    .catch(e => {
                        console.error(e);
                    });
            }));
        });
    });

    req.write('grant_type=client_credentials');
    req.end();
}

module.exports.handle = handle;
