'use strict';
const fs = require('fs');
const config = require('config');
const uuid = require('uuid');
const obfuscate = require('./obfuscator');
const os = require('os');
const child_process = require('child_process');

const WebSocketServer = require('ws').Server;

const maxmind = require('maxmind');
const cityLookup = maxmind.open('./GeoLite2-City.mmdb');

const Database = require('./database')({
    firehose: config.get('firehose'),
});

const s3Config = {
    region: process.env.AWS_REGION,
    bucket: process.env.STORAGE_BUCKET
};

const Store = require('./store')({
  s3: s3Config
});

let server;
const tempPath = 'temp';

function calcStoreKey(clientid, data) {
    const lines = data.split('\n');
    const identifyLine = lines.find( line => {
        try {
            const data = JSON.parse(line);
            return data[0] === "identify";
        } catch (error) {
            //Line wasn't json...
            return false;
        }
    });

    //if there's identify information we use it
    //otherwise we just use the clientid
    if (identifyLine) {
        console.log("Found an identify line: %s", identifyLine);
        const identify = JSON.parse(identifyLine);
        const identifyData = identify[2];
        const callId = identifyData["call_id"];

        return (callId === undefined) ? clientid : callId;
    } else {
        console.log("No identify found using client id: %s", clientid);
        return clientid;
    }
}

class ProcessQueue {
    constructor() {
        this.maxProc = os.cpus().length;
        this.q = [];
        this.numProc = 0;
    }
    enqueue(clientid) {
        this.q.push(clientid);
        if (this.numProc < this.maxProc) {
            process.nextTick(this.process.bind(this));
        } else {
            console.log('process Q too long:', this.numProc);
        }
    }
    process() {
        const clientid = this.q.shift();
        if (!clientid) return;
        const p = child_process.fork('extract.js', [clientid]);
        p.on('exit', () => {
            this.numProc--;
            console.log('done', clientid, this.numProc);
            if (this.numProc < 0) this.numProc = 0;
            if (this.numProc < this.maxProc) process.nextTick(this.process.bind(this));
            fs.readFile(tempPath + '/' + clientid, {encoding: 'utf-8'}, (err, data) => {
                if (err) {
                    console.error('Could not open file for store upload', err);
                    return;
                }
                // remove the file
                fs.unlink(tempPath + '/' + clientid, () => {
                    // we're good...
                });

                const key = calcStoreKey(clientid, data);
                Store.put(key, data);
            });
        });
        p.on('message', (msg) => {
            const {url, clientid, connid, clientFeatures, connectionFeatures} = msg;
            Database.put(url, clientid, connid, clientFeatures, connectionFeatures);
        });
        p.on('error', () => {
            this.numProc--;
            console.log('failed to spawn, rescheduling', clientid, this.numProc);
            this.q.push(clientid); // do not immediately retry
        });
        this.numProc++;
        console.log('process Q:', this.numProc);
    }
}
var q = new ProcessQueue();

function setupWorkDirectory() {
    try {
        if (fs.existsSync(tempPath)) {
            fs.readdirSync(tempPath).forEach(fname => {
                try {
                    console.log('Removing file ' + tempPath + '/' + fname);
                    fs.unlinkSync(tempPath + '/' + fname);
                } catch (e) {
                    console.error('Error while unlinking file ' + fname + ' - ' + e.message);
                }
            });
        } else {
            console.log('Creating working dir ' + tempPath);
            fs.mkdirSync(tempPath);
        }
    } catch (e) {
        console.error('Error while accessing working dir ' + tempPath + ' - ' + e.message);
    }
}

function run(keys) {
    setupWorkDirectory();

    if (keys === undefined) {
      server = require('http').Server(() => { });
    } else {
      server = require('https').Server({
          key: keys.serviceKey,
          cert: keys.certificate,
      }, () => { });
    }

    const port = process.env.PORT;
    console.log("Starting on port %s, bucket is: %s", port, s3Config.bucket);

    server.listen(port);
    server.on('request', (request, response) => {
        // look at request.url
        switch (request.url) {
        case "/healthcheck":
            response.writeHead(200);
            response.end();
            return;
        default:
            response.writeHead(404);
            response.end();
        }
    });

    const wss = new WebSocketServer({ server: server });
    wss.on('connection', (client, upgradeReq) => {
        let numberOfEvents = 0;
        // the url the client is coming from
        const referer = upgradeReq.headers['origin'] + upgradeReq.url;
        // TODO: check against known/valid urls

        const ua = upgradeReq.headers['user-agent'];
        const clientid = uuid.v4();
        let peerConnectionId = null;
        let locationData = null;

        let tempStream = null;

        const meta = {
            path: upgradeReq.url,
            origin: upgradeReq.headers['origin'],
            url: referer,
            userAgent: ua,
            time: Date.now()
        };

        const forwardedFor = upgradeReq.headers['x-forwarded-for'];
        if (forwardedFor) {
            process.nextTick(() => {
                const city = cityLookup.get(forwardedFor);
                locationData = {
                    0: 'location',
                    1: null,
                    2: city,
                    time: Date.now()
                };
            });
        }

        console.log('New connection from', ua, referer, clientid);

        client.on('message', msg => {
            const data = JSON.parse(msg);

            if (!tempStream || (data[0] === 'create' && data[1] !== peerConnectionId)) {
                //close existing stream
                if (tempStream) {
                    tempStream.end();
                }

                console.log("Creating a new file no filestream or new peer connection detected: " + peerConnectionId);

                peerConnectionId = data[1];
                //create a temp file if this is a new peer connection
                tempStream = fs.createWriteStream(tempPath + '/' + clientid + '-' + peerConnectionId);
                numberOfEvents = 0;

                tempStream.on('finish', () => {
                    if (numberOfEvents > 0) {
                        console.log("Enqueuing processing of " + clientid + '-' + peerConnectionId);
                        q.enqueue(clientid + '-' + peerConnectionId);
                    } else {
                        console.log("No events NOT enqueuing processing of " + clientid + '-' + peerConnectionId);
                        fs.unlink(tempPath + '/' + clientid + '-' + peerConnectionId, () => {
                            // we're good...
                        });
                    }
                });

                tempStream.write(JSON.stringify(meta) + '\n');

                if (locationData) {
                    tempStream.write(JSON.stringify(locationData) + '\n'
                    );
                }
            }

            numberOfEvents++;

            switch(data[0]) {
            case 'getUserMedia':
            case 'getUserMediaOnSuccess':
            case 'getUserMediaOnFailure':
            case 'navigator.mediaDevices.getUserMedia':
            case 'navigator.mediaDevices.getUserMediaOnSuccess':
            case 'navigator.mediaDevices.getUserMediaOnFailure':
                data.time = Date.now();
                tempStream.write(JSON.stringify(data) + '\n');
                break;
            default:
                obfuscate(data);
                data.time = Date.now();
                tempStream.write(JSON.stringify(data) + '\n');
                break;
            }
        });

        client.on('close', () => {
            if (tempStream) {
                tempStream.end();
            }
            tempStream = null;
        });
    });
}

function stop() {
    if (server) {
        server.close();
    }
}

run();

module.exports = {
    stop: stop
};
