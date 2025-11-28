import http from 'http';
import fs from 'fs';
import url from 'url';
import { start, stop, getRoomState, setStateUpdateCallback, getStatsTracker } from './haxball.mjs';

const PORT = process.env.PORT || 8080;

// Array to hold connected SSE clients
let clients = [];

// Function to send the current state to all connected clients
function sendStateToAllClients() {
    const currentState = getRoomState();
    const data = `data: ${JSON.stringify(currentState)}\n\n`;
    clients.forEach(client => client.res.write(data));
}

// Register the callback in the haxball module
setStateUpdateCallback(sendStateToAllClients);

const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // Unprotected route for joining the room
    if (pathname === '/join') {
        const { status, room_url } = getRoomState();
        if (status === 'running' && room_url) {
            res.writeHead(302, { 'Location': room_url });
            res.end();
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: "Room not available." }));
        }
        return;
    }

    // Simple Basic Authentication
    const { USERNAME, PASSWORD } = process.env;
    if (USERNAME && PASSWORD) {
        const authHeader = req.headers['authorization'];
        if (!authHeader || !authHeader.startsWith('Basic ')) {
            res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Restricted Area"' });
            res.end('Authentication required.');
            return;
        }

        const credentials = Buffer.from(authHeader.split(' ')[1], 'base64').toString();
        const [username, password] = credentials.split(':');

        if (username !== USERNAME || password !== PASSWORD) {
            res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Restricted Area"' });
            res.end('Invalid credentials.');
            return;
        }
    }

    // Standard headers for CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Pre-flight request
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
            } else {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(data);
            }
        });
    } else if (pathname === '/events') {
        // SSE endpoint
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });

        const clientId = Date.now();
        const newClient = { id: clientId, res };
        clients.push(newClient);
        console.log(`Client ${clientId} connected`);

        // Immediately send the current state to the new client
        res.write(`data: ${JSON.stringify(getRoomState())}\n\n`);

        req.on('close', () => {
            clients = clients.filter(c => c.id !== clientId);
            console.log(`Client ${clientId} disconnected`);
        });
    } else if (pathname === '/start' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const { token } = JSON.parse(body);
                await start(token);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: "Room start initiated." }));
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: `Failed to start room: ${error.message}` }));
            }
        });
    } else if (pathname === '/stop' && req.method === 'POST') {
        try {
            await stop();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: "Room stop initiated." }));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: `Failed to stop room: ${error.message}` }));
        }
    } else if (pathname === '/clear-stats' && req.method === 'POST') {
        try {
            const statsTracker = getStatsTracker();
            if (!statsTracker) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: "Stats tracker not initialized. Start the room first." }));
                return;
            }
            statsTracker.clearStats();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: "Statistics cleared successfully." }));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: `Failed to clear statistics: ${error.message}` }));
        }
    } else if (pathname === '/delete-test-players' && req.method === 'POST') {
        try {
            const statsTracker = getStatsTracker();
            if (!statsTracker) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: "Stats tracker not initialized. Start the room first." }));
                return;
            }
            const deletedCount = statsTracker.deleteTestPlayers();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: `Deleted ${deletedCount} test player(s) and their statistics.` }));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: `Failed to delete test players: ${error.message}` }));
        }
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
    console.log(`SSE endpoint at http://localhost:${PORT}/events`);
});
