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
            matchGoals: {}, // { auth: { name, team, goals, assists } }
            playerAuthMap: {}, // Map player.id -> { auth, name } (room.getPlayerList() doesn't include auth)
            finalScores: null, // Saved from onTeamVictory, null if draw/stopped early
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

            // Store player auth mapping (room.getPlayerList() doesn't include auth)
            if (player.auth) {
                gameState.playerAuthMap[player.id] = {
                    auth: player.auth,
                    name: player.name,
                };
            }

            // Only track players with valid auth (can be null if validation fails)
            if (window.statsOnPlayerJoin && player.auth) {
                window.statsOnPlayerJoin(player.auth, player.name);
            } else if (!player.auth) {
                console.log(`[Stats] Player joined without auth: ${player.name} (id: ${player.id})`);
            }
        };

        // Player leave
        room.onPlayerLeave = (player) => {
            updateAdmins();

            // Remove from auth mapping
            if (gameState.playerAuthMap[player.id]) {
                delete gameState.playerAuthMap[player.id];
            }

            if (window.statsOnPlayerLeave && player.auth) {
                window.statsOnPlayerLeave(player.auth);
            }
        };

        // Game start
        room.onGameStart = (byPlayer) => {
            gameState.isGameRunning = true;
            gameState.lastTouches = [];
            gameState.matchGoals = {};
            gameState.finalScores = null; // Reset final scores

            const allPlayers = room.getPlayerList();

            // Debug: Log all players and their state
            console.log(`[Stats] Game starting - Total players in room: ${allPlayers.length}`);
            allPlayers.forEach(p => {
                const authData = gameState.playerAuthMap[p.id];
                console.log(`  - Player: ${p.name}, Team: ${p.team}, HasAuth: ${!!authData}, ID: ${p.id}, Auth: ${authData?.auth || 'none'}`);
            });

            // Only include players with valid auth and in a team (use playerAuthMap)
            const players = allPlayers
                .filter(p => p.team !== 0 && gameState.playerAuthMap[p.id])
                .map(p => {
                    const authData = gameState.playerAuthMap[p.id];
                    return {
                        auth: authData.auth,
                        name: p.name,
                        team: p.team,
                    };
                });

            // Initialize match goals tracker
            players.forEach(p => {
                gameState.matchGoals[p.auth] = {
                    name: p.name,
                    team: p.team,
                    goals: 0,
                    assists: 0
                };
            });

            if (players.length === 0) {
                console.log('[Stats] WARNING: Match starting with 0 tracked players (all players lack auth or are spectators)');
            }

            // Announcement: Match started
            room.sendAnnouncement('🏁 MECZ ROZPOCZĘTY!', null, 0xFFFFFF, 'bold', 2);
            room.sendAnnouncement('🔴 Red vs Blue 🔵', null, 0xFFFFFF, 'normal', 1);

            if (window.statsOnGameStart) {
                window.statsOnGameStart(players);
            }
        };

        // Game stop
        room.onGameStop = (byPlayer) => {
            if (!gameState.isGameRunning) return;
            gameState.isGameRunning = false;

            // Use scores from onTeamVictory (getScores() returns null after game ends)
            // If no victory (draw/stopped early), try getScores() as fallback
            let scores = gameState.finalScores || room.getScores();

            if (!scores) {
                console.log('[Stats] Warning: No scores available in onGameStop (game stopped early or draw?)');
                return;
            }

            const allPlayers = room.getPlayerList();

            // Only include players with valid auth (use playerAuthMap)
            const redPlayers = allPlayers
                .filter(p => p.team === 1 && gameState.playerAuthMap[p.id])
                .map(p => {
                    const authData = gameState.playerAuthMap[p.id];
                    return {
                        auth: authData.auth,
                        name: p.name,
                    };
                });

            const bluePlayers = allPlayers
                .filter(p => p.team === 2 && gameState.playerAuthMap[p.id])
                .map(p => {
                    const authData = gameState.playerAuthMap[p.id];
                    return {
                        auth: authData.auth,
                        name: p.name,
                    };
                });

            // Announcement: Match ended
            room.sendAnnouncement('🏁 KONIEC MECZU!', null, 0xFFFFFF, 'bold', 2);
            room.sendAnnouncement(`🔴 Red ${scores.red} - ${scores.blue} Blue 🔵`, null, 0xFFFFFF, 'bold', 1);

            // Get top scorers from each team
            const redScorers = Object.values(gameState.matchGoals)
                .filter(p => p.team === 1 && p.goals > 0)
                .sort((a, b) => b.goals - a.goals);

            const blueScorers = Object.values(gameState.matchGoals)
                .filter(p => p.team === 2 && p.goals > 0)
                .sort((a, b) => b.goals - a.goals);

            // Display top scorers
            if (redScorers.length > 0 || blueScorers.length > 0) {
                room.sendAnnouncement('⚽ Top strzelcy:', null, 0xFFFFFF, 'normal', 1);

                if (redScorers.length > 0) {
                    const redText = redScorers.map(p => `${p.name} (${p.goals})`).join(', ');
                    room.sendAnnouncement(`  Red: ${redText}`, null, 0xFFFFFF, 'normal', 0);
                }

                if (blueScorers.length > 0) {
                    const blueText = blueScorers.map(p => `${p.name} (${p.goals})`).join(', ');
                    room.sendAnnouncement(`  Blue: ${blueText}`, null, 0xFFFFFF, 'normal', 0);
                }
            }

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
            } else {
                console.log('[Stats] Warning: No ball touches recorded before goal (team: ' + team + ')');
            }

            // Track goals for match summary
            const isOwnGoal = scorer && scorer.team !== team;
            if (scorer && !isOwnGoal && gameState.matchGoals[scorer.auth]) {
                gameState.matchGoals[scorer.auth].goals++;
            }
            if (assister && !assister.isSelf && gameState.matchGoals[assister.auth]) {
                gameState.matchGoals[assister.auth].assists++;
            }

            // Get current score for announcement (and save for onGameStop)
            const scores = room.getScores();
            if (scores) {
                gameState.finalScores = scores; // Keep updating latest scores
            }
            const scoreText = scores ? `🔴 Red ${scores.red} - ${scores.blue} Blue 🔵` : 'Score unavailable';

            // Announcement: Goal
            if (isOwnGoal) {
                room.sendAnnouncement(`😱 SAMOBÓJ! ${scorer.name}`, null, 0xFFFFFF, 'bold', 2);
            } else if (scorer) {
                let goalText = `⚽ GOOOL! ${scorer.name}`;
                if (assister && !assister.isSelf) {
                    goalText += ` - asysta: ${assister.name}`;
                }
                room.sendAnnouncement(goalText, null, 0xFFFFFF, 'bold', 2);
            }
            room.sendAnnouncement(scoreText, null, 0xFFFFFF, 'normal', 1);

            if (window.statsOnTeamGoal) {
                window.statsOnTeamGoal(team, scorer, assister);
            }
        };

        // Team victory - save final scores
        room.onTeamVictory = (scores) => {
            // Save scores for onGameStop (getScores() returns null after game ends)
            gameState.finalScores = scores;
            console.log(`[Stats] Team victory - Red: ${scores.red}, Blue: ${scores.blue}`);
        };

        // Game tick - track ball touches
        room.onGameTick = () => {
            if (!gameState.isGameRunning) return;

            const ballPosition = room.getBallPosition();
            const players = room.getPlayerList();

            for (const player of players) {
                if (player.team === 0) continue; // Skip spectators

                // Skip players without auth (use playerAuthMap)
                const authData = gameState.playerAuthMap[player.id];
                if (!authData) continue;

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
                    if (!lastTouch || lastTouch.playerId !== player.id || Date.now() - lastTouch.timestamp > 50) {
                        gameState.lastTouches.push({
                            playerId: player.id,
                            playerAuth: authData.auth,
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

            // Only handle commands from players with valid auth (use playerAuthMap)
            const authData = gameState.playerAuthMap[player.id];
            if (!authData) {
                room.sendAnnouncement('❌ Statystyki niedostępne (brak auth)', player.id, 0xFFFFFF, "normal", 0);
                return false;
            }

            if (window.statsOnPlayerChat) {
                // Call async and handle response
                Promise.resolve(window.statsOnPlayerChat(authData.auth, message))
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
        const statsTracker = new HaxballStatsTracker(page, './data/stats.db');
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
