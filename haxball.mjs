import { chromium } from "playwright";
import { HaxballStatsTracker } from "./stats/index.mjs";

// The WebSocket endpoint for the existing Playwright server.
const wsPath = process.env.WS_PATH;

let state = {
    status: 'stopped', // Can be: stopped, starting, running, stopping, error
    status_message: 'Room is stopped.',
    room_url: null,
    browser: null,
    page: null,
    statsTracker: null,
};

let onStateUpdate = () => {}; // Placeholder for the callback

export function setStateUpdateCallback(callback) {
    if (typeof callback === 'function') {
        onStateUpdate = callback;
    }
}

function updateState(newState) {
    state = { ...state, ...newState };
    console.log(`[State Update] => ${state.status_message}`);
    onStateUpdate();
}

export function getRoomState() {
    return {
        status: state.status,
        status_message: state.status_message,
        room_url: state.room_url,
    };
}

async function initializeRoom(token = null) {
    if (!state.page) return;

    await state.page.exposeFunction("onRoomLinkSet", (url) => {
        console.log("==================================================");
        console.log(`🎉 Haxball Room URL: ${url}`);
        console.log("==================================================");
        updateState({ room_url: url, status: 'running', status_message: 'Room is running successfully!' });
    });

    updateState({ status_message: 'Initializing Haxball room...' });

    const roomConfig = {
        roomName: "Jules's Awesome Haxball Room",
        maxPlayers: 12,
        public: false,
        noPlayer: true,
        token: token, // Pass the token here
    };

    await state.page.evaluate((config) => {
        const room = window.HBInit(config);
        room.setDefaultStadium("Rounded");
        room.setScoreLimit(0);
        room.setTimeLimit(3);
        room.onRoomLink = (url) => window.onRoomLinkSet(url);

        // Stats tracking state
        const ASSIST_TIME_WINDOW = 3000; // 3 seconds
        let gameState = {
            isGameRunning: false,
            lastTouches: [], // { playerId, playerAuth, playerName, playerTeam, timestamp }
        };

        // Admin management logic
        function updateAdmins() {
            const players = room.getPlayerList();
            if (players.length > 0 && !players.some(p => p.admin)) {
                room.setPlayerAdmin(players[0].id, true);
            }
        }

        // Player join
        room.onPlayerJoin = (player) => {
            updateAdmins();
            if (window.statsOnPlayerJoin) {
                window.statsOnPlayerJoin(player.auth, player.name);
            }
        };

        // Player leave
        room.onPlayerLeave = (player) => {
            updateAdmins();
            if (window.statsOnPlayerLeave) {
                window.statsOnPlayerLeave(player.auth);
            }
        };

        // Game start
        room.onGameStart = (byPlayer) => {
            gameState.isGameRunning = true;
            gameState.lastTouches = [];

            const players = room.getPlayerList().filter(p => p.team !== 0).map(p => ({
                auth: p.auth,
                name: p.name,
                team: p.team,
            }));

            if (window.statsOnGameStart) {
                window.statsOnGameStart(players);
            }
        };

        // Game stop
        room.onGameStop = (byPlayer) => {
            if (!gameState.isGameRunning) return;
            gameState.isGameRunning = false;

            const scores = room.getScores();
            const allPlayers = room.getPlayerList();

            const redPlayers = allPlayers.filter(p => p.team === 1).map(p => ({
                auth: p.auth,
                name: p.name,
            }));

            const bluePlayers = allPlayers.filter(p => p.team === 2).map(p => ({
                auth: p.auth,
                name: p.name,
            }));

            if (window.statsOnGameStop) {
                window.statsOnGameStop({
                    scoreRed: scores.red,
                    scoreBlue: scores.blue,
                    redPlayers,
                    bluePlayers,
                });
            }
        };

        // Team goal
        room.onTeamGoal = (team) => {
            // Find scorer (last player who touched the ball)
            let scorer = null;
            let assister = null;

            if (gameState.lastTouches.length > 0) {
                const lastTouch = gameState.lastTouches[gameState.lastTouches.length - 1];
                scorer = {
                    auth: lastTouch.playerAuth,
                    name: lastTouch.playerName,
                    team: lastTouch.playerTeam,
                };

                // Find assister (second-to-last touch within time window)
                if (gameState.lastTouches.length > 1) {
                    const now = Date.now();
                    const secondLastTouch = gameState.lastTouches[gameState.lastTouches.length - 2];

                    const timeDiff = now - secondLastTouch.timestamp;
                    const isSamePlayer = secondLastTouch.playerId === lastTouch.playerId;
                    const isSameTeam = secondLastTouch.playerTeam === lastTouch.playerTeam;

                    if (timeDiff <= ASSIST_TIME_WINDOW && !isSamePlayer && isSameTeam) {
                        assister = {
                            auth: secondLastTouch.playerAuth,
                            name: secondLastTouch.playerName,
                            isSelf: false,
                        };
                    }
                }
            }

            if (window.statsOnTeamGoal) {
                window.statsOnTeamGoal(team, scorer, assister);
            }
        };

        // Game tick - track ball touches
        room.onGameTick = () => {
            if (!gameState.isGameRunning) return;

            const ballPosition = room.getBallPosition();
            const players = room.getPlayerList();

            for (const player of players) {
                if (player.team === 0) continue; // Skip spectators

                const playerDisc = room.getPlayerDiscProperties(player.id);
                if (!playerDisc) continue;

                // Calculate distance between player and ball
                const dx = playerDisc.x - ballPosition.x;
                const dy = playerDisc.y - ballPosition.y;
                const distance = Math.sqrt(dx * dx + dy * dy);

                // If player is touching the ball (within radius)
                const touchRadius = 15 + 10; // player radius + ball radius (approximate)
                if (distance < touchRadius) {
                    const lastTouch = gameState.lastTouches[gameState.lastTouches.length - 1];

                    // Only record if it's a different player or enough time has passed
                    if (!lastTouch || lastTouch.playerId !== player.id || Date.now() - lastTouch.timestamp > 100) {
                        gameState.lastTouches.push({
                            playerId: player.id,
                            playerAuth: player.auth,
                            playerName: player.name,
                            playerTeam: player.team,
                            timestamp: Date.now(),
                        });

                        // Keep only last 5 touches
                        if (gameState.lastTouches.length > 5) {
                            gameState.lastTouches.shift();
                        }
                    }
                    break; // Only one player can touch at a time
                }
            }
        };

        // Player chat - handle commands
        room.onPlayerChat = (player, message) => {
            if (!message.startsWith('!')) return true;

            if (window.statsOnPlayerChat) {
                // Call async and handle response
                Promise.resolve(window.statsOnPlayerChat(player.auth, message))
                    .then(msg => {
                        if (msg) {
                            room.sendAnnouncement(msg, null, 0xFFFFFF, "normal", 1);
                        }
                    })
                    .catch(err => {
                        console.error('Error handling chat command:', err);
                    });
                return false; // Prevent message from showing in chat
            }

            return true;
        };
    }, roomConfig);

    updateState({ status_message: 'Room script executed. Waiting for room link...' });
}

