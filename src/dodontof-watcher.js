const https = require('https');
const config = require('config');
const Twitter = require('twitter');
const path = require('path');
const promisify = require('promisify-node');
const fse = promisify(require('fs-extra'));
const git = require('nodegit');

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

function genCredential(url, userName) {
    return git.Cred.sshKeyNew(
        userName,
        path.join(__dirname, '../config/id_rsa.pub'),
        path.join(__dirname, '../config/id_rsa'),
        ''
    );
}

function clone(version) {
    console.log('clone');

    return git.Clone(
        config.get('git.cloneURL'),
        `/tmp/dw-${version}`,
        {
            fetchOpts: {
                callbacks: {
                    certificateCheck: () => 1,
                    credentials: genCredential,
                },
            },
        }
    );
}

function update(repo, version) {
    console.log('update');
    const versionCache = path.join(repo.workdir(), 'VERSION');
    const template = path.join(repo.workdir(), 'Dockerfile.template');
    const dockerfile = path.join(repo.workdir(), 'Dockerfile');

    return fse.readFile(versionCache, 'utf8')
        .catch(() => null)
        .then(data => (
            data !== version ? Promise.resolve() : Promise.reject(new Error('Already Updated'))
        ))
        .then(() => fse.readFile(template, 'utf8'))
        .then(data => data.replace('<DODONTOF_VERSION>', version))
        .then(data => fse.outputFile(dockerfile, data, 'utf8'))
        .then(() => fse.outputFile(versionCache, version, 'utf8'));
}

function commit(repo, version) {
    console.log('commit');

    return repo.openIndex().then(index => {
        index.read(1);
        index.addByPath('Dockerfile');
        index.addByPath('VERSION');

        return index.writeTree();
    }).then(oid =>
        git.Reference.nameToId(repo, 'HEAD')
            .then(head => repo.getCommit(head))
            .then(parent => {
                const author = git.Signature.now(
                    config.get('git.author.name'),
                    config.get('git.author.email')
                );
                const comitter = git.Signature.now(
                    config.get('git.comitter.name'),
                    config.get('git.comitter.email')
                );

                return repo.createCommit('HEAD', author, comitter, version, oid, [parent]);
            })
    );
}

function push(repo) {
    console.log('push');

    return Promise.resolve(git.Remote.create(repo, 'origin-push', config.get('git.pushURL')))
        .then(remote =>
            remote.push(
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
            )
        );
}

function handler() {
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

                clone(release.version)
                    .then(repo =>
                        update(repo, release.version)
                            .then(() => commit(repo, release.version))
                            .then(() => push(repo))
                    )
                    .catch(e => {
                        console.error(e.stack);
                        process.exit(-1);
                    });
            }));
        });
    });

    req.write('grant_type=client_credentials');
    req.end();
}

module.exports.handler = handler;
