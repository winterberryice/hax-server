import http from 'http';
import fs from 'fs';
import url from 'url';
import { start, stop, getRoomState } from './haxball.mjs';

const PORT = process.env.PORT || 8080;

const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (pathname === '/') {
        fs.readFile('admin.html', (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading admin.html');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else if (pathname === '/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getRoomState()));
    } else if (pathname === '/start' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', async () => {
            try {
                const { token } = JSON.parse(body);
                await start(token);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: "Room starting process initiated." }));
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: "Failed to start room.", error: error.message }));
            }
        });
    } else if (pathname === '/stop' && req.method === 'POST') {
        try {
            await stop();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: "Room stopping process initiated." }));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: "Failed to stop room.", error: error.message }));
        }
    } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: "Not Found" }));
    }
});

server.listen(PORT, () => {
    console.log(`Admin server running on http://localhost:${PORT}`);
});
