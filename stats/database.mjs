import Database from 'better-sqlite3';

/**
 * StatsDatabase - handles all SQLite operations for Haxball stats
 */
export class StatsDatabase {
    constructor(dbPath) {
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL'); // Better performance
    }

    /**
     * Initialize database schema
     */
    initialize() {
        // Create players table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS players (
                auth TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                goals INTEGER DEFAULT 0,
                assists INTEGER DEFAULT 0,
                own_goals INTEGER DEFAULT 0,
                games INTEGER DEFAULT 0,
                wins INTEGER DEFAULT 0,
                losses INTEGER DEFAULT 0,
                draws INTEGER DEFAULT 0,
                clean_sheets INTEGER DEFAULT 0,
                minutes_played INTEGER DEFAULT 0,
                current_streak INTEGER DEFAULT 0,
                best_streak INTEGER DEFAULT 0,
                last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Create matches table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS matches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                score_red INTEGER NOT NULL,
                score_blue INTEGER NOT NULL,
                duration INTEGER DEFAULT 0
            )
        `);

        // Create match_players table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS match_players (
                match_id INTEGER,
                player_auth TEXT NOT NULL,
                team INTEGER NOT NULL CHECK (team IN (1, 2)),
                goals INTEGER DEFAULT 0,
                assists INTEGER DEFAULT 0,
                FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
                FOREIGN KEY (player_auth) REFERENCES players(auth)
            )
        `);

        // Create index for faster queries
        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_match_players_match
            ON match_players(match_id)
        `);
        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_match_players_player
            ON match_players(player_auth)
        `);
    }

    /**
     * Get player by auth
     */
    getPlayer(auth) {
        const stmt = this.db.prepare('SELECT * FROM players WHERE auth = ?');
        return stmt.get(auth);
    }

    /**
     * Get player by name (case-insensitive)
     */
    getPlayerByName(name) {
        const stmt = this.db.prepare('SELECT * FROM players WHERE LOWER(name) = LOWER(?)');
        return stmt.get(name);
    }

    /**
     * Update or insert player (upsert)
     */
    upsertPlayer(auth, name) {
        const stmt = this.db.prepare(`
            INSERT INTO players (auth, name, last_seen)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(auth) DO UPDATE SET
                name = excluded.name,
                last_seen = CURRENT_TIMESTAMP
        `);
        stmt.run(auth, name);
    }

    /**
     * Update player statistics
     */
    updatePlayerStats(auth, stats) {
        const player = this.getPlayer(auth);
        if (!player) return;

        const fields = [];
        const values = [];

        // Build dynamic update query
        for (const [key, value] of Object.entries(stats)) {
            if (key === 'current_streak' || key === 'best_streak') {
                fields.push(`${key} = ?`);
                values.push(value);
            } else {
                fields.push(`${key} = ${key} + ?`);
                values.push(value);
            }
        }

        if (fields.length === 0) return;

        values.push(auth);
        const stmt = this.db.prepare(`
            UPDATE players
            SET ${fields.join(', ')}, last_seen = CURRENT_TIMESTAMP
            WHERE auth = ?
        `);
        stmt.run(...values);
    }

    /**
     * Get top players by goals
     */
    getTopPlayers(limit = 10) {
        const stmt = this.db.prepare(`
            SELECT * FROM players
            ORDER BY goals DESC, games ASC
            LIMIT ?
        `);
        return stmt.all(limit);
    }

    /**
     * Save match to database
     */
    saveMatch(matchData) {
        const insertMatch = this.db.prepare(`
            INSERT INTO matches (score_red, score_blue, duration)
            VALUES (?, ?, ?)
        `);

        const insertPlayer = this.db.prepare(`
            INSERT INTO match_players (match_id, player_auth, team, goals, assists)
            VALUES (?, ?, ?, ?, ?)
        `);

        // Transaction for atomicity
        const saveTransaction = this.db.transaction((data) => {
            const result = insertMatch.run(data.scoreRed, data.scoreBlue, data.duration);
            const matchId = result.lastInsertRowid;

            // Save all players
            for (const player of data.players) {
                insertPlayer.run(matchId, player.auth, player.team, player.goals, player.assists);
            }

            return matchId;
        });

        return saveTransaction(matchData);
    }

    /**
     * Get last match with players
     */
    getLastMatch() {
        const stmt = this.db.prepare(`
            SELECT * FROM matches
            ORDER BY timestamp DESC
            LIMIT 1
        `);
        const match = stmt.get();

        if (!match) return null;

        // Get players for this match
        const playersStmt = this.db.prepare(`
            SELECT mp.*, p.name
            FROM match_players mp
            JOIN players p ON mp.player_auth = p.auth
            WHERE mp.match_id = ?
        `);
        const players = playersStmt.all(match.id);

        return {
            ...match,
            players
        };
    }

    /**
     * Close database connection
     */
    close() {
        this.db.close();
    }
}
