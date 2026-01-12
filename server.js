"use strict";

const ws = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const DOMAIN = 'tudominio.com'; // <--- TU DOMINIO
const AUTH_TOKEN = 'token-secreto-123';

const clients = new Map(); // subdomain -> socket
const pendingRequests = new Map();

async function startServer() {
    // 1. Inicializar Base de Datos
    const db = await open({ filename: './tunnels.db', driver: sqlite3.Database });
    await db.exec(`CREATE TABLE IF NOT EXISTS tunnels (subdomain TEXT PRIMARY KEY, clientId TEXT)`);

    // 2. Servidor de Túneles (WebSocket seguro)
    // Escucha en un puerto aparte para el control
    const wss = new ws.Server({ port: 8080 });

    wss.on('connection', (socket) => {
        socket.on('message', async (data) => {
            const msg = JSON.parse(data);

            if (msg.type === 'auth') {
                if (msg.token !== AUTH_TOKEN) return socket.close();
                
                let row = await db.get('SELECT subdomain FROM tunnels WHERE clientId = ?', [msg.clientId]);
                const subdomain = row ? row.subdomain : uuidv4().split('-')[0];

                if (!row) await db.run('INSERT INTO tunnels VALUES (?, ?)', [subdomain, msg.clientId]);

                clients.set(subdomain, socket);
                socket.subdomain = subdomain;
                socket.send(JSON.stringify({ type: 'init', url: `https://${subdomain}.${DOMAIN}` }));
                console.log(`🚀 Túnel HTTPS Activo: ${subdomain}.${DOMAIN}`);
            }

            if (msg.type === 'response') {
                const res = pendingRequests.get(msg.id);
                if (res) {
                    res.writeHead(msg.status, msg.headers);
                    res.end(Buffer.from(msg.body, 'base64'));
                    pendingRequests.delete(msg.id);
                }
            }
        });

        socket.on('close', () => clients.delete(socket.subdomain));
    });

    // 3. Servidor Web con SSL Automático
    require("greenlock-express").init({
        packageRoot: __dirname,
        configDir: "./greenlock.d",
        maintainerEmail: "tu-email@gmail.com", // <--- TU EMAIL
        cluster: false
    }).serve(function(req, res) {
        // Esta función maneja TODAS las peticiones HTTPS que lleguen
        const host = req.headers.host || '';
        const subdomain = host.split('.')[0];
        const localClient = clients.get(subdomain);

        if (!localClient) {
            res.writeHead(404);
            return res.end("Túnel desconectado.");
        }

        const requestId = uuidv4();
        pendingRequests.set(requestId, res);

        let body = [];
        req.on('data', chunk => body.push(chunk));
        req.on('end', () => {
            localClient.send(JSON.stringify({
                type: 'request',
                id: requestId,
                method: req.method,
                url: req.url,
                headers: req.headers,
                body: Buffer.concat(body).toString('base64')
            }));
        });
    });
}

startServer();