export async function start(token) {
    if (!token) {
        throw new Error('A reCAPTCHA token is required to start the room.');
    }
    if (state.status !== 'stopped') {
        throw new Error(`Cannot start room when status is ${state.status}.`);
    }

    if (!wsPath) {
        const errorMsg = "FATAL: The WS_PATH environment variable is not set.";
        updateState({ status: 'error', status_message: errorMsg });
        throw new Error(errorMsg);
    }

    updateState({ status: 'starting', status_message: 'Connecting to Playwright server...' });

    try {
        const browser = await chromium.connect(wsPath, { timeout: 20000 });
        updateState({ browser, status_message: 'Connected to Playwright. Opening new page...' });

        const context = await browser.newContext();
        const page = await context.newPage();
        updateState({ page, status_message: 'Navigating to Haxball headless URL...' });

        page.on('close', () => stop('Page was closed.'));
        page.on("console", (msg) => console.log(`[Browser]: ${msg.text()}`));

        await page.goto("https://html5.haxball.com/headless", { timeout: 30000 });
        updateState({ status_message: 'Waiting for Haxball to load...' });

        await page.waitForFunction(() => window.HBInit, null, { timeout: 30000 });

        // Initialize stats tracker
        updateState({ status_message: 'Initializing stats tracker...' });
        const statsTracker = new HaxballStatsTracker(page, './stats.db');
        await statsTracker.initialize();
        updateState({ statsTracker });

        await initializeRoom(token);

    } catch (error) {
        console.error("❌ An error occurred during startup:", error);
        await stop(`Error during startup: ${error.message}`);
        throw error; // Re-throw to inform the caller
    }
}

export async function stop(reason = 'Room stopped by admin.') {
    if (state.status === 'stopped') return;

    updateState({ status: 'stopping', status_message: `Stopping room: ${reason}` });

    // Close stats tracker
    if (state.statsTracker) {
        try {
            state.statsTracker.close();
        } catch (e) {
            console.error("Ignoring error while closing stats tracker:", e.message);
        }
    }

    if (state.page && !state.page.isClosed()) {
        try {
            await state.page.close();
        } catch (e) {
            console.error("Ignoring error while closing page:", e.message);
        }
    }

    // We connected to an existing browser server, so we should not close the browser itself.
    // We just disconnect from it.
    if (state.browser && state.browser.isConnected()) {
        try {
            await state.browser.disconnect();
        } catch (e) {
            console.error("Ignoring error while disconnecting browser:", e.message);
        }
    }

    // Reset state
    updateState({
        status: 'stopped',
        status_message: reason,
        room_url: null,
        browser: null,
        page: null,
        statsTracker: null,
    });
}
