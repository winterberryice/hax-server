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
     * Initialize database schema with versioning system
     *
     * This uses a migration-based approach where each version represents
     * a set of schema changes. To add new changes in the future:
     * 1. Add a new migration block (e.g., "if (currentVersion < 2)")
     * 2. Make your changes (ALTER TABLE, CREATE TABLE, etc.)
     * 3. Update the version number
     *
     * For complex changes (removing columns, changing types), use the pattern:
     * - CREATE TABLE new_table (...)
     * - INSERT INTO new_table SELECT ... FROM old_table
     * - DROP TABLE old_table
     * - ALTER TABLE new_table RENAME TO old_table
     */
    initialize() {
        // Create schema_version table if it doesn't exist
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER PRIMARY KEY
            )
        `);

        // Get current schema version
        const row = this.db.prepare('SELECT version FROM schema_version').get();
        let currentVersion = row ? row.version : 0;

        console.log(`[DB] Current schema version: ${currentVersion}`);

        // ========================================
        // MIGRATION 1: Initial schema
        // ========================================
        if (currentVersion < 1) {
            console.log('[DB] Running migration 1: Initial schema');

            // Create players table
            this.db.exec(`
                CREATE TABLE players (
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
                CREATE TABLE matches (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    score_red INTEGER NOT NULL,
                    score_blue INTEGER NOT NULL,
                    duration INTEGER DEFAULT 0
                )
            `);

            // Create match_players table
            this.db.exec(`
                CREATE TABLE match_players (
                    match_id INTEGER,
                    player_auth TEXT NOT NULL,
                    team INTEGER NOT NULL CHECK (team IN (1, 2)),
                    goals INTEGER DEFAULT 0,
                    assists INTEGER DEFAULT 0,
                    FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
                    FOREIGN KEY (player_auth) REFERENCES players(auth)
                )
            `);

            // Create indexes for faster queries
            this.db.exec(`
                CREATE INDEX idx_match_players_match
                ON match_players(match_id)
            `);
            this.db.exec(`
                CREATE INDEX idx_match_players_player
                ON match_players(player_auth)
            `);

            // Update schema version
            if (currentVersion === 0) {
                this.db.exec('INSERT INTO schema_version VALUES (1)');
            } else {
                this.db.exec('UPDATE schema_version SET version = 1');
            }
            currentVersion = 1;
            console.log('[DB] Migration 1 completed');
        }

        // ========================================
        // FUTURE MIGRATIONS GO HERE
        // ========================================
        // Example migration 2 (simple ALTER):
        // if (currentVersion < 2) {
        //     console.log('[DB] Running migration 2: Add shots column');
        //     this.db.exec(`ALTER TABLE players ADD COLUMN shots INTEGER DEFAULT 0`);
        //     this.db.exec('UPDATE schema_version SET version = 2');
        //     currentVersion = 2;
        //     console.log('[DB] Migration 2 completed');
        // }
        //
        // Example migration 3 (complex - removing column):
        // if (currentVersion < 3) {
        //     console.log('[DB] Running migration 3: Remove old_column');
        //     this.db.exec(`CREATE TABLE players_new (...)`);
        //     this.db.exec(`INSERT INTO players_new SELECT ... FROM players`);
        //     this.db.exec(`DROP TABLE players`);
        //     this.db.exec(`ALTER TABLE players_new RENAME TO players`);
        //     this.db.exec('UPDATE schema_version SET version = 3');
        //     currentVersion = 3;
        //     console.log('[DB] Migration 3 completed');
        // }

        console.log(`[DB] Schema up to date (version ${currentVersion})`);
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
     * Clear all statistics (delete all data from tables)
     */
    clearStats() {
        const clearTransaction = this.db.transaction(() => {
            this.db.exec('DELETE FROM match_players');
            this.db.exec('DELETE FROM matches');
            this.db.exec('DELETE FROM players');
        });

        clearTransaction();
        console.log('[DB] All statistics cleared');
    }

    /**
     * Delete test players and their related data
     * Removes all players whose name starts with '___test'
     */
    deleteTestPlayers() {
        const deleteTransaction = this.db.transaction(() => {
            // Get all test player auths
            const testPlayers = this.db.prepare(`
                SELECT auth FROM players WHERE name LIKE '___test%'
            `).all();

            if (testPlayers.length === 0) {
                console.log('[DB] No test players found to delete');
                return 0;
            }

            const testAuths = testPlayers.map(p => p.auth);
            const placeholders = testAuths.map(() => '?').join(',');

            // Delete from match_players
            this.db.prepare(`DELETE FROM match_players WHERE player_auth IN (${placeholders})`).run(...testAuths);

            // Delete matches where all players were test players
            this.db.exec(`
                DELETE FROM matches WHERE id IN (
                    SELECT DISTINCT m.id
                    FROM matches m
                    LEFT JOIN match_players mp ON m.id = mp.match_id
                    LEFT JOIN players p ON mp.player_auth = p.auth
                    GROUP BY m.id
                    HAVING COUNT(DISTINCT CASE WHEN p.name NOT LIKE '___test%' THEN p.auth END) = 0
                )
            `);

            // Delete test players
            this.db.prepare(`DELETE FROM players WHERE auth IN (${placeholders})`).run(...testAuths);

            console.log(`[DB] Deleted ${testPlayers.length} test players and their data`);
            return testPlayers.length;
        });

        return deleteTransaction();
    }

    /**
     * Close database connection
     */
    close() {
        this.db.close();
    }
}
